#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BETA_REFERENCE_BUDGETS = Object.freeze({
  minimumSamples: 5,
  coldModelPreparationMs: 8_000,
  warmupInferenceMs: 1_000,
  transcriptionMsP50: 1_200,
  transcriptionMsP95: 2_000,
  minimumMemoryBytes: 16 * 1024 * 1024 * 1024,
});

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nearestRankPercentile(values, percentile) {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
}

export function verifyDictationLatencyReport(
  report,
  { requireReferenceHardware = true } = {},
) {
  const failures = [];
  const requireEqual = (field, expected) => {
    if (report?.[field] !== expected) {
      failures.push(`${field} must be ${JSON.stringify(expected)}`);
    }
  };
  const requireNumber = (field) => {
    if (!finiteNumber(report?.[field])) failures.push(`${field} must be a finite number`);
  };

  requireEqual("schemaVersion", 1);
  requireEqual("thresholdProfile", "beta-reference-v1");
  requireEqual("metricScope", "provider_transcription_only");
  requireEqual("warmState", "warm");
  requireNumber("coldModelPreparationMs");
  requireNumber("warmupInferenceMs");
  requireNumber("sampleCount");
  requireNumber("transcriptionMsP50");
  requireNumber("transcriptionMsP95");

  for (const field of [
    "coldModelPreparationMs",
    "warmupInferenceMs",
    "transcriptionMsP50",
    "transcriptionMsP95",
  ]) {
    if (finiteNumber(report?.[field]) && report[field] < 0) {
      failures.push(`${field} must be non-negative`);
    }
  }

  if (!Array.isArray(report?.measurementsMs)) {
    failures.push("measurementsMs must be an array");
  } else {
    if (report.measurementsMs.length !== report.sampleCount) {
      failures.push("measurementsMs length must match sampleCount");
    }
    report.measurementsMs.forEach((measurement, index) => {
      if (!finiteNumber(measurement) || measurement < 0) {
        failures.push(`measurementsMs[${index}] must be a finite, non-negative number`);
      }
    });

    if (
      report.measurementsMs.length > 0 &&
      report.measurementsMs.every((measurement) => finiteNumber(measurement) && measurement >= 0)
    ) {
      for (const [field, percentile] of [
        ["transcriptionMsP50", 50],
        ["transcriptionMsP95", 95],
      ]) {
        const expected = nearestRankPercentile(report.measurementsMs, percentile);
        if (report?.[field] !== expected) {
          failures.push(
            `${field} must match the nearest-rank P${percentile} of measurementsMs (${expected}ms)`,
          );
        }
      }
    }
  }
  if (finiteNumber(report?.sampleCount) && report.sampleCount < BETA_REFERENCE_BUDGETS.minimumSamples) {
    failures.push(`sampleCount must be at least ${BETA_REFERENCE_BUDGETS.minimumSamples}`);
  }
  for (const field of ["coldModelPreparationMs", "warmupInferenceMs"]) {
    if (
      finiteNumber(report?.[field]) &&
      report[field] > BETA_REFERENCE_BUDGETS[field]
    ) {
      failures.push(
        `${field} ${report[field]}ms exceeds ${BETA_REFERENCE_BUDGETS[field]}ms`,
      );
    }
  }
  if (
    finiteNumber(report?.transcriptionMsP50) &&
    report.transcriptionMsP50 > BETA_REFERENCE_BUDGETS.transcriptionMsP50
  ) {
    failures.push(
      `transcriptionMsP50 ${report.transcriptionMsP50}ms exceeds ${BETA_REFERENCE_BUDGETS.transcriptionMsP50}ms`,
    );
  }
  if (
    finiteNumber(report?.transcriptionMsP95) &&
    report.transcriptionMsP95 > BETA_REFERENCE_BUDGETS.transcriptionMsP95
  ) {
    failures.push(
      `transcriptionMsP95 ${report.transcriptionMsP95}ms exceeds ${BETA_REFERENCE_BUDGETS.transcriptionMsP95}ms`,
    );
  }

  const hardware = report?.hardware;
  if (!hardware || typeof hardware !== "object") {
    failures.push("hardware context is required");
  } else if (requireReferenceHardware) {
    if (hardware.os !== "macos") failures.push("reference hardware must run macOS");
    if (hardware.arch !== "aarch64") failures.push("reference hardware must be Apple silicon");
    if (
      !finiteNumber(hardware.memoryBytes) ||
      hardware.memoryBytes < BETA_REFERENCE_BUDGETS.minimumMemoryBytes
    ) {
      failures.push("reference hardware must report at least 16 GiB memory");
    }
  }

  for (const field of [
    "generatedAt",
    "provider",
    "model",
    "fixture",
    "fixtureSha256",
    "hostApplication",
  ]) {
    if (typeof report?.[field] !== "string" || !report[field].trim()) {
      failures.push(`${field} is required`);
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    budgets: BETA_REFERENCE_BUDGETS,
  };
}

function valueFor(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && index < args.length - 1 ? args[index + 1] : fallback;
}

function main() {
  const args = process.argv.slice(2);
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const inputPath = path.resolve(
    repoRoot,
    valueFor(args, "--input", "artifacts/qa/dictation-latency.json"),
  );
  if (!fs.existsSync(inputPath)) {
    console.error(
      `Missing dictation latency receipt: ${inputPath}\nRun bun run benchmark:latency -- --provider whisper --model base.en --runs 5 first.`,
    );
    process.exitCode = 1;
    return;
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  } catch (error) {
    console.error(`Could not parse dictation latency receipt: ${error}`);
    process.exitCode = 1;
    return;
  }

  const result = verifyDictationLatencyReport(report, {
    requireReferenceHardware: !args.includes("--allow-non-reference-hardware"),
  });
  console.log(JSON.stringify({ inputPath, ...result }, null, 2));
  process.exitCode = result.pass ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
