# Browser -> Ollama: use the Vite /ollama proxy, not a direct call

## What went wrong
Calling the local Ollama container (`http://localhost:11434`) directly from the browser
hits CORS, and on a remote VPS/Cloud Shell the browser often cannot reach :11434 at all.
Exposing Ollama publicly to fix this is the wrong move.

## Fix
Proxy through the Vite dev/preview server (`vite.config.ts`): map `/ollama` ->
`http://localhost:11434` with `rewrite: p => p.replace(/^\/ollama/, "")`. The browser then
calls same-origin `/ollama/api/chat` (no CORS) and Ollama stays private. App code lives in
`src/ai/ollama.ts` and posts to `/ollama/api/chat` with `model: "qwen2.5-coder:1.5b"`.
Start Ollama with: `docker run -d --name ollama -p 11434:11434 -v ~/ollama-data:/root/.ollama ollama/ollama`
then `docker exec ollama ollama pull qwen2.5-coder:1.5b` (the `-v` volume in $HOME survives
Cloud Shell session resets). Dev server runs on port 8080 (host:true) for Cloud Shell Web Preview.

## Verification
`curl -sf http://localhost:8080/ollama/api/tags` lists the model, and a POST to
`http://localhost:8080/ollama/api/chat` returns generated EA code in `.message.content`.
