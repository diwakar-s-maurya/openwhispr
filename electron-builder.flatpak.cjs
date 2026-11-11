// Hardened Flatpak build (local.surface.OpenWhispr): the cloud-only build with
// no auto-updater, no publish feed, no bundled .env, and only the portal paste
// helper from resources/bin (the sandbox has no uinput, X11 or /dev/input for
// the others). Packaged as a plain directory; packaging/flatpak/ turns that
// into the Flatpak.
//
//   npm run build:linux:flatpak
const cloudOnly = require("./electron-builder.cloud-only.cjs");

const FLATPAK_BIN = ["linux-portal-input"];

function flatpakResource(resource) {
  if (typeof resource === "object" && resource.from === "resources/bin/") {
    return { ...resource, filter: FLATPAK_BIN };
  }
  return resource;
}

module.exports = {
  ...cloudOnly,
  publish: null,
  files: [...cloudOnly.files, "!**/node_modules/electron-updater/**"],
  extraResources: cloudOnly.extraResources
    // No bundled .env, and no macOS MediaRemote helper.
    .filter((r) => r !== ".env" && !(typeof r === "object" && /mediaremote/.test(r.from)))
    .map(flatpakResource),
  linux: { ...cloudOnly.linux, target: ["dir"] },
  extraMetadata: {
    ...cloudOnly.extraMetadata,
    openwhisprBuild: { ...cloudOnly.extraMetadata.openwhisprBuild, updater: false, flatpak: true },
  },
};
