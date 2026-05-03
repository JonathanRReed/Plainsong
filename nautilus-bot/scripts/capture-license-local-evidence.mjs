#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const generatedAt = new Date().toISOString();

function run(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if ((result.status ?? 1) !== 0) {
    if (output) {
      process.stderr.write(`${output}\n`);
    }
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }

  return {
    label,
    command: [command, ...args].join(" "),
    status: "PASS",
    output,
  };
}

function writeText(relativePath, body) {
  const fullPath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${body.trimEnd()}\n`, "utf8");
}

function writeJson(relativePath, value) {
  writeText(relativePath, JSON.stringify(value, null, 2));
}

function resultBlock(result) {
  return [
    `- Command: \`${result.command}\``,
    `- Result: ${result.status}`,
  ].join("\n");
}

const rustLicense = run("Rust license core tests", "cargo", [
  "test",
  "--manifest-path",
  "rust-sidecar/Cargo.toml",
  "license::tests",
]);

const rendererLicense = run("Renderer license tests", "bun", [
  "run",
  "test",
  "--",
  "src/__tests__/entitlement.test.ts",
  "src/__tests__/nag-modal.test.tsx",
]);

const report = {
  generatedAt,
  status: "PASS",
  coverage: {
    trialExpiry: "PASS",
    nagCadence: "PASS",
    tierMatrix: "PASS",
    activationLimits: "PASS",
    futureTrialTamper: "PASS",
    secureCacheShape: "PASS",
    activationDeactivation: "BLOCKED_LIVE_LEMON_SQUEEZY_KEY_REQUIRED",
  },
  commands: [rustLicense, rendererLicense].map(({ label, command, status }) => ({
    label,
    command,
    status,
  })),
};

writeJson("artifacts/qa/macos/licensing-local-evidence.json", report);

writeText(
  "artifacts/qa/macos/licensing-trial-expiry.md",
  `# Licensing: Trial expiry + nag behavior

Status: PASS
Owner: qa-macos
Generated: ${generatedAt}

## Evidence
${resultBlock(rustLicense)}
${resultBlock(rendererLicense)}

## Verified Behavior
- New local trial state starts with 30 trial days and no nag.
- Expired trial state returns 0 remaining days and requires the nag.
- Malformed trial metadata fails closed.
- Future-dated trial metadata fails closed instead of extending the trial.
- Renderer nag cadence is 24 hours for the first expired week, 12 hours after 7 expired days, and 4 hours after 14 expired days.
`
);

writeText(
  "artifacts/qa/macos/licensing-tier-matrix.md",
  `# Licensing: License tiers unlock correct features (basic/pro/friends-club)

Status: PASS
Owner: qa-macos
Generated: ${generatedAt}

## Evidence
${resultBlock(rustLicense)}
${resultBlock(rendererLicense)}

## Verified Behavior
- Free or expired trial state resolves to the free tier with Pro and Friends Club features disabled.
- Active trial resolves to Pro feature access and update access, with Friends Club features disabled.
- Valid Pro resolves to Pro feature access, update access, and no Friends Club-only cloud sync or priority support.
- Valid Friends Club resolves to Friends tier access, Pro features, cloud sync, and priority support.
- Theme access remains basic for trial users, Pro for valid Pro users, and Friends for valid Friends Club users.
`
);

writeText(
  "artifacts/qa/macos/licensing-30-day-lockout.md",
  `# Licensing: 30-day pro lockout behavior verified

Status: PASS
Owner: qa-macos
Generated: ${generatedAt}

## Evidence
${resultBlock(rustLicense)}
${resultBlock(rendererLicense)}

## Verified Behavior
- Trial access is active inside the 30-day window.
- Trial access expires at 30 days when no valid license is present.
- Expired trial state disables Pro entitlement, experimental entitlement, and update access.
- Future-dated and malformed trial anchors fail closed.
- Activation-limit enforcement invalidates otherwise active cached licenses when usage exceeds the tier limit.
`
);

writeText(
  "artifacts/qa/macos/licensing-activate-deactivate.md",
  `# Licensing: License activation/deactivation

Status: BLOCKED
Owner: qa-macos
Generated: ${generatedAt}

## Current Local Observation
- License state persistence stores secret fields in secure storage and keeps raw key material out of the JSON cache.
- Cached entitlement, tier, trial, and activation-limit behavior pass local Rust and renderer tests.

## Blocking Detail
- Live activation and deactivation call Lemon Squeezy license endpoints and require a real launch license key.
- Packaged live capture is wired as \`bun run qa:packaged:macos:license-live\` and expects \`NAUTILUS_QA_LICENSE_KEY\`.
- This row remains blocked until a live license key is available for a packaged activation, validation, and deactivation run.
`
);

console.log(JSON.stringify(report, null, 2));
