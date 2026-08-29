# Task 2 — Grouped Resource Selection Report

## Implementation

Created `src/selection.ts`, a pure state module with no terminal or filesystem I/O.

- Orders rows as packages, then each owned child, then independent resources.
- Defaults scan-origin resources selected and manual-only resources unselected.
- Matches installed packages by source identity and children by owner ID plus name.
- Disables IDs supplied by `missingLocalIds`.
- Computes checked/unchecked/partial package states over the package and its children.
- Supports package/child toggles, owner dependency inclusion, wrapped cursor movement, select-all, and select-none.

## TDD Evidence

### RED

Command: `npx tsx --test test/selection.test.ts`

Result: exit 1 before implementation. The test failed with:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/selection.js'
```

The failure identified the missing production module requested by the test.

### GREEN

Command: `npx tsx --test test/selection.test.ts`

Result: exit 0.

```text
✔ grouped selection preserves resource selection and navigation contract
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

## Final Verification

Command: `npm run check`

Result: exit 0.

```text
> tsc --noEmit -p tsconfig.json
```

Command: `npm test -- --test-reporter=spec`

Result: exit 0. The npm script executed `tsx --test test/**/*.test.ts --test-reporter=spec` and reported:

```text
ℹ tests 79
ℹ pass 79
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4223.139917
```
