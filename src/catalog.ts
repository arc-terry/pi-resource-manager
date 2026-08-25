import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";
import type { ScanResult } from "./scanner.js";
import { parsePiSource, sourceIdentity } from "./sources.js";

export const catalogSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(
    z.object({
      name: z.string(),
      type: z.enum(["package", "skill", "plugin"]),
      source: z.string(),
      description: z.string().optional(),
      expectedResource: z.string().optional(),
    }),
  ),
});

export type Catalog = z.infer<typeof catalogSchema>;
export type CatalogStatus = { entry: Catalog["entries"][number]; installed: boolean };

export async function loadCatalog(path: string): Promise<Catalog> {
  return catalogSchema.parse(YAML.parse(await readFile(path, "utf8")));
}

export function matchCatalog(catalog: Catalog, scan: ScanResult): CatalogStatus[] {
  return catalog.entries.map((entry) => {
    const packageResource = scan.packages.find(
      (resource) => sourceIdentity(resource.source) === sourceIdentity(parsePiSource(entry.source)),
    );

    if (entry.type === "package") return { entry, installed: packageResource !== undefined };

    const resources = entry.type === "skill" ? scan.skills : scan.extensions;
    const expectedName = entry.expectedResource ?? entry.name;
    const installed = resources.some(
      (resource) => resource.ownerPackageId === packageResource?.id && resource.name === expectedName,
    );

    return { entry, installed };
  });
}
