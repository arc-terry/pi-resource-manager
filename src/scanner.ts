import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Resource, Scope, Source } from "./domain.js";
import { defaultAgentDir, locationsFor, readSettings, type PiLocations } from "./settings.js";
import { parsePiSource, sourceIdentity } from "./sources.js";

export interface ScanResult {
  packages: Resource[];
  skills: Resource[];
  extensions: Resource[];
}

interface ScanScope {
  scope: Scope;
  locations: PiLocations;
  projectRoot?: string;
}

interface SkillFile {
  installedPath: string;
  name: string;
}

interface PackageEntry {
  source: Source;
  skills?: string[];
  extensions?: string[];
}

interface PackageResourceFilter {
  additions: string[];
  matches(resource: Resource): boolean;
  forceIncludes(resource: Resource): boolean;
}

interface LoadedScope extends ScanScope {
  settings: Record<string, unknown>;
  packages: PackageEntry[];
}

interface SkillDiscoveryOptions {
  includeRootMarkdown: boolean;
  includeNestedMarkdown: boolean;
}

const standardSkillDiscovery: SkillDiscoveryOptions = { includeRootMarkdown: true, includeNestedMarkdown: false };
const agentsSkillDiscovery: SkillDiscoveryOptions = { includeRootMarkdown: false, includeNestedMarkdown: true };

export async function scanPi(options: { agentDir?: string; projectRoot?: string }): Promise<ScanResult> {
  const agentDir = options.agentDir ?? defaultAgentDir();
  const projectRoot = options.projectRoot && resolve(options.projectRoot);
  const scopes: ScanScope[] = [{ scope: "global", locations: locationsFor("global", agentDir) }];
  if (projectRoot) {
    scopes.push({
      scope: "local",
      locations: locationsFor("local", agentDir, projectRoot),
      projectRoot,
    });
  }

  const loadedScopes = await Promise.all(scopes.map(loadScope));
  const localPackageIdentities = new Set(
    loadedScopes.filter((scanScope) => scanScope.scope === "local")
      .flatMap((scanScope) => scanScope.packages.map((entry) => sourceIdentity(entry.source))),
  );
  const result: ScanResult = { packages: [], skills: [], extensions: [] };
  const seen = new Set<string>();
  for (const scanScope of loadedScopes) {
    await scanScopeResources(scanScope, result, seen, scanScope.scope === "global" ? localPackageIdentities : new Set());
  }
  return result;
}

async function loadScope(scanScope: ScanScope): Promise<LoadedScope> {
  const settings = await readSettings(scanScope.locations.settingsPath);
  return {
    ...scanScope,
    settings,
    packages: packageEntries(settings.packages, scanScope.locations.settingsPath),
  };
}

async function scanScopeResources(
  scanScope: LoadedScope,
  result: ScanResult,
  seen: Set<string>,
  overriddenPackageIdentities: Set<string>,
): Promise<void> {
  const packageResources: Array<{ entry: PackageEntry; resource: Resource }> = [];
  const scannedPackageIdentities = new Set<string>();

  for (const entry of scanScope.packages) {
    const identity = sourceIdentity(entry.source);
    if (overriddenPackageIdentities.has(identity) || scannedPackageIdentities.has(identity)) continue;
    scannedPackageIdentities.add(identity);
    const installedPath = await packagePath(entry.source, scanScope.locations.packageDirs);
    const resource = packageResource(entry.source, installedPath, scanScope);
    add(result.packages, resource, seen);
    packageResources.push({ entry, resource });
  }

  for (const { entry, resource } of packageResources) {
    await scanPackageResources(resource, entry, scanScope, result, seen);
  }

  for (const [index, skillsDir] of scanScope.locations.skillsDirs.entries()) {
    await scanSkills(skillsDir, undefined, scanScope, result, seen, index === 1 ? agentsSkillDiscovery : standardSkillDiscovery);
  }
  for (const skillPath of stringValues(scanScope.settings.skills)) {
    const path = configuredPath(skillPath, scanScope.locations.settingsPath);
    await scanSkills(path, undefined, scanScope, result, seen, skillDiscoveryFor(path));
  }

  await scanExtensions(scanScope.locations.extensionsDir, undefined, scanScope, result, seen);
  for (const extensionPath of stringValues(scanScope.settings.extensions)) {
    await scanExtensions(configuredPath(extensionPath, scanScope.locations.settingsPath), undefined, scanScope, result, seen);
  }
}

function packageResource(source: Source, installedPath: string, scanScope: ScanScope): Resource {
  const identity = sourceIdentity(source);
  return {
    id: `package:${identity}`,
    type: "package",
    name: packageName(source),
    scope: scanScope.scope,
    source,
    installedPath,
    ...(scanScope.projectRoot ? { projectRoot: scanScope.projectRoot } : {}),
  };
}

