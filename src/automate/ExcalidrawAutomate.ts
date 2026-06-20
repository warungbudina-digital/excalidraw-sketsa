/**
 * A scaled-down ExcalidrawAutomate ("EA") workbench.
 *
 * Ports the core mental model from the plugin's `src/shared/ExcalidrawAutomate.ts`:
 * elements are built on a private "workbench" (here: skeletons + an edit dict) and only
 * committed to the live scene by `addElementsToView()`. Scene elements are immutable, so
 * editing existing ones goes through `copyViewElementsToEAforEditing()` first.
 *
 * Scope is intentionally small (rect/ellipse/diamond/text/line/arrow + grouping); it is
 * enough to demonstrate the build -> commit -> merge -> render flow.
 */
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { nanoid } from "nanoid";
import { decodeSceneArtifact } from "../scene-code/artifact";
import { loadSceneIntoApi, type SceneLoadOptions } from "../scene-code/apply";
import type { ExcalidrawApi, SceneElement, SceneFiles, SerializableScene } from "../types";

export interface EAStyle {
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  strokeStyle: string;
  roughness: number;
  opacity: number;
  fontSize: number;
  fontFamily: number;
  textAlign: string;
}

const DEFAULT_STYLE: EAStyle = {
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 1,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  fontSize: 20,
  fontFamily: 1,
  textAlign: "left",
};

type Skeleton = Record<string, unknown> & { type: string; id: string; groupIds?: string[] };

/** Frame-like element types (Excalidraw frames spec): they must be emitted after their children. */
const isFrameType = (type: string): boolean => type === "frame" || type === "magicframe";

export class ExcalidrawAutomate {
  public style: EAStyle;

  private api: ExcalidrawApi;
  private skeletons: Skeleton[] = [];
  private editDict: Record<string, SceneElement> = {};
  // Already-converted elements (e.g. Mermaid output) staged outside the skeleton pipeline.
  private prebuilt: SceneElement[] = [];
  // Binary files (e.g. the image for an unsupported Mermaid diagram) to register on commit.
  private pendingFiles: SceneFiles = {};

  constructor(api: ExcalidrawApi) {
    this.api = api;
    this.style = { ...DEFAULT_STYLE };
  }

  setStyle(patch: Partial<EAStyle>): void {
    Object.assign(this.style, patch);
  }

  private shapeStyle(): Record<string, unknown> {
    return {
      strokeColor: this.style.strokeColor,
      backgroundColor: this.style.backgroundColor,
      fillStyle: this.style.fillStyle,
      strokeWidth: this.style.strokeWidth,
      strokeStyle: this.style.strokeStyle,
      roughness: this.style.roughness,
      opacity: this.style.opacity,
    };
  }

  // --- workbench: create new elements ---------------------------------------

  /**
   * Build a skeleton `label` from the current text style. When passed to
   * `convertToExcalidrawElements` on a container (rect/ellipse/diamond) or an arrow, it
   * auto-creates a bound, centered text child — no manual coordinates, and the text moves
   * with its shape. Prefer this over a separate `addText` for text inside a shape.
   */
  private labelFor(text: string | undefined): Record<string, unknown> | undefined {
    if (text === undefined || text === "") {
      return undefined;
    }
    return { label: { text, fontSize: this.style.fontSize } };
  }

  addRect(x: number, y: number, width: number, height: number, label?: string): string {
    const id = nanoid();
    this.skeletons.push({
      id,
      type: "rectangle",
      x,
      y,
      width,
      height,
      ...this.shapeStyle(),
      ...this.labelFor(label),
    });
    return id;
  }

  addEllipse(x: number, y: number, width: number, height: number, label?: string): string {
    const id = nanoid();
    this.skeletons.push({
      id,
      type: "ellipse",
      x,
      y,
      width,
      height,
      ...this.shapeStyle(),
      ...this.labelFor(label),
    });
    return id;
  }

  addDiamond(x: number, y: number, width: number, height: number, label?: string): string {
    const id = nanoid();
    this.skeletons.push({
      id,
      type: "diamond",
      x,
      y,
      width,
      height,
      ...this.shapeStyle(),
      ...this.labelFor(label),
    });
    return id;
  }

  addText(x: number, y: number, text: string): string {
    const id = nanoid();
    this.skeletons.push({
      id,
      type: "text",
      x,
      y,
      text,
      fontSize: this.style.fontSize,
      fontFamily: this.style.fontFamily,
      textAlign: this.style.textAlign,
      strokeColor: this.style.strokeColor,
      opacity: this.style.opacity,
    });
    return id;
  }

  addLine(points: [number, number][]): string {
    return this.addLinear("line", points);
  }

  addArrow(points: [number, number][]): string {
    return this.addLinear("arrow", points);
  }

