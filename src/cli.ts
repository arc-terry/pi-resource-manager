#!/usr/bin/env node

import { Command } from "commander";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { basename, extname } from "node:path";
import { realpathSync } from "node:fs";
import { type CatalogStatus } from "./catalog.js";
import {
  addSource,
  installCatalogEntries,
  listCollection,
  removeCatalogEntries,
  type CatalogCommandSummary,
  type CommandDependencies as CollectionCommandDependencies,
} from "./commands.js";
import { defaultAgentDir } from "./settings.js";
import { profileFromScan, readProfile, writeProfileAtomic } from "./profile.js";
import { executeRestore, planRestore, type RestoreAction, type RestoreSummary } from "./restore.js";
import { scanPi } from "./scanner.js";

type PublicResourceType = "package" | "skill" | "plugin";

export interface CommandDependencies extends CollectionCommandDependencies {}

export function buildProgram(deps: CommandDependencies = {}): Command {
  const program = new Command()
    .name("pi-collection")
    .description("Manage Pi packages, skills, and plugins");

  program.command("list")
    .option("--full", "include source and installation details")
    .option("--type <type>", "package, skill, or plugin")
    .option("--json", "emit catalog status as JSON")
    .option("--profile <path>", "profile path", "pi-profile.yml")
    .action(async (options: { full?: boolean; type?: string; json?: boolean; profile?: string }) => {
      const type = publicType(options.type);
      const statuses = await listCollection({ type, profilePath: options.profile }, deps);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(statuses)}\n`);
        return;
      }
      console.log(renderChecklist(statuses, options.full ?? false));
    });

  program.command("install [names...]")
    .option("--full", "install every catalog entry")
    .option("--type <type>", "package, skill, or plugin")
    .option("--yes", "skip the confirmation prompt")
    .action(async (names: string[], options: { full?: boolean; type?: string; yes?: boolean }) => {
      const summary = await installCatalogEntries(names, {
        full: options.full,
        type: publicType(options.type),
        yes: options.yes ?? false,
      }, deps);
      printCatalogSummary(summary);
    });

  program.command("remove <names...>")
    .option("--type <type>", "package, skill, or plugin")
    .option("--yes", "skip the confirmation prompt")
    .action(async (names: string[], options: { type?: string; yes?: boolean }) => {
      const summary = await removeCatalogEntries(names, {
        type: publicType(options.type),
        yes: options.yes ?? false,
      }, deps);
      printCatalogSummary(summary);
    });

  program.command("add <source>")
    .option("-l, --local", "install in Pi's local scope")
    .option("--type <type>", "assert package, skill, or plugin resources")
    .option("--dry-run", "show the requested operation without changing Pi")
    .option("--yes", "skip the confirmation prompt")
    .action(async (source: string, options: { local?: boolean; type?: string; dryRun?: boolean; yes?: boolean }) => {
      const result = await addSource(source, {
        local: options.local,
        expectedType: publicType(options.type),
        dryRun: options.dryRun,
        yes: options.yes ?? false,
      }, deps);
      console.log(`source: ${source}\nvalidation: ${result.validation}`);
    });

  const profile = program.command("profile").description("Scan, show, and restore Pi profiles");
  profile.command("scan")
    .option("--output <path>", "profile output path", "pi-profile.yml")
    .option("--project <path>", "include local resources from this project")
    .action(async (options: { output: string; project?: string }) => {
      const scan = deps.scan ?? scanPi;
      const result = await scan({ projectRoot: options.project });
      const output = options.output;
      await writeProfileAtomic(output, profileFromScan(result, {
        name: basename(output, extname(output)),
        agentDirectory: defaultAgentDir(),
      }));
      console.log(`wrote profile: ${output}`);
    });

  profile.command("show <path>")
    .action(async (path: string) => {
      process.stdout.write(YAML.stringify(await readProfile(path)));
    });

  profile.command("restore <path>")
    .option("--dry-run", "show restore actions without changing Pi")
    .option("--only <type>", "package, skill, or plugin")
    .option("--project <path>", "restore local resources to this project")
    .option("--yes", "skip the confirmation prompt")
    .action(async (path: string, options: { dryRun?: boolean; only?: string; project?: string; yes?: boolean }) => {
      const restoreProfile = await readProfile(path);
      const projectRoot = options.project ?? recordedProjectRoot(restoreProfile);
      const scan = deps.scan ?? scanPi;
      const scanOptions = { agentDir: restoreProfile.profile.pi.agentDirectory, projectRoot };
      const currentScan = await scan(scanOptions);
      const actions = await planRestore(restoreProfile, {
        only: publicType(options.only),
        projectRoot: options.project,
        agentDir: restoreProfile.profile.pi.agentDirectory,
        currentScan,
      });
      printRestoreActions(actions);
      const summary = await executeRestore(actions, {
        dryRun: options.dryRun,
        only: publicType(options.only),
        projectRoot: options.project,
        yes: options.yes ?? false,
        piPath: deps.piPath,
        env: deps.env,
        cwd: deps.cwd,
        rescan: async () => scan(scanOptions),
      });
      printRestoreSummary(summary);
      if (summary.failed > 0) process.exitCode = 1;
    });

  return program;
}

export function renderChecklist(statuses: CatalogStatus[], full: boolean): string {
  return statuses.map((status) => {
    const line = `[${status.installed ? "v" : " "}] ${status.entry.type} ${status.entry.name}`;
    if (!full) return line;
    const details = [
      `source: ${status.entry.source}`,
      ...(status.entry.description ? [`description: ${status.entry.description}`] : []),
      ...((status.package ?? status.resource ?? status.profile)
        ? [
          `scope: ${(status.package ?? status.resource ?? status.profile)!.scope}`,
          `installedPath: ${(status.package ?? status.resource ?? status.profile)!.installedPath}`,
          ...((status.package ?? status.resource ?? status.profile)!.projectRoot
            ? [`projectRoot: ${(status.package ?? status.resource ?? status.profile)!.projectRoot}`]
            : []),
        ]
        : []),
    ];
    return `${line}\n${details.map((detail) => `  ${detail}`).join("\n")}`;
  }).join("\n");
}

function publicType(value: string | undefined): PublicResourceType | undefined {
  if (value === undefined) return undefined;
  if (value === "package" || value === "skill" || value === "plugin") return value;
  throw new Error(`Invalid type ${JSON.stringify(value)}; expected package, skill, or plugin`);
}

function printCatalogSummary(summary: CatalogCommandSummary): void {
  console.log(`requested: ${summary.requested}\ncompleted: ${summary.completed}\nskipped: ${summary.skipped}`);
}

function printRestoreActions(actions: RestoreAction[]): void {
  for (const action of actions) {
    if (action.kind === "pi-install") console.log(`pi ${action.args.join(" ")}`);
    else if (action.kind === "settings-skill") console.log(`settings skill ${action.value}`);
    else if (action.kind === "settings-extension") console.log(`settings plugin ${action.value}`);
    else if (action.kind === "missing-local-source") console.log(`missing local source: ${action.path}`);
    else console.log(`already present: ${action.id}`);
  }
}

function recordedProjectRoot(profile: Awaited<ReturnType<typeof readProfile>>): string | undefined {
  return [...profile.packages, ...profile.skills, ...profile.extensions].find((entry) => entry.scope === "local")?.projectRoot;
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
