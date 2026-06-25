# nginx NGINX_ENVSUBST_FILTER must be extended for each new upstream variable

## What went wrong
Added `${CLAUDE_HOST}` to `deploy/nginx.conf.template` for the new `/claude/` proxy
location. The nginx:alpine image runs `envsubst` at startup filtered by
`NGINX_ENVSUBST_FILTER` (set in the app Dockerfile). Because `CLAUDE_` was not in
the filter, `${CLAUDE_HOST}` would have been passed through literally as text instead
of being substituted, causing nginx to fail resolving the upstream.

## Fix
In `Dockerfile` (app stage), extend the filter to include the new prefix:

```dockerfile
# Before (codex + collab only):
ENV NGINX_ENVSUBST_FILTER="OLLAMA_|COLLAB_"

# After (added CLAUDE_):
ENV NGINX_ENVSUBST_FILTER="OLLAMA_|COLLAB_|CLAUDE_"
```

Rule: any new `${VAR_NAME}` placeholder added to `deploy/nginx.conf.template` needs
its prefix (`VAR_`) added to this pipe-separated filter, AND the corresponding
`ENV VAR_NAME=default` in the Dockerfile (or compose environment) so envsubst has
a value to substitute.

## Verification

```sh
# Render and syntax-check the template without a full stack:
docker run --rm \
  -e OLLAMA_HOST=codex:8082 \
  -e COLLAB_HOST=collab:8081 \
  -e CLAUDE_HOST=claude:8083 \
  -e NGINX_ENVSUBST_FILTER="OLLAMA_|COLLAB_|CLAUDE_" \
  -v "$PWD/deploy/nginx.conf.template:/etc/nginx/templates/default.conf.template:ro" \
  nginx:1.27-alpine nginx -t
# -> "syntax is ok / test is successful"
# Confirm no literal ${...} remains in rendered config:
# docker compose exec app cat /etc/nginx/conf.d/default.conf | grep '\${'
```
