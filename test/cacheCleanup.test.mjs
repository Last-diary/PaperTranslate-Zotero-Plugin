import test from "node:test";
import assert from "node:assert/strict";
import {
  decideCacheReconciliation,
  deletedItemIdentities,
  normalizedCacheKey
} from "../chrome/content/modules/cacheCleanup.mjs";

test("only permanent item delete events produce cache identities", () => {
  const extraData = {
    10: { libraryID: 1, key: "ABCD1234" },
    11: { libraryID: 2, key: "EFGH5678" }
  };
  assert.deepEqual(deletedItemIdentities("trash", "item", [10], extraData), []);
  assert.deepEqual(deletedItemIdentities("delete", "collection", [10], extraData), []);
  assert.deepEqual(
    deletedItemIdentities("delete", "item", [10, 11, 10], extraData),
    [
      { id: 10, libraryID: 1, key: "ABCD1234" },
      { id: 11, libraryID: 2, key: "EFGH5678" }
    ]
  );
});

test("invalid notifier keys cannot escape the cache root", () => {
  assert.equal(normalizedCacheKey("../ABCD1234"), "");
  assert.equal(normalizedCacheKey("A/B"), "");
  assert.equal(normalizedCacheKey("A\\B"), "");
  assert.equal(normalizedCacheKey("ABCD1234"), "ABCD1234");
});

test("version 2 cache is deleted only for its exact library owner", () => {
  const manifest = {
    version: 2,
    attachmentKey: "ABCD1234",
    attachmentLibraryID: 1
  };
  assert.deepEqual(
    decideCacheReconciliation({
      directoryKey: "ABCD1234",
      manifest,
      deletedIdentity: { libraryID: 1, key: "ABCD1234" }
    }),
    { action: "delete", reason: "deleted-owner" }
  );
  assert.deepEqual(
    decideCacheReconciliation({
      directoryKey: "ABCD1234",
      manifest,
      deletedIdentity: { libraryID: 2, key: "ABCD1234" }
    }),
    { action: "keep", reason: "different-library-owner" }
  );
});

test("legacy cache deletion is conservative when the key is still live", () => {
  const legacy = { version: 1, attachmentKey: "ABCD1234" };
  assert.deepEqual(
    decideCacheReconciliation({
      directoryKey: "ABCD1234",
      manifest: legacy,
      liveIdentities: [{ libraryID: 2, key: "ABCD1234" }],
      deletedIdentity: { libraryID: 1, key: "ABCD1234" }
    }),
    { action: "skip", reason: "legacy-key-still-live" }
  );
  assert.deepEqual(
    decideCacheReconciliation({
      directoryKey: "ABCD1234",
      manifest: legacy,
      liveIdentities: [],
      deletedIdentity: { libraryID: 1, key: "ABCD1234" }
    }),
    { action: "delete", reason: "deleted-legacy-owner" }
  );
});

test("startup reconciliation upgrades live legacy caches and removes orphans", () => {
  const legacy = { version: 1, attachmentKey: "ABCD1234" };
  assert.deepEqual(
    decideCacheReconciliation({
      directoryKey: "ABCD1234",
      manifest: legacy,
      liveIdentities: [{ libraryID: 7, key: "ABCD1234" }]
    }),
    {
      action: "upgrade",
      reason: "legacy-owner-resolved",
      libraryID: 7
    }
  );
  assert.deepEqual(
    decideCacheReconciliation({
      directoryKey: "ABCD1234",
      manifest: legacy,
      liveIdentities: []
    }),
    { action: "delete", reason: "orphaned-legacy-cache" }
  );
});

test("ambiguous or inconsistent cache identity is never deleted automatically", () => {
  assert.deepEqual(
    decideCacheReconciliation({
      directoryKey: "ABCD1234",
      manifest: { attachmentKey: "OTHER123" },
      liveIdentities: []
    }),
    { action: "skip", reason: "manifest-key-mismatch" }
  );
  assert.deepEqual(
    decideCacheReconciliation({
      directoryKey: "ABCD1234",
      manifest: { version: 1, attachmentKey: "ABCD1234" },
      liveIdentities: [
        { libraryID: 1, key: "ABCD1234" },
        { libraryID: 2, key: "ABCD1234" }
      ]
    }),
    { action: "skip", reason: "legacy-owner-ambiguous" }
  );
});
