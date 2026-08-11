#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_AUTOMATED_MEETING_SCENARIOS = [
  "microphoneCapture",
  "systemAudioCapture",
  "combinedCapture",
  "normalStop",
  "duplicateStop",
  "transcript",
];

export const REQUIRED_REAL_DEVICE_MEETING_SCENARIOS = [
  "quitMidMeeting",
  "sidecarFault",
  "relaunchReconciliation",
  "processingQuitRecovery",
  "notes",
  "actionItems",
  "followUp",
  "export",
  "deletion",
];

const REQUIRED_CANDIDATE_COMPONENTS = [
  "appAsar",
  "sidecar",
  "shortcutHelper",
  "speechHelper",
];

function componentsMatch(expected, actual) {
  return REQUIRED_CANDIDATE_COMPONENTS.every(
    (name) =>
      /^[a-f0-9]{64}$/i.test(expected?.[name] ?? "") &&
      expected[name] === actual?.[name],
  );
}

function observationPassed(observation) {
  return (
    observation?.pass === true &&
    typeof observation?.observedAt === "string" &&
    observation.observedAt.trim().length > 0 &&
    typeof observation?.notes === "string" &&
    observation.notes.trim().length >= 12
  );
}

function processingQuitRecoveryPassed(realDevice) {
  const evidence = realDevice?.evidence?.processingQuitRecovery;
  return (
    evidence?.statusBeforeQuit === "processing" &&
    evidence?.recoveredStatus === "error" &&
    Number.isFinite(evidence?.audioBytes) &&
    evidence.audioBytes > 44 &&
    evidence?.reconciliationPreviousStatus === "processing" &&
    evidence?.retranscribeStatus === "processing" &&
    evidence?.finalStatus === "completed" &&
    Number.isFinite(evidence?.transcriptChars) &&
    evidence.transcriptChars > 0
  );
}

function check(id, mode, pass, evidence, detail) {
  return { id, mode, pass: Boolean(pass), evidence, detail };
}

export function evaluateMeetingLifecycleEvidence({
  candidateIdentityTarget,
  candidateAppSha256,
  candidateComponents,
  microphone,
  combined,
  soak,
  realDevice,
}) {
  const realDeviceBoundToCandidate =
    typeof candidateAppSha256 === "string" &&
    candidateAppSha256.length === 64 &&
    realDevice?.candidateAppSha256 === candidateAppSha256 &&
    componentsMatch(candidateComponents, realDevice?.candidateComponents);

  const checks = [
    check(
      "microphoneCapture",
      "automated",
      microphone?.pass === true && microphone?.expectedCaptureMode === "mic_only",
      "meeting-mic.json",
      "The packaged mic-only capture must pass.",
    ),
    check(
      "systemAudioCapture",
      "automated",
      combined?.pass === true &&
        combined?.includeSystemAudio === true &&
        combined?.systemAudioVerification?.capability?.ready === true,
      "meeting-system-audio.json",
      "The packaged known-tone system-audio verification must pass.",
    ),
    check(
      "combinedCapture",
      "automated",
      combined?.pass === true && combined?.expectedCaptureMode === "me_and_them",
      "meeting-system-audio.json",
      "The packaged Me + Them capture must preserve both source files.",
    ),
    check(
      "normalStop",
      "automated",
      microphone?.checks?.overlayEnteredProcessing === true &&
        microphone?.checks?.recordingStatusProcessing === true,
      "meeting-mic.json",
      "Normal Stop must persist processing state before returning.",
    ),
    check(
      "duplicateStop",
      "automated",
      microphone?.checks?.duplicateStopIdempotent === true &&
        combined?.checks?.duplicateStopIdempotent === true,
      "meeting-mic.json, meeting-system-audio.json",
      "Duplicate Stop must be idempotent for both capture modes.",
    ),
    check(
      "transcript",
      "automated",
      soak?.pass === true &&
        soak?.fixtureTranscriptMatch?.matched === true &&
        soak.fixtureTranscriptMatch.coverage >=
          soak.fixtureTranscriptMatch.minimumCoverage &&
        soak.fixtureTranscriptMatch.orderedCoverage >=
          soak.fixtureTranscriptMatch.minimumOrderedCoverage,
      "capture-soak-3h.json",
      "The long packaged capture must produce an ordered, sufficiently complete transcript.",
    ),
    ...REQUIRED_REAL_DEVICE_MEETING_SCENARIOS.map((id) =>
      check(
        id,
        "real_device",
        realDeviceBoundToCandidate &&
          observationPassed(realDevice?.observations?.[id]) &&
          (id !== "processingQuitRecovery" || processingQuitRecoveryPassed(realDevice)),
        "meeting-lifecycle-real-device.json",
        id === "processingQuitRecovery"
          ? "Stop must reach processing, relaunch must reconcile it, and a retry must complete a non-empty transcript from saved audio."
          : realDeviceBoundToCandidate
          ? "A dated real-device observation with concrete notes is required."
          : "The real-device receipt must be bound to this exact packaged app hash.",
      ),
    ),
  ];

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    candidateIdentityTarget,
    candidateAppSha256,
    candidateComponents,
    pass: checks.every((entry) => entry.pass),
    summary: {
      total: checks.length,
      passed: checks.filter((entry) => entry.pass).length,
      automated: checks.filter((entry) => entry.mode === "automated").length,
      realDevice: checks.filter((entry) => entry.mode === "real_device").length,
    },
    checks,
  };
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function valueFor(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && index < args.length - 1 ? args[index + 1] : fallback;
}

