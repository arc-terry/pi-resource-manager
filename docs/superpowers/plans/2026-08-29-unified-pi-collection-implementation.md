# Unified Pi Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace separate catalog/profile workflows with one schema-v2 `pi-collection.yml`, three commands (`scan`, `add`, `install`), and a dependency-safe grouped install TUI.

**Architecture:** `collection.ts` owns schema-v2 persistence and normalized merges; `selection.ts` owns pure package/child selection state; `tui.ts` owns terminal interaction. Existing scanner and Pi command adapters remain infrastructure, while `commands.ts`, `restore.ts`, and `cli.ts` are refactored around the new collection model.

**Tech Stack:** Node.js 20+, TypeScript strict/NodeNext, Commander, YAML, Zod, `node:test`, `tsx`, Node readline/ANSI terminal APIs.

**Spec:** `docs/superpowers/specs/2026-08-29-unified-pi-collection-design.md`

## Global Constraints

- Expose only `scan`, `add`, and `install` commands.
- Use only `pi-collection.yml` with `schemaVersion: 2`; do not read or migrate `catalog.yml`, `pi-profile.yml`, or schema version 1.
- `scan` is read-only and prints current packages, skills, and plugins.
- `add` without a source equals `add --scan`; `add --scan` and a source argument are mutually exclusive.
- `add <source>` validates and saves a manual package but never invokes Pi.
- Resource `origins` is a unique, non-empty subset of `scan` and `manual`; duplicate resources merge origins.
- Scan merge is non-destructive and never removes an absent saved resource.
- `install` opens the TUI by default; `--yes` skips it and selects scan-origin resources; non-interactive use without `--yes` fails.
- The TUI groups package-owned skills/extensions under packages, supports package-wide and individual toggles, and displays partial parents as `[-]`.
- Keep canonical domain type `extension`; display it as `plugin` in terminal output.
- Delegate all package installation to `pi install`; never shell-interpolate a source, clone Git, or run npm directly.
- Collection and settings writes remain atomic: temporary sibling file, fsync/close, then rename.
- Local paths are references only; never copy or guess a missing path.

---

## Proposed file structure

```text
src/collection.ts              # schema v2, identity, merge, YAML read/write
src/selection.ts               # pure grouped checkbox state
src/tui.ts                     # readline key input and ANSI rendering
src/domain.ts                  # existing Source/Resource/Scope types
src/scanner.ts                 # existing Pi discovery
src/settings.ts                # existing atomic/settings helpers
src/pi-command.ts              # existing safe Pi subprocess adapter
src/restore.ts                 # refactor to collection-aware install planning/execution
src/commands.ts                # scan/add/install orchestration
src/cli.ts                     # only scan/add/install Commander surface

test/collection.test.ts        # schema, identity, merge, persistence
test/selection.test.ts         # grouped toggle state
 test/tui.test.ts               # fake-stream TUI behavior
 test/commands.test.ts          # scan/add orchestration
 test/restore.test.ts           # install plan/execution
 test/cli.test.ts               # subprocess command contracts
 test/readme.test.ts            # public documentation contract
README.md                       # three-command usage and safety
```

Legacy tracked files removed after consumers switch:

```text
catalog.yml
src/catalog.ts
src/profile.ts
test/profile.test.ts
```

## Task 1: Add schema-v2 collection persistence and normalized merge

**Files:**
- Create: `src/collection.ts`
- Create: `test/collection.test.ts`
- Modify: `src/domain.ts`

**Interfaces:**
- Produces `Origin = "scan" | "manual"`.
- Produces `CollectionResource`, `Collection`, and `collectionSchema`.
- Produces `emptyCollection(name, now)`, `readCollection(path)`, and `writeCollectionAtomic(path, collection)`.
- Produces `collectionResourceIdentity(resource)`, `resourcesFromScan(scan)`, `manualPackage(source)`, and `mergeCollection(base, incoming, updatedAt)`.

- [ ] **Step 1: Write failing schema and merge tests**

```ts
// test/collection.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { makeTempDir } from "./helpers.js";
import {
  emptyCollection,
  mergeCollection,
  readCollection,
  resourcesFromScan,
  writeCollectionAtomic,
} from "../src/collection.js";

test("round-trips a schema-v2 collection", async () => {
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

test("merges scan and manual origins without duplicate packages", () => {
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
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm test -- --test-name-pattern "schema-v2|legacy schema|merges scan"`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/collection.js`.

- [ ] **Step 3: Implement the schema and persistence model**

```ts
// src/collection.ts
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";
import type { Resource, ResourceType, Scope, Source } from "./domain.js";
import type { ScanResult } from "./scanner.js";
import { writeFileAtomic } from "./settings.js";
import { sourceIdentity } from "./sources.js";

export type Origin = "scan" | "manual";
export interface CollectionResource {
  id: string;
  type: ResourceType;
  name: string;
  origins: Origin[];
  scope: Scope;
  source: Source;
  installedPath?: string;
  projectRoot?: string;
  ownerPackageId?: string;
}
export interface Collection {
  schemaVersion: 2;
  collection: { name: string; updatedAt: string };
  resources: CollectionResource[];
}

