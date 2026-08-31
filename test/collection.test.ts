import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collapseHomePath,
  collapseHomeReference,
  collectionSchema,
  emptyCollection,
  expandHomePath,
  expandHomeReference,
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

test("stores home paths portably and expands them for runtime use", async () => {
  const path = join(await makeTempDir(), "pi-collection.yml");
  const home = homedir();
  const packagePath = join(home, "tools", "local-package");
  const projectRoot = join(home, "projects", "app");
  const packageId = `package:local:${packagePath}`;
  const collection = {
    ...emptyCollection("portable", new Date("2026-08-29T00:00:00Z")),
    resources: [
      {
        id: packageId,
        type: "package" as const,
        name: "local-package",
        origins: ["scan" as const],
        scope: "local" as const,
        projectRoot,
        installedPath: join(projectRoot, ".pi", "local-package"),
        source: { kind: "local-path" as const, path: packagePath },
      },
      {
        id: `skill:owner:${packageId}:review`,
        type: "skill" as const,
        name: "review",
        origins: ["scan" as const],
        scope: "local" as const,
        projectRoot,
        installedPath: join(packagePath, "skills", "review"),
        ownerPackageId: packageId,
        source: { kind: "local-path" as const, path: packagePath },
      },
    ],
  };

  await writeCollectionAtomic(path, collection);

  const yaml = await readFile(path, "utf8");
  assert.equal(yaml.includes(home), false);
  assert.match(yaml, /installedPath: \$HOME\//);
  assert.match(yaml, /projectRoot: \$HOME\//);
  assert.match(yaml, /path: \$HOME\//);
  assert.match(yaml, /id: .*\$HOME\//);
  assert.match(yaml, /ownerPackageId: .*\$HOME\//);
  assert.deepEqual(await readCollection(path), collection);
});

test("home path codec preserves boundaries and platform separators", () => {
  const home = homedir();
  assert.equal(collapseHomePath(join(home, "..cache", "tool")), "$HOME/..cache/tool");
  assert.equal(collapseHomePath(`/tmp${home}/tool`), `/tmp${home}/tool`);
  assert.equal(collapseHomeReference(`package:local:/tmp${home}/tool`), `package:local:/tmp${home}/tool`);
  assert.equal(expandHomePath("$HOMELESS/tool"), "$HOMELESS/tool");
  assert.throws(() => expandHomePath("$HOME//tmp"), /Invalid portable home path/);
  assert.throws(() => expandHomePath("$HOME/../tmp"), /escapes \$HOME/);

  const windowsHome = String.raw`C:\Users\alice`;
  const windowsPath = String.raw`C:\Users\alice\tools\plugin`;
  assert.equal(collapseHomePath(windowsPath, windowsHome, "\\"), "$HOME/tools/plugin");
  assert.equal(expandHomePath("$HOME/tools/plugin", windowsHome, "\\"), windowsPath);
  const windowsId = `package:local:${windowsPath}`;
  assert.equal(expandHomeReference(collapseHomeReference(windowsId, windowsHome, "\\"), windowsHome, "\\"), windowsId);
  assert.equal(expandHomeReference("package:git:github.com/acme/tools", windowsHome, "\\"), "package:git:github.com/acme/tools");
  assert.equal(expandHomeReference("package:git:github.com/acme/$HOMELESS/tools", windowsHome, "\\"), "package:git:github.com/acme/$HOMELESS/tools");
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
  assert.throws(() => collectionSchema.parse({
    ...schemaBase,
    resources: [
      { id: "duplicate", type: "package", name: "one", origins: ["manual"], scope: "global", source: { kind: "npm", spec: "npm:one", name: "one" } },
      { id: "duplicate", type: "package", name: "two", origins: ["manual"], scope: "global", source: { kind: "npm", spec: "npm:two", name: "two" } },
    ],
  }), /resource IDs must be unique/);
  assert.throws(() => collectionSchema.parse({
    ...schemaBase,
    resources: [
      { id: "skill:owner", type: "skill", name: "owner", origins: ["manual"], scope: "global", source: { kind: "npm", spec: "npm:owner", name: "owner" } },
      { id: "extension:child", type: "extension", name: "child", origins: ["manual"], scope: "global", ownerPackageId: "skill:owner", source: { kind: "npm", spec: "npm:owner", name: "owner" } },
    ],
  }), /owner package must reference a package/);
});

test("converts scanned resources to canonical IDs independent of installed paths", () => {
  const resources = resourcesFromScan({
    packages: [{
      id: "package:raw", type: "package", name: "pi-tools", scope: "global", installedPath: "/first/pi-tools",
      source: { kind: "git", spec: "https://github.com/acme/pi-tools.git@v2", url: "https://github.com/acme/pi-tools.git", ref: "v2" },
    }],
    skills: [{
      id: "skill:/first/pi-tools/skills/deploy", type: "skill", name: "deploy", scope: "global", installedPath: "/first/pi-tools/skills/deploy", ownerPackageId: "package:raw",
      source: { kind: "git", spec: "https://github.com/acme/pi-tools.git@v2", url: "https://github.com/acme/pi-tools.git", ref: "v2" },
    }],
    extensions: [{
      id: "extension:/first/independent.ts", type: "extension", name: "independent", scope: "global", installedPath: "/first/independent.ts",
      source: { kind: "local-path", path: "/stable/independent.ts" },
    }],
  });

  assert.deepEqual(resources.map(({ id, ownerPackageId }) => ({ id, ownerPackageId })), [
    { id: "package:git:github.com/acme/pi-tools", ownerPackageId: undefined },
    { id: "skill:owner:package:git:github.com/acme/pi-tools:deploy", ownerPackageId: "package:git:github.com/acme/pi-tools" },
    { id: "extension:local:/stable/independent.ts:independent", ownerPackageId: undefined },
  ]);
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
    { id: "skill:owner:package:npm:tools:deploy", ownerPackageId: "package:npm:tools" },
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
