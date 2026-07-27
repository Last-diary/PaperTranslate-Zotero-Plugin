// 目录增强（移植自原项目 server/toc.js）
// 差异：签名用 FNV-1a 替代 sha1；缓存读写走 IOUtils。

import { getConfig } from "./config.mjs";
import { readJson, writeJson, tocEnhancementPath } from "./storage.mjs";
import { extractJson } from "./deepseek.mjs";
import { fnv1a64Hex } from "./utils.mjs";

function tocHeadingCandidates(blocks) {
  return blocks
    .filter((block) => block.text && (block.level || block.type === "title"))
    .map((block) => ({
      id: block.id,
      title: block.text.replace(/\s+/g, " ").trim().slice(0, 260),
      pageIdx: block.pageIdx,
      originalLevel: Number(block.level || (block.type === "title" ? 1 : 2))
    }));
}

function tocSignature(headings) {
  return fnv1a64Hex(JSON.stringify(headings.map((item) => ({
    id: item.id,
    title: item.title,
    pageIdx: item.pageIdx,
    originalLevel: item.originalLevel
  }))));
}

function normalizeTocLevel(value) {
  const level = Number(value);
  if (!Number.isFinite(level)) return null;
  if (level <= 0) return 0;
  return Math.min(Math.max(Math.round(level), 1), 4);
}

function applyTocEnhancement(blocks, items) {
  const levels = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.id !== "string") continue;
    const level = normalizeTocLevel(item.level);
    if (level !== null) levels.set(item.id, level);
  }

  if (!levels.size) return blocks;
  return blocks.map((block) => {
    if (!levels.has(block.id)) return block;
    const level = levels.get(block.id);
    const next = { ...block, tocEnhanced: true };
    if (level === 0) {
      delete next.level;
      next.tocExcluded = true;
    } else {
      next.level = level;
    }
    return next;
  });
}

async function readTocEnhancement(dir, signature) {
  const cache = await readJson(tocEnhancementPath(dir), null);
  if (!cache || cache.version !== 1 || cache.signature !== signature || !Array.isArray(cache.items)) return null;
  return cache;
}

async function writeTocEnhancement(dir, signature, items, model) {
  const payload = {
    version: 1,
    signature,
    model,
    enhancedAt: new Date().toISOString(),
    items
  };
  await writeJson(tocEnhancementPath(dir), payload);
  return payload;
}

export class TocEnhancer {
  async enhanceWithDeepSeek(headings) {
    const config = getConfig();
    if (!config.deepseek.apiKey) {
      throw new Error("缺少 DeepSeek API Key，无法执行目录增强。");
    }

    const payload = {
      model: config.deepseek.model,
      thinking: { type: config.deepseek.thinkingEnabled ? "enabled" : "disabled" },
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: [
            "You repair the table-of-contents hierarchy for academic papers.",
            "You receive heading candidates in document order from a PDF parser.",
            "Return only JSON in the shape {\"items\":[{\"id\":\"...\",\"level\":0|1|2|3|4,\"title\":\"...\"}]} using the same ids.",
            "Use level 1 for the paper title, level 2 for major sections, level 3 and 4 for subsections.",
            "Use level 0 only for false headings such as running headers, footers, captions, author blocks, affiliations, keywords, or body text misidentified as headings.",
            "Do not translate or rewrite titles; copy the original title text."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            headings,
            rules: [
              "Preserve document order.",
              "Prefer conventional paper structure: Abstract, Introduction, Related Work, Method, Experiments, Results, Discussion, Conclusion, References, Appendix.",
              "Numbered headings such as 2.1 should be children of their numbered parent."
            ]
          })
        }
      ]
    };

    if (config.deepseek.jsonMode !== false) {
      payload.response_format = { type: "json_object" };
    }

    const response = await fetch(`${config.deepseek.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${config.deepseek.apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`DeepSeek 目录增强请求失败：${response.status} ${body.slice(0, 500)}`);
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    const parsed = extractJson(content);
    if (!Array.isArray(parsed.items)) throw new Error("DeepSeek 目录增强 JSON 缺少 items 数组。");
    const knownIds = new Set(headings.map((item) => item.id));
    return parsed.items
      .filter((item) => item && knownIds.has(item.id))
      .map((item) => ({
        id: item.id,
        level: normalizeTocLevel(item.level) ?? 0,
        title: String(item.title || headings.find((heading) => heading.id === item.id)?.title || "").trim()
      }));
  }

  // 成功/失败都不阻断阅读：失败时返回原始 blocks 并附带 status.error
  async maybeEnhance(dir, blocks) {
    const config = getConfig();
    const status = {
      enabled: config.tocEnhancement.enabled,
      applied: false,
      cached: false,
      saved: false
    };
    if (!config.tocEnhancement.enabled) return { blocks, status };

    const allHeadings = tocHeadingCandidates(blocks);
    if (allHeadings.length < config.tocEnhancement.minHeadings) {
      status.reason = "heading_count_below_minimum";
      return { blocks, status };
    }

    const headings = allHeadings.slice(0, config.tocEnhancement.maxHeadings);
    const signature = tocSignature(headings);
    try {
      const cached = config.tocEnhancement.forceRefresh ? null : await readTocEnhancement(dir, signature);
      if (cached) {
        status.applied = true;
        status.cached = true;
        return { blocks: applyTocEnhancement(blocks, cached.items), status };
      }

      const items = await this.enhanceWithDeepSeek(headings);
      const saved = await writeTocEnhancement(dir, signature, items, config.deepseek.model);
      status.applied = true;
      status.saved = true;
      return { blocks: applyTocEnhancement(blocks, saved.items), status };
    } catch (error) {
      status.error = error.message;
      return { blocks, status };
    }
  }
}
