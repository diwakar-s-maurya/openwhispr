const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const portalSecret = require("../../src/helpers/portalSecret");

const quiet = { warn() {}, info() {}, debug() {} };
const SECRET = Buffer.alloc(64, 7);

test("the portal secret is used inside a Flatpak on Linux only", () => {
  assert.equal(portalSecret.shouldUsePortalSecret({ FLATPAK_ID: "a.b.C" }, "linux"), true);
  assert.equal(portalSecret.shouldUsePortalSecret({}, "linux"), false);
  assert.equal(portalSecret.shouldUsePortalSecret({ FLATPAK_ID: "a.b.C" }, "darwin"), false);
});

test("readPortalSecret decodes the helper's base64 line", () => {
  const calls = [];
  const secret = portalSecret.readPortalSecret({
    binaryPath: "/bin/helper",
    logger: quiet,
    spawnSyncImpl: (command, args) => {
      calls.push([command, args]);
      return { status: 0, stdout: `${SECRET.toString("base64")}\n`, stderr: "" };
    },
  });
  assert.deepEqual(secret, SECRET);
  assert.deepEqual(calls, [["/bin/helper", ["--secret"]]]);
});

test("readPortalSecret returns null on a failed, denied or too-short answer", () => {
  for (const result of [
    { status: 3, stdout: "", stderr: "RetrieveSecret denied (1)" },
    { status: null, stdout: "", stderr: "", error: new Error("ETIMEDOUT") },
    { status: 0, stdout: Buffer.alloc(8).toString("base64"), stderr: "" },
  ]) {
    assert.equal(
      portalSecret.readPortalSecret({
        binaryPath: "/bin/helper",
        logger: quiet,
        spawnSyncImpl: () => result,
      }),
      null
    );
  }
  assert.equal(portalSecret.readPortalSecret({ binaryPath: null, logger: quiet }), null);
});

// ---- secretCrypto with the keyring and safeStorage unavailable (a Flatpak) ----

function loadSecretCrypto(t, { secret, userData }) {
  const modulePath = require.resolve("../../src/helpers/secretCrypto");
  delete require.cache[modulePath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { getPath: () => userData },
        safeStorage: { isEncryptionAvailable: () => false },
      };
    }
    if (request === "@napi-rs/keyring") {
      return {
        Entry: class {
          getPassword() {
            throw new Error("PermissionDenied");
          }
          setPassword() {
            throw new Error("PermissionDenied");
          }
        },
      };
    }
    if (request === "./portalSecret") {
      return {
        shouldUsePortalSecret: () => true,
        readPortalSecret: () => (secret ? Buffer.from(secret) : null),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
    t.after(() => delete require.cache[modulePath]);
  }
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-secret-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("without a keyring, the portal secret keys the encryption", (t) => {
  const userData = tempDir(t);
  const crypto1 = loadSecretCrypto(t, { secret: SECRET, userData });
  assert.equal(crypto1.isAvailable(), true);
  const blob = crypto1.encrypt("sk-test-123");
  assert.ok(!blob.toString("latin1").includes("sk-test-123"));

  // A later launch, with the same portal secret, reads it back.
  const crypto2 = loadSecretCrypto(t, { secret: SECRET, userData });
  assert.equal(crypto2.decrypt(blob).value, "sk-test-123");
  // No master-key backup is written (safeStorage has no backend).
  assert.equal(fs.existsSync(path.join(userData, "secure-keys", "master-key-backup.enc")), false);

  // A different secret (another app ID, or a reset wallet) can't.
  const other = loadSecretCrypto(t, { secret: Buffer.alloc(64, 9), userData });
  assert.throws(() => other.decrypt(blob));
});

test("with neither keyring nor portal, encryption stays unavailable", (t) => {
  const userData = tempDir(t);
  const crypto1 = loadSecretCrypto(t, { secret: null, userData });
  assert.equal(crypto1.isAvailable(), false);
});
