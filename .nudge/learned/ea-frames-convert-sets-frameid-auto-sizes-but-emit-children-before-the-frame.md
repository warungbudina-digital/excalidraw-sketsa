# EA frames: convert sets frameId + auto-sizes, but emit children BEFORE the frame

## What to know
`convertToExcalidrawElements` (from `@excalidraw/excalidraw` 0.18.x) DOES support frames
via a skeleton `{ id, type: "frame", name, children: [childId, ...] }`. In
`src/automate/ExcalidrawAutomate.ts`, `addFrame(name, childIds)` pushes that skeleton.
Verified behavior (read from dist/dev/index.js `convertToExcalidrawElements`):
- It iterates `frame.children` ids, maps old->new via `oldToNewElementIdMap`, and sets
  `frameId = frame.id` on each child. With `regenerateIds: false` (what EA passes) the ids
  stay stable, so children referenced by our nanoid ids bind correctly.
- The frame is **auto-sized** to the children's common bounds + 10px PADDING **only when
  its x/y/width/height are falsy**. Code is `frame?.x || minX` etc. — so passing an explicit
  `x: 0` (or y/w/h = 0) is treated as "unset" and snaps to the children box. Don't pass 0
  coords expecting them to stick; omit them and let it auto-fit (what EA does).
- Empty `children` => `getCommonBounds([])` => Infinity/NaN bounds. EA throws if childIds is
  empty/unknown instead of producing a broken frame.
- **Ordering:** convert returns elements in INSERTION (array) order; it does NOT reorder.
  Per the frames spec the frame must come AFTER its children. So `getElements()` reorders
  skeletons as `[...non-frames, ...frames]` before calling convert. `addElementsToView`'s
  merge then appends new elements in that order, keeping children-before-frame in the scene.

## Can't run convert in node to probe it
`convertToExcalidrawElements` is only reachable via the package index, which pulls in
react-dom; react-dom does DOM feature-detection at import (`element.setAttribute(...)`) and
throws under node even with window/document/location shims (would need jsdom). So the
esbuild->node harness pattern does NOT work for anything importing the excalidraw index.
Verify convert behavior by reading `node_modules/@excalidraw/excalidraw/dist/dev/index.js`
instead, and verify the pure EA ordering/helper logic with a plain `node -e` snippet.
