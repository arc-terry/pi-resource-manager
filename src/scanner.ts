import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Resource, Scope } from "./domain.js";
import { defaultAgentDirectory, locationsFor, readSettings, type PiLocations } from "./settings.js";
import { parsePiSource, sourceIdentity, type Source } from "./sources.js";

export interface ScanResult {
  packages: Resource[];
  skills: Resource[];
  extensions: Resource[];
}

export async function scanPi(options: { agentDir?: string; projectRoot?: string } = {}): Promise<ScanResult> {
  const agentDir = options.agentDir ?? defaultAgentDirectory();
  const scopes: Array<{ scope: Scope; locations: PiLocations }> = [
    { scope: "global", locations: locationsFor("global", agentDir) },
  ];
  if (options.projectRoot) {
    scopes.push({ scope: "local", locations: locationsFor("local", agentDir, options.projectRoot) });
  }

  const result: ScanResult = { packages: [], skills: [], extensions: [] };
  for (const { scope, locations } of scopes) {
    const settings = await readSettings(locations.settingsPath);
    const packages = await scanPackages(scope, locations, settings);
    result.packages.push(...packages.resources);
    result.skills.push(...packages.skills);
    result.extensions.push(...packages.extensions);

    const configuredSkills = stringArray(settings.skills).map((path) => resolveConfiguredPath(locations.settingsPath, path));
    const configuredExtensions = stringArray(settings.extensions).map((path) => resolveConfiguredPath(locations.settingsPath, path));
    for (const path of [...locations.skillsDirs, ...configuredSkills]) {
      result.skills.push(...await scanSkills(path, scope, options.projectRoot));
    }
    for (const path of [locations.extensionsDir, ...configuredExtensions]) {
      result.extensions.push(...await scanExtensions(path, scope, options.projectRoot));
    }
  }

  return {
    packages: deduplicate(result.packages, (resource) => sourceIdentity(resource.source)),
    skills: deduplicate(result.skills, (resource) => resource.installedPath),
    extensions: deduplicate(result.extensions, (resource) => resource.installedPath),
  };
}

async function scanPackages(
  scope: Scope,
  locations: PiLocations,
  settings: Record<string, unknown>,
): Promise<{ resources: Resource[]; skills: Resource[]; extensions: Resource[] }> {
  const resources: Resource[] = [];
  const skills: Resource[] = [];
  const extensions: Resource[] = [];
  for (const spec of stringArray(settings.packages)) {
    const source = parsePiSource(spec);
    const installedPath = await packagePath(source, locations.packageDirs);
    const name = source.kind === "npm" ? source.name : packageName(source);
    const resource: Resource = {
      id: `package:${sourceIdentity(source)}`,
      type: "package",
      name,
      scope,
      source,
      installedPath,
      ...(scope === "local" ? { projectRoot: dirname(dirname(locations.settingsPath)) } : {}),
    };
    resources.push(resource);
    if (!await isDirectory(installedPath)) continue;

    const manifest = await readPackageManifest(installedPath);
    const skillPaths = manifest?.skills?.length
      ? manifest.skills.map((path) => resolve(installedPath, path))
      : [join(installedPath, "skills")];
    const extensionPaths = manifest?.extensions?.length
      ? manifest.extensions.map((path) => resolve(installedPath, path))
      : [join(installedPath, "extensions")];
    for (const path of skillPaths) {
      skills.push(...(await scanSkills(path, scope, resource.projectRoot, resource.id)));
    }
    for (const path of extensionPaths) {
      extensions.push(...(await scanExtensions(path, scope, resource.projectRoot, resource.id)));
    }
  }
  return { resources, skills, extensions };
}

async function packagePath(source: Source, packageDirs: string[]): Promise<string> {
  const leaf = source.kind === "npm" ? source.name : packageName(source);
  for (const directory of packageDirs) {
    const candidate = join(directory, leaf);
    if (await exists(candidate)) return canonicalPath(candidate);
  }
  return join(source.kind === "npm" ? packageDirs[0] : packageDirs[1], leaf);
}

