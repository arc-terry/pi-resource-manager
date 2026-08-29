import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const makeTempDir = () => mkdtemp(join(tmpdir(), "pi-collection-"));

export async function createFakePi(root: string, failingArgs?: string): Promise<{ path: string; log: string }> {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const log = join(root, "pi.log");
  const path = join(bin, "pi");
  const fail = failingArgs ? `if [ "$*" = ${JSON.stringify(failingArgs)} ]; then exit 1; fi\n` : "";
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n${fail}`);
  await chmod(path, 0o755);
  return { path, log };
}
