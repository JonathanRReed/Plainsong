#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const sourceOnly = args.includes("--source-only");
const sidecarArg = args.find((arg) => !arg.startsWith("--"));
const sidecarPath = path.resolve(
  repoRoot,
  sidecarArg ?? "rust-sidecar/target/release/plainsong-sidecar",
);

function fail(message) {
  console.error(`macOS system-audio gate failed: ${message}`);
  process.exit(1);
}

function requireMatch(value, pattern, message) {
  if (!pattern.test(value)) fail(message);
}

function run(program, commandArgs) {
  const result = spawnSync(program, commandArgs, { encoding: "utf8" });
  if (result.error) fail(`could not launch ${program}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${program} ${commandArgs.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

const builder = fs.readFileSync(path.join(repoRoot, "electron-builder.yml"), "utf8");
requireMatch(
  builder,
  /minimumSystemVersion:\s*["']13\.0["']/,
  "electron-builder must retain the macOS 13.0 minimum",
);
requireMatch(
  builder,
  /NSAudioCaptureUsageDescription:\s*["']Plainsong captures audio playing on your Mac to record and transcribe meetings\. Depending on your transcription settings, meeting audio may be processed on this Mac or sent to the cloud provider you choose\.["']/,
  "NSAudioCaptureUsageDescription must disclose configurable cloud transcription",
);

const cargoToml = fs.readFileSync(path.join(repoRoot, "rust-sidecar", "Cargo.toml"), "utf8");
requireMatch(
  cargoToml,
  /cpal\s*=\s*\{\s*path\s*=\s*["']vendor\/cpal-0\.18\.1["']\s*\}/,
  "the sidecar must use the narrowly vendored CPAL 0.18.1 patch",
);

const loopback = fs.readFileSync(
  path.join(
    repoRoot,
    "rust-sidecar",
    "vendor",
    "cpal-0.18.1",
    "src",
    "host",
    "coreaudio",
    "macos",
    "loopback.rs",
  ),
  "utf8",
);
requireMatch(loopback, /libc::dlsym/, "the CPAL patch must resolve process-tap symbols dynamically");
if (/AudioHardwareCreateProcessTap\s*\(/.test(loopback)) {
  fail("the CPAL patch still contains a direct AudioHardwareCreateProcessTap call");
}
if (/AudioHardwareDestroyProcessTap\s*\(/.test(loopback)) {
  fail("the CPAL patch still contains a direct AudioHardwareDestroyProcessTap call");
}

const cpalDevice = fs.readFileSync(
  path.join(
    repoRoot,
    "rust-sidecar",
    "vendor",
    "cpal-0.18.1",
    "src",
    "host",
    "coreaudio",
    "macos",
    "device.rs",
  ),
  "utf8",
);
requireMatch(
  cpalDevice,
  /self\.is_default_output\s*\|\|\s*!self\.supports_input\(\)/,
  "default-output input streams must force the process-tap path",
);
requireMatch(
  cpalDevice,
  /if self\.is_default_output \{[\s\S]*?DefaultOutputMonitor::new\(/,
  "default-output input streams must use the Core Audio route-change monitor",
);

if (!sourceOnly) {
  if (process.platform !== "darwin") {
    fail("Mach-O auditing requires macOS; pass --source-only on other platforms");
  }
  if (!fs.existsSync(sidecarPath)) {
    fail(`sidecar not found at ${sidecarPath}`);
  }

  const buildVersion = run("xcrun", ["vtool", "-show-build", sidecarPath]);
  requireMatch(
    buildVersion,
    /minos\s+13\.0(?:\.0)?\b/,
    "the packaged sidecar Mach-O minimum must be macOS 13.0",
  );

  const undefinedSymbols = run("nm", ["-u", sidecarPath]);
  if (/AudioHardware(?:Create|Destroy)ProcessTap/.test(undefinedSymbols)) {
    fail("the sidecar has a strong undefined Core Audio process-tap import");
  }

  const imports = run("xcrun", ["dyld_info", "-imports", sidecarPath]);
  if (/AudioHardware(?:Create|Destroy)ProcessTap/.test(imports)) {
    fail("dyld import metadata still contains a Core Audio process-tap import");
  }
}

console.log(
  JSON.stringify({
    pass: true,
    sourceOnly,
    sidecarPath: sourceOnly ? null : sidecarPath,
    minimumSystemVersion: "13.0",
    processTapImports: "dynamic-only",
  }),
);
