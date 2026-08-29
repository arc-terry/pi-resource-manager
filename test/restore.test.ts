import assert from "node:assert/strict";
import { realpath, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { executeRestore, type RestoreAction } from "../src/restore.js";
import { runPi } from "../src/pi-command.js";
import { makeTempDir, createFakePi } from "./helpers.js";

test("dry-run does not invoke Pi", async () => {
  const { path, log } = await createFakePi(await makeTempDir());
  const summary = await executeRestore([{ kind: "pi-install", id: "package:tools", args: ["install", "npm:tools"], scope: "global" }], { dryRun: true, piPath: path, yes: true });
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

test("continues installation after an independent Pi install failure", async () => {
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

test("writes settings entries during installation", async () => {
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

test("rescans after package installs before completing installation", async () => {
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

test("retains Pi command failure details while continuing independent installs", async () => {
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
