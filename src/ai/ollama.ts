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
ea.addRect(x, y, width, height) -> id
ea.addEllipse(x, y, width, height) -> id
ea.addDiamond(x, y, width, height) -> id
ea.addText(x, y, text) -> id
ea.addLine(points) -> id     // points: [[x,y], ...]
ea.addArrow(points) -> id    // points: [[x,y], ...]
ea.addToGroup(ids) -> groupId
ea.addFrame(name, childIds) -> frameId   // wraps childIds in a named frame, auto-sized
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

Rules:
- ALWAYS finish with: await ea.addElementsToView();
- Call ea.setStyle(...) before creating shapes to set colors.
- Coordinates are pixels; lay elements out so they don't overlap.
- To edit selected elements, first ea.copyViewElementsToEAforEditing(selected), then mutate.
- To group visually inside a labelled box, prefer ea.addFrame(name, [ids]) over addToGroup.
- Pass real shape ids to addFrame: const a = ea.addRect(...); ea.addFrame("Grup", [a]);

Example — flowchart of 3 boxes connected by arrows, wrapped in a frame:
ea.setStyle({ strokeColor: "#1971c2", backgroundColor: "#a5d8ff" });
const a = ea.addRect(100, 100, 150, 60);
const b = ea.addRect(100, 240, 150, 60);
const c = ea.addRect(100, 380, 150, 60);
ea.addText(120, 120, "Mulai");
ea.addText(120, 260, "Proses");
ea.addText(120, 400, "Selesai");
ea.setStyle({ strokeColor: "#1e1e1e" });
ea.addArrow([[175, 160], [175, 240]]);
ea.addArrow([[175, 300], [175, 380]]);
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