function packageName(source: Exclude<Source, { kind: "npm" }>): string {
  if (source.kind === "local-path") return basename(source.path);
  return basename(source.url).replace(/\.git$/, "");
}

async function readPackageManifest(packageRoot: string): Promise<{ skills?: string[]; extensions?: string[] } | undefined> {
  try {
    const json: unknown = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (!json || typeof json !== "object") return undefined;
    const pi = (json as { pi?: unknown }).pi;
    if (!pi || typeof pi !== "object") return undefined;
    return {
      skills: stringArray((pi as { skills?: unknown }).skills),
      extensions: stringArray((pi as { extensions?: unknown }).extensions),
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function scanSkills(path: string, scope: Scope, projectRoot?: string, ownerPackageId?: string): Promise<Resource[]> {
  const files = await skillFiles(path);
  const resources: Resource[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const metadata = skillMetadata(text);
    if (!metadata) continue;
    const installedPath = file.endsWith("SKILL.md") ? dirname(file) : file;
    const sourcePath = await canonicalPath(installedPath);
    resources.push({
      id: `skill:${sourcePath}`,
      type: "skill",
      name: metadata.name,
      scope,
      source: { kind: "local-path", path: sourcePath },
      installedPath: sourcePath,
      ...(projectRoot && scope === "local" ? { projectRoot } : {}),
      ...(ownerPackageId ? { ownerPackageId } : {}),
    });
  }
  return resources;
}

async function skillFiles(path: string): Promise<string[]> {
  try {
    const info = await stat(path);
    if (info.isFile()) return extname(path) === ".md" ? [path] : [];
    if (!info.isDirectory()) return [];
    const entries = await readdir(path, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) files.push(...await skillFiles(child));
      else if (entry.isFile() && (entry.name === "SKILL.md" || extname(entry.name) === ".md")) files.push(child);
    }
    return files;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function scanExtensions(path: string, scope: Scope, projectRoot?: string, ownerPackageId?: string): Promise<Resource[]> {
  const files = await extensionFiles(path);
  return Promise.all(files.map(async (file) => {
    const installedPath = await canonicalPath(file);
    return {
      id: `extension:${installedPath}`,
      type: "extension" as const,
      name: basename(file, extname(file)),
      scope,
      source: { kind: "local-path" as const, path: installedPath },
      installedPath,
      ...(projectRoot && scope === "local" ? { projectRoot } : {}),
      ...(ownerPackageId ? { ownerPackageId } : {}),
    };
  }));
}

async function extensionFiles(path: string): Promise<string[]> {
  try {
    const info = await stat(path);
    if (info.isFile()) return isExtension(path) ? [path] : [];
    if (!info.isDirectory()) return [];
    const entries = await readdir(path, { withFileTypes: true });
    const candidates = entries.flatMap((entry) => {
      const child = join(path, entry.name);
      if (entry.isFile() && isExtension(child)) return [child];
      if (entry.isDirectory()) return [join(child, "index.ts"), join(child, "index.js")];
      return [];
    });
    const present = await Promise.all(candidates.map(async (file) => (await exists(file)) ? file : undefined));
    return present.filter((file): file is string => file !== undefined);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function isExtension(path: string): boolean {
  return [".ts", ".js"].includes(extname(path));
}

function skillMetadata(text: string): { name: string; description: string } | undefined {
  const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatter) return undefined;
  const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return name && description ? { name, description } : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function resolveConfiguredPath(settingsPath: string, path: string): string {
  return resolve(dirname(settingsPath), path);
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(path);
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function deduplicate(resources: Resource[], key: (resource: Resource) => string): Resource[] {
  const seen = new Set<string>();
  return resources.filter((resource) => {
    const resourceKey = `${resource.type}:${key(resource)}`;
    if (seen.has(resourceKey)) return false;
    seen.add(resourceKey);
    return true;
  });
}
