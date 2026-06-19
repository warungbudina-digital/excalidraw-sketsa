# Compose `${VAR:?}` breaks EVERY command, even for the other profile

## What went wrong
The stack has two profile-gated backends (`ollama` = profile local, `ai-proxy` = profile
cloud). I guarded the cloud secret with `OPENAI_API_KEY: ${OPENAI_API_KEY:?set ...}`. That
made EVERY `docker compose` command fail — even `docker compose ps` while running the LOCAL
profile — with "required variable OPENAI_API_KEY is missing a value". Reason: Compose does
variable interpolation over the WHOLE file BEFORE filtering by active profiles, so a hard
`:?` on a service in an inactive profile still aborts the command.

## Fix
Use a soft default for profile-specific / optional secrets and validate at RUNTIME inside the
service: `OPENAI_API_KEY: ${OPENAI_API_KEY:-}` (the ai-proxy logs "key MISSING" and returns a
clear 500 if empty). Reserve `:?` only for vars every active configuration truly needs. (The
local backend then never needs OPENAI_API_KEY at all.) Note CLOUDFLARE_TUNNEL_TOKEN still uses
`:?` because cloudflared has no profile and is always required.

## Verification
With OPENAI_API_KEY unset: `COMPOSE_PROFILES=local docker compose config --services` ->
app/cloudflared/ollama, and `COMPOSE_PROFILES=cloud docker compose config --services` ->
ai-proxy/app/cloudflared — both succeed (no interpolation error). `docker compose ps` works
without the key.