const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("npm"), spec: z.string(), name: z.string(), version: z.string().optional() }),
  z.object({ kind: z.literal("git"), spec: z.string(), url: z.string(), ref: z.string().optional() }),
  z.object({ kind: z.literal("local-path"), path: z.string() }),
]);
const resourceSchema = z.object({
  id: z.string(), type: z.enum(["package", "skill", "extension"]), name: z.string(),
  origins: z.array(z.enum(["scan", "manual"])).min(1),
  scope: z.enum(["global", "local"]), source: sourceSchema,
  installedPath: z.string().optional(), projectRoot: z.string().optional(),
  ownerPackageId: z.string().optional(),
});
export const collectionSchema = z.object({
  schemaVersion: z.literal(2),
  collection: z.object({ name: z.string(), updatedAt: z.string().datetime() }),
  resources: z.array(resourceSchema),
}).superRefine((value, ctx) => {
  const ids = new Set(value.resources.map((resource) => resource.id));
  value.resources.forEach((resource, index) => {
    if (new Set(resource.origins).size !== resource.origins.length) {
      ctx.addIssue({ code: "custom", path: ["resources", index, "origins"], message: "origins must be unique" });
    }
    if (resource.ownerPackageId && !ids.has(resource.ownerPackageId)) {
      ctx.addIssue({ code: "custom", path: ["resources", index, "ownerPackageId"], message: "owner package does not exist" });
    }
    if (resource.scope === "local" && resource.origins.includes("scan") && !resource.projectRoot) {
      ctx.addIssue({ code: "custom", path: ["resources", index, "projectRoot"], message: "local scanned resources require projectRoot" });
    }
  });
});

export function emptyCollection(name: string, now = new Date()): Collection {
  return { schemaVersion: 2, collection: { name, updatedAt: now.toISOString() }, resources: [] };
}
export async function readCollection(path: string): Promise<Collection> {
  return collectionSchema.parse(YAML.parse(await readFile(path, "utf8")));
}
export async function writeCollectionAtomic(path: string, value: Collection): Promise<void> {
  await writeFileAtomic(path, YAML.stringify(collectionSchema.parse(value)));
}
```

- [ ] **Step 4: Implement identity, scan conversion, and merge**

```ts
export function collectionResourceIdentity(resource: Pick<CollectionResource, "type" | "name" | "source" | "ownerPackageId">): string {
  if (resource.type === "package") return `package:${sourceIdentity(resource.source)}`;
  if (resource.ownerPackageId) return `${resource.type}:owner:${resource.ownerPackageId}:${resource.name}`;
  return `${resource.type}:${sourceIdentity(resource.source)}:${resource.name}`;
}

export function resourcesFromScan(scan: ScanResult): CollectionResource[] {
  const convert = (resource: Resource): CollectionResource => ({ ...resource, origins: ["scan"] });
  return [...scan.packages, ...scan.skills, ...scan.extensions].map(convert);
}

export function manualPackage(source: Source): CollectionResource {
  const name = source.kind === "npm" ? source.name
    : source.kind === "git" ? source.url.replace(/\/?(?:\.git)?$/, "").split(/[/:]/).at(-1)!
    : source.path.replace(/[\\/]$/, "").split(/[\\/]/).at(-1)!;
  return {
    id: `package:${sourceIdentity(source)}`,
    type: "package",
    name,
    origins: ["manual"],
    scope: "global",
    source,
  };
}

export function mergeCollection(base: Collection, incoming: CollectionResource[], updatedAt = new Date().toISOString()): Collection {
  const resources = [...base.resources];
  const indexes = new Map(resources.map((resource, index) => [collectionResourceIdentity(resource), index]));
  for (const candidate of incoming) {
    const key = collectionResourceIdentity(candidate);
    const index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, resources.length);
      resources.push(candidate);
      continue;
    }
    const existing = resources[index]!;
    const origins = (["scan", "manual"] as Origin[]).filter((origin) => existing.origins.includes(origin) || candidate.origins.includes(origin));
    resources[index] = { ...existing, ...candidate, origins };
  }
  return collectionSchema.parse({ ...base, collection: { ...base.collection, updatedAt }, resources });
}
```

- [ ] **Step 5: Add validation tests for owner references, duplicate origins, and local scan roots**

Run: `npm test -- test/collection.test.ts`

Expected: all collection tests PASS.

- [ ] **Step 6: Run checks and commit**

Run: `npm run check && npm test`

```bash
git add src/collection.ts src/domain.ts test/collection.test.ts
git commit -m "feat: add unified collection schema"
```

## Task 2: Build the pure grouped selection state

**Files:**
- Create: `src/selection.ts`
- Create: `test/selection.test.ts`

**Interfaces:**
- Consumes `Collection`, `CollectionResource`, and current `ScanResult`.
- Produces `SelectionRow`, `SelectionState`, `buildSelection`, `toggleSelection`, `selectAll`, `selectNone`, `checkState`, and `selectedResourceIds`.

- [ ] **Step 1: Write failing package and child toggle tests**

```ts
// test/selection.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildSelection, checkState, selectedResourceIds, toggleSelection } from "../src/selection.js";

const collection = {
  schemaVersion: 2 as const,
  collection: { name: "x", updatedAt: "2026-08-29T00:00:00.000Z" },
  resources: [
    { id: "pkg", type: "package" as const, name: "tools", origins: ["scan" as const], scope: "global" as const, source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } },
    { id: "skill:a", type: "skill" as const, name: "a", origins: ["scan" as const], scope: "global" as const, ownerPackageId: "pkg", source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } },
    { id: "extension:b", type: "extension" as const, name: "b", origins: ["manual" as const], scope: "global" as const, ownerPackageId: "pkg", source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } },
  ],
};

test("defaults scan resources on and manual-only resources off", () => {
  const state = buildSelection(collection, { packages: [], skills: [], extensions: [] });
  assert.deepEqual([...state.selected], ["pkg", "skill:a"]);
  assert.equal(checkState(state, "pkg"), "partial");
});

