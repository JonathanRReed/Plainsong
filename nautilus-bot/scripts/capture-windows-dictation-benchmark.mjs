#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

function flag(name) {
  return args.includes(name);
}

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return result;
}

if (process.platform !== "win32") {
  process.stderr.write(
    "Run this helper on Windows to capture a real Windows dictation benchmark artifact.\n"
  );
  process.exit(1);
}

const candidateOut = valueFor(
  "--candidate-out",
  "docs/evals/benchmark-run-latest-windows.json"
);
const baselineOut = valueFor(
  "--baseline-out",
  "docs/evals/benchmark-run-baseline.json"
);
const fixtures = valueFor(
  "--fixtures",
  "docs/evals/dictation-parity-fixture.json"
);
const buildVersion = valueFor("--build-version", "nautilus-windows-local");
const promoteBaseline = flag("--promote-baseline");
const schemaPath = "docs/evals/benchmark-run.schema.json";

const candidatePath = path.resolve(process.cwd(), candidateOut);
const baselinePath = path.resolve(process.cwd(), baselineOut);

fs.mkdirSync(path.dirname(candidatePath), { recursive: true });

run(process.execPath, [
  "scripts/generate-dictation-benchmark.mjs",
  "--fixtures",
  fixtures,
  "--out",
  candidateOut,
  "--build-version",
  buildVersion,
]);

run(process.execPath, [
  "scripts/validate-gate-artifact.mjs",
  "--schema",
  schemaPath,
  "--file",
  candidateOut,
]);

if (promoteBaseline || !fs.existsSync(baselinePath)) {
  fs.copyFileSync(candidatePath, baselinePath);
  run(process.execPath, [
    "scripts/validate-gate-artifact.mjs",
    "--schema",
    schemaPath,
    "--file",
    baselineOut,
  ]);
  process.stdout.write(
    `Promoted Windows benchmark run to baseline: ${baselineOut}\n`
  );
} else {
  process.stdout.write(
    `Left existing baseline unchanged: ${baselineOut}\n`
  );
}
