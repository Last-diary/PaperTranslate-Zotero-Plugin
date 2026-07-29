import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  MATHJAX_BASE_URL,
  MATHJAX_SCRIPT_URL,
  MATHJAX_VERSION,
  mathJaxConfig
} from "../chrome/content/modules/ui/mathJax.mjs";

test("MathJax is pinned to the local 3.2.2 SVG component", () => {
  assert.equal(MATHJAX_VERSION, "3.2.2");
  assert.equal(MATHJAX_SCRIPT_URL, `${MATHJAX_BASE_URL}/tex-svg-full.js`);
  assert.ok(fs.statSync(
    new URL("../chrome/content/vendor/mathjax/es5/tex-svg-full.js", import.meta.url)
  ).size > 1_000_000);
});

test("MathJax dynamic Reader configuration is scoped and restrictive", () => {
  const config = mathJaxConfig();
  assert.equal(config.startup.typeset, false);
  assert.deepEqual(config.tex.inlineMath, [["\\(", "\\)"]]);
  assert.deepEqual(config.tex.displayMath, [["\\[", "\\]"]]);
  assert.equal(config.svg.fontCache, "local");
  assert.deepEqual(config.loader.load, ["ui/safe"]);
  assert.equal(config.options.enableMenu, false);
  assert.equal(config.options.safeOptions.allow.URLs, "none");
  assert.ok(config.options.skipHtmlTags.includes("code"));
});
