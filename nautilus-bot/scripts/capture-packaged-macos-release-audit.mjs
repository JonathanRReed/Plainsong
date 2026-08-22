#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { collectReleaseCandidateIdentity } from "./lib/release-candidate-identity.mjs";
import { evaluateReleaseReceiptFreshness } from "./lib/release-receipt-freshness.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const candidatePath = path.resolve(
  repoRoot,
  valueFor("--candidate", "release")
);
const qaPath = path.resolve(
  repoRoot,
  valueFor("--qa-dir", "artifacts/qa/macos")
);
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", path.join(qaPath, "release-readiness-audit.json"))
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", path.join(qaPath, "release-readiness-audit.md"))
);
const candidateAppPath = path.join(candidatePath, "mac-arm64", "Plainsong.app");
const candidateAppAsarPath = path.join(
  candidateAppPath,
  "Contents",
  "Resources",
  "app.asar",
);
const candidateSidecarPath = path.join(
  candidateAppPath,
  "Contents",
  "Resources",
  "sidecar",
  "plainsong-sidecar",
);
const candidateComponentPaths = [
  candidateAppAsarPath,
  candidateSidecarPath,
  path.join(candidateAppPath, "Contents", "MacOS", "Plainsong"),
  path.join(
    candidateAppPath,
    "Contents",
    "Resources",
    "shortcut-helper",
    "plainsong-native-shortcut-helper",
  ),
  path.join(
    candidateAppPath,
    "Contents",
    "Resources",
    "sidecar",
    "nautilus-macos-speech-helper-aarch64-apple-darwin",
  ),
];
const candidateComponentMtimes = candidateComponentPaths
  .filter((componentPath) => fs.existsSync(componentPath))
  .map((componentPath) => fs.statSync(componentPath).mtimeMs);
const candidateBuiltAtMs = candidateComponentMtimes.length > 0
  ? Math.max(...candidateComponentMtimes)
  : null;