test("toggling a package toggles every child", () => {
  let state = buildSelection(collection, { packages: [], skills: [], extensions: [] });
  state = toggleSelection(state, "pkg");
  assert.deepEqual([...state.selected], ["pkg", "skill:a", "extension:b"]);
  state = toggleSelection(state, "pkg");
  assert.deepEqual([...state.selected], []);
});

test("selecting one child includes its owner in the install IDs", () => {
  let state = buildSelection(collection, { packages: [], skills: [], extensions: [] });
  state = { ...state, selected: new Set() };
  state = toggleSelection(state, "extension:b");
  assert.deepEqual(selectedResourceIds(state), ["pkg", "extension:b"]);
});
```

- [ ] **Step 2: Run the tests to verify RED**

Run: `npm test -- test/selection.test.ts`

Expected: FAIL because `src/selection.ts` does not exist.

- [ ] **Step 3: Implement grouped rows and toggle transitions**

```ts
// src/selection.ts
import type { Collection, CollectionResource } from "./collection.js";
import type { ScanResult } from "./scanner.js";
import { sourceIdentity } from "./sources.js";

export type CheckState = "checked" | "unchecked" | "partial";
export interface SelectionRow {
  id: string;
  parentId?: string;
  depth: 0 | 1;
  disabled: boolean;
  installed: boolean;
}
export interface SelectionState {
  collection: Collection;
  rows: SelectionRow[];
  selected: Set<string>;
  cursor: number;
}

export function buildSelection(
  collection: Collection,
  scan: ScanResult,
  options: { missingLocalIds?: Set<string> } = {},
): SelectionState {
  const packages = collection.resources.filter((resource) => resource.type === "package");
  const children = collection.resources.filter((resource) => resource.type !== "package" && resource.ownerPackageId);
  const independent = collection.resources.filter((resource) => resource.type !== "package" && !resource.ownerPackageId);
  const rows: SelectionRow[] = [];
  for (const pkg of packages) {
    rows.push({ id: pkg.id, depth: 0, disabled: options.missingLocalIds?.has(pkg.id) ?? false, installed: resourceIsInstalled(pkg, scan) });
    for (const child of children.filter((resource) => resource.ownerPackageId === pkg.id)) {
      rows.push({ id: child.id, parentId: pkg.id, depth: 1, disabled: options.missingLocalIds?.has(child.id) ?? false, installed: resourceIsInstalled(child, scan) });
    }
  }
  for (const resource of independent) rows.push({
    id: resource.id, depth: 0,
    disabled: options.missingLocalIds?.has(resource.id) ?? false,
    installed: resourceIsInstalled(resource, scan),
  });
  return {
    collection,
    rows,
    selected: new Set(collection.resources.filter((resource) => resource.origins.includes("scan")).map((resource) => resource.id)),
    cursor: 0,
  };
}

function resourceIsInstalled(resource: CollectionResource, scan: ScanResult): boolean {
  const candidates = resource.type === "package" ? scan.packages : resource.type === "skill" ? scan.skills : scan.extensions;
  return candidates.some((candidate) => resource.type === "package"
    ? sourceIdentity(candidate.source) === sourceIdentity(resource.source)
    : resource.ownerPackageId
      ? candidate.ownerPackageId === resource.ownerPackageId && candidate.name === resource.name
      : sourceIdentity(candidate.source) === sourceIdentity(resource.source) && candidate.name === resource.name);
}

export function checkState(state: SelectionState, id: string): CheckState {
  const children = state.rows.filter((row) => row.parentId === id);
  const members = children.length === 0 ? [id] : [id, ...children.map((row) => row.id)];
  const selected = members.filter((member) => state.selected.has(member)).length;
  return selected === 0 ? "unchecked" : selected === members.length ? "checked" : "partial";
}

export function toggleSelection(state: SelectionState, id: string): SelectionState {
  const row = state.rows.find((candidate) => candidate.id === id);
  if (!row || row.disabled) return state;
  const selected = new Set(state.selected);
  const children = state.rows.filter((candidate) => candidate.parentId === id && !candidate.disabled);
  const targetIds = children.length > 0 ? [id, ...children.map((child) => child.id)] : [id];
  const turnOn = children.length > 0 ? checkState(state, id) !== "checked" : !selected.has(id);
  targetIds.forEach((target) => turnOn ? selected.add(target) : selected.delete(target));
  return { ...state, selected };
}

export function selectedResourceIds(state: SelectionState): string[] {
  const selected = new Set(state.selected);
  for (const row of state.rows) if (selected.has(row.id) && row.parentId) selected.add(row.parentId);
  return state.rows.map((row) => row.id).filter((id) => selected.has(id));
}

export function moveCursor(state: SelectionState, delta: -1 | 1): SelectionState {
  if (state.rows.length === 0) return state;
  return { ...state, cursor: (state.cursor + delta + state.rows.length) % state.rows.length };
}
export function selectAll(state: SelectionState): SelectionState {
  return { ...state, selected: new Set(state.rows.filter((row) => !row.disabled).map((row) => row.id)) };
}
export function selectNone(state: SelectionState): SelectionState {
  return { ...state, selected: new Set() };
}
```

- [ ] **Step 4: Add cursor, all/none, installed, and disabled-local tests**

```ts
test("cursor wraps and all excludes disabled rows", () => {
  const initial = buildSelection(collection, emptyScan, { missingLocalIds: new Set(["extension:b"]) });
  const wrapped = moveCursor(initial, -1);
  assert.equal(wrapped.cursor, wrapped.rows.length - 1);
  assert.deepEqual([...selectAll(wrapped).selected], ["pkg", "skill:a"]);
  assert.deepEqual([...selectNone(wrapped).selected], []);
});
```

Extend `buildSelection` with an optional `{ missingLocalIds?: Set<string> }` input. Set `disabled` from that set and set `installed` by matching package source identity or child owner/name against `ScanResult`; command orchestration computes missing local IDs with `fs.access` before opening the TUI.

Run: `npm test -- test/selection.test.ts`

Expected: selection tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/selection.ts test/selection.test.ts
git commit -m "feat: model grouped resource selection"
```

