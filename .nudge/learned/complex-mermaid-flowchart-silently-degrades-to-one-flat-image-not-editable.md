# Complex Mermaid flowchart silently degrades to ONE flat image (not editable)

## What went wrong
A user generated a big architecture **flowchart** via `ea.addMermaid` (~35 nodes,
nested subgraphs, `<br>`/HTML labels). It rendered, but "Scene → Code" produced a
giant base64 payload, not editable `ea.*` calls. Root cause: the scene contained
exactly ONE element — `type:"image"`, `mimeType:"image/svg+xml"`, `status:"error"`.

`parseMermaidToExcalidraw` (in `src/automate/ExcalidrawAutomate.ts` `addMermaid`)
normally turns a flowchart into native shapes, but when the flowchart is too complex
(deeply nested subgraphs, `<br>`/HTML in node labels) its internal conversion FAILS
and it **silently falls back to embedding the rendered SVG as a single image** — it
does NOT throw, so the `try/catch` around it (which only catches outright parse
errors) never fires. An image is pixels; the Scene → Code decompiler
(`src/scene-code/decompile.ts`) can only emit it via `ea.addRawElements([...])` — the
"payload". No decompiler can turn an image back into shapes.

Note: static-image diagram types (gantt/pie/sequence/journey/gitgraph/sankey/timeline/
xychart) return an image BY DESIGN — that is expected, not a failure.

## Fix (3 layers, all in the browser bundle — need `docker compose up -d --build app`)
1. PROMPT (`src/ai/ollama.ts` SYSTEM_PROMPT — the single source of EA knowledge):
   steer the model to keep flowcharts simple (short single-line labels, NO `<br>`,
   subgraphs ≤1 level) and to build LARGE/complex/architecture diagrams from primitives
   (`addRect`/`connect`/`addFrame`) instead of `addMermaid`.
2. RUNTIME GUARD (`addMermaid`): after convert, if the definition is a `flowchart`/`graph`
   AND every converted element is `type:"image"`, THROW an actionable error instead of
   staging junk. Guard ONLY flowchart/graph (static-image types legitimately return an image).
   IMPORTANT: this fails the script LOUDLY at run time (► Jalankan) — it is NOT a
   generation retry. The backend shim's validation gate only PARSES the script
   (AsyncFunction + `/\bea\./`); it never executes it, so a runtime throw can't reach it.
3. DIAGNOSTIC (`decompile.ts`): the raw-fallback block now lists per-type/per-reason what
   became payload (e.g. "• 1× image — tipe tanpa builder EA") so the cause is visible.

## Verification
`ExcalidrawAutomate.ts` is browser-only (its value-import of `convertToExcalidrawElements`
drags in react-dom — see [[no-test-runner-verify-ts-logic-by-bundling-with-esbuild-then-node]]),
so `addMermaid` can't be node-tested. Verify via `./node_modules/.bin/tsc --noEmit` +
`npm run build`. Manual: in the app, generate a deeply-nested flowchart with `<br>` labels
and run it — expect a clear error in the run-log, not a flat image. See also
[[ea-addmermaid-use-excalidraw-mermaid-to-excalidraw-not-the-main-pkg-browser-only]].
