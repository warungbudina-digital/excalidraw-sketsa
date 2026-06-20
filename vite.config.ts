import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

// Proxy browser calls to /ollama/* -> the local Ollama container on :11434.
// Same-origin from the browser's view, so there is no CORS issue and Ollama is never
// exposed publicly. e.g. POST /ollama/api/chat -> http://localhost:11434/api/chat
const ollamaProxy: Record<string, ProxyOptions> = {
  "/ollama": {
    target: "http://localhost:11434",
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/ollama/, ""),
    // Ollama (0.x) returns HTTP 403 for browser requests whose Origin isn't localhost —
    // e.g. the Cloud Shell `*.cloudshell.dev` origin. `changeOrigin` only rewrites Host,
    // not Origin, so strip Origin/Referer here; Ollama then treats the proxied call like a
    // non-browser client and allows it (no need to loosen OLLAMA_ORIGINS or expose Ollama).
    configure: (proxy) => {
      proxy.on("proxyReq", (proxyReq) => {
        proxyReq.removeHeader("origin");
        proxyReq.removeHeader("referer");
      });
    },
  },
};

const collaborationProxy: Record<string, ProxyOptions> = {
  "/collab": {
    target: "http://localhost:8081",
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/collab/, ""),
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
    proxy: { ...ollamaProxy, ...collaborationProxy },
  },
  preview: {
    host: true,
    port: 8080,
    proxy: { ...ollamaProxy, ...collaborationProxy },
  },
});
