# Scaling live collaboration (Redis backplane)

By default the `collab` service runs **single-instance**: rooms live in one Node process's
memory (`deploy/collab/server.js`). That is fine for one host, but it does **not** scale
horizontally — and naively adding replicas *breaks* collaboration. This document explains why,
the fix, how to enable it, and the honest limitations.

## Why a second replica breaks it (without a backplane)

In `server.js`, `rooms` is an in-process `Map` and `broadcast()` only reaches SSE clients **on
the same process**. With two replicas behind nginx:

- client A's SSE stream lands on replica 1, client B's on replica 2;
- a scene `POST` to replica 1 broadcasts only to replica 1's clients — **B never sees it**;
- each replica keeps its own `version` counter, so the browser's
  `if (version <= lastApplied) drop` guard (`src/collab/client.ts`) discards valid updates.

So **nginx load-balancing alone is not enough — it is harmful** for a stateful SSE service.

## The fix: Redis as a backplane (not "just a cache")

Redis here is a **pub/sub message bus + shared state**, not a passive cache:

- **Fan-out (pub/sub):** every replica `SUBSCRIBE`s one channel `collab:bus`. A `POST` to any
  replica `PUBLISH`es the merged scene; every replica re-broadcasts it to its own SSE clients.
- **Monotonic version:** `INCR collab:ver:<room>` is the single source of version, so the
  browser's dedupe guard stays correct across replicas.
- **Shared snapshot:** the merged scene is stored at `collab:scene:<room>` (with TTL), so a new
  joiner on any replica gets the current scene.
- **Global presence:** members live in a Redis hash `collab:presence:<room>`; every replica
  reports the aggregated "N online".

It is **opt-in** via `REDIS_URL`. Unset → byte-for-byte the previous single-instance behaviour.
The client is a tiny dependency-free RESP implementation inside `server.js` (the `collab` image
stays zero-dependency).

## Enable it

```bash
# .env
COMPOSE_PROFILES=cloud,scale        # add `scale` to whichever AI profile you use
REDIS_URL=redis://redis:6379

docker compose up -d --build --scale collab=2
```

`nginx` needs **no change**: `deploy/nginx.conf.template` already proxies `/collab/` via a
variabled `proxy_pass` + Docker's `resolver`, so `collab:8081` resolves to all replicas and is
load-balanced per request. SSE settings there (`proxy_buffering off`, `proxy_read_timeout 1h`)
are already correct for long-lived streams.

Check health: `curl .../healthz` on a replica returns `"backplane":"redis-up"`.

## Verify the fan-out yourself

`scripts/collab-scale-test.mjs` proves cross-replica fan-out + global presence over plain HTTP
(no browser). It was used to validate this change:

```bash
docker network create cn
docker run -d --name redis --network cn redis:7-alpine
docker build -t collab ./deploy/collab
docker run -d --name a --network cn -e REDIS_URL=redis://redis:6379 -p 18081:8081 collab
docker run -d --name b --network cn -e REDIS_URL=redis://redis:6379 -p 18082:8081 collab
node scripts/collab-scale-test.mjs http://localhost:18081 http://localhost:18082
docker rm -f a b redis && docker network rm cn
```

Expected: `ALL PASSED ✓` — an SSE client on replica B receives a scene `POST`ed to replica A
(both directions), and presence reads 2 on both. Pointing both URLs at one instance with no
`REDIS_URL` proves the single-instance path is unchanged (`"backplane":"off"`).

## Honest limitations (what this does NOT do)

- **Eventual consistency, not strong consistency.** The merge is read-modify-write per replica;
  two simultaneous `POST`s to different replicas can momentarily drop one element from the shared
  snapshot. It self-heals because the browser re-publishes the full scene on every change and the
  merge is last-writer-wins per element by `version`/`versionNonce`. Acceptable for this drawing
  workload; not suitable as-is for strict financial-grade consistency.
- **Backplane outage degrades writes.** If Redis is unreachable, scene `POST`s return `503`
  (the browser auto-retries) and resume when Redis returns; existing SSE clients stay connected.
  The process never crashes.
- **Presence can go briefly stale** if a replica crashes without cleaning up (entries clear when
  the room key's TTL expires).
- **One pub/sub channel** for all rooms — fine for moderate scale; very high scale would shard
  channels per room.
- **Not load-tested, and the public Cloudflare-tunnel path was not exercised here.** Validation
  covered the HTTP/SSE fan-out logic with real containers (Redis + 2 replicas), not browser UX or
  high concurrency. Test at your expected scale before relying on it.
