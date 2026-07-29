// PaperTranslate 缓存生命周期：
// - 放入 Zotero 回收站（trash）时保留，便于恢复；
// - 条目被永久删除（delete）后，按 notifier extraData 中的 libraryID/key 清理；
// - 启动时扫描历史孤立缓存，并为旧 manifest 回填 libraryID。

import { ctx } from "./context.mjs";
import * as storage from "./storage.mjs";

const OBSERVER_NAME = "papertranslate-cache-cleanup";
let notifierID = null;
let cleanupQueue = Promise.resolve();

function normalizedLibraryID(value) {
  const libraryID = Number(value);
  return Number.isInteger(libraryID) && libraryID > 0 ? libraryID : null;
}

export function normalizedCacheKey(value) {
  const key = String(value || "").trim();
  if (!key || key.length > 64 || key.includes("/") || key.includes("\\")) return "";
  return /^[a-z0-9_-]+$/i.test(key) ? key : "";
}

export function deletedItemIdentities(event, type, ids, extraData) {
  if (event !== "delete" || type !== "item") return [];
  const identities = [];
  const seen = new Set();
  for (const id of Array.isArray(ids) ? ids : [ids]) {
    const data = extraData?.[id] || extraData?.[String(id)] || {};
    const libraryID = normalizedLibraryID(data.libraryID);
    const key = normalizedCacheKey(data.key);
    if (!libraryID || !key) continue;
    const token = `${libraryID}:${key}`;
    if (seen.has(token)) continue;
    seen.add(token);
    identities.push({ id: Number(id) || null, libraryID, key });
  }
  return identities;
}

function normalizedLiveIdentities(values) {
  const identities = [];
  for (const value of values || []) {
    const libraryID = normalizedLibraryID(value?.libraryID);
    const key = normalizedCacheKey(value?.key);
    if (libraryID && key) identities.push({ libraryID, key });
  }
  return identities;
}

// 纯决策函数，供 Node 回归测试覆盖旧 manifest 和跨库同 key 场景。
export function decideCacheReconciliation({
  directoryKey,
  manifest,
  liveIdentities = [],
  deletedIdentity = null
} = {}) {
  const key = normalizedCacheKey(directoryKey);
  if (!key) return { action: "skip", reason: "invalid-directory-key" };

  const manifestKey = normalizedCacheKey(manifest?.attachmentKey);
  if (manifestKey && manifestKey !== key) {
    return { action: "skip", reason: "manifest-key-mismatch" };
  }

  const manifestLibraryID = normalizedLibraryID(manifest?.attachmentLibraryID);
  const live = normalizedLiveIdentities(liveIdentities)
    .filter((identity) => identity.key === key);

  if (deletedIdentity) {
    const deletedKey = normalizedCacheKey(deletedIdentity.key);
    const deletedLibraryID = normalizedLibraryID(deletedIdentity.libraryID);
    if (deletedKey !== key || !deletedLibraryID) {
      return { action: "keep", reason: "different-deleted-item" };
    }
    if (manifestLibraryID) {
      return manifestLibraryID === deletedLibraryID
        ? { action: "delete", reason: "deleted-owner" }
        : { action: "keep", reason: "different-library-owner" };
    }
    return live.length
      ? { action: "skip", reason: "legacy-key-still-live" }
      : { action: "delete", reason: "deleted-legacy-owner" };
  }

  if (manifestLibraryID) {
    return live.some((identity) => identity.libraryID === manifestLibraryID)
      ? { action: "keep", reason: "owner-still-live" }
      : { action: "delete", reason: "orphaned-owner" };
  }
  if (!live.length) return { action: "delete", reason: "orphaned-legacy-cache" };
  if (live.length === 1 && manifest && typeof manifest === "object") {
    return {
      action: "upgrade",
      reason: "legacy-owner-resolved",
      libraryID: live[0].libraryID
    };
  }
  return { action: "skip", reason: "legacy-owner-ambiguous" };
}

function isPdfAttachment(item) {
  try {
    if (!item?.isAttachment?.()) return false;
    const contentType = String(item.attachmentContentType || "").toLowerCase();
    const fileName = String(item.attachmentFilename || "").toLowerCase();
    return contentType === "application/pdf" || fileName.endsWith(".pdf");
  } catch {
    return false;
  }
}

