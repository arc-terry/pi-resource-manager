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

const schemaBase = {
  schemaVersion: 2,
  collection: { name: "workstation", updatedAt: "2026-08-29T00:00:00.000Z" },
};

test("creates an empty schema-v2 collection", () => {
  assert.deepEqual(emptyCollection("workstation", new Date("2026-08-29T00:00:00Z")), {
    ...schemaBase,
    resources: [],
  });
});

test("schema-v2 collection round-trips through YAML", async () => {
  const path = join(await makeTempDir(), "pi-collection.yml");
  const collection = emptyCollection("workstation", new Date("2026-08-29T00:00:00Z"));

  await writeCollectionAtomic(path, collection);

  assert.deepEqual(await readCollection(path), collection);
});

test("rejects legacy schema version one", async () => {
  const path = join(await makeTempDir(), "old.yml");
  await writeFile(path, "schemaVersion: 1\npackages: []\n");

  await assert.rejects(readCollection(path), /schemaVersion/);
});

test("rejects collection resources with invalid cross-field values", () => {
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
});

test("merges matching scan and manual packages without duplication", () => {
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
  assert.deepEqual(merged.resources[0]?.source, scan.packages[0]?.source);
});

test("normalizes duplicate base identities without incoming resources", () => {
  const base = {
    ...emptyCollection("x", new Date("2026-08-29T00:00:00Z")),
    resources: [
      {
        id: "package:npm:tools", type: "package" as const, name: "tools",
        origins: ["manual" as const], scope: "global" as const,
        source: { kind: "npm" as const, spec: "npm:tools", name: "tools" },
      },
      {
        id: "package:npm:tools", type: "package" as const, name: "tools",
        origins: ["scan" as const], scope: "global" as const, installedPath: "/agent/npm/tools",
        source: { kind: "npm" as const, spec: "npm:tools@1.2.3", name: "tools", version: "1.2.3" },
      },
    ],
  };

  const merged = mergeCollection(base, [], "2026-08-29T01:00:00.000Z");

  assert.equal(merged.resources.length, 1);
  assert.deepEqual(merged.resources[0]?.origins, ["scan", "manual"]);
  assert.deepEqual(merged.resources[0]?.source, {
    kind: "npm", spec: "npm:tools@1.2.3", name: "tools", version: "1.2.3",
  });
});

test("remaps children to the canonical duplicate package ID", () => {
  const base = {
    ...emptyCollection("x", new Date("2026-08-29T00:00:00Z")),
    resources: [
      {
        id: "package:manual-tools", type: "package" as const, name: "tools",
        origins: ["manual" as const], scope: "global" as const,
        source: { kind: "npm" as const, spec: "npm:tools", name: "tools" },
      },
      {
        id: "package:scan-tools", type: "package" as const, name: "tools",
        origins: ["scan" as const], scope: "global" as const, installedPath: "/agent/npm/tools",
        source: { kind: "npm" as const, spec: "npm:tools@1.2.3", name: "tools", version: "1.2.3" },
      },
      {
        id: "skill:manual-tools:deploy", type: "skill" as const, name: "deploy",
        origins: ["scan" as const], scope: "global" as const, installedPath: "/agent/npm/tools/skills/deploy",
        ownerPackageId: "package:manual-tools",
        source: { kind: "npm" as const, spec: "npm:tools@1.2.3", name: "tools", version: "1.2.3" },
      },
    ],
  };

  const merged = mergeCollection(base, [], "2026-08-29T01:00:00.000Z");

  assert.deepEqual(merged.resources.map(({ id, ownerPackageId }) => ({ id, ownerPackageId })), [
    { id: "package:npm:tools", ownerPackageId: undefined },
    { id: "skill:manual-tools:deploy", ownerPackageId: "package:npm:tools" },
  ]);
});

test("scan refresh clears stale observed project roots", () => {
  const base = {
    ...emptyCollection("x", new Date("2026-08-29T00:00:00Z")),
    resources: [{
      id: "package:npm:tools", type: "package" as const, name: "tools",
      origins: ["scan" as const], scope: "local" as const,
      installedPath: "/old/.pi/npm/tools", projectRoot: "/old",
      source: { kind: "npm" as const, spec: "npm:tools@1.0.0", name: "tools", version: "1.0.0" },
    }],
  };
  const scan = {
    packages: [{
      id: "package:npm:tools", type: "package" as const, name: "tools",
      scope: "global" as const, installedPath: "/agent/npm/tools",
      source: { kind: "npm" as const, spec: "npm:tools@2.0.0", name: "tools", version: "2.0.0" },
    }],
    skills: [], extensions: [],
  };

  const merged = mergeCollection(base, resourcesFromScan(scan), "2026-08-29T01:00:00.000Z");

  assert.deepEqual(merged.resources[0], {
    id: "package:npm:tools", type: "package", name: "tools", origins: ["scan"],
    scope: "global", installedPath: "/agent/npm/tools",
    source: { kind: "npm", spec: "npm:tools@2.0.0", name: "tools", version: "2.0.0" },
  });
});
