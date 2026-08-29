import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class PiCommandError extends Error {
  constructor(
    readonly command: string,
    readonly args: string[],
    readonly result?: CommandResult,
    options?: { cause?: unknown },
  ) {
    super(PiCommandError.message(command, result, options?.cause), options);
    this.name = "PiCommandError";
  }

  private static message(command: string, result?: CommandResult, cause?: unknown): string {
    if (!result) return `${command} failed to start: ${cause instanceof Error ? cause.message : String(cause)}`;
    return `${command} exited with code ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
  }
}

export async function runPi(
  args: string[],
  options: { piPath?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<CommandResult> {
  const piPath = options.piPath ?? "pi";
  const command = `Pi command ${JSON.stringify(piPath)} [${args.map((arg) => JSON.stringify(arg)).join(", ")}]`;
  const child = spawn(piPath, args, {
    shell: false,
    cwd: options.cwd,
    env: options.env ?? process.env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", (error) => reject(new PiCommandError(command, args, undefined, { cause: error })));
    child.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
  const result = { code, stdout, stderr };
  if (code !== 0) throw new PiCommandError(command, args, result);
  return result;
}

export async function confirm(
  message: string,
  options: { yes: boolean; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream },
): Promise<boolean> {
  if (options.yes) return true;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  output.write(`${message} [y/N] `);
  const reader = createInterface({ input });
  try {
    for await (const line of reader) return /^y(?:es)?$/i.test(line.trim());
    return false;
  } finally {
    reader.close();
  }
}
