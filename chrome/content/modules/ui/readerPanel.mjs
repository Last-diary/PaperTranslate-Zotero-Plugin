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
import { TranslationService, eligibleTranslationIds } from "../deepseek.mjs";
import { TocEnhancer } from "../toc.mjs";
import { escapeHtml } from "../utils.mjs";
import { importAttachment } from "../importer.mjs";
import { READER_PANEL_CSS } from "../readerPanelStyles.mjs";

const PANEL_ID = "papertranslate-panel";
const RESIZER_ID = "papertranslate-resizer";
const WORKSPACE_ID = "papertranslate-workspace";
const PANEL_OPEN_CLASS = "papertranslate-panel-open";
const PANEL_OCCUPIED_WIDTH_VAR = "--papertranslate-panel-occupied-width";
const DEFAULT_WIDTH = 440;
const DEFAULT_WIDTH_RATIO = 0.4;
const MIN_WIDTH = 280;
const AUTO_TRANSLATE_DEBOUNCE_MS = 300;
const AUTO_TRANSLATE_PREFETCH_PX = 160;
const PDF_LOCATOR_STYLE_ID = "papertranslate-pdf-locator-style";

// 会话内记住用户调整的宽度
let lastWidth = DEFAULT_WIDTH;

const panelStates = new WeakMap();
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

// ---------- LaTeX 公式（复用 PaperTranslate-Zotero 的 KaTeX 方案） ----------

function stripMathWrappers(content) {
  const trimmed = String(content || "").trim();
  const patterns = [
    /^\$\$([\s\S]*?)\$\$$/,
    /^\\\[([\s\S]*?)\\\]$/,
    /^\\\(([\s\S]*?)\\\)$/,
    /^\$([\s\S]*?)\$$/
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) return match[1].trim();
  }
  return trimmed;
}

function normalizeSafeInlineTag(rawTag) {
  const match = String(rawTag).match(
    /^<\s*(\/?)\s*(sub|sup|b|i|em|strong|u|br|mark|small)\b([^>]*)>$/i
  );
  if (!match) return null;
  const isClose = match[1] === "/";
  const name = match[2].toLowerCase();
  if (name === "br") return "<br>";
  if (isClose) return `</${name}>`;
  return `<${name}>`;
}

function protectSafeInlineHtml(text) {
  const tokens = [];
  const stash = (html) => {
    const token = `\uE000${tokens.length}\uE001`;
    tokens.push(html);
    return token;
  };
  let output = decodeCommonHtmlEntities(text);
  output = output.replace(
    /&(?:amp|lt|gt|nbsp|times|minus|plusmn|deg|middot|le|ge|ne|infin|#\d+|#x[0-9a-fA-F]+);/gi,
    (entity) => stash(entity)
  );
  output = output.replace(
    /<\/?\s*(?:sub|sup|b|i|em|strong|u|br|mark|small)\b[^>]*>/gi,
    (tag) => {
      const normalized = normalizeSafeInlineTag(tag);
      return normalized ? stash(normalized) : tag;
    }
  );
  return { text: output, tokens };
}

function formatPlainMarkdown(text) {
  const protectedContent = protectSafeInlineHtml(text);
  let html = escapeHtml(protectedContent.text);
  html = html.replace(/\uE000(\d+)\uE001/g, (match, index) => (
    protectedContent.tokens[Number(index)] ?? ""
  ));
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/~([^~\n]+?)~/g, "<sub>$1</sub>");
  html = html.replace(/\^([^^\n]+?)\^/g, "<sup>$1</sup>");
  return html.replace(/\r?\n/g, "<br>");
}

function renderMathHtml(tex, displayMode = false) {
  const cleaned = stripMathWrappers(tex);
  if (!cleaned) return "";
  try {
    if (!ctx.katex?.renderToString) throw new Error("KaTeX 未加载");
    return ctx.katex.renderToString(cleaned, {
      displayMode: Boolean(displayMode),
      throwOnError: false,
      strict: "ignore",
      trust: false,
      // Firefox/Zotero 原生支持 MathML。使用 MathML 可避免 KaTeX HTML
      // 依赖外部字体和样式表，在 Reader 文档里更可靠。
      output: "mathml",
      errorColor: "#b42318"
    });
  } catch {
    return `<code class="pt-math-fallback">${escapeHtml(cleaned)}</code>`;
  }
}

