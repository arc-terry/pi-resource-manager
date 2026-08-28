import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Scope } from "./domain.js";

export interface PiLocations {
  agentDir: string;
  settingsPath: string;
  packageDirs: string[];
  skillsDirs: string[];
  extensionsDir: string;
}

export function defaultAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function locationsFor(scope: Scope, agentDir: string, projectRoot?: string): PiLocations {
  if (scope === "global") {
    return {
      agentDir,
      settingsPath: join(agentDir, "settings.json"),
      packageDirs: [join(agentDir, "npm"), join(agentDir, "git")],
      skillsDirs: [join(agentDir, "skills"), join(homedir(), ".agents", "skills")],
      extensionsDir: join(agentDir, "extensions"),
    };
  }

  if (!projectRoot) throw new Error("projectRoot is required for local Pi locations");
  const piDir = join(projectRoot, ".pi");
  return {
    agentDir,
    settingsPath: join(piDir, "settings.json"),
    packageDirs: [join(piDir, "npm"), join(piDir, "git")],
    skillsDirs: [join(piDir, "skills"), join(projectRoot, ".agents", "skills")],
    extensionsDir: join(piDir, "extensions"),
  };
}

export async function readSettings(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporaryPath, contents);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, 2));
}

export async function updateSettingsArray(
  path: string,
  key: "skills" | "extensions",
  value: string,
): Promise<void> {
  const settings = await readSettings(path);
  const existing = Array.isArray(settings[key])
    ? settings[key].filter((entry): entry is string => typeof entry === "string")
    : [];
  settings[key] = existing.includes(value) ? existing : [...existing, value];
  await writeJsonAtomic(path, settings);
}
