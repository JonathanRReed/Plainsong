import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_AUTOMATED_MEETING_SCENARIOS,
  REQUIRED_REAL_DEVICE_MEETING_SCENARIOS,
  evaluateMeetingLifecycleEvidence,
} from "../../scripts/capture-packaged-macos-meeting-lifecycle.ts";

const appHash = "a".repeat(64);
const candidateComponents = {
  appAsar: appHash,
  sidecar: "b".repeat(64),
  shortcutHelper: "c".repeat(64),
  speechHelper: "d".repeat(64),
};

const fullBundleHash = "e".repeat(64);
const releaseHash = "f".repeat(64);
function receiptBinding() {
  return { candidateIdentity: { appBundle: { sha256: fullBundleHash } }, candidateAppUnchanged: true };
}

function passingEvidence() {
  return {
    candidateAppBundleSha256: fullBundleHash,
    candidateReleaseSha256: releaseHash,
    candidateIdentityTarget: "packaged-app-components",
    candidateAppSha256: appHash,
    candidateComponents,
    microphone: {
      ...receiptBinding(),
      pass: true,
      expectedCaptureMode: "mic_only",
      checks: {
        overlayEnteredProcessing: true,
        recordingStatusProcessing: true,
        duplicateStopIdempotent: true,
      },
    },
    combined: {
      ...receiptBinding(),
      pass: true,
      includeSystemAudio: true,
      expectedCaptureMode: "me_and_them",
      systemAudioVerification: { capability: { ready: true } },
      checks: { duplicateStopIdempotent: true },
    },
    soak: {
      candidateIdentity: { appBundle: { sha256: fullBundleHash }, complete: true, releaseSha256: releaseHash },
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
      ...receiptBinding(),
      pass: true,
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

  it("rejects stale nested evidence even when component hashes match", () => {
    for (const child of ["microphone", "combined", "realDevice"] as const) {
      const evidence = passingEvidence();
      evidence[child].candidateIdentity.appBundle.sha256 = "0".repeat(64);
      expect(evaluateMeetingLifecycleEvidence(evidence).pass).toBe(false);
    }
    const evidence = passingEvidence();
    evidence.soak.candidateIdentity.releaseSha256 = "0".repeat(64);
    expect(evaluateMeetingLifecycleEvidence(evidence).pass).toBe(false);
  });

  it("binds real-device observations to the packaged app archive", () => {
    const source = fs.readFileSync(
      path.join(repoRoot, "scripts", "capture-packaged-macos-meeting-lifecycle.ts"),
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

  it("rejects nested receipts without unchanged-app proof", () => {
    for (const child of ["microphone", "combined", "realDevice"] as const) {
      const evidence = passingEvidence();
      evidence[child].candidateAppUnchanged = false;
      expect(evaluateMeetingLifecycleEvidence(evidence).pass).toBe(false);
    }
  });

  it("rejects a soak receipt from a different full app bundle", () => {
    const evidence = passingEvidence();
    evidence.soak.candidateIdentity.appBundle.sha256 = "0".repeat(64);
    expect(evaluateMeetingLifecycleEvidence(evidence).pass).toBe(false);
  });

  it("rejects a failed real-device receipt despite matching identity and observations", () => {
    const evidence = passingEvidence();
    evidence.realDevice.pass = false;
    const receipt = evaluateMeetingLifecycleEvidence(evidence);
    expect(receipt.pass).toBe(false);
    expect(receipt.checks.filter(check => check.mode === "real_device")
      .every(check => !check.pass)).toBe(true);
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
      path.join(repoRoot, "scripts", "capture-packaged-macos-meeting-lifecycle.ts"),
      "utf8",
    );
    const auditSource = fs.readFileSync(
      path.join(repoRoot, "scripts", "capture-packaged-macos-release-audit.ts"),
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
      path.join(repoRoot, "scripts", "capture-packaged-macos-release-audit.ts"),
      "utf8",
    );

    expect(auditSource).toContain('id: "meeting-lifecycle"');
    expect(auditSource).toContain('evidenceFile("meeting-lifecycle.json")');
    expect(auditSource).toContain("artifact?.summary?.total === 15");
    expect(auditSource).toContain("artifact?.summary?.passed === 15");
  });

  it("uses privileged-admission-shaped nonces and the processing phase in capture harnesses", () => {
    for (const scriptName of [
      "capture-packaged-macos-meeting-mic.ts",
      "capture-packaged-macos-meeting-soak.ts",
    ]) {
      const source = fs.readFileSync(path.join(repoRoot, "scripts", scriptName), "utf8");
      expect(source).toContain("admissionNonce: crypto.randomUUID()");
      expect(source).toContain('phase === "processing"');
      expect(source).not.toContain('phase === "transcribing"');
    }
  });
});
