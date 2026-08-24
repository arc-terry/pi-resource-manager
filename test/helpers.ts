import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const makeTempDir = () => mkdtemp(join(tmpdir(), "pi-collection-"));

export async function createFakePi(root: string): Promise<{ path: string; log: string }> {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });

  const log = join(root, "pi.log");
  const path = join(bin, "pi");
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);
  await chmod(path, 0o755);

  return { path, log };
}
