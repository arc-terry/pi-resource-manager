# Pi Collection Utility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone CLI that catalogs Pi packages, skills, and extensions, installs sources through Pi, and scans/restores versioned YAML profiles.

**Architecture:** TypeScript modules separate Pi filesystem discovery, normalized resource/domain types, profile serialization, Pi command execution, catalog matching, and command presentation. The CLI is a thin Commander adapter that renders domain results and never duplicates Pi's npm/Git installer behavior.

**Tech Stack:** Node.js 20+, TypeScript (strict), Commander, YAML, Zod, `node:test`, `tsx`.

**Spec:** `docs/superpowers/specs/2026-08-25-pi-collection-design.md`

## Global Constraints

- Use only Pi-supported package sources: `npm:`, `git:`, supported Git protocol URLs, or local paths.
- Global is the default scope; `--local` maps to Pi's `-l` switch.
- Use `plugin` in CLI output and options; store `extension` in profiles and domain types.
- Never implement direct Git clone or `npm install`; invoke `pi install` and `pi remove`.
- Profiles are YAML with `schemaVersion: 1`, explicit `global`/`local` scopes, observed `installedPath`, and a restoration `source`.
- Do not copy local sources into profiles. A missing local source must be reported, never guessed.
- Require confirmation for non-dry-run install, remove, add, and restore operations; `--yes` skips that prompt.
- All filesystem settings/profile writes must be atomic.

---

## Proposed file structure

```text
package.json                         # package metadata and commands
 tsconfig.json                        # strict TypeScript configuration
 src/cli.ts                           # Commander program and terminal rendering
 src/domain.ts                        # public resource/profile/result types
 src/sources.ts                       # Pi source parsing and identity normalization
 src/settings.ts                      # settings JSON read/write and scope paths
 src/scanner.ts                       # packages, skills, extensions discovery
 src/profile.ts                       # Zod schema, YAML read/write, profile creation
 src/pi-command.ts                    # Pi subprocess adapter and confirmation
 src/restore.ts                       # restore action planning and execution
 src/catalog.ts                       # catalog schema, loading, matching
 src/commands.ts                      # list/install/remove/add/profile orchestration
 catalog.yml                          # initially valid empty catalog
 test/helpers.ts                      # temporary homes, files, fake Pi executable
 test/sources.test.ts                 # source parser and identity tests
 test/profile.test.ts                 # schema/scan/atomic profile tests
 test/scanner.test.ts                 # documented path/settings discovery tests
 test/restore.test.ts                 # restore-plan/action tests
 test/commands.test.ts                # catalog/list/add/install/remove behavior
 test/cli.test.ts                     # command argument and output integration tests
 README.md                            # install, security, and command reference
```

## Task 1: Bootstrap the strict TypeScript CLI and test environment

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/domain.ts`
- Create: `src/cli.ts`
- Create: `test/helpers.ts`
- Create: `test/cli.test.ts`
- Create: `catalog.yml`
- Create: `.gitignore`

**Interfaces:**
- Produces `ResourceType = "package" | "skill" | "extension"`, `Scope = "global" | "local"`, and `displayType(type): "package" | "skill" | "plugin"`.
- Produces `buildProgram(deps: CommandDependencies): Command` for later command registration.
- Produces `makeTempDir()` and `createFakePi()` for all integration tests.

- [ ] **Step 1: Create package metadata and scripts**

```json
{
  "name": "pi-collection",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "pi-collection": "./dist/cli.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "tsx --test test/**/*.test.ts",
    "check": "tsc --noEmit -p tsconfig.json"
  },
  "engines": { "node": ">=20" },
  "dependencies": { "commander": "^14.0.0", "yaml": "^2.8.0", "zod": "^4.1.0" },
  "devDependencies": { "@types/node": "^24.0.0", "tsx": "^4.20.0", "typescript": "^5.9.0" }
}
```

- [ ] **Step 2: Create `tsconfig.json`, `.gitignore`, and an empty valid catalog**

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "rootDir": "src", "outDir": "dist", "strict": true,
    "esModuleInterop": true, "skipLibCheck": true, "declaration": true
  },
  "include": ["src/**/*.ts"]
}
```

```text
# .gitignore
node_modules/
dist/
coverage/
```

```yaml
# catalog.yml
schemaVersion: 1
entries: []
```

- [ ] **Step 3: Write the failing CLI type-display test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { displayType } from "../src/domain.js";

