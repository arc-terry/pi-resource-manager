import assert from "node:assert/strict";
import test from "node:test";
import type { Collection } from "../src/collection.js";
import type { ScanResult } from "../src/scanner.js";
import {
  buildSelection,
  checkState,
  moveCursor,
  selectAll,
  selectNone,
  selectedResourceIds,
  toggleSelection,
} from "../src/selection.js";

const collection: Collection = {
  schemaVersion: 2,
  collection: { name: "selection contract", updatedAt: "2026-08-29T00:00:00.000Z" },
  resources: [
    {
      id: "pkg",
      type: "package",
      name: "tools",
      origins: ["scan"],
      scope: "global",
      source: { kind: "npm", spec: "npm:tools", name: "tools" },
    },
    {
      id: "skill:a",
      type: "skill",
      name: "a",
      origins: ["scan"],
      scope: "global",
      ownerPackageId: "pkg",
      source: { kind: "npm", spec: "npm:tools", name: "tools" },
    },
    {
      id: "extension:b",
      type: "extension",
      name: "b",
      origins: ["manual"],
      scope: "global",
      ownerPackageId: "pkg",
      source: { kind: "npm", spec: "npm:tools", name: "tools" },
    },
  ],
};

const emptyScan: ScanResult = { packages: [], skills: [], extensions: [] };

test("grouped selection preserves resource selection and navigation contract", () => {
  const initial = buildSelection(collection, emptyScan);
  assert.deepEqual([...initial.selected], ["pkg", "skill:a"]);
  assert.equal(checkState(initial, "pkg"), "partial");

  const selectedPackage = toggleSelection(initial, "pkg");
  assert.deepEqual([...selectedPackage.selected], ["pkg", "skill:a", "extension:b"]);
  const clearedPackage = toggleSelection(selectedPackage, "pkg");
  assert.deepEqual([...clearedPackage.selected], []);

  const selectedChild = toggleSelection(clearedPackage, "extension:b");
  assert.deepEqual(selectedResourceIds(selectedChild), ["pkg", "extension:b"]);

  const backwardWrapped = moveCursor(initial, -1);
  assert.equal(backwardWrapped.cursor, initial.rows.length - 1);
  assert.equal(moveCursor(backwardWrapped, 1).cursor, 0);

  const withMissingLocal = buildSelection(collection, emptyScan, { missingLocalIds: new Set(["extension:b"]) });
  assert.deepEqual([...selectAll(withMissingLocal).selected], ["pkg", "skill:a"]);
  assert.deepEqual([...selectNone(initial).selected], []);
});
