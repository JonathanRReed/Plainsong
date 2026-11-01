#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createPackagedQaProfile } from "./lib/packaged-qa-profile.ts";

import { captureAppReceiptBinding, bindAppReceipt } from "./lib/app-receipt-binding.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name: string): string | null;
function valueFor(name: string, fallback: string): string;
function valueFor(name: string, fallback: string | null = null): string | null {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const appPath = path.resolve(
  repoRoot,
  valueFor("--app", "release/mac-arm64/Plainsong.app")
);
const appBinding = captureAppReceiptBinding(appPath);
const qaProfile = createPackagedQaProfile({
  args,
  prefix: "plainsong-whisper-qa-",
});
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
  "plainsong-sidecar"
);

function fail(message: string): never {
  const receipt = bindAppReceipt({
    generatedAt: new Date().toISOString(),
    appPath,
    pass: false,
    error: message,
  }, appBinding);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
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
  env: { ...process.env, ...qaProfile.env },
});

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

interface BenchmarkResult {
  providerType?: unknown;
  providerName?: unknown;
  modelId?: unknown;
  runtimeStatus?: unknown;
  nonEmptyTranscript?: unknown;
  processingTimeMs?: unknown;
  confidence?: unknown;
  transcription?: unknown;
  errorMessage?: unknown;
}

interface WhisperArtifact {
  generatedAt: string;
  appPath: string;
  sidecarPath: string;
  fixturePath: string;
  pass: boolean;
  timedOut?: boolean;
  whisper?: BenchmarkResult | null;
  returnedProviders?: unknown[];
  stderr: { length: number; tail: string };
  whisperDiagnostics?: { runtimeStatus?: unknown } | null;
  error?: string;
  sidecarExit?: ChildExit;
  checks?: Record<string, unknown>;
}

const childExit = new Promise<ChildExit>((resolve) => {
  child.on("exit", (code, signal) => resolve({ code, signal }));
});

const stderr: string[] = [];
child.stderr.on("data", (chunk: Buffer) => {
  stderr.push(String(chunk));
});

const rl = createInterface({ input: child.stdout });
const pending = new Map<string, PendingCommand>();
let nextId = 1;
let didTimeOut = false;

function sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = String(nextId++);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
  });
}

rl.on("line", (line) => {
  let message: { id?: unknown; result?: unknown; error?: { message?: string } };
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

async function shutdown(): Promise<ChildExit> {
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
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 15000)),
  ]);
  if (!result) {
    child.kill("SIGTERM");
    return await childExit;
  }
  return result;
}

function transcriptionLooksValid(value: unknown): boolean {
  const text = String(value ?? "").trim();
  return text.length >= 5 && /[a-z]/i.test(text);
}

function stderrEvidence(chunks: string[]): { length: number; tail: string } {
  const value = chunks.join("").trim();
  return {
    length: value.length,
    tail: value.slice(-12000),
  };
}

function hasFatalShutdownEvidence(value: string): boolean {
  return /GGML_ASSERT|assertion failed|fatal error|SIGABRT/i.test(value);
}

async function writeArtifact(input: WhisperArtifact) {
  const artifact = bindAppReceipt(input, appBinding);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(artifact, null, 2));
  return artifact;
}

async function run() {
  const artifact: WhisperArtifact = {
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
    artifact.whisperDiagnostics = diagnostics as WhisperArtifact["whisperDiagnostics"];

    const results = (await sendCommand("benchmark_asr_providers", {
      testAudioPath: fixturePath,
    })) as BenchmarkResult[];
    artifact.returnedProviders = results.map((result) => ({
      providerType: result.providerType,
      providerName: result.providerName,
      modelId: result.modelId,
      runtimeStatus: result.runtimeStatus,
      nonEmptyTranscript: result.nonEmptyTranscript,
      processingTimeMs: result.processingTimeMs,
      confidence: result.confidence,
      transcriptionPreview: String(result.transcription ?? "").trim().slice(0, 240),
      errorMessage: result.errorMessage ?? null,
    }));
    artifact.whisper = results.find((result) => result.providerType === "whisper") ?? null;
  } catch (error) {
    artifact.error = error instanceof Error ? error.message : String(error);
  } finally {
    artifact.timedOut = didTimeOut;
    artifact.sidecarExit = await shutdown();
    const completeStderr = stderr.join("");
    artifact.stderr = stderrEvidence(stderr);
    artifact.checks = {
      whisperReady: artifact.whisperDiagnostics?.runtimeStatus === "ready",
      nonEmptyTranscript:
        artifact.whisper?.providerType === "whisper" &&
        artifact.whisper?.runtimeStatus === "ready" &&
        artifact.whisper?.nonEmptyTranscript &&
        transcriptionLooksValid(artifact.whisper?.transcription),
      singleWhisperModelLoad:
        (completeStderr.match(/Loading Whisper model from/g) ?? []).length === 1,
      sidecarCleanExit:
        artifact.sidecarExit?.code === 0 && artifact.sidecarExit?.signal === null,
      noFatalShutdownEvidence: !hasFatalShutdownEvidence(completeStderr),
    };
    artifact.pass = Boolean(
      !didTimeOut &&
        Object.values(artifact.checks).every(Boolean)
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
        errorMessage: artifact.whisper.errorMessage ?? null,
      };
    }

    const receipt = await writeArtifact(artifact);
    clearTimeout(timeout);
    process.exit(receipt.pass ? 0 : 1);
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
