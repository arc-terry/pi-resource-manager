import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";
import type { Resource } from "./domain.js";
import type { ScanResult } from "./scanner.js";
import { parsePiSource, sourceIdentity } from "./sources.js";

const catalogEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["package", "skill", "plugin"]),
  source: z.string(),
  description: z.string().optional(),
  expectedResource: z.string().optional(),
});

export const catalogSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(catalogEntrySchema),
});

export type Catalog = z.infer<typeof catalogSchema>;
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export interface CatalogStatus {
  entry: CatalogEntry;
  installed: boolean;
  package?: Resource;
  resource?: Resource;
}

export async function loadCatalog(path: string): Promise<Catalog> {
  const catalog = catalogSchema.parse(YAML.parse(await readFile(path, "utf8")));
  for (const entry of catalog.entries) parsePiSource(entry.source);
  return catalog;
}

export function matchCatalog(catalog: Catalog, scan: ScanResult): CatalogStatus[] {
  return catalog.entries.map((entry) => matchEntry(entry, scan));
}

function matchEntry(entry: CatalogEntry, scan: ScanResult): CatalogStatus {
  const identity = sourceIdentity(parsePiSource(entry.source));
  const pkg = scan.packages.find((candidate) => sourceIdentity(candidate.source) === identity);
  if (!pkg) return { entry, installed: false };
  if (entry.type === "package") return { entry, installed: true, package: pkg };

  const resources = entry.type === "skill" ? scan.skills : scan.extensions;
  const resource = resources.find((candidate) => candidate.ownerPackageId === pkg.id && candidate.name === (entry.expectedResource ?? entry.name));
  return resource ? { entry, installed: true, package: pkg, resource } : { entry, installed: false, package: pkg };
}
