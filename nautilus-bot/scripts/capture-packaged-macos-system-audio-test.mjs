#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createPackagedQaProfile } from "./lib/packaged-qa-profile.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const qaProfile = createPackagedQaProfile({
  args,
  prefix: "plainsong-system-audio-qa-",
});

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
// The sidecar owns a 75s worker deadline so it can kill and reap a Core Audio
// setup that macOS leaves blocked. Give that cleanup and the JSON-RPC response
// enough room to arrive before the outer QA harness declares its own timeout.
const timeoutMs = Number(valueFor("--timeout-ms", "90000"));
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
  env: { ...process.env, ...qaProfile.env },
});
const stderr = [];
child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
const rl = createInterface({ input: child.stdout });
const requestId = "system-audio-test";
const healthRequestId = "system-audio-post-test-health";
let settled = false;
let pendingSystemAudioResult = null;
let pendingSystemAudioChecks = null;
let finalArtifact = null;
let finalExitCode = 1;
let shutdownTimer = null;

function writeArtifact(artifact, exitCode) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(artifact, null, 2));
  process.exitCode = exitCode;
}

function finish(artifact, exitCode) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  finalArtifact = artifact;
  finalExitCode = exitCode;
  if (child.stdin.writable) {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "shutdown", method: "shutdown", params: {} })}\n`,
    );
  }
  // Native model warmup can still be finishing when the system-audio probe
  // completes. Give the sidecar the same bounded shutdown window as the other
  // packaged QA harnesses so the evidence cannot hide a forced termination.
  shutdownTimer = setTimeout(() => child.kill("SIGTERM"), 15000);
  shutdownTimer.unref();
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
  if (String(message.id) === healthRequestId) {
    const sidecarResponsive =
      !message.error &&
      message.result !== null &&
      typeof message.result === "object";
    const checks = {
      ...pendingSystemAudioChecks,
      sidecarResponsiveAfterTest: sidecarResponsive,
    };
    const pass = Object.values(checks).every(Boolean);
    finish(
      {
        pass,
        generatedAt: new Date().toISOString(),
        appPath,
        sidecarPath,
        checks,
        recovery: {
          sidecarResponsive,
          healthMethod: "get_settings",
          healthError: message.error ?? null,
        },
        result: pendingSystemAudioResult,
        stderr: stderr.join("").slice(-12000),
      },
      pass ? 0 : 1,
    );
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
  pendingSystemAudioResult = result;
  pendingSystemAudioChecks = checks;
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: healthRequestId,
      method: "get_settings",
      params: {},
    })}\n`,
  );
});

child.on("exit", (code, signal) => {
  if (shutdownTimer) clearTimeout(shutdownTimer);

  if (finalArtifact) {
    const sidecarExitedCleanly = code === 0 && signal === null;
    const checks = finalArtifact.checks
      ? { ...finalArtifact.checks, sidecarExitedCleanly }
      : null;
    const pass = finalArtifact.pass === true && sidecarExitedCleanly;
    writeArtifact(
      {
        ...finalArtifact,
        pass,
        ...(checks ? { checks } : {}),
        sidecarExit: { code, signal },
      },
      pass ? 0 : Math.max(1, finalExitCode),
    );
    return;
  }

  if (!settled) {
    settled = true;
    clearTimeout(timeout);
    writeArtifact(
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
