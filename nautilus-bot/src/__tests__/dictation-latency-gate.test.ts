import { describe, expect, it } from "vitest";
import {
  BETA_REFERENCE_BUDGETS,
  END_TO_END_BUDGETS,
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
    fixture: "/tmp/fixture.wav",
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

function validEndToEndReport(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    benchmarkVersion: "0.9.0-beta.2",
    generatedAt: "2026-08-27T12:00:00Z",
    thresholdProfile: "beta-reference-v1",
    metricScope: "end_to_end",
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
    fixture: "/tmp/fixture.wav",
    fixtureSha256: "a".repeat(64),
    fixtureBytes: 42,
    audioSeconds: 5.3,
    runs: 5,
    sampleCount: 5,
    insertionStrategy: "mocked-in-memory-copy",
    insertionStrategyNote: "mock note",
    formatOnScopeNote: "scope note",
    stageBreakdownMs: {
      asr: { measurementsMs: [80, 85, 90, 95, 100], p50: 90, p95: 100 },
      formatOff: { measurementsMs: [0, 0, 1, 0, 1], p50: 1, p95: 1 },
      formatOn: { measurementsMs: [1, 1, 2, 1, 2], p50: 2, p95: 2 },
      insertionMockOff: { measurementsMs: [0, 0, 0, 0, 1], p50: 0, p95: 1 },
      insertionMockOn: { measurementsMs: [0, 0, 0, 0, 1], p50: 0, p95: 1 },
    },
    formatOff: {
      measurementsMs: [81, 86, 92, 96, 102],
      endToEndMsP50: 92,
      endToEndMsP95: 102,
    },
    formatOn: {
      measurementsMs: [83, 88, 95, 99, 106],
      endToEndMsP50: 95,
      endToEndMsP95: 106,
    },
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
  });
});

describe("dictation latency end-to-end gate (Wave 3)", () => {
  it("publishes explicit, documented end-to-end budgets", () => {
    expect(END_TO_END_BUDGETS).toMatchObject({
      minimumSamples: 5,
      formatOffP50Ms: 500,
    });
    // format-off must stay under the 500ms bar the audit measured competing
    // tools against; format-on is allowed a generous but still-bounded
    // premium on top of it.
    expect(END_TO_END_BUDGETS.formatOffP95Ms).toBeGreaterThan(END_TO_END_BUDGETS.formatOffP50Ms);
    expect(END_TO_END_BUDGETS.formatOnP50Ms).toBeGreaterThanOrEqual(END_TO_END_BUDGETS.formatOffP50Ms);
    expect(END_TO_END_BUDGETS.formatOnP95Ms).toBeGreaterThan(END_TO_END_BUDGETS.formatOnP50Ms);
  });

  it("accepts a complete, in-budget end-to-end report", () => {
    expect(verifyDictationLatencyReport(validEndToEndReport())).toMatchObject({
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
        fixture: "/tmp/fixture.wav",
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

  it("rejects format-off end-to-end regressions past the 500ms/900ms bars", () => {
    const result = verifyDictationLatencyReport(
      validEndToEndReport({
        formatOff: {
          measurementsMs: [501, 600, 700, 800, 950],
          endToEndMsP50: 700,
          endToEndMsP95: 950,
        },
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain(
      `formatOff.endToEndMsP50 700ms exceeds ${END_TO_END_BUDGETS.formatOffP50Ms}ms`,
    );
    expect(result.failures.join(" ")).toContain(
      `formatOff.endToEndMsP95 950ms exceeds ${END_TO_END_BUDGETS.formatOffP95Ms}ms`,
    );
  });

  it("rejects format-on end-to-end regressions past its generous-but-bounded bars", () => {
    const result = verifyDictationLatencyReport(
      validEndToEndReport({
        formatOn: {
          measurementsMs: [701, 800, 900, 1_100, 1_300],
          endToEndMsP50: 900,
          endToEndMsP95: 1_300,
        },
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain(
      `formatOn.endToEndMsP50 900ms exceeds ${END_TO_END_BUDGETS.formatOnP50Ms}ms`,
    );
    expect(result.failures.join(" ")).toContain(
      `formatOn.endToEndMsP95 1300ms exceeds ${END_TO_END_BUDGETS.formatOnP95Ms}ms`,
    );
  });

  it("rejects a sample count below the floor", () => {
    const result = verifyDictationLatencyReport(
      validEndToEndReport({
        sampleCount: 4,
        formatOff: {
          measurementsMs: [81, 86, 92, 96],
          endToEndMsP50: 89,
          endToEndMsP95: 96,
        },
        formatOn: {
          measurementsMs: [83, 88, 95, 99],
          endToEndMsP50: 91,
          endToEndMsP95: 99,
        },
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain(
      `sampleCount must be at least ${END_TO_END_BUDGETS.minimumSamples}`,
    );
  });

  it("rejects a missing formatOn/formatOff section", () => {
    const missingFormatOn = validEndToEndReport();
    delete (missingFormatOn as Record<string, unknown>).formatOn;
    const result = verifyDictationLatencyReport(missingFormatOn);
    expect(result.pass).toBe(false);
    expect(result.failures).toContain("formatOn is required");
  });

  it("rejects a stage breakdown missing a stage or reporting mismatched sample counts", () => {
    const missingStage = validEndToEndReport();
    const breakdown = { ...(missingStage as Record<string, any>).stageBreakdownMs };
    delete breakdown.insertionMockOn;
    const result = verifyDictationLatencyReport({ ...missingStage, stageBreakdownMs: breakdown });
    expect(result.pass).toBe(false);
    expect(result.failures).toContain("stageBreakdownMs.insertionMockOn is required");

    const mismatched = verifyDictationLatencyReport(
      validEndToEndReport({
        stageBreakdownMs: {
          ...validEndToEndReport().stageBreakdownMs,
          asr: { measurementsMs: [80, 85, 90], p50: 85, p95: 90 },
        },
      }),
    );
    expect(mismatched.pass).toBe(false);
    expect(mismatched.failures).toContain(
      "stageBreakdownMs.asr.measurementsMs length must match sampleCount",
    );
  });

  it("requires a non-empty insertionStrategy label since insertion is mocked", () => {
    const result = verifyDictationLatencyReport(
      validEndToEndReport({ insertionStrategy: "" }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures).toContain(
      "insertionStrategy is required (this receipt mocks insertion; say how)",
    );
  });

  it("rejects negative and non-numeric end-to-end measurements", () => {
    const result = verifyDictationLatencyReport(
      validEndToEndReport({
        formatOff: {
          measurementsMs: [81, "bad", 92, null, 102],
          endToEndMsP50: 92,
          endToEndMsP95: 102,
        },
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures.join(" ")).toContain("formatOff.measurementsMs[1]");
    expect(result.failures.join(" ")).toContain("formatOff.measurementsMs[3]");
  });

  it("requires the supported Apple silicon reference tier by default", () => {
    const result = verifyDictationLatencyReport(
      validEndToEndReport({
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
      validEndToEndReport({
        hardware: { os: "linux", arch: "x86_64", memoryBytes: 8 * 1024 * 1024 * 1024 },
      }),
      { requireReferenceHardware: false },
    );
    expect(result.pass).toBe(true);
  });
});
