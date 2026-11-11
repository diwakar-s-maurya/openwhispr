// Hardened Flatpak build (local.surface.OpenWhispr): the cloud-only build with
// no auto-updater, no publish feed, no bundled .env, and only the portal paste
// helper from resources/bin (the sandbox has no uinput, X11 or /dev/input for
// the others). Packaged as a plain directory; packaging/flatpak/ turns that
// into the Flatpak.
//
//   npm run build:linux:flatpak
const cloudOnly = require("./electron-builder.cloud-only.cjs");

const FLATPAK_BIN = ["linux-portal-input"];

// What each base resource becomes in the Flatpak; null leaves it out.
function flatpakResource(resource) {
  if (resource === ".env") return null; // no bundled .env
  if (typeof resource !== "object") return resource;
  if (/mediaremote/.test(resource.from)) return null; // macOS only
  if (resource.from === "resources/bin/") return { ...resource, filter: FLATPAK_BIN };
  return resource;
}

module.exports = {
  ...cloudOnly,
  publish: null,
  files: [...cloudOnly.files, "!**/node_modules/electron-updater/**"],
  extraResources: cloudOnly.extraResources.map(flatpakResource).filter(Boolean),
  linux: { ...cloudOnly.linux, target: ["dir"] },
  extraMetadata: {
    ...cloudOnly.extraMetadata,
    openwhisprBuild: { ...cloudOnly.extraMetadata.openwhisprBuild, updater: false },
  },
};
