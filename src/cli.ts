import { Command, InvalidArgumentError } from "commander";
import { createCommandDependencies } from "./commands.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface ActionSummary {
  failed?: number;
  failures?: unknown[];
  [key: string]: unknown;
}

export interface CommandDependencies {
  listCollection?: (options: { full: boolean; type?: string }) => Promise<ChecklistStatus[]>;
  installCatalogEntries?: (names: string[], options: { full: boolean; type?: string; yes: boolean }) => Promise<ActionSummary>;
  removeCatalogEntries?: (names: string[], options: { type?: string; yes: boolean }) => Promise<ActionSummary>;
  addSource?: (source: string, options: { local: boolean; type?: string; dryRun: boolean; yes: boolean }) => Promise<ActionSummary>;
  scanProfile?: (options: { output: string; project?: string }) => Promise<ActionSummary>;
  showProfile?: (path: string) => Promise<unknown>;
  restoreProfile?: (path: string, options: { dryRun: boolean; only?: string; project?: string; yes: boolean }) => Promise<ActionSummary>;
  write?: (text: string) => void;
}

export type CliResourceType = "package" | "skill" | "plugin";

function parseResourceType(value: string): CliResourceType {
  if (value === "package" || value === "skill" || value === "plugin") return value;
  throw new InvalidArgumentError("type must be package, skill, or plugin");
}

export interface ChecklistStatus {
  installed: boolean;
  entry: { type: "package" | "skill" | "plugin"; name: string; source?: string; description?: string };
}

export function renderChecklist(statuses: ChecklistStatus[], full: boolean): string {
  return statuses
    .map((status) => {
      const lines = [`[${status.installed ? "v" : " "}] ${status.entry.type} ${status.entry.name}`];
      if (full && status.entry.source) lines.push(`    source: ${status.entry.source}`);
      if (full && status.entry.description) lines.push(`    description: ${status.entry.description}`);
      return lines.join("\n");
    })
    .join("\n");
}

function hasFailures(summary: ActionSummary): boolean {
  return (summary.failed ?? 0) > 0 || (summary.failures?.length ?? 0) > 0;
}

export function buildProgram(deps: CommandDependencies): Command {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const writeSummary = (summary: ActionSummary) => {
    write(`${JSON.stringify(summary)}\n`);
    if (hasFailures(summary)) process.exitCode = 1;
  };
  const program = new Command()
    .name("pi-collection")
    .description("Manage Pi packages, skills, and plugins");

  program
    .command("list")
    .option("--full")
    .option("--type <type>", "resource type", parseResourceType)
    .option("--json")
    .action(async (options: { full?: boolean; type?: string; json?: boolean }) => {
      if (!deps.listCollection) throw new Error("listCollection dependency is required");
      const statuses = await deps.listCollection({ full: options.full ?? false, type: options.type });
      write(options.json ? `${JSON.stringify(statuses)}\n` : `${renderChecklist(statuses, options.full ?? false)}\n`);
    });

  program
    .command("install [names...]")
    .option("--full")
    .option("--type <type>", "resource type", parseResourceType)
    .option("--yes")
    .action(async (names: string[], options: { full?: boolean; type?: string; yes?: boolean }) => {
      if (!deps.installCatalogEntries) throw new Error("installCatalogEntries dependency is required");
      const summary = await deps.installCatalogEntries(names, {
        full: options.full ?? false,
        type: options.type,
        yes: options.yes ?? false,
      });
      writeSummary(summary);
    });

  program
    .command("remove <names...>")
    .option("--type <type>", "resource type", parseResourceType)
    .option("--yes")
    .action(async (names: string[], options: { type?: string; yes?: boolean }) => {
      if (!deps.removeCatalogEntries) throw new Error("removeCatalogEntries dependency is required");
      const summary = await deps.removeCatalogEntries(names, { type: options.type, yes: options.yes ?? false });
      writeSummary(summary);
    });

  program
    .command("add <source>")
    .option("--local")
    .option("--type <type>", "resource type", parseResourceType)
    .option("--dry-run")
    .option("--yes")
    .action(async (source: string, options: { local?: boolean; type?: string; dryRun?: boolean; yes?: boolean }) => {
      if (!deps.addSource) throw new Error("addSource dependency is required");
      const summary = await deps.addSource(source, {
        local: options.local ?? false,
        type: options.type,
        dryRun: options.dryRun ?? false,
        yes: options.yes ?? false,
      });
      writeSummary(summary);
    });

  const profile = program.command("profile");
  profile
    .command("scan")
    .option("--output <path>", "profile output path", "pi-profile.yml")
    .option("--project <path>")
    .action(async (options: { output: string; project?: string }) => {
      if (!deps.scanProfile) throw new Error("scanProfile dependency is required");
      const summary = await deps.scanProfile({ output: options.output, project: options.project });
      writeSummary(summary);
    });
  profile.command("show <path>").action(async (path: string) => {
    if (!deps.showProfile) throw new Error("showProfile dependency is required");
    write(`${JSON.stringify(await deps.showProfile(path))}\n`);
  });
  profile
    .command("restore <path>")
    .option("--dry-run")
    .option("--only <type>", "resource type", parseResourceType)
    .option("--project <path>")
    .option("--yes")
    .action(async (path: string, options: { dryRun?: boolean; only?: string; project?: string; yes?: boolean }) => {
      if (!deps.restoreProfile) throw new Error("restoreProfile dependency is required");
      const summary = await deps.restoreProfile(path, {
        dryRun: options.dryRun ?? false,
        only: options.only,
        project: options.project,
        yes: options.yes ?? false,
      });
      writeSummary(summary);
    });

  return program;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildProgram(createCommandDependencies()).parseAsync().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
