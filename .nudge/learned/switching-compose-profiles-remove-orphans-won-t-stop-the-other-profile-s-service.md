# Switching compose profiles: --remove-orphans won't stop the other profile's service

## What to know
The stack has two profile-gated backends: `ollama` (profile `local`) and `ai-proxy` (profile
`cloud`). Switching backend = edit `.env` `COMPOSE_PROFILES` + `AI_UPSTREAM`, then
`docker compose up -d` (recreates `app` with the new `OLLAMA_HOST` upstream and starts the
now-active backend).

## Gotcha (hit both directions)
`docker compose up -d --remove-orphans` does NOT stop the previously-running backend from the
OTHER profile — a profiled service that is merely inactive is NOT treated as an orphan. So the
old backend keeps running, wasting RAM; and because the app's nginx resolves its upstream at
request time, the app still works, masking the leftover container. Seen both ways: `ollama` left
running after switching to cloud, and `ai-proxy` left running after switching to local.

## Fix
Stop it explicitly: `docker compose stop ollama` (or `docker compose stop ai-proxy`). Confirm
with `docker compose ps`. The `app` container must be RECREATED on a switch so nginx re-templates
`OLLAMA_HOST` from the new `AI_UPSTREAM` (it is envsubst'd at container start) — `docker compose
up -d` does this automatically because the env changed.

Related: [[ai-proxy-ollama-compatible-shim-openai-responses-api-codex-mini-quirks]] and
[[compose-var-breaks-every-command-even-for-the-other-profile]].
