#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  let resolved = fallback;
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === name) {
      resolved = args[index + 1];
    }
  }
  return resolved;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result;
}

const fixturesPath = path.resolve(
  process.cwd(),
  valueFor("--fixtures", "docs/evals/dictation-parity-fixture.json")
);
const outputPath = path.resolve(
  process.cwd(),
  valueFor("--out", "artifacts/evals/dictation-benchmark-run.json")
);
const latencyScale = valueFor("--latency-scale", "1.0");
const buildVersion = valueFor("--build-version", "nautilus-dev");
const generatedAt = valueFor("--generated-at", new Date().toISOString());
const runId = valueFor("--run-id", `dictation-parity-${Date.now()}`);
const buildCommitOverride = valueFor("--build-commit");

if (!fs.existsSync(fixturesPath)) {
  console.error(`Fixture file not found: ${fixturesPath}`);
  process.exit(1);
}

const commit =
  buildCommitOverride ??
  run("git", ["rev-parse", "--short", "HEAD"]).stdout.trim() ??
  "unknown";
const platformOs =
  valueFor(
    "--platform-os",
    process.platform === "darwin"
      ? "macOS"
      : process.platform === "win32"
        ? "Windows"
        : process.platform
  ) ?? "unknown";
const platformVersion =
  valueFor(
    "--platform-version",
    process.platform === "darwin"
      ? run("sw_vers", ["-productVersion"]).stdout.trim()
      : os.release()
  ) ?? "unknown";
const device =
  valueFor(
    "--device",
    process.platform === "darwin"
      ? run("sysctl", ["-n", "machdep.cpu.brand_string"]).stdout.trim().replace(/\s+/g, " ")
      : `${os.type()} ${os.arch()}`
  ) ?? "unknown";

run(
  "cargo",
  [
    "run",
    "--manifest-path",
    "rust-sidecar/Cargo.toml",
    "--bin",
    "dictation-parity-benchmark",
    "--",
    "--fixtures",
    fixturesPath,
    "--out",
    outputPath,
    "--run-id",
    runId,
    "--generated-at",
    generatedAt,
    "--build-version",
    buildVersion,
    "--build-commit",
    commit,
    "--platform-os",
    platformOs,
    "--platform-version",
    platformVersion,
    "--device",
    device,
    "--latency-scale",
    latencyScale,
  ],
  { env: { ...process.env } }
);
