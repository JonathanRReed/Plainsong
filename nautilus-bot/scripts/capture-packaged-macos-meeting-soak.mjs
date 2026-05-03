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
  valueFor("--app", "release/mac-arm64/Nautilus.app")
);
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/qa/macos/capture-soak-3h.json")
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "artifacts/qa/macos/capture-soak-3h.md")
);
const recordMs = Number(valueFor("--record-ms", String(3 * 60 * 60 * 1000)));
const minRecordMs = Number(valueFor("--min-record-ms", String(3 * 60 * 60 * 1000)));
const transcriptTimeoutMs = Number(valueFor("--transcript-timeout-ms", "1800000"));
const pollIntervalMs = Number(valueFor("--poll-interval-ms", "10000"));
const timeoutMs = Number(
  valueFor("--timeout-ms", String(recordMs + transcriptTimeoutMs + 120000))
);
const speakFixture = args.includes("--speak-fixture");
const speakFixtureText = valueFor(
  "--speak-fixture-text",
  "Nautilus packaged meeting soak fixture. The transcript should contain this repeated launch readiness sentence."
);
const speakFixtureIntervalMs = Number(valueFor("--speak-fixture-interval-ms", "15000"));
const includeSystemAudio = !args.includes("--mic-only");
const expectedCaptureMode = includeSystemAudio ? "me_and_them" : "mic_only";
const sidecarPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "nautilus-sidecar"
);
const configDir = path.join(os.homedir(), "Library", "Application Support", "Nautilus");
const settingsPath = path.join(configDir, "settings.json");
const dbPath = path.join(configDir, "nautilus.db");
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
  fail("capture-packaged-macos-meeting-soak can only run on macOS.");
}
if (!fs.existsSync(sidecarPath)) {
  fail(`Packaged sidecar not found at ${sidecarPath}`);
}
if (!fs.existsSync(dbPath)) {
  fail(`Nautilus database not found at ${dbPath}`);
}
for (const [label, value] of [
  ["--record-ms", recordMs],
  ["--min-record-ms", minRecordMs],
  ["--transcript-timeout-ms", transcriptTimeoutMs],
  ["--poll-interval-ms", pollIntervalMs],
  ["--timeout-ms", timeoutMs],
  ["--speak-fixture-interval-ms", speakFixtureIntervalMs],
]) {
  if (!Number.isFinite(value) || value < 0) {
    fail(`Invalid ${label} value.`);
  }
}
if (pollIntervalMs < 1000) {
  fail("--poll-interval-ms must be at least 1000.");
}
if (recordMs < minRecordMs) {
  fail("--record-ms must be greater than or equal to --min-record-ms.");
}
if (speakFixture && speakFixtureText.trim().length === 0) {
  fail("--speak-fixture-text cannot be empty when --speak-fixture is enabled.");
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

function childExitPromise(child) {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (error) =>
      resolve({ code: null, signal: null, error: error.message })
    );
  });
}

