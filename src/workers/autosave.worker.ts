import { serializeScene } from "../io/serialize";
import type { SerializableScene } from "../types";

interface AutosaveRequest {
  id: number;
  scene: SerializableScene;
}

interface AutosaveResponse {
  id: number;
  data?: string;
  error?: string;
}

self.onmessage = (event: MessageEvent<AutosaveRequest>) => {
  const { id, scene } = event.data;
  try {
    const response: AutosaveResponse = { id, data: serializeScene(scene) };
    self.postMessage(response);
  } catch (error) {
    const response: AutosaveResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
