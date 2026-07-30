import test from "node:test";
import assert from "node:assert/strict";

import {
  canReparseBlock,
  replacementTextFromMineru
} from "../chrome/content/modules/ui/blockReparseText.mjs";

const locatedBlock = (type) => ({
  id: "block-1",
  type,
  bbox: [10, 20, 30, 40],
  pageSize: [1000, 1000]
});

test("reparse scope matches editable text-like blocks and skips structured blocks", () => {
  assert.equal(canReparseBlock(locatedBlock("text")), true);
  assert.equal(canReparseBlock(locatedBlock("title")), true);
  assert.equal(canReparseBlock(locatedBlock("equation")), true);
  assert.equal(canReparseBlock(locatedBlock("table")), false);
  assert.equal(canReparseBlock(locatedBlock("image")), false);
  assert.equal(canReparseBlock(locatedBlock("chart")), false);
  assert.equal(canReparseBlock({ type: "text" }), false);
});

test("reparse result joins MinerU text blocks as one editable source string", () => {
  const result = replacementTextFromMineru(locatedBlock("text"), [
    { type: "text", text: "First paragraph." },
    { type: "text", text: "Second paragraph." }
  ]);
  assert.equal(result, "First paragraph.\n\nSecond paragraph.");
});

test("code reparse prefers code output and preserves its body", () => {
  const result = replacementTextFromMineru(locatedBlock("code"), [
    { type: "text", text: "caption" },
    { type: "code", code_body: "const value = 1;" }
  ]);
  assert.equal(result, "const value = 1;");
});

test("equation reparse prefers equation output", () => {
  const result = replacementTextFromMineru(locatedBlock("equation"), [
    { type: "text", text: "nearby text" },
    { type: "equation", text: "E = mc^2" }
  ]);
  assert.equal(result, "E = mc^2");
});
