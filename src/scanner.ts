import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
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

export async function scanPi(options: { agentDir?: string; projectRoot?: string }): Promise<ScanResult> {
  const agentDir = options.agentDir ?? defaultAgentDir();
  const scopes: ScanScope[] = [{ scope: "global", locations: locationsFor("global", agentDir) }];
  if (options.projectRoot) {
    scopes.push({
      scope: "local",
      locations: locationsFor("local", agentDir, options.projectRoot),
      projectRoot: options.projectRoot,
    });
  }

  const result: ScanResult = { packages: [], skills: [], extensions: [] };
  const seen = new Set<string>();
  for (const scanScope of scopes) await scanScopeResources(scanScope, result, seen);
  return result;
}

async function scanScopeResources(scanScope: ScanScope, result: ScanResult, seen: Set<string>): Promise<void> {
  const settings = await readSettings(scanScope.locations.settingsPath);
  const packageResources: Resource[] = [];

  for (const spec of stringValues(settings.packages)) {
    const source = parsePiSource(spec);
    const installedPath = await packagePath(source, scanScope.locations.packageDirs);
    const resource = packageResource(source, installedPath, scanScope);
    add(result.packages, resource, seen);
    packageResources.push(resource);
  }

  for (const resource of packageResources) {
    await scanPackageResources(resource, scanScope, result, seen);
  }

  for (const skillsDir of scanScope.locations.skillsDirs) {
    await scanSkills(skillsDir, undefined, scanScope, result, seen);
  }
  for (const skillPath of stringValues(settings.skills)) {
    await scanSkills(configuredPath(skillPath, scanScope.locations.settingsPath), undefined, scanScope, result, seen);
  }

  await scanExtensions(scanScope.locations.extensionsDir, undefined, scanScope, result, seen);
  for (const extensionPath of stringValues(settings.extensions)) {
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
  scanScope: ScanScope,
  result: ScanResult,
  seen: Set<string>,
): Promise<void> {
  const pi = await packagePiConfig(resource.installedPath);
  const skillPaths = pi?.skills ?? [join(resource.installedPath, "skills")];
  const extensionPaths = pi?.extensions ?? [join(resource.installedPath, "extensions")];

  for (const skillPath of skillPaths) {
    await scanSkills(packagePathEntry(resource.installedPath, skillPath), resource, scanScope, result, seen);
  }
  for (const extensionPath of extensionPaths) {
    await scanExtensions(packagePathEntry(resource.installedPath, extensionPath), resource, scanScope, result, seen);
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
): Promise<void> {
  for (const skill of await findSkills(path)) {
    const installedPath = await canonicalPath(skill.installedPath);
    const source = owner?.source ?? { kind: "local-path" as const, path: installedPath };
    add(result.skills, {
      id: owner ? `skill:${owner.id}:${installedPath}` : `skill:${installedPath}`,
      type: "skill",
      name: skill.name,
      scope: scanScope.scope,
      source,
      installedPath,
      ...(scanScope.projectRoot ? { projectRoot: scanScope.projectRoot } : {}),
      ...(owner ? { ownerPackageId: owner.id } : {}),
    }, seen);
  }
}

async function scanExtensions(
  path: string,
  owner: Resource | undefined,
  scanScope: ScanScope,
  result: ScanResult,
  seen: Set<string>,
): Promise<void> {
  for (const extension of await findExtensions(path)) {
    const installedPath = await canonicalPath(extension);
    const source = owner?.source ?? { kind: "local-path" as const, path: installedPath };
    add(result.extensions, {
      id: owner ? `extension:${owner.id}:${installedPath}` : `extension:${installedPath}`,
      type: "extension",
      name: extensionName(installedPath),
      scope: scanScope.scope,
      source,
      installedPath,
      ...(scanScope.projectRoot ? { projectRoot: scanScope.projectRoot } : {}),
      ...(owner ? { ownerPackageId: owner.id } : {}),
    }, seen);
  }
}

async function findSkills(path: string): Promise<SkillFile[]> {
  if (await isFile(path)) {
    const skill = await skillFromFile(path);
    return skill ? [skill] : [];
  }
  if (!await isDirectory(path)) return [];

  const skills: SkillFile[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const skill = await skillFromFile(entryPath);
      if (skill) skills.push(skill);
    } else if (entry.isDirectory()) {
      skills.push(...await findNestedSkills(entryPath));
    }
  }
  return skills;
}

async function findNestedSkills(path: string): Promise<SkillFile[]> {
  const skillPath = join(path, "SKILL.md");
  const skills: SkillFile[] = [];
  if (await isFile(skillPath)) {
    const skill = await skillFromFile(skillPath);
    if (skill) skills.push(skill);
  }
  if (!await isDirectory(path)) return skills;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) skills.push(...await findNestedSkills(join(path, entry.name)));
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

async function packagePath(source: Source, packageDirs: string[]): Promise<string> {
  if (source.kind === "local-path") return canonicalPath(source.path);
  const root = source.kind === "npm"
    ? join(packageDirs[0], source.name)
    : join(packageDirs[1], source.url.replace(/^[a-z]+:\/\//, ""));
  return canonicalPath(root);
}

function packageName(source: Source): string {
  if (source.kind === "npm") return source.name;
  if (source.kind === "local-path") return basename(source.path);
  return basename(source.url.replace(/\.git$/, ""));
}

function configuredPath(path: string, settingsPath: string): string {
  return resolve(dirname(settingsPath), path);
}

function packagePathEntry(packageRoot: string, path: string): string {
  return resolve(packageRoot, path);
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
