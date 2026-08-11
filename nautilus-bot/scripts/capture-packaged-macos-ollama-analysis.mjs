#!/usr/bin/env node
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
  prefix: "plainsong-ollama-qa-",
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
  valueFor("--out", "artifacts/qa/macos/ai-ollama-local.json")
);
const model = valueFor("--model", "gpt-oss:20b");
const timeoutMs = Number(valueFor("--timeout-ms", "240000"));
const sidecarPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "plainsong-sidecar"
);
const dataDir = qaProfile.dataDir;
const dbPath = path.join(dataDir, "plainsong.db");
const dbSidecarPaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
const dbBackups = new Map();
const recordingId = `qa-ollama-${Date.now()}`;
const transcriptId = `${recordingId}-transcript`;
const now = new Date().toISOString();
const transcriptText =
  "Maya decided the launch readiness report must stay no go until signing is complete. " +
  "Jon will prepare the QA evidence bundle today. " +
  "Priya owns the Windows installer validation next week.";
const segments = [
  {
    id: `${recordingId}-seg-1`,
    startTime: 0,
    endTime: 6,
    text: "Maya decided the launch readiness report must stay no go until signing is complete.",
    speakerId: "speaker-1",
    confidence: 0.98,
  },
  {
    id: `${recordingId}-seg-2`,
    startTime: 6,
    endTime: 12,
    text: "Jon will prepare the QA evidence bundle today.",
    speakerId: "speaker-2",
    confidence: 0.97,
  },
  {
    id: `${recordingId}-seg-3`,
    startTime: 12,
    endTime: 18,
    text: "Priya owns the Windows installer validation next week.",
    speakerId: "speaker-3",
    confidence: 0.97,
  },
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.platform !== "darwin") {
  fail("capture-packaged-macos-ollama-analysis can only run on macOS.");
}

if (!fs.existsSync(sidecarPath)) {
  fail(`Packaged sidecar not found at ${sidecarPath}`);
}

if (!fs.existsSync(dbPath)) {
  fail(`Plainsong database not found at ${dbPath}`);
}

function hashBytes(bytes) {
  if (!bytes) {
    return null;
  }
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

function seedFixture() {
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
  'QA Ollama Local Analysis Fixture',
  'inbox',
  18,
  ${sqlString(now)},
  ${sqlString(now)},
  'meeting',
  '',
  'completed',
  'QA fixture for local Ollama analysis. Remove after test.',
  'standup',
  'mic',
  ${sqlString(now)},
  1,
  'manual',
  'qa',
  'QA fixture consent notice',
  ${sqlString(now)}
);
INSERT INTO transcripts (
  id, recording_id, segments, full_text, language, confidence, model,
  model_id, requested_provider, actual_provider, created_at
) VALUES (
  ${sqlString(transcriptId)},
  ${sqlString(recordingId)},
  ${sqlString(JSON.stringify(segments))},
  ${sqlString(transcriptText)},
  'en',
  0.98,
  'qa-fixture',
  'qa-fixture',
  'qa-fixture',
  'qa-fixture',
  ${sqlString(now)}
);
COMMIT;
`);
}

function stderrEvidence(chunks) {
  const value = chunks.join("").trim();
  return {
    length: value.length,
    tail: value.slice(-12000),
  };
}

snapshotDbFiles();
seedFixture();

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
  if (!pendingCommand) {
    return;
  }
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

function resultHasCitation(result) {
  return Array.isArray(result?.citations) && result.citations.length > 0;
}

function resultMentionsFixture(result) {
  const response = String(result?.summary ?? result?.response ?? "").toLowerCase();
  return (
    response.includes("signing") ||
    response.includes("qa evidence") ||
    response.includes("windows")
  );
}

async function writeArtifact(artifact) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(artifact, null, 2));
}

async function run() {
  const artifact = {
    generatedAt: new Date().toISOString(),
    appPath,
    sidecarPath,
    dbPath,
    recordingId,
    model,
    pass: false,
    timedOut: false,
    dbRestored: false,
    originalDbHashes: Object.fromEntries(
      [...dbBackups.entries()].map(([filePath, bytes]) => [filePath, hashBytes(bytes)])
    ),
    restoredDbHashes: null,
    checks: {},
    stderr: { length: 0, tail: "" },
  };

  try {
    const ollamaAvailable = await sendCommand("get_ollama_status", {});
    const models = await sendCommand("list_ollama_models", {});
    artifact.ollama = {
      available: Boolean(ollamaAvailable),
      models,
      selectedModelPresent: models.includes(model),
    };

    if (!ollamaAvailable) {
      throw new Error("Ollama is not available.");
    }
    if (!models.includes(model)) {
      throw new Error(`Ollama model ${model} is not installed.`);
    }

    const summary = await sendCommand("summarize_recording_grounded", {
      recordingId,
      model,
    });
    artifact.summary = summary;
    artifact.checks.summaryHasCitation = resultHasCitation(summary);
    artifact.checks.summaryMentionsFixture = resultMentionsFixture(summary);

    const actionItems = await sendCommand("extract_action_items_grounded", {
      recordingId,
      model,
    });
    artifact.actionItems = actionItems;
    artifact.checks.actionItemsHaveCitations =
      Array.isArray(actionItems?.items) &&
      actionItems.items.length > 0 &&
      actionItems.items.every((item) => resultHasCitation({ citations: item.citations }));
    artifact.checks.actionItemsMentionOwners = JSON.stringify(actionItems).toLowerCase().includes("jon");
  } catch (error) {
    artifact.error = error instanceof Error ? error.message : String(error);
  } finally {
    artifact.timedOut = didTimeOut;
    artifact.stderr = stderrEvidence(stderr);
    artifact.sidecarExit = await shutdown();

    restoreDbFiles();
    artifact.restoredDbHashes = dbHashes();
    artifact.dbRestored =
      JSON.stringify(artifact.restoredDbHashes) === JSON.stringify(artifact.originalDbHashes);

    artifact.pass = Boolean(
      !didTimeOut &&
        artifact.dbRestored &&
        artifact.ollama?.available &&
        artifact.ollama?.selectedModelPresent &&
        artifact.checks.summaryHasCitation &&
        artifact.checks.summaryMentionsFixture &&
        artifact.checks.actionItemsHaveCitations &&
        artifact.checks.actionItemsMentionOwners
    );

    await writeArtifact(artifact);
    clearTimeout(timeout);
    process.exit(artifact.pass ? 0 : 1);
  }
}

run().catch(async (error) => {
  clearTimeout(timeout);
  child.kill("SIGTERM");
  restoreDbFiles();
  await writeArtifact({
    generatedAt: new Date().toISOString(),
    appPath,
    sidecarPath,
    dbPath,
    recordingId,
    model,
    pass: false,
    dbRestored: true,
    error: error instanceof Error ? error.message : String(error),
    stderr: stderrEvidence(stderr),
  });
  process.exit(1);
});