async function scanPackageResources(
  resource: Resource,
  entry: PackageEntry,
  scanScope: ScanScope,
  result: ScanResult,
  seen: Set<string>,
): Promise<void> {
  const pi = await packagePiConfig(resource.installedPath);
  const skillPaths = pi?.skills ?? [join(resource.installedPath, "skills")];
  const extensionPaths = pi?.extensions ?? [join(resource.installedPath, "extensions")];
  const skillFilter = entry.skills === undefined ? undefined : packageResourceFilter(entry.skills, resource.installedPath);
  const extensionFilter = entry.extensions === undefined ? undefined : packageResourceFilter(entry.extensions, resource.installedPath);

  for (const skillPath of skillPaths) {
    await scanSkills(packagePathEntry(resource.installedPath, skillPath), resource, scanScope, result, seen, standardSkillDiscovery, skillFilter?.matches);
  }
  if (skillFilter) {
    for (const skillPath of skillFilter.additions) {
      await scanSkills(packagePathEntry(resource.installedPath, skillPath), resource, scanScope, result, seen, standardSkillDiscovery, skillFilter.forceIncludes);
    }
  }
  for (const extensionPath of extensionPaths) {
    await scanExtensions(packagePathEntry(resource.installedPath, extensionPath), resource, scanScope, result, seen, extensionFilter?.matches);
  }
  if (extensionFilter) {
    for (const extensionPath of extensionFilter.additions) {
      await scanExtensions(packagePathEntry(resource.installedPath, extensionPath), resource, scanScope, result, seen, extensionFilter.forceIncludes);
    }
  }
}

async function packagePiConfig(path: string): Promise<{ skills?: string[]; extensions?: string[] } | undefined> {
  try {
    const packageJson: unknown = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
    if (packageJson === null || typeof packageJson !== "object") return undefined;
    const pi = (packageJson as { pi?: unknown }).pi;
    if (pi === null || typeof pi !== "object") return undefined;
    return {
      skills: stringArray((pi as { skills?: unknown }).skills),
      extensions: stringArray((pi as { extensions?: unknown }).extensions),
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function scanSkills(
  path: string,
  owner: Resource | undefined,
  scanScope: ScanScope,
  result: ScanResult,
  seen: Set<string>,
  discovery: SkillDiscoveryOptions,
  accept: (resource: Resource) => boolean = () => true,
): Promise<void> {
  for (const skill of await findSkills(path, discovery)) {
    const installedPath = await canonicalPath(skill.installedPath);
    const source = owner?.source ?? { kind: "local-path" as const, path: installedPath };
    const resource: Resource = {
      id: owner ? `skill:${owner.id}:${installedPath}` : `skill:${installedPath}`,
      type: "skill",
      name: skill.name,
      scope: scanScope.scope,
      source,
      installedPath,
      ...(scanScope.projectRoot ? { projectRoot: scanScope.projectRoot } : {}),
      ...(owner ? { ownerPackageId: owner.id } : {}),
    };
    if (accept(resource)) add(result.skills, resource, seen);
  }
}

async function scanExtensions(
  path: string,
  owner: Resource | undefined,
  scanScope: ScanScope,
  result: ScanResult,
  seen: Set<string>,
  accept: (resource: Resource) => boolean = () => true,
): Promise<void> {
  for (const extension of await findExtensions(path)) {
    const installedPath = await canonicalPath(extension);
    const source = owner?.source ?? { kind: "local-path" as const, path: installedPath };
    const resource: Resource = {
      id: owner ? `extension:${owner.id}:${installedPath}` : `extension:${installedPath}`,
      type: "extension",
      name: extensionName(installedPath),
      scope: scanScope.scope,
      source,
      installedPath,
      ...(scanScope.projectRoot ? { projectRoot: scanScope.projectRoot } : {}),
      ...(owner ? { ownerPackageId: owner.id } : {}),
    };
    if (accept(resource)) add(result.extensions, resource, seen);
  }
}

async function findSkills(path: string, discovery: SkillDiscoveryOptions): Promise<SkillFile[]> {
  if (await isFile(path)) {
    const skill = await skillFromFile(path);
    return skill ? [skill] : [];
  }
  if (!await isDirectory(path)) return [];

  const skills: SkillFile[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isFile() && discovery.includeRootMarkdown && entry.name.endsWith(".md")) {
      const skill = await skillFromFile(entryPath);
      if (skill) skills.push(skill);
    } else if (entry.isDirectory()) {
      skills.push(...await findNestedSkills(entryPath, discovery.includeNestedMarkdown));
    }
  }
  return skills;
}

async function findNestedSkills(path: string, includeMarkdown: boolean): Promise<SkillFile[]> {
  const skillPath = join(path, "SKILL.md");
  const skills: SkillFile[] = [];
  if (await isFile(skillPath)) {
    const skill = await skillFromFile(skillPath);
    if (skill) skills.push(skill);
  }
  if (!await isDirectory(path)) return skills;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      skills.push(...await findNestedSkills(entryPath, includeMarkdown));
    } else if (includeMarkdown && entry.isFile() && entry.name !== "SKILL.md" && entry.name.endsWith(".md")) {
      const skill = await skillFromFile(entryPath);
      if (skill) skills.push(skill);
    }
  }
  return skills;
}

