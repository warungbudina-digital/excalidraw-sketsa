# syntax=docker/dockerfile:1
# Codex CLI ships a platform binary via its npm postinstall (glibc x64), so use the Debian
# slim Node image (not alpine/musl). Pinned for reproducible builds.
FROM node:22-slim AS runtime

# The Codex binary uses the SYSTEM cert store for HTTPS to api.openai.com. node:22-slim ships
# without it, so codex fails with "no CA certificates found" — install ca-certificates.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@0.142.0 && npm cache clean --force

WORKDIR /work

# Codex stores auth + config here. Mount a volume and run `codex login --device-auth` ONCE so
# the credential persists across container restarts (see docs/RUNBOOK.md / ADR 0001).
ENV CODEX_HOME=/codex-home
RUN mkdir -p /codex-home /work && chown -R node:node /codex-home /work

COPY server.js ./
USER node

ENV PORT=8082
EXPOSE 8082

# Node-based probe (no wget/curl on slim); 127.0.0.1 per the IPv4 healthcheck note.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8082/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
