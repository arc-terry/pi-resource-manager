import assert from "node:assert/strict";
import test from "node:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFakePi, makeTempDir } from "./helpers.js";
import { planRestore } from "../src/restore.js";
import * as restoreModule from "../src/restore.js";

test("does not invoke Pi for a dry-run restore", async () => {
  const { path, log } = await createFakePi(await makeTempDir());
  const executeRestore = (restoreModule as typeof restoreModule & {
    executeRestore?: (actions: unknown[], options: { dryRun: boolean; piPath: string; yes: boolean }) => Promise<{ installed: number }>;
  }).executeRestore;

  assert.equal(typeof executeRestore, "function");
  const summary = await executeRestore!([
    { kind: "pi-install", args: ["install", "npm:tools"], scope: "global" },
  ], { dryRun: true, piPath: path, yes: true });

  assert.equal(summary.installed, 0);
  await assert.rejects(readFile(log, "utf8"));
});

test("uses Pi's local flag and reports missing local sources", async () => {
  const profile = {
    profile: { pi: { agentDirectory: "/agent" } },
    packages: [{
      id: "package:npm:tools",
      name: "tools",
      scope: "local" as const,
      projectRoot: "/project",
      installedPath: "/project/.pi/npm/tools",
      source: { kind: "npm" as const, spec: "npm:tools", name: "tools" },
    }],
    skills: [{
      id: "skill:missing",
      name: "missing",
      scope: "global" as const,
      installedPath: "/agent/skills/missing",
      source: { kind: "local-path" as const, path: "/does-not-exist" },
    }],
    extensions: [],
  };

  const actions = await planRestore(profile, {});

  assert.deepEqual(actions, [
    { kind: "pi-install", args: ["install", "-l", "npm:tools"], scope: "local" },
    { kind: "missing-local-source", id: "skill:missing", path: "/does-not-exist" },
  ]);
});

test("continues restore actions after a Pi failure", async () => {
  const root = await makeTempDir();
  const badPi = join(root, "bad-pi");
  const settingsPath = join(root, "settings.json");
  await writeFile(badPi, "#!/bin/sh\necho failed >&2\nexit 7\n");
  await chmod(badPi, 0o755);
  await writeFile(settingsPath, JSON.stringify({ theme: "night" }));
  const executeRestore = (restoreModule as typeof restoreModule & {
    executeRestore: (actions: unknown[], options: { dryRun: boolean; piPath: string; yes: boolean }) => Promise<{
      failed: number; updated: number; failures: string[];
    }>;
  }).executeRestore;

  const summary = await executeRestore([
    { kind: "pi-install", args: ["install", "npm:broken"], scope: "global" },
    { kind: "settings-extension", settingsPath, value: "/source/team.ts" },
  ], { dryRun: false, piPath: badPi, yes: true });

  assert.equal(summary.failed, 1);
  assert.equal(summary.updated, 1);
  assert.match(summary.failures[0] ?? "", /exit 7/);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    theme: "night",
    extensions: ["/source/team.ts"],
  });
});

test("plans global package install before remapped local extension settings", async () => {
  const source = join(await makeTempDir(), "x.ts");
  await writeFile(source, "export default () => {};");
  const profile = {
    schemaVersion: 1,
    profile: {
      name: "x",
      generatedAt: "2026-08-25T00:00:00.000Z",
      pi: { agentDirectory: "/tmp/a" },
    },
    packages: [{
      id: "package:npm:tools",
      name: "tools",
      scope: "global",
      installedPath: "/tmp/a/npm/tools",
      source: {
        kind: "npm",
        spec: "npm:tools@1.0.0",
        name: "tools",
        version: "1.0.0",
      },
    }],
    skills: [],
    extensions: [{
      id: "extension:x",
      name: "x",
      scope: "local",
      projectRoot: "/old",
      installedPath: "/old/.pi/extensions/x.ts",
      source: { kind: "local-path", path: source },
    }],
  };

  const actions = await planRestore(profile, { projectRoot: "/new" });

  assert.deepEqual(actions.map((action) => action.kind), ["pi-install", "settings-extension"]);
  assert.equal(actions[0]?.args.join(" "), "install npm:tools@1.0.0");
  assert.equal(actions[1]?.projectRoot, "/new");
});
