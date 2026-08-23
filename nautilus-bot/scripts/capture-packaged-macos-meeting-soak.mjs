#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { matchSpokenFixture } from "./lib/spoken-fixture-match.mjs";
import { createPackagedQaProfile } from "./lib/packaged-qa-profile.mjs";
import { sanitizeMeetingSoakReceipt } from "./lib/meeting-soak-receipt.mjs";
import { collectReleaseCandidateIdentity } from "./lib/release-candidate-identity.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const qaProfile = createPackagedQaProfile({
  args,
  prefix: "plainsong-meeting-soak-qa-",
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
const candidatePath = path.resolve(
  repoRoot,
  valueFor("--candidate", path.resolve(appPath, "../..")),
);
const candidateIdentity = collectReleaseCandidateIdentity({
  candidatePath,
  appPath,
});
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
const muteFixtureOutput = args.includes("--mute-fixture-output");
const speakFixtureText = valueFor(
  "--speak-fixture-text",
  "Plainsong packaged meeting soak fixture. The transcript should contain this repeated launch readiness sentence."
);
const speakFixtureIntervalMs = Number(valueFor("--speak-fixture-interval-ms", "15000"));
const virtualFixtureDeviceName = valueFor("--virtual-fixture-device");
const expectStartFailure = args.includes("--expect-start-failure");
const expectedStartError = valueFor(
  "--expected-start-error",
  "Timed out waiting for microphone stream preparation",
);
const maxStartFailureMs = Number(valueFor("--max-start-failure-ms", "5000"));
const includeSystemAudio = !args.includes("--mic-only");
const expectedCaptureMode = includeSystemAudio ? "me_and_them" : "mic_only";
const sidecarPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "plainsong-sidecar"
);
const configDir = qaProfile.configDir;
const settingsPath = path.join(configDir, "settings.json");
const dbPath = path.join(qaProfile.dataDir, "plainsong.db");
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
  fail(`Plainsong database not found at ${dbPath}`);
}
for (const [label, value] of [
  ["--record-ms", recordMs],
  ["--min-record-ms", minRecordMs],
  ["--transcript-timeout-ms", transcriptTimeoutMs],
  ["--poll-interval-ms", pollIntervalMs],
  ["--timeout-ms", timeoutMs],
  ["--speak-fixture-interval-ms", speakFixtureIntervalMs],
  ["--max-start-failure-ms", maxStartFailureMs],
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
if (muteFixtureOutput && !speakFixture) {
  fail("--mute-fixture-output requires --speak-fixture.");
}
if (muteFixtureOutput && virtualFixtureDeviceName) {
  fail("--mute-fixture-output cannot be combined with --virtual-fixture-device.");
}
if (virtualFixtureDeviceName && !speakFixture && !expectStartFailure) {
  fail(
    "--virtual-fixture-device requires --speak-fixture unless --expect-start-failure is enabled.",
  );
}
if (expectStartFailure && !virtualFixtureDeviceName) {
  fail("--expect-start-failure requires --virtual-fixture-device.");
}
if (expectStartFailure && includeSystemAudio) {
  fail("--expect-start-failure requires --mic-only.");
}
if (expectStartFailure && expectedStartError.trim().length === 0) {
  fail("--expected-start-error cannot be empty.");
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

function switchAudioSource(args) {
  const result = spawnSync("SwitchAudioSource", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`SwitchAudioSource failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `SwitchAudioSource ${args.join(" ")} failed: ${String(result.stderr).trim()}`,
    );
  }
  return String(result.stdout).trim();
}

function currentAudioSource(type) {
  return switchAudioSource(["-c", "-t", type]);
}

function selectAudioSource(deviceName, type) {
  switchAudioSource(["-s", deviceName, "-t", type]);
  return currentAudioSource(type);
}

function runAppleScript(script) {
  const result = spawnSync("/usr/bin/osascript", ["-e", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`osascript failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`osascript failed: ${String(result.stderr).trim()}`);
  }
  return String(result.stdout).trim();
}

function currentOutputMuted() {
  return runAppleScript("output muted of (get volume settings)") === "true";
}

function setOutputMuted(muted) {
  runAppleScript(`set volume output muted ${muted ? "true" : "false"}`);
  return currentOutputMuted();
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

function qaSettings(base, virtualFixtureDevice) {
  const next = JSON.parse(JSON.stringify(base));
  next.transcription = {
    ...next.transcription,
    useSharedAsrSelection: false,
    meetingProvider: "parakeet",
    meetingModelId: "parakeet-tdt-0.6b-v3",
    providerModelIds: {
      ...(next.transcription?.providerModelIds ?? {}),
      parakeet: "parakeet-tdt-0.6b-v3",
    },
    enableAutoAnalysis: false,
    meetingAudioStorageMode: "always",
    meetingRetentionPreset: "never",
    meetingRetentionDeleteMode: "audio_only",
  };
  next.audio = {
    ...next.audio,
    captureMicrophone: true,
    captureSystemAudio: includeSystemAudio,
    ...(virtualFixtureDevice
      ? {
          meetingInputOverrideEnabled: true,
          meetingInputDevice: {
            deviceId: virtualFixtureDevice.deviceId,
            deviceName: virtualFixtureDevice.deviceName,
            transportType: virtualFixtureDevice.transportType ?? null,
          },
        }
      : {}),
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
  if (Number.isFinite(transcript?.fullTextLength)) {
    return transcript.fullTextLength;
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
- Observed recording duration: ${artifact.recordingDurationMs ?? "not measured"} ms
- System audio requested: ${artifact.includeSystemAudio ? "yes" : "no"}
- Expected start failure: ${artifact.expectStartFailure ? "yes" : "no"}
- Start failure: ${artifact.startFailure?.message ?? "none"}
- Start failure duration: ${artifact.startFailure?.durationMs ?? "not measured"} ms
- Sidecar responsive after start failure: ${artifact.startFailureRecovery?.sidecarResponsive ?? "not tested"}
- Recording ID returned: ${artifact.recordingId ?? "none"}
- Recording status: ${artifact.recordingAfterTranscriptWait?.status ?? "unknown"}
- Transcript characters: ${transcriptChars}
- Spoken fixture captured: ${artifact.fixtureTranscriptMatch?.matched ?? "not requested"}
- Fixture output muted: ${artifact.muteFixtureOutput ? "yes" : "no"}
- Fixture output mute restored: ${artifact.fixtureOutputMuteRestored ?? "not requested"}
- Spoken fixture coverage: ${artifact.fixtureTranscriptMatch?.coverage ?? "not requested"}
- Spoken fixture ordered coverage: ${artifact.fixtureTranscriptMatch?.orderedCoverage ?? "not requested"}
- Spoken fixture omissions: ${artifact.fixtureTranscriptMatch?.omissions?.join(", ") || "none"}
- Spoken fixture order violations: ${artifact.fixtureTranscriptMatch?.orderViolations?.join(", ") || "none"}
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
  const safeArtifact = sanitizeMeetingSoakReceipt(artifact);
  const json = JSON.stringify(safeArtifact, null, 2);
  fs.writeFileSync(outPath, `${json}\n`, "utf8");
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, `${renderMarkdown(safeArtifact)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        generatedAt: artifact.generatedAt,
        pass: artifact.pass,
        recordingId: artifact.recordingId ?? null,
        recordMs: artifact.recordMs ?? null,
        expectStartFailure: artifact.expectStartFailure ?? false,
        startFailure: artifact.startFailure ?? null,
        startFailureRecovery: artifact.startFailureRecovery ?? null,
        transcriptChars: transcriptCharCount(artifact.transcript),
        fixtureTranscriptMatch: artifact.fixtureTranscriptMatch ?? null,
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
    candidatePath,
    candidateIdentity,
    sidecarPath,
    sidecarSha256: hashBytes(fs.readFileSync(sidecarPath)),
    dbPath,
    settingsPath,
    recordMs,
    minRecordMs,
    transcriptTimeoutMs,
    pollIntervalMs,
    includeSystemAudio,
    speakFixture,
    muteFixtureOutput,
    speakFixtureText: speakFixture ? speakFixtureText : null,
    speakFixtureIntervalMs,
    virtualFixtureDeviceName,
    expectStartFailure,
    expectedStartError: expectStartFailure ? expectedStartError : null,
    maxStartFailureMs: expectStartFailure ? maxStartFailureMs : null,
    virtualFixtureDevice: null,
    systemOutputBefore: null,
    systemOutputDuring: null,
    systemOutputAfter: null,
    systemOutputRestored: false,
    systemOutputRestoreError: null,
    systemOutputDeviceBefore: null,
    systemOutputDeviceDuring: null,
    systemOutputDeviceAfter: null,
    systemOutputDeviceRestored: false,
    systemOutputDeviceRestoreError: null,
    fixtureOutputMutedBefore: null,
    fixtureOutputMutedDuring: null,
    fixtureOutputMutedAfter: null,
    fixtureOutputMuteRestored: false,
    fixtureOutputMuteRestoreError: null,
    speechFixtureRuns: [],
    fixtureTranscriptMatch: null,
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
    recordingStartedAt: null,
    recordingStopRequestedAt: null,
    recordingStoppedAt: null,
    recordingDurationMs: null,
    startRecordingAttempted: false,
    startFailure: null,
    startFailureRecovery: {
      sidecarResponsive: false,
      healthMethod: "get_settings",
      healthError: null,
    },
    recordingAfterStop: null,
    recordingAfterTranscriptWait: null,
    systemAudioVerification: null,
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

  async function releaseFixtureEnvironment() {
    if (speechFixture) {
      const fixture = speechFixture;
      speechFixture = null;
      await fixture.stop();
      artifact.speechFixtureRuns = fixture.runs;
    }
    if (
      virtualFixtureDeviceName &&
      artifact.systemOutputBefore &&
      !artifact.systemOutputRestored
    ) {
      try {
        artifact.systemOutputAfter = selectAudioSource(
          artifact.systemOutputBefore,
          "output",
        );
        artifact.systemOutputRestored =
          artifact.systemOutputAfter === artifact.systemOutputBefore;
      } catch (error) {
        artifact.systemOutputRestoreError =
          error instanceof Error ? error.message : String(error);
      }
    }
    if (
      virtualFixtureDeviceName &&
      artifact.systemOutputDeviceBefore &&
      !artifact.systemOutputDeviceRestored
    ) {
      try {
        artifact.systemOutputDeviceAfter = selectAudioSource(
          artifact.systemOutputDeviceBefore,
          "system",
        );
        artifact.systemOutputDeviceRestored =
          artifact.systemOutputDeviceAfter === artifact.systemOutputDeviceBefore;
      } catch (error) {
        artifact.systemOutputDeviceRestoreError =
          error instanceof Error ? error.message : String(error);
      }
    }
    if (
      muteFixtureOutput &&
      artifact.fixtureOutputMutedBefore !== null &&
      !artifact.fixtureOutputMuteRestored
    ) {
      try {
        artifact.fixtureOutputMutedAfter = setOutputMuted(
          artifact.fixtureOutputMutedBefore,
        );
        artifact.fixtureOutputMuteRestored =
          artifact.fixtureOutputMutedAfter === artifact.fixtureOutputMutedBefore;
      } catch (error) {
        artifact.fixtureOutputMuteRestoreError =
          error instanceof Error ? error.message : String(error);
      }
    }
  }

  try {
    const originalSettings = await sidecar.sendCommand("get_settings", {});
    if (virtualFixtureDeviceName) {
      const inventory = await sidecar.sendCommand("list_audio_input_devices", {});
      artifact.virtualFixtureDevice = inventory?.devices?.find(
        (device) =>
          device?.deviceName === virtualFixtureDeviceName &&
          device?.isAvailable === true,
      );
      if (!artifact.virtualFixtureDevice) {
        throw new Error(
          `Virtual fixture input is unavailable: ${virtualFixtureDeviceName}`,
        );
      }
      artifact.systemOutputBefore = currentAudioSource("output");
      artifact.systemOutputDeviceBefore = currentAudioSource("system");
      artifact.systemOutputDuring = selectAudioSource(
        virtualFixtureDeviceName,
        "output",
      );
      artifact.systemOutputDeviceDuring = selectAudioSource(virtualFixtureDeviceName, "system");
      if (artifact.systemOutputDuring !== virtualFixtureDeviceName) {
        throw new Error(
          `System output did not switch to ${virtualFixtureDeviceName}.`,
        );
      }
      if (artifact.systemOutputDeviceDuring !== virtualFixtureDeviceName) {
        throw new Error(
          `System sound-effects output did not switch to ${virtualFixtureDeviceName}.`,
        );
      }
    }
    await sidecar.sendCommand("save_settings", {
      settings: qaSettings(originalSettings, artifact.virtualFixtureDevice),
    });

    if (muteFixtureOutput) {
      artifact.fixtureOutputMutedBefore = currentOutputMuted();
      artifact.fixtureOutputMutedDuring = setOutputMuted(true);
      if (artifact.fixtureOutputMutedDuring !== true) {
        throw new Error("The spoken-fixture output could not be muted.");
      }
    }

    // A virtual loopback route cannot inject the verifier's internal tone by
    // design. Start the external spoken fixture before the route preflight so
    // the verifier can prove that the selected cable is carrying real output.
    if (speakFixture && virtualFixtureDeviceName) {
      speechFixture = startSpeechFixture();
    }

    if (includeSystemAudio) {
      artifact.systemAudioVerification = await sidecar.sendCommand(
        "test_system_audio_capture",
        {},
      );
      const expectedVerificationMethod = virtualFixtureDeviceName
        ? "external_audio"
        : "known_tone";
      const verificationSignalPassed = virtualFixtureDeviceName
        ? Number(artifact.systemAudioVerification?.nonSilentFrames) > 0
        : Number(artifact.systemAudioVerification?.detectedToneAmplitude) >= 0.005;
      if (
        artifact.systemAudioVerification?.capability?.ready !== true ||
        Number(artifact.systemAudioVerification?.callbacks) <= 0 ||
        Number(artifact.systemAudioVerification?.nonSilentFrames) <= 0 ||
        !verificationSignalPassed ||
        artifact.systemAudioVerification?.verificationMethod !==
          expectedVerificationMethod
      ) {
        throw new Error(
          `Packaged system-audio verification did not capture the expected ${expectedVerificationMethod} signal in this sidecar session.`,
        );
      }
    }

    const setup = await sidecar.sendCommand("verify_meeting_setup", {});
    artifact.meetingSetup = setup;
    if (!setup?.ok) {
      throw new Error(`Meeting setup is not ready: ${setup?.summary ?? "unknown"}`);
    }

    artifact.startRecordingAttempted = true;
    const startAttemptedAt = Date.now();
    let started = null;
    try {
      started = await sidecar.sendCommand("start_recording", {
        options: {
          mic: true,
          systemAudio: includeSystemAudio,
          projectId: "inbox",
          template: "meeting",
          meetingNotes: "Packaged QA long meeting soak.",
          consentPromptShown: true,
          admissionNonce: crypto.randomUUID(),
          meetingCaptureMode: expectedCaptureMode,
        },
      });
    } catch (error) {
      artifact.startFailure = {
        message: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startAttemptedAt,
      };
      if (!expectStartFailure) {
        throw error;
      }
      try {
        await sidecar.sendCommand("get_settings", {});
        artifact.startFailureRecovery.sidecarResponsive = true;
      } catch (healthError) {
        artifact.startFailureRecovery.healthError =
          healthError instanceof Error ? healthError.message : String(healthError);
      }
    }

    if (!artifact.startFailure) {
      artifact.recordingId = started?.recordingId;
      if (!artifact.recordingId) {
        throw new Error("start_recording did not return a recordingId.");
      }
      const recordingStartedAtMs = Date.now();
      artifact.recordingStartedAt = new Date(recordingStartedAtMs).toISOString();

      if (speakFixture && !speechFixture) {
        speechFixture = startSpeechFixture();
      }

      await sleep(recordMs);
      artifact.overlayWhileRecording = await sidecar.sendCommand(
        "get_recording_overlay_state",
        {},
      );

      const recordingStopRequestedAtMs = Date.now();
      artifact.recordingStopRequestedAt = new Date(
        recordingStopRequestedAtMs,
      ).toISOString();
      artifact.recordingDurationMs =
        recordingStopRequestedAtMs - recordingStartedAtMs;
      await sidecar.sendCommand("stop_recording", {
        recordingId: artifact.recordingId,
      });
      artifact.recordingStoppedAt = new Date().toISOString();
      artifact.overlayAfterStop = await sidecar.sendCommand(
        "get_recording_overlay_state",
        {},
      );
      artifact.recordingAfterStop = await sidecar.sendCommand("get_recording", {
        recordingId: artifact.recordingId,
      });

      await releaseFixtureEnvironment();

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
    } else {
      artifact.events = sidecar.events.slice(-20);
    }
  } catch (error) {
    artifact.error = error instanceof Error ? error.message : String(error);
    artifact.events = artifact.recordingId
      ? relevantEvents(sidecar.events, artifact.recordingId)
      : sidecar.events.slice(-20);
  } finally {
    await releaseFixtureEnvironment();
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
  artifact.fixtureTranscriptMatch = speakFixture
    ? matchSpokenFixture(
        artifact.transcript?.fullText ?? artifact.transcript?.full_text ?? "",
        speakFixtureText,
      )
    : null;

  if (expectStartFailure) {
    artifact.checks = {
      meetingSetupReady: Boolean(artifact.meetingSetup?.ok),
      startRecordingAttempted: artifact.startRecordingAttempted,
      expectedStartFailureObserved:
        typeof artifact.startFailure?.message === "string" &&
        artifact.startFailure.message.includes(expectedStartError),
      startFailureWithinLimit:
        Number.isFinite(artifact.startFailure?.durationMs) &&
        artifact.startFailure.durationMs <= maxStartFailureMs,
      noRecordingPublished: artifact.recordingId === null,
      sidecarResponsiveAfterStartFailure:
        artifact.startFailureRecovery.sidecarResponsive === true,
      virtualFixtureInputReady:
        artifact.virtualFixtureDevice?.deviceName === virtualFixtureDeviceName,
      virtualFixtureOutputSelected:
        artifact.systemOutputDuring === virtualFixtureDeviceName,
      virtualFixtureSystemOutputSelected:
        artifact.systemOutputDeviceDuring === virtualFixtureDeviceName,
      virtualFixtureOutputRestored: artifact.systemOutputRestored === true,
      virtualFixtureSystemOutputRestored:
        artifact.systemOutputDeviceRestored === true,
      systemOutputRestoreErrorAbsent: artifact.systemOutputRestoreError === null,
      systemOutputDeviceRestoreErrorAbsent:
        artifact.systemOutputDeviceRestoreError === null,
      fixtureOutputMutedDuring:
        !muteFixtureOutput || artifact.fixtureOutputMutedDuring === true,
      fixtureOutputMuteRestored:
        !muteFixtureOutput || artifact.fixtureOutputMuteRestored === true,
      fixtureOutputMuteRestoreErrorAbsent:
        artifact.fixtureOutputMuteRestoreError === null,
      sidecarExitedCleanly:
        artifact.sidecarExit?.code === 0 && artifact.sidecarExit?.signal === null,
      audioFilesCleaned: artifact.audioFilesCleaned,
      dbRestored: artifact.dbRestored,
      settingsRestored: artifact.settingsRestored,
    };
  } else {
    artifact.checks = {
      meetingSetupReady: Boolean(artifact.meetingSetup?.ok),
      systemAudioVerifiedForCombinedCapture:
        !includeSystemAudio ||
        (artifact.systemAudioVerification?.capability?.ready === true &&
          Number(artifact.systemAudioVerification?.callbacks) > 0 &&
          Number(artifact.systemAudioVerification?.nonSilentFrames) > 0 &&
          (virtualFixtureDeviceName
            ? artifact.systemAudioVerification?.verificationMethod ===
              "external_audio"
            : Number(artifact.systemAudioVerification?.detectedToneAmplitude) >=
                0.005 &&
              artifact.systemAudioVerification?.verificationMethod === "known_tone")),
      minimumDurationRequested: artifact.recordMs >= artifact.minRecordMs,
      minimumDurationObserved:
        Number.isFinite(artifact.recordingDurationMs) &&
        artifact.recordingDurationMs >= artifact.minRecordMs,
      recordingIdReturned: Boolean(artifact.recordingId),
      overlayEnteredRecording: artifact.overlayWhileRecording?.phase === "recording",
      overlayEnteredProcessing: artifact.overlayAfterStop?.phase === "processing",
      recordingRowPreserved:
        artifact.recordingAfterTranscriptWait?.id === artifact.recordingId,
      recordingSourceMeeting:
        artifact.recordingAfterTranscriptWait?.sourceType === "meeting",
      captureModeMatches:
        artifact.recordingAfterTranscriptWait?.meetingCaptureMode ===
        expectedCaptureMode,
      systemAudioFlagMatches:
        artifact.overlayWhileRecording?.systemAudioActive === includeSystemAudio,
      speechFixtureRan: !speakFixture || artifact.speechFixtureRuns.length > 0,
      speechFixtureCaptured:
        !speakFixture || artifact.fixtureTranscriptMatch?.matched === true,
      virtualFixtureInputReady:
        !virtualFixtureDeviceName ||
        artifact.virtualFixtureDevice?.deviceName === virtualFixtureDeviceName,
      virtualFixtureOutputSelected:
        !virtualFixtureDeviceName ||
        artifact.systemOutputDuring === virtualFixtureDeviceName,
      virtualFixtureSystemOutputSelected:
        !virtualFixtureDeviceName ||
        artifact.systemOutputDeviceDuring === virtualFixtureDeviceName,
      virtualFixtureOutputRestored:
        !virtualFixtureDeviceName || artifact.systemOutputRestored === true,
      virtualFixtureSystemOutputRestored:
        !virtualFixtureDeviceName ||
        artifact.systemOutputDeviceRestored === true,
      systemOutputRestoreErrorAbsent:
        artifact.systemOutputRestoreError === null,
      systemOutputDeviceRestoreErrorAbsent:
        artifact.systemOutputDeviceRestoreError === null,
      fixtureOutputMutedDuring:
        !muteFixtureOutput || artifact.fixtureOutputMutedDuring === true,
      fixtureOutputMuteRestored:
        !muteFixtureOutput || artifact.fixtureOutputMuteRestored === true,
      fixtureOutputMuteRestoreErrorAbsent:
        artifact.fixtureOutputMuteRestoreError === null,
      recordingCompleted:
        artifact.recordingAfterTranscriptWait?.status === "completed",
      transcriptWaitCompleted: artifact.transcriptWait?.timedOut === false,
      transcriptNotTerminalEmpty:
        artifact.transcriptWait?.terminalEmptyTranscript === false,
      transcriptCreated: Boolean(artifact.transcript),
      transcriptHasText: transcriptTextLength > 0,
      audioPathPersisted: Boolean(
        artifact.recordingAfterTranscriptWait?.audioPath,
      ),
      audioFileExists: Boolean(artifact.audioFile?.exists),
      audioFileHasData: Number(artifact.audioFile?.sizeBytes ?? 0) > 44,
      sidecarAudioFilesMatchMode: includeSystemAudio
        ? artifact.sidecarAudioFiles.length === 2 &&
          artifact.sidecarAudioFiles.every(
            (file) => file.exists && file.sizeBytes > 44,
          )
        : artifact.sidecarAudioFiles.every((file) => !file.exists),
      startEventEmitted: eventSeen(
        artifact.events,
        "recording-status-changed",
        (payload) =>
          payload.recordingId === artifact.recordingId &&
          payload.status === "recording",
      ),
      processingEventEmitted: eventSeen(
        artifact.events,
        "recording-status-changed",
        (payload) =>
          payload.recordingId === artifact.recordingId &&
          payload.status === "processing",
      ),
      completedEventEmitted: eventSeen(
        artifact.events,
        "recording-status-changed",
        (payload) =>
          payload.recordingId === artifact.recordingId &&
          payload.status === "completed",
      ),
      staleMeetingRouteErrorsAbsent:
        !/Distil-Whisper model not downloaded|Failed to transcribe .*Distil Whisper/i.test(
          artifact.stderr.tail,
        ),
      audioFilesCleaned: artifact.audioFilesCleaned,
      dbRestored: artifact.dbRestored,
      settingsRestored: artifact.settingsRestored,
    };
  }

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
    candidatePath,
    candidateIdentity,
    sidecarPath,
    sidecarSha256: fs.existsSync(sidecarPath)
      ? hashBytes(fs.readFileSync(sidecarPath))
      : null,
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
