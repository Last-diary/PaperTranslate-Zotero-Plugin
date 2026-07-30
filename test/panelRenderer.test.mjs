import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  MARKDOWN_SANITIZE_OPTIONS,
  TABLE_SANITIZE_OPTIONS,
  normalizeMathSource,
  renderSourceHtmlToken,
  safeBlockTypeClass
} from "../chrome/content/modules/ui/panelRenderer.mjs";
import {
  markdownMathExtension,
  normalizeInlineMathSpacing,
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

test("unsupported source tags remain visible instead of becoming HTML", () => {
  const marked = loadMarked();
  const markdown = new marked.Marked({ breaks: true, gfm: true });
  markdown.use({
    extensions: [markdownMathExtension],
    renderer: {
      html(token) {
        return renderSourceHtmlToken(token);
      }
    }
  });

  const inline = markdown.parse("before <search>term</search> after");
  assert.match(inline, /before &lt;search&gt;term&lt;\/search&gt; after/);

  const block = markdown.parse("<search>\nterm\n</search>");
  assert.equal(block, "&lt;search&gt;\nterm\n&lt;/search&gt;");

  const safeFormatting = markdown.parse("H<sub>2</sub>O");
  assert.match(safeFormatting, /H<sub>2<\/sub>O/);

  const activeContent = markdown.parse("<script>alert(1)</script>");
  assert.equal(activeContent, "&lt;script&gt;alert(1)&lt;/script&gt;");
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

test("inline math spacing is normalized only next to text", () => {
  assert.equal(
    normalizeInlineMathSpacing("结果为$x$时，令  $y$  equal z。"),
    "结果为 $x$ 时，令 $y$ equal z。"
  );
  assert.equal(
    normalizeInlineMathSpacing("取值为 $x$，且($y$)有效。"),
    "取值为 $x$，且($y$)有效。"
  );
  assert.equal(
    normalizeInlineMathSpacing("alpha\t$x$\tbeta"),
    "alpha $x$ beta"
  );
});

test("inline math spacing preserves display math, code, currency, and escapes", () => {
  const source = [
    "cost $5 and $10",
    "代码 `value$x$code` 不变。",
    "~~~txt",
    "value$x$code",
    "~~~",
    "$$x+y$$",
    String.raw`\$x$`
  ].join("\n");
  const expected = [
    "cost $5 and $10",
    "代码 `value$x$code` 不变。",
    "~~~txt",
    "value$x$code",
    "~~~",
    "$$x+y$$",
    String.raw`\$x$`
  ].join("\n");
  assert.equal(normalizeInlineMathSpacing(source), expected);
});

test("MathJax source normalization preserves complex TeX without exposing HTML", () => {
  const tex = String.raw`\text{fix rate}=\underset{\text{problems}}{\mathbb{E}}\left[\frac{c}{n}\right]\tag{1}`;
  const source = normalizeMathSource(tex, true);
  assert.equal(source, String.raw`\[\text{fix rate}=\underset{\text{problems}}{\mathbb{E}}\left[\frac{c}{n}\right]\tag{1}\]`);
  assert.doesNotMatch(source, /<[^>]+>/);
  assert.equal(normalizeMathSource("$x_1$", false), String.raw`\(x_1\)`);
});

test("sanitizer allow-lists exclude active content and remote images", () => {
  assert.ok(MARKDOWN_SANITIZE_OPTIONS.ALLOWED_TAGS.includes("a"));
  assert.ok(MARKDOWN_SANITIZE_OPTIONS.ALLOWED_TAGS.includes("sub"));
  assert.ok(!MARKDOWN_SANITIZE_OPTIONS.ALLOWED_TAGS.includes("img"));
  assert.ok(!MARKDOWN_SANITIZE_OPTIONS.ALLOWED_TAGS.includes("script"));
  assert.ok(!MARKDOWN_SANITIZE_OPTIONS.ALLOWED_ATTR.includes("onclick"));
  assert.ok(MARKDOWN_SANITIZE_OPTIONS.FORBID_ATTR.includes("style"));
  assert.ok(!MARKDOWN_SANITIZE_OPTIONS.ALLOWED_TAGS.includes("math"));
  assert.ok(!MARKDOWN_SANITIZE_OPTIONS.ALLOWED_TAGS.includes("svg"));

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
