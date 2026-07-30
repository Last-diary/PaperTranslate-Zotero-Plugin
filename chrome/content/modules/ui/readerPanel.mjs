// Reader 译文面板：在 Zotero Reader 工具栏注入“译”按钮，
// 点击后在阅读器内与 PDF 并排展开重排内容/译文面板（移植自原项目 public/ 前端的双栏右栏逻辑）。
//
// 并排实现：Zotero Reader 的 #split-view 本身是 flex 行容器
// （#primary-view flex-grow:1 + 默认隐藏的 #secondary-view），
// 把面板作为 flex 子项追加进去即可挤压 PDF 区域，而不是覆盖。

import { ctx } from "../context.mjs";
import { getConfig } from "../config.mjs";
import * as storage from "../storage.mjs";
import { loadBlocks, tocItems } from "../blocks.mjs";
import {
  matchBlockRegionAtPoint,
  regionsForBlock
} from "../blockRegions.mjs";
import { reparseBlockImage } from "../blockReparse.mjs";
import { TranslationService, eligibleTranslationIds } from "../deepseek.mjs";
import { TocEnhancer } from "../toc.mjs";
import { escapeHtml } from "../utils.mjs";
import { importAttachment } from "../importer.mjs";
import { READER_PANEL_CSS } from "../readerPanelStyles.mjs";
import {
  blockSourceText,
  setBlockSourceText,
  shouldEditSource
} from "./blockEditing.mjs";
import { canReparseBlock } from "./blockReparseText.mjs";
import { normalizeCodeBlock } from "./codeBlock.mjs";
import { normalizeInlineMathSpacing } from "./markdownMath.mjs";
import { createPanelRenderer, safeBlockTypeClass } from "./panelRenderer.mjs";
import { createMathJaxController } from "./mathJax.mjs";
import {
  blockCropViewRect,
  renderBlockRegionsCrop
} from "./pdfBlockCrop.mjs";

const PANEL_ID = "papertranslate-panel";
const RESIZER_ID = "papertranslate-resizer";
const WORKSPACE_ID = "papertranslate-workspace";
const PANEL_OPEN_CLASS = "papertranslate-panel-open";
const PANEL_OCCUPIED_WIDTH_VAR = "--papertranslate-panel-occupied-width";
const PANEL_STYLE_ID = "papertranslate-reader-panel-style";
const DEFAULT_WIDTH = 440;
const DEFAULT_WIDTH_RATIO = 0.5;
const MIN_WIDTH = 280;
const AUTO_TRANSLATE_DEBOUNCE_MS = 300;
const AUTO_TRANSLATE_PREFETCH_PX = 160;
const PDF_AUTO_ZOOM_FALLBACK_DELAY_MS = 800;
const PDF_LOCATOR_STYLE_ID = "papertranslate-pdf-locator-style";

// 会话内记住用户实际拖动后的宽度与比例；未拖动时始终使用默认比例。
let lastWidth = DEFAULT_WIDTH;
let lastUserWidthRatio = null;

const panelStates = new WeakMap();
const activePanelStates = new Set();
const styledDocuments = new WeakSet();

// ---------- 显示过滤（移植自 public/src/modules/displayFilter.mjs） ----------

function decodeCommonHtmlEntities(value) {
  return String(value || "")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#039;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function stripMermaidWrapper(value) {
  let text = String(value || "").trim();
  text = text.replace(/^<details>\s*<summary>flowchart<\/summary>\s*/i, "").trim();
  text = text.replace(/<\/details>\s*$/i, "").trim();
  text = text.replace(/^```(?:mermaid)?\s*/i, "").trim();
  text = text.replace(/```\s*$/i, "").trim();
  return text;
}

