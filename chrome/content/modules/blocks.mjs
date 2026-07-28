// MinerU 内容块归一化（移植自原项目 server/projects.js 中的纯数据逻辑）
// 差异：block id 用 FNV-1a 64 位替代 Node crypto sha1；文件读取改用 IOUtils。

import { fnv1a64Hex } from "./utils.mjs";
import { readJson } from "./storage.mjs";

const NON_BODY_BLOCK_TYPES = new Set([
  "aside_text",
  "page_footnote",
  "header",
  "footer",
  "page_header",
  "page_footer",
  "page_number"
]);

function stripHeading(text) {
  return String(text || "").replace(/^#{1,6}\s+/, "").trim();
}

function textFromParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts.map((item) => item.content || item.text || "").join("").trim();
}

export function contentBlockText(block = {}) {
  if (typeof block.text === "string") return stripHeading(block.text);
  if (Array.isArray(block.list_items)) return block.list_items.join("\n").trim();
  if (typeof block.content === "string") return block.content.trim();
  if (typeof block.code_body === "string") return block.code_body.trim();
  if (typeof block.table_body === "string") return block.table_body.trim();
  if (Array.isArray(block.image_caption)) return block.image_caption.join("\n").trim();
  if (Array.isArray(block.table_caption)) return block.table_caption.join("\n").trim();
  if (Array.isArray(block.chart_caption)) return block.chart_caption.join("\n").trim();
  if (Array.isArray(block.code_caption)) return block.code_caption.join("\n").trim();
  if (block.content?.paragraph_content) return textFromParts(block.content.paragraph_content);
  if (block.content?.title_content) return textFromParts(block.content.title_content);
  return "";
}

function isStandalonePageNumberText(text) {
  const value = String(text || "").trim();
  return /^[-–—]?\s*(\d{1,4}|[ivxlcdm]{1,8})\s*[-–—]?$/i.test(value)
    || /^\d{1,4}\s*\/\s*\d{1,4}$/.test(value);
}

function isPageNumberBlock(block, text, pageSize) {
  if (block.type === "page_number") return true;
  if (!isStandalonePageNumberText(text) || !Array.isArray(block.bbox)) return false;

  const [x1, y1, x2, y2] = block.bbox.map(Number);
  const width = Number(pageSize?.[0] || 1000);
  const height = Number(pageSize?.[1] || 1000);
  if (![x1, y1, x2, y2, width, height].every(Number.isFinite)) return false;

  const centerY = (y1 + y2) / 2 / height;
  const blockWidth = Math.max(0, x2 - x1);
  const blockHeight = Math.max(0, y2 - y1);
  const nearPageEdge = centerY < 0.08 || centerY > 0.9;
  const smallStandaloneBox = blockWidth < width * 0.18 && blockHeight < height * 0.04;
  return nearPageEdge && smallStandaloneBox;
}

export function normalizeBlock(
  block,
  index,
  pageSize = null,
  { hideNonBody = true } = {}
) {
  // “更好的阅读体验”默认隐藏 MinerU 标记出的非正文块。关闭后保留这些
  // 块供 Reader 面板显示；is_discarded 仍始终排除，因为它表示解析器已判废。
  if (hideNonBody && NON_BODY_BLOCK_TYPES.has(block.type)) return null;
  const text = contentBlockText(block);
  const isMedia = ["image", "table", "chart"].includes(block.type);
  if (!isMedia && !text) return null;
  if (block.is_discarded) return null;
  const resolvedPageSize = pageSize || (Array.isArray(block.page_size) ? block.page_size : [1000, 1000]);
  if (hideNonBody && isPageNumberBlock(block, text, resolvedPageSize)) return null;
  const blockPosition = block.block_position || `${block.page_idx || 0}-${index}`;
  const id = fnv1a64Hex(`${block.id || ""}:${blockPosition}:${index}`);
  const rawPath = block.img_path || "";
  const imagePath = rawPath ? rawPath.replace(/^\/+/, "images/") : "";
  const captions = []
    .concat(block.image_caption || [])
    .concat(block.table_caption || [])
    .concat(block.chart_caption || [])
    .concat(block.code_caption || []);
  return {
    id,
    sourceId: block.id || id,
    position: blockPosition,
    type: block.type || "text",
    subType: block.sub_type || "",
    level: block.text_level || block.level || (block.type === "title" ? 2 : undefined),
    text,
    pageIdx: Number(block.page_idx || 0),
    bbox: block.bbox || null,
    pageSize: resolvedPageSize,
    imagePath,
    captions,
    tableBody: block.table_body || "",
    codeBody: block.code_body || "",
    textFormat: block.text_format || "",
    mergePrev: Boolean(block.merge_prev)
  };
}

async function pickContentFile(dir, manifest = null) {
  const manifestFile = manifest?.files?.contentList;
  if (manifestFile) return manifestFile;
  const children = await IOUtils.getChildren(dir).catch(() => []);
  const names = children.map((p) => PathUtils.filename(p));
  if (names.includes("content_list.json")) return "content_list.json";
  return names.find((name) => name.endsWith("_content_list.json")) || "";
}

export async function loadBlocks(dir, manifest = null, { hideNonBody = true } = {}) {
  const contentFile = await pickContentFile(dir, manifest);
  if (contentFile) {
    const data = await readJson(PathUtils.join(dir, contentFile), []);
    if (!Array.isArray(data)) return [];
    return data
      .map((block, index) => normalizeBlock({
        ...block,
        block_position: `${block.page_idx || 0}-${index}`
      }, index, [1000, 1000], { hideNonBody }))
      .filter(Boolean);
  }

  const blockList = await readJson(PathUtils.join(dir, "block_list.json"), null);
  if (blockList) {
    const pages = Array.isArray(blockList.pdfData) ? blockList.pdfData : [];
    return pages
      .flatMap((page, pageIndex) => page.map((block, blockIndex) => normalizeBlock(
        { ...block, page_idx: block.page_idx ?? pageIndex },
        blockIndex,
        null,
        { hideNonBody }
      )))
      .filter(Boolean);
  }

  return [];
}

// 供阅读面板生成目录（简化自 public/app.mjs 的 tocBlocks）
export function tocItems(blocks) {
  const items = blocks.filter((block) => block.text && block.level && !block.tocExcluded);
  const levels = items.map((block) => Number(block.level)).filter((level) => Number.isFinite(level));
  const baseLevel = levels.length ? Math.min(...levels) : 1;
  return items.map((block) => {
    const rawLevel = Number(block.level || baseLevel);
    const tocLevel = Number.isFinite(rawLevel) ? rawLevel - baseLevel + 1 : 1;
    return {
      id: block.id,
      text: block.text,
      pageIdx: block.pageIdx,
      tocLevel: Math.min(Math.max(tocLevel, 1), 4)
    };
  });
}
