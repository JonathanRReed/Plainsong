import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { microphoneReceiptFromFootprint, retainedFootprintReceipt } from "../../scripts/lib/candidate-qa-receipts.ts";
import { completeReview, reviewTemplate } from "../../scripts/lib/release-review-receipt.ts";
import type { ReleaseCandidateIdentity } from "../../scripts/lib/release-candidate-identity.ts";

import { evaluateMeetingLifecycleEvidence } from "../../scripts/capture-packaged-macos-meeting-lifecycle.ts";

const digest = "a".repeat(64);
const footprint = {
  generatedAt: "2026-10-30T18:00:00Z", pass: false, error: null,
  candidateIdentity: { appBundle: { sha256: digest } }, candidateAppUnchanged: true,
  fixtureDevice: "BlackHole 2ch", states: [{ state: "meeting", exercised: true, samples: 120 }],
  meeting: { captureMode: "me_and_them", overlayPhase: "recording", liveEvents: 13,
    status: "completed", transcriptChars: 2110, fixtureCoverage: 0.92 },
};
const capture = { binding: { appBundleSha256: digest }, phase: "before-meeting-stop", recordingId: "fixture",
  liveEvents: 13, overlay: { recordingId: "fixture", phase: "recording", microphoneInput: {
    requestedName: "BlackHole 2ch", resolvedName: "BlackHole 2ch", usedFallback: false,
  } } };
function convert(raw: unknown = footprint, frame: unknown = capture) {
  return microphoneReceiptFromFootprint({ footprint: raw, capture: frame, appBundleSha256: digest });
}
describe("retained candidate QA receipts", () => {
  it("proves measured microphone capture independently of a failed memory budget", () => {
    expect(convert().pass).toBe(true);
    expect(convert().measurementPass).toBe(false);
    expect(retainedFootprintReceipt(footprint, digest).pass).toBe(false);
  });
  it("rejects stale, mutated and absent app bindings", () => {
    for (const raw of [null, {}, { ...footprint, candidateAppUnchanged: false }]) {
      expect(() => convert(raw)).toThrow();
    }
    expect(() => convert(footprint, { ...capture, binding: { appBundleSha256: "b".repeat(64) } })).toThrow();
    expect(() => retainedFootprintReceipt(footprint, "b".repeat(64))).toThrow();
  });
  it("keeps missing and incomplete microphone observations failed", () => {
    for (const raw of [
      { ...footprint, meeting: {} }, { ...footprint, states: [] },
      { ...footprint, meeting: { ...footprint.meeting, status: "processing" } },
      { ...footprint, meeting: { ...footprint.meeting, fixtureCoverage: 0.1 } },
    ]) expect(convert(raw).pass).toBe(false);
    expect(convert(footprint, { ...capture, overlay: { ...capture.overlay, microphoneInput: {} } }).pass).toBe(false);
  });
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const identity: ReleaseCandidateIdentity = { schemaVersion: 2, complete: true, missing: [], appComponents: [],
  appBundle: { sha256: digest, entries: [] }, artifacts: [], appComponentsSha256: digest, releaseSha256: digest };
function review() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-review-receipt-")); roots.push(root);
  fs.writeFileSync(path.join(root, "evidence.txt"), "Actual walkthrough findings\n");
  const template = reviewTemplate("rendered-first-run", identity, null);
  const input = { ...template, reviewer: "QA reviewer", observedAt: new Date().toISOString(),
    observations: template.observations.map((row) => ({ ...row, status: "pass", detail: "Observed the required behavior", evidence: ["evidence.txt"] })) };
  return { root, input, finish: (data: unknown = input, candidateIdentity = identity) => completeReview({
    input: data, kind: "rendered-first-run", candidateIdentity, sourceIdentity: null, baseDir: root,
  }) };
}
describe("recorded release reviews", () => {
  it("requires every observation and hashes its evidence", () => {
    const { finish } = review();
    expect(finish().pass).toBe(true);
    const { input } = review();
    expect(() => finish({ ...input, observations: [] })).toThrow();
    expect(() => finish({ ...input, reviewer: "" })).toThrow();
    expect(() => finish({ ...input, observations: input.observations.map((row) => ({ ...row, evidence: [] })) })).toThrow();
    expect(() => finish({ ...input, observations: input.observations.map((row) => ({ ...row, evidence: ["absent.png"] })) })).toThrow();
  });
  it("does not promote unrun reviews, changed candidates or failed observations", () => {
    const { input, finish } = review();
    expect(() => finish(reviewTemplate("rendered-first-run", identity, null))).toThrow();
    expect(() => finish(input, { ...identity, releaseSha256: "b".repeat(64) })).toThrow();
    expect(finish({ ...input, observations: input.observations.map((row) => ({ ...row, status: "fail" })) }).pass).toBe(false);
    expect(finish({ ...input, remainingLaunchFindings: ["open finding"] }).pass).toBe(false);
  });
  it("binds code review to the same source snapshot as the source gates", () => {
    const { root } = review();
    const source = { sourceSnapshotSha256: digest, trackedDiffSha256: digest };
    const template = reviewTemplate("release-code-review", identity, source);
    const input = { ...template, reviewer: "Reviewer", observedAt: new Date().toISOString(),
      observations: template.observations.map((row) => ({ ...row, status: "pass", detail: "Reviewed source and findings", evidence: ["evidence.txt"] })) };
    const complete = (sourceIdentity: unknown) => completeReview({ input, kind: "release-code-review", candidateIdentity: identity, sourceIdentity, baseDir: root });
    expect(complete(source).pass).toBe(true);
    expect(() => complete({ ...source, sourceSnapshotSha256: "b".repeat(64) })).toThrow();
  });
});

it("records all nine real-device lifecycle observations in the aggregator's schema", () => {
  const { root } = review();
  const components = ["Contents/Resources/app.asar", "Contents/Resources/sidecar/plainsong-sidecar",
    "Contents/Resources/shortcut-helper/plainsong-native-shortcut-helper",
    "Contents/Resources/sidecar/nautilus-macos-speech-helper-aarch64-apple-darwin"];
  const candidateIdentity = { ...identity, appComponents: components.map((name) => ({ name, sha256: digest, bytes: 1 })) };
  const template = reviewTemplate("meeting-lifecycle-real-device", candidateIdentity, null);
  const input = { ...template, reviewer: "QA", observedAt: new Date().toISOString(), evidence: {
    processingQuitRecovery: { statusBeforeQuit: "processing", recoveredStatus: "error", audioBytes: 1024,
      reconciliationPreviousStatus: "processing", retranscribeStatus: "processing", finalStatus: "completed", transcriptChars: 200 },
  }, observations: template.observations.map((row) => ({ ...row, status: "pass", detail: "Observed the lifecycle behavior", evidence: ["evidence.txt"] })) };
  const result = completeReview({ input, kind: "meeting-lifecycle-real-device", candidateIdentity, sourceIdentity: null, baseDir: root });
  if (result.kind !== "meeting-lifecycle-real-device") throw new Error("Expected lifecycle receipt");
  const evaluated = evaluateMeetingLifecycleEvidence({ candidateAppSha256: digest,
    candidateAppBundleSha256: digest, candidateReleaseSha256: digest,
    candidateComponents: result.candidateComponents, realDevice: result,
  });
  expect(evaluated.summary.realDevice).toBe(9);
  expect(evaluated.summary.passed).toBe(9);
  expect(evaluated.pass).toBe(false);
});
