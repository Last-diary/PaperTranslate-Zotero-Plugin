import { ctx } from "./context.mjs";
import { renderBlockRegionsCrop } from "./ui/pdfBlockCrop.mjs";
import { sleep } from "./utils.mjs";

const IMPLEMENTATION_MARKER = "document-reparse-hidden-preview-v1";
const READER_URL = "resource://zotero/reader/reader.html";

function assertActive(shouldAbort) {
  if (ctx.shuttingDown || shouldAbort()) throw new Error("操作已取消。");
}

async function waitForReaderShell(browser, shouldAbort) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    assertActive(shouldAbort);
    const readerWindow = browser.contentWindow?.wrappedJSObject || browser.contentWindow;
    if (typeof readerWindow?.createReader === "function") return;
    await sleep(50);
  }
  throw new Error("后台 PDF 预览器初始化超时。");
}

async function dataUrlBytes(dataUrl) {
  const response = await fetch(dataUrl);
  if (!response.ok) throw new Error("无法读取块截图。");
  return new Uint8Array(await response.arrayBuffer());
}

// Zotero 没有公开的后台 PDF 区域截图 API。这里集中使用 Zotero 自己给
// 条目附件预览提供的 Reader.openPreview()，并对内部能力逐项检测；不会
// 打开可见 Reader 标签页。调用者必须在 finally 中执行 close()。
export async function openBackgroundBlockRenderer(attachment, {
  shouldAbort = () => false
} = {}) {
  assertActive(shouldAbort);
  const { Zotero } = ctx;
  const win = Zotero.getMainWindow?.();
  const doc = win?.document;
  if (!doc?.createXULElement || typeof Zotero.Reader?.openPreview !== "function") {
    throw new Error("当前 Zotero 版本不支持后台 PDF 预览渲染。");
  }

  const browser = doc.createXULElement("browser");
  browser.setAttribute("type", "content");
  browser.setAttribute("primary", "true");
  browser.setAttribute("transparent", "transparent");
  browser.setAttribute("src", READER_URL);
  browser.setAttribute("aria-hidden", "true");
  browser.style.cssText = [
    "position:fixed",
    "left:-12000px",
    "top:-12000px",
    "width:1200px",
    "height:900px",
    "opacity:0",
    "pointer-events:none",
    "z-index:-1"
  ].join(";");

  let reader = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      reader?.uninit?.();
    } catch (error) {
      Zotero.logError(error);
    }
    try {
      browser.remove();
    } catch {}
    Zotero.debug?.(
      `PaperTranslate ${IMPLEMENTATION_MARKER}: closed Zotero=${Zotero.version || "unknown"}`
    );
  };

  try {
    doc.documentElement.appendChild(browser);
    await waitForReaderShell(browser, shouldAbort);
    assertActive(shouldAbort);
    Zotero.debug?.(
      `PaperTranslate ${IMPLEMENTATION_MARKER}: opening attachment=${attachment?.id} `
      + `Zotero=${Zotero.version || "unknown"}`
    );
    reader = await Zotero.Reader.openPreview(attachment.id, browser);
    if (!reader || typeof reader._open !== "function") {
      throw new Error("Zotero 后台 Preview Reader 接口不可用。");
    }
    const opened = await reader._open({});
    if (!opened) throw new Error("Zotero 后台 Preview Reader 无法打开当前 PDF。");
    const pdfDocument = reader?._internalReader?._primaryView?._iframeWindow
      ?.wrappedJSObject?.PDFViewerApplication?.pdfDocument
      || reader?._internalReader?._primaryView?._iframeWindow
        ?.PDFViewerApplication?.pdfDocument;
    if (!pdfDocument?.getPage) {
      throw new Error("Zotero 后台 PDF.js 尚未完成初始化。");
    }
    const renderDoc = browser.contentDocument || browser.contentWindow?.document || doc;
    return {
      async render(block) {
        assertActive(shouldAbort);
        const image = await renderBlockRegionsCrop(reader, block, {
          paddingRatio: 0,
          doc: renderDoc
        });
        assertActive(shouldAbort);
        return dataUrlBytes(image);
      },
      close
    };
  } catch (error) {
    close();
    throw error;
  }
}
