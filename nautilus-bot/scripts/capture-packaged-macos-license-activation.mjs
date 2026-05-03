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
const sidecarPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "nautilus-sidecar"
);
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/qa/macos/licensing-activate-deactivate-live.json")
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "artifacts/qa/macos/licensing-activate-deactivate.md")
);
const timeoutMs = Number(valueFor("--timeout-ms", "120000"));
const liveKey = process.env.NAUTILUS_QA_LICENSE_KEY?.trim() ?? "";
const allowExistingLicense = args.includes("--allow-existing-license");
const generatedAt = new Date().toISOString();

function redact(value) {
  if (!value) return "";
  return `[redacted:${crypto.createHash("sha256").update(value).digest("hex").slice(0, 12)}]`;
}

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${body.trimEnd()}\n`, "utf8");
}

function writeJson(filePath, value) {
  writeText(filePath, JSON.stringify(value, null, 2));
}

function scrubSecretValues(value) {
  if (typeof value === "string") {
    return liveKey ? value.replaceAll(liveKey, redact(liveKey)) : value;
  }
  if (Array.isArray(value)) {
    return value.map(scrubSecretValues);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, scrubSecretValues(entry)])
    );
  }
  return value;
}

function blockedReport(reason) {
  return {
    generatedAt,
    appPath,
    sidecarPath,
    pass: false,
    status: "BLOCKED",
    reason,
    requiredEnv: "NAUTILUS_QA_LICENSE_KEY",
    command: "bun run qa:packaged:macos:license-live",
    secretPolicy: "License values are never written. Live results store only a redacted key fingerprint.",
  };
}

function writeMarkdown(report) {
  const status = report.pass ? "PASS" : "BLOCKED";
  const lines = [
    "# Licensing: License activation/deactivation",
    "",
    `Status: ${status}`,
    "Owner: qa-macos",
    `Generated: ${report.generatedAt}`,
    "",
    "## Evidence",
    "",
    `- Artifact: \`${path.relative(repoRoot, outPath)}\``,
    "- Command: `bun run qa:packaged:macos:license-live`",
    "- App: `release/mac-arm64/Nautilus.app`",
    "- Sidecar: `release/mac-arm64/Nautilus.app/Contents/Resources/sidecar/nautilus-sidecar`",
  ];

  if (report.pass) {
    lines.push(
      "",
      "## Verified Checks",
      "",
      "- Packaged sidecar accepted the live test license key without logging the raw key.",
      "- Activation returned a valid entitlement.",
      "- Validation after activation returned a valid entitlement.",
      "- Deactivation completed through the packaged sidecar command.",
      "- Validation after deactivation returned an invalid or trial-only entitlement.",
      "- The raw license key was not written to the renderer-visible license cache."
    );
  } else {
    lines.push(
      "",
      "## Blocking Detail",
      "",
      `- ${report.reason}`,
      "- Set `NAUTILUS_QA_LICENSE_KEY` to a disposable Lemon Squeezy test key and rerun `bun run qa:packaged:macos:license-live`.",
      "- The harness refuses to overwrite an existing valid local license unless `--allow-existing-license` is passed."
    );
  }

  writeText(markdownPath, lines.join("\n"));
}

function stderrEvidence(chunks) {
  const value = chunks.join("").trim();
  return {
    length: value.length,
    tail: value.replaceAll(liveKey, redact(liveKey)).slice(-12000),
  };
}

function licenseCachePath() {
  return path.join(os.homedir(), "Library", "Application Support", "NautilusBot", "nautilus_license.json");
}

function cacheContainsRawKey() {
  const filePath = licenseCachePath();
  if (!liveKey || !fs.existsSync(filePath)) return false;
  return fs.readFileSync(filePath, "utf8").includes(liveKey);
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
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const pending = new Map();
  const rl = createInterface({ input: child.stdout });
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

  return { sendCommand, shutdown, stderr, didTimeOut: () => didTimeOut };
}

async function runLiveCapture() {
  if (process.platform !== "darwin") {
    return blockedReport("Live packaged license activation capture can only run on macOS.");
  }
  if (!fs.existsSync(sidecarPath)) {
    return blockedReport(`Packaged sidecar not found at ${sidecarPath}`);
  }
  if (!liveKey) {
    return blockedReport("Missing NAUTILUS_QA_LICENSE_KEY.");
  }

  const sidecar = launchSidecar();
  const report = {
    generatedAt,
    appPath,
    sidecarPath,
    command: "bun run qa:packaged:macos:license-live",
    requiredEnv: "NAUTILUS_QA_LICENSE_KEY",
    secretPolicy: "License values are never written. Live results store only a redacted key fingerprint.",
    pass: false,
    status: "FAIL",
    licenseKeyFingerprint: redact(liveKey),
    existingLicenseBeforeRun: null,
    activation: null,
    validationAfterActivation: null,
    validationAfterDeactivation: null,
    deactivationCompleted: false,
    rawKeyInCacheAfterActivation: null,
    rawKeyInCacheAfterDeactivation: null,
    checks: {},
    sidecarExit: null,
    sidecarStderr: null,
  };

  try {
    report.existingLicenseBeforeRun = await sidecar.sendCommand("validate_license", {});
    const existingValid = Boolean(report.existingLicenseBeforeRun?.valid);
    if (existingValid && !allowExistingLicense) {
      throw new Error(
        "Existing valid local license detected. Refusing to overwrite it without --allow-existing-license."
      );
    }

    report.activation = await sidecar.sendCommand("activate_license", { key: liveKey });
    report.validationAfterActivation = await sidecar.sendCommand("validate_license", {});
    report.rawKeyInCacheAfterActivation = cacheContainsRawKey();
    await sidecar.sendCommand("deactivate_license", {});
    report.deactivationCompleted = true;
    report.validationAfterDeactivation = await sidecar.sendCommand("validate_license", {});
    report.rawKeyInCacheAfterDeactivation = cacheContainsRawKey();
  } catch (error) {
    report.error = String(error instanceof Error ? error.message : error).replaceAll(
      liveKey,
      redact(liveKey)
    );
  } finally {
    report.sidecarExit = await sidecar.shutdown();
    report.sidecarStderr = stderrEvidence(sidecar.stderr);
    report.timedOut = sidecar.didTimeOut();
  }

  report.checks = {
    noTimeout: !report.timedOut,
    activationValid: Boolean(report.activation?.valid),
    validationAfterActivationValid: Boolean(report.validationAfterActivation?.valid),
    deactivationCompleted: report.deactivationCompleted,
    validationAfterDeactivationNotValid: !report.validationAfterDeactivation?.valid,
    rawKeyAbsentFromCacheAfterActivation: report.rawKeyInCacheAfterActivation === false,
    rawKeyAbsentFromCacheAfterDeactivation: report.rawKeyInCacheAfterDeactivation === false,
  };
  report.pass = Object.values(report.checks).every(Boolean);
  report.status = report.pass ? "PASS" : "FAIL";
  return report;
}

const report = scrubSecretValues(await runLiveCapture());
writeJson(outPath, report);
writeMarkdown(report);
console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
