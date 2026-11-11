// Under native Wayland an app cannot place its own windows: setBounds() keeps
// the size and drops the position, and the compositor decides where the
// dictation overlay goes. To let a compositor-side helper (for example a KWin
// script) honour the user's "panel start position" setting, the overlay title
// carries it as a suffix, e.g. "Voice Recorder [bottom-left]". Under X11 and on
// other platforms the title is left alone.
const PANEL_POSITIONS = new Set(["bottom-right", "center", "bottom-left"]);

function isNativeWayland({ platform = process.platform, ozonePlatform = "" } = {}) {
  return platform === "linux" && String(ozonePlatform).toLowerCase() === "wayland";
}

function withPlacementHint(title, position, enabled) {
  if (!enabled) return title;
  const side = PANEL_POSITIONS.has(position) ? position : "bottom-right";
  return `${title} [${side}]`;
}

module.exports = { PANEL_POSITIONS, isNativeWayland, withPlacementHint };
