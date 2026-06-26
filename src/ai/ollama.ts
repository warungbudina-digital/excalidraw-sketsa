/**
 * AI script generation — turns a natural-language prompt into an EA script.
 *
 * Calls the codex backend through the same-origin `/ollama` proxy (nginx/Vite),
 * so the browser never speaks directly to the AI backend. The system prompt
 * is an API "cheat sheet" for the EA workbench (see ExcalidrawAutomate.ts) plus
 * few-shot examples — this is the SINGLE SOURCE OF TRUTH for EA knowledge.
 */

/**
 * Which Ollama model to call. Defaults to the small base coder model; the Docker build
 * sets `VITE_OLLAMA_MODEL=excalidraw-ea` to use the custom model whose Modelfile bakes in
 * the deep Excalidraw knowledge below. Keep this prompt and the Modelfile SYSTEM in sync.
 */
export const OLLAMA_MODEL = import.meta.env.VITE_OLLAMA_MODEL?.trim() || "qwen2.5-coder:1.5b";

/** AI backend that the user has selected in the Script panel. */
export type AIBackend = "codex" | "claude" | "agy";

const BACKEND_ENDPOINTS: Record<AIBackend, string> = {
  codex: "/ollama/api/chat",
  claude: "/claude/api/chat",
  agy: "/agy/api/chat",
};

