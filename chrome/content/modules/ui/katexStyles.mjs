export const KATEX_STYLESHEET_URL =
  "chrome://papertranslate/content/vendor/katex/katex.min.css";

export const KATEX_FONT_BASE_URL =
  "chrome://papertranslate/content/vendor/katex/fonts/";

export function prepareKatexStyles(css, fontBaseUrl = KATEX_FONT_BASE_URL) {
  return String(css || "").replace(
    /url\((['"]?)fonts\/([^)'"]+)\1\)/g,
    (_match, _quote, fileName) => `url("${fontBaseUrl}${fileName}")`
  );
}
