const test = require("node:test");
const assert = require("node:assert/strict");

const PortalShortcutManager = require("../../src/helpers/portalShortcut");

function fakePortal({ failBind = false, assign = (t) => t } = {}) {
  const portal = {
    binds: [],
    unregistered: 0,
    closed: false,
    onEvent: null,
    async init() {
      return true;
    },
    async bindShortcuts(shortcuts, onEvent) {
      portal.binds.push(shortcuts.map((s) => ({ ...s })));
      if (failBind) throw new Error("Portal request was rejected (1)");
      portal.onEvent = onEvent;
      return new Map(shortcuts.map(({ id, trigger }) => [id, assign(trigger)]));
    },
    async unregisterKeybinding() {
      portal.unregistered += 1;
      portal.onEvent = null;
    },
    async close() {
      portal.closed = true;
    },
  };
  return portal;
}

test("the portal backend is chosen inside a Flatpak or on explicit opt-in only", () => {
  const linux = process.platform === "linux";
  assert.equal(PortalShortcutManager.shouldUse({ FLATPAK_ID: "org.example.App" }), linux);
  assert.equal(PortalShortcutManager.shouldUse({ OPENWHISPR_SHORTCUT_BACKEND: "portal" }), linux);
  assert.equal(PortalShortcutManager.shouldUse({ XDG_CURRENT_DESKTOP: "KDE" }), false);
  assert.equal(PortalShortcutManager.shouldUse({}), false);
});

test("a shortcut is bound in the portal's trigger format", async () => {
  const portal = fakePortal();
  const manager = new PortalShortcutManager({ portal });

  assert.equal(
    await manager.registerKeybinding("Control+Super+Space", "dictation", () => {}),
    true
  );
  assert.deepEqual(portal.binds.at(-1), [
    { id: "dictation", description: "Start or stop dictation", trigger: "CTRL+LOGO+space" },
  ]);
  assert.deepEqual([...manager.registeredSlots], ["dictation"]);
});

test("modifier-only shortcuts are refused without touching the portal", async () => {
  const portal = fakePortal();
  const manager = new PortalShortcutManager({ portal });

  assert.equal(
    await manager.registerKeybinding("Control+Super", "dictation", () => {}),
    "modifier-only"
  );
  assert.equal(portal.binds.length, 0);
});

test("every slot is rebound together, and unregistering keeps the others", async () => {
  const portal = fakePortal();
  const manager = new PortalShortcutManager({ portal });

  await manager.registerKeybinding("Control+Super+Space", "dictation", () => {});
  await manager.registerKeybinding("Alt+Escape", "cancel", () => {});
  assert.deepEqual(
    portal.binds.at(-1).map((s) => [s.id, s.trigger]),
    [
      ["dictation", "CTRL+LOGO+space"],
      ["cancel", "ALT+Escape"],
    ]
  );

  await manager.unregisterKeybinding("cancel");
  assert.deepEqual(
    portal.binds.at(-1).map((s) => s.id),
    ["dictation"]
  );
  assert.deepEqual([...manager.registeredSlots], ["dictation"]);

  await manager.unregisterKeybinding("dictation");
  assert.equal(portal.unregistered, 1);
  assert.equal(manager.registeredSlots.size, 0);
});

test("dictation gets press and release; other slots only press", async () => {
  const portal = fakePortal();
  const manager = new PortalShortcutManager({ portal });
  const seen = [];
  const logged = [];
  manager.onHotkeyEvent = (slot, phase) => logged.push(`${slot}:${phase}`);

  await manager.registerKeybinding("F9", "dictation", (_h, phase) =>
    seen.push(`dictation:${phase}`)
  );
  await manager.registerKeybinding("Alt+Escape", "cancel", (_h, phase) =>
    seen.push(`cancel:${phase}`)
  );

  for (const [slot, phase] of [
    ["dictation", "down"],
    ["dictation", "up"],
    ["cancel", "down"],
    ["cancel", "up"],
    ["unknown", "down"],
  ]) {
    portal.onEvent(slot, phase);
  }

  assert.deepEqual(seen, ["dictation:down", "dictation:up", "cancel:down"]);
  assert.deepEqual(logged, ["dictation:down", "dictation:up", "cancel:down", "cancel:up"]);
});

test("a rejected binding reports failure and restores the previous slots", async () => {
  const portal = fakePortal();
  const manager = new PortalShortcutManager({ portal });
  await manager.registerKeybinding("F9", "dictation", () => {});

  portal.bindShortcuts = async (shortcuts) => {
    portal.binds.push(shortcuts);
    if (shortcuts.some((s) => s.id === "cancel")) throw new Error("rejected");
    return new Map(shortcuts.map(({ id, trigger }) => [id, trigger]));
  };
  assert.equal(await manager.registerKeybinding("Alt+Escape", "cancel", () => {}), false);
  assert.deepEqual(
    portal.binds.at(-1).map((s) => s.id),
    ["dictation"]
  );
  assert.deepEqual([...manager.registeredSlots], ["dictation"]);
});

test("the trigger the desktop actually assigned is remembered", async () => {
  const portal = fakePortal({ assign: () => "Meta+Ctrl+Space" });
  const manager = new PortalShortcutManager({ portal });
  await manager.registerKeybinding("Control+Super+Space", "dictation", () => {});
  assert.equal(manager.assignedTriggers.get("dictation"), "Meta+Ctrl+Space");
});

test("close drops every slot and closes the portal", async () => {
  const portal = fakePortal();
  const manager = new PortalShortcutManager({ portal });
  await manager.registerKeybinding("F9", "dictation", () => {});
  manager.close();
  await new Promise((r) => setImmediate(r));
  assert.equal(portal.closed, true);
  assert.equal(manager.registeredSlots.size, 0);
});

test("changes made while a rebind is queued share one portal session", async () => {
  const portal = fakePortal();
  const manager = new PortalShortcutManager({ portal });

  const results = await Promise.all([
    manager.registerKeybinding("Control+Super+Space", "dictation", () => {}),
    manager.registerKeybinding("Escape", "cancel", () => {}),
  ]);

  assert.deepEqual(results, [true, true]);
  assert.equal(portal.binds.length, 1);
  assert.deepEqual(
    portal.binds[0].map((s) => s.id),
    ["dictation", "cancel"]
  );
  assert.deepEqual([...manager.registeredSlots], ["dictation", "cancel"]);
});
