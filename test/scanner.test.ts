import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./helpers.js";
import { scanPi } from "../src/scanner.js";

test("scans package settings plus global skills and extensions", async () => {
  const root = await makeTempDir();
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "skills", "review"), { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(
    join(agentDir, "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review code\n---\n",
  );
  await writeFile(join(agentDir, "extensions", "team.ts"), "export default () => {};");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: ["npm:@acme/pi-tools@1.2.3"] }),
  );

  const scan = await scanPi({ agentDir });

  assert.equal(scan.packages[0]?.source.spec, "npm:@acme/pi-tools@1.2.3");
  assert.equal(scan.skills[0]?.name, "review");
  assert.equal(scan.extensions[0]?.name, "team");
});
