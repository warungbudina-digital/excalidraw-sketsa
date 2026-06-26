/**
 * Scene -> readable EA script ("decompiler").
 *
 * The inverse of running an EA script: it turns the live scene into a readable sequence of
 * `ea.*` calls that rebuild it, using exactly the API this project's workbench exposes
 * (see `src/automate/ExcalidrawAutomate.ts`). Unlike `generateSceneCode` (artifact.ts) — which
 * emits an opaque, checksum-locked payload optimised for LOSSLESS reproduction — this output
 * is meant to be READ and EDITED (by a human or the AI), then run with `► Jalankan`.
 *
 * Coverage:
 * - rectangle / ellipse / diamond  -> ea.addRect/addEllipse/addDiamond (bound text -> label arg)
 * - text (standalone)              -> ea.addText
 * - line                           -> ea.addLine (points made absolute)
 * - arrow bound to two shapes       -> ea.connect; otherwise ea.addArrow(points)
 * - frame                          -> ea.addFrame(name, [children])
 * - shared groupIds                -> ea.addToGroup([...])
 * - per-element style              -> ea.setStyle({...}) (only the keys that changed)
 *
 * Anything EA has no builder for (image, freedraw, embeddable, a rotated shape, …) is emitted
 * verbatim through `ea.addRawElements(...)` so the script stays runnable AND exact for it.
 */
import type { SceneElement, SceneFiles, SerializableScene } from "../types";

const SUPPORTED = new Set(["rectangle", "ellipse", "diamond", "text", "line", "arrow", "frame"]);

const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
/** JSON.stringify produces a safe, escaped JS literal we can embed directly in the script. */
const lit = (value: unknown): string => JSON.stringify(value);
const labelText = (el: SceneElement): string => str(el.originalText) ?? str(el.text) ?? "";

const VAR_PREFIX: Record<string, string> = {
  rectangle: "r",
  ellipse: "el",
  diamond: "d",
  text: "t",
  line: "ln",
  arrow: "ar",
};

