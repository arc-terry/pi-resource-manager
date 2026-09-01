#!/usr/bin/env node

import { Command } from "commander";
import { access } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCollection, type Collection } from "./collection.js";
import { addResources, scanResources, type CommandDependencies as CollectionCommandDependencies } from "./commands.js";
import { displayType } from "./domain.js";
import { executeRestore, planInstall, type RestoreAction, type RestoreSummary } from "./restore.js";
import { buildSelection, selectedResourceIds } from "./selection.js";
import { scanPi, type ScanResult } from "./scanner.js";
import { runInstallTui } from "./tui.js";

export interface CommandDependencies extends Pick<CollectionCommandDependencies, "scan" | "piPath" | "env" | "cwd"> {}

export function buildProgram(deps: CommandDependencies = {}): Command {
  const program = new Command()
    .name("pi-collection")
    .description("Capture and install Pi resources");

  program.command("scan")
    .option("--project <path>")
    .action(async (options: { project?: string }) => {
      console.log(renderScanChecklist(await scanResources({ projectRoot: options.project }, deps)));
    });

  program.command("add [source]")
    .option("--scan", "save resources discovered on this computer")
    .option("--project <path>")
    .action(async (source: string | undefined, options: { scan?: boolean; project?: string }) => {
      const collection = await addResources({ source, scan: options.scan, projectRoot: options.project }, deps);
      console.log(`wrote collection: pi-collection.yml\nresources: ${collection.resources.length}`);
    });

  program.command("install [collection-path]")
    .option("--dry-run")
    .option("--yes")
    .action(async (collectionPath: string | undefined, options: { dryRun?: boolean; yes?: boolean }) => {
      const collection = await readCollection(collectionPath ?? "pi-collection.yml");
      const currentScan = await scanInstallResources(collection, deps);
      const state = buildSelection(collection, currentScan, { missingLocalIds: await missingLocalIds(collection.resources) });
      const selected = options.yes
        ? selectedResourceIds(state)
        : await runInstallTui(state, { input: process.stdin, output: process.stdout, closeInput: true });
      if (selected === undefined) return;

      const actions = await planInstall(collection, selected, { currentScan });
      printInstallActions(actions);
      const summary = await executeRestore(actions, {
        dryRun: options.dryRun,
        yes: true,
        piPath: deps.piPath,
        env: deps.env,
        cwd: deps.cwd,
        rescan: () => scanInstallResources(collection, deps),
      });
      printRestoreSummary(summary);
      if (summary.failed > 0) process.exitCode = 1;
    });

  return program;
}

export async function scanInstallResources(collection: Collection, deps: CommandDependencies = {}): Promise<ScanResult> {
  const roots = [...new Set(collection.resources
    .filter((resource) => resource.scope === "local" && resource.projectRoot)
    .map((resource) => resolve(resource.projectRoot!)))].sort();
  const scans = await Promise.all([scanResources({}, deps), ...roots.map((projectRoot) => scanResources({ projectRoot }, deps))]);
  const result: ScanResult = { packages: [], skills: [], extensions: [] };
  const seen = new Set<string>();
  for (const [index, scan] of scans.entries()) {
    for (const type of ["packages", "skills", "extensions"] as const) {
      for (const resource of scan[type]) {
        if (index > 0 && resource.scope !== "local") continue;
        const key = `${resource.type}:${resource.scope}:${resource.projectRoot ?? ""}:${resource.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result[type].push(resource);
      }
    }
  }
  return result;
}

export function renderScanChecklist(scan: Awaited<ReturnType<typeof scanPi>>): string {
  return [...scan.packages, ...scan.skills, ...scan.extensions]
    .map((resource) => `[v] ${displayType(resource.type)} ${resource.name}`)
    .join("\n");
}

async function missingLocalIds(resources: Awaited<ReturnType<typeof readCollection>>["resources"]): Promise<Set<string>> {
  const missing = await Promise.all(resources.map(async (resource) => {
    if (resource.source.kind !== "local-path") return undefined;
    try {
      await access(resource.source.path);
      return undefined;
    } catch {
      return resource.id;
    }
  }));
  return new Set(missing.filter((id): id is string => id !== undefined));
}

function printInstallActions(actions: RestoreAction[]): void {
  for (const action of actions) {
    if (action.kind === "pi-install") console.log(`pi ${action.args.join(" ")}`);
    else if (action.kind === "settings-skill") console.log(`settings skill ${action.value}`);
    else if (action.kind === "settings-extension") console.log(`settings plugin ${action.value}`);
    else if (action.kind === "missing-local-source") console.log(`missing local source: ${action.path}`);
    else console.log(`already present: ${action.id}`);
  }
}

function printRestoreSummary(summary: RestoreSummary): void {
  console.log(`installed: ${summary.installed}\nalready present: ${summary.alreadyPresent}\nskipped: ${summary.skipped}\nfailed: ${summary.failed}`);
  for (const failure of summary.failures) {
    console.log(`failure ${failure.id}: ${failure.message}`);
    if (failure.command) console.log(`  command: ${failure.command}`);
    if (failure.exitCode !== undefined) console.log(`  exit status: ${failure.exitCode}`);
    if (failure.stdout !== undefined) console.log(`  stdout: ${failure.stdout}`);
    if (failure.stderr !== undefined) console.log(`  stderr: ${failure.stderr}`);
  }
}

function canonicalEntrypoint(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

const invokedPath = canonicalEntrypoint(process.argv[1]);
const modulePath = canonicalEntrypoint(fileURLToPath(import.meta.url));
if (invokedPath !== undefined && invokedPath === modulePath) {
  await buildProgram().parseAsync(process.argv).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