function splitMathSegments(text) {
  const source = String(text || "");
  const segments = [];
  const pattern = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$((?:\\.|[^$\\])+)\$/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (match.index > last) segments.push({ type: "text", text: source.slice(last, match.index) });
    if (match[1] != null) segments.push({ type: "display", tex: match[1] });
    else if (match[2] != null) segments.push({ type: "display", tex: match[2] });
    else if (match[3] != null) segments.push({ type: "inline", tex: match[3] });
    else if (match[4] != null) segments.push({ type: "inline", tex: match[4] });
    last = match.index + match[0].length;
  }
  if (last < source.length) segments.push({ type: "text", text: source.slice(last) });
  if (!segments.length) segments.push({ type: "text", text: source });
  return segments;
}

function wrapInlineMath(text) {
  return splitMathSegments(text).map((segment) => {
    if (segment.type === "display") {
      return `<span class="pt-math-display">${renderMathHtml(segment.tex, true)}</span>`;
    }
    if (segment.type === "inline") {
      return `<span class="pt-math-inline">${renderMathHtml(segment.tex, false)}</span>`;
    }
    return formatPlainMarkdown(segment.text);
  }).join("");
}

function renderMathInHtmlFragment(html) {
  return String(html || "").split(/(<[^>]+>)/g).map((part) => {
    if (!part || part.startsWith("<")) return part;
    return splitMathSegments(part).map((segment) => {
      if (segment.type === "display") return renderMathHtml(segment.tex, true);
      if (segment.type === "inline") return renderMathHtml(segment.tex, false);
      return segment.text;
    }).join("");
  }).join("");
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
    if (state.translations[block.id]) return state.translations[block.id];
  }
  return block.text;
}

function captionContent(block, state) {
  const captions = Array.isArray(block.captions) ? block.captions : [];
  if (state.mode === "translation" && ["image", "chart", "table"].includes(block.type)) {
    if (!state.eligibleIds.has(block.id)) return captions.join("\n");
    return state.translations[block.id] || captions.join("\n");
  }
  return captions.join("\n");
}

function captionList(block, state) {
  const content = captionContent(block, state).trim();
  return content ? content.split("\n").map((item) => item.trim()).filter(Boolean) : [];
}

