import test from "node:test";
import assert from "node:assert/strict";
import { MineruRateLimit, mineruRateLimitFor } from "../chrome/content/modules/mineruRateLimit.mjs";
import { MineruClient } from "../chrome/content/modules/mineru.mjs";
import { chunkDocumentReparseItems } from "../chrome/content/modules/ui/documentReparseState.mjs";

const config = { mineru: { apiKey: "test-rate-limit", baseUrl: "https://mineru.example/api/v4" } };
function clock() {
  let time = 0;
  return {
    now: () => time,
    wait: async (ms) => { time += ms; },
    advance: (ms) => { time += ms; }
  };
}
const done = () => new Response(JSON.stringify({ code: 0, data: { batch_id: "ok", file_urls: [] } }));

test("128 files produce 50/50/28 requests at least one minute apart", async () => {
  const timer = clock();
  const client = new MineruClient(config, { rateLimit: new MineruRateLimit(timer) });
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ time: timer.now(), count: JSON.parse(options.body).files.length });
    return done();
  };
  try {
    for (const batch of chunkDocumentReparseItems(Array.from({ length: 128 }, (_, i) => ({ name: `${i}.png` })))) {
      await client.createUploadBatchFiles(batch);
    }
    assert.deepEqual(requests, [{ time: 0, count: 50 }, { time: 61000, count: 50 }, { time: 122000, count: 28 }]);
    await assert.rejects(client.createUploadBatchFiles(Array(51).fill({ name: "a" })), /1 到 50/);
    assert.equal(requests.length, 3);
  } finally { globalThis.fetch = originalFetch; }
});

for (const [header, expected] of [[null, 61000], ["120", 120000], ["Thu, 01 Jan 1970 00:02:00 GMT", 120000]]) {
  test(`429 waits for Retry-After ${header} before retrying, including HTML responses`, async () => {
    const timer = clock();
    const client = new MineruClient(config, { rateLimit: new MineruRateLimit(timer) });
    const times = [];
    const messages = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      times.push(timer.now());
      return times.length === 1
        ? new Response("<html>Too many files</html>", { status: 429, headers: header ? { "Retry-After": header } : {} })
        : done();
    };
    try {
      await client.createUploadBatch({ name: "a.png" }, { onProgress: (text) => messages.push(text) });
      assert.deepEqual(times, [0, expected]);
      assert.ok(messages.some(text => text.includes("限流等待")));
    } finally { globalThis.fetch = originalFetch; }
  });
}

test("a rolling quota retains newer reservations when the oldest expires", async () => {
  const timer = clock();
  const limiter = new MineruRateLimit(timer);
  await limiter.acquire(30);
  timer.advance(30000);
  await limiter.acquire(20);
  await limiter.acquire(40);
  assert.equal(timer.now(), 91000);
});

test("simultaneous callers cannot reserve more than the file quota", async () => {
  let time = 0;
  const waits = [];
  const limiter = new MineruRateLimit({ now: () => time, wait: () => new Promise(resolve => waits.push(resolve)) });
  await limiter.acquire(49);
  let first = false;
  let second = false;
  const a = limiter.acquire(1).then(() => { first = true; });
  const b = limiter.acquire(1).then(() => { second = true; });
  await a;
  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(limiter.reservations.reduce((n, entry) => n + entry.count, 0), 50);
  time = 61000;
  waits.shift()();
  await b;
  assert.equal(second, true);
});

test("quota wait cancels promptly without reserving files", async () => {
  const timer = clock();
  let aborted = false;
  const limiter = new MineruRateLimit({ now: timer.now, wait: async () => { aborted = true; } });
  await limiter.acquire(50);
  await assert.rejects(limiter.acquire(1, { shouldAbort: () => aborted }), /操作已取消/);
  assert.equal(limiter.reservations.length, 1);
});

test("clients with the same endpoint and token share quota", () => {
  assert.equal(new MineruClient(config).rateLimit, new MineruClient(config).rateLimit);
  assert.notEqual(mineruRateLimitFor(config.mineru), mineruRateLimitFor({ ...config.mineru, apiKey: "different" }));
});
