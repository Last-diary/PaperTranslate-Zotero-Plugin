function closingFencePattern(character, minimumLength) {
  return new RegExp(
    `(?:\\r?\\n|^)[ ]{0,3}${character}{${minimumLength},}[\\t ]*(?:\\r?\\n)?$`
  );
}

function codeLanguage(infoString) {
  const token = String(infoString || "").trim().split(/\s+/, 1)[0] || "";
  return token
    .replace(/^\{?\.?/, "")
    .replace(/\}?$/, "")
    .replace(/[^a-z0-9_+.-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeCodeBlock(value) {
  const source = String(value ?? "").replace(/^\uFEFF/, "");
  const opening = source.match(/^[ ]{0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n/);
  if (!opening) return { code: source, language: "" };

  const fence = opening[1];
  const info = opening[2];
  if (fence[0] === "`" && info.includes("`")) {
    return { code: source, language: "" };
  }

  const bodyAndClosing = source.slice(opening[0].length);
  const closing = closingFencePattern(fence[0], fence.length).exec(bodyAndClosing);
  if (!closing) return { code: source, language: "" };

  return {
    code: bodyAndClosing.slice(0, closing.index),
    language: codeLanguage(info)
  };
}
