#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const appPath = path.resolve(
  repoRoot,
  valueFor("--app", "release/mac-arm64/Plainsong.app")
);
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/qa/macos/capture-meeting-mic.json")
);
const recordMs = Number(valueFor("--record-ms", "3500"));
const timeoutMs = Number(valueFor("--timeout-ms", "90000"));
const inputDeviceId = valueFor("--input-device-id", "")?.trim() ?? "";
const inputDeviceName = valueFor("--input-device-name", "")?.trim() ?? "";
const includeSystemAudio = args.includes("--system-audio");
const expectedCaptureMode = includeSystemAudio ? "me_and_them" : "mic_only";
const sidecarPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "plainsong-sidecar"
);
const dataRoot = process.env.PLAINSONG_DATA_DIR
  ? path.resolve(process.env.PLAINSONG_DATA_DIR)
  : path.join(os.homedir(), "Library", "Application Support");
const configRoot = process.env.PLAINSONG_CONFIG_DIR
  ? path.resolve(process.env.PLAINSONG_CONFIG_DIR)
  : path.join(os.homedir(), "Library", "Application Support");
const dataDir = path.join(dataRoot, "Plainsong");
const configDir = path.join(configRoot, "Plainsong");
const settingsPath = path.join(configDir, "settings.json");
const dbPath = path.join(dataDir, "plainsong.db");
const dbSidecarPaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
const dbBackups = new Map();
const originalSettingsBytes = fs.existsSync(settingsPath)
  ? fs.readFileSync(settingsPath)
  : null;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.platform !== "darwin") {
  fail("capture-packaged-macos-meeting-mic can only run on macOS.");
}

if (!fs.existsSync(sidecarPath)) {
  fail(`Packaged sidecar not found at ${sidecarPath}`);
}

if (!fs.existsSync(dbPath)) {
  fail(`Plainsong database not found at ${dbPath}`);
}

function hashBytes(bytes) {
  if (!bytes) return null;
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function snapshotDbFiles() {
  for (const filePath of dbSidecarPaths) {
    dbBackups.set(filePath, fs.existsSync(filePath) ? fs.readFileSync(filePath) : null);
  }
}

function restoreDbFiles() {
  for (const [filePath, bytes] of dbBackups.entries()) {
    if (bytes) {
      fs.writeFileSync(filePath, bytes);
    } else if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
  }
}

function restoreSettings() {
  if (originalSettingsBytes) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, originalSettingsBytes);
  } else if (fs.existsSync(settingsPath)) {
    fs.rmSync(settingsPath, { force: true });
  }
}

