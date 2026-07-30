import { regionsForBlock } from "../blockRegions.mjs";
import { ctx } from "../context.mjs";

const DEFAULT_PADDING_RATIO = 0.015;
const RENDER_SCALE = 4;
const MAX_COMPOSITE_REGIONS = 16;
const MAX_COMPOSITE_DIMENSION = 16384;
const MAX_COMPOSITE_PIXELS = 32_000_000;
const COMPOSITE_GAP = 24;
const IMPLEMENTATION_MARKER = "block-reparse-regions-v2";

function finiteRect(values) {
  return Array.isArray(values)
    && values.length === 4
    && values.map(Number).every(Number.isFinite);
}

export function blockCropViewRect(block, paddingRatio = DEFAULT_PADDING_RATIO) {
  const bbox = Array.isArray(block?.bbox) ? block.bbox.map(Number) : [];
  const pageSize = Array.isArray(block?.pageSize) ? block.pageSize.map(Number) : [];
  const [x1, y1, x2, y2] = bbox;
  const [pageWidth, pageHeight] = pageSize;
  const valid = finiteRect(bbox)
    && pageSize.length === 2
    && pageSize.every(Number.isFinite)
    && pageWidth > 0
    && pageHeight > 0
    && x2 > x1
    && y2 > y1;
  if (!valid) return null;

  const padding = Math.max(0, Number(paddingRatio) || 0);
  return [
    Math.max(0, (x1 - pageWidth * padding) / pageWidth),
    Math.max(0, (y1 - pageHeight * padding) / pageHeight),
    Math.min(1, (x2 + pageWidth * padding) / pageWidth),
    Math.min(1, (y2 + pageHeight * padding) / pageHeight)
  ];
}

export function viewRatioRectToPdfRect(viewport, ratioRect) {
  if (!viewport?.convertToPdfPoint || !finiteRect(ratioRect)) return null;
  const [left, top, right, bottom] = ratioRect;
  if (!(right > left) || !(bottom > top) || !viewport.width || !viewport.height) {
    return null;
  }
  const [x1, y2] = viewport.convertToPdfPoint(
    left * viewport.width,
    top * viewport.height
  );
  const [x2, y1] = viewport.convertToPdfPoint(
    right * viewport.width,
    bottom * viewport.height
  );
  const rect = [
    Math.min(x1, x2),
    Math.min(y1, y2),
    Math.max(x1, x2),
    Math.max(y1, y2)
  ];
  return finiteRect(rect) && rect[2] > rect[0] && rect[3] > rect[1]
    ? rect
    : null;
}

export function ratioRectToCanvasRect(ratioRect, canvasWidth, canvasHeight) {
  if (
    !finiteRect(ratioRect)
    || !(Number(canvasWidth) > 0)
    || !(Number(canvasHeight) > 0)
  ) {
    return null;
  }
  const [left, top, right, bottom] = ratioRect;
  const x = Math.max(0, Math.floor(left * canvasWidth));
  const y = Math.max(0, Math.floor(top * canvasHeight));
  const rightPixel = Math.min(canvasWidth, Math.ceil(right * canvasWidth));
  const bottomPixel = Math.min(canvasHeight, Math.ceil(bottom * canvasHeight));
  const width = rightPixel - x;
  const height = bottomPixel - y;
  return width > 0 && height > 0 ? [x, y, width, height] : null;
}

function loadCropImage(doc, dataUrl) {
  return new Promise((resolve, reject) => {
    const image = doc.createElement("img");
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error("无法合并当前段落的 PDF 区域截图。")),
      { once: true }
    );
    image.src = dataUrl;
  });
}