  private addLinear(type: "line" | "arrow", points: [number, number][]): string {
    const id = nanoid();
    const [ox, oy] = points[0] ?? [0, 0];
    this.skeletons.push({
      id,
      type,
      x: ox,
      y: oy,
      points: points.map(([px, py]) => [px - ox, py - oy]),
      strokeColor: this.style.strokeColor,
      strokeWidth: this.style.strokeWidth,
      strokeStyle: this.style.strokeStyle,
      roughness: this.style.roughness,
      opacity: this.style.opacity,
    });
    return id;
  }

  /**
   * Draw an arrow that is BOUND to two shapes created earlier in this run, optionally
   * labelled. Unlike `addArrow(points)` (raw coordinates), a bound arrow stays attached to
   * its shapes when they move and needs no manual endpoint math — prefer it for connecting
   * shapes. `fromId`/`toId` must be ids returned by `addRect`/`addEllipse`/`addDiamond` (or
   * `addText`) earlier in THIS script run. Returns the arrow id.
   *
   * Implementation: we seed the arrow with center-to-center geometry AND a `start`/`end`
   * binding by id. `convertToExcalidrawElements` turns the bindings into real
   * startBinding/endBinding (clipped to the shapes' edges at render); the seed points keep
   * it sane even if a renderer doesn't re-route.
   */
  connect(fromId: string, toId: string, label?: string): string {
    const from = this.skeletons.find((sk) => sk.id === fromId);
    const to = this.skeletons.find((sk) => sk.id === toId);
    if (!from || !to) {
      throw new Error(
        "connect: fromId/toId must reference shapes created earlier in this script, " +
          "e.g. const a = ea.addRect(...); const b = ea.addRect(...); ea.connect(a, b);",
      );
    }
    const center = (sk: Skeleton): [number, number] => {
      const x = Number(sk.x ?? 0);
      const y = Number(sk.y ?? 0);
      const w = Number(sk.width ?? 0);
      const h = Number(sk.height ?? 0);
      return [x + w / 2, y + h / 2];
    };
    const [x1, y1] = center(from);
    const [x2, y2] = center(to);
    const id = nanoid();
    this.skeletons.push({
      id,
      type: "arrow",
      x: x1,
      y: y1,
      points: [
        [0, 0],
        [x2 - x1, y2 - y1],
      ],
      start: { id: fromId },
      end: { id: toId },
      strokeColor: this.style.strokeColor,
      strokeWidth: this.style.strokeWidth,
      strokeStyle: this.style.strokeStyle,
      roughness: this.style.roughness,
      opacity: this.style.opacity,
      ...this.labelFor(label),
    });
    return id;
  }

  /** Group the given element ids (workbench or copied-for-editing). Returns the group id. */
  addToGroup(ids: string[]): string {
    const groupId = nanoid();
    for (const sk of this.skeletons) {
      if (ids.includes(sk.id)) {
        sk.groupIds = [...(sk.groupIds ?? []), groupId];
      }
    }
    for (const id of ids) {
      const el = this.editDict[id];
      if (el) {
        el.groupIds = [...(el.groupIds ?? []), groupId];
      }
    }
    return groupId;
  }

  /**
   * Wrap the given children in a frame (an Excalidraw container element).
   *
   * `childIds` must be ids returned by `add*` earlier in THIS script run. The frame is
   * auto-sized to the children's bounding box + 10px padding, each child gets its
   * `frameId` set to the new frame, and — per the Excalidraw frames spec — the frame is
   * emitted *after* its children in the elements array (see {@link getElements}) so the
   * renderer clips it correctly. Returns the frame id.
   *
   * Frames cannot be auto-sized without children, so an empty/unknown `childIds` throws.
   */
  addFrame(name: string, childIds: string[]): string {
    const known = new Set(this.skeletons.map((sk) => sk.id));
    const children = childIds.filter((id) => known.has(id));
    if (children.length === 0) {
      throw new Error(
        "addFrame: childIds must reference shapes created earlier in this script, " +
          "e.g. const a = ea.addRect(...); ea.addFrame('Grup', [a]);",
      );
    }
    const id = nanoid();
    // No x/y/width/height: convertToExcalidrawElements auto-fits the frame to its children.
    this.skeletons.push({ id, type: "frame", name, children });
    return id;
  }

