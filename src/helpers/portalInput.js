// Pastes through one long-lived XDG RemoteDesktop portal session with the
// Clipboard portal attached (resources/linux-portal-input.c).
//
// The helper starts on first use and stays up for the life of the app, so the
// desktop asks for permission once (then never again while the restore token is
// valid) and shows its "remote control" notice once per launch rather than once
// per paste. The session owns the clipboard selection itself, so the paste works
// while an unfocused window can't write the clipboard (KWin), and the app never
// needs to read the clipboard: there is nothing to save or restore.
//
// Used inside a Flatpak, where it is the only way to type into other apps, or
// elsewhere with OPENWHISPR_PASTE_BACKEND=portal-input.
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const debugLogger = require("./debugLogger");

const PASTE_KEYS = new Set(["shift-insert", "ctrl-v", "ctrl-shift-v"]);
// The first start may wait on the permission dialog.
const FIRST_START_TIMEOUT_MS = 125000;
const RESTORED_START_TIMEOUT_MS = 10000;
const COMMAND_TIMEOUT_MS = 5000;
// Helper exit codes (see linux-portal-input.c).
// Only "denied" stops further prompts; after a timeout the next paste asks again.
const EXIT_REASONS = { 1: "no-session-bus", 2: "unavailable", 3: "denied", 5: "timeout" };

function portalInputError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

class PortalInputSession {
  static shouldUse(env = process.env, platform = process.platform) {
    if (platform !== "linux") return false;
    return Boolean(env.FLATPAK_ID) || env.OPENWHISPR_PASTE_BACKEND === "portal-input";
  }

  constructor({ binaryPath, tokenPath, spawnImpl = spawn, logger = debugLogger }) {
    this.binaryPath = binaryPath;
    this.tokenPath = tokenPath;
    this.spawnImpl = spawnImpl;
    this.logger = logger;
    this.child = null;
    this.starting = null;
    this.waiters = [];
    this.clipboardEnabled = false;
    // A refused permission dialog isn't asked again until the app restarts.
    this.denied = false;
  }

  _readToken() {
    try {
      return fs.readFileSync(this.tokenPath, "utf8").trim();
    } catch {
      return "";
    }
  }

  _saveToken(token) {
    try {
      fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.tokenPath, token, { mode: 0o600 });
      fs.chmodSync(this.tokenPath, 0o600);
    } catch (err) {
      this.logger.warn("Failed to save portal input token", { error: err.message }, "clipboard");
    }
  }

  start() {
    if (this.denied) return Promise.reject(portalInputError("denied"));
    if (this.starting) return this.starting;

    const token = this._readToken();
    const startedAt = Date.now();
    const child = this.spawnImpl(this.binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORTAL_INPUT_RESTORE_TOKEN: token },
    });
    this.child = child;

    const starting = new Promise((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(
        () => {
          reject(portalInputError("timeout", "portal session did not start"));
          child.kill("SIGKILL");
        },
        token ? RESTORED_START_TIMEOUT_MS : FIRST_START_TIMEOUT_MS
      );

      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        const space = line.indexOf(" ");
        const kind = space === -1 ? line : line.slice(0, space);
        const rest = space === -1 ? "" : line.slice(space + 1);
        if (kind === "TOKEN") {
          this._saveToken(rest);
        } else if (kind === "READY") {
          ready = true;
          clearTimeout(timer);
          this.clipboardEnabled = rest.includes("clipboard=1");
          this.logger.info(
            "Portal input session ready",
            {
              elapsedMs: Date.now() - startedAt,
              clipboard: this.clipboardEnabled,
              restored: Boolean(token),
            },
            "clipboard"
          );
          resolve({ clipboard: this.clipboardEnabled });
        } else if (kind === "OK" || kind === "ERR") {
          const waiter = this.waiters.shift();
          if (!waiter) return;
          clearTimeout(waiter.timer);
          if (kind === "OK") waiter.resolve();
          else {
            const [code, ...detail] = rest.split(" ");
            waiter.reject(portalInputError(code || "error", detail.join(" ") || code));
          }
        } else if (kind === "CLOSED") {
          this.logger.info("Portal input session closed by the desktop", {}, "clipboard");
        }
      });
      readline
        .createInterface({ input: child.stderr })
        .on("line", (line) => this.logger.debug("linux-portal-input", { line }, "clipboard"));

      const onGone = (code, error) => {
        clearTimeout(timer);
        if (this.child === child) {
          this.child = null;
          this.starting = null;
        }
        const reason = error ? "spawn-failed" : EXIT_REASONS[code] || "closed";
        if (!ready && reason === "denied") this.denied = true;
        for (const waiter of this.waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(portalInputError("closed", "portal session ended"));
        }
        this.logger.info("Portal input helper exited", { code, reason }, "clipboard");
        if (!ready) reject(portalInputError(reason, error?.message || reason));
      };
      child.on("exit", (code) => onGone(code));
      child.on("error", (error) => onGone(null, error));
    });
    // A failed start is retried on the next paste.
    starting.catch(() => {});
    this.starting = starting;
    return starting;
  }

  async _send(command, payload) {
    await this.start();
    const child = this.child;
    if (!child) throw portalInputError("closed", "portal session ended");
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(portalInputError("timeout", `${command.split(" ")[0]} timed out`));
        // Replies are matched by order; after a lost one, start over.
        child.kill("SIGKILL");
      }, COMMAND_TIMEOUT_MS);
      this.waiters.push(waiter);
      child.stdin.write(`${command} ${Buffer.from(payload, "utf8").toString("base64")}\n`);
    });
  }

  // Puts the text on the clipboard and presses the paste chord in the focused app.
  paste(text, keys = "shift-insert") {
    if (!PASTE_KEYS.has(keys)) throw new Error(`unknown paste keys: ${keys}`);
    return this._send(`PASTE ${keys}`, text);
  }

  // Puts the text on the clipboard only.
  copy(text) {
    return this._send("COPY", text);
  }

  close() {
    const child = this.child;
    this.child = null;
    this.starting = null;
    if (child) {
      try {
        child.stdin.end("QUIT\n");
      } catch {}
    }
  }
}

module.exports = { PortalInputSession, PASTE_KEYS };
