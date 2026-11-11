const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

async function createManager(t) {
  const { AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-stop-tail-test-",
    settingsKey: "__stopTailSettings",
    settings: { cloudTranscriptionMode: "byok", isSignedIn: false },
  });
  const recorder = {
    state: "recording",
    stops: 0,
    stop() {
      this.stops += 1;
      this.state = "inactive";
    },
  };
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    micRecovery: { stop() {} },
    mediaRecorder: recorder,
    isRecording: true,
    isStreaming: false,
  });
  return { manager, recorder };
}

test("recording runs on for the tail after a stop, so the last word is kept", async (t) => {
  const { manager, recorder } = await createManager(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });

  assert.equal(manager.stopRecording(), true);
  assert.equal(recorder.stops, 0);
  t.mock.timers.tick(399);
  assert.equal(recorder.stops, 0);
  t.mock.timers.tick(1);
  assert.equal(recorder.stops, 1);
});

test("a second stop inside the tail doesn't stop twice or extend it", async (t) => {
  const { manager, recorder } = await createManager(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });

  manager.stopRecording();
  t.mock.timers.tick(200);
  assert.equal(manager.stopRecording(), true);
  t.mock.timers.tick(200);
  assert.equal(recorder.stops, 1);
  t.mock.timers.tick(1000);
  assert.equal(recorder.stops, 1);
});

test("a cancel inside the tail drops the pending stop", async (t) => {
  const { manager, recorder } = await createManager(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  manager.stopRecording();
  manager._cancelActivationCapture = () => {};
  manager._takeActivationCapture = () => null;
  // Only the timer handling at the top of cancelRecording is under test.
  manager._rotatingBatchRecorder = {};
  manager.cancelRecording();
  t.mock.timers.tick(1000);
  assert.equal(recorder.stops, 0);
});
