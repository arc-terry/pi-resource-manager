import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { addSource, installCatalogEntries, listCollection, removeCatalogEntries } from "../src/commands.js";
import { loadCatalog, matchCatalog } from "../src/catalog.js";
import { createFakePi, makeTempDir } from "./helpers.js";

test("marks a matching catalog package installed by normalized source identity", () => {
  const statuses = matchCatalog(
    { schemaVersion: 1, entries: [{ name: "tools", type: "package", source: "npm:tools@1.0.0" }] },
    { packages: [{ id: "package:npm:tools", type: "package", name: "tools", source: { kind: "npm", spec: "npm:tools@2.0.0", name: "tools", version: "2.0.0" } }], skills: [], extensions: [] } as never,
  );

  assert.deepEqual(statuses.map((status) => [status.installed, status.entry.name]), [[true, "tools"]]);
});

test("requires the expected package-provided resource for skills and plugins", () => {
  const statuses = matchCatalog(
    {
      schemaVersion: 1,
      entries: [
        { name: "review", type: "skill", source: "npm:tools", expectedResource: "code-review" },
        { name: "team", type: "plugin", source: "npm:tools" },
      ],
    },
    {
      packages: [{ id: "package:npm:tools", type: "package", name: "tools", source: { kind: "npm", spec: "npm:tools", name: "tools" } }],
      skills: [{ id: "skill:package:npm:tools:code-review", type: "skill", name: "code-review", ownerPackageId: "package:npm:tools" }],
      extensions: [{ id: "extension:other:team", type: "extension", name: "team", ownerPackageId: "package:npm:other" }],
    } as never,
  );

  assert.deepEqual(statuses.map((status) => [status.entry.name, status.installed]), [["review", true], ["team", false]]);
});

test("loads a schema-versioned catalog", async () => {
  const file = join(await makeTempDir(), "catalog.yml");
  await writeFile(file, "schemaVersion: 1\nentries:\n  - name: tools\n    type: package\n    source: npm:tools\n");

  assert.deepEqual(await loadCatalog(file), {
    schemaVersion: 1,
    entries: [{ name: "tools", type: "package", source: "npm:tools" }],
  });
});

test("rejects a catalog with an unsupported schema version", async () => {
  const file = join(await makeTempDir(), "catalog.yml");
  await writeFile(file, "schemaVersion: 2\nentries: []\n");

  await assert.rejects(loadCatalog(file), /schemaVersion/);
});

const catalog = {
  schemaVersion: 1 as const,
  entries: [
    { name: "tools", type: "package" as const, source: "npm:tools" },
    { name: "review", type: "skill" as const, source: "npm:review-tools" },
    { name: "team", type: "plugin" as const, source: "npm:team-tools" },
  ],
};

const emptyScan = { packages: [], skills: [], extensions: [] };

function quietOutput(): Writable {
  return new Writable({ write(_chunk, _encoding, callback) { callback(); } });
}

test("lists only the requested catalog type", async () => {
  const statuses = await listCollection({ type: "skill" }, { catalog, scan: async () => emptyScan });

  assert.deepEqual(statuses.map((status) => status.entry.name), ["review"]);
});

test("installs exactly the selected catalog entry through Pi", async () => {
  const { path, log } = await createFakePi(await makeTempDir());

  const result = await installCatalogEntries(["review"], { yes: true }, { catalog, scan: async () => emptyScan, piPath: path });

  assert.deepEqual(result, { requested: 1, completed: 1, skipped: 0 });
  assert.equal(await readFile(log, "utf8"), "install npm:review-tools\n");
});

test("installs every catalog source with full", async () => {
  const { path, log } = await createFakePi(await makeTempDir());

  await installCatalogEntries([], { full: true, yes: true }, { catalog, scan: async () => emptyScan, piPath: path });

  assert.equal(await readFile(log, "utf8"), "install npm:tools\ninstall npm:review-tools\ninstall npm:team-tools\n");
});

test("does not install catalog entries when confirmation is declined", async () => {
  const { path, log } = await createFakePi(await makeTempDir());

  const result = await installCatalogEntries(
    ["tools"],
    { yes: false, input: Readable.from(["n\n"]), output: quietOutput() },
    { catalog, scan: async () => emptyScan, piPath: path },
  );

  assert.deepEqual(result, { requested: 1, completed: 0, skipped: 1 });
  await assert.rejects(readFile(log, "utf8"));
});

test("removes a locally installed catalog source with Pi local scope", async () => {
  const { path, log } = await createFakePi(await makeTempDir());
  const localScan = {
    packages: [{ id: "package:npm:tools", type: "package" as const, name: "tools", scope: "local" as const, source: { kind: "npm" as const, spec: "npm:tools", name: "tools" }, installedPath: "/project/.pi/npm/tools", projectRoot: "/project" }],
    skills: [],
    extensions: [],
  };

  const result = await removeCatalogEntries(["tools"], { yes: true }, { catalog, scan: async () => localScan, piPath: path });

  assert.deepEqual(result, { requested: 1, completed: 1, skipped: 0 });
  assert.equal(await readFile(log, "utf8"), "remove -l npm:tools\n");
});

test("adds only a source that supplies the requested skill", async () => {
  const { path } = await createFakePi(await makeTempDir());

  const result = await addSource("npm:tools", { expectedType: "skill", dryRun: true, yes: true }, { piPath: path, scan: async () => emptyScan });

  assert.equal(result.validation, "pending-rescan");
});

test("validates a requested plugin after Pi installs the source", async () => {
  const { path, log } = await createFakePi(await makeTempDir());
  const scan = {
    packages: [{ id: "package:npm:tools", type: "package" as const, name: "tools", scope: "global" as const, source: { kind: "npm" as const, spec: "npm:tools", name: "tools" }, installedPath: "/agent/npm/tools" }],
    skills: [],
    extensions: [{ id: "extension:package:npm:tools:team", type: "extension" as const, name: "team", scope: "global" as const, source: { kind: "npm" as const, spec: "npm:tools", name: "tools" }, installedPath: "/agent/npm/tools/extensions/team.ts", ownerPackageId: "package:npm:tools" }],
  };

  const result = await addSource("npm:tools", { expectedType: "plugin", yes: true }, { piPath: path, scan: async () => scan });

  assert.equal(result.validation, "passed");
  assert.equal(await readFile(log, "utf8"), "install npm:tools\n");
});

test("rejects an unsupported add source before Pi is invoked", async () => {
  const { path, log } = await createFakePi(await makeTempDir());

  await assert.rejects(addSource("tools", { dryRun: false, yes: true }, { piPath: path, scan: async () => emptyScan }), /Pi-supported source/);
  await assert.rejects(readFile(log, "utf8"));
});
