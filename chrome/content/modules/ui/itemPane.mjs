// 条目面板区域（Zotero 7+ 官方 ItemPaneManager API）：
// 显示当前条目 PDF 的解析/翻译状态，并提供操作按钮。

import { ctx } from "../context.mjs";
import {
  resolvePdfAttachment,
  attachmentDisplayTitle,
  parseAttachment,
  translateAttachment,
  openInReader
} from "./actions.mjs";
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
      l10nID: "papertranslate-section-sidenav",
      icon: rootURI + "icons/section-20.svg"
    },
    onRender: ({ body, item, setSectionSummary }) => {
      setSectionSummary("加载中…");
      renderSection(body, item, setSectionSummary).catch((error) => {
        setSectionSummary("读取失败");
        body.textContent = String(error?.message || error);
      });
    }
  });
}

function makeButton(doc, label, onClick) {
  const button = doc.createElementNS(HTML_NS, "button");
  button.type = "button";
  button.textContent = label;
  button.style.cssText = [
    "flex:1 1 92px",
    "min-width:0",
    "min-height:30px",
    "padding:4px 12px",
    "cursor:pointer"
  ].join(";");
  button.addEventListener("click", () => {
    Promise.resolve(onClick()).catch((error) => ctx.Zotero.logError(error));
  });
  return button;
}

function makeMetric(doc, value, label) {
  const metric = doc.createElementNS(HTML_NS, "div");
  metric.style.cssText = [
    "min-width:0",
    "padding:8px 6px",
    "border:1px solid var(--fill-quinary)",
    "border-radius:6px",
    "text-align:center"
  ].join(";");

  const metricValue = doc.createElementNS(HTML_NS, "div");
  metricValue.textContent = String(value);
  metricValue.style.cssText = [
    "font-size:1.08em",
    "font-weight:600",
    "font-variant-numeric:tabular-nums",
    "line-height:1.25"
  ].join(";");

  const metricLabel = doc.createElementNS(HTML_NS, "div");
  metricLabel.textContent = label;
  metricLabel.style.cssText = [
    "margin-top:2px",
    "color:var(--fill-secondary)",
    "font-size:0.82em",
    "line-height:1.25",
    "white-space:nowrap"
  ].join(";");

  metric.append(metricValue, metricLabel);
  return metric;
}

function makeStatusLine(doc, text, color) {
  const line = doc.createElementNS(HTML_NS, "div");
  line.style.cssText = [
    "display:flex",
    "align-items:center",
    "gap:6px",
    "color:var(--fill-secondary)",
    "font-size:0.9em",
    "font-weight:600"
  ].join(";");

  const dot = doc.createElementNS(HTML_NS, "span");
  dot.style.cssText = [
    "display:inline-block",
    "width:8px",
    "height:8px",
    "flex:0 0 8px",
    "border-radius:50%",
    `background:${color}`
  ].join(";");
  line.append(dot, text);
  return line;
}

async function renderSection(body, item, setSectionSummary = () => {}) {
  const doc = body.ownerDocument;
  body.textContent = "";
  body.style.cssText = [
    "display:flex",
    "flex-direction:column",
    "gap:10px",
    "padding:2px 0 6px"
  ].join(";");

  const attachment = resolvePdfAttachment(item);
  if (!attachment) {
    setSectionSummary("无 PDF");
    const empty = doc.createElementNS(HTML_NS, "div");
    empty.textContent = "所选条目没有 PDF 附件。";
    empty.style.cssText = "color:var(--fill-secondary); line-height:1.5;";
    body.appendChild(empty);
    return;
  }

  const { manifest, translationCount } = await storage.getItemStatus(attachment);
  const paperTitle = attachmentDisplayTitle(attachment, manifest, 240);

  const overview = doc.createElementNS(HTML_NS, "div");
  overview.style.cssText = "display:flex; flex-direction:column; gap:6px; min-width:0;";

  if (manifest) {
    const date = manifest.createdAt ? manifest.createdAt.slice(0, 10) : "";
    const pageCount = manifest.pageCount || "—";
    const blockCount = manifest.blockCount || "—";

    setSectionSummary(`${pageCount} 页 · ${blockCount} 块 · 译文 ${translationCount} 段`);
    overview.appendChild(makeStatusLine(doc, "已解析", "var(--accent-green)"));

    const title = doc.createElementNS(HTML_NS, "div");
    title.textContent = paperTitle;
    title.title = paperTitle;
    title.style.cssText = [
      "display:-webkit-box",
      "-webkit-box-orient:vertical",
      "-webkit-line-clamp:2",
      "overflow:hidden",
      "font-weight:600",
      "line-height:1.4",
      "overflow-wrap:anywhere"
    ].join(";");
    overview.appendChild(title);

    const metrics = doc.createElementNS(HTML_NS, "div");
    metrics.style.cssText = [
      "display:grid",
      "grid-template-columns:repeat(3,minmax(0,1fr))",
      "gap:6px"
    ].join(";");
    metrics.append(
      makeMetric(doc, pageCount, "页数"),
      makeMetric(doc, blockCount, "内容块"),
      makeMetric(doc, translationCount, "译文段")
    );

    const parsedAt = doc.createElementNS(HTML_NS, "div");
    parsedAt.textContent = date ? `解析日期：${date}` : "解析日期：未知";
    parsedAt.style.cssText = [
      "color:var(--fill-secondary)",
      "font-size:0.86em",
      "font-variant-numeric:tabular-nums",
      "line-height:1.4"
    ].join(";");

    body.append(overview, metrics, parsedAt);
  } else {
    setSectionSummary("尚未解析");
    overview.appendChild(makeStatusLine(doc, "尚未解析", "var(--fill-tertiary)"));

    const title = doc.createElementNS(HTML_NS, "div");
    title.textContent = paperTitle;
    title.title = paperTitle;
    title.style.cssText = "font-weight:600; line-height:1.4; overflow-wrap:anywhere;";
    overview.appendChild(title);

    const hint = doc.createElementNS(HTML_NS, "div");
    hint.textContent = "尚未生成 MinerU 解析结果。";
    hint.style.cssText = "color:var(--fill-secondary); font-size:0.9em; line-height:1.4;";
    overview.appendChild(hint);
    body.appendChild(overview);
  }

  const row = doc.createElementNS(HTML_NS, "div");
  row.style.cssText = "display:flex; flex-wrap:wrap; gap:6px;";

  const parseButton = makeButton(doc, manifest ? "重新解析" : "解析 PDF", async () => {
    await parseAttachment(attachment, { force: Boolean(manifest) });
    await renderSection(body, item, setSectionSummary);
  });
  const translateButton = makeButton(doc, "翻译全文", async () => {
    await translateAttachment(attachment);
    await renderSection(body, item, setSectionSummary);
  });
  translateButton.disabled = !manifest;
  const openButton = makeButton(doc, "打开阅读", () => openInReader(attachment));

  row.append(parseButton, translateButton, openButton);
  body.appendChild(row);
}
