import assert from "node:assert/strict";
import test from "node:test";

import {
  createParserStateView,
  parserStatePresentation,
  updateParserStateView
} from "../chrome/content/modules/ui/readerParserState.mjs";
import { READER_PANEL_CSS } from "../chrome/content/modules/readerPanelStyles.mjs";

function mockElement(tagName) {
  return {
    tagName,
    children: [],
    dataset: {},
    attributes: {},
    hidden: false,
    disabled: false,
    textContent: "",
    className: "",
    append(...children) {
      this.children.push(...children);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(name, listener) {
      this.listener = { name, listener };
    }
  };
}

const doc = {
  createElement: (tagName) => mockElement(tagName)
};

test("parser state copy distinguishes idle, loading, and failure", () => {
  assert.deepEqual(parserStatePresentation("idle"), {
    title: "尚未解析",
    detail: "MinerU 尚未生成正文内容。",
    status: "等待解析",
    actionLabel: "开始解析",
    busy: false,
    error: false
  });
  assert.equal(parserStatePresentation("loading", "上传 PDF…").detail, "上传 PDF…");
  assert.deepEqual(parserStatePresentation("preparing"), {
    title: "正在整理正文",
    detail: "正在加载解析结果…",
    status: "整理中",
    actionLabel: "",
    busy: true,
    error: false
  });
  assert.equal(parserStatePresentation("error", "Token 缺失").actionLabel, "重试");
});

test("parser view exposes progress and retry without rebuilding the panel", () => {
  let actionCalls = 0;
  const view = createParserStateView(doc, {
    onAction: () => actionCalls++
  });

  assert.equal(view.root.dataset.phase, "idle");
  assert.equal(view.button.textContent, "开始解析");
  view.button.listener.listener();
  assert.equal(actionCalls, 1);

  updateParserStateView(view, "loading", "MinerU 解析中…");
  assert.equal(view.root.attributes["aria-busy"], "true");
  assert.equal(view.detail.textContent, "MinerU 解析中…");
  assert.equal(view.progress.hidden, false);
  assert.equal(view.button.hidden, true);

  updateParserStateView(view, "preparing", "正在加载正文内容…");
  assert.equal(view.root.attributes["aria-busy"], "true");
  assert.equal(view.title.textContent, "正在整理正文");
  assert.equal(view.detail.textContent, "正在加载正文内容…");
  assert.equal(view.progress.hidden, false);
  assert.equal(view.button.hidden, true);

  updateParserStateView(view, "error", "网络连接失败");
  assert.equal(view.root.attributes["aria-busy"], "false");
  assert.equal(view.detail.textContent, "网络连接失败");
  assert.equal(view.errorMark.hidden, false);
  assert.equal(view.button.hidden, false);
  assert.equal(view.button.textContent, "重试");
});

test("Reader styles force hidden parser actions out of layout", () => {
  assert.match(
    READER_PANEL_CSS,
    /\.pt-parser-action\[hidden\]\s*\{\s*display:none !important;\s*\}/
  );
});

test("Reader styles justify only paragraphs and list items with Gecko CJK spacing", () => {
  assert.match(
    READER_PANEL_CSS,
    /\.pt-block p,\s*\.pt-block li \{\s*text-align:var\(--pt-reading-text-align\);\s*text-justify:inter-character;\s*\}/
  );
  assert.doesNotMatch(READER_PANEL_CSS, /inter-ideograph/);
  assert.match(READER_PANEL_CSS, /\.pt-heading \{[^}]*text-align:left/);
  assert.match(READER_PANEL_CSS, /\.pt-block pre \{[^}]*text-align:left/);
  assert.doesNotMatch(
    READER_PANEL_CSS,
    /\.pt-markdown-view \{[^}]*text-align:justify/
  );
});
