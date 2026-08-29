import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { addResources, scanResources } from "../src/commands.js";
import { readCollection } from "../src/collection.js";
import { makeTempDir } from "./helpers.js";

const scan = {
  packages: [{ id: "package:npm:tools", type: "package" as const, name: "tools", scope: "global" as const, installedPath: "/agent/npm/tools", source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } }],
  skills: [],
  extensions: [],
};

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
