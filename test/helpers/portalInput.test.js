const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const { PortalInputSession } = require("../../src/helpers/portalInput");

const quietLogger = { debug() {}, info() {}, warn() {} };

// A stand-in for linux-portal-input: records stdin lines, answers via `respond`.
function fakeHelper({ respond = () => "OK", greet = ["READY clipboard=1"] } = {}) {
  const spawns = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.lines = [];
    child.killed = null;
    child.stdin = {
      write(chunk) {
        for (const line of chunk.split("\n").filter(Boolean)) {
          child.lines.push(line);
          const answer = respond(line, child);
          if (answer) child.stdout.write(`${answer}\n`);
        }
      },
      end(chunk) {
        if (chunk) this.write(chunk);
      },
    };
    child.kill = (signal) => {
      child.killed = signal;
      setImmediate(() => child.emit("exit", null));
    };
    child.exit = (code) => child.emit("exit", code);
    spawns.push({ command, args, options, child });
    setImmediate(() => greet.forEach((line) => child.stdout.write(`${line}\n`)));
    return child;
  };
  return { spawns, spawnImpl };
}

function tempTokenPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-portal-input-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "cache", "portal-input-token");
}

function decode(line) {
  const [, , b64] = line.split(" ");
  return Buffer.from(b64 ?? line.split(" ")[1], "base64").toString("utf8");
}

test("shouldUse: inside a Flatpak or when opted in, on Linux only", () => {
  assert.equal(PortalInputSession.shouldUse({ FLATPAK_ID: "x.y.Z" }, "linux"), true);
  assert.equal(
    PortalInputSession.shouldUse({ OPENWHISPR_PASTE_BACKEND: "portal-input" }, "linux"),
    true
  );
  assert.equal(PortalInputSession.shouldUse({}, "linux"), false);
  assert.equal(PortalInputSession.shouldUse({ FLATPAK_ID: "x.y.Z" }, "darwin"), false);
});

test("one helper serves every paste, and the text travels base64-encoded", async (t) => {
  const helper = fakeHelper();
  const session = new PortalInputSession({
    binaryPath: "/bin/helper",
    tokenPath: tempTokenPath(t),
    spawnImpl: helper.spawnImpl,
    logger: quietLogger,
  });

  await session.paste("héllo world\nline two");
  await session.paste("again", "ctrl-v");
  await session.copy("copied");

  assert.equal(helper.spawns.length, 1);
  const lines = helper.spawns[0].child.lines;
  assert.deepEqual(
    lines.map((line) => line.split(" ").slice(0, -1).join(" ")),
    ["PASTE shift-insert", "PASTE ctrl-v", "COPY"]
  );
  assert.equal(decode(lines[0]), "héllo world\nline two");
  assert.equal(Buffer.from(lines[2].split(" ")[1], "base64").toString(), "copied");
  assert.equal(session.clipboardEnabled, true);
});

test("the restore token goes in through the environment and is saved owner-only", async (t) => {
  const tokenPath = tempTokenPath(t);
  const helper = fakeHelper({ greet: ["TOKEN fresh-token", "READY clipboard=1"] });
  const session = new PortalInputSession({
    binaryPath: "/bin/helper",
    tokenPath,
    spawnImpl: helper.spawnImpl,
    logger: quietLogger,
  });
  await session.start();
  assert.equal(fs.readFileSync(tokenPath, "utf8"), "fresh-token");
  assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
  assert.equal(helper.spawns[0].options.env.PORTAL_INPUT_RESTORE_TOKEN, "");

  session.close();
  const again = fakeHelper();
  const second = new PortalInputSession({
    binaryPath: "/bin/helper",
    tokenPath,
    spawnImpl: again.spawnImpl,
    logger: quietLogger,
  });
  await second.start();
  assert.deepEqual(again.spawns[0].args, []);
  assert.equal(again.spawns[0].options.env.PORTAL_INPUT_RESTORE_TOKEN, "fresh-token");
});

