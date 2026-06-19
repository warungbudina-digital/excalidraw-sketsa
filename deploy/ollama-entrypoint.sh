#!/bin/sh
# Entrypoint for the ollama service: start the server, then (once) pull the base model and
# build the custom "excalidraw-ea" model from /Modelfile. Creating excalidraw-ea does NOT
# duplicate the base weights — Ollama layers share them — so the extra disk cost is tiny.
set -e

BASE_MODEL="${BASE_MODEL:-qwen2.5-coder:1.5b}"
CUSTOM_MODEL="${CUSTOM_MODEL:-excalidraw-ea}"

# Start the Ollama server in the background; keep its PID so we can hand control back to it.
ollama serve &
serve_pid=$!

# Wait until the server answers before talking to it.
echo "ollama-init: waiting for server..."
until ollama list >/dev/null 2>&1; do
  sleep 1
done

# Pull the base model (no-op if already in the mounted volume).
echo "ollama-init: ensuring base model ${BASE_MODEL}"
ollama pull "${BASE_MODEL}"

# Build the custom model from the Modelfile if it isn't already present.
if [ -f /Modelfile ]; then
  if ollama list | awk '{print $1}' | grep -q "^${CUSTOM_MODEL}:"; then
    echo "ollama-init: ${CUSTOM_MODEL} already exists, recreating to pick up Modelfile changes"
  fi
  echo "ollama-init: creating ${CUSTOM_MODEL} from /Modelfile"
  ollama create "${CUSTOM_MODEL}" -f /Modelfile || echo "ollama-init: WARNING create failed"
else
  echo "ollama-init: /Modelfile not mounted, skipping custom model"
fi

echo "ollama-init: ready (model in use: ${CUSTOM_MODEL})"
# Hand control back to the server process so the container stays up.
wait "${serve_pid}"