async function findLivePdfIdentities(key) {
  const identities = [];
  const libraries = ctx.Zotero?.Libraries?.getAll?.() || [];
  for (const library of libraries) {
    const libraryID = normalizedLibraryID(library?.libraryID ?? library?.id);
    if (!libraryID) continue;
    const item = await ctx.Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
    if (isPdfAttachment(item)) identities.push({ libraryID, key });
  }
  return identities;
}

function logDebug(message) {
  ctx.Zotero?.debug?.(`PaperTranslate cache cleanup: ${message}`);
}

async function reconcileDirectory(dir, key, deletedIdentity = null) {
  const manifest = await storage.readJson(storage.manifestPath(dir), null);
  const manifestLibraryID = normalizedLibraryID(manifest?.attachmentLibraryID);
  const liveIdentities = deletedIdentity && manifestLibraryID
    ? []
    : await findLivePdfIdentities(key);
  const decision = decideCacheReconciliation({
    directoryKey: key,
    manifest,
    liveIdentities,
    deletedIdentity
  });

  if (decision.action === "delete") {
    await storage.removeItemData(dir);
    logDebug(`removed ${key} (${decision.reason})`);
    return { removed: 1, upgraded: 0, skipped: 0 };
  }
  if (decision.action === "upgrade") {
    await storage.writeJson(storage.manifestPath(dir), {
      ...manifest,
      version: Math.max(2, Number(manifest.version) || 1),
      attachmentLibraryID: decision.libraryID
    });
    logDebug(`upgraded manifest ${key} -> library ${decision.libraryID}`);
    return { removed: 0, upgraded: 1, skipped: 0 };
  }
  if (decision.action === "skip") {
    logDebug(`kept ${key} (${decision.reason})`);
    return { removed: 0, upgraded: 0, skipped: 1 };
  }
  return { removed: 0, upgraded: 0, skipped: 0 };
}

function addResult(total, result) {
  total.removed += result.removed || 0;
  total.upgraded += result.upgraded || 0;
  total.skipped += result.skipped || 0;
}

export async function cleanupDeletedItemCaches(identities) {
  const result = { removed: 0, upgraded: 0, skipped: 0, failed: 0 };
  for (const identity of identities || []) {
    try {
      const dir = storage.itemDirForKey(identity.key);
      if (!(await IOUtils.exists(dir))) continue;
      addResult(result, await reconcileDirectory(dir, identity.key, identity));
    } catch (error) {
      result.failed++;
      ctx.Zotero?.logError?.(error);
    }
  }
  return result;
}

export async function sweepOrphanedCaches() {
  const result = { removed: 0, upgraded: 0, skipped: 0, failed: 0 };
  const root = storage.rootDir();
  if (!(await IOUtils.exists(root))) return result;
  const children = await IOUtils.getChildren(root).catch(() => []);
  for (const dir of children) {
    const key = normalizedCacheKey(PathUtils.filename(dir));
    if (!key || key.toLowerCase() === "tmp") continue;
    try {
      const stat = await IOUtils.stat(dir);
      if (stat.type !== "directory") continue;
      addResult(result, await reconcileDirectory(dir, key));
    } catch (error) {
      result.failed++;
      ctx.Zotero?.logError?.(error);
    }
  }
  logDebug(
    `startup sweep removed=${result.removed}, upgraded=${result.upgraded}, `
    + `skipped=${result.skipped}, failed=${result.failed}`
  );
  return result;
}

function enqueueCleanup(task) {
  cleanupQueue = cleanupQueue
    .catch((error) => ctx.Zotero?.logError?.(error))
    .then(task);
  return cleanupQueue;
}

const observer = {
  notify(event, type, ids, extraData) {
    const identities = deletedItemIdentities(event, type, ids, extraData);
    if (!identities.length || ctx.shuttingDown) return undefined;
    return enqueueCleanup(() => cleanupDeletedItemCaches(identities));
  }
};

export function registerCacheCleanupObserver() {
  if (notifierID || !ctx.Zotero?.Notifier?.registerObserver) return notifierID;
  notifierID = ctx.Zotero.Notifier.registerObserver(
    observer,
    ["item"],
    OBSERVER_NAME
  );
  void Promise.resolve(ctx.Zotero.initializationPromise)
    .then(() => {
      if (!ctx.shuttingDown) return enqueueCleanup(() => sweepOrphanedCaches());
      return undefined;
    })
    .catch((error) => ctx.Zotero?.logError?.(error));
  return notifierID;
}

export function unregisterCacheCleanupObserver() {
  if (!notifierID) return;
  try {
    ctx.Zotero?.Notifier?.unregisterObserver?.(notifierID);
  } finally {
    notifierID = null;
  }
}
