import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("README documents profile restore and source safety", async () => {
  const text = await readFile("README.md", "utf8");
  assert.match(text, /pi-collection profile restore/);
  assert.match(text, /review source code before installing/i);
  assert.match(text, /local paths.*must exist/i);
});
