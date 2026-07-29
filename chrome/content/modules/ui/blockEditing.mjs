export function blockSourceText(block) {
  if (["image", "chart", "table"].includes(block?.type)) {
    return Array.isArray(block.captions)
      ? block.captions.filter(Boolean).join("\n").trim()
      : "";
  }
  if (block?.type === "code") {
    return String(block.codeBody || block.text || "").trim();
  }
  return String(block?.text || "").trim();
}

export function setBlockSourceText(block, value) {
  const normalized = String(value || "").trim();
  if (["image", "chart", "table"].includes(block?.type)) {
    block.captions = normalized
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    return;
  }
  if (block?.type === "code") {
    // 代码块渲染优先读取 codeBody，因此必须与通用 text 字段同步。
    block.codeBody = normalized;
  }
  block.text = normalized;
}

export function shouldEditSource(mode, isTranslationEligible) {
  return mode === "original" || !isTranslationEligible;
}
