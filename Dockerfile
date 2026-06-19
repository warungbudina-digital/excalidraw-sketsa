# syntax=docker/dockerfile:1

# ---- Stage 1: build the Vite app to static assets --------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install deps first so this layer is cached unless the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Which Ollama model the browser asks for. Baked into the bundle at build time via
# import.meta.env; defaults to the custom model created from the Modelfile.
ARG VITE_OLLAMA_MODEL=excalidraw-ea
ENV VITE_OLLAMA_MODEL=${VITE_OLLAMA_MODEL}

COPY . .
RUN npm run build

# ---- Stage 2: serve the static build with a tiny nginx ---------------------------------
# Final image carries no node_modules / node runtime — just nginx + the built assets.
FROM nginx:1.27-alpine AS runtime

# SPA config + /ollama reverse proxy. The nginx image runs envsubst over *.template at
# startup; NGINX_ENVSUBST_FILTER limits substitution to our OLLAMA_* vars so nginx's own
# $uri/$host/$1 are left intact.
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template

# The app container reaches Ollama over the compose network (service name "ollama"),
# never over the host's localhost. Override at run time if your Ollama lives elsewhere.
ENV OLLAMA_HOST=ollama:11434
ENV NGINX_ENVSUBST_FILTER=OLLAMA_

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
# nginx:alpine already provides the default CMD ["nginx", "-g", "daemon off;"].
