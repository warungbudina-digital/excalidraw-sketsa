import http from "node:http";
import net from "node:net";

const PORT = Number(process.env.PORT || 8081);
const MAX_BODY = Number(process.env.COLLAB_MAX_BODY_BYTES || 15_000_000);
const MAX_CLIENTS_PER_ROOM = Number(process.env.COLLAB_MAX_CLIENTS_PER_ROOM || 25);
const ROOM_TTL_MS = Number(process.env.COLLAB_ROOM_TTL_MS || 3_600_000);
// Optional horizontal-scaling backplane. UNSET (default) = single-instance in-memory behaviour,
// byte-for-byte identical to before. SET (redis://host:port) = scene fan-out + shared snapshot +
// monotonic version + global presence across replicas (see docs/SCALING.md).
const REDIS_URL = (process.env.REDIS_URL || "").trim();
const TTL_SEC = Math.max(1, Math.ceil(ROOM_TTL_MS / 1000));
const ROOM_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CLIENT_RE = /^[A-Za-z0-9_-]{8,80}$/;
const rooms = new Map();

// A dead Redis must never take the process down — degrade, don't crash.
process.on("unhandledRejection", (error) => console.error("collab: unhandledRejection", error?.message ?? error));

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

// ───────────────────────────────────────────────────────────────────────────
// Redis backplane (minimal, dependency-free RESP client).
//
// Two TCP connections: one request/reply for commands, one for SUBSCRIBE. Both auto-reconnect
// with a fixed backoff. When the command socket is down, `cmd()` rejects immediately so callers
// fall back instead of hanging. Only the handful of commands this server needs are used:
// INCR / GET / SET ... EX / HSET / HDEL / HGETALL / EXPIRE / PUBLISH / SUBSCRIBE.
// ───────────────────────────────────────────────────────────────────────────
const CHANNEL = "collab:bus";

function encodeCommand(args) {
  const parts = [Buffer.from(`*${args.length}\r\n`, "utf8")];
  for (const arg of args) {
    const buf = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg), "utf8");
    parts.push(Buffer.from(`$${buf.length}\r\n`, "utf8"), buf, Buffer.from("\r\n", "utf8"));
  }
  return Buffer.concat(parts);
}

function findCRLF(buf, start) {
  for (let i = start; i + 1 < buf.length; i += 1) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i;
  }
  return -1;
}

// Parse one RESP reply from `buf` at `off`. Returns { value, next } or null when incomplete.
function parseReply(buf, off) {
  if (off >= buf.length) return null;
  const type = buf[off];
  const crlf = findCRLF(buf, off + 1);
  if (crlf === -1) return null;
  const line = buf.toString("utf8", off + 1, crlf);
  const afterLine = crlf + 2;
  if (type === 43) return { value: line, next: afterLine }; // +simple
  if (type === 45) return { value: new Error(line), next: afterLine }; // -error
  if (type === 58) return { value: Number(line), next: afterLine }; // :integer
  if (type === 36) {
    // $bulk
    const len = Number(line);
    if (len === -1) return { value: null, next: afterLine };
    if (afterLine + len + 2 > buf.length) return null;
    return { value: buf.toString("utf8", afterLine, afterLine + len), next: afterLine + len + 2 };
  }
  if (type === 42) {
    // *array
    const count = Number(line);
    if (count === -1) return { value: null, next: afterLine };
    const arr = [];
    let cursor = afterLine;
    for (let i = 0; i < count; i += 1) {
      const item = parseReply(buf, cursor);
      if (!item) return null;
      arr.push(item.value);
      cursor = item.next;
    }
    return { value: arr, next: cursor };
  }
  return { value: line, next: afterLine };
}

