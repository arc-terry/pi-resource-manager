import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runPi(
  args: string[],
  options: { piPath?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<CommandResult> {
  const result = await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(options.piPath ?? "pi", args, {
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
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
  if (result.code !== 0) {
    const renderedArgs = args.map((arg) => JSON.stringify(arg)).join(" ");
    throw new Error(`Pi command failed (exit ${result.code}): pi ${renderedArgs}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
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
  let received = "";
  for await (const chunk of input) {
    received += chunk.toString();
    const newline = received.search(/[\r\n]/);
    if (newline >= 0) return /^(y|yes)$/i.test(received.slice(0, newline).trim());
  }
  return /^(y|yes)$/i.test(received.trim());
}
