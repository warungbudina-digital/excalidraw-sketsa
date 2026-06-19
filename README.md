# Excalidraw Sketsa

A small **standalone Excalidraw web app** that reuses the core logic of the
[obsidian-excalidraw-plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin) —
without Obsidian. It runs in the browser (e.g. on a VPS / Cloud Shell).

> This is **not** the Obsidian plugin and does not depend on it. It re-implements, at a
> much smaller scale, the *patterns* that drive the plugin: the save/load pipeline, scene
> compression, the file format, and the Excalidraw Automate scripting model.

## What it does

- **Login gate** branded for **Mesari Jaya Network dan CCTV** (simple client-side gate).
- Renders an Excalidraw canvas using the public `@excalidraw/excalidraw` package.
- **Save / Load** the scene to `localStorage` (autosaves while you draw).
- **Export / Import** a `.excalidraw.md` file.
- **Run scripts** with an `ea` (Excalidraw Automate) object, just like the plugin.
- **AI script generation** — describe what you want and a local Ollama model
  (`qwen2.5-coder:1.5b`) writes the EA script for you.

## Logic ported from the plugin

| This app | Plugin source |
|---|---|
| `src/io/compression.ts` | `src/utils/sceneDataUtils.ts` + compression worker |
| `src/io/serialize.ts` | `generateMDBase` / `getMarkdownDrawingSection` (`ExcalidrawData.ts`) |
| `src/io/parse.ts` | `getJSON` / `getDecompressedScene` / `loadData` text reconciliation |
| `src/automate/ExcalidrawAutomate.ts` | `src/shared/ExcalidrawAutomate.ts` (workbench → `addElementsToView`) |
| `src/automate/scriptRunner.ts` | `ScriptEngine.executeScript` (`src/shared/Scripts.ts`) |

### File format

Mirrors the plugin's `.excalidraw.md` shape:

```
# Excalidraw Data

## Text Elements
some text ^blockId

## Drawing
```compressed-json
<LZString base64, 256-char chunks>
```
```

- The `## Drawing` block holds the LZString-compressed scene JSON.
- `# Text Elements` keeps one `^blockId` per text element and **takes priority** over the
  JSON on load (same idea as the plugin, so text edits survive a round-trip).

### Scripting

Scripts run exactly like the plugin: as the body of an async function with `ea` and
`utils` injected.

```js
const box = ea.addRect(120, 120, 180, 90);
const label = ea.addText(140, 150, "Halo dari script!");
ea.addToGroup([box, label]);
await ea.addElementsToView();
```

EA API (subset): `setStyle`, `addRect`, `addEllipse`, `addDiamond`, `addText`, `addLine`,
`addArrow`, `addToGroup`, `addFrame`, `addMermaid`, `getViewElements`,
`getViewSelectedElements`, `copyViewElementsToEAforEditing`, `getElements`, `clear`,
`addElementsToView`.
`utils`: `inputPrompt`, `suggester`.

#### Frames

`ea.addFrame(name, childIds)` wraps elements in an Excalidraw **frame** — a named,
clipping container. Pass ids returned by `add*` in the same run:

```js
const a = ea.addRect(100, 100, 150, 60);
const b = ea.addRect(100, 200, 150, 60);
ea.addFrame("Alur", [a, b]);   // auto-sized to a+b (+10px), children get frameId
await ea.addElementsToView();
```

