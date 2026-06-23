# EA rebuild script duplicates the scene unless it starts with ea.clearView()

## What went wrong
A "rebuild the whole scene" EA script — e.g. the output of Scene -> Code's decompiler
(`src/scene-code/decompile.ts` `sceneToEAScript`) — run on a NON-empty canvas silently
DUPLICATES the scene. Cause: EA's `addRect/addEllipse/.../connect/addFrame` mint FRESH
`nanoid` ids, and `addElementsToView` (`src/automate/ExcalidrawAutomate.ts`) merges new
elements into the live scene BY ID. Fresh ids never collide with the existing elements, so
every element is appended -> a second copy stacked on top of the original. (This is the flip
side of the merge-by-id design that lets `copyViewElementsToEAforEditing` + re-commit update
elements in place.)

Separately, EA has NO skeleton builder for `image`, `freedraw`, `embeddable`, or a rotated
shape (`angle != 0`), so a decompiler / round-tripper cannot rebuild those readably.

## Fix
- Emit `await ea.clearView();` as the FIRST line of any full-scene rebuild script. `clearView`
  (added alongside the decompiler) wipes the canvas via `loadSceneIntoApi(..., {mode:"replace"})`:
  it publishes tombstones (so a collaboration room won't merge the old scene back) then leaves an
  empty scene, so the subsequent `add*` calls produce exactly one copy. Deleting that line is the
  documented way to make the script ADD to the canvas instead of replacing it.
- For element types EA can't build, use `ea.addRawElements(elements, files?)`. It pushes raw
  Excalidraw elements onto the private `prebuilt` array (the SAME bypass Mermaid image output
  uses) and registers their files via `pendingFiles` — skipping `convertToExcalidrawElements`
  entirely, so they stay lossless AND runnable. Strip `frameId` from raw elements first: their
  frame was rebuilt with a fresh id, so the old reference would dangle.

## Verification
`npm run test:scene-code` (esbuild->node harness) unit-tests the PURE decompiler string output
(label folding, bound-arrow -> connect, absolute line points, frame-after-children ordering,
addRawElements + files, tombstone drop). The actual rebuild RENDER (clearView + convert) is
BROWSER-ONLY: `convertToExcalidrawElements` pulls react-dom, which throws under node even with
DOM shims — see [[ea-frames-convert-sets-frameid-auto-sizes-but-emit-children-before-the-frame]]
and [[no-test-runner-verify-ts-logic-by-bundling-with-esbuild-then-node]]. Verify end-to-end in
the running app.
