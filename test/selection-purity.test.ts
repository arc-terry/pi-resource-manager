import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import type { Collection } from "../src/collection.js";
import type { ScanResult } from "../src/scanner.js";

const localCollection: Collection = {
  schemaVersion: 2,
  collection: { name: "local selection", updatedAt: "2026-08-29T00:00:00.000Z" },
  resources: [{
    id: "local-package",
    type: "package",
    name: "local-tools",
    origins: ["manual"],
    scope: "global",
    source: { kind: "local-path", path: "/already-normalized/local-tools" },
  }],
};

const localScan: ScanResult = {
  packages: [{
    id: "current-local-package",
    type: "package",
    name: "local-tools",
    scope: "global",
    installedPath: "/installed/local-tools",
    source: { kind: "local-path", path: "/already-normalized/local-tools" },
  }],
  skills: [],
  extensions: [],
};

test("matches local sources without accessing the filesystem", async () => {
  const { buildSelection } = await import("../src/selection.js");
  const originalExistsSync = fs.existsSync;
  const originalRealpathSync = fs.realpathSync;
  let filesystemAccesses = 0;
  fs.existsSync = () => {
    filesystemAccesses++;
    throw new Error("selection must not access the filesystem");
  };
  fs.realpathSync = () => {
    filesystemAccesses++;
    throw new Error("selection must not access the filesystem");
  };
  syncBuiltinESMExports();

  try {
    assert.equal(buildSelection(localCollection, localScan).rows[0]?.installed, true);
    assert.equal(filesystemAccesses, 0);
  } finally {
    fs.existsSync = originalExistsSync;
    fs.realpathSync = originalRealpathSync;
    syncBuiltinESMExports();
  }
});
