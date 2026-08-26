import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";
import type { Resource } from "./domain.js";
import type { ScanResult } from "./scanner.js";
import { writeFileAtomic } from "./settings.js";

const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("npm"), spec: z.string(), name: z.string(), version: z.string().optional() }),
  z.object({ kind: z.literal("git"), spec: z.string(), url: z.string(), ref: z.string().optional() }),
  z.object({ kind: z.literal("local-path"), path: z.string() }),
]);

const profileEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: z.enum(["global", "local"]),
  installedPath: z.string(),
  projectRoot: z.string().optional(),
  ownerPackageId: z.string().optional(),
  source: sourceSchema,
}).superRefine((entry, context) => {
  if (entry.scope === "local" && !entry.projectRoot) {
    context.addIssue({ code: "custom", message: "local entries require projectRoot" });
  }
});

export const profileSchema = z.object({
  schemaVersion: z.literal(1),
  profile: z.object({
    name: z.string(),
    generatedAt: z.string().datetime(),
    pi: z.object({ agentDirectory: z.string(), version: z.string().optional() }),
  }),
  packages: z.array(profileEntrySchema),
  skills: z.array(profileEntrySchema),
  extensions: z.array(profileEntrySchema),
});

export type ProfileEntry = z.infer<typeof profileEntrySchema>;
export type ProfilePackage = ProfileEntry;
export type ProfileSkill = ProfileEntry;
export type ProfileExtension = ProfileEntry;
export type Profile = z.infer<typeof profileSchema>;

export async function readProfile(path: string): Promise<Profile> {
  return profileSchema.parse(YAML.parse(await readFile(path, "utf8")));
}

export async function writeProfileAtomic(path: string, profile: Profile): Promise<void> {
  await writeFileAtomic(path, YAML.stringify(profileSchema.parse(profile)));
}

export function profileFromScan(
  scan: ScanResult,
  input: { name: string; agentDirectory: string; piVersion?: string; generatedAt?: Date },
): Profile {
  return profileSchema.parse({
    schemaVersion: 1,
    profile: {
      name: input.name,
      generatedAt: (input.generatedAt ?? new Date()).toISOString(),
      pi: {
        agentDirectory: input.agentDirectory,
        ...(input.piVersion ? { version: input.piVersion } : {}),
      },
    },
    packages: scan.packages.map(profileEntry),
    skills: scan.skills.map(profileEntry),
    extensions: scan.extensions.map(profileEntry),
  });
}

function profileEntry(resource: Resource): ProfileEntry {
  return {
    id: resource.id,
    name: resource.name,
    scope: resource.scope,
    installedPath: resource.installedPath,
    source: resource.source,
    ...(resource.projectRoot ? { projectRoot: resource.projectRoot } : {}),
    ...(resource.ownerPackageId ? { ownerPackageId: resource.ownerPackageId } : {}),
  };
}
