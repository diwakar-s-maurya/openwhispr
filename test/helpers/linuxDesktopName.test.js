const test = require("node:test");
const assert = require("node:assert/strict");
const { getLinuxDesktopName } = require("../../src/helpers/linuxDesktopName");

test("uses the packaged desktop entry outside Flatpak", () => {
  assert.equal(getLinuxDesktopName({}), "open-whispr.desktop");
});

test("uses the Flatpak app ID inside Flatpak", () => {
  assert.equal(
    getLinuxDesktopName({ FLATPAK_ID: "com.example.OpenWhispr" }),
    "com.example.OpenWhispr.desktop"
  );
});

test("ignores a malformed FLATPAK_ID", () => {
  assert.equal(getLinuxDesktopName({ FLATPAK_ID: "../evil desktop" }), "open-whispr.desktop");
});
