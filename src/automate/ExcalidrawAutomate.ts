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
import type { ExcalidrawApi, SceneElement } from "../types";

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

  addRect(x: number, y: number, width: number, height: number): string {
    const id = nanoid();
    this.skeletons.push({ id, type: "rectangle", x, y, width, height, ...this.shapeStyle() });
    return id;
  }

  addEllipse(x: number, y: number, width: number, height: number): string {
    const id = nanoid();
    this.skeletons.push({ id, type: "ellipse", x, y, width, height, ...this.shapeStyle() });
    return id;
  }

  addDiamond(x: number, y: number, width: number, height: number): string {
    const id = nanoid();
    this.skeletons.push({ id, type: "diamond", x, y, width, height, ...this.shapeStyle() });
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
    return [...converted, ...Object.values(this.editDict)];
  }

  clear(): void {
    this.skeletons = [];
    this.editDict = {};
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

    this.api.updateScene({ elements: merged });
    this.clear();
    return true;
  }
}
