import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReleaseCandidateIdentity } from "./release-candidate-identity.ts";

export const reviewChecks = {
  "rendered-first-run": ["onboarding-before-workspace", "skip-limited-mode", "local-dictation-insertion-recovery",
    "meeting-notes-actions-export", "themes-keyboard-screen-reader-focus-contrast", "loading-empty-disabled-error-reduced-motion"],
  "clean-install": ["quarantined-dmg-gatekeeper", "drag-install-disposable-location", "first-run-permission-flow", "local-dictation-and-meeting"],
  "meeting-lifecycle-real-device": ["quitMidMeeting", "sidecarFault", "relaunchReconciliation", "processingQuitRecovery", "notes", "actionItems", "followUp", "export", "deletion"],
  "release-code-review": ["ordinary-code-review", "no-unresolved-launch-findings"],
} satisfies Record<string, string[]>;
export type ReviewKind = keyof typeof reviewChecks;
export function parseReviewKind(input: string | undefined): ReviewKind {
  if (input === "rendered-first-run" || input === "clean-install" || input === "release-code-review" || input === "meeting-lifecycle-real-device") return input;
  throw new Error("--kind must be rendered-first-run, clean-install, release-code-review or meeting-lifecycle-real-device");
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a review JSON object");
  return Object.fromEntries(Object.entries(input));
}
function reviewSourceIdentity(input: unknown) {
  const row = object(input);
  if (typeof row.sourceSnapshotSha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sourceSnapshotSha256) ||
    typeof row.trackedDiffSha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.trackedDiffSha256)) {
    throw new Error("A source-gates sourceIdentity is required for code review");
  }
  return { sourceSnapshotSha256: row.sourceSnapshotSha256, trackedDiffSha256: row.trackedDiffSha256 };
}
export function reviewTemplate(kind: ReviewKind, candidateIdentity: ReleaseCandidateIdentity, sourceIdentity: unknown) {
  if (!candidateIdentity.complete) throw new Error("Complete release identity required before review");
  return { schemaVersion: 1, kind, startedAt: new Date().toISOString(), candidateIdentity,
    sourceIdentity: kind === "release-code-review" ? reviewSourceIdentity(sourceIdentity) : null,
    reviewer: "", observedAt: "", remainingLaunchFindings: [],
    evidence: kind === "meeting-lifecycle-real-device" ? { processingQuitRecovery: {
      statusBeforeQuit: "", recoveredStatus: "", audioBytes: 0, reconciliationPreviousStatus: "",
      retranscribeStatus: "", finalStatus: "", transcriptChars: 0,
    } } : null,
    observations: reviewChecks[kind].map((id) => ({ id, status: "unrun", evidence: [], detail: "" })),
  };
}
export function completeReview({ input, kind, candidateIdentity, sourceIdentity, baseDir }: {
  input: unknown; kind: ReviewKind; candidateIdentity: ReleaseCandidateIdentity; sourceIdentity: unknown; baseDir: string;
}) {
  const row = object(input);
  const original = object(row.candidateIdentity);
  if (row.schemaVersion !== 1 || row.kind !== kind || !candidateIdentity.complete || !candidateIdentity.appBundle ||
    original.releaseSha256 !== candidateIdentity.releaseSha256 ||
    object(original.appBundle).sha256 !== candidateIdentity.appBundle?.sha256) {
    throw new Error("Review must begin and finish on the same complete release");
  }
  if (typeof row.reviewer !== "string" || !row.reviewer.trim() ||
    typeof row.startedAt !== "string" || !Number.isFinite(Date.parse(row.startedAt)) ||
    typeof row.observedAt !== "string" || !Number.isFinite(Date.parse(row.observedAt)) ||
    Date.parse(row.observedAt) < Date.parse(row.startedAt) || Date.parse(row.observedAt) > Date.now()) {
    throw new Error("Reviewer and observation time within the review interval are required");
  }
  if (!Array.isArray(row.observations) || row.observations.length !== reviewChecks[kind].length ||
    !Array.isArray(row.remainingLaunchFindings)) throw new Error("Review observations are incomplete");
  const observedAt = row.observedAt;
  const inputs: unknown[] = row.observations;
  const observations = reviewChecks[kind].map((id) => {
    const matches = inputs.map(object).filter((observation) => observation.id === id);
    const observation = matches[0];
    if (matches.length !== 1 || !observation ||
      (observation.status !== "pass" && observation.status !== "fail") ||
      typeof observation.detail !== "string" || observation.detail.trim().length < 12 ||
      !Array.isArray(observation.evidence) || !observation.evidence.length) {
      throw new Error(`Missing measured review observation: ${id}`);
    }
    const files: unknown[] = observation.evidence;
    return { id, status: observation.status, detail: observation.detail, evidence: files.map((file) => {
      if (typeof file !== "string" || !file.trim()) throw new Error(`Missing evidence path for ${id}`);
      const resolved = path.resolve(baseDir, file);
      const content = fs.readFileSync(resolved);
      if (!content.length) throw new Error(`Empty evidence file: ${file}`);
      return { path: resolved, sha256: crypto.createHash("sha256").update(content).digest("hex") };
    }) };
  });
  const source = kind === "release-code-review" ? reviewSourceIdentity(row.sourceIdentity) : null;
  if (source && JSON.stringify(source) !== JSON.stringify(reviewSourceIdentity(sourceIdentity))) {
    throw new Error("Source gates changed during review");
  }
  const components = Object.fromEntries(candidateIdentity.appComponents.map((entry) => [entry.name, entry.sha256]));
  const candidateComponents = {
    appAsar: components["Contents/Resources/app.asar"],
    sidecar: components["Contents/Resources/sidecar/plainsong-sidecar"],
    shortcutHelper: components["Contents/Resources/shortcut-helper/plainsong-native-shortcut-helper"],
    speechHelper: components["Contents/Resources/sidecar/nautilus-macos-speech-helper-aarch64-apple-darwin"],
  };
  const common = { schemaVersion: 1, generatedAt: new Date().toISOString(),
    startedAt: row.startedAt, observedAt, reviewer: row.reviewer,
    candidateIdentity: { ...candidateIdentity, appBundle: candidateIdentity.appBundle }, candidateAppUnchanged: true, sourceIdentity: source,
    reviewMethod: kind === "release-code-review" ? "ordinary-code-review" : "recorded-walkthrough",
    remainingLaunchFindings: row.remainingLaunchFindings,
    candidateAppSha256: candidateComponents.appAsar, candidateComponents,
    pass: observations.every((observation) => observation.status === "pass") && row.remainingLaunchFindings.length === 0,
  };
  if (kind === "meeting-lifecycle-real-device") {
    const recovery = object(object(row.evidence).processingQuitRecovery);
    if (typeof recovery.statusBeforeQuit !== "string" || typeof recovery.recoveredStatus !== "string" ||
      typeof recovery.audioBytes !== "number" || !Number.isFinite(recovery.audioBytes) ||
      typeof recovery.reconciliationPreviousStatus !== "string" || typeof recovery.retranscribeStatus !== "string" ||
      typeof recovery.finalStatus !== "string" || typeof recovery.transcriptChars !== "number" ||
      !Number.isFinite(recovery.transcriptChars)) throw new Error("Actual processing recovery evidence is required");
    const processingQuitRecovery = {
      statusBeforeQuit: recovery.statusBeforeQuit, recoveredStatus: recovery.recoveredStatus,
      audioBytes: recovery.audioBytes, reconciliationPreviousStatus: recovery.reconciliationPreviousStatus,
      retranscribeStatus: recovery.retranscribeStatus, finalStatus: recovery.finalStatus, transcriptChars: recovery.transcriptChars,
    };
    return { ...common, kind: "meeting-lifecycle-real-device" satisfies ReviewKind,
      evidence: { processingQuitRecovery },
      observations: Object.fromEntries(observations.map((observation) => [observation.id, {
        pass: observation.status === "pass", observedAt, notes: observation.detail, evidence: observation.evidence,
      }])),
    };
  }
  return { ...common, kind, observations };
}
