import assert from "node:assert/strict";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import test from "node:test";
import { basename, dirname, extname, join, resolve } from "node:path";
import { renderChecklist } from "../src/cli.js";
import { createFakePi, makeTempDir } from "./helpers.js";

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ProcessResult extends CliResult {
  error?: Error;
}

async function runProcess(command: string, args: string[]): Promise<ProcessResult> {
  const child = spawn(command, args);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  return new Promise((resolveResult) => {
    child.once("error", (error) => resolveResult({ code: 1, stdout, stderr, error }));
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

async function writeCatalog(cwd: string): Promise<void> {
  await writeFile(join(cwd, "catalog.yml"), `schemaVersion: 1
entries:
  - name: tools
    type: package
    source: npm:tools
    description: Tool collection
  - name: review
    type: skill
    source: npm:review-tools
  - name: team
    type: plugin
    source: npm:team-tools
`);
}

async function writeAgent(agentDir: string, packages: unknown[] = []): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages }));
}

test("renders extensions as plugins for CLI users", async () => {
  const { displayType } = await import("../src/domain.js");
  assert.equal(displayType("package"), "package");
  assert.equal(displayType("skill"), "skill");
  assert.equal(displayType("extension"), "plugin");
});

test("renders missing and installed entries with required brackets", () => {
  assert.equal(
    renderChecklist([
      { installed: true, entry: { type: "package", name: "tools" } },
      { installed: false, entry: { type: "plugin", name: "team" } },
    ] as never, false),
    "[v] package tools\n[ ] plugin team",
  );
});

test("build output is directly executable", async () => {
  const build = await runProcess("npm", ["run", "build"]);
  assert.equal(build.error, undefined);
  assert.equal(build.code, 0);

  const result = await runProcess(resolve("dist/cli.js"), ["--help"]);
  assert.equal(result.error, undefined);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: pi-collection/);
});

test("runs when invoked through an npm-style symlink", async () => {
  const cwd = await makeTempDir();
  const linked = join(cwd, "pi-collection");
  await symlink(resolve("dist/cli.js"), linked);

  const result = await runProcess(linked, ["--help"]);
  assert.equal(result.error, undefined);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: pi-collection/);
});

test("list filters types, renders full details, and emits JSON without prose", async () => {
  const cwd = await makeTempDir();
  const agentDir = join(cwd, "agent");
  await writeCatalog(cwd);
  await writeAgent(agentDir, ["npm:tools"]);

  const filtered = await runCli(["list", "--type", "plugin"], { cwd, env: { PI_CODING_AGENT_DIR: agentDir } });
  assert.equal(filtered.code, 0);
  assert.equal(filtered.stdout, "[ ] plugin team\n");

  const full = await runCli(["list", "--type", "package", "--full"], { cwd, env: { PI_CODING_AGENT_DIR: agentDir } });
  assert.equal(full.code, 0);
  assert.match(full.stdout, /^\[v\] package tools\n/);
  assert.match(full.stdout, /source: npm:tools/);
  assert.match(full.stdout, /description: Tool collection/);
  assert.match(full.stdout, /scope: global/);

  const json = await runCli(["list", "--json"], { cwd, env: { PI_CODING_AGENT_DIR: agentDir } });
  assert.equal(json.code, 0);
  assert.equal(json.stderr, "");
  assert.deepEqual(JSON.parse(json.stdout).map((status: { entry: { name: string } }) => status.entry.name), ["tools", "review", "team"]);
});

test("rejects invalid public resource types before executing commands", async () => {
  const cwd = await makeTempDir();
  await writeCatalog(cwd);

  const result = await runCli(["list", "--type", "extension"], { cwd });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /type.*package.*skill.*plugin/i);
});

test("catalog install uses global Pi arguments and add local uses -l", async () => {
  const cwd = await makeTempDir();
  const agentDir = join(cwd, "agent");
  const fake = await createFakePi(cwd);
  await writeCatalog(cwd);
  await writeAgent(agentDir);
  const env = { PI_CODING_AGENT_DIR: agentDir, PATH: `${dirname(fake.path)}:${process.env.PATH}` };

  const install = await runCli(["install", "tools", "--yes"], { cwd, env });
  assert.equal(install.code, 0);
  assert.equal(await readFile(fake.log, "utf8"), "install npm:tools\n");

  const add = await runCli(["add", "npm:local-tools", "--local", "--yes"], { cwd, env });
  assert.equal(add.code, 0);
  assert.equal(await readFile(fake.log, "utf8"), "install npm:tools\ninstall -l npm:local-tools\n");
});

