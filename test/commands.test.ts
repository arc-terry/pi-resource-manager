import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { matchCatalog } from "../src/catalog.js";
import * as catalogModule from "../src/catalog.js";
import { createFakePi, makeTempDir } from "./helpers.js";
import { addSource, installCatalogEntries, removeCatalogEntries } from "../src/commands.js";
import type { ScanResult } from "../src/scanner.js";

test("loads and validates a schema-v1 YAML catalog", async () => {
  const file = join(await makeTempDir(), "catalog.yml");
  await writeFile(file, "schemaVersion: 1\nentries:\n  - name: tools\n    type: package\n    source: npm:tools\n");
  const loadCatalog = (catalogModule as typeof catalogModule & {
    loadCatalog?: (path: string) => Promise<unknown>;
  }).loadCatalog;

  assert.equal(typeof loadCatalog, "function");
  assert.deepEqual(await loadCatalog!(file), {
    schemaVersion: 1,
    entries: [{ name: "tools", type: "package", source: "npm:tools" }],
  });
});

test("add dry-run validates Pi source syntax without invoking Pi", async () => {
  const { path, log } = await createFakePi(await makeTempDir());

  const pending = await addSource("npm:tools", { local: false, type: "skill", dryRun: true, yes: true }, { piPath: path });

  assert.equal(pending.validation, "pending-rescan");
  await assert.rejects(readFile(log, "utf8"));
  await assert.rejects(
    addSource("tools", { local: false, dryRun: false, yes: true }, { piPath: path }),
    /Pi-supported source/,
  );
  await assert.rejects(readFile(log, "utf8"));
});

test("rejects an add type assertion supplied only by an unrelated package", async () => {
  const root = await makeTempDir();
  const agentDir = join(root, "agent");
  const { path } = await createFakePi(root);
  await mkdir(join(agentDir, "npm", "unrelated", "skills", "review"), { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:unrelated"] }));
  await writeFile(join(agentDir, "npm", "unrelated", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Existing\n---\n");

  const result = await addSource("npm:tools", { local: false, type: "skill", dryRun: false, yes: true }, { agentDir, piPath: path });

  assert.equal(result.validation, "failed");
  assert.equal(result.failed, 1);
});

test("installs and removes exactly the selected catalog sources through Pi", async () => {
  const root = await makeTempDir();
  const catalogPath = join(root, "catalog.yml");
  const { path, log } = await createFakePi(root);
  await writeFile(catalogPath, "schemaVersion: 1\nentries:\n  - name: tools\n    type: package\n    source: npm:tools\n  - name: other\n    type: package\n    source: npm:other\n");

  const installed = await installCatalogEntries(["tools"], { full: false, yes: true }, { catalogPath, piPath: path });
  const removed = await removeCatalogEntries(["tools"], { yes: true }, { catalogPath, piPath: path });

  assert.equal(installed.installed, 1);
  assert.equal(removed.removed, 1);
  assert.equal(await readFile(log, "utf8"), "install npm:tools\nremove npm:tools\n");
});

test("removes a source from its detected local Pi scope", async () => {
  const root = await makeTempDir();
  const projectRoot = join(root, "project");
  const agentDir = join(root, "agent");
  const catalogPath = join(root, "catalog.yml");
  const { path, log } = await createFakePi(root);
  await mkdir(join(projectRoot, ".pi"), { recursive: true });
  await writeFile(join(projectRoot, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:tools"] }));
  await writeFile(catalogPath, "schemaVersion: 1\nentries:\n  - name: tools\n    type: package\n    source: npm:tools\n");

  const summary = await removeCatalogEntries(["tools"], { yes: true }, { catalogPath, piPath: path, agentDir, projectRoot });

  assert.equal(summary.removed, 1);
  assert.equal(await readFile(log, "utf8"), "remove -l npm:tools\n");
});

test("marks a matching catalog entry installed", () => {
  const scan: ScanResult = {
    packages: [
      {
        id: "package:npm:tools",
        type: "package",
        name: "tools",
        scope: "global",
        installedPath: "/tmp/agent/npm/tools",
        source: {
          kind: "npm",
          spec: "npm:tools@1.0.0",
          name: "tools",
          version: "1.0.0",
        },
      },
    ],
    skills: [],
    extensions: [],
  };

  const statuses = matchCatalog(
    {
      schemaVersion: 1,
      entries: [
        { name: "tools", type: "package", source: "npm:tools@1.0.0" },
      ],
    },
    scan,
  );

  assert.deepEqual(
    statuses.map((status) => [status.installed, status.entry.name]),
    [[true, "tools"]],
  );
});
