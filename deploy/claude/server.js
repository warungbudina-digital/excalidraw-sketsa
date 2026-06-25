// claude — Claude Code CLI backend in the same Ollama dialect as the codex shim.
//
// Outside it speaks POST /api/chat -> {message:{content}} — identical contract to codex,
// so app/nginx/src/ai/ollama.ts are UNCHANGED. Inside it runs the Claude Code CLI
// non-interactively (`claude --print <prompt>`) — exactly parallel to how the codex shim
// runs `codex exec --ephemeral ...`. Auth ONCE, credential persists to a named volume:
//   docker compose exec claude claude auth login
// Without login the shim returns 503, same behaviour as codex without `codex login`.
import http from "node:http";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.PORT || 8083);
const MODEL = (process.env.CLAUDE_MODEL || "").trim(); // empty = CLI default
const MAX_ATTEMPTS = Math.max(1, Number(process.env.CLAUDE_MAX_ATTEMPTS || 2));
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 120_000);
const MAX_BODY = Number(process.env.CLAUDE_MAX_BODY_BYTES || 2_000_000);

// Same constructor scriptRunner.ts uses — if a script parses here, it parses there.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

process.on("unhandledRejection", (e) => console.error("claude: unhandledRejection", e?.message ?? e));

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
    new AsyncFunction("ea", "utils", "console", script);
  } catch (e) {
    return `sintaks tidak valid: ${e.message}`;
  }
  if (!/\bea\s*\./.test(script)) return "tidak memanggil EA API (ea.*)";
  return null;
}

/** Run `claude --print <prompt>` non-interactively, return the assistant's text. */
function runClaudeExec(prompt) {
  return new Promise((resolve, reject) => {
    // --print       non-interactive, output to stdout
    // --dangerously-skip-permissions  skip tool-use permission prompts (headless container)
    const args = ["--print", "--dangerously-skip-permissions"];
    if (MODEL) args.push("--model", MODEL);
    args.push(prompt);

    const child = spawn("claude", args, { env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("claude exec timeout"));
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 50_000) stderr = stderr.slice(-50_000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`tidak bisa menjalankan claude: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!stdout.trim()) {
        reject(new Error(
          `claude exit ${code}: ${stderr.slice(-400) || "tidak ada output (sudah login? jalankan: docker compose exec claude claude auth login)"}`,
        ));
        return;
      }
      resolve(stdout);
    });
  });
}

const claudeLoginStatus = () => {
  // `claude auth login` writes credentials to $HOME/.claude/
  const claudeDir = path.join(process.env.HOME || "/claude-home", ".claude");
  return access(claudeDir).then(
    () => ({ ok: true, detail: `config: ${claudeDir}` }),
    () => ({ ok: false, detail: "belum login — jalankan: docker compose exec claude claude auth login" }),
  );
};

async function handleChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendJson(res, e.message === "payload too large" ? 413 : 400, { error: e.message });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages.filter((m) => m?.role === "system").map((m) => m.content).join("\n\n");
  const user = messages.filter((m) => m?.role && m.role !== "system").map((m) => m.content).join("\n\n");
  const base =
    [system, user].filter(Boolean).join("\n\n---\n\n") +
    "\n\nOutput ONLY the runnable EA script (JavaScript). No prose, no markdown fences.";

  let prompt = base;
  let lastProblem = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let raw;
    try {
      raw = await runClaudeExec(prompt);
    } catch (e) {
      // CLI not found / not authenticated / runtime failure — surface clearly, don't retry.
      return sendJson(res, 503, { error: `claude backend: ${e.message}` });
    }
    const script = stripFences(raw);
    const problem = validateScript(script);
    if (!problem) {
      return sendJson(res, 200, {
        model: MODEL || "claude",
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
  const status = await claudeLoginStatus();
  sendJson(res, 200, {
    ok: true,
    backend: "claude",
    model: MODEL || "claude-default",
    auth: status.ok ? "logged-in" : "not-logged-in",
    detail: status.detail,
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/healthz") return void handleHealth(res);
  if (req.method === "GET" && url.pathname === "/api/tags") {
    return sendJson(res, 200, { models: [{ name: MODEL || "claude", model: MODEL || "claude" }] });
  }
  if (req.method === "POST" && url.pathname === "/api/chat") return void handleChat(req, res);
  return sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () =>
  console.log(`claude shim on :${PORT} (HOME=${process.env.HOME || "/claude-home"}, model=${MODEL || "default"})`),
);
