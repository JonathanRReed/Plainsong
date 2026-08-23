#!/usr/bin/env node
/**
 * Packaged macOS capture for the three recovery shortcuts LAUNCH.md still owes
 * evidence for: paste-last, copy-last, and open-window.
 *
 * Evidence policy (this file is written to be auditable, not persuasive):
 *
 *   - Only values under a step's `external` block can carry the pass. Every one
 *     of them is a fact read from outside the app under test: the system
 *     clipboard via pbpaste, a TextEdit document body read back through
 *     AppleScript, an AX window count from System Events, a sqlite row, or
 *     bytes on disk.
 *   - Values under `selfReported` are things the app said about itself (log
 *     lines it printed, RPC result fields). They are recorded as corroboration
 *     and are deliberately excluded from the pass computation.
 *   - Values under `observations` / `soft` are external but not discriminating
 *     (they cannot tell a correct outcome from an incorrect one on their own),
 *     so they are recorded and excluded too.
 *   - When a check cannot be made external, this harness emits status BLOCKED
 *     with a precise reason and exits non-zero rather than guessing.
 *
 * Why each step is shaped the way it is:
 *
 *   - Both recovery shortcuts leave the text on the clipboard, so pbpaste alone
 *     cannot tell paste-last from copy-last. copy-last is therefore proven by a
 *     sentinel -> transcript clipboard transition; paste-last is proven by
 *     reading the text back out of a real target document (TextEdit).
 *   - The recent-result store is in-memory in the sidecar and is only written by
 *     a completed dictation with non-empty text. There is no seed RPC, so this
 *     harness drives a real dictation through the packaged app first, using
 *     `say` for a near-deterministic fixture.
 *   - Re-paste writes no database row (reuse_recent_dictation_result never
 *     reaches the insertion_actions INSERT), so there is no sqlite evidence for
 *     it and none is claimed.
 *   - Successful registration of these three shortcuts is unlogged (only
 *     failures log), so registration is proven behaviourally, never by waiting
 *     on a registration log line.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createPackagedQaProfile } from "./lib/packaged-qa-profile.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const qaProfile = createPackagedQaProfile({
  args,
  prefix: "plainsong-recovery-shortcuts-qa-",
});

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
  valueFor("--out", "artifacts/qa/macos/recovery-shortcuts.json")
);
const settleMs = Number(valueFor("--settle-ms", "4000"));
const recordPadMs = Number(valueFor("--record-pad-ms", "900"));
const seedAttemptLimit = Math.max(1, Number(valueFor("--seed-attempts", "3")));
const seedTimeoutMs = Number(valueFor("--seed-timeout-ms", "90000"));
const setupTimeoutMs = Number(valueFor("--setup-timeout-ms", "120000"));
const stepPollTimeoutMs = Number(valueFor("--step-poll-timeout-ms", "12000"));
const osascriptTimeoutMs = Number(valueFor("--osascript-timeout-ms", "45000"));
const speakTimeoutMs = Number(valueFor("--speak-timeout-ms", "30000"));
const fixtureOutputVolume = Number(valueFor("--fixture-output-volume", "65"));
const fixtureText =
  valueFor(
    "--fixture-text",
    "Plainsong recovery shortcut fixture. The lantern keeps the harbor honest."
  )?.trim() ?? "";

const sidecarPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "plainsong-sidecar"
);
const appExecutablePath = path.join(appPath, "Contents", "MacOS", "Plainsong");
const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
const configDir = qaProfile.configDir;
const settingsPath = path.join(configDir, "settings.json");
const dbPath = path.join(qaProfile.dataDir, "plainsong.db");
const dbSidecarPaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
const dbBackups = new Map();
const originalSettingsBytes = fs.existsSync(settingsPath)
  ? fs.readFileSync(settingsPath)
  : null;

// Restoration is destructive, not neutral: restoreDbFiles() writes over
// plainsong.db and rmSync's any of plainsong.db / -wal / -shm whose snapshot was
// null, and restoreSettings() can delete settings.json. plainsong.db-wal
// routinely does not exist while the app is idle and checkpointed, and appears
// the moment a running app writes. So restoring on a path where this harness
// never mutated anything is worse than doing nothing: on the "Plainsong is
// already running" block -- the one path where another process holds the
// database open -- an unconditional restore would delete the live app's -wal and
// discard its uncommitted transactions, or write a stale -shm under a live mmap.
// Both restores are therefore gated on having actually mutated the state.
let plainsongStateMutated = false;
let clipboardMutated = false;

const generatedAt = new Date().toISOString();
const runId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
const sentinelPreSeed = `PLAINSONG-QA-SENTINEL-PRESEED-${runId}`;
const sentinelCopy = `PLAINSONG-QA-SENTINEL-COPY-${runId}`;
const sentinelPaste = `PLAINSONG-QA-SENTINEL-PASTE-${runId}`;

const KEY_CODE_C = 8;
const KEY_CODE_V = 9;
const KEY_CODE_N = 45;
const KEY_CODE_SPACE = 49;

const SHORTCUTS = {
  toggleDictation: "Cmd+Shift+Space",
  openWindow: "Ctrl+Shift+N",
  repasteLastDictation: "Cmd+Ctrl+V",
  recopyLastDictation: "Cmd+Ctrl+C",
};

class BlockedError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "BlockedError";
    this.blocked = true;
  }
}

function blocked(reason) {
  throw new BlockedError(reason);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  recordings.source_type AS sourceType,
  recordings.status,
  recordings.created_at AS createdAt,
  transcripts.full_text AS transcriptText,
  transcripts.model_id AS modelId,
  transcripts.actual_provider AS actualProvider
FROM recordings
LEFT JOIN transcripts ON transcripts.recording_id = recordings.id
WHERE recordings.source_type = 'dictation'
ORDER BY recordings.created_at DESC
LIMIT 1;
`)[0] ?? null
  );
}

// ---------------------------------------------------------------------------
// Text normalisation used by every comparison. Whitespace is collapsed and the
// smart-quote/dash substitutions a rich-text editor may apply are folded back
// to ASCII. Case is preserved: nothing here is lenient enough to let a
// different string pass as a match.
// ---------------------------------------------------------------------------
function normalizeText(value) {
  return String(value ?? "")
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|h1|h2|h3|li|ul|ol|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function truncate(value, limit = 2000) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…[${text.length} chars]` : text;
}

// ---------------------------------------------------------------------------
// osascript / clipboard plumbing
// ---------------------------------------------------------------------------
function asString(value) {
  const text = String(value ?? "");
  if (/[\r\n]/.test(text)) {
    throw new Error("AppleScript string literals cannot contain newlines");
  }
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function osascript(script, { language = "AppleScript" } = {}) {
  const commandArgs = language === "AppleScript" ? ["-e", script] : ["-l", language, "-e", script];
  const result = spawnSync("osascript", commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: osascriptTimeoutMs,
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: (result.stdout ?? "").replace(/\n$/, ""),
    stderr: (result.stderr ?? "").trim(),
    spawnError: result.error ? result.error.message : null,
  };
}

function readClipboard() {
  const result = spawnSync("pbpaste", [], { encoding: "utf8", timeout: 15000 });
  if (result.status !== 0 || result.error) return null;
  return result.stdout;
}

function writeClipboard(text) {
  // Flag before the spawn, not after: a pbcopy that fails partway can still have
  // replaced the operator's pasteboard, and the writeback at the end of the run
  // is gated on this flag. Marking it here means every clipboard write in this
  // file -- including the preflight round-trip probe -- arms the restore, and a
  // run that never writes leaves the pasteboard untouched.
  clipboardMutated = true;
  const result = spawnSync("pbcopy", [], { input: text, encoding: "utf8", timeout: 15000 });
  return result.status === 0 && !result.error;
}

function pressChord(keyCode, modifiers) {
  return osascript(
    `tell application "System Events" to key code ${keyCode} using {${modifiers.join(", ")}}`
  );
}

function frontmostAppName() {
  const result = osascript(
    'tell application "System Events" to return name of first application process whose frontmost is true'
  );
  return result.ok ? result.stdout.trim() : null;
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
    error:
      result.status === 0 && match
        ? null
        : result.stderr || result.stdout || result.error || "unreadable",
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
    error: result.status === 0 ? null : result.stderr || result.error || "unknown",
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
    error: result.status === 0 ? null : result.stderr || result.error || "unknown",
  };
}

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
    const child = spawn("say", [fixtureText], { cwd: repoRoot, stdio: "ignore" });
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
  blocked(
    `The spoken seed did not play and restore cleanly: \`say\` exited code=${speech.code}, signal=${speech.signal}, timedOut=${speech.timedOut}, error=${speech.error ?? "none"}, speakerPrepared=${speech.audioOutput?.temporary?.ok ?? false}, speakerRestored=${speech.audioOutput?.restored?.ok ?? false}. No trustworthy spoken seed reached the microphone.`
  );
}

function plainsongWindowCount() {
  const result = osascript(`tell application "System Events"
  if not (exists application process "Plainsong") then return "-1"
  return (count windows of application process "Plainsong") as text
end tell`);
  if (!result.ok) return { count: null, error: result.stderr || result.spawnError };
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return { count: Number.isNaN(parsed) ? null : parsed, error: null };
}

function plainsongWindowNames() {
  const result = osascript(`tell application "System Events"
  if not (exists application process "Plainsong") then return ""
  set collected to ""
  repeat with aWindow in windows of application process "Plainsong"
    try
      set collected to collected & (name of aWindow) & "|"
    on error
      set collected to collected & "<unnamed>|"
    end try
  end repeat
  return collected
end tell`);
  if (!result.ok) return [];
  return result.stdout.split("|").map((value) => value.trim()).filter(Boolean);
}

async function pollUntil(predicate, timeoutMs, intervalMs = 300) {
  const started = Date.now();
  let last = await predicate();
  if (last.done) return { ...last, waitedMs: Date.now() - started };
  while (Date.now() - started < timeoutMs) {
    await sleep(intervalMs);
    last = await predicate();
    if (last.done) return { ...last, waitedMs: Date.now() - started };
  }
  return { ...last, waitedMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Log cursors. stderrEvidence-style tails truncate to the last 12000 chars and
// an ordinary run of this app already emits far more than that, so every step
// records a cursor into the LIVE chunk arrays before its keypress and only ever
// inspects the slice after that cursor.
// ---------------------------------------------------------------------------
function logCursor(appRun) {
  if (!appRun) return { stdout: 0, stderr: 0 };
  return {
    stdout: appRun.stdout.join("").length,
    stderr: appRun.stderr.join("").length,
  };
}

function logWindow(appRun, cursor) {
  if (!appRun) {
    return { combined: "", stdoutLength: 0, stderrLength: 0, stdoutTail: "", stderrTail: "" };
  }
  const stdout = appRun.stdout.join("").slice(cursor.stdout);
  const stderr = appRun.stderr.join("").slice(cursor.stderr);
  return {
    combined: `${stdout}\n${stderr}`,
    stdoutLength: stdout.length,
    stderrLength: stderr.length,
    stdoutTail: stdout.slice(-4000),
    stderrTail: stderr.slice(-4000),
  };
}

function recordLogWindow(appRun, cursor) {
  const window = logWindow(appRun, cursor);
  const { combined, ...stored } = window;
  return { window, stored };
}

function stderrEvidence(chunks) {
  const value = chunks.join("").trim();
  return {
    length: value.length,
    tail: value.slice(-12000),
  };
}

// ---------------------------------------------------------------------------
// Settings for the seeding dictation only.
//
// NOTE ON SCOPE: transcription.dictationInsertionMode is set to clipboard_only
// so the seeding dictation does not fire a system-wide paste into whatever
// happens to be frontmost while the harness is setting up. It is NOT
// load-bearing for the re-paste step under test: reuse_recent_dictation_result
// never reads settings, so the paste-last shortcut behaves the same whatever
// this value is.
// ---------------------------------------------------------------------------
function qaSettings(base) {
  const next = JSON.parse(JSON.stringify(base));
  next.shortcuts = {
    ...next.shortcuts,
    toggleDictation: SHORTCUTS.toggleDictation,
    openWindow: SHORTCUTS.openWindow,
    repasteLastDictation: SHORTCUTS.repasteLastDictation,
    recopyLastDictation: SHORTCUTS.recopyLastDictation,
  };
  next.transcription = {
    ...next.transcription,
    dictationPushToTalk: false,
    dictationHandsFreeEnabled: false,
    dictationLivePreviewEnabled: true,
    dictationCopyToClipboard: true,
    dictationSaveToInbox: true,
    dictationAiFormatting: false,
    dictationCategoryFormattingEnabled: false,
    dictationSnippetsEnabled: false,
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
    child.kill("SIGTERM");
    for (const { reject, method } of pending.values()) {
      reject(new Error(`Timed out waiting for ${method}`));
    }
    pending.clear();
  }, setupTimeoutMs);

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

  return { sendCommand, shutdown, stderr };
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

async function quitApp(appRun) {
  if (!appRun?.child || appRun.child.killed) return null;
  try {
    runCommand("osascript", ["-e", 'tell application id "com.plainsong.app" to quit']);
  } catch {
    appRun.child.kill("SIGTERM");
  }
  const result = await Promise.race([
    appRun.childExit,
    new Promise((resolve) => setTimeout(() => resolve(null), 6000)),
  ]);
  if (!result && !appRun.child.killed) {
    appRun.child.kill("SIGTERM");
    return await appRun.childExit;
  }
  return result;
}

// ---------------------------------------------------------------------------
// TextEdit target document.
//
// An earlier revision targeted Apple Notes on the assumption that TextEdit's
// Automation TCC was ungranted. That assumption was wrong, and Notes turned out
// to be the worse target on every axis. Measured on this machine:
//
//   - `tell application "TextEdit" to count documents` returns immediately with
//     no consent prompt, so Automation is already granted.
//   - A new TextEdit document puts the caret in an AXTextArea by itself. Notes
//     leaves focus on AXWindow after `show`, and walking its AX tree for the
//     body is unreliable — `entire contents of window 1` came back empty on
//     repeated attempts, which BLOCKED every paste-last run.
//   - `text of document` is a direct read. No AX traversal, no HTML unwrapping.
//   - An empty new document is its own pre-insert-empty proof.
//   - `close saving no` leaves nothing behind. A Notes note has to be deleted
//     explicitly, and `delete` only moves it to Recently Deleted, so failed runs
//     accumulated litter in the user's account.
//
// Always create a NEW document and close only that one, so any document the
// user already had open is untouched.
// ---------------------------------------------------------------------------
function createDisposableDocument() {
  const result = osascript(`tell application "TextEdit"
  activate
  set newDoc to make new document
  return name of newDoc
end tell`);
  if (!result.ok || !result.stdout.trim()) {
    blocked(
      `Could not create the disposable TextEdit target: ${
        result.stderr || result.spawnError || `exit ${result.status}`
      }. Automation permission for TextEdit must be granted to the process running this harness.`
    );
  }
  return result.stdout.trim();
}

function readDocumentText(documentName) {
  const result = osascript(
    `tell application "TextEdit" to return text of document ${asString(documentName)}`
  );
  if (!result.ok) return null;
  return result.stdout;
}

function showDocument(documentName) {
  return osascript(`tell application "TextEdit"
  activate
  set index of document ${asString(documentName)} to 1
end tell`);
}

/**
 * Close the disposable document without saving.
 *
 * The recorded name is NOT a stable handle. TextEdit renames an untitled
 * document after its first line of content, so the document created as
 * "Untitled" is called "Plane Song Recovery Shortcut" by the time the pasted
 * transcript lands in it, and closing by the original name silently leaves it
 * open. Observed on a real run, which is why the fallback exists.
 *
 * So: try the recorded name, then fall back to closing the document whose text
 * matches what this run pasted. Both are scoped to one document, so a document
 * the user already had open is never touched.
 */
