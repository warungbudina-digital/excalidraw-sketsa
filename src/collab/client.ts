import type { SerializableScene } from "../types";

export type CollaborationStatus = "connecting" | "connected" | "reconnecting" | "offline";

export interface Collaborator {
  id: string;
  name: string;
}

interface CollaborationCallbacks {
  onStatus: (status: CollaborationStatus) => void;
  onScene: (scene: SerializableScene) => void;
  onPresence: (users: Collaborator[]) => void;
  onEmptyRoom: () => void;
  onError: (message: string) => void;
}

interface SceneEvent {
  version: number;
  scene: SerializableScene;
}

const PUBLISH_DEBOUNCE_MS = 120;

export class CollaborationClient {
  private readonly roomId: string;
  private readonly clientId: string;
  private readonly name: string;
  private readonly callbacks: CollaborationCallbacks;
  private events: EventSource | null = null;
  private publishTimer: number | null = null;
  private pendingScene: SerializableScene | null = null;
  private publishing = false;
  private stopped = false;
  private lastAppliedVersion = 0;

  constructor(
    roomId: string,
    clientId: string,
    name: string,
    callbacks: CollaborationCallbacks,
  ) {
    this.roomId = roomId;
    this.clientId = clientId;
    this.name = name;
    this.callbacks = callbacks;
  }

  connect(): void {
    this.stopped = false;
    this.callbacks.onStatus("connecting");
    const params = new URLSearchParams({
      room: this.roomId,
      client: this.clientId,
      name: this.name,
    });
    const events = new EventSource(`/collab/events?${params}`);
    this.events = events;

    events.onopen = () => this.callbacks.onStatus("connected");
    events.onerror = () => {
      if (!this.stopped) this.callbacks.onStatus("reconnecting");
    };
    events.addEventListener("ready", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        version: number;
        hasScene: boolean;
      };
      // The in-memory collaboration server can restart while this browser remains open.
      // Its room version then starts from zero; reset the guard so fresh updates are not
      // mistaken for stale events from the previous server process.
      if (payload.version < this.lastAppliedVersion) this.lastAppliedVersion = 0;
      if (!payload.hasScene) this.callbacks.onEmptyRoom();
    });
    events.addEventListener("scene", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as SceneEvent;
        if (payload.version <= this.lastAppliedVersion) return;
        this.lastAppliedVersion = payload.version;
        this.callbacks.onScene(payload.scene);
      } catch (error) {
        this.callbacks.onError(`Update kolaborasi tidak valid: ${(error as Error).message}`);
      }
    });
    events.addEventListener("presence", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          users: Collaborator[];
        };
        this.callbacks.onPresence(payload.users);
      } catch {
        // A malformed presence event must not interrupt scene synchronization.
      }
    });
  }

  publish(scene: SerializableScene, immediately = false): void {
    if (this.stopped) return;
    this.pendingScene = scene;
    if (this.publishTimer !== null) window.clearTimeout(this.publishTimer);
    if (immediately) {
      this.publishTimer = null;
      void this.flush();
      return;
    }
    this.publishTimer = window.setTimeout(() => {
      this.publishTimer = null;
      void this.flush();
    }, PUBLISH_DEBOUNCE_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.publishTimer !== null) window.clearTimeout(this.publishTimer);
    this.publishTimer = null;
    this.pendingScene = null;
    this.events?.close();
    this.events = null;
    this.callbacks.onStatus("offline");
    this.callbacks.onPresence([]);
  }

  private async flush(): Promise<void> {
    if (this.publishing || this.stopped || !this.pendingScene) return;
    this.publishing = true;
    let retryScheduled = false;
    const scene = this.pendingScene;
    this.pendingScene = null;
    try {
      const response = await fetch(`/collab/rooms/${encodeURIComponent(this.roomId)}/scene`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: this.clientId, scene }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${detail.slice(0, 160)}`);
      }
      await response.json();
    } catch (error) {
      if (!this.stopped) {
        if (!this.pendingScene) this.pendingScene = scene;
        this.callbacks.onError(`Gagal mengirim perubahan: ${(error as Error).message}`);
        retryScheduled = true;
        this.publishTimer = window.setTimeout(() => {
          this.publishTimer = null;
          void this.flush();
        }, 1000);
      }
    } finally {
      this.publishing = false;
      if (this.pendingScene && !this.stopped && !retryScheduled) void this.flush();
    }
  }
}

export function createRoomId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function getRoomFromUrl(): string {
  const room = new URLSearchParams(window.location.search).get("room") ?? "";
  return /^[A-Za-z0-9_-]{8,64}$/.test(room) ? room : "";
}

export function setRoomInUrl(roomId: string): void {
  const url = new URL(window.location.href);
  if (roomId) url.searchParams.set("room", roomId);
  else url.searchParams.delete("room");
  window.history.replaceState(null, "", url);
}
