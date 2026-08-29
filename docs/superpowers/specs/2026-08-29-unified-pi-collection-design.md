# Unified Pi Collection — Design

## Purpose

Refactor `pi-collection` around one portable `pi-collection.yml` file and three commands:

```text
pi-collection scan
pi-collection add [source] [--scan]
pi-collection install [--dry-run] [--yes]
```

The file records both resources discovered on a computer and package sources deliberately added by a user. It preserves provenance, supports dependency-safe installation, and drives an interactive grouped selection TUI.

This is a breaking command and file-format redesign. `catalog.yml`, `pi-profile.yml`, schema version 1, and the old `list`, `remove`, and `profile` command surfaces are not supported or migrated.

## Command interface

### `scan`

`pi-collection scan` is read-only. It scans global Pi resources and optionally project-local resources when a project option is supplied, then prints every detected package, skill, and plugin:

```text
[v] package @andrewjacop/pi-herdr
[v] skill test-driven-development
[v] plugin tdd-herdr
```

It does not create or modify `pi-collection.yml`.

### `add`

`pi-collection add` with no source is equivalent to `pi-collection add --scan`.

`add --scan`:

1. Scans the current computer.
2. Reads `pi-collection.yml` when it exists, otherwise starts an empty collection.
3. Adds or updates discovered package, skill, and plugin resources with `origins: [scan]`.
4. Merges origins when a matching manual resource already exists.
5. Writes the file atomically.

Scan merge is non-destructive: resources absent from the latest computer scan remain in the collection. Automatic pruning is outside the initial scope.

`add <source>` validates one Pi-supported npm, Git, URL, or local-path source and saves it as a package with `origins: [manual]`. It does not download or install the source. Because an uninstalled source cannot be inspected safely, child skills and plugins are unknown until after installation and a later `add --scan`.

A source argument and `--scan` are mutually exclusive.

### `install`

`pi-collection install` reads `pi-collection.yml`, scans the destination computer, and opens an interactive grouped TUI by default.

- `--dry-run` performs selection and planning but makes no changes.
- `--yes` skips the TUI and installs the default-selected resources.
- A non-interactive terminal without `--yes` fails with an actionable message.

Default selection includes resources with the `scan` origin. Manual-only resources start unchecked. There is no `--tui` flag because TUI mode is already the default.

## Schema version 2

```yaml
schemaVersion: 2
collection:
  name: workstation
  updatedAt: 2026-08-29T10:00:00.000Z
resources:
  - id: package:git:github.com/obra/superpowers
    type: package
    name: superpowers
    origins: [scan, manual]
    scope: global
    source:
      kind: git
      spec: git:github.com/obra/superpowers
      url: github.com/obra/superpowers
    installedPath: /Users/alex/.pi/agent/git/github.com/obra/superpowers

  - id: skill:package:git:github.com/obra/superpowers:brainstorming
    type: skill
    name: brainstorming
    origins: [scan]
    scope: global
    ownerPackageId: package:git:github.com/obra/superpowers
    source:
      kind: git
      spec: git:github.com/obra/superpowers
      url: github.com/obra/superpowers
    installedPath: /Users/alex/.pi/agent/git/github.com/obra/superpowers/skills/brainstorming
```

Each resource contains:

- `id`: stable identity.
- `type`: canonical `package`, `skill`, or `extension`; terminal output uses `plugin` for extensions.
- `name`: display/resource name.
- `origins`: unique, non-empty subset of `scan` and `manual`.
- `scope`: `global` or `local`.
- `source`: restoration source.
- `ownerPackageId`: required for package-owned skills/extensions.
- `projectRoot`: required for local scanned resources.
- `installedPath`: observed scan location; optional for uninstalled manual packages.

The schema rejects unknown schema versions, invalid source objects, empty origins, local scanned entries without a project root, and child references to nonexistent package entries.

## Identity and merge rules

- npm packages: package name.
- Git packages: normalized repository URL without ref.
- Local packages: canonical absolute source path.
- Package-owned children: resource type + owner package identity + resource name.
- Independent skills/extensions: resource type + normalized source identity + resource name.

Merging never emits duplicate resources. When scan and manual records match:

