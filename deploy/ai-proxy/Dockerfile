# syntax=docker/dockerfile:1
# Tiny Ollama-compatible -> OpenAI Responses API proxy. No build step, no dependencies
# (uses Node's built-in http + global fetch), so the runtime image is just node:alpine + one file.
FROM node:22-alpine AS runtime
WORKDIR /app

# Run as the image's built-in non-root user.
COPY server.js ./
USER node

ENV PORT=8080
EXPOSE 8080

# 127.0.0.1 (not localhost) — same IPv4 reasoning as the app image's healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server.js"]
