import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy browser calls to /ollama/* -> the local Ollama container on :11434.
// Same-origin from the browser's view, so there is no CORS issue and Ollama is never
// exposed publicly. e.g. POST /ollama/api/chat -> http://localhost:11434/api/chat
const ollamaProxy = {
  "/ollama": {
    target: "http://localhost:11434",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/ollama/, ""),
  },
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // Excalidraw checks this at build time; required for non-Preact bundlers.
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  server: {
    // Port 8080 + host:true so Google Cloud Shell "Web Preview" works out of the box.
    host: true,
    port: 8080,
    proxy: ollamaProxy,
  },
  preview: {
    host: true,
    port: 8080,
    proxy: ollamaProxy,
  },
});
