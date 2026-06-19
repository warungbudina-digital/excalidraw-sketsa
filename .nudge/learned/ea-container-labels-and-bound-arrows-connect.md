# EA wrapper: container labels + bound arrows (ea.connect) — verified via convert

## What to know
`src/automate/ExcalidrawAutomate.ts` exposes two skeleton features beyond raw shapes, both
passed straight through `convertToExcalidrawElements` (the `ExcalidrawElementSkeleton` API):

- **Container labels:** `addRect/addEllipse/addDiamond(x, y, w, h, label?)`. When `label` is set,
  the skeleton carries `label: { text, fontSize }`; convert emits a SEPARATE text element with
  `containerId` = the shape, and the shape's `boundElements` lists it. Centered + bound — moves
  with the box. Prefer over a standalone `addText` for text that lives inside a shape.
- **Bound arrows:** `connect(fromId, toId, label?)`. Emits an arrow skeleton with
  `start: { id: fromId }`, `end: { id: toId }` (+ seed center-to-center `points`/`x`/`y`, and an
  optional `label`). convert turns the bindings into real `startBinding`/`endBinding`; both shapes
  get the arrow in their `boundElements`. The arrow stays attached when shapes move. Prefer over
  `addArrow(points)` for connecting shapes. `fromId/toId` must be ids returned by `add*` earlier
  in the SAME run (looked up in `this.skeletons`); otherwise it throws (like `addFrame`).

## Why it works here
The wrapper calls `convertToExcalidrawElements(ordered, { regenerateIds: false })`, so within-batch
id references (`start.id`/`end.id`, and `label`) resolve against the preserved nanoid ids — same
id-map mechanism that makes frame `children` work. Keep `regenerateIds: false`.

## Verification (how it was proven)
node_modules is wiped each Cloud Shell session. To run convert under node: bundle a harness with
esbuild (`--platform=node --loader:.css=empty`) and inject a DOM/canvas shim via `--banner:js`
(stub `window`, `navigator`, `document.createElement().getContext()`, and DOM constructor
prototypes `Element`/`Node`/`HTMLCanvasElement`/... — the package patches `*.prototype` at import).
Result for a rect+label, ellipse+label, and `connect`-ed labelled arrow: 3 bound text elements
(containerId set), `startBinding -> rect`, `endBinding -> ellipse`, both shapes' boundElements list
the arrow. Keep the harness ENTRY inside the project dir so the bare import resolves.

## Sync requirement
The prompts that teach these (`src/ai/ollama.ts` SYSTEM_PROMPT + `Modelfile` SYSTEM) must stay in
sync — see [[testing-excalidraw-ea-a-request-system-message-replaces-the-modelfile-system]]. The
in-app prompt (ollama.ts) is the operative one for both the cloud (ai-proxy/gpt-5-mini) and local
backends; the Modelfile SYSTEM only drives bare `ollama run excalidraw-ea`.
