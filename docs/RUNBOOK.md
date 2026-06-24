# Deploy Runbook — Excalidraw Sketsa

Manual, step-by-step deployment of the full stack: the web **app** (nginx), the **`codex`**
AI backend (Codex CLI on a ChatGPT subscription), the **`collab`** room server, and a
**Cloudflare Zero Trust tunnel** that publishes the app with no inbound ports.

This runbook is written for an **ephemeral Google Cloud Shell** (no swap, limited disk),
but works on any Docker host. Times and sizes are approximate. See
[ADR 0001](adr/0001-codex-cli-subscription-backend.md) for the AI-backend decision.

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
        │   │  app  │─────────────▶│  codex   │  (private, │
        │   │ nginx │  reverse     │  :8082   │  no host   │
        │   └───┬───┘  proxy       └────┬─────┘  port)     │
        └───────┼───────────────────────┼──────────────────┘
                │ host port              │ codex exec -> api.openai.com (subscription)
            localhost:8080  ◀── Web Preview / local testing
```

- The browser only ever calls **same-origin `/ollama/*`**; nginx reverse-proxies it to the
  `codex` container (the dialect name is legacy — the backend is Codex, not Ollama). `codex` is
  **never** published to the host or internet.
- `codex` runs the Codex CLI against your ChatGPT subscription; auth persists in a volume.
- `cloudflared` makes an **outbound** connection to Cloudflare — no open inbound ports.

Files involved: `Dockerfile`, `docker-compose.yml`, `deploy/codex/`,
`deploy/nginx.conf.template`, `.env`.

---

## 1. Prerequisites

| Need | Check | Notes |
|---|---|---|
| Docker + Compose v2 | `docker --version && docker compose version` | Compose v2 syntax (no `version:` key). |
| Free disk ≥ ~3 GB | `df -h /` | codex image (~0.7 GB) + app/build layers. (Far less than the old ollama model.) |
| Free port for the app | `ss -ltn \| grep :8080` | Default `8080`. **Avoid Cloud Shell reserved ports: 22, 900, 922, 970, 971, 980, 981, 8998.** |
| Cloudflare account w/ a domain on Cloudflare | — | Needed for the Zero Trust tunnel (Section 3). |

> **Ephemeral host (Cloud Shell):** the VM disk and `$HOME` outside the project may reset
> between sessions. **Commit your code to Git** before ending a session. The Codex auth
> credential lives in the `codex-auth` **named volume** (node-owned, so login can write it);
> it survives container restarts and `docker compose down`. A full VM recycle that wipes Docker
> volumes means you re-run `codex login`.

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
APP_PORT=8080                     # host port for the app (or remove the ports block)
# CODEX_MODEL=                    # optional; empty = the model your subscription grants
TZ=Asia/Jakarta                   # or Asia/Makassar; container log timezone
```

`.env` is gitignored — never commit it.

---

## 5. Deploy

### Option A — one shot (simplest)

```bash
docker compose up -d --build
docker compose exec codex codex login --device-auth   # one-time; authorize on another device
```

This builds the app + `codex` images, starts `collab` and `codex`, the app, and the tunnel.
AI generation works after the **one-time Codex login** above.

### Option B — staged (recommended on a small/ephemeral host)

Brings services up one at a time so you can watch disk/RAM and verify each step.

```bash
# 1) Build + start the app (nginx), collab, and codex.
docker compose up -d --build app

# 2) Authenticate Codex (one-time). Prints a device code; authorize it in any browser.
docker compose exec codex codex login --device-auth
docker compose exec codex codex login status     # expect: logged in

# 3) Open the tunnel.
docker compose up -d cloudflared
```

### AI backend: Codex CLI on a ChatGPT subscription

The `codex` service is the only AI backend. The app is unchanged — it always calls same-origin
`/ollama/*`; the shim translates to `codex exec` and validates the result before returning it.

```bash
# Optional overrides in .env:
CODEX_MODEL=                 # empty = the model your subscription grants
CODEX_MAX_ATTEMPTS=2         # validation-gate retries on an invalid script

# Authenticate once (credential persists to the codex-auth volume):
docker compose exec codex codex login --device-auth
```

Honest trade-off (see [ADR 0001](adr/0001-codex-cli-subscription-backend.md)): no metered/local
fallback; using a personal subscription as an automated backend may bump intended-use/rate
limits; `codex exec` is heavier than a plain API call (mitigated by `read-only` + `--ephemeral`).

---

## 6. Verify

```bash
# All services Up:
docker compose ps

# (a) Codex backend is up and authenticated:
docker compose exec codex codex login status    # expect: logged in

# (b) App serves the SPA:
curl -sf -o /dev/null -w "app: %{http_code}\n" http://localhost:8080/

# (c) Collaboration service and nginx route are healthy:
curl -sf http://localhost:8080/collab/healthz

# (d) /ollama proxy reaches the codex shim through the app:
curl -s -o /dev/null -w "tags via proxy: %{http_code}\n" http://localhost:8080/ollama/api/tags
# Expect 200.

# (e) End-to-end generate through the proxy (needs codex login; returns a validated EA script):
curl -s http://localhost:8080/ollama/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"codex","stream":false,
       "messages":[{"role":"system","content":"You write EA scripts."},
                   {"role":"user","content":"kotak berisi teks Halo dalam sebuah frame"}]}' \
  | head -c 400; echo
# (without login -> HTTP 503 with a clear "codex backend" message, not a crash.)

# (f) Tunnel registered connections to Cloudflare:
docker compose logs cloudflared | grep -iE "Registered tunnel connection|Connection .* registered"
```

Then open your Cloudflare hostname in a browser, log in (demo `admin` / `mesari123`), open
**Script → ✨ Generate**, and confirm the AI produces an EA script (including `ea.addFrame`).

Scene as Code regression check:

1. Draw shapes, bindings, a frame, and an image.
2. Open **Script → Scene → Code** and copy the generated script.
3. Clear or alter the canvas, then run the script; the original visible scene must return.
4. Change `mode` to `insert`, set `offsetX`/`offsetY`, and run twice; both copies must appear
   without id collisions.
5. Run `npm run test:scene-code` after changing artifact, remapping, or load behavior. The
   Docker production build runs this test automatically before Vite builds.

On Cloud Shell without the tunnel, use **Web Preview → port 8080**.

---

## 7. Codex authentication & re-login

```bash
docker compose exec codex codex login --device-auth   # (re)authorize; prints a device code
docker compose exec codex codex login status          # check
docker compose exec codex codex logout                # clear the stored credential
```

The credential lives in the `codex-auth` volume (`/codex-home`), so it survives restarts. To
change the model the shim requests, set `CODEX_MODEL` in `.env` and `docker compose up -d codex`.
The EA knowledge stays in `src/ai/ollama.ts` (sent per request) — there is no model to rebuild.

---

## 8. Operations

```bash
docker compose ps                 # status
docker compose logs -f app        # nginx access/error logs
docker compose logs -f collab     # room connections and server errors
docker compose logs -f codex      # codex shim + `codex exec` logs
docker compose logs -f cloudflared

docker compose restart app        # restart one service
docker compose up -d --build app  # redeploy app after code changes
docker compose pull cloudflared && docker compose up -d  # update base images

docker compose down               # stop + remove containers (keeps the codex-auth volume + images)
docker compose down --rmi local   # also remove the built app/codex images (frees disk)
```

The Codex credential lives in the `codex-auth` named volume, so `down` does not log you out
(`docker compose down -v` would remove it). It is node-owned, so `codex login` can write it —
a host bind mount would be root-owned and fail with "permission denied".

---

## 9. Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| Browser AI fails, `curl ... -H "Origin: ..." /ollama/api/tags` returns **403** | nginx must strip `Origin`/`Referer` (it does in `deploy/nginx.conf.template`). Confirm the rendered config: `docker compose exec app cat /etc/nginx/conf.d/default.conf`. |
| `/ollama/*` returns **502 / 504** | `codex` not up yet — watch `docker compose logs -f codex`. Or DNS: the app resolves `codex` via Docker DNS at request time (`resolver 127.0.0.11`); ensure both share the compose network (`docker compose ps`). |
| Generate returns **503 "codex backend"** | Codex isn't authenticated (or its TLS/CA failed). Run `docker compose exec codex codex login --device-auth`, then `codex login status`. The shim's `/healthz` shows `"auth"`. |
| Cloudflare hostname shows **502 Bad Gateway** | Tunnel is up but the Public Hostname isn't routed to `app:80`. Re-check Section 3 step 4 (Service = `HTTP`, URL = `app:80`). |
| `cloudflared` exits / "**error parsing token**" | `CLOUDFLARE_TUNNEL_TOKEN` missing/wrong in `.env`. `docker compose config` should show it set. |
| Compose error **"set CLOUDFLARE_TUNNEL_TOKEN in .env"** | The token var is required; put it in `.env` (Section 4). |
| App build gets **OOM-killed** | Host has no swap. Don't run heavy work during the build. Inference runs in OpenAI's cloud via Codex, so generation itself is light on the host. |
| **Disk full** during pull/build | `docker system df` then `docker system prune -f` (and `docker compose down --rmi local`). Keep the app image small (it's nginx-only at runtime). |
| Port **8080 already in use** | Another process (e.g. `npm run dev`) holds it. Set `APP_PORT=8081` in `.env` (avoid reserved ports) and `docker compose up -d app`. |

---

## 10. Security notes

- **The `codex` backend is private** — no `ports:` mapping; only the app (via nginx) reaches it.
  The ChatGPT-subscription credential lives in the `codex-auth` volume, never in the image or
  the browser bundle. Do not add a host port.
- The app's **login is a client-side gate only** (`src/auth/auth.ts`, demo `admin` /
  `mesari123`). It is **not** real auth — anyone with the URL can bypass it via devtools. For
  real protection, put the Cloudflare hostname behind a **Zero Trust Access policy**
  (Applications → Add an application → Self-hosted), and change the demo credentials.
- `.env` holds the tunnel token — keep it gitignored and out of screenshots/logs.
- To run **tunnel-only** (no host port at all), delete the `ports:` block from the `app`
  service in `docker-compose.yml`.
```
