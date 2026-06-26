# memory backend (Supabase-backed AI capture): wiring + Supabase gotchas

## What to know
`deploy/memory/` is a 4th private container (after collab/codex/claude/agy), zero-dep
Node mirroring `deploy/collab/`. It captures each AI generation turn (prompt + response
+ scene) to Supabase (Postgres via PostgREST). Outside it speaks plain JSON over nginx
`/memory/*`; inside it calls Supabase REST with the SERVICE key (server-side only — the
browser never gets it, same posture as codex/claude auth + ai-proxy key).

- Endpoints (container-internal): `POST /memory` (insert), `GET /memory?limit&q`
  (recent list — SUMMARY fields only, NO `response`/`scene_snapshot`, kept small),
  `GET /memory/<uuid>` (ONE full row incl. `response` + `scene_snapshot`), `GET /healthz`.
- BROWSER path doubles the segment: nginx `location /memory/` rewrites `^/memory/(.*)$`
  -> `/$1`, so the client calls `/memory/memory` (list/insert), `/memory/memory/<id>`
  (detail), `/memory/healthz`. See the `BASE = "/memory/memory"` const in `src/ai/memory.ts`.
- Read client is `src/ai/memory.ts` (`listMemory`/`getMemory`); the "Riwayat" panel in
  `src/Editor.tsx` lists turns and reloads a turn's `response` into the editor. The
  list/detail field split means the panel needs getMemory(id) to get the actual script.
- Capture is fired from `src/ai/ollama.ts` `captureMemory()` — fire-and-forget,
  `.catch(()=>{})`, NEVER awaited: a capture failure must not block/break generation.
- nginx `/memory/` route is deliberately NOT rate-limited (the ai_gen limit_req zone is
  only on /ollama, /claude, /agy) — capture must never 429.
- No volume: Supabase IS the store. Container degrades to 503 if SUPABASE_* unset; boots fine.
- Wiring touched the usual 3 spots (see the per-upstream pattern): docker-compose service +
  MEMORY_HOST in app env; nginx location; Dockerfile NGINX_ENVSUBST_FILTER += MEMORY_.

## Supabase gotchas (verified live this session)
1. **SUPABASE_URL must be the BASE project URL only** — `https://<ref>.supabase.co`.
   server.js appends `/rest/v1/<table>` itself. Passing the full `.../rest/v1/` endpoint
   double-appends and 404s.
2. **New `sb_secret_...` API key format works as service role** for PostgREST: send it as
   BOTH `apikey: sb_secret_...` AND `authorization: Bearer sb_secret_...`. (Replaces the
   legacy JWT `eyJ...` service_role key.) It bypasses RLS.
3. **Schema is NOT auto-created.** `deploy/memory/schema.sql` must be run once in the
   Supabase SQL Editor. Symptom if you forget: REST returns
   `{"code":"PGRST205","message":"Could not find the table 'public.ai_memory' in the schema cache"}`
   with HTTP 404 — the project/key are fine, the table just doesn't exist yet.
4. **RLS enabled with NO policy = service-role-only access** (anon/authenticated denied).
   This is the intended secure default since only the server-side container writes.
5. **Free-tier auto-pause (~7 days idle):** server.js `pingSupabase()` does
   `GET /rest/v1/ai_memory?select=id&limit=1` 15s after boot then every
   `MEMORY_PING_INTERVAL_MS` (default 3 days). setInterval is safe (3d < ~24.8d timer cap);
   timers are `.unref()`'d. Last result shows at `GET /memory/healthz` -> lastPing.

## Verification
```sh
# Key valid + project awake (base URL!):
curl -s -o /dev/null -w "%{http_code}\n" "$SUPABASE_URL/rest/v1/" \
  -H "apikey: $KEY" -H "authorization: Bearer $KEY"            # -> 200
# Table exists (after running schema.sql):
curl -s "$SUPABASE_URL/rest/v1/ai_memory?select=id&limit=1" \
  -H "apikey: $KEY" -H "authorization: Bearer $KEY"            # -> []  (not PGRST205)
# Container health after `docker compose up -d --build memory`:
curl -s localhost:8080/memory/healthz                          # -> {"configured":true,"lastPing":{"ok":true,...}}
# nginx renders with the new upstream:
docker run --rm -e OLLAMA_HOST=codex:8082 -e COLLAB_HOST=collab:8081 \
  -e CLAUDE_HOST=claude:8083 -e AGY_HOST=agy:8084 -e MEMORY_HOST=memory:8085 \
  -e NGINX_ENVSUBST_FILTER="OLLAMA_|COLLAB_|CLAUDE_|AGY_|MEMORY_" \
  -v "$PWD/deploy/nginx.conf.template:/etc/nginx/templates/default.conf.template:ro" \
  nginx:1.27-alpine nginx -t
```
