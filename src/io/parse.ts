/**
 * File -> scene parsing.
 *
 * Ports the plugin's `getJSON` / `getDecompressedScene` + the `# Text Elements`
 * reconciliation in `loadData` (`src/shared/ExcalidrawData.ts`):
 *   1. extract + decompress the `## Drawing` JSON,
 *   2. drop deleted elements,
 *   3. re-apply text from the `# Text Elements` section (which takes priority, mirroring
 *      the plugin — this is what lets renamed links survive a round-trip).
 */
import { decompress } from "./compression";
import type { ParsedScene, SceneElement } from "../types";

// Matches the ```compressed-json block under "## Drawing".
const DRAWING_COMPRESSED_REG = /\n##? Drawing\n[^`]*```compressed-json\n([\s\S]*?)```/m;
// Fallback for an uncompressed ```json block.
const DRAWING_JSON_REG = /\n##? Drawing\n```json\n([\s\S]*?)```/m;

function extractSceneJSON(data: string): string | null {
  const compressed = data.match(DRAWING_COMPRESSED_REG);
  if (compressed) {
    const json = decompress(compressed[1]);
    // guard against sync artifacts after the closing brace
    return json ? json.substring(0, json.lastIndexOf("}") + 1) : null;
  }
  const plain = data.match(DRAWING_JSON_REG);
  if (plain) {
    return plain[1];
  }
  return null;
}

/** Build a map of block-ref id -> raw text from the `# Text Elements` section. */
function parseTextElementsSection(data: string): Map<string, string> {
  const map = new Map<string, string>();
  const headerIdx = data.search(/##? Text Elements\n/);
  if (headerIdx === -1) {
    return map;
  }
  let section = data.slice(headerIdx).replace(/##? Text Elements\n/, "");
  const drawingIdx = section.search(/\n##? Drawing\n/);
  if (drawingIdx > -1) {
    section = section.slice(0, drawingIdx);
  }

  // Each entry was written as `${raw} ^${id}\n\n`.
  const re = /\s\^([A-Za-z0-9_-]+)\n+/g;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    const raw = section.substring(pos, m.index);
    map.set(m[1], raw);
    pos = m.index + m[0].length;
  }
  return map;
}

export function parseScene(data: string): ParsedScene {
  const normalized = data.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const json = extractSceneJSON(normalized);
  if (!json) {
    throw new Error("'## Drawing' scene data not found in file");
  }

  const parsed = JSON.parse(json) as {
    elements?: SceneElement[];
    appState?: Record<string, unknown>;
    files?: Record<string, unknown>;
  };

  const elements = (parsed.elements ?? []).filter((el) => !el.isDeleted);

  // # Text Elements takes priority over the JSON text (plugin behavior).
  const textMap = parseTextElementsSection(normalized);
  for (const el of elements) {
    if (el.type === "text" && textMap.has(el.id)) {
      const raw = textMap.get(el.id) as string;
      el.text = raw;
      el.originalText = raw;
    }
  }

  return {
    elements,
    appState: parsed.appState ?? {},
    files: parsed.files ?? {},
  };
}