function createRedisBus(url, onMessage) {
  const target = new URL(url);
  const conf = {
    host: target.hostname || "127.0.0.1",
    port: Number(target.port || 6379),
    user: target.username && target.username !== "default" ? target.username : "",
    pass: target.password || "",
  };
  const pending = [];
  let cmdSock = null;
  let cmdReady = false;
  let cmdBuf = Buffer.alloc(0);
  let subSock = null;
  let subBuf = Buffer.alloc(0);

  const writeCmd = (args) =>
    new Promise((resolve, reject) => {
      if (!cmdSock || cmdSock.destroyed) {
        reject(new Error("redis socket not ready"));
        return;
      }
      pending.push({ resolve, reject });
      cmdSock.write(encodeCommand(args));
    });

  const connectCmd = () => {
    cmdReady = false;
    cmdBuf = Buffer.alloc(0);
    cmdSock = net.connect(conf.port, conf.host);
    cmdSock.on("connect", async () => {
      try {
        if (conf.pass) await writeCmd(conf.user ? ["AUTH", conf.user, conf.pass] : ["AUTH", conf.pass]);
        cmdReady = true;
        console.log("collab: redis command connection ready");
      } catch (error) {
        console.error("collab: redis AUTH failed:", error.message);
      }
    });
    cmdSock.on("data", (chunk) => {
      cmdBuf = Buffer.concat([cmdBuf, chunk]);
      let reply;
      while ((reply = parseReply(cmdBuf, 0))) {
        cmdBuf = cmdBuf.subarray(reply.next);
        const waiter = pending.shift();
        if (!waiter) continue;
        if (reply.value instanceof Error) waiter.reject(reply.value);
        else waiter.resolve(reply.value);
      }
    });
    cmdSock.on("error", (error) => console.error("collab: redis cmd error:", error.message));
    cmdSock.on("close", () => {
      cmdReady = false;
      while (pending.length) pending.shift().reject(new Error("redis disconnected"));
      setTimeout(connectCmd, 1000);
    });
  };

  const connectSub = () => {
    subBuf = Buffer.alloc(0);
    subSock = net.connect(conf.port, conf.host);
    subSock.on("connect", () => {
      if (conf.pass) subSock.write(encodeCommand(conf.user ? ["AUTH", conf.user, conf.pass] : ["AUTH", conf.pass]));
      subSock.write(encodeCommand(["SUBSCRIBE", CHANNEL]));
      console.log("collab: redis subscribe connection ready");
    });
    subSock.on("data", (chunk) => {
      subBuf = Buffer.concat([subBuf, chunk]);
      let reply;
      while ((reply = parseReply(subBuf, 0))) {
        subBuf = subBuf.subarray(reply.next);
        const value = reply.value;
        if (Array.isArray(value) && value[0] === "message" && typeof value[2] === "string") {
          try {
            onMessage(JSON.parse(value[2]));
          } catch {
            // ignore malformed bus message
          }
        }
      }
    });
    subSock.on("error", (error) => console.error("collab: redis sub error:", error.message));
    subSock.on("close", () => setTimeout(connectSub, 1000));
  };

  connectCmd();
  connectSub();

  return {
    isReady: () => cmdReady,
    cmd: (...args) => (cmdReady ? writeCmd(args) : Promise.reject(new Error("redis not connected"))),
    publish: (payload) => (cmdReady ? writeCmd(["PUBLISH", CHANNEL, JSON.stringify(payload)]) : Promise.reject(new Error("redis not connected"))),
  };
}

const bus = REDIS_URL ? createRedisBus(REDIS_URL, onBusMessage) : null;

const kScene = (id) => `collab:scene:${id}`;
const kVer = (id) => `collab:ver:${id}`;
const kPres = (id) => `collab:presence:${id}`;

async function redisScene(id) {
  const raw = await bus.cmd("GET", kScene(id));
  return raw ? JSON.parse(raw) : null;
}

async function redisPresence(id) {
  const flat = await bus.cmd("HGETALL", kPres(id));
  const users = [];
  for (let i = 0; i + 1 < flat.length; i += 2) users.push({ id: flat[i], name: flat[i + 1] });
  return users;
}

