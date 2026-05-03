#!/usr/bin/env node
import fs from "node:fs";
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
const fixturePath = path.resolve(
  repoRoot,
  valueFor("--fixture", "scripts/fixtures/local-quality-gate.wav")
);
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/qa/macos/transcription-whisper-e2e.json")
);
const timeoutMs = Number(valueFor("--timeout-ms", "180000"));
const sidecarPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "nautilus-sidecar"
);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.platform !== "darwin") {
  fail("capture-packaged-macos-whisper-transcription can only run on macOS.");
}

if (!fs.existsSync(sidecarPath)) {
  fail(`Packaged sidecar not found at ${sidecarPath}`);
}

if (!fs.existsSync(fixturePath)) {
  fail(`Fixture audio not found at ${fixturePath}`);
}

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
    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
  if (!result) {
    child.kill("SIGTERM");
    return await childExit;
  }
  return result;
}

function transcriptionLooksValid(value) {
  const text = String(value ?? "").trim();
  return text.length >= 5 && /[a-z]/i.test(text);
}

function stderrEvidence(chunks) {
  const value = chunks.join("").trim();
  return {
    length: value.length,
    tail: value.slice(-12000),
  };
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
    fixturePath,
    pass: false,
    timedOut: false,
    whisper: null,
    returnedProviders: [],
    stderr: { length: 0, tail: "" },
  };

  try {
    const diagnostics = await sendCommand("get_asr_runtime_diagnostics", {
      providerType: "whisper",
    });
    artifact.whisperDiagnostics = diagnostics;

    const results = await sendCommand("benchmark_asr_providers", {
      testAudioPath: fixturePath,
    });
    artifact.returnedProviders = results.map((result) => ({
      providerType: result.providerType,
      providerName: result.providerName,
      modelId: result.modelId,
      runtimeStatus: result.runtimeStatus,
      nonEmptyTranscript: result.nonEmptyTranscript,
      processingTimeMs: result.processingTimeMs,
      confidence: result.confidence,
      transcriptionPreview: String(result.transcription ?? "").trim().slice(0, 240),
    }));
    artifact.whisper = results.find((result) => result.providerType === "whisper") ?? null;
  } catch (error) {
    artifact.error = error instanceof Error ? error.message : String(error);
  } finally {
    artifact.timedOut = didTimeOut;
    artifact.stderr = stderrEvidence(stderr);
    artifact.sidecarExit = await shutdown();
    artifact.pass = Boolean(
      !didTimeOut &&
        artifact.whisperDiagnostics?.runtimeStatus === "ready" &&
        artifact.whisper?.providerType === "whisper" &&
        artifact.whisper?.runtimeStatus === "ready" &&
        artifact.whisper?.nonEmptyTranscript &&
        transcriptionLooksValid(artifact.whisper?.transcription)
    );

    if (artifact.whisper) {
      artifact.whisper = {
        providerType: artifact.whisper.providerType,
        providerName: artifact.whisper.providerName,
        modelId: artifact.whisper.modelId,
        runtimeStatus: artifact.whisper.runtimeStatus,
        nonEmptyTranscript: artifact.whisper.nonEmptyTranscript,
        processingTimeMs: artifact.whisper.processingTimeMs,
        confidence: artifact.whisper.confidence,
        transcription: artifact.whisper.transcription,
      };
    }

    await writeArtifact(artifact);
    clearTimeout(timeout);
    process.exit(artifact.pass ? 0 : 1);
  }
}

run().catch(async (error) => {
  clearTimeout(timeout);
  child.kill("SIGTERM");
  await writeArtifact({
    generatedAt: new Date().toISOString(),
    appPath,
    sidecarPath,
    fixturePath,
    pass: false,
    error: error instanceof Error ? error.message : String(error),
    stderr: stderrEvidence(stderr),
  });
  process.exit(1);
});
