import { readdir, readFile } from "node:fs/promises";
import { join, parse } from "node:path";
import type { Resource } from "./domain.js";
import { parsePiSource } from "./sources.js";

export interface ScanResult {
  packages: Resource[];
  skills: Resource[];
  extensions: Resource[];
}

export async function scanPi(options: { agentDir?: string }): Promise<ScanResult> {
  if (!options.agentDir) throw new Error("agentDir is required");
  const { agentDir } = options;
  const settings = await readJson(join(agentDir, "settings.json"));
  const packages = (Array.isArray(settings.packages) ? settings.packages : [])
    .filter((source): source is string => typeof source === "string")
    .map((spec) => {
      const source = parsePiSource(spec);
      const name = source.kind === "npm" ? source.name : spec;
      return {
        id: `package:${spec}`,
        type: "package" as const,
        name,
        scope: "global" as const,
        source,
        installedPath: agentDir,
      };
    });

  return {
    packages,
    skills: await scanSkills(join(agentDir, "skills")),
    extensions: await scanExtensions(join(agentDir, "extensions")),
  };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function scanSkills(directory: string): Promise<Resource[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const skills = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map(async (entry): Promise<Resource | undefined> => {
        const installedPath = join(directory, entry.name);
        const frontmatter = await readFile(join(installedPath, "SKILL.md"), "utf8");
        const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
        const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
        return name && description
          ? {
              id: `skill:${installedPath}`,
              type: "skill" as const,
              name,
              scope: "global" as const,
              source: { kind: "local-path" as const, path: installedPath },
              installedPath,
            }
          : undefined;
      }),
    );
    return skills.filter((skill): skill is Resource => skill !== undefined);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function scanExtensions(directory: string): Promise<Resource[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && [".ts", ".js"].includes(parse(entry.name).ext))
      .map((entry) => {
        const installedPath = join(directory, entry.name);
        return {
          id: `extension:${installedPath}`,
          type: "extension" as const,
          name: parse(entry.name).name,
          scope: "global" as const,
          source: { kind: "local-path" as const, path: installedPath },
          installedPath,
        };
      });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
