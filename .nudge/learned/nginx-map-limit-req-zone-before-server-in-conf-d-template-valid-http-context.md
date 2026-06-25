# nginx `map`/`limit_req_zone` before `server{}` in conf.d template = valid http-context

## What went wrong
(Pre-emptive) When adding rate limiting to `deploy/nginx.conf.template`, a future
agent might assume that `map`, `limit_req_zone`, and `limit_req_status` — which are
http-context directives — can only go in `nginx.conf` itself, not in a `conf.d/` file.
Or they might place them inside `server {}`, which would fail with "not allowed here".

## Fix
Directives placed BEFORE the `server {}` block in `deploy/nginx.conf.template` land
in the `http {}` context because nginx.conf includes all `conf.d/*.conf` files INSIDE
its `http {}` block:

```nginx
# deploy/nginx.conf.template (rendered to /etc/nginx/conf.d/default.conf)
# These sit at http context — valid here:
map $http_cf_connecting_ip $ai_rate_key {
    ""      $binary_remote_addr;   # local/dev: no CF header -> direct IP
    default $http_cf_connecting_ip; # Cloudflare tunnel: real user IP
}
limit_req_zone $ai_rate_key zone=ai_gen:10m rate=10r/m;
limit_req_status 429;

server {
    ...
    location /ollama/ {
        limit_req zone=ai_gen burst=5 nodelay;
        ...
    }
}
```

CF-Connecting-IP note: this repo uses `cloudflared` tunnel (not Cloudflare WARP).
With a tunnel, `CF-Connecting-IP` is the real individual user IP — NOT a shared
WARP egress IP. The `map` fallback to `$binary_remote_addr` covers direct/local
access when the Cloudflare tunnel is not in use.

## Verification
```sh
docker run --rm \
  -e OLLAMA_HOST=codex:8082 \
  -e COLLAB_HOST=collab:8081 \
  -e CLAUDE_HOST=claude:8083 \
  -e AGY_HOST=agy:8084 \
  -e NGINX_ENVSUBST_FILTER="OLLAMA_|COLLAB_|CLAUDE_|AGY_" \
  -v "$PWD/deploy/nginx.conf.template:/etc/nginx/templates/default.conf.template:ro" \
  nginx:1.27-alpine nginx -t
# -> "syntax is ok / test is successful"
```
