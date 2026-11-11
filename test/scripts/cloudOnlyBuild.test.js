const test = require("node:test");
const assert = require("node:assert/strict");

const base = require("../../electron-builder.json");
const cloudOnly = require("../../electron-builder.cloud-only.cjs");
const { isCloudOnlyBuild } = require("../../scripts/afterPack");

const binFilter = (config) => config.extraResources.find((r) => r.from === "resources/bin/").filter;

test("cloud-only build leaves local inference engines and models out of resources/bin", () => {
  const filter = binFilter(cloudOnly);
  for (const pattern of [
    "whisper-cpp-*",
    "whisper-server-*",
    "llama-server-*",
    "sherpa-onnx-*",
    "qdrant-*",
    "all-MiniLM-L6-v2/**/*",
    "diarization-models/**/*",
    "whisper-vad/**/*",
    "*.so*",
  ]) {
    assert.ok(binFilter(base).includes(pattern), `base config should still ship ${pattern}`);
    assert.ok(!filter.includes(pattern), `cloud-only should not ship ${pattern}`);
  }
});

test("cloud-only build keeps the non-inference helpers", () => {
  const filter = binFilter(cloudOnly);
  for (const pattern of ["linux-fast-paste", "linux-key-listener*", "macos-fast-paste"]) {
    assert.ok(filter.includes(pattern), `cloud-only should keep ${pattern}`);
  }
});

test("cloud-only build excludes onnxruntime-node and ffmpeg-static", () => {
  assert.ok(cloudOnly.files.includes("!**/node_modules/onnxruntime-node/**"));
  assert.ok(cloudOnly.files.includes("!**/node_modules/ffmpeg-static/**"));
  assert.ok(!cloudOnly.asarUnpack.some((p) => p.includes("onnxruntime-node")));
  assert.ok(!cloudOnly.asarUnpack.some((p) => p.includes("ffmpeg-static")));
  assert.ok(cloudOnly.asarUnpack.includes("**/node_modules/better-sqlite3/**/*"));
});

test("cloud-only build marks itself in package metadata and leaves the base config alone", () => {
  assert.deepEqual(cloudOnly.extraMetadata.openwhisprBuild, { cloudOnly: true });
  assert.equal(base.extraMetadata.openwhisprBuild, undefined);
  assert.equal(cloudOnly.appId, base.appId);
});

test("afterPack recognises a cloud-only build only from its metadata", () => {
  const ctx = (extraMetadata) => ({ packager: { config: { extraMetadata } } });
  assert.equal(isCloudOnlyBuild(ctx(cloudOnly.extraMetadata)), true);
  assert.equal(isCloudOnlyBuild(ctx(base.extraMetadata)), false);
  assert.equal(isCloudOnlyBuild({}), false);
});