function closeDisposableDocument(documentName, expectedText) {
  if (!documentName) return { attempted: false, ok: false, error: null };

  const byName = osascript(
    `tell application "TextEdit" to close document ${asString(documentName)} saving no`
  );
  if (byName.ok) {
    return {
      attempted: true,
      ok: true,
      strategy: "recorded-name",
      error: null,
      note: "Closed without saving, so nothing reaches disk and no other open document is touched.",
    };
  }

  const needle = normalizeText(expectedText ?? "");
  if (!needle) {
    return {
      attempted: true,
      ok: false,
      strategy: "recorded-name",
      error: byName.stderr || byName.spawnError || `exit ${byName.status}`,
    };
  }

  const byContent = osascript(`tell application "TextEdit"
  repeat with i from (count of documents) to 1 by -1
    try
      if (text of document i) contains ${asString(expectedText)} then
        close document i saving no
        return "closed"
      end if
    end try
  end repeat
  return "not-found"
end tell`);

  const closed = byContent.ok && byContent.stdout.trim() === "closed";
  return {
    attempted: true,
    ok: closed,
    strategy: closed ? "content-match" : "none",
    error: closed
      ? null
      : `close by recorded name failed (${
          byName.stderr || byName.spawnError || `exit ${byName.status}`
        }); content-match fallback returned ${
          byContent.ok ? byContent.stdout.trim() : byContent.stderr || byContent.spawnError
        }`,
    note: "TextEdit renames untitled documents after their first line, so the recorded name goes stale once the transcript is pasted.",
  };
}

