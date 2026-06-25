# syntax=docker/dockerfile:1
# Claude Code CLI backend — mirrors the structure of deploy/codex/Dockerfile.
# Runs `claude --print <prompt>` non-interactively (parallel to `codex exec`).
# Auth ONCE: `docker compose exec claude claude auth login`
FROM node:22-slim AS runtime

# ca-certificates: the Claude Code CLI (Rust binary inside) needs the system cert store
# for TLS to claude.ai — same reason as deploy/codex/Dockerfile (api.openai.com).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI — provides the `claude` binary.
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

WORKDIR /work

# Claude Code stores auth + config in $HOME/.claude. Use HOME=/claude-home so the named
# volume (mounted at /claude-home) captures the credentials and survives restarts.
ENV HOME=/claude-home
RUN mkdir -p /claude-home /work && chown -R node:node /claude-home /work

COPY server.js ./
USER node

ENV PORT=8083
EXPOSE 8083

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8083/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