/** Build a readable EA script that reconstructs `scene`. Pure (no DOM) — safe to unit-test. */
export function sceneToEAScript(scene: SerializableScene): string {
  const elements = scene.elements.filter((el) => !el.isDeleted);

  // Text with a containerId is a label living inside a shape/arrow — fold it into that
  // element's `label` argument instead of emitting it as a standalone addText.
  const labelByContainer = new Map<string, SceneElement>();
  const foldedTextIds = new Set<string>();
  for (const el of elements) {
    const containerId = el.type === "text" ? str(el.containerId) : undefined;
    if (containerId) {
      labelByContainer.set(containerId, el);
      foldedTextIds.add(el.id);
    }
  }

  // A supported element is emitted readably only if EA can reproduce it. Rotation has no EA
  // builder arg, so a rotated element is preserved losslessly via addRawElements instead.
  const isReadable = (el: SceneElement): boolean => SUPPORTED.has(el.type) && num(el.angle) === 0;

  const shapesText: SceneElement[] = [];
  const arrows: SceneElement[] = [];
  const frames: SceneElement[] = [];
  // Each raw element carries WHY it couldn't be emitted readably, so the output can
  // explain the payload to the user instead of dumping an opaque blob.
  const raw: { el: SceneElement; reason: string }[] = [];
  for (const el of elements) {
    if (foldedTextIds.has(el.id)) continue;
    if (!isReadable(el)) {
      raw.push({ el, reason: SUPPORTED.has(el.type) ? "dirotasi (angle≠0)" : "tipe tanpa builder EA" });
    } else if (el.type === "arrow") {
      arrows.push(el);
    } else if (el.type === "frame") {
      frames.push(el);
    } else {
      shapesText.push(el);
    }
  }

  const varOf = new Map<string, string>();
  const counters: Record<string, number> = {};
  const nameFor = (type: string): string => {
    const prefix = VAR_PREFIX[type] ?? "e";
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    return `${prefix}${counters[prefix]}`;
  };

  const lines: string[] = [];

  // --- style diffing: only emit ea.setStyle for keys that actually change ---
  const current: Record<string, unknown> = {
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
  const emitStyle = (want: Record<string, unknown>): void => {
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(want)) {
      if (value !== undefined && value !== current[key]) {
        patch[key] = value;
        current[key] = value;
      }
    }
    if (Object.keys(patch).length > 0) lines.push(`ea.setStyle(${lit(patch)});`);
  };
  const shapeStyle = (el: SceneElement): Record<string, unknown> => ({
    strokeColor: str(el.strokeColor),
    backgroundColor: str(el.backgroundColor),
    fillStyle: str(el.fillStyle),
    strokeWidth: el.strokeWidth,
    strokeStyle: str(el.strokeStyle),
    roughness: el.roughness,
    opacity: el.opacity,
  });

  // line/arrow store points relative to x,y; EA's addLine/addArrow take absolute coordinates.
  const absolutePoints = (el: SceneElement): [number, number][] | null => {
    if (!Array.isArray(el.points)) return null;
    const ox = num(el.x);
    const oy = num(el.y);
    const points = (el.points as unknown[])
      .filter((p): p is [number, number] => Array.isArray(p))
      .map(([px, py]) => [ox + num(px), oy + num(py)] as [number, number]);
    return points.length >= 2 ? points : null;
  };

  // --- shapes / standalone text / lines ---
  for (const el of shapesText) {
    if (el.type === "text") {
      emitStyle({
        strokeColor: str(el.strokeColor),
        opacity: el.opacity,
        fontSize: el.fontSize,
        fontFamily: el.fontFamily,
        textAlign: str(el.textAlign),
      });
      const v = nameFor("text");
      varOf.set(el.id, v);
      lines.push(`const ${v} = ea.addText(${num(el.x)}, ${num(el.y)}, ${lit(labelText(el))});`);
      continue;
    }
    if (el.type === "line") {
      const points = absolutePoints(el);
      if (!points) {
        raw.push({ el, reason: "garis tanpa titik valid" });
        continue;
      }
      emitStyle(shapeStyle(el));
      const v = nameFor("line");
      varOf.set(el.id, v);
      lines.push(`const ${v} = ea.addLine(${lit(points)});`);
      continue;
    }
    // rectangle / ellipse / diamond
    const label = labelByContainer.get(el.id);
    emitStyle({ ...shapeStyle(el), fontSize: label ? label.fontSize : undefined });
    const builder = el.type === "rectangle" ? "addRect" : el.type === "ellipse" ? "addEllipse" : "addDiamond";
    const v = nameFor(el.type);
    varOf.set(el.id, v);
    const args = `${num(el.x)}, ${num(el.y)}, ${num(el.width)}, ${num(el.height)}`;
    const labelArg = label ? `, ${lit(labelText(label))}` : "";
    lines.push(`const ${v} = ea.${builder}(${args}${labelArg});`);
  }

  // --- arrows: bound -> connect, else raw points -> addArrow, else losslessly raw ---
  const bindingId = (binding: unknown): string | undefined =>
    binding && typeof binding === "object" ? str((binding as { elementId?: unknown }).elementId) : undefined;
  for (const el of arrows) {
    const fromVar = varOf.get(bindingId(el.startBinding) ?? "");
    const toVar = varOf.get(bindingId(el.endBinding) ?? "");
    const label = labelByContainer.get(el.id);
    if (fromVar && toVar) {
      emitStyle({
        strokeColor: str(el.strokeColor),
        strokeWidth: el.strokeWidth,
        strokeStyle: str(el.strokeStyle),
        roughness: el.roughness,
        opacity: el.opacity,
        fontSize: label ? label.fontSize : undefined,
      });
      const v = nameFor("arrow");
      varOf.set(el.id, v);
      lines.push(`const ${v} = ea.connect(${fromVar}, ${toVar}${label ? `, ${lit(labelText(label))}` : ""});`);
      continue;
    }
    const points = absolutePoints(el);
    if (!points) {
      raw.push({ el, reason: "panah tanpa binding & titik valid" });
      continue;
    }
    emitStyle(shapeStyle(el));
    const v = nameFor("arrow");
    varOf.set(el.id, v);
    lines.push(`const ${v} = ea.addArrow(${lit(points)});`);
  }

  // --- groups: a groupId shared by >=2 emitted elements ---
  const groupMembers = new Map<string, string[]>();
  for (const el of elements) {
    const v = varOf.get(el.id);
    if (!v) continue;
    for (const groupId of Array.isArray(el.groupIds) ? el.groupIds : []) {
      const members = groupMembers.get(groupId) ?? [];
      members.push(v);
      groupMembers.set(groupId, members);
    }
  }
  for (const members of groupMembers.values()) {
    if (members.length >= 2) lines.push(`ea.addToGroup([${members.join(", ")}]);`);
  }

  // --- frames: must come after their children (which already have vars) ---
  for (const el of frames) {
    const childVars = elements
      .filter((child) => str(child.frameId) === el.id && varOf.has(child.id))
      .map((child) => varOf.get(child.id) as string);
    if (childVars.length === 0) {
      raw.push({ el, reason: "frame tanpa anak ter-emit" });
      continue;
    }
    lines.push(`ea.addFrame(${lit(str(el.name) ?? "Frame")}, [${childVars.join(", ")}]);`);
  }

  // --- everything EA can't express: emitted verbatim, with its files ---
  if (raw.length > 0) {
    const files: SceneFiles = {};
    const cleaned = raw.map(({ el }) => {
      const copy = { ...el } as SceneElement;
      // Its frame (if any) was rebuilt with a fresh id, so this reference can't survive; drop
      // it rather than leave a dangling link. The element still renders, just unframed.
      delete (copy as Record<string, unknown>).frameId;
      const fileId = str(el.fileId);
      if (fileId && scene.files[fileId] !== undefined) files[fileId] = scene.files[fileId];
      return copy;
    });
    const filesArg = Object.keys(files).length > 0 ? `, ${lit(files)}` : "";

    // Diagnostic breakdown: "<count> <type> (<reason>)" per distinct type+reason, so the
    // user can SEE what became payload and why — instead of staring at an opaque blob.
    const breakdown = new Map<string, number>();
    for (const { el, reason } of raw) {
      const key = `${el.type}::${reason}`;
      breakdown.set(key, (breakdown.get(key) ?? 0) + 1);
    }
    lines.push(
      `// ⚠ ${raw.length} elemen di luar cakupan EA — disisipkan apa adanya (payload, sulit diedit):`,
    );
    for (const [key, count] of breakdown) {
      const [type, reason] = key.split("::");
      lines.push(`//   • ${count}× ${type} — ${reason}`);
    }
    // image/freedraw are pixels: NO decompiler can turn them into editable shapes. The only
    // way to get an editable Scene→Code is to build the diagram from EA primitives upstream.
    if (raw.some(({ el }) => el.type === "image" || el.type === "freedraw")) {
      lines.push(
        "//   → image/freedraw = piksel, tak bisa jadi shape editable. Untuk diagram yang bisa diedit,",
      );
      lines.push(
        "//     minta AI membangun dgn primitif (addRect/connect/addFrame) & hindari Mermaid gambar-statis",
      );
      lines.push("//     (gantt/pie/sequence/journey/gitgraph/sankey/timeline/xychart).");
    }
    lines.push(`ea.addRawElements(${lit(cleaned)}${filesArg});`);
  }

  const header = [
    `// Scene as Code (EA) — ${elements.length} elemen. Script readable yang membangun ulang kanvas.`,
    "// Edit langsung atau minta AI menambah ide, lalu ► Jalankan.",
    "// Hapus baris `await ea.clearView();` jika ingin MENAMBAHKAN ke kanvas (bukan mengganti).",
  ];
  return [...header, "", "await ea.clearView();", ...lines, "await ea.addElementsToView();", ""].join("\n");
}
