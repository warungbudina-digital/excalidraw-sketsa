# ai-proxy: Ollama-compatible shim -> OpenAI Responses API (codex-mini quirks)

## What to know
`deploy/ai-proxy/server.js` is the cloud AI backend: outside it speaks the Ollama dialect
(`GET /api/tags`, `POST /api/chat`) so the browser app + nginx are UNCHANGED; inside it calls
the OpenAI **Responses API** (`/v1/responses`, default `gpt-5-mini` — was `codex-mini-latest`).
Swap backends via `.env` (`COMPOSE_PROFILES=cloud`, `AI_UPSTREAM=ai-proxy:8080`); the key stays
server-side (browser only ever sees same-origin `/ollama/*`). Hard-won specifics:
- Default model `gpt-5-mini` mirrors the Modelfile's `qwen2.5-coder:1.5b` (small/cheap/
  code-strong/deterministic). Scale up via `OPENAI_MODEL=gpt-5` (like Modelfile's `:7b` note).
- Map Ollama `messages` -> Responses API: system messages become `instructions` (string),
  the rest become `input` (array of `{role, content}`). NOT chat-completions `messages`.
- gpt-5-mini AND codex-mini are REASONING models: `temperature`/`top_p` are NOT supported and
  400 if sent. So the proxy deliberately drops Ollama's `options.temperature`; it only sets
  `reasoning: { effort }` (default low; gpt-5 also accepts "minimal") and `max_output_tokens`.
- Extract the reply from the raw HTTP result by walking `output[].content[]` for items with
  `type === "output_text"` (or top-level `output_text` if present) — there is no
  `choices[].message.content` like chat-completions.
- Respond in Ollama's shape `{ model, message:{role,content}, done:true }` so the app's
  `data.message.content` parsing in src/ai/ollama.ts works unchanged.

## Verification
`docker compose --profile cloud up -d --build ai-proxy` (dummy key ok for these):
`docker compose exec app wget -qO- http://ai-proxy:8080/api/tags` lists the model;
`POST /api/chat` with a dummy key returns OpenAI **401 propagated** (proves parse +
message->Responses translation + upstream call). A real OPENAI_API_KEY returns the script.

NOTE (billing gotcha): if `/api/chat` comes back as **429 `billing_not_active`** ("Your account
is not active, please check your billing details"), that is NOT a code/config bug — the whole
pipeline (browser -> nginx /ollama -> ai-proxy -> OpenAI) is wired correctly and is propagating
OpenAI's account-state error verbatim. Fix it on the OpenAI side (activate billing / use a key
from a billed account); no redeploy needed once the account is active. 429 here is account state,
not rate-limit — retrying won't help.
