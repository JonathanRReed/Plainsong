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

/**
 * Thresholds for the `metricScope: "end_to_end"` receipt (Wave 3): the full
 * post-capture pipeline, not just ASR decode.
 *
 * `formatOffP50Ms: 500` is the number the Wave 3 audit asked for directly:
 * competing dictation tools land the entire pipeline in 130-700ms, and this
 * app had never measured its own end-to-end number at all. 500ms keeps
 * format-off (no formatting stage in the way) comfortably inside that bar.
 *
 * The rest were set from a real local run on the reference machine (see
 * `artifacts/qa/dictation-latency-e2e.json`, committed alongside this gate)
 * with deliberate headroom on top of what was actually measured, since a CI
 * runner or a slower Mac will have more scheduling jitter than a quiet
 * developer machine:
 *   - `formatOffP95Ms: 900` — roughly 2x the measured P95, covering a cold
 *     cache or a noisy-neighbor run without masking a real regression.
 *   - `formatOnP50Ms` / `formatOnP95Ms` are "generous but bounded" per the
 *     spec: format-on only adds the local (non-LLM) smart-format pass in
 *     this benchmark (see `build_end_to_end_report`'s doc comment in
 *     `benchmark-latency.rs` for why the LLM-backed Smart Format pass isn't
 *     driven here), so it should track format-off closely; the wider budget
 *     leaves room for that pass without hiding a real regression.
 * Tightening any of these later should cite a fresh local measurement, the
 * same way this one does.
 */
