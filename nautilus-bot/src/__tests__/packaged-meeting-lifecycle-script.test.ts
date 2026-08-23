import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_AUTOMATED_MEETING_SCENARIOS,
  REQUIRED_REAL_DEVICE_MEETING_SCENARIOS,
  evaluateMeetingLifecycleEvidence,
} from "../../scripts/capture-packaged-macos-meeting-lifecycle.mjs";

const appHash = "a".repeat(64);
const candidateComponents = {
  appAsar: appHash,
  sidecar: "b".repeat(64),
  shortcutHelper: "c".repeat(64),
  speechHelper: "d".repeat(64),
};

function passingEvidence() {
  return {
    candidateIdentityTarget: "packaged-app-components",
    candidateAppSha256: appHash,
    candidateComponents,
    microphone: {
      pass: true,
      expectedCaptureMode: "mic_only",
      checks: {
        overlayEnteredProcessing: true,
        recordingStatusProcessing: true,
        duplicateStopIdempotent: true,
      },
    },
    combined: {
      pass: true,
      includeSystemAudio: true,
      expectedCaptureMode: "me_and_them",
      systemAudioVerification: { capability: { ready: true } },
      checks: { duplicateStopIdempotent: true },
    },
    soak: {
      pass: true,
      fixtureTranscriptMatch: {
        matched: true,
        coverage: 0.8,
        minimumCoverage: 0.6,
        orderedCoverage: 0.8,
        minimumOrderedCoverage: 0.6,
      },
    },
    realDevice: {
      candidateAppSha256: appHash,
      candidateComponents,
      evidence: {
        processingQuitRecovery: {
          statusBeforeQuit: "processing",
          recoveredStatus: "error",
          audioBytes: 4096,
          reconciliationPreviousStatus: "processing",
          retranscribeStatus: "processing",
          finalStatus: "completed",
          transcriptChars: 128,
        },
      },
      observations: Object.fromEntries(
        REQUIRED_REAL_DEVICE_MEETING_SCENARIOS.map((id) => [
          id,
          {
            pass: true,
            observedAt: "2026-08-08T18:00:00Z",
            notes: `Verified ${id} on the packaged beta candidate.`,
          },
        ]),
      ),
    },
  };
}

describe("packaged Meeting lifecycle receipt", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");

  it("binds real-device observations to the packaged app archive", () => {
    const source = fs.readFileSync(
      path.join(repoRoot, "scripts", "capture-packaged-macos-meeting-lifecycle.mjs"),
      "utf8",
    );

    expect(source).toContain("candidateComponents");
    expect(source).toContain("candidateIdentityTarget");
  });

  it("covers every automated and real-device beta scenario", () => {
    expect(REQUIRED_AUTOMATED_MEETING_SCENARIOS).toEqual([
      "microphoneCapture",
      "systemAudioCapture",
      "combinedCapture",
      "normalStop",
      "duplicateStop",
      "transcript",
    ]);
    expect(REQUIRED_REAL_DEVICE_MEETING_SCENARIOS).toEqual([
      "quitMidMeeting",
      "sidecarFault",
      "relaunchReconciliation",
      "processingQuitRecovery",
      "notes",
      "actionItems",
      "followUp",
      "export",
      "deletion",
    ]);
  });

  it("passes only when both evidence classes cover the exact candidate", () => {
    const receipt = evaluateMeetingLifecycleEvidence(passingEvidence());

    expect(receipt.pass).toBe(true);
    expect(receipt.candidateIdentityTarget).toBe(
      "packaged-app-components",
    );
    expect(receipt.summary).toMatchObject({ total: 15, passed: 15 });
  });

  it("blocks a missing real-device step", () => {
    const evidence = passingEvidence();
    delete evidence.realDevice.observations.sidecarFault;

    const receipt = evaluateMeetingLifecycleEvidence(evidence);

    expect(receipt.pass).toBe(false);
    expect(receipt.checks.find((entry) => entry.id === "sidecarFault")?.pass).toBe(
      false,
    );
  });

  it("blocks observations copied from a different app build", () => {
    const evidence = passingEvidence();
    evidence.realDevice.candidateAppSha256 = "b".repeat(64);

    expect(evaluateMeetingLifecycleEvidence(evidence).pass).toBe(false);
  });

  it("blocks observations copied from a build with a different sidecar", () => {
    const evidence = passingEvidence();
    evidence.realDevice.candidateComponents = {
      ...candidateComponents,
      sidecar: "e".repeat(64),
    };

    expect(evaluateMeetingLifecycleEvidence(evidence).pass).toBe(false);
  });

  it("blocks processing-quit recovery without structured retry proof", () => {
    const evidence = passingEvidence();
    evidence.realDevice.evidence.processingQuitRecovery.transcriptChars = 0;

    const receipt = evaluateMeetingLifecycleEvidence(evidence);

    expect(receipt.pass).toBe(false);
    expect(
      receipt.checks.find((entry) => entry.id === "processingQuitRecovery")?.pass,
    ).toBe(false);
  });

  it("uses the packaged QA producers' canonical receipt directory and filenames", () => {
    const lifecycleSource = fs.readFileSync(
      path.join(repoRoot, "scripts", "capture-packaged-macos-meeting-lifecycle.mjs"),
      "utf8",
    );
    const auditSource = fs.readFileSync(
      path.join(repoRoot, "scripts", "capture-packaged-macos-release-audit.mjs"),
      "utf8",
    );

    for (const source of [lifecycleSource, auditSource]) {
      expect(source).toContain('"artifacts/qa/macos"');
    }
    for (const receipt of [
      "capture-meeting-mic.json",
      "capture-meeting-system-audio.json",
      "capture-system-audio-test.json",
    ]) {
      expect(lifecycleSource + auditSource).toContain(receipt);
    }
    expect(auditSource).toContain('valueFor("--qa-dir", "artifacts/qa/macos")');
  });

  it("is required by the exact-candidate release audit", () => {
    const auditSource = fs.readFileSync(
      path.join(repoRoot, "scripts", "capture-packaged-macos-release-audit.mjs"),
      "utf8",
    );

    expect(auditSource).toContain('id: "meeting-lifecycle"');
    expect(auditSource).toContain('evidenceFile("meeting-lifecycle.json")');
    expect(auditSource).toContain("artifact?.summary?.total === 15");
    expect(auditSource).toContain("artifact?.summary?.passed === 15");
  });

  it("uses privileged-admission-shaped nonces and the processing phase in capture harnesses", () => {
    for (const scriptName of [
      "capture-packaged-macos-meeting-mic.mjs",
      "capture-packaged-macos-meeting-soak.mjs",
    ]) {
      const source = fs.readFileSync(path.join(repoRoot, "scripts", scriptName), "utf8");
      expect(source).toContain("admissionNonce: crypto.randomUUID()");
      expect(source).toContain('phase === "processing"');
      expect(source).not.toContain('phase === "transcribing"');
    }
  });
});
