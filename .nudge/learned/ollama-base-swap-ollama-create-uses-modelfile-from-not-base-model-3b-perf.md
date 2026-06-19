# Ollama base swap: `ollama create` uses Modelfile FROM (not BASE_MODEL); 3b perf

## What to know
The `ollama` service entrypoint (`deploy/ollama-entrypoint.sh`) pulls `BASE_MODEL` then runs
`ollama create excalidraw-ea -f /Modelfile`. `ollama create` builds FROM the **Modelfile's
`FROM` line**, NOT the `BASE_MODEL` env. So to change the model you MUST edit BOTH:
`Modelfile` `FROM` (the real source) AND `docker-compose.yml` `BASE_MODEL` (just the pre-pull).
Editing only `BASE_MODEL` pulls the new base but excalidraw-ea is still built from the old FROM.

## How to apply a change
The entrypoint recreates excalidraw-ea on every container start ("recreating to pick up Modelfile
changes"). So: edit the files, then recreate the container — `docker compose up -d ollama` — and
watch `docker compose logs ollama` for `ollama-init: ready`. The base pull (~1.9GB for 3b) +
verify happens first; `ollama create` is quick (shares base layers).

## qwen2.5-coder:3b-instruct on this Cloud Shell (2 vCPU, 7.8Gi, NO swap)
- With the model loaded: available RAM drops to ~2.8Gi (used ~5.0Gi) — tight but no OOM observed.
- Cold load (model + the large baked SYSTEM) ~278s; warm generation ~35s (`keep_alive:5m` holds
  it). First user after idle waits for the cold load. The 1.5b base is much lighter (~1.3GB RSS)
  if RAM is tight.
- After swapping, drop the now-unused old base to reclaim disk:
  `docker compose exec ollama ollama rm qwen2.5-coder:1.5b` (excalidraw-ea no longer references it).

See [[testing-excalidraw-ea-a-request-system-message-replaces-the-modelfile-system]] for how to
smoke-test (no `system` stub), and [[browser-ollama-use-the-vite-ollama-proxy-not-a-direct-call]].
