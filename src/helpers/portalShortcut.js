// Global shortcuts through the XDG Desktop Portal (org.freedesktop.portal.GlobalShortcuts).
//
// Used inside a Flatpak, where KGlobalAccel, GNOME's custom-keybinding settings
// and Hyprland's socket are out of reach (and should be: talking to KGlobalAccel
// would let a sandboxed app grab any shortcut on the desktop). The portal asks
// the user once, remembers the binding per app ID, and reports press and release,
// so Tap and Hold both work. It cannot bind modifier-only shortcuts.
//
// Implements the same interface as KDEShortcutManager, so HotkeyManager drives it
// through its native-manager code path.
const debugLogger = require("./debugLogger");
const GnomeGlobalShortcutsPortal = require("./gnomeGlobalShortcutsPortal");
const GnomeShortcutManager = require("./gnomeShortcut");

const SLOT_DESCRIPTIONS = {
  dictation: "Start or stop dictation",
  cancel: "Cancel dictation",
};

class PortalShortcutManager {
  // Inside a Flatpak the portal is the only way to get a global shortcut.
  // OPENWHISPR_SHORTCUT_BACKEND=portal opts in elsewhere (e.g. a native-Wayland
  // session on a desktop without a dedicated backend).
  static shouldUse(env = process.env) {
    if (process.platform !== "linux") return false;
    return Boolean(env.FLATPAK_ID) || env.OPENWHISPR_SHORTCUT_BACKEND === "portal";
  }

  constructor({ portal = new GnomeGlobalShortcutsPortal() } = {}) {
    this.portal = portal;
    this.slots = new Map(); // slotName -> { trigger, callback }
    this.assignedTriggers = new Map(); // slotName -> what the desktop actually bound
    this.onHotkeyEvent = null;
    this.pending = Promise.resolve(); // the last rebind, running or queued
    this.queued = null; // a rebind waiting to start, shared by later callers
  }

  // HotkeyManager reads this, like KDEShortcutManager's field.
  get registeredSlots() {
    return new Set(this.assignedTriggers.keys());
  }

  async init() {
    const ok = await this.portal.init();
    debugLogger.log("[PortalShortcut] Global Shortcuts portal available:", ok);
    return ok;
  }

  // Returns true, "modifier-only", or false, like KDEShortcutManager.
  async registerKeybinding(electronHotkey, slotName = "dictation", callback, isPushToTalk = false) {
    const trigger = GnomeShortcutManager.convertToPortalFormat(electronHotkey);
    if (!trigger) {
      debugLogger.log("[PortalShortcut] Modifier-only or empty shortcut cannot be bound", {
        slot: slotName,
        hotkey: electronHotkey,
        isPushToTalk,
      });
      return "modifier-only";
    }

    const previous = this.slots.get(slotName);
    this.slots.set(slotName, { trigger, callback });
    const ok = await this._rebind();
    if (!ok) {
      if (previous) this.slots.set(slotName, previous);
      else this.slots.delete(slotName);
      await this._rebind();
      return false;
    }
    debugLogger.log("[PortalShortcut] Registered", {
      slot: slotName,
      requested: trigger,
      assigned: this.assignedTriggers.get(slotName),
    });
    return true;
  }

  async unregisterKeybinding(slotName = "dictation") {
    if (!this.slots.delete(slotName)) return;
    await this._rebind();
    debugLogger.log("[PortalShortcut] Unregistered", { slot: slotName });
  }

  // KGlobalAccel kept a retired "agent" action around; portal bindings are per
  // session, so there is nothing to clean up.
  async removeRetiredAgentKeybinding() {}

  close() {
    this.slots.clear();
    this.assignedTriggers.clear();
    this.portal.close().catch(() => {});
  }

  // The portal binds a whole set of shortcuts per session, so every change
  // rebinds all slots in a fresh session. Runs are serialised, and changes made
  // while one is queued share it: startup registers several slots in a row, and a
  // hotkey change unregisters then registers, each of which would otherwise open
  // (and may prompt for) a session of its own.
  _rebind() {
    if (this.queued) return this.queued;
    const run = async () => {
      this.queued = null;
      if (this.slots.size === 0) {
        await this.portal.unregisterKeybinding();
        this.assignedTriggers.clear();
        return true;
      }
      const shortcuts = [...this.slots].map(([id, { trigger }]) => ({
        id,
        description: SLOT_DESCRIPTIONS[id] || `OpenWhispr ${id}`,
        trigger,
      }));
      try {
        const bound = await this.portal.bindShortcuts(shortcuts, (slotName, phase) =>
          this._dispatch(slotName, phase)
        );
        this.assignedTriggers = bound;
        return true;
      } catch (err) {
        debugLogger.log("[PortalShortcut] Binding failed:", err.message);
        this.assignedTriggers.clear();
        return false;
      }
    };
    this.queued = this.pending.then(run, run);
    this.pending = this.queued;
    return this.queued;
  }

  // Same delivery as KDEShortcutManager: every slot gets "down"; only dictation
  // gets "up" (Hold needs it, the other slots are taps).
  _dispatch(slotName, phase) {
    const slot = this.slots.get(slotName);
    if (!slot) return;
    this.onHotkeyEvent?.(slotName, phase);
    if (phase === "up" && slotName !== "dictation") return;
    slot.callback?.(undefined, phase);
  }
}

module.exports = PortalShortcutManager;