function isMermaidDiagramSource(value) {
  const text = stripMermaidWrapper(decodeCommonHtmlEntities(value));
  if (!text) return false;
  const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() || "";
  if (!/^(graph|flowchart)\s+(TD|TB|BT|RL|LR)\b/i.test(firstLine)) return false;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const diagramLineCount = lines.filter((line) => (
    /-->|---|-\.-|==>|~~~/.test(line)
    || /\w+\s*(?:\[|\{|\()/u.test(line)
  )).length;
  return lines.length >= 3 && diagramLineCount >= 2;
}

function isMarkdownTableSource(value) {
  const lines = String(value || "").trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  return /^ *\|.*\| *$/.test(lines[0])
    && /^ *\|? *:?-{3,}:? *(?:\| *:?-{3,}:? *)+\|? *$/.test(lines[1]);
}

function filterDisplayBlock(block, { content = "", extraText = content, tableBody = "" } = {}) {
  const isMedia = ["image", "chart", "table"].includes(block.type);
  const hasImage = Boolean(block.imagePath);
  const next = { hidden: false, content, tableBody, extraText: "", showTableBody: true };

  if (!isMedia && isMermaidDiagramSource(block.codeBody || content)) {
    next.hidden = true;
    return next;
  }
  if (block.type === "table" && hasImage) {
    next.showTableBody = false;
  }
  if (block.type === "image" || block.type === "chart") {
    const rawExtraText = String(extraText || block.text || "");
    const isOwnCaption = Array.isArray(block.captions) && block.captions.includes(rawExtraText);
    const shouldHideExtra = !rawExtraText
      || isOwnCaption
      || isMermaidDiagramSource(rawExtraText)
      || (hasImage && isMarkdownTableSource(rawExtraText));
    next.extraText = shouldHideExtra ? "" : rawExtraText;
  }
  return next;
}

// ---------- 渲染辅助 ----------

// imagePath 形如 "images/xxx.jpg"：PathUtils.join 的组件不允许包含分隔符，必须逐段拼接
function imageFilePath(dir, imagePath) {
  const parts = String(imagePath).split("/").filter((part) => part && part !== "." && part !== "..");
  return PathUtils.join(dir, ...parts);
}

function imageMimeType(path) {
  const extension = String(path || "").toLowerCase().split(".").pop();
  if (extension === "png") return "image/png";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  if (extension === "svg") return "image/svg+xml";
  return "image/jpeg";
}

function bytesToBase64(bytes, win) {
  const chunks = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return win.btoa(chunks.join(""));
}

async function prepareImageSources(state, blocks) {
  state.imageSources = new Map();
  const paths = [...new Set(
    blocks.map((block) => block.imagePath).filter(Boolean)
  )];
  if (!paths.length) return { loaded: 0, failed: 0 };

  let loaded = 0;
  let failed = 0;
  await Promise.all(paths.map(async (imagePath) => {
    try {
      const fullPath = imageFilePath(state.dir, imagePath);
      const bytes = await IOUtils.read(fullPath);
      const mime = imageMimeType(fullPath);
      const source = `data:${mime};base64,${bytesToBase64(bytes, state.win)}`;
      state.imageSources.set(imagePath, source);
      loaded += 1;
    } catch (error) {
      failed += 1;
      ctx.Zotero.logError(error);
    }
  }));
  return { loaded, failed };
}

function blockContent(block, state) {
  if (state.mode === "translation" && state.eligibleIds.has(block.id)) {
    if (state.translations[block.id]) {
      return normalizeInlineMathSpacing(state.translations[block.id]);
    }
  }
  return normalizeInlineMathSpacing(block.text);
}

function sourceOverrideState(data) {
  const overrides = data?.overrides && typeof data.overrides === "object"
    ? data.overrides
    : {};
  const pendingIds = Array.isArray(data?.pendingTranslationIds)
    ? data.pendingTranslationIds.filter((id) => typeof id === "string")
    : [];
  return {
    overrides,
    pendingIds: new Set(pendingIds)
  };
}

function applySourceOverrides(blocks, overrides) {
  for (const block of blocks) {
    if (!Object.prototype.hasOwnProperty.call(overrides, block.id)) continue;
    setBlockSourceText(block, overrides[block.id]);
  }
}

function sourceOverridePayload(state, overrides = state.sourceOverrides, pendingIds = state.pendingSourceTranslationIds) {
  return {
    version: 1,
    overrides,
    pendingTranslationIds: [...pendingIds]
  };
}

async function writeSourceOverrideState(state) {
  await storage.writeJson(
    storage.sourceOverridesPath(state.dir),
    sourceOverridePayload(state)
  );
}

async function clearCompletedSourceRetranslations(state, ids, translations = state.translations) {
  const nextPendingIds = new Set(state.pendingSourceTranslationIds);
  let changed = false;
  for (const id of ids) {
    if (translations[id] && nextPendingIds.delete(id)) {
      changed = true;
    }
  }
  if (changed) {
    await storage.writeJson(
      storage.sourceOverridesPath(state.dir),
      sourceOverridePayload(state, state.sourceOverrides, nextPendingIds)
    );
    state.pendingSourceTranslationIds = nextPendingIds;
  }
}

function captionContent(block, state) {
  const captions = Array.isArray(block.captions) ? block.captions : [];
  if (state.mode === "translation" && ["image", "chart", "table"].includes(block.type)) {
    if (!state.eligibleIds.has(block.id)) return captions.join("\n");
    return normalizeInlineMathSpacing(state.translations[block.id] || captions.join("\n"));
  }
  return normalizeInlineMathSpacing(captions.join("\n"));
}

function captionList(block, state) {
  const content = captionContent(block, state).trim();
  return content ? content.split("\n").map((item) => item.trim()).filter(Boolean) : [];
}

function renderCaptionList(captions, state) {
  if (!Array.isArray(captions) || !captions.length) return "";
  return `<figcaption>${captions.map((caption) => state.renderer.inline(caption)).join("<br>")}</figcaption>`;
}

function imageHtml(block, state) {
  if (!block?.imagePath) return "";
  const src = state.imageSources.get(block.imagePath);
  if (!src) return `<div class="pt-image-missing">图片加载失败</div>`;
  return `<img src="${escapeHtml(src)}" alt="" style="max-width:100%; height:auto; display:block; margin:6px auto;">`;
}

// 移植自 public/app.mjs 的 renderMarkdownBlock（去掉调试信息与翻译遮罩）
function blockBodyHtml(block, state) {
  const display = filterDisplayBlock(block, {
    content: blockContent(block, state),
    extraText: block.text,
    tableBody: block.tableBody
  });
  if (display.hidden) return "";
  const content = display.content;

  if (block.type === "text" && block.level) {
    const level = Math.min(Math.max(Number(block.level || 2), 1), 3);
    return `<h${level} class="pt-heading pt-heading-${level}">${state.renderer.inline(content)}</h${level}>`;
  }
  if (block.type === "title") {
    return `<h1 class="pt-heading pt-title">${state.renderer.inline(content)}</h1>`;
  }
  if (block.type === "code") {
    const normalized = normalizeCodeBlock(block.codeBody || content);
    const languageClass = normalized.language
      ? ` class="language-${escapeHtml(normalized.language)}"`
      : "";
    return `${renderCaptionList(block.captions, state)}<pre><code${languageClass}>${escapeHtml(normalized.code)}</code></pre>`;
  }
  if (block.type === "equation") {
    return `<div class="pt-equation-math">${state.renderer.math(content, true)}</div>`;
  }
  if (block.type === "table") {
    const extractedTable = display.showTableBody
      ? `<div class="pt-table-content">${display.tableBody ? state.renderer.table(display.tableBody) : state.renderer.block(content)}</div>`
      : "";
    return `<figure>${imageHtml(block, state)}${renderCaptionList(captionList(block, state), state)}${extractedTable}</figure>`;
  }
  if (block.type === "image" || block.type === "chart") {
    const extra = display.extraText ? state.renderer.block(display.extraText) : "";
    return `<figure>${imageHtml(block, state)}${renderCaptionList(captionList(block, state), state)}${extra}</figure>`;
  }
  if (block.type === "list") {
    const items = content
      .split("\n")
      .map((item) => item.trim().replace(/^•\s*/, ""))
      .filter(Boolean)
      .map((item) => `<li>${state.renderer.inline(item)}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }
  if (content.includes("|") && /^ *\|.*\|/m.test(content)) {
    return state.renderer.block(content);
  }
  return state.renderer.block(content);
}

function blockSectionHtml(block, state) {
  const body = blockBodyHtml(block, state);
  if (!body) return "";
  const translated = state.mode === "translation" && Boolean(state.translations[block.id]);
  const typeClass = `pt-block-${safeBlockTypeClass(block.type)}`;
  const selectedClass = state.selectedBlockId === block.id ? " pt-selected" : "";
  const translating = state.mode === "translation" && state.translatingIds.has(block.id);
  const translatingClass = translating ? " pt-translating" : "";
  const busyAttribute = translating ? ` aria-busy="true"` : "";
  return `<section class="pt-block ${typeClass}${selectedClass}${translatingClass}" data-id="${block.id}" data-page="${block.pageIdx}" data-translated="${translated ? "1" : "0"}"${busyAttribute}
    title="第 ${block.pageIdx + 1} 页 · 点击定位并高亮 PDF">${body}</section>`;
}

// ---------- 面板 ----------

function el(doc, tag, cssText) {
  const node = doc.createElement(tag);
  if (cssText) node.style.cssText = cssText;
  return node;
}

function applyReadingPreferences(state, reading) {
  const fontSize = Number(reading?.fontSize);
  const safeFontSize = [12, 13, 14, 15, 16, 18, 20].includes(fontSize)
    ? fontSize
    : 14;
  const textAlign = reading?.textAlign === "left" ? "left" : "justify";
  state.reading = {
    textAlign,
    fontSize: safeFontSize,
    betterReading: reading?.betterReading !== false
  };
  state.els.root.style.setProperty("--pt-reading-font-size", `${safeFontSize}px`);
  state.els.root.style.setProperty("--pt-reading-text-align", textAlign);
  // 同时写到正文容器，避免 Reader 内嵌文档的旧样式或紧凑布局规则
  // 覆盖根节点上的 CSS 变量。重新加载面板时始终以当前偏好为准。
  state.els.body.style.setProperty("font-size", `${safeFontSize}px`, "important");
  state.els.body.style.setProperty("text-align", textAlign);
  ctx.Zotero?.debug?.(
    `[PaperTranslate][reading-prefs-v2] fontSize=${safeFontSize}px textAlign=${textAlign}`
  );
}

function ensurePanelStyles(doc) {
  if (styledDocuments.has(doc)) return;
  // Reader 文档位于另一个 privileged compartment。读取 adoptedStyleSheets
  // 会尝试遍历 XrayWrapper，并触发 Symbol.iterator 拒绝警告；直接注入
  // <style> 可避免跨 compartment 传递 CSSStyleSheet。Zotero Reader 自身
  // 的 _injectCSS() 也采用相同方式。
  const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
  style.id = PANEL_STYLE_ID;
  style.textContent = READER_PANEL_CSS;
  (doc.head || doc.documentElement).appendChild(style);
  styledDocuments.add(doc);
}

function makeHeaderButton(doc, label, title) {
  const button = el(doc, "button");
  button.className = "pt-button";
  button.textContent = label;
  if (title) button.title = title;
  return button;
}

function makeHeaderIconButton(doc, icon, title) {
  const button = el(doc, "button");
  button.className = "pt-button pt-icon-button";
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);

  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    icon === "refresh"
      ? "M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7"
      : "M6 6l12 12M18 6 6 18"
  );
  svg.appendChild(path);
  button.appendChild(svg);
  return button;
}

function makeBlockContextMenu(doc) {
  const menu = el(doc, "div");
  menu.className = "pt-block-context-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  return menu;
}

function populateBlockContextMenu(state) {
  const { blockContextMenu: menu } = state.els;
  menu.textContent = "";

  const addCommand = (action, label) => {
    const button = el(state.doc, "button");
    button.type = "button";
    button.dataset.action = action;
    button.textContent = label;
    button.setAttribute("role", "menuitem");
    menu.appendChild(button);
  };
  const addSeparator = () => {
    const separator = el(state.doc, "div");
    separator.className = "pt-menu-separator";
    separator.setAttribute("role", "separator");
    menu.appendChild(separator);
  };

  if (state.mode === "original") {
    addCommand("copy-original", "复制原文");
    addSeparator();
    const block = state.blockById.get(state.contextBlockId);
    if (canReparseBlock(block)) {
      addCommand("reparse", "重新解析");
    }
    addCommand("edit", "编辑内容");
    addSeparator();
    addCommand("locate", "在 PDF 中定位");
  } else {
    addCommand("copy-translation", "复制译文");
    addCommand("copy-original", "复制原文");
    addSeparator();
    addCommand("retranslate", "重新翻译");
    addCommand("edit", "编辑内容");
    addSeparator();
    addCommand("locate", "在 PDF 中定位");
  }
}

function buildPanelShell(doc) {
  const root = el(doc, "div");
  root.id = PANEL_ID;
  root.className = "pt-reader-panel";
  root.style.flex = `0 0 ${lastWidth}px`;
  root.style.width = `${lastWidth}px`;

  const header = el(doc, "header");
  header.className = "pt-toolbar";

  const controls = el(doc, "div");
  controls.className = "pt-controls";

  const originalBtn = makeHeaderButton(doc, "原文", "显示原文");
  const translationBtn = makeHeaderButton(doc, "译文", "显示译文并自动翻译当前屏幕");
  const modeGroup = el(doc, "div");
  modeGroup.className = "pt-segmented";
  modeGroup.append(originalBtn, translationBtn);

  const translateBtn = makeHeaderButton(doc, "翻译全文", "翻译全文（DeepSeek，增量缓存）");
  const refreshBtn = makeHeaderIconButton(doc, "refresh", "重新加载解析产物与译文缓存");
  refreshBtn.classList.add("pt-refresh-button");
  refreshBtn.hidden = true;
  refreshBtn.tabIndex = -1;
  const closeBtn = makeHeaderIconButton(doc, "close", "关闭面板");
  controls.append(modeGroup, translateBtn, refreshBtn, closeBtn);
  header.append(controls);

  const paneHead = el(doc, "div");
  paneHead.className = "pt-pane-head";
  const paneLabel = el(doc, "span");
  paneLabel.textContent = "重新排版（点击可定位左侧 PDF）";
  const paneActions = el(doc, "span");
  paneActions.className = "pt-pane-actions";
  const translationStatus = el(doc, "span");
  translationStatus.textContent = "未翻译";
  paneActions.append(translationStatus);
  paneHead.append(paneLabel, paneActions);

  const content = el(doc, "div");
  content.className = "pt-content pt-toc-hidden";
  const tocPanel = el(doc, "aside");
  tocPanel.className = "pt-toc-panel";
  const tocNav = el(doc, "nav");
  tocNav.className = "pt-toc-list";
  tocPanel.appendChild(tocNav);
  const body = el(doc, "article");
  body.className = "pt-markdown-view";
  content.append(tocPanel, body);

  const footer = el(doc, "div");
  footer.className = "pt-status-bar";
  footer.textContent = "加载中…";

  const blockContextMenu = makeBlockContextMenu(doc);
  root.append(header, paneHead, content, footer, blockContextMenu);
  return {
    root,
    header,
    tocNav,
    content,
    translationStatus,
    originalBtn,
    translationBtn,
    translateBtn,
    refreshBtn,
    closeBtn,
    body,
    footer,
    blockContextMenu
  };
}

function updateOuterLayoutMetrics(state) {
  if (!state.workspace) return;
  const occupiedWidth = Math.max(0, state.workspace.getBoundingClientRect().width);
  state.doc.documentElement.style.setProperty(
    PANEL_OCCUPIED_WIDTH_VAR,
    `${Math.ceil(occupiedWidth)}px`
  );
}

function availableReaderWidth(state) {
  const viewportWidth = state.doc.documentElement.clientWidth || state.win.innerWidth;
  const splitLeft = state.splitView?.getBoundingClientRect().left || 0;
  return Math.max(0, viewportWidth - splitLeft);
}

function setPanelWidth(state, width) {
  const roundedWidth = Math.round(width);
  state.els.root.style.width = `${roundedWidth}px`;
  state.els.root.style.flexBasis = `${roundedWidth}px`;
  if (state.workspace) {
    // 预留拖拽手柄宽度；原生 #split-view 只通过 inset 缩窄，不换父节点。
    state.workspace.style.width = `${roundedWidth + 9}px`;
  }
  state.els.root.classList.toggle("pt-compact", roundedWidth < 360);
  updateOuterLayoutMetrics(state);
}

function resizePanelToWorkspace(state) {
  if (!state.workspace || state.disposed) return;
  const readerWidth = availableReaderWidth(state);
  if (!readerWidth) return;
  const ratio = state.panelWidthRatio ?? lastUserWidthRatio ?? DEFAULT_WIDTH_RATIO;
  const maxWidth = Math.max(MIN_WIDTH, readerWidth - 320);
  setPanelWidth(
    state,
    Math.min(maxWidth, Math.max(MIN_WIDTH, readerWidth * ratio))
  );
}

function debugPdfAutoZoom(stage, details = {}) {
  const record = {
    stage,
    version: ctx.version || "",
    api: "reader.zoomAuto",
    ...details
  };
  try {
    console.log("[PaperTranslate][pdf-auto-zoom]", record);
  } catch {}
  try {
    ctx.Zotero?.debug(`[PaperTranslate][pdf-auto-zoom] ${JSON.stringify(record)}`);
  } catch {}
}

function getNativePdfReadyCompatibility(state) {
  try {
    // Zotero 没有公开的“PDF 首页已渲染”Reader 事件。这里集中检测官方
    // Reader 源码中的内部初始化 Promise，并在调用方继续检测 PDF.js
    // onePageRendered；字段变化时返回 null，由单次延时方案安全降级。
    const primaryView = state.reader?._internalReader?._primaryView;
    const initializedPromise = primaryView?.initializedPromise;
    if (!primaryView || typeof initializedPromise?.then !== "function") {
      return null;
    }
    return { primaryView, initializedPromise };
  } catch (error) {
    debugPdfAutoZoom("compat-unavailable", {
      reason: "capability-check-error",
      message: error?.message || String(error)
    });
    return null;
  }
}

function applyNativePdfAutoZoom(state, source) {
  if (state.disposed) return false;
  const reader = state.reader;
  if (reader?.type && reader.type !== "pdf") {
    debugPdfAutoZoom("skipped", { source, reason: "not-pdf", readerType: reader.type });
    return false;
  }
  if (typeof reader?.zoomAuto !== "function") {
    debugPdfAutoZoom("unsupported", { source, reason: "reader.zoomAuto-unavailable" });
    return false;
  }

  try {
    // 最终操作仍使用 ReaderInstance 的官方 Proxy API；就绪兼容层不会
    // 直接改写 PDFViewerApplication 的缩放状态。
    reader.zoomAuto();
    debugPdfAutoZoom("applied", { source });
    return true;
  } catch (error) {
    debugPdfAutoZoom("apply-error", {
      source,
      message: error?.message || String(error)
    });
    return false;
  }
}

function scheduleNativePdfAutoZoom(state) {
  if (state.pdfAutoZoomTimer) {
    state.win.clearTimeout(state.pdfAutoZoomTimer);
    state.pdfAutoZoomTimer = null;
  }
  const requestId = ++state.pdfAutoZoomRequestId;
  const isCurrentRequest = () => (
    !state.disposed && state.pdfAutoZoomRequestId === requestId
  );
  const applyOnce = (source) => {
    if (!isCurrentRequest()) return;
    updateOuterLayoutMetrics(state);
    try {
      state.win.dispatchEvent(new state.win.Event("resize"));
    } catch {}
    applyNativePdfAutoZoom(state, source);
  };
  const scheduleFallback = (reason, details = {}) => {
    if (!isCurrentRequest()) return;
    debugPdfAutoZoom("fallback-scheduled", {
      reason,
      delayMs: PDF_AUTO_ZOOM_FALLBACK_DELAY_MS,
      ...details
    });
    state.pdfAutoZoomTimer = state.win.setTimeout(() => {
      state.pdfAutoZoomTimer = null;
      applyOnce("delayed-fallback");
    }, PDF_AUTO_ZOOM_FALLBACK_DELAY_MS);
  };

  // 先等待外层 flex 布局提交，再优先走能力检测过的内部就绪兼容层。
  // 不再读取异步的 zoomAutoEnabled，也不会连续调用 zoomAuto()。
  state.win.requestAnimationFrame(() => {
    state.win.requestAnimationFrame(() => {
      if (!isCurrentRequest()) return;
      const compatibility = getNativePdfReadyCompatibility(state);
      if (!compatibility) {
        scheduleFallback("compatibility-unavailable");
        return;
      }

      debugPdfAutoZoom("compat-waiting", {
        signal: "primaryView.initializedPromise+pdfViewer.onePageRendered+pdfViewer.pagesPromise"
      });
      void (async () => {
        try {
          await compatibility.initializedPromise;
          if (!isCurrentRequest()) return;

          const currentPrimaryView = state.reader?._internalReader?._primaryView;
          if (currentPrimaryView !== compatibility.primaryView) {
            scheduleFallback("primary-view-replaced");
            return;
          }
          const onePageRendered = currentPrimaryView?._iframeWindow
            ?.PDFViewerApplication?.pdfViewer?.onePageRendered;
          const pagesPromise = currentPrimaryView?._iframeWindow
            ?.PDFViewerApplication?.pdfViewer?.pagesPromise;
          if (
            typeof onePageRendered?.then !== "function"
            || typeof pagesPromise?.then !== "function"
          ) {
            scheduleFallback("pdf-viewer-readiness-unavailable");
            return;
          }

          // 顺序等待，避免把跨 privileged compartment 的 Promise 放进
          // 可迭代集合后触发 XrayWrapper 的 Symbol.iterator 检查。
          await onePageRendered;
          await pagesPromise;
          if (!isCurrentRequest()) return;
          debugPdfAutoZoom("compat-ready", {
            signal: "primaryView.initializedPromise+pdfViewer.onePageRendered+pdfViewer.pagesPromise"
          });
          applyOnce("compat-ready");
        } catch (error) {
          scheduleFallback("compatibility-wait-error", {
            message: error?.message || String(error)
          });
        }
      })();
    });
  });
}

// 同级并排布局：绝不移动包含 PDF iframe 的原生 #split-view。
// Firefox 中给 iframe 祖先换父节点会重建浏览上下文，导致 PDF 和缩略图
// 渲染状态丢失。这里只增加右侧同级面板，并用 CSS inset 缩窄原生区域。
function attachSideBySide(state) {
  const doc = state.doc;
  const splitView = doc.getElementById("split-view");
  const primaryView = doc.getElementById("primary-view");
  const secondaryView = doc.getElementById("secondary-view");
  if (!splitView || !primaryView) {
    // 结构不符时回退为固定定位浮层（不影响功能）
    state.els.root.style.cssText += ";position:fixed;top:0;right:0;bottom:0;z-index:1000;box-shadow:-3px 0 10px rgba(0,0,0,.25);";
    doc.body.appendChild(state.els.root);
    state.layoutMode = "overlay";
    return;
  }

  const originalParent = splitView.parentNode;
  const originalNextSibling = splitView.nextSibling;
  if (!originalParent) {
    state.els.root.style.cssText += ";position:fixed;top:0;right:0;bottom:0;z-index:1000;box-shadow:-3px 0 10px rgba(0,0,0,.25);";
    doc.body.appendChild(state.els.root);
    state.layoutMode = "overlay";
    return;
  }

  const workspace = el(doc, "div");
  workspace.id = WORKSPACE_ID;

  const resizer = el(doc, "div");
  resizer.className = "pt-pane-resize-handle";
  resizer.id = RESIZER_ID;
  resizer.title = "拖拽调整面板宽度";
  resizer.addEventListener("mouseover", () => { resizer.style.background = "rgba(127,127,127,.35)"; });
  resizer.addEventListener("mouseout", () => { resizer.style.background = "transparent"; });
  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    state.resizeCleanup?.();
    const startX = event.clientX;
    const startWidth = state.els.root.offsetWidth || lastWidth;
    const pointerId = event.pointerId;
    const previousCursor = doc.documentElement.style.cursor;
    const previousUserSelect = doc.documentElement.style.userSelect;
    // Reader 的 PDF 区域是嵌套 iframe。指针捕获负责跨过 iframe 时继续接收
    // 事件，透明遮罩同时避免 PDF 文本选择和原生批注拖动被误触发。
    const overlay = el(doc, "div", "position:fixed; inset:0; z-index:2147483646; cursor:ew-resize; background:transparent; touch-action:none; user-select:none;");
    doc.body.appendChild(overlay);
    doc.documentElement.style.cursor = "ew-resize";
    doc.documentElement.style.userSelect = "none";
    resizer.style.background = "rgba(70,130,220,.55)";
    try {
      resizer.setPointerCapture(pointerId);
    } catch {}

    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      ev.preventDefault();
      const readerWidth = availableReaderWidth(state);
      const maxWidth = Math.max(MIN_WIDTH, Math.round(readerWidth - 320));
      const width = Math.min(maxWidth, Math.max(MIN_WIDTH, startWidth + (startX - ev.clientX)));
      setPanelWidth(state, width);
      state.panelWidthRatio = readerWidth ? width / readerWidth : null;
      lastUserWidthRatio = state.panelWidthRatio;
      lastWidth = width;
    };

    const finishDrag = (ev) => {
      if (ev?.pointerId !== undefined && ev.pointerId !== pointerId) return;
      state.win.removeEventListener("pointermove", onMove, true);
      state.win.removeEventListener("pointerup", finishDrag, true);
      state.win.removeEventListener("pointercancel", finishDrag, true);
      try {
        if (resizer.hasPointerCapture(pointerId)) resizer.releasePointerCapture(pointerId);
      } catch {}
      overlay.remove();
      doc.documentElement.style.cursor = previousCursor;
      doc.documentElement.style.userSelect = previousUserSelect;
      resizer.style.background = "transparent";
      state.resizeCleanup = null;
      // 使用 Zotero 原生“自动调整大小”按最终 PDF 区域宽度重排。
      scheduleNativePdfAutoZoom(state);
    };

    state.resizeCleanup = finishDrag;
    state.win.addEventListener("pointermove", onMove, true);
    state.win.addEventListener("pointerup", finishDrag, true);
    state.win.addEventListener("pointercancel", finishDrag, true);
  });

  state.layoutBackup = {
    originalParent,
    originalNextSibling,
    splitStyle: splitView.getAttribute("style"),
    primaryMinWidth: primaryView.style.minWidth,
    secondaryMinWidth: secondaryView?.style.minWidth || "",
    panelOpenClassExisted: doc.body.classList.contains(PANEL_OPEN_CLASS),
    occupiedWidth: doc.documentElement.style.getPropertyValue(PANEL_OCCUPIED_WIDTH_VAR)
  };

  if (originalNextSibling?.parentNode === originalParent) {
    originalParent.insertBefore(workspace, originalNextSibling);
  } else {
    originalParent.appendChild(workspace);
  }
  workspace.append(resizer, state.els.root);
  state.workspace = workspace;
  state.splitView = splitView;
  state.resizer = resizer;
  state.layoutMode = "sibling-side-by-side";

  const readerWidth = availableReaderWidth(state);
  const maxInitialWidth = Math.max(MIN_WIDTH, readerWidth - 320);
  const initialRatio = lastUserWidthRatio ?? DEFAULT_WIDTH_RATIO;
  const initialWidth = Math.min(
    maxInitialWidth,
    Math.max(MIN_WIDTH, readerWidth * initialRatio)
  );
  state.panelWidthRatio = initialRatio;
  setPanelWidth(state, initialWidth);
  doc.body.classList.add(PANEL_OPEN_CLASS);

  scheduleNativePdfAutoZoom(state);
}

function detachPanel(state) {
  const doc = state.doc;
  state.disposed = true;
  state.mathJax?.dispose();
  state.mathJax = null;
  activePanelStates.delete(state);
  panelStates.delete(state.win);
  clearPdfLocatorHighlight(state);
  unbindPdfContextBridge(state);
  if (state.autoTranslateTimer) {
    state.win.clearTimeout(state.autoTranslateTimer);
    state.autoTranslateTimer = null;
  }
  if (state.pdfAutoZoomTimer) {
    state.win.clearTimeout(state.pdfAutoZoomTimer);
    state.pdfAutoZoomTimer = null;
  }
  state.pdfAutoZoomRequestId += 1;
  if (state.sourceRetranslateTimer) {
    state.win.clearTimeout(state.sourceRetranslateTimer);
    state.sourceRetranslateTimer = null;
  }
  state.autoTranslateQueued.clear();
  state.eventCleanup?.();
  state.eventCleanup = null;
  state.resizeCleanup?.();
  state.resizeCleanup = null;
  if (state.layoutMode === "sibling-side-by-side") {
    if (!state.layoutBackup?.panelOpenClassExisted) {
      doc.body.classList.remove(PANEL_OPEN_CLASS);
    }
    if (state.layoutBackup?.occupiedWidth) {
      doc.documentElement.style.setProperty(
        PANEL_OCCUPIED_WIDTH_VAR,
        state.layoutBackup.occupiedWidth
      );
    } else {
      doc.documentElement.style.removeProperty(PANEL_OCCUPIED_WIDTH_VAR);
    }
  }
  state.resizer?.remove();
  state.els.root.remove();
  state.workspace?.remove();
  state.workspace = null;
  state.splitView = null;
  doc.getElementById(PANEL_STYLE_ID)?.remove();
  styledDocuments.delete(doc);
  try {
    state.win.dispatchEvent(new state.win.Event("resize"));
  } catch {}
}

function setFooter(state, text) {
  state.els.footer.textContent = text;
}

const BLOCK_MENU_LOG_PREFIX = "[PaperTranslate][block-context-menu]";

function debugBlockContextMenu(stage, details = {}) {
  const record = { stage, ...details };
  try {
    console.log(BLOCK_MENU_LOG_PREFIX, record);
  } catch {}
  try {
    ctx.Zotero?.debug(`${BLOCK_MENU_LOG_PREFIX} ${JSON.stringify(record)}`);
  } catch {}
}

function reportBlockContextMenuError(error, details = {}) {
  debugBlockContextMenu("error", {
    ...details,
    message: error?.message || String(error),
    stack: error?.stack || ""
  });
  try {
    console.error(BLOCK_MENU_LOG_PREFIX, error);
  } catch {}
  ctx.Zotero?.logError(error);
}

function closeBlockContextMenu(state, reason = "") {
  const wasOpen = !state.els.blockContextMenu.hidden;
  state.contextBlockId = null;
  state.els.blockContextMenu.hidden = true;
  if (wasOpen) {
    debugBlockContextMenu("closed", {
      reason: reason || "unspecified",
      hidden: state.els.blockContextMenu.hidden
    });
  }
}

function blockSection(state, id) {
  for (const section of state.els.body.querySelectorAll("section[data-id]")) {
    if (section.getAttribute("data-id") === id) return section;
  }
  return null;
}

function refreshBlockSection(state, block) {
  return state.mathJax.replace(
    () => {
      const section = blockSection(state, block.id);
      if (!section) return [];
      const html = blockBodyHtml(block, state);
      if (!html) return [];
      section.innerHTML = html;
      section.classList.remove("pt-editing");
      section.setAttribute(
        "data-translated",
        state.mode === "translation" && state.translations[block.id] ? "1" : "0"
      );
      return [section];
    }
  );
}

async function copyBlockText(state, text, label) {
  const value = String(text || "");
  if (!value) {
    setFooter(state, `${label}为空，无法复制。`);
    return;
  }
  try {
    await state.win.navigator.clipboard.writeText(value);
  } catch {
    const clipboard = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper);
    clipboard.copyString(value);
  }
  setFooter(state, `${label}已复制。`);
}

async function retranslateBlock(state, block) {
  if (state.translationBusy || state.translatingIds.has(block.id)) {
    setFooter(state, "翻译任务正在进行，请稍后重试。");
    return;
  }

  state.translationBusy = true;
  state.els.translateBtn.disabled = true;
  state.translatingIds.add(block.id);
  syncTranslationMasks(state);
  setFooter(state, "正在重新翻译当前块…");
  try {
    const service = new TranslationService();
    const result = await service.translateBlocks({
      dir: state.dir,
      allBlocks: state.blocks,
      ids: [block.id],
      force: true
    });
    if (state.disposed) return;
    state.translations = result.translations;
    await clearCompletedSourceRetranslations(state, [block.id], state.translations);
    await refreshBlockSection(state, block);
    updateTranslationStatus(state);
    setFooter(
      state,
      result.translated ? "当前块已重新翻译。" : "重新翻译完成，但没有返回新的译文。"
    );
  } catch (error) {
    if (!state.disposed) {
      setFooter(state, `重新翻译失败：${error.message || error}`);
      ctx.Zotero.logError(error);
    }
  } finally {
    state.translatingIds.delete(block.id);
    state.translationBusy = false;
    if (!state.disposed) {
      syncTranslationMasks(state);
      state.els.translateBtn.disabled = false;
    }
  }
}

async function saveOriginalBlockText(state, block, value) {
  const nextOverrides = { ...state.sourceOverrides, [block.id]: value };
  const nextPendingIds = new Set(state.pendingSourceTranslationIds);
  const nextTranslations = { ...state.translations };
  const needsTranslation = state.eligibleIds.has(block.id);
  if (needsTranslation) {
    nextPendingIds.add(block.id);
    delete nextTranslations[block.id];
  }

  // 原文覆盖独立保存，不修改 MinerU 解析产物。先让旧译文失效，
  // 再写入覆盖与待重译标记，避免重新打开面板时展示过期译文。
  await storage.writeJson(storage.translationsPath(state.dir), nextTranslations);
  try {
    await storage.writeJson(
      storage.sourceOverridesPath(state.dir),
      sourceOverridePayload(state, nextOverrides, nextPendingIds)
    );
  } catch (error) {
    await storage.writeJson(storage.translationsPath(state.dir), state.translations).catch(() => {});
    throw error;
  }

  state.sourceOverrides = nextOverrides;
  state.pendingSourceTranslationIds = nextPendingIds;
  state.translations = nextTranslations;
  setBlockSourceText(block, value);
  state.eligibleIds = eligibleTranslationIds(state.blocks, getConfig().translation);
  renderToc(state);
  await refreshBlockSection(state, block);
  updateTranslationStatus(state);
  return { needsTranslation };
}

async function dataUrlBytes(dataUrl) {
  const response = await fetch(dataUrl);
  if (!response.ok) throw new Error("无法读取当前块截图。");
  return new Uint8Array(await response.arrayBuffer());
}

async function reparseBlock(state, block) {
  if (!canReparseBlock(block)) {
    setFooter(state, "当前块类型暂不支持重新解析。");
    return;
  }
  if (state.translationBusy || state.translatingIds.has(block.id)) {
    setFooter(state, "已有任务正在进行，请稍后重试。");
    return;
  }

  state.translationBusy = true;
  state.els.translateBtn.disabled = true;
  state.translatingIds.add(block.id);
  syncTranslationMasks(state);
  setFooter(state, "正在截取当前块…");
  ctx.Zotero.debug?.(
    `PaperTranslate block-reparse-regions-v5-no-navigation: start block=${block.id} type=${block.type} regions=${regionsForBlock(block).length}`
  );
  try {
    const image = await renderBlockRegionsCrop(state.reader, block, {
      paddingRatio: 0,
      doc: state.doc
    });
    const replacement = await reparseBlockImage({
      attachment: state.attachment,
      block,
      pngBytes: await dataUrlBytes(image),
      onProgress: (text) => {
        if (!state.disposed) setFooter(state, text);
      },
      shouldAbort: () => state.disposed
    });
    if (state.disposed) return;
    if (!ctx.Zotero.Items.exists(state.attachment.id)) {
      throw new Error("PDF 附件已删除，无法保存重新解析结果。");
    }
    if (replacement === blockSourceText(block)) {
      setFooter(state, "重新解析完成，内容没有变化。");
      return;
    }
    const { needsTranslation } = await saveOriginalBlockText(state, block, replacement);
    setFooter(
      state,
      needsTranslation
        ? "当前块已重新解析并替换原文；切换到译文页后将自动重新翻译。"
        : "当前块已重新解析并替换原文。"
    );
  } catch (error) {
    if (!state.disposed) {
      setFooter(state, `重新解析失败：${error.message || error}`);
      ctx.Zotero.logError(error);
    }
  } finally {
    state.translatingIds.delete(block.id);
    state.translationBusy = false;
    if (!state.disposed) {
      syncTranslationMasks(state);
      state.els.translateBtn.disabled = false;
    }
  }
}

function editBlockContent(state, block) {
  if (state.translationBusy || state.translatingIds.has(block.id)) {
    setFooter(state, "翻译任务正在进行，请稍后再编辑内容。");
    return;
  }
  const section = blockSection(state, block.id);
  if (!section) return;

  // 译文页中的代码、公式等不可翻译块展示的仍是源内容，
  // 因此编辑目标也必须是源内容，而不是一个不会被渲染的译文缓存项。
  const editingOriginal = shouldEditSource(
    state.mode,
    state.eligibleIds.has(block.id)
  );
  section.classList.add("pt-editing");
  section.textContent = "";
  const editor = el(state.doc, "div");
  editor.className = "pt-block-editor";
  // Zotero Reader 的 FocusManager 会在捕获阶段把 textarea 的方向键
  // 当作界面焦点导航并 preventDefault；contenteditable 是其明确排除的
  // 文本编辑元素，因此保留浏览器原生的光标移动和文本选择行为。
  const editorInput = el(state.doc, "div");
  editorInput.className = "pt-block-editor-input";
  editorInput.contentEditable = "true";
  editorInput.setAttribute("role", "textbox");
  editorInput.setAttribute("aria-multiline", "true");
  editorInput.spellcheck = false;
  const previousValue = editingOriginal
    ? blockSourceText(block)
    : String(state.translations[block.id] || "");
  editorInput.textContent = previousValue;
  editorInput.setAttribute("aria-label", editingOriginal ? "编辑原文内容" : "编辑译文内容");

  const actions = el(state.doc, "div");
  actions.className = "pt-block-editor-actions";
  const cancelButton = el(state.doc, "button");
  cancelButton.type = "button";
  cancelButton.textContent = "取消";
  const saveButton = el(state.doc, "button");
  saveButton.type = "button";
  saveButton.className = "pt-editor-save";
  saveButton.textContent = "保存";
  actions.append(cancelButton, saveButton);
  editor.append(editorInput, actions);
  section.appendChild(editor);

  const cancel = () => {
    void refreshBlockSection(state, block).catch((error) => ctx.Zotero.logError(error));
  };
  const save = async () => {
    const value = editorInput.innerText.replace(/\r\n?/g, "\n").trim();
    if (!value) {
      setFooter(state, `${editingOriginal ? "原文" : "译文"}内容不能为空。`);
      editorInput.focus();
      return;
    }
    if (value === previousValue) {
      await refreshBlockSection(state, block);
      setFooter(state, "内容未更改。");
      return;
    }
    saveButton.disabled = true;
    cancelButton.disabled = true;
    try {
      if (editingOriginal) {
        const { needsTranslation } = await saveOriginalBlockText(state, block, value);
        setFooter(
          state,
          needsTranslation
            ? "原文已保存；切换到译文页后将自动重新翻译当前块。"
            : "原文已保存。"
        );
      } else {
        const nextTranslations = { ...state.translations, [block.id]: value };
        const nextPendingIds = new Set(state.pendingSourceTranslationIds);
        nextPendingIds.delete(block.id);
        await storage.writeJson(storage.translationsPath(state.dir), nextTranslations);
        try {
          await storage.writeJson(
            storage.sourceOverridesPath(state.dir),
            sourceOverridePayload(state, state.sourceOverrides, nextPendingIds)
          );
        } catch (error) {
          await storage.writeJson(storage.translationsPath(state.dir), state.translations).catch(() => {});
          throw error;
        }
        state.translations = nextTranslations;
        state.pendingSourceTranslationIds = nextPendingIds;
        await refreshBlockSection(state, block);
        updateTranslationStatus(state);
        setFooter(state, "当前块译文已保存。");
      }
      if (state.disposed) return;
    } catch (error) {
      saveButton.disabled = false;
      cancelButton.disabled = false;
      setFooter(state, `保存${editingOriginal ? "原文" : "译文"}失败：${error.message || error}`);
      ctx.Zotero.logError(error);
    }
  };

  editor.addEventListener("click", (event) => event.stopPropagation());
  cancelButton.addEventListener("click", cancel);
  saveButton.addEventListener("click", save);
  editorInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    }
  });
  editorInput.focus();
  const selection = state.win.getSelection();
  const range = state.doc.createRange();
  range.selectNodeContents(editorInput);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function showBlockContextMenu(state, block, clientX, clientY) {
  const menu = state.els.blockContextMenu;
  state.contextBlockId = block.id;
  selectBlockInPanel(state, block);
  populateBlockContextMenu(state);
  debugBlockContextMenu("selected", {
    blockId: block.id,
    mode: state.mode,
    clientX,
    clientY,
    menuExists: Boolean(menu),
    menuType: menu?.constructor?.name || "",
    hidden: menu?.hidden,
    hiddenAttribute: menu?.getAttribute?.("hidden")
  });

  const busy = state.translationBusy || state.translatingIds.has(block.id);
  const buttons = menu.querySelectorAll("button[data-action]");
  for (const button of buttons) {
    button.disabled = busy && ["retranslate", "reparse", "edit"].includes(button.dataset.action);
  }
  debugBlockContextMenu("buttons-ready", {
    blockId: block.id,
    busy,
    buttonCount: buttons.length
  });

  menu.hidden = false;
  debugBlockContextMenu("visibility-set", {
    blockId: block.id,
    hidden: menu.hidden,
    hiddenAttribute: menu.getAttribute("hidden"),
    display: state.win.getComputedStyle(menu).display,
    visibility: state.win.getComputedStyle(menu).visibility
  });
  menu.style.left = "0px";
  menu.style.top = "0px";
  const rootRect = state.els.root.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  debugBlockContextMenu("measured", {
    blockId: block.id,
    rootRect: {
      left: rootRect.left,
      top: rootRect.top,
      width: rootRect.width,
      height: rootRect.height
    },
    menuRect: {
      left: menuRect.left,
      top: menuRect.top,
      width: menuRect.width,
      height: menuRect.height
    }
  });
  const left = Math.max(4, Math.min(clientX - rootRect.left, rootRect.width - menuRect.width - 4));
  const top = Math.max(4, Math.min(clientY - rootRect.top, rootRect.height - menuRect.height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  debugBlockContextMenu("opened", {
    blockId: block.id,
    left,
    top,
    hidden: menu.hidden,
    display: state.win.getComputedStyle(menu).display
  });
}

function updateModeButtons(state) {
  state.els.originalBtn.classList.toggle("active", state.mode === "original");
  state.els.translationBtn.classList.toggle("active", state.mode === "translation");
}

function translatedCount(state) {
  let count = 0;
  for (const id of state.eligibleIds) {
    if (state.translations[id]) count += 1;
  }
  return count;
}

function updateTranslationStatus(state) {
  const count = translatedCount(state);
  state.els.translationStatus.textContent = state.eligibleIds.size
    ? `译文 ${count}/${state.eligibleIds.size}`
    : "无可译段落";
  return count;
}

function navigateToPage(state, pageIdx) {
  const pageIndex = Math.max(0, Number(pageIdx) || 0);
  try {
    state.reader.navigate({ pageIndex });
  } catch (error) {
    try {
      state.reader._internalReader?.navigate({ pageIndex });
    } catch {
      ctx.Zotero.logError(error);
    }
  }
}

function pdfViewerDocument(state) {
  const candidates = [
    state.reader?._internalReader?._primaryView?._iframeWindow,
    state.reader?._primaryView?._iframeWindow,
    state.win?._primaryView?._iframeWindow
  ];
  for (const candidate of candidates) {
    try {
      const viewerWindow = candidate?.wrappedJSObject || candidate;
      const doc = viewerWindow?.document;
      if (doc?.getElementById("viewerContainer") || doc?.querySelector(".page[data-page-number]")) {
        return doc;
      }
    } catch {
      /* private reader view may still be initializing */
    }
  }

  try {
    for (const frame of state.doc.querySelectorAll("iframe")) {
      const candidate = frame.contentWindow;
      const viewerWindow = candidate?.wrappedJSObject || candidate;
      const doc = viewerWindow?.document;
      if (doc?.getElementById("viewerContainer") || doc?.querySelector(".page[data-page-number]")) {
        return doc;
      }
    }
  } catch {
    /* inaccessible or not initialized yet */
  }
  return null;
}

function unbindPdfContextBridge(state) {
  if (state.pdfContextBindTimer) {
    state.win.clearTimeout(state.pdfContextBindTimer);
    state.pdfContextBindTimer = null;
  }
  if (state.pdfContextContainer && state.pdfContextHandler) {
    try {
      state.pdfContextContainer.removeEventListener("contextmenu", state.pdfContextHandler, true);
    } catch {
      /* inner PDF view may already have been destroyed */
    }
  }
  state.pdfContextContainer = null;
  state.pdfContextHandler = null;
  state.pdfContextPoint = null;
}

function bindPdfContextBridge(state, attempt = 0) {
  if (state.disposed) return;
  const doc = pdfViewerDocument(state);
  const container = doc?.getElementById("viewerContainer");
  if (!container) {
    if (attempt < 20) {
      state.pdfContextBindTimer = state.win.setTimeout(
        () => bindPdfContextBridge(state, attempt + 1),
        100 + attempt * 40
      );
    }
    return;
  }
  if (state.pdfContextContainer === container && state.pdfContextHandler) return;

  unbindPdfContextBridge(state);
  const handler = (event) => {
    try {
      const page = event.target?.closest?.(".page")
        || event.composedPath?.().find((node) => node?.classList?.contains?.("page"));
      if (!page) {
        state.pdfContextPoint = null;
        return;
      }
      const pageNumber = Number(
        page.dataset?.pageNumber || page.getAttribute?.("data-page-number")
      );
      const rect = page.getBoundingClientRect();
      if (!Number.isFinite(pageNumber) || pageNumber < 1 || !rect.width || !rect.height) {
        state.pdfContextPoint = null;
        return;
      }
      state.pdfContextPoint = {
        pageIdx: pageNumber - 1,
        xRatio: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
        yRatio: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
      };
    } catch {
      state.pdfContextPoint = null;
    }
  };
  container.addEventListener("contextmenu", handler, true);
  state.pdfContextContainer = container;
  state.pdfContextHandler = handler;
  state.pdfContextBindTimer = null;
}

function blockAtPdfPoint(state, point) {
  return matchBlockRegionAtPoint(state.blocks, point);
}

function clearPdfLocatorHighlight(state) {
  if (state.pdfHighlightAttemptTimer) {
    state.win.clearTimeout(state.pdfHighlightAttemptTimer);
    state.pdfHighlightAttemptTimer = null;
  }
  if (state.pdfCenterTimer) {
    state.win.clearTimeout(state.pdfCenterTimer);
    state.pdfCenterTimer = null;
  }
  for (const node of state.pdfHighlightNodes || []) node?.remove();
  state.pdfHighlightNodes = [];
}

function ensurePdfLocatorStyle(doc) {
  if (doc.getElementById(PDF_LOCATOR_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = PDF_LOCATOR_STYLE_ID;
  style.textContent = `
    .pt-pdf-locator-highlight {
      position:absolute;
      z-index:1000;
      pointer-events:none;
      border:2px solid rgba(59,130,246,.42);
      border-radius:3px;
      background:rgba(96,165,250,.14);
      box-shadow:0 0 0 3px rgba(96,165,250,.06);
    }
  `;
  (doc.head || doc.documentElement).appendChild(style);
}

function centerPdfHighlight(doc, highlight) {
  const container = doc.getElementById("viewerContainer");
  if (!container || !highlight?.isConnected) return;
  const containerRect = container.getBoundingClientRect();
  const highlightRect = highlight.getBoundingClientRect();
  if (!containerRect.height || !highlightRect.height) return;

  const highlightCenter = highlightRect.top + highlightRect.height / 2;
  const viewportCenter = containerRect.top + containerRect.height / 2;
  const targetTop = Math.max(0, container.scrollTop + highlightCenter - viewportCenter);
  // container 属于 PDF viewer 的 privileged compartment。传入包含
  // behavior 的对象会触发 SecurityWrapper 拒绝；数字属性赋值可安全跨域。
  container.scrollTop = targetTop;
}

function regionKey(region) {
  return region
    ? `${region.pageIdx}:${region.bbox?.join(",") || ""}`
    : "";
}

function showPdfBlockHighlight(state, block, attempt = 0) {
  if (state.disposed || !block) return;
  // Zotero 的公开 reader.navigate() 只负责导航，没有任意多区域的临时
  // 高亮接口。继续把 PDF viewer DOM 兼容访问集中在本函数和
  // pdfViewerDocument() 中，所有节点都由 clearPdfLocatorHighlight()
  // 清理；结构不匹配时仅安全降级为不显示高亮。
  const doc = pdfViewerDocument(state);
  const regions = regionsForBlock(block);
  const firstRegion = regions[0];
  if (!firstRegion) return;
  state.pdfHighlightAttemptTimer = null;
  if (!doc) {
    if (attempt < 12) {
      state.pdfHighlightAttemptTimer = state.win.setTimeout(
        () => showPdfBlockHighlight(state, block, attempt + 1),
        80 + attempt * 35
      );
    }
    return;
  }

  ensurePdfLocatorStyle(doc);

  const highlights = (state.pdfHighlightNodes || []).filter((node) => node?.isConnected);
  const highlightsByRegion = new Map(
    highlights.map((node) => [node.getAttribute("data-papertranslate-region"), node])
  );
  let firstHighlight = highlightsByRegion.get(regionKey(firstRegion)) || null;
  let firstHighlightCreated = false;
  let missingPage = false;
  for (const region of regions) {
    const key = regionKey(region);
    if (highlightsByRegion.has(key)) continue;
    const pageNumber = Math.max(1, Number(region.pageIdx) + 1 || 1);
    const page = doc.querySelector(
      `.page[data-page-number="${pageNumber}"], .page[data-page-index="${pageNumber - 1}"]`
    );
    if (!page) {
      missingPage = true;
      continue;
    }
    const highlight = doc.createElement("div");
    highlight.className = "pt-pdf-locator-highlight";
    highlight.setAttribute("aria-hidden", "true");
    highlight.setAttribute("data-papertranslate-region", key);
    const ratioRect = blockCropViewRect(region, 0);
    if (ratioRect) {
      const [leftRatio, topRatio, rightRatio, bottomRatio] = ratioRect;
      const left = leftRatio * 100;
      const top = topRatio * 100;
      const right = rightRatio * 100;
      const bottom = bottomRatio * 100;
      highlight.style.left = `${Math.max(0, left - 0.35)}%`;
      highlight.style.top = `${Math.max(0, top - 0.25)}%`;
      highlight.style.width = `${Math.max(1.2, Math.min(100 - left, right - left + 0.7))}%`;
      highlight.style.height = `${Math.max(1, Math.min(100 - top, bottom - top + 0.5))}%`;
    } else {
      highlight.style.inset = "8px";
      highlight.style.background = "rgba(96,165,250,.04)";
    }
    page.appendChild(highlight);
    highlights.push(highlight);
    highlightsByRegion.set(key, highlight);
    if (key === regionKey(firstRegion)) {
      firstHighlight = highlight;
      firstHighlightCreated = true;
    }
  }
  state.pdfHighlightNodes = highlights;
  if (firstHighlightCreated && firstHighlight) {
    centerPdfHighlight(doc, firstHighlight);
    // 原生 Reader 的页面导航可能在高亮插入后继续调整滚动位置，
    // 稍后再校正一次，确保逻辑段落的第一个物理块最终位于视口中间。
    state.pdfCenterTimer = state.win.setTimeout(() => {
      state.pdfCenterTimer = null;
      centerPdfHighlight(doc, firstHighlight);
    }, 180);
  }
  if (missingPage && attempt < 12) {
    state.pdfHighlightAttemptTimer = state.win.setTimeout(
      () => showPdfBlockHighlight(state, block, attempt + 1),
      80 + attempt * 35
    );
  }
}

function navigateToBlock(state, block) {
  if (!block) return;
  const firstRegion = regionsForBlock(block)[0];
  if (!firstRegion) return;
  selectBlockInPanel(state, block);
  clearPdfLocatorHighlight(state);
  navigateToPage(state, firstRegion.pageIdx);
  state.pdfHighlightAttemptTimer = state.win.setTimeout(
    () => showPdfBlockHighlight(state, block),
    60
  );
}

function selectBlockInPanel(state, block, { scroll = false } = {}) {
  if (!block) return;
  state.selectedBlockId = block.id;
  let selectedSection = null;
  for (const section of state.els.body.querySelectorAll("section[data-id]")) {
    const selected = section.getAttribute("data-id") === block.id;
    section.classList.toggle("pt-selected", selected);
    if (selected) selectedSection = section;
  }
  if (!scroll || !selectedSection) return;

  const bodyRect = state.els.body.getBoundingClientRect();
  const sectionRect = selectedSection.getBoundingClientRect();
  const targetTop = Math.max(
    0,
    state.els.body.scrollTop
      + sectionRect.top
      + sectionRect.height / 2
      - bodyRect.top
      - bodyRect.height / 2
  );
  // Reader 文档处于另一个 compartment，不向 scrollTo() 传对象。
  state.els.body.scrollTop = targetTop;
}

function captureBlockScrollAnchor(state) {
  const container = state?.els?.body;
  if (!container) return null;

  const containerRect = container.getBoundingClientRect();
  const sections = container.querySelectorAll("section[data-id]");
  let closest = null;
  for (const section of sections) {
    const blockId = section.getAttribute("data-id");
    if (!blockId) continue;
    const sectionRect = section.getBoundingClientRect();
    const offset = sectionRect.top - containerRect.top;
    const candidate = {
      blockId,
      offset,
      scrollTop: container.scrollTop
    };
    if (!closest || Math.abs(offset) < Math.abs(closest.offset)) {
      closest = candidate;
    }
    if (sectionRect.bottom > containerRect.top && sectionRect.top < containerRect.bottom) {
      return candidate;
    }
  }
  return closest;
}

function restoreBlockScrollAnchor(state, anchor) {
  const container = state?.els?.body;
  if (!container || !anchor) return;

  let anchorSection = null;
  for (const section of container.querySelectorAll("section[data-id]")) {
    if (section.getAttribute("data-id") === anchor.blockId) {
      anchorSection = section;
      break;
    }
  }
  if (!anchorSection) {
    container.scrollTop = anchor.scrollTop;
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const sectionRect = anchorSection.getBoundingClientRect();
  const currentOffset = sectionRect.top - containerRect.top;
  container.scrollTop = Math.max(0, container.scrollTop + currentOffset - anchor.offset);
}

function locatePdfContextInPanel(state, match) {
  if (state.disposed || !match?.block) return;
  const { block } = match;
  const firstRegion = regionsForBlock(block)[0];
  if (!firstRegion) return;
  selectBlockInPanel(state, block, { scroll: true });
  clearPdfLocatorHighlight(state);
  navigateToPage(state, firstRegion.pageIdx);
  state.pdfHighlightAttemptTimer = state.win.setTimeout(
    () => showPdfBlockHighlight(state, block),
    60
  );
}

function clearLinkedSelection(state) {
  if (!state.selectedBlockId && !(state.pdfHighlightNodes || []).length) return;
  state.selectedBlockId = null;
  for (const section of state.els.body.querySelectorAll("section.pt-selected")) {
    section.classList.remove("pt-selected");
  }
  clearPdfLocatorHighlight(state);
}

function renderToc(state) {
  const nav = state.els.tocNav;
  nav.textContent = "";
  const items = tocItems(state.blocks);
  if (!items.length) {
    nav.innerHTML = `<div class="pt-toc-empty">无目录</div>`;
    return;
  }
  for (const item of items) {
    const link = el(state.doc, "button");
    link.type = "button";
    link.className = `pt-toc-item level-${Math.min(item.tocLevel, 3)}`;
    link.textContent = item.text;
    link.title = `第 ${item.pageIdx + 1} 页`;
    link.addEventListener("click", () => {
      state.els.content.classList.add("pt-toc-hidden");
      navigateToPage(state, item.pageIdx);
    });
    nav.appendChild(link);
  }
}

function renderBlocks(state) {
  return state.mathJax.replace(
    () => {
      closeBlockContextMenu(state);
      const scrollAnchor = captureBlockScrollAnchor(state);
      state.els.body.innerHTML = state.blocks.map((block) => blockSectionHtml(block, state)).join("");
      restoreBlockScrollAnchor(state, scrollAnchor);
      updateModeButtons(state);
      const count = updateTranslationStatus(state);
      setFooter(state, `共 ${state.blocks.length} 块 · 已译 ${count} 段 · ${state.mode === "translation" ? "译文" : "原文"}模式`);
      if (state.mode === "translation") scheduleVisibleTranslation(state);
      return [state.els.body];
    }
  );
}

// 翻译进行中：只更新本次新译出的块，避免整列表重排
function updateTranslatedBlocks(state) {
  return state.mathJax.replace(
    () => {
      updateTranslationStatus(state);
      if (state.mode !== "translation") return [];
      const scrollAnchor = captureBlockScrollAnchor(state);
      const changed = [];
      const sections = state.els.body.querySelectorAll("section[data-id][data-translated='0']");
      for (const section of sections) {
        const id = section.getAttribute("data-id");
        const block = state.blockById.get(id);
        if (!block || !state.translations[id]) continue;
        const html = blockBodyHtml(block, state);
        if (html) {
          section.innerHTML = html;
          section.setAttribute("data-translated", "1");
          changed.push(section);
        }
      }
      if (changed.length) restoreBlockScrollAnchor(state, scrollAnchor);
      return changed;
    }
  );
}

function syncTranslationMasks(state) {
  for (const section of state.els.body.querySelectorAll("section[data-id]")) {
    const id = section.getAttribute("data-id");
    const translating = state.mode === "translation" && state.translatingIds.has(id);
    section.classList.toggle("pt-translating", translating);
    if (translating) {
      section.setAttribute("aria-busy", "true");
    } else {
      section.removeAttribute("aria-busy");
    }
  }
}

function revealCompletedMasks(state, ids, cache) {
  for (const id of ids) {
    if (cache[id]) state.translatingIds.delete(id);
  }
  syncTranslationMasks(state);
}

function visibleUntranslatedIds(state) {
  if (state.disposed || state.mode !== "translation" || !state.dir) return [];

  const bodyRect = state.els.body.getBoundingClientRect();
  const top = bodyRect.top - AUTO_TRANSLATE_PREFETCH_PX;
  const bottom = bodyRect.bottom + AUTO_TRANSLATE_PREFETCH_PX;
  const ids = [];
  for (const section of state.els.body.querySelectorAll("section[data-id]")) {
    const id = section.getAttribute("data-id");
    if (
      !id
      || !state.eligibleIds.has(id)
      || state.translations[id]
      || state.translatingIds.has(id)
    ) {
      continue;
    }
    const rect = section.getBoundingClientRect();
    if (rect.bottom >= top && rect.top <= bottom) ids.push(id);
  }
  return ids;
}

function scheduleVisibleTranslation(state, delay = AUTO_TRANSLATE_DEBOUNCE_MS) {
  if (state.disposed || state.mode !== "translation" || state.autoTranslateFailed) return;
  if (state.autoTranslateTimer) state.win.clearTimeout(state.autoTranslateTimer);
  state.autoTranslateTimer = state.win.setTimeout(() => {
    state.autoTranslateTimer = null;
    queueVisibleTranslation(state).catch((error) => {
      if (!state.disposed) {
        state.autoTranslateFailed = true;
        setFooter(state, `自动翻译失败：${error.message || error}`);
        ctx.Zotero.logError(error);
      }
    });
  }, delay);
}

async function queueVisibleTranslation(state) {
  if (state.disposed || state.mode !== "translation") return;
  for (const id of visibleUntranslatedIds(state)) state.autoTranslateQueued.add(id);
  if (state.translationBusy || !state.autoTranslateQueued.size) return;

  const ids = [...state.autoTranslateQueued].filter(
    (id) => state.eligibleIds.has(id) && !state.translations[id] && !state.translatingIds.has(id)
  );
  state.autoTranslateQueued.clear();
  if (!ids.length) return;

  state.translationBusy = true;
  state.els.translateBtn.disabled = true;
  for (const id of ids) state.translatingIds.add(id);
  syncTranslationMasks(state);
  setFooter(state, `正在自动翻译当前屏幕… 0/${ids.length} 段`);

  try {
    const service = new TranslationService();
    const result = await service.translateBlocks({
      dir: state.dir,
      allBlocks: state.blocks,
      ids,
      onChunk: (cache, done, total) => {
        if (state.disposed) return;
        state.translations = cache;
        revealCompletedMasks(state, ids, cache);
        void updateTranslatedBlocks(state).catch((error) => ctx.Zotero.logError(error));
        setFooter(state, `正在自动翻译当前屏幕… ${done}/${total} 段`);
      }
    });
    if (!state.disposed) {
      state.translations = result.translations;
      await clearCompletedSourceRetranslations(state, ids, result.translations);
      revealCompletedMasks(state, ids, result.translations);
      await updateTranslatedBlocks(state);
      setFooter(state, `当前屏幕自动翻译完成：新增 ${result.translated} 段。`);
    }
  } catch (error) {
    if (!state.disposed) {
      state.autoTranslateFailed = true;
      setFooter(state, `自动翻译失败：${error.message || error}`);
      ctx.Zotero.logError(error);
    }
  } finally {
    for (const id of ids) state.translatingIds.delete(id);
    state.translationBusy = false;
    if (!state.disposed) {
      syncTranslationMasks(state);
      state.els.translateBtn.disabled = false;
      if (!state.autoTranslateFailed) scheduleVisibleTranslation(state);
    }
  }
}

async function retranslateEditedOriginalBlocks(state) {
  if (state.disposed || state.mode !== "translation") return;
  const ids = [...state.pendingSourceTranslationIds].filter(
    (id) => state.eligibleIds.has(id) && state.blockById.has(id)
  );
  if (!ids.length) return;
  if (state.translationBusy) {
    if (state.sourceRetranslateTimer) state.win.clearTimeout(state.sourceRetranslateTimer);
    state.sourceRetranslateTimer = state.win.setTimeout(() => {
      state.sourceRetranslateTimer = null;
      retranslateEditedOriginalBlocks(state).catch((error) => {
        if (!state.disposed) {
          setFooter(state, `自动重译失败：${error.message || error}`);
          ctx.Zotero.logError(error);
        }
      });
    }, 250);
    return;
  }

  if (state.autoTranslateTimer) {
    state.win.clearTimeout(state.autoTranslateTimer);
    state.autoTranslateTimer = null;
  }
  state.translationBusy = true;
  state.els.translateBtn.disabled = true;
  for (const id of ids) state.translatingIds.add(id);
  syncTranslationMasks(state);
  setFooter(state, `原文已修改，正在自动重新翻译… 0/${ids.length} 段`);

  try {
    const service = new TranslationService();
    const result = await service.translateBlocks({
      dir: state.dir,
      allBlocks: state.blocks,
      ids,
      force: true,
      onChunk: (cache, done, total) => {
        if (state.disposed) return;
        state.translations = cache;
        revealCompletedMasks(state, ids, cache);
        void updateTranslatedBlocks(state).catch((error) => ctx.Zotero.logError(error));
        setFooter(state, `原文已修改，正在自动重新翻译… ${done}/${total} 段`);
      }
    });
    if (state.disposed) return;
    state.translations = result.translations;
    await clearCompletedSourceRetranslations(state, ids, state.translations);
    revealCompletedMasks(state, ids, state.translations);
    await updateTranslatedBlocks(state);
    const remaining = ids.filter((id) => state.pendingSourceTranslationIds.has(id)).length;
    setFooter(
      state,
      remaining
        ? `自动重译完成，但仍有 ${remaining} 段未返回译文。`
        : `已根据修改后的原文重新翻译 ${ids.length} 段。`
    );
  } catch (error) {
    if (!state.disposed) {
      setFooter(state, `自动重译失败：${error.message || error}`);
      ctx.Zotero.logError(error);
    }
  } finally {
    for (const id of ids) state.translatingIds.delete(id);
    state.translationBusy = false;
    if (!state.disposed) {
      syncTranslationMasks(state);
      state.els.translateBtn.disabled = false;
      scheduleVisibleTranslation(state);
    }
  }
}

async function translateAllInPanel(state) {
  const button = state.els.translateBtn;
  if (button.disabled || state.translationBusy) return;
  if (state.autoTranslateTimer) {
    state.win.clearTimeout(state.autoTranslateTimer);
    state.autoTranslateTimer = null;
  }
  state.autoTranslateFailed = false;
  state.translationBusy = true;
  button.disabled = true;
  const ids = [...state.eligibleIds].filter((id) => !state.translations[id]);
  for (const id of ids) state.translatingIds.add(id);
  syncTranslationMasks(state);
  setFooter(state, "正在准备全文翻译…");
  try {
    const service = new TranslationService();
    const result = await service.translateBlocks({
      dir: state.dir,
      allBlocks: state.blocks,
      onChunk: (cache, done, total) => {
        if (state.disposed) return;
        state.translations = cache;
        revealCompletedMasks(state, ids, cache);
        void updateTranslatedBlocks(state).catch((error) => ctx.Zotero.logError(error));
        setFooter(state, `翻译中… ${done}/${total} 段`);
      }
    });
    if (!state.disposed) {
      state.translations = result.translations;
      await clearCompletedSourceRetranslations(state, ids, result.translations);
      revealCompletedMasks(state, ids, result.translations);
      await updateTranslatedBlocks(state);
      setFooter(state, `翻译完成：本次 ${result.translated} 段，缓存共 ${translatedCount(state)} 段。`);
    }
  } catch (error) {
    if (!state.disposed) {
      state.autoTranslateFailed = true;
      setFooter(state, `翻译失败：${error.message || error}`);
      ctx.Zotero.logError(error);
    }
  } finally {
    for (const id of ids) state.translatingIds.delete(id);
    state.translationBusy = false;
    if (!state.disposed) {
      syncTranslationMasks(state);
      button.disabled = false;
      if (!state.autoTranslateFailed) scheduleVisibleTranslation(state);
    }
  }
}

async function reloadPanel(state) {
  state.autoTranslateFailed = false;
  try {
    await reloadPanelInner(state);
  } catch (error) {
    setFooter(state, `加载失败：${error.message || error}`);
    ctx.Zotero.logError(error);
  }
}

async function reloadPanelInner(state) {
  const { Zotero } = ctx;
  const attachment = Zotero.Items.get(state.reader.itemID);
  state.attachment = attachment;
  if (!attachment) {
    setFooter(state, "无法读取当前附件。");
    return;
  }
  const config = getConfig();
  applyReadingPreferences(state, config.reading);
  const dir = storage.itemDir(attachment);
  state.dir = dir;
  const manifest = await storage.readManifest(attachment);
  state.manifest = manifest;

  if (!manifest) {
    state.blocks = [];
    state.translations = {};
    state.sourceOverrides = {};
    state.pendingSourceTranslationIds = new Set();
    state.blockById = new Map();
    let parseNow = null;
    await state.mathJax.replace(
      () => {
        state.els.body.textContent = "";
        const hint = el(state.doc, "div", "padding:20px; line-height:2;");
        hint.textContent = "此 PDF 尚未用 MinerU 解析。";
        const parseBtn = makeHeaderButton(
          state.doc,
          "立即解析",
          "上传 PDF 到 MinerU 并解析（需要 API Token）"
        );
        parseBtn.style.cssText = "padding:4px 14px; cursor:pointer;";
        parseNow = async () => {
          if (parseBtn.disabled) return;
          parseBtn.disabled = true;
          parseBtn.textContent = "正在解析…";
          try {
            await importAttachment(attachment, { onProgress: (text) => setFooter(state, text) });
            if (!state.disposed) await reloadPanel(state);
          } catch (error) {
            setFooter(state, `解析失败：${error.message || error}`);
            parseBtn.disabled = false;
            parseBtn.textContent = "重试解析";
          }
        };
        parseBtn.addEventListener("click", () => {
          void parseNow();
        });
        hint.appendChild(parseBtn);
        state.els.body.appendChild(hint);
        setFooter(state, "未解析");
        return [state.els.body];
      }
    );
    if (state.autoParseOnOpen) {
      state.autoParseOnOpen = false;
      await parseNow?.();
    }
    return;
  }

  let blocks = await loadBlocks(dir, manifest, {
    hideNonBody: config.reading.betterReading
  });
  if (config.tocEnhancement.enabled && blocks.length) {
    const result = await new TocEnhancer().maybeEnhance(dir, blocks);
    blocks = result.blocks;
  }

  const storedSourceOverrides = sourceOverrideState(
    await storage.readJson(storage.sourceOverridesPath(dir), {})
  );
  applySourceOverrides(blocks, storedSourceOverrides.overrides);
  state.blocks = blocks;
  state.blockById = new Map(blocks.map((block) => [block.id, block]));
  state.sourceOverrides = storedSourceOverrides.overrides;
  state.pendingSourceTranslationIds = storedSourceOverrides.pendingIds;
  state.translations = (await storage.readJson(storage.translationsPath(dir), {})) || {};
  state.eligibleIds = eligibleTranslationIds(blocks, config.translation);

  const imageCount = blocks.filter((block) => block.imagePath).length;
  if (imageCount) setFooter(state, `加载图片… 0/${imageCount}`);
  const imageResult = await prepareImageSources(state, blocks);
  renderToc(state);
  await renderBlocks(state);
  if (imageResult.failed) {
    setFooter(state, `正文已加载 · 图片 ${imageResult.loaded} 成功，${imageResult.failed} 失败`);
  }
  if (state.mode === "translation" && state.pendingSourceTranslationIds.size) {
    retranslateEditedOriginalBlocks(state).catch((error) => {
      if (!state.disposed) {
        setFooter(state, `自动重译失败：${error.message || error}`);
        ctx.Zotero.logError(error);
      }
    });
  }
}

function attachPanelEvents(state) {
  const { els } = state;
  debugBlockContextMenu("events-attached", {
    version: ctx.version || "",
    mode: state.mode,
    menuExists: Boolean(els.blockContextMenu),
    listener: "window-contextmenu+pointerdown+mousedown-v5-source-edit"
  });

  els.closeBtn.addEventListener("click", () => {
    detachPanel(state);
    panelStates.delete(state.win);
  });
  els.refreshBtn.addEventListener("click", () => reloadPanel(state));
  els.originalBtn.addEventListener("click", () => {
    if (state.mode === "original") return;
    closeBlockContextMenu(state);
    state.mode = "original";
    if (state.autoTranslateTimer) {
      state.win.clearTimeout(state.autoTranslateTimer);
      state.autoTranslateTimer = null;
    }
    state.autoTranslateQueued.clear();
    void renderBlocks(state).catch((error) => ctx.Zotero.logError(error));
  });
  els.translationBtn.addEventListener("click", () => {
    if (state.mode === "translation") return;
    closeBlockContextMenu(state);
    state.mode = "translation";
    state.autoTranslateFailed = false;
    void renderBlocks(state).catch((error) => ctx.Zotero.logError(error));
    retranslateEditedOriginalBlocks(state).catch((error) => {
      if (!state.disposed) {
        setFooter(state, `自动重译失败：${error.message || error}`);
        ctx.Zotero.logError(error);
      }
    });
  });
  els.translateBtn.addEventListener("click", () => translateAllInPanel(state));

  const openBlockContextMenuFromEvent = (event, source) => {
    let section = null;
    let block = null;
    try {
      if (!els.body.contains(event.target)) return false;
      debugBlockContextMenu("event", {
        source,
        mode: state.mode,
        targetType: event.target?.constructor?.name || "",
        targetTag: event.target?.tagName || "",
        targetClass: event.target?.className || "",
        clientX: event.clientX,
        clientY: event.clientY
      });
      if (event.target?.closest?.(".pt-block-editor")) {
        debugBlockContextMenu("ignored", { source, reason: "editor" });
        return false;
      }
      section = event.target?.closest?.("section[data-id]") || null;
      if (!section) {
        debugBlockContextMenu("ignored", {
          source,
          reason: "no-block-section"
        });
        return false;
      }
      block = state.blockById.get(section.getAttribute("data-id"));
      if (!block) {
        debugBlockContextMenu("ignored", {
          source,
          reason: "block-not-found",
          blockId: section.getAttribute("data-id")
        });
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      showBlockContextMenu(state, block, event.clientX, event.clientY);
      return true;
    } catch (error) {
      event.preventDefault();
      reportBlockContextMenuError(error, {
        handler: source,
        mode: state.mode,
        blockId: block?.id || section?.getAttribute?.("data-id") || ""
      });
      setFooter(state, `右键菜单打开失败：${error.message || error}`);
      return true;
    }
  };
  let lastSecondaryDownAt = 0;
  let lastSecondaryMenuOpenAt = 0;
  const onBlockSecondaryDown = (event) => {
    if (event.button !== 2) return;
    const now = Date.now();
    // 同一次鼠标动作通常会连续产生 pointerdown 和 mousedown。
    if (now - lastSecondaryDownAt < 80 && els.body.contains(event.target)) return;
    lastSecondaryDownAt = now;
    if (openBlockContextMenuFromEvent(event, event.type)) {
      lastSecondaryMenuOpenAt = now;
    }
  };
  const onBlockContextMenu = (event) => {
    // Windows 鼠标右键通常先触发 pointerdown/mousedown，再触发 contextmenu。
    // 前一事件已经打开菜单时，只抑制紧随其后的原生菜单，避免重复渲染。
    if (
      Date.now() - lastSecondaryMenuOpenAt < 500
      && els.body.contains(event.target)
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    openBlockContextMenuFromEvent(event, "contextmenu");
  };
  // Zotero Reader 自身也在捕获阶段同时使用 pointerdown 和 mousedown。
  // 这里复用同一路径，并保留 contextmenu 以支持键盘菜单键和触控板。
  state.win.addEventListener("pointerdown", onBlockSecondaryDown, true);
  state.win.addEventListener("mousedown", onBlockSecondaryDown, true);
  state.win.addEventListener("contextmenu", onBlockContextMenu, true);

  els.blockContextMenu.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled) return;
    const block = state.blockById.get(state.contextBlockId);
    const action = button.dataset.action;
    closeBlockContextMenu(state);
    if (!block) return;

    if (action === "copy-original") {
      copyBlockText(state, blockSourceText(block), "原文").catch((error) => {
        setFooter(state, `复制原文失败：${error.message || error}`);
      });
    } else if (action === "copy-translation") {
      copyBlockText(state, state.translations[block.id], "译文").catch((error) => {
        setFooter(state, `复制译文失败：${error.message || error}`);
      });
    } else if (action === "retranslate") {
      retranslateBlock(state, block);
    } else if (action === "reparse") {
      reparseBlock(state, block);
    } else if (action === "edit") {
      editBlockContent(state, block);
    } else if (action === "locate") {
      navigateToBlock(state, block);
    }
  });

  // 点击块定位并短暂高亮 PDF 原文；用户在面板内选择文本时不触发
  els.body.addEventListener("click", (event) => {
    if (event.target.closest(".pt-block-editor")) return;
    const link = event.target.closest("a.pt-external-link[href]");
    if (link) {
      event.preventDefault();
      event.stopPropagation();
      const href = String(link.getAttribute("href") || "").trim();
      if (/^(?:https?|mailto):/i.test(href)) {
        ctx.Zotero.launchURL(href);
      }
      return;
    }
    if (state.win.getSelection()?.toString()) return;
    const section = event.target.closest("section[data-id][data-page]");
    if (!section) {
      clearLinkedSelection(state);
      return;
    }
    navigateToBlock(state, state.blockById.get(section.getAttribute("data-id")));
  });

  const onScroll = () => {
    closeBlockContextMenu(state, "scroll");
    scheduleVisibleTranslation(state);
  };
  els.body.addEventListener("scroll", onScroll, { passive: true });
  const onWindowResize = () => {
    closeBlockContextMenu(state, "resize");
    resizePanelToWorkspace(state);
  };
  state.win.addEventListener("resize", onWindowResize);
  const onDocumentPointerDown = (event) => {
    if (
      event.button === 0
      && !els.blockContextMenu.hidden
      && !els.blockContextMenu.contains(event.target)
    ) {
      closeBlockContextMenu(state, "pointerdown");
    }
  };
  const onDocumentKeyDown = (event) => {
    if (event.key === "Escape" && !els.blockContextMenu.hidden) {
      closeBlockContextMenu(state, "escape");
    }
  };
  state.doc.addEventListener("pointerdown", onDocumentPointerDown, true);
  state.doc.addEventListener("keydown", onDocumentKeyDown, true);
  const workspaceResizeObserver = state.win.ResizeObserver && state.workspace
    ? new state.win.ResizeObserver(() => resizePanelToWorkspace(state))
    : null;
  workspaceResizeObserver?.observe(state.workspace);
  state.eventCleanup = () => {
    state.win.removeEventListener("pointerdown", onBlockSecondaryDown, true);
    state.win.removeEventListener("mousedown", onBlockSecondaryDown, true);
    state.win.removeEventListener("contextmenu", onBlockContextMenu, true);
    els.body.removeEventListener("scroll", onScroll);
    state.win.removeEventListener("resize", onWindowResize);
    state.doc.removeEventListener("pointerdown", onDocumentPointerDown, true);
    state.doc.removeEventListener("keydown", onDocumentKeyDown, true);
    workspaceResizeObserver?.disconnect();
  };
}

function pdfPointFromViewContextEvent(event) {
  const params = event.params;
  const internalReader = event.reader?._internalReader;
  const view = internalReader?._lastView;
  const frame = view?._iframe;
  const viewerWindow = view?._iframeWindow?.wrappedJSObject || view?._iframeWindow;
  const doc = viewerWindow?.document;
  const menuX = Number(params?.x);
  const menuY = Number(params?.y);
  if (!frame || !doc || !Number.isFinite(menuX) || !Number.isFinite(menuY)) {
    return null;
  }

  try {
    const frameRect = frame.getBoundingClientRect();
    const clientX = menuX - frameRect.left;
    const clientY = menuY - frameRect.top;
    let page = doc.elementFromPoint(clientX, clientY)?.closest?.(".page");
    if (!page) {
      page = Array.from(doc.querySelectorAll(".page")).find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return clientX >= rect.left
          && clientX <= rect.right
          && clientY >= rect.top
          && clientY <= rect.bottom;
      });
    }
    if (!page) return null;

    const pageNumber = Number(
      page.dataset?.pageNumber || page.getAttribute?.("data-page-number")
    );
    const rect = page.getBoundingClientRect();
    if (!Number.isFinite(pageNumber) || pageNumber < 1 || !rect.width || !rect.height) {
      return null;
    }
    return {
      pageIdx: pageNumber - 1,
      xRatio: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      yRatio: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    };
  } catch {
    return null;
  }
}

function appendPdfViewContextCommand(event) {
  const state = panelStates.get(event.reader?._iframeWindow);
  if (!state || state.disposed || !state.blocks.length) return;
  // createViewContextMenu 已携带本次点击坐标。直接从当前活动 PDF view
  // 解析坐标，避免 iframe 重建或原生双视图切换后使用过期的桥接状态。
  const currentPoint = pdfPointFromViewContextEvent(event);
  if (event.params) state.pdfContextPoint = currentPoint;
  const match = blockAtPdfPoint(state, currentPoint || state.pdfContextPoint);
  event.append({
    label: "在右侧内容中定位",
    disabled: !match,
    onCommand() {
      locatePdfContextInPanel(state, match);
    }
  });
}

function removeOrphanedPanelLayout(doc) {
  const workspace = doc.getElementById(WORKSPACE_ID);
  const splitView = doc.getElementById("split-view");
  if (workspace && splitView && workspace.contains(splitView) && workspace.parentNode) {
    workspace.parentNode.insertBefore(splitView, workspace);
    for (const property of [
      "position",
      "inset",
      "inset-inline-start",
      "inset-inline-end",
      "top",
      "bottom",
      "min-width",
      "width",
      "height",
      "flex"
    ]) {
      splitView.style.removeProperty(property);
    }
  }
  workspace?.remove();
  doc.getElementById(RESIZER_ID)?.remove();
  doc.getElementById(PANEL_ID)?.remove();
  doc.body.classList.remove(PANEL_OPEN_CLASS);
  doc.documentElement.style.removeProperty(PANEL_OCCUPIED_WIDTH_VAR);
}

async function togglePanel(reader) {
  const win = reader._iframeWindow;
  const doc = win.document;
  ensurePanelStyles(doc);
  const existing = doc.getElementById(PANEL_ID);
  if (existing) {
    const state = panelStates.get(win);
    if (state) {
      detachPanel(state);
    } else {
      removeOrphanedPanelLayout(doc);
    }
    panelStates.delete(win);
    return;
  }

  const renderer = createPanelRenderer({
    markedNamespace: ctx.marked,
    createDOMPurify: ctx.createDOMPurify,
    win
  });
  const els = buildPanelShell(doc);
  const state = {
    reader,
    win,
    doc,
    els,
    renderer,
    mathJax: null,
    mode: "translation",
    blocks: [],
    blockById: new Map(),
    translations: {},
    reading: null,
    sourceOverrides: {},
    pendingSourceTranslationIds: new Set(),
    eligibleIds: new Set(),
    manifest: null,
    dir: null,
    attachment: null,
    layoutMode: "",
    layoutBackup: null,
    workspace: null,
    splitView: null,
    panelWidthRatio: null,
    resizer: null,
    resizeCleanup: null,
    imageSources: new Map(),
    disposed: false,
    eventCleanup: null,
    translationBusy: false,
    autoTranslateTimer: null,
    autoTranslateFailed: false,
    autoTranslateQueued: new Set(),
    translatingIds: new Set(),
    sourceRetranslateTimer: null,
    autoParseOnOpen: true,
    selectedBlockId: null,
    contextBlockId: null,
    pdfContextBindTimer: null,
    pdfContextContainer: null,
    pdfContextHandler: null,
    pdfContextPoint: null,
    pdfAutoZoomTimer: null,
    pdfAutoZoomRequestId: 0,
    pdfHighlightAttemptTimer: null,
    pdfCenterTimer: null,
    pdfHighlightNodes: []
  };
  state.mathJax = createMathJaxController(win);
  panelStates.set(win, state);
  activePanelStates.add(state);
  attachSideBySide(state);
  attachPanelEvents(state);
  bindPdfContextBridge(state);
  await state.mathJax.ensureLoaded();
  await reloadPanel(state);
  if (state.mathJax.error) {
    setFooter(
      state,
      `正文已加载，但 MathJax 排版不可用：${state.mathJax.error.message || state.mathJax.error}`
    );
  }
}

// ---------- 入口：注册 Reader 工具栏按钮 ----------

function appendTranslateToolbarIcon(doc, button) {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "17");
  svg.setAttribute("height", "17");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  for (const d of [
    "m5 8 6 6",
    "m4 14 6-6 2-3",
    "M2 5h12",
    "M7 2h1",
    "m22 22-5-10-5 10",
    "M14 18h6"
  ]) {
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  button.appendChild(svg);
}

export function registerReader(pluginID) {
  ctx.Zotero.Reader.registerEventListener(
    "createViewContextMenu",
    appendPdfViewContextCommand,
    pluginID
  );
  ctx.Zotero.Reader.registerEventListener("renderToolbar", (event) => {
    const { reader, doc, append } = event;
    const button = doc.createElement("button");
    button.className = "toolbar-button papertranslate-toolbar-button";
    button.title = "打开 PaperTranslate 原文/译文面板";
    button.setAttribute("aria-label", button.title);
    button.style.cssText = "width:28px; min-width:28px; padding:0; display:inline-flex; align-items:center; justify-content:center;";
    appendTranslateToolbarIcon(doc, button);
    button.addEventListener("click", () => {
      togglePanel(reader).catch((error) => ctx.Zotero.logError(error));
    });
    append(button);
  }, pluginID);
}

export function shutdownReaderPanels() {
  for (const state of [...activePanelStates]) {
    try {
      detachPanel(state);
    } catch (error) {
      ctx.Zotero?.logError?.(error);
    }
  }
}
