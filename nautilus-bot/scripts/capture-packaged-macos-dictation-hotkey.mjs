#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
  valueFor("--out", "artifacts/qa/macos/capture-dictation-hotkey.json")
);
const recordMs = Number(valueFor("--record-ms", "2600"));
const timeoutMs = Number(valueFor("--timeout-ms", "120000"));
const settleMs = Number(valueFor("--settle-ms", "2500"));
const sidecarPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "plainsong-sidecar"
);
const appExecutablePath = path.join(appPath, "Contents", "MacOS", "Plainsong");
const configDir = path.join(os.homedir(), "Library", "Application Support", "Plainsong");
const settingsPath = path.join(configDir, "settings.json");
const dbPath = path.join(configDir, "plainsong.db");
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
  fail("capture-packaged-macos-dictation-hotkey can only run on macOS.");
}
if (!fs.existsSync(sidecarPath)) {
  fail(`Packaged sidecar not found at ${sidecarPath}`);
}
if (!fs.existsSync(appExecutablePath)) {
  fail(`Packaged app executable not found at ${appExecutablePath}`);
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

function runCommand(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed: ${result.stderr || result.stdout}`
    );
  }
  return result.stdout.trim();
}

function runSqlJson(sql) {
  const stdout = runCommand("sqlite3", ["-json", dbPath, sql]);
  return stdout ? JSON.parse(stdout) : [];
}

function latestDictationRecording() {
  return (
    runSqlJson(`
SELECT
  recordings.id,
  recordings.title,
  recordings.source_type AS sourceType,
  recordings.status,
  recordings.duration,
  recordings.created_at AS createdAt,
  transcripts.full_text AS transcriptText,
  transcripts.model_id AS modelId,
  transcripts.requested_provider AS requestedProvider,
  transcripts.actual_provider AS actualProvider
FROM recordings
LEFT JOIN transcripts ON transcripts.recording_id = recordings.id
WHERE recordings.source_type = 'dictation'
ORDER BY recordings.created_at DESC
LIMIT 1;
`)[0] ?? null
  );
}

function latestInsertionAction(recordingId) {
  if (!recordingId) return null;
  const escaped = String(recordingId).replaceAll("'", "''");
  return (
    runSqlJson(`
SELECT
  recording_id AS recordingId,
  requested_mode AS requestedMode,
  actual_mode AS actualMode,
  pasted,
  copied,
  failed,
  error,
  created_at AS createdAt
FROM insertion_actions
WHERE recording_id = '${escaped}'
ORDER BY created_at DESC
LIMIT 1;
`)[0] ?? null
  );
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
  next.shortcuts = {
    ...next.shortcuts,
    toggleDictation: "Cmd+Shift+Space",
  };
  next.transcription = {
    ...next.transcription,
    dictationPushToTalk: false,
    dictationHandsFreeEnabled: false,
    dictationLivePreviewEnabled: true,
    dictationCopyToClipboard: true,
    dictationSaveToInbox: true,
    dictationAiFormatting: false,
    dictationCommandModeEnabled: false,
    dictationInsertionMode: "clipboard_only",
    dictationContextSource: "none",
    dictationModePreset: "voice",
    dictationRoutePreference: "local",
    dictationSilenceTimeoutSeconds: 0,
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
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const rl = createInterface({ input: child.stdout });
  const pending = new Map();
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
    didTimeOut: () => didTimeOut,
  };
}

function launchApp() {
  const stderr = [];
  const stdout = [];
  const child = spawn(appExecutablePath, [], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: "1",
      PLAINSONG_QA_PACKAGED_HOTKEY: "1",
    },
  });
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const childExit = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, childExit, stdout, stderr };
}

async function waitForLog(chunks, pattern, deadlineMs) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (pattern.test(chunks.join(""))) return true;
    await sleep(250);
  }
  return false;
}

function pressDictationShortcut() {
  runCommand("osascript", [
    "-e",
    'tell application "System Events" to key code 49 using {command down, shift down}',
  ]);
}

async function waitForCompletedDictation(previousId, deadlineMs) {
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < deadlineMs) {
    latest = latestDictationRecording();
    if (
      latest &&
      latest.id !== previousId &&
      latest.sourceType === "dictation" &&
      latest.status === "completed"
    ) {
      return latest;
    }
    await sleep(1000);
  }
  return latest;
}

async function quitApp(appRun) {
  if (!appRun?.child || appRun.child.killed) {
    return null;
  }
  try {
    runCommand("osascript", [
      "-e",
      'tell application id "com.plainsong.app" to quit',
    ]);
  } catch {
    appRun.child.kill("SIGTERM");
  }
  const result = await Promise.race([
    appRun.childExit,
    new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
  if (!result && !appRun.child.killed) {
    appRun.child.kill("SIGTERM");
    return await appRun.childExit;
  }
  return result;
}

async function writeArtifact(artifact) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(artifact, null, 2));
}

snapshotDbFiles();

async function run() {
  restoreDbFiles();
  restoreSettings();

  const previousRecording = latestDictationRecording();
  const artifact = {
    generatedAt: new Date().toISOString(),
    appPath,
    appExecutablePath,
    sidecarPath,
    dbPath,
    settingsPath,
    recordMs,
    settleMs,
    pass: false,
    previousRecordingId: previousRecording?.id ?? null,
    newRecording: null,
    insertionAction: null,
    originalDbHashes: Object.fromEntries(
      [...dbBackups.entries()].map(([filePath, bytes]) => [filePath, hashBytes(bytes)])
    ),
    restoredDbHashes: null,
    originalSettingsHash: hashBytes(originalSettingsBytes),
    restoredSettingsHash: null,
    dbRestored: false,
    settingsRestored: false,
    checks: {},
    appExit: null,
    appStdout: { length: 0, tail: "" },
    appStderr: { length: 0, tail: "" },
    setupSidecarExit: null,
    setupSidecarStderr: { length: 0, tail: "" },
  };

  const setupSidecar = launchSidecar();
  let appRun = null;

  try {
    const originalSettings = await setupSidecar.sendCommand("get_settings", {});
    await setupSidecar.sendCommand("save_settings", { settings: qaSettings(originalSettings) });
    artifact.dictationSetup = await setupSidecar.sendCommand("verify_dictation_setup", {});
    if (!artifact.dictationSetup?.ok) {
      throw new Error(
        `Dictation setup is not ready: ${artifact.dictationSetup?.summary ?? "unknown"}`
      );
    }
    artifact.setupSidecarExit = await setupSidecar.shutdown();
    artifact.setupSidecarStderr = stderrEvidence(setupSidecar.stderr);

    appRun = launchApp();
    const shortcutRegistered = await waitForLog(
      appRun.stdout,
      /registered dictation shortcut/i,
      15000
    );
    artifact.shortcutRegistered = shortcutRegistered;
    if (!shortcutRegistered) {
      throw new Error("Packaged app did not report dictation shortcut registration.");
    }

    await sleep(settleMs);
    pressDictationShortcut();
    await sleep(Math.max(1000, recordMs));
    pressDictationShortcut();

    artifact.newRecording = await waitForCompletedDictation(
      artifact.previousRecordingId,
      timeoutMs
    );
    artifact.insertionAction = latestInsertionAction(artifact.newRecording?.id);
  } catch (error) {
    artifact.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (!artifact.setupSidecarExit) {
      artifact.setupSidecarExit = await setupSidecar.shutdown();
      artifact.setupSidecarStderr = stderrEvidence(setupSidecar.stderr);
    }
    if (appRun) {
      artifact.appExit = await quitApp(appRun);
      artifact.appStdout = stderrEvidence(appRun.stdout);
      artifact.appStderr = stderrEvidence(appRun.stderr);
    }
    restoreDbFiles();
    restoreSettings();
    artifact.restoredDbHashes = dbHashes();
    artifact.restoredSettingsHash = fs.existsSync(settingsPath)
      ? hashBytes(fs.readFileSync(settingsPath))
      : null;
    artifact.dbRestored =
      JSON.stringify(artifact.restoredDbHashes) === JSON.stringify(artifact.originalDbHashes);
    artifact.settingsRestored = artifact.restoredSettingsHash === artifact.originalSettingsHash;
  }

  const appLogs = `${artifact.appStdout.tail}\n${artifact.appStderr.tail}`;
  artifact.checks = {
    dictationSetupReady: Boolean(artifact.dictationSetup?.ok),
    shortcutRegistered: Boolean(artifact.shortcutRegistered),
    shortcutStartInvoked: /start_dictation/i.test(appLogs),
    shortcutStopInvoked: /stop_dictation/i.test(appLogs),
    recordingCreated: Boolean(artifact.newRecording?.id),
    recordingIsNew: Boolean(
      artifact.newRecording?.id && artifact.newRecording.id !== artifact.previousRecordingId
    ),
    recordingSourceDictation: artifact.newRecording?.sourceType === "dictation",
    recordingCompleted: artifact.newRecording?.status === "completed",
    transcriptPersisted: typeof artifact.newRecording?.transcriptText === "string",
    insertionActionPersisted:
      artifact.insertionAction?.recordingId === artifact.newRecording?.id,
    clipboardOnlyMode: artifact.insertionAction?.requestedMode === "clipboard_only",
    copiedOrEmptyOutcome:
      Boolean(artifact.insertionAction?.copied) ||
      String(artifact.newRecording?.transcriptText ?? "").trim().length === 0,
    overlayIpcAllowed: !/Renderer command is not allowed: get_(dictation|recording)_overlay_state/i.test(
      appLogs
    ),
    staleDictationRouteErrorsAbsent:
      !/Distil-Whisper model not downloaded|Dictation transcription failed/i.test(appLogs),
    dbRestored: artifact.dbRestored,
    settingsRestored: artifact.settingsRestored,
  };

  artifact.pass = Boolean(Object.values(artifact.checks).every(Boolean));
  await writeArtifact(artifact);
  process.exit(artifact.pass ? 0 : 1);
}

run().catch(async (error) => {
  restoreDbFiles();
  restoreSettings();
  await writeArtifact({
    generatedAt: new Date().toISOString(),
    appPath,
    appExecutablePath,
    sidecarPath,
    pass: false,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
