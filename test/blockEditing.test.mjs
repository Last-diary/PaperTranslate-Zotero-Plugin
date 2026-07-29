import test from "node:test";
import assert from "node:assert/strict";
import {
  blockSourceText,
  setBlockSourceText,
  shouldEditSource
} from "../chrome/content/modules/ui/blockEditing.mjs";

test("translation mode edits source content for non-translatable blocks", () => {
  assert.equal(shouldEditSource("translation", false), true);
  assert.equal(shouldEditSource("translation", true), false);
  assert.equal(shouldEditSource("original", true), true);
});

test("code source editing reads and updates the rendered codeBody field", () => {
  const block = {
    type: "code",
    text: "stale text",
    codeBody: "module before;\nendmodule"
  };

  assert.equal(blockSourceText(block), "module before;\nendmodule");
  setBlockSourceText(block, "module after;\nendmodule");

  assert.equal(block.codeBody, "module after;\nendmodule");
  assert.equal(block.text, "module after;\nendmodule");
});

test("equation and caption source editing preserve their storage shapes", () => {
  const equation = { type: "equation", text: "$$x$$" };
  setBlockSourceText(equation, "$$y$$");
  assert.equal(blockSourceText(equation), "$$y$$");

  const image = { type: "image", captions: ["before"] };
  setBlockSourceText(image, "first\n\n second ");
  assert.deepEqual(image.captions, ["first", "second"]);
  assert.equal(blockSourceText(image), "first\nsecond");
});
