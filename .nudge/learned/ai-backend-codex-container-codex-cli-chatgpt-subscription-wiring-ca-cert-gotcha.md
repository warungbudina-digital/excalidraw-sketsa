# AI backend = `codex` container (Codex CLI + ChatGPT subscription): wiring + ca-cert gotcha

## What to know
The AI backend is `deploy/codex/server.js` — a zero-dep Node shim that speaks the Ollama dialect
OUTSIDE (`POST /api/chat` -> `{message:{content}}`, so app/nginx/`src/ai/ollama.ts` are UNCHANGED)
and runs Codex CLI headless INSIDE. ollama (local) and ai-proxy (metered) were REMOVED. Verified
facts (codex-cli 0.142.0 `--help`):
- Generation: `codex exec --ephemeral --skip-git-repo-check -s read-only -o <file> -` with the
  prompt on STDIN; read the `-o` last-message file (clean final answer, NOT the transcript).
  `-m <model>` optional (empty = the model the subscription grants).
- Subscription auth headless: `codex login --device-auth` (device-code; authorize in a browser on
  another device), or `--with-access-token` / `--with-api-key` via stdin. Credential persists to
  `$CODEX_HOME` -> mounted volume `/codex-home`. NOTE: the plain OpenAI Responses API (old ai-proxy)
  CANNOT use a subscription — only the CLI login can. That is the whole reason for the CLI.
- Accuracy gate: the shim validates the script with the SAME `AsyncFunction` constructor as
  `src/automate/scriptRunner.ts` and requires `ea.*`; retries `CODEX_MAX_ATTEMPTS` on failure.
  Single source of the EA system prompt stays `src/ai/ollama.ts` (sent per request); Codex
  `AGENTS.md` is intentionally NOT populated (parallel to how Modelfile only drove bare `ollama run`).

## The ca-cert gotcha (the real bug verification caught)
On `node:22-slim` the Codex (Rust) binary fails HTTPS to api.openai.com with `no CA certificates
found` — slim has no system cert store. FIX: `apt-get install -y --no-install-recommends
ca-certificates` in `deploy/codex/Dockerfile`. (The build-time `npm install -g @openai/codex`
download works WITHOUT it because npm uses node's bundled certs, not the Rust binary's store — so
the failure only shows at request time.)

## Verification ladder (no subscription credentials needed)
1. `docker build ./deploy/codex` -> image ~0.7 GB (vs the removed ~1.9 GB ollama model).
2. Run; `GET /healthz` -> `{"auth":"not-logged-in"}` (works unauthenticated).
3. `POST /api/chat` without login -> HTTP **503** with a clear "codex backend" message; the
   container STAYS alive (graceful, no crash).
4. AFTER the ca-cert fix, that 503's detail changes from "no CA certificates" to
   **`401 Unauthorized` at https://api.openai.com/v1/responses** — proving image + TLS reach OpenAI
   and only the login is missing. That 401 is the MAXIMAL verification without real credentials.
NOT covered here (need the device-login): real generation, latency/load, the Cloudflare path.

## Why / trade-off
Owner wanted flat subscription billing + accurate output + storage savings, so ollama + ai-proxy
were dropped. See `docs/adr/0001-codex-cli-subscription-backend.md`. Codex is the SOLE backend (no
fallback); using a personal subscription as an automated app backend has ToS / rate-limit risk.
