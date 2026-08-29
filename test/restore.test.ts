import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, realpath, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir, createFakePi } from "./helpers.js";
import { planRestore, executeRestore, type RestoreAction } from "../src/restore.js";
import { runPi } from "../src/pi-command.js";

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

test("reports a missing local package source before scheduling Pi install", async () => {
  const profile = { schemaVersion: 1 as const, profile: { name: "x", generatedAt: "2026-08-25T00:00:00.000Z", pi: { agentDirectory: "/tmp/a" } }, packages: [{ id: "package:missing", name: "missing", scope: "local" as const, projectRoot: "/old", installedPath: "/old/.pi/npm/missing", source: { kind: "local-path" as const, path: "/does-not-exist" } }], skills: [], extensions: [] };
  const actions = await planRestore(profile, { projectRoot: "/new" });
  assert.deepEqual(actions, [{ kind: "missing-local-source", id: "package:missing", path: "/does-not-exist" }]);
});

test("dry-run does not invoke Pi", async () => {
  const { path, log } = await createFakePi(await makeTempDir());
  const summary = await executeRestore([{ kind: "pi-install", args: ["install", "npm:tools"], scope: "global" }], { dryRun: true, piPath: path, yes: true });
  assert.equal(summary.installed, 0);
  await assert.rejects(readFile(log, "utf8"));
});

test("executes Pi install through the configured executable", async () => {
  const { path, log } = await createFakePi(await makeTempDir());
  const summary = await executeRestore(
    [{ kind: "pi-install", id: "package:tools", args: ["install", "npm:tools"], scope: "global" }],
    { piPath: path, yes: true },
  );
  assert.deepEqual(summary, { installed: 1, alreadyPresent: 0, skipped: 0, failed: 0, failures: [] });
  assert.equal(await readFile(log, "utf8"), "install npm:tools\n");
});

test("continues restore after an independent Pi install failure", async () => {
  const { path, log } = await createFakePi(await makeTempDir(), "install npm:broken");
  const summary = await executeRestore(
    [
      { kind: "pi-install", id: "package:broken", args: ["install", "npm:broken"], scope: "global" },
      { kind: "pi-install", id: "package:tools", args: ["install", "npm:tools"], scope: "global" },
    ],
    { piPath: path, yes: true },
  );
  assert.deepEqual({ installed: summary.installed, alreadyPresent: summary.alreadyPresent, skipped: summary.skipped, failed: summary.failed }, { installed: 1, alreadyPresent: 0, skipped: 0, failed: 1 });
  assert.equal(await readFile(log, "utf8"), "install npm:broken\ninstall npm:tools\n");
});

test("writes settings entries during restore", async () => {
  const settingsPath = join(await makeTempDir(), "settings.json");
  const summary = await executeRestore(
    [{ kind: "settings-extension", id: "extension:local", settingsPath, value: "/source/local.ts", projectRoot: "/project" }],
    { yes: true },
  );
  assert.deepEqual(summary, { installed: 1, alreadyPresent: 0, skipped: 0, failed: 0, failures: [] });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { extensions: ["/source/local.ts"] });
});

test("reports executable and quoted arguments when Pi cannot start", async () => {
  const piPath = join(await makeTempDir(), "missing-pi");
  await assert.rejects(
    runPi(["install", "npm:tools"], { piPath }),
    (error: unknown) => error instanceof Error
      && error.message.includes(`Pi command ${JSON.stringify(piPath)} ["install", "npm:tools"] failed to start`),
  );
});

test("uses a local package's recorded project root as Pi's working directory", async () => {
  const projectRoot = await makeTempDir();
  const { path, cwdLog } = await createFakePi(await makeTempDir(), undefined, true);
  const summary = await executeRestore(
    [{ kind: "pi-install", id: "package:tools", args: ["install", "-l", "npm:tools"], scope: "local", projectRoot }],
    { piPath: path, yes: true },
  );

  assert.equal(summary.installed, 1);
  assert.equal((await readFile(cwdLog, "utf8")).trim(), await realpath(projectRoot));
});

test("restores a package-owned skill or plugin by installing its owner package once", async () => {
  const profile = {
    schemaVersion: 1 as const,
    profile: { name: "x", generatedAt: "2026-08-25T00:00:00.000Z", pi: { agentDirectory: "/tmp/a" } },
    packages: [{ id: "package:npm:tools", name: "tools", scope: "global" as const, installedPath: "/tmp/a/npm/tools", source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } }],
    skills: [{ id: "skill:tools", name: "review", scope: "global" as const, installedPath: "/tmp/a/npm/tools/skills/review", ownerPackageId: "package:npm:tools", source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } }],
    extensions: [{ id: "extension:tools", name: "team", scope: "global" as const, installedPath: "/tmp/a/npm/tools/extensions/team.ts", ownerPackageId: "package:npm:tools", source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } }],
  };

  const skillActions = await planRestore(profile, { only: "skill" });
  const pluginActions = await planRestore(profile, { only: "plugin" });

  assert.deepEqual(skillActions, [{ kind: "pi-install", id: "package:npm:tools", args: ["install", "npm:tools"], scope: "global" }]);
  assert.deepEqual(pluginActions, [{ kind: "pi-install", id: "package:npm:tools", args: ["install", "npm:tools"], scope: "global" }]);
});

