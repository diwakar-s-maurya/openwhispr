// Cloud-only build: packages OpenWhispr without the bundled local-inference
// engines (whisper.cpp, llama-server, sherpa-onnx, Qdrant), their models,
// onnxruntime-node or FFmpeg. Transcription and reasoning then run only through
// cloud providers. The local-model code stays in the app, but there is nothing
// for it to run. The packaged package.json carries
// `openwhisprBuild.cloudOnly: true`, which scripts/afterPack.js reads to skip
// its checks for the left-out binaries.
//
// Useful for distro packages, sandboxed (e.g. Flatpak) builds and audited
// deployments that want a smaller binary surface.
//
//   npm run build:linux:cloud-only
const base = require("./electron-builder.json");

// resources/bin entries that only local inference uses. Anything else in the
// base filter (paste helpers, key listeners, ...) is kept.
const LOCAL_INFERENCE_RESOURCES = new Set([
  "whisper-cpp-*",
  "whisper-server-*",
  "llama-server-*",
  "sherpa-onnx-*",
  "qdrant-*",
  "all-MiniLM-L6-v2/**/*",
  "diarization-models/**/*",
  "whisper-vad/**/*",
  "*.dylib",
  "*.dll",
  "*.so*",
]);

// Node modules that ship native inference runtimes or a prebuilt FFmpeg.
const LOCAL_INFERENCE_MODULES = ["onnxruntime-node", "ffmpeg-static"];

function withoutLocalInference(resource) {
  if (typeof resource !== "object" || resource.from !== "resources/bin/") return resource;
  return { ...resource, filter: resource.filter.filter((p) => !LOCAL_INFERENCE_RESOURCES.has(p)) };
}

module.exports = {
  ...base,
  files: [...base.files, ...LOCAL_INFERENCE_MODULES.map((m) => `!**/node_modules/${m}/**`)],
  asarUnpack: base.asarUnpack.filter(
    (p) => !LOCAL_INFERENCE_MODULES.some((m) => p.includes(`/node_modules/${m}/`))
  ),
  extraResources: base.extraResources.map(withoutLocalInference),
  extraMetadata: { ...base.extraMetadata, openwhisprBuild: { cloudOnly: true } },
};
