import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCodeBlock } from "../chrome/content/modules/ui/codeBlock.mjs";

test("keeps plain MinerU code bodies unchanged", () => {
  const source = "module top_module;\n  assign out = in;\nendmodule";
  assert.deepEqual(normalizeCodeBlock(source), {
    code: source,
    language: ""
  });
});

test("unwraps a complete backtick fence and extracts its language", () => {
  assert.deepEqual(
    normalizeCodeBlock("```verilog\nmodule top_module;\nendmodule\n```"),
    {
      code: "module top_module;\nendmodule",
      language: "verilog"
    }
  );
});

test("supports longer and tilde fences", () => {
  assert.deepEqual(
    normalizeCodeBlock("~~~~ c++ extra-info\r\nint main() {}\r\n~~~~~  "),
    {
      code: "int main() {}",
      language: "c++"
    }
  );
});

test("does not remove incomplete or surrounding fences", () => {
  const incomplete = "```python\nprint('hello')";
  const surrounding = "description\n```python\nprint('hello')\n```";
  assert.equal(normalizeCodeBlock(incomplete).code, incomplete);
  assert.equal(normalizeCodeBlock(surrounding).code, surrounding);
});

test("preserves backticks inside the fenced code body", () => {
  const source = "```js\nconst value = `hello`;\n```\n";
  assert.deepEqual(normalizeCodeBlock(source), {
    code: "const value = `hello`;",
    language: "js"
  });
});

test("sanitizes the language token before using it as a class", () => {
  assert.deepEqual(
    normalizeCodeBlock("```{.objective-c}\nint main() {}\n```"),
    {
      code: "int main() {}",
      language: "objective-c"
    }
  );
});
