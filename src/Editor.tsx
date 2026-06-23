import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { curateAppState, serializeScene } from "./io/serialize";
import { parseScene } from "./io/parse";
import { ExcalidrawAutomate } from "./automate/ExcalidrawAutomate";
import { createDefaultUtils, runScript } from "./automate/scriptRunner";
import { generateScript, OLLAMA_MODEL } from "./ai/ollama";
import { COMPANY_NAME } from "./auth/auth";
import { sceneToEAScript } from "./scene-code/decompile";
import {
  CollaborationClient,
  createRoomId,
  getRoomFromUrl,
  setRoomInUrl,
  type Collaborator,
  type CollaborationStatus,
} from "./collab/client";
import type { ExcalidrawApi, SerializableScene } from "./types";
import "./App.css";

const STORAGE_KEY = "excalidraw-sketsa:scene";
const AUTOSAVE_MS = 2000;

interface AutosaveResponse {
  id: number;
  data?: string;
  error?: string;
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

// WebKit (Safari) ships the Fullscreen API only under vendor prefixes; the standard
// DOM lib doesn't type them, so widen here instead of casting to `any`.
type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

// iPhone Safari exposes no element-level Fullscreen API (only <video>), so hide the
// control there rather than offering a button that silently does nothing.
const FULLSCREEN_SUPPORTED =
  typeof document !== "undefined" &&
  (document.fullscreenEnabled || "webkitFullscreenEnabled" in document);

const SAMPLE_SCRIPT = `// EA script — 'ea' dan 'utils' sudah tersedia.
// Select beberapa text element lalu jalankan untuk menambah "bullet" + grup.
// Jika tidak ada teks terpilih, script ini menggambar contoh.

const selected = ea.getViewSelectedElements().filter((el) => el.type === "text");

if (selected.length > 0) {
  ea.copyViewElementsToEAforEditing(selected);
  for (const el of selected) {
    ea.setStyle({ strokeColor: el.strokeColor });
    const size = el.fontSize / 2;
    const dot = ea.addEllipse(el.x - 10 - size, el.y + size / 2, size, size);
    ea.addToGroup([el.id, dot]);
  }
} else {
  ea.setStyle({ strokeColor: "#1971c2", backgroundColor: "#a5d8ff" });
  const box = ea.addRect(120, 120, 180, 90);
  ea.setStyle({ strokeColor: "#1e1e1e" });
  const label = ea.addText(140, 150, "Halo dari script!");
  ea.addToGroup([box, label]);
  ea.setStyle({ strokeColor: "#e8590c", backgroundColor: "#ffd8a8" });
  const ball = ea.addEllipse(360, 130, 110, 110);
  // Bungkus semua dalam satu frame bernama (lihat Excalidraw "frames").
  ea.addFrame("Contoh", [box, label, ball]);
}

await ea.addElementsToView();
`;

export default function Editor({ onLogout }: { onLogout: () => void }) {
  const apiRef = useRef<ExcalidrawApi | null>(null);
  const autosaveTimer = useRef<number | null>(null);
  const autosaveIdleTask = useRef<number | null>(null);
  const autosaveWorker = useRef<Worker | null>(null);
  const autosaveVersion = useRef(0);
  const collaborationClient = useRef<CollaborationClient | null>(null);
  const suppressCollaborationUntil = useRef(0);
  const clientId = useRef(crypto.randomUUID().replace(/-/g, ""));
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const appRef = useRef<HTMLDivElement | null>(null);

  const [status, setStatus] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoomLocked, setZoomLocked] = useState(false);
  const [showScript, setShowScript] = useState(false);
  const [scriptCode, setScriptCode] = useState(SAMPLE_SCRIPT);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [sceneCodeBusy, setSceneCodeBusy] = useState(false);
  const [apiReady, setApiReady] = useState(false);
  const [collaborationRoom, setCollaborationRoom] = useState(getRoomFromUrl);
  const [collaborationStatus, setCollaborationStatus] =
    useState<CollaborationStatus>("offline");
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);

  const flash = useCallback((message: string) => {
    setStatus(message);
    window.setTimeout(() => setStatus(""), 3000);
  }, []);

  // Toggle native fullscreen on the whole app shell (toolbar + canvas + script panel),
  // so the canvas can fill the device screen for an immersive drawing mode.
  const toggleFullscreen = useCallback(async () => {
    const doc = document as FullscreenDocument;
    const el = appRef.current as FullscreenElement | null;
    if (!el) return;
    try {
      const active = document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
      if (!active) {
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
        else throw new Error("Fullscreen API tidak tersedia di perangkat ini");
      } else {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
      }
    } catch (e) {
      flash(`Layar penuh gagal — ${(e as Error).message}`);
    }
  }, [flash]);

  // Keep the button label in sync even when the user leaves fullscreen via Esc / OS gesture.
  useEffect(() => {
    const doc = document as FullscreenDocument;
    const sync = () =>
      setIsFullscreen(Boolean(document.fullscreenElement ?? doc.webkitFullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  // Optional page-zoom lock for touch devices: while on, pinch zooms the Excalidraw canvas
  // instead of the page. Scoped to the viewport meta and fully restored when turned off /
  // on unmount, so accessibility (page zoom) is preserved by default.
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const original = meta.content;
    if (zoomLocked) {
      meta.content = `${original}, maximum-scale=1, user-scalable=no`;
    }
    return () => {
      meta.content = original;
    };
  }, [zoomLocked]);

  useEffect(() => {
    const worker = new Worker(new URL("./workers/autosave.worker.ts", import.meta.url), {
      type: "module",
      name: "scene-autosave",
    });
    autosaveWorker.current = worker;

    worker.onmessage = (event: MessageEvent<AutosaveResponse>) => {
      const { id, data, error } = event.data;
      if (id !== autosaveVersion.current) {
        return;
      }
      if (error || data === undefined) {
        console.error("Autosave serialization failed:", error ?? "empty worker response");
        return;
      }

      const idleWindow = window as IdleWindow;
      const write = () => {
        autosaveIdleTask.current = null;
        if (id !== autosaveVersion.current) {
          return;
        }
        try {
          localStorage.setItem(STORAGE_KEY, data);
        } catch (writeError) {
          console.error("Autosave localStorage write failed:", writeError);
        }
      };

      autosaveIdleTask.current = idleWindow.requestIdleCallback
        ? idleWindow.requestIdleCallback(write, { timeout: 1000 })
        : window.setTimeout(write, 0);
    };

    return () => {
      if (autosaveTimer.current !== null) {
        window.clearTimeout(autosaveTimer.current);
      }
      if (autosaveIdleTask.current !== null) {
        const idleWindow = window as IdleWindow;
        if (idleWindow.cancelIdleCallback) {
          idleWindow.cancelIdleCallback(autosaveIdleTask.current);
        } else {
          window.clearTimeout(autosaveIdleTask.current);
        }
      }
      worker.terminate();
      autosaveWorker.current = null;
    };
  }, []);

  const currentScene = useCallback((includeDeleted = false): SerializableScene | null => {
    const api = apiRef.current;
    if (!api) {
      return null;
    }
    return {
      elements:
        includeDeleted && api.getSceneElementsIncludingDeleted
          ? api.getSceneElementsIncludingDeleted()
          : api.getSceneElements(),
      appState: curateAppState(api.getAppState()),
      files: api.getFiles(),
    };
  }, []);

  const currentCollaborationScene = useCallback((): SerializableScene | null => {
    const scene = currentScene(true);
    if (!scene) return null;
    return {
      ...scene,
      // Viewport, zoom, selection, and current tool remain local to each collaborator.
      appState: { viewBackgroundColor: scene.appState.viewBackgroundColor },
    };
  }, [currentScene]);

  const serializeCurrent = useCallback((): string | null => {
    const scene = currentScene();
    return scene ? serializeScene(scene) : null;
  }, [currentScene]);

  const save = useCallback(() => {
    const data = serializeCurrent();
    if (data === null) {
      return;
    }
    localStorage.setItem(STORAGE_KEY, data);
    flash("Tersimpan ke localStorage");
  }, [serializeCurrent, flash]);

  const loadFromString = useCallback(
    (data: string, label: string) => {
      const api = apiRef.current;
      if (!api) {
        return;
      }
      try {
        const scene = parseScene(data);
        api.updateScene({ elements: scene.elements, appState: scene.appState });
        if (api.addFiles) {
          const files = Object.entries(scene.files).map(([id, f]) => ({
            id,
            ...(f as object),
          }));
          if (files.length > 0) {
            api.addFiles(files);
          }
        }
        flash(`${label}: ${scene.elements.length} elemen`);
      } catch (e) {
        flash(`Gagal memuat — ${(e as Error).message}`);
      }
    },
    [flash],
  );

  const handleApi = useCallback(
    (api: ExcalidrawApi) => {
      apiRef.current = api;
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        loadFromString(stored, "Dipulihkan");
      }
      setApiReady(true);
    },
    [loadFromString],
  );

  useEffect(() => {
    if (!collaborationRoom || !apiReady) return;
    const nameKey = "excalidraw-sketsa:collab-name";
    const savedName = localStorage.getItem(nameKey);
    const name = savedName || `Pengguna-${clientId.current.slice(0, 4)}`;
    if (!savedName) localStorage.setItem(nameKey, name);

    const client = new CollaborationClient(collaborationRoom, clientId.current, name, {
      onStatus: setCollaborationStatus,
      onPresence: setCollaborators,
      onEmptyRoom: () => {
        const scene = currentCollaborationScene();
        if (scene) client.publish(scene, true);
      },
      onScene: (scene) => {
        const api = apiRef.current;
        if (!api) return;
        suppressCollaborationUntil.current = performance.now() + 500;
        const files = Object.entries(scene.files).map(([id, file]) => ({
          id,
          ...(file as object),
        }));
        if (files.length > 0) api.addFiles?.(files);
        api.updateScene({ elements: scene.elements, appState: scene.appState });
      },
      onError: (message) => flash(message),
    });
    collaborationClient.current = client;
    client.connect();

    return () => {
      client.stop();
      if (collaborationClient.current === client) collaborationClient.current = null;
    };
  }, [apiReady, collaborationRoom, currentCollaborationScene, flash]);

  const handleChange = useCallback(() => {
    const id = autosaveVersion.current + 1;
    autosaveVersion.current = id;
    if (autosaveTimer.current !== null) {
      window.clearTimeout(autosaveTimer.current);
    }
    autosaveTimer.current = window.setTimeout(() => {
      autosaveTimer.current = null;
      const scene = currentScene();
      if (scene && autosaveWorker.current) {
        autosaveWorker.current.postMessage({ id, scene });
      }
    }, AUTOSAVE_MS);

    if (performance.now() >= suppressCollaborationUntil.current) {
      const scene = currentCollaborationScene();
      if (scene) collaborationClient.current?.publish(scene);
    }
  }, [currentCollaborationScene, currentScene]);

  const startCollaboration = useCallback(() => {
    const nameKey = "excalidraw-sketsa:collab-name";
    const currentName = localStorage.getItem(nameKey) || `Pengguna-${clientId.current.slice(0, 4)}`;
    const name = window.prompt("Nama yang terlihat oleh kolaborator:", currentName)?.trim();
    if (!name) return;
    localStorage.setItem(nameKey, name.slice(0, 48));
    const room = createRoomId();
    setRoomInUrl(room);
    setCollaborationRoom(room);
  }, []);

  const leaveCollaboration = useCallback(() => {
    collaborationClient.current?.stop();
    setRoomInUrl("");
    setCollaborationRoom("");
    setCollaborationStatus("offline");
    setCollaborators([]);
    flash("Kolaborasi dihentikan");
  }, [flash]);

  const copyCollaborationLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      flash("Link kolaborasi disalin");
    } catch {
      window.prompt("Salin link kolaborasi ini:", window.location.href);
    }
  }, [flash]);

  const exportFile = useCallback(() => {
    const data = serializeCurrent();
    if (data === null) {
      return;
    }
    const blob = new Blob([data], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "drawing.excalidraw.md";
    a.click();
    URL.revokeObjectURL(url);
    flash("Diekspor sebagai drawing.excalidraw.md");
  }, [serializeCurrent, flash]);

  const importFile = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }
      const reader = new FileReader();
      reader.onload = () => loadFromString(String(reader.result), "Diimpor");
      reader.readAsText(file);
      event.target.value = "";
    },
    [loadFromString],
  );

  const doRunScript = useCallback(async () => {
    const api = apiRef.current;
    if (!api) {
      return;
    }
    const ea = new ExcalidrawAutomate(api);
    try {
      await runScript(scriptCode, ea, createDefaultUtils());
      save();
      flash("Script selesai");
    } catch (e) {
      flash(`Script error — ${(e as Error).message}`);
    }
  }, [scriptCode, save, flash]);

  const doGenerate = useCallback(async () => {
    const prompt = aiPrompt.trim();
    if (!prompt || aiBusy) {
      return;
    }
    setAiBusy(true);
    flash(`Menghubungi ${OLLAMA_MODEL}…`);
    try {
      // Pass the current editor script as context so the AI can EDIT/extend an existing scene
      // (e.g. a Scene → Code decompilation), not just generate from scratch.
      const code = await generateScript(prompt, { currentScript: scriptCode });
      setScriptCode(code);
      flash("Script dibuat AI — tinjau lalu ► Jalankan");
    } catch (e) {
      flash(`AI gagal — ${(e as Error).message}`);
    } finally {
      setAiBusy(false);
    }
  }, [aiPrompt, aiBusy, scriptCode, flash]);

  const generateCurrentSceneCode = useCallback(() => {
    if (sceneCodeBusy) return;
    const scene = currentScene();
    if (!scene) return;
    setSceneCodeBusy(true);
    try {
      // Decompile the live scene to a READABLE EA script (not an opaque payload), so the user
      // — or the AI via ✨ Generate — can edit it, then ► Jalankan to render the result.
      const code = sceneToEAScript(scene);
      setScriptCode(code);
      setShowScript(true);
      flash("Scene → EA script dibuat — edit / minta AI, lalu ► Jalankan");
    } catch (error) {
      flash(`Scene → Code gagal — ${(error as Error).message}`);
    } finally {
      setSceneCodeBusy(false);
    }
  }, [currentScene, flash, sceneCodeBusy]);

  return (
    <div className="app" ref={appRef}>
      <header className="toolbar">
        <span className="brand">{COMPANY_NAME}</span>
        <button onClick={save}>Simpan</button>
        <button
          onClick={() => {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
              loadFromString(stored, "Dimuat");
            } else {
              flash("Belum ada data tersimpan");
            }
          }}
        >
          Muat
        </button>
        <button onClick={exportFile}>Ekspor .md</button>
        <button onClick={() => fileInputRef.current?.click()}>Impor .md</button>
        <button onClick={() => setShowScript((v) => !v)}>
          {showScript ? "Tutup Script" : "Script"}
        </button>
        {FULLSCREEN_SUPPORTED && (
          <button
            onClick={() => void toggleFullscreen()}
            title="Tampilkan kanvas memenuhi layar (mode menggambar)"
          >
            {isFullscreen ? "⛶ Keluar Layar Penuh" : "⛶ Layar Penuh"}
          </button>
        )}
        <button
          onClick={() => setZoomLocked((v) => !v)}
          title="Kunci zoom halaman di perangkat sentuh — pinch hanya men-zoom kanvas, bukan halaman"
        >
          {zoomLocked ? "🔓 Buka Zoom" : "🔒 Kunci Zoom"}
        </button>
        {collaborationRoom ? (
          <span className="collaboration-controls" title={collaborators.map((user) => user.name).join(", ")}>
            <span className={`collaboration-state ${collaborationStatus}`} aria-hidden />
            <span>{collaborators.length} online</span>
            <button onClick={() => void copyCollaborationLink()}>Salin Link</button>
            <button className="collaboration-leave" onClick={leaveCollaboration}>Keluar Room</button>
          </span>
        ) : (
          <button className="collaboration-start" onClick={startCollaboration}>Kolaborasi</button>
        )}
        <span className="status">{status}</span>
        <button className="logout" onClick={onLogout}>
          Keluar
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.json,text/markdown"
          style={{ display: "none" }}
          onChange={importFile}
        />
      </header>

      <div className="canvas">
        <Excalidraw
          excalidrawAPI={(api) => handleApi(api as unknown as ExcalidrawApi)}
          onChange={handleChange}
        />
      </div>

      {showScript && (
        <div className="script-panel">
          <div className="script-panel-head">
            <strong>Script (Excalidraw Automate)</strong>
            <span className="script-panel-actions">
              <button
                className="scene-code-btn"
                onClick={() => void generateCurrentSceneCode()}
                disabled={sceneCodeBusy}
              >
                {sceneCodeBusy ? "Membuat…" : "Scene → Code"}
              </button>
              <button onClick={doRunScript}>► Jalankan</button>
            </span>
          </div>
          <div className="ai-row">
            <input
              className="ai-input"
              placeholder={`Minta ${OLLAMA_MODEL} membuat script… (mis. "flowchart 3 kotak")`}
              value={aiPrompt}
              disabled={aiBusy}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void doGenerate();
                }
              }}
            />
            <button className="ai-btn" onClick={doGenerate} disabled={aiBusy}>
              {aiBusy ? "…" : "✨ Generate"}
            </button>
          </div>
          <textarea
            value={scriptCode}
            spellCheck={false}
            onChange={(e) => setScriptCode(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
