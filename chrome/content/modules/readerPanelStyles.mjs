// Reader 文档不会可靠加载其他 chrome package 的 <link> 样式表。
// 将右栏样式作为构造样式表直接注入，避免跨 chrome principal 的资源加载限制。
export const READER_PANEL_CSS = String.raw`
.pt-reader-panel {
  --pt-panel:#fff; --pt-ink:#1f2933; --pt-muted:#64717f; --pt-line:#d9dee5;
  --pt-accent:#2563eb; --pt-accent-soft:#dbeafe; --pt-select:#eaf4ff; --pt-danger:#b42318;
  --pt-reading-font-size:14px; --pt-reading-text-align:justify;
  position:relative; min-width:280px !important; height:100% !important; display:flex !important;
  flex-direction:column !important; overflow:hidden !important;
  border-left:1px solid var(--pt-line) !important; background:var(--pt-panel) !important;
  color:var(--pt-ink) !important;
  font:13px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif !important;
}
.pt-reader-panel,.pt-reader-panel * { box-sizing:border-box; }
#papertranslate-workspace {
  position:absolute;
  inset-inline-start:auto;
  inset-inline-end:0;
  top:41px;
  bottom:var(--bottom-placeholder-height);
  display:flex;
  min-width:0;
  overflow:hidden;
  z-index:1;
}
body.papertranslate-panel-open #split-view,
body.papertranslate-panel-open #reader-ui .split-view {
  inset-inline-end:var(--papertranslate-panel-occupied-width) !important;
}
.pt-toolbar {
  min-height:44px; flex:none; display:flex; align-items:center; justify-content:flex-end;
  flex-wrap:wrap; gap:10px; padding:8px 10px; border-bottom:1px solid var(--pt-line); background:#fff;
}
.pt-controls {
  min-width:0; display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:6px;
}
.pt-reader-panel .pt-button {
  min-height:28px; margin:0; padding:5px 9px; border:1px solid var(--pt-line);
  border-radius:8px; background:#fff; color:var(--pt-ink); font:inherit;
  font-size:12px; line-height:1.2; cursor:pointer;
}
.pt-reader-panel .pt-button:hover { border-color:#b8c0cc; background:#f8fafc; }
.pt-reader-panel .pt-button:disabled { cursor:default; opacity:.55; }
.pt-reader-panel .pt-button.active {
  border-color:#93c5fd; background:var(--pt-accent-soft); color:#1d4ed8;
}
.pt-segmented { display:inline-flex; overflow:hidden; border:1px solid var(--pt-line); border-radius:9px; }
.pt-segmented .pt-button { border:0; border-radius:0; background:transparent; }
.pt-reader-panel .pt-icon-button {
  width:30px; min-width:30px; padding:0; display:inline-flex; align-items:center; justify-content:center;
}
.pt-reader-panel .pt-icon-button svg {
  width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.8;
  stroke-linecap:round; stroke-linejoin:round; pointer-events:none;
}
.pt-reader-panel .pt-refresh-button { display:none !important; }
.pt-pane-head {
  min-height:38px; flex:none; display:flex; align-items:center; justify-content:space-between;
  gap:8px; padding:7px 11px; border-bottom:1px solid var(--pt-line);
  color:var(--pt-muted); font-size:12px;
}
.pt-pane-head>span:first-child {
  min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.pt-pane-actions { flex:none; display:flex; align-items:center; gap:8px; white-space:nowrap; }
.pt-reader-panel.pt-compact .pt-toolbar { gap:4px; padding:6px; }
.pt-reader-panel.pt-compact .pt-controls { width:100%; gap:4px; }
.pt-reader-panel.pt-compact .pt-button { padding-inline:7px; }
.pt-reader-panel.pt-compact .pt-pane-head { padding-inline:8px; }
.pt-reader-panel.pt-compact .pt-pane-head>span:first-child { display:none; }
.pt-reader-panel.pt-compact .pt-pane-actions { margin-inline-start:auto; }
.pt-reader-panel.pt-compact .pt-markdown-view {
  padding-inline:10px;
  font-size:var(--pt-reading-font-size);
}
.pt-reader-panel.pt-compact .pt-block { padding-inline:7px; }
.pt-content {
  flex:1; min-width:0; min-height:0; display:grid;
  grid-template-columns:168px minmax(0,1fr); background:#fff;
}
.pt-content.pt-toc-hidden { grid-template-columns:minmax(0,1fr); }
.pt-toc-panel { min-width:0; overflow:auto; border-right:1px solid var(--pt-line); background:#fafbfc; }
.pt-toc-hidden .pt-toc-panel { display:none; }
.pt-toc-list { padding:8px; font-size:12px; }
.pt-reader-panel .pt-toc-item {
  display:block; width:100%; margin:0; padding:6px 8px; overflow:hidden; border:0;
  border-radius:6px; background:transparent; color:var(--pt-ink); font:inherit;
  line-height:1.45; text-align:left; text-overflow:ellipsis; white-space:nowrap; cursor:pointer;
}
.pt-reader-panel .pt-toc-item:hover { background:var(--pt-accent-soft); }
.pt-toc-item.level-2 { padding-left:16px; }
.pt-toc-item.level-3 { padding-left:27px; }
.pt-toc-empty { padding:12px; color:var(--pt-muted); }
.pt-markdown-view {
  min-width:0; width:100%; height:100%; padding:18px 22px 30vh; overflow:auto;
  color:var(--pt-ink); background:#fff; font-size:var(--pt-reading-font-size); line-height:1.7;
  overflow-wrap:break-word;
}
.pt-block {
  position:relative; margin:0 0 10px; padding:8px 10px; border:1px solid transparent;
  border-radius:8px; cursor:pointer;
}
.pt-block:hover { border-color:#e6eaf0; background:#f8fafc; }
.pt-block:active { border-color:#f0d78c; background:var(--pt-select); }
.pt-block.pt-selected,
.pt-block.pt-selected:hover {
  border-color:rgba(59,130,246,.38);
  background:rgba(96,165,250,.12);
  box-shadow:0 0 0 2px rgba(96,165,250,.045);
}
.pt-block.pt-translating {
  overflow:hidden;
  cursor:wait;
}
.pt-block.pt-translating::after {
  content:"翻译中…";
  position:absolute;
  inset:0;
  z-index:30;
  display:flex;
  align-items:center;
  justify-content:center;
  border-radius:inherit;
  color:#4975a8;
  font-size:12px;
  font-weight:600;
  letter-spacing:.04em;
  pointer-events:none;
  background:
    linear-gradient(105deg, transparent 30%, rgba(255,255,255,.58) 46%, transparent 62%) 100% 0 / 220% 100%,
    rgba(235,245,255,.82);
  animation:pt-translation-mask-sweep 1.25s linear infinite;
}
@keyframes pt-translation-mask-sweep {
  to { background-position:-120% 0, 0 0; }
}
.pt-block-context-menu {
  position:absolute; z-index:1000; min-width:168px; padding:5px;
  border:1px solid var(--pt-line); border-radius:9px; background:var(--pt-panel);
  box-shadow:0 10px 28px rgba(15,23,42,.18);
}
.pt-block-context-menu[hidden] { display:none !important; }
.pt-reader-panel .pt-block-context-menu button {
  display:block; width:100%; margin:0; padding:7px 10px; border:0; border-radius:6px;
  background:transparent; color:var(--pt-ink); font:inherit; font-size:12px;
  line-height:1.35; text-align:left; white-space:nowrap; cursor:pointer;
}
.pt-reader-panel .pt-block-context-menu button:hover { background:var(--pt-accent-soft); }
.pt-reader-panel .pt-block-context-menu button:disabled {
  background:transparent; color:var(--pt-muted); cursor:default; opacity:.55;
}
.pt-block-context-menu .pt-menu-separator {
  height:1px; margin:4px 5px; background:var(--pt-line);
}
.pt-block.pt-editing { cursor:default; }
.pt-block-editor { display:flex; flex-direction:column; gap:8px; }
.pt-block-editor-input {
  width:100%; min-height:150px; resize:vertical; padding:9px 10px;
  border:1px solid #93c5fd; border-radius:7px; outline:none;
  box-sizing:border-box; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere;
  background:#fff; color:var(--pt-ink); font:inherit; line-height:1.65; cursor:text;
}
.pt-block-editor-input:focus { box-shadow:0 0 0 2px rgba(37,99,235,.14); }
.pt-block-editor-actions { display:flex; justify-content:flex-end; gap:7px; }
.pt-reader-panel .pt-block-editor-actions button {
  min-height:27px; margin:0; padding:4px 11px; border:1px solid var(--pt-line);
  border-radius:7px; background:#fff; color:var(--pt-ink); font:inherit;
  font-size:12px; cursor:pointer;
}
.pt-reader-panel .pt-block-editor-actions .pt-editor-save {
  border-color:#2563eb; background:#2563eb; color:#fff;
}
.pt-reader-panel .pt-block-editor-actions button:disabled { cursor:default; opacity:.55; }
.pt-block p { margin:0 0 .65em; }
.pt-block p,.pt-block li {
  text-align:var(--pt-reading-text-align);
  text-justify:inter-ideograph;
}
.pt-block p:last-child { margin-bottom:0; }
.pt-block ul,.pt-block ol { margin:.35em 0 .65em; padding-inline-start:1.8em; }
.pt-block blockquote {
  margin:.5em 0; padding:.15em .8em; border-inline-start:3px solid var(--pt-line);
  color:var(--pt-muted);
}
.pt-block a.pt-external-link { color:var(--pt-accent); text-decoration:underline; cursor:pointer; }
.pt-block del { color:var(--pt-muted); }
.pt-block hr { margin:.8em 0; border:0; border-top:1px solid var(--pt-line); }
.pt-heading { margin:0; color:var(--pt-ink); line-height:1.4; }
.pt-title { font-size:1.35em; font-weight:700; }
.pt-heading-1 { font-size:1.25em; }
.pt-heading-2 { font-size:1.12em; }
.pt-heading-3 { font-size:1.05em; }
.pt-block sub { font-size:.75em; vertical-align:sub; line-height:0; }
.pt-block sup { font-size:.75em; vertical-align:super; line-height:0; }
.pt-block pre,.pt-block code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.pt-block pre {
  margin:0; padding:9px 10px; overflow:auto; border-radius:8px;
  background:#f3f4f6; white-space:pre-wrap;
}
.pt-block-equation { overflow-x:auto; background:#f8fafc; text-align:center; }
.pt-equation-math {
  display:block; min-width:max-content; padding:8px 4px; overflow-x:auto; text-align:center;
}
.pt-math-inline { display:inline; white-space:normal; }
.pt-math-inline math { display:inline; font-size:1.05em; }
.pt-math-display { display:block; margin:.4em 0; overflow-x:auto; text-align:center; }
.pt-math-display math,.pt-equation-math math { display:block; margin:.35em auto; font-size:1.08em; }
.pt-math-fallback {
  padding:2px 6px; border-radius:4px; background:#f3f4f6; color:var(--pt-danger);
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.92em;
  white-space:pre-wrap;
}
.pt-block figure { margin:0; }
.pt-block img { max-width:100%; height:auto; display:block; margin:6px auto; }
.pt-image-missing {
  padding:18px; border:1px dashed #d9dee5; border-radius:8px;
  background:#f8fafc; color:#b42318; text-align:center;
}
.pt-block figcaption { margin-top:6px; color:var(--pt-muted); font-size:12px; text-align:center; }
.pt-table-content { overflow:auto; font-size:12px; }
.pt-block table { width:100%; border-collapse:collapse; }
.pt-block th,.pt-block td {
  padding:6px 8px; border:1px solid var(--pt-line); text-align:left; vertical-align:top;
}
.pt-status-bar {
  min-height:28px; flex:none; display:flex; align-items:center; padding:0 11px;
  overflow:hidden; border-top:1px solid var(--pt-line); background:#fff;
  color:var(--pt-muted); font-size:12px; text-overflow:ellipsis; white-space:nowrap;
}
.pt-pane-resize-handle {
  position:relative; z-index:20; width:9px; flex:0 0 9px; margin:0 -3px;
  background:#d9dee5; cursor:col-resize; touch-action:none; user-select:none;
}
.pt-pane-resize-handle:hover { background:#93c5fd; }
`;
