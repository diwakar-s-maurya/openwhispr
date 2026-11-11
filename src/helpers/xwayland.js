// Overlay positioning and globalShortcut both need X11, so every Linux Wayland
// session runs under XWayland. Packaged builds apply the same rule from the
// launcher script (scripts/lib/linux-launcher.js); keep the two in sync.

const OZONE_PLATFORM_PREFIX = "--ozone-platform=";
const XWAYLAND_FLAG = `${OZONE_PLATFORM_PREFIX}x11`;

function shouldForceXWayland(argv) {
  return (
    process.platform === "linux" &&
    process.env.XDG_SESSION_TYPE === "wayland" &&
    !argv.some((arg) => arg.startsWith(OZONE_PLATFORM_PREFIX))
  );
}

// True when the app was started on Wayland directly (--ozone-platform=wayland),
// e.g. by a Flatpak launcher. Windows can't place themselves there.
function isNativeWayland({ platform = process.platform, ozonePlatform = "" } = {}) {
  return platform === "linux" && String(ozonePlatform).toLowerCase() === "wayland";
}

module.exports = { OZONE_PLATFORM_PREFIX, XWAYLAND_FLAG, isNativeWayland, shouldForceXWayland };