## Task 3: Refactor scan and add orchestration around `pi-collection.yml`

**Files:**
- Modify: `src/commands.ts`
- Replace tests in: `test/commands.test.ts`

**Interfaces:**
- Produces `scanResources(options, deps): Promise<ScanResult>`.
- Produces `addResources(options, deps): Promise<Collection>`.
- `AddResourcesOptions` has `source?: string`, `scan?: boolean`, `projectRoot?: string`, `collectionPath?: string`, and `now?: Date`.
- No scan/add path invokes `runPi`.

- [ ] **Step 1: Replace catalog command tests with failing scan/add tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { addResources, scanResources } from "../src/commands.js";
import { readCollection } from "../src/collection.js";
import { makeTempDir } from "./helpers.js";

const scan = {
  packages: [{ id: "package:npm:tools", type: "package" as const, name: "tools", scope: "global" as const, installedPath: "/agent/npm/tools", source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } }],
  skills: [], extensions: [],
};

test("scan is read-only", async () => {
  const root = await makeTempDir();
  const path = join(root, "pi-collection.yml");
  assert.deepEqual(await scanResources({}, { scan: async () => scan }), scan);
  await assert.rejects(readFile(path, "utf8"));
});

test("add with no source saves scanned resources", async () => {
  const path = join(await makeTempDir(), "pi-collection.yml");
  await addResources({ collectionPath: path, now: new Date("2026-08-29T00:00:00Z") }, { scan: async () => scan });
  const collection = await readCollection(path);
  assert.equal(collection.resources[0]?.name, "tools");
  assert.deepEqual(collection.resources[0]?.origins, ["scan"]);
});

test("add source saves a manual package without invoking Pi", async () => {
  const path = join(await makeTempDir(), "pi-collection.yml");
  await addResources({ source: "npm:manual-tools", collectionPath: path }, { scan: async () => { throw new Error("scan must not run"); } });
  const collection = await readCollection(path);
  assert.deepEqual(collection.resources.map((resource) => [resource.type, resource.name, resource.origins]), [["package", "manual-tools", ["manual"]]]);
});

test("rejects a source together with scan mode", async () => {
  await assert.rejects(addResources({ source: "npm:tools", scan: true }, {}), /mutually exclusive/);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- test/commands.test.ts`

Expected: FAIL because the new exports do not exist.

- [ ] **Step 3: Implement scan/add orchestration**

```ts
// key src/commands.ts interfaces
import { basename } from "node:path";
import {
  emptyCollection, manualPackage, mergeCollection, readCollection,
  resourcesFromScan, writeCollectionAtomic, type Collection,
} from "./collection.js";
import { scanPi, type ScanResult } from "./scanner.js";
import { parsePiSource } from "./sources.js";

export interface CommandDependencies {
  scan?: (options: { agentDir?: string; projectRoot?: string }) => Promise<ScanResult>;
}
export interface AddResourcesOptions {
  source?: string;
  scan?: boolean;
  projectRoot?: string;
  agentDir?: string;
  collectionPath?: string;
  now?: Date;
}

export async function scanResources(options: { projectRoot?: string; agentDir?: string }, deps: CommandDependencies = {}): Promise<ScanResult> {
  return (deps.scan ?? scanPi)(options);
}

export async function addResources(options: AddResourcesOptions = {}, deps: CommandDependencies = {}): Promise<Collection> {
  if (options.source && options.scan) throw new Error("source and --scan are mutually exclusive");
  const path = options.collectionPath ?? "pi-collection.yml";
  const now = options.now ?? new Date();
  const base = await readCollection(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return emptyCollection(basename(process.cwd()), now);
    throw error;
  });
  const incoming = options.source
    ? [manualPackage(parsePiSource(options.source))]
    : resourcesFromScan(await scanResources({ projectRoot: options.projectRoot, agentDir: options.agentDir }, deps));
  const merged = mergeCollection(base, incoming, now.toISOString());
  await writeCollectionAtomic(path, merged);
  return merged;
}
```

- [ ] **Step 4: Add non-destructive merge and unsupported-source tests**

```ts
test("scan merge preserves a saved resource absent from the latest scan", async () => {
  const path = join(await makeTempDir(), "pi-collection.yml");
  await addResources({ collectionPath: path }, { scan: async () => scan });
  await addResources({ collectionPath: path }, { scan: async () => ({ packages: [], skills: [], extensions: [] }) });
  assert.deepEqual((await readCollection(path)).resources.map((resource) => resource.name), ["tools"]);
});

test("unsupported manual source does not write the collection", async () => {
  const path = join(await makeTempDir(), "pi-collection.yml");
  await assert.rejects(addResources({ source: "tools", collectionPath: path }), /Pi-supported source/);
  await assert.rejects(readFile(path, "utf8"));
});
```

Run: `npm test -- test/commands.test.ts`

Expected: command tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands.ts test/commands.test.ts
git commit -m "feat: add scan and collection merge commands"
```

## Task 4: Refactor install planning and execution for selected collection resources

**Files:**
- Modify: `src/restore.ts`
- Rewrite: `test/restore.test.ts`

**Interfaces:**
- Replaces `planRestore(Profile, ...)` with `planInstall(collection, selectedIds, options)`.
- Keeps `RestoreAction`, `RestoreSummary`, and `executeRestore` names internally to minimize subprocess/settings churn.
- Planning accepts `currentScan`, `agentDir`, and selected collection IDs.

- [ ] **Step 1: Write failing selected-resource planning tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { planInstall } from "../src/restore.js";

const collection = {
  schemaVersion: 2 as const,
  collection: { name: "x", updatedAt: "2026-08-29T00:00:00.000Z" },
  resources: [
    { id: "pkg", type: "package" as const, name: "tools", origins: ["scan" as const], scope: "global" as const, source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } },
    { id: "skill", type: "skill" as const, name: "review", origins: ["scan" as const], scope: "global" as const, ownerPackageId: "pkg", source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } },
  ],
};

