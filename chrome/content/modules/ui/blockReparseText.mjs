const UNSUPPORTED_BLOCK_TYPES = new Set(["table", "image", "chart"]);

export function canReparseBlock(block) {
  return Boolean(
    block
    && !UNSUPPORTED_BLOCK_TYPES.has(block.type)
    && Array.isArray(block.bbox)
    && Array.isArray(block.pageSize)
  );
}

function extractedText(block) {
  if (block?.type === "code") {
    return String(block.code_body || block.text || "").trim();
  }
  if (Array.isArray(block?.list_items)) {
    return block.list_items.map((item) => String(item || "").trim()).filter(Boolean).join("\n");
  }
  return String(block?.text || block?.content || block?.latex || "").trim();
}

export function replacementTextFromMineru(targetBlock, parsedBlocks) {
  const blocks = Array.isArray(parsedBlocks) ? parsedBlocks : [];
  let preferred = blocks;
  if (targetBlock?.type === "code") {
    preferred = blocks.filter((block) => block?.type === "code");
  } else if (targetBlock?.type === "equation") {
    preferred = blocks.filter((block) => block?.type === "equation");
  } else if (targetBlock?.type === "list") {
    preferred = blocks.filter((block) => block?.type === "list");
  } else if (targetBlock?.type === "title") {
    preferred = blocks.filter((block) => ["title", "text"].includes(block?.type));
  }
  if (!preferred.length) preferred = blocks;

  return preferred
    .map(extractedText)
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
