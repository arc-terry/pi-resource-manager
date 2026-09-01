import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { displayType } from "./domain.js";
import {
  checkState,
  moveCursor,
  selectAll,
  selectNone,
  selectedResourceIds,
  toggleSelection,
  type SelectionState,
} from "./selection.js";

interface TuiInput extends Readable {
  isTTY?: boolean;
  setRawMode?(enabled: boolean): void;
}

interface SignalSource {
  on(event: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): unknown;
}

export interface TuiOptions {
  input: TuiInput;
  output: Writable;
  signalSource?: SignalSource;
  closeInput?: boolean;
}

type StreamListener = (...args: any[]) => void;
interface KeypressListeners {
  data: StreamListener[];
  newListener: StreamListener[];
}
const keypressListenersByInput = new WeakMap<TuiInput, KeypressListeners>();

export function renderSelection(state: SelectionState): string {
  const resources = new Map(state.collection.resources.map((resource) => [resource.id, resource]));
  const rows = state.rows.map((row, index) => {
    const resource = resources.get(row.id)!;
    const marker = checkState(state, row.id) === "checked" ? "[x]"
      : checkState(state, row.id) === "partial" ? "[-]" : "[ ]";
    const status = row.disabled ? " missing local source" : row.installed ? " installed" : "";
    return `${index === state.cursor ? ">" : " "} ${row.depth === 1 ? "    " : ""}${marker} ${displayType(resource.type)} ${resource.name}  ${resource.origins.join(",")}${status}`;
  });
  return ["Install Pi Resources", ...rows, "", "↑/↓ Move  Space Toggle  A All  N None  Enter Install  Esc Cancel"].join("\n");
}

export async function runInstallTui(initial: SelectionState, options: TuiOptions): Promise<string[] | undefined> {
  const { input, output } = options;
  if (input.isTTY !== true || typeof input.setRawMode !== "function") {
    throw new Error("install requires an interactive terminal; use --yes for non-interactive use");
  }

  const inputWasFlowing = input.readableFlowing === true;
  const existingDataListeners = new Set(input.listeners("data"));
  const existingNewListeners = new Set(input.listeners("newListener"));
  const cachedKeypressListeners = keypressListenersByInput.get(input);
  if (cachedKeypressListeners) {
    const listeners = cachedKeypressListeners.newListener.length > 0
      ? cachedKeypressListeners.newListener
      : cachedKeypressListeners.data;
    const event = cachedKeypressListeners.newListener.length > 0 ? "newListener" : "data";
    for (const listener of listeners) input.on(event, listener);
  } else {
    emitKeypressEvents(input);
  }
  let keypressListeners: KeypressListeners = cachedKeypressListeners ?? { data: [], newListener: [] };
  const captureKeypressListeners = () => {
    const data = input.listeners("data").filter((listener) => !existingDataListeners.has(listener)) as StreamListener[];
    const newListener = input.listeners("newListener").filter((listener) => !existingNewListeners.has(listener)) as StreamListener[];
    keypressListeners = {
      data: [...new Set([...keypressListeners.data, ...data])],
      newListener: [...new Set([...keypressListeners.newListener, ...newListener])],
    };
    keypressListenersByInput.set(input, keypressListeners);
  };
  captureKeypressListeners();
  const signalSource = options.signalSource ?? process;
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let state = initial;
  let cleaned = false;
  let onSignal!: () => void;
  const draw = () => output.write(`\u001b[2J\u001b[H${renderSelection(state)}`);
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    let cleanupError: unknown;
    for (const signal of signals) {
      try {
        signalSource.removeListener(signal, onSignal);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    try {
      input.removeListener("keypress", onKey);
    } catch (error) {
      cleanupError ??= error;
    }
    for (const [event, listeners] of [["data", keypressListeners.data], ["newListener", keypressListeners.newListener]] as const) {
      for (const listener of listeners) {
        try {
          input.removeListener(event, listener);
        } catch (error) {
          cleanupError ??= error;
        }
      }
    }
    try {
      input.setRawMode!(false);
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      output.write("\u001b[?25h\n");
    } catch (error) {
      cleanupError ??= error;
    }
    if (!inputWasFlowing) {
      try {
        input.pause();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (options.closeInput) {
      try {
        input.destroy();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError !== undefined) throw cleanupError;
  };
  let resolve!: (value: string[] | undefined) => void;
  let reject!: (reason: unknown) => void;
  const result = new Promise<string[] | undefined>((resolveResult, rejectResult) => {
    resolve = resolveResult;
    reject = rejectResult;
  });
  const onKey = (_text: string, key: { name?: string; ctrl?: boolean }) => {
    try {
      if (key.name === "up") state = moveCursor(state, -1);
      else if (key.name === "down") state = moveCursor(state, 1);
      else if (key.name === "space") state = toggleSelection(state, state.rows[state.cursor]!.id);
      else if (key.name === "a") state = selectAll(state);
      else if (key.name === "n") state = selectNone(state);
      else if (key.name === "return") {
        cleanup();
        resolve(selectedResourceIds(state));
        return;
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        resolve(undefined);
        return;
      }
      draw();
    } catch (error) {
      try {
        cleanup();
      } catch {
        // Preserve the key handling failure over cleanup failures.
      }
      reject(error);
    }
  };
  onSignal = () => {
    try {
      cleanup();
      resolve(undefined);
    } catch (error) {
      reject(error);
    }
  };

  try {
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKey);
    captureKeypressListeners();
    for (const signal of signals) signalSource.on(signal, onSignal);
    output.write("\u001b[?25l");
    draw();
  } catch (error) {
    try {
      cleanup();
    } catch {
      // Preserve the initialization failure over cleanup failures.
    }
    throw error;
  }
  return result.finally(cleanup);
}
