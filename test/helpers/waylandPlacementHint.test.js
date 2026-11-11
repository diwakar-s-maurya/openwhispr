const test = require("node:test");
const assert = require("node:assert/strict");
const { isNativeWayland, withPlacementHint } = require("../../src/helpers/waylandPlacementHint");

test("detects native Wayland only on Linux with the wayland ozone platform", () => {
  assert.equal(isNativeWayland({ platform: "linux", ozonePlatform: "wayland" }), true);
  assert.equal(isNativeWayland({ platform: "linux", ozonePlatform: "x11" }), false);
  assert.equal(isNativeWayland({ platform: "linux", ozonePlatform: "" }), false);
  assert.equal(isNativeWayland({ platform: "darwin", ozonePlatform: "wayland" }), false);
});

test("appends the panel position when enabled", () => {
  assert.equal(
    withPlacementHint("Voice Recorder", "bottom-left", true),
    "Voice Recorder [bottom-left]"
  );
  assert.equal(withPlacementHint("Voice Recorder", "center", true), "Voice Recorder [center]");
});

test("falls back to bottom-right for unknown positions", () => {
  assert.equal(withPlacementHint("Voice Recorder", "top", true), "Voice Recorder [bottom-right]");
  assert.equal(
    withPlacementHint("Voice Recorder", undefined, true),
    "Voice Recorder [bottom-right]"
  );
});

test("leaves the title alone when disabled", () => {
  assert.equal(withPlacementHint("Voice Recorder", "bottom-left", false), "Voice Recorder");
});
