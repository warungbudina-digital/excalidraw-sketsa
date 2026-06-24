# Scaling collab: Redis backplane — why naive replicas break + how to verify

## What went wrong
`deploy/collab/server.js` keeps rooms in an in-process `Map` and `broadcast()` only reaches SSE
clients ON THE SAME PROCESS. So adding a 2nd collab replica behind nginx SPLITS rooms: a scene
POST landing on replica 1 never reaches an SSE client on replica 2. Worse, each replica had its
own `version` counter, and the browser's dedupe guard (`src/collab/client.ts`:
`if (version <= lastAppliedVersion) drop`) then discards valid updates. **nginx load-balancing
alone is not just insufficient — it is harmful for this stateful SSE service.** "Cache" is the
wrong mental model; the fix is a pub/sub BACKPLANE + shared state.

## Fix
Opt-in Redis backplane, implemented as a minimal DEPENDENCY-FREE RESP client INSIDE
`deploy/collab/server.js` (keeps the collab image zero-dep — no package.json/npm ci, matching
ai-proxy). Gated on `REDIS_URL`; UNSET = byte-for-byte the previous single-instance behaviour.
Keys/channels: fan-out via `PUBLISH/SUBSCRIBE collab:bus`; monotonic version via
`INCR collab:ver:<room>`; shared snapshot `SET collab:scene:<room> ... EX`; global presence in
hash `collab:presence:<room>`. On Redis outage a scene POST returns **503** (the browser client
auto-retries) instead of crashing or corrupting local state; the RESP client auto-reconnects.
nginx needs NO change — `deploy/nginx.conf.template`'s `/collab` block already uses a variabled
`proxy_pass` + `resolver`, so `collab:8081` round-robins all replicas via Docker DNS, and it is
already SSE-correct (`proxy_buffering off`, `proxy_read_timeout 1h`).
Enable: `COMPOSE_PROFILES=<ai>,scale` + `REDIS_URL=redis://redis:6379`, then
`docker compose up -d --build --scale collab=2` (the `redis` service is behind profile `scale`).
Consistency is EVENTUAL: the per-replica read-modify-write merge can momentarily drop one element
under simultaneous cross-replica POSTs; it self-heals because the client re-publishes the full
scene and the merge is last-writer-wins per element by version/versionNonce. Full design +
honest limits: `docs/SCALING.md`.

## Verification
Browserless — SSE is plain HTTP, so no browser/excalidraw needed (and EA/convert wouldn't run in
node anyway). Harness: `scripts/collab-scale-test.mjs`. Recipe (deterministic per-replica
targeting via distinct host ports on a user-defined network so Docker DNS resolves `redis`):
```
docker network create cn
docker run -d --name redis --network cn redis:7-alpine
docker build -t collab ./deploy/collab
docker run -d --name a --network cn -e REDIS_URL=redis://redis:6379 -p 18081:8081 collab
docker run -d --name b --network cn -e REDIS_URL=redis://redis:6379 -p 18082:8081 collab
node scripts/collab-scale-test.mjs http://localhost:18081 http://localhost:18082   # ALL PASSED
docker rm -f a b redis && docker network rm cn
```
`GET /healthz` returns `"backplane":"redis-up"|"redis-down"|"off"`. To prove ZERO regression, run
ONE collab container with NO `REDIS_URL` and point both harness URLs at it (same instance) →
local broadcast + presence still pass, healthz `"backplane":"off"`. Verified both ways here.
Not covered: browser UX, high-concurrency load, the public Cloudflare-tunnel path (no token).
