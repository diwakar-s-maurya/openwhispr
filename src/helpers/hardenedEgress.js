// Network egress for the hardened Flatpak build (local.surface.OpenWhispr).
//
// The sandbox has no network of its own (no --share=network): only loopback.
// Its single way out is a unix socket, $XDG_RUNTIME_DIR/openwhispr-net/proxy.sock,
// served on the host by a filtering proxy that allows CONNECT to port 443 of the
// provider hosts only. That proxy is the enforcement point; nothing here can
// widen it.
//
// This module, active only when OW_PROXY_SOCKET is set:
//   1. bridges 127.0.0.1:<port> to that socket, since Chromium and Node speak
//      HTTP proxy over TCP, not over a unix socket;
//   2. sends `ws` WebSocket connections through the proxy (ws ignores the
//      environment proxy that Node's own http/https/fetch honour);
//   3. cancels, inside the app, any web request to a host outside the list
//      below, and grants web contents microphone access only (defence in depth;
//      the host proxy holds the same list).
const net = require("net");

// Keep in sync with host/openwhispr-net/allowlist.txt.
const ALLOWED_HOSTS = [
  /^api\.groq\.com$/,
  /^api\.openai\.com$/,
  /^api\.anthropic\.com$/,
  /^generativelanguage\.googleapis\.com$/,
  /^api\.mistral\.ai$/,
  /^openrouter\.ai$/,
  /^api\.deepgram\.com$/,
  /^api\.assemblyai\.com$/,
  /^streaming\.assemblyai\.com$/,
  /^atc\.tinfoil\.sh$/,
  /^([a-z0-9-]+\.)+tinfoil\.sh$/,
  /^[a-z0-9-]+\.openai\.azure\.com$/,
  /^[a-z0-9-]+\.cognitiveservices\.azure\.com$/,
  /^[a-z0-9-]+\.services\.ai\.azure\.com$/,
];

function isAllowedHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return ALLOWED_HOSTS.some((pattern) => pattern.test(host));
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

// Only encrypted requests to listed hosts leave the app. file:, devtools:,
// data: and blob: never reach this filter (it matches network schemes only).
function isAllowedRequestUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "wss:") return false;
  if (parsed.port && parsed.port !== "443") return false;
  return isAllowedHost(parsed.hostname);
}

function startProxyBridge({ socketPath, port, host = "127.0.0.1", logger = console }) {
  const server = net.createServer((client) => {
    const upstream = net.connect(socketPath);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", (error) => {
      logger.warn?.("Egress proxy socket unavailable", { error: error.message }, "network");
      close();
    });
    client.on("close", close);
    upstream.on("close", close);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

// Every module loads ws as `const WebSocket = require("ws")`, so replacing the
// cached export before they load is enough to cover all of them.
function installWebSocketProxy(proxyUrl, { wsModuleId = "ws" } = {}) {
  const { HttpsProxyAgent } = require("https-proxy-agent");
  const OriginalWebSocket = require(wsModuleId);
  const agent = new HttpsProxyAgent(proxyUrl);

  class ProxiedWebSocket extends OriginalWebSocket {
    constructor(address, protocols, options) {
      if (address != null) {
        if (protocols && typeof protocols === "object" && !Array.isArray(protocols)) {
          options = protocols;
          protocols = undefined;
        }
        const target = new URL(String(address));
        if (!options?.agent && !isLoopbackHost(target.hostname)) {
          options = { ...options, agent };
        }
      }
      super(address, protocols, options);
    }
  }
  ProxiedWebSocket.WebSocket = ProxiedWebSocket;

  const cached = require.cache[require.resolve(wsModuleId)];
  cached.exports = ProxiedWebSocket;
  return ProxiedWebSocket;
}

function installSessionGuards(targetSession, { logger = console } = {}) {
  targetSession.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, callback) => {
    if (isAllowedRequestUrl(details.url)) return callback({});
    logger.warn?.("Blocked request outside the egress allowlist", { url: details.url }, "network");
    callback({ cancel: true });
  });

  const allowPermission = (permission, details = {}) => {
    if (permission === "media") {
      const types = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
      return !types.includes("video");
    }
    // navigator.clipboard.writeText; reading the clipboard stays denied.
    return permission === "clipboard-sanitized-write";
  };
  targetSession.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(allowPermission(permission, details))
  );
  targetSession.setPermissionCheckHandler((_contents, permission, _origin, details) =>
    allowPermission(permission, details)
  );
}

// Call at the very top of main.js, before anything requires ws or opens a window.
function setupHardenedEgress({ app, session, env = process.env, logger = console }) {
  const socketPath = env.OW_PROXY_SOCKET;
  if (!socketPath) return false;
  const proxyUrl = env.HTTPS_PROXY || "http://127.0.0.1:18080";
  const { port, hostname } = new URL(proxyUrl);

  // Chromium: everything through the bridge, and none of its own background
  // traffic (component updates, safe-browsing lists, reporting, pings).
  app.commandLine.appendSwitch("proxy-server", proxyUrl);
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("disable-domain-reliability");
  app.commandLine.appendSwitch("no-pings");

  installWebSocketProxy(proxyUrl);
  startProxyBridge({ socketPath, port: Number(port), host: hostname, logger }).catch((error) => {
    logger.error?.("Egress proxy bridge failed to start", { error: error.message }, "network");
  });
  // Every session, including partitions created later.
  app.on("session-created", (created) => installSessionGuards(created, { logger }));
  app.whenReady().then(() => installSessionGuards(session.defaultSession, { logger }));
  return true;
}

module.exports = {
  ALLOWED_HOSTS,
  isAllowedHost,
  isAllowedRequestUrl,
  isLoopbackHost,
  installSessionGuards,
  installWebSocketProxy,
  setupHardenedEgress,
  startProxyBridge,
};
