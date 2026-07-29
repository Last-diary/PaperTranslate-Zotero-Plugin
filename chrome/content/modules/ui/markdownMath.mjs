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

function isHorizontalWhitespace(value) {
  return value === " " || value === "\t";
}

function isTextBoundary(value) {
  return Boolean(value) && /[\p{L}\p{N}]/u.test(value);
}

function fencedCodeRangeAt(source, start) {
  const marker = source[start];
  if (!["`", "~"].includes(marker)) return null;
  if (start > 0 && source[start - 1] !== "\n") return null;
  let delimiterLength = 1;
  while (source[start + delimiterLength] === marker) delimiterLength += 1;
  if (delimiterLength < 3) return null;
  const closingPattern = new RegExp(
    `(?:^|\\n)[ \\t]{0,3}${marker === "`" ? "\\`" : "~"}{${delimiterLength},}[ \\t]*(?:\\r?\\n|$)`,
    "g"
  );
  closingPattern.lastIndex = start + delimiterLength;
  const match = closingPattern.exec(source);
  return match ? { end: match.index + match[0].length } : { end: source.length };
}

function codeRangeAt(source, start) {
  const fence = fencedCodeRangeAt(source, start);
  if (fence) return fence;
  if (source[start] !== "`" || isEscaped(source, start)) return null;
  let delimiterLength = 1;
  while (source[start + delimiterLength] === "`") delimiterLength += 1;
  const delimiter = "`".repeat(delimiterLength);
  const close = source.indexOf(delimiter, start + delimiterLength);
  return close < 0 ? null : { end: close + delimiterLength };
}

// 在已经识别出的行内公式与相邻文字之间保留一个 ASCII 空格。
// 展示公式、公式内部、转义美元符号以及 Markdown 代码片段保持原样。
export function normalizeInlineMathSpacing(sourceValue) {
  const source = String(sourceValue || "");
  let output = "";
  let cursor = 0;

  while (cursor < source.length) {
    const codeRange = codeRangeAt(source, cursor);
    if (codeRange) {
      output += source.slice(cursor, codeRange.end);
      cursor = codeRange.end;
      continue;
    }

    const range = mathRangeAt(source, cursor);
    if (!range) {
      output += source[cursor];
      cursor += 1;
      continue;
    }

    const raw = source.slice(range.start, range.end);
    if (range.display) {
      output += raw;
      cursor = range.end;
      continue;
    }

    let whitespaceStart = output.length;
    while (whitespaceStart > 0 && isHorizontalWhitespace(output[whitespaceStart - 1])) {
      whitespaceStart -= 1;
    }
    if (isTextBoundary(output[whitespaceStart - 1])) {
      output = `${output.slice(0, whitespaceStart)} `;
    }

    output += raw;

    let next = range.end;
    while (next < source.length && isHorizontalWhitespace(source[next])) next += 1;
    if (isTextBoundary(source[next])) {
      output += " ";
      cursor = next;
    } else {
      cursor = range.end;
    }
  }

  return output;
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
// DOMPurify 完成净化后，panelRenderer 再把已识别公式保存到受控占位节点，
// 最后由 Reader document 中的 MathJax 直接转换为 SVG。
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
