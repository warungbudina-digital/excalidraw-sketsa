# Deploy Runbook — Excalidraw Sketsa

Manual, step-by-step deployment of the full stack: the web **app** (nginx), a private
**Ollama** backend (with the custom `excalidraw-ea` model), and a **Cloudflare Zero Trust
tunnel** that publishes the app with no inbound ports.

This runbook is written for an **ephemeral Google Cloud Shell** (no swap, limited disk),
but works on any Docker host. Times and sizes are approximate.

---

## 0. Architecture

```
                      Internet
                         │  (HTTPS, your Cloudflare hostname)
                 ┌───────▼────────┐
                 │  Cloudflare     │   outbound-only tunnel, no inbound ports
                 │  edge           │
                 └───────▲────────┘
                         │ tunnel
  docker compose network │
        ┌────────────────┼───────────────────────────────┐
        │   cloudflared ──┘                               │
        │       │ http://app:80                           │
        │   ┌───▼───┐  /ollama/*   ┌──────────┐           │
        │   │  app  │─────────────▶│  ollama  │  (private, │
        │   │ nginx │  reverse     │  :11434  │  no host   │
        │   └───┬───┘  proxy       └──────────┘  port)     │
        └───────┼──────────────────────────────────────────┘
                │ host port (optional, ${APP_PORT}:80)
            localhost:8080  ◀── Cloud Shell Web Preview / local testing
```

- The browser only ever calls **same-origin `/ollama/*`**; nginx reverse-proxies it to the
  `ollama` container. Ollama is **never** published to the host or internet.
- `cloudflared` makes an **outbound** connection to Cloudflare — no open inbound ports.

Files involved: `Dockerfile`, `docker-compose.yml`, `Modelfile`,
`deploy/nginx.conf.template`, `deploy/ollama-entrypoint.sh`, `.env`.

---

## 1. Prerequisites

| Need | Check | Notes |
|---|---|---|
| Docker + Compose v2 | `docker --version && docker compose version` | Compose v2 syntax (no `version:` key). |
| Free disk ≥ ~8 GB | `df -h /` | ollama image (~1.5 GB) + base model (~1 GB) + app/build layers. |
| Free port for the app | `ss -ltn \| grep :8080` | Default `8080`. **Avoid Cloud Shell reserved ports: 22, 900, 922, 970, 971, 980, 981, 8998.** |
| Cloudflare account w/ a domain on Cloudflare | — | Needed for the Zero Trust tunnel (Section 3). |

> **Ephemeral host (Cloud Shell):** the VM disk and `$HOME` outside the project may reset
> between sessions. **Commit your code to Git** before ending a session. Models are kept in
> `~/ollama-data` so they are re-used, not re-downloaded, when that path survives.

---

## 2. Get the code & set git identity (Cloud Shell)

```bash
cd ~/excalidraw-sketsa
# Fresh Cloud Shell sessions have no git identity; set it (repo-local) before committing:
git config user.name  "your-name"
git config user.email "you@example.com"
```

---

## 3. Create the Cloudflare tunnel (one-time)

1. Cloudflare **Zero Trust** dashboard → **Networks → Tunnels → Create a tunnel**.
2. Choose **Cloudflared**, name it (e.g. `excalidraw-sketsa`), **Save**.
3. On the "Install connector" screen, copy the **token** (the long `eyJ...` string). You do
   **not** run the shown `cloudflared` command — compose runs it for you.
4. Go to the tunnel's **Public Hostname** tab → **Add a public hostname**:
   - **Subdomain/Domain:** pick your hostname (e.g. `sketsa.example.com`).
   - **Service Type:** `HTTP`  **URL:** `app:80`   ← the compose service name + port.
5. Save. (DNS is created automatically for hostnames on your Cloudflare domain.)

---

## 4. Configure `.env`

```bash
cp .env.example .env   # if you don't have one yet
```

Edit `.env`:

```dotenv
CLOUDFLARE_TUNNEL_TOKEN=eyJ...your token from step 3...
VITE_OLLAMA_MODEL=excalidraw-ea   # model baked into the app + built by ollama
APP_PORT=8080                     # host port for the app (or remove the ports block)
TZ=Asia/Jakarta                   # or Asia/Makassar; container log timezone
```

`.env` is gitignored — never commit it.

---

## 5. Deploy

### Option A — one shot (simplest)

```bash
docker compose up -d --build
```

This builds the app image, starts ollama (which pulls the base model and builds
`excalidraw-ea` on first boot — a few minutes), starts the app, and opens the tunnel.

### Option B — staged (recommended on a small/ephemeral host)

Brings services up one at a time so you can watch disk/RAM and verify each step.

```bash
# 1) Ollama first — it pulls the base model + builds excalidraw-ea in the background.
docker compose up -d ollama
docker compose logs -f ollama        # wait for: "ollama-init: ready (model in use: excalidraw-ea)"

# 2) Build + start the app (nginx).
docker compose build app
docker compose up -d app

# 3) Open the tunnel.
docker compose up -d cloudflared
```

### AI backend: local Ollama ↔ cloud codex-mini

The AI backend is pluggable; the app is unchanged either way (it always calls same-origin
`/ollama/*`, and `ai-proxy` speaks the same Ollama dialect). Choose with two `.env` vars:

