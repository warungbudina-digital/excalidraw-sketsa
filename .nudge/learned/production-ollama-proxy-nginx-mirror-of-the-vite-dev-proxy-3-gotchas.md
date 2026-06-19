# Production /ollama proxy: nginx mirror of the Vite dev proxy (3 gotchas)

## What went wrong
The deploy image serves the built app with `nginx:alpine` (not `vite preview`), so the
`/ollama` reverse proxy had to be re-implemented in `deploy/nginx.conf.template`. Three
non-obvious things bite if you copy a naive nginx proxy block:
1. Ollama (0.x) returns HTTP 403 to browser requests whose `Origin` isn't localhost — the
   SAME issue as the dev proxy. nginx must strip it too, or the app gets 403 in the browser
   while curl (no Origin) returns 200.
2. nginx's startup `envsubst` (the official image runs it over `/etc/nginx/templates/*.template`)
   will clobber nginx's own `$uri`/`$host`/`$1` if you template anything, breaking the config.
3. A bare `proxy_pass http://ollama:11434;` resolves the upstream ONCE at nginx start; if the
   ollama container isn't up yet (compose starts it in parallel) nginx fails to start.

## Fix
In `deploy/nginx.conf.template`:
- `proxy_set_header Origin "";` and `proxy_set_header Referer "";` in the `/ollama/` location.
- Template only the upstream host as `${OLLAMA_HOST}` and set `NGINX_ENVSUBST_FILTER=OLLAMA_`
  in the Dockerfile so envsubst touches only `OLLAMA_*` vars, leaving `$uri`/`$host`/`$1` alone.
- Resolve the upstream at request time: `resolver 127.0.0.11 ipv6=off valid=10s;` +
  `set $ollama_upstream ${OLLAMA_HOST}; rewrite ^/ollama/(.*)$ /$1 break; proxy_pass http://$ollama_upstream;`
  (a variable in proxy_pass forces DNS via the resolver, so a recreated ollama IP is picked up).
The app reaches ollama by compose service name `ollama:11434`, NOT localhost (Dockerfile sets
`ENV OLLAMA_HOST=ollama:11434`). Ollama still publishes no host port — stays private.

## Verification
Render + syntax-check the real config without a full stack:
`docker run --rm -e OLLAMA_HOST=ollama:11434 -e NGINX_ENVSUBST_FILTER=OLLAMA_ \
  -v "$PWD/deploy/nginx.conf.template:/etc/nginx/templates/default.conf.template:ro" \
  nginx:1.27-alpine nginx -t`  -> "syntax is ok / test is successful".
Also `CLOUDFLARE_TUNNEL_TOKEN=x docker compose config` must succeed (validates interpolation,
mounts, and the resolved `OLLAMA_HOST`/`VITE_OLLAMA_MODEL`).
