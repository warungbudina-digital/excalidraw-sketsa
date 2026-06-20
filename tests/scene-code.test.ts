import assert from "node:assert/strict";
import {
  createSceneArtifact,
  decodeSceneArtifact,
  encodeSceneArtifact,
  generateSceneCode,
} from "../src/scene-code/artifact";
import { remapSceneForInsert } from "../src/scene-code/remap";
import { loadSceneIntoApi } from "../src/scene-code/apply";
import type { ExcalidrawApi, SceneElement, SerializableScene } from "../src/types";

const scene: SerializableScene = {
  elements: [
    {
      id: "box",
      type: "rectangle",
      x: 10,
      y: 20,
      version: 2,
      versionNonce: 10,
      groupIds: ["group-a"],
      boundElements: [{ id: "label", type: "text" }, { id: "arrow", type: "arrow" }],
      frameId: "frame",
    },
    {
      id: "label",
      type: "text",
      x: 20,
      y: 30,
      text: "Router",
      containerId: "box",
      groupIds: ["group-a"],
      frameId: "frame",
    },
    {
      id: "arrow",
      type: "arrow",
      x: 100,
      y: 50,
      startBinding: { elementId: "box", focus: 0, gap: 1 },
      endBinding: null,
      frameId: "frame",
    },
    { id: "image", type: "image", x: 200, y: 50, fileId: "file-live", frameId: "frame" },
    { id: "frame", type: "frame", x: 0, y: 0, name: "Network" },
    { id: "deleted", type: "image", isDeleted: true, fileId: "file-orphan" },
  ],
  appState: { viewBackgroundColor: "#ffffff", selectedElementIds: { box: true } },
  files: {
    "file-live": { id: "file-live", mimeType: "image/png", dataURL: "data:image/png;base64,AA==" },
    "file-orphan": { id: "file-orphan", mimeType: "image/png", dataURL: "data:image/png;base64,BB==" },
  },
};

const artifact = await createSceneArtifact(scene, true);
assert.equal(artifact.scene.elements.length, 5, "compaction removes tombstones");
assert.deepEqual(Object.keys(artifact.scene.files), ["file-live"], "compaction removes orphan files");
assert.equal(artifact.scene.appState.selectedElementIds, undefined, "transient appState is removed");

const payload = encodeSceneArtifact(artifact);
const decoded = await decodeSceneArtifact(payload, true);
assert.deepEqual(decoded.scene, artifact.scene, "artifact survives compressed round-trip");

const tampered = { ...artifact, checksum: "0".repeat(64) };
await assert.rejects(() => decodeSceneArtifact(encodeSceneArtifact(tampered), true), /checksum mismatch/);

const code = await generateSceneCode(scene, { compact: true, mode: "replace" });
assert.match(code, /await ea\.loadSceneCode/);
assert.match(code, /verifyChecksum: true/);

const inserted = remapSceneForInsert(artifact.scene, { offsetX: 300, offsetY: 400 });
const byType = new Map(inserted.elements.map((element) => [element.type, element]));
const box = byType.get("rectangle") as Record<string, unknown>;
const label = byType.get("text") as Record<string, unknown>;
const arrow = byType.get("arrow") as Record<string, unknown>;
const frame = byType.get("frame") as Record<string, unknown>;
const image = byType.get("image") as Record<string, unknown>;
assert.notEqual(box.id, "box", "insert creates fresh ids");
assert.equal(box.x, 310);
assert.equal(box.y, 420);
assert.equal(label.containerId, box.id, "container reference is remapped");
assert.equal(label.frameId, frame.id, "frame reference is remapped");
assert.equal((arrow.startBinding as { elementId: string }).elementId, box.id, "binding is remapped");
assert.deepEqual(label.groupIds, box.groupIds, "shared group id remains shared");
assert.notEqual((label.groupIds as string[])[0], "group-a", "group id is fresh");
assert.ok(Object.hasOwn(inserted.files, image.fileId as string), "image file id and file map agree");

const updates: Parameters<ExcalidrawApi["updateScene"]>[0][] = [];
const addedFiles: unknown[][] = [];
let resetCount = 0;
let scrolled = false;
const oldElement: SceneElement = { id: "old", type: "ellipse", version: 4 };
const api: ExcalidrawApi = {
  getSceneElements: () => [oldElement],
  getAppState: () => ({}),
  getFiles: () => ({}),
  updateScene: (update) => updates.push(update),
  addFiles: (files) => addedFiles.push(files),
  resetScene: () => {
    resetCount += 1;
  },
  scrollToContent: () => {
    scrolled = true;
  },
};

await loadSceneIntoApi(api, artifact.scene, { mode: "replace" });
assert.equal(resetCount, 1, "replace resets stale files/scene");
assert.equal(addedFiles[0].length, 1, "replace registers referenced files");
const replacement = updates[0].elements as SceneElement[];
assert.deepEqual(
  replacement.slice(0, artifact.scene.elements.length),
  artifact.scene.elements,
  "replace preserves exact element order and data",
);
const oldTombstone = replacement.at(-1) as SceneElement;
assert.equal(oldTombstone.id, "old");
assert.equal(oldTombstone.isDeleted, true, "replace publishes tombstones for collaboration");
assert.equal(oldTombstone.version, 5);

updates.length = 0;
addedFiles.length = 0;
await loadSceneIntoApi(api, artifact.scene, { mode: "insert", offsetX: 5, offsetY: 7 });
assert.equal(resetCount, 1, "insert does not reset the existing scene");
assert.equal((updates[0].elements as SceneElement[])[0].id, "old", "insert retains existing elements");
assert.equal(scrolled, true, "insert scrolls to inserted content");

console.log("scene-code tests: passed");
