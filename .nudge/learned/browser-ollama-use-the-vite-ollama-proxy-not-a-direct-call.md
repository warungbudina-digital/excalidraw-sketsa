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

### Gotcha: HTTP 403 from the browser even WITH the proxy
The proxy alone is not enough. Ollama (0.x, e.g. 0.30.10) rejects requests whose `Origin`
header isn't localhost and returns **HTTP 403** — and the Cloud Shell origin is
`https://<port>-<hash>.cloudshell.dev`, not localhost. `changeOrigin: true` only rewrites
the `Host` header, NOT `Origin`, so the browser's Origin is forwarded and rejected. This is
why a plain `curl` test (no Origin header) returns 200 while the real browser gets 403.
Fix: strip Origin/Referer in the proxy so Ollama sees a non-browser client:
```ts
configure: (proxy) => {
  proxy.on("proxyReq", (proxyReq) => {
    proxyReq.removeHeader("origin");
    proxyReq.removeHeader("referer");
  });
}
```
Type the proxy object as `Record<string, ProxyOptions>` (import `ProxyOptions` from "vite")
so `configure`/`proxyReq` get correct contextual types — a hand-written narrow type for the
`proxy` param fails `tsc` (not assignable to http-proxy `Server`).

## Verification
`curl -sf http://localhost:8080/ollama/api/tags` lists the model. To reproduce/confirm the
403 fix, send the browser's Origin through the proxy:
`curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/ollama/api/chat -H "Origin: https://8080-x.cloudshell.dev" -H "Content-Type: application/json" -d '{"model":"qwen2.5-coder:1.5b","messages":[{"role":"user","content":"hi"}],"stream":false}'`
— must return 200 (was 403 before stripping Origin). Also `npm run typecheck` must pass.