  /**
   * Render a Mermaid diagram into the scene. The Mermaid text is parsed by
   * `@excalidraw/mermaid-to-excalidraw` into Excalidraw element skeletons, converted, and
   * staged like any other workbench output (committed by {@link addElementsToView}).
   *
   * Only **flowcharts** become real, editable shapes + arrows (subgraphs become frames);
   * every other diagram type comes back as a single static **image** (added via files).
   * Returns the ids of the created elements.
   *
   * Async and browser-only — Mermaid renders through the DOM. Usage:
   * `await ea.addMermaid("flowchart TD\n A[Mulai] --> B{OK?}");`
   */
  async addMermaid(definition: string): Promise<string[]> {
    // Lazy-import so Mermaid (heavy) only loads when actually used.
    const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
    let result: { elements: unknown[]; files?: Record<string, unknown> };
    try {
      result = await parseMermaidToExcalidraw(definition, {
        themeVariables: { fontSize: `${this.style.fontSize}px` },
      });
    } catch (e) {
      throw new Error(`Mermaid tidak valid — ${(e as Error).message}`);
    }
    // regenerateIds: true — Mermaid ids are self-contained (bindings/frameId are remapped
    // consistently by convert), and fresh ids avoid colliding with the scene or a 2nd call.
    const converted = convertToExcalidrawElements(result.elements as never, {
      regenerateIds: true,
    }) as unknown as SceneElement[];
    this.prebuilt.push(...converted);
    if (result.files) {
      Object.assign(this.pendingFiles, result.files);
    }
    return converted.map((el) => el.id);
  }

  // --- workbench: read / edit existing scene elements -----------------------

  getViewElements(): readonly SceneElement[] {
    return this.api.getSceneElements();
  }

  getViewSelectedElements(): SceneElement[] {
    const selected = this.api.getAppState().selectedElementIds ?? {};
    return this.api.getSceneElements().filter((el) => selected[el.id]);
  }

  /** Copy scene elements into the workbench so they can be mutated, then re-committed. */
  copyViewElementsToEAforEditing(elements: readonly SceneElement[]): void {
    for (const el of elements) {
      this.editDict[el.id] = JSON.parse(JSON.stringify(el)) as SceneElement;
    }
  }

  /** Materialize all workbench elements (new skeletons + edited copies). */
  getElements(): SceneElement[] {
    let converted: SceneElement[] = [];
    if (this.skeletons.length > 0) {
      // Frames must come AFTER their children in the elements array (Excalidraw frames
      // spec) — children are normally created first anyway, but order frames last
      // regardless of call order so clipping/rendering stays correct. convert reads each
      // frame's `children` ids, sets `frameId` on those children, and auto-sizes the frame.
      const ordered = [
        ...this.skeletons.filter((sk) => !isFrameType(sk.type)),
        ...this.skeletons.filter((sk) => isFrameType(sk.type)),
      ];
      converted = convertToExcalidrawElements(ordered as never, {
        regenerateIds: false,
      }) as unknown as SceneElement[];
      // Re-apply groupIds by id in case the converter drops them.
      const byId = new Map(this.skeletons.map((s) => [s.id, s]));
      for (const el of converted) {
        const sk = byId.get(el.id);
        if (sk?.groupIds) {
          el.groupIds = sk.groupIds;
        }
      }
    }
    return [...converted, ...Object.values(this.editDict), ...this.prebuilt];
  }

  clear(): void {
    this.skeletons = [];
    this.editDict = {};
    this.prebuilt = [];
    this.pendingFiles = {};
  }

  /**
   * Load a raw Excalidraw scene without rebuilding it through skeleton converters.
   * `replace` preserves ids/seeds/order for lossless reproduction; `insert` creates fresh
   * ids and remaps bindings, groups, frames, and files so the template can be reused.
   */
  async loadScene(scene: SerializableScene, options: SceneLoadOptions = {}): Promise<boolean> {
    this.clear();
    return loadSceneIntoApi(this.api, scene, options);
  }

  /** Decode, verify, and load code generated by the Scene as Code exporter. */
  async loadSceneCode(payload: string, options: SceneLoadOptions = {}): Promise<boolean> {
    const artifact = await decodeSceneArtifact(payload, options.verifyChecksum ?? true);
    return this.loadScene(artifact.scene, options);
  }

  // --- commit ---------------------------------------------------------------

  /** Merge the workbench into the live scene by id, then render. Clears the workbench. */
  async addElementsToView(): Promise<boolean> {
    const newElements = this.getElements();
    if (newElements.length === 0) {
      return false;
    }
    const byId = new Map(newElements.map((el) => [el.id, el]));
    const used = new Set<string>();
    const merged: SceneElement[] = [];

    for (const el of this.api.getSceneElements()) {
      const replacement = byId.get(el.id);
      if (replacement) {
        merged.push(replacement);
        used.add(el.id);
      } else {
        merged.push(el);
      }
    }
    for (const el of newElements) {
      if (!used.has(el.id)) {
        merged.push(el);
      }
    }

    // Register any binary files (e.g. a Mermaid image) before the scene references them.
    const files = Object.entries(this.pendingFiles);
    if (files.length > 0 && this.api.addFiles) {
      this.api.addFiles(files.map(([id, f]) => ({ id, ...(f as object) })));
    }

    this.api.updateScene({ elements: merged });
    this.clear();
    return true;
  }
}
