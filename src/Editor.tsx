import { useCallback, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { serializeScene } from "./io/serialize";
import { parseScene } from "./io/parse";
import { ExcalidrawAutomate } from "./automate/ExcalidrawAutomate";
import { createDefaultUtils, runScript } from "./automate/scriptRunner";
import { generateScript, OLLAMA_MODEL } from "./ai/ollama";
import { COMPANY_NAME } from "./auth/auth";
import type { ExcalidrawApi } from "./types";
import "./App.css";

const STORAGE_KEY = "excalidraw-sketsa:scene";
const AUTOSAVE_MS = 800;

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
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [status, setStatus] = useState("");
  const [showScript, setShowScript] = useState(false);
  const [scriptCode, setScriptCode] = useState(SAMPLE_SCRIPT);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  const flash = useCallback((message: string) => {
    setStatus(message);
    window.setTimeout(() => setStatus(""), 3000);
  }, []);

  const serializeCurrent = useCallback((): string | null => {
    const api = apiRef.current;
    if (!api) {
      return null;
    }
    return serializeScene({
      elements: api.getSceneElements(),
      appState: api.getAppState(),
      files: api.getFiles(),
    });
  }, []);

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
    },
    [loadFromString],
  );

  const handleChange = useCallback(() => {
    if (autosaveTimer.current !== null) {
      window.clearTimeout(autosaveTimer.current);
    }
    autosaveTimer.current = window.setTimeout(() => {
      const data = serializeCurrent();
      if (data !== null) {
        localStorage.setItem(STORAGE_KEY, data);
      }
    }, AUTOSAVE_MS);
  }, [serializeCurrent]);

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
      const code = await generateScript(prompt);
      setScriptCode(code);
      flash("Script dibuat AI — tinjau lalu ► Jalankan");
    } catch (e) {
      flash(`AI gagal — ${(e as Error).message}`);
    } finally {
      setAiBusy(false);
    }
  }, [aiPrompt, aiBusy, flash]);

  return (
    <div className="app">
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
            <button onClick={doRunScript}>► Jalankan</button>
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
