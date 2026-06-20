/**
 * Ollama (Qwen) integration — turns a natural-language prompt into an EA script.
 *
 * Calls a local Ollama container through the Vite proxy (`/ollama` -> :11434), so the
 * browser request is same-origin (no CORS) and Ollama stays private. The system prompt
 * is an API "cheat sheet" for the EA workbench (see ExcalidrawAutomate.ts) plus a
 * few-shot example — the same idea as the plugin's SuggesterInfo / AI training data, which
 * is what makes a small model produce usable scripts.
 */

/**
 * Which Ollama model to call. Defaults to the small base coder model; the Docker build
 * sets `VITE_OLLAMA_MODEL=excalidraw-ea` to use the custom model whose Modelfile bakes in
 * the deep Excalidraw knowledge below. Keep this prompt and the Modelfile SYSTEM in sync.
 */
export const OLLAMA_MODEL = import.meta.env.VITE_OLLAMA_MODEL?.trim() || "qwen2.5-coder:1.5b";
const ENDPOINT = "/ollama/api/chat";

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
                                          // this for any flowchart/diagram.
await ea.loadSceneCode(payload, { mode:"replace"|"insert", offsetX?, offsetY?, verifyChecksum? })
  // load a payload produced by the app's "Scene → Code" button; NEVER invent this payload
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

Mermaid (ea.addMermaid) — the EASIEST way to draw diagrams; it does the layout for you:
- Write a Mermaid FLOWCHART; it becomes real, editable shapes + arrows. Other diagram types
  (sequence, gantt, class, pie, ...) still work but come back as a static IMAGE, not shapes.
- Flowchart syntax: first line "flowchart TD" (top-down) or "flowchart LR" (left-right).
  Nodes: A[Rect]  B(Rounded)  C{Diamond/decision}  D((Circle))  E([Stadium]).
  Edges: A --> B (arrow), A --- B (line), A -.-> B (dotted), A ==> B (thick),
         A -->|label| B (labelled). A node id is reused to connect it again.
  Group: "subgraph Title ... end" becomes a frame around those nodes.

Rules:
- For ANY flowchart/diagram, PREFER: await ea.addMermaid(\`flowchart TD ...\`); it auto-lays
  out nodes and arrows. Only hand-place shapes if Mermaid can't express it.
- When hand-placing, put text inside a shape via its label arg — ea.addRect(x,y,w,h,"Mulai") —
  NOT a separate addText; the label is centered and moves with the box.
- Connect shapes with ea.connect(a, b) — NOT ea.addArrow with manual points; the arrow binds to
  both shapes and stays attached. Use addArrow(points) only for free-floating lines.
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

/** Remove a surrounding markdown code fence if the model added one. */
function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:javascript|js|typescript|ts)?\s*\n([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

export interface GenerateOptions {
  signal?: AbortSignal;
}

/** Generate an EA script from a natural-language prompt. Throws on transport/model error. */
export async function generateScript(
  prompt: string,
  opts: GenerateOptions = {},
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
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
  return stripCodeFences(content);
}
