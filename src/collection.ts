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

export function collectionResourceIdentity(
  resource: Pick<CollectionResource, "type" | "name" | "source" | "ownerPackageId">,
): string {
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

export function mergeCollection(
  base: Collection,
  incoming: CollectionResource[],
  updatedAt = new Date().toISOString(),
): Collection {
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
    const origins = (["scan", "manual"] as Origin[])
      .filter((origin) => existing.origins.includes(origin) || candidate.origins.includes(origin));
    resources[index] = { ...existing, ...candidate, origins };
  }
  return collectionSchema.parse({ ...base, collection: { ...base.collection, updatedAt }, resources });
}
