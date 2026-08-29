import type { Source } from "./domain.js";
import { catalogSource, type Catalog, type CatalogEntry, type CatalogStatus, loadCatalog, matchCatalog } from "./catalog.js";
import { confirm, runPi } from "./pi-command.js";
import { scanPi, type ScanResult } from "./scanner.js";
import { parsePiSource, sourceIdentity } from "./sources.js";

type CatalogType = CatalogEntry["type"];

interface ScanOptions {
  agentDir?: string;
  projectRoot?: string;
}

export interface CommandDependencies {
  catalog?: Catalog;
  catalogPath?: string;
  scan?: (options: ScanOptions) => Promise<ScanResult>;
  piPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

interface ScanCommandOptions extends ScanOptions {
  type?: CatalogType;
}

interface MutationOptions extends ScanOptions {
  full?: boolean;
  type?: CatalogType;
  local?: boolean;
  dryRun?: boolean;
  yes: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export interface CatalogCommandSummary {
  requested: number;
  completed: number;
  skipped: number;
}

export interface AddOptions {
  local?: boolean;
  expectedType?: CatalogType;
  dryRun?: boolean;
  yes: boolean;
  agentDir?: string;
  projectRoot?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export interface AddResult {
  source: Source;
  validation: "pending-rescan" | "passed" | "not-requested" | "skipped";
}

export async function listCollection(options: ScanCommandOptions = {}, deps: CommandDependencies = {}): Promise<CatalogStatus[]> {
  const statuses = matchCatalog(await catalogFor(deps), await scanFor(options, deps));
  return options.type ? statuses.filter((status) => status.entry.type === options.type) : statuses;
}

export async function installCatalogEntries(
  names: string[],
  options: MutationOptions,
  deps: CommandDependencies = {},
): Promise<CatalogCommandSummary> {
  const catalog = await catalogFor(deps);
  return executeEntries(catalog, selectEntries(catalog.entries, names, options), "install", options, deps);
}

export async function removeCatalogEntries(
  names: string[],
  options: MutationOptions,
  deps: CommandDependencies = {},
): Promise<CatalogCommandSummary> {
  const catalog = await catalogFor(deps);
  const scan = await scanFor(options, deps);
  const statuses = matchCatalog(catalog, scan);
  const selected = selectEntries(statuses.map((status) => status.entry), names, options);
  const scopes = new Map(statuses.map((status) => [status.entry, status.package?.scope]));
  return executeEntries(catalog, selected, "remove", options, deps, (entry) => scopes.get(entry) === "local");
}

export async function addSource(sourceText: string, options: AddOptions, deps: CommandDependencies = {}): Promise<AddResult> {
  const source = parsePiSource(sourceText);
  if (source.kind === "npm" && !sourceText.startsWith("npm:")) {
    throw new Error(`Pi-supported source required: ${sourceText}`);
  }
  if (options.dryRun) return { source, validation: "pending-rescan" };
  if (!await confirm("Add this Pi source?", options)) return { source, validation: "skipped" };

  await runPi(["install", ...(options.local ? ["-l"] : []), sourceArgument(source)], piOptions(deps));
  const scan = await scanFor(options, deps);
  if (!options.expectedType) return { source, validation: "not-requested" };

  const pkg = scan.packages.find((candidate) => sourceIdentity(candidate.source) === sourceIdentity(source));
  if (!pkg) throw new Error(`Pi installed source was not found by scan: ${sourceText}`);
  const resources = options.expectedType === "skill" ? scan.skills
    : options.expectedType === "plugin" ? scan.extensions : scan.packages;
  const valid = options.expectedType === "package"
    ? resources.some((resource) => resource.id === pkg.id)
    : resources.some((resource) => resource.ownerPackageId === pkg.id);
  if (!valid) throw new Error(`Source ${sourceText} does not supply a ${options.expectedType}`);
  return { source, validation: "passed" };
}

function selectEntries(entries: CatalogEntry[], names: string[], options: Pick<MutationOptions, "full" | "type">): CatalogEntry[] {
  const selected = options.full ? entries : entries.filter((entry) => names.includes(entry.name));
  return options.type ? selected.filter((entry) => entry.type === options.type) : selected;
}

async function executeEntries(
  catalog: Catalog,
  entries: CatalogEntry[],
  command: "install" | "remove",
  options: MutationOptions,
  deps: CommandDependencies,
  isLocal: (entry: CatalogEntry) => boolean = () => false,
): Promise<CatalogCommandSummary> {
  const actions = uniqueSources(catalog, entries).map((entry) => ({ entry, source: catalogSource(catalog, entry) }));
  if (actions.length === 0) return { requested: 0, completed: 0, skipped: 0 };
  if (options.dryRun) return { requested: actions.length, completed: 0, skipped: actions.length };
  if (!await confirm(`${command === "install" ? "Install" : "Remove"} selected Pi catalog entries?`, options)) {
    return { requested: actions.length, completed: 0, skipped: actions.length };
  }

  for (const { entry, source } of actions) {
    await runPi([command, ...(command === "remove" && (options.local || isLocal(entry)) ? ["-l"] : []), sourceArgument(source)], piOptions(deps));
  }
  return { requested: actions.length, completed: actions.length, skipped: 0 };
}

function uniqueSources(catalog: Catalog, entries: CatalogEntry[]): CatalogEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const identity = sourceIdentity(catalogSource(catalog, entry));
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

async function catalogFor(deps: CommandDependencies): Promise<Catalog> {
  return deps.catalog ?? loadCatalog(deps.catalogPath ?? "catalog.yml");
}

async function scanFor(options: ScanOptions, deps: CommandDependencies): Promise<ScanResult> {
  const scan = deps.scan ?? scanPi;
  return scan({ agentDir: options.agentDir, projectRoot: options.projectRoot });
}

function piOptions(deps: CommandDependencies): { piPath?: string; env?: NodeJS.ProcessEnv; cwd?: string } {
  return { piPath: deps.piPath, env: deps.env, cwd: deps.cwd };
}

function sourceArgument(source: Source): string {
  return source.kind === "local-path" ? source.path : source.spec;
}
