# memory — AI generation memory → Supabase

Captures each AI generation turn (prompt + response + scene snapshot) and persists it
to Supabase (Postgres via PostgREST). Private container, reached only by nginx over the
compose network — exactly like `collab`. The Supabase **service role key** stays here,
server-side; the browser never sees it.

This is the **minimal** first slice of the memory subsystem: ONE store (Supabase),
markdown/text + JSON in Postgres. Obsidian-vault export and rclone/gdrive blob storage
are deliberately **not** included yet (add later only if a concrete need appears — see
the `ai_asset` pointer table in `schema.sql`, which is ready for that day).

## 1. Supabase setup (once)

1. Create a project at supabase.com (free tier is fine).
2. SQL Editor → paste `schema.sql` → Run.
3. Project Settings → API → copy:
   - **Project URL**  → `SUPABASE_URL`
   - **service_role** secret key → `SUPABASE_SERVICE_KEY` (NOT the anon key)

## 2. `.env`

```dotenv
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_KEY=eyJ... (service_role secret — keep out of git, .env is gitignored)
# Optional: keep-alive cadence (default 3 days, under Supabase's ~7-day idle pause)
# MEMORY_PING_INTERVAL_MS=259200000
```

## 3. `docker-compose.yml` — add the service + (optional) wire it as an upstream

```yaml
  # AI memory: captures generation turns to Supabase (Postgres). Private, like collab.
  # No volume — Supabase IS the store. Keep-alive ping lives inside server.js.
  memory:
    build:
      context: ./deploy/memory
      dockerfile: Dockerfile
    image: excalidraw-sketsa-memory:latest
    environment:
      PORT: 8085
      SUPABASE_URL: ${SUPABASE_URL:-}
      SUPABASE_SERVICE_KEY: ${SUPABASE_SERVICE_KEY:-}
      TZ: ${TZ:-Asia/Jakarta}
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8085/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 5s
    restart: unless-stopped
```

Add `MEMORY_HOST: ${MEMORY_UPSTREAM:-memory:8085}` to the `app` service `environment:`.

## 4. `deploy/nginx.conf.template` — add a route

Inside `server {}` (NOT rate-limited — capture should never 429):

```nginx
    # AI memory capture/list — private memory container (Supabase-backed).
    location /memory/ {
        set $memory_upstream ${MEMORY_HOST};
        rewrite ^/memory/(.*)$ /$1 break;
        proxy_pass http://$memory_upstream;

        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_read_timeout 30s;
    }
```

## 5. `Dockerfile` (app) — extend the envsubst filter

```dockerfile
ENV NGINX_ENVSUBST_FILTER="OLLAMA_|COLLAB_|CLAUDE_|AGY_|MEMORY_"
```

(See learned note `nginx-nginx-envsubst-filter-must-be-extended-for-each-new-upstream-variable`.)

## 6. Capture from the browser (in `src/ai/ollama.ts`, after a successful generate)

Fire-and-forget so it never blocks or breaks generation:

```ts
fetch("/memory/memory", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    backend: opts.backend ?? "codex",
    model: OLLAMA_MODEL,
    prompt: userContent,
    response: content,        // the generated EA script
    meta: { valid: true },
  }),
}).catch(() => {});            // capture is best-effort; ignore failures
```

## Endpoints

| Method | Path            | Purpose                                  |
|--------|-----------------|------------------------------------------|
| POST   | `/memory/memory`| Insert one turn → `{id}`                 |
| GET    | `/memory/memory?limit=50&q=flowchart` | Recent turns, summary fields (no `response`) |
| GET    | `/memory/memory/<id>` | One full turn incl. `response` + `scene_snapshot` |
| GET    | `/memory/healthz` | Liveness + last keep-alive result      |

## Keep-alive

`server.js` runs `pingSupabase()` 15s after boot, then every `MEMORY_PING_INTERVAL_MS`
(default 3 days). It does a `GET /rest/v1/ai_memory?select=id&limit=1` — the cheapest
call that still counts as DB activity — so a free-tier project never auto-pauses. The
last result is visible at `GET /memory/healthz` (`lastPing`).
