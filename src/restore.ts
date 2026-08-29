import { access } from "node:fs/promises";
import type { Scope, Source } from "./domain.js";
import { locationsFor, updateSettingsArray } from "./settings.js";
import type { Profile, ProfileEntry } from "./profile.js";
import { sourceIdentity } from "./sources.js";
import { confirm, runPi } from "./pi-command.js";

export type RestoreAction =
  | { kind: "pi-install"; args: string[]; scope: Scope; id: string }
  | { kind: "settings-skill" | "settings-extension"; settingsPath: string; value: string; projectRoot?: string; id: string }
  | { kind: "already-present"; id: string }
  | { kind: "missing-local-source"; id: string; path: string };

export interface RestoreOptions {
  projectRoot?: string;
  agentDir?: string;
  only?: "package" | "skill" | "plugin";
}

export interface ExecuteRestoreOptions extends RestoreOptions {
  dryRun?: boolean;
  yes: boolean;
  piPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export interface RestoreSummary {
  installed: number;
  alreadyPresent: number;
  skipped: number;
  failed: number;
}

export async function planRestore(profile: Profile, options: RestoreOptions = {}): Promise<RestoreAction[]> {
  const actions: RestoreAction[] = [];
  const include = (type: "package" | "skill" | "plugin") => !options.only || options.only === type;
  const packageEntries = include("package") ? profile.packages : [];
  const seenPackages = new Set<string>();
  for (const entry of packageEntries) {
    const identity = sourceIdentity(entry.source as Source);
    if (seenPackages.has(identity)) continue;
    seenPackages.add(identity);
    actions.push({
      kind: "pi-install",
      args: packageInstallArgs(entry),
      scope: entry.scope,
      id: entry.id,
    });
  }

  const pathEntries: Array<{ type: "skill" | "plugin"; entries: ProfileEntry[]; key: "settings-skill" | "settings-extension" }> = [
    { type: "skill", entries: profile.skills, key: "settings-skill" },
    { type: "plugin", entries: profile.extensions, key: "settings-extension" },
  ];
  for (const group of pathEntries) {
    if (!include(group.type)) continue;
    for (const entry of group.entries) {
      if (entry.ownerPackageId) continue;
      if (entry.source.kind !== "local-path") continue;
      if (!(await exists(entry.source.path))) {
        actions.push({ kind: "missing-local-source", id: entry.id, path: entry.source.path });
        continue;
      }
      const projectRoot = entry.scope === "local" ? (options.projectRoot ?? entry.projectRoot) : undefined;
      const locations = locationsFor(entry.scope, options.agentDir ?? profile.profile.pi.agentDirectory, projectRoot);
      actions.push({ kind: group.key, settingsPath: locations.settingsPath, value: entry.source.path, projectRoot, id: entry.id });
    }
  }
  return actions;
}

function packageInstallArgs(entry: ProfileEntry): string[] {
  const spec = entry.source.kind === "local-path" ? entry.source.path : entry.source.spec;
  return entry.scope === "local" ? ["install", "-l", spec] : ["install", spec];
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function executeRestore(actions: RestoreAction[], options: ExecuteRestoreOptions): Promise<RestoreSummary> {
  const summary: RestoreSummary = { installed: 0, alreadyPresent: 0, skipped: 0, failed: 0 };
  const mutating = actions.some((action) => action.kind === "pi-install" || action.kind.startsWith("settings-"));
  if (!options.dryRun && mutating && !(await confirm("Restore this Pi profile?", options))) {
    summary.skipped = actions.length;
    return summary;
  }
  for (const action of actions) {
    if (action.kind === "already-present") { summary.alreadyPresent++; continue; }
    if (action.kind === "missing-local-source") { summary.failed++; continue; }
    if (options.dryRun) { summary.skipped++; continue; }
    try {
      if (action.kind === "pi-install") {
        await runPi(action.args, options);
        summary.installed++;
      } else {
        await updateSettingsArray(action.settingsPath, action.kind === "settings-skill" ? "skills" : "extensions", action.value);
        summary.installed++;
      }
    } catch {
      summary.failed++;
    }
  }
  return summary;
}