Frame membership is by reference — each child sets `frameId` to the frame's id — and,
per the [Excalidraw frames spec](https://docs.excalidraw.com/docs/codebase/frames),
**children are emitted before the frame element** in the elements array (the renderer
relies on that ordering for clipping). EA handles the ids, sizing, and ordering for you.

#### Mermaid

`await ea.addMermaid(definition)` renders a [Mermaid](https://mermaid.js.org/) diagram into
the scene via [`@excalidraw/mermaid-to-excalidraw`](https://docs.excalidraw.com/docs/@excalidraw/mermaid-to-excalidraw/codebase/parser),
so you get automatic layout instead of placing shapes by hand:

```js
await ea.addMermaid(`flowchart TD
  A[Mulai] --> B{Valid?}
  B -->|ya| C[Proses]
  B -->|tidak| D[Tolak]`);
await ea.addElementsToView();
```

**Flowcharts** become real, editable shapes + arrows (`subgraph`s become frames). Every
other diagram type is inserted as a single static **image** (returned in `files`) — see the
[supported-types note](https://docs.excalidraw.com/docs/@excalidraw/mermaid-to-excalidraw/codebase/new-diagram-type).
It is async and browser-only (Mermaid renders through the DOM). Returns the created element ids.

## Login

A minimal front-end gate (`src/auth/auth.ts`, `src/Login.tsx`) branded for
**Mesari Jaya Network dan CCTV**. Demo credentials: **`admin` / `mesari123`**.

> This is **not** real security — there is no backend, so the check is client-side only
> and can be bypassed via devtools. For real auth, move the check to a server. Change the
> demo credentials in `src/auth/auth.ts` before any real use.

## AI script generation (Ollama + Qwen)

Open the **Script** panel → type a request in the prompt box → **✨ Generate**. The app
calls a local **Ollama** container running **`qwen2.5-coder:1.5b`** and drops the
generated EA script into the editor for you to review and **► Jalankan** (run).

- `src/ai/ollama.ts` builds the request; the system prompt is an EA API cheat sheet +
  a few-shot example so a small model produces usable scripts.
- The browser calls same-origin `/ollama/*`, which `vite.config.ts` proxies to
  `http://localhost:11434` — no CORS, and Ollama is never exposed publicly.
- Generated code is shown in the editor first (not auto-run).

Start Ollama (Docker):

```bash
docker run -d --name ollama -p 11434:11434 -v ~/ollama-data:/root/.ollama ollama/ollama
docker exec ollama ollama pull qwen2.5-coder:1.5b
```

The `-v ~/ollama-data` volume keeps the model in your home dir so it survives across
sessions (the model is re-used, not re-downloaded). For better accuracy with more
RAM/disk, swap in `qwen2.5-coder:7b`.

### Custom model (`Modelfile`)

The repo ships a **`Modelfile`** that bakes deep Excalidraw knowledge — the
[JSON schema](https://docs.excalidraw.com/docs/codebase/json-schema), the
[frames spec](https://docs.excalidraw.com/docs/codebase/frames), and the full EA API —
into a custom model called **`excalidraw-ea`**, so a small model writes much better
scripts (including frames). Build it once:

```bash
docker exec ollama ollama create excalidraw-ea -f /Modelfile   # Modelfile mounted by compose
# or, on a host with the ollama CLI:  ollama create excalidraw-ea -f Modelfile
```

Point the app at it by setting `VITE_OLLAMA_MODEL=excalidraw-ea` at build/dev time (the
Docker build and compose stack already default to this). `src/ai/ollama.ts` reads
`import.meta.env.VITE_OLLAMA_MODEL` and falls back to `qwen2.5-coder:1.5b`.

## Run

```bash
npm install
npm run dev      # dev server on http://localhost:8080 (host:true for Cloud Shell)
npm run build    # type-check + production build to dist/
npm run preview  # serve the production build
```

On Google Cloud Shell use **Web Preview → port 8080**. AI generation needs the Ollama
container running (above); everything else works without it.

## Deploy (Docker + Cloudflare Tunnel)

The repo ships a stack that builds the app, exposes it over a **Cloudflare Zero Trust
tunnel** (no inbound ports, no public IP), and lets you pick the **AI backend**:

| Service | What it does |
|---|---|
| `app` | Multi-stage build (Node → `nginx:alpine`); serves the static build and reverse-proxies `/ollama` (Origin/Referer stripped, like the dev proxy) to the chosen backend. |
| `cloudflared` | Cloudflare tunnel; reaches `app:80` over the compose network and publishes it via your Zero Trust hostname. |
| `ollama` *(profile `local`)* | Private on-VPS LLM. Auto-pulls `qwen2.5-coder:1.5b` and builds `excalidraw-ea` from `Modelfile`. Never publishes a port. |
| `ai-proxy` *(profile `cloud`)* | Tiny Ollama-compatible shim → OpenAI **Responses API** (`codex-mini-latest`). Offloads inference to the cloud; the API key stays server-side. |

See [**AI backend**](#ai-backend-local-ollama-vs-cloud-codex-mini) below to choose between them.

### 1. Create the tunnel

In the **Cloudflare Zero Trust dashboard** → *Networks → Tunnels → Create a tunnel* →
*Cloudflared*. Copy the connector **token**. In the tunnel's *Public hostname* tab, route
your hostname to the service **`http://app:80`**.

### 2. Configure and launch

```bash
cp .env.example .env          # paste CLOUDFLARE_TUNNEL_TOKEN into it
docker compose up -d --build  # builds the app, boots ollama + builds excalidraw-ea, opens the tunnel
```

First boot pulls the base model (~1 GB into `~/ollama-data`, re-used afterwards). The app
is then reachable at your Cloudflare hostname; locally it's on `http://localhost:8080`
(Cloud Shell: **Web Preview → 8080**). Building `excalidraw-ea` adds almost no disk — the
custom model shares the base weights.

### AI backend: local Ollama vs cloud codex-mini

The backend is pluggable via `.env` — the browser app is unchanged either way (it always
calls same-origin `/ollama/*`; `ai-proxy` speaks the same Ollama dialect):

| | `local` (Ollama) | `cloud` (codex-mini) |
|---|---|---|
| Inference | on the VPS (CPU) | OpenAI cloud — VPS stays light |
| Instruction-following | modest (1.5b) | strong (`codex-mini-latest`, an o4-mini reasoning model) |
| Cost / privacy | free, fully private | per-token (cheap) + prompts go to OpenAI |
| Needs | ~2 GB RAM + ~1 GB disk | `OPENAI_API_KEY` |

```bash
# Local (default): private on-VPS Ollama
COMPOSE_PROFILES=local   AI_UPSTREAM=ollama:11434      # in .env
docker compose up -d --build

# Cloud: OpenAI codex-mini via ai-proxy
COMPOSE_PROFILES=cloud   AI_UPSTREAM=ai-proxy:8080      # in .env
OPENAI_API_KEY=sk-...                                  # in .env
docker compose up -d --build
docker compose up -d --build app   # recreate app so nginx picks up the new upstream
```

The system prompt (EA + frames + Mermaid knowledge) is sent by the app, so it applies to
**either** backend; `codex-mini` follows it far more reliably than the 1.5b model.

### Files

```
Dockerfile                    multi-stage app image (node build -> nginx runtime)
docker-compose.yml            app + ollama + cloudflared
Modelfile                     custom "excalidraw-ea" Ollama model (deep Excalidraw knowledge)
deploy/nginx.conf.template    SPA serving + /ollama reverse proxy (envsubst-filled)
deploy/ollama-entrypoint.sh   pulls base model + builds excalidraw-ea on first boot
.env.example                  tunnel token + optional overrides
```

> **Notes.** Only `app` binds a host port (delete its `ports:` block to go tunnel-only).
> Ollama is never exposed — the browser only ever talks to same-origin `/ollama/*`.
> On a tiny host (Cloud Shell has no swap) prefer the 1.5b model to avoid OOM.

## Known simplifications vs the plugin

- Compression is synchronous (the plugin offloads compress to a Web Worker).
- Persistence is `localStorage` + file export/import (no vault, no `.excalidraw` files,
  no embedded-file extraction; images stay inline in the JSON).
- Block-ref ids reuse the element id; the plugin rewrites them to 8-char nanoids for
  Obsidian block-reference constraints (not needed standalone).
- EA covers basic shapes/text/grouping/frames, not the full plugin API.
