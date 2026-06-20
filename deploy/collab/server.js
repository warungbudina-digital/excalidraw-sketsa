import http from "node:http";

const PORT = Number(process.env.PORT || 8081);
const MAX_BODY = Number(process.env.COLLAB_MAX_BODY_BYTES || 15_000_000);
const MAX_CLIENTS_PER_ROOM = Number(process.env.COLLAB_MAX_CLIENTS_PER_ROOM || 25);
const ROOM_TTL_MS = Number(process.env.COLLAB_ROOM_TTL_MS || 3_600_000);
const ROOM_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CLIENT_RE = /^[A-Za-z0-9_-]{8,80}$/;
const rooms = new Map();

const sendJson = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
};

const readJson = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });

const roomFor = (id) => {
  let room = rooms.get(id);
  if (!room) {
    room = { id, version: 0, scene: null, clients: new Map(), cleanupTimer: null };
    rooms.set(id, room);
  }
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
  return room;
};

const event = (res, name, data) => {
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
};

const broadcast = (room, name, data, exceptClientId = null) => {
  for (const [clientId, client] of room.clients) {
    if (clientId !== exceptClientId) event(client.res, name, data);
  }
};

const publishPresence = (room) => {
  const users = [...room.clients].map(([id, client]) => ({ id, name: client.name }));
  broadcast(room, "presence", { count: users.length, users });
};

const scheduleCleanup = (room) => {
  if (room.clients.size > 0 || room.cleanupTimer) return;
  room.cleanupTimer = setTimeout(() => rooms.delete(room.id), ROOM_TTL_MS);
  room.cleanupTimer.unref();
};

const isCandidateNewer = (candidate, existing) => {
  const candidateVersion = Number(candidate?.version || 0);
  const existingVersion = Number(existing?.version || 0);
  if (candidateVersion !== existingVersion) return candidateVersion > existingVersion;
  return Number(candidate?.versionNonce || 0) >= Number(existing?.versionNonce || 0);
};

const mergeScene = (current, incoming) => {
  if (!current) {
    const elements = Array.isArray(incoming.elements) ? incoming.elements : [];
    const referencedFiles = new Set(
      elements
        .filter((element) => !element.isDeleted && typeof element.fileId === "string")
        .map((element) => element.fileId),
    );
    const incomingFiles = incoming.files && typeof incoming.files === "object" ? incoming.files : {};
    return {
      elements,
      appState: incoming.appState && typeof incoming.appState === "object" ? incoming.appState : {},
      files: Object.fromEntries(
        Object.entries(incomingFiles).filter(([fileId]) => referencedFiles.has(fileId)),
      ),
    };
  }

  const elements = new Map((current.elements || []).map((element) => [element.id, element]));
  for (const candidate of incoming.elements || []) {
    if (!candidate || typeof candidate.id !== "string") continue;
    const existing = elements.get(candidate.id);
    if (!existing || isCandidateNewer(candidate, existing)) {
      elements.set(candidate.id, candidate);
    }
  }

  const mergedElements = [...elements.values()];
  const mergedFiles = { ...(current.files || {}), ...(incoming.files || {}) };
  const referencedFiles = new Set(
    mergedElements
      .filter((element) => !element.isDeleted && typeof element.fileId === "string")
      .map((element) => element.fileId),
  );
  const files = Object.fromEntries(
    Object.entries(mergedFiles).filter(([fileId]) => referencedFiles.has(fileId)),
  );
  return {
    elements: mergedElements,
    appState: { ...(current.appState || {}), ...(incoming.appState || {}) },
    files,
  };
};

const handleEvents = (req, res, url) => {
  const roomId = url.searchParams.get("room") || "";
  const clientId = url.searchParams.get("client") || "";
  const name = (url.searchParams.get("name") || "Kolaborator").slice(0, 48);
  if (!ROOM_RE.test(roomId) || !CLIENT_RE.test(clientId)) {
    return sendJson(res, 400, { error: "invalid room or client id" });
  }

  const room = roomFor(roomId);
  if (!room.clients.has(clientId) && room.clients.size >= MAX_CLIENTS_PER_ROOM) {
    return sendJson(res, 429, { error: "room is full" });
  }
  room.clients.get(clientId)?.res.end();

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  room.clients.set(clientId, { res, name });
  event(res, "ready", { room: roomId, version: room.version, hasScene: Boolean(room.scene) });
  if (room.scene) event(res, "scene", { version: room.version, scene: room.scene });
  publishPresence(room);

  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
  const close = () => {
    clearInterval(heartbeat);
    if (room.clients.get(clientId)?.res === res) {
      room.clients.delete(clientId);
      publishPresence(room);
      scheduleCleanup(room);
    }
  };
  req.on("close", close);
};

const handleScene = async (req, res, roomId) => {
  if (!ROOM_RE.test(roomId)) return sendJson(res, 400, { error: "invalid room id" });
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, error.message === "payload too large" ? 413 : 400, { error: error.message });
  }
  if (!CLIENT_RE.test(body.clientId || "") || !body.scene || typeof body.scene !== "object") {
    return sendJson(res, 400, { error: "invalid scene update" });
  }

  const room = roomFor(roomId);
  room.scene = mergeScene(room.scene, body.scene);
  room.version += 1;
  const update = { version: room.version, scene: room.scene };
  broadcast(room, "scene", update, body.clientId);
  return sendJson(res, 200, { ok: true, version: room.version });
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/healthz") {
    const clients = [...rooms.values()].reduce((total, room) => total + room.clients.size, 0);
    return sendJson(res, 200, { ok: true, rooms: rooms.size, clients });
  }
  if (req.method === "GET" && url.pathname === "/events") return handleEvents(req, res, url);
  const sceneMatch = url.pathname.match(/^\/rooms\/([A-Za-z0-9_-]+)\/scene$/);
  if (req.method === "POST" && sceneMatch) return handleScene(req, res, sceneMatch[1]);
  return sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`collab listening on :${PORT}`));