export function compositeCanvasSize(
  imageSizes,
  {
    gap = COMPOSITE_GAP,
    maxDimension = MAX_COMPOSITE_DIMENSION,
    maxPixels = MAX_COMPOSITE_PIXELS
  } = {}
) {
  const sizes = (Array.isArray(imageSizes) ? imageSizes : [])
    .map((size) => Array.isArray(size) ? size.map(Number) : [])
    .filter((size) => size.length === 2 && size.every(Number.isFinite) && size[0] > 0 && size[1] > 0);
  if (!sizes.length) return null;

  const rawWidth = Math.max(...sizes.map(([width]) => width));
  const rawHeight = sizes.reduce((total, [, height]) => total + height, 0)
    + Math.max(0, sizes.length - 1) * Math.max(0, Number(gap) || 0);
  const scale = Math.min(
    1,
    Number(maxDimension) / rawWidth,
    Number(maxDimension) / rawHeight,
    Math.sqrt(Number(maxPixels) / (rawWidth * rawHeight))
  );
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return {
    width: Math.max(1, Math.floor(rawWidth * scale)),
    height: Math.max(1, Math.floor(rawHeight * scale)),
    scale,
    gap: Math.max(0, Number(gap) || 0)
  };
}

async function composeCropImages(doc, dataUrls) {
  const images = await Promise.all(dataUrls.map((dataUrl) => loadCropImage(doc, dataUrl)));
  const size = compositeCanvasSize(
    images.map((image) => [image.naturalWidth, image.naturalHeight])
  );
  if (!size) throw new Error("当前段落的 PDF 区域截图尺寸无效。");

  const canvas = doc.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("无法创建多区域段落截图。");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  let y = 0;
  for (const image of images) {
    const width = Math.max(1, Math.round(image.naturalWidth * size.scale));
    const height = Math.max(1, Math.round(image.naturalHeight * size.scale));
    context.drawImage(image, 0, y, width, height);
    y += height + Math.round(size.gap * size.scale);
  }
  const dataUrl = canvas.toDataURL("image/png");
  canvas.width = 0;
  canvas.height = 0;
  return dataUrl;
}

function cloneIntoReader(value, readerWindow) {
  try {
    return typeof Cu !== "undefined" && Cu.cloneInto
      ? Cu.cloneInto(value, readerWindow)
      : value;
  } catch {
    return value;
  }
}

function unwrapReaderObject(value) {
  if (!value) return value;
  try {
    return value.wrappedJSObject
      || (typeof Cu !== "undefined" && Cu.waiveXrays ? Cu.waiveXrays(value) : value);
  } catch {
    return value;
  }
}

function debug(message) {
  ctx.Zotero?.debug?.(`PaperTranslate ${IMPLEMENTATION_MARKER}: ${message}`);
}

function readerPdfDocument(reader) {
  const internalReader = reader?._internalReader;
  const candidates = [
    internalReader?._primaryView?._iframeWindow,
    internalReader?._lastView?._iframeWindow
  ];
  for (const candidate of candidates) {
    try {
      const readerGlobal = unwrapReaderObject(candidate);
      const doc = readerGlobal?.document;
      if (doc?.getElementById("viewerContainer") || doc?.querySelector?.(".page")) {
        return doc;
      }
    } catch {
      /* Reader iframe may be rebuilding */
    }
  }
  return null;
}

function pageCanvas(doc, pageIndex) {
  const pageNumber = pageIndex + 1;
  const page = doc?.querySelector?.(
    `.page[data-page-number="${pageNumber}"], .page[data-page-index="${pageIndex}"]`
  );
  if (!page) return null;
  const candidates = page.querySelectorAll?.(
    ".canvasWrapper canvas, canvas[role='presentation'], canvas"
  ) || [];
  return Array.from(candidates).find((canvas) => canvas.width > 0 && canvas.height > 0)
    || null;
}

