// codex — an Ollama-dialect shim in front of the Codex CLI (ChatGPT subscription backend).
//
// Outside it speaks the SAME dialect as ai-proxy/ollama (`POST /api/chat` -> {message:{content}}),
// so the browser app, nginx, and src/ai/ollama.ts are UNCHANGED. Inside it runs the Codex CLI
// non-interactively (`codex exec ... -o <file>`) and applies a VALIDATION GATE: the generated EA
// script must parse with the same AsyncFunction the runner uses (src/automate/scriptRunner.ts)
// and reference `ea.`; otherwise it re-prompts Codex (bounded retries). See ADR 0001.
//
// Auth: Codex reads $CODEX_HOME (mounted volume). Run `codex login --device-auth` once.
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.PORT || 8082);
const MODEL = (process.env.CODEX_MODEL || "").trim(); // empty = Codex default (the subscription model)
const MAX_ATTEMPTS = Math.max(1, Number(process.env.CODEX_MAX_ATTEMPTS || 2));
const TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 120_000);
const MAX_BODY = Number(process.env.CODEX_MAX_BODY_BYTES || 2_000_000);

// Same constructor scriptRunner.ts uses — if a script parses here, it parses there.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

process.on("unhandledRejection", (e) => console.error("codex: unhandledRejection", e?.message ?? e));

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

const stripFences = (text) => {
  const fenced = text.match(/```(?:javascript|js|typescript|ts)?\s*\n([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
};

/** The validation gate. Returns null when the script is acceptable, else a reason string. */
function validateScript(script) {
  if (!script || !script.trim()) return "script kosong";
  try {
    // eslint-disable-next-line no-new-func
    new AsyncFunction("ea", "utils", "console", script);
  } catch (e) {
    return `sintaks tidak valid: ${e.message}`;
  }
  if (!/\bea\s*\./.test(script)) return "tidak memanggil EA API (ea.*)";
  return null;
}

/** Run `codex exec` reading the prompt from stdin, return the agent's last message. */
function runCodexExec(prompt) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(os.tmpdir(), `codex-${process.pid}-${Date.now()}.txt`);
    const args = ["exec"];
    if (MODEL) args.push("-m", MODEL);
    args.push("--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-o", outFile, "-");

    const child = spawn("codex", args, { env: process.env });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("codex exec timeout"));
    }, TIMEOUT_MS);

    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 50_000) stderr = stderr.slice(-50_000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`tidak bisa menjalankan codex: ${e.message}`));
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      let last = "";
      try {
        last = await readFile(outFile, "utf8");
      } catch {
        // no output file
      }
      await rm(outFile, { force: true }).catch(() => {});
      if (!last.trim()) {
        reject(new Error(`codex exec gagal (exit ${code}): ${stderr.slice(-400) || "tidak ada output (sudah login?)"}`));
        return;
      }
      resolve(last);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

const codexLoginStatus = () =>
  new Promise((resolve) => {
    execFile("codex", ["login", "status"], { timeout: 10_000, env: process.env }, (err, stdout, stderr) => {
      resolve({ ok: !err, detail: `${stdout || ""}${stderr || ""}`.trim().slice(0, 200) });
    });
  });

async function handleChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendJson(res, e.message === "payload too large" ? 413 : 400, { error: e.message });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages.filter((m) => m && m.role === "system").map((m) => m.content).join("\n\n");
  const user = messages.filter((m) => m && m.role && m.role !== "system").map((m) => m.content).join("\n\n");
  const base =
    [system, user].filter(Boolean).join("\n\n---\n\n") +
    "\n\nOutput ONLY the runnable EA script (JavaScript). No prose, no markdown fences.";

  let prompt = base;
  let lastProblem = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let raw;
    try {
      raw = await runCodexExec(prompt);
    } catch (e) {
      // codex not authenticated / runtime failure — do not retry, surface clearly.
      return sendJson(res, 503, { error: `codex backend: ${e.message}` });
    }
    const script = stripFences(raw);
    const problem = validateScript(script);
    if (!problem) {
      return sendJson(res, 200, {
        model: MODEL || "codex",
        message: { role: "assistant", content: script },
        done: true,
      });
    }
    lastProblem = problem;
    prompt = `${base}\n\nYour previous attempt was rejected (${problem}). Return a corrected, complete, runnable EA script only.`;
  }
  return sendJson(res, 422, {
    error: `script tidak lolos validasi setelah ${MAX_ATTEMPTS} percobaan: ${lastProblem}`,
  });
}

async function handleHealth(res) {
  const status = await codexLoginStatus();
  sendJson(res, 200, {
    ok: true,
    backend: "codex",
    model: MODEL || "codex-default",
    auth: status.ok ? "logged-in" : "not-logged-in",
    detail: status.detail,
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/healthz") return void handleHealth(res);
  if (req.method === "GET" && url.pathname === "/api/tags") {
    return sendJson(res, 200, { models: [{ name: MODEL || "codex", model: MODEL || "codex" }] });
  }
  if (req.method === "POST" && url.pathname === "/api/chat") return void handleChat(req, res);
  return sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () =>
  console.log(`codex shim on :${PORT} (CODEX_HOME=${process.env.CODEX_HOME || "~/.codex"}, model=${MODEL || "default"})`),
);