const SYSTEM_PROMPT = `You write scripts for "Excalidraw Sketsa", a drawing app.
The script body runs as an async function with two injected objects: \`ea\` and \`utils\`.
Output ONLY runnable JavaScript. No explanations.

EA API:
ea.setStyle({ strokeColor, backgroundColor, fillStyle, strokeWidth, strokeStyle, roughness, opacity, fontSize, fontFamily, textAlign })
ea.addRect(x, y, width, height, label?) -> id     // label? = text auto-centered & BOUND inside the box
ea.addEllipse(x, y, width, height, label?) -> id  // same: pass a label instead of a separate addText
ea.addDiamond(x, y, width, height, label?) -> id
ea.addText(x, y, text) -> id                        // standalone text only (NOT inside a shape)
ea.addLine(points) -> id     // points: [[x,y], ...]
ea.addArrow(points) -> id    // points: [[x,y], ...] — raw, NOT attached to shapes
ea.connect(fromId, toId, label?) -> id  // arrow BOUND to two shapes (ids from add* above); it
                                        // follows them when moved. No coordinate math needed.
ea.addToGroup(ids) -> groupId
ea.addFrame(name, childIds) -> frameId   // wraps childIds in a named frame, auto-sized
await ea.addMermaid(definition) -> ids[]  // render a Mermaid diagram (auto layout). PREFER
  // this for SIMPLE flowcharts/diagrams. WARNING: a flowchart that is too complex — deeply
  // nested subgraphs or <br>/HTML in labels — FAILS to convert and falls back to ONE flat
  // image: not editable, and "Scene → Code" can only dump it as an opaque payload. Keep
  // flowcharts simple, or build big/complex ones from primitives so they stay editable shapes.
ea.addRawElements(elements, files?) -> ids[]  // insert raw Excalidraw elements verbatim. "Scene →
  // Code" emits this for shapes it can't rebuild (image/freedraw). KEEP such blocks intact when editing.
await ea.clearView()  // wipe the canvas. "Scene → Code" puts this first so re-running REPLACES the scene
await ea.loadSceneCode(payload, { mode:"replace"|"insert", offsetX?, offsetY?, verifyChecksum? })
  // load an opaque payload (advanced); NEVER invent this payload
ea.getViewElements() -> elements[]
ea.getViewSelectedElements() -> elements[]   // elements have id, type, x, y, width, height, strokeColor, fontSize, text
ea.copyViewElementsToEAforEditing(elements)  // required before mutating existing scene elements
await ea.addElementsToView()                 // renders the workbench to the canvas

utils.inputPrompt(header, placeholder?, value?) -> Promise<string|null>
utils.suggester(displayItems, items) -> Promise<any>

Excalidraw model (what the elements ARE):
- A scene is { type:"excalidraw", version, source, elements:[], appState:{}, files:{} }.
- Every element has: id, type, x, y, width, height, angle, strokeColor, backgroundColor,
  fillStyle("hachure"|"cross-hatch"|"solid"), strokeWidth, strokeStyle("solid"|"dashed"|"dotted"),
  roughness(0-2), opacity(0-100), groupIds[], frameId(string|null), seed, boundElements, isDeleted.
- type is "rectangle"|"ellipse"|"diamond"|"text"|"line"|"arrow"|"frame"|"image"|"freedraw".
- text adds: text, fontSize, fontFamily(1=hand,2=normal,3=code), textAlign, verticalAlign, containerId.
- line/arrow add: points (relative to x,y), startBinding/endBinding, startArrowhead/endArrowhead.
- frame is a container: child elements set frameId = the frame's id. The colors above don't
  apply to it — give it a name. ea.addFrame handles ids, sizing and ordering for you.

Mermaid (ea.addMermaid) — auto-layout; PREFER for any diagram that fits:
- flowchart TD/LR → editable shapes + bound arrows; subgraph → frame. UTAMA.
- stateDiagram-v2 → state nodes + transition arrows (editable shapes).
- erDiagram → entity boxes + relationship lines (editable shapes).
- mindmap → tree hierarchy, each node is a shape (editable shapes).
- block-beta → block diagram with nested containers (editable shapes).
- architecture-beta → services in group boundaries + labeled arrows (editable shapes).
- gantt / pie / journey / gitgraph / sankey / timeline / sequence / xychart →
  static IMAGE. For these, use the EA manual patterns below instead.
- Flowchart syntax: first line "flowchart TD" (top-down) or "flowchart LR" (left-right).
  Nodes: A[Rect]  B(Rounded)  C{Diamond/decision}  D((Circle))  E([Stadium]).
  Edges: A --> B (arrow), A --- B (line), A -.-> B (dotted), A ==> B (thick),
         A -->|label| B (labelled). A node id is reused to connect it again.
  Group: "subgraph Title ... end" becomes a frame around those nodes — MAX 1 level deep.
  KEEP IT CONVERTIBLE (else it silently becomes one flat image): node labels SHORT & single-
  line — NO <br>, NO HTML tags; do NOT nest a subgraph inside another subgraph. If the diagram
  needs more than ~15 nodes or nested groups, do NOT use Mermaid — build it from EA primitives
  (addRect/connect/addFrame) so it stays editable shapes that Scene → Code can decompile.

EA manual patterns — build these with primitives when Mermaid gives a static image:

Kanban board (frame per column, rect per card):
ea.setStyle({ backgroundColor: "#d0ebff", strokeColor: "#1971c2", fillStyle: "solid" });
const t1 = ea.addRect(60, 90, 160, 55, "Task A");
const t2 = ea.addRect(60, 155, 160, 55, "Task B");
ea.addFrame("To Do", [t1, t2]);
// repeat for In Progress, Done with different colors/x positions

C4 / Arsitektur layered (frame boundary + shape per node + connect arrow):
const user = ea.addEllipse(80, 160, 100, 80, "User");
const app  = ea.addRect(260, 155, 180, 100, "Aplikasi\n[Web]");
const ext  = ea.addRect(520, 155, 160, 100, "Payment\n[Ext]");
ea.connect(user, app, "menggunakan"); ea.connect(app, ext, "API");
ea.addFrame("System Boundary", [app]);

Quadrant matrix (addLine axes + addText labels + addEllipse per point):
ea.addLine([[250,450],[250,50]]); ea.addLine([[50,250],[550,250]]);
ea.addText(260,40,"High Impact"); ea.addText(260,455,"Low Impact");
ea.addText(50,255,"Low Effort"); ea.addText(450,255,"High Effort");
ea.setStyle({ backgroundColor: "#a9e34b", fillStyle: "solid" });
ea.addEllipse(120, 80, 70, 40, "Fitur A");

Timeline horizontal (rect per milestone + connect arrows):
ea.setStyle({ backgroundColor: "#dbe4ff", strokeColor: "#3b5bdb", fillStyle: "solid" });
const m1 = ea.addRect(50, 200, 130, 60, "Fase 1\nJan");
ea.setStyle({ backgroundColor: "#d3f9d8", strokeColor: "#2f9e44", fillStyle: "solid" });
const m2 = ea.addRect(230, 200, 130, 60, "Fase 2\nFeb-Mar");
ea.connect(m1, m2); ea.addFrame("Timeline", [m1, m2]);

Gantt chart (rows of rects per task, stacked vertically):
ea.setStyle({ backgroundColor: "#fff3bf", strokeColor: "#e67700", fillStyle: "solid" });
ea.addRect(150, 50, 200, 45, "Analisis (W1)");
ea.setStyle({ backgroundColor: "#d0ebff", strokeColor: "#1971c2", fillStyle: "solid" });
ea.addRect(150, 105, 350, 45, "Desain (W1-W2)");

Rules:
- For SIMPLE flowcharts/diagrams, PREFER: await ea.addMermaid(\`flowchart TD ...\`); it auto-lays
  out nodes and arrows. Keep labels short & single-line (NO <br>) and subgraphs ≤1 level deep —
  a too-complex flowchart silently becomes ONE flat image (not editable, can't be decompiled by
  Scene → Code). For LARGE/complex diagrams (>~15 nodes, nested groups, or full architecture),
  build from EA primitives (addRect/connect/addFrame + addFrame for boundaries) INSTEAD of
  Mermaid. Use EA manual patterns also when Mermaid gives a static image.
- When hand-placing, put text inside a shape via its label arg — ea.addRect(x,y,w,h,"Mulai") —
  NOT a separate addText; the label is centered and moves with the box.
- Connect shapes with ea.connect(a, b) — NOT ea.addArrow with manual points; the arrow binds to
  both shapes and stays attached. Use addArrow(points) only for free-floating lines.
- EDITING: when the user message contains a "SCRIPT EA SAAT INI" block, MODIFY that script to
  satisfy the request and return the COMPLETE updated script (keep its structure, and keep any
  ea.clearView()/ea.addRawElements(...) lines unless asked otherwise). Add the user's idea —
  goresan/garis baru, pewarnaan via ea.setStyle, atau menggabungkan dua gambar — into it.
- ALWAYS finish with: await ea.addElementsToView();
- Call ea.setStyle(...) before creating shapes to set colors.
- Coordinates are pixels; lay elements out so they don't overlap.
- To edit selected elements, first ea.copyViewElementsToEAforEditing(selected), then mutate.
- To group visually inside a labelled box, prefer ea.addFrame(name, [ids]) over addToGroup.
- Pass real shape ids to addFrame: const a = ea.addRect(...); ea.addFrame("Grup", [a]);

Example — flowchart via Mermaid (PREFERRED), then commit:
await ea.addMermaid(\`flowchart TD
  A[Mulai] --> B{Valid?}
  B -->|ya| C[Proses]
  B -->|tidak| D[Tolak]
  C --> E[Selesai]\`);
await ea.addElementsToView();

Example — same flowchart drawn by hand (only if Mermaid can't express it), wrapped in a frame.
Labels go straight into the shapes and ea.connect makes the arrows bind:
ea.setStyle({ strokeColor: "#1971c2", backgroundColor: "#a5d8ff" });
const a = ea.addRect(100, 100, 160, 60, "Mulai");
const b = ea.addRect(100, 260, 160, 60, "Proses");
const c = ea.addRect(100, 420, 160, 60, "Selesai");
ea.connect(a, b);
ea.connect(b, c);
ea.addFrame("Alur Proses", [a, b, c]);
await ea.addElementsToView();`;