test("selected package child installs its owner once", async () => {
  const actions = await planInstall(collection, ["skill"], { currentScan: { packages: [], skills: [], extensions: [] } });
  assert.deepEqual(actions, [{ kind: "pi-install", id: "pkg", args: ["install", "npm:tools"], scope: "global" }]);
});

test("already installed selected package produces no mutation", async () => {
  const currentScan = {
    packages: [{ id: "pkg", type: "package" as const, name: "tools", scope: "global" as const, installedPath: "/agent/npm/tools", source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } }],
    skills: [], extensions: [],
  };
  assert.deepEqual(await planInstall(collection, ["pkg"], { currentScan }), [{ kind: "already-present", id: "pkg" }]);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- --test-name-pattern "selected package child|already installed selected"`

Expected: FAIL because `planInstall` is not exported.

- [ ] **Step 3: Adapt planning to a flat selected collection**

```ts
export async function planInstall(
  collection: Collection,
  selectedIds: Iterable<string>,
  options: { currentScan?: ScanResult; agentDir?: string } = {},
): Promise<RestoreAction[]> {
  const selected = new Set(selectedIds);
  const byId = new Map(collection.resources.map((resource) => [resource.id, resource]));
  for (const id of [...selected]) {
    const owner = byId.get(id)?.ownerPackageId;
    if (owner) selected.add(owner);
  }
  const actions: RestoreAction[] = [];
  const packageIdentities = new Set<string>();
  for (const resource of collection.resources.filter((candidate) => selected.has(candidate.id) && candidate.type === "package")) {
    const identity = sourceIdentity(resource.source);
    if (packageIdentities.has(identity)) continue;
    packageIdentities.add(identity);
    if (resource.source.kind === "local-path" && !await exists(resource.source.path)) {
      actions.push({ kind: "missing-local-source", id: resource.id, path: resource.source.path });
    } else if (isPresent(resource, "package", resource.projectRoot, options.currentScan)) {
      actions.push({ kind: "already-present", id: resource.id });
    } else {
      actions.push({
        kind: "pi-install", id: resource.id, scope: resource.scope,
        args: resource.scope === "local" ? ["install", "-l", sourceArgument(resource.source)] : ["install", sourceArgument(resource.source)],
        ...(resource.projectRoot ? { projectRoot: resource.projectRoot } : {}),
      });
    }
  }
  for (const resource of collection.resources.filter((candidate) => selected.has(candidate.id) && candidate.type !== "package" && !candidate.ownerPackageId)) {
    if (resource.source.kind !== "local-path") continue;
    if (!await exists(resource.source.path)) {
      actions.push({ kind: "missing-local-source", id: resource.id, path: resource.source.path });
      continue;
    }
    if (isPresent(resource, resource.type, resource.projectRoot, options.currentScan)) {
      actions.push({ kind: "already-present", id: resource.id });
      continue;
    }
    if (isAutoDiscovered(resource, displayType(resource.type), options.agentDir ?? defaultAgentDir())) continue;
    const locations = locationsFor(resource.scope, options.agentDir ?? defaultAgentDir(), resource.projectRoot);
    actions.push({
      kind: resource.type === "skill" ? "settings-skill" : "settings-extension",
      id: resource.id,
      settingsPath: locations.settingsPath,
      value: resource.source.path,
      ...(resource.projectRoot ? { projectRoot: resource.projectRoot } : {}),
    });
  }
  return actions;
}

function sourceArgument(source: Source): string {
  return source.kind === "local-path" ? source.path : source.spec;
}
```

- [ ] **Step 4: Port execution tests to collection actions**

```ts
test("dry-run does not invoke Pi", async () => {
  const { path, log } = await createFakePi(await makeTempDir());
  const summary = await executeRestore(
    [{ kind: "pi-install", id: "pkg", args: ["install", "npm:tools"], scope: "global" }],
    { dryRun: true, piPath: path, yes: true },
  );
  assert.equal(summary.installed, 0);
  await assert.rejects(readFile(log, "utf8"));
});

test("continues after Pi failure and preserves diagnostics", async () => {
  const { path, log } = await createFakePi(await makeTempDir(), "install npm:broken");
  const summary = await executeRestore([
    { kind: "pi-install", id: "broken", args: ["install", "npm:broken"], scope: "global" },
    { kind: "pi-install", id: "tools", args: ["install", "npm:tools"], scope: "global" },
  ], { piPath: path, yes: true });
  assert.equal(summary.failed, 1);
  assert.equal(summary.installed, 1);
  assert.match(summary.failures[0]?.stderr ?? "", /fake Pi failure/);
  assert.equal(await readFile(log, "utf8"), "install npm:broken\ninstall npm:tools\n");
});
```

```ts
test("uses a local package project root as Pi cwd", async () => {
  const projectRoot = await makeTempDir();
  const { path, cwdLog } = await createFakePi(await makeTempDir(), undefined, true);
  await executeRestore(
    [{ kind: "pi-install", id: "pkg", args: ["install", "-l", "npm:tools"], scope: "local", projectRoot }],
    { piPath: path, yes: true },
  );
  assert.equal((await readFile(cwdLog, "utf8")).trim(), await realpath(projectRoot));
});

test("rescans after package installation", async () => {
  const { path } = await createFakePi(await makeTempDir());
  let rescans = 0;
  await executeRestore(
    [{ kind: "pi-install", id: "pkg", args: ["install", "npm:tools"], scope: "global" }],
    { piPath: path, yes: true, rescan: async () => { rescans++; return { packages: [], skills: [], extensions: [] }; } },
  );
  assert.equal(rescans, 1);
});

test("writes selected independent extension settings", async () => {
  const settingsPath = join(await makeTempDir(), "settings.json");
  const summary = await executeRestore(
    [{ kind: "settings-extension", id: "ext", settingsPath, value: "/source/ext.ts" }],
    { yes: true },
  );
  assert.equal(summary.installed, 1);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { extensions: ["/source/ext.ts"] });
});

