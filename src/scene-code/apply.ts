import { validateScene } from "./artifact";
import { remapSceneForInsert } from "./remap";
import type { ExcalidrawApi, SerializableScene } from "../types";

export interface SceneLoadOptions {
  mode?: "replace" | "insert";
  offsetX?: number;
  offsetY?: number;
  verifyChecksum?: boolean;
}

export async function loadSceneIntoApi(
  api: ExcalidrawApi,
  scene: SerializableScene,
  options: SceneLoadOptions = {},
): Promise<boolean> {
  validateScene(scene);
  const mode = options.mode ?? "replace";
  const materialized =
    mode === "insert"
      ? remapSceneForInsert(scene, { offsetX: options.offsetX, offsetY: options.offsetY })
      : (JSON.parse(JSON.stringify(scene)) as SerializableScene);
  const files = Object.entries(materialized.files).map(([id, file]) => ({
    id,
    ...(file as object),
  }));

  if (mode === "replace") {
    const incomingIds = new Set(materialized.elements.map((element) => element.id));
    const tombstones = api
      .getSceneElements()
      .filter((element) => !incomingIds.has(element.id))
      .map((element) => ({
        ...element,
        isDeleted: true,
        version: Number(element.version ?? 0) + 1,
        versionNonce: Math.floor(Math.random() * 2_147_483_647),
      }));
    api.resetScene?.();
    if (files.length > 0) api.addFiles?.(files);
    api.updateScene({
      elements: [...materialized.elements, ...tombstones],
      appState: materialized.appState,
      captureUpdate: "IMMEDIATELY",
    });
  } else {
    if (files.length > 0) api.addFiles?.(files);
    api.updateScene({
      elements: [...api.getSceneElements(), ...materialized.elements],
      captureUpdate: "IMMEDIATELY",
    });
    api.scrollToContent?.(materialized.elements, { fitToContent: true });
  }
  return true;
}
