# Pi Collection Utility — Design

## Purpose

`pi-collection` is a standalone Node.js CLI for managing a curated collection of Pi packages, skills, and extensions (called `plugin` in its user-facing commands). It lists availability, installs selected or all catalog entries into Pi, snapshots the current Pi setup into a portable profile, and restores a profile.

The utility delegates package installation to Pi instead of reimplementing npm or Git behavior.

## Scope

- Display the collection with `[v]` for detected and `[ ]` for missing entries.
- Install catalog entries globally by default, or project-locally when explicitly requested.
- Add arbitrary Pi-supported package sources.
- Scan global and project-local Pi resources into a profile.
- Restore package, skill, and extension references from a profile.

It does not copy source code into profiles, publish packages, or replace Pi's trust/security workflow.

## Pi resource model

Pi's documented locations and source of truth determine the scanner:

| Resource | Global | Project-local | Notes |
|---|---|---|---|
| Package, npm | `~/.pi/agent/npm/` | `.pi/npm/` | Installed through `pi install npm:...` |
| Package, Git | `~/.pi/agent/git/` | `.pi/git/` | Installed through `pi install git:...` |
| Package registration | `~/.pi/agent/settings.json` | `.pi/settings.json` | `packages` list is the authoritative installed-source list |
| Skill | `~/.pi/agent/skills/`, `~/.agents/skills/` | `.pi/skills/`, `.agents/skills/` | Packages and settings can also provide skills |
| Extension (plugin) | `~/.pi/agent/extensions/` | `.pi/extensions/` | Settings can add extension paths; package resources may provide extensions |

The CLI calls this last resource type `plugin` for ergonomic commands, but profiles persist its canonical type as `extension`.

## Commands

```text
pi-collection list [--full] [--type package|skill|plugin] [--json]
pi-collection install <name...> [--type package|skill|plugin]
pi-collection install --full
pi-collection remove <name...> [--type package|skill|plugin]

pi-collection add <source> [--local] [--type package|skill|plugin] [--dry-run]

pi-collection profile scan [--output <profile.yml>] [--project <path>]
pi-collection profile show <profile.yml>
pi-collection profile restore <profile.yml> [--dry-run] [--only package|skill|plugin] [--project <path>]
```

### List and install

The catalog is a version-controlled manifest that maps a stable entry name to one Pi package source and metadata. `list` evaluates every catalog entry against the current scan and prints one line per entry:

```text
[v] package @acme/pi-tools
[ ] skill review-workflow
[v] plugin team-tools
```

`--full` includes every collection item with scope, source, installed paths, and version/ref. Without it, output remains a concise checklist. `install --full` installs every catalog entry using the global scope.

The repository owns `catalog.yml`, a versioned manifest whose entries contain `name`, `type` (`package`, `skill`, or `plugin`), Pi package `source`, optional display description, and optional expected resource name. Catalog entries do not duplicate installed-state data; the scanner supplies that data.

### Add

`add` accepts only Pi-supported source syntax: `npm:...`, `git:...`, accepted Git protocol URL, or a local path. It runs Pi directly:

```text
pi install <source>
pi install -l <source>  # with --local
```

After a successful install, the utility rescans resources. `--type` is an assertion about discovered contents: a requested `skill` must supply at least one skill and a requested `plugin` must supply at least one extension. It never runs a custom Git clone or `npm install` itself.

## Profile format

Profiles are YAML and versioned for forward-compatible migrations. They record external references and provenance, not package or skill contents.

