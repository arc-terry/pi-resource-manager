import assert from "node:assert/strict";
import test from "node:test";
import { displayType } from "../src/domain.js";

test("renders extensions as plugins for CLI users", () => {
  assert.equal(displayType("package"), "package");
  assert.equal(displayType("skill"), "skill");
  assert.equal(displayType("extension"), "plugin");
});
