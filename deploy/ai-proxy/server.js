// ai-proxy — a tiny, dependency-free Ollama-compatible shim that forwards to the OpenAI
// Responses API (default model: gpt-5-mini).
//
// Why: the browser app talks "Ollama dialect" (POST /api/chat, GET /api/tags) through the
// same-origin nginx proxy. This service speaks that same dialect on the OUTSIDE, but on the
// INSIDE calls a cloud LLM — so inference leaves the VPS (light host, strong instruction
// following) with ZERO changes to the app or nginx. Pick this backend by pointing the app's
// upstream at `ai-proxy:8080` (AI_UPSTREAM in .env). The API key stays here, server-side.
//
// Env: OPENAI_API_KEY (required), OPENAI_MODEL (default gpt-5-mini),
//      OPENAI_BASE_URL (default https://api.openai.com/v1/responses),
//      OPENAI_REASONING_EFFORT (default low; gpt-5-mini also accepts "minimal" for faster/cheaper),
//      OPENAI_MAX_OUTPUT_TOKENS (default 1024), PORT (default 8080).
//
// Model choice mirrors the Ollama Modelfile: qwen2.5-coder:1.5b (small, cheap, code-strong,
// deterministic) -> gpt-5-mini. Both are REASONING models, so temperature/top_p are dropped
// and reasoning.effort is sent. Scale up like the Modelfile's qwen2.5-coder:7b note via
// OPENAI_MODEL=gpt-5.

import http from "node:http";

const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/responses";
const EFFORT = process.env.OPENAI_REASONING_EFFORT || "low";
const MAX_OUT = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 1024);

const sendJson = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 5_000_000) reject(new Error("request body too large"));
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

// Pull the assistant text out of a Responses API result (raw HTTP shape, no SDK).
const extractText = (data) => {
  if (typeof data.output_text === "string" && data.output_text) return data.output_text;
  const parts = [];
  for (const item of data.output || []) {
    for (const c of item.content || []) {
      if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("");
};

async function handleChat(req, res) {
  if (!API_KEY) {
    return sendJson(res, 500, { error: "OPENAI_API_KEY is not set on the ai-proxy service" });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "invalid JSON body" });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // Ollama dialect -> Responses API: system messages become `instructions`, the rest is `input`.
  const instructions = messages
    .filter((m) => m.role === "system")
    .map((m) => String(m.content ?? ""))
    .join("\n\n");
  const input = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") }));

  let upstream;
  try {
    upstream = await fetch(BASE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        ...(instructions ? { instructions } : {}),
        input,
        max_output_tokens: MAX_OUT,
        // gpt-5-mini (and codex-mini-latest) are REASONING models: temperature/top_p are NOT
        // supported and 400 if sent, so we drop Ollama's options.temperature and only set
        // reasoning.effort + max_output_tokens.
        reasoning: { effort: EFFORT },
      }),
    });
  } catch (e) {
    return sendJson(res, 502, { error: `cannot reach OpenAI: ${e.message}` });
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    return sendJson(res, upstream.status, { error: `OpenAI HTTP ${upstream.status}: ${text.slice(0, 500)}` });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return sendJson(res, 502, { error: "OpenAI returned non-JSON" });
  }
  // Respond in Ollama's /api/chat shape so the app needs no changes.
  return sendJson(res, 200, {
    model: MODEL,
    created_at: new Date().toISOString(),
    message: { role: "assistant", content: extractText(data) },
    done: true,
    done_reason: "stop",
  });
}

const server = http.createServer((req, res) => {
  const url = (req.url || "").split("?")[0];
  if (req.method === "GET" && url === "/healthz") return sendJson(res, 200, { ok: true });
  // Ollama parity: let the app's model list / health checks succeed.
  if (req.method === "GET" && (url === "/api/tags" || url === "/api/version")) {
    return sendJson(res, 200, { models: [{ name: MODEL, model: MODEL, size: 0 }], version: "ai-proxy" });
  }
  if (req.method === "POST" && url === "/api/chat") return handleChat(req, res);
  return sendJson(res, 404, { error: `not found: ${req.method} ${url}` });
});

server.listen(PORT, () => {
  console.log(`ai-proxy listening on :${PORT} -> ${BASE_URL} (model ${MODEL}); key ${API_KEY ? "set" : "MISSING"}`);
});