function startSpeechFixture() {
  const runs = [];
  let stopped = false;
  let activeChild = null;

  const loop = (async () => {
    while (!stopped) {
      const startedAt = new Date().toISOString();
      activeChild = spawn("say", [speakFixtureText], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      const result = await childExitPromise(activeChild);
      runs.push({
        startedAt,
        finishedAt: new Date().toISOString(),
        ...result,
      });
      activeChild = null;
      if (!stopped) {
        await sleep(speakFixtureIntervalMs);
      }
    }
  })();

  return {
    runs,
    async stop() {
      stopped = true;
      if (activeChild && !activeChild.killed) {
        activeChild.kill("SIGTERM");
      }
      await Promise.race([loop, sleep(5000)]);
    },
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

function eventSeen(events, eventName, predicate) {
  return events.some((entry) => {
    if (entry.event !== eventName) return false;
    return predicate(entry.payload ?? {});
  });
}

function truncateText(value, maxChars = 500) {
  if (typeof value !== "string" || value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`;
}

function boundedPayload(eventName, payload) {
  if (!payload || typeof payload !== "object") {
    return payload ?? null;
  }

  const next = { ...payload };
  if (typeof next.text === "string") {
    const textMax = eventName === "recording-transcription-stream" ? 320 : 500;
    next.text = truncateText(next.text, textMax);
  }
  if (typeof next.fullText === "string") {
    next.fullText = truncateText(next.fullText, 1000);
  }
  if (typeof next.full_text === "string") {
    next.full_text = truncateText(next.full_text, 1000);
  }
  return next;
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
      payload: boundedPayload(entry.event, entry.payload),
    }));
}

function transcriptCharCount(transcript) {
  if (typeof transcript?.fullText === "string") {
    return transcript.fullText.trim().length;
  }
  if (typeof transcript?.full_text === "string") {
    return transcript.full_text.trim().length;
  }
  return 0;
}

async function waitForTranscript(sidecar, recordingId) {
  const deadline = Date.now() + transcriptTimeoutMs;
  const polls = [];

  while (Date.now() <= deadline) {
    const recording = await sidecar.sendCommand("get_recording", { recordingId });
    const transcript = await sidecar.sendCommand("get_transcript", { recordingId });
    const transcriptDetails = await sidecar.sendCommand("get_meeting_transcript_details", {
      recordingId,
    });

    const transcriptChars = transcriptCharCount(transcript);
    polls.push({
      polledAt: new Date().toISOString(),
      status: recording?.status ?? null,
      transcriptChars,
      segmentCount: Array.isArray(transcript?.segments) ? transcript.segments.length : 0,
      qualityScore: transcriptDetails?.qualityScore ?? transcriptDetails?.quality_score ?? null,
    });

    if (
      recording?.status === "completed" &&
      transcript &&
      transcriptChars > 0
    ) {
      return {
        recording,
        transcript,
        transcriptDetails,
        polls,
        timedOut: false,
        terminalEmptyTranscript: false,
      };
    }

    if (recording?.status === "completed" && transcript) {
      return {
        recording,
        transcript,
        transcriptDetails,
        polls,
        timedOut: false,
        terminalEmptyTranscript: transcriptChars === 0,
      };
    }

    await sleep(pollIntervalMs);
  }

  const recording = await sidecar.sendCommand("get_recording", { recordingId });
  const transcript = await sidecar.sendCommand("get_transcript", { recordingId });
  const transcriptDetails = await sidecar.sendCommand("get_meeting_transcript_details", {
    recordingId,
  });
  return {
    recording,
    transcript,
    transcriptDetails,
    polls,
    timedOut: true,
    terminalEmptyTranscript: false,
  };
}

function renderMarkdown(artifact) {
  const transcriptChars = transcriptCharCount(artifact.transcript);
  const strictLongSoakMs = 3 * 60 * 60 * 1000;
  const isStrictLongSoak = artifact.minRecordMs >= strictLongSoakMs;
  const title = isStrictLongSoak
    ? "3h+ Meeting Soak"
    : "Meeting Soak Preflight";
  const command = isStrictLongSoak
    ? "bun run qa:packaged:macos:meeting:soak"
    : `node scripts/capture-packaged-macos-meeting-soak.mjs --record-ms ${artifact.recordMs} --min-record-ms ${artifact.minRecordMs}`;

  return `# Capture: ${title}

Status: ${artifact.pass ? "PASS" : "FAIL"}
Owner: qa-macos
Generated: ${artifact.generatedAt}

## Command

\`${command}\`

## Result

- Record duration requested: ${artifact.recordMs} ms
- Minimum required duration: ${artifact.minRecordMs} ms
- System audio requested: ${artifact.includeSystemAudio ? "yes" : "no"}
- Recording ID returned: ${artifact.recordingId ?? "none"}
- Recording status: ${artifact.recordingAfterTranscriptWait?.status ?? "unknown"}
- Transcript characters: ${transcriptChars}
- Transcript wait timed out: ${artifact.transcriptWait?.timedOut ? "yes" : "no"}
- Terminal empty transcript: ${artifact.transcriptWait?.terminalEmptyTranscript ? "yes" : "no"}
- Audio file bytes: ${artifact.audioFile?.sizeBytes ?? 0}

## Checks

${Object.entries(artifact.checks ?? {})
  .map(([key, value]) => `- ${key}: ${value ? "PASS" : "FAIL"}`)
  .join("\n") || "- checksAvailable: FAIL"}
`;
}

async function writeArtifact(artifact) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const json = JSON.stringify(artifact, null, 2);
  fs.writeFileSync(outPath, `${json}\n`, "utf8");
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, `${renderMarkdown(artifact)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        generatedAt: artifact.generatedAt,
        pass: artifact.pass,
        recordingId: artifact.recordingId ?? null,
        recordMs: artifact.recordMs ?? null,
        transcriptChars: transcriptCharCount(artifact.transcript),
        checks: artifact.checks ?? null,
        error: artifact.error ?? null,
      },
      null,
      2
    )
  );
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
    minRecordMs,
    transcriptTimeoutMs,
    pollIntervalMs,
    includeSystemAudio,
    speakFixture,
    speakFixtureText: speakFixture ? speakFixtureText : null,
    speakFixtureIntervalMs,
    speechFixtureRuns: [],
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
    recordingAfterTranscriptWait: null,
    transcript: null,
    transcriptDetails: null,
    transcriptWait: null,
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
  let speechFixture = null;

  try {
    const originalSettings = await sidecar.sendCommand("get_settings", {});
    await sidecar.sendCommand("save_settings", { settings: qaSettings(originalSettings) });

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
        meetingNotes: "Packaged QA long meeting soak.",
        consentPromptShown: true,
        meetingCaptureMode: expectedCaptureMode,
      },
    });

    artifact.recordingId = started?.recordingId;
    if (!artifact.recordingId) {
      throw new Error("start_recording did not return a recordingId.");
    }

    if (speakFixture) {
      speechFixture = startSpeechFixture();
    }

    await sleep(recordMs);
    artifact.overlayWhileRecording = await sidecar.sendCommand("get_recording_overlay_state", {});

    await sidecar.sendCommand("stop_recording", { recordingId: artifact.recordingId });
    artifact.overlayAfterStop = await sidecar.sendCommand("get_recording_overlay_state", {});
    artifact.recordingAfterStop = await sidecar.sendCommand("get_recording", {
      recordingId: artifact.recordingId,
    });

    const transcriptWait = await waitForTranscript(sidecar, artifact.recordingId);
    artifact.recordingAfterTranscriptWait = transcriptWait.recording;
    artifact.transcript = transcriptWait.transcript;
    artifact.transcriptDetails = transcriptWait.transcriptDetails;
    artifact.transcriptWait = {
      timedOut: transcriptWait.timedOut,
      terminalEmptyTranscript: transcriptWait.terminalEmptyTranscript,
      polls: transcriptWait.polls,
    };

    const audioPath = artifact.recordingAfterTranscriptWait?.audioPath;
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
    if (speechFixture) {
      await speechFixture.stop();
      artifact.speechFixtureRuns = speechFixture.runs;
    }
    artifact.timedOut = sidecar.didTimeOut();
    artifact.stderr = stderrEvidence(sidecar.stderr);
    artifact.sidecarExit = await sidecar.shutdown();
    removeFileIfPresent(artifact.recordingAfterTranscriptWait?.audioPath);
    for (const file of artifact.sidecarAudioFiles) {
      removeFileIfPresent(file.path);
    }
    restoreDbFiles();
    restoreSettings();
    artifact.audioFilesCleaned = [
      artifact.recordingAfterTranscriptWait?.audioPath,
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

  const transcriptTextLength = transcriptCharCount(artifact.transcript);

  artifact.checks = {
    meetingSetupReady: Boolean(artifact.meetingSetup?.ok),
    minimumDurationRequested: artifact.recordMs >= artifact.minRecordMs,
    recordingIdReturned: Boolean(artifact.recordingId),
    overlayEnteredRecording: artifact.overlayWhileRecording?.phase === "recording",
    overlayEnteredTranscribing: artifact.overlayAfterStop?.phase === "transcribing",
    recordingRowPreserved:
      artifact.recordingAfterTranscriptWait?.id === artifact.recordingId,
    recordingSourceMeeting:
      artifact.recordingAfterTranscriptWait?.sourceType === "meeting",
    captureModeMatches:
      artifact.recordingAfterTranscriptWait?.meetingCaptureMode === expectedCaptureMode,
    systemAudioFlagMatches:
      artifact.overlayWhileRecording?.systemAudioActive === includeSystemAudio,
    speechFixtureRan: !speakFixture || artifact.speechFixtureRuns.length > 0,
    recordingCompleted: artifact.recordingAfterTranscriptWait?.status === "completed",
    transcriptWaitCompleted: artifact.transcriptWait?.timedOut === false,
    transcriptNotTerminalEmpty: artifact.transcriptWait?.terminalEmptyTranscript === false,
    transcriptCreated: Boolean(artifact.transcript),
    transcriptHasText: transcriptTextLength > 0,
    audioPathPersisted: Boolean(artifact.recordingAfterTranscriptWait?.audioPath),
    audioFileExists: Boolean(artifact.audioFile?.exists),
    audioFileHasData: Number(artifact.audioFile?.sizeBytes ?? 0) > 44,
    sidecarAudioFilesMatchMode: includeSystemAudio
      ? artifact.sidecarAudioFiles.length === 2 &&
        artifact.sidecarAudioFiles.every((file) => file.exists && file.sizeBytes > 44)
      : artifact.sidecarAudioFiles.every((file) => !file.exists),
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
    completedEventEmitted: eventSeen(
      artifact.events,
      "recording-status-changed",
      (payload) => payload.recordingId === artifact.recordingId && payload.status === "completed"
    ),
    staleMeetingRouteErrorsAbsent:
      !/Distil-Whisper model not downloaded|Failed to transcribe .*Distil Whisper/i.test(
        artifact.stderr.tail
      ),
    audioFilesCleaned: artifact.audioFilesCleaned,
    dbRestored: artifact.dbRestored,
    settingsRestored: artifact.settingsRestored,
  };

  artifact.pass = Boolean(
    !artifact.timedOut && Object.values(artifact.checks).every(Boolean)
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
    recordMs,
    minRecordMs,
    transcriptTimeoutMs,
    pollIntervalMs,
    includeSystemAudio,
    pass: false,
    checks: {},
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
