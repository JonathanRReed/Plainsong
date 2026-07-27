#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && index < args.length - 1 ? args[index + 1] : fallback;
}

const appPath = path.resolve(
  repoRoot,
  valueFor("--app", "release/mac-arm64/Plainsong.app"),
);
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/qa/macos/capture-system-audio-test.json"),
);
const timeoutMs = Number(valueFor("--timeout-ms", "75000"));
const sidecarPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "plainsong-sidecar",
);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.platform !== "darwin") {
  fail("capture-packaged-macos-system-audio-test can only run on macOS.");
}
if (!fs.existsSync(sidecarPath)) {
  fail(`Packaged sidecar not found at ${sidecarPath}`);
}

const child = spawn(sidecarPath, [], {
  cwd: repoRoot,
  stdio: ["pipe", "pipe", "pipe"],
});
const stderr = [];
child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
const rl = createInterface({ input: child.stdout });
const requestId = "system-audio-test";
let settled = false;

function finish(artifact, exitCode) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(artifact, null, 2));
  if (child.stdin.writable) {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "shutdown", method: "shutdown", params: {} })}\n`,
    );
  }
  setTimeout(() => child.kill("SIGTERM"), 1000).unref();
  process.exitCode = exitCode;
}

const timeout = setTimeout(() => {
  finish(
    {
      pass: false,
      reason: "timeout",
      timeoutMs,
      appPath,
      sidecarPath,
      stderr: stderr.join("").slice(-12000),
    },
    1,
  );
}, timeoutMs);

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (String(message.id) !== requestId) return;
  if (message.error) {
    finish(
      {
        pass: false,
        reason: "rpc_error",
        error: message.error,
        appPath,
        sidecarPath,
        stderr: stderr.join("").slice(-12000),
      },
      1,
    );
    return;
  }

  const result = message.result ?? {};
  const capability = result.capability ?? {};
  const checks = {
    ready: capability.ready === true,
    callbacks: Number(result.callbacks) > 0,
    nonSilentFrames: Number(result.nonSilentFrames) > 0,
    expectedTone: Math.abs(Number(result.expectedToneHz) - 997) < 0.5,
    detectedTone: Number(result.detectedToneAmplitude) >= 0.005,
    knownToneMethod: result.verificationMethod === "known_tone",
    nativeFormat: Number(capability.nativeSampleRate) > 0 && Number(capability.nativeChannels) > 0,
  };
  const pass = Object.values(checks).every(Boolean);
  finish(
    {
      pass,
      generatedAt: new Date().toISOString(),
      appPath,
      sidecarPath,
      checks,
      result,
      stderr: stderr.join("").slice(-12000),
    },
    pass ? 0 : 1,
  );
});

child.on("exit", (code, signal) => {
  if (!settled) {
    finish(
      {
        pass: false,
        reason: "sidecar_exit",
        code,
        signal,
        appPath,
        sidecarPath,
        stderr: stderr.join("").slice(-12000),
      },
      1,
    );
  }
});

child.stdin.write(
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    method: "test_system_audio_capture",
    params: {},
  })}\n`,
);
