import { nanoid } from "nanoid";
import type { SceneElement, SceneFiles, SerializableScene } from "../types";

export interface RemapOptions {
  offsetX?: number;
  offsetY?: number;
}

function remapReference(
  value: unknown,
  idMap: Map<string, string>,
): unknown {
  return typeof value === "string" ? (idMap.get(value) ?? null) : value;
}

/** Clone a scene with fresh element/group/file ids while preserving internal references. */
export function remapSceneForInsert(
  scene: SerializableScene,
  options: RemapOptions = {},
): SerializableScene {
  const elements = scene.elements.filter((element) => !element.isDeleted);
  const idMap = new Map(elements.map((element) => [element.id, nanoid()]));
  const groupIds = new Set<string>();
  for (const element of elements) {
    for (const groupId of element.groupIds ?? []) groupIds.add(groupId);
  }
  const groupMap = new Map([...groupIds].map((id) => [id, nanoid()]));
  const fileMap = new Map(Object.keys(scene.files).map((id) => [id, nanoid()]));
  const offsetX = Number.isFinite(options.offsetX) ? Number(options.offsetX) : 0;
  const offsetY = Number.isFinite(options.offsetY) ? Number(options.offsetY) : 0;

  const remappedElements = elements.map((source) => {
    const element = JSON.parse(JSON.stringify(source)) as SceneElement;
    element.id = idMap.get(source.id) as string;
    if (typeof element.x === "number") element.x += offsetX;
    if (typeof element.y === "number") element.y += offsetY;
    if (element.groupIds) element.groupIds = element.groupIds.map((id) => groupMap.get(id) ?? id);
    if ("frameId" in element) element.frameId = remapReference(element.frameId, idMap);
    if ("containerId" in element) element.containerId = remapReference(element.containerId, idMap);
    if (typeof element.fileId === "string") element.fileId = fileMap.get(element.fileId) ?? element.fileId;

    if (Array.isArray(element.boundElements)) {
      element.boundElements = element.boundElements
        .map((binding) => {
          if (!binding || typeof binding !== "object") return null;
          const oldId = (binding as { id?: unknown }).id;
          const newId = typeof oldId === "string" ? idMap.get(oldId) : undefined;
          return newId ? { ...(binding as object), id: newId } : null;
        })
        .filter(Boolean);
    }
    for (const key of ["startBinding", "endBinding"] as const) {
      const binding = element[key];
      if (binding && typeof binding === "object") {
        const oldId = (binding as { elementId?: unknown }).elementId;
        const newId = typeof oldId === "string" ? idMap.get(oldId) : undefined;
        element[key] = newId ? { ...(binding as object), elementId: newId } : null;
      }
    }
    return element;
  });

  const files: SceneFiles = {};
  for (const [oldId, file] of Object.entries(scene.files)) {
    const newId = fileMap.get(oldId) as string;
    files[newId] = file && typeof file === "object" ? { ...(file as object), id: newId } : file;
  }
  return { elements: remappedElements, appState: scene.appState, files };
}
