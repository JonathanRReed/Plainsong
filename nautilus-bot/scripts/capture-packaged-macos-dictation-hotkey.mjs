#!/usr/bin/env node
//
// Packaged macOS dictation activation-mode capture.
//
// `--mode toggle` (default) is the original harness, preserved behavior-for-
// behavior: press the global shortcut, wait, press it again, then read the
// resulting recording/insertion rows back out of sqlite.
//
// `--mode hold` and `--mode hands-free` extend it to the other two activation
// modes LAUNCH.md requires:
//
//   hold        transcription.dictationPushToTalk = true. A duration-controlled
//               synthetic hold (separate CGEvent keyDown / keyUp with a real
//               sleep between them) must start on the press and stop on the
//               release. A press-only fallback that "works" because a second
//               press happened to stop it is NOT a hold-to-talk pass, so this
//               mode asserts the resolved behavior/capability the app logged
//               AND emits BLOCKED (never PASS, never FAIL) when the native
//               CGEventTap helper is not available.
//   hands-free  transcription.dictationHandsFreeEnabled = true. Zero keystrokes
//               are posted: spoken audio must start the session and sustained
//               silence must stop it.
//
// Evidence discipline (this project has a hard rule against fabricated
// evidence, and a `--observed`-style human attestation flag is banned):
//
//   * `checks` holds the pass-carrying evidence. Each key is labeled in
//     `evidenceClass` as "external" (a sqlite row, the system clipboard read
//     through pbpaste, a process list read through pgrep, a wall clock in this
//     process, a file on disk) or "self_report".
//   * `selfReportedChecks` holds facts the app under test reported about
//     itself - log lines it printed. They are recorded as corroboration and,
//     for hold/hands-free, are additionally *required*; they can never carry a
//     pass on their own because the external checks must pass too.
//   * When a claim cannot be made externally the run stops with status
//     BLOCKED, a precise reason, and a non-zero exit.
//
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createPackagedQaProfile } from "./lib/packaged-qa-profile.mjs";
import { matchSpokenFixture } from "./lib/spoken-fixture-match.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const qaProfile = createPackagedQaProfile({
  args,
  prefix: "plainsong-dictation-hotkey-qa-",
});

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const MODES = ["toggle", "hold", "hands-free"];
const mode = String(valueFor("--mode", "toggle") ?? "toggle")
  .trim()
  .toLowerCase();
const modeIsKnown = MODES.includes(mode);

const appPath = path.resolve(
  repoRoot,
  valueFor("--app", "release/mac-arm64/Plainsong.app")
);
const outPath = path.resolve(
  repoRoot,
  valueFor(
    "--out",
    `artifacts/qa/macos/capture-dictation-hotkey-${modeIsKnown ? mode : "usage"}.json`
  )
);
const recordMs = Number(valueFor("--record-ms", "2600"));
const timeoutMs = Number(valueFor("--timeout-ms", "120000"));
const settleMs = Number(valueFor("--settle-ms", "2500"));

// hold-mode knobs. The hold is Node-controlled: keyDown, speak the fixture,
// keyUp - so the hold always covers the whole utterance no matter how long the
// system voice takes.
const holdLeadMs = Number(valueFor("--hold-lead-ms", "600"));
const holdTrailMs = Number(valueFor("--hold-trail-ms", "700"));
const maxHoldMs = Number(valueFor("--max-hold-ms", "30000"));
const holdStartLogTimeoutMs = Number(valueFor("--hold-start-log-timeout-ms", "8000"));
const helperAliveTimeoutMs = Number(valueFor("--helper-alive-timeout-ms", "6000"));
// The helper exits(2) the moment CGEvent.tapCreate is refused, so re-check
// after this long before trusting "the helper is alive".
const helperSettleMs = Number(valueFor("--helper-settle-ms", "1500"));

// hands-free knobs.
const handsFreeSettleMs = Number(valueFor("--hands-free-settle-ms", "4000"));
const handsFreeSilenceSeconds = Number(valueFor("--hands-free-silence-seconds", "2"));
const handsFreeStartTimeoutMs = Number(valueFor("--hands-free-start-timeout-ms", "25000"));
const handsFreeStopTimeoutMs = Number(valueFor("--hands-free-stop-timeout-ms", "45000"));

const speakFixtureText = String(
  valueFor(
    "--speak-fixture-text",
    "Plainsong packaged activation mode check. This sentence is spoken by the system voice so the dictation transcript is deterministic."
  )
);
const speakTimeoutMs = Number(valueFor("--speak-timeout-ms", "30000"));
const fixtureOutputVolume = Number(valueFor("--fixture-output-volume", "65"));

const sidecarPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "plainsong-sidecar"
);
const appExecutablePath = path.join(appPath, "Contents", "MacOS", "Plainsong");
// electron/main.ts getNativeShortcutHelperPath(): packaged builds load the
// CGEventTap helper from Resources/shortcut-helper.
const nativeShortcutHelperPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "shortcut-helper",
  "plainsong-native-shortcut-helper"
);
const configDir = qaProfile.configDir;
const settingsPath = path.join(configDir, "settings.json");
const dbPath = path.join(qaProfile.dataDir, "plainsong.db");
const dbSidecarPaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
const dbBackups = new Map();
let originalSettingsBytes = null;

// qaSettings() pins the dictation shortcut to Cmd+Shift+Space for every mode;
// these are the CGEvent equivalents of that binding.
const SHORTCUT_LABEL = "Cmd+Shift+Space";
const SHORTCUT_KEY_CODE = 49; // kVK_Space
const CG_EVENT_FLAG_MASK_SHIFT = 0x20000;
const CG_EVENT_FLAG_MASK_COMMAND = 0x100000;
const SHORTCUT_CG_EVENT_FLAGS = CG_EVENT_FLAG_MASK_COMMAND | CG_EVENT_FLAG_MASK_SHIFT;

// Documented caps (never narrow scope silently).
const DICTATION_ID_SNAPSHOT_LIMIT = 200;
const PHASE_LOG_TAIL_CHARS = 4000;

class BlockedError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "BlockedError";
    this.blocked = true;
  }
}

function writeArtifactSync(artifact) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(artifact, null, 2));
}

function fail(message) {
  console.error(message);
  writeArtifactSync({
    generatedAt: new Date().toISOString(),
    mode: modeIsKnown ? mode : null,
    appPath,
    appExecutablePath,
    sidecarPath,
    pass: false,
    status: "BLOCKED",
    blockedReasons: [message],
    checks: {},
    selfReportedChecks: {},
  });
  process.exit(1);
}

