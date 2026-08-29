import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile } from "node:fs/promises";

test("README documents the unified three-command workflow", async () => {
  const text = await readFile("README.md", "utf8");
  const violations: string[] = [];
  const matches = [
    ["scan", /pi-collection scan/],
    ["add --scan", /pi-collection add --scan/],
    ["add npm:", /pi-collection add npm:/],
    ["install --dry-run", /pi-collection install --dry-run/],
    ["install --yes for CI", /\bCI\b[\s\S]*--yes|--yes[\s\S]*\bCI\b/i],
    ["TUI controls", /↑\/↓ Move[\s\S]*Space Toggle[\s\S]*A All[\s\S]*N None[\s\S]*Enter Install[\s\S]*Esc Cancel/i],
    ["schema version 2", /schemaVersion:\s*2/],
    ["origins", /origins:/],
    ["non-destructive merge", /non-destructive merge/i],
    ["arbitrary-code security warning", /arbitrary code/i],
  ] as const;

  for (const [name, pattern] of matches) {
    try {
      assert.match(text, pattern);
    } catch {
      violations.push(`missing ${name}`);
    }
  }
  for (const [name, pattern] of [
    ["legacy catalog.yml documentation", /catalog\.yml/i],
    ["legacy pi-profile.yml documentation", /pi-profile\.yml/i],
    ["legacy list/remove/profile command documentation", /pi-collection (?:list|remove|profile)\b/i],
  ] as const) {
    try {
      assert.doesNotMatch(text, pattern);
    } catch {
      violations.push(`documents ${name}`);
    }
  }
  for (const path of ["catalog.yml", "src/catalog.ts", "src/profile.ts", "test/profile.test.ts"]) {
    try {
      await assert.rejects(access(path), { code: "ENOENT" });
    } catch {
      violations.push(`legacy file remains: ${path}`);
    }
  }
  assert.deepEqual(violations, []);
});
