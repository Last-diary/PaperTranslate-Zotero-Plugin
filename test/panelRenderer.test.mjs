import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  MARKDOWN_SANITIZE_OPTIONS,
  stripKatexSourceAnnotations,
  TABLE_SANITIZE_OPTIONS,
  safeBlockTypeClass
} from "../chrome/content/modules/ui/panelRenderer.mjs";
import {
  markdownMathExtension,
  splitMathSegments
} from "../chrome/content/modules/ui/markdownMath.mjs";

function loadMarked() {
  const source = fs.readFileSync(
    new URL("../chrome/content/vendor/marked/marked.umd.js", import.meta.url),
    "utf8"
  );
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.marked;
}

function loadKatex() {
  const source = fs.readFileSync(
    new URL("../chrome/content/vendor/katex/katex.min.js", import.meta.url),
    "utf8"
  );
  const sandbox = {};
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.katex;
}

test("vendored Marked 18 parses GFM and preserves math tokens", () => {
  const marked = loadMarked();
  const markdown = new marked.Marked({ breaks: true, gfm: true });
  markdown.use({ extensions: [markdownMathExtension] });
  const output = markdown.parse(
    "H<sub>2</sub>O and $x_1$ with **bold**\n\n| A | B |\n| - | - |\n| 1 | 2 |"
  );

  assert.match(output, /<sub>2<\/sub>/);
  assert.match(output, /\$x_1\$/);
  assert.match(output, /<strong>bold<\/strong>/);
  assert.match(output, /<table>/);
});

test("math segmentation ignores currency-like and escaped dollars", () => {
  assert.deepEqual(splitMathSegments("cost $5 and $10"), [
    { type: "text", text: "cost $5 and $10" }
  ]);
  assert.deepEqual(splitMathSegments(String.raw`\$5 and $x_1$`), [
    { type: "text", text: String.raw`\$5 and ` },
    { type: "inline", tex: "x_1" }
  ]);
});

test("KaTeX MathML source annotation is stripped before sanitization", () => {
  const katex = loadKatex();
  const tex = String.raw`\operatorname{Attention}(Q,K,V)=\operatorname{softmax}(\frac{QK^{T}}{\sqrt{d_k}})V\tag{1}`;
  const markup = katex.renderToString(tex, {
    displayMode: true,
    output: "mathml",
    throwOnError: false
  });

  assert.match(markup, /<annotation encoding="application\/x-tex">/);
  assert.match(markup, /\\operatorname\{Attention\}/);

  const stripped = stripKatexSourceAnnotations(markup);
  assert.match(stripped, /<math\b/);
  assert.match(stripped, /<mfrac>/);
  assert.doesNotMatch(stripped, /<annotation\b/);
  assert.doesNotMatch(stripped, /\\operatorname\{Attention\}/);
});

test("sanitizer allow-lists exclude active content and remote images", () => {
  assert.ok(MARKDOWN_SANITIZE_OPTIONS.ALLOWED_TAGS.includes("a"));
  assert.ok(MARKDOWN_SANITIZE_OPTIONS.ALLOWED_TAGS.includes("sub"));
  assert.ok(!MARKDOWN_SANITIZE_OPTIONS.ALLOWED_TAGS.includes("img"));
  assert.ok(!MARKDOWN_SANITIZE_OPTIONS.ALLOWED_TAGS.includes("script"));
  assert.ok(!MARKDOWN_SANITIZE_OPTIONS.ALLOWED_ATTR.includes("onclick"));
  assert.ok(MARKDOWN_SANITIZE_OPTIONS.FORBID_ATTR.includes("style"));

  assert.deepEqual(
    TABLE_SANITIZE_OPTIONS.ALLOWED_ATTR.slice().sort(),
    ["align", "colspan", "rowspan", "scope"]
  );
});

test("block type classes cannot break out of the class attribute", () => {
  assert.equal(safeBlockTypeClass("ref_text"), "ref_text");
  assert.equal(safeBlockTypeClass('x" onclick="alert(1)'), "x-onclick-alert-1");
  assert.equal(safeBlockTypeClass(""), "text");
});