const candidateIdentity = collectReleaseCandidateIdentity({
  candidatePath,
  appPath: candidateAppPath,
});
const candidateComponentSha256 = Object.fromEntries(
  candidateIdentity.appComponents.map((component) => [component.name, component.sha256]),
);
const lifecycleCandidateComponents = {
  appAsar: candidateComponentSha256["Contents/Resources/app.asar"],
  sidecar:
    candidateComponentSha256["Contents/Resources/sidecar/plainsong-sidecar"],
  shortcutHelper:
    candidateComponentSha256[
      "Contents/Resources/shortcut-helper/plainsong-native-shortcut-helper"
    ],
  speechHelper:
    candidateComponentSha256[
      "Contents/Resources/sidecar/nautilus-macos-speech-helper-aarch64-apple-darwin"
    ],
};

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${String(value).trimEnd()}\n`, "utf8");
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function plistScalar(filePath, key) {
  if (!fs.existsSync(filePath)) return null;
  const result = spawnSync(
    "/usr/bin/plutil",
    ["-extract", key, "raw", "-o", "-", filePath],
    { encoding: "utf8" },
  );
  return result.status === 0 ? String(result.stdout).trim() || null : null;
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function relative(filePath) {
  return path.relative(repoRoot, filePath);
}

function artifactFiles(pattern) {
  if (!fs.existsSync(candidatePath)) return [];
  return fs
    .readdirSync(candidatePath)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(candidatePath, name))
    .sort();
}

function evidenceFile(name) {
  return path.join(qaPath, name);
}

function artifactRequirement({
  id,
  label,
  file,
  predicate = (artifact) => artifact?.pass === true,
  candidateBound = false,
  candidateIdentityMode = null,
  missingDetail,
  failedDetail,
}) {
  if (!fs.existsSync(file)) {
    return {
      id,
      label,
      status: "missing",
      evidence: relative(file),
      detail: missingDetail,
    };
  }
  const artifact = readJson(file);
  if (!artifact) {
    return {
      id,
      label,
      status: "contradicted",
      evidence: relative(file),
      detail: "The required JSON evidence exists but is unreadable.",
    };
  }
  const expectedIdentitySha256 = candidateIdentityMode === "release"
    ? candidateIdentity.releaseSha256
    : undefined;
  const receiptIdentitySha256 = candidateIdentityMode === "release"
    ? artifact?.candidateIdentity?.releaseSha256
    : undefined;
  const currentCandidateResult = evaluateReleaseReceiptFreshness({
    candidateBound,
    candidateBuiltAtMs,
    generatedAt: artifact?.generatedAt,
    expectedIdentitySha256,
    receiptIdentitySha256,
  });
  const currentCandidateEvidence =
    candidateIdentityMode !== "release" || candidateIdentity.complete
      ? currentCandidateResult.current
      : false;
  const proved = Boolean(predicate(artifact)) && currentCandidateEvidence;
  return {
    id,
    label,
    status: proved ? "proved" : "contradicted",
    evidence: relative(file),
    detail: proved
      ? "The exact-candidate evidence passes its required checks."
      : !currentCandidateEvidence
        ? candidateIdentityMode === "release"
          ? "The receipt is not bound to the exact app, DMG, ZIP, blockmap, and beta manifest identity."
          : "The receipt predates the current candidate app archive and must be regenerated."
      : failedDetail(artifact),
  };
}

if (!fs.existsSync(candidatePath)) {
  console.error(`Release candidate directory not found: ${candidatePath}`);
  process.exit(1);
}

const dmgFiles = artifactFiles(/\.dmg$/i);
const zipFiles = artifactFiles(/-mac\.zip$/i);
const dmg = dmgFiles.length === 1 ? dmgFiles[0] : null;
const zip = zipFiles.length === 1 ? zipFiles[0] : null;
const packageVersion = readJson(path.join(repoRoot, "package.json"))?.version ?? null;
const appVersion = plistScalar(
  path.join(candidateAppPath, "Contents", "Info.plist"),
  "CFBundleShortVersionString",
);
const betaManifest = path.join(candidatePath, "beta-mac.yml");
const artifactsMatchVersion =
  typeof appVersion === "string" &&
  appVersion.length > 0 &&
  packageVersion === appVersion &&
  Boolean(dmg && path.basename(dmg).includes(appVersion)) &&
  Boolean(zip && path.basename(zip).includes(appVersion)) &&
  fs.existsSync(betaManifest);
const trustPath = evidenceFile("macos-trust.json");
const trust = readJson(trustPath);
const trustCurrentCandidate = evaluateReleaseReceiptFreshness({
  candidateBound: true,
  candidateBuiltAtMs,
  generatedAt: trust?.generatedAt,
  expectedIdentitySha256: candidateIdentity.releaseSha256,
  receiptIdentitySha256: trust?.candidateIdentity?.releaseSha256,
}).current && candidateIdentity.complete;
const distributionCheckNames = new Set([
  "notarizationTicketStapled",
  "gatekeeperAccepted",
  "gatekeeperSourceIsNotarizedDeveloperId",
  "dmgTicketStapled",
  "dmgGatekeeperAccepted",
  "zipNotarizationTicketStapled",
  "zipGatekeeperAccepted",
  "zipGatekeeperSourceIsNotarizedDeveloperId",
]);
const nonDistributionTrustChecks = Object.entries(trust?.checks ?? {}).filter(
  ([name]) => !distributionCheckNames.has(name)
);
const nonDistributionTrustPassed =
  trustCurrentCandidate &&
  nonDistributionTrustChecks.length > 0 &&
  nonDistributionTrustChecks.every(([, passed]) => passed === true);
const sourceGateEvidence = readJson(evidenceFile("source-gates.json"));

function reviewSourceMatchesGates(artifact) {
  const reviewIdentity = artifact?.sourceIdentity;
  const sourceGateIdentity = sourceGateEvidence?.sourceIdentity;
  return (
    typeof reviewIdentity?.sourceSnapshotSha256 === "string" &&
    reviewIdentity.sourceSnapshotSha256 === sourceGateIdentity?.sourceSnapshotSha256 &&
    typeof reviewIdentity?.trackedDiffSha256 === "string" &&
    reviewIdentity.trackedDiffSha256 === sourceGateIdentity?.trackedDiffSha256
  );
}

const requirements = [
  {
    id: "beta-identity",
    label: `Package and release artifacts share the ${packageVersion ?? "declared"} identity`,
    status: artifactsMatchVersion ? "proved" : "missing",
    evidence: relative(candidatePath),
    detail: artifactsMatchVersion
      ? "The package version, DMG, update ZIP, and beta-mac.yml identify one beta candidate."
      : `Expected package version ${packageVersion ?? "from package.json"} plus matching versioned DMG, ZIP, and beta-mac.yml.`,
  },
  {
    id: "release-artifacts",
    label: "Exact DMG and update ZIP exist with immutable hashes",
    status: dmg && zip ? "proved" : "missing",
    evidence: relative(candidatePath),
    detail:
      dmg && zip
        ? "Exactly one DMG and one macOS update ZIP were found and hashed."
        : `Expected exactly one DMG and one macOS update ZIP. Found ${dmgFiles.length} DMG and ${zipFiles.length} ZIP artifact(s).`,
  },
  {
    id: "developer-id-signing",
    label: "App, helpers, DMG, and update ZIP pass signing and least-privilege checks",
    status: nonDistributionTrustPassed ? "proved" : trust ? "contradicted" : "missing",
    evidence: relative(trustPath),
    detail: nonDistributionTrustPassed
      ? "Every non-distribution trust check passes, including signatures, hardened runtime, architectures, fuses, teams, timestamps, and per-binary entitlements."
      : trust
        ? "At least one signing, architecture, fuse, timestamp, team, or entitlement check failed."
        : "The exact-candidate macOS trust artifact is missing.",
  },
  artifactRequirement({
    id: "update-metadata",
    label: "Update ZIP metadata, size, and SHA-512 match",
    file: evidenceFile("update-metadata.json"),
    candidateBound: true,
    candidateIdentityMode: "release",
    missingDetail: "The exact-candidate update metadata artifact is missing.",
    failedDetail: () => "The update metadata verifier reports a mismatch or missing artifact.",
  }),
  artifactRequirement({
    id: "local-transcription",
    label: "Real local Whisper transcription passes",
    file: evidenceFile("transcription-whisper-e2e.json"),
    candidateBound: true,
    missingDetail: "The exact-candidate real-model transcription artifact is missing.",
    failedDetail: (artifact) =>
      artifact?.error || "The real local Whisper transcription checks did not all pass.",
  }),
  artifactRequirement({
    id: "backup-restore",
    label: "Backup and restore preserve settings and data",
    file: evidenceFile("backup-create-restore.json"),
    candidateBound: true,
    missingDetail: "The exact-candidate backup and restore artifact is missing.",
    failedDetail: (artifact) =>
      artifact?.error || "The backup and restore checks did not all pass.",
  }),
  artifactRequirement({
    id: "retention",
    label: "Every retention policy passes",
    file: evidenceFile("retention-policies.json"),
    candidateBound: true,
    missingDetail: "The exact-candidate retention artifact is missing.",
    failedDetail: (artifact) =>
      artifact?.error || "One or more retention-policy scenarios failed.",
  }),
  artifactRequirement({
    id: "exports",
    label: "Standard exports and meeting templates pass",
    file: evidenceFile("exports.json"),
    candidateBound: true,
    missingDetail: "The exact-candidate export artifact is missing.",
    failedDetail: (artifact) =>
      artifact?.error || "One or more export or template checks failed.",
  }),
  artifactRequirement({
    id: "host-matrix",
    label: "Every required macOS host row has verifier-clean support evidence",
    file: evidenceFile("app-matrix-preflight.json"),
    candidateBound: true,
    predicate: (artifact) =>
      artifact?.pass === true &&
      artifact?.summary?.required > 0 &&
      artifact?.summary?.requiredLaunchReady === artifact?.summary?.required,
    missingDetail: "The exact-candidate app-matrix preflight is missing.",
    failedDetail: (artifact) =>
      `${artifact?.summary?.requiredLaunchReady ?? 0} of ${artifact?.summary?.required ?? 0} required macOS rows are launch-ready.`,
  }),
  artifactRequirement({
    id: "meeting-microphone",
    label: "Real microphone meeting capture passes",
    file: evidenceFile("capture-meeting-mic.json"),
    candidateBound: true,
    missingDetail: "The exact-candidate microphone meeting artifact is missing.",
    failedDetail: (artifact) =>
      artifact?.error || "The microphone meeting checks did not all pass.",
  }),
  artifactRequirement({
    id: "meeting-system-audio",
    label: "Real system-audio capture passes with a known tone",
    file: evidenceFile("capture-system-audio-test.json"),
    candidateBound: true,
    missingDetail: "The exact-candidate system-audio artifact is missing.",
    failedDetail: (artifact) =>
      artifact?.result?.capability?.actionableReason ||
      artifact?.reason ||
      "The known-tone system-audio checks did not all pass.",
  }),
  artifactRequirement({
    id: "meeting-lifecycle",
    label: "Full packaged Meeting lifecycle and real-device recovery matrix passes",
    file: evidenceFile("meeting-lifecycle.json"),
    candidateBound: true,
    predicate: (artifact) =>
      artifact?.pass === true &&
      artifact?.summary?.total === 15 &&
      artifact?.summary?.passed === 15 &&
      artifact?.candidateIdentityTarget === "packaged-app-components" &&
      Object.entries(lifecycleCandidateComponents).every(
        ([name, sha256Value]) =>
          typeof sha256Value === "string" &&
          artifact?.candidateComponents?.[name] === sha256Value,
      ),
    missingDetail:
      "The exact-candidate Meeting lifecycle artifact is missing.",
    failedDetail: (artifact) =>
      `${artifact?.summary?.passed ?? 0} of ${artifact?.summary?.total ?? 15} Meeting lifecycle scenarios passed.`,
  }),
  artifactRequirement({
    id: "meeting-soak",
    label: "Three-hour dual-source local meeting soak completes on the exact candidate",
    file: evidenceFile("capture-soak-3h.json"),
    candidateBound: true,
    candidateIdentityMode: "release",
    predicate: (artifact) => {
      const checks = Object.values(artifact?.checks ?? {});
      return (
        artifact?.pass === true &&
        artifact?.recordMs >= 3 * 60 * 60 * 1000 &&
        artifact?.minRecordMs >= 3 * 60 * 60 * 1000 &&
        artifact?.recordingDurationMs >= 3 * 60 * 60 * 1000 &&
        artifact?.includeSystemAudio === true &&
        artifact?.expectedCaptureMode === "me_and_them" &&
        artifact?.transcriptWait?.timedOut === false &&
        artifact?.fixtureTranscriptMatch?.matched === true &&
        artifact?.transcriptDetails?.requestedProvider === "parakeet" &&
        artifact?.transcriptDetails?.actualProvider === "parakeet" &&
        checks.length > 0 &&
        checks.every(Boolean) &&
        fs.existsSync(candidateSidecarPath) &&
        artifact?.sidecarSha256 === sha256(candidateSidecarPath)
      );
    },
    missingDetail: "The exact-candidate three-hour dual-source meeting soak is missing.",
    failedDetail: (artifact) =>
      artifact?.error ||
      "The three-hour Parakeet meeting soak is incomplete, failed, or does not match the exact candidate sidecar.",
  }),
  artifactRequirement({
    id: "source-gates",
    label: "Current source lint, tests, builds, IPC, dead-code, and dependency gates pass",
    file: evidenceFile("source-gates.json"),
    candidateBound: true,
    missingDetail:
      "A current-revision source-gate receipt has not been attached to this candidate.",
    failedDetail: (artifact) =>
      artifact?.error || "One or more current source gates failed.",
  }),
  artifactRequirement({
    id: "rendered-first-run",
    label: "Rendered first-run and daily UX pass on the exact candidate",
    file: evidenceFile("rendered-ux.json"),
    candidateBound: true,
    candidateIdentityMode: "release",
    missingDetail:
      "A machine-readable rendered UX walkthrough is not attached to this candidate.",
    failedDetail: (artifact) =>
      artifact?.error || "One or more rendered UX checks failed.",
  }),
  artifactRequirement({
    id: "release-code-review",
    label: "Current-source ordinary code review is complete with no unresolved launch finding",
    file: evidenceFile("code-review.json"),
    predicate: (artifact) =>
      artifact?.pass === true &&
      artifact?.reviewMethod === "ordinary-code-review" &&
      Array.isArray(artifact?.remainingLaunchFindings) &&
      artifact.remainingLaunchFindings.length === 0 &&
      reviewSourceMatchesGates(artifact),
    missingDetail:
      "The current source has not received a completed ordinary code review receipt.",
    failedDetail: (artifact) =>
      artifact?.error ||
      (!reviewSourceMatchesGates(artifact)
        ? "The code-review receipt does not match the source snapshot that passed the source gates."
        : "The ordinary code review is incomplete or has unresolved launch findings."),
  }),
  {
    id: "apple-distribution",
    label: "App, DMG, and ZIP are Apple accepted, stapled, and Gatekeeper approved",
    status: trust?.pass === true && trustCurrentCandidate
      ? "proved"
      : trust
        ? "incomplete"
        : "missing",
    evidence: relative(trustPath),
    detail:
      trust?.pass === true && trustCurrentCandidate
        ? "The exact release passes the complete macOS trust gate."
        : trust?.pass === true && !trustCurrentCandidate
          ? "The macOS trust receipt predates the current candidate components and must be regenerated."
        : "The exact release is signed but still lacks notarization tickets, stapling, or Gatekeeper acceptance.",
  },
  artifactRequirement({
    id: "clean-install",
    label: "Quarantined clean install and first-run permission flow pass",
    file: evidenceFile("clean-install.json"),
    candidateBound: true,
    candidateIdentityMode: "release",
    missingDetail: "No exact-candidate clean-install artifact exists yet.",
    failedDetail: (artifact) =>
      artifact?.error || "The clean-install or permission walkthrough failed.",
  }),
  artifactRequirement({
    id: "signed-updater",
    label: "Signed and notarized N-to-N+1 updater flow preserves user state",
    file: evidenceFile("updater-n-to-n-plus-1.json"),
    candidateBound: true,
    candidateIdentityMode: "release",
    missingDetail: "No signed N-to-N+1 updater acceptance artifact exists yet.",
    failedDetail: (artifact) =>
      artifact?.error || "The signed updater acceptance checks failed.",
  }),
  artifactRequirement({
    id: "public-update-feed",
    label: "Installed beta can reach the production update feed without credentials",
    file: evidenceFile("public-update-feed.json"),
    candidateBound: true,
    candidateIdentityMode: "release",
    predicate: (artifact) => {
      const feedUrl = typeof artifact?.feedUrl === "string" ? artifact.feedUrl : "";
      const checks = Object.values(artifact?.checks ?? {});
      return (
        artifact?.pass === true &&
        artifact?.access === "unauthenticated" &&
        artifact?.channel === "beta" &&
        artifact?.requestedManifest === "beta-mac.yml" &&
        artifact?.manifestVersion === appVersion &&
        artifact?.candidateZipSha256 === (zip ? sha256(zip) : null) &&
        /^https:\/\//i.test(feedUrl) &&
        !/^https:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/i.test(feedUrl) &&
        checks.length > 0 &&
        checks.every(Boolean)
      );
    },
    missingDetail:
      "No exact-candidate proof exists for an unauthenticated HTTPS beta feed. Publishing or configuring that feed requires separate authorization.",
    failedDetail: (artifact) =>
      artifact?.error ||
      "The production beta feed is private, local-only, stale, credential-dependent, or does not serve this exact candidate.",
  }),
  artifactRequirement({
    id: "support-bundle",
    label: "Previewable support bundle is content-free and safe to share",
    file: evidenceFile("support-bundle.json"),
    candidateBound: true,
    predicate: (artifact) =>
      artifact?.safeToShare === true &&
      Array.isArray(artifact?.excludedByDesign) &&
      artifact.excludedByDesign.length >= 7,
    missingDetail: "No exact-candidate support-bundle preview exists yet.",
    failedDetail: (artifact) =>
      artifact?.errors?.join("; ") || "The support bundle failed its redaction checks.",
  }),
];

const counts = Object.fromEntries(
  ["proved", "contradicted", "incomplete", "indirect", "missing"].map((status) => [
    status,
    requirements.filter((requirement) => requirement.status === status).length,
  ])
);
const pass = requirements.every((requirement) => requirement.status === "proved");
const generatedAt = new Date().toISOString();
const report = {
  schemaVersion: 1,
  generatedAt,
  candidatePath,
  pass,
  status: pass ? "PASS" : "BLOCKED",
  receiptFinal: pass,
  artifacts: {
    dmg: dmg
      ? {
          path: relative(dmg),
          sizeBytes: fs.statSync(dmg).size,
          sha256: sha256(dmg),
        }
      : null,
    updateZip: zip
      ? {
          path: relative(zip),
          sizeBytes: fs.statSync(zip).size,
          sha256: sha256(zip),
        }
      : null,
  },
  candidateIdentity,
  summary: {
    total: requirements.length,
    ...counts,
  },
  requirements,
};

const markdownRows = requirements
  .map(
    (requirement) =>
      `| ${requirement.id} | ${requirement.status.toUpperCase()} | \`${requirement.evidence}\` | ${requirement.detail.replaceAll("|", "\\|")} |`
  )
  .join("\n");

writeText(outPath, JSON.stringify(report, null, 2));
writeText(
  markdownPath,
  `# Plainsong macOS Release Readiness Audit

Generated: ${generatedAt}
Status: ${report.status}
Final release receipt: ${report.receiptFinal ? "yes" : "no"}

This receipt is final only when every required row is \`PROVED\`. Missing, indirect, incomplete, or contradicted evidence blocks release.

## Artifact Identity

- DMG: ${report.artifacts.dmg ? `\`${report.artifacts.dmg.path}\`` : "missing"}
- DMG SHA-256: ${report.artifacts.dmg?.sha256 ?? "missing"}
- Update ZIP: ${report.artifacts.updateZip ? `\`${report.artifacts.updateZip.path}\`` : "missing"}
- Update ZIP SHA-256: ${report.artifacts.updateZip?.sha256 ?? "missing"}

## Summary

- Requirements: ${report.summary.total}
- Proved: ${report.summary.proved}
- Contradicted: ${report.summary.contradicted}
- Incomplete: ${report.summary.incomplete}
- Indirect: ${report.summary.indirect}
- Missing: ${report.summary.missing}

## Requirements

| ID | Status | Evidence | Detail |
| --- | --- | --- | --- |
${markdownRows}
`
);

console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
