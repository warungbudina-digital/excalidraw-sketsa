// memory — captures AI generation turns and persists them to Supabase (Postgres via
// PostgREST). Zero-dep Node, same shape as deploy/collab/server.js.
//
// OUTSIDE (reached by nginx /memory/* over the compose network):
//   POST /memory   -> insert one generation turn        {id} | 503 if Supabase unset
//   GET  /memory   -> recent turns (limit, optional q)   [{...}]
//   GET  /healthz  -> liveness + last keep-alive result
//
// INSIDE: talks to Supabase REST with the SERVICE ROLE key. That key stays here,
// server-side — the browser never sees it and never calls Supabase directly (same
// posture as the codex/claude auth and the ai-proxy key).
//
// KEEP-ALIVE: Supabase's free tier PAUSES a project after ~7 days of no REST/DB
// activity. A lightweight `select id limit 1` every few days keeps it warm. See
// pingSupabase() + the scheduler at the bottom.
import http from "node:http";

const PORT = Number(process.env.PORT || 8085);
const MAX_BODY = Number(process.env.MEMORY_MAX_BODY_BYTES || 20_000_000);
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || "").trim();
const TABLE = (process.env.MEMORY_TABLE || "ai_memory").trim();
const DEFAULT_LIMIT = Math.max(1, Number(process.env.MEMORY_LIST_LIMIT || 50));

// Keep-alive cadence. Default 3 days — comfortably under Supabase's ~7-day idle
// pause. setInterval is safe here: 3d = 259_200_000 ms < the ~24.8-day timer cap.
const PING_INTERVAL_MS = Math.min(
  2_147_483_647,
  Number(process.env.MEMORY_PING_INTERVAL_MS || 3 * 24 * 60 * 60 * 1000),
);
const PING_TIMEOUT_MS = Number(process.env.MEMORY_PING_TIMEOUT_MS || 10_000);

const configured = Boolean(SUPABASE_URL && SERVICE_KEY);
let lastPing = { at: null, ok: false, detail: configured ? "belum dijalankan" : "Supabase tidak dikonfigurasi" };

// A failed ping or insert must never take the process down — degrade, don't crash.
process.on("unhandledRejection", (e) => console.error("memory: unhandledRejection", e?.message ?? e));

const authHeaders = {
  apikey: SERVICE_KEY,
  authorization: `Bearer ${SERVICE_KEY}`,
  "content-type": "application/json",
};

const sendJson = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
};

const readJson = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });

/** Build the row to insert from a client payload; returns [row, error]. */
function rowFromBody(body) {
  const backend = body?.backend;
  if (!["codex", "claude", "agy"].includes(backend)) return [null, "backend tidak valid (codex|claude|agy)"];
  if (typeof body?.prompt !== "string" || !body.prompt.trim()) return [null, "prompt kosong"];
  if (typeof body?.response !== "string" || !body.response.trim()) return [null, "response kosong"];
  return [
    {
      backend,
      model: typeof body.model === "string" ? body.model : null,
      prompt: body.prompt,
      response: body.response,
      scene_snapshot: body.scene_snapshot ?? null,
      meta: body.meta && typeof body.meta === "object" ? body.meta : {},
      room_id: typeof body.room_id === "string" ? body.room_id : null,
      tags: Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === "string") : [],
    },
    null,
  ];
}

async function handleInsert(req, res) {
  if (!configured) return sendJson(res, 503, { error: "Supabase tidak dikonfigurasi (set SUPABASE_URL + SUPABASE_SERVICE_KEY)" });
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendJson(res, e.message === "payload too large" ? 413 : 400, { error: e.message });
  }
  const [row, problem] = rowFromBody(body);
  if (problem) return sendJson(res, 400, { error: problem });

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
      method: "POST",
      headers: { ...authHeaders, prefer: "return=representation" },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    const text = await r.text();
    if (!r.ok) return sendJson(res, 502, { error: `Supabase ${r.status}: ${text.slice(0, 300)}` });
    const inserted = JSON.parse(text)?.[0];
    return sendJson(res, 201, { id: inserted?.id ?? null });
  } catch (e) {
    return sendJson(res, 502, { error: `gagal menulis ke Supabase: ${e.message}` });
  }
}

async function handleList(res, url) {
  if (!configured) return sendJson(res, 503, { error: "Supabase tidak dikonfigurasi" });
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT));
  const q = (url.searchParams.get("q") || "").trim();
  const params = new URLSearchParams({
    select: "id,created_at,backend,model,prompt,tags",
    order: "created_at.desc",
    limit: String(limit),
  });
  // Optional substring search over the prompt (PostgREST ilike).
  if (q) params.set("prompt", `ilike.*${q}*`);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?${params}`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    const text = await r.text();
    if (!r.ok) return sendJson(res, 502, { error: `Supabase ${r.status}: ${text.slice(0, 300)}` });
    return sendJson(res, 200, JSON.parse(text));
  } catch (e) {
    return sendJson(res, 502, { error: `gagal membaca dari Supabase: ${e.message}` });
  }
}

/** Lightweight REST call that keeps the Supabase project from auto-pausing. */
async function pingSupabase() {
  if (!configured) {
    lastPing = { at: new Date().toISOString(), ok: false, detail: "Supabase tidak dikonfigurasi" };
    return lastPing;
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?select=id&limit=1`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    await r.text();
    lastPing = { at: new Date().toISOString(), ok: r.ok, detail: r.ok ? "warm" : `HTTP ${r.status}` };
  } catch (e) {
    lastPing = { at: new Date().toISOString(), ok: false, detail: e.message };
  }
  console.log(`memory: keep-alive ping -> ${lastPing.ok ? "ok" : "fail"} (${lastPing.detail})`);
  return lastPing;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/healthz") {
    return sendJson(res, 200, { ok: true, backend: "memory", configured, lastPing });
  }
  if (req.method === "POST" && url.pathname === "/memory") return void handleInsert(req, res);
  if (req.method === "GET" && url.pathname === "/memory") return void handleList(res, url);
  return sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`memory shim on :${PORT} (supabase=${configured ? "configured" : "UNSET"}, ping every ${Math.round(PING_INTERVAL_MS / 3_600_000)}h)`);
  // Warm once shortly after boot, then on the long cadence. unref() so the timer
  // never keeps the process alive on its own.
  setTimeout(pingSupabase, 15_000).unref();
  setInterval(pingSupabase, PING_INTERVAL_MS).unref();
});
