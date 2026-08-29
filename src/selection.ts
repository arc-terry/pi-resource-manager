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
    rows.push(rowFor(pkg, scan, options.missingLocalIds));
    for (const child of children.filter((resource) => resource.ownerPackageId === pkg.id)) {
      rows.push({ ...rowFor(child, scan, options.missingLocalIds), parentId: pkg.id, depth: 1 });
    }
  }
  for (const resource of independent) rows.push(rowFor(resource, scan, options.missingLocalIds));

  return {
    collection,
    rows,
    selected: new Set(collection.resources.filter((resource) => resource.origins.includes("scan")).map((resource) => resource.id)),
    cursor: 0,
  };
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

function rowFor(resource: CollectionResource, scan: ScanResult, missingLocalIds: Set<string> | undefined): SelectionRow {
  return {
    id: resource.id,
    depth: 0,
    disabled: missingLocalIds?.has(resource.id) ?? false,
    installed: resourceIsInstalled(resource, scan),
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