function removeFileIfPresent(filePath) {
  if (typeof filePath === "string" && filePath && fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

function siblingAudioPaths(audioPath) {
  if (typeof audioPath !== "string" || !audioPath) return [];
  const parsed = path.parse(audioPath);
  return [
    path.join(parsed.dir, `${parsed.name}_mic${parsed.ext}`),
    path.join(parsed.dir, `${parsed.name}_system${parsed.ext}`),
  ];
}

function dbHashes() {
  return Object.fromEntries(
    dbSidecarPaths.map((filePath) => [
      filePath,
      fs.existsSync(filePath) ? hashBytes(fs.readFileSync(filePath)) : null,
    ])
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stderrEvidence(chunks) {
  const value = chunks.join("").trim();
  return {
    length: value.length,
    tail: value.slice(-12000),
  };
}

function qaSettings(base) {
  const next = JSON.parse(JSON.stringify(base));
  next.transcription = {
    ...next.transcription,
    enableAutoAnalysis: false,
    meetingAudioStorageMode: "always",
    meetingRetentionPreset: "never",
    meetingRetentionDeleteMode: "audio_only",
  };
  next.audio = {
    ...next.audio,
    captureMicrophone: true,
    captureSystemAudio: includeSystemAudio,
    meetingInputOverrideEnabled: Boolean(inputDeviceId),
    meetingInputDevice: inputDeviceId
      ? {
          deviceId: inputDeviceId,
          deviceName: inputDeviceName || inputDeviceId,
        }
      : next.audio?.meetingInputDevice ?? null,
  };
  return next;
}

function launchSidecar() {
  const child = spawn(sidecarPath, [], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const childExit = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
  });

  const rl = createInterface({ input: child.stdout });
  const pending = new Map();
  const events = [];
  let nextId = 1;
  let didTimeOut = false;

  function sendCommand(method, params = {}) {
    const id = String(nextId++);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
    });
  }

  rl.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.method === "event" && message.params?.event) {
      events.push({
        event: message.params.event,
        payload: message.params.payload,
        receivedAt: new Date().toISOString(),
      });
      return;
    }

    const pendingCommand = pending.get(String(message.id));
    if (!pendingCommand) return;
    pending.delete(String(message.id));

    if (message.error) {
      pendingCommand.reject(new Error(message.error.message ?? String(message.error)));
    } else {
      pendingCommand.resolve(message.result);
    }
  });

  const timeout = setTimeout(() => {
    didTimeOut = true;
    child.kill("SIGTERM");
    for (const { reject, method } of pending.values()) {
      reject(new Error(`Timed out waiting for ${method}`));
    }
    pending.clear();
  }, timeoutMs);

  async function shutdown() {
    clearTimeout(timeout);
    if (child.stdin.writable) {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: String(nextId++),
          method: "shutdown",
          params: {},
        })}\n`
      );
    }
    const result = await Promise.race([
      childExit,
      new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    if (!result) {
      child.kill("SIGTERM");
      return await childExit;
    }
    return result;
  }

  return {
    sendCommand,
    shutdown,
    stderr,
    events,
    didTimeOut: () => didTimeOut,
  };
}

async function writeArtifact(artifact) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(artifact, null, 2));
}

function eventSeen(events, eventName, predicate) {
  return events.some((entry) => {
    if (entry.event !== eventName) return false;
    return predicate(entry.payload ?? {});
  });
}

function relevantEvents(events, recordingId) {
  return events
    .filter((entry) => {
      const payload = entry.payload ?? {};
      return (
        entry.event.startsWith("window:") ||
        payload.recordingId === recordingId ||
        payload.recording_id === recordingId
      );
    })
    .map((entry) => ({
      event: entry.event,
      receivedAt: entry.receivedAt,
      payload: entry.payload,
    }));
}

snapshotDbFiles();

async function run() {
  restoreDbFiles();
  restoreSettings();

  const artifact = {
    generatedAt: new Date().toISOString(),
    appPath,
    sidecarPath,
    dbPath,
    settingsPath,
    recordMs,
    inputDeviceId: inputDeviceId || null,
    inputDeviceName: inputDeviceName || null,
    includeSystemAudio,
    expectedCaptureMode,
    pass: false,
    timedOut: false,
    originalDbHashes: Object.fromEntries(
      [...dbBackups.entries()].map(([filePath, bytes]) => [filePath, hashBytes(bytes)])
    ),
    restoredDbHashes: null,
    originalSettingsHash: hashBytes(originalSettingsBytes),
    restoredSettingsHash: null,
    dbRestored: false,
    settingsRestored: false,
    checks: {},
    recordingId: null,
    recordingAfterStop: null,
    systemAudioVerification: null,
    overlayWhileRecording: null,
    overlayAfterStop: null,
    audioFile: null,
    sidecarAudioFiles: [],
    audioFilesCleaned: false,
    events: [],
    sidecarExit: null,
    stderr: { length: 0, tail: "" },
  };

  const sidecar = launchSidecar();

  try {
    const originalSettings = await sidecar.sendCommand("get_settings", {});
    await sidecar.sendCommand("save_settings", { settings: qaSettings(originalSettings) });

    if (includeSystemAudio) {
      artifact.systemAudioVerification = await sidecar.sendCommand(
        "test_system_audio_capture",
        {},
      );
      if (
        artifact.systemAudioVerification?.capability?.ready !== true ||
        Number(artifact.systemAudioVerification?.callbacks) <= 0 ||
        Number(artifact.systemAudioVerification?.nonSilentFrames) <= 0 ||
        Number(artifact.systemAudioVerification?.detectedToneAmplitude) < 0.005 ||
        artifact.systemAudioVerification?.verificationMethod !== "known_tone"
      ) {
        throw new Error(
          "Packaged system-audio verification did not capture the known tone in this sidecar session.",
        );
      }
    }

    const setup = await sidecar.sendCommand("verify_meeting_setup", {});
    artifact.meetingSetup = setup;
    if (!setup?.ok) {
      throw new Error(`Meeting setup is not ready: ${setup?.summary ?? "unknown"}`);
    }

    const started = await sidecar.sendCommand("start_recording", {
      options: {
        mic: true,
        systemAudio: includeSystemAudio,
        projectId: "inbox",
        template: "meeting",
        meetingNotes: includeSystemAudio
          ? "Packaged QA microphone and system audio capture."
          : "Packaged QA mic-only capture.",
        consentPromptShown: true,
        meetingCaptureMode: expectedCaptureMode,
      },
    });

    artifact.recordingId = started?.recordingId;
    if (!artifact.recordingId) {
      throw new Error("start_recording did not return a recordingId.");
    }

    await sleep(Math.max(1000, recordMs));
    artifact.overlayWhileRecording = await sidecar.sendCommand("get_recording_overlay_state", {});

    await sidecar.sendCommand("stop_recording", { recordingId: artifact.recordingId });
    artifact.overlayAfterStop = await sidecar.sendCommand("get_recording_overlay_state", {});
    artifact.recordingAfterStop = await sidecar.sendCommand("get_recording", {
      recordingId: artifact.recordingId,
    });

    const audioPath = artifact.recordingAfterStop?.audioPath;
    artifact.audioFile =
      typeof audioPath === "string" && audioPath
        ? {
            path: audioPath,
            exists: fs.existsSync(audioPath),
            sizeBytes: fs.existsSync(audioPath) ? fs.statSync(audioPath).size : 0,
          }
        : null;
    artifact.sidecarAudioFiles = siblingAudioPaths(audioPath).map((filePath) => ({
      path: filePath,
      exists: fs.existsSync(filePath),
      sizeBytes: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
    }));

    artifact.events = relevantEvents(sidecar.events, artifact.recordingId);
  } catch (error) {
    artifact.error = error instanceof Error ? error.message : String(error);
    artifact.events = artifact.recordingId
      ? relevantEvents(sidecar.events, artifact.recordingId)
      : sidecar.events.slice(-20);
  } finally {
    artifact.timedOut = sidecar.didTimeOut();
    artifact.stderr = stderrEvidence(sidecar.stderr);
    artifact.sidecarExit = await sidecar.shutdown();
    removeFileIfPresent(artifact.recordingAfterStop?.audioPath);
    for (const file of artifact.sidecarAudioFiles) {
      removeFileIfPresent(file.path);
    }
    restoreDbFiles();
    restoreSettings();
    artifact.audioFilesCleaned = [
      artifact.recordingAfterStop?.audioPath,
      ...artifact.sidecarAudioFiles.map((file) => file.path),
    ]
      .filter(Boolean)
      .every((filePath) => !fs.existsSync(filePath));
    artifact.restoredDbHashes = dbHashes();
    artifact.restoredSettingsHash = fs.existsSync(settingsPath)
      ? hashBytes(fs.readFileSync(settingsPath))
      : null;
    artifact.dbRestored =
      JSON.stringify(artifact.restoredDbHashes) === JSON.stringify(artifact.originalDbHashes);
    artifact.settingsRestored = artifact.restoredSettingsHash === artifact.originalSettingsHash;
  }

  artifact.checks = {
    meetingSetupReady: Boolean(artifact.meetingSetup?.ok),
    systemAudioVerifiedForCombinedCapture:
      !includeSystemAudio ||
      (artifact.systemAudioVerification?.capability?.ready === true &&
        Number(artifact.systemAudioVerification?.callbacks) > 0 &&
        Number(artifact.systemAudioVerification?.nonSilentFrames) > 0 &&
        Number(artifact.systemAudioVerification?.detectedToneAmplitude) >= 0.005 &&
        artifact.systemAudioVerification?.verificationMethod === "known_tone"),
    recordingIdReturned: Boolean(artifact.recordingId),
    overlayEnteredRecording: artifact.overlayWhileRecording?.phase === "recording",
    overlayEnteredTranscribing: artifact.overlayAfterStop?.phase === "transcribing",
    recordingRowPreserved: artifact.recordingAfterStop?.id === artifact.recordingId,
    recordingSourceMeeting: artifact.recordingAfterStop?.sourceType === "meeting",
    captureModeMatches: artifact.recordingAfterStop?.meetingCaptureMode === expectedCaptureMode,
    systemAudioFlagMatches: artifact.overlayWhileRecording?.systemAudioActive === includeSystemAudio,
    recordingStatusProcessing: artifact.recordingAfterStop?.status === "processing",
    audioPathPersisted: Boolean(artifact.recordingAfterStop?.audioPath),
    audioFileExists: Boolean(artifact.audioFile?.exists),
    audioFileHasData: Number(artifact.audioFile?.sizeBytes ?? 0) > 44,
    sidecarAudioFilesMatchMode: includeSystemAudio
      ? artifact.sidecarAudioFiles.length === 2 &&
        artifact.sidecarAudioFiles.every((file) => file.exists && file.sizeBytes > 44)
      : artifact.sidecarAudioFiles.every((file) => !file.exists),
    staleMeetingRouteErrorsAbsent:
      !/Distil-Whisper model not downloaded|Failed to transcribe .*Distil Whisper/i.test(
        artifact.stderr.tail
      ),
    startEventEmitted: eventSeen(
      artifact.events,
      "recording-status-changed",
      (payload) => payload.recordingId === artifact.recordingId && payload.status === "recording"
    ),
    processingEventEmitted: eventSeen(
      artifact.events,
      "recording-status-changed",
      (payload) => payload.recordingId === artifact.recordingId && payload.status === "processing"
    ),
    recordingOverlayShown: eventSeen(
      artifact.events,
      "window:show-recording-overlay",
      () => true
    ),
    recordingOverlayHidden: eventSeen(
      artifact.events,
      "window:hide-recording-overlay",
      () => true
    ),
    audioFilesCleaned: artifact.audioFilesCleaned,
    dbRestored: artifact.dbRestored,
    settingsRestored: artifact.settingsRestored,
  };

  artifact.pass = Boolean(
    !artifact.timedOut &&
      Object.values(artifact.checks).every(Boolean)
  );

  await writeArtifact(artifact);
  process.exit(artifact.pass ? 0 : 1);
}

run().catch(async (error) => {
  restoreDbFiles();
  restoreSettings();
  await writeArtifact({
    generatedAt: new Date().toISOString(),
    appPath,
    sidecarPath,
    pass: false,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
