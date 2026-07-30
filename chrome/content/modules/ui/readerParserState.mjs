const PRESENTATIONS = {
  idle: {
    title: "尚未解析",
    detail: "MinerU 尚未生成正文内容。",
    status: "等待解析",
    actionLabel: "开始解析",
    busy: false,
    error: false
  },
  loading: {
    title: "正在解析 PDF",
    detail: "正在准备解析任务…",
    status: "解析中",
    actionLabel: "",
    busy: true,
    error: false
  },
  preparing: {
    title: "正在整理正文",
    detail: "正在加载解析结果…",
    status: "整理中",
    actionLabel: "",
    busy: true,
    error: false
  },
  error: {
    title: "解析未完成",
    detail: "请重试解析。",
    status: "解析失败",
    actionLabel: "重试",
    busy: false,
    error: true
  }
};

export function parserStatePresentation(phase, detail = "") {
  const base = PRESENTATIONS[phase] || PRESENTATIONS.idle;
  return {
    ...base,
    detail: String(detail || "").trim() || base.detail
  };
}

export function updateParserStateView(view, phase, detail = "") {
  const presentation = parserStatePresentation(phase, detail);
  view.root.dataset.phase = phase;
  view.root.setAttribute("aria-busy", presentation.busy ? "true" : "false");
  view.title.textContent = presentation.title;
  view.detail.textContent = presentation.detail;
  view.progress.hidden = !presentation.busy;
  view.errorMark.hidden = !presentation.error;
  view.button.hidden = !presentation.actionLabel;
  view.button.disabled = presentation.busy;
  view.button.textContent = presentation.actionLabel;
  return presentation;
}

export function createParserStateView(doc, { onAction } = {}) {
  const root = doc.createElement("section");
  root.className = "pt-parser-state";
  root.setAttribute("aria-live", "polite");

  const visual = doc.createElement("div");
  visual.className = "pt-parser-visual";
  visual.setAttribute("aria-hidden", "true");

  const spinner = doc.createElement("span");
  spinner.className = "pt-parser-spinner";
  const errorMark = doc.createElement("span");
  errorMark.className = "pt-parser-error-mark";
  errorMark.textContent = "!";
  visual.append(spinner, errorMark);

  const title = doc.createElement("h2");
  title.className = "pt-parser-title";
  const detail = doc.createElement("p");
  detail.className = "pt-parser-detail";
  const progress = doc.createElement("div");
  progress.className = "pt-parser-progress";
  progress.setAttribute("aria-hidden", "true");
  progress.appendChild(doc.createElement("span"));

  const button = doc.createElement("button");
  button.type = "button";
  button.className = "pt-button pt-parser-action";
  if (typeof onAction === "function") {
    button.addEventListener("click", onAction);
  }

  root.append(visual, title, detail, progress, button);
  const view = { root, title, detail, progress, errorMark, button };
  updateParserStateView(view, "idle");
  return view;
}
