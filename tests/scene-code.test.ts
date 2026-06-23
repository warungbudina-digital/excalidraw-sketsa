import assert from "node:assert/strict";
import {
  createSceneArtifact,
  decodeSceneArtifact,
  encodeSceneArtifact,
  generateSceneCode,
} from "../src/scene-code/artifact";
import { remapSceneForInsert } from "../src/scene-code/remap";
import { loadSceneIntoApi } from "../src/scene-code/apply";
import { sceneToEAScript } from "../src/scene-code/decompile";
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

// --- decompiler: scene -> readable EA script ---------------------------------------------
const decompScene: SerializableScene = {
  elements: [
    {
      id: "a",
      type: "rectangle",
      x: 100,
      y: 100,
      width: 160,
      height: 60,
      strokeColor: "#1971c2",
      backgroundColor: "#a5d8ff",
      groupIds: ["g1"],
      frameId: "fr1",
      boundElements: [{ id: "alab", type: "text" }, { id: "arr", type: "arrow" }],
    },
    { id: "alab", type: "text", x: 110, y: 120, text: "Mulai", originalText: "Mulai", containerId: "a", fontSize: 20 },
    {
      id: "b",
      type: "rectangle",
      x: 100,
      y: 260,
      width: 160,
      height: 60,
      strokeColor: "#1971c2",
      backgroundColor: "#a5d8ff",
      groupIds: ["g1"],
      frameId: "fr1",
    },
    { id: "arr", type: "arrow", x: 180, y: 160, points: [[0, 0], [0, 100]], startBinding: { elementId: "a" }, endBinding: { elementId: "b" } },
    { id: "note", type: "text", x: 400, y: 100, text: "catatan", originalText: "catatan", fontSize: 16, strokeColor: "#e8590c" },
    { id: "ln", type: "line", x: 400, y: 200, points: [[0, 0], [50, 50], [100, 0]] },
    { id: "fd", type: "freedraw", x: 500, y: 300, points: [[0, 0], [5, 5]] },
    { id: "img", type: "image", x: 600, y: 100, width: 80, height: 80, fileId: "f1" },
    { id: "fr1", type: "frame", x: 0, y: 0, name: "Alur" },
    { id: "gone", type: "rectangle", x: 0, y: 0, width: 10, height: 10, isDeleted: true },
  ],
  appState: { viewBackgroundColor: "#ffffff" },
  files: { f1: { id: "f1", mimeType: "image/png", dataURL: "data:image/png;base64,AA==" } },
};

const script = sceneToEAScript(decompScene);
// readable EA, never an opaque payload
assert.match(script, /await ea\.clearView\(\);/, "rebuild starts by clearing the canvas");
assert.match(script, /await ea\.addElementsToView\(\);/, "rebuild commits at the end");
assert.doesNotMatch(script, /loadSceneCode/, "decompiler emits readable EA, not a payload");
// rectangle carries its bound text as a label arg; the bound text is NOT a standalone addText
assert.match(script, /ea\.addRect\(100, 100, 160, 60, "Mulai"\)/, "bound label folded into the shape");
assert.doesNotMatch(script, /ea\.addText\([^)]*"Mulai"/, "bound label is not emitted as standalone text");
// standalone text stays addText
assert.match(script, /ea\.addText\(400, 100, "catatan"\)/, "standalone text -> addText");
// arrow bound to two shapes -> connect referencing their vars
assert.match(script, /ea\.connect\(r1, r2\)/, "bound arrow -> connect(from,to)");
// line points are made absolute
assert.match(script, /ea\.addLine\(\[\[400,200\],\[450,250\],\[500,200\]\]\)/, "line points absolutized");
// shared groupIds -> addToGroup; frame wraps its children (emitted after them)
assert.match(script, /ea\.addToGroup\(\[r1, r2\]\)/, "shared group -> addToGroup");
assert.match(script, /ea\.addFrame\("Alur", \[r1, r2\]\)/, "frame wraps its children");
// per-element style is emitted as a diff
assert.match(script, /ea\.setStyle\(\{[^}]*"strokeColor":"#1971c2"/, "changed style emitted via setStyle");
// unsupported types preserved verbatim through the escape hatch, with their files
assert.match(script, /ea\.addRawElements\(\[/, "unsupported elements -> addRawElements");
assert.match(script, /"type":"freedraw"/, "freedraw preserved verbatim");
assert.match(script, /"type":"image"/, "image preserved verbatim");
assert.match(script, /"f1"/, "referenced image file is included");
// deleted elements are dropped
assert.doesNotMatch(script, /"id":"gone"/, "tombstones are not decompiled");

console.log("decompile tests: passed");