async function skillFromFile(path: string): Promise<SkillFile | undefined> {
  const text = await readFile(path, "utf8");
  const match = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(text);
  if (!match) return undefined;
  const frontmatter: unknown = parseYaml(match[1]);
  if (frontmatter === null || typeof frontmatter !== "object") return undefined;
  const { name, description } = frontmatter as { name?: unknown; description?: unknown };
  return typeof name === "string" && name.length > 0 && typeof description === "string" && description.length > 0
    ? { installedPath: basename(path) === "SKILL.md" ? dirname(path) : path, name }
    : undefined;
}

async function findExtensions(path: string): Promise<string[]> {
  if (await isFile(path)) return isExtension(path) ? [path] : [];
  if (!await isDirectory(path)) return [];

  const extensions: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isFile() && isExtension(entryPath)) extensions.push(entryPath);
    if (entry.isDirectory()) {
      const indexPath = join(entryPath, "index.ts");
      if (await isFile(indexPath)) extensions.push(indexPath);
    }
  }
  return extensions;
}

function add(resources: Resource[], resource: Resource, seen: Set<string>): void {
  const identity = resource.type === "package" ? sourceIdentity(resource.source) : resource.installedPath;
  const key = `${resource.type}:${identity}`;
  if (!seen.has(key)) {
    seen.add(key);
    resources.push(resource);
  }
}

function packageResourceFilter(filters: string[], packageRoot: string): PackageResourceFilter {
  const additions = filters.filter((filter) => filter.startsWith("+")).map((filter) => filter.slice(1));
  const exactExclusions = filters.filter((filter) => filter.startsWith("-")).map((filter) => normalizeFilterPath(filter.slice(1)));
  const globExclusions = filters.filter((filter) => filter.startsWith("!")).map((filter) => filter.slice(1));
  const selections = filters.filter((filter) => !/^[!+-]/.test(filter));

  const isExcluded = (resource: Resource) => {
    const path = packageRelativePath(resource, packageRoot);
    return exactExclusions.includes(path) || globExclusions.some((filter) => globMatches(filter, path));
  };
  return {
    additions,
    matches: (resource) => filters.length > 0 && !isExcluded(resource)
      && (selections.length === 0 || selections.some((filter) => filterMatches(filter, resource, packageRoot))),
    forceIncludes: (resource) => !exactExclusions.includes(packageRelativePath(resource, packageRoot)),
  };
}

function filterMatches(filter: string, resource: Resource, packageRoot: string): boolean {
  return globMatches(filter, packageRelativePath(resource, packageRoot)) || globMatches(filter, resource.name);
}

function packageRelativePath(resource: Resource, packageRoot: string): string {
  return relative(packageRoot, resource.installedPath).split("\\").join("/");
}

function normalizeFilterPath(path: string): string {
  return path.replace(/^\.\//, "").split("\\").join("/");
}

function globMatches(pattern: string, value: string): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`).test(value);
}

async function packagePath(source: Source, packageDirs: string[]): Promise<string> {
  if (source.kind === "local-path") return canonicalPath(source.path);
  const root = source.kind === "npm"
    ? join(packageDirs[0], source.name)
    : join(packageDirs[1], gitDirectory(source.url));
  return canonicalPath(root);
}

function gitDirectory(url: string): string {
  const normalizedUrl = url.replace(/^[a-z]+:\/\//, "");
  const sshMatch = /^(?:[^@/]+@)?([^:]+):(.+)$/.exec(normalizedUrl);
  if (sshMatch) return join(sshMatch[1], sshMatch[2]);
  return normalizedUrl.replace(/^[^@/]+@/, "");
}

function packageName(source: Source): string {
  if (source.kind === "npm") return source.name;
  if (source.kind === "local-path") return basename(source.path);
  return basename(source.url.replace(/\.git$/, ""));
}

function configuredPath(path: string, settingsPath: string): string {
  const expandedPath = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return resolve(dirname(settingsPath), expandedPath);
}

function skillDiscoveryFor(path: string): SkillDiscoveryOptions {
  return basename(path) === "skills" && basename(dirname(path)) === ".agents"
    ? agentsSkillDiscovery
    : standardSkillDiscovery;
}

function packagePathEntry(packageRoot: string, path: string): string {
  return resolve(packageRoot, path);
}

function packageEntries(value: unknown, settingsPath: string): PackageEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): PackageEntry[] => {
    if (typeof entry === "string") return [{ source: parsePiSource(entry, dirname(settingsPath)) }];
    if (entry === null || typeof entry !== "object" || typeof (entry as { source?: unknown }).source !== "string") return [];
    const packageEntry = entry as { source: string; skills?: unknown; extensions?: unknown };
    return [{
      source: parsePiSource(packageEntry.source, dirname(settingsPath)),
      skills: stringArray(packageEntry.skills),
      extensions: stringArray(packageEntry.extensions),
    }];
  });
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? stringValues(value) : undefined;
}

function isExtension(path: string): boolean {
  return [".ts", ".js"].includes(extname(path));
}

function extensionName(path: string): string {
  return basename(path) === "index.ts" ? basename(dirname(path)) : basename(path, extname(path));
}

async function canonicalPath(path: string): Promise<string> {
  const absolutePath = resolve(path);
  try {
    return await realpath(absolutePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return absolutePath;
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}
