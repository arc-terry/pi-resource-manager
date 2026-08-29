import { access } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import type { Collection, CollectionResource } from "./collection.js";
import { type Scope, type Source } from "./domain.js";
import { defaultAgentDir, locationsFor, updateSettingsArray } from "./settings.js";
import type { Profile, ProfileEntry } from "./profile.js";
import type { ScanResult } from "./scanner.js";
import { sourceIdentity } from "./sources.js";
import { confirm, PiCommandError, runPi } from "./pi-command.js";

export type RestoreAction =
  | { kind: "pi-install"; args: string[]; scope: Scope; projectRoot?: string; id: string }
  | { kind: "settings-skill" | "settings-extension"; settingsPath: string; value: string; projectRoot?: string; id: string }
  | { kind: "already-present"; id: string }
  | { kind: "missing-local-source"; id: string; path: string };

export interface RestoreOptions {
  projectRoot?: string;
  agentDir?: string;
  only?: "package" | "skill" | "plugin";
  currentScan?: ScanResult;
}

export interface ExecuteRestoreOptions extends RestoreOptions {
  dryRun?: boolean;
  yes: boolean;
  piPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  rescan?: () => Promise<ScanResult>;
}

export interface RestoreFailure {
  id: string;
  message: string;
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export interface RestoreSummary {
  installed: number;
  alreadyPresent: number;
  skipped: number;
  failed: number;
  failures: RestoreFailure[];
}

export async function planInstall(
  collection: Collection,
  selectedIds: Iterable<string>,
  options: { currentScan?: ScanResult; agentDir?: string } = {},
): Promise<RestoreAction[]> {
  const selected = new Set(selectedIds);
  const byId = new Map(collection.resources.map((resource) => [resource.id, resource]));
  for (const id of [...selected]) {
    const owner = byId.get(id)?.ownerPackageId;
    if (owner) selected.add(owner);
  }

  const actions: RestoreAction[] = [];
  const packageIdentities = new Set<string>();
  for (const resource of collection.resources) {
    if (!selected.has(resource.id) || resource.type !== "package") continue;
    const identity = sourceIdentity(resource.source);
    if (packageIdentities.has(identity)) continue;
    packageIdentities.add(identity);
    if (resource.source.kind === "local-path" && !(await exists(resource.source.path))) {
      actions.push({ kind: "missing-local-source", id: resource.id, path: resource.source.path });
    } else if (
      isPresent(resource, "package", resource.projectRoot, options.currentScan)
      && collection.resources.filter((candidate) => selected.has(candidate.id) && candidate.ownerPackageId === resource.id)
        .every((candidate) => isPresent(candidate, candidate.type, candidate.projectRoot, options.currentScan))
    ) {
      actions.push({ kind: "already-present", id: resource.id });
    } else {
      actions.push(packageInstallAction(resource));
    }
  }

  for (const resource of collection.resources) {
    if (!selected.has(resource.id) || resource.type === "package" || resource.ownerPackageId || resource.source.kind !== "local-path") continue;
    if (!(await exists(resource.source.path))) {
      actions.push({ kind: "missing-local-source", id: resource.id, path: resource.source.path });
      continue;
    }
    if (isPresent(resource, resource.type, resource.projectRoot, options.currentScan)) {
      actions.push({ kind: "already-present", id: resource.id });
      continue;
    }
    const agentDir = options.agentDir ?? defaultAgentDir();
    if (isAutoDiscovered(resource, resource.type === "skill" ? "skill" : "plugin", agentDir)) continue;
    const locations = locationsFor(resource.scope, agentDir, resource.projectRoot);
    actions.push({
      kind: resource.type === "skill" ? "settings-skill" : "settings-extension",
      id: resource.id,
      settingsPath: locations.settingsPath,
      value: resource.source.path,
      ...(resource.projectRoot ? { projectRoot: resource.projectRoot } : {}),
    });
  }
  return actions;
}

export async function planRestore(profile: Profile, options: RestoreOptions = {}): Promise<RestoreAction[]> {
  const actions: RestoreAction[] = [];
  const include = (type: "package" | "skill" | "plugin") => !options.only || options.only === type;
  const requestedResources = [
    ...(include("skill") ? profile.skills : []),
    ...(include("plugin") ? profile.extensions : []),
  ];
  const requestedOwnerIds = new Set(requestedResources.flatMap((entry) => entry.ownerPackageId === undefined ? [] : [entry.ownerPackageId]));
  const packageEntries = profile.packages.filter((entry) => include("package") || requestedOwnerIds.has(entry.id));
  const seenPackages = new Set<string>();

  for (const entry of packageEntries) {
    const identity = sourceIdentity(entry.source);
    if (seenPackages.has(identity)) continue;
    seenPackages.add(identity);
    const projectRoot = targetProjectRoot(entry, options);
    if (entry.source.kind === "local-path" && !(await exists(entry.source.path))) {
      actions.push({ kind: "missing-local-source", id: entry.id, path: entry.source.path });
      continue;
    }
    const ownedResources = requestedResources.filter((resource) => resource.ownerPackageId === entry.id);
    const ownerResourcesPresent = ownedResources.every((resource) => isPresent(
      resource,
      profile.skills.includes(resource) ? "skill" : "extension",
      targetProjectRoot(resource, options),
      options.currentScan,
    ));
    if (isPresent(entry, "package", projectRoot, options.currentScan) && ownerResourcesPresent) {
      actions.push({ kind: "already-present", id: entry.id });
      continue;
    }
    actions.push(packageInstallAction(entry, projectRoot));
  }

  const pathEntries: Array<{ type: "skill" | "plugin"; entries: ProfileEntry[]; key: "settings-skill" | "settings-extension" }> = [
    { type: "skill", entries: profile.skills, key: "settings-skill" },
    { type: "plugin", entries: profile.extensions, key: "settings-extension" },
  ];
  for (const group of pathEntries) {
    if (!include(group.type)) continue;
    for (const entry of group.entries) {
      if (entry.ownerPackageId !== undefined || entry.source.kind !== "local-path") continue;
      const projectRoot = targetProjectRoot(entry, options);
      if (!(await exists(entry.source.path))) {
        actions.push({ kind: "missing-local-source", id: entry.id, path: entry.source.path });
        continue;
      }
      if (isPresent(entry, group.type === "skill" ? "skill" : "extension", projectRoot, options.currentScan)) {
        actions.push({ kind: "already-present", id: entry.id });
        continue;
      }
      if (isAutoDiscovered(entry, group.type, profile.profile.pi.agentDirectory)) continue;
      const locations = locationsFor(entry.scope, options.agentDir ?? profile.profile.pi.agentDirectory, projectRoot);
      actions.push({ kind: group.key, settingsPath: locations.settingsPath, value: entry.source.path, ...(projectRoot ? { projectRoot } : {}), id: entry.id });
    }
  }
  return actions;
}

function targetProjectRoot(entry: ProfileEntry, options: RestoreOptions): string | undefined {
  return entry.scope === "local" ? (options.projectRoot ?? entry.projectRoot) : undefined;
}

type InstallResource = Pick<CollectionResource, "name" | "scope" | "source" | "projectRoot" | "ownerPackageId"> & { installedPath?: string };

function isPresent(
  entry: InstallResource,
  type: "package" | "skill" | "extension",
  projectRoot: string | undefined,
  scan: ScanResult | undefined,
): boolean {
  if (!scan) return false;
  const resources = type === "package" ? scan.packages : type === "skill" ? scan.skills : scan.extensions;
  return resources.some((resource) => resource.scope === entry.scope
    && (entry.scope === "global" || resource.projectRoot === projectRoot)
    && sourceIdentity(resource.source) === sourceIdentity(entry.source)
    && (entry.ownerPackageId === undefined || (resource.ownerPackageId === entry.ownerPackageId && resource.name === entry.name)));
}

function isAutoDiscovered(entry: InstallResource, type: "skill" | "plugin", agentDir: string): boolean {
  const locations = locationsFor(entry.scope, agentDir, entry.projectRoot);
  const path = entry.source.kind === "local-path" ? entry.source.path : entry.installedPath ?? "";
  if (type === "skill") return locations.skillsDirs.some((directory) => isTopLevelPath(path, directory));
  return isTopLevelPath(path, locations.extensionsDir)
    || (basename(path) === "index.ts" && isTopLevelPath(resolve(path, ".."), locations.extensionsDir));
}

function isTopLevelPath(path: string, directory: string): boolean {
  const pathFromDirectory = relative(resolve(directory), resolve(path));
  return pathFromDirectory !== "" && !pathFromDirectory.startsWith("..") && !pathFromDirectory.includes("../")
    && pathFromDirectory.split(/[\\/]/).length === 1;
}

function sourceArgument(source: Source): string {
  return source.kind === "local-path" ? source.path : source.spec;
}

type PackageInstallEntry = Pick<CollectionResource, "id" | "scope" | "source" | "projectRoot">;

function packageInstallAction(entry: PackageInstallEntry, projectRoot = entry.projectRoot): Extract<RestoreAction, { kind: "pi-install" }> {
  return {
    kind: "pi-install",
    id: entry.id,
    scope: entry.scope,
    args: entry.scope === "local" ? ["install", "-l", sourceArgument(entry.source)] : ["install", sourceArgument(entry.source)],
    ...(projectRoot ? { projectRoot } : {}),
  };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function executeRestore(actions: RestoreAction[], options: ExecuteRestoreOptions): Promise<RestoreSummary> {
  const summary: RestoreSummary = { installed: 0, alreadyPresent: 0, skipped: 0, failed: 0, failures: [] };
  const mutating = actions.some((action) => action.kind === "pi-install" || action.kind.startsWith("settings-"));
  if (!options.dryRun && mutating && !(await confirm("Restore this Pi profile?", options))) {
    summary.skipped = actions.length;
    return summary;
  }

  const packageActions = actions.filter((action): action is Extract<RestoreAction, { kind: "pi-install" }> => action.kind === "pi-install");
  const remainingActions = actions.filter((action) => action.kind !== "pi-install");
  let ranPackageInstall = false;
  for (const action of packageActions) {
    if (options.dryRun) { summary.skipped++; continue; }
    try {
      await runPi(action.args, { ...options, cwd: action.projectRoot ?? options.cwd });
      ranPackageInstall = true;
      summary.installed++;
    } catch (error) {
      recordFailure(summary, action.id, error);
    }
  }
  if (ranPackageInstall && !options.dryRun && options.rescan) {
    try {
      await options.rescan();
    } catch (error) {
      recordFailure(summary, "rescan", error);
    }
  }

  for (const action of remainingActions) {
    if (action.kind === "already-present") { summary.alreadyPresent++; continue; }
    if (action.kind === "missing-local-source") {
      recordFailure(summary, action.id, new Error(`Local source does not exist: ${action.path}`));
      continue;
    }
    if (options.dryRun) { summary.skipped++; continue; }
    try {
      await updateSettingsArray(action.settingsPath, action.kind === "settings-skill" ? "skills" : "extensions", action.value);
      summary.installed++;
    } catch (error) {
      recordFailure(summary, action.id, error);
    }
  }
  return summary;
}

function recordFailure(summary: RestoreSummary, id: string, error: unknown): void {
  summary.failed++;
  if (error instanceof PiCommandError) {
    summary.failures.push({
      id,
      message: error.message,
      command: error.command,
      ...(error.result ? {
        exitCode: error.result.code,
        stdout: error.result.stdout,
        stderr: error.result.stderr,
      } : {}),
    });
    return;
  }
  summary.failures.push({ id, message: error instanceof Error ? error.message : String(error) });
}
