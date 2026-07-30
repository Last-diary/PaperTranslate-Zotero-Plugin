import assert from "node:assert/strict";
import test from "node:test";

import { ctx } from "../chrome/content/modules/context.mjs";
import { openPaperTranslateDataDirectory } from "../chrome/content/modules/storage.mjs";

globalThis.PathUtils = {
  join: (...parts) => parts.join("/"),
  parent: (path) => path.slice(0, path.lastIndexOf("/")),
  filename: (path) => path.slice(path.lastIndexOf("/") + 1)
};

test("opens the PaperTranslate cache directory through Zotero.File.reveal", async () => {
  const calls = [];
  globalThis.IOUtils = {
    makeDirectory: async (path, options) => calls.push(["makeDirectory", path, options])
  };
  ctx.Zotero = {
    DataDirectory: { dir: "/zotero" },
    File: {
      reveal: async (path) => calls.push(["reveal", path])
    }
  };

  assert.equal(await openPaperTranslateDataDirectory(), true);
  assert.deepEqual(calls, [
    ["makeDirectory", "/zotero/papertranslate", { createAncestors: true }],
    ["reveal", "/zotero/papertranslate"]
  ]);
});

test("falls back to revealing the Zotero data directory", async () => {
  let fallbackCalls = 0;
  globalThis.IOUtils = {
    makeDirectory: async () => {}
  };
  ctx.Zotero = {
    DataDirectory: {
      dir: "/zotero",
      reveal: async () => {
        fallbackCalls++;
      }
    }
  };

  assert.equal(await openPaperTranslateDataDirectory(), false);
  assert.equal(fallbackCalls, 1);
});

test("reports unsupported Zotero versions after creating the cache directory", async () => {
  globalThis.IOUtils = {
    makeDirectory: async () => {}
  };
  ctx.Zotero = {
    DataDirectory: { dir: "/zotero" }
  };

  await assert.rejects(
    openPaperTranslateDataDirectory(),
    /当前 Zotero 版本不支持打开数据目录/
  );
});
