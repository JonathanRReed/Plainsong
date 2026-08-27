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
 * Thresholds for the `metricScope: "asr_and_local_format_only"` receipt
 * (Wave 3), applied ONLY to the receipt's `primary` fixture -- a single
 * short utterance, the regime the audit's 130-700ms competitor bar is
 * actually about. `secondaryLongForm` (a ~44s clip, kept for comparison) is
 * validated structurally but never threshold-gated: ASR decode time scales
 * with audio length, so a long clip's pipeline time is dominated by that
 * scaling, not by anything a latency budget should police.
 *
 * IMPORTANT SCOPE NOTE, repeated here because it changes what these numbers
 * mean: this receipt's clock starts at `transcribe_bytes` with audio already
 * in memory. It does NOT include the stop gesture (hotkey release), the
 * Electron-to-sidecar IPC hop, audio finalization, the real (not mocked)
 * insertion path, or the 120ms `DICTATION_STOP_CAPTURE_TAIL_MS` wait the
 * real stop handler awaits before its own clock starts (`captureTailExcludedMs`
 * on the receipt). None of that is a small slice: the capture tail alone is
 * 120ms, and none of it is measured anywhere else in an automated way yet
 * either -- the runtime `DictationTimingRecord` (dictation_timing.rs)
 * captures the real, full-session number per live dictation instead, logged
 * but not currently receipted. Do not read a pass here as "the user feels
 * this fast"; read it as "ASR plus the local pipeline stayed within budget,"
 * a real and useful thing to gate, just a narrower one than "end to end."
 *
 * Real local measurement (Apple M4 Pro, 10 runs, whisper base.en,
 * `scripts/fixtures/local-quality-gate.wav`, ~5.3s of speech -- see the
 * benchmark output in the PR/commit that introduced this threshold since the
 * receipt itself is gitignored and never committed):
 *   formatOff: P50 91ms / P95 128ms
 *   formatOn (local smart-format only, see below): P50 96ms / P95 131ms
 *
 * Thresholds below give roughly 2.7-3x headroom over those measurements --
 * enough to absorb a slower reference Mac (the hardware gate only requires
 * Apple silicon with 16GiB+ RAM, not a specific chip) or a noisy run,
 * without inflating the bar so far that it stops catching real regressions.
 * `formatOnP50Ms`/`formatOnP95Ms` get a little more room than formatOff's
 * per the "generous but bounded" brief, since format-on adds a real (if
 * small) local-formatting cost on top: format-on measures only the
 * deterministic local smart-formatting pass (`text::format`), not the
 * optional LLM-backed Smart Format pass, which calls a live model/provider
 * behind `dictation_format_timeout` (`lib.rs`) and cannot be driven safely
 * or deterministically from a headless benchmark -- its real timing and
 * timeout rate are captured by the runtime timing record instead.
 *
 * Tightening any of these later should cite a fresh local measurement, the
 * same way this one does.
 */
