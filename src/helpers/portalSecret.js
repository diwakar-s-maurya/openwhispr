// This app's own secret from the XDG Secret portal (org.freedesktop.portal.Secret),
// read through `linux-portal-input --secret`.
//
// Inside a Flatpak the desktop keyring (Secret Service) is out of reach, and
// should be: access to it is access to every secret in it. The portal instead
// gives each app ID one random secret, kept in the keyring on the app's behalf.
// secretCrypto derives its master key from it.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const debugLogger = require("./debugLogger");

// Long enough for the keyring's unlock prompt, if the wallet is locked.
const SECRET_TIMEOUT_MS = 60000;

function resolvePortalInputBinary({ resourcesPath = process.resourcesPath } = {}) {
  const candidates = [
    path.join(__dirname, "..", "..", "resources", "bin", "linux-portal-input"),
    resourcesPath && path.join(resourcesPath, "bin", "linux-portal-input"),
    resourcesPath &&
      path.join(resourcesPath, "app.asar.unpacked", "resources", "bin", "linux-portal-input"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function shouldUsePortalSecret(env = process.env, platform = process.platform) {
  return platform === "linux" && Boolean(env.FLATPAK_ID);
}

// Returns the secret as a Buffer, or null when the portal can't provide one.
function readPortalSecret({
  binaryPath = resolvePortalInputBinary(),
  spawnSyncImpl = spawnSync,
  logger = debugLogger,
} = {}) {
  if (!binaryPath) return null;
  const result = spawnSyncImpl(binaryPath, ["--secret"], {
    encoding: "utf8",
    timeout: SECRET_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    logger.warn(
      "Secret portal unavailable",
      { status: result.status, error: result.error?.message, stderr: result.stderr?.trim() },
      "secretCrypto"
    );
    return null;
  }
  const secret = Buffer.from(String(result.stdout).trim(), "base64");
  if (secret.length < 16) {
    logger.warn(
      "Secret portal returned too short a secret",
      { bytes: secret.length },
      "secretCrypto"
    );
    return null;
  }
  return secret;
}

module.exports = { readPortalSecret, resolvePortalInputBinary, shouldUsePortalSecret };
