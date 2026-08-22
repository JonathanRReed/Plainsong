import { describe, expect, it } from "vitest";
import {
  BETA_REFERENCE_BUDGETS,
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
});
