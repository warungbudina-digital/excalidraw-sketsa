# Extending the EA SYSTEM_PROMPT with a new layout/diagram pattern (+ fidelity ceiling)

## What to know
Recurring request: "make the AI draw <some visual> accurately" (floor plans, GA
drawings, org charts…). The lever is `src/ai/ollama.ts` `SYSTEM_PROMPT` — the SINGLE
source of EA knowledge sent per request (no Modelfile anymore; ollama backend removed).
The established way to add a capability, done for the "Denah / Floor plan" pattern:

1. Add a compact RECIPE block to the "EA manual patterns" area — it sits BETWEEN the
   Gantt block (`ea.addRect(150, 105, 350, 45, "Desain (W1-W2)");`) and the `Rules:`
   line. Mirror the terse style of the existing Kanban/C4/Gantt/Timeline recipes:
   real `ea.*` calls with concrete x/y/w/h, built from primitives.
2. Optionally add one-click `PROMPT_PRESETS` chips ({label, prompt}) before the closing
   `];`. They render in the scrollable `.preset-row`; ~17 chips fit (row scrolls).
3. Prompt-only — NO change to ExcalidrawAutomate.ts. Verify with
   `./node_modules/.bin/tsc --noEmit && npm run build`. Then `docker compose up -d
   --build app` (the prompt is baked into the browser bundle, so a rebuild is required
   for it to take effect — editing ollama.ts alone changes nothing live).

GOTCHA: `SYSTEM_PROMPT` is a backtick TEMPLATE LITERAL spanning ~130 lines. Any backtick
inside the recipe must be escaped `\`` and `${...}` must be avoided (or it interpolates).
Existing escaped examples: `await ea.addMermaid(\`flowchart TD ...\`)`. Keep new recipe
code backtick-free (use plain `ea.addRect(...)`, `for (let i...)`, `String(n)` etc.).

## Fidelity ceiling (set expectations honestly)
EA primitives are addRect/addEllipse/addDiamond/addText/addLine/addArrow/connect/addFrame.
Hard limits that cap visual reproduction of detailed CAD/GA artwork:
- NO Bézier/spline — organic curves (ship hulls, etc.) only as POLYGONAL addLine.
- Lines/non-rect shapes are NOT fillable — irregular filled areas must be tiled with rects;
  `fillStyle:"hachure"` is rough diagonal, not parallel planks/teak.
- No symbol library — every chair/bed/sink is hand-assembled from primitives.
- An LLM placing 100s of exact coordinates drifts; symmetry-by-mirroring helps, not pixel-perfect.
Realistic output = clean SCHEMATIC layouts (~70-80% style match for simple plans, lower for
dense/organic ones), NOT a 98% CAD reproduction. For true precision the right tool is CAD /
SVG import, not EA. (Note: an `addPolygon(points, fill)` EA primitive would lift the
fill/outline limit — a deliberate ExcalidrawAutomate.ts + convert change, not done yet.)

## Verification
```sh
./node_modules/.bin/tsc --noEmit   # catches an unescaped backtick / ${ in SYSTEM_PROMPT
npm run build                      # bundle must succeed
# Manual: docker compose up -d --build app, then Script panel → new preset chip → Generate
```
