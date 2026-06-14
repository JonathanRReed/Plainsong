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
  valueFor("--out", "artifacts/qa/macos/retention-policies.json")
);
const workDir = path.resolve(
  repoRoot,
  valueFor("--work-dir", "artifacts/qa/macos/retention-workdir")
);
const timeoutMs = Number(valueFor("--timeout-ms", "90000"));
const sidecarPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "plainsong-sidecar"
);
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
  fail("capture-packaged-macos-retention can only run on macOS.");
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

function dbHashes() {
  return Object.fromEntries(
    dbSidecarPaths.map((filePath) => [
      filePath,
      fs.existsSync(filePath) ? hashBytes(fs.readFileSync(filePath)) : null,
    ])
  );
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runSql(sql) {
  const result = spawnSync("sqlite3", [dbPath], {
    input: sql,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `sqlite3 exited ${result.status}`);
  }
}

function scenarioSettings(base, scenario) {
  const next = JSON.parse(JSON.stringify(base));
  next.transcription = {
    ...next.transcription,
    meetingAudioStorageMode:
      scenario.kind === "transcript-only" ? "transcript_only" : "always",
    meetingRetentionPreset: scenario.kind === "transcript-only" ? "never" : "custom",
    meetingRetentionCustomMonths: 1,
    meetingRetentionDeleteMode:
      scenario.kind === "audio-and-transcript" ? "audio_and_transcript" : "audio_only",
  };
  return next;
}

function writeAudioFixture(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from("Plainsong retention QA audio fixture\n", "utf8"));
}

function seedScenario(scenario) {
  const recordingId = scenario.recordingId;
  const transcriptId = `${recordingId}-transcript`;
  const createdAt =
    scenario.kind === "transcript-only"
      ? new Date().toISOString()
      : new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
  const audioPath = path.join(workDir, `${recordingId}.wav`);
  writeAudioFixture(audioPath);

  runSql(`
BEGIN IMMEDIATE;
DELETE FROM transcripts WHERE recording_id = ${sqlString(recordingId)};
DELETE FROM recordings WHERE id = ${sqlString(recordingId)};
INSERT INTO recordings (
  id, title, project_id, duration, created_at, updated_at, source_type, audio_path, status,
  meeting_notes, meeting_template_id, meeting_capture_mode, notes_updated_at,
  consent_prompt_shown, consent_notice_mode, consent_notice_surface,
  consent_notice_message, consent_notice_updated_at
) VALUES (
  ${sqlString(recordingId)},
  ${sqlString(scenario.title)},
  'inbox',
  18,
  ${sqlString(createdAt)},
  ${sqlString(createdAt)},
  'meeting',
  ${sqlString(audioPath)},
  'completed',
  'QA fixture for packaged retention validation.',
  'standup',
  'mic',
  ${sqlString(createdAt)},
  1,
  'manual',
  'qa',
  'QA fixture consent notice',
  ${sqlString(createdAt)}
);
INSERT INTO transcripts (
  id, recording_id, segments, full_text, language, confidence, model,
  model_id, requested_provider, actual_provider, created_at
) VALUES (
  ${sqlString(transcriptId)},
  ${sqlString(recordingId)},
  ${sqlString(JSON.stringify([
    {
      id: `${recordingId}-seg-1`,
      startTime: 0,
      endTime: 18,
      text: scenario.transcript,
      speakerId: "speaker-1",
      confidence: 0.98,
    },
  ]))},
  ${sqlString(scenario.transcript)},
  'en',
  0.98,
  'qa-fixture',
  'qa-fixture',
  'qa-fixture',
  'qa-fixture',
  ${sqlString(createdAt)}
);
COMMIT;
`);

  return { recordingId, audioPath, createdAt };
}

function stderrEvidence(chunks) {
  const value = chunks.join("").trim();
  return {
    length: value.length,
    tail: value.slice(-12000),
  };
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

async function writeArtifact(artifact) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(artifact, null, 2));
}

const scenarios = [
  {
    key: "transcriptOnly",
    kind: "transcript-only",
    recordingId: `qa-retention-transcript-only-${Date.now()}`,
    title: "QA Transcript Only Storage Fixture",
    transcript: "The transcript-only fixture must remove audio and preserve transcript text.",
  },
  {
    key: "audioOnly",
    kind: "audio-only",
    recordingId: `qa-retention-audio-only-${Date.now()}`,
    title: "QA Audio Only Retention Fixture",
    transcript: "The audio-only retention fixture must keep transcript text and clear audio.",
  },
  {
    key: "audioAndTranscript",
    kind: "audio-and-transcript",
    recordingId: `qa-retention-audio-and-transcript-${Date.now()}`,
    title: "QA Audio And Transcript Retention Fixture",
    transcript: "The full retention fixture must remove recording and transcript.",
  },
];

