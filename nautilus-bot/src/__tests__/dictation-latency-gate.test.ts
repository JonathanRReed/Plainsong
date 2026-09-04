import { describe, expect, it } from "vitest";
import {
  BETA_REFERENCE_BUDGETS,
  PIPELINE_BUDGETS,
  verifyDictationLatencyReport,
} from "../../scripts/verify-dictation-latency.mjs";

function validReport(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    benchmarkVersion: "0.9.0-beta.2",
    generatedAt: "2026-08-08T12:00:00Z",
    thresholdProfile: "beta-reference-v1",
    metricScope: "provider_transcription_only",
    hostApplication: "benchmark-cli",
    warmState: "warm",
    hardware: {
      os: "macos",
      arch: "aarch64",
      logicalCpus: 12,
      cpuModel: "Apple M4 Pro",
      memoryBytes: 24 * 1024 * 1024 * 1024,
    },
    provider: "whisper",
    model: "base.en",
    fixture: "scripts/fixtures/local-quality-gate.wav",
    fixtureSha256: "a".repeat(64),
    fixtureBytes: 42,
    audioSeconds: 5.3,
    coldModelPreparationMs: 430,
    warmupInferenceMs: 110,
    runs: 5,
    sampleCount: 5,
    measurementsMs: [90, 95, 100, 105, 110],
    transcriptionMsP50: 100,
    transcriptionMsP95: 110,
    ...overrides,
  };
}

function validFixtureReport(overrides: Record<string, unknown> = {}) {
  return {
    fixture: "scripts/fixtures/local-quality-gate.wav",
    fixtureSha256: "a".repeat(64),
    fixtureBytes: 42,
    audioSeconds: 5.32,
    runs: 5,
    sampleCount: 5,
    stageBreakdownMs: {
      asr: { measurementsMs: [85, 90, 95, 100, 105], p50: 95, p95: 105 },
      formatOff: { measurementsMs: [0, 0, 0, 0, 0], p50: 0, p95: 0 },
      formatOn: { measurementsMs: [3, 3, 3, 3, 3], p50: 3, p95: 3 },
      insertionMockOff: { measurementsMs: [0, 0, 0, 0, 0], p50: 0, p95: 0 },
      insertionMockOn: { measurementsMs: [0, 0, 0, 0, 0], p50: 0, p95: 0 },
    },
    formatOff: {
      measurementsMs: [85, 90, 95, 100, 105],
      pipelineMsP50: 95,
      pipelineMsP95: 105,
    },
    formatOn: {
      measurementsMs: [88, 93, 98, 103, 108],
      pipelineMsP50: 98,
      pipelineMsP95: 108,
    },
    ...overrides,
  };
}

function validSecondaryLongFormReport(overrides: Record<string, unknown> = {}) {
  // Deliberately shaped like the real 44s fixture: numbers that would fail
  // primary's budget outright, proving secondaryLongForm is reported but
  // never threshold-gated.
  return validFixtureReport({
    fixture: "scripts/fixtures/real-speech-44s.wav",
    audioSeconds: 43.97,
    stageBreakdownMs: {
      asr: { measurementsMs: [480, 485, 490, 495, 500], p50: 490, p95: 500 },
      formatOff: { measurementsMs: [0, 0, 0, 0, 0], p50: 0, p95: 0 },
      formatOn: { measurementsMs: [3, 3, 3, 3, 3], p50: 3, p95: 3 },
      insertionMockOff: { measurementsMs: [0, 0, 0, 0, 0], p50: 0, p95: 0 },
      insertionMockOn: { measurementsMs: [0, 0, 0, 0, 0], p50: 0, p95: 0 },
    },
    formatOff: {
      measurementsMs: [480, 485, 490, 495, 500],
      pipelineMsP50: 490,
      pipelineMsP95: 500,
    },
    formatOn: {
      measurementsMs: [483, 488, 493, 498, 503],
      pipelineMsP50: 493,
      pipelineMsP95: 503,
    },
    ...overrides,
  });
}