test("an ERR reply rejects with its reason as the code", async (t) => {
  const helper = fakeHelper({ respond: () => "ERR clipboard-unavailable" });
  const session = new PortalInputSession({
    binaryPath: "/bin/helper",
    tokenPath: tempTokenPath(t),
    spawnImpl: helper.spawnImpl,
    logger: quietLogger,
  });
  await assert.rejects(session.paste("x"), { code: "clipboard-unavailable" });
});

test("a refused permission isn't asked again until restart", async (t) => {
  const helper = fakeHelper({ greet: [] });
  const session = new PortalInputSession({
    binaryPath: "/bin/helper",
    tokenPath: tempTokenPath(t),
    spawnImpl: helper.spawnImpl,
    logger: quietLogger,
  });
  const first = session.paste("x");
  setImmediate(() => helper.spawns[0].child.exit(3));
  await assert.rejects(first, { code: "denied" });
  await assert.rejects(session.paste("y"), { code: "denied" });
  assert.equal(helper.spawns.length, 1);
});

test("a session the desktop ends is reopened on the next paste", async (t) => {
  const helper = fakeHelper();
  const session = new PortalInputSession({
    binaryPath: "/bin/helper",
    tokenPath: tempTokenPath(t),
    spawnImpl: helper.spawnImpl,
    logger: quietLogger,
  });
  await session.paste("one");
  helper.spawns[0].child.stdout.write("CLOSED\n");
  helper.spawns[0].child.exit(0);
  await session.paste("two");
  assert.equal(helper.spawns.length, 2);
  assert.equal(decode(helper.spawns[1].child.lines[0]), "two");
});

test("a helper that stops answering is killed so replies can't get out of step", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const helper = fakeHelper({ respond: () => null });
  const session = new PortalInputSession({
    binaryPath: "/bin/helper",
    tokenPath: tempTokenPath(t),
    spawnImpl: helper.spawnImpl,
    logger: quietLogger,
  });
  await session.start();
  const pending = session.paste("x");
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5000);
  await assert.rejects(pending, { code: "timeout" });
  assert.equal(helper.spawns[0].child.killed, "SIGKILL");
});

// ---- ClipboardManager with the portal backend ----

