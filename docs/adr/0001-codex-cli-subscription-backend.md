# ADR 0001 — Codex CLI (ChatGPT subscription) as the sole AI backend

- Status: **Accepted** (directed by the project owner)
- Date: 2026-06-24
- Supersedes: the dual `ollama` (local) + `ai-proxy` (OpenAI Responses API, metered) backends.

## Context

The Script panel generates/edits Excalidraw Automate (EA) scripts with an AI backend. Prior
design offered two interchangeable backends behind one `AI_UPSTREAM` slot (Strategy pattern):
`ollama` (local, free, ~1.9 GB model on disk) and `ai-proxy` (OpenAI Responses API, **billed
per token**, needs `OPENAI_API_KEY`).

The owner's two hard requirements:
1. **Use an AI subscription plan (flat cost), not metered API.** The Responses API path cannot
   use a ChatGPT/Codex subscription — it requires a metered API key. Only the **Codex CLI with
   "Sign in with ChatGPT"** uses the subscription's included Codex usage.
2. **Accurate script output** — the returned script must be runnable.

Plus a storage constraint: the ephemeral host is disk-tight; the ~1.9 GB Ollama model is the
biggest consumer.

## Decision

1. Add a **`codex` container** (`deploy/codex/`): a tiny dependency-free HTTP shim that speaks
   the **Ollama dialect** outside (`POST /api/chat` → `{message:{content}}`) — so the browser,
   nginx, and `src/ai/ollama.ts` are **UNCHANGED** — and inside runs the **Codex CLI**
   non-interactively: `codex exec --ephemeral --skip-git-repo-check -s read-only -o <file>`,
   returning the agent's last message. Verified CLI facts (codex-cli 0.142.0 `--help`):
   - `exec -o/--output-last-message <FILE>` yields a clean final message (no transcript).
   - `login --device-auth` does headless device-code OAuth; credentials persist to
     `$CODEX_HOME` (mounted as a volume). `--with-api-key`/`--with-access-token` are alternatives.
   - `-s read-only` keeps the agent from editing files (we only want the script back).
2. Add a **server-side validation gate** in the shim: the generated script must parse with the
   SAME `AsyncFunction` constructor the runner uses (`src/automate/scriptRunner.ts`) and must
   reference `ea.`; on failure the shim re-prompts Codex (bounded retries). Accuracy becomes a
   property of OUR system, independent of the model.
3. **Single source of truth stays `src/ai/ollama.ts`.** The app sends the full EA system prompt
   per request; the shim uses it as the Codex instructions. Codex **`AGENTS.md` is NOT populated**
   with EA knowledge (mirrors how `Modelfile` SYSTEM only drove bare `ollama run`). No new
   sync burden.
4. **Remove** `ollama` and `ai-proxy` services, `Modelfile`, `deploy/ollama-entrypoint.sh`, and
   `deploy/ai-proxy/` to reclaim storage. `codex` becomes the only backend.

## Consequences

Positive:
- Flat **subscription** billing instead of per-token.
- Big **storage** win (no ~1.9 GB model; codex image ≈ node-slim + a small binary).
- Stronger coding model + a **validation gate** guaranteeing runnable output.
- The `/ollama/*` contract and `src/ai/ollama.ts` are untouched (Adapter boundary held).

Negative / trade-offs:
- **No fallback backend.** Codex is sole; if auth/ToS/rate-limit fails, AI script-gen is down.
  This trades resilience for storage — an explicit owner decision.
- `codex exec` is an agent: heavier/slower than a direct API call (mitigated by `read-only`
  + `--ephemeral`).
- Auth is a one-time **device-login** persisted to a volume; token refresh/expiry to manage.

## Risks (honest)

- **ToS / usage policy:** using a personal ChatGPT/Codex subscription as an **automated app
  backend** (potentially multi-user) may violate intended-use terms or hit rate limits. The
  owner accepts this risk. Not a technical guarantee.
- **Not verified end-to-end here:** this environment has no subscription credentials. Verified:
  image build, shim boot, `codex doctor`, the unauthenticated error path, and the validation
  gate. **NOT verified:** real generation, latency under load, multi-user behavior.

## Alternatives considered

- **A. Swap `ai-proxy` to a Codex-family model** via Responses API — rejected: still metered
  API, does not use the subscription.
- **B. Keep all three backends** as fallbacks — rejected by the owner for storage.
- **C. Agentic loop without the CLI** — folded in as the shim's validation/retry gate.

## Follow-ups

- Update `README.md`, `docs/ARCHITECTURE.md`, `docs/RUNBOOK.md` to drop ollama/ai-proxy.
- Several `.nudge/learned/*` now describe removed components — kept as historical record.
- `.nudge/rules.yaml` reminders referencing ollama/ai-proxy can be trimmed later.
- Reclaim disk after switching: `docker rmi ollama/ollama` and remove the model dir
  (`~/ollama-data`) — destructive, run manually.
