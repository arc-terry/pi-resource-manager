import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
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

export function defaultAgentDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function locationsFor(scope: Scope, agentDir = defaultAgentDirectory(), projectRoot?: string): PiLocations {
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
  return {
    agentDir,
    settingsPath: join(projectRoot, ".pi", "settings.json"),
    packageDirs: [join(projectRoot, ".pi", "npm"), join(projectRoot, ".pi", "git")],
    skillsDirs: [join(projectRoot, ".pi", "skills"), join(projectRoot, ".agents", "skills")],
    extensionsDir: join(projectRoot, ".pi", "extensions"),
  };
}

export async function readSettings(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error(`Pi settings must contain an object: ${path}`);
    }
    return value as Record<string, unknown>;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(dirname(path), { recursive: true });
    handle = await open(temporaryPath, "w", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function updateSettingsArray(
  path: string,
  key: "skills" | "extensions",
  value: string,
): Promise<void> {
  const settings = await readSettings(path);
  const existing = Array.isArray(settings[key])
    ? settings[key].filter((item): item is string => typeof item === "string")
    : [];
  if (!existing.includes(value)) existing.push(value);
  await writeJsonAtomic(path, { ...settings, [key]: existing });
}

