import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import YAML from "yaml";
import { z } from "zod";

const profileSchema = z.object({
  schemaVersion: z.literal(1),
  profile: z.object({
    name: z.string(),
    generatedAt: z.string(),
    pi: z.object({ agentDirectory: z.string() }),
  }),
  packages: z.array(z.unknown()),
  skills: z.array(z.unknown()),
  extensions: z.array(z.unknown()),
});

type Profile = z.infer<typeof profileSchema>;

export async function readProfile(path: string): Promise<Profile> {
  return profileSchema.parse(YAML.parse(await readFile(path, "utf8")));
}

export async function writeProfileAtomic(path: string, profile: Profile): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);

  try {
    await writeFile(temporaryPath, YAML.stringify(profileSchema.parse(profile)), "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
