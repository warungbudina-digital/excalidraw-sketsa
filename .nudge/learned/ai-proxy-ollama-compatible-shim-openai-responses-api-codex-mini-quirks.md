# ai-proxy: Ollama-compatible shim -> OpenAI Responses API (codex-mini quirks)

## What to know
`deploy/ai-proxy/server.js` is the cloud AI backend: outside it speaks the Ollama dialect
(`GET /api/tags`, `POST /api/chat`) so the browser app + nginx are UNCHANGED; inside it calls
the OpenAI **Responses API** (`/v1/responses`, default `codex-mini-latest`). Swap backends via
`.env` (`COMPOSE_PROFILES=cloud`, `AI_UPSTREAM=ai-proxy:8080`); the key stays server-side
(browser only ever sees same-origin `/ollama/*`). Hard-won specifics:
- Map Ollama `messages` -> Responses API: system messages become `instructions` (string),
  the rest become `input` (array of `{role, content}`). NOT chat-completions `messages`.
- codex-mini is a REASONING model: `temperature`/`top_p` are NOT supported and 400 if sent.
  So the proxy deliberately drops Ollama's `options.temperature`; it only sets
  `reasoning: { effort }` and `max_output_tokens`.
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
