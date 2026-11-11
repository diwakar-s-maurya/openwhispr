const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const egress = require("../../src/helpers/hardenedEgress");

test("the in-app host list matches the host proxy's allowlist", () => {
  const file = path.join(__dirname, "../../packaging/flatpak/host/openwhispr-net/allowlist.txt");
  const hostRules = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(
    egress.ALLOWED_HOSTS.map((pattern) => pattern.source),
    hostRules
  );
});

test("only https/wss on 443 to listed provider hosts is allowed", () => {
  for (const url of [
    "https://api.openai.com/v1/audio/transcriptions",
    "wss://api.deepgram.com/v1/listen",
    "https://API.GROQ.COM/openai/v1/models",
    "https://my-resource.openai.azure.com/openai/deployments",
    "https://inference.tinfoil.sh/v1/chat",
  ]) {
    assert.equal(egress.isAllowedRequestUrl(url), true, url);
  }
  for (const url of [
    "http://api.openai.com/v1/models",
    "https://api.openai.com:8443/v1/models",
    "https://auth.openwhispr.com/api/get-session",
    "https://api.openai.com.evil.example/",
    "https://evil.example/?u=api.openai.com",
    "https://a.b.openai.azure.com/",
    "https://update.electronjs.org/",
    "not a url",
  ]) {
    assert.equal(egress.isAllowedRequestUrl(url), false, url);
  }
});

test("outbound WebSockets get the proxy agent; loopback and explicit agents don't", (t) => {
  const created = [];
  class FakeWebSocket {
    constructor(address, protocols, options) {
      created.push({ address, protocols, options });
    }
  }
  FakeWebSocket.OPEN = 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-ws-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const modulePath = path.join(dir, "fake-ws.js");
  fs.writeFileSync(modulePath, "module.exports = null;");
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: FakeWebSocket,
  };

  const Proxied = egress.installWebSocketProxy("http://127.0.0.1:18080", {
    wsModuleId: modulePath,
  });
  assert.equal(require(modulePath), Proxied);
  assert.equal(Proxied.WebSocket, Proxied);
  assert.equal(Proxied.OPEN, 1);

  new Proxied("wss://api.deepgram.com/v1/listen", { headers: { a: "b" } });
  new Proxied("wss://api.assemblyai.com/v3/ws", ["proto"], { headers: {} });
  new Proxied("ws://127.0.0.1:9000/local");
  const own = { own: true };
  new Proxied("wss://api.openai.com/v1/realtime", { agent: own });

  assert.equal(created[0].options.agent.constructor.name, "HttpsProxyAgent");
  assert.deepEqual(created[0].options.headers, { a: "b" });
  assert.equal(created[0].protocols, undefined);
  assert.deepEqual(created[1].protocols, ["proto"]);
  assert.equal(created[1].options.agent.constructor.name, "HttpsProxyAgent");
  assert.equal(created[2].options?.agent, undefined);
  assert.equal(created[3].options.agent, own);
});

test("the bridge pipes loopback TCP to the unix socket both ways", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-bridge-"));
  const socketPath = path.join(dir, "proxy.sock");
  const upstream = net.createServer((conn) => conn.on("data", (d) => conn.write(`echo:${d}`)));
  await new Promise((resolve) => upstream.listen(socketPath, resolve));
  const bridge = await egress.startProxyBridge({ socketPath, port: 0, logger: {} });
  t.after(() => {
    bridge.close();
    upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const reply = await new Promise((resolve, reject) => {
    const client = net.connect(bridge.address().port, "127.0.0.1", () => client.write("ping"));
    client.on("data", (d) => {
      resolve(String(d));
      client.end();
    });
    client.on("error", reject);
  });
  assert.equal(reply, "echo:ping");
});

test("session guards cancel unlisted requests and grant only the microphone and clipboard writes", () => {
  let filter;
  let onRequest;
  let requestHandler;
  let checkHandler;
  const session = {
    webRequest: {
      onBeforeRequest: (f, listener) => {
        filter = f;
        onRequest = listener;
      },
    },
    setPermissionRequestHandler: (h) => (requestHandler = h),
    setPermissionCheckHandler: (h) => (checkHandler = h),
  };
  egress.installSessionGuards(session, { logger: {} });
  assert.deepEqual(filter, { urls: ["*://*/*"] });

  const decide = (url) => {
    let result;
    onRequest({ url }, (r) => (result = r));
    return result;
  };
  assert.deepEqual(decide("https://api.anthropic.com/v1/messages"), {});
  assert.deepEqual(decide("https://auth.openwhispr.com/api/get-session"), { cancel: true });

  const ask = (permission, details) => {
    let granted;
    requestHandler(null, permission, (g) => (granted = g), details);
    return granted;
  };
  assert.equal(ask("media", { mediaTypes: ["audio"] }), true);
  assert.equal(ask("media", { mediaTypes: ["audio", "video"] }), false);
  assert.equal(ask("clipboard-read", {}), false);
  assert.equal(ask("clipboard-sanitized-write", {}), true);
  assert.equal(ask("geolocation", {}), false);
  assert.equal(ask("notifications", {}), false);
  assert.equal(checkHandler(null, "media", "file://", { mediaType: "audio" }), true);
  assert.equal(checkHandler(null, "media", "file://", { mediaType: "video" }), false);
});

test("setup does nothing without OW_PROXY_SOCKET", () => {
  const app = new EventEmitter();
  app.commandLine = { appendSwitch: () => assert.fail("no switches") };
  assert.equal(egress.setupHardenedEgress({ app, session: {}, env: {} }), false);
});