if (!modeIsKnown) {
  fail(`Unknown --mode "${mode}". Use one of: ${MODES.join(", ")}.`);
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
if (!Number.isFinite(maxHoldMs) || maxHoldMs <= 0) {
  fail("--max-hold-ms must be a positive number of milliseconds.");
}
if (mode !== "toggle" && speakFixtureText.trim().length === 0) {
  fail("--speak-fixture-text cannot be empty for hold or hands-free mode.");
}
if (
  !Number.isFinite(fixtureOutputVolume) ||
  fixtureOutputVolume < 1 ||
  fixtureOutputVolume > 100
) {
  fail("--fixture-output-volume must be a number from 1 through 100.");
}

function hashBytes(bytes) {
  if (!bytes) return null;
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function hashText(value) {
  if (typeof value !== "string") return null;
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function snapshotDbFiles() {
  for (const filePath of dbSidecarPaths) {
    dbBackups.set(filePath, fs.existsSync(filePath) ? fs.readFileSync(filePath) : null);
  }
}

function snapshotSettings() {
  originalSettingsBytes = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath) : null;
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

// Same spawn, but a non-zero exit is data rather than an exception: pgrep exits
// 1 when nothing matches, and pbpaste/osascript failures are evidence too.
function runCommandAllowFailure(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? "").trim(),
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
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

// Ids only, newest first, capped at DICTATION_ID_SNAPSHOT_LIMIT. Diffing ids is
// used instead of a created_at cutoff so nothing depends on sqlite parsing the
// stored microsecond ISO timestamps the same way JS does.
function dictationRecordingIds() {
  return runSqlJson(`
SELECT id
FROM recordings
WHERE source_type = 'dictation'
ORDER BY created_at DESC
LIMIT ${DICTATION_ID_SNAPSHOT_LIMIT};
`).map((row) => row.id);
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

function phaseEvidence(value) {
  const text = String(value ?? "");
  return {
    length: text.length,
    tail: text.slice(-PHASE_LOG_TAIL_CHARS),
  };
}

function qaSettings(base) {
  const next = JSON.parse(JSON.stringify(base));
  next.shortcuts = {
    ...next.shortcuts,
    toggleDictation: SHORTCUT_LABEL,
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

  if (mode === "hold") {
    // resolveDictationShortcutBehavior -> "hold_to_talk"
    // (electron/dictation-shortcut-controller.ts:53-64). Silence auto-stop stays
    // disabled so the key release is the only thing that can end the session -
    // otherwise a VAD stop could masquerade as a working release.
    next.transcription.dictationPushToTalk = true;
    next.transcription.dictationHandsFreeEnabled = false;
    next.transcription.dictationSilenceTimeoutSeconds = 0;
  } else if (mode === "hands-free") {
    // resolveDictationShortcutBehavior -> "hands_free". The sidecar's idle-time
    // monitor starts the session on sustained speech and the in-session gate
    // stops it after dictationSilenceTimeoutSeconds of silence.
    next.transcription.dictationPushToTalk = false;
    next.transcription.dictationHandsFreeEnabled = true;
    next.transcription.dictationSilenceTimeoutSeconds = handsFreeSilenceSeconds;
    next.transcription.dictationVadBackend = "energy_threshold";
  }

  return next;
}

function launchSidecar() {
  const child = spawn(sidecarPath, [], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...qaProfile.env },
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
      new Promise((resolve) => setTimeout(() => resolve(null), 15000)),
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
  const child = spawn(appExecutablePath, qaProfile.appArgs, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...qaProfile.env,
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

// A real run has already overflowed stderrEvidence()'s 12000-char tail (18845
// chars observed), so every hold/hands-free assertion is made against a slice
// of the LIVE chunk arrays taken from a cursor captured before the phase, never
// against the truncated tail stored in the artifact.
function logCursor(appRun) {
  return { stdout: appRun.stdout.length, stderr: appRun.stderr.length };
}

function sliceLogs(appRun, cursor) {
  const stdout = appRun.stdout.slice(cursor.stdout).join("");
  const stderr = appRun.stderr.slice(cursor.stderr).join("");
  return { stdout, stderr, combined: `${stdout}\n${stderr}` };
}

async function waitForSliceLog(appRun, cursor, pattern, deadlineMs) {
  const started = Date.now();
  for (;;) {
    if (pattern.test(sliceLogs(appRun, cursor).combined)) return true;
    if (Date.now() - started >= deadlineMs) return false;
    await sleep(250);
  }
}

// electron/main.ts qaLog() prints these as `[qa] <message> { ... }` through
// util.inspect, so the payload is a single-line brace block.
const SHORTCUT_SIGNAL_LOG_PATTERN =
  /\[qa\] dictation shortcut (start_dictation|stop_dictation|force_stop_dictation)[ \t]*(\{[^{}]*\})?/g;

function readLoggedField(payload, field) {
  const match = new RegExp(`["']?${field}["']?\\s*:\\s*["']([^"']*)["']`).exec(
    String(payload ?? "")
  );
  return match ? match[1] : null;
}

function parseShortcutSignalLogs(text) {
  const entries = [];
  for (const match of String(text ?? "").matchAll(SHORTCUT_SIGNAL_LOG_PATTERN)) {
    const payload = match[2] ?? "";
    entries.push({
      command: match[1],
      phase: readLoggedField(payload, "phase"),
      behavior: readLoggedField(payload, "behavior"),
      capability: readLoggedField(payload, "capability"),
      stopReason: readLoggedField(payload, "stopReason"),
      raw: match[0].slice(0, 400),
    });
  }
  return entries;
}

function pgrepPattern(value) {
  return String(value).replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");
}

function pidsMatching(pattern) {
  const result = runCommandAllowFailure("pgrep", ["-f", pgrepPattern(pattern)]);
  if (result.status !== 0) return [];
  return result.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

// External: the OS process list. The Swift helper exits(2) as soon as
// CGEvent.tapCreate is refused, so "still running" is an out-of-band signal
// that the event tap exists.
function nativeHelperPids() {
  return pidsMatching(nativeShortcutHelperPath);
}

// Deliberately broader than appExecutablePath: the instance holding Electron's
// single-instance lock may be an installed copy in /Applications, and that copy
// would make the build under test exit on launch.
function plainsongAppPids() {
  return pidsMatching("Plainsong.app/Contents/MacOS/Plainsong");
}

// Mirrors scripts/capture-packaged-macos-idle-cpu.mjs:185-186, but tolerant:
// `tell application id ... to quit` errors when nothing is running, and that is
// the common case rather than a failure.
async function quitRunningPlainsong() {
  const before = plainsongAppPids();
  const outcome = {
    wasRunning: before.length > 0,
    pidsBefore: before,
    quitStatus: null,
    quitStderr: null,
    pidsAfter: before,
  };
  if (before.length === 0) {
    return outcome;
  }
  const quit = runCommandAllowFailure("osascript", [
    "-e",
    'tell application id "com.plainsong.app" to quit',
  ]);
  outcome.quitStatus = quit.status;
  outcome.quitStderr = quit.stderr || null;
  const deadline = Date.now() + 10000;
  for (;;) {
    const remaining = plainsongAppPids();
    outcome.pidsAfter = remaining;
    if (remaining.length === 0 || Date.now() >= deadline) break;
    await sleep(500);
  }
  return outcome;
}

// --- system clipboard (external evidence) ---------------------------------
function readClipboard() {
  const result = runCommandAllowFailure("pbpaste", []);
  return {
    ok: result.status === 0,
    text: result.status === 0 ? result.stdout : "",
    stderr: result.stderr || null,
  };
}

function writeClipboard(text) {
  const result = spawnSync("pbcopy", [], {
    cwd: repoRoot,
    input: text,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    stderr: String(result.stderr ?? "").trim() || null,
  };
}

// --- synthetic input -------------------------------------------------------
// toggle mode keeps the original System Events chord, byte-for-byte.
function pressDictationShortcut() {
  runCommand("osascript", [
    "-e",
    'tell application "System Events" to key code 49 using {command down, shift down}',
  ]);
}

const keyEventsPosted = [];

// The artifact stores capped copies of these (a 4000-char clipboard excerpt, a
// 12000-char log tail); the checks compare against the untruncated values held
// here so a cap can never decide a verdict.
let clipboardAfterRunFullText = "";
let appLogsFullCombined = "";

const syntheticHoldDriverSourcePath = path.join(
  repoRoot,
  "scripts",
  "native-macos-key-hold-driver.swift"
);

function syntheticHoldDriverBinaryPath() {
  const source = fs.readFileSync(syntheticHoldDriverSourcePath);
  const digest = crypto.createHash("sha256").update(source).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `plainsong-key-hold-driver-${digest}`);
}

function ensureSyntheticHoldDriver() {
  const binaryPath = syntheticHoldDriverBinaryPath();
  if (fs.existsSync(binaryPath)) return binaryPath;
  const build = spawnSync("xcrun", ["swiftc", syntheticHoldDriverSourcePath, "-o", binaryPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (build.status !== 0 || !fs.existsSync(binaryPath)) {
    throw new BlockedError(
      `Could not compile the persistent macOS hold driver (exit ${build.status}): ${String(build.stderr ?? "").trim() || "no stderr"}. This is a failure of the harness input path, not a verdict on the app.`
    );
  }
  return binaryPath;
}

async function launchSyntheticHoldDriver() {
  const binaryPath = ensureSyntheticHoldDriver();
  const child = spawn(
    binaryPath,
    [
      "--key-code",
      String(SHORTCUT_KEY_CODE),
      "--flags",
      String(SHORTCUT_CG_EVENT_FLAGS),
      "--max-hold-ms",
      String(maxHoldMs),
    ],
    { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] }
  );
  const lines = createInterface({ input: child.stdout });
  const received = [];
  const waiters = new Set();
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  lines.on("line", (line) => {
    received.push({ line: line.trim(), atEpochMs: Date.now() });
    for (const wake of waiters) wake();
    waiters.clear();
  });
  const childExit = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const waitForLine = async (expected, deadlineMs) => {
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
      const match = received.find((entry) => entry.line === expected);
      if (match) return match;
      await Promise.race([
        new Promise((resolve) => {
          waiters.add(resolve);
          setTimeout(() => {
            waiters.delete(resolve);
            resolve();
          }, 100);
        }),
        childExit,
      ]);
    }
    return null;
  };

  const down = await waitForLine("down", 5000);
  const downRecord = {
    kind: "down",
    keyCode: SHORTCUT_KEY_CODE,
    flags: SHORTCUT_CG_EVENT_FLAGS,
    postedAtEpochMs: down?.atEpochMs ?? Date.now(),
    completedAtEpochMs: down?.atEpochMs ?? Date.now(),
    ok: Boolean(down),
    exitStatus: down ? 0 : null,
    stderr: down ? null : stderr.trim() || "Hold driver did not report key-down.",
  };
  keyEventsPosted.push(downRecord);

  let released = false;
  return {
    downRecord,
    release: async () => {
      if (released) return keyEventsPosted.find((event) => event.kind === "up") ?? null;
      released = true;
      const requestedAtEpochMs = Date.now();
      child.stdin.end("\n");
      const up = await waitForLine("up", 5000);
      const exit = await Promise.race([
        childExit,
        sleep(5000).then(() => ({ code: null, signal: "timeout" })),
      ]);
      const upRecord = {
        kind: "up",
        keyCode: SHORTCUT_KEY_CODE,
        flags: SHORTCUT_CG_EVENT_FLAGS,
        postedAtEpochMs: requestedAtEpochMs,
        completedAtEpochMs: up?.atEpochMs ?? Date.now(),
        ok: Boolean(up) && exit.code === 0,
        exitStatus: exit.code,
        stderr: stderr.trim() || null,
      };
      keyEventsPosted.push(upRecord);
      lines.close();
      return upRecord;
    },
  };
}

function snapshotOutputVolume() {
  const result = runCommandAllowFailure("osascript", [
    "-e",
    "set s to get volume settings",
    "-e",
    'return ((output volume of s) as text) & "," & ((output muted of s) as text)',
  ]);
  const match = /^(\d+)\s*,\s*(true|false)$/i.exec(result.stdout.trim());
  return {
    ok: result.status === 0 && Boolean(match),
    volume: match ? Number(match[1]) : null,
    muted: match ? match[2].toLowerCase() === "true" : null,
    error: result.status === 0 && match ? null : result.stderr || result.stdout || "unreadable",
  };
}

function setFixtureOutputVolume() {
  const result = runCommandAllowFailure("osascript", [
    "-e",
    `set volume output volume ${fixtureOutputVolume} without output muted`,
  ]);
  return {
    ok: result.status === 0,
    volume: fixtureOutputVolume,
    muted: false,
    error: result.status === 0 ? null : result.stderr || "unknown",
  };
}

function restoreOutputVolume(snapshot) {
  if (!snapshot.ok || snapshot.volume === null || snapshot.muted === null) {
    return { ok: false, error: "The original speaker state was not readable." };
  }
  const muteClause = snapshot.muted ? "with output muted" : "without output muted";
  const result = runCommandAllowFailure("osascript", [
    "-e",
    `set volume output volume ${snapshot.volume} ${muteClause}`,
  ]);
  return {
    ok: result.status === 0,
    volume: snapshot.volume,
    muted: snapshot.muted,
    error: result.status === 0 ? null : result.stderr || "unknown",
  };
}

// Deterministic speech, same approach as
// scripts/capture-packaged-macos-meeting-soak.mjs:180. `maxMs` bounds the run
// and kills the voice, so a stuck `say` can never bleed into a later phase.
// The speaker is made audible only for the fixture, then restored exactly.
async function speakFixture(maxMs = speakTimeoutMs) {
  const startedAt = Date.now();
  const audioOutput = {
    original: snapshotOutputVolume(),
    temporary: null,
    restored: null,
  };
  if (!audioOutput.original.ok) {
    return {
      startedAtEpochMs: startedAt,
      finishedAtEpochMs: Date.now(),
      timedOut: false,
      maxMs,
      code: null,
      signal: null,
      error: `Could not read the original speaker state: ${audioOutput.original.error}`,
      audioOutput,
    };
  }

  audioOutput.temporary = setFixtureOutputVolume();
  if (!audioOutput.temporary.ok) {
    audioOutput.restored = restoreOutputVolume(audioOutput.original);
    return {
      startedAtEpochMs: startedAt,
      finishedAtEpochMs: Date.now(),
      timedOut: false,
      maxMs,
      code: null,
      signal: null,
      error: `Could not make the spoken fixture audible: ${audioOutput.temporary.error}`,
      audioOutput,
    };
  }

  let speechResult;
  try {
    const child = spawn("say", [speakFixtureText], { cwd: repoRoot, stdio: "ignore" });
    const exited = new Promise((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal, error: null }));
      child.on("error", (error) =>
        resolve({ code: null, signal: null, error: error.message })
      );
    });
    const result = await Promise.race([exited, sleep(maxMs).then(() => null)]);
    if (!result) {
      child.kill("SIGTERM");
      speechResult = { timedOut: true, ...(await exited) };
    } else {
      speechResult = { timedOut: false, ...result };
    }
  } finally {
    audioOutput.restored = restoreOutputVolume(audioOutput.original);
  }

  return {
    startedAtEpochMs: startedAt,
    finishedAtEpochMs: Date.now(),
    maxMs,
    ...speechResult,
    audioOutput,
  };
}

// A fixture-tooling failure blocks instead of being misreported as a product
// failure. `say` exits 0 while muted, so speaker preparation/restoration are
// explicit requirements as well as the process exit.
function assertSpeechFixturePlayed(speech) {
  if (
    speech.code === 0 &&
    !speech.timedOut &&
    !speech.error &&
    speech.audioOutput?.temporary?.ok &&
    speech.audioOutput?.restored?.ok
  ) {
    return;
  }
  throw new BlockedError(
    `The spoken fixture did not play and restore cleanly: \`say\` exited code=${speech.code}, signal=${speech.signal}, timedOut=${speech.timedOut}, error=${speech.error ?? "none"}, speakerPrepared=${speech.audioOutput?.temporary?.ok ?? false}, speakerRestored=${speech.audioOutput?.restored?.ok ?? false}. No trustworthy audio fixture reached the microphone, so this run cannot judge the activation mode.`
  );
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
  writeArtifactSync(artifact);
}

// Which check keys are machine-read facts from outside the app under test, and
// which are things the app said about itself. toggle's legacy check set mixes
// both, and is preserved that way on purpose so its existing PASS reproduces;
// hold and hands-free keep the two classes in separate objects.
const TOGGLE_CHECK_EVIDENCE_CLASS = {
  dictationSetupReady: "self_report",
  shortcutRegistered: "self_report",
  shortcutStartInvoked: "self_report",
  shortcutStopInvoked: "self_report",
  recordingCreated: "external",
  recordingIsNew: "external",
  recordingSourceDictation: "external",
  recordingCompleted: "external",
  transcriptPersisted: "external",
  insertionActionPersisted: "external",
  clipboardOnlyMode: "external",
  copiedOrEmptyOutcome: "external",
  overlayIpcAllowed: "self_report",
  staleDictationRouteErrorsAbsent: "self_report",
  dbRestored: "external",
  settingsRestored: "external",
};

const SHARED_EXTERNAL_EVIDENCE_CLASS = {
  recordingCreated: "external",
  recordingIsNew: "external",
  recordingSourceDictation: "external",
  recordingCompleted: "external",
  transcriptPersisted: "external",
  transcriptNonEmpty: "external",
  spokenFixtureMatched: "external",
  insertionActionPersisted: "external",
  clipboardOnlyMode: "external",
  clipboardMatchesTranscript: "external",
  clipboardOverwroteRunSentinel: "external",
  dbRestored: "external",
  settingsRestored: "external",
};

const MODE_EVIDENCE_CLASS = {
  toggle: TOGGLE_CHECK_EVIDENCE_CLASS,
  hold: {
    ...SHARED_EXTERNAL_EVIDENCE_CLASS,
    nativeHelperBinaryPresent: "external",
    nativeHelperProcessAliveThroughHold: "external",
    syntheticHoldPosted: "external",
    exactlyOneHoldPosted: "external",
    holdCoveredSpokenFixture: "external",
    speechFixtureSpoken: "external",
  },
  "hands-free": {
    ...SHARED_EXTERNAL_EVIDENCE_CLASS,
    zeroKeyEventsPosted: "external",
    speechFixtureSpoken: "external",
  },
};

const MODE_PASS_FORMULA = {
  toggle:
    "pass = AND(checks). Preserved from the pre-parameterization harness, including its mix of external (sqlite/file) and self-reported (app log) checks. Its presence checks still read the 12000-char truncated log tails, where truncation can only cost a pass; its two absence checks read the untruncated combined log, so a scrolled-off failure line cannot pass as absent. An unexpected exception anywhere in the run produces status BLOCKED instead of PASS or FAIL.",
  hold:
    "pass = AND(checks) AND AND(selfReportedChecks). checks are external facts only (sqlite rows, pbpaste, pgrep, this process's wall clock). selfReportedChecks are app log lines: required, but they cannot carry a pass because every external check must hold too. A missing or degraded native CGEventTap helper produces status BLOCKED instead of PASS or FAIL.",
  "hands-free":
    "pass = AND(checks) AND AND(selfReportedChecks). checks are external facts only, including 'zero synthetic key events were posted by this harness'. selfReportedChecks are app log lines: required, never sufficient. An absent hands-free auto-start with no session at all produces status BLOCKED, because this harness cannot externally prove the microphone heard the spoken fixture.",
};

snapshotDbFiles();
snapshotSettings();

async function run() {
  // Serialized lanes share one GUI: a stale Plainsong holds the Electron
  // single-instance lock and would make the app we launch exit immediately.
  const preexistingPlainsong = await quitRunningPlainsong();
  if (preexistingPlainsong.wasRunning) {
    await sleep(1500);
    // That instance flushed its own writes on the way out. Re-take the
    // snapshot so the restore at the end hands the user back what their app
    // actually left behind rather than rolling it back.
    snapshotDbFiles();
    snapshotSettings();
  }

  restoreDbFiles();
  restoreSettings();

  const previousRecording = latestDictationRecording();
  const artifact = {
    generatedAt: new Date().toISOString(),
    mode,
    appPath,
    appExecutablePath,
    sidecarPath,
    nativeShortcutHelperPath,
    dbPath,
    settingsPath,
    shortcut: SHORTCUT_LABEL,
    recordMs,
    settleMs,
    pass: false,
    status: "FAIL",
    blockedReasons: [],
    previousRecordingId: previousRecording?.id ?? null,
    previousDictationRecordingIds: [],
    newDictationRecordingIds: [],
    newDictationRecordingIdsError: null,
    newRecording: null,
    insertionAction: null,
    preexistingPlainsong,
    originalDbHashes: Object.fromEntries(
      [...dbBackups.entries()].map(([filePath, bytes]) => [filePath, hashBytes(bytes)])
    ),
    restoredDbHashes: null,
    originalSettingsHash: hashBytes(originalSettingsBytes),
    restoredSettingsHash: null,
    dbRestored: false,
    settingsRestored: false,
    appliedSettings: null,
    activation: {
      keyEventsPosted,
      speechRuns: [],
      holdStartedAtEpochMs: null,
      holdReleasedAtEpochMs: null,
      measuredHoldMs: null,
      resolvedBehavior: null,
      resolvedCapability: null,
      fixtureMatch: null,
      handsFreeAutoStartObserved: null,
      handsFreeAutoStopObserved: null,
      handsFreeMonitorFailure: null,
    },
    clipboard: null,
    nativeHelper: null,
    phaseLogs: {},
    shortcutSignalLogs: [],
    checks: {},
    selfReportedChecks: {},
    evidenceClass: MODE_EVIDENCE_CLASS[mode],
    passFormula: MODE_PASS_FORMULA[mode],
    caps: {
      dictationIdSnapshotLimit: DICTATION_ID_SNAPSHOT_LIMIT,
      phaseLogTailChars: PHASE_LOG_TAIL_CHARS,
      artifactLogTailChars: 12000,
      maxHoldMs,
      speakTimeoutMs,
    },
    notes: [
      "checks carry the pass. selfReportedChecks are lines the app under test printed about itself; for hold and hands-free they are required gates but can never carry a pass alone, and for toggle the legacy check set (preserved verbatim) mixes both classes - see evidenceClass.",
      "toggle mode is otherwise unchanged from the pre-parameterization harness: no spoken fixture, two System Events chord presses, presence checks computed from the 12000-char truncated log tails. Its two absence checks (overlayIpcAllowed, staleDictationRouteErrorsAbsent) now read the full untruncated combined log rather than the tail, so a failure line emitted early enough to scroll out of the artifact window can no longer read as absent; this can only make toggle stricter.",
      "No mode asserts absence against a truncated log. hold and hands-free additionally take their activation assertions from a per-phase slice cut with a cursor over the live stdout/stderr chunk arrays. The artifact stores capped copies of both.",
      "An unexpected (non-BlockedError) exception during the run is recorded in error and also pushed into blockedReasons, so a run that threw after activation reports BLOCKED and exits non-zero instead of passing on the checks it happened to fill in before the throw.",
      "newDictationRecordingIds is advisory only: it carries no check, it is taken after every pass-carrying read, and a sqlite failure while taking it is recorded in newDictationRecordingIdsError rather than aborting the run.",
      "The sqlite rows are the app's own writes read back off disk with the sqlite3 CLI. The signals that do not pass through the app at all are the system clipboard (pbpaste, against a sentinel this harness seeded), the process list (pgrep), the synthetic key events this harness did or did not post, and this process's wall clock.",
    ],
    appExit: null,
    appStdout: { length: 0, tail: "" },
    appStderr: { length: 0, tail: "" },
    appStdoutFullLength: 0,
    appStderrFullLength: 0,
    setupSidecarExit: null,
    setupSidecarStderr: { length: 0, tail: "" },
  };

  if (mode !== "toggle") {
    artifact.notes.push(
      "hold and hands-free seed the system clipboard with a per-run sentinel before activation and restore the pre-run clipboard afterwards. pbpaste/pbcopy carry plain text only, so a non-text clipboard cannot be restored - the app's clipboard_only delivery overwrites it during the run in any case."
    );
  }
  if (mode === "hold") {
    artifact.notes.push(
      "The hold is posted as separate CGEvent keyDown/keyUp events with only the Cmd+Shift flags set on the Space events; no modifier key events are posted, so an interrupted run cannot leave a modifier stuck down."
    );
  }

  const setupSidecar = launchSidecar();
  let appRun = null;
  let clipboardSentinel = null;
  let originalClipboard = null;

  try {
    const originalSettings = await setupSidecar.sendCommand("get_settings", {});
    const applied = qaSettings(originalSettings);
    await setupSidecar.sendCommand("save_settings", { settings: applied });
    artifact.appliedSettings = {
      toggleDictation: applied.shortcuts?.toggleDictation ?? null,
      dictationPushToTalk: applied.transcription?.dictationPushToTalk ?? null,
      dictationHandsFreeEnabled: applied.transcription?.dictationHandsFreeEnabled ?? null,
      dictationSilenceTimeoutSeconds:
        applied.transcription?.dictationSilenceTimeoutSeconds ?? null,
      dictationVadBackend: applied.transcription?.dictationVadBackend ?? null,
      dictationInsertionMode: applied.transcription?.dictationInsertionMode ?? null,
      dictationCopyToClipboard: applied.transcription?.dictationCopyToClipboard ?? null,
    };
    artifact.dictationSetup = await setupSidecar.sendCommand("verify_dictation_setup", {});
    if (!artifact.dictationSetup?.ok) {
      const summary = artifact.dictationSetup?.summary ?? "unknown";
      if (mode === "toggle") {
        // Preserved: toggle keeps the original plain Error and its message. It
        // is still never a pass and still exits non-zero; since an unexpected
        // exception now blocks the verdict, this surfaces as BLOCKED rather
        // than the FAIL it used to report.
        throw new Error(`Dictation setup is not ready: ${summary}`);
      }
      throw new BlockedError(
        `Dictation setup is not ready (${summary}). The packaged app cannot capture dictation on this machine, so no activation-mode claim can be made. A human must grant the missing permission or install the missing local model, then re-run.`
      );
    }
    artifact.setupSidecarExit = await setupSidecar.shutdown();
    artifact.setupSidecarStderr = stderrEvidence(setupSidecar.stderr);

    artifact.previousDictationRecordingIds = dictationRecordingIds();

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

    if (mode !== "toggle") {
      originalClipboard = readClipboard();
      clipboardSentinel = `plainsong-qa-${mode}-${Date.now()}-${crypto
        .randomBytes(6)
        .toString("hex")}`;
      const seeded = writeClipboard(clipboardSentinel);
      const seededReadback = readClipboard();
      artifact.clipboard = {
        originalTextLength: originalClipboard.text.length,
        originalTextHash: hashText(originalClipboard.text),
        originalReadOk: originalClipboard.ok,
        sentinel: clipboardSentinel,
        sentinelSeeded: seeded.ok && seededReadback.text === clipboardSentinel,
        seedError: seeded.stderr,
        afterRunText: null,
        afterRunTextLength: null,
        restored: null,
        restoreSkippedReason: null,
      };
      if (!artifact.clipboard.sentinelSeeded) {
        throw new BlockedError(
          `Could not seed the system clipboard sentinel through pbcopy/pbpaste (${seeded.stderr ?? "no stderr"}). Without it there is no out-of-process way to prove the app wrote the dictated text to the clipboard during this run, and this harness will not pass on the app's own report that it did.`
        );
      }
    }

    if (mode === "toggle") {
      pressDictationShortcut();
      await sleep(Math.max(1000, recordMs));
      pressDictationShortcut();
    } else if (mode === "hold") {
      await runHoldActivation(artifact, appRun);
    } else {
      await runHandsFreeActivation(artifact, appRun);
    }

    artifact.newRecording = await waitForCompletedDictation(
      artifact.previousRecordingId,
      timeoutMs
    );
    artifact.insertionAction = latestInsertionAction(artifact.newRecording?.id);

    if (mode !== "toggle") {
      const afterRun = readClipboard();
      clipboardAfterRunFullText = afterRun.text;
      artifact.clipboard.afterRunText = afterRun.text.slice(0, 4000);
      artifact.clipboard.afterRunTextLength = afterRun.text.length;
      artifact.clipboard.afterRunTextHash = hashText(afterRun.text);
      artifact.clipboard.afterRunTextTruncatedTo = 4000;
    }

    // Advisory only: this id diff carries no check. It runs last, and in its own
    // try/catch, because sqlite3 is still contending with the running app and
    // its sidecar ("database is locked" exits non-zero, which runCommand throws
    // on) - an informational query must never be able to abort a run whose
    // pass-carrying reads already succeeded.
    try {
      const previousIds = new Set(artifact.previousDictationRecordingIds);
      artifact.newDictationRecordingIds = dictationRecordingIds().filter(
        (id) => !previousIds.has(id)
      );
    } catch (error) {
      artifact.newDictationRecordingIdsError =
        error instanceof Error ? error.message : String(error);
    }
  } catch (error) {
    if (error instanceof BlockedError) {
      artifact.blockedReasons.push(error.message);
    } else {
      artifact.error = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (!artifact.setupSidecarExit) {
      artifact.setupSidecarExit = await setupSidecar.shutdown();
      artifact.setupSidecarStderr = stderrEvidence(setupSidecar.stderr);
    }
    if (appRun) {
      artifact.appExit = await quitApp(appRun);
      artifact.appStdout = stderrEvidence(appRun.stdout);
      artifact.appStderr = stderrEvidence(appRun.stderr);
      artifact.appStdoutFullLength = appRun.stdout.join("").length;
      artifact.appStderrFullLength = appRun.stderr.join("").length;
      appLogsFullCombined = `${appRun.stdout.join("")}\n${appRun.stderr.join("")}`;
    }
    if (mode !== "toggle" && artifact.clipboard) {
      if (originalClipboard?.ok && originalClipboard.text.length > 0) {
        const restore = writeClipboard(originalClipboard.text);
        const readback = readClipboard();
        artifact.clipboard.restored =
          restore.ok && readback.text === originalClipboard.text;
      } else {
        artifact.clipboard.restoreSkippedReason =
          "The pre-run clipboard held no plain text (empty, or a non-text flavor pbpaste cannot read), so writing it back would not restore it.";
        artifact.clipboard.restored = false;
      }
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

  if (mode === "toggle") {
    buildToggleChecks(artifact);
  } else {
    buildActivationChecks(artifact, clipboardSentinel);
  }

  // Self-audit: a pass-carrying check whose evidence class was never declared
  // cannot be trusted to be external, so it blocks instead of passing.
  artifact.uncategorizedCheckKeys = Object.keys(artifact.checks).filter(
    (key) => !(key in (artifact.evidenceClass ?? {}))
  );
  if (artifact.uncategorizedCheckKeys.length > 0) {
    artifact.blockedReasons.push(
      `These pass-carrying checks have no evidenceClass label, so this artifact cannot claim they are external facts: ${artifact.uncategorizedCheckKeys.join(", ")}. Label them in MODE_EVIDENCE_CLASS.`
    );
  }

  // An unexpected (non-BlockedError) exception means the run stopped partway
  // through, so the checks were computed over whatever happened to be populated
  // before the throw and several can still read true. That makes the verdict
  // uninterpretable, not merely noteworthy: it blocks rather than passing.
  if (artifact.error) {
    artifact.blockedReasons.push(
      `This run threw an unexpected error, so it stopped partway through and its checks were computed over a partial run: ${artifact.error}. A human must read the error, fix the cause, and re-run; no activation claim can be made from this artifact.`
    );
  }

  if (artifact.blockedReasons.length > 0) {
    artifact.status = "BLOCKED";
    artifact.pass = false;
  } else {
    artifact.pass = Boolean(
      Object.values(artifact.checks).every(Boolean) &&
        Object.values(artifact.selfReportedChecks).every(Boolean)
    );
    artifact.status = artifact.pass ? "PASS" : "FAIL";
  }

  await writeArtifact(artifact);
  process.exit(artifact.pass ? 0 : 1);
}

// --- hold-to-talk ----------------------------------------------------------
async function runHoldActivation(artifact, appRun) {
  const helperBinaryPresent = fs.existsSync(nativeShortcutHelperPath);
  artifact.nativeHelper = {
    binaryPath: nativeShortcutHelperPath,
    binaryPresent: helperBinaryPresent,
    pidsAfterLaunch: [],
    pidsAfterSettle: [],
    pidsDuringHold: [],
    pidsAfterHold: [],
    tapCreationRefusedInAppLog: false,
    unavailableInAppLog: false,
  };

  if (!helperBinaryPresent) {
    throw new BlockedError(
      `The packaged native shortcut helper is missing at ${nativeShortcutHelperPath}. hold-to-talk needs it for the press_and_release capability (electron/dictation-shortcut-controller.ts:66-74); without it the app can only run the press-only toggle fallback, which is not hold-to-talk. Rebuild/repackage the app with scripts/build-native-shortcut-helper.mjs, then re-run.`
    );
  }

  // The helper is spawned alongside shortcut registration; give it a moment to
  // appear, then re-check after helperSettleMs because a refused event tap
  // makes it exit(2) almost immediately.
  const helperDeadline = Date.now() + helperAliveTimeoutMs;
  let pids = nativeHelperPids();
  while (pids.length === 0 && Date.now() < helperDeadline) {
    await sleep(250);
    pids = nativeHelperPids();
  }
  artifact.nativeHelper.pidsAfterLaunch = pids;
  await sleep(helperSettleMs);
  artifact.nativeHelper.pidsAfterSettle = nativeHelperPids();

  const launchLogs = `${appRun.stdout.join("")}\n${appRun.stderr.join("")}`;
  artifact.nativeHelper.tapCreationRefusedInAppLog =
    /Unable to create keyboard event tap/i.test(launchLogs);
  artifact.nativeHelper.unavailableInAppLog =
    /native shortcut helper became unavailable|native helper exited/i.test(launchLogs);

  if (artifact.nativeHelper.pidsAfterSettle.length === 0) {
    throw new BlockedError(
      `The packaged native CGEventTap helper is not running (${nativeShortcutHelperPath}); ` +
        `app log reported tap-creation refusal: ${artifact.nativeHelper.tapCreationRefusedInAppLog}, ` +
        `helper-unavailable: ${artifact.nativeHelper.unavailableInAppLog}. ` +
        "Without it the app resolves capability press_only and silently degrades hold-to-talk to the toggle fallback, so this run cannot prove hold-to-talk either way. " +
        "A human must grant macOS Accessibility (and Input Monitoring) trust to the process responsible for this launch - Plainsong.app when launched from Finder, and the terminal application running this harness when launched by script - in System Settings > Privacy & Security, then re-run. Launching Plainsong.app from Finder once and re-granting is the reliable path."
    );
  }

  const holdCursor = logCursor(appRun);
  let holdDriver = null;

  try {
    holdDriver = await launchSyntheticHoldDriver();
    const downPosted = holdDriver.downRecord;
    artifact.activation.holdStartedAtEpochMs = downPosted.completedAtEpochMs;
    if (!downPosted.ok) {
      throw new BlockedError(
        `Could not post the synthetic key-down through the persistent hold driver (exit ${downPosted.exitStatus}): ${downPosted.stderr ?? "no stderr"}. ` +
          "This is a failure of the harness's own input path, not a verdict on the app. Grant Accessibility trust to the terminal running this harness, or perform the hold manually and re-check the artifact."
      );
    }

    const sawStart = await waitForSliceLog(
      appRun,
      holdCursor,
      /\[qa\] dictation shortcut start_dictation/,
      holdStartLogTimeoutMs
    );
    const afterPressLogs = sliceLogs(appRun, holdCursor);
    const pressSignals = parseShortcutSignalLogs(afterPressLogs.combined);
    artifact.shortcutSignalLogs = pressSignals;

    if (!sawStart) {
      throw new BlockedError(
        `The packaged app logged no dictation shortcut signal within ${holdStartLogTimeoutMs} ms of the synthetic key-down while the native helper was alive (pids ${artifact.nativeHelper.pidsAfterSettle.join(", ")}). ` +
          "That is ambiguous: the synthetic CGEvent may never have reached the app, or the app may have ignored it. A human must repeat the hold with a physical Cmd+Shift+Space press and re-check this artifact."
      );
    }

    const start = pressSignals.find((entry) => entry.command === "start_dictation") ?? null;
    artifact.activation.resolvedBehavior = start?.behavior ?? null;
    artifact.activation.resolvedCapability = start?.capability ?? null;

    if (!start || start.behavior === null || start.capability === null) {
      throw new BlockedError(
        `The app logged a dictation shortcut signal but this harness could not read behavior/capability out of its payload (raw: ${start?.raw ?? "no start_dictation entry parsed"}). The resolved activation mode cannot be asserted, so no hold-to-talk verdict is possible; the log format in electron/main.ts qaLog() and this parser have drifted apart.`
      );
    }
    if (start.behavior !== "hold_to_talk") {
      throw new BlockedError(
        `The app resolved dictation shortcut behavior "${start.behavior}" instead of "hold_to_talk" for this press. The QA settings requested dictationPushToTalk = true, so the app never entered hold-to-talk and this run cannot judge it.`
      );
    }
    if (start.capability !== "press_and_release") {
      throw new BlockedError(
        `The app resolved capability "${start.capability}" instead of "press_and_release", i.e. it degraded hold-to-talk to the press-only toggle fallback (electron/dictation-shortcut-controller.ts:66-74) because nativeShortcutAvailable was false. ` +
          "A run that ended in a completed recording here would be a toggle pass wearing a hold-to-talk label, so this is reported BLOCKED. A human must grant macOS Accessibility/Input Monitoring trust to Plainsong.app (System Settings > Privacy & Security) so the packaged CGEventTap helper stays available, then re-run."
      );
    }

    artifact.nativeHelper.pidsDuringHold = nativeHelperPids();

    await sleep(holdLeadMs);
    const speech = await speakFixture(Math.min(speakTimeoutMs, maxHoldMs));
    artifact.activation.speechRuns.push(speech);
    assertSpeechFixturePlayed(speech);
    await sleep(holdTrailMs);
  } finally {
    if (holdDriver) {
      const upPosted = await holdDriver.release();
      artifact.activation.holdReleasedAtEpochMs = upPosted.postedAtEpochMs;
      artifact.activation.measuredHoldMs =
        upPosted.postedAtEpochMs - holdDriver.downRecord.completedAtEpochMs;
      artifact.nativeHelper.pidsAfterHold = nativeHelperPids();
    }
    // Capture the phase slice even when this phase is unwinding with a BLOCKED
    // reason, so the artifact still carries the log evidence behind it.
    captureHoldPhaseLogs(artifact, appRun, holdCursor);
  }

  // Give the release path time to reach stop_dictation before the phase slice
  // is re-read for the stopReason assertion.
  await waitForSliceLog(
    appRun,
    holdCursor,
    /\[qa\] dictation shortcut stop_dictation/,
    10000
  );
  captureHoldPhaseLogs(artifact, appRun, holdCursor);
}

function captureHoldPhaseLogs(artifact, appRun, holdCursor) {
  const holdLogs = sliceLogs(appRun, holdCursor);
  artifact.phaseLogs.hold = {
    stdout: phaseEvidence(holdLogs.stdout),
    stderr: phaseEvidence(holdLogs.stderr),
  };
  artifact.shortcutSignalLogs = parseShortcutSignalLogs(holdLogs.combined);
  artifact.activation.holdPhaseLogsCombinedLength = holdLogs.combined.length;
}

// --- hands-free ------------------------------------------------------------
// rust-sidecar/src/lib.rs reconcile_hands_free_monitor() logs this when the
// idle monitor cannot open the microphone; the sidecar's stderr is forwarded
// into the app's stderr by electron/ipc-bridge.ts.
function readHandsFreeMonitorFailure(appRun) {
  const match = /Failed to start hands-free idle monitor: ([^\n]*)/.exec(
    `${appRun.stdout.join("")}\n${appRun.stderr.join("")}`
  );
  return match ? match[1].trim() : null;
}

async function runHandsFreeActivation(artifact, appRun) {
  await sleep(handsFreeSettleMs);

  // Checked before speaking too: if the monitor never opened the microphone
  // there is nothing to speak at.
  artifact.activation.handsFreeMonitorFailure = readHandsFreeMonitorFailure(appRun);
  if (artifact.activation.handsFreeMonitorFailure) {
    throw new BlockedError(
      `The sidecar could not start the hands-free idle monitor: ${artifact.activation.handsFreeMonitorFailure}. The microphone was never opened for hands-free listening, so this run cannot judge hands-free activation. A human must resolve the input-device/permission problem and re-run.`
    );
  }

  const handsFreeCursor = logCursor(appRun);
  const speech = await speakFixture();
  artifact.activation.speechRuns.push(speech);
  assertSpeechFixturePlayed(speech);

  const sawAutoStart = await waitForSliceLog(
    appRun,
    handsFreeCursor,
    /\[qa\] dictation hands-free auto-start/,
    handsFreeStartTimeoutMs
  );
  artifact.activation.handsFreeAutoStartObserved = sawAutoStart;
  artifact.activation.handsFreeMonitorFailure = readHandsFreeMonitorFailure(appRun);

  if (artifact.activation.handsFreeMonitorFailure) {
    throw new BlockedError(
      `The sidecar could not start the hands-free idle monitor: ${artifact.activation.handsFreeMonitorFailure}. The microphone was never opened for hands-free listening, so this run cannot judge hands-free activation. A human must resolve the input-device/permission problem and re-run.`
    );
  }

  if (!sawAutoStart) {
    const startedAnyway = dictationRecordingIds().filter(
      (id) => !artifact.previousDictationRecordingIds.includes(id)
    );
    if (startedAnyway.length === 0) {
      throw new BlockedError(
        `No hands-free session started within ${handsFreeStartTimeoutMs} ms of the spoken fixture, and no new dictation recording exists. ` +
          "This harness plays the fixture through the speakers and cannot externally prove the microphone heard it, so a VAD/product failure is indistinguishable from this machine's audio routing (muted output, headphones, an input device that cannot hear the speakers). " +
          "A human must enable hands-free and speak into the microphone directly, then re-check this artifact."
      );
    }
  }

  await waitForSliceLog(
    appRun,
    handsFreeCursor,
    /\[qa\] dictation vad auto-stop(?! dropped)/,
    handsFreeStopTimeoutMs
  );
  const handsFreeLogs = sliceLogs(appRun, handsFreeCursor);
  artifact.phaseLogs.handsFree = {
    stdout: phaseEvidence(handsFreeLogs.stdout),
    stderr: phaseEvidence(handsFreeLogs.stderr),
  };
  artifact.activation.handsFreePhaseLogsCombinedLength = handsFreeLogs.combined.length;
  artifact.activation.handsFreeAutoStopObserved =
    /\[qa\] dictation vad auto-stop(?! dropped)/.test(handsFreeLogs.combined);
  artifact.shortcutSignalLogs = parseShortcutSignalLogs(handsFreeLogs.combined);
}

// --- checks ----------------------------------------------------------------
function buildToggleChecks(artifact) {
  // Presence checks are unchanged from the pre-parameterization harness,
  // truncated tails included: a line that scrolled past the 12000-char tail can
  // only make a presence check fail, which is the safe direction.
  const appLogs = `${artifact.appStdout.tail}\n${artifact.appStderr.tail}`;
  // Absence checks read the untruncated log instead. A denied overlay IPC or a
  // "Dictation transcription failed" emitted early in the run scrolls out of the
  // artifact tail, and reading absence over a window that no longer contains the
  // failure is exactly the truncation-driven false pass this harness forbids for
  // hold and hands-free. This can only turn a truncation-driven PASS into a
  // FAIL, never the reverse, so a genuinely clean run still reproduces.
  const auditLogs = appLogsFullCombined;
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
      auditLogs
    ),
    staleDictationRouteErrorsAbsent:
      !/Distil-Whisper model not downloaded|Dictation transcription failed/i.test(auditLogs),
    dbRestored: artifact.dbRestored,
    settingsRestored: artifact.settingsRestored,
  };
  artifact.selfReportedChecks = {};
}

function buildActivationChecks(artifact, clipboardSentinel) {
  const transcriptText = String(artifact.newRecording?.transcriptText ?? "");
  const fixtureMatch = matchSpokenFixture(transcriptText, speakFixtureText);
  artifact.activation.fixtureMatch = fixtureMatch;
  const clipboardText = clipboardAfterRunFullText;
  // Untruncated: a log line that scrolled past the 12000-char artifact tail
  // must not be able to turn an absence check into a pass.
  const auditLogs = appLogsFullCombined;
  const signals = artifact.shortcutSignalLogs ?? [];
  const startSignal = signals.find((entry) => entry.command === "start_dictation") ?? null;
  const releaseStop = signals.find(
    (entry) => entry.command === "stop_dictation" && entry.stopReason === "release"
  );

  const sharedExternal = {
    recordingCreated: Boolean(artifact.newRecording?.id),
    recordingIsNew: Boolean(
      artifact.newRecording?.id && artifact.newRecording.id !== artifact.previousRecordingId
    ),
    recordingSourceDictation: artifact.newRecording?.sourceType === "dictation",
    recordingCompleted: artifact.newRecording?.status === "completed",
    transcriptPersisted: typeof artifact.newRecording?.transcriptText === "string",
    // Stricter than toggle: a spoken fixture must produce actual text, so an
    // empty transcript can never stand in for a working activation mode.
    transcriptNonEmpty: transcriptText.trim().length > 0,
    spokenFixtureMatched: fixtureMatch.matched,
    insertionActionPersisted:
      artifact.insertionAction?.recordingId === artifact.newRecording?.id,
    clipboardOnlyMode: artifact.insertionAction?.requestedMode === "clipboard_only",
    // Out-of-process cross-check: the system clipboard, read with pbpaste, must
    // hold exactly the text the sidecar persisted for this recording.
    clipboardMatchesTranscript:
      transcriptText.trim().length > 0 && clipboardText.trim() === transcriptText.trim(),
    // ...and it must no longer hold the sentinel this harness seeded before
    // activation, so a stale clipboard from an earlier run cannot pass for
    // delivery.
    clipboardOverwroteRunSentinel:
      Boolean(clipboardSentinel) &&
      Boolean(artifact.clipboard?.sentinelSeeded) &&
      clipboardText !== clipboardSentinel,
    dbRestored: artifact.dbRestored,
    settingsRestored: artifact.settingsRestored,
  };

  const speechRun = artifact.activation.speechRuns[0] ?? null;
  const speechFixtureSpoken = Boolean(
    speechRun && speechRun.code === 0 && !speechRun.timedOut && !speechRun.error
  );

  if (mode === "hold") {
    const down = artifact.activation.keyEventsPosted.find((event) => event.kind === "down");
    const up = artifact.activation.keyEventsPosted.find((event) => event.kind === "up");
    artifact.checks = {
      ...sharedExternal,
      nativeHelperBinaryPresent: Boolean(artifact.nativeHelper?.binaryPresent),
      nativeHelperProcessAliveThroughHold: Boolean(
        (artifact.nativeHelper?.pidsDuringHold?.length ?? 0) > 0 &&
          (artifact.nativeHelper?.pidsAfterHold?.length ?? 0) > 0
      ),
      syntheticHoldPosted: Boolean(down?.ok && up?.ok),
      // Exactly one press and one release were posted by this harness: no
      // second press could have stopped the session, so only the release can
      // have ended it.
      exactlyOneHoldPosted:
        artifact.activation.keyEventsPosted.length === 2 &&
        artifact.activation.keyEventsPosted[0]?.kind === "down" &&
        artifact.activation.keyEventsPosted[1]?.kind === "up",
      holdCoveredSpokenFixture: Boolean(
        speechRun?.finishedAtEpochMs &&
          artifact.activation.holdReleasedAtEpochMs &&
          artifact.activation.holdReleasedAtEpochMs >= speechRun.finishedAtEpochMs &&
          (artifact.activation.measuredHoldMs ?? 0) > 0
      ),
      speechFixtureSpoken,
    };
    artifact.selfReportedChecks = {
      dictationSetupReady: Boolean(artifact.dictationSetup?.ok),
      shortcutRegistered: Boolean(artifact.shortcutRegistered),
      holdBehaviorResolvedHoldToTalk: startSignal?.behavior === "hold_to_talk",
      holdCapabilityPressAndRelease: startSignal?.capability === "press_and_release",
      startInvokedDuringHold: Boolean(startSignal),
      stoppedWithReleaseReason: Boolean(releaseStop),
      overlayIpcAllowed:
        !/Renderer command is not allowed: get_(dictation|recording)_overlay_state/i.test(
          auditLogs
        ),
      staleDictationRouteErrorsAbsent:
        !/Distil-Whisper model not downloaded|Dictation transcription failed/i.test(
          auditLogs
        ),
    };
    return;
  }

  artifact.checks = {
    ...sharedExternal,
    // The defining external fact for hands-free: this harness posted no
    // keystrokes at all, so nothing but detected speech can have started the
    // session and nothing but the silence gate can have ended it.
    zeroKeyEventsPosted: artifact.activation.keyEventsPosted.length === 0,
    speechFixtureSpoken,
  };
  artifact.selfReportedChecks = {
    dictationSetupReady: Boolean(artifact.dictationSetup?.ok),
    shortcutRegistered: Boolean(artifact.shortcutRegistered),
    handsFreeAutoStartLogged: Boolean(artifact.activation.handsFreeAutoStartObserved),
    silenceAutoStopLogged: Boolean(artifact.activation.handsFreeAutoStopObserved),
    handsFreeMonitorStarted: !artifact.activation.handsFreeMonitorFailure,
    overlayIpcAllowed:
      !/Renderer command is not allowed: get_(dictation|recording)_overlay_state/i.test(
        auditLogs
      ),
    staleDictationRouteErrorsAbsent:
      !/Distil-Whisper model not downloaded|Dictation transcription failed/i.test(
        auditLogs
      ),
  };
}

run().catch(async (error) => {
  restoreDbFiles();
  restoreSettings();
  await writeArtifact({
    generatedAt: new Date().toISOString(),
    mode,
    appPath,
    appExecutablePath,
    sidecarPath,
    pass: false,
    status: error instanceof BlockedError ? "BLOCKED" : "FAIL",
    blockedReasons: error instanceof BlockedError ? [error.message] : [],
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