function validPipelineReport(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    benchmarkVersion: "0.9.0-beta.2",
    generatedAt: "2026-08-27T12:00:00Z",
    thresholdProfile: "beta-reference-v1",
    metricScope: "asr_and_local_format_only",
    hostApplication: "benchmark-cli",
    warmState: "warm",
    hardware: {
      os: "macos",
      arch: "aarch64",
      logicalCpus: 12,
      cpuModel: "Apple M4 Pro",
      memoryBytes: 24 * 1024 * 1024 * 1024,
    },
    provider: "whisper",
    model: "base.en",
    percentileBasis: "5 repeats of one fixture",
    insertionMocked: true,
    insertionStrategy: "mocked-in-memory-copy",
    insertionStrategyNote: "mock note",
    formatOnScopeNote: "scope note",
    captureTailExcludedMs: 120,
    captureTailExcludedNote: "tail note",
    primary: validFixtureReport(),
    secondaryLongForm: validSecondaryLongFormReport(),
    ...overrides,
  };
}

describe("dictation latency beta gate", () => {
  it("publishes explicit beta budgets for cold model preparation and warmup", () => {
    expect(BETA_REFERENCE_BUDGETS).toMatchObject({
      coldModelPreparationMs: 8_000,
      warmupInferenceMs: 1_000,
    });
  });

  it("accepts a complete warm reference-tier report within budget", () => {
    expect(verifyDictationLatencyReport(validReport())).toMatchObject({
      pass: true,
      failures: [],
    });
  });

  it("fails cold preparation, warmup, p50, p95, and sample-count regressions", () => {
    const result = verifyDictationLatencyReport(
      validReport({
        coldModelPreparationMs: BETA_REFERENCE_BUDGETS.coldModelPreparationMs + 1,
        warmupInferenceMs: BETA_REFERENCE_BUDGETS.warmupInferenceMs + 1,
        sampleCount: 4,
        measurementsMs: [1_300, 1_400, 1_800, 2_100],
        transcriptionMsP50: BETA_REFERENCE_BUDGETS.transcriptionMsP50 + 1,
        transcriptionMsP95: BETA_REFERENCE_BUDGETS.transcriptionMsP95 + 1,
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain("coldModelPreparationMs");
    expect(result.failures.join(" ")).toContain("warmupInferenceMs");
    expect(result.failures.join(" ")).toContain("sampleCount must be at least 5");
    expect(result.failures.join(" ")).toContain("transcriptionMsP50");
    expect(result.failures.join(" ")).toContain("transcriptionMsP95");
  });

  it("rejects a cold sample masquerading as a warm benchmark", () => {
    const result = verifyDictationLatencyReport(
      validReport({ warmState: "cold" }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures).toContain('warmState must be "warm"');
  });

  it("requires the supported Apple silicon reference tier by default", () => {
    const result = verifyDictationLatencyReport(
      validReport({
        hardware: {
          os: "linux",
          arch: "x86_64",
          logicalCpus: 8,
          memoryBytes: 8 * 1024 * 1024 * 1024,
        },
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain("Apple silicon");
    expect(result.failures.join(" ")).toContain("16 GiB");
  });

  it("rejects negative and non-numeric timing samples", () => {
    const result = verifyDictationLatencyReport(
      validReport({
        coldModelPreparationMs: -1,
        warmupInferenceMs: -1,
        measurementsMs: [90, "bad", 100, null, 110],
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain("coldModelPreparationMs must be non-negative");
    expect(result.failures.join(" ")).toContain("warmupInferenceMs must be non-negative");
    expect(result.failures.join(" ")).toContain("measurementsMs[1]");
    expect(result.failures.join(" ")).toContain("measurementsMs[3]");
  });

  it("rejects summary percentiles that do not match the raw samples", () => {
    const result = verifyDictationLatencyReport(
      validReport({
        transcriptionMsP50: 99,
        transcriptionMsP95: 109,
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures).toContain(
      "transcriptionMsP50 must match the nearest-rank P50 of measurementsMs (100ms)",
    );
    expect(result.failures).toContain(
      "transcriptionMsP95 must match the nearest-rank P95 of measurementsMs (110ms)",
    );
  });

  it("rejects a report with no recognizable metricScope", () => {
    const missing = verifyDictationLatencyReport(validReport({ metricScope: undefined }));
    expect(missing.pass).toBe(false);
    expect(missing.failures.join(" ")).toContain("metricScope must be one of");

    const unknown = verifyDictationLatencyReport(validReport({ metricScope: "made_up_scope" }));
    expect(unknown.pass).toBe(false);
    expect(unknown.failures.join(" ")).toContain("made_up_scope");

    // The pre-Wave-3 "end_to_end" name was renamed for honesty and never had
    // a committed receipt to stay compatible with -- it must not be silently
    // accepted as an alias.
    const stale = verifyDictationLatencyReport(validReport({ metricScope: "end_to_end" }));
    expect(stale.pass).toBe(false);
    expect(stale.failures.join(" ")).toContain("end_to_end");
  });
});

describe("dictation latency pipeline gate (Wave 3, asr_and_local_format_only)", () => {
  it("publishes explicit, documented pipeline budgets with real headroom", () => {
    expect(PIPELINE_BUDGETS).toMatchObject({
      minimumSamples: 5,
      formatOffP50Ms: 250,
      formatOffP95Ms: 350,
      formatOnP50Ms: 300,
      formatOnP95Ms: 400,
    });
    expect(PIPELINE_BUDGETS.formatOffP95Ms).toBeGreaterThan(PIPELINE_BUDGETS.formatOffP50Ms);
    expect(PIPELINE_BUDGETS.formatOnP50Ms).toBeGreaterThanOrEqual(PIPELINE_BUDGETS.formatOffP50Ms);
    expect(PIPELINE_BUDGETS.formatOnP95Ms).toBeGreaterThan(PIPELINE_BUDGETS.formatOnP50Ms);
  });

  it("accepts a complete, in-budget pipeline report", () => {
    expect(verifyDictationLatencyReport(validPipelineReport())).toMatchObject({
      pass: true,
      failures: [],
    });
  });

  it("keeps the old provider_transcription_only scope valid so gate history doesn't break", () => {
    // A receipt shaped like the pre-Wave-3 gate must still pass unchanged --
    // this is the whole point of adding a scope rather than replacing one.
    expect(
      verifyDictationLatencyReport({
        schemaVersion: 1,
        thresholdProfile: "beta-reference-v1",
        metricScope: "provider_transcription_only",
        warmState: "warm",
        hardware: {
          os: "macos",
          arch: "aarch64",
          memoryBytes: 24 * 1024 * 1024 * 1024,
        },
        provider: "whisper",
        model: "base.en",
        fixture: "scripts/fixtures/local-quality-gate.wav",
        fixtureSha256: "a".repeat(64),
        hostApplication: "benchmark-cli",
        generatedAt: "2026-08-27T12:00:00Z",
        coldModelPreparationMs: 400,
        warmupInferenceMs: 100,
        sampleCount: 5,
        measurementsMs: [90, 95, 100, 105, 110],
        transcriptionMsP50: 100,
        transcriptionMsP95: 110,
      }),
    ).toMatchObject({ pass: true, failures: [] });
  });

  it("rejects primary format-off regressions past its budget", () => {
    const result = verifyDictationLatencyReport(
      validPipelineReport({
        primary: validFixtureReport({
          formatOff: {
            measurementsMs: [251, 260, 270, 280, 360],
            pipelineMsP50: 270,
            pipelineMsP95: 360,
          },
        }),
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain(
      `primary.formatOff.pipelineMsP50 270ms exceeds ${PIPELINE_BUDGETS.formatOffP50Ms}ms`,
    );
    expect(result.failures.join(" ")).toContain(
      `primary.formatOff.pipelineMsP95 360ms exceeds ${PIPELINE_BUDGETS.formatOffP95Ms}ms`,
    );
  });

  it("rejects primary format-on regressions past its generous-but-bounded budget", () => {
    const result = verifyDictationLatencyReport(
      validPipelineReport({
        primary: validFixtureReport({
          formatOn: {
            measurementsMs: [301, 310, 320, 330, 410],
            pipelineMsP50: 320,
            pipelineMsP95: 410,
          },
        }),
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain(
      `primary.formatOn.pipelineMsP50 320ms exceeds ${PIPELINE_BUDGETS.formatOnP50Ms}ms`,
    );
    expect(result.failures.join(" ")).toContain(
      `primary.formatOn.pipelineMsP95 410ms exceeds ${PIPELINE_BUDGETS.formatOnP95Ms}ms`,
    );
  });

  it("never gates secondaryLongForm against primary's thresholds", () => {
    // validPipelineReport()'s default secondaryLongForm already carries
    // ~490-503ms numbers, which would fail primary's 250/350/300/400ms
    // budgets outright if gated. It must still pass, because long-form is
    // informational only.
    const result = verifyDictationLatencyReport(validPipelineReport());
    expect(result.pass).toBe(true);
    expect(result.failures).not.toContain(
      expect.stringContaining("secondaryLongForm.formatOff.pipelineMsP50"),
    );
  });

  it("rejects a sample count below the floor on either fixture", () => {
    const result = verifyDictationLatencyReport(
      validPipelineReport({
        primary: validFixtureReport({
          sampleCount: 4,
          formatOff: { measurementsMs: [85, 90, 95, 100], pipelineMsP50: 93, pipelineMsP95: 100 },
          formatOn: { measurementsMs: [88, 93, 98, 103], pipelineMsP50: 96, pipelineMsP95: 103 },
        }),
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain(
      `primary.sampleCount must be at least ${PIPELINE_BUDGETS.minimumSamples}`,
    );
  });

  it("rejects a missing primary or secondaryLongForm section", () => {
    const missingPrimary = validPipelineReport();
    delete (missingPrimary as Record<string, unknown>).primary;
    const primaryResult = verifyDictationLatencyReport(missingPrimary);
    expect(primaryResult.pass).toBe(false);
    expect(primaryResult.failures).toContain("primary is required");

    const missingSecondary = validPipelineReport();
    delete (missingSecondary as Record<string, unknown>).secondaryLongForm;
    const secondaryResult = verifyDictationLatencyReport(missingSecondary);
    expect(secondaryResult.pass).toBe(false);
    expect(secondaryResult.failures).toContain("secondaryLongForm is required");
  });

  it("rejects a missing formatOn/formatOff section on primary", () => {
    const missingFormatOn = validPipelineReport({
      primary: (() => {
        const fixture = validFixtureReport() as Record<string, unknown>;
        delete fixture.formatOn;
        return fixture;
      })(),
    });
    const result = verifyDictationLatencyReport(missingFormatOn);
    expect(result.pass).toBe(false);
    expect(result.failures).toContain("primary.formatOn is required");
  });

  it("rejects a stage breakdown missing a stage or reporting mismatched sample counts", () => {
    const breakdown = { ...validFixtureReport().stageBreakdownMs } as Record<string, unknown>;
    delete breakdown.insertionMockOn;
    const missingStageResult = verifyDictationLatencyReport(
      validPipelineReport({ primary: validFixtureReport({ stageBreakdownMs: breakdown }) }),
    );
    expect(missingStageResult.pass).toBe(false);
    expect(missingStageResult.failures).toContain("primary.stageBreakdownMs.insertionMockOn is required");

    const mismatched = verifyDictationLatencyReport(
      validPipelineReport({
        primary: validFixtureReport({
          stageBreakdownMs: {
            ...validFixtureReport().stageBreakdownMs,
            asr: { measurementsMs: [85, 90, 95], p50: 90, p95: 95 },
          },
        }),
      }),
    );
    expect(mismatched.pass).toBe(false);
    expect(mismatched.failures).toContain(
      "primary.stageBreakdownMs.asr.measurementsMs length must match sampleCount",
    );
  });

  it("rejects invalid stage samples and percentiles that do not match them", () => {
    const invalidSamples = verifyDictationLatencyReport(
      validPipelineReport({
        primary: validFixtureReport({
          stageBreakdownMs: {
            ...validFixtureReport().stageBreakdownMs,
            asr: { measurementsMs: [85, "bad", 95, -1, 105], p50: 95, p95: 105 },
          },
        }),
      }),
    );
    expect(invalidSamples.pass).toBe(false);
    expect(invalidSamples.failures).toContain(
      "primary.stageBreakdownMs.asr.measurementsMs[1] must be a finite, non-negative number",
    );
    expect(invalidSamples.failures).toContain(
      "primary.stageBreakdownMs.asr.measurementsMs[3] must be a finite, non-negative number",
    );

    const forgedPercentiles = verifyDictationLatencyReport(
      validPipelineReport({
        primary: validFixtureReport({
          stageBreakdownMs: {
            ...validFixtureReport().stageBreakdownMs,
            asr: { measurementsMs: [100, 200, 300, 400, 500], p50: 0, p95: 0 },
          },
        }),
      }),
    );
    expect(forgedPercentiles.pass).toBe(false);
    expect(forgedPercentiles.failures).toContain(
      "primary.stageBreakdownMs.asr.p50 must match the nearest-rank P50 of primary.stageBreakdownMs.asr.measurementsMs (300ms)",
    );
    expect(forgedPercentiles.failures).toContain(
      "primary.stageBreakdownMs.asr.p95 must match the nearest-rank P95 of primary.stageBreakdownMs.asr.measurementsMs (500ms)",
    );
  });

  it("requires a non-empty insertionStrategy label since insertion is mocked", () => {
    const result = verifyDictationLatencyReport(
      validPipelineReport({ insertionStrategy: "" }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures).toContain(
      "insertionStrategy is required (this receipt mocks insertion; say how)",
    );
  });

  it("requires a non-empty formatOnScopeNote", () => {
    const result = verifyDictationLatencyReport(
      validPipelineReport({ formatOnScopeNote: "" }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures).toContain(
      "formatOnScopeNote is required (formatOn measures only the local pass; say so explicitly)",
    );
  });

  it("requires captureTailExcludedMs and percentileBasis", () => {
    const missingTail = verifyDictationLatencyReport(
      validPipelineReport({ captureTailExcludedMs: undefined }),
    );
    expect(missingTail.pass).toBe(false);
    expect(missingTail.failures).toContain("captureTailExcludedMs must be a finite, non-negative number");

    const missingBasis = verifyDictationLatencyReport(
      validPipelineReport({ percentileBasis: "" }),
    );
    expect(missingBasis.pass).toBe(false);
    expect(missingBasis.failures).toContain("percentileBasis is required");
  });

  it("requires insertionMocked to be exactly true", () => {
    const result = verifyDictationLatencyReport(
      validPipelineReport({ insertionMocked: false }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures).toContain("insertionMocked must be true");
  });

  it("requires insertionStrategy to admit it is a mock whenever an insertion stage measures 0ms P95", () => {
    // validFixtureReport()'s insertion stages are always 0ms/0ms (a real
    // mock's honest floor) -- claiming a non-mock strategy over that shape
    // must fail.
    const result = verifyDictationLatencyReport(
      validPipelineReport({ insertionStrategy: "native-accessibility-write" }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain("only plausible for a mock");
  });

  it("rejects negative and non-numeric pipeline measurements", () => {
    const result = verifyDictationLatencyReport(
      validPipelineReport({
        primary: validFixtureReport({
          formatOff: {
            measurementsMs: [85, "bad", 95, null, 105],
            pipelineMsP50: 95,
            pipelineMsP95: 105,
          },
        }),
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain("primary.formatOff.measurementsMs[1]");
    expect(result.failures.join(" ")).toContain("primary.formatOff.measurementsMs[3]");
  });

  it("requires the supported Apple silicon reference tier by default", () => {
    const result = verifyDictationLatencyReport(
      validPipelineReport({
        hardware: {
          os: "linux",
          arch: "x86_64",
          memoryBytes: 8 * 1024 * 1024 * 1024,
        },
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain("Apple silicon");
    expect(result.failures.join(" ")).toContain("16 GiB");
  });

  it("allows non-reference hardware when explicitly requested", () => {
    const result = verifyDictationLatencyReport(
      validPipelineReport({
        hardware: { os: "linux", arch: "x86_64", memoryBytes: 8 * 1024 * 1024 * 1024 },
      }),
      { requireReferenceHardware: false },
    );
    expect(result.pass).toBe(true);
  });
});
