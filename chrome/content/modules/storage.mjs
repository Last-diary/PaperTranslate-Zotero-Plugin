// 存储层：每篇论文一个数据目录，位于 Zotero 数据目录下（不随同步上传）。
// 目录结构：<ZoteroData>/papertranslate/<attachmentKey>/
//   parser-manifest.json                     解析产物清单
//   .papertranslate-translations.zh.json     DeepSeek 译文缓存
//   .papertranslate-source-overrides.json    用户编辑的原文覆盖与待重译块
//   .papertranslate-toc-enhancement.json     目录增强缓存
//   .papertranslate-block-regions.json       MinerU 逻辑块到 PDF 区域的映射缓存
//   content_list.json / images/ / source.pdf MinerU 解析产物与原 PDF

import { ctx } from "./context.mjs";

export function rootDir() {
  return PathUtils.join(ctx.Zotero.DataDirectory.dir, "papertranslate");
}

export async function openPaperTranslateDataDirectory() {
  const root = checkedRootDir();
  await ensureDir(root);

  // Zotero 的 PreferencePanes API 没有提供打开插件子目录的方法。官方设置页用
  // DataDirectory.reveal() 打开数据根目录；Zotero.File.reveal(path) 是官方源码中
  // 用于任意路径的内部入口，因此把访问集中在这里并做能力检测与安全降级。
  if (typeof ctx.Zotero?.File?.reveal === "function") {
    ctx.Zotero.debug?.(`PaperTranslate storage: revealing ${root}`);
    await ctx.Zotero.File.reveal(root);
    return true;
  }
  if (typeof ctx.Zotero?.DataDirectory?.reveal === "function") {
    ctx.Zotero.debug?.(
      "PaperTranslate storage: Zotero.File.reveal unavailable; revealing Zotero data directory"
    );
    await ctx.Zotero.DataDirectory.reveal();
    return false;
  }
  throw new Error("当前 Zotero 版本不支持打开数据目录。");
}

export function itemDir(item) {
  return itemDirForKey(item?.key);
}

export function itemDirForKey(value) {
  const root = checkedRootDir();
  const key = String(value || "").trim();
  if (!key || key.length > 64 || key.includes("/") || key.includes("\\")) {
    throw new Error("无法确定论文缓存目录。");
  }
  const dir = PathUtils.join(root, key);
  if (PathUtils.parent(dir) !== root || PathUtils.filename(dir) !== key) {
    throw new Error("论文缓存目录校验失败。");
  }
  return dir;
}

export function manifestPath(dir) {
  return PathUtils.join(dir, "parser-manifest.json");
}

export function translationsPath(dir) {
  return PathUtils.join(dir, ".papertranslate-translations.zh.json");
}

export function sourceOverridesPath(dir) {
  return PathUtils.join(dir, ".papertranslate-source-overrides.json");
}

export function tocEnhancementPath(dir) {
  return PathUtils.join(dir, ".papertranslate-toc-enhancement.json");
}

export function blockRegionsPath(dir) {
  return PathUtils.join(dir, ".papertranslate-block-regions.json");
}

export function documentReparsePath(dir) {
  return PathUtils.join(dir, ".papertranslate-document-reparse.json");
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

function checkedRootDir() {
  const dataDir = String(ctx.Zotero?.DataDirectory?.dir || "");
  if (!dataDir) throw new Error("无法确定 Zotero 数据目录。");
  const root = PathUtils.join(dataDir, "papertranslate");
  if (PathUtils.parent(root) !== dataDir || PathUtils.filename(root) !== "papertranslate") {
    throw new Error("PaperTranslate 缓存目录校验失败，已取消清除。");
  }
  return root;
}

function checkedItemDir(item) {
  return itemDirForKey(item?.key);
}

export async function clearItemTranslationCache(item) {
  const path = translationsPath(checkedItemDir(item));
  const existed = await IOUtils.exists(path);
  await IOUtils.remove(path, { ignoreAbsent: true });
  return { removed: existed };
}

export async function clearItemPaperTranslateData(item) {
  const dir = checkedItemDir(item);
  const existed = await IOUtils.exists(dir);
  await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
  return { removed: existed };
}

export async function clearAllTranslationCaches() {
  const root = checkedRootDir();
  const children = await IOUtils.getChildren(root).catch(() => []);
  let removed = 0;
  for (const child of children) {
    const stat = await IOUtils.stat(child).catch(() => null);
    if (stat?.type !== "directory") continue;
    const path = translationsPath(child);
    if (!(await IOUtils.exists(path))) continue;
    await IOUtils.remove(path, { ignoreAbsent: true });
    removed++;
  }
  return { removed };
}

export async function getPaperTranslateStorageUsage() {
  const root = checkedRootDir();
  if (!(await IOUtils.exists(root))) {
    return { bytes: 0, files: 0, directories: 0, papers: 0 };
  }

  const pending = [{ path: root, depth: 0 }];
  let bytes = 0;
  let files = 0;
  let directories = 0;
  let papers = 0;
  while (pending.length) {
    const { path: dir, depth } = pending.pop();
    directories++;
    const children = await IOUtils.getChildren(dir).catch(() => []);
    for (const child of children) {
      const stat = await IOUtils.stat(child).catch(() => null);
      if (!stat) continue;
      if (stat.type === "directory") {
        if (depth === 0 && PathUtils.filename(child) !== "tmp") papers++;
        pending.push({ path: child, depth: depth + 1 });
        continue;
      }
      files++;
      const size = Number(stat.size);
      if (Number.isFinite(size) && size > 0) bytes += size;
    }
  }
  return { bytes, files, directories, papers };
}

export async function clearAllPaperTranslateData() {
  const root = checkedRootDir();
  const existed = await IOUtils.exists(root);
  await IOUtils.remove(root, { recursive: true, ignoreAbsent: true });
  return { removed: existed };
}
