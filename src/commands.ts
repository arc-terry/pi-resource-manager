import { basename, dirname, resolve } from "node:path";
import type { Resource, Source } from "./domain.js";
import {
  emptyCollection, manualPackage, mergeCollection, readCollection,
  resourcesFromScan, writeCollectionAtomic, type Collection,
} from "./collection.js";
import { catalogSource, type Catalog, type CatalogEntry, type CatalogStatus, loadCatalog, matchCatalog } from "./catalog.js";
import { readProfile, type Profile, type ProfileEntry } from "./profile.js";
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
  profile?: Profile;
  profilePath?: string;
  scan?: (options: ScanOptions) => Promise<ScanResult>;
  piPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface AddResourcesOptions extends ScanOptions {
  source?: string;
  scan?: boolean;
  collectionPath?: string;
  now?: Date;
}

export async function scanResources(options: ScanOptions = {}, deps: CommandDependencies = {}): Promise<ScanResult> {
  return (deps.scan ?? scanPi)(options);
}

export async function addResources(options: AddResourcesOptions = {}, deps: CommandDependencies = {}): Promise<Collection> {
  if (options.source !== undefined && options.scan) throw new Error("source and --scan are mutually exclusive");

  const source = options.source === undefined ? undefined : manualSource(options.source);
  const path = options.collectionPath ?? "pi-collection.yml";
  const now = options.now ?? new Date();
  const base = await readCollection(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyCollection(basename(dirname(resolve(path))) || basename(process.cwd()), now);
    }
    throw error;
  });
  const incoming = source
    ? [manualPackage(source)]
    : resourcesFromScan(await scanResources({ projectRoot: options.projectRoot, agentDir: options.agentDir }, deps));
  const merged = mergeCollection(base, incoming, now.toISOString());
  await writeCollectionAtomic(path, merged);
  return merged;
}

function manualSource(sourceText: string): Source {
  const source = parsePiSource(sourceText);
  if (source.kind === "npm" && !sourceText.startsWith("npm:")) {
    throw new Error(`Pi-supported source required: ${sourceText}`);
  }
  return source;
}

interface ScanCommandOptions extends ScanOptions {
  type?: CatalogType;
  profilePath?: string;
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
  const catalog = await catalogFor(deps);
  const scan = await scanFor(options, deps);
  const statuses = matchCatalog(catalog, scan);
  const profilePath = options.profilePath ?? deps.profilePath;
  const profile = deps.profile ?? (profilePath ? await profileFor(profilePath, deps) : undefined);
  const merged = profile ? mergeProfileStatuses(statuses, profile, scan) : statuses;
  return options.type ? merged.filter((status) => status.entry.type === options.type) : merged;
}

async function profileFor(path: string, deps: CommandDependencies): Promise<Profile | undefined> {
  if (deps.profile) return deps.profile;
  try {
    return await readProfile(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function mergeProfileStatuses(statuses: CatalogStatus[], profile: Profile, scan: ScanResult): CatalogStatus[] {
  const seen = new Set(statuses.map((status) => statusKey(status)));
  const result = [...statuses];
  for (const entry of profile.packages) addProfileStatus(result, seen, "package", entry, scan);
  for (const entry of profile.skills) addProfileStatus(result, seen, "skill", entry, scan);
  for (const entry of profile.extensions) addProfileStatus(result, seen, "plugin", entry, scan);
  return result;
}

function addProfileStatus(
  result: CatalogStatus[],
  seen: Set<string>,
  type: CatalogType,
  profile: ProfileEntry,
  scan: ScanResult,
): void {
  const status = profileStatus(type, profile, scan);
  const key = statusKey(status);
  if (seen.has(key)) return;
  seen.add(key);
  result.push(status);
}

function profileStatus(type: CatalogType, profile: ProfileEntry, scan: ScanResult): CatalogStatus {
  const resource = type === "package"
    ? scan.packages.find((candidate) => sourceIdentity(candidate.source) === sourceIdentity(profile.source))
    : (type === "skill" ? scan.skills : scan.extensions).find((candidate) => profileResourceMatches(candidate, profile));
  const packageResource = resource?.ownerPackageId
    ? scan.packages.find((candidate) => candidate.id === resource.ownerPackageId)
    : resource?.type === "package" ? resource : undefined;
  return {
    entry: { name: profile.name, type, source: sourceArgument(profile.source) },
    installed: resource !== undefined,
    package: packageResource,
    resource: resource?.type === "package" ? undefined : resource,
    profile,
  };
}

function profileResourceMatches(resource: Resource, profile: ProfileEntry): boolean {
  if (profile.ownerPackageId) return resource.ownerPackageId === profile.ownerPackageId && resource.name === profile.name;
  return resource.name === profile.name && sourceIdentity(resource.source) === sourceIdentity(profile.source);
}

function statusKey(status: CatalogStatus): string {
  const type = status.entry.type;
  if (type === "package") return `package:${sourceIdentity(parseStatusSource(status))}`;
  if (status.package) return `${type}:${status.package.id}:${status.entry.name}`;
  return `${type}:${sourceIdentity(parseStatusSource(status))}:${status.entry.name}`;
}

function parseStatusSource(status: CatalogStatus): Source {
  if (status.profile) return status.profile.source;
  if (status.package) return status.package.source;
  return parsePiSource(status.entry.source);
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