```yaml
schemaVersion: 1
profile:
  name: workstation
  generatedAt: 2026-08-25T10:30:00Z
  pi:
    agentDirectory: /Users/alex/.pi/agent
    version: 0.52.0

packages:
  - id: package:npm:@acme/pi-tools
    name: "@acme/pi-tools"
    scope: global
    source:
      kind: npm
      spec: npm:@acme/pi-tools@1.2.3
    installedPath: /Users/alex/.pi/agent/npm/@acme/pi-tools
    version: 1.2.3

  - id: package:git:github.com/acme/pi-tools
    name: pi-tools
    scope: local
    projectRoot: /Users/alex/projects/app
    source:
      kind: git
      spec: git:github.com/acme/pi-tools@91fe33a
      url: https://github.com/acme/pi-tools
      ref: 91fe33a
    installedPath: /Users/alex/projects/app/.pi/git/github.com/acme/pi-tools

skills:
  - id: skill:review-workflow
    name: review-workflow
    scope: global
    source:
      kind: local-path
      path: /Users/alex/.pi/agent/skills/review-workflow
    installedPath: /Users/alex/.pi/agent/skills/review-workflow

extensions:
  - id: extension:company-tools
    name: company-tools
    scope: local
    projectRoot: /Users/alex/projects/app
    source:
      kind: local-path
      path: /Users/alex/projects/company-tools/pi-extension.ts
    installedPath: /Users/alex/projects/app/.pi/extensions/company-tools.ts
```

### Profile rules

- Every entry has an explicit `scope`: `global` or `local`.
- `installedPath` is the scanner's observed location. `source` is what restoration uses.
- npm sources use an exact `spec`; Git sources record a pinned ref whenever one is available.
- Entries discovered inside a package retain their package provenance. Restore installs the owning package once rather than copying each supplied skill or extension.
- Independently discovered top-level skills/extensions use a `local-path` source. Restore verifies the path exists. A path already in a documented auto-discovery directory needs no settings change; any other discovered configured path is restored by atomically updating the matching Pi `skills` or `extensions` array in global or project `settings.json`.
- Local profiles are portable only when their referenced paths exist on the destination. Restore reports missing paths and continues with other entries; it does not silently substitute a different source.
- `projectRoot` is required for local entries. `profile restore --project <path>` remaps the project root deliberately; no implicit mapping occurs.

## Scanning and detection

The scanner reads Pi global settings plus optional project settings, then examines their configured package, skill, and extension sources. It also discovers top-level documented skill/extension folders. It resolves paths, canonicalizes existing symlinks, and deduplicates resources by Pi's identity rules:

- npm: package name
- Git: repository URL without ref
- local: resolved absolute path

Detection compares catalog source identity and resource type against this normalized scan. Package-managed resources are represented both under their owning package and as derived skills/extensions so `list --type skill` and `list --type plugin` answer accurately.

## Restore

Restore validates `schemaVersion` and every entry before changing anything. It proceeds in dependency-safe order:

1. Install package entries with `pi install` or `pi install -l`.
2. Re-scan so package-provided skills and extensions become available.
3. Restore top-level skill and extension paths where their original configuration supports it.
4. Print a summary of installed, already-present, skipped, and failed entries.

`--dry-run` performs the same validation and prints the proposed Pi commands and filesystem/settings actions without modifying the environment. `--only` filters on package, skill, or plugin (`extension` internally).

## Safety and errors

- The tool does not install an unrecognized source format.
- It propagates Pi installer failures with the executed command and exit status.
- It warns that packages, skills, and extensions can execute arbitrary code, and requires an interactive confirmation before non-dry-run install/restore unless a future `--yes` flag is provided.
- It writes profiles atomically: temporary sibling file, fsync/close, then rename.
- Invalid YAML, unsupported schema versions, missing local paths, unavailable `pi`, and inaccessible settings produce actionable errors and nonzero exit codes.
- Restore is best-effort across independent entries and exits nonzero if any requested entry fails.

## Testing

Unit tests cover source parsing, catalog matching, scope normalization, profile schema validation/migration, YAML serialization, and restore planning. Integration tests use a temporary Pi agent directory (`PI_CODING_AGENT_DIR`) plus a fake `pi` executable to assert commands, scopes, failure reporting, idempotence, and dry-run behavior. Fixture trees cover npm/Git packages, top-level skills, top-level extensions, package-derived resources, and missing local-path references.
