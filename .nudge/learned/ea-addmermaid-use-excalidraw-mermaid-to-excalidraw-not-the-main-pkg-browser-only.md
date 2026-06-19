# ea.addMermaid: use @excalidraw/mermaid-to-excalidraw (not the main pkg), browser-only

## What to know
`ea.addMermaid(definition)` in `src/automate/ExcalidrawAutomate.ts` renders Mermaid via
`parseMermaidToExcalidraw`. Hard-won facts:
- It is NOT re-exported by `@excalidraw/excalidraw` (only used internally in TTDDialog). Use
  the separate package `@excalidraw/mermaid-to-excalidraw` (already present TRANSITIVELY as
  2.2.2 because Excalidraw bundles it). Import: `await import("@excalidraw/mermaid-to-excalidraw")`.
- Signature: `parseMermaidToExcalidraw(def, config?) => Promise<MermaidToExcalidrawResult>` where
  the result is `{ elements: ExcalidrawElementSkeleton[]; files?: BinaryFiles }`. So feed
  `result.elements` into `convertToExcalidrawElements`, and register `result.files` via
  `api.addFiles(Object.entries(files).map(([id,f]) => ({id, ...f})))` before updateScene.
- Output depends on diagram type: only **flowchart** yields editable shapes+arrows (subgraphs
  become frames). EVERY other type (sequence/gantt/class/pie/...) comes back as ONE image
  skeleton in `elements` + the dataURL in `files` (GraphImage fallback). Not an error.
- Use `convertToExcalidrawElements(result.elements, { regenerateIds: true })` for Mermaid —
  the OPPOSITE of the EA workbench (which uses false). Mermaid ids are self-contained, convert
  remaps internal bindings/frameId consistently, and fresh ids avoid colliding with the scene
  or a second addMermaid call.
- config fonts: `MermaidConfig.themeVariables.fontSize` is a STRING px (e.g. "20px"), not a number.
- It is **async and browser-only** (Mermaid + convert need the DOM) — you CANNOT exercise it in
  a node/esbuild harness; verify via typecheck + build, run it in the browser for real output.

## Gotcha: declaring the dep
The package was only a transitive dep. Adding it to `package.json` requires syncing the
lockfile or the Docker build's `npm ci` fails ("can't be in sync"). Sync without touching
node_modules (matters on the disk-tight ephemeral host): `npm install --package-lock-only`.

## Verification
`npm run typecheck` passes; `docker compose build app` succeeds (the lazy `import()` becomes a
mermaid chunk). The model emitting `ea.addMermaid(\`flowchart TD ...\`)` is a separate concern —
see the testing-excalidraw-ea note (warm the model + cap num_predict, or CPU runs time out).