function focusedElementRole(processName) {
  const result = osascript(`tell application "System Events"
  tell application process ${asString(processName)}
    try
      return role of (value of attribute "AXFocusedUIElement")
    on error
      return "unavailable"
    end try
  end tell
end tell`);
  return result.ok ? result.stdout.trim() : "unavailable";
}

/**
 * Confirm the caret is in the TextEdit document body, polling because window
 * activation is asynchronous. A new TextEdit document focuses its AXTextArea on
 * its own, so unlike the Notes path this needs no AX-tree walking — it only has
 * to verify, and BLOCK rather than press a chord into an unknown focus target.
 */
async function focusDocumentBody({ attempts: maxAttempts = 8, intervalMs = 250 } = {}) {
  const attempts = [];
  let role = "unavailable";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    role = focusedElementRole("TextEdit");
    attempts.push({ strategy: "new-document-autofocus", attempt, focusedRole: role });
    if (role === "AXTextArea") {
      return { focused: true, strategy: "new-document-autofocus", attempts, focusedRole: role };
    }
    await sleep(intervalMs);
  }

  // TextEdit is frontmost but something else inside it holds focus. One click
  // into the text area is the only remaining lever, and it is still external.
  const click = osascript(`tell application "System Events"
  tell application process "TextEdit"
    try
      set focused of (text area 1 of scroll area 1 of window 1) to true
      return "applied"
    on error errMsg
      return "error: " & errMsg
    end try
  end tell
end tell`);
  role = focusedElementRole("TextEdit");
  attempts.push({
    strategy: "ax-text-area-1",
    applied: click.ok,
    result: click.ok ? click.stdout.trim() : null,
    error: click.ok ? null : click.stderr || click.spawnError,
    focusedRole: role,
  });

  return {
    focused: role === "AXTextArea",
    strategy: role === "AXTextArea" ? "ax-text-area-1" : null,
    attempts,
    focusedRole: role,
  };
}

function asarContains(needle) {
  const result = spawnSync("grep", ["-a", "-q", needle, asarPath], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60000,
  });
  return result.status === 0;
}

