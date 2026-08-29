import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readCollection, writeCollectionAtomic } from "../src/collection.js";
import { createFakePi, makeTempDir } from "./helpers.js";

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runProcess(command: string, args: string[]): Promise<CliResult> {
  const child = spawn(command, args);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  return new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolveResult({ code: exitCode ?? 1, stdout, stderr }));
  });
}

async function runCli(args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<CliResult> {
  const child = spawn(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("src/cli.ts"), ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
  });
  let stdout = "";
  let stderr = "";
  child.stdin.end();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolveCode(exitCode ?? 1));
  });
  return { code, stdout, stderr };
}

async function writeAgent(agentDir: string, packages: unknown[] = []): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages }));
}

const scannedToolsCollection = {
  schemaVersion: 2 as const,
  collection: { name: "test", updatedAt: "2026-08-29T00:00:00.000Z" },
  resources: [{
    id: "package:npm:tools",
    type: "package" as const,
    name: "tools",
    origins: ["scan" as const],
    scope: "global" as const,
    source: { kind: "npm" as const, spec: "npm:tools", name: "tools" },
  }],
};

test("install scans saved local project roots before planning", async () => {
  const cwd = await makeTempDir();
  const projectRoot = join(cwd, "project");
  const agentDir = join(cwd, "agent");
  const fake = await createFakePi(cwd);
  await writeAgent(agentDir);
  await mkdir(join(projectRoot, ".pi"), { recursive: true });
  await writeFile(join(projectRoot, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:local-tools"] }));
  await writeCollectionAtomic(join(cwd, "pi-collection.yml"), {
    schemaVersion: 2,
    collection: { name: "test", updatedAt: "2026-08-29T00:00:00.000Z" },
    resources: [{
      id: "package:npm:local-tools", type: "package", name: "local-tools", origins: ["scan"], scope: "local", projectRoot,
      source: { kind: "npm", spec: "npm:local-tools", name: "local-tools" },
    }],
  });

  const result = await runCli(["install", "--yes"], {
    cwd,
    env: { PI_CODING_AGENT_DIR: agentDir, PATH: `${dirname(fake.path)}:${process.env.PATH}` },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /already present: 1/);
  await assert.rejects(readFile(fake.log, "utf8"));
});

// Fails if the legacy Commander command surface remains, unified commands do not
// persist their intended origins, or noninteractive/dry-run installation regresses.
test("CLI exposes only scan, add, and install", async () => {
  const help = await runCli(["--help"], { cwd: await makeTempDir() });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /\bscan\b/);
  assert.match(help.stdout, /\badd\b/);
  assert.match(help.stdout, /\binstall\b/);
  assert.doesNotMatch(help.stdout, /\blist\b|\bremove\b|\bprofile\b/);

  const removed = await runCli(["profile", "scan"], { cwd: await makeTempDir() });
  assert.notEqual(removed.code, 0);

  const scanCwd = await makeTempDir();
  const scanAgentDir = join(scanCwd, "agent");
  await writeAgent(scanAgentDir, ["npm:tools"]);
  const scan = await runCli(["scan"], { cwd: scanCwd, env: { PI_CODING_AGENT_DIR: scanAgentDir } });
  assert.equal(scan.code, 0);
  assert.match(scan.stdout, /\[v\] package tools/);
  await assert.rejects(access(join(scanCwd, "pi-collection.yml")));

  const addCwd = await makeTempDir();
  const addAgentDir = join(addCwd, "agent");
  await writeAgent(addAgentDir, ["npm:tools"]);
  for (const args of [[], ["--scan"]]) {
    assert.equal((await runCli(["add", ...args], { cwd: addCwd, env: { PI_CODING_AGENT_DIR: addAgentDir } })).code, 0);
    assert.deepEqual((await readCollection(join(addCwd, "pi-collection.yml"))).resources[0]?.origins, ["scan"]);
  }

  const fake = await createFakePi(addCwd);
  assert.equal((await runCli(["add", "npm:manual"], {
    cwd: addCwd,
    env: { PI_CODING_AGENT_DIR: addAgentDir, PATH: `${dirname(fake.path)}:${process.env.PATH}` },
  })).code, 0);
  assert.deepEqual((await readCollection(join(addCwd, "pi-collection.yml"))).resources.find((resource) => resource.name === "manual")?.origins, ["manual"]);
  await assert.rejects(readFile(fake.log, "utf8"));

  const conflictingAdd = await runCli(["add", "npm:tools", "--scan"], { cwd: await makeTempDir() });
  assert.equal(conflictingAdd.code, 1);
  assert.match(conflictingAdd.stderr, /mutually exclusive/);

  const installCwd = await makeTempDir();
  const installFake = await createFakePi(installCwd);
  await writeCollectionAtomic(join(installCwd, "pi-collection.yml"), scannedToolsCollection);
  const dryRun = await runCli(["install", "--yes", "--dry-run"], {
    cwd: installCwd,
    env: { PATH: `${dirname(installFake.path)}:${process.env.PATH}` },
  });
  assert.equal(dryRun.code, 0);
  assert.match(dryRun.stdout, /pi install npm:tools/);
  await assert.rejects(readFile(installFake.log, "utf8"));

  const installed = await runCli(["install", "--yes"], {
    cwd: installCwd,
    env: { PATH: `${dirname(installFake.path)}:${process.env.PATH}` },
  });
  assert.equal(installed.code, 0);
  assert.match(installed.stdout, /pi install npm:tools/);
  assert.match(installed.stdout, /installed: 1/);
  assert.equal(await readFile(installFake.log, "utf8"), "install npm:tools\n");

  const failedInstallCwd = await makeTempDir();
  const failingPi = await createFakePi(failedInstallCwd, "install npm:tools");
  await writeCollectionAtomic(join(failedInstallCwd, "pi-collection.yml"), scannedToolsCollection);
  const failedInstall = await runCli(["install", "--yes"], {
    cwd: failedInstallCwd,
    env: { PATH: `${dirname(failingPi.path)}:${process.env.PATH}` },
  });
  assert.equal(failedInstall.code, 1);
  assert.match(failedInstall.stdout, /installed: 0/);
  assert.match(failedInstall.stdout, /failed: 1/);
  assert.match(failedInstall.stdout, /failure package:npm:tools:/);
  assert.match(failedInstall.stdout, /exit status: 1/);
  assert.equal(await readFile(failingPi.log, "utf8"), "install npm:tools\n");

  const noninteractive = await runCli(["install"], { cwd: installCwd });
  assert.equal(noninteractive.code, 1);
  assert.match(noninteractive.stderr, /use --yes/);

  const build = await runProcess("npm", ["run", "build"]);
  assert.equal(build.code, 0);
  const executable = await runProcess(resolve("dist/cli.js"), ["--help"]);
  assert.equal(executable.code, 0);
  assert.match(executable.stdout, /Usage: pi-collection/);
  const linked = join(await makeTempDir(), "pi-collection");
  await symlink(resolve("dist/cli.js"), linked);
  const symlinked = await runProcess(linked, ["--help"]);
  assert.equal(symlinked.code, 0);
  assert.match(symlinked.stdout, /Usage: pi-collection/);
  const imported = await runProcess(process.execPath, [
    "--input-type=module",
    "-e",
    `import(${JSON.stringify(pathToFileURL(resolve("dist/cli.js")).href)})`,
  ]);
  assert.equal(imported.code, 0);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
});
