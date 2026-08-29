import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join, resolve } from "node:path";
import { addResources, scanResources } from "../src/commands.js";
import { readCollection } from "../src/collection.js";
import { makeTempDir } from "./helpers.js";

const scan = {
  packages: [{ id: "package:npm:tools", type: "package" as const, name: "tools", scope: "global" as const, installedPath: "/agent/npm/tools", source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } }],
  skills: [],
  extensions: [],
};

test("add defaults to scanning and saves scan-origin resources", async () => {
  const collectionPath = join(await makeTempDir(), "pi-collection.yml");
  let scans = 0;
  await addResources({ collectionPath }, { scan: async () => { scans += 1; return scan; } });

  assert.equal(scans, 1);
  assert.deepEqual((await readCollection(collectionPath)).resources.map((resource) => [resource.name, resource.origins]), [["tools", ["scan"]]]);
});

test("canonicalizes project roots before scanning and persisting", async () => {
  const collectionPath = join(await makeTempDir(), "pi-collection.yml");
  const projectRoot = "relative-project";
  const scannedRoots: Array<string | undefined> = [];

  await addResources({ scan: true, projectRoot, collectionPath }, {
    scan: async (options) => {
      scannedRoots.push(options.projectRoot);
      return {
        packages: [{ id: "package:npm:local", type: "package", name: "local", scope: "local", projectRoot: options.projectRoot!, installedPath: "/agent/local", source: { kind: "npm", spec: "npm:local", name: "local" } }],
        skills: [], extensions: [],
      };
    },
  });

  assert.deepEqual(scannedRoots, [resolve(projectRoot)]);
  assert.equal((await readCollection(collectionPath)).resources[0]?.projectRoot, resolve(projectRoot));
});

test("scan and add orchestrate a schema-v2 collection", async () => {
  const root = await makeTempDir();
  const scanPath = join(root, "scan-only.yml");
  assert.deepEqual(await scanResources({ projectRoot: root }, { scan: async () => scan }), scan);
  await assert.rejects(readFile(scanPath, "utf8"));

  const collectionPath = join(root, "pi-collection.yml");
  await addResources({ scan: true, collectionPath, now: new Date("2026-08-29T00:00:00Z") }, { scan: async () => scan });
  let collection = await readCollection(collectionPath);
  assert.equal(collection.schemaVersion, 2);
  assert.deepEqual(collection.resources.map((resource) => [resource.name, resource.origins]), [["tools", ["scan"]]]);

  await addResources({ scan: true, collectionPath }, { scan: async () => ({ packages: [], skills: [], extensions: [] }) });
  collection = await readCollection(collectionPath);
  assert.deepEqual(collection.resources.map((resource) => resource.name), ["tools"]);

  const manualPath = join(root, "manual.yml");
  await addResources({ source: "npm:manual-tools", collectionPath: manualPath }, { scan: async () => { throw new Error("scan must not run"); } });
  assert.deepEqual((await readCollection(manualPath)).resources.map((resource) => [resource.type, resource.name, resource.origins]), [["package", "manual-tools", ["manual"]]]);

  const invalidPath = join(root, "invalid.yml");
  await assert.rejects(addResources({ source: "tools", collectionPath: invalidPath }), /Pi-supported source/);
  await assert.rejects(readFile(invalidPath, "utf8"));
  await assert.rejects(addResources({ source: "npm:tools", scan: true, collectionPath: invalidPath }), /mutually exclusive/);
  await assert.rejects(readFile(invalidPath, "utf8"));
});