test("reinstalls an owner package when a requested owned resource is absent", async () => {
  const profile = {
    schemaVersion: 1 as const,
    profile: { name: "x", generatedAt: "2026-08-25T00:00:00.000Z", pi: { agentDirectory: "/tmp/a" } },
    packages: [{ id: "package:npm:tools", name: "tools", scope: "global" as const, installedPath: "/tmp/a/npm/tools", source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } }],
    skills: [{ id: "skill:tools", name: "review", scope: "global" as const, installedPath: "/tmp/a/npm/tools/skills/review", ownerPackageId: "package:npm:tools", source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } }],
    extensions: [],
  };
  const currentScan = {
    packages: [{ id: "package:npm:tools", type: "package" as const, name: "tools", scope: "global" as const, installedPath: "/tmp/a/npm/tools", source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } }],
    skills: [], extensions: [],
  };

  assert.deepEqual(await planRestore(profile, { only: "skill", currentScan }), [{ kind: "pi-install", id: "package:npm:tools", args: ["install", "npm:tools"], scope: "global" }]);
});

test("marks profile entries already present in the destination scan", async () => {
  const profile = {
    schemaVersion: 1 as const,
    profile: { name: "x", generatedAt: "2026-08-25T00:00:00.000Z", pi: { agentDirectory: "/tmp/a" } },
    packages: [{ id: "package:npm:tools", name: "tools", scope: "global" as const, installedPath: "/tmp/a/npm/tools", source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } }],
    skills: [], extensions: [],
  };
  const currentScan = {
    packages: [{ id: "package:npm:tools", type: "package" as const, name: "tools", scope: "global" as const, installedPath: "/tmp/a/npm/tools", source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } }],
    skills: [], extensions: [],
  };

  assert.deepEqual(await planRestore(profile, { currentScan }), [{ kind: "already-present", id: "package:npm:tools" }]);
});

test("rescans after package installs before completing restore", async () => {
  const { path } = await createFakePi(await makeTempDir());
  let rescans = 0;
  await executeRestore(
    [{ kind: "pi-install", id: "package:tools", args: ["install", "npm:tools"], scope: "global" }],
    { piPath: path, yes: true, rescan: async () => { rescans += 1; return { packages: [], skills: [], extensions: [] }; } },
  );

  assert.equal(rescans, 1);
});

test("does not rescan when every Pi package install fails", async () => {
  const { path } = await createFakePi(await makeTempDir(), "install npm:broken");
  let rescans = 0;
  const summary = await executeRestore(
    [{ kind: "pi-install", id: "package:broken", args: ["install", "npm:broken"], scope: "global" }],
    { piPath: path, yes: true, rescan: async () => { rescans += 1; return { packages: [], skills: [], extensions: [] }; } },
  );

  assert.equal(summary.failed, 1);
  assert.equal(rescans, 0);
});

test("does not write auto-discovered top-level skills or extensions to settings", async () => {
  const root = await makeTempDir();
  const projectRoot = join(root, "project");
  const skillPath = join(projectRoot, ".pi", "skills", "review");
  const extensionPath = join(projectRoot, ".pi", "extensions", "team.ts");
  await mkdir(skillPath, { recursive: true });
  await mkdir(join(projectRoot, ".pi", "extensions"), { recursive: true });
  await writeFile(extensionPath, "export default {}");
  const profile = {
    schemaVersion: 1 as const,
    profile: { name: "x", generatedAt: "2026-08-25T00:00:00.000Z", pi: { agentDirectory: join(root, "agent") } },
    packages: [],
    skills: [{ id: "skill:review", name: "review", scope: "local" as const, projectRoot, installedPath: skillPath, source: { kind: "local-path" as const, path: skillPath } }],
    extensions: [{ id: "extension:team", name: "team", scope: "local" as const, projectRoot, installedPath: extensionPath, source: { kind: "local-path" as const, path: extensionPath } }],
  };

  assert.deepEqual(await planRestore(profile), []);
});

test("retains Pi command failure details while continuing independent restores", async () => {
  const { path } = await createFakePi(await makeTempDir(), "install npm:broken");
  const summary = await executeRestore(
    [
      { kind: "pi-install", id: "package:broken", args: ["install", "npm:broken"], scope: "global" },
      { kind: "pi-install", id: "package:tools", args: ["install", "npm:tools"], scope: "global" },
    ],
    { piPath: path, yes: true },
  );

  assert.equal(summary.failures[0]?.id, "package:broken");
  assert.equal(summary.failures[0]?.exitCode, 1);
  assert.match(summary.failures[0]?.stderr ?? "", /fake Pi failure/);
  assert.match(summary.failures[0]?.command ?? "", /npm:broken/);
});