function loadClipboardManager(fakeClipboard) {
  const modulePath = require.resolve("../../src/helpers/clipboard");
  delete require.cache[modulePath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return { clipboard: fakeClipboard, systemPreferences: {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../../src/helpers/clipboard");
  } finally {
    Module._load = originalLoad;
  }
}

function strictClipboard() {
  const writes = [];
  const refuse = (name) => () => {
    throw new Error(`clipboard.${name} must not be called`);
  };
  return {
    writes,
    readText: refuse("readText"),
    readHTML: refuse("readHTML"),
    readRTF: refuse("readRTF"),
    readImage: refuse("readImage"),
    readBuffer: refuse("readBuffer"),
    availableFormats: refuse("availableFormats"),
    writeText: (text, type) => writes.push([text, type]),
  };
}

function fakeSession({ pasteError, copyError } = {}) {
  const calls = [];
  return {
    calls,
    async paste(text, keys) {
      calls.push(["paste", text, keys]);
      if (pasteError) throw pasteError;
    },
    async copy(text) {
      calls.push(["copy", text]);
      if (copyError) throw copyError;
    },
    start: async () => ({ clipboard: true }),
  };
}

function onLinux(t) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  t.after(() => Object.defineProperty(process, "platform", platform));
}

test("a portal paste never reads, saves or restores the user's clipboard", async (t) => {
  onLinux(t);
  const fakeClipboard = strictClipboard();
  const ClipboardManager = loadClipboardManager(fakeClipboard);
  const manager = new ClipboardManager();
  const session = fakeSession();
  manager.portalInput = session;

  const result = await manager.pasteText("dictated text");
  await result.restoreComplete;

  assert.deepEqual(session.calls, [["paste", "dictated text", "shift-insert"]]);
  assert.deepEqual(fakeClipboard.writes, []);
  assert.equal(result.pasted, undefined);
  assert.equal(result.method, "portal-input:shift-insert");
});

test("OPENWHISPR_PORTAL_PASTE_KEYS picks the chord", async (t) => {
  onLinux(t);
  t.after(() => delete process.env.OPENWHISPR_PORTAL_PASTE_KEYS);
  process.env.OPENWHISPR_PORTAL_PASTE_KEYS = "ctrl-v";
  const ClipboardManager = loadClipboardManager(strictClipboard());
  const manager = new ClipboardManager();
  manager.portalInput = fakeSession();
  await manager.pasteText("x");
  assert.deepEqual(manager.portalInput.calls, [["paste", "x", "ctrl-v"]]);
});

test("a failed portal paste leaves the text on the clipboard and says it didn't paste", async (t) => {
  onLinux(t);
  const fakeClipboard = strictClipboard();
  const ClipboardManager = loadClipboardManager(fakeClipboard);
  const manager = new ClipboardManager();
  const session = fakeSession({
    pasteError: Object.assign(new Error("gone"), { code: "keyboard" }),
  });
  manager.portalInput = session;

  const result = await manager.pasteText("dictated text");
  assert.equal(result.pasted, false);
  assert.equal(result.reason, "portal-input-keyboard");
  assert.deepEqual(session.calls.at(-1), ["copy", "dictated text"]);
  assert.deepEqual(fakeClipboard.writes, []);
});

test("when the portal can't copy either, Electron's clipboard gets the text", async (t) => {
  onLinux(t);
  const fakeClipboard = strictClipboard();
  const ClipboardManager = loadClipboardManager(fakeClipboard);
  const manager = new ClipboardManager();
  const denied = Object.assign(new Error("denied"), { code: "denied" });
  manager.portalInput = fakeSession({ pasteError: denied, copyError: denied });

  const result = await manager.pasteText("dictated text");
  assert.equal(result.reason, "portal-input-denied");
  assert.deepEqual(fakeClipboard.writes, [["dictated text", undefined]]);
});

test("without the Clipboard portal, the paste takes the regular path", async (t) => {
  onLinux(t);
  const ClipboardManager = loadClipboardManager(strictClipboard());
  const manager = new ClipboardManager();
  manager.portalInput = fakeSession({
    pasteError: Object.assign(new Error("no"), { code: "clipboard-unavailable" }),
  });
  assert.equal(await manager._pasteViaPortalInput(manager.portalInput, "x"), null);
});

test("copy-to-clipboard goes through the portal session", async (t) => {
  onLinux(t);
  const fakeClipboard = strictClipboard();
  const ClipboardManager = loadClipboardManager(fakeClipboard);
  const manager = new ClipboardManager();
  manager.portalInput = fakeSession();

  assert.deepEqual(await manager.writeClipboard("copied"), { success: true });
  assert.deepEqual(manager.portalInput.calls, [["copy", "copied"]]);
  assert.deepEqual(fakeClipboard.writes, []);
});

test("paste tools report the portal backend as available", (t) => {
  onLinux(t);
  const ClipboardManager = loadClipboardManager(strictClipboard());
  const manager = new ClipboardManager();
  manager.portalInput = fakeSession();
  const tools = manager.checkPasteTools();
  assert.equal(tools.available, true);
  assert.equal(tools.method, "portal-input");
  assert.equal(tools.wlCopyMissing, false);
});

test("outside a Flatpak, nothing changes unless opted in", (t) => {
  onLinux(t);
  const saved = { ...process.env };
  t.after(() => {
    delete process.env.FLATPAK_ID;
    delete process.env.OPENWHISPR_PASTE_BACKEND;
    Object.assign(process.env, saved);
  });
  delete process.env.FLATPAK_ID;
  delete process.env.OPENWHISPR_PASTE_BACKEND;
  const ClipboardManager = loadClipboardManager(strictClipboard());
  const manager = new ClipboardManager();
  assert.equal(manager._getPortalInput(), null);
});