test("renders extensions as plugins for CLI users", () => {
  assert.equal(displayType("package"), "package");
  assert.equal(displayType("skill"), "skill");
  assert.equal(displayType("extension"), "plugin");
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm install && npm test -- --test-name-pattern "renders extensions"`

Expected: FAIL because `src/domain.ts` does not exist.

- [ ] **Step 5: Implement the minimal domain types and CLI shell**

```ts
// src/domain.ts
export type ResourceType = "package" | "skill" | "extension";
export type Scope = "global" | "local";
export const displayType = (type: ResourceType): "package" | "skill" | "plugin" =>
  type === "extension" ? "plugin" : type;
```

```ts
// src/cli.ts
import { Command } from "commander";
export interface CommandDependencies {}
export function buildProgram(_deps: CommandDependencies): Command {
  return new Command().name("pi-collection").description("Manage Pi packages, skills, and plugins");
}
```

```ts
// test/helpers.ts
import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const makeTempDir = () => mkdtemp(join(tmpdir(), "pi-collection-"));
export async function createFakePi(root: string): Promise<{ path: string; log: string }> {
  const bin = join(root, "bin"); await mkdir(bin, { recursive: true });
  const log = join(root, "pi.log"); const path = join(bin, "pi");
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);
  await chmod(path, 0o755); return { path, log };
}
```

- [ ] **Step 6: Run typecheck and tests**

Run: `npm run check && npm test`

Expected: PASS.

- [ ] **Step 7: Commit the bootstrap**

```bash
git add package.json tsconfig.json .gitignore catalog.yml src test
git commit -m "chore: bootstrap pi collection CLI"
```

## Task 2: Parse and normalize Pi package sources

**Files:**
- Create: `src/sources.ts`
- Create: `test/sources.test.ts`
- Modify: `src/domain.ts`

**Interfaces:**
- Produces `Source = NpmSource | GitSource | LocalPathSource` and normalized `Resource` records for later scanning.
- Produces `parsePiSource(input: string): Source` and throws `SourceParseError` for unsupported input.
- Produces `sourceIdentity(source: Source): string`, matching Pi's npm, Git-without-ref, and canonical local-path identities.

- [ ] **Step 1: Write failing source parser tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parsePiSource, sourceIdentity } from "../src/sources.js";

test("parses pinned npm specs", () => {
  const source = parsePiSource("npm:@acme/pi-tools@1.2.3");
  assert.deepEqual(source, { kind: "npm", spec: "npm:@acme/pi-tools@1.2.3", name: "@acme/pi-tools", version: "1.2.3" });
  assert.equal(sourceIdentity(source), "npm:@acme/pi-tools");
});

test("normalizes git identity without its ref", () => {
  const source = parsePiSource("git:github.com/acme/pi-tools@v2");
  assert.equal(source.kind, "git");
  assert.equal(sourceIdentity(source), "git:github.com/acme/pi-tools");
});

test("rejects an arbitrary registry shorthand", () => {
  assert.throws(() => parsePiSource("acme/pi-tools"), /Pi-supported source/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern "parses pinned|normalizes git|rejects an arbitrary"`

Expected: FAIL because `src/sources.ts` does not exist.

- [ ] **Step 3: Implement discriminated source types and parser**

```ts
export type Source =
  | { kind: "npm"; spec: string; name: string; version?: string }
  | { kind: "git"; spec: string; url: string; ref?: string }
  | { kind: "local-path"; path: string };
export interface Resource {
  id: string; type: ResourceType; name: string; scope: Scope; source: Source;
  installedPath: string; projectRoot?: string; ownerPackageId?: string;
}

export class SourceParseError extends Error {}
export function parsePiSource(input: string): Source;
export function sourceIdentity(source: Source): string;
```

The implementation must branch in this order: `npm:` prefix; `git:` prefix; `https:`, `http:`, `ssh:`, or `git:` URL; then `isAbsolute(input) || input.startsWith("./") || input.startsWith("../")`. Otherwise throw `new SourceParseError(`Pi-supported source required: ${input}`)`. Return identities exactly as `npm:${name}`, `git:${url}`, and `local:${resolvedPath}`.

```ts
```

Implement npm scoped-name parsing by splitting at the final `@`; retain an unpinned npm spec when no version is present. For Git, accept `git:` shorthand and `https:`, `http:`, `ssh:`, and `git:` protocol URLs; split an optional ref only after the repository path. Resolve local paths with `node:path.resolve`; use `realpath` when the target exists.

- [ ] **Step 4: Add edge-case tests and implement them**

```ts
test("accepts a relative local path", () => {
  assert.equal(parsePiSource("./my-package").kind, "local-path");
});
test("preserves SSH git sources", () => {
  assert.equal(parsePiSource("git:git@github.com:acme/pi-tools@abc123").kind, "git");
});
```

Run: `npm test -- --test-name-pattern "source|npm|git|local"`

Expected: PASS.

- [ ] **Step 5: Commit the source model**

```bash
git add src/domain.ts src/sources.ts test/sources.test.ts
git commit -m "feat: parse supported pi package sources"
```

## Task 3: Read and atomically update Pi settings and scan resource locations

**Files:**
- Create: `src/settings.ts`
- Create: `src/scanner.ts`
- Create: `test/scanner.test.ts`
- Modify: `src/domain.ts`

**Interfaces:**
- Produces `PiLocations` with `agentDir`, global `settingsPath`, scope-specific `packageDirs`, `skillsDirs`, and `extensionsDir`.
- Produces `scanPi(options): Promise<ScanResult>` returning normalized packages and derived/top-level skills/extensions.
- Produces `updateSettingsArray(path, key, value): Promise<void>` for safe `skills` and `extensions` restoration.

- [ ] **Step 1: Write a failing scanner fixture test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./helpers.js";
import { scanPi } from "../src/scanner.js";

test("scans package settings plus global skills and extensions", async () => {
  const root = await makeTempDir(); const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "skills", "review"), { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n");
  await writeFile(join(agentDir, "extensions", "team.ts"), "export default () => {};");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@acme/pi-tools@1.2.3"] }));
  const scan = await scanPi({ agentDir });
  assert.equal(scan.packages[0]?.source.spec, "npm:@acme/pi-tools@1.2.3");
  assert.equal(scan.skills[0]?.name, "review");
  assert.equal(scan.extensions[0]?.name, "team");
});
```

- [ ] **Step 2: Run the scanner test to verify it fails**

Run: `npm test -- --test-name-pattern "scans package settings"`

Expected: FAIL because `src/scanner.ts` does not exist.

- [ ] **Step 3: Implement documented locations and settings parsing**

```ts
export interface PiLocations { agentDir: string; settingsPath: string; packageDirs: string[]; skillsDirs: string[]; extensionsDir: string; }
export function locationsFor(scope: Scope, agentDir: string, projectRoot?: string): PiLocations;
export async function readSettings(path: string): Promise<Record<string, unknown>>;
export async function writeJsonAtomic(path: string, value: unknown): Promise<void>;
export async function writeFileAtomic(path: string, contents: string): Promise<void>;
export async function updateSettingsArray(path: string, key: "skills" | "extensions", value: string): Promise<void>;
```

For global scope, return `settingsPath: join(agentDir, "settings.json")`, `packageDirs: [join(agentDir, "npm"), join(agentDir, "git")]`, `skillsDirs: [join(agentDir, "skills"), join(homedir(), ".agents", "skills")]`, and `extensionsDir: join(agentDir, "extensions")`. For local scope, require `projectRoot` and return `.pi/settings.json`, `[.pi/npm, .pi/git]`, `[.pi/skills, .agents/skills]`, and `.pi/extensions`. `writeFileAtomic` writes `${path}.tmp-${process.pid}`, calls `rename`, and always removes an incomplete temporary file after a write error; `writeJsonAtomic` serializes JSON then calls it.

```ts
```

Use `PI_CODING_AGENT_DIR` as the default agent directory, otherwise `join(homedir(), ".pi", "agent")`. Include global `~/.pi/agent/skills`, `~/.agents/skills`, and global extensions; include `.pi/skills`, `.agents/skills`, and `.pi/extensions` when `projectRoot` is supplied. Read `packages`, `skills`, and `extensions` arrays from settings.

- [ ] **Step 4: Implement skill/extension discovery and verify scope tests**

```ts
export interface ScanResult { packages: Resource[]; skills: Resource[]; extensions: Resource[]; }
export async function scanPi(options: { agentDir?: string; projectRoot?: string }): Promise<ScanResult>;
```

For every settings `packages` string, call `parsePiSource` and emit a package resource. Resolve the installed package root in `packageDirs`; read its `package.json` `pi.skills` and `pi.extensions` arrays or conventional `skills/` and `extensions/` directories; emit derived resources with the package id as `ownerPackageId`. Recursively collect directories containing `SKILL.md` and direct root Markdown skills with valid `name` and `description` frontmatter. Collect extension `*.ts`, `*.js`, and `*/index.ts` paths. Resolve every path before deduplicating by resource type plus `sourceIdentity` or real path.

```ts
```

Add tests for `.pi/settings.json` package sources, an extension directory `index.ts`, configured extension paths, and `updateSettingsArray` preserving unrelated settings.

Run: `npm test -- --test-name-pattern "scans|settings|extension"`

Expected: PASS.

- [ ] **Step 5: Commit discovery support**

```bash
git add src/settings.ts src/scanner.ts src/domain.ts test/scanner.test.ts
git commit -m "feat: scan pi packages skills and extensions"
```

## Task 4: Define, validate, create, and write YAML profiles

**Files:**
- Create: `src/profile.ts`
- Create: `test/profile.test.ts`
- Modify: `src/domain.ts`

**Interfaces:**
- Produces `Profile`, `ProfilePackage`, `ProfileSkill`, and `ProfileExtension` types matching schema version 1.
- Produces `profileSchema`, `profileFromScan(scan, metadata): Profile`, `readProfile(path)`, and `writeProfileAtomic(path, profile)`.

- [ ] **Step 1: Write failing profile round-trip and rejection tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./helpers.js";
import { readProfile, writeProfileAtomic } from "../src/profile.js";

test("writes a schema-versioned YAML profile atomically", async () => {
  const file = join(await makeTempDir(), "profile.yml");
  const profile = { schemaVersion: 1, profile: { name: "test", generatedAt: "2026-08-25T00:00:00.000Z", pi: { agentDirectory: "/tmp/agent" } }, packages: [], skills: [], extensions: [] };
  await writeProfileAtomic(file, profile);
  assert.match(await readFile(file, "utf8"), /schemaVersion: 1/);
  assert.deepEqual(await readProfile(file), profile);
});

test("rejects a profile with an unsupported schema version", async () => {
  const file = join(await makeTempDir(), "bad.yml");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(file, "schemaVersion: 2\n"));
  await assert.rejects(readProfile(file), /schemaVersion/);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --test-name-pattern "schema-versioned|unsupported schema"`

Expected: FAIL because `src/profile.ts` does not exist.

- [ ] **Step 3: Implement Zod schema and YAML serialization**

```ts
const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("npm"), spec: z.string(), name: z.string(), version: z.string().optional() }),
  z.object({ kind: z.literal("git"), spec: z.string(), url: z.string(), ref: z.string().optional() }),
  z.object({ kind: z.literal("local-path"), path: z.string() })
]);
const entrySchema = z.object({
  id: z.string(), name: z.string(), scope: z.enum(["global", "local"]), installedPath: z.string(),
  projectRoot: z.string().optional(), ownerPackageId: z.string().optional(), source: sourceSchema
}).superRefine((entry, ctx) => { if (entry.scope === "local" && !entry.projectRoot) ctx.addIssue({ code: "custom", message: "local entries require projectRoot" }); });
export const profileSchema = z.object({
  schemaVersion: z.literal(1),
  profile: z.object({ name: z.string(), generatedAt: z.string().datetime(), pi: z.object({ agentDirectory: z.string(), version: z.string().optional() }) }),
  packages: z.array(entrySchema), skills: z.array(entrySchema), extensions: z.array(entrySchema)
});
export type Profile = z.infer<typeof profileSchema>;
export async function readProfile(path: string): Promise<Profile>;
export async function writeProfileAtomic(path: string, profile: Profile): Promise<void>;
```

`readProfile` calls `YAML.parse(await readFile(path, "utf8"))` then `profileSchema.parse`. `writeProfileAtomic` first validates with `profileSchema.parse`, serializes with `YAML.stringify`, and delegates to `writeFileAtomic` from `src/settings.ts`.

```ts
```

Use `source.kind` as `npm`, `git`, or `local-path`, include explicit scope and `installedPath` on every entry, and require `projectRoot` for local scope entries with Zod refinement.

- [ ] **Step 4: Implement scan conversion and test provenance**

```ts
export function profileFromScan(scan: ScanResult, input: { name: string; agentDirectory: string; piVersion?: string; generatedAt?: Date }): Profile;
```

Set `schemaVersion: 1`, use `input.generatedAt ?? new Date()` with `toISOString()`, and preserve each resource's `ownerPackageId`, source, scope, `installedPath`, and `projectRoot` in its profile record.

```ts
```

Add tests that package records preserve pinned Git refs, extension records use canonical `extension` type, and local items retain `projectRoot`.

Run: `npm test -- --test-name-pattern "profile|Git|extension|projectRoot"`

Expected: PASS.

- [ ] **Step 5: Commit profile support**

```bash
git add src/profile.ts src/domain.ts test/profile.test.ts
git commit -m "feat: scan and serialize pi profiles"
```

## Task 5: Plan and execute safe Pi install/remove and profile restore actions

**Files:**
- Create: `src/pi-command.ts`
- Create: `src/restore.ts`
- Create: `test/restore.test.ts`

**Interfaces:**
- Produces `runPi(args, options): Promise<CommandResult>`.
- Produces `planRestore(profile, options): Promise<RestoreAction[]>`.
- Produces `executeRestore(actions, options): Promise<RestoreSummary>`.

- [ ] **Step 1: Write failing restore-planning tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./helpers.js";
import { planRestore } from "../src/restore.js";

test("plans global package install before local extension settings", async () => {
  const source = join(await makeTempDir(), "x.ts"); await writeFile(source, "export default () => {};");
  const profile = { schemaVersion: 1, profile: { name: "x", generatedAt: "2026-08-25T00:00:00.000Z", pi: { agentDirectory: "/tmp/a" } }, packages: [{ id: "package:npm:tools", name: "tools", scope: "global", installedPath: "/tmp/a/npm/tools", source: { kind: "npm", spec: "npm:tools@1.0.0", name: "tools", version: "1.0.0" } }], skills: [], extensions: [{ id: "extension:x", name: "x", scope: "local", projectRoot: "/old", installedPath: "/old/.pi/extensions/x.ts", source: { kind: "local-path", path: source } }] };
  const actions = await planRestore(profile, { projectRoot: "/new" });
  assert.deepEqual(actions.map(a => a.kind), ["pi-install", "settings-extension"]);
  assert.equal(actions[0]?.args.join(" "), "install npm:tools@1.0.0");
  assert.equal(actions[1]?.projectRoot, "/new");
});

test("reports rather than substitutes a missing local path", async () => {
  const profile = { schemaVersion: 1, profile: { name: "x", generatedAt: "2026-08-25T00:00:00.000Z", pi: { agentDirectory: "/tmp/a" } }, packages: [], skills: [{ id: "skill:missing", name: "missing", scope: "global", installedPath: "/tmp/a/skills/missing", source: { kind: "local-path", path: "/does-not-exist" } }], extensions: [] };
  const actions = await planRestore(profile, {});
  assert.equal(actions[0]?.kind, "missing-local-source");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern "plans global|missing local"`

Expected: FAIL because `src/restore.ts` does not exist.

- [ ] **Step 3: Implement Pi subprocess adapter**

```ts
export interface CommandResult { code: number; stdout: string; stderr: string; }
export async function runPi(args: string[], options: { piPath?: string; env?: NodeJS.ProcessEnv; cwd?: string }): Promise<CommandResult>;
export async function confirm(message: string, options: { yes: boolean; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }): Promise<boolean>;
```

Implement `runPi` using `spawn(options.piPath ?? "pi", args, { shell: false, cwd: options.cwd, env: options.env })`, collect UTF-8 stdout/stderr, and resolve its exit code. `confirm` immediately returns true for `yes`; otherwise write `${message} [y/N] ` and accept only a trimmed, case-insensitive `y` or `yes` line.

```ts
```

Reject a nonzero Pi exit by throwing an error that includes quoted args, exit code, stdout, and stderr. Do not put source strings in a shell command.

- [ ] **Step 4: Implement deterministic restore actions**

```ts
export type RestoreAction =
 | { kind: "pi-install"; args: string[]; scope: Scope }
 | { kind: "settings-skill" | "settings-extension"; settingsPath: string; value: string; projectRoot?: string }
 | { kind: "already-present"; id: string }
 | { kind: "missing-local-source"; id: string; path: string };
```

Filter `--only` using `extension` for a user request of `plugin`; ensure package installs are deduplicated by `sourceIdentity`; add `-l` only for local package actions. Before a top-level path action, test source existence. Apply project-root remapping only when `--project` is present.

- [ ] **Step 5: Add fake-Pi execution/dry-run tests**

```ts
test("dry-run does not invoke Pi", async () => {
  const { path, log } = await createFakePi(await makeTempDir());
  const summary = await executeRestore([{ kind: "pi-install", args: ["install", "npm:tools"], scope: "global" }], { dryRun: true, piPath: path, yes: true });
  assert.equal(summary.installed, 0);
  await assert.rejects(readFile(log, "utf8"));
});
```

Add a non-dry-run test asserting `install npm:tools` is logged, one failure test continuing after an independent error, and one setting-write test.

Run: `npm test -- --test-name-pattern "restore|dry-run|fake"`

Expected: PASS.

- [ ] **Step 6: Commit installation and restoration**

```bash
git add src/pi-command.ts src/restore.ts test/restore.test.ts
git commit -m "feat: restore pi profiles through pi install"
```

## Task 6: Load the collection catalog and orchestrate list/install/remove/add

**Files:**
- Create: `src/catalog.ts`
- Create: `src/commands.ts`
- Create: `test/commands.test.ts`
- Modify: `catalog.yml`

**Interfaces:**
- Produces `loadCatalog(path): Promise<Catalog>` and `matchCatalog(catalog, scan): CatalogStatus[]`.
- Produces `listCollection`, `installCatalogEntries`, `removeCatalogEntries`, and `addSource`.

- [ ] **Step 1: Write failing catalog matching tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { matchCatalog } from "../src/catalog.js";

test("marks a matching catalog entry installed", () => {
  const statuses = matchCatalog({ schemaVersion: 1, entries: [{ name: "tools", type: "package", source: "npm:tools@1.0.0" }] }, { packages: [{ type: "package", name: "tools", source: { kind: "npm", spec: "npm:tools@1.0.0", name: "tools", version: "1.0.0" } }], skills: [], extensions: [] } as never);
  assert.deepEqual(statuses.map(s => [s.installed, s.entry.name]), [[true, "tools"]]);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --test-name-pattern "matching catalog"`

Expected: FAIL because `src/catalog.ts` does not exist.

- [ ] **Step 3: Implement catalog schema and matching**

```ts
export const catalogSchema = z.object({ schemaVersion: z.literal(1), entries: z.array(z.object({ name: z.string(), type: z.enum(["package", "skill", "plugin"]), source: z.string(), description: z.string().optional(), expectedResource: z.string().optional() })) });
export function matchCatalog(catalog: Catalog, scan: ScanResult): CatalogStatus[];
```

Parse each entry source with `parsePiSource`. A package matches a scanned package with identical `sourceIdentity`. A skill/plugin first requires that package match, then requires a scanned skill/extension with `ownerPackageId` equal to the matched package id and `name` equal to `expectedResource ?? entry.name`.

```ts
```

For type `package`, match the normalized source identity. For `skill` and `plugin`, match a package source and a derived skill/extension whose name equals `expectedResource ?? name`. Keep the repository catalog empty until maintainers add reviewed sources.

- [ ] **Step 4: Write and implement add/install/remove orchestration tests**

```ts
test("adds only a source that supplies the requested skill", async () => {
  const result = await addSource("npm:tools", { expectedType: "skill", dryRun: true, yes: true }, deps);
  assert.equal(result.validation, "pending-rescan");
});

test("rejects an unsupported add source before Pi is invoked", async () => {
  await assert.rejects(addSource("tools", { dryRun: false, yes: true }, deps), /Pi-supported source/);
});
```

Implement `addSource` as parse → confirm → Pi install → re-scan → type assertion. Implement catalog installation and removal with exact selected names, `--full`, confirmation, and source-aware Pi arguments. Removal maps to `pi remove <source>` and local removal maps to `pi remove -l <source>`.

- [ ] **Step 5: Run commands tests**

Run: `npm test -- --test-name-pattern "catalog|adds|remove|install"`

Expected: PASS.

- [ ] **Step 6: Commit catalog orchestration**

```bash
git add catalog.yml src/catalog.ts src/commands.ts test/commands.test.ts
git commit -m "feat: manage collection catalog entries"
```

## Task 7: Expose all commands through the CLI with required checklist output

**Files:**
- Modify: `src/cli.ts`
- Modify: `test/cli.test.ts`

**Interfaces:**
- `pi-collection list`, `install`, `remove`, `add`, `profile scan`, `profile show`, and `profile restore` invoke the Task 6 orchestration functions.
- Produces `renderChecklist(statuses, full): string`.

- [ ] **Step 1: Write failing output and argument tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { renderChecklist } from "../src/cli.js";

test("renders missing and installed entries with required brackets", () => {
  assert.equal(renderChecklist([{ installed: true, entry: { type: "package", name: "tools" } }, { installed: false, entry: { type: "plugin", name: "team" } }] as never, false), "[v] package tools\n[ ] plugin team");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern "required brackets"`

Expected: FAIL because `renderChecklist` is not exported.

- [ ] **Step 3: Implement Commander command definitions**

```ts
program.command("list").option("--full").option("--type <type>").option("--json");
program.command("install [names...]").option("--full").option("--type <type>").option("--yes");
program.command("remove <names...>").option("--type <type>").option("--yes");
program.command("add <source>").option("--local").option("--type <type>").option("--dry-run").option("--yes");
const profile = program.command("profile");
profile.command("scan").option("--output <path>").option("--project <path>");
profile.command("show <path>");
profile.command("restore <path>").option("--dry-run").option("--only <type>").option("--project <path>").option("--yes");
```

Validate type option values before invoking domain code. Default `profile scan --output` to `pi-profile.yml`. Return exit code 1 after action summaries containing failures. Keep `list --json` as JSON only; no status prefixes or prose.

- [ ] **Step 4: Add subprocess-level CLI tests using the fake Pi executable**

```ts
test("profile restore dry-run prints actions without calling Pi", async () => {
  const result = await runCli(["profile", "restore", profilePath, "--dry-run", "--yes"], { PI_CODING_AGENT_DIR: agentDir, PATH: fakeBin });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /pi install npm:tools/);
});
```

Test list filtering, `--full` details, `add --type plugin` success/failure, default global install args, and local `-l` args.

- [ ] **Step 5: Run all static checks and tests**

Run: `npm run check && npm test && npm run build`

Expected: all commands exit 0 and every test passes.

- [ ] **Step 6: Commit the completed CLI**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat: expose pi collection commands"
```

## Task 8: Document installation, source safety, profile portability, and command use

**Files:**
- Create: `README.md`
- Modify: `package.json`
- Create: `test/readme.test.ts`

**Interfaces:**
- README documents every public command and identifies `plugin` as the CLI name for Pi extensions.
- Package exposes a runnable `pi-collection` binary after `npm run build`.

- [ ] **Step 1: Write a failing documentation contract test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("README documents profile restore and source safety", async () => {
  const text = await readFile("README.md", "utf8");
  assert.match(text, /pi-collection profile restore/);
  assert.match(text, /review source code before installing/i);
  assert.match(text, /local paths.*must exist/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern "README documents"`

Expected: FAIL because `README.md` does not exist.

- [ ] **Step 3: Write README usage and safety documentation**

Include install/build commands, each CLI command with an example, exact checklist meanings, `--full`, `--dry-run`, `--yes`, the YAML profile example from the specification, global versus local scope, source formats, Pi's arbitrary-code warning, and missing-local-path restore behavior. State that npm/Git package installation is delegated to `pi install`.

- [ ] **Step 4: Run final verification**

Run: `npm run check && npm test && npm run build && node dist/cli.js --help`

Expected: typecheck, tests, and build pass; help lists `list`, `install`, `remove`, `add`, and `profile`.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md test/readme.test.ts package.json
git commit -m "docs: document pi collection usage"
```

## Plan self-review

- **Spec coverage:** Tasks 2–3 cover documented sources and paths; Task 6 covers the `[v]`/`[ ]` collection plus full install; Tasks 4–5 cover versioned scanning/restoration profiles, global/local provenance, path validation, atomic writes, and dry runs; Task 7 covers every required command; Task 8 covers operational and security guidance.
- **Placeholder scan:** No implementation placeholder terms or deferred tasks remain. Every task names files, tests, commands, interfaces, and commit boundaries.
- **Type consistency:** Public resource type is `extension` in domain/profile modules and `plugin` only at command/catalog boundaries. `Scope`, `Source`, `ScanResult`, `Profile`, and `RestoreAction` are introduced before consumers.
