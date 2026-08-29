import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import type { Collection } from "../src/collection.js";
import { buildSelection } from "../src/selection.js";
import { renderSelection, runInstallTui } from "../src/tui.js";

const emptyScan = { packages: [], skills: [], extensions: [] };
const collection: Collection = {
  schemaVersion: 2,
  collection: { name: "x", updatedAt: "2026-08-29T00:00:00.000Z" },
  resources: [
    { id: "pkg", type: "package", name: "tools", origins: ["scan"], scope: "global", source: { kind: "npm", spec: "npm:tools", name: "tools" } },
    { id: "skill:a", type: "skill", name: "a", origins: ["scan"], scope: "global", ownerPackageId: "pkg", source: { kind: "npm", spec: "npm:tools", name: "tools" } },
    { id: "extension:b", type: "extension", name: "b", origins: ["manual"], scope: "global", ownerPackageId: "pkg", source: { kind: "npm", spec: "npm:tools", name: "tools" } },
  ],
};

type TtyInput = PassThrough & { isTTY: boolean; setRawMode(value: boolean): void };

function fakeTty() {
  const calls: boolean[] = [];
  const input = new PassThrough() as TtyInput;
  input.isTTY = true;
  input.setRawMode = (value) => { calls.push(value); };
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk.toString(); });
  return { input, output, calls, rendered: () => rendered };
}

async function runKeys(keys: string[]) {
  const tty = fakeTty();
  const result = runInstallTui(buildSelection(collection, emptyScan), tty);
  keys.forEach((key) => tty.input.write(key));
  return { result: await result, ...tty };
}

test("TUI renders grouped selection and handles selection, confirmation, cancellation, and terminal cleanup", async () => {
  const rendered = renderSelection(buildSelection(collection, emptyScan));
  assert.match(rendered, /\[-\] package tools/);
  assert.match(rendered, /    \[x\] skill a/);
  assert.match(rendered, /    \[ \] plugin b/);

  assert.deepEqual((await runKeys([" ", "\r"])).result, ["pkg", "skill:a", "extension:b"]);

  const child = await runKeys(["a", "\u001b[B", " ", "\r"]);
  assert.deepEqual(child.result, ["pkg", "extension:b"]);
  const finalFrame = child.rendered().slice(child.rendered().lastIndexOf("\u001b[2J\u001b[H"));
  assert.match(finalFrame, /\[-\] package tools/);

  assert.deepEqual((await runKeys(["a", "\r"])).result, ["pkg", "skill:a", "extension:b"]);
  assert.deepEqual((await runKeys(["n", "\r"])).result, []);

  const cancelled = await runKeys(["\u001b"]);
  assert.equal(cancelled.result, undefined);
  assert.deepEqual(cancelled.calls, [true, false]);
  assert.match(cancelled.rendered(), /\u001b\[\?25l/);
  assert.match(cancelled.rendered(), /\u001b\[\?25h/);

  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = false;
  await assert.rejects(
    runInstallTui(buildSelection(collection, emptyScan), { input, output: new PassThrough() }),
    /use --yes/,
  );
});

test("TUI ignores a synchronous key following confirmation and restores the terminal", async () => {
  const tty = fakeTty();
  const result = runInstallTui(buildSelection(collection, emptyScan), tty);
  tty.input.write("\r");
  tty.input.write("\u001b[B");

  assert.deepEqual(await result, ["pkg", "skill:a"]);
  assert.deepEqual(tty.calls, [true, false]);
  assert.equal(tty.input.listenerCount("keypress"), 0);
  assert.match(tty.rendered(), /\u001b\[\?25h/);
});

test("TUI cancels on Ctrl-C and restores the terminal", async () => {
  const cancelled = await runKeys(["\u0003"]);

  assert.equal(cancelled.result, undefined);
  assert.deepEqual(cancelled.calls, [true, false]);
  assert.match(cancelled.rendered(), /\u001b\[\?25h/);
});

test("TUI restores the terminal when its initial draw fails", async () => {
  const tty = fakeTty();
  const write = tty.output.write.bind(tty.output);
  let failDraw = true;
  tty.output.write = ((chunk: string | Uint8Array) => {
    if (failDraw && String(chunk).startsWith("\u001b[2J")) {
      failDraw = false;
      throw new Error("draw failed");
    }
    return write(chunk);
  }) as typeof tty.output.write;

  await assert.rejects(
    runInstallTui(buildSelection(collection, emptyScan), tty),
    /draw failed/,
  );
  assert.deepEqual(tty.calls, [true, false]);
  assert.equal(tty.input.listenerCount("keypress"), 0);
  assert.match(tty.rendered(), /\u001b\[\?25h/);
});