test("add validates a requested plugin after Pi installation", async () => {
  const cwd = await makeTempDir();
  const agentDir = join(cwd, "agent");
  const fake = await createFakePi(cwd);
  const packageDir = join(agentDir, "npm", "plugin-tools");
  await writeCatalog(cwd);
  await writeAgent(agentDir, ["npm:plugin-tools"]);
  await mkdir(join(packageDir, "extensions"), { recursive: true });
  await writeFile(join(packageDir, "extensions", "team.ts"), "export default {};");
  const env = { PI_CODING_AGENT_DIR: agentDir, PATH: `${dirname(fake.path)}:${process.env.PATH}` };

  const success = await runCli(["add", "npm:plugin-tools", "--type", "plugin", "--yes"], { cwd, env });
  assert.equal(success.code, 0);
  assert.match(success.stdout, /validation: passed/);
  assert.equal(await readFile(fake.log, "utf8"), "install npm:plugin-tools\n");

  const failure = await runCli(["add", "npm:plugin-tools", "--type", "skill", "--yes"], { cwd, env });
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /does not supply a skill/);
});

test("profile scan defaults its output and profile show prints YAML", async () => {
  const cwd = await makeTempDir();
  const agentDir = join(cwd, "agent");
  await writeAgent(agentDir, ["npm:tools"]);

  const scan = await runCli(["profile", "scan"], { cwd, env: { PI_CODING_AGENT_DIR: agentDir } });
  assert.equal(scan.code, 0);
  const profilePath = join(cwd, "pi-profile.yml");
  await access(profilePath);
  const profile = await readFile(profilePath, "utf8");
  assert.match(profile, /schemaVersion: 1/);
  assert.match(profile, new RegExp(`name: ${basename(profilePath, extname(profilePath))}`));

  const show = await runCli(["profile", "show", "pi-profile.yml"], { cwd });
  assert.equal(show.code, 0);
  assert.equal(show.stdout, profile);
});

test("profile restore dry-run prints actions without calling Pi", async () => {
  const cwd = await makeTempDir();
  const agentDir = join(cwd, "agent");
  const fake = await createFakePi(cwd);
  const profilePath = join(cwd, "profile.yml");
  await writeAgent(agentDir);
  await writeFile(profilePath, `schemaVersion: 1
profile:
  name: test
  generatedAt: 2026-08-25T00:00:00.000Z
  pi:
    agentDirectory: ${agentDir}
packages:
  - id: package:npm:tools
    name: tools
    scope: global
    installedPath: ${join(agentDir, "npm", "tools")}
    source:
      kind: npm
      spec: npm:tools
      name: tools
skills: []
extensions: []
`);

  const result = await runCli(["profile", "restore", profilePath, "--dry-run", "--yes"], {
    cwd,
    env: { PI_CODING_AGENT_DIR: agentDir, PATH: `${dirname(fake.path)}:${process.env.PATH}` },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /pi install npm:tools/);
  await assert.rejects(readFile(fake.log, "utf8"));
});

test("profile restore reports failures and exits one after its summary", async () => {
  const cwd = await makeTempDir();
  const profilePath = join(cwd, "profile.yml");
  await writeFile(profilePath, `schemaVersion: 1
profile:
  name: test
  generatedAt: 2026-08-25T00:00:00.000Z
  pi:
    agentDirectory: ${join(cwd, "agent")}
packages:
  - id: package:missing
    name: missing
    scope: global
    installedPath: ${join(cwd, "agent", "npm", "missing")}
    source:
      kind: local-path
      path: ${join(cwd, "missing")}
skills: []
extensions: []
`);

  const result = await runCli(["profile", "restore", profilePath, "--yes"], { cwd });

  assert.equal(result.code, 1);
  assert.match(result.stdout, /failed: 1/);
});
