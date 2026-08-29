import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  collectionSchema,
  emptyCollection,
  mergeCollection,
  readCollection,
  resourcesFromScan,
  writeCollectionAtomic,
} from "../src/collection.js";
import { makeTempDir } from "./helpers.js";

test("schema-v2 collection round-trips and merges matching scan and manual packages without duplication", async () => {
  const path = join(await makeTempDir(), "pi-collection.yml");
  const collection = emptyCollection("workstation", new Date("2026-08-29T00:00:00Z"));

  assert.deepEqual(collection, {
    schemaVersion: 2,
    collection: { name: "workstation", updatedAt: "2026-08-29T00:00:00.000Z" },
    resources: [],
  });
  await writeCollectionAtomic(path, collection);
  assert.deepEqual(await readCollection(path), collection);

  const legacyPath = join(await makeTempDir(), "old.yml");
  await writeFile(legacyPath, "schemaVersion: 1\npackages: []\n");
  await assert.rejects(readCollection(legacyPath), /schemaVersion/);

  const schemaBase = {
    schemaVersion: 2,
    collection: { name: "workstation", updatedAt: "2026-08-29T00:00:00.000Z" },
  };
  assert.throws(() => collectionSchema.parse({
    ...schemaBase,
    resources: [{
      id: "package:npm:duplicate", type: "package", name: "duplicate",
      origins: ["manual", "manual"], scope: "global",
      source: { kind: "npm", spec: "npm:duplicate", name: "duplicate" },
    }],
  }), /origins must be unique/);
  assert.throws(() => collectionSchema.parse({
    ...schemaBase,
    resources: [{
      id: "skill:orphan", type: "skill", name: "orphan",
      origins: ["manual"], scope: "global", ownerPackageId: "package:npm:missing",
      source: { kind: "npm", spec: "npm:orphan", name: "orphan" },
    }],
  }), /owner package does not exist/);
  assert.throws(() => collectionSchema.parse({
    ...schemaBase,
    resources: [{
      id: "package:npm:local", type: "package", name: "local",
      origins: ["scan"], scope: "local",
      source: { kind: "npm", spec: "npm:local", name: "local" },
    }],
  }), /local scanned resources require projectRoot/);

  const base = {
    ...emptyCollection("x", new Date("2026-08-29T00:00:00Z")),
    resources: [{
      id: "package:npm:tools", type: "package" as const, name: "tools",
      origins: ["manual" as const], scope: "global" as const,
      source: { kind: "npm" as const, spec: "npm:tools", name: "tools" },
    }],
  };
  const scan = {
    packages: [{
      id: "package:npm:tools", type: "package" as const, name: "tools",
      scope: "global" as const, installedPath: "/agent/npm/tools",
      source: { kind: "npm" as const, spec: "npm:tools@1.2.3", name: "tools", version: "1.2.3" },
    }],
    skills: [], extensions: [],
  };

  const merged = mergeCollection(base, resourcesFromScan(scan), "2026-08-29T01:00:00.000Z");
  assert.equal(merged.resources.length, 1);
  assert.deepEqual(merged.resources[0]?.origins, ["scan", "manual"]);
  assert.equal(merged.resources[0]?.installedPath, "/agent/npm/tools");
});