test("plans a missing local source as failure", async () => {
  const value = { ...collection, resources: [{ ...collection.resources[0]!, source: { kind: "local-path" as const, path: "/does-not-exist" } }] };
  assert.deepEqual(await planInstall(value, ["pkg"]), [{ kind: "missing-local-source", id: "pkg", path: "/does-not-exist" }]);
});
```

Run: `npm test -- test/restore.test.ts`

Expected: restore/install tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/restore.ts test/restore.test.ts
git commit -m "feat: plan selected collection installs"
```

## Task 5: Implement the custom terminal selection TUI

**Files:**
- Create: `src/tui.ts`
- Create: `test/tui.test.ts`

**Interfaces:**
- Consumes `SelectionState` from Task 2.
- Produces `renderSelection(state): string`.
- Produces `runInstallTui(initial, options): Promise<string[] | undefined>` where `undefined` means cancelled.
- `TuiOptions` accepts injectable input/output streams and terminal capability checks.

- [ ] **Step 1: Write failing render and key-transition tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { renderSelection, runInstallTui } from "../src/tui.js";
import { buildSelection } from "../src/selection.js";

const emptyScan = { packages: [], skills: [], extensions: [] };
const collection = {
  schemaVersion: 2 as const,
  collection: { name: "x", updatedAt: "2026-08-29T00:00:00.000Z" },
  resources: [
    { id: "pkg", type: "package" as const, name: "tools", origins: ["scan" as const], scope: "global" as const, source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } },
    { id: "skill:a", type: "skill" as const, name: "a", origins: ["scan" as const], scope: "global" as const, ownerPackageId: "pkg", source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } },
    { id: "extension:b", type: "extension" as const, name: "b", origins: ["manual" as const], scope: "global" as const, ownerPackageId: "pkg", source: { kind: "npm" as const, spec: "npm:tools", name: "tools" } },
  ],
};
function fakeTty() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(value: boolean): void };
  input.isTTY = true;
  input.setRawMode = () => undefined;
  return { input, output: new PassThrough() };
}

test("renders grouped checked partial and unchecked rows", () => {
  const text = renderSelection(buildSelection(collection, emptyScan));
  assert.match(text, /\[-\] package tools/);
  assert.match(text, /    \[x\] skill a/);
  assert.match(text, /    \[ \] plugin b/);
});

test("space on package selects children and enter confirms", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(value: boolean): void };
  input.isTTY = true;
  input.setRawMode = () => undefined;
  const output = new PassThrough();
  const promise = runInstallTui(buildSelection(collection, emptyScan), { input, output });
  input.write(" ");
  input.write("\r");
  assert.deepEqual(await promise, ["pkg", "skill:a", "extension:b"]);
});

