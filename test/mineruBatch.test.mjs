import test from "node:test";
import assert from "node:assert/strict";

import { MineruClient, uploadToOss } from "../chrome/content/modules/mineru.mjs";

const config = {
  mineru: {
    apiKey: "token",
    baseUrl: "https://mineru.example/api/v4",
    modelVersion: "vlm",
    language: "ch",
    isOcr: false,
    enableFormula: true,
    enableTable: true,
    pollIntervalMs: 1,
    timeoutMs: 100
  }
};

test("MinerU upload batch sends multiple files with stable data ids", async () => {
  const originalFetch = globalThis.fetch;
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      code: 0,
      data: { batch_id: "batch", file_urls: ["u1", "u2"] }
    }), { status: 200 });
  };
  try {
    const result = await new MineruClient(config).createUploadBatchFiles([
      { name: "a.png", dataId: "a" },
      { name: "b.png", dataId: "b" }
    ]);
    assert.equal(result.batch_id, "batch");
    const body = JSON.parse(request.options.body);
    assert.deepEqual(body.files, [
      { name: "a.png", data_id: "a", is_ocr: false },
      { name: "b.png", data_id: "b", is_ocr: false }
    ]);
    assert.equal(body.model_version, "vlm");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MinerU batch polling maps terminal results by data id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 0,
    data: {
      extract_result: [
        { file_name: "second.png", data_id: "b", state: "failed", err_msg: "bad" },
        { file_name: "first.png", data_id: "a", state: "done", full_zip_url: "zip" }
      ]
    }
  }), { status: 200 });
  try {
    const results = await new MineruClient(config).pollBatchResults("batch", [
      { name: "first.png", dataId: "a" },
      { name: "second.png", dataId: "b" }
    ]);
    assert.equal(results[0].result.state, "done");
    assert.equal(results[1].result.state, "failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MinerU OSS upload does not add a Content-Type header", async () => {
  const originalFetch = globalThis.fetch;
  let options = null;
  globalThis.fetch = async (url, value) => {
    options = value;
    return new Response("", { status: 200 });
  };
  try {
    await uploadToOss("https://oss.example/upload", new Uint8Array([1, 2, 3]));
    assert.equal(options.method, "PUT");
    assert.equal(options.headers, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