export const PIPELINE_BUDGETS = Object.freeze({
  minimumSamples: 5,
  formatOffP50Ms: 250,
  formatOffP95Ms: 350,
  formatOnP50Ms: 300,
  formatOnP95Ms: 400,
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
    PIPELINE_BUDGETS.minimumMemoryBytes ?? BETA_REFERENCE_BUDGETS.minimumMemoryBytes;
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

function verifyFormatVariant(prefix, variant, failures, p50Budget, p95Budget, expectedCount) {
  if (!variant || typeof variant !== "object") {
    failures.push(`${prefix} is required`);
    return;
  }

  if (!Array.isArray(variant.measurementsMs)) {
    failures.push(`${prefix}.measurementsMs must be an array`);
  } else {
    if (finiteNumber(expectedCount) && variant.measurementsMs.length !== expectedCount) {
      failures.push(`${prefix}.measurementsMs length must match sampleCount`);
    }
    variant.measurementsMs.forEach((measurement, index) => {
      if (!finiteNumber(measurement) || measurement < 0) {
        failures.push(`${prefix}.measurementsMs[${index}] must be a finite, non-negative number`);
      }
    });

    const allValid = variant.measurementsMs.every(
      (measurement) => finiteNumber(measurement) && measurement >= 0,
    );
    if (variant.measurementsMs.length > 0 && allValid) {
      for (const [field, percentile] of [
        ["pipelineMsP50", 50],
        ["pipelineMsP95", 95],
      ]) {
        const expected = nearestRankPercentile(variant.measurementsMs, percentile);
        if (variant?.[field] !== expected) {
          failures.push(
            `${prefix}.${field} must match the nearest-rank P${percentile} of ${prefix}.measurementsMs (${expected}ms)`,
          );
        }
      }
    }
  }

  const checkBudget = (field, budget) => {
    if (budget === null) return; // informational only (secondaryLongForm): no ceiling enforced
    if (!finiteNumber(variant?.[field])) {
      failures.push(`${prefix}.${field} must be a finite number`);
    } else if (variant[field] < 0) {
      failures.push(`${prefix}.${field} must be non-negative`);
    } else if (variant[field] > budget) {
      failures.push(`${prefix}.${field} ${variant[field]}ms exceeds ${budget}ms`);
    }
  };
  checkBudget("pipelineMsP50", p50Budget);
  checkBudget("pipelineMsP95", p95Budget);
}

function verifyStageBreakdown(prefix, breakdown, failures, expectedCount) {
  if (!breakdown || typeof breakdown !== "object") {
    failures.push(`${prefix}.stageBreakdownMs is required`);
    return;
  }
  for (const stage of ["asr", "formatOff", "formatOn", "insertionMockOff", "insertionMockOn"]) {
    const stats = breakdown[stage];
    if (!stats || typeof stats !== "object") {
      failures.push(`${prefix}.stageBreakdownMs.${stage} is required`);
      continue;
    }
    if (!Array.isArray(stats.measurementsMs)) {
      failures.push(`${prefix}.stageBreakdownMs.${stage}.measurementsMs must be an array`);
    } else if (finiteNumber(expectedCount) && stats.measurementsMs.length !== expectedCount) {
      failures.push(`${prefix}.stageBreakdownMs.${stage}.measurementsMs length must match sampleCount`);
    }
    if (!finiteNumber(stats.p50) || stats.p50 < 0) {
      failures.push(`${prefix}.stageBreakdownMs.${stage}.p50 must be a finite, non-negative number`);
    }
    if (!finiteNumber(stats.p95) || stats.p95 < 0) {
      failures.push(`${prefix}.stageBreakdownMs.${stage}.p95 must be a finite, non-negative number`);
    }
  }
}

/**
 * Any insertion stage reporting P95 0ms is, by construction, a mock or a
 * stub -- real system insertion (a paste dispatch, an Accessibility write, a
 * clipboard copy shelling out to `pbcopy`) never costs literally zero
 * milliseconds. A receipt in that shape must say so plainly in
 * `insertionStrategy`, so a reader can never mistake a near-instant mock for
 * a real, fast insertion measurement.
 */
function verifyInsertionStrategyHonesty(prefix, fixtureReport, insertionStrategy, failures) {
  const breakdown = fixtureReport?.stageBreakdownMs;
  const zeroP95 =
    finiteNumber(breakdown?.insertionMockOff?.p95) && breakdown.insertionMockOff.p95 === 0
      ? "insertionMockOff"
      : finiteNumber(breakdown?.insertionMockOn?.p95) && breakdown.insertionMockOn.p95 === 0
        ? "insertionMockOn"
        : null;
  if (zeroP95 && !/mock/i.test(String(insertionStrategy ?? ""))) {
    failures.push(
      `${prefix}.stageBreakdownMs.${zeroP95}.p95 is 0ms, which is only plausible for a mock -- insertionStrategy must say so (match /mock/i)`,
    );
  }
}

function verifyFixtureReport(prefix, fixtureReport, failures, budgets) {
  if (!fixtureReport || typeof fixtureReport !== "object") {
    failures.push(`${prefix} is required`);
    return;
  }
  if (!finiteNumber(fixtureReport.sampleCount)) {
    failures.push(`${prefix}.sampleCount must be a finite number`);
  } else if (fixtureReport.sampleCount < PIPELINE_BUDGETS.minimumSamples) {
    failures.push(`${prefix}.sampleCount must be at least ${PIPELINE_BUDGETS.minimumSamples}`);
  }
  const expectedCount = finiteNumber(fixtureReport.sampleCount) ? fixtureReport.sampleCount : undefined;

  // `budgets` is `null` for a fixture that is reported but never
  // threshold-gated (secondaryLongForm): each variant still gets shape and
  // percentile-consistency checks, just no ceiling.
  verifyFormatVariant(
    `${prefix}.formatOff`,
    fixtureReport.formatOff,
    failures,
    budgets?.formatOffP50Ms ?? null,
    budgets?.formatOffP95Ms ?? null,
    expectedCount,
  );
  verifyFormatVariant(
    `${prefix}.formatOn`,
    fixtureReport.formatOn,
    failures,
    budgets?.formatOnP50Ms ?? null,
    budgets?.formatOnP95Ms ?? null,
    expectedCount,
  );
  verifyStageBreakdown(prefix, fixtureReport.stageBreakdownMs, failures, expectedCount);

  requireNonEmptyStrings(fixtureReport, failures, ["fixture", "fixtureSha256"]);
}

function verifyPipelineReport(report, { requireReferenceHardware }) {
  const failures = [];
  const requireEqual = (field, expected) => {
    if (report?.[field] !== expected) {
      failures.push(`${field} must be ${JSON.stringify(expected)}`);
    }
  };

  requireEqual("schemaVersion", 1);
  requireEqual("thresholdProfile", "beta-reference-v1");
  requireEqual("metricScope", "asr_and_local_format_only");
  requireEqual("warmState", "warm");
  requireEqual("insertionMocked", true);

  verifyFixtureReport("primary", report?.primary, failures, PIPELINE_BUDGETS);
  // secondaryLongForm is structurally validated but never threshold-gated:
  // ASR decode time scales with audio length, so its pipeline time is
  // dominated by that scaling, not by anything a latency budget should
  // police. `null` means "check the field exists and is sane, enforce no
  // ceiling."
  verifyFixtureReport("secondaryLongForm", report?.secondaryLongForm, failures, null);

  if (typeof report?.insertionStrategy !== "string" || !report.insertionStrategy.trim()) {
    failures.push("insertionStrategy is required (this receipt mocks insertion; say how)");
  }
  if (typeof report?.formatOnScopeNote !== "string" || !report.formatOnScopeNote.trim()) {
    failures.push(
      "formatOnScopeNote is required (formatOn measures only the local pass; say so explicitly)",
    );
  }
  if (!finiteNumber(report?.captureTailExcludedMs) || report.captureTailExcludedMs < 0) {
    failures.push("captureTailExcludedMs must be a finite, non-negative number");
  }
  if (typeof report?.percentileBasis !== "string" || !report.percentileBasis.trim()) {
    failures.push("percentileBasis is required");
  }

  verifyInsertionStrategyHonesty("primary", report?.primary, report?.insertionStrategy, failures);
  verifyInsertionStrategyHonesty("secondaryLongForm", report?.secondaryLongForm, report?.insertionStrategy, failures);

  checkReferenceHardware(report, failures, requireReferenceHardware);
  requireNonEmptyStrings(report, failures, [
    "generatedAt",
    "provider",
    "model",
    "hostApplication",
  ]);

  return { pass: failures.length === 0, failures, budgets: PIPELINE_BUDGETS };
}

const KNOWN_METRIC_SCOPES = new Set(["provider_transcription_only", "asr_and_local_format_only"]);

export function verifyDictationLatencyReport(
  report,
  { requireReferenceHardware = true } = {},
) {
  const metricScope = report?.metricScope;
  if (metricScope === "asr_and_local_format_only") {
    return verifyPipelineReport(report, { requireReferenceHardware });
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