snapshotDbFiles();

async function runScenario(scenario) {
  restoreDbFiles();
  restoreSettings();
  const seeded = seedScenario(scenario);
  const sidecar = launchSidecar();
  const result = {
    ...seeded,
    pass: false,
    checks: {},
    maintenance: null,
    stderr: { length: 0, tail: "" },
    sidecarExit: null,
  };

  try {
    const originalSettings = await sidecar.sendCommand("get_settings", {});
    await sidecar.sendCommand("save_settings", {
      settings: scenarioSettings(originalSettings, scenario),
    });
    result.maintenance = await sidecar.sendCommand("run_storage_retention_maintenance", {
      recordingId: seeded.recordingId,
    });
    result.recordingAfter = await sidecar.sendCommand("get_recording", {
      recordingId: seeded.recordingId,
    });
    result.transcriptAfter = await sidecar.sendCommand("get_transcript", {
      recordingId: seeded.recordingId,
    });

    result.checks.audioFileRemoved = !fs.existsSync(seeded.audioPath);
    if (scenario.kind === "audio-and-transcript") {
      result.checks.recordingRemoved = result.recordingAfter === null;
      result.checks.transcriptRemoved = result.transcriptAfter === null;
      result.checks.maintenanceCountedDeletion =
        result.maintenance?.meetingRetention?.deletedRecordings === 1;
    } else {
      result.checks.recordingPreserved = result.recordingAfter?.id === seeded.recordingId;
      result.checks.transcriptPreserved =
        result.transcriptAfter?.fullText === scenario.transcript;
      result.checks.audioPathCleared = result.recordingAfter?.audioPath === "";
      const bucket =
        scenario.kind === "transcript-only"
          ? result.maintenance?.transcriptOnly
          : result.maintenance?.meetingRetention;
      result.checks.maintenanceCountedClear = bucket?.audioPathsCleared === 1;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    result.timedOut = sidecar.didTimeOut();
    result.stderr = stderrEvidence(sidecar.stderr);
    result.sidecarExit = await sidecar.shutdown();
  }

  result.pass = Boolean(
    !result.timedOut &&
      result.checks.audioFileRemoved &&
      (scenario.kind === "audio-and-transcript"
        ? result.checks.recordingRemoved &&
          result.checks.transcriptRemoved &&
          result.checks.maintenanceCountedDeletion
        : result.checks.recordingPreserved &&
          result.checks.transcriptPreserved &&
          result.checks.audioPathCleared &&
          result.checks.maintenanceCountedClear)
  );

  return result;
}

async function run() {
  if (fs.existsSync(workDir)) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  fs.mkdirSync(workDir, { recursive: true });
  const artifact = {
    generatedAt: new Date().toISOString(),
    appPath,
    sidecarPath,
    dbPath,
    settingsPath,
    workDir,
    pass: false,
    originalDbHashes: Object.fromEntries(
      [...dbBackups.entries()].map(([filePath, bytes]) => [filePath, hashBytes(bytes)])
    ),
    restoredDbHashes: null,
    originalSettingsHash: hashBytes(originalSettingsBytes),
    restoredSettingsHash: null,
    dbRestored: false,
    settingsRestored: false,
    workDirCleaned: false,
    scenarios: {},
  };

  try {
    for (const scenario of scenarios) {
      artifact.scenarios[scenario.key] = await runScenario(scenario);
    }
  } catch (error) {
    artifact.error = error instanceof Error ? error.message : String(error);
  } finally {
    restoreDbFiles();
    restoreSettings();
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    artifact.restoredDbHashes = dbHashes();
    artifact.restoredSettingsHash = fs.existsSync(settingsPath)
      ? hashBytes(fs.readFileSync(settingsPath))
      : null;
    artifact.dbRestored =
      JSON.stringify(artifact.restoredDbHashes) === JSON.stringify(artifact.originalDbHashes);
    artifact.settingsRestored = artifact.restoredSettingsHash === artifact.originalSettingsHash;
    artifact.workDirCleaned = !fs.existsSync(workDir);
    artifact.pass = Boolean(
      artifact.dbRestored &&
        artifact.settingsRestored &&
        artifact.workDirCleaned &&
        Object.values(artifact.scenarios).every((scenario) => scenario.pass)
    );

    await writeArtifact(artifact);
    process.exit(artifact.pass ? 0 : 1);
  }
}

run().catch(async (error) => {
  restoreDbFiles();
  restoreSettings();
  if (fs.existsSync(workDir)) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  await writeArtifact({
    generatedAt: new Date().toISOString(),
    appPath,
    sidecarPath,
    dbPath,
    settingsPath,
    workDir,
    pass: false,
    error: error instanceof Error ? error.message : String(error),
    dbRestored: true,
    settingsRestored: true,
  });
  process.exit(1);
});
