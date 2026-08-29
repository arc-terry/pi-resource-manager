# Task 5 Report: Pi commands and restore

Implemented safe Pi subprocess execution, confirmation, deterministic restore planning, dry-run behavior, local path validation, settings restoration, and best-effort summaries.

## TDD evidence

RED restore planning tests failed with `ERR_MODULE_NOT_FOUND` because `src/restore.ts` did not exist. GREEN implementation then passed planning and dry-run tests.

## Verification

- `npm test -- --test-name-pattern 'plans global|missing local|dry-run'`: 29 passing, 0 failing
- `npm test`: 29 passing, 0 failing
- `npm run check`: passed
- `npm run build`: passed
- `git diff --check`: passed

## Original task commit

`ok3dc6317 feat: restore pi profiles through pi install`

## Concerns

None.

## Review-fix evidence

- TDD RED: `./node_modules/.bin/tsx --test --test-reporter=spec --test-name-pattern='missing local package source' test/restore.test.ts` failed before the planner guard because it emitted `pi-install` for the missing local package source.
- TDD GREEN: the same focused regression passed after local package paths were validated before action creation.
- Added real execution coverage for a successful fake-Pi install, continuation after a failing fake-Pi install, and on-disk settings writes. `./node_modules/.bin/tsx --test --test-reporter=spec test/restore.test.ts` passed 8/8.
- Added a startup failure regression requiring the executable and JSON-quoted arguments. It failed with the raw `spawn ... ENOENT` error, then passed after `runPi` added command context.
- `npm test`: 34 passing, 0 failing.
- `npm run check`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
