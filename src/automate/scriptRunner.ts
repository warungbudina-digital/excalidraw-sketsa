/**
 * Script execution — ports the plugin's `ScriptEngine.executeScript`
 * (`src/shared/Scripts.ts`).
 *
 * A user script is run as the body of an async function with `ea` and `utils` injected,
 * exactly like the plugin:
 *
 *   new AsyncFunction("ea", "utils", code)(ea, utils)
 *
 * so a script can `await ea.addElementsToView()` and call `utils.inputPrompt(...)` /
 * `utils.suggester(...)` without any imports.
 */
import type { ExcalidrawAutomate } from "./ExcalidrawAutomate";

export interface ScriptUtils {
  inputPrompt: (header: string, placeholder?: string, value?: string) => Promise<string | null>;
  suggester: (displayItems: string[], items: unknown[]) => Promise<unknown>;
}

/** Browser-native implementations of the script `utils` helpers. */
export function createDefaultUtils(): ScriptUtils {
  return {
    inputPrompt: async (header, _placeholder, value) => window.prompt(header, value ?? ""),
    suggester: async (displayItems, items) => {
      const menu = displayItems.map((d, i) => `${i}: ${d}`).join("\n");
      const choice = window.prompt(`Pilih (ketik nomor):\n${menu}`, "0");
      if (choice === null) {
        return undefined;
      }
      const idx = Number.parseInt(choice, 10);
      return Number.isInteger(idx) ? items[idx] : undefined;
    },
  };
}

/** Receives one progress/output line from a running script (EA stages + console output). */
export type ScriptLog = (message: string) => void;

interface ConsoleLike {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

type ScriptFn = (
  ea: ExcalidrawAutomate,
  utils: ScriptUtils,
  console: ConsoleLike,
) => Promise<unknown>;

function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * A `console` shim injected into the script scope (shadowing the global). It forwards output
 * to the UI log via `onLog` AND mirrors to the real devtools console, so a script's
 * `console.log("tahap …")` shows up as a progress notification without leaking globally.
 */
function makeConsole(onLog?: ScriptLog): ConsoleLike {
  const line = (args: unknown[]): string => args.map(formatArg).join(" ");
  return {
    log: (...args) => { onLog?.(line(args)); console.log(...args); },
    info: (...args) => { onLog?.(line(args)); console.info(...args); },
    warn: (...args) => { onLog?.(`⚠ ${line(args)}`); console.warn(...args); },
    error: (...args) => { onLog?.(`✗ ${line(args)}`); console.error(...args); },
    debug: (...args) => { console.debug(...args); },
  };
}

export async function runScript(
  code: string,
  ea: ExcalidrawAutomate,
  utils: ScriptUtils,
  onLog?: ScriptLog,
): Promise<unknown> {
  // Same trick the plugin uses to obtain the AsyncFunction constructor.
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => ScriptFn;
  const fn = new AsyncFunction("ea", "utils", "console", code);
  return fn(ea, utils, makeConsole(onLog));
}