async function waitForPageCanvas(reader, pageIndex, attempts = 40) {
  try {
    reader.navigate({ pageIndex });
  } catch {
    reader?._internalReader?.navigate?.({ pageIndex });
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const doc = readerPdfDocument(reader);
    const canvas = pageCanvas(doc, pageIndex);
    if (doc && canvas) return { doc, canvas };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function renderFromPageCanvas(reader, pageIndex, ratioRect) {
  const source = await waitForPageCanvas(reader, pageIndex);
  if (!source) throw new Error("目标 PDF 页面尚未完成渲染。");
  const cropRect = ratioRectToCanvasRect(
    ratioRect,
    source.canvas.width,
    source.canvas.height
  );
  if (!cropRect) throw new Error("当前块在 PDF 页面中的范围为空。");
  const [sourceX, sourceY, width, height] = cropRect;
  const output = source.doc.createElement("canvas");
  output.width = width;
  output.height = height;
  const context = output.getContext("2d", { alpha: false });
  if (!context) throw new Error("无法创建 PDF 块截图画布。");
  try {
    context.drawImage(
      source.canvas,
      sourceX,
      sourceY,
      width,
      height,
      0,
      0,
      width,
      height
    );
    return output.toDataURL("image/png", 1);
  } finally {
    output.width = 0;
    output.height = 0;
  }
}

export async function resolvePdfPageContext(pdfViewer, pdfDocument, pageIndex) {
  const viewer = unwrapReaderObject(pdfViewer);
  const documentProxy = unwrapReaderObject(pdfDocument);
  let pageView = null;
  try {
    pageView = unwrapReaderObject(
      viewer?.getPageView?.(pageIndex)
      || viewer?._pages?.[pageIndex]
    );
  } catch {
    pageView = null;
  }

  let page = unwrapReaderObject(pageView?.pdfPage);
  if (typeof page?.getViewport !== "function" && documentProxy?.getPage) {
    try {
      page = unwrapReaderObject(await documentProxy.getPage(pageIndex + 1));
    } catch {
      page = null;
    }
  }

  let viewport = null;
  if (typeof page?.getViewport === "function") {
    try {
      viewport = unwrapReaderObject(page.getViewport({ scale: 1 }));
    } catch {
      viewport = null;
    }
  }
  // 跨 privileged/content compartment 调用 getPage() 时，部分 Zotero
  // 版本只返回序列化页面数据，没有 PDFPageProxy 方法。PDFViewer 的
  // pageView.viewport 仍是 Reader 实际用于坐标转换的完整对象。
  if (typeof viewport?.convertToPdfPoint !== "function") {
    viewport = unwrapReaderObject(pageView?.viewport);
  }
  return { page, viewport };
}

function pdfRectToViewportRect(viewport, rect) {
  const [x1, y2] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y1] = viewport.convertToViewportPoint(rect[2], rect[3]);
  return [
    Math.min(x1, x2),
    Math.min(y1, y2),
    Math.max(x1, x2),
    Math.max(y1, y2)
  ];
}

async function renderWithPdfJs(page, pdfView, pdfRect) {
  const readerWindow = unwrapReaderObject(pdfView?._iframeWindow);
  const pdfViewer = readerWindow?.PDFViewerApplication?.pdfViewer;
  if (
    !readerWindow?.document
    || typeof page?.render !== "function"
    || typeof page?.getViewport !== "function"
  ) {
    throw new Error("当前 Zotero Reader 无法渲染 PDF 局部区域。");
  }

  let scale = RENDER_SCALE;
  let viewport = page.getViewport({ scale });
  let viewRect = pdfRectToViewportRect(viewport, pdfRect);
  const maxCanvasPixels = Number(pdfViewer?.maxCanvasPixels || 0);
  const canvasPixels = (viewRect[2] - viewRect[0]) * (viewRect[3] - viewRect[1]);
  if (maxCanvasPixels > 0 && canvasPixels > maxCanvasPixels) {
    scale *= Math.sqrt(maxCanvasPixels / canvasPixels);
    viewport = page.getViewport({ scale });
    viewRect = pdfRectToViewportRect(viewport, pdfRect);
  }

  const width = Math.ceil(viewRect[2] - viewRect[0]);
  const height = Math.ceil(viewRect[3] - viewRect[1]);
  if (!(width > 0) || !(height > 0)) {
    throw new Error("当前块的 PDF 定位范围为空。");
  }

  viewport = page.getViewport({
    scale,
    offsetX: -viewRect[0],
    offsetY: -viewRect[1]
  });
  const canvas = readerWindow.document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("无法创建 PDF 裁图画布。");
  context.skipBlender = true;
  try {
    await page.render({ canvasContext: context, viewport }).promise;
    return canvas.toDataURL("image/png", 1);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function renderBlockCrop(reader, block, { paddingRatio } = {}) {
  const pageIndex = Number(block?.pageIdx);
  const ratioRect = blockCropViewRect(block, paddingRatio);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || !ratioRect) {
    throw new Error("当前块没有可用的 PDF 定位范围。");
  }

  // 与“点击右侧块定位 PDF”共用 pageIdx + bbox/pageSize 比例坐标。
  // 优先直接裁切 Reader 已渲染的页面 canvas，避免跨 privileged/content
  // compartment 取得不完整的 PDFPageProxy/PageViewport 方法对象。
  try {
    const image = await renderFromPageCanvas(reader, pageIndex, ratioRect);
    if (image) {
      debug("used located PDF page canvas");
      return image;
    }
  } catch (error) {
    debug(`page canvas crop unavailable at runtime: ${error.message || error}`);
  }

  // Zotero 没有公开 PDF 区域裁图 API。把私有访问集中在这里并逐级做
  // 能力检测：新版 Reader 的区域裁图、9.0.x 的批注裁图、最后直接
  // 使用 Reader 自带的 PDF.js 页面对象渲染。
  const internalReader = reader?._internalReader;
  const pdfView = internalReader?._primaryView;
  await pdfView?.initializedPromise;
  const readerWindow = pdfView?._iframeWindow
    || internalReader?._primaryView?._iframeWindow;
  const readerGlobal = unwrapReaderObject(readerWindow);
  const pdfApplication = unwrapReaderObject(readerGlobal?.PDFViewerApplication);
  const pdfDocument = unwrapReaderObject(pdfApplication?.pdfDocument);
  const pdfViewer = unwrapReaderObject(pdfApplication?.pdfViewer);
  if (!pdfDocument?.getPage) {
    throw new Error("当前 Zotero Reader 尚未完成 PDF 初始化。");
  }

  const { page, viewport } = await resolvePdfPageContext(
    pdfViewer,
    pdfDocument,
    pageIndex
  );
  const pdfRect = viewRatioRectToPdfRect(viewport, ratioRect);
  if (!pdfRect) throw new Error("无法转换当前块的 PDF 定位坐标。");

  const renderer = pdfView?._pdfRenderer;
  if (typeof renderer?.renderRegionCrops === "function") {
    try {
      const rects = cloneIntoReader([pdfRect], readerWindow);
      const images = await renderer.renderRegionCrops(pageIndex, rects);
      if (images?.[0]) {
        debug("used PDFRenderer.renderRegionCrops");
        return images[0];
      }
    } catch (error) {
      debug(`renderRegionCrops unavailable at runtime: ${error.message || error}`);
    }
  }
  if (typeof renderer?._renderAnnotationImage === "function") {
    try {
      const annotation = cloneIntoReader({
        position: { pageIndex, rects: [pdfRect] },
        color: "#000000"
      }, readerWindow);
      const image = await renderer._renderAnnotationImage(annotation);
      if (image) {
        debug("used PDFRenderer._renderAnnotationImage");
        return image;
      }
    } catch (error) {
      debug(`_renderAnnotationImage unavailable at runtime: ${error.message || error}`);
    }
  }
  debug("using direct PDF.js page render fallback");
  return renderWithPdfJs(page, pdfView, pdfRect);
}

export async function renderBlockRegionsCrop(
  reader,
  block,
  {
    paddingRatio,
    doc
  } = {}
) {
  const regions = regionsForBlock(block);
  if (!regions.length) {
    throw new Error("当前块没有可用的 PDF 定位范围。");
  }
  if (block?.regionsReliable === false && regions.length > 1) {
    throw new Error("当前段落的多区域定位信息不完整，无法安全重新解析。");
  }
  if (regions.length > MAX_COMPOSITE_REGIONS) {
    throw new Error(`当前段落包含 ${regions.length} 个 PDF 区域，超出重新解析上限。`);
  }

  const crops = [];
  for (const region of regions) {
    crops.push(await renderBlockCrop(reader, region, { paddingRatio }));
  }
  if (crops.length === 1) return crops[0];
  if (!doc?.createElement) {
    throw new Error("当前 Reader 无法合并多区域段落截图。");
  }
  debug(`composing ${crops.length} located PDF regions`);
  return composeCropImages(doc, crops);
}