function renderCaptionList(captions) {
  if (!Array.isArray(captions) || !captions.length) return "";
  return `<figcaption>${captions.map(wrapInlineMath).join("<br>")}</figcaption>`;
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
    return `<h${level} class="pt-heading pt-heading-${level}">${wrapInlineMath(content)}</h${level}>`;
  }
  if (block.type === "title") {
    return `<h1 class="pt-heading pt-title">${wrapInlineMath(content)}</h1>`;
  }
  if (block.type === "code") {
    return `${renderCaptionList(block.captions)}<pre><code>${escapeHtml(block.codeBody || content)}</code></pre>`;
  }
  if (block.type === "equation") {
    const tex = stripMathWrappers(content);
    return `<div class="pt-equation-math">${renderMathHtml(tex, true)}</div>`;
  }
  if (block.type === "table") {
    const extractedTable = display.showTableBody
      ? `<div class="pt-table-content">${display.tableBody ? renderMathInHtmlFragment(display.tableBody) : wrapInlineMath(content)}</div>`
      : "";
    return `<figure>${imageHtml(block, state)}${renderCaptionList(captionList(block, state))}${extractedTable}</figure>`;
  }
  if (block.type === "image" || block.type === "chart") {
    const extra = display.extraText ? wrapInlineMath(display.extraText) : "";
    return `<figure>${imageHtml(block, state)}${renderCaptionList(captionList(block, state))}${extra}</figure>`;
  }
  if (block.type === "list") {
    const items = content
      .split("\n")
      .map((item) => item.trim().replace(/^•\s*/, ""))
      .filter(Boolean)
      .map((item) => `<li>${wrapInlineMath(item)}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }
  if (content.includes("|") && /^ *\|.*\|/m.test(content)) {
    return wrapInlineMath(content);
  }
  return `<p>${wrapInlineMath(content)}</p>`;
}

function blockSectionHtml(block, state) {
  const body = blockBodyHtml(block, state);
  if (!body) return "";
  const translated = state.mode === "translation" && Boolean(state.translations[block.id]);
  const typeClass = `pt-block-${block.type || "text"}`;
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

function ensurePanelStyles(doc) {
  if (styledDocuments.has(doc)) return;
  const win = doc.defaultView;
  try {
    const sheet = new win.CSSStyleSheet();
    sheet.replaceSync(READER_PANEL_CSS);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
  } catch {
    const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
    style.textContent = READER_PANEL_CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }
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

  root.append(header, paneHead, content, footer);
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
    footer
  };
}

function updateOuterLayoutMetrics(state) {
  if (!state.workspace || !state.splitView) return;
  const occupiedWidth = Math.max(
    0,
    state.workspace.getBoundingClientRect().width
      - state.splitView.getBoundingClientRect().width
  );
  state.doc.documentElement.style.setProperty(
    PANEL_OCCUPIED_WIDTH_VAR,
    `${Math.ceil(occupiedWidth)}px`
  );
}

function setPanelWidth(state, width) {
  const roundedWidth = Math.round(width);
  state.els.root.style.width = `${roundedWidth}px`;
  state.els.root.style.flexBasis = `${roundedWidth}px`;
  state.els.root.classList.toggle("pt-compact", roundedWidth < 360);
  updateOuterLayoutMetrics(state);
}

function resizePanelToWorkspace(state) {
  if (!state.workspace || state.disposed) return;
  const workspaceWidth = state.workspace.clientWidth || state.win.innerWidth;
  if (!workspaceWidth) return;
  const ratio = state.panelWidthRatio || DEFAULT_WIDTH_RATIO;
  const maxWidth = Math.max(MIN_WIDTH, workspaceWidth - 320);
  setPanelWidth(
    state,
    Math.min(maxWidth, Math.max(MIN_WIDTH, workspaceWidth * ratio))
  );
}

function applyNativePdfAutoZoom(state) {
  if (state.disposed) return;
  const internalReader = state.reader?._internalReader;
  if (!internalReader) return;

  // Zotero 的公开 zoomAuto() 只作用于当前活动视图；原生双视图开启时，
  // 同时设置两个 PDF view，保证左右 PDF 都使用“自动调整大小”。
  const views = [
    internalReader._primaryView,
    internalReader._secondaryView
  ].filter(Boolean);
  if (views.length) {
    for (const view of views) {
      try {
        view.zoomAuto?.();
        // PDF.js 监听的是每个 PDF iframe 自己的 resize，而不是外层
        // Zotero Reader 窗口。主动通知内层窗口，立即按新的容器宽度重算。
        const viewerWindow = view._iframeWindow?.wrappedJSObject || view._iframeWindow;
        viewerWindow?.dispatchEvent(new viewerWindow.Event("resize"));
      } catch {}
    }
  } else {
    try {
      internalReader.zoomAuto?.();
    } catch {}
  }
}

function scheduleNativePdfAutoZoom(state) {
  if (state.pdfAutoZoomTimer) {
    state.win.clearTimeout(state.pdfAutoZoomTimer);
    state.pdfAutoZoomTimer = null;
  }
  // 等外层 flex 布局完成两帧后再切换原生缩放模式，避免 PDF.js
  // 根据面板打开前的旧容器宽度计算缩放比例。
  state.win.requestAnimationFrame(() => {
    state.win.requestAnimationFrame(() => {
      if (state.disposed) return;
      updateOuterLayoutMetrics(state);
      try {
        state.win.dispatchEvent(new state.win.Event("resize"));
      } catch {}
      applyNativePdfAutoZoom(state);
      // Zotero 的原生拆分视图还可能在下一轮 React 布局中更新 iframe，
      // 稍后再校正一次，确保面板刚打开时即可完成自动适配。
      state.pdfAutoZoomTimer = state.win.setTimeout(() => {
        state.pdfAutoZoomTimer = null;
        applyNativePdfAutoZoom(state);
      }, 120);
    });
  });
}

// 外层并排布局：#split-view 保持为完整的 PDF 双视图单元，
// PaperTranslate 面板作为其外层同级项，不再参与 Zotero 原生拆分排列。
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
      const workspaceWidth = state.workspace?.clientWidth || state.win.innerWidth;
      const maxWidth = Math.max(MIN_WIDTH, Math.round(workspaceWidth - 320));
      const width = Math.min(maxWidth, Math.max(MIN_WIDTH, startWidth + (startX - ev.clientX)));
      setPanelWidth(state, width);
      state.panelWidthRatio = workspaceWidth ? width / workspaceWidth : null;
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

  originalParent.insertBefore(workspace, splitView);
  workspace.append(splitView, resizer, state.els.root);
  splitView.style.setProperty("position", "relative", "important");
  splitView.style.setProperty("inset", "auto", "important");
  splitView.style.setProperty("inset-inline-start", "auto", "important");
  splitView.style.setProperty("inset-inline-end", "auto", "important");
  splitView.style.setProperty("top", "auto", "important");
  splitView.style.setProperty("bottom", "auto", "important");
  splitView.style.setProperty("min-width", "0", "important");
  splitView.style.setProperty("width", "auto", "important");
  splitView.style.setProperty("height", "100%", "important");
  splitView.style.setProperty("flex", "1 1 auto", "important");
  primaryView.style.minWidth = "0";
  if (secondaryView) secondaryView.style.minWidth = "0";

  const workspaceWidth = workspace.clientWidth || state.win.innerWidth;
  const maxInitialWidth = Math.max(MIN_WIDTH, workspaceWidth - 320);
  const initialWidth = Math.min(
    maxInitialWidth,
    Math.max(MIN_WIDTH, workspaceWidth * DEFAULT_WIDTH_RATIO)
  );
  state.panelWidthRatio = DEFAULT_WIDTH_RATIO;

  doc.body.classList.add(PANEL_OPEN_CLASS);
  state.workspace = workspace;
  state.splitView = splitView;
  state.resizer = resizer;
  state.layoutMode = "outer-side-by-side";
  setPanelWidth(state, initialWidth);

  scheduleNativePdfAutoZoom(state);
}

function detachPanel(state) {
  const doc = state.doc;
  state.disposed = true;
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
  state.autoTranslateQueued.clear();
  state.eventCleanup?.();
  state.eventCleanup = null;
  state.resizeCleanup?.();
  state.resizeCleanup = null;
  if (state.layoutMode === "outer-side-by-side") {
    const primaryView = doc.getElementById("primary-view");
    const secondaryView = doc.getElementById("secondary-view");
    if (primaryView && state.layoutBackup) {
      primaryView.style.minWidth = state.layoutBackup.primaryMinWidth || "";
    }
    if (secondaryView && state.layoutBackup) {
      secondaryView.style.minWidth = state.layoutBackup.secondaryMinWidth || "";
    }
    const splitView = state.splitView || doc.getElementById("split-view");
    const backup = state.layoutBackup;
    if (splitView && backup?.originalParent) {
      const nextSibling = backup.originalNextSibling;
      if (nextSibling?.parentNode === backup.originalParent) {
        backup.originalParent.insertBefore(splitView, nextSibling);
      } else {
        backup.originalParent.appendChild(splitView);
      }
      if (backup.splitStyle === null) {
        splitView.removeAttribute("style");
      } else {
        splitView.setAttribute("style", backup.splitStyle);
      }
    }
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
  try {
    state.win.dispatchEvent(new state.win.Event("resize"));
  } catch {}
}

function setFooter(state, text) {
  state.els.footer.textContent = text;
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
  if (!point) return null;
  const candidates = state.blocks.filter((block) => Number(block.pageIdx) === point.pageIdx);
  if (!candidates.length) return null;

  let best = null;
  for (const block of candidates) {
    const bbox = Array.isArray(block.bbox) ? block.bbox.map(Number) : [];
    const pageSize = Array.isArray(block.pageSize) ? block.pageSize.map(Number) : [];
    const [x1, y1, x2, y2] = bbox;
    const [pageWidth, pageHeight] = pageSize;
    const valid = [x1, y1, x2, y2, pageWidth, pageHeight].every(Number.isFinite)
      && pageWidth > 0
      && pageHeight > 0
      && x2 > x1
      && y2 > y1;
    if (!valid) continue;

    const left = Math.max(0, Math.min(1, x1 / pageWidth));
    const top = Math.max(0, Math.min(1, y1 / pageHeight));
    const right = Math.max(left, Math.min(1, x2 / pageWidth));
    const bottom = Math.max(top, Math.min(1, y2 / pageHeight));
    const inside = point.xRatio >= left
      && point.xRatio <= right
      && point.yRatio >= top
      && point.yRatio <= bottom;
    const dx = point.xRatio < left
      ? left - point.xRatio
      : point.xRatio > right ? point.xRatio - right : 0;
    const dy = point.yRatio < top
      ? top - point.yRatio
      : point.yRatio > bottom ? point.yRatio - bottom : 0;
    const area = Math.max(0.000001, (right - left) * (bottom - top));
    const score = inside ? -1 / area : dx * dx + dy * dy;
    if (!best || score < best.score) best = { block, score };
  }
  return best?.block || candidates[0];
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
  state.pdfHighlightNode?.remove();
  state.pdfHighlightNode = null;
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

function centerPdfHighlight(doc, highlight, smooth = true) {
  const container = doc.getElementById("viewerContainer");
  if (!container || !highlight?.isConnected) return;
  const containerRect = container.getBoundingClientRect();
  const highlightRect = highlight.getBoundingClientRect();
  if (!containerRect.height || !highlightRect.height) return;

  const highlightCenter = highlightRect.top + highlightRect.height / 2;
  const viewportCenter = containerRect.top + containerRect.height / 2;
  const targetTop = Math.max(0, container.scrollTop + highlightCenter - viewportCenter);
  try {
    container.scrollTo({ top: targetTop, behavior: smooth ? "smooth" : "auto" });
  } catch {
    container.scrollTop = targetTop;
  }
}

function showPdfBlockHighlight(state, block, attempt = 0) {
  if (state.disposed || !block) return;
  const doc = pdfViewerDocument(state);
  const pageNumber = Math.max(1, Number(block.pageIdx) + 1 || 1);
  const page = doc?.querySelector(
    `.page[data-page-number="${pageNumber}"], .page[data-page-index="${pageNumber - 1}"]`
  );
  if (!doc || !page) {
    if (attempt < 12) {
      state.pdfHighlightAttemptTimer = state.win.setTimeout(
        () => showPdfBlockHighlight(state, block, attempt + 1),
        80 + attempt * 35
      );
    }
    return;
  }

  state.pdfHighlightAttemptTimer = null;
  clearPdfLocatorHighlight(state);
  ensurePdfLocatorStyle(doc);

  const highlight = doc.createElement("div");
  highlight.className = "pt-pdf-locator-highlight";
  highlight.setAttribute("aria-hidden", "true");

  const bbox = Array.isArray(block.bbox) ? block.bbox.map(Number) : [];
  const pageSize = Array.isArray(block.pageSize) ? block.pageSize.map(Number) : [];
  const [x1, y1, x2, y2] = bbox;
  const [pageWidth, pageHeight] = pageSize;
  const hasBox = [x1, y1, x2, y2, pageWidth, pageHeight].every(Number.isFinite)
    && pageWidth > 0
    && pageHeight > 0
    && x2 > x1
    && y2 > y1;

  if (hasBox) {
    const left = Math.max(0, Math.min(100, x1 / pageWidth * 100));
    const top = Math.max(0, Math.min(100, y1 / pageHeight * 100));
    const right = Math.max(left, Math.min(100, x2 / pageWidth * 100));
    const bottom = Math.max(top, Math.min(100, y2 / pageHeight * 100));
    highlight.style.left = `${Math.max(0, left - 0.35)}%`;
    highlight.style.top = `${Math.max(0, top - 0.25)}%`;
    highlight.style.width = `${Math.max(1.2, Math.min(100 - left, right - left + 0.7))}%`;
    highlight.style.height = `${Math.max(1, Math.min(100 - top, bottom - top + 0.5))}%`;
  } else {
    highlight.style.inset = "8px";
    highlight.style.background = "rgba(96,165,250,.04)";
  }

  page.appendChild(highlight);
  state.pdfHighlightNode = highlight;
  centerPdfHighlight(doc, highlight, true);
  // 原生 Reader 的页面导航可能在高亮插入后继续调整滚动位置，
  // 稍后再校正一次，确保目标段落最终位于视口中间。
  state.pdfCenterTimer = state.win.setTimeout(() => {
    state.pdfCenterTimer = null;
    centerPdfHighlight(doc, highlight, false);
  }, 180);
}

function navigateToBlock(state, block) {
  if (!block) return;
  selectBlockInPanel(state, block);
  clearPdfLocatorHighlight(state);
  navigateToPage(state, block.pageIdx);
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
  try {
    state.els.body.scrollTo({ top: targetTop, behavior: "smooth" });
  } catch {
    state.els.body.scrollTop = targetTop;
  }
}

function locatePdfContextInPanel(state, block) {
  if (state.disposed || !block) return;
  selectBlockInPanel(state, block, { scroll: true });
  clearPdfLocatorHighlight(state);
  showPdfBlockHighlight(state, block);
}

function clearLinkedSelection(state) {
  if (!state.selectedBlockId && !state.pdfHighlightNode) return;
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
  const scrollTop = state.els.body.scrollTop;
  state.els.body.innerHTML = state.blocks.map((block) => blockSectionHtml(block, state)).join("");
  state.els.body.scrollTop = scrollTop;
  updateModeButtons(state);
  const count = updateTranslationStatus(state);
  setFooter(state, `共 ${state.blocks.length} 块 · 已译 ${count} 段 · ${state.mode === "translation" ? "译文" : "原文"}模式`);
  if (state.mode === "translation") scheduleVisibleTranslation(state);
}

// 翻译进行中：只更新本次新译出的块，避免整列表重排
function updateTranslatedBlocks(state) {
  updateTranslationStatus(state);
  if (state.mode !== "translation") return;
  const sections = state.els.body.querySelectorAll("section[data-id][data-translated='0']");
  for (const section of sections) {
    const id = section.getAttribute("data-id");
    const block = state.blockById.get(id);
    if (!block || !state.translations[id]) continue;
    const html = blockBodyHtml(block, state);
    if (html) {
      section.innerHTML = html;
      section.setAttribute("data-translated", "1");
    }
  }
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
        updateTranslatedBlocks(state);
        setFooter(state, `正在自动翻译当前屏幕… ${done}/${total} 段`);
      }
    });
    if (!state.disposed) {
      state.translations = result.translations;
      revealCompletedMasks(state, ids, result.translations);
      updateTranslatedBlocks(state);
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
        updateTranslatedBlocks(state);
        setFooter(state, `翻译中… ${done}/${total} 段`);
      }
    });
    if (!state.disposed) {
      state.translations = result.translations;
      revealCompletedMasks(state, ids, result.translations);
      updateTranslatedBlocks(state);
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
  const dir = storage.itemDir(attachment);
  state.dir = dir;
  const manifest = await storage.readManifest(attachment);
  state.manifest = manifest;

  if (!manifest) {
    state.blocks = [];
    state.translations = {};
    state.blockById = new Map();
    state.els.body.textContent = "";
    const hint = el(state.doc, "div", "padding:20px; line-height:2;");
    hint.textContent = "此 PDF 尚未用 MinerU 解析。";
    const parseBtn = makeHeaderButton(state.doc, "立即解析", "上传 PDF 到 MinerU 并解析（需要 API Token）");
    parseBtn.style.cssText = "padding:4px 14px; cursor:pointer;";
    const parseNow = async () => {
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
    parseBtn.addEventListener("click", parseNow);
    hint.appendChild(parseBtn);
    state.els.body.appendChild(hint);
    setFooter(state, "未解析");
    if (state.autoParseOnOpen) {
      state.autoParseOnOpen = false;
      await parseNow();
    }
    return;
  }

  let blocks = await loadBlocks(dir, manifest);
  const config = getConfig();
  if (config.tocEnhancement.enabled && blocks.length) {
    const result = await new TocEnhancer().maybeEnhance(dir, blocks);
    blocks = result.blocks;
  }

  state.blocks = blocks;
  state.blockById = new Map(blocks.map((block) => [block.id, block]));
  state.translations = (await storage.readJson(storage.translationsPath(dir), {})) || {};
  state.eligibleIds = eligibleTranslationIds(blocks, config.translation);

  const imageCount = blocks.filter((block) => block.imagePath).length;
  if (imageCount) setFooter(state, `加载图片… 0/${imageCount}`);
  const imageResult = await prepareImageSources(state, blocks);
  renderToc(state);
  renderBlocks(state);
  if (imageResult.failed) {
    setFooter(state, `正文已加载 · 图片 ${imageResult.loaded} 成功，${imageResult.failed} 失败`);
  }
}

function attachPanelEvents(state) {
  const { els } = state;

  els.closeBtn.addEventListener("click", () => {
    detachPanel(state);
    panelStates.delete(state.win);
  });
  els.refreshBtn.addEventListener("click", () => reloadPanel(state));
  els.originalBtn.addEventListener("click", () => {
    if (state.mode === "original") return;
    state.mode = "original";
    if (state.autoTranslateTimer) {
      state.win.clearTimeout(state.autoTranslateTimer);
      state.autoTranslateTimer = null;
    }
    state.autoTranslateQueued.clear();
    renderBlocks(state);
  });
  els.translationBtn.addEventListener("click", () => {
    if (state.mode === "translation") return;
    state.mode = "translation";
    state.autoTranslateFailed = false;
    renderBlocks(state);
    scheduleVisibleTranslation(state, 0);
  });
  els.translateBtn.addEventListener("click", () => translateAllInPanel(state));

  // 点击块定位并短暂高亮 PDF 原文；用户在面板内选择文本时不触发
  els.body.addEventListener("click", (event) => {
    if (state.win.getSelection()?.toString()) return;
    const section = event.target.closest("section[data-id][data-page]");
    if (!section) {
      clearLinkedSelection(state);
      return;
    }
    navigateToBlock(state, state.blockById.get(section.getAttribute("data-id")));
  });

  const onScroll = () => scheduleVisibleTranslation(state);
  els.body.addEventListener("scroll", onScroll, { passive: true });
  const onWindowResize = () => resizePanelToWorkspace(state);
  state.win.addEventListener("resize", onWindowResize);
  const workspaceResizeObserver = state.win.ResizeObserver && state.workspace
    ? new state.win.ResizeObserver(() => resizePanelToWorkspace(state))
    : null;
  workspaceResizeObserver?.observe(state.workspace);
  state.eventCleanup = () => {
    els.body.removeEventListener("scroll", onScroll);
    state.win.removeEventListener("resize", onWindowResize);
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
  const block = blockAtPdfPoint(state, currentPoint || state.pdfContextPoint);
  event.append({
    label: "在右侧内容中定位",
    disabled: !block,
    onCommand() {
      locatePdfContextInPanel(state, block);
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

  const els = buildPanelShell(doc);
  const state = {
    reader,
    win,
    doc,
    els,
    mode: "translation",
    blocks: [],
    blockById: new Map(),
    translations: {},
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
    autoParseOnOpen: true,
    selectedBlockId: null,
    pdfContextBindTimer: null,
    pdfContextContainer: null,
    pdfContextHandler: null,
    pdfContextPoint: null,
    pdfAutoZoomTimer: null,
    pdfHighlightAttemptTimer: null,
    pdfCenterTimer: null,
    pdfHighlightNode: null
  };
  panelStates.set(win, state);
  attachSideBySide(state);
  attachPanelEvents(state);
  bindPdfContextBridge(state);
  await reloadPanel(state);
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
