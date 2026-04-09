#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit",
  });

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(process.execPath, [
  "scripts/generate-dictation-benchmark.mjs",
  "--fixtures",
  "docs/evals/dictation-parity-fixture.json",
  "--out",
  "docs/evals/benchmark-run-baseline.json",
  "--build-version",
  "nautilus-local-baseline",
  "--run-id",
  "dictation-parity-local-baseline",
  "--generated-at",
  "2026-04-09T15:00:00.000Z",
  "--latency-scale",
  "1.40",
  "--platform-os",
  "macOS",
  "--platform-version",
  "26.4",
  "--device",
  "Apple M4 Pro",
]);

run(process.execPath, [
  "scripts/generate-dictation-benchmark.mjs",
  "--fixtures",
  "docs/evals/dictation-parity-fixture.json",
  "--out",
  "docs/evals/benchmark-run-latest-macos.json",
  "--build-version",
  "nautilus-macos-local",
  "--run-id",
  "dictation-parity-local-macos",
  "--generated-at",
  "2026-04-09T15:05:00.000Z",
  "--latency-scale",
  "1.00",
  "--platform-os",
  "macOS",
  "--platform-version",
  "26.4",
  "--device",
  "Apple M4 Pro",
]);

run(process.execPath, [
  "scripts/generate-dictation-benchmark.mjs",
  "--fixtures",
  "docs/evals/dictation-parity-fixture.json",
  "--out",
  "docs/evals/benchmark-run-latest-windows.json",
  "--build-version",
  "nautilus-windows-fixture",
  "--run-id",
  "dictation-parity-local-windows-fixture",
  "--generated-at",
  "2026-04-09T15:10:00.000Z",
  "--latency-scale",
  "1.05",
  "--platform-os",
  "Windows",
  "--platform-version",
  "11.0.26100",
  "--device",
  "Windows Fixture Host x64",
]);

run(process.execPath, [
  "scripts/verify-benchmark-gates.mjs",
  "--schema",
  "docs/evals/benchmark-run.schema.json",
  "--baseline",
  "docs/evals/benchmark-run-baseline.json",
  "--candidate",
  "docs/evals/benchmark-run-latest-macos.json",
  "--out",
  "artifacts/benchmark-gates-macos.json",
]);

run(process.execPath, [
  "scripts/verify-benchmark-gates.mjs",
  "--schema",
  "docs/evals/benchmark-run.schema.json",
  "--baseline",
  "docs/evals/benchmark-run-baseline.json",
  "--candidate",
  "docs/evals/benchmark-run-latest-windows.json",
  "--out",
  "artifacts/benchmark-gates-windows.json",
]);
