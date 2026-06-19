/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Ollama model the browser asks for. Defaults to `qwen2.5-coder:1.5b`; the Docker build
   * sets it to the custom `excalidraw-ea` model (see Modelfile). Set in `.env` for dev.
   */
  readonly VITE_OLLAMA_MODEL?: string;
}