test("escape cancels", async () => {
  const { input, output } = fakeTty();
  const promise = runInstallTui(buildSelection(collection, emptyScan), { input, output });
  input.write("\u001b");
  assert.equal(await promise, undefined);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- test/tui.test.ts`

Expected: FAIL because `src/tui.ts` does not exist.

- [ ] **Step 3: Implement deterministic rendering**

```ts
// src/tui.ts
import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { displayType } from "./domain.js";
import { checkState, selectedResourceIds, toggleSelection, type SelectionState } from "./selection.js";

export function renderSelection(state: SelectionState): string {
  const byId = new Map(state.collection.resources.map((resource) => [resource.id, resource]));
  const lines = state.rows.map((row, index) => {
    const resource = byId.get(row.id)!;
    const check = checkState(state, row.id);
    const marker = check === "checked" ? "[x]" : check === "partial" ? "[-]" : "[ ]";
    const cursor = index === state.cursor ? ">" : " ";
    const indent = row.depth === 1 ? "    " : "";
    const origin = resource.origins.join(",");
    const status = row.disabled ? " missing local source" : row.installed ? " installed" : "";
    return `${cursor} ${indent}${marker} ${displayType(resource.type)} ${resource.name}  ${origin}${status}`;
  });
  return ["Install Pi Resources", ...lines, "", "↑/↓ Move  Space Toggle  A All  N None  Enter Install  Esc Cancel"].join("\n");
}
```

- [ ] **Step 4: Implement terminal lifecycle and keys**

```ts
interface TuiInput extends Readable {
  isTTY?: boolean;
  setRawMode?(enabled: boolean): void;
}
interface TuiOptions { input: TuiInput; output: Writable }

export async function runInstallTui(initial: SelectionState, options: TuiOptions): Promise<string[] | undefined> {
  const { input, output } = options;
  if (input.isTTY !== true || typeof input.setRawMode !== "function") {
    throw new Error("install requires an interactive terminal; use --yes for non-interactive use");
  }
  emitKeypressEvents(input);
  let state = initial;
  let cleaned = false;
  const draw = () => output.write(`\u001b[2J\u001b[H${renderSelection(state)}`);
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    input.removeListener("keypress", onKey);
    input.setRawMode!(false);
    output.write("\u001b[?25h\n");
  };
  let resolveResult!: (value: string[] | undefined) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<string[] | undefined>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const onKey = (_text: string, key: { name?: string; ctrl?: boolean }) => {
    try {
      if (key.name === "up") state = moveCursor(state, -1);
      else if (key.name === "down") state = moveCursor(state, 1);
      else if (key.name === "space") state = toggleSelection(state, state.rows[state.cursor]!.id);
      else if (key.name === "a") state = selectAll(state);
      else if (key.name === "n") state = selectNone(state);
      else if (key.name === "return") { cleanup(); resolveResult(selectedResourceIds(state)); return; }
      else if (key.name === "escape" || (key.ctrl && key.name === "c")) { cleanup(); resolveResult(undefined); return; }
      draw();
    } catch (error) {
      cleanup();
      rejectResult(error);
    }
  };
  input.setRawMode(true);
  input.resume();
  input.on("keypress", onKey);
  output.write("\u001b[?25l");
  draw();
  return result.finally(cleanup);
}
```

- [ ] **Step 5: Add individual, all/none, non-TTY, and cleanup tests**

```ts
test("down and space toggle one child and leave a partial parent", async () => {
  const { input, output } = fakeTty();
  const promise = runInstallTui(buildSelection(collection, emptyScan), { input, output });
  input.write("\u001b[B"); // first child
  input.write(" ");
  input.write("\r");
  assert.deepEqual(await promise, ["pkg"]);
});

test("non-TTY input fails with --yes guidance", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = false;
  await assert.rejects(
    runInstallTui(buildSelection(collection, emptyScan), { input, output: new PassThrough() }),
    /use --yes/,
  );
});

test("cancel restores raw mode and cursor", async () => {
  const calls: boolean[] = [];
  const { input, output } = fakeTty();
  input.setRawMode = (value) => calls.push(value);
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk.toString(); });
  const promise = runInstallTui(buildSelection(collection, emptyScan), { input, output });
  input.write("\u001b");
  assert.equal(await promise, undefined);
  assert.deepEqual(calls, [true, false]);
  assert.match(rendered, /\u001b\[\?25h/);
});
```

Run: `npm test -- test/tui.test.ts`

Expected: TUI tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui.ts test/tui.test.ts
git commit -m "feat: add grouped install TUI"
```

## Task 6: Expose only `scan`, `add`, and `install` through the CLI

**Files:**
- Modify: `src/cli.ts`
- Rewrite: `test/cli.test.ts`

**Interfaces:**
- `scan [--project <path>]` calls `scanResources` and prints `[v]` rows.
- `add [source] [--scan] [--project <path>]` calls `addResources` and reports saved counts.
- `install [--dry-run] [--yes]` reads the collection, scans, selects through TUI or scan-origin defaults, plans, executes, and summarizes.

- [ ] **Step 1: Write failing help and removed-command tests**

```ts
test("help exposes only scan add and install", async () => {
  const result = await runCli(["--help"], { cwd: await makeTempDir() });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\bscan\b/);
  assert.match(result.stdout, /\badd\b/);
  assert.match(result.stdout, /\binstall\b/);
  assert.doesNotMatch(result.stdout, /\blist\b|\bremove\b|\bprofile\b/);
});

test("removed profile command fails", async () => {
  const result = await runCli(["profile", "scan"], { cwd: await makeTempDir() });
  assert.notEqual(result.code, 0);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- --test-name-pattern "only scan add and install|removed profile"`

Expected: FAIL because old commands remain.

- [ ] **Step 3: Replace Commander definitions**

```ts
const program = new Command().name("pi-collection").description("Capture and install Pi resources");
program.command("scan")
  .option("--project <path>")
  .action(async (options) => console.log(renderScanChecklist(await scanResources({ projectRoot: options.project }, deps))));

program.command("add [source]")
  .option("--scan", "save resources discovered on this computer")
  .option("--project <path>")
  .action(async (source, options) => {
    const collection = await addResources({ source, scan: options.scan, projectRoot: options.project }, deps);
    console.log(`wrote collection: pi-collection.yml\nresources: ${collection.resources.length}`);
  });

program.command("install")
  .option("--dry-run")
  .option("--yes")
  .action(async (options) => {
    const collection = await readCollection("pi-collection.yml");
    const currentScan = await scanResources({}, deps);
    const state = buildSelection(collection, currentScan);
    const selected = options.yes
      ? selectedResourceIds(state)
      : await runInstallTui(state, { input: process.stdin, output: process.stdout });
    if (selected === undefined) return;
    const actions = await planInstall(collection, selected, { currentScan });
    printInstallActions(actions);
    const summary = await executeRestore(actions, { dryRun: options.dryRun, yes: true, piPath: deps.piPath, env: deps.env, cwd: deps.cwd });
    printRestoreSummary(summary);
    if (summary.failed > 0) process.exitCode = 1;
  });
```

- [ ] **Step 4: Add CLI integration tests**

