# EA: convertToExcalidrawElements regenerates element ids by default

## What went wrong
In `src/automate/ExcalidrawAutomate.ts`, the EA workbench pre-assigns each new element a
`nanoid` (so `addRect(...)` etc. can return an id and `addToGroup([...])` can reference
it). But `convertToExcalidrawElements(skeletons)` from `@excalidraw/excalidraw`
**regenerates ids by default**, so the returned id no longer matched the element in the
scene — breaking `addToGroup` and the "returns id" contract, and the merge-by-id logic in
`addElementsToView`.

## Fix
Pass `{ regenerateIds: false }` so provided skeleton ids are preserved:
`convertToExcalidrawElements(skeletons, { regenerateIds: false })`.
Also re-apply `groupIds` from each skeleton onto the converted element by id, since the
converter can drop them. (Index mapping is 1:1 only for simple shapes/text — containers
with bound text would produce extra elements.)

## Verification
`npm run build` passes, and a script that does `const a = ea.addRect(...); const b =
ea.addText(...); ea.addToGroup([a,b]); await ea.addElementsToView();` produces a single
group whose returned ids match the on-canvas elements.
