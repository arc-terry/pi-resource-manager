import { access } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { Scope } from "./domain.js";
import { confirm, runPi } from "./pi-command.js";
import type { Profile, ProfileEntry } from "./profile.js";
import { locationsFor, updateSettingsArray } from "./settings.js";
import { sourceIdentity, type Source } from "./sources.js";

export interface RestoreEntry extends ProfileEntry {}
export interface RestoreProfile {
  profile?: { pi: { agentDirectory: string } };
  packages: RestoreEntry[];
  skills: RestoreEntry[];
  extensions: RestoreEntry[];
}

export type RestoreAction =
  | { kind: "pi-install"; args: string[]; scope: Scope }
  | { kind: "settings-skill" | "settings-extension"; settingsPath: string; value: string; projectRoot?: string }
  | { kind: "already-present"; id: string }
  | { kind: "missing-local-source"; id: string; path: string };

export interface RestoreSummary {
  [key: string]: unknown;
  installed: number;
  updated: number;
  skipped: number;
  failed: number;
  failures: string[];
  actions: string[];
}

export async function planRestore(
  profile: RestoreProfile | Profile,
  options: { projectRoot?: string; only?: "package" | "skill" | "plugin" } = {},
): Promise<RestoreAction[]> {
  const selected = new Set(options.only ? [options.only] : ["package", "skill", "plugin"]);
  const actions: RestoreAction[] = [];
  const packageIdentities = new Set<string>();
  if (selected.has("package")) {
    for (const entry of profile.packages) {
      const identity = sourceIdentity(entry.source);
      if (packageIdentities.has(identity)) continue;
      packageIdentities.add(identity);
      actions.push({
        kind: "pi-install",
        args: ["install", ...(entry.scope === "local" ? ["-l"] : []), sourceValue(entry.source)],
        scope: entry.scope,
      });
    }
  }

  const agentDir = profile.profile?.pi.agentDirectory ?? process.env.PI_CODING_AGENT_DIR;
  const packageIds = new Set(profile.packages.map((entry) => entry.id));
  for (const [entries, type] of [
    [profile.skills, "skill"],
    [profile.extensions, "plugin"],
  ] as const) {
    if (!selected.has(type)) continue;
    for (const entry of entries) {
      if (entry.ownerPackageId && packageIds.has(entry.ownerPackageId)) {
        actions.push({ kind: "already-present", id: entry.id });
        continue;
      }
      if (entry.source.kind !== "local-path") {
        actions.push({ kind: "already-present", id: entry.id });
        continue;
      }
      if (!(await pathExists(entry.source.path))) {
        actions.push({ kind: "missing-local-source", id: entry.id, path: entry.source.path });
        continue;
      }
      const projectRoot = entry.scope === "local" && options.projectRoot ? options.projectRoot : entry.projectRoot;
      const targetScope: Scope = entry.scope;
      const locations = locationsFor(targetScope, agentDir, projectRoot);
      if (isAutoDiscovered(entry.source.path, type, locations)) {
        actions.push({ kind: "already-present", id: entry.id });
        continue;
      }
      actions.push({
        kind: type === "skill" ? "settings-skill" : "settings-extension",
        settingsPath: locations.settingsPath,
        value: entry.source.path,
        ...(targetScope === "local" && projectRoot ? { projectRoot } : {}),
      });
    }
  }
  return actions;
}

export async function executeRestore(
  actions: RestoreAction[],
  options: {
    dryRun: boolean;
    piPath?: string;
    yes: boolean;
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
  },
): Promise<RestoreSummary> {
  const summary: RestoreSummary = { installed: 0, updated: 0, skipped: 0, failed: 0, failures: [], actions: actions.map(renderAction) };
  if (options.dryRun) return summary;
  if (!await confirm("Restore Pi profile?", options)) {
    return { ...summary, skipped: actions.length };
  }
  for (const action of actions) {
    try {
      if (action.kind === "pi-install") {
        await runPi(action.args, { piPath: options.piPath });
        summary.installed += 1;
      } else if (action.kind === "settings-skill" || action.kind === "settings-extension") {
        await updateSettingsArray(action.settingsPath, action.kind === "settings-skill" ? "skills" : "extensions", action.value);
        summary.updated += 1;
      } else if (action.kind === "already-present" || action.kind === "missing-local-source") {
        summary.skipped += 1;
      }
    } catch (error: unknown) {
      summary.failed += 1;
      summary.failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return summary;
}

function sourceValue(source: Source): string {
  return source.kind === "local-path" ? source.path : source.spec;
}

function isAutoDiscovered(path: string, type: "skill" | "plugin", locations: ReturnType<typeof locationsFor>): boolean {
  const directories = type === "skill" ? locations.skillsDirs : [locations.extensionsDir];
  return directories.some((directory) => within(path, directory));
}

function within(path: string, directory: string): boolean {
  const difference = relative(resolve(directory), resolve(path));
  return difference === "" || (!difference.startsWith("..") && !resolve(difference).startsWith(resolve("..")));
}

function renderAction(action: RestoreAction): string {
  switch (action.kind) {
    case "pi-install": return `pi ${action.args.join(" ")}`;
    case "settings-skill": return `settings skills ${action.value}`;
    case "settings-extension": return `settings extensions ${action.value}`;
    case "already-present": return `already present ${action.id}`;
    case "missing-local-source": return `missing local source ${action.path}`;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
