# Pi Collection

`pi-collection` captures a reviewed collection of [Pi](https://github.com/badlogic/pi-mono) packages, skills, and extensions, then installs selected resources through Pi.

## Install and build

Node.js 20 or later is required. An installed, runnable `pi` command is required only for installation.

```sh
npm install
npm run build
node dist/cli.js --help
```

To use the binary from a checkout:

```sh
npm link
pi-collection --help
```

## Commands

`pi-collection` has exactly three commands: `scan`, `add`, and `install`.

### Scan

```sh
pi-collection scan
pi-collection scan --project ~/projects/app
```

`scan` is read-only: it reports resources Pi currently discovers and does not create or modify `pi-collection.yml`.

### Add

```sh
pi-collection add --scan
pi-collection add npm:@acme/pi-tools
pi-collection add git:github.com/acme/pi-tools@91fe33a
pi-collection add ./company-tools
```

`add` defaults to scanning the current Pi setup, so `pi-collection add` and `pi-collection add --scan` save discovered resources with the `scan` origin. Pass one manual Pi source to save a package with the `manual` origin instead. Manual sources support Pi's `npm:`, Git, and local-path forms.

Adding only records resources in `pi-collection.yml`; it does **not** install anything. An existing collection is updated with a non-destructive merge: saved resources remain, matching resources combine their origins, and new discoveries are added.

### Install

```sh
pi-collection install
pi-collection install --dry-run --yes
```

`install` loads `pi-collection.yml`, scans the destination, and opens a selection TUI. Resources with the `scan` origin are selected by default; manually added resources are initially unselected. Package-owned skills and extensions are grouped beneath their package.

TUI keys: `↑/↓ Move`, `Space Toggle`, `A All`, `N None`, `Enter Install`, `Esc Cancel`.

`--dry-run` prints the Pi and settings actions without changing Pi or settings. `--yes` accepts the default selection without opening the TUI; use `--yes` for CI and other non-interactive automation.

## Collection format

The only supported format is the schema-v2 `pi-collection.yml` file. There is no legacy YAML support.

```yaml
schemaVersion: 2
collection:
  name: workstation
  updatedAt: 2026-08-29T10:30:00.000Z
resources:
  - id: package:npm:@acme/pi-tools
    type: package
    name: "@acme/pi-tools"
    origins:
      - scan
      - manual
    scope: global
    source:
      kind: npm
      spec: npm:@acme/pi-tools@1.2.3
      name: "@acme/pi-tools"
      version: 1.2.3
    installedPath: $HOME/.pi/agent/npm/@acme/pi-tools
  - id: skill:owner:package:npm:@acme/pi-tools:review
    type: skill
    name: review
    origins:
      - scan
    scope: global
    ownerPackageId: package:npm:@acme/pi-tools
    source:
      kind: npm
      spec: npm:@acme/pi-tools@1.2.3
      name: "@acme/pi-tools"
```

`origins` records whether each resource came from `scan`, manual addition, or both. Package-owned children retain `ownerPackageId`, so installation delegates to their owner package once.

Paths beneath the user's home directory are stored with the portable `$HOME` prefix. This applies to `installedPath`, `projectRoot`, local `source.path`, and path-bearing IDs/owner references. When the collection is read, `$HOME` expands to the current computer's home directory before scanning or installation. Paths outside the home directory remain absolute.

## Safety

Pi packages, skills, and extensions can execute arbitrary code. Review any source before installation, including npm, Git, and local paths. `--yes` bypasses the interactive selection safeguard, so use it only for intentional, reviewed automation.

`pi-collection` delegates package installation to `pi install`. It does not run its own `npm install`, clone Git repositories, or execute a supplied source. Use `pi-collection install --dry-run` to inspect the planned actions first.
