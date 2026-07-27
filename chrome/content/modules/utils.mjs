// 通用工具函数（移植自原项目 server/utils.js 与 public/src/utils.mjs）

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function safeName(value) {
  return String(value || "paper")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120)
    .replace(/^_+|_+$/g, "") || "paper";
}

export function cleanTitle(text, fallback) {
  const title = String(text || "").replace(/\s+/g, " ").trim();
  if (!title) return fallback;
  return title.length > 180 ? `${title.slice(0, 177)}...` : title;
}

export function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function randId() {
  try {
    return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

// FNV-1a 64 位哈希，替代 Node 的 crypto sha1，
// 用于生成确定性的 block id 和目录增强签名（同步实现，足够稳定）。
export function fnv1a64Hex(input) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const text = String(input);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}
