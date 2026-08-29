import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir, createFakePi } from "./helpers.js";
import { planRestore, executeRestore, type RestoreAction } from "../src/restore.js";

test("plans global package install before local extension settings", async () => {
  const source = join(await makeTempDir(), "x.ts");
  await writeFile(source, "export default () => {};");
  const profile = { schemaVersion: 1 as const, profile: { name: "x", generatedAt: "2026-08-25T00:00:00.000Z", pi: { agentDirectory: "/tmp/a" } }, packages: [{ id: "package:npm:tools", name: "tools", scope: "global" as const, installedPath: "/tmp/a/npm/tools", source: { kind: "npm" as const, spec: "npm:tools@1.0.0", name: "tools", version: "1.0.0" } }], skills: [], extensions: [{ id: "extension:x", name: "x", scope: "local" as const, projectRoot: "/old", installedPath: "/old/.pi/extensions/x.ts", source: { kind: "local-path" as const, path: source } }] };
  const actions = await planRestore(profile, { projectRoot: "/new" });
  assert.deepEqual(actions.map((a) => a.kind), ["pi-install", "settings-extension"]);
  assert.equal(actions[0]?.kind === "pi-install" ? actions[0].args.join(" ") : "", "install npm:tools@1.0.0");
  assert.equal(actions[1]?.kind === "settings-extension" ? actions[1].projectRoot : undefined, "/new");
});

test("reports rather than substitutes a missing local path", async () => {
  const profile = { schemaVersion: 1 as const, profile: { name: "x", generatedAt: "2026-08-25T00:00:00.000Z", pi: { agentDirectory: "/tmp/a" } }, packages: [], skills: [{ id: "skill:missing", name: "missing", scope: "global" as const, installedPath: "/tmp/a/skills/missing", source: { kind: "local-path" as const, path: "/does-not-exist" } }], extensions: [] };
  const actions = await planRestore(profile, {});
  assert.equal(actions[0]?.kind, "missing-local-source");
});

test("dry-run does not invoke Pi", async () => {
  const { path, log } = await createFakePi(await makeTempDir());
  const summary = await executeRestore([{ kind: "pi-install", args: ["install", "npm:tools"], scope: "global" }], { dryRun: true, piPath: path, yes: true });
  assert.equal(summary.installed, 0);
  await assert.rejects(readFile(log, "utf8"));
});