// A message from another (or this) replica: re-broadcast to THIS replica's local SSE clients.
function onBusMessage(message) {
  if (!message || typeof message !== "object") return;
  const room = rooms.get(message.room);
  if (!room || room.clients.size === 0) return;
  if (message.type === "scene") {
    broadcast(room, "scene", { version: message.version, scene: message.scene }, message.except || null);
  } else if (message.type === "presence") {
    redisPresence(message.room)
      .then((users) => broadcast(room, "presence", { count: users.length, users }))
      .catch(() => {});
  }
}

const handleEvents = async (req, res, url) => {
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

  // Initial state: from Redis when scaling (global snapshot), else this replica's memory.
  let version = room.version;
  let scene = room.scene;
  if (bus) {
    try {
      version = Number((await bus.cmd("GET", kVer(roomId))) || 0);
      scene = await redisScene(roomId);
    } catch {
      version = room.version;
      scene = room.scene;
    }
  }
  event(res, "ready", { room: roomId, version, hasScene: Boolean(scene) });
  if (scene) event(res, "scene", { version, scene });

  // Presence: shared via a Redis hash when scaling, else local fan-out.
  if (bus) {
    try {
      await bus.cmd("HSET", kPres(roomId), clientId, name);
      await bus.cmd("EXPIRE", kPres(roomId), TTL_SEC);
      await bus.publish({ type: "presence", room: roomId });
    } catch {
      publishPresence(room);
    }
  } else {
    publishPresence(room);
  }

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
    if (bus) bus.cmd("EXPIRE", kPres(roomId), TTL_SEC).catch(() => {});
  }, 20_000);
  const close = () => {
    clearInterval(heartbeat);
    if (room.clients.get(clientId)?.res === res) {
      room.clients.delete(clientId);
      if (bus) {
        bus
          .cmd("HDEL", kPres(roomId), clientId)
          .then(() => bus.publish({ type: "presence", room: roomId }))
          .catch(() => {});
      } else {
        publishPresence(room);
      }
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

  if (bus) {
    // Scaled path: monotonic version via INCR, snapshot in Redis, fan-out via pub/sub (the
    // subscription delivers to every replica's local clients, including this one). On any Redis
    // error, return 503 — the browser client auto-retries — instead of corrupting local state.
    try {
      const version = Number(await bus.cmd("INCR", kVer(roomId)));
      await bus.cmd("EXPIRE", kVer(roomId), TTL_SEC);
      const merged = mergeScene(await redisScene(roomId), body.scene);
      await bus.cmd("SET", kScene(roomId), JSON.stringify(merged), "EX", TTL_SEC);
      await bus.publish({ type: "scene", room: roomId, version, scene: merged, except: body.clientId });
      return sendJson(res, 200, { ok: true, version });
    } catch (error) {
      return sendJson(res, 503, { error: `backplane unavailable: ${error.message}` });
    }
  }

  // Single-instance path (unchanged): merge + broadcast from this process's memory.
  room.scene = mergeScene(room.scene, body.scene);
  room.version += 1;
  broadcast(room, "scene", { version: room.version, scene: room.scene }, body.clientId);
  return sendJson(res, 200, { ok: true, version: room.version });
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/healthz") {
    const clients = [...rooms.values()].reduce((total, room) => total + room.clients.size, 0);
    return sendJson(res, 200, {
      ok: true,
      rooms: rooms.size,
      clients,
      backplane: bus ? (bus.isReady() ? "redis-up" : "redis-down") : "off",
    });
  }
  if (req.method === "GET" && url.pathname === "/events") return void handleEvents(req, res, url);
  const sceneMatch = url.pathname.match(/^\/rooms\/([A-Za-z0-9_-]+)\/scene$/);
  if (req.method === "POST" && sceneMatch) return void handleScene(req, res, sceneMatch[1]);
  return sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () =>
  console.log(`collab listening on :${PORT}${REDIS_URL ? ` (backplane: ${REDIS_URL.replace(/\/\/.*@/, "//***@")})` : " (single-instance)"}`),
);
