// 论文翻译服务（移植自原项目 server/translation.js）。
// 大模型请求通过 Provider 适配层发送；缓存读写走 IOUtils。

import { getConfig } from "./config.mjs";
import { chatCompletionText } from "./llm/openaiCompatible.mjs";
import { createLlmProvider } from "./llm/provider.mjs";
import { readJson, writeJson, translationsPath } from "./storage.mjs";
import { normalizeInlineMathSpacing } from "./ui/markdownMath.mjs";

export function extractJson(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/) || trimmed.match(/(\{[\s\S]*\})/);
  if (!match) throw new Error("大模型没有返回 JSON。");
  return JSON.parse(match[1]);
}

function normalizedHeadingText(block) {
  return String(block?.text || "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\d+(\.\d+)*\.?\s+/, "")
    .trim()
    .toUpperCase();
}

function headingLevel(block) {
  const level = Number(block?.level);
  if (Number.isFinite(level) && level > 0) return level;
  const match = String(block?.text || "").match(/^(#{1,6})\s+/);
  return match ? match[1].length : null;
}

function isHeadingBlock(block) {
  return headingLevel(block) !== null;
}

function isReferencesHeading(block) {
  const text = normalizedHeadingText(block);
  return [
    "REFERENCES",
    "REFERENCE",
    "BIBLIOGRAPHY",
    "参考文献",
    "引用文献"
  ].includes(text);
}

function isSupplementHeading(block) {
  const text = normalizedHeadingText(block);
  if (/^(SUPPLEMENT|SUPPLEMENTS|SUPPLEMENTARY)(\b|:)/.test(text)) return true;
  if (/^(APPENDIX|APPENDICES)(\b|:)/.test(text)) return true;
  return [
    "SUPPLEMENT",
    "SUPPLEMENTS",
    "SUPPLEMENTARY",
    "SUPPLEMENTARY MATERIAL",
    "SUPPLEMENTARY MATERIALS",
    "SUPPLEMENTARY INFORMATION",
    "SUPPORTING INFORMATION",
    "APPENDIX",
    "APPENDICES",
    "附录",
    "补充材料",
    "补充信息",
    "支持信息"
  ].includes(text);
}

function isBodyStartHeading(block) {
  const text = normalizedHeadingText(block);
  if (/^(ABSTRACT|KEYWORDS)(\b|[-—:])/.test(text)) return true;
  if (/^(INTRODUCTION)(\b|[-—:])/.test(text)) return true;
  return [
    "ABSTRACT",
    "摘要",
    "INTRODUCTION",
    "引言",
    "KEYWORDS",
    "关键词"
  ].includes(text);
}

function authorBlockIds(blocks) {
  const ids = new Set();
  const titleIndex = blocks.findIndex((block) => {
    const level = headingLevel(block);
    return block?.type === "title" || level === 1;
  });
  if (titleIndex < 0) return ids;

  const bodyStartIndex = blocks.findIndex((block, index) => index > titleIndex && isBodyStartHeading(block));
  const endIndex = bodyStartIndex > titleIndex ? bodyStartIndex : Math.min(blocks.length, titleIndex + 24);
  for (let index = titleIndex + 1; index < endIndex; index += 1) {
    const block = blocks[index];
    if (!block || headingLevel(block) !== null) continue;
    if (!["text", "header", "title"].includes(block.type || "text")) continue;
    if (String(block.text || "").trim()) ids.add(block.id);
  }
  return ids;
}

function sectionType(block) {
  if (isReferencesHeading(block)) return "references";
  if (isSupplementHeading(block)) return "supplement";
  return "";
}

export function filterTranslationBlocks(blocks, settings = {}) {
  const translateReferences = settings.translateReferences === true;
  const translateSupplement = settings.translateSupplement === true;
  const translateAuthors = settings.translateAuthors === true;
  if (translateReferences && translateSupplement && translateAuthors) return blocks;

  const authors = translateAuthors ? new Set() : authorBlockIds(blocks);
  let activeSection = null;
  return blocks.filter((block) => {
    if (block?.pdfOutline) return true;

    const outlineType = block?.outlineSection?.type;
    if (outlineType === "references" && !translateReferences) return false;
    if (outlineType === "supplement" && !translateSupplement) return false;
    const hasOutlineSection = Boolean(block?.outlineSection);

    if (!hasOutlineSection && isHeadingBlock(block)) {
      const level = headingLevel(block) || 1;
      const type = sectionType(block);
      if (type) activeSection = { type, level };
      else if (activeSection && level <= activeSection.level) activeSection = null;
    }

    if (!translateAuthors && authors.has(block.id)) return false;
    if (!hasOutlineSection && activeSection?.type === "references" && !translateReferences) return false;
    if (!hasOutlineSection && activeSection?.type === "supplement" && !translateSupplement) return false;
    return true;
  });
}

function chunkBlocks(blocks, maxChars = 6500) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const block of blocks) {
    const len = block.translationText.length + 80;
    if (current.length && chars + len > maxChars) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(block);
    chars += len;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function translationSourceText(block) {
  if (!block) return "";
  if (["image", "chart", "table"].includes(block.type)) {
    return Array.isArray(block.captions) ? block.captions.filter(Boolean).join("\n").trim() : "";
  }
  if (["code", "equation"].includes(block.type)) return "";
  return String(block.text || "").trim();
}

function translatableBlock(block) {
  const translationText = translationSourceText(block);
  return translationText ? { ...block, translationText } : null;
}

// 面板用：可翻译 block 的 id 集合（决定译文模式下是否替换该块）
export function eligibleTranslationIds(blocks, settings = {}) {
  return new Set(
    filterTranslationBlocks(blocks, settings)
      .map(translatableBlock)
      .filter(Boolean)
      .map((block) => block.id)
  );
}

export class TranslationService {
  async translateChunk(chunk) {
    const config = getConfig();
    const provider = createLlmProvider(config.llm);
    const data = await provider.createChatCompletion({
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: [
            "You are a precise academic paper translator.",
            "Translate English academic paper blocks into Simplified Chinese.",
            "Keep equations, code, citations, variable names, URLs, and markdown tables intact.",
            "Return only JSON in the shape {\"translations\":[{\"id\":\"...\",\"text\":\"...\"}]}."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            target_language: "Simplified Chinese",
            blocks: chunk.map((block) => ({ id: block.id, type: block.type, text: block.translationText }))
          })
        }
      ]
    }, { json: true });
    const content = chatCompletionText(data);
    const parsed = extractJson(content);
    if (!Array.isArray(parsed.translations)) throw new Error("大模型 JSON 缺少 translations 数组。");
    return parsed.translations;
  }

  async translateBlocks({ dir, allBlocks, ids = [], force = false, onChunk = null }) {
    const config = getConfig();
    const requested = new Set(Array.isArray(ids) ? ids : []);
    const cache = (await readJson(translationsPath(dir), {})) || {};
    const sourceBlocks = filterTranslationBlocks(allBlocks, config.translation);
    const blocks = sourceBlocks
      .map(translatableBlock)
      .filter(Boolean)
      .filter((block) => !requested.size || requested.has(block.id))
      .filter((block) => force || !cache[block.id]);

    let translated = 0;
    const total = blocks.length;
    for (const chunk of chunkBlocks(blocks)) {
      const items = await this.translateChunk(chunk);
      for (const item of items) {
        if (item && typeof item.id === "string" && typeof item.text === "string") {
          cache[item.id] = normalizeInlineMathSpacing(item.text.trim());
          translated += 1;
        }
      }
      await writeJson(translationsPath(dir), cache);
      if (onChunk) onChunk(cache, translated, total);
    }

    return { translated, translations: cache };
  }
}
