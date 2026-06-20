import { compress, decompress } from "../io/compression";
import { curateAppState } from "../io/serialize";
import type { SceneElement, SceneFiles, SerializableScene } from "../types";

export const SCENE_CODE_FORMAT = "excalidraw-sketsa/scene-code";
export const SCENE_CODE_VERSION = 1;
export const MAX_SCENE_CODE_BYTES = 15_000_000;
export const MAX_SCENE_CODE_ELEMENTS = 100_000;
export const MAX_SCENE_CODE_FILES = 1_000;

export interface SceneCodeArtifact {
  format: typeof SCENE_CODE_FORMAT;
  version: typeof SCENE_CODE_VERSION;
  excalidrawVersion: "0.18.1";
  checksum: string;
  scene: SerializableScene;
}

export interface SceneCodeOptions {
  compact?: boolean;
  mode?: "replace" | "insert";
  offsetX?: number;
  offsetY?: number;
}

function referencedFileIds(elements: readonly SceneElement[]): Set<string> {
  const ids = new Set<string>();
  for (const element of elements) {
    if (typeof element.fileId === "string") ids.add(element.fileId);
  }
  return ids;
}

/** Remove tombstones and binary files that the visible scene no longer references. */
export function compactScene(scene: SerializableScene): SerializableScene {
  const elements = scene.elements.filter((element) => !element.isDeleted);
  const referenced = referencedFileIds(elements);
  const files: SceneFiles = {};
  for (const [id, file] of Object.entries(scene.files)) {
    if (referenced.has(id)) files[id] = file;
  }
  return {
    elements,
    appState: curateAppState(scene.appState),
    files,
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertSafeValue(value: unknown, path: string, depth = 0): void {
  if (depth > 100) throw new Error(`${path}: nesting exceeds 100 levels`);
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) assertSafeValue(value[i], `${path}[${i}]`, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error(`${path}: forbidden key ${key}`);
    }
    assertSafeValue(child, `${path}.${key}`, depth + 1);
  }
}

export function validateScene(scene: unknown): asserts scene is SerializableScene {
  if (!scene || typeof scene !== "object") throw new Error("scene must be an object");
  const candidate = scene as Partial<SerializableScene>;
  if (!Array.isArray(candidate.elements)) throw new Error("scene.elements must be an array");
  if (candidate.elements.length > MAX_SCENE_CODE_ELEMENTS) {
    throw new Error(`scene exceeds ${MAX_SCENE_CODE_ELEMENTS} elements`);
  }
  if (!candidate.appState || typeof candidate.appState !== "object") {
    throw new Error("scene.appState must be an object");
  }
  if (!candidate.files || typeof candidate.files !== "object" || Array.isArray(candidate.files)) {
    throw new Error("scene.files must be an object");
  }
  if (Object.keys(candidate.files).length > MAX_SCENE_CODE_FILES) {
    throw new Error(`scene exceeds ${MAX_SCENE_CODE_FILES} files`);
  }

  const ids = new Set<string>();
  for (const [index, element] of candidate.elements.entries()) {
    if (!element || typeof element !== "object") throw new Error(`element ${index} is invalid`);
    if (typeof element.id !== "string" || !element.id) throw new Error(`element ${index} has no id`);
    if (typeof element.type !== "string" || !element.type) {
      throw new Error(`element ${element.id} has no type`);
    }
    if (ids.has(element.id)) throw new Error(`duplicate element id: ${element.id}`);
    ids.add(element.id);
  }
  assertSafeValue(candidate, "scene");
}

export async function createSceneArtifact(
  source: SerializableScene,
  compact = true,
): Promise<SceneCodeArtifact> {
  const scene = compact ? compactScene(source) : source;
  validateScene(scene);
  const sceneJson = JSON.stringify(scene);
  if (byteLength(sceneJson) > MAX_SCENE_CODE_BYTES) {
    throw new Error(`scene code exceeds ${Math.round(MAX_SCENE_CODE_BYTES / 1_000_000)} MB`);
  }
  return {
    format: SCENE_CODE_FORMAT,
    version: SCENE_CODE_VERSION,
    excalidrawVersion: "0.18.1",
    checksum: await sha256(sceneJson),
    scene,
  };
}

export function encodeSceneArtifact(artifact: SceneCodeArtifact): string {
  return compress(JSON.stringify(artifact));
}

export async function decodeSceneArtifact(
  payload: string,
  verifyChecksum = true,
): Promise<SceneCodeArtifact> {
  const json = decompress(payload);
  if (!json) throw new Error("scene code payload cannot be decompressed");
  if (byteLength(json) > MAX_SCENE_CODE_BYTES) throw new Error("scene code payload is too large");

  const artifact = JSON.parse(json) as Partial<SceneCodeArtifact>;
  if (artifact.format !== SCENE_CODE_FORMAT || artifact.version !== SCENE_CODE_VERSION) {
    throw new Error("unsupported scene code format or version");
  }
  validateScene(artifact.scene);
  if (typeof artifact.checksum !== "string") throw new Error("scene code checksum is missing");
  if (verifyChecksum) {
    const actual = await sha256(JSON.stringify(artifact.scene));
    if (actual !== artifact.checksum) throw new Error("scene code checksum mismatch");
  }
  return artifact as SceneCodeArtifact;
}

export async function generateSceneCode(
  scene: SerializableScene,
  options: SceneCodeOptions = {},
): Promise<string> {
  const artifact = await createSceneArtifact(scene, options.compact ?? true);
  const payload = encodeSceneArtifact(artifact);
  const mode = options.mode ?? "replace";
  const offsetX = Number.isFinite(options.offsetX) ? options.offsetX : 0;
  const offsetY = Number.isFinite(options.offsetY) ? options.offsetY : 0;
  return `// Scene as Code — ${artifact.scene.elements.length} elements, checksum ${artifact.checksum.slice(0, 12)}\n` +
    `// Generated payload is lossless for @excalidraw/excalidraw ${artifact.excalidrawVersion}.\n` +
    `const sceneCode = \`${payload}\`;\n` +
    `await ea.loadSceneCode(sceneCode, { mode: ${JSON.stringify(mode)}, offsetX: ${offsetX}, offsetY: ${offsetY}, verifyChecksum: true });\n`;
}
