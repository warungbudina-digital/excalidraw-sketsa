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

type ScriptFn = (ea: ExcalidrawAutomate, utils: ScriptUtils) => Promise<unknown>;

export async function runScript(
  code: string,
  ea: ExcalidrawAutomate,
  utils: ScriptUtils,
): Promise<unknown> {
  // Same trick the plugin uses to obtain the AsyncFunction constructor.
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => ScriptFn;
  const fn = new AsyncFunction("ea", "utils", code);
  return fn(ea, utils);
}
