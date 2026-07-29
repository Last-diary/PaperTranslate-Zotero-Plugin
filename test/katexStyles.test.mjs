import test from "node:test";
import assert from "node:assert/strict";
import {
  KATEX_FONT_BASE_URL,
  prepareKatexStyles
} from "../chrome/content/modules/ui/katexStyles.mjs";

test("KaTeX font URLs are rewritten for the registered chrome package", () => {
  const css = [
    "@font-face{src:url(fonts/KaTeX_Main-Regular.woff2) format(\"woff2\")}",
    "@font-face{src:url('fonts/KaTeX_Math-Italic.woff') format(\"woff\")}",
    ".external{background:url(\"images/example.svg\")}"
  ].join("");

  const prepared = prepareKatexStyles(css);
  assert.match(
    prepared,
    new RegExp(`${KATEX_FONT_BASE_URL}KaTeX_Main-Regular\\.woff2`)
  );
  assert.match(
    prepared,
    new RegExp(`${KATEX_FONT_BASE_URL}KaTeX_Math-Italic\\.woff`)
  );
  assert.match(prepared, /url\("images\/example\.svg"\)/);
  assert.doesNotMatch(prepared, /url\(['"]?fonts\//);
});
