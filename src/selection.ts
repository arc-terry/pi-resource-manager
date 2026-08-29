import type { Collection, CollectionResource } from "./collection.js";
import type { Source } from "./domain.js";
import type { ScanResult } from "./scanner.js";

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
  const childrenByOwner = new Map<string, CollectionResource[]>();
  const independent: CollectionResource[] = [];
  for (const resource of collection.resources) {
    if (resource.type === "package") continue;
    if (!resource.ownerPackageId) {
      independent.push(resource);
      continue;
    }
    const children = childrenByOwner.get(resource.ownerPackageId) ?? [];
    children.push(resource);
    childrenByOwner.set(resource.ownerPackageId, children);
  }
  const rows: SelectionRow[] = [];

  for (const pkg of packages) {
    const packageRow = rowFor(pkg, scan, options.missingLocalIds);
    rows.push(packageRow);
    for (const child of childrenByOwner.get(pkg.id) ?? []) {
      rows.push({ ...rowFor(child, scan, options.missingLocalIds, packageRow.disabled), parentId: pkg.id, depth: 1 });
    }
  }
  for (const resource of independent) rows.push(rowFor(resource, scan, options.missingLocalIds));

  const disabledIds = new Set(rows.filter((row) => row.disabled).map((row) => row.id));
  return {
    collection,
    rows,
    selected: new Set(collection.resources
      .filter((resource) => resource.origins.includes("scan") && !disabledIds.has(resource.id))
      .map((resource) => resource.id)),
    cursor: 0,
  };
}

export function checkState(state: SelectionState, id: string): CheckState {
  const members = selectableRows(state, id);
  if (members.length === 0) return "unchecked";
  const selected = members.filter((member) => state.selected.has(member.id)).length;
  return selected === 0 ? "unchecked" : selected === members.length ? "checked" : "partial";
}

export function toggleSelection(state: SelectionState, id: string): SelectionState {
  const row = state.rows.find((candidate) => candidate.id === id);
  if (!row || row.disabled) return state;

  const selected = new Set(state.selected);
  const members = selectableRows(state, id);
  const turnOn = checkState(state, id) !== "checked";
  members.forEach(({ id: memberId }) => turnOn ? selected.add(memberId) : selected.delete(memberId));
  return { ...state, selected };
}

export function selectedResourceIds(state: SelectionState): string[] {
  const selected = new Set(state.selected);
  for (const row of state.rows) if (selected.has(row.id) && row.parentId) selected.add(row.parentId);
  return state.rows.filter((row) => !row.disabled && selected.has(row.id)).map((row) => row.id);
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

function rowFor(
  resource: CollectionResource,
  scan: ScanResult,
  missingLocalIds: Set<string> | undefined,
  ownerDisabled = false,
): SelectionRow {
  return {
    id: resource.id,
    depth: 0,
    disabled: ownerDisabled || missingLocalIds?.has(resource.id) === true,
    installed: resourceIsInstalled(resource, scan),
  };
}

function selectableRows(state: SelectionState, id: string): SelectionRow[] {
  const row = state.rows.find((candidate) => candidate.id === id);
  if (!row || row.disabled) return [];
  const children = state.rows.filter((candidate) => candidate.parentId === id && !candidate.disabled);
  return children.length === 0 ? [row] : [row, ...children];
}

function resourceIsInstalled(resource: CollectionResource, scan: ScanResult): boolean {
  const candidates = resource.type === "package" ? scan.packages : resource.type === "skill" ? scan.skills : scan.extensions;
  return candidates.some((candidate) => resource.type === "package"
    ? storedSourceIdentity(candidate.source) === storedSourceIdentity(resource.source)
    : resource.ownerPackageId
      ? candidate.ownerPackageId === resource.ownerPackageId && candidate.name === resource.name
      : storedSourceIdentity(candidate.source) === storedSourceIdentity(resource.source) && candidate.name === resource.name);
}

function storedSourceIdentity(source: Source): string {
  switch (source.kind) {
    case "npm": return `npm:${source.name}`;
    case "git": return `git:${source.url}`;
    case "local-path": return `local:${source.path}`;
  }
}