// ---------------------------------------------------------------------------
// Prompt presets — keyword-triggered templates shown as chips in the UI.
// Clicking a chip pre-fills the AI input so the user can send or tweak it.
// ---------------------------------------------------------------------------

export interface PromptPreset {
  label: string;
  prompt: string;
}

export const PROMPT_PRESETS: PromptPreset[] = [
  {
    label: "Flowchart",
    prompt:
      "Buat flowchart proses checkout: Pilih produk → Tambah ke keranjang → Pembayaran, jika berhasil → Konfirmasi pesanan, jika gagal → Ulangi pembayaran",
  },
  {
    label: "State Diagram",
    prompt:
      "Buat state diagram status pesanan online: Dibuat → Dibayar → Diproses → Dikirim → Selesai. Bisa Dibatalkan dari status Dibuat atau Dibayar",
  },
  {
    label: "ER Diagram",
    prompt:
      "Buat ER diagram toko online: Customer (id, nama, email) punya banyak Order (id, tanggal, total), satu Order berisi banyak Product (id, nama, harga, stok)",
  },
  {
    label: "Mind Map",
    prompt:
      "Buat mind map Pengembangan Web: cabang Frontend (HTML, CSS, React), Backend (Node.js, REST API, Database), DevOps (Docker, CI/CD, Cloud). Tiap cabang punya 3 sub-topik",
  },
  {
    label: "Arsitektur",
    prompt:
      "Buat diagram arsitektur jaringan: Internet → Cloudflare CDN → Load Balancer → 2 Web Server → PostgreSQL Database. Tambahkan Redis Cache antara server dan database",
  },
  {
    label: "Kanban",
    prompt:
      "Buat kanban board 3 kolom: To Do (5 task), In Progress (2 task), Done (3 task). Gunakan warna berbeda per kolom dan bungkus tiap kolom dalam frame berlabel",
  },
  {
    label: "C4 Context",
    prompt:
      "Buat C4 context diagram: User menggunakan Aplikasi Web, Aplikasi memanggil Codex AI untuk generate script dan Cloudflare Tunnel untuk akses publik. Beri frame System Boundary",
  },
  {
    label: "Kuadran",
    prompt:
      "Buat quadrant matrix prioritas: sumbu X=Effort (Low→High), Y=Impact (Low→High). Plot 5 fitur: Login SSO, Dashboard Analytics, Export PDF, Dark Mode, Mobile App",
  },
  {
    label: "Timeline",
    prompt:
      "Buat timeline horizontal proyek 6 bulan: Riset & Analisis (Jan), Desain UI (Feb-Mar), Pengembangan (Apr-Mei), Launch & Monitoring (Jun). Warna berbeda per fase, bungkus dalam frame",
  },
  {
    label: "Gantt",
    prompt:
      "Buat gantt chart 4 minggu: Analisis Kebutuhan (W1), Desain UI/UX (W1-W2), Backend (W2-W3), Frontend (W2-W3), Testing (W3-W4), Deploy (W4). Bar warna berbeda per task",
  },
];