```ts
test("scan prints current resources without writing a collection", async () => {
  const cwd = await makeTempDir();
  const agentDir = join(cwd, "agent");
  await writeAgent(agentDir, ["npm:tools"]);
  const result = await runCli(["scan"], { cwd, env: { PI_CODING_AGENT_DIR: agentDir } });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[v\] package tools/);
  await assert.rejects(readFile(join(cwd, "pi-collection.yml"), "utf8"));
});

test("add defaults to scan and add source is manual", async () => {
  const cwd = await makeTempDir();
  const agentDir = join(cwd, "agent");
  await writeAgent(agentDir, ["npm:tools"]);
  assert.equal((await runCli(["add"], { cwd, env: { PI_CODING_AGENT_DIR: agentDir } })).code, 0);
  let collection = await readCollection(join(cwd, "pi-collection.yml"));
  assert.deepEqual(collection.resources[0]?.origins, ["scan"]);
  assert.equal((await runCli(["add", "npm:manual"], { cwd })).code, 0);
  collection = await readCollection(join(cwd, "pi-collection.yml"));
  assert.deepEqual(collection.resources.find((resource) => resource.name === "manual")?.origins, ["manual"]);
});

test("source with scan flag fails", async () => {
  const result = await runCli(["add", "npm:tools", "--scan"], { cwd: await makeTempDir() });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /mutually exclusive/);
});

test("install yes dry-run prints actions without invoking Pi", async () => {
  const cwd = await makeTempDir();
  const fake = await createFakePi(cwd);
  await writeCollectionAtomic(join(cwd, "pi-collection.yml"), collectionWithScannedTools);
  const result = await runCli(["install", "--yes", "--dry-run"], { cwd, env: { PATH: `${dirname(fake.path)}:${process.env.PATH}` } });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /pi install npm:tools/);
  await assert.rejects(readFile(fake.log, "utf8"));
});

test("noninteractive install requires yes", async () => {
  const cwd = await makeTempDir();
  await writeCollectionAtomic(join(cwd, "pi-collection.yml"), collectionWithScannedTools);
  const result = await runCli(["install"], { cwd });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /use --yes/);
});
```

Retain the existing direct-executable and npm-style symlink tests unchanged.

Run: `npm test -- test/cli.test.ts`

Expected: CLI tests PASS.

- [ ] **Step 5: Run static checks and commit**

Run: `npm run check && npm test && npm run build && node dist/cli.js --help`

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat: expose unified collection commands"
```

## Task 7: Remove legacy catalog/profile code and rewrite documentation

**Files:**
- Delete: `catalog.yml`
- Delete: `src/catalog.ts`
- Delete: `src/profile.ts`
- Delete: `test/profile.test.ts`
- Modify: `README.md`
- Modify: `test/readme.test.ts`

**Interfaces:**
- Public documentation describes only `scan`, `add`, `install`, and schema version 2.
- No source or test imports legacy catalog/profile APIs.

- [ ] **Step 1: Write a failing README contract**

```ts
test("README documents the unified three-command workflow", async () => {
  const text = await readFile("README.md", "utf8");
  assert.match(text, /pi-collection scan/);
  assert.match(text, /pi-collection add --scan/);
  assert.match(text, /pi-collection add npm:/);
  assert.match(text, /pi-collection install --dry-run/);
  assert.match(text, /schemaVersion: 2/);
  assert.doesNotMatch(text, /catalog\.yml|pi-profile\.yml|profile restore/);
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm test -- --test-name-pattern "unified three-command workflow"`

Expected: FAIL because README documents legacy files and commands.

- [ ] **Step 3: Remove legacy files and imports**

Run:

```bash
rm catalog.yml src/catalog.ts src/profile.ts test/profile.test.ts
rg "catalog|profileFromScan|readProfile|planRestore|listCollection|removeCatalogEntries" src test
```

Expected: the search returns no legacy production imports; update any remaining test names or internal function names to collection/install terms.

- [ ] **Step 4: Rewrite README**

Document:

- Install/build/link instructions.
- Exactly three commands and examples.
- `scan` read-only behavior.
- `add` default scan behavior and manual source behavior.
- `install` TUI controls, default origin selection, `--dry-run`, `--yes`, and CI requirement.
- Schema-v2 example with `origins` and package-owned children.
- Non-destructive merge semantics.
- No legacy YAML support.
- Arbitrary-code warning and delegated `pi install` behavior.

- [ ] **Step 5: Run final verification**

Run:

```bash
npm run check
npm test
npm run build
node dist/cli.js --help
./dist/cli.js --help
```

Expected: all commands exit zero; help lists only `scan`, `add`, and `install`; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A README.md test/readme.test.ts catalog.yml src/catalog.ts src/profile.ts test/profile.test.ts
git commit -m "docs: document unified pi collection workflow"
```

## Plan self-review

- **Schema/file coverage:** Task 1 implements schema v2, origins, identity, merge, validation, and atomic persistence.
- **Command coverage:** Tasks 3 and 6 implement the exact `scan`, `add`, and `install` surfaces and remove old commands.
- **TUI coverage:** Tasks 2 and 5 separate pure parent/child selection from terminal I/O and cover all approved keys/states.
- **Install coverage:** Task 4 adapts dependency-safe package installation, local path/settings restoration, dry-run, re-scan, and diagnostics.
- **Compatibility scope:** Task 7 explicitly deletes legacy catalog/profile support as approved.
- **Safety coverage:** Tasks 1, 3, 4, 5, and 7 cover atomic writes, source validation, non-interactive refusal, local-path failures, and arbitrary-code documentation.
- **Type consistency:** `CollectionResource`, `Collection`, `SelectionState`, `RestoreAction`, `ScanResult`, and command signatures are introduced before consumers and use canonical `extension` internally.
