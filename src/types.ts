/**
 * Lightweight structural types for the scene boundary.
 *
 * We intentionally model Excalidraw elements/appState/files structurally instead of
 * importing the exact `@excalidraw/excalidraw` deep type paths. This keeps the IO and
 * automate layers decoupled from Excalidraw's internal type layout while still being
 * type-checked at our own boundaries. The live canvas types are richer; we only rely on
 * the fields we actually touch.
 */

export type SceneElement = Record<string, unknown> & {
  id: string;
  type: string;
  isDeleted?: boolean;
  text?: string;
  originalText?: string;
  groupIds?: string[];
};

export type SceneFiles = Record<string, unknown>;

export type SceneAppState = Record<string, unknown> & {
  selectedElementIds?: Record<string, boolean>;
};

export interface ParsedScene {
  elements: SceneElement[];
  appState: SceneAppState;
  files: SceneFiles;
}

export interface SerializableScene {
  elements: readonly SceneElement[];
  appState: SceneAppState;
  files: SceneFiles;
}

/**
 * The subset of the Excalidraw imperative API this app uses.
 * Mirrors `ExcalidrawImperativeAPI` but only the methods we call.
 */
export interface ExcalidrawApi {
  getSceneElements: () => readonly SceneElement[];
  getSceneElementsIncludingDeleted?: () => readonly SceneElement[];
  getAppState: () => SceneAppState;
  getFiles: () => SceneFiles;
  updateScene: (scene: {
    elements?: readonly SceneElement[];
    appState?: Record<string, unknown>;
    captureUpdate?: unknown;
  }) => void;
  addFiles?: (files: unknown[]) => void;
  resetScene?: () => void;
  scrollToContent?: (target?: unknown, opts?: unknown) => void;
}
