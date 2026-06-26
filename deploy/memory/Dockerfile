# syntax=docker/dockerfile:1
# memory backend — captures AI generation turns to Supabase. Mirrors deploy/collab.
# Zero-dep: uses Node 22's built-in global fetch (no node_modules).
FROM node:22-alpine AS runtime
WORKDIR /app

COPY server.js ./
USER node

ENV PORT=8085
EXPOSE 8085

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8085/healthz || exit 1

CMD ["node", "server.js"]
