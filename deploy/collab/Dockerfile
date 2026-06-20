# syntax=docker/dockerfile:1
FROM node:22-alpine AS runtime
WORKDIR /app

COPY server.js ./
USER node

ENV PORT=8081
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8081/healthz || exit 1

CMD ["node", "server.js"]
