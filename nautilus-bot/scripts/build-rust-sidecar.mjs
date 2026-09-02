#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { sidecarCargoFeatureArgs } from "./sidecar-cargo-features.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repoRoot, "rust-sidecar", "Cargo.toml");
const env = { ...process.env };

// The Electron bundle supports macOS 13. Keep the Rust executable's Mach-O
// deployment target aligned with that floor while the Core Audio 14.2 symbols
// are resolved dynamically by the vendored CPAL patch.
if (process.platform === "darwin") {
  env.MACOSX_DEPLOYMENT_TARGET = "13.0";
}

// On macOS the shipped sidecar also compiles the opt-in acceleration features
// (currently Candle's Metal backend). The list, and why it is Darwin-only,
// lives in scripts/sidecar-cargo-features.mjs so lint/test/benchmark and the
// third-party notices resolve the same feature set. Other hosts get `[]`.
const result = spawnSync(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    manifestPath,
    ...sidecarCargoFeatureArgs(),
    "--bin",
    "plainsong-sidecar",
    // The `plainsong` command-line tool / MCP server ships beside the sidecar.
    "--bin",
    "plainsong-cli",
  ],
  {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(`Failed to launch cargo: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const auditArgs = [path.join(repoRoot, "scripts", "verify-macos-system-audio.mjs")];
if (process.platform !== "darwin") {
  auditArgs.push("--source-only");
}
const audit = spawnSync(process.execPath, auditArgs, {
  cwd: repoRoot,
  env,
  stdio: "inherit",
});
if (audit.error) {
  console.error(`Failed to launch system-audio audit: ${audit.error.message}`);
  process.exit(1);
}
if (audit.status !== 0) {
  process.exit(audit.status ?? 1);
}

const speechHelperArgs = [
  path.join(repoRoot, "scripts", "verify-macos-speech-helper.mjs"),
];
if (process.platform !== "darwin") {
  speechHelperArgs.push("--source-only");
}
const speechHelperAudit = spawnSync(process.execPath, speechHelperArgs, {
  cwd: repoRoot,
  env,
  stdio: "inherit",
});
if (speechHelperAudit.error) {
  console.error(
    `Failed to launch macOS Speech helper audit: ${speechHelperAudit.error.message}`,
  );
  process.exit(1);
}
process.exit(speechHelperAudit.status ?? 1);
