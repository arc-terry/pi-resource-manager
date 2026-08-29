# Final fix wave report

## Important findings resolved

1. Local restore package actions retain the recorded project root (or `--project` remap) and execute `pi install -l` from that root.
2. `--only skill` and `--only plugin` schedule each requested owner package once; a present package is reinstalled when its requested owned resource is absent.
3. Restore plans can mark destination resources `already-present`; the CLI scans before planning and re-scans after package actions. Package actions remain before independent settings actions.
4. Restore summaries preserve per-action Pi command diagnostics (command, exit status, stdout, and stderr) while subsequent independent actions continue.
5. Direct top-level skills/extensions in documented auto-discovery locations are omitted from settings actions; external configured paths remain settings actions.
6. Atomic writes now write a temporary file, fsync and close it, rename it, and clean up the temporary file on failure.
7. Catalog parsing rejects bare npm package names while scanner settings continue to accept Pi's existing bare-name representation.
8. The CLI plugin-add integration test now asserts the actual Pi invocation.

## Regression coverage

New regressions cover local Pi working directories, owner-package filtering and missing owned resources, already-present planning, post-package re-scan, Pi error diagnostics, auto-discovery settings exclusion, atomic temporary cleanup, bare catalog npm names, and CLI plugin-add invocation.

## Verification

- Focused regressions and `npm run check` passed before final verification.
- `npm test`: 67 passing, 0 failing.
- `npm run check`: passed.
- `npm run build`: passed.
- `node dist/cli.js --help`: passed.
- `test -x dist/cli.js`: passed.
- `git diff --check`: passed.
