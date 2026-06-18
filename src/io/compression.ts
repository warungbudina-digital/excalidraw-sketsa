/**
 * Scene compression — ported from the obsidian-excalidraw-plugin
 * (`src/utils/sceneDataUtils.ts` + the compression worker).
 *
 * The plugin runs compression in a Web Worker on save and decompresses synchronously
 * on load. Here we keep both synchronous for simplicity; the on-disk format (LZString
 * base64, chunked into 256-char lines) is identical, so files are interchangeable in
 * spirit with the plugin's `compressed-json` blocks.
 */
import LZString from "lz-string";

const CHUNK_SIZE = 256;

/** Compress a string to base64 and break it into 256-char lines (diff-friendly). */
export function compress(data: string): string {
  const compressed = LZString.compressToBase64(data);
  let result = "";
  for (let i = 0; i < compressed.length; i += CHUNK_SIZE) {
    result += `${compressed.slice(i, i + CHUNK_SIZE)}\n\n`;
  }
  return result.trim();
}

/** Strip the chunk whitespace and decompress. Returns null on failure. */
export function decompress(data: string): string | null {
  let cleaned = "";
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch !== "\n" && ch !== "\r") {
      cleaned += ch;
    }
  }
  return LZString.decompressFromBase64(cleaned) || null;
}
