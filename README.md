# Pi Resource Manager

`pi-resource-manager` catalogs a reviewed set of Pi packages, skills, and extensions. The CLI calls Pi for package installation and removal; it never runs `npm install` or clones Git repositories itself. In command output and options, Pi extensions are called **plugins**.

## Install

```sh
npm install
npm run build
node dist/cli.js --help
```

The package exposes the `pi-resource-manager` binary after `npm run build` when installed through npm.

## Safety

Packages, skills, and plugins can execute arbitrary code. **Review source code before installing** a source, including its dependencies and Git revision. The CLI accepts only source formats Pi supports:

- `npm:<package>` or `npm:<package>@<version>`
- `git:<repository>` or `git:<repository>@<ref>`
- `https:`, `http:`, or `ssh:` Git URLs
- absolute paths and `./` or `../` local paths

Package installation is delegated to `pi install`; removal is delegated to `pi remove`. Non-dry-run `install`, `remove`, `add`, and profile restore operations ask for confirmation. Pass `--yes` only after reviewing the requested action.

## Collection commands

```text
pi-resource-manager list [--full] [--type package|skill|plugin] [--json]
pi-resource-manager install [names...] [--full] [--type package|skill|plugin] [--yes]
pi-resource-manager remove <names...> [--type package|skill|plugin] [--yes]
pi-resource-manager add <source> [--local] [--type package|skill|plugin] [--dry-run] [--yes]
```

`list` renders `[v]` for an installed catalog entry and `[ ]` for an unavailable entry. Use `--full` to include the source and description; use `--json` when a program consumes the status.

Examples:

```sh
pi-resource-manager list
pi-resource-manager list --type plugin --full
pi-resource-manager install review-workflow --yes
pi-resource-manager install --full --yes
pi-resource-manager remove review-workflow --yes
pi-resource-manager add npm:@acme/pi-tools@1.2.3 --type plugin --yes
pi-resource-manager add ./my-local-pi-package --local --dry-run
```

The catalog is version controlled in `catalog.yml`. `add` is for a source outside that catalog: after Pi installs it, the command rescans Pi and verifies a requested `--type` assertion.

## Profiles

```text
pi-resource-manager profile scan [--output <profile.yml>] [--project <path>]
pi-resource-manager profile show <profile.yml>
pi-resource-manager profile restore <profile.yml> [--dry-run] [--only package|skill|plugin] [--project <path>] [--yes]
```

`profile scan` writes `pi-profile.yml` by default. It records references and observed provenance, not package source code. Profiles use schema version 1:

```yaml
schemaVersion: 1
profile:
  name: workstation
  generatedAt: 2026-08-25T10:30:00.000Z
  pi:
    agentDirectory: /Users/alex/.pi/agent
    version: 0.52.0
packages:
  - id: package:npm:@acme/pi-tools
    name: "@acme/pi-tools"
    scope: global
    installedPath: /Users/alex/.pi/agent/npm/@acme/pi-tools
    source:
      kind: npm
      spec: npm:@acme/pi-tools@1.2.3
      name: "@acme/pi-tools"
      version: 1.2.3
skills: []
extensions: []
```

Global resources use `~/.pi/agent`; local resources use a project’s `.pi` directory. `profile restore` installs package references first, then restores independent skill/plugin settings. `--dry-run` prints planned actions without running Pi or changing settings. `--only plugin` filters the canonical `extension` resources.

Profiles intentionally do not copy local source code. For restore, local paths **must exist** at restore time; a missing local source is reported and restoration continues with independent entries. Use `--project <path>` to deliberately remap local profile entries to another project—there is no implicit project-root remapping.