/** Remove a surrounding markdown code fence if the model added one. */
function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:javascript|js|typescript|ts)?\s*\n([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

export interface GenerateOptions {
  signal?: AbortSignal;
  /**
   * The script currently in the editor (e.g. a Scene → Code decompilation). When present, the
   * model is asked to EDIT/extend it rather than start from scratch. It is sent inside the USER
   * message — NOT a system message — because a request `system` message REPLACES the custom
   * model's baked-in Modelfile SYSTEM (see .nudge/learned/testing-excalidraw-ea-...).
   */
  currentScript?: string;
  /** Which AI backend to use. Defaults to "codex". */
  backend?: AIBackend;
}

/** Generate an EA script from a natural-language prompt. Throws on transport/model error. */
export async function generateScript(
  prompt: string,
  opts: GenerateOptions = {},
): Promise<string> {
  const endpoint = BACKEND_ENDPOINTS[opts.backend ?? "codex"];
  const context = opts.currentScript?.trim();
  const userContent = context
    ? `${prompt}\n\n--- SCRIPT EA SAAT INI (ubah sesuai permintaan di atas, lalu kembalikan SELURUH script lengkap yang bisa dijalankan) ---\n${context}`
    : prompt;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        stream: false,
        options: { temperature: 0.2 },
      }),
      signal: opts.signal,
    });
  } catch (e) {
    throw new Error(
      `Tidak bisa menghubungi Ollama (apakah container berjalan di :11434?) — ${(e as Error).message}`,
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Ollama HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content ?? "";
  if (!content.trim()) {
    throw new Error("Respons Ollama kosong");
  }
  const script = stripCodeFences(content);
  captureMemory(opts.backend ?? "codex", userContent, script);
  return script;
}

/**
 * Best-effort persistence of a generation turn to the memory backend (Supabase-backed).
 * Fire-and-forget: never awaited, errors swallowed — capture must not block or break
 * generation. The Supabase service key stays server-side in the memory container; the
 * browser only ever calls the same-origin /memory/ proxy (no secret in the bundle).
 */
function captureMemory(backend: AIBackend, prompt: string, response: string): void {
  try {
    void fetch("/memory/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend, model: OLLAMA_MODEL, prompt, response, meta: { valid: true } }),
    }).catch(() => {});
  } catch {
    /* capture is optional — ignore */
  }
}
