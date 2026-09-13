import test from "node:test";
import assert from "node:assert/strict";

import {
  chunkDocumentReparseItems,
  documentReparseCampaignKey,
  normalizeDocumentReparseRecord,
  planDocumentReparse,
  recordDocumentReparseResult
} from "../chrome/content/modules/ui/documentReparseState.mjs";

const locatedBlock = (id, type = "text") => ({
  id,
  type,
  pageIdx: 0,
  bbox: [10, 20, 30, 40],
  pageSize: [1000, 1000],
  regions: []
});

test("document reparse batches respect the 50-file minute quota", () => {
  const chunks = chunkDocumentReparseItems(Array.from({ length: 401 }, (_, index) => index));
  assert.deepEqual(chunks.map((chunk) => chunk.length), [50, 50, 50, 50, 50, 50, 50, 50, 1]);
  assert.deepEqual(chunkDocumentReparseItems(Array(128)).map((chunk) => chunk.length), [50, 50, 28]);
});

test("document reparse plan skips structured and unreliable blocks", () => {
  const blocks = [
    locatedBlock("text"),
    locatedBlock("equation", "equation"),
    locatedBlock("table", "table"),
    { ...locatedBlock("unreliable"), regionsReliable: false }
  ];
  const record = {
    blocks: {
      text: { status: "success" },
      equation: { status: "failed" }
    }
  };
  const resume = planDocumentReparse(blocks, record);
  assert.deepEqual(resume.targets.map((block) => block.id), ["equation"]);
  assert.equal(resume.candidates.length, 2);
  assert.equal(resume.skipped.length, 2);
  assert.equal(resume.priorSucceeded, 1);
  assert.equal(resume.firstPassConsumption, 1);
  assert.equal(resume.maximumConsumption, 2);

  const restart = planDocumentReparse(blocks, record, { restart: true });
  assert.deepEqual(restart.targets.map((block) => block.id), ["text", "equation"]);
  assert.equal(restart.priorSucceeded, 0);
});

test("campaign key changes with PDF, MinerU options, manifest, or block regions", () => {
  const base = {
    manifest: { version: 3, createdAt: "2026-01-01", files: { contentList: "content_list.json" } },
    fileInfo: { size: 10, lastModified: 20 },
    blocks: [locatedBlock("a")],
    mineru: { modelVersion: "vlm", language: "ch", enableFormula: true }
  };
  const key = documentReparseCampaignKey(base);
  assert.notEqual(key, documentReparseCampaignKey({
    ...base,
    fileInfo: { ...base.fileInfo, size: 11 }
  }));
  assert.notEqual(key, documentReparseCampaignKey({
    ...base,
    mineru: { ...base.mineru, baseUrl: "https://another-mineru.example/api/v4" }
  }));
  assert.notEqual(key, documentReparseCampaignKey({
    ...base,
    mineru: { ...base.mineru, language: "en" }
  }));
  assert.notEqual(key, documentReparseCampaignKey({
    ...base,
    blocks: [{ ...locatedBlock("a"), bbox: [11, 20, 30, 40] }]
  }));
});

test("document reparse record resumes only the matching campaign", () => {
  let record = normalizeDocumentReparseRecord(null, "campaign-a");
  record = recordDocumentReparseResult(record, locatedBlock("a"), {
    success: true,
    attempts: 2,
    changed: true
  }, "2026-01-01T00:00:00Z");
  assert.equal(record.blocks.a.status, "success");
  assert.equal(record.blocks.a.attempts, 2);
  assert.equal(record.blocks.a.changed, true);
  assert.deepEqual(
    normalizeDocumentReparseRecord(record, "campaign-b").blocks,
    {}
  );
});
