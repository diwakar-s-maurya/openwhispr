const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const KEY = "OPENAI_API_KEY";

function loadEnvironmentManager(t, userData, { encryption }) {
  const environmentPath = require.resolve("../../src/helpers/environment");
  delete require.cache[environmentPath];
  const originalLoad = Module._load;
  const fakeCrypto = {
    isAvailable: () => encryption,
    encrypt: (value) => Buffer.from(`enc:${value}`),
    decrypt: (blob) => ({ value: String(blob).slice(4), needsReencrypt: false }),
  };
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { getPath: () => userData, getAppPath: () => userData, isReady: () => false },
        safeStorage: { isEncryptionAvailable: () => false },
      };
    }
    if (request === "./secretCrypto") return fakeCrypto;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(environmentPath);
  } finally {
    Module._load = originalLoad;
    t.after(() => delete require.cache[environmentPath]);
  }
}

// A key saved while no encryption backend existed: the migration sentinel is
// already there, and the key sits in the userData .env in plain text.
function setUp(t) {
  const saved = process.env[KEY];
  t.after(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });
  delete process.env[KEY];
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ow-env-migrate-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const resourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  process.resourcesPath = userData;
  t.after(() => {
    if (resourcesPath) Object.defineProperty(process, "resourcesPath", resourcesPath);
    else delete process.resourcesPath;
  });
  fs.mkdirSync(path.join(userData, "secure-keys"));
  fs.writeFileSync(path.join(userData, "secure-keys", ".migrated"), "");
  fs.writeFileSync(path.join(userData, ".env"), `${KEY}=sk-plain\nUI_LANGUAGE=en\n`);
  return userData;
}

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("a plaintext key is encrypted once encryption becomes available", async (t) => {
  const userData = setUp(t);
  const EnvironmentManager = loadEnvironmentManager(t, userData, { encryption: true });
  const manager = new EnvironmentManager();
  await manager.init();
  await settle();

  const enc = path.join(userData, "secure-keys", `${KEY}.enc`);
  assert.equal(String(fs.readFileSync(enc)), "enc:sk-plain");
  const env = fs.readFileSync(path.join(userData, ".env"), "utf8");
  assert.ok(!env.includes("sk-plain"), env);
  assert.ok(env.includes("UI_LANGUAGE=en"));
  assert.equal(process.env[KEY], "sk-plain");
});

test("without encryption the plaintext key is left where it is", async (t) => {
  const userData = setUp(t);
  const EnvironmentManager = loadEnvironmentManager(t, userData, { encryption: false });
  const manager = new EnvironmentManager();
  await manager.init();
  await settle();

  assert.equal(fs.existsSync(path.join(userData, "secure-keys", `${KEY}.enc`)), false);
  assert.ok(fs.readFileSync(path.join(userData, ".env"), "utf8").includes(`${KEY}=sk-plain`));
});
