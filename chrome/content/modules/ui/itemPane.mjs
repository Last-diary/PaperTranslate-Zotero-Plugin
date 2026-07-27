// 条目面板区域（Zotero 7+ 官方 ItemPaneManager API）：
// 显示当前条目 PDF 的解析/翻译状态，并提供操作按钮。

import { ctx } from "../context.mjs";
import { resolvePdfAttachment, parseAttachment, translateAttachment, openInReader } from "./actions.mjs";
import * as storage from "../storage.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";

export function registerItemPane(pluginID, rootURI) {
  ctx.Zotero.ItemPaneManager.registerSection({
    paneID: "papertranslate-status",
    pluginID,
    header: {
      l10nID: "papertranslate-section-header",
      icon: rootURI + "icons/section-16.svg"
    },
    sidenav: {
      l10nID: "papertranslate-section-header",
      icon: rootURI + "icons/section-20.svg"
    },
    onRender: ({ body, item }) => {
      renderSection(body, item).catch((error) => {
        body.textContent = String(error?.message || error);
      });
    }
  });
}

function makeButton(doc, label, onClick) {
  const button = doc.createElementNS(HTML_NS, "button");
  button.textContent = label;
  button.style.cssText = "padding:2px 10px; cursor:pointer;";
  button.addEventListener("click", () => {
    Promise.resolve(onClick()).catch((error) => ctx.Zotero.logError(error));
  });
  return button;
}

async function renderSection(body, item) {
  const doc = body.ownerDocument;
  body.textContent = "";
  body.style.display = "flex";
  body.style.flexDirection = "column";
  body.style.gap = "6px";

  const attachment = resolvePdfAttachment(item);
  if (!attachment) {
    body.textContent = "所选条目没有 PDF 附件。";
    return;
  }

  const { manifest, translationCount } = await storage.getItemStatus(attachment);

  const status = doc.createElementNS(HTML_NS, "div");
  status.style.cssText = "line-height:1.5; word-break:break-all;";
  if (manifest) {
    const date = manifest.createdAt ? manifest.createdAt.slice(0, 10) : "";
    status.textContent = `已解析：${manifest.title || attachment.attachmentFilename}`
      + `（${manifest.pageCount || "?"} 页 / ${manifest.blockCount || "?"} 块，译文 ${translationCount} 段，${date}）`;
  } else {
    status.textContent = "尚未用 MinerU 解析此 PDF。";
  }
  body.appendChild(status);

  const row = doc.createElementNS(HTML_NS, "div");
  row.style.display = "flex";
  row.style.gap = "6px";

  const parseButton = makeButton(doc, manifest ? "重新解析" : "解析 PDF", async () => {
    await parseAttachment(attachment);
    await renderSection(body, item);
  });
  const translateButton = makeButton(doc, "翻译全文", async () => {
    await translateAttachment(attachment);
    await renderSection(body, item);
  });
  translateButton.disabled = !manifest;
  const openButton = makeButton(doc, "打开阅读", () => openInReader(attachment));

  row.append(parseButton, translateButton, openButton);
  body.appendChild(row);
}
