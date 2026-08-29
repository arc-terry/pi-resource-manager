# Task 4 Report: YAML profiles

## Status

Implemented schema-versioned YAML profile validation, atomic serialization, reading, and scan conversion with provenance.

## Files

- `src/profile.ts`
- `test/profile.test.ts`

## TDD evidence

The original RED tests were written before implementation and failed because `src/profile.ts` was missing. The implementation then passed the focused profile tests and the full verification suite.

### Review-fix RED/GREEN

- Added `profileFromScan preserves empty-string owner package provenance`; it failed before the production change because the truthiness check omitted a defined empty-string `ownerPackageId`.
- Changed only that presence check to `resource.ownerPackageId !== undefined`; the focused regression then passed.
- Added behavior-focused `profileFromScan` coverage for pinned Git refs, local `projectRoot`, owner provenance, and canonical extension records.

## Verification

- `npm test -- --test-name-pattern 'schema-versioned|unsupported schema'`: 22 passing, 0 failing (original Task 4 evidence)
- `./node_modules/.bin/tsx --test --test-name-pattern "profileFromScan" test/profile.test.ts`: 4 passing, 0 failing
- `npm test`: 26 passing, 0 failing
- `npm run check`: passed
- `npm run build`: passed
- `git diff --check`: passed

## Commit

Fix committed: `26f04ca fix: preserve profile scan provenance`

## Concerns

None.
