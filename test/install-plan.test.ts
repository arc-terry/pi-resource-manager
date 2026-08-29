import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { planInstall } from "../src/restore.js";
import { makeTempDir } from "./helpers.js";

const source = { kind: "npm" as const, spec: "npm:tools", name: "tools" };
const packageResource = {
  id: "pkg", type: "package" as const, name: "tools", origins: ["scan" as const], scope: "global" as const, source,
};

// Fails if selected children do not install owners, existing packages mutate,
// equal owner sources install twice, or independent local extensions are omitted.
test("plans selected schema-v2 install actions", async () => {
  const collection = {
    schemaVersion: 2 as const,
    collection: { name: "x", updatedAt: "2026-08-29T00:00:00.000Z" },
    resources: [
      packageResource,
      { id: "skill", type: "skill" as const, name: "review", origins: ["scan" as const], scope: "global" as const, ownerPackageId: "pkg", source },
    ],
  };
  const emptyScan = { packages: [], skills: [], extensions: [] };

  assert.deepEqual(
    await planInstall(collection, ["skill"], { currentScan: emptyScan }),
    [{ kind: "pi-install", id: "pkg", args: ["install", "npm:tools"], scope: "global" }],
  );
  assert.deepEqual(
    await planInstall(collection, ["pkg"], {
      currentScan: { packages: [{ ...packageResource, installedPath: "/agent/npm/tools" }], skills: [], extensions: [] },
    }),
    [{ kind: "already-present", id: "pkg" }],
  );

  const duplicateOwnerCollection = {
    ...collection,
    resources: [
      ...collection.resources,
      { ...packageResource, id: "pkg-copy" },
      { id: "extension", type: "extension" as const, name: "team", origins: ["scan" as const], scope: "global" as const, ownerPackageId: "pkg-copy", source },
    ],
  };
  assert.deepEqual(
    await planInstall(duplicateOwnerCollection, ["skill", "extension"], { currentScan: emptyScan }),
    [{ kind: "pi-install", id: "pkg", args: ["install", "npm:tools"], scope: "global" }],
  );

  const missingPath = "/does-not-exist";
  assert.deepEqual(
    await planInstall({ ...collection, resources: [{ ...packageResource, source: { kind: "local-path" as const, path: missingPath } }] }, ["pkg"]),
    [{ kind: "missing-local-source", id: "pkg", path: missingPath }],
  );

  const root = await makeTempDir();
  const projectRoot = join(root, "project");
  const extensionPath = join(root, "external.ts");
  await writeFile(extensionPath, "export default {};\n");
  assert.deepEqual(
    await planInstall({
      ...collection,
      resources: [{ id: "extension:local", type: "extension" as const, name: "local", origins: ["manual" as const], scope: "local" as const, projectRoot, source: { kind: "local-path" as const, path: extensionPath } }],
    }, ["extension:local"], { agentDir: join(root, "agent"), currentScan: emptyScan }),
    [{ kind: "settings-extension", id: "extension:local", settingsPath: join(projectRoot, ".pi", "settings.json"), value: extensionPath, projectRoot }],
  );
});

test("reinstalls a present owner when its selected child is absent", async () => {
  const collection = {
    schemaVersion: 2 as const,
    collection: { name: "x", updatedAt: "2026-08-29T00:00:00.000Z" },
    resources: [
      packageResource,
      { id: "skill", type: "skill" as const, name: "review", origins: ["scan" as const], scope: "global" as const, ownerPackageId: "pkg", source },
    ],
  };

  assert.deepEqual(
    await planInstall(collection, ["skill"], {
      currentScan: { packages: [{ ...packageResource, installedPath: "/agent/npm/tools" }], skills: [], extensions: [] },
    }),
    [{ kind: "pi-install", id: "pkg", args: ["install", "npm:tools"], scope: "global" }],
  );
});

test("orders package installs before independent settings actions", async () => {
  const root = await makeTempDir();
  const extensionPath = join(root, "external.ts");
  await writeFile(extensionPath, "export default {};\n");
  const agentDir = join(root, "agent");
  const collection = {
    schemaVersion: 2 as const,
    collection: { name: "x", updatedAt: "2026-08-29T00:00:00.000Z" },
    resources: [
      { id: "extension", type: "extension" as const, name: "external", origins: ["manual" as const], scope: "global" as const, source: { kind: "local-path" as const, path: extensionPath } },
      packageResource,
    ],
  };

  assert.deepEqual(
    await planInstall(collection, ["extension", "pkg"], { agentDir, currentScan: { packages: [], skills: [], extensions: [] } }),
    [
      { kind: "pi-install", id: "pkg", args: ["install", "npm:tools"], scope: "global" },
      { kind: "settings-extension", id: "extension", settingsPath: join(agentDir, "settings.json"), value: extensionPath },
    ],
  );
});

test("omits an auto-discovered independent extension", async () => {
  const root = await makeTempDir();
  const agentDir = join(root, "agent");
  const extensionPath = join(agentDir, "extensions", "team.ts");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(extensionPath, "export default {};\n");
  const collection = {
    schemaVersion: 2 as const,
    collection: { name: "x", updatedAt: "2026-08-29T00:00:00.000Z" },
    resources: [{ id: "extension", type: "extension" as const, name: "team", origins: ["manual" as const], scope: "global" as const, source: { kind: "local-path" as const, path: extensionPath } }],
  };

  assert.deepEqual(await planInstall(collection, ["extension"], { agentDir }), []);
});