```bash
# Local: private on-VPS Ollama (default)
COMPOSE_PROFILES=local   AI_UPSTREAM=ollama:11434

# Cloud: OpenAI codex-mini via ai-proxy (light VPS, strong instruction-following)
COMPOSE_PROFILES=cloud   AI_UPSTREAM=ai-proxy:8080
OPENAI_API_KEY=sk-...                 # server-side only; never in the browser bundle
```

After editing `.env`: `docker compose up -d --build` then `docker compose up -d --build app`
(recreates the app so nginx picks up the new `AI_UPSTREAM`). Switching to `cloud` stops
running on-VPS inference entirely; prompts then go to OpenAI (privacy/cost trade-off).
`OPENAI_API_KEY` uses a soft default in compose, so the **local** backend never needs it.

---

## 6. Verify

```bash
# All services Up:
docker compose ps

# (a) Ollama built the custom model:
docker compose exec ollama ollama list          # excalidraw-ea and qwen2.5-coder:1.5b listed

# (b) App serves the SPA:
curl -sf -o /dev/null -w "app: %{http_code}\n" http://localhost:8080/

# (c) /ollama proxy works through the app, WITH a browser Origin (the 403 regression test):
curl -s -o /dev/null -w "tags via proxy: %{http_code}\n" \
  -H "Origin: https://example.cloudshell.dev" http://localhost:8080/ollama/api/tags
# Expect 200 (would be 403 if nginx didn't strip Origin).

# (d) End-to-end generate through the proxy:
curl -s http://localhost:8080/ollama/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"excalidraw-ea","stream":false,
       "messages":[{"role":"user","content":"kotak berisi teks Halo dalam sebuah frame"}]}' \
  | head -c 400; echo

# (e) Tunnel registered connections to Cloudflare:
docker compose logs cloudflared | grep -iE "Registered tunnel connection|Connection .* registered"
```

Then open your Cloudflare hostname in a browser, log in (demo `admin` / `mesari123`), open
**Script → ✨ Generate**, and confirm the AI produces an EA script (including `ea.addFrame`).

On Cloud Shell without the tunnel, use **Web Preview → port 8080**.

---

## 7. Rebuild the custom model after editing `Modelfile`

```bash
docker compose exec ollama ollama create excalidraw-ea -f /Modelfile
# (no restart needed; the next generate uses the new model)
```

To change the model the app requests, set `VITE_OLLAMA_MODEL` in `.env` and rebuild the app
image: `docker compose up -d --build app` (the name is baked into the bundle at build time).

---

## 8. Operations

```bash
docker compose ps                 # status
docker compose logs -f app        # nginx access/error logs
docker compose logs -f ollama     # model pull/build + inference logs
docker compose logs -f cloudflared

docker compose restart app        # restart one service
docker compose up -d --build app  # redeploy app after code changes
docker compose pull ollama cloudflared && docker compose up -d  # update base images

docker compose down               # stop + remove containers (keeps ~/ollama-data + images)
docker compose down --rmi local   # also remove the built app image (frees disk)
```

The model data lives in `~/ollama-data` (host bind mount), so `down` does not delete it.

---

## 9. Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| Browser AI fails, `curl ... -H "Origin: ..." /ollama/api/tags` returns **403** | nginx must strip `Origin`/`Referer` (it does in `deploy/nginx.conf.template`). Confirm the rendered config: `docker compose exec app cat /etc/nginx/conf.d/default.conf`. |
| `/ollama/*` returns **502 / 504** | ollama not ready yet (still pulling/building the model) — watch `docker compose logs -f ollama`. Or DNS: the app resolves `ollama` via Docker DNS at request time (`resolver 127.0.0.11`); ensure both services share the compose network (`docker compose ps`). |
| `ollama create` / generate: **model "excalidraw-ea" not found** | The init didn't build it. Run Section 7 manually and check `docker compose logs ollama` for "create failed". |
| Cloudflare hostname shows **502 Bad Gateway** | Tunnel is up but the Public Hostname isn't routed to `app:80`. Re-check Section 3 step 4 (Service = `HTTP`, URL = `app:80`). |
| `cloudflared` exits / "**error parsing token**" | `CLOUDFLARE_TUNNEL_TOKEN` missing/wrong in `.env`. `docker compose config` should show it set. |
| Compose error **"set CLOUDFLARE_TUNNEL_TOKEN in .env"** | The token var is required; put it in `.env` (Section 4). |
| App build or a generate gets **OOM-killed** | Host has no swap. Don't run a big generate during the build; prefer the 1.5b model; build the app first, then exercise the model. |
| **Disk full** during pull/build | `docker system df` then `docker system prune -f` (and `docker compose down --rmi local`). Keep the app image small (it's nginx-only at runtime). |
| Port **8080 already in use** | Another process (e.g. `npm run dev`) holds it. Set `APP_PORT=8081` in `.env` (avoid reserved ports) and `docker compose up -d app`. |

---

## 10. Security notes

- **Ollama is private** — it has no `ports:` mapping; only the app (via nginx) and the host
  Docker CLI reach it. Do not add a host port unless you intend to expose it.
- The app's **login is a client-side gate only** (`src/auth/auth.ts`, demo `admin` /
  `mesari123`). It is **not** real auth — anyone with the URL can bypass it via devtools. For
  real protection, put the Cloudflare hostname behind a **Zero Trust Access policy**
  (Applications → Add an application → Self-hosted), and change the demo credentials.
- `.env` holds the tunnel token — keep it gitignored and out of screenshots/logs.
- To run **tunnel-only** (no host port at all), delete the `ports:` block from the `app`
  service in `docker-compose.yml`.
```
