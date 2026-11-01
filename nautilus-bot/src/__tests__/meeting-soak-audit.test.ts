import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { meetingSoakReceiptQualifies } from "../../scripts/lib/meeting-soak-audit.ts";
import { getAsrModelCapability, isKnownAsrProvider } from "@/lib/asr-capabilities";

const sidecar = "a".repeat(64);
const passing = {
  pass: true, recordMs: 10800000, minRecordMs: 10800000, recordingDurationMs: 10800003,
  includeSystemAudio: true, expectedCaptureMode: "me_and_them",
  transcriptWait: { timedOut: false }, fixtureTranscriptMatch: { matched: true },
  transcriptDetails: { requestedProvider: "transcribe_cpp", actualProvider: "transcribe_cpp",
    modelId: "parakeet-tdt-0.6b-v3-q8_0" },
  checks: { minimumDurationObserved: true, recordingCompleted: true }, sidecarSha256: sidecar,
};

describe("three-hour Parakeet soak audit", () => {
  it.each([
    ["transcribe_cpp", "parakeet-tdt-0.6b-v3-q8_0"],
    ["transcribe_cpp", "parakeet-unified-en-0.6b-q8_0"],
    ["parakeet", "parakeet-tdt-0.6b-v3"],
    ["parakeet", "parakeet-tdt-0.6b-v2"],
    ["parakeet", "parakeet-tdt-ctc-110m"],
  ])("accepts the catalogued %s route with %s", (provider, modelId) => {
    if (!isKnownAsrProvider(provider)) throw new Error("Unknown catalog provider");
    expect(getAsrModelCapability(provider, modelId)?.modelId).toBe(modelId);
    const runtime = fs.readFileSync(path.resolve(import.meta.dirname, `../../rust-sidecar/src/asr/${provider}.rs`), "utf8");
    expect(runtime).toContain(`"${modelId}"`);
    expect(meetingSoakReceiptQualifies({ ...passing, transcriptDetails: {
      requestedProvider: provider, actualProvider: provider, modelId,
    } }, sidecar)).toBe(true);
  });

  it.each([
    ["transcribe_cpp", "transcribe_cpp", "orukeet-r3-q8_0"],
    ["transcribe_cpp", "transcribe_cpp", "qwen3-asr-1.7b-q8_0"],
    ["transcribe_cpp", "transcribe_cpp", "fluid-speech-mini-q8_0"],
    ["transcribe_cpp", "transcribe_cpp", "underdog-bark-3.0-pro-q8_0"],
    ["transcribe_cpp", "transcribe_cpp", "parakeet-made-up-q8_0"],
    ["transcribe_cpp", "transcribe_cpp", "parakeet-tdt-0.6b-v3"],
    ["parakeet", "parakeet", "parakeet-tdt-0.6b-v3-q8_0"],
    ["parakeet", "parakeet", "base.en"],
    ["parakeet", "parakeet", ""],
    ["parakeet", "transcribe_cpp", "parakeet-tdt-0.6b-v3-q8_0"],
    ["transcribe_cpp", "whisper", "parakeet-tdt-0.6b-v3-q8_0"],
  ])("rejects requested %s, actual %s, model %s", (requestedProvider, actualProvider, modelId) => {
    expect(meetingSoakReceiptQualifies({ ...passing,
      transcriptDetails: { requestedProvider, actualProvider, modelId },
    }, sidecar)).toBe(false);
  });

  it.each([
    null, {}, { pass: false }, { recordMs: 10799999 }, { minRecordMs: 10799999 },
    { recordingDurationMs: 10799999 }, { recordingDurationMs: Infinity }, { recordMs: "10800000" },
    { includeSystemAudio: false }, { expectedCaptureMode: "mic_only" },
    { transcriptWait: { timedOut: true } }, { fixtureTranscriptMatch: { matched: false } },
    { transcriptDetails: null }, { checks: {} }, { checks: { completed: false } },
    { checks: { completed: "true" } }, { sidecarSha256: "b".repeat(64) },
  ])("rejects incomplete or failed evidence %j", (override) => {
    const receipt = override === null || Object.keys(override).length === 0 ? override : { ...passing, ...override };
    expect(meetingSoakReceiptQualifies(receipt, sidecar)).toBe(false);
  });

  it("requires the exact candidate sidecar", () => {
    for (const digest of [null, "", "invalid", "b".repeat(64)]) {
      expect(meetingSoakReceiptQualifies(passing, digest)).toBe(false);
    }
  });
});
