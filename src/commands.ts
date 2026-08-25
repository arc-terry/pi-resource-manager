import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandDependencies } from "./cli.js";
import { loadCatalog, matchCatalog, type Catalog, type CatalogStatus } from "./catalog.js";
import { profileFromScan, readProfile, writeProfileAtomic } from "./profile.js";
import { confirm, runPi } from "./pi-command.js";
import { executeRestore, planRestore, type RestoreSummary } from "./restore.js";
import { scanPi } from "./scanner.js";
import { defaultAgentDirectory } from "./settings.js";
import { parsePiSource, sourceIdentity } from "./sources.js";

type CliType = "package" | "skill" | "plugin";
type Summary = { installed?: number; removed?: number; added?: number; skipped?: number; failed?: number; failures?: string[]; actions?: string[]; validation?: string; written?: string };

export interface CommandRuntime {
  catalogPath?: string;
  agentDir?: string;
  piPath?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export function createCommandDependencies(runtime: CommandRuntime = {}): CommandDependencies {
  return {
    listCollection: (options) => listCollection(options, runtime),
    installCatalogEntries: (names, options) => installCatalogEntries(names, options, runtime),
    removeCatalogEntries: (names, options) => removeCatalogEntries(names, options, runtime),
    addSource: (source, options) => addSource(source, options, runtime),
    scanProfile: (options) => scanProfile(options, runtime),
    showProfile: (path) => readProfile(path),
    restoreProfile: (path, options) => restoreProfile(path, options, runtime),
  };
}

export async function listCollection(
  options: { full: boolean; type?: string },
  runtime: CommandRuntime = {},
): Promise<CatalogStatus[]> {
  const catalog = await loadCatalog(runtime.catalogPath ?? defaultCatalogPath());
  const scan = await scanPi({ agentDir: runtime.agentDir });
  return matchCatalog(catalog, scan).filter((status) => !options.type || status.entry.type === options.type);
}

export async function installCatalogEntries(
  names: string[],
  options: { full: boolean; type?: string; yes: boolean },
  runtime: CommandRuntime = {},
): Promise<Summary> {
  const entries = selectEntries(await loadCatalog(runtime.catalogPath ?? defaultCatalogPath()), names, options);
  const sources = uniqueSources(entries.map((entry) => entry.source));
  if (!await confirm(`Install ${sources.length} Pi source(s)?`, { yes: options.yes, input: runtime.input, output: runtime.output })) {
    return { installed: 0, skipped: sources.length };
  }
  return runSourceActions(sources, "install", runtime, "installed");
}

export async function removeCatalogEntries(
  names: string[],
  options: { type?: string; yes: boolean },
  runtime: CommandRuntime = {},
): Promise<Summary> {
  const entries = selectEntries(await loadCatalog(runtime.catalogPath ?? defaultCatalogPath()), names, { full: false, type: options.type });
  const sources = uniqueSources(entries.map((entry) => entry.source));
  if (!await confirm(`Remove ${sources.length} Pi source(s)?`, { yes: options.yes, input: runtime.input, output: runtime.output })) {
    return { removed: 0, skipped: sources.length };
  }
  return runSourceActions(sources, "remove", runtime, "removed");
}

export async function addSource(
  source: string,
  options: { local: boolean; type?: string; dryRun: boolean; yes: boolean },
  runtime: CommandRuntime = {},
): Promise<Summary> {
  const parsed = parsePiSource(source);
  const args = ["install", ...(options.local ? ["-l"] : []), source];
  if (options.dryRun) return { added: 0, validation: "pending-rescan", actions: [`pi ${args.join(" ")}`] };
  if (!await confirm("Install Pi source?", { yes: options.yes, input: runtime.input, output: runtime.output })) {
    return { added: 0, skipped: 1 };
  }
  await runPi(args, { piPath: runtime.piPath });
  const scan = await scanPi({ agentDir: runtime.agentDir, ...(options.local ? { projectRoot: process.cwd() } : {}) });
  const expected = options.type === "plugin" ? "extension" : options.type;
  const packageResource = scan.packages.find((resource) => sourceIdentity(resource.source) === sourceIdentity(parsed));
  const matches = expected === "package"
    ? packageResource !== undefined
    : expected === "skill"
      ? scan.skills.some((resource) => resource.ownerPackageId === packageResource?.id)
      : expected === "extension"
        ? scan.extensions.some((resource) => resource.ownerPackageId === packageResource?.id)
        : true;
  return matches
    ? { added: 1, validation: "verified" }
    : { added: 1, failed: 1, failures: [`Installed source did not provide requested ${options.type}`], validation: "failed" };
}

export async function scanProfile(
  options: { output: string; project?: string },
  runtime: CommandRuntime = {},
): Promise<Summary> {
  const agentDirectory = runtime.agentDir ?? defaultAgentDirectory();
  const scan = await scanPi({ agentDir: agentDirectory, projectRoot: options.project });
  await writeProfileAtomic(options.output, profileFromScan(scan, {
    name: basename(options.output, extname(options.output)) || "pi-profile",
    agentDirectory,
  }));
  return { written: options.output };
}

export async function restoreProfile(
  path: string,
  options: { dryRun: boolean; only?: string; project?: string; yes: boolean },
  runtime: CommandRuntime = {},
): Promise<RestoreSummary> {
  const actions = await planRestore(await readProfile(path), {
    projectRoot: options.project,
    ...(options.only ? { only: options.only as CliType } : {}),
  });
  return executeRestore(actions, {
    dryRun: options.dryRun,
    yes: options.yes,
    piPath: runtime.piPath,
    input: runtime.input,
    output: runtime.output,
  });
}

function selectEntries(catalog: Catalog, names: string[], options: { full: boolean; type?: string }): Catalog["entries"] {
  if (!options.full && names.length === 0) throw new Error("Select at least one catalog entry or use --full");
  const selected = catalog.entries.filter((entry) =>
    (options.full || names.includes(entry.name)) && (!options.type || entry.type === options.type),
  );
  if (!options.full) {
    const found = new Set(selected.map((entry) => entry.name));
    const missing = names.filter((name) => !found.has(name));
    if (missing.length) throw new Error(`Unknown catalog entry: ${missing.join(", ")}`);
  }
  return selected;
}

function uniqueSources(sources: string[]): string[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const identity = sourceIdentity(parsePiSource(source));
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

async function runSourceActions(
  sources: string[],
  operation: "install" | "remove",
  runtime: CommandRuntime,
  resultKey: "installed" | "removed",
): Promise<Summary> {
  const summary: Summary = { [resultKey]: 0, failed: 0, failures: [] };
  for (const source of sources) {
    try {
      await runPi([operation, source], { piPath: runtime.piPath });
      summary[resultKey] = (summary[resultKey] ?? 0) + 1;
    } catch (error: unknown) {
      summary.failed = (summary.failed ?? 0) + 1;
      summary.failures?.push(error instanceof Error ? error.message : String(error));
    }
  }
  return summary;
}

function defaultCatalogPath(): string {
  return resolve(fileURLToPath(new URL("../catalog.yml", import.meta.url)));
}
