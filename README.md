# Pi Collection

`pi-collection` manages a reviewed collection of [Pi](https://github.com/badlogic/pi-mono) packages, skills, and extensions. The CLI calls Pi extensions **plugins**; profile files retain Pi's canonical `extension` name.

## Install and build

This repository requires Node.js 20 or later and an installed, runnable `pi` command for operations that change Pi.

```sh
npm install
npm run build
node dist/cli.js --help
```

The build creates the `dist/cli.js` target for the package's `pi-collection` binary. To make that binary available from a checkout, link the built package:

```sh
npm link
pi-collection --help
```

## Commands

Run commands from a directory containing the repository's `catalog.yml` when using the collection catalog.

### List catalog entries

```sh
pi-collection list
pi-collection list --type plugin
pi-collection list --full
pi-collection list --json
```

The normal checklist has one entry per catalog item:

- `[v]` means a matching resource was detected in the current Pi scan.
- `[ ]` means the catalog item was not detected.

`--full` adds the catalog source and description, plus detected installation scope and path. `--json` writes only JSON, for scripts. `--type` accepts `package`, `skill`, or `plugin` (not Pi's internal `extension`).

### Install catalog entries

```sh
pi-collection install review-workflow --type skill
pi-collection install --full --yes
```

Pass one or more catalog names to install them, or use `--full` to install every catalog entry. Catalog installs are global by default. `--type package|skill|plugin` narrows the selected catalog type. Installation asks for confirmation unless `--yes` is supplied.

### Remove catalog entries

```sh
pi-collection remove review-workflow --type skill
pi-collection remove review-workflow --yes
```

Removal uses the source and scope detected by the Pi scan. It asks for confirmation unless `--yes` is supplied.

### Add a Pi source

```sh
pi-collection add npm:@acme/pi-tools --type plugin
pi-collection add ./company-tools --local --yes
pi-collection add git:github.com/acme/pi-tools@91fe33a --dry-run
```

`add` accepts only Pi-supported sources:

- npm: `npm:<package>` or `npm:<package>@<version>`
- Git shorthand: `git:<repository>` with an optional ref
- Git URLs using `https:`, `http:`, `ssh:`, or `git:`
- absolute paths and paths beginning with `./` or `../`

`--local` selects Pi's project-local scope; otherwise the source is global. `--type package|skill|plugin` verifies after installation that the package supplied the requested kind of resource. `--dry-run` prints the requested add operation without changing Pi. `--yes` bypasses the confirmation prompt.

### Scan and inspect a profile

```sh
pi-collection profile scan
pi-collection profile scan --output workstation.yml --project ~/projects/app
pi-collection profile show workstation.yml
```

`profile scan` writes `pi-profile.yml` by default. Use `--output` to choose another YAML file and `--project` to include project-local Pi resources. `profile show` prints a validated profile as YAML.

### Restore a profile

```sh
pi-collection profile restore workstation.yml --dry-run
pi-collection profile restore workstation.yml --only plugin --project ~/projects/app --yes
```

Restore first plans package operations, then restores independent skill and plugin paths. `--dry-run` validates the profile and prints the Pi and settings operations without modifying Pi. `--only package|skill|plugin` filters what is restored. `--project` deliberately remaps local entries to a destination project; without it, a profile's recorded project root is used. Restore prompts before changes unless `--yes` is supplied, prints a summary, and exits nonzero when any requested entry fails.

## Scope and profiles

Global is the default Pi scope. Global packages are installed under Pi's agent directory; local packages are installed under a project's `.pi/` directory and use Pi's `-l` install flag. Profiles record the scope, observed `installedPath`, restoration source, and `projectRoot` for every local resource. They record references and provenance, not a copy of package or skill source code.

The versioned YAML profile format is:

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

Profiles are portable for npm and Git references, including recorded Git refs. Local paths are machine-specific: **local paths must exist** on the destination for restore to use them. If a local source is missing, restore reports that failure, continues with independent entries, and never guesses or substitutes a different path.

## Safety

Pi packages, skills, and plugins can execute arbitrary code. Review source code before installing any source, including code from npm, Git, or a local path. `--yes` disables the interactive confirmation safeguard, so use it only in an intentional, reviewed automation flow.

`pi-collection` delegates npm and Git package installation to `pi install` (and removal to `pi remove`). It does not run its own `npm install`, Git clone, or shell command for a supplied source. Use `--dry-run` for `add` and `profile restore` to inspect planned changes first.