function plainsongProcessPids() {
  const result = spawnSync("pgrep", ["-f", "Plainsong.app/Contents/MacOS/Plainsong"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 15000,
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function writeArtifact(artifact) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(artifact, null, 2));
}

// ---------------------------------------------------------------------------

const artifact = {
  generatedAt,
  runId,
  harness: "capture-packaged-macos-recovery-shortcuts",
  launchGate:
    "Confirm paste-last, copy-last, and open-window shortcuts behave as labeled",
  appPath,
  appExecutablePath,
  sidecarPath,
  asarPath,
  dbPath,
  settingsPath,
  shortcutsUnderTest: SHORTCUTS,
  fixtureText,
  pass: false,
  status: "FAIL",
  reason: null,
  error: null,
  evidencePolicy: {
    passCarrying:
      "Only `external` values (system clipboard via pbpaste, TextEdit document text read back via AppleScript, AX window counts via System Events, sqlite rows, bytes on disk) contribute to `pass`.",
    selfReportedNotPassCarrying:
      "`selfReported` values are log lines the app printed or fields the app returned about itself. Recorded as corroboration only; excluded from `pass`.",
    nonDiscriminating:
      "`observations` / `soft` values are external but cannot distinguish a correct outcome from an incorrect one, so they are excluded from `pass`.",
    noHumanAttestation:
      "There is no --observed style attestation flag in this harness; nothing here can be passed by a human assertion.",
  },
  scope: {
    seedAttemptLimit,
    seedTimeoutMs,
    speakTimeoutMs,
    fixtureOutputVolume,
    stepPollTimeoutMs,
    pasteStrategyNotAsserted:
      "The paste-last step accepts either the AX-direct insert or the native Cmd+V fallback. Which strategy the sidecar used is not asserted, because there is currently no machine-verified proof the AX-direct path works on this Mac.",
    noSqliteEvidenceForRepaste:
      "reuse_recent_dictation_result never reaches the insertion_actions INSERT, so re-paste writes no database row and none is claimed here.",
    insertionModeNotLoadBearing:
      "transcription.dictationInsertionMode is set to clipboard_only for the seeding dictation only. reuse_recent_dictation_result never reads settings, so it does not gate the re-paste.",
    registrationProvenBehaviourally:
      "Successful registration of these three shortcuts is unlogged in the app, so registration is proven by external effect, never by waiting on a registration log line.",
    clipboardRestoreIsPlainTextOnly:
      "The operator clipboard is snapshotted and restored as plain text only; rich-text flavours present before the run are not preserved.",
    restoreIsGatedOnMutation:
      "Database/settings restore runs only if this harness got as far as launching the setup sidecar, and the clipboard writeback runs only if this harness actually wrote to the clipboard. On an early BLOCKED path (most importantly 'Plainsong is already running') nothing was mutated, so nothing is restored and stateRestore.skipped is set instead: an unconditional restore there would delete a live app's plainsong.db-wal rather than put anything back.",
  },
  preflight: { external: {}, details: {} },
  seed: { attempts: [], external: {}, selfReported: {}, details: {} },
  steps: {
    copyLast: null,
    pasteLast: null,
    openWindow: null,
  },
  external: {},
  selfReported: {},
  stateRestore: {
    note: "dbRestored / settingsRestored mean 'the bytes on disk at the end of the run match the pre-run snapshot'. They are true either because a restore put them back or because the run never mutated them and skipped the restore; `skipped` says which.",
    originalDbHashes: null,
    restoredDbHashes: null,
    originalSettingsHash: hashBytes(originalSettingsBytes),
    restoredSettingsHash: null,
    dbRestored: false,
    settingsRestored: false,
    skipped: false,
    skippedReason: null,
    clipboardRestored: null,
    clipboardSkippedReason: null,
    disposableNote: null,
  },
  appExit: null,
  appStdout: { length: 0, tail: "" },
  appStderr: { length: 0, tail: "" },
  setupSidecarExit: null,
  setupSidecarStderr: { length: 0, tail: "" },
};

snapshotDbFiles();
artifact.stateRestore.originalDbHashes = Object.fromEntries(
  [...dbBackups.entries()].map(([filePath, bytes]) => [filePath, hashBytes(bytes)])
);

const originalClipboard = readClipboard();

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------
function preflight() {
  if (process.platform !== "darwin") {
    blocked("capture-packaged-macos-recovery-shortcuts can only run on macOS.");
  }
  if (!fs.existsSync(sidecarPath)) {
    blocked(`Packaged sidecar not found at ${sidecarPath}`);
  }
  if (!fs.existsSync(appExecutablePath)) {
    blocked(`Packaged app executable not found at ${appExecutablePath}`);
  }
  if (!fs.existsSync(asarPath)) {
    blocked(`Packaged app.asar not found at ${asarPath}`);
  }
  if (!fs.existsSync(dbPath)) {
    blocked(`Plainsong database not found at ${dbPath}`);
  }
  if (!fixtureText) {
    blocked("The spoken fixture sentence cannot be empty.");
  }
  if (!Number.isFinite(speakTimeoutMs) || speakTimeoutMs <= 0) {
    blocked("--speak-timeout-ms must be a positive number of milliseconds.");
  }
  if (
    !Number.isFinite(fixtureOutputVolume) ||
    fixtureOutputVolume < 1 ||
    fixtureOutputVolume > 100
  ) {
    blocked("--fixture-output-volume must be a number from 1 through 100.");
  }
  if (
    !fs.existsSync("/System/Applications/TextEdit.app") &&
    !fs.existsSync("/Applications/TextEdit.app")
  ) {
    blocked("TextEdit is not installed; the paste-last target document is unavailable.");
  }

  const runningPids = plainsongProcessPids();
  if (runningPids.length > 0) {
    blocked(
      `Plainsong is already running (pids ${runningPids.join(", ")}). The app takes a single-instance lock, so a second launch would exit immediately and the shortcuts under test would belong to the other instance. Quit Plainsong and rerun.`
    );
  }

  // Bytes on disk: the packaged build must actually contain the recovery
  // shortcut wiring, otherwise the whole run is measuring nothing.
  const hasRecoveryWiring = asarContains("dictation recovery shortcut");
  const hasOpenWindowWiring = asarContains("failed to register open window shortcut");

  // System Events must be reachable, otherwise every keypress in this harness
  // silently does nothing and the steps would fail for an environment reason.
  const frontmostProbe = osascript(
    'tell application "System Events" to return name of first application process whose frontmost is true'
  );
  if (!frontmostProbe.ok) {
    blocked(
      `System Events is not driveable from this process: ${
        frontmostProbe.stderr || frontmostProbe.spawnError
      }. Grant Accessibility permission to the terminal running this harness.`
    );
  }

  const clipboardProbeToken = `PLAINSONG-QA-CLIPBOARD-PROBE-${runId}`;
  const clipboardWritable = writeClipboard(clipboardProbeToken);
  const clipboardRoundTrip = readClipboard() === clipboardProbeToken;
  if (!clipboardWritable || !clipboardRoundTrip) {
    blocked("pbcopy/pbpaste round trip failed; clipboard evidence cannot be read externally.");
  }

  artifact.preflight.details = {
    frontmostAppAtStart: frontmostProbe.stdout.trim(),
    originalClipboardLength: originalClipboard === null ? null : originalClipboard.length,
    runningPlainsongPidsBeforeLaunch: runningPids,
  };
  artifact.preflight.external = {
    packagedBuildHasRecoveryShortcutWiring: hasRecoveryWiring,
    packagedBuildHasOpenWindowShortcutWiring: hasOpenWindowWiring,
    systemEventsDriveable: true,
    clipboardReadWriteRoundTrip: true,
    noPriorPlainsongInstance: true,
  };

  if (!hasRecoveryWiring || !hasOpenWindowWiring) {
    blocked(
      "The packaged app.asar does not contain the recovery/open-window shortcut registration strings; this build predates the wiring under test."
    );
  }
}

// ---------------------------------------------------------------------------
// Seed: drive one real dictation through the packaged app so the sidecar's
// in-memory recent-result store is non-empty. There is no seed RPC.
// ---------------------------------------------------------------------------
async function seedRecentDictationResult(appRun) {
  let seeded = null;

  for (let attempt = 1; attempt <= seedAttemptLimit; attempt += 1) {
    const previous = latestDictationRecording();
    const record = {
      attempt,
      previousRecordingId: previous?.id ?? null,
      sayExit: null,
      recording: null,
      transcriptNonEmpty: false,
    };

    pressChord(KEY_CODE_SPACE, ["command down", "shift down"]);
    await sleep(800);

    record.sayExit = await speakFixture();
    assertSpeechFixturePlayed(record.sayExit);

    await sleep(recordPadMs);
    pressChord(KEY_CODE_SPACE, ["command down", "shift down"]);

    const polled = await pollUntil(
      async () => {
        const latest = latestDictationRecording();
        const isNew =
          latest &&
          latest.id !== record.previousRecordingId &&
          latest.sourceType === "dictation" &&
          latest.status === "completed";
        return { done: Boolean(isNew), latest };
      },
      seedTimeoutMs,
      1000
    );

    record.recording = polled.latest
      ? {
          id: polled.latest.id,
          status: polled.latest.status,
          createdAt: polled.latest.createdAt,
          modelId: polled.latest.modelId,
          actualProvider: polled.latest.actualProvider,
          transcriptText: truncate(polled.latest.transcriptText),
        }
      : null;
    record.waitedMs = polled.waitedMs;
    record.newRow = polled.done;

    const transcript = polled.done ? String(polled.latest.transcriptText ?? "") : "";
    record.transcriptNonEmpty = normalizeText(transcript).length > 0;
    artifact.seed.attempts.push(record);

    if (polled.done && record.transcriptNonEmpty) {
      seeded = { recording: polled.latest, transcript };
      break;
    }
  }

  if (!seeded) {
    blocked(
      `The seeding dictation produced no completed row with non-empty text in ${seedAttemptLimit} attempt(s). The recent-result store is written only by a completed dictation with non-empty text and there is no seed RPC, so the recovery shortcuts cannot be exercised. A human would need to check microphone input and the dictation model, then rerun.`
    );
  }

  // Established by reading the source on this tree: the text handed to
  // record_recent_dictation_result is the same `final_text` persisted as
  // transcripts.full_text (stored_text falls back to the raw transcript only
  // when final_text is empty, which is excluded above). So this sqlite value is
  // the externally-read expectation for both recovery shortcuts.
  const expectedText = seeded.transcript;
  const fixtureTokens = new Set(
    normalizeText(fixtureText).toLowerCase().replace(/[^a-z0-9\s]/g, "").split(" ").filter(Boolean)
  );
  const transcriptTokens = normalizeText(expectedText)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(" ")
    .filter(Boolean);
  const overlap = transcriptTokens.filter((token) => fixtureTokens.has(token)).length;

  // Merge, never assign: the pre-seed negative control already wrote into
  // artifact.seed.details and artifact.seed.external.
  Object.assign(artifact.seed.details, {
    recordingId: seeded.recording.id,
    createdAt: seeded.recording.createdAt,
    modelId: seeded.recording.modelId,
    actualProvider: seeded.recording.actualProvider,
    expectedText: truncate(expectedText),
    expectedTextNormalized: truncate(normalizeText(expectedText)),
    expectedTextLength: expectedText.length,
    attemptsUsed: artifact.seed.attempts.length,
  });
  Object.assign(artifact.seed.external, {
    newCompletedDictationRowInSqlite: true,
    seedTranscriptNonEmpty: true,
  });
  artifact.seed.observations = {
    // Non-discriminating: a transcript that does not resemble the fixture still
    // proves the recovery shortcuts, because every comparison below is against
    // the sqlite transcript rather than the spoken sentence.
    spokenFixtureTokenOverlap: transcriptTokens.length === 0 ? 0 : overlap / transcriptTokens.length,
    transcriptResemblesSpokenFixture:
      transcriptTokens.length > 0 && overlap / transcriptTokens.length >= 0.5,
  };

  return expectedText;
}

// ---------------------------------------------------------------------------
// Step: copy-last (Cmd+Ctrl+C)
// ---------------------------------------------------------------------------
async function runCopyLastStep(appRun, expectedText) {
  const step = {
    label: "copy-last",
    shortcut: SHORTCUTS.recopyLastDictation,
    chord: "key code 8 using {command down, control down}",
    external: {},
    selfReported: {},
    observations: {},
    details: {},
  };
  // Registered before the first assertion so a BLOCKED run still carries
  // whatever this step managed to observe.
  artifact.steps.copyLast = step;
  step.completed = false;

  const sentinelInstalled = writeClipboard(sentinelCopy);
  const clipboardBefore = readClipboard();
  step.external.sentinelInstalledBeforePress = sentinelInstalled && clipboardBefore === sentinelCopy;

  const frontmostAtPress = frontmostAppName();
  const cursor = logCursor(appRun);
  const press = pressChord(KEY_CODE_C, ["command down", "control down"]);
  step.details.keypressDispatched = press.ok;
  step.details.keypressError = press.ok ? null : press.stderr || press.spawnError;

  const polled = await pollUntil(
    async () => {
      const clipboard = readClipboard();
      return {
        done: clipboard !== null && normalizeText(clipboard) === normalizeText(expectedText),
        clipboard,
      };
    },
    stepPollTimeoutMs,
    250
  );

  const { window, stored } = recordLogWindow(appRun, cursor);
  const clipboardAfter = polled.clipboard;

  step.details.frontmostAppAtPress = frontmostAtPress;
  step.details.waitedMs = polled.waitedMs;
  step.details.clipboardBefore = truncate(clipboardBefore, 400);
  step.details.clipboardAfter = truncate(clipboardAfter, 2000);
  step.details.logCursor = cursor;

  step.external.clipboardLeftSentinelAfterPress =
    clipboardAfter !== null && clipboardAfter !== sentinelCopy;
  step.external.clipboardMatchesSeedTranscript =
    clipboardAfter !== null && normalizeText(clipboardAfter) === normalizeText(expectedText);

  step.observations.clipboardExactMatch = clipboardAfter === expectedText;

  step.selfReported = {
    note: "Log lines the app printed inside this step's cursor window. Corroboration only; excluded from pass.",
    logWindow: stored,
    recopyCommandMentioned: /recopy_dictation_result/i.test(window.combined),
    recoveryShortcutRejectionWarning: /dictation recovery shortcut failed/i.test(window.combined),
  };

  step.completed = true;
  return step;
}

// ---------------------------------------------------------------------------
// Step: paste-last (Cmd+Ctrl+V) into a disposable TextEdit document
// ---------------------------------------------------------------------------
async function runPasteLastStep(appRun, expectedText, noteState) {
  const step = {
    label: "paste-last",
    shortcut: SHORTCUTS.repasteLastDictation,
    chord: "key code 9 using {command down, control down}",
    target: "TextEdit (disposable unsaved document)",
    external: {},
    selfReported: {},
    observations: {},
    details: {},
  };
  artifact.steps.pasteLast = step;
  step.completed = false;

  osascript('tell application "TextEdit" to activate');
  await sleep(900);

  const documentName = createDisposableDocument();
  noteState.documentName = documentName;
  // Cleanup needs a content handle too: the recorded name goes stale as soon as
  // TextEdit renames the document after the pasted transcript's first line.
  noteState.expectedText = expectedText;
  await sleep(600);
  showDocument(documentName);
  await sleep(600);

  const focus = await focusDocumentBody();
  step.details.documentName = documentName;
  step.details.focus = focus;
  if (!focus.focused) {
    blocked(
      `Could not place the caret in the TextEdit document body (focused element role: ${focus.focusedRole}). Pressing the paste chord without a focused text area would prove nothing about paste-last, so this run stops here rather than guessing.`
    );
  }

  // A brand-new document is empty by construction, so this reads as a genuine
  // pre-insert measurement rather than a restatement of control flow: if it is
  // ever non-empty, something is wrong and the run must not pass.
  const bodyBefore = readDocumentText(documentName);
  const bodyBeforeText = normalizeText(bodyBefore);
  step.details.documentTextBefore = truncate(bodyBeforeText, 1000);
  step.external.disposableDocumentReadableBeforePress = bodyBefore !== null;
  step.external.documentEmptyBeforePress = bodyBefore !== null && bodyBeforeText === "";
  step.external.documentLackedSeedTextBeforePress =
    bodyBefore !== null && !bodyBeforeText.includes(normalizeText(expectedText));

  // A sentinel on the clipboard before the press means a bare Cmd+V could only
  // have produced the sentinel. Finding the seed transcript in the note body
  // therefore proves the app re-supplied the text, not that something replayed
  // whatever happened to be on the clipboard.
  const sentinelInstalled = writeClipboard(sentinelPaste);
  const clipboardBefore = readClipboard();
  step.external.sentinelInstalledBeforePress =
    sentinelInstalled && clipboardBefore === sentinelPaste;
  step.details.clipboardBefore = truncate(clipboardBefore, 400);

  // is_self_activation_target nulls the repaste target when Plainsong itself is
  // frontmost, so TextEdit has to own the front window at the moment of the
  // press. Re-checking focus alongside it is deliberate: a browser probe run
  // earlier in this project's history proved that an app can be frontmost while
  // something other than the intended field holds focus, which would send the
  // paste somewhere the harness never inspects.
  let frontmost = frontmostAppName();
  const activationAttempts = [{ frontmost }];
  for (let attempt = 0; attempt < 3 && frontmost !== "TextEdit"; attempt += 1) {
    osascript('tell application "TextEdit" to activate');
    await sleep(1000);
    frontmost = frontmostAppName();
    activationAttempts.push({ frontmost });
  }
  step.details.activationAttempts = activationAttempts;
  step.details.frontmostImmediatelyBeforePress = frontmost;
  step.external.textEditFrontmostImmediatelyBeforePress = frontmost === "TextEdit";
  if (frontmost !== "TextEdit") {
    blocked(
      `TextEdit never became the frontmost application (frontmost was "${frontmost}"). reuse_recent_dictation_result resolves the current frontmost app at press time and nulls the target when Plainsong itself is in front, so pressing the chord now could not test paste-last.`
    );
  }

  const focusAtPress = focusedElementRole("TextEdit");
  step.details.focusedRoleImmediatelyBeforePress = focusAtPress;
  step.external.documentFocusedImmediatelyBeforePress = focusAtPress === "AXTextArea";
  if (focusAtPress !== "AXTextArea") {
    blocked(
      `TextEdit is frontmost but focus sits on ${focusAtPress}, not the document body. The paste would land somewhere this harness does not read back, so it would prove nothing about paste-last.`
    );
  }

  const cursor = logCursor(appRun);
  step.details.logCursor = cursor;

  // Press on a retry loop rather than once. The clipboard proves the in-memory
  // recent-result store is populated by the time copy-last runs, but the paste
  // still has to win a race against the app finishing its own post-dictation
  // teardown, and a single press that lands early hits the "No recent dictation
  // result is available to reuse" early return with no way to recover inside the
  // poll. Re-pressing is safe: the poll stops at the first read-back that
  // contains the transcript, and `includes` is unaffected if a slow first press
  // and a retry both land. Press count is recorded so a run that needed three
  // attempts does not read as a clean one-shot.
  const presses = [];
  let polled = { done: false, text: "", waitedMs: 0 };

  for (let attempt = 1; attempt <= 3 && !polled.done; attempt += 1) {
    const press = pressChord(KEY_CODE_V, ["command down", "control down"]);
    presses.push({
      attempt,
      dispatched: press.ok,
      error: press.ok ? null : press.stderr || press.spawnError,
    });

    const round = await pollUntil(
      async () => {
        const body = readDocumentText(documentName);
        const text = normalizeText(body);
        return { done: text.includes(normalizeText(expectedText)), body, text };
      },
      Math.max(2000, Math.floor(stepPollTimeoutMs / 3)),
      500
    );
    polled = { ...round, waitedMs: polled.waitedMs + round.waitedMs };
  }

  step.details.presses = presses;
  step.details.pressCount = presses.length;
  step.details.keypressDispatched = presses.some((entry) => entry.dispatched);
  step.details.keypressError = presses.find((entry) => entry.error)?.error ?? null;

  const { window, stored } = recordLogWindow(appRun, cursor);
  const clipboardAfter = readClipboard();

  step.details.waitedMs = polled.waitedMs;
  step.details.documentTextAfter = truncate(polled.text, 2000);
  step.details.clipboardAfter = truncate(clipboardAfter, 2000);

  step.external.documentContainsSeedTextAfterPress = Boolean(polled.done);
  step.external.documentChangedAfterPress = polled.text !== bodyBeforeText;
  // The sentinel was on the clipboard before the press, so a bare Cmd+V could
  // only have produced the sentinel. Its absence is what separates "the app
  // re-supplied the text" from "something replayed the clipboard".
  step.external.documentDoesNotContainClipboardSentinel = !polled.text.includes(
    normalizeText(sentinelPaste)
  );

  step.observations = {
    note: "External but non-discriminating: paste-last keeps the text in the clipboard (keep_text_in_clipboard = true), so the clipboard alone cannot tell paste-last from copy-last. Recorded, not pass-carrying.",
    clipboardAfterPressMatchesSeedTranscript:
      clipboardAfter !== null && normalizeText(clipboardAfter) === normalizeText(expectedText),
    clipboardLeftSentinel: clipboardAfter !== null && clipboardAfter !== sentinelPaste,
  };

  step.selfReported = {
    note: "Log lines the app printed inside this step's cursor window. Corroboration only; excluded from pass.",
    logWindow: stored,
    repasteCommandMentioned: /repaste_dictation_result/i.test(window.combined),
    recoveryShortcutRejectionWarning: /dictation recovery shortcut failed/i.test(window.combined),
  };

  step.completed = true;
  return step;
}

// ---------------------------------------------------------------------------
// Step: open-window (Ctrl+Shift+N)
//
// The app opens a visible window at startup, so the window has to be taken away
// first; otherwise "a window exists afterwards" proves nothing. Closing the
// window is the hide mechanism because it exercises both branches of
// showAndFocusMainWindow: with minimize-to-tray on, close hides the window and
// show()/focus() brings it back; with it off, close destroys the window and
// createMainWindow() makes a new one. Either way the AX count goes 0 -> 1.
// ---------------------------------------------------------------------------
async function runOpenWindowStep(appRun) {
  const step = {
    label: "open-window",
    shortcut: SHORTCUTS.openWindow,
    chord: "key code 45 using {control down, shift down}",
    external: {},
    selfReported: {},
    soft: {},
    details: {},
  };
  artifact.steps.openWindow = step;
  step.completed = false;

  const before = plainsongWindowCount();
  step.details.windowCountBeforeHide = before.count;
  step.details.windowNamesBeforeHide = plainsongWindowNames();
  if (before.count === null || before.count < 0) {
    blocked(
      `System Events cannot see the Plainsong process, so the AX window count is unavailable${
        before.error ? `: ${before.error}` : "."
      }`
    );
  }

  let hideStrategy = before.count === 0 ? "already-zero" : null;
  const hideAttempts = [];

  for (let attempt = 0; attempt < 4 && hideStrategy === null; attempt += 1) {
    let closed = osascript(`tell application "System Events"
  tell application process "Plainsong"
    click (first button of window 1 whose subrole is "AXCloseButton")
  end tell
end tell`);
    if (!closed.ok) {
      closed = osascript(`tell application "System Events"
  tell application process "Plainsong"
    click button 1 of window 1
  end tell
end tell`);
    }
    await sleep(900);
    const counted = plainsongWindowCount();
    hideAttempts.push({
      strategy: "close-button",
      applied: closed.ok,
      error: closed.ok ? null : closed.stderr || closed.spawnError,
      windowCount: counted.count,
    });
    if (counted.count === 0) hideStrategy = "close-button";
    if (!closed.ok && counted.count !== 0) break;
  }

  if (hideStrategy === null) {
    const hidden = osascript(
      'tell application "System Events" to set visible of application process "Plainsong" to false'
    );
    await sleep(1200);
    const counted = plainsongWindowCount();
    hideAttempts.push({
      strategy: "app-hide",
      applied: hidden.ok,
      error: hidden.ok ? null : hidden.stderr || hidden.spawnError,
      windowCount: counted.count,
    });
    if (counted.count === 0) hideStrategy = "app-hide";
  }

  step.details.hideAttempts = hideAttempts;
  step.details.hideStrategy = hideStrategy;

  const afterHide = plainsongWindowCount();
  step.details.windowCountAfterHide = afterHide.count;
  step.details.windowNamesAfterHide = plainsongWindowNames();
  step.external.windowCountZeroBeforePress = afterHide.count === 0;

  if (afterHide.count !== 0) {
    blocked(
      `Could not reduce the Plainsong AX window count to 0 before the press (still ${
        afterHide.count
      }, windows: ${JSON.stringify(step.details.windowNamesAfterHide)}). Without a 0 baseline, "a window exists afterwards" would prove nothing, so no pass is claimed.`
    );
  }

  const cursor = logCursor(appRun);
  const press = pressChord(KEY_CODE_N, ["control down", "shift down"]);
  step.details.keypressDispatched = press.ok;
  step.details.keypressError = press.ok ? null : press.stderr || press.spawnError;
  step.details.logCursor = cursor;

  const polled = await pollUntil(
    async () => {
      const counted = plainsongWindowCount();
      return { done: typeof counted.count === "number" && counted.count >= 1, counted };
    },
    stepPollTimeoutMs,
    400
  );

  const { window, stored } = recordLogWindow(appRun, cursor);

  step.details.waitedMs = polled.waitedMs;
  step.details.windowCountAfterPress = polled.counted?.count ?? null;
  step.details.windowNamesAfterPress = plainsongWindowNames();
  step.external.windowCountAtLeastOneAfterPress = Boolean(polled.done);

  // macOS 26 cooperative activation can leave the app bouncing in the Dock
  // rather than taking the front window, so frontmost is a soft signal only.
  step.soft = {
    note: "External but soft: macOS 26 cooperative activation can leave the app bouncing in the Dock instead of taking focus, so frontmost is not pass-carrying.",
    frontmostAppAfterPress: frontmostAppName(),
  };
  step.soft.plainsongFrontmostAfterPress = step.soft.frontmostAppAfterPress === "Plainsong";

  step.selfReported = {
    note: "Log lines the app printed inside this step's cursor window. Corroboration only; excluded from pass.",
    logWindow: stored,
    openWindowRegistrationFailureLogged: /failed to register open window shortcut/i.test(
      window.combined
    ),
  };

  if (!polled.done && hideStrategy === "app-hide") {
    blocked(
      "The close-button hide path was unavailable and the app-hide fallback was used. showAndFocusMainWindow() calls show()/focus() on the window rather than unhiding the application, so a non-recovery after an app-level hide is not evidence of a broken shortcut. Rerun with the main window closable to get a real verdict."
    );
  }

  step.completed = true;
  return step;
}

// ---------------------------------------------------------------------------

async function run() {
  let appRun = null;
  let setupSidecar = null;
  const noteState = { documentName: null, expectedText: null };

  try {
    preflight();

    // Everything above this line is read-only with respect to the operator's
    // Plainsong state, and preflight has just proved no other Plainsong process
    // holds the database. From here on this harness owns that state: the setup
    // sidecar opens plainsong.db as soon as it starts (which can create -wal and
    // -shm), and save_settings below rewrites settings.json. Arm the restore
    // here rather than after save_settings so a sidecar that starts and then
    // fails does not leak files the snapshot does not know about.
    plainsongStateMutated = true;
    setupSidecar = launchSidecar();
    const originalSettings = await setupSidecar.sendCommand("get_settings", {});
    await setupSidecar.sendCommand("save_settings", { settings: qaSettings(originalSettings) });
    const dictationSetup = await setupSidecar.sendCommand("verify_dictation_setup", {});
    artifact.seed.selfReported.dictationSetup = {
      note: "Sidecar's own readiness report. Corroboration only; excluded from pass.",
      ok: Boolean(dictationSetup?.ok),
      summary: dictationSetup?.summary ?? null,
    };
    artifact.setupSidecarExit = await setupSidecar.shutdown();
    artifact.setupSidecarStderr = stderrEvidence(setupSidecar.stderr);
    setupSidecar = null;

    if (!dictationSetup?.ok) {
      blocked(
        `Dictation setup is not ready (${
          dictationSetup?.summary ?? "unknown"
        }), so the seeding dictation cannot be driven and the recovery shortcuts cannot be exercised.`
      );
    }

    appRun = launchApp();
    const bootstrapped = await waitForLog(
      appRun.stdout,
      /registered dictation shortcut/i,
      20000
    );
    artifact.seed.selfReported.dictationShortcutRegistrationLogged = bootstrapped;
    if (!bootstrapped) {
      blocked(
        "The packaged app never logged dictation shortcut registration, so applyElectronGlobalShortcuts did not complete and the seeding dictation cannot be driven. (This gate is used only to know the app finished bootstrapping; the three shortcuts under test are proven behaviourally below.)"
      );
    }

    const startupLogs = `${appRun.stdout.join("")}\n${appRun.stderr.join("")}`;
    artifact.selfReported.startupShortcutLog = {
      note: "Log lines the app printed during startup. Corroboration only; excluded from pass.",
      conflictSkipLogged: /conflict detected, skipping registration/i.test(startupLogs),
      openWindowRegistrationFailureLogged: /failed to register open window shortcut/i.test(
        startupLogs
      ),
      recoveryRegistrationFailureLogged: /failed to register dictation recovery shortcut/i.test(
        startupLogs
      ),
    };

    await sleep(settleMs);

    // Negative control, external: with a fresh app process the in-memory
    // recent-result store is empty, so copy-last must leave the clipboard
    // untouched. This is the "before" half of the copy-last transition; on its
    // own it proves nothing about registration.
    const negativeSentinelInstalled = writeClipboard(sentinelPreSeed);
    const negativeCursor = logCursor(appRun);
    pressChord(KEY_CODE_C, ["command down", "control down"]);
    await sleep(2500);
    const clipboardAfterNegative = readClipboard();
    const negativeLog = recordLogWindow(appRun, negativeCursor);
    artifact.seed.details.negativeControl = {
      sentinelInstalled: negativeSentinelInstalled,
      clipboardAfter: truncate(clipboardAfterNegative, 400),
    };
    artifact.seed.selfReported.negativeControl = {
      note: "Log lines the app printed inside the negative-control cursor window. Corroboration only; excluded from pass. A rejection warning here is the expected shape when nothing has been dictated yet.",
      logWindow: negativeLog.stored,
      recoveryShortcutRejectionWarning: /dictation recovery shortcut failed/i.test(
        negativeLog.window.combined
      ),
    };
    artifact.seed.external.recopyBeforeSeedLeftClipboardUnchanged =
      negativeSentinelInstalled && clipboardAfterNegative === sentinelPreSeed;

    const expectedText = await seedRecentDictationResult(appRun);

    artifact.steps.copyLast = await runCopyLastStep(appRun, expectedText);
    artifact.steps.pasteLast = await runPasteLastStep(appRun, expectedText, noteState);
    artifact.steps.openWindow = await runOpenWindowStep(appRun);

    artifact.status = "PASS";
  } catch (error) {
    if (error instanceof BlockedError) {
      artifact.status = "BLOCKED";
      artifact.reason = error.message;
    } else {
      artifact.status = "FAIL";
      artifact.error = error instanceof Error ? error.message : String(error);
    }
  } finally {
    artifact.stateRestore.disposableDocument = {
      documentName: noteState.documentName,
      ...closeDisposableDocument(noteState.documentName, noteState.expectedText),
    };

    if (setupSidecar) {
      artifact.setupSidecarExit = await setupSidecar.shutdown();
      artifact.setupSidecarStderr = stderrEvidence(setupSidecar.stderr);
    }
    if (appRun) {
      artifact.appExit = await quitApp(appRun);
      artifact.appStdout = stderrEvidence(appRun.stdout);
      artifact.appStderr = stderrEvidence(appRun.stderr);
    }

    if (plainsongStateMutated) {
      restoreDbFiles();
      restoreSettings();
    } else {
      artifact.stateRestore.skipped = true;
      artifact.stateRestore.skippedReason =
        "This run exited before it launched the setup sidecar, so it never wrote settings.json or plainsong.db. Restoring anyway would have written over -- or deleted the -wal/-shm of -- a database this harness did not touch and, on the already-running block, one another process still has open.";
    }

    // Read-only either way: on the skipped path this just records that the files
    // on disk still match the pre-run snapshot.
    artifact.stateRestore.restoredDbHashes = dbHashes();
    artifact.stateRestore.restoredSettingsHash = fs.existsSync(settingsPath)
      ? hashBytes(fs.readFileSync(settingsPath))
      : null;
    artifact.stateRestore.dbRestored =
      JSON.stringify(artifact.stateRestore.restoredDbHashes) ===
      JSON.stringify(artifact.stateRestore.originalDbHashes);
    artifact.stateRestore.settingsRestored =
      artifact.stateRestore.restoredSettingsHash === artifact.stateRestore.originalSettingsHash;

    if (!clipboardMutated) {
      artifact.stateRestore.clipboardRestored = null;
      artifact.stateRestore.clipboardSkippedReason =
        "This run never wrote to the clipboard, so the operator's pasteboard was left exactly as found and no writeback was performed.";
    } else if (originalClipboard !== null) {
      writeClipboard(originalClipboard);
      artifact.stateRestore.clipboardRestored = readClipboard() === originalClipboard;
    } else {
      artifact.stateRestore.clipboardRestored = null;
      artifact.stateRestore.clipboardSkippedReason =
        "pbpaste could not be read at startup, so there is no snapshot to write back; the clipboard is left holding whatever this run last put there.";
    }
  }

  // Roll the per-step external checks up into one flat, pass-carrying map.
  const external = {};
  for (const [key, value] of Object.entries(artifact.preflight.external)) {
    external[`preflight.${key}`] = value;
  }
  for (const [key, value] of Object.entries(artifact.seed.external)) {
    external[`seed.${key}`] = value;
  }
  for (const [stepKey, step] of Object.entries(artifact.steps)) {
    if (!step) continue;
    for (const [key, value] of Object.entries(step.external)) {
      external[`${stepKey}.${key}`] = value;
    }
  }
  external["state.databaseRestored"] = artifact.stateRestore.dbRestored;
  external["state.settingsRestored"] = artifact.stateRestore.settingsRestored;
  artifact.external = external;

  // Step objects are registered as soon as a step starts so a BLOCKED run keeps
  // its partial detail, so "ran" has to mean "reached the end", not "exists".
  const requiredStepsRan = ["copyLast", "pasteLast", "openWindow"].every(
    (key) => artifact.steps[key]?.completed === true
  );
  const allExternalTrue =
    Object.keys(external).length > 0 && Object.values(external).every(Boolean);

  if (artifact.status === "BLOCKED") {
    artifact.pass = false;
  } else {
    artifact.pass = Boolean(requiredStepsRan && allExternalTrue && !artifact.error);
    artifact.status = artifact.pass ? "PASS" : "FAIL";
    if (!artifact.pass && !artifact.reason) {
      const failing = Object.entries(external)
        .filter(([, value]) => !value)
        .map(([key]) => key);
      artifact.reason = requiredStepsRan
        ? `External checks failed: ${failing.join(", ") || "none recorded"}`
        : "One or more steps did not run to completion.";
    }
  }

  await writeArtifact(artifact);
  process.exit(artifact.pass ? 0 : 1);
}

run().catch(async (error) => {
  // Same gate as the finally block above: this last-ditch path must not write
  // over a database this run never mutated.
  if (plainsongStateMutated) {
    restoreDbFiles();
    restoreSettings();
  } else {
    artifact.stateRestore.skipped = true;
    artifact.stateRestore.skippedReason =
      "This run exited before it launched the setup sidecar, so it never wrote settings.json or plainsong.db and nothing was restored.";
  }
  artifact.pass = false;
  artifact.status = artifact.status === "BLOCKED" ? "BLOCKED" : "FAIL";
  artifact.error = error instanceof Error ? error.message : String(error);
  await writeArtifact(artifact);
  process.exit(1);
});
