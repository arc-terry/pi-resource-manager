import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { displayType } from "../src/domain.js";
import { buildProgram, renderChecklist } from "../src/cli.js";

const execFile = promisify(execFileCallback);

test("renders extensions as plugins for CLI users", () => {
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

test("renders catalog source and description when full details are requested", () => {
  assert.equal(
    renderChecklist([
      {
        installed: true,
        entry: { type: "package", name: "tools", source: "npm:tools", description: "Pi tools" },
      },
    ] as never, true),
    "[v] package tools\n    source: npm:tools\n    description: Pi tools",
  );
});

test("list forwards its type filter and renders the selected checklist entries", async () => {
  const statuses = [
    { installed: true, entry: { type: "package", name: "tools", source: "npm:tools" } },
    { installed: false, entry: { type: "plugin", name: "team", source: "npm:team" } },
  ] as const;
  let stdout = "";
  const program = buildProgram({
    listCollection: async (options: { type?: string }) => statuses.filter((status) => !options.type || status.entry.type === options.type),
    write: (text: string) => { stdout += text; },
  } as never);

  await program.parseAsync(["node", "pi-collection", "list", "--type", "plugin"]);

  assert.equal(stdout, "[ ] plugin team\n");
});

test("list emits JSON without checklist markers when requested", async () => {
  let stdout = "";
  const program = buildProgram({
    listCollection: async () => [{ installed: true, entry: { type: "package", name: "tools", source: "npm:tools" } }],
    write: (text: string) => { stdout += text; },
  } as never);

  await program.parseAsync(["node", "pi-collection", "list", "--json"]);

  assert.deepEqual(JSON.parse(stdout), [{ installed: true, entry: { type: "package", name: "tools", source: "npm:tools" } }]);
  assert.doesNotMatch(stdout, /\[v]/);
});

test("install forwards selected names and confirmation options", async () => {
  let received: unknown;
  let stdout = "";
  const program = buildProgram({
    installCatalogEntries: async (names: string[], options: unknown) => {
      received = { names, options };
      return { installed: 2 };
    },
    write: (text: string) => { stdout += text; },
  } as never);
  program.exitOverride();

  await program.parseAsync(["node", "pi-collection", "install", "tools", "team", "--full", "--type", "plugin", "--yes"]);

  assert.deepEqual(received, { names: ["tools", "team"], options: { full: true, type: "plugin", yes: true } });
  assert.equal(stdout, "{\"installed\":2}\n");
});

test("remove forwards the selected names, type, and confirmation", async () => {
  let received: unknown;
  const program = buildProgram({
    removeCatalogEntries: async (names: string[], options: unknown) => {
      received = { names, options };
      return { removed: 1 };
    },
    write: () => undefined,
  } as never);
  program.exitOverride();

  await program.parseAsync(["node", "pi-collection", "remove", "tools", "--type", "package", "--yes"]);

  assert.deepEqual(received, { names: ["tools"], options: { type: "package", yes: true } });
});

test("add forwards local plugin validation and dry-run options", async () => {
  let received: unknown;
  const program = buildProgram({
    addSource: async (source: string, options: unknown) => {
      received = { source, options };
      return { added: 1 };
    },
    write: () => undefined,
  } as never);
  program.exitOverride();

  await program.parseAsync(["node", "pi-collection", "add", "npm:team", "--local", "--type", "plugin", "--dry-run", "--yes"]);

  assert.deepEqual(received, {
    source: "npm:team",
    options: { local: true, type: "plugin", dryRun: true, yes: true },
  });
});

test("profile scan uses its default output path and forwards the project", async () => {
  let received: unknown;
  const program = buildProgram({
    scanProfile: async (options: unknown) => {
      received = options;
      return { written: "pi-profile.yml" };
    },
    write: () => undefined,
  } as never);
  program.exitOverride();

  await program.parseAsync(["node", "pi-collection", "profile", "scan", "--project", "/workspace"]);

  assert.deepEqual(received, { output: "pi-profile.yml", project: "/workspace" });
});

test("profile show forwards its path and renders the loaded profile", async () => {
  let received = "";
  let stdout = "";
  const program = buildProgram({
    showProfile: async (path: string) => {
      received = path;
      return { schemaVersion: 1, packages: [] };
    },
    write: (text: string) => { stdout += text; },
  } as never);
  program.exitOverride();
  program.commands.find((command) => command.name() === "profile")?.exitOverride();

  await program.parseAsync(["node", "pi-collection", "profile", "show", "saved.yml"]);

  assert.equal(received, "saved.yml");
  assert.equal(stdout, "{\"schemaVersion\":1,\"packages\":[]}\n");
});

test("profile restore forwards dry-run filters and prints planned actions", async () => {
  let received: unknown;
  let stdout = "";
  const program = buildProgram({
    restoreProfile: async (path: string, options: unknown) => {
      received = { path, options };
      return { actions: ["pi install npm:tools"] };
    },
    write: (text: string) => { stdout += text; },
  } as never);
  program.exitOverride();
  program.commands.find((command) => command.name() === "profile")?.exitOverride();

  await program.parseAsync(["node", "pi-collection", "profile", "restore", "saved.yml", "--dry-run", "--only", "plugin", "--project", "/workspace", "--yes"]);

  assert.deepEqual(received, {
    path: "saved.yml",
    options: { dryRun: true, only: "plugin", project: "/workspace", yes: true },
  });
  assert.match(stdout, /pi install npm:tools/);
});

test("rejects unsupported CLI resource types before invoking add", async () => {
  let called = false;
  const program = buildProgram({
    addSource: async () => {
      called = true;
      return { added: 1 };
    },
    write: () => undefined,
  } as never);
  program.exitOverride();
  const add = program.commands.find((command) => command.name() === "add");
  add?.configureOutput({ writeErr: () => undefined });
  add?.exitOverride();

  await assert.rejects(
    program.parseAsync(["node", "pi-collection", "add", "npm:tools", "--type", "extension"]),
    /type must be package, skill, or plugin/,
  );
  assert.equal(called, false);
});

test("sets a nonzero exit code when an action summary reports failures", async () => {
  const originalExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    const program = buildProgram({
      installCatalogEntries: async () => ({ installed: 0, failed: 1 }),
      write: () => undefined,
    } as never);

    await program.parseAsync(["node", "pi-collection", "install", "tools", "--yes"]);

    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test("executable help exposes every Task 7 command", async () => {
  const { stdout } = await execFile(process.execPath, ["--import", "tsx", "src/cli.ts", "--help"]);

  for (const command of ["list", "install", "remove", "add", "profile"]) {
    assert.match(stdout, new RegExp(`\\b${command}\\b`));
  }
});
