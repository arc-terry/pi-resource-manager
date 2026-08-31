import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, sep, win32 } from "node:path";
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
  id: z.string(),
  type: z.enum(["package", "skill", "extension"]),
  name: z.string(),
  origins: z.array(z.enum(["scan", "manual"])).min(1),
  scope: z.enum(["global", "local"]),
  source: sourceSchema,
  installedPath: z.string().optional(),
  projectRoot: z.string().optional(),
  ownerPackageId: z.string().optional(),
});

export const collectionSchema = z.object({
  schemaVersion: z.literal(2),
  collection: z.object({ name: z.string(), updatedAt: z.string().datetime() }),
  resources: z.array(resourceSchema),
}).superRefine((value, ctx) => {
  const resourcesById = new Map<string, CollectionResource>();
  value.resources.forEach((resource, index) => {
    if (resourcesById.has(resource.id)) {
      ctx.addIssue({ code: "custom", path: ["resources", index, "id"], message: "resource IDs must be unique" });
    }
    resourcesById.set(resource.id, resource);
  });
  value.resources.forEach((resource, index) => {
    if (new Set(resource.origins).size !== resource.origins.length) {
      ctx.addIssue({ code: "custom", path: ["resources", index, "origins"], message: "origins must be unique" });
    }
    if (resource.ownerPackageId) {
      const owner = resourcesById.get(resource.ownerPackageId);
      if (!owner) ctx.addIssue({ code: "custom", path: ["resources", index, "ownerPackageId"], message: "owner package does not exist" });
      else if (owner.type !== "package") ctx.addIssue({ code: "custom", path: ["resources", index, "ownerPackageId"], message: "owner package must reference a package" });
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
  const stored = collectionSchema.parse(YAML.parse(await readFile(path, "utf8")));
  return collectionSchema.parse(mapCollectionPaths(stored, expandHomePath, expandHomeReference));
}

export async function writeCollectionAtomic(path: string, value: Collection): Promise<void> {
  const runtime = collectionSchema.parse(value);
  const portable = collectionSchema.parse(mapCollectionPaths(runtime, collapseHomePath, collapseHomeReference));
  await writeFileAtomic(path, YAML.stringify(portable));
}

function mapCollectionPaths(
  collection: Collection,
  mapPath: (value: string) => string,
  mapReference: (value: string) => string,
): Collection {
  return {
    ...collection,
    resources: collection.resources.map((resource) => ({
      ...resource,
      id: mapReference(resource.id),
      ...(resource.ownerPackageId ? { ownerPackageId: mapReference(resource.ownerPackageId) } : {}),
      ...(resource.installedPath ? { installedPath: mapPath(resource.installedPath) } : {}),
      ...(resource.projectRoot ? { projectRoot: mapPath(resource.projectRoot) } : {}),
      source: resource.source.kind === "local-path"
        ? { ...resource.source, path: mapPath(resource.source.path) }
        : resource.source,
    })),
  };
}

export function collapseHomePath(value: string, home = homedir(), separator = sep): string {
  const paths = separator === "\\" ? win32 : posix;
  const pathFromHome = paths.relative(home, value);
  if (pathFromHome === "") return "$HOME";
  if (pathFromHome === ".." || pathFromHome.startsWith(`..${separator}`) || paths.isAbsolute(pathFromHome)) return value;
  return `$HOME/${pathFromHome.split(separator).join("/")}`;
}

export function expandHomePath(value: string, home = homedir(), separator = sep): string {
  if (value === "$HOME") return home;
  if (!value.startsWith("$HOME/") && !value.startsWith("$HOME\\")) return value;
  const suffix = value.slice(6);
  if (suffix === "" || suffix.startsWith("/") || suffix.startsWith("\\")) {
    throw new Error(`Invalid portable home path: ${value}`);
  }
  const paths = separator === "\\" ? win32 : posix;
  const expanded = paths.resolve(home, ...suffix.split(/[\\/]/));
  const pathFromHome = paths.relative(home, expanded);
  if (pathFromHome === ".." || pathFromHome.startsWith(`..${separator}`) || paths.isAbsolute(pathFromHome)) {
    throw new Error(`Portable home path escapes $HOME: ${value}`);
  }
  return expanded;
}

export function collapseHomeReference(value: string, home = homedir(), separator = sep): string {
  const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let replaced = false;
  const portable = value.replace(new RegExp(`(^|:)${escapedHome}(?=$|[\\\\/])`, "g"), (_match, prefix: string) => {
    replaced = true;
    return `${prefix}$HOME`;
  });
  return replaced ? portable.split(separator).join("/") : value;
}

export function expandHomeReference(value: string, home = homedir(), separator = sep): string {
  if (!/\$HOME(?=$|[\\/])/.test(value)) return value;
  for (const match of value.matchAll(/\$HOME[\\/]([^:]*)/g)) expandHomePath(`$HOME/${match[1]}`, home, separator);
  const expanded = value.replace(/\$HOME(?=$|[\\/])/g, home);
  return separator === "\\" ? expanded.replaceAll("/", "\\") : expanded.replaceAll("\\", "/");
}

export function collectionResourceIdentity(
  resource: Pick<CollectionResource, "type" | "name" | "source" | "ownerPackageId">,
): string {
  if (resource.type === "package") return `package:${sourceIdentity(resource.source)}`;
  if (resource.ownerPackageId) return `${resource.type}:owner:${resource.ownerPackageId}:${resource.name}`;
  return `${resource.type}:${sourceIdentity(resource.source)}:${resource.name}`;
}

export function resourcesFromScan(scan: ScanResult): CollectionResource[] {
  const scanned = [...scan.packages, ...scan.skills, ...scan.extensions];
  const packageIds = new Map(scanned.filter((resource) => resource.type === "package")
    .map((resource) => [resource.id, collectionResourceIdentity(resource)]));
  return scanned.map((resource) => {
    const candidate: CollectionResource = {
      ...resource,
      origins: ["scan"],
      ...(resource.ownerPackageId ? { ownerPackageId: packageIds.get(resource.ownerPackageId) ?? resource.ownerPackageId } : {}),
    };
    return { ...candidate, id: collectionResourceIdentity(candidate) };
  });
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

export function mergeCollection(
  base: Collection,
  incoming: CollectionResource[],
  updatedAt = new Date().toISOString(),
): Collection {
  const candidates = [...base.resources, ...incoming];
  const packageIds = new Map<string, string>();
  for (const resource of candidates) {
    if (resource.type === "package") packageIds.set(resource.id, collectionResourceIdentity(resource));
  }

  const resources: CollectionResource[] = [];
  const indexes = new Map<string, number>();
  for (const resource of candidates) {
    const candidate: CollectionResource = {
      ...resource,
      ...(resource.ownerPackageId ? { ownerPackageId: packageIds.get(resource.ownerPackageId) ?? resource.ownerPackageId } : {}),
    };
    candidate.id = collectionResourceIdentity(candidate);
    const key = collectionResourceIdentity(candidate);
    const index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, resources.length);
      resources.push(candidate);
      continue;
    }
    const existing = resources[index]!;
    const origins = (["scan", "manual"] as Origin[])
      .filter((origin) => existing.origins.includes(origin) || candidate.origins.includes(origin));
    const preferred = candidate.origins.includes("scan") || !existing.origins.includes("scan") ? candidate : existing;
    resources[index] = { ...preferred, origins };
  }
  return collectionSchema.parse({ ...base, collection: { ...base.collection, updatedAt }, resources });
}
