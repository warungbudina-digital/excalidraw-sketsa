# syntax=docker/dockerfile:1
# Antigravity CLI (agy) backend — mirrors deploy/claude/Dockerfile in structure.
# Runs `agy --print --dangerously-skip-permissions <prompt>` non-interactively.
# Auth ONCE: `docker compose exec agy agy` (follow the Google OAuth URL it prints)
FROM node:22-slim AS runtime

# ca-certificates: agy (Go binary) uses the system cert store for TLS to Google APIs.
# curl: needed to download the agy binary in the build step below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Install the agy binary via the official install script. During build, HOME=/root so
# the binary lands at /root/.local/bin/agy; move it to /usr/local/bin so it is always
# on PATH regardless of HOME at runtime.
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash \
    && mv /root/.local/bin/agy /usr/local/bin/agy \
    && rm -rf /root/.local /root/.bashrc /root/.profile

WORKDIR /work

# agy stores auth in $HOME/.config/antigravity/. Use HOME=/agy-home so a named volume
# mounted at /agy-home captures the credentials across restarts (same pattern as
# claude's HOME=/claude-home and codex's CODEX_HOME=/codex-home).
ENV HOME=/agy-home
RUN mkdir -p /agy-home /work && chown -R node:node /agy-home /work

COPY server.js ./
USER node

ENV PORT=8084
EXPOSE 8084

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8084/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
