import { basename, dirname, resolve } from "node:path";
import type { Source } from "./domain.js";
import {
  emptyCollection, manualPackage, mergeCollection, readCollection,
  resourcesFromScan, writeCollectionAtomic, type Collection,
} from "./collection.js";
import { scanPi, type ScanResult } from "./scanner.js";
import { parsePiSource } from "./sources.js";

interface ScanOptions {
  agentDir?: string;
  projectRoot?: string;
}

export interface CommandDependencies {
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
