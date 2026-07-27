// 存储层：每篇论文一个数据目录，位于 Zotero 数据目录下（不随同步上传）。
// 目录结构：<ZoteroData>/papertranslate/<attachmentKey>/
//   parser-manifest.json                     解析产物清单
//   .papertranslate-translations.zh.json     DeepSeek 译文缓存
//   .papertranslate-toc-enhancement.json     目录增强缓存
//   content_list.json / images/ / source.pdf MinerU 解析产物与原 PDF

import { ctx } from "./context.mjs";

export function rootDir() {
  return PathUtils.join(ctx.Zotero.DataDirectory.dir, "papertranslate");
}

export function itemDir(item) {
  return PathUtils.join(rootDir(), item.key);
}

export function manifestPath(dir) {
  return PathUtils.join(dir, "parser-manifest.json");
}

export function translationsPath(dir) {
  return PathUtils.join(dir, ".papertranslate-translations.zh.json");
}

export function tocEnhancementPath(dir) {
  return PathUtils.join(dir, ".papertranslate-toc-enhancement.json");
}

export async function ensureDir(dir) {
  await IOUtils.makeDirectory(dir, { createAncestors: true });
}

export async function readJson(path, fallback = null) {
  try {
    return await IOUtils.readJSON(path);
  } catch {
    return fallback;
  }
}

export async function writeJson(path, data) {
  await IOUtils.writeUTF8(path, JSON.stringify(data, null, 2));
}

export async function readManifest(item) {
  return readJson(manifestPath(itemDir(item)));
}

// 供条目面板/菜单显示状态
export async function getItemStatus(item) {
  const dir = itemDir(item);
  const manifest = await readJson(manifestPath(dir));
  const translations = manifest ? await readJson(translationsPath(dir), {}) : {};
  return {
    dir,
    manifest,
    translationCount: translations ? Object.keys(translations).length : 0
  };
}

export async function removeItemData(dir) {
  await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
}
