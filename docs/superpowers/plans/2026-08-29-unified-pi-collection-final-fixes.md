# Unified Pi Collection Final Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development. Inline execution only; no subagents.

**Goal:** Close the final review’s install-scan, Git identity, TUI lifecycle, scan identity, and schema-validation gaps.

**Architecture:** Keep normalization in the existing source/collection boundaries, aggregate install scans in the CLI orchestration, and keep TUI signal lifecycle local to the TUI. No dependencies or new abstractions.

**Tech Stack:** Node.js, TypeScript, Zod, node:test.

**Spec:** `docs/superpowers/specs/2026-08-29-unified-pi-collection-design.md`

## Global Constraints

- Add each regression before its implementation and observe its expected failure.
- `projectRoot` is resolved before scans and persistence.
- Git repository identity ignores supported transport/user/trailing-slash/`.git` variations, not refs.
- TUI cleanup covers success, error, cancellation, and injected SIGINT/SIGTERM/SIGHUP.

---

### Task 1: Collection identities and validation

**Files:** `test/collection.test.ts`, `test/sources.test.ts`, `src/collection.ts`, `src/sources.ts`, `src/selection.ts`

- [ ] Add regressions for equivalent Git forms, canonical scanned child IDs/remapped owners, duplicate IDs, and non-package owners.
- [ ] Run focused collection/source tests and observe failures from raw Git IDs and permissive schema.
- [ ] Normalize Git identity, derive all scanned/merged IDs from canonical identity, and validate ownership graph.
- [ ] Re-run focused tests.

### Task 2: Canonical local install scan aggregation

**Files:** `test/cli.test.ts`, `test/commands.test.ts`, `src/cli.ts`, `src/commands.ts`

- [ ] Add regression for canonical `--project` persistence and an already-installed local package discovered during `install --yes`.
- [ ] Run focused CLI/command tests and observe global-only scan failure.
- [ ] Resolve project roots at scan boundary and aggregate global plus sorted unique saved local roots before selection, planning, and rescan.
- [ ] Re-run focused tests.

### Task 3: TUI signals

**Files:** `test/tui.test.ts`, `src/tui.ts`

- [ ] Add injected-signal regression for SIGINT, SIGTERM, and SIGHUP cleanup/listener removal.
- [ ] Run focused TUI test and observe absent signal cleanup.
- [ ] Register signal listeners after activation and remove each exactly once through the existing idempotent cleanup.
- [ ] Re-run focused test.

### Task 4: Verification and report

**Files:** `.superpowers/sdd/2026-08-29-unified-pi-collection-implementation/final-fix-report.md`

- [ ] Run the requested focused regressions, full spec reporter, check, build, direct/symlink/import help, and diff-check.
- [ ] Record RED/GREEN evidence in the requested report.
- [ ] Commit one clear final-fix commit.
