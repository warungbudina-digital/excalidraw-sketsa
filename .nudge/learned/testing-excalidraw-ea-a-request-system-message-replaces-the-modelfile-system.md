# Testing excalidraw-ea: a request `system` message REPLACES the Modelfile SYSTEM

## What went wrong
The custom Ollama model `excalidraw-ea` (built from `Modelfile`) bakes the EA API + schema
+ frames into its SYSTEM. When smoke-testing via `curl /ollama/api/chat`, sending a SHORT
`system` message produced garbage — generic `document.createElement('div')` DOM code, not
EA — because **a request's `system` message overrides/replaces the Modelfile SYSTEM**, so
the model lost all EA knowledge for that call. With NO `system` message (Modelfile SYSTEM
active) the same model returned a correct EA script using `ea.addRect/addText/addArrow/
addFrame/addElementsToView`.

Implication: the app (`src/ai/ollama.ts`) sends its OWN full system prompt, which REPLACES
the Modelfile SYSTEM at runtime. So the Modelfile SYSTEM only drives bare `ollama run
excalidraw-ea`; in-app the knowledge comes from ollama.ts. Keep BOTH prompts carrying the
EA/frames knowledge in sync (the Modelfile still gives tuned PARAMETERs + a CLI-usable model).

## Fix / how to test correctly
- To validate the BAKED knowledge, send NO `system` message (let the Modelfile SYSTEM apply).
- To mimic the APP, send the same full system prompt ollama.ts sends (don't send a short stub).
- CPU-only Cloud Shell (no GPU, no swap) is slow: first call COLD-loads the 1.5b (~1.3 GB RSS,
  no OOM at ~5 GB available) and a no-`system` call must process the large baked SYSTEM, which
  blew past a 180s curl timeout. Warm the model first (one call with `keep_alive:"5m"`), cap
  `options.num_predict` (~300), and use a generous `--max-time`. Warm runs were ~55-83s.

## Verification
Warm + Modelfile SYSTEM:
`curl -s --max-time 170 http://localhost:8080/ollama/api/chat -H 'Origin: https://x.cloudshell.dev' \
  -d '{"model":"excalidraw-ea","stream":false,"keep_alive":"5m","options":{"num_predict":320},
       "messages":[{"role":"user","content":"flowchart 3 kotak dalam frame"}]}'`
Then assert the output uses the real API:
`grep -oE 'ea\.(addRect|addText|addArrow|addFrame|setStyle|addElementsToView)' /tmp/gen.json`
must list addFrame + addElementsToView (done_reason:"stop"). A short `system` stub instead
yields non-EA DOM code — that's the override, not a model failure.
