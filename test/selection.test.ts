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

test("selected resource IDs are ordered by rows without mutating selection state", () => {
  const initial = buildSelection(collection, emptyScan);
  const childOnly = { ...initial, selected: new Set(["extension:b"]) };

  assert.deepEqual(selectedResourceIds(childOnly), ["pkg", "extension:b"]);
  assert.deepEqual([...childOnly.selected], ["extension:b"]);
  assert.deepEqual(selectedResourceIds(childOnly), ["pkg", "extension:b"]);
});

test("selection transitions do not reuse mutable selected sets", () => {
  const initial = buildSelection(collection, emptyScan);
  const all = selectAll(initial);
  const none = selectNone(all);
  const toggled = toggleSelection(initial, "extension:b");

  assert.notStrictEqual(all.selected, initial.selected);
  assert.notStrictEqual(none.selected, all.selected);
  assert.notStrictEqual(toggled.selected, initial.selected);
  assert.deepEqual([...initial.selected], ["pkg", "skill:a"]);
  assert.deepEqual([...all.selected], ["pkg", "skill:a", "extension:b"]);
  assert.deepEqual([...none.selected], []);
  assert.deepEqual([...toggled.selected], ["pkg", "skill:a", "extension:b"]);
});

test("marks matching current-scan packages and owned children installed", () => {
  const state = buildSelection(collection, {
    packages: [{
      id: "installed-pkg",
      type: "package",
      name: "tools",
      scope: "global",
      installedPath: "/packages/tools",
      source: { kind: "npm", spec: "npm:tools@2", name: "tools", version: "2" },
    }],
    skills: [{
      id: "installed-skill",
      type: "skill",
      name: "a",
      scope: "global",
      installedPath: "/packages/tools/skills/a",
      ownerPackageId: "pkg",
      source: { kind: "npm", spec: "npm:tools@2", name: "tools", version: "2" },
    }],
    extensions: [{
      id: "installed-extension",
      type: "extension",
      name: "b",
      scope: "global",
      installedPath: "/packages/tools/extensions/b.ts",
      ownerPackageId: "pkg",
      source: { kind: "npm", spec: "npm:tools@2", name: "tools", version: "2" },
    }],
  });

  assert.deepEqual(state.rows.map((row) => [row.id, row.installed]), [
    ["pkg", true],
    ["skill:a", true],
    ["extension:b", true],
  ]);
});

test("marks equivalent Git transports as installed", () => {
  const state = buildSelection({
    ...collection,
    resources: [{
      ...collection.resources[0]!,
      id: "git-pkg",
      source: { kind: "git", spec: "https://github.com/acme/pi-tools.git@v2", url: "https://github.com/acme/pi-tools.git", ref: "v2" },
    }],
  }, {
    packages: [{
      id: "installed-git-pkg", type: "package", name: "tools", scope: "global", installedPath: "/packages/pi-tools",
      source: { kind: "git", spec: "git:git@github.com:acme/pi-tools@main", url: "git@github.com:acme/pi-tools", ref: "main" },
    }],
    skills: [], extensions: [],
  });

  assert.equal(state.rows[0]?.installed, true);
});

test("excludes disabled scan rows from defaults and final install IDs", () => {
  const state = buildSelection(collection, emptyScan, { missingLocalIds: new Set(["pkg"]) });
  const staleSelection = { ...state, selected: new Set(["pkg", "skill:a", "extension:b"]) };

  assert.deepEqual([...state.selected], []);
  assert.deepEqual(selectedResourceIds(staleSelection), []);
  assert.strictEqual(toggleSelection(state, "pkg"), state);
  assert.equal(state.rows.every((row) => row.disabled), true);
});

test("ignores disabled children when calculating and toggling package state", () => {
  const state = buildSelection(collection, emptyScan, { missingLocalIds: new Set(["extension:b"]) });

  assert.equal(checkState(state, "pkg"), "checked");
  const cleared = toggleSelection(state, "pkg");
  assert.deepEqual([...cleared.selected], []);
  assert.equal(checkState(cleared, "pkg"), "unchecked");
  assert.deepEqual([...toggleSelection(cleared, "pkg").selected], ["pkg", "skill:a"]);
});
