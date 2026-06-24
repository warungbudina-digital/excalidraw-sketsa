/**
 * Cross-replica fan-out test for the collab Redis backplane.
 *
 * Proves that with two collab replicas sharing one Redis, a scene POST to replica A reaches an
 * SSE client connected to replica B (and vice-versa), and that presence is global. SSE is plain
 * HTTP, so this needs no browser.
 *
 *   node scripts/collab-scale-test.mjs http://localhost:18081 http://localhost:18082
 *
 * Exit 0 = all assertions passed; 1 = a failure; 2 = bad usage.
 */
import http from "node:http";

const [A, B] = process.argv.slice(2);
if (!A || !B) {
  console.error("usage: node scripts/collab-scale-test.mjs <collabA-baseurl> <collabB-baseurl>");
  process.exit(2);
}

const ROOM = "scaletestroom";
const sceneWith = (id) => ({
  elements: [{ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1 }],
  appState: {},
  files: {},
});

function sseConnect(base, clientId, name) {
  const url = new URL(`${base}/events`);
  url.searchParams.set("room", ROOM);
  url.searchParams.set("client", clientId);
  url.searchParams.set("name", name);
  const events = [];
  const waiters = [];
  const emit = (ev) => {
    events.push(ev);
    for (const w of [...waiters]) {
      if (w.match(ev)) {
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(ev);
      }
    }
  };
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE ${clientId}: HTTP ${res.statusCode}`));
        return;
      }
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let type = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (data) {
            try {
              emit({ type, data: JSON.parse(data) });
            } catch {
              emit({ type, data });
            }
          }
        }
      });
      resolve({
        waitFor: (type, predicate = () => true, timeoutMs = 6000) =>
          new Promise((res2, rej2) => {
            const found = events.find((e) => e.type === type && predicate(e.data));
            if (found) return res2(found);
            const w = {
              match: (e) => e.type === type && predicate(e.data),
              resolve: res2,
              timer: setTimeout(() => {
                const i = waiters.indexOf(w);
                if (i >= 0) waiters.splice(i, 1);
                rej2(new Error(`${clientId}: timeout waiting for "${type}"`));
              }, timeoutMs),
            };
            waiters.push(w);
          }),
        close: () => req.destroy(),
      });
    });
    req.on("error", reject);
  });
}

function postScene(base, clientId, scene) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ clientId, scene });
    const url = new URL(`${base}/rooms/${ROOM}/scene`);
    const req = http.request(
      url,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const hasElement = (id) => (data) =>
  Array.isArray(data?.scene?.elements) && data.scene.elements.some((e) => e.id === id);

const pass = (msg) => console.log(`  PASS  ${msg}`);

async function main() {
  console.log(`collab scale test: A=${A}  B=${B}  room=${ROOM}`);
  const a = await sseConnect(A, "clientAAAA", "Alice");
  const b = await sseConnect(B, "clientBBBB", "Bob");

  await a.waitFor("ready");
  await b.waitFor("ready");
  pass("both SSE clients connected (ready) — one per replica");

  // Global presence: each replica must report 2 online (aggregated via Redis).
  await a.waitFor("presence", (d) => d.count === 2);
  await b.waitFor("presence", (d) => d.count === 2);
  pass("presence aggregated across replicas (count = 2 on both)");

  // POST to A as a third client; B (other replica) must receive it.
  const post1 = await postScene(A, "posterCCCC", sceneWith("elemFromA1"));
  if (post1.status !== 200) throw new Error(`POST to A failed: ${post1.status} ${post1.body}`);
  await b.waitFor("scene", hasElement("elemFromA1"));
  pass("POST -> A  reached SSE client on B (cross-replica fan-out)");
  await a.waitFor("scene", hasElement("elemFromA1"));
  pass("POST -> A  also reached SSE client on A (poster excluded)");

  // POST to B; A must receive it (other direction).
  const post2 = await postScene(B, "posterCCCC", sceneWith("elemFromB1"));
  if (post2.status !== 200) throw new Error(`POST to B failed: ${post2.status} ${post2.body}`);
  await a.waitFor("scene", hasElement("elemFromB1"));
  pass("POST -> B  reached SSE client on A (fan-out both directions)");

  a.close();
  b.close();
  console.log("\nALL PASSED ✓");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\nFAILED ✗  ${error.message}`);
    process.exit(1);
  });
