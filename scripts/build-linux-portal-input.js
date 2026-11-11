#!/usr/bin/env node
// Builds resources/bin/linux-portal-input (see resources/linux-portal-input.c).
// Needs gio-2.0 (libglib2.0-dev). Without it the build is skipped and the app
// keeps using its other Linux paste methods.

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { linuxBaselineFlags } = require("./lib/linux-baseline-flags");

if (process.platform !== "linux") {
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");
const cSource = path.join(projectRoot, "resources", "linux-portal-input.c");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "linux-portal-input");
const hashFile = path.join(outputDir, ".linux-portal-input.hash");

function log(message) {
  console.log(`[linux-portal-input] ${message}`);
}

function pkgConfig(...args) {
  try {
    const result = spawnSync("pkg-config", args, { stdio: "pipe" });
    if (result.status === 0) return result.stdout.toString().trim().split(/\s+/).filter(Boolean);
  } catch {}
  return null;
}

if (!fs.existsSync(cSource)) {
  console.error(`[linux-portal-input] C source not found at ${cSource}`);
  process.exit(1);
}

const gioFlags = pkgConfig("--cflags", "--libs", "gio-2.0", "gio-unix-2.0");
if (!gioFlags) {
  log("gio-2.0 not found, skipping (install libglib2.0-dev to build the portal paste helper)");
  process.exit(0);
}

const buildHash = crypto
  .createHash("sha256")
  .update(fs.readFileSync(cSource))
  .update(gioFlags.join(" "))
  .update(linuxBaselineFlags().join(" "))
  .digest("hex");

try {
  if (fs.existsSync(outputBinary) && fs.readFileSync(hashFile, "utf8").trim() === buildHash) {
    process.exit(0);
  }
} catch {}

fs.mkdirSync(outputDir, { recursive: true });

const args = [
  "-O2",
  "-Wall",
  "-Wextra",
  "-Wno-unused-parameter",
  ...linuxBaselineFlags(),
  cSource,
  "-o",
  outputBinary,
  ...gioFlags,
];

let result;
for (const compiler of ["gcc", "cc"]) {
  log(`Compiling with ${[compiler, ...args].join(" ")}`);
  result = spawnSync(compiler, args, { stdio: "inherit", env: process.env });
  if (result.status === 0) break;
}

if (result.status !== 0) {
  console.warn("[linux-portal-input] Compile failed; portal paste helper not built.");
  process.exit(0);
}

fs.chmodSync(outputBinary, 0o755);
fs.writeFileSync(hashFile, buildHash);
log("Successfully built the portal paste helper.");