function renderMarkdown(receipt) {
  const rows = receipt.checks
    .map(
      (entry) =>
        `| ${entry.id} | ${entry.mode} | ${entry.pass ? "PASS" : "FAIL"} | ${entry.evidence} | ${entry.detail} |`,
    )
    .join("\n");
  return `# Packaged macOS Meeting Lifecycle

Status: ${receipt.pass ? "PASS" : "BLOCKED"}
Generated: ${receipt.generatedAt}
Candidate identity target: ${receipt.candidateIdentityTarget ?? "missing"}
Candidate app archive SHA-256: ${receipt.candidateAppSha256 ?? "missing"}
Candidate packaged components: ${receipt.candidateComponents ? "recorded" : "missing"}

Both the automated capture checks and the dated real-device observations are required for beta signoff.

| Scenario | Mode | Status | Evidence | Requirement |
| --- | --- | --- | --- | --- |
${rows}
`;
}

async function main() {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const args = process.argv.slice(2);
  const appPath = path.resolve(
    repoRoot,
    valueFor(args, "--app", "release/mac-arm64/Plainsong.app"),
  );
  const qaDir = path.resolve(
    repoRoot,
    valueFor(args, "--qa-dir", "release/qa"),
  );
  const outPath = path.resolve(
    repoRoot,
    valueFor(args, "--out", path.join(qaDir, "meeting-lifecycle.json")),
  );
  const markdownPath = path.resolve(
    repoRoot,
    valueFor(
      args,
      "--markdown",
      path.join(qaDir, "meeting-lifecycle.md"),
    ),
  );
  const candidateIdentityTarget = "packaged-app-components";
  const candidateIdentityPath = path.join(
    appPath,
    "Contents",
    "Resources",
    "app.asar",
  );
  const candidateAppSha256 = fs.existsSync(candidateIdentityPath)
    ? sha256(candidateIdentityPath)
    : null;
  const componentPaths = {
    appAsar: candidateIdentityPath,
    sidecar: path.join(
      appPath,
      "Contents",
      "Resources",
      "sidecar",
      "plainsong-sidecar",
    ),
    shortcutHelper: path.join(
      appPath,
      "Contents",
      "Resources",
      "shortcut-helper",
      "plainsong-native-shortcut-helper",
    ),
    speechHelper: path.join(
      appPath,
      "Contents",
      "Resources",
      "sidecar",
      "nautilus-macos-speech-helper-aarch64-apple-darwin",
    ),
  };
  const candidateComponents = Object.fromEntries(
    Object.entries(componentPaths).map(([name, componentPath]) => [
      name,
      fs.existsSync(componentPath) ? sha256(componentPath) : null,
    ]),
  );
  const receipt = evaluateMeetingLifecycleEvidence({
    candidateIdentityTarget,
    candidateAppSha256,
    candidateComponents,
    microphone: readJson(path.join(qaDir, "meeting-mic.json")),
    combined: readJson(path.join(qaDir, "meeting-system-audio.json")),
    soak: readJson(path.join(qaDir, "capture-soak-3h.json")),
    realDevice: readJson(path.join(qaDir, "meeting-lifecycle-real-device.json")),
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, `${renderMarkdown(receipt).trimEnd()}\n`, "utf8");
  console.log(JSON.stringify(receipt, null, 2));
  process.exit(receipt.pass ? 0 : 1);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main();
}
