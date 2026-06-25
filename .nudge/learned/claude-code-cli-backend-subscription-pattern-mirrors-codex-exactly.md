# Claude Code CLI backend: subscription pattern mirrors codex exactly

## What went wrong
First attempt wired the claude backend using direct Anthropic API calls (fetch +
ANTHROPIC_API_KEY). The repo invariant requires CLI-subscription backends (codex uses
`codex exec` + ChatGPT subscription), not API-key HTTP calls. The Nudge
`ai-backend-reminder` rule flagged this on the second attempt.

## Fix
Rewrite deploy/claude/ to mirror deploy/codex/ exactly:

- Dockerfile: `node:22-slim` + `ca-certificates` (same TLS reason as codex — the CLI
  binary uses the system cert store)
- Install CLI: `npm install -g @anthropic-ai/claude-code` (provides `claude` binary)
- Run headless: `spawn("claude", ["--print", "--dangerously-skip-permissions", prompt])`
  stdout = generated text (no output file needed, unlike codex's `-o <file>`)
- Auth once: `docker compose exec claude claude auth login` (browser OAuth flow)
- Creds location: `$HOME/.claude/` — set `ENV HOME=/claude-home` in Dockerfile so the
  named volume captures it. MUST be a NAMED volume (not host-bind): host-bind is
  root-owned, the `node` user cannot write to it (`claude auth login` fails silently)
- Auth health check: `access($HOME/.claude/)` — dir present = logged in
- Without login: spawn exits non-zero with no stdout → shim returns 503 (same as codex)
- Validation gate: identical to codex (AsyncFunction parse + `/\bea\s*\./` check)
- nginx route: `/claude/*` → `claude:8083` (mirror of `/ollama/*` → `codex:8082`)
- Model override: `CLAUDE_MODEL` env (empty = CLI default for the subscription)
- Prompt assembly: join system + user with `\n\n---\n\n` then pass as positional arg to
  `--print` (same structure codex uses for stdin)

## Verification

```sh
docker compose up -d --build
docker compose exec claude claude auth login
# Check health:
curl http://localhost:8080/claude/healthz
# -> {"ok":true,"backend":"claude","auth":"logged-in",...}
# Use Claude in UI: Script panel -> [Claude] button -> prompt -> Generate
```
