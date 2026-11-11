const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const windowConfig = require("../../src/helpers/windowConfig");

const CONFIGS = [
  "MAIN_WINDOW_CONFIG",
  "AGENT_WINDOW_CONFIG",
  "CONTROL_PANEL_CONFIG",
  "NOTIFICATION_WINDOW_CONFIG",
];

for (const name of CONFIGS) {
  test(`${name} runs its renderer sandboxed and isolated`, () => {
    const prefs = windowConfig[name].webPreferences;
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegration, false);
    assert.notEqual(prefs.nodeIntegrationInSubFrames, true);
    assert.notEqual(prefs.webviewTag, true);
    assert.notEqual(prefs.allowRunningInsecureContent, true);
  });
}

// A sandboxed preload can require only a few Electron modules; anything else
// would break every window at startup.
test("the shared preload requires only what a sandboxed preload can", () => {
  const preload = fs.readFileSync(path.join(__dirname, "../../preload.js"), "utf8");
  const required = [...preload.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(required)], ["electron"]);
  const electronNames = preload
    .match(/const\s*\{([^}]+)\}\s*=\s*require\(\s*["']electron["']\s*\)/)[1]
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  for (const name of electronNames) {
    assert.ok(
      [
        "contextBridge",
        "ipcRenderer",
        "webFrame",
        "webUtils",
        "crashReporter",
        "nativeImage",
      ].includes(name),
      name
    );
  }
});