export const END_TO_END_BUDGETS = Object.freeze({
  minimumSamples: 5,
  formatOffP50Ms: 500,
  formatOffP95Ms: 900,
  formatOnP50Ms: 700,
  formatOnP95Ms: 1_200,
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

function checkReferenceHardware(report, failures, requireReferenceHardware) {
  const hardware = report?.hardware;
  if (!hardware || typeof hardware !== "object") {
    failures.push("hardware context is required");
    return;
  }
  if (!requireReferenceHardware) return;
  if (hardware.os !== "macos") failures.push("reference hardware must run macOS");
  if (hardware.arch !== "aarch64") failures.push("reference hardware must be Apple silicon");
  const minimumMemoryBytes =
    END_TO_END_BUDGETS.minimumMemoryBytes ?? BETA_REFERENCE_BUDGETS.minimumMemoryBytes;
  if (!finiteNumber(hardware.memoryBytes) || hardware.memoryBytes < minimumMemoryBytes) {
    failures.push("reference hardware must report at least 16 GiB memory");
  }
}

function requireNonEmptyStrings(report, failures, fields) {
  for (const field of fields) {
    if (typeof report?.[field] !== "string" || !report[field].trim()) {
      failures.push(`${field} is required`);
    }
  }
}

function verifyProviderTranscriptionOnlyReport(report, { requireReferenceHardware }) {
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

  checkReferenceHardware(report, failures, requireReferenceHardware);
  requireNonEmptyStrings(report, failures, [
    "generatedAt",
    "provider",
    "model",
    "fixture",
    "fixtureSha256",
    "hostApplication",
  ]);

  return { pass: failures.length === 0, failures, budgets: BETA_REFERENCE_BUDGETS };
}

function verifyFormatVariant(report, failures, variantKey, p50Budget, p95Budget, expectedCount) {
  const variant = report?.[variantKey];
  if (!variant || typeof variant !== "object") {
    failures.push(`${variantKey} is required`);
    return;
  }

  if (!Array.isArray(variant.measurementsMs)) {
    failures.push(`${variantKey}.measurementsMs must be an array`);
  } else {
    if (finiteNumber(expectedCount) && variant.measurementsMs.length !== expectedCount) {
      failures.push(`${variantKey}.measurementsMs length must match sampleCount`);
    }
    variant.measurementsMs.forEach((measurement, index) => {
      if (!finiteNumber(measurement) || measurement < 0) {
        failures.push(`${variantKey}.measurementsMs[${index}] must be a finite, non-negative number`);
      }
    });

    const allValid = variant.measurementsMs.every(
      (measurement) => finiteNumber(measurement) && measurement >= 0,
    );
    if (variant.measurementsMs.length > 0 && allValid) {
      for (const [field, percentile] of [
        ["endToEndMsP50", 50],
        ["endToEndMsP95", 95],
      ]) {
        const expected = nearestRankPercentile(variant.measurementsMs, percentile);
        if (variant?.[field] !== expected) {
          failures.push(
            `${variantKey}.${field} must match the nearest-rank P${percentile} of ${variantKey}.measurementsMs (${expected}ms)`,
          );
        }
      }
    }
  }

  if (!finiteNumber(variant.endToEndMsP50)) {
    failures.push(`${variantKey}.endToEndMsP50 must be a finite number`);
  } else if (variant.endToEndMsP50 < 0) {
    failures.push(`${variantKey}.endToEndMsP50 must be non-negative`);
  } else if (variant.endToEndMsP50 > p50Budget) {
    failures.push(`${variantKey}.endToEndMsP50 ${variant.endToEndMsP50}ms exceeds ${p50Budget}ms`);
  }

  if (!finiteNumber(variant.endToEndMsP95)) {
    failures.push(`${variantKey}.endToEndMsP95 must be a finite number`);
  } else if (variant.endToEndMsP95 < 0) {
    failures.push(`${variantKey}.endToEndMsP95 must be non-negative`);
  } else if (variant.endToEndMsP95 > p95Budget) {
    failures.push(`${variantKey}.endToEndMsP95 ${variant.endToEndMsP95}ms exceeds ${p95Budget}ms`);
  }
}

function verifyStageBreakdown(report, failures, expectedCount) {
  const breakdown = report?.stageBreakdownMs;
  if (!breakdown || typeof breakdown !== "object") {
    failures.push("stageBreakdownMs is required");
    return;
  }
  for (const stage of ["asr", "formatOff", "formatOn", "insertionMockOff", "insertionMockOn"]) {
    const stats = breakdown[stage];
    if (!stats || typeof stats !== "object") {
      failures.push(`stageBreakdownMs.${stage} is required`);
      continue;
    }
    if (!Array.isArray(stats.measurementsMs)) {
      failures.push(`stageBreakdownMs.${stage}.measurementsMs must be an array`);
    } else if (finiteNumber(expectedCount) && stats.measurementsMs.length !== expectedCount) {
      failures.push(`stageBreakdownMs.${stage}.measurementsMs length must match sampleCount`);
    }
    if (!finiteNumber(stats.p50) || stats.p50 < 0) {
      failures.push(`stageBreakdownMs.${stage}.p50 must be a finite, non-negative number`);
    }
    if (!finiteNumber(stats.p95) || stats.p95 < 0) {
      failures.push(`stageBreakdownMs.${stage}.p95 must be a finite, non-negative number`);
    }
  }
}

function verifyEndToEndReport(report, { requireReferenceHardware }) {
  const failures = [];
  const requireEqual = (field, expected) => {
    if (report?.[field] !== expected) {
      failures.push(`${field} must be ${JSON.stringify(expected)}`);
    }
  };

  requireEqual("schemaVersion", 1);
  requireEqual("thresholdProfile", "beta-reference-v1");
  requireEqual("metricScope", "end_to_end");
  requireEqual("warmState", "warm");

  if (!finiteNumber(report?.sampleCount)) {
    failures.push("sampleCount must be a finite number");
  } else if (report.sampleCount < END_TO_END_BUDGETS.minimumSamples) {
    failures.push(`sampleCount must be at least ${END_TO_END_BUDGETS.minimumSamples}`);
  }

  const expectedCount = finiteNumber(report?.sampleCount) ? report.sampleCount : undefined;
  verifyFormatVariant(
    report,
    failures,
    "formatOff",
    END_TO_END_BUDGETS.formatOffP50Ms,
    END_TO_END_BUDGETS.formatOffP95Ms,
    expectedCount,
  );
  verifyFormatVariant(
    report,
    failures,
    "formatOn",
    END_TO_END_BUDGETS.formatOnP50Ms,
    END_TO_END_BUDGETS.formatOnP95Ms,
    expectedCount,
  );
  verifyStageBreakdown(report, failures, expectedCount);

  if (typeof report?.insertionStrategy !== "string" || !report.insertionStrategy.trim()) {
    failures.push("insertionStrategy is required (this receipt mocks insertion; say how)");
  }

  checkReferenceHardware(report, failures, requireReferenceHardware);
  requireNonEmptyStrings(report, failures, [
    "generatedAt",
    "provider",
    "model",
    "fixture",
    "fixtureSha256",
    "hostApplication",
  ]);

  return { pass: failures.length === 0, failures, budgets: END_TO_END_BUDGETS };
}

const KNOWN_METRIC_SCOPES = new Set(["provider_transcription_only", "end_to_end"]);

export function verifyDictationLatencyReport(
  report,
  { requireReferenceHardware = true } = {},
) {
  const metricScope = report?.metricScope;
  if (metricScope === "end_to_end") {
    return verifyEndToEndReport(report, { requireReferenceHardware });
  }
  if (metricScope === "provider_transcription_only") {
    return verifyProviderTranscriptionOnlyReport(report, { requireReferenceHardware });
  }
  return {
    pass: false,
    failures: [
      `metricScope must be one of ${[...KNOWN_METRIC_SCOPES].join(", ")}, got ${JSON.stringify(metricScope)}`,
    ],
    budgets: null,
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
