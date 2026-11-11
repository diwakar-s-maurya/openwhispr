// The Wayland app_id (and the X11 WM_CLASS) Electron derives from
// app.setDesktopName(). Desktops match it against .desktop file names to pick a
// window icon and taskbar entry. Inside a Flatpak the desktop entry is named
// after the app ID, which the runtime exports as FLATPAK_ID.
const PACKAGED_DESKTOP_NAME = "open-whispr.desktop";

function getLinuxDesktopName(env = process.env) {
  const flatpakId = String(env.FLATPAK_ID || "").trim();
  return /^[A-Za-z0-9_.-]+$/.test(flatpakId) ? `${flatpakId}.desktop` : PACKAGED_DESKTOP_NAME;
}

module.exports = { PACKAGED_DESKTOP_NAME, getLinuxDesktopName };
