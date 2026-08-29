import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const makeTempDir = () => mkdtemp(join(tmpdir(), "pi-collection-"));

export async function createFakePi(root: string, failingArgs?: string, captureCwd = false): Promise<{ path: string; log: string; cwdLog: string }> {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const log = join(root, "pi.log");
  const cwdLog = join(root, "pi.cwd.log");
  const path = join(bin, "pi");
  const fail = failingArgs ? `if [ "$*" = ${JSON.stringify(failingArgs)} ]; then printf 'fake Pi failure\\n' >&2; exit 1; fi\n` : "";
  const recordCwd = captureCwd ? `pwd >> "${cwdLog}"\n` : "";
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n${recordCwd}${fail}`);
  await chmod(path, 0o755);
  return { path, log, cwdLog };
}
