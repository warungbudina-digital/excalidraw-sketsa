/**
 * Scene -> file serialization.
 *
 * Ports the plugin's `generateMDBase` + `getMarkdownDrawingSection`
 * (`src/shared/ExcalidrawData.ts`): a human-readable `# Text Elements` section with one
 * `^blockId` per text element, followed by a `## Drawing` block containing the
 * LZString-compressed scene JSON.
 */
import { compress } from "./compression";
import type { SerializableScene } from "../types";

const SOURCE = "https://github.com/excalidraw-sketsa";

/**
 * Only a curated subset of appState is persisted — the same idea as the plugin's
 * `getScene()` (ExcalidrawView.ts). Persisting the full appState would bake in transient
 * UI state (collaborators, selection, open menus, etc.).
 */
const CURATED_APPSTATE_KEYS = [
  "theme",
  "viewBackgroundColor",
  "gridSize",
  "gridModeEnabled",
  "scrollX",
  "scrollY",
  "zoom",
  "currentItemStrokeColor",
  "currentItemBackgroundColor",
  "currentItemFillStyle",
  "currentItemStrokeWidth",
  "currentItemStrokeStyle",
  "currentItemRoughness",
  "currentItemOpacity",
  "currentItemFontFamily",
  "currentItemFontSize",
  "currentItemTextAlign",
  "currentItemStartArrowhead",
  "currentItemEndArrowhead",
  "currentItemRoundness",
] as const;

export function curateAppState(appState: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CURATED_APPSTATE_KEYS) {
    if (appState[key] !== undefined) {
      out[key] = appState[key];
    }
  }
  return out;
}

export function serializeScene(scene: SerializableScene): string {
  const { elements, appState, files } = scene;

  // --- # Text Elements: one raw text + block reference per text element ---
  let out = "# Excalidraw Data\n\n## Text Elements\n";
  for (const el of elements) {
    if (el.type === "text" && !el.isDeleted) {
      const raw = (el.originalText as string | undefined) ?? (el.text as string | undefined) ?? "";
      out += `${raw} ^${el.id}\n\n`;
    }
  }

  // --- scene JSON (deleted elements kept like the plugin does for sync safety) ---
  const sceneJSON = JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: SOURCE,
      elements,
      appState: curateAppState(appState),
      files,
    },
    null,
    "\t",
  );

  // --- ## Drawing: compressed scene payload ---
  out += `## Drawing\n\`\`\`compressed-json\n${compress(sceneJSON)}\n\`\`\`\n`;
  return out;
}