- `origins` becomes `[scan, manual]` in stable order.
- The scanned record refreshes the exact restoration source and observed fields such as `installedPath`, scope, and project root.
- Manual provenance remains represented by the `manual` origin tag.
- Package ownership relationships remain intact.

## Install TUI

```text
┌─ Install Pi Resources ───────────────────────────────┐
│ File: pi-collection.yml                              │
│                                                     │
│ [x] package superpowers                  scan        │
│     [x] skill brainstorming                          │
│     [x] skill test-driven-development                │
│     [x] plugin superpowers                           │
│                                                     │
│ [ ] package company-tools                manual      │
│                                                     │
│ Selected: 4                                         │
│                                                     │
│ ↑/↓ Move   Space Toggle   A All   N None             │
│ Enter Install              Esc Cancel                │
└─────────────────────────────────────────────────────┘
```

Keyboard behavior:

- Up/down moves the cursor.
- Space toggles the current resource.
- Toggling a package toggles all displayed children.
- Children can be toggled independently.
- A package displays `[-]` when only some children are selected.
- Selecting a child always includes its owning package in the installation plan.
- `A` selects all installable resources; `N` selects none.
- Enter confirms; Escape cancels without mutation.

Already-present resources remain visible and produce no install action. Missing local sources are visible but disabled with an explanation. The terminal cursor, raw mode, and screen state are restored on success, cancellation, signals, and errors.

## Architecture

### `collection.ts`

Owns the schema-v2 Zod model, YAML serialization, atomic writes, normalized identity, empty collection creation, and resource merge operations.

### `selection.ts`

A pure state model that creates package/child groups, computes checked/unchecked/partial parent states, applies toggles, and converts selected rows into dependency-safe resource IDs. It performs no terminal I/O.

### `tui.ts`

Uses Node `readline.emitKeypressEvents` and terminal escape sequences. It renders selection state and maps key events to the pure selection model. No React or large TUI framework is introduced.

### `commands.ts`

Coordinates scan, add, and install behavior. It delegates npm/Git/local installation to `pi install`; it does not implement package installation itself.

### `cli.ts`

Contains only Commander argument definitions, rendering adapters, dependency wiring, and exit-code handling.

## Install planning and execution

1. Read and validate `pi-collection.yml`.
2. Scan current Pi resources.
3. Build selection groups and default selection.
4. Obtain selection through TUI, or use default scan-origin selection with `--yes`.
5. Convert selected children to their owning package dependencies.
6. Remove already-present resources from the mutation plan.
7. Validate local source existence.
8. Install selected packages with `pi install` or `pi install -l` in dependency-safe order.
9. Re-scan after package installation.
10. Restore independently sourced top-level skills/extensions through documented settings paths when needed.
11. Print installed, already-present, skipped, and failed summaries with Pi command diagnostics.

Independent failures are best-effort: later resources continue, and any failure makes the command exit nonzero.

## Safety and errors

- All collection writes use sibling temporary files, fsync/close, and atomic rename.
- Unsupported sources are rejected before file mutation or Pi execution.
- `add` never installs code.
- `install` requires TUI confirmation or explicit `--yes`.
- Local paths are never copied or guessed.
- Invalid files, missing local paths, unavailable Pi, inaccessible settings, non-interactive TUI attempts, and Pi failures produce actionable nonzero errors.
- Packages, skills, and extensions can execute arbitrary code; documentation keeps the source-review warning.

## Testing

Unit tests cover:

- Schema-v2 validation and serialization.
- Resource identities and origin merging.
- Non-destructive scan merges.
- Manual package creation.
- Parent/child/partial selection transitions.
- Dependency-safe selected IDs.
- Already-present and local-path planning.

Integration tests cover:

- `scan` read-only behavior.
- `add` defaulting to scan mode.
- `add --scan` file creation and merge.
- `add <source>` manual save without Pi invocation.
- Fake-input TUI navigation, package toggles, individual child toggles, confirm, and cancel.
- Non-interactive install rejection and `--yes` behavior.
- Fake Pi execution, local scope, dry-run, failure diagnostics, and post-install re-scan.
- Executable and npm-symlink CLI invocation.
