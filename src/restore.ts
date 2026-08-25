import { access } from "node:fs/promises";
import { join } from "node:path";
import type { Scope } from "./domain.js";
import type { Source } from "./sources.js";

export interface RestoreEntry {
  id: string;
  scope: Scope;
  source: Source;
  projectRoot?: string;
}

export interface RestoreProfile {
  packages: RestoreEntry[];
  skills: RestoreEntry[];
  extensions: RestoreEntry[];
}

export type RestoreAction =
  | { kind: "pi-install"; args: string[]; scope: Scope }
  | { kind: "settings-skill" | "settings-extension"; settingsPath: string; value: string; projectRoot?: string }
  | { kind: "missing-local-source"; id: string; path: string };

export async function planRestore(
  profile: RestoreProfile,
  options: { projectRoot?: string },
): Promise<RestoreAction[]> {
  const actions: RestoreAction[] = profile.packages.map((entry) => ({
    kind: "pi-install",
    args: ["install", sourceValue(entry.source)],
    scope: entry.scope,
  }));

  for (const [entries, kind] of [
    [profile.skills, "settings-skill"],
    [profile.extensions, "settings-extension"],
  ] as const) {
    for (const entry of entries) {
      if (entry.source.kind === "local-path" && !(await pathExists(entry.source.path))) {
        actions.push({ kind: "missing-local-source", id: entry.id, path: entry.source.path });
        continue;
      }

      const projectRoot = entry.scope === "local" ? options.projectRoot ?? entry.projectRoot : undefined;
      actions.push({
        kind,
        settingsPath: projectRoot ? join(projectRoot, ".pi", "settings.json") : "settings.json",
        value: sourceValue(entry.source),
        ...(projectRoot ? { projectRoot } : {}),
      });
    }
  }

  return actions;
}

function sourceValue(source: Source): string {
  return source.kind === "local-path" ? source.path : source.spec;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
