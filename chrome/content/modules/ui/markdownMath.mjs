function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isEscaped(source, index) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function findClosingSequence(source, start, closingSequence, { singleLine = false } = {}) {
  for (let cursor = start; cursor <= source.length - closingSequence.length; cursor += 1) {
    if (singleLine && (source[cursor] === "\n" || source[cursor] === "\r")) return -1;
    if (source.startsWith(closingSequence, cursor) && !isEscaped(source, cursor)) {
      return cursor;
    }
  }
  return -1;
}

function findDollarClose(source, start, delimiter) {
  const singleDollar = delimiter === "$";
  for (let cursor = start; cursor <= source.length - delimiter.length; cursor += 1) {
    if (singleDollar && (source[cursor] === "\n" || source[cursor] === "\r")) return -1;
    if (!source.startsWith(delimiter, cursor) || isEscaped(source, cursor)) continue;
    if (singleDollar && (source[cursor - 1] === "$" || source[cursor + 1] === "$")) continue;
    if (singleDollar && /\s/.test(source[cursor - 1] || "")) continue;
    return cursor;
  }
  return -1;
}

export function mathRangeAt(sourceValue, start) {
  const source = String(sourceValue || "");
  if (source.startsWith("\\(", start) && !isEscaped(source, start)) {
    const close = findClosingSequence(source, start + 2, "\\)", { singleLine: true });
    return close < 0
      ? null
      : { start, end: close + 2, tex: source.slice(start + 2, close), display: false };
  }

  if (source.startsWith("\\[", start) && !isEscaped(source, start)) {
    const close = findClosingSequence(source, start + 2, "\\]");
    return close < 0
      ? null
      : { start, end: close + 2, tex: source.slice(start + 2, close), display: true };
  }

  if (source[start] !== "$" || isEscaped(source, start)) return null;
  const delimiter = source[start + 1] === "$" ? "$$" : "$";
  const contentStart = start + delimiter.length;
  if (delimiter === "$" && /\s/.test(source[contentStart] || "")) return null;
  const close = findDollarClose(source, contentStart, delimiter);
  if (close < 0 || close === contentStart) return null;
  return {
    start,
    end: close + delimiter.length,
    tex: source.slice(contentStart, close),
    display: delimiter === "$$"
  };
}

function findMathStart(source) {
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (mathRangeAt(source, cursor)) return cursor;
  }
  return -1;
}

export function splitMathSegments(sourceValue) {
  const source = String(sourceValue || "");
  const segments = [];
  let cursor = 0;
  let textStart = 0;
  while (cursor < source.length) {
    const range = mathRangeAt(source, cursor);
    if (!range) {
      cursor += 1;
      continue;
    }
    if (cursor > textStart) {
      segments.push({ type: "text", text: source.slice(textStart, cursor) });
    }
    segments.push({
      type: range.display ? "display" : "inline",
      tex: range.tex
    });
    cursor = range.end;
    textStart = cursor;
  }
  if (textStart < source.length) {
    segments.push({ type: "text", text: source.slice(textStart) });
  }
  if (!segments.length) segments.push({ type: "text", text: source });
  return segments;
}

// 先让 Marked 把公式视为不可拆分的 token，并返回转义后的原始定界符。
// DOMPurify 完成净化后，panelRenderer 再在文本节点中调用 KaTeX。
export const markdownMathExtension = {
  name: "paperTranslateMath",
  level: "inline",
  start(source) {
    return findMathStart(source);
  },
  tokenizer(source) {
    const range = mathRangeAt(source, 0);
    if (!range) return undefined;
    const raw = source.slice(0, range.end);
    return {
      type: "paperTranslateMath",
      raw,
      text: raw
    };
  },
  renderer(token) {
    return escapeHtml(token.raw);
  }
};
