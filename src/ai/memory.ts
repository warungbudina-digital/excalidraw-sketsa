/**
 * AI memory history — reads generation turns captured by the `memory` backend
 * (Supabase-backed). The browser only ever talks to the same-origin `/memory/` proxy;
 * the Supabase service key stays server-side in the memory container.
 *
 * Capture (writes) lives in ./ollama.ts (`captureMemory`); this module is read-only.
 */

// nginx maps /memory/* -> the memory container, which itself routes /memory (list/insert)
// and /memory/<id> (detail). Hence the double "memory" in the browser path.
const BASE = "/memory/memory";

/** Summary row from the list endpoint — intentionally omits `response`/`scene_snapshot`. */
export interface MemorySummary {
  id: string;
  created_at: string;
  backend: string;
  model: string | null;
  prompt: string;
  tags: string[];
}

/** Full row from the detail endpoint — includes the generated script and scene. */
export interface MemoryDetail extends MemorySummary {
  response: string;
  scene_snapshot: unknown;
  meta: Record<string, unknown>;
  room_id: string | null;
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return `Riwayat HTTP ${res.status}: ${text.slice(0, 200)}`;
}

/** Recent generation turns, newest first. `q` filters by prompt substring. */
export async function listMemory(opts: { limit?: number; q?: string } = {}): Promise<MemorySummary[]> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.q?.trim()) params.set("q", opts.q.trim());
  const res = await fetch(`${BASE}?${params}`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as MemorySummary[];
}

/** One full turn by id — use its `response` to reload the generated script. */
export async function getMemory(id: string): Promise<MemoryDetail> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as MemoryDetail;
}
