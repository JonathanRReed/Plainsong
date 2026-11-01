#!/usr/bin/env bun
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { releaseScopeDecisions, type ScopeDecision } from "./lib/release-scope-exceptions.ts";
import { partialScopeReceiptQualifies } from "./lib/release-scoped-requirements.ts";
import { prePublicationAuditProvesRequirements } from "./lib/release-audit-phase.ts";
import { meetingSoakReceiptQualifies } from "./lib/meeting-soak-audit.ts";
import { RELEASE_CHANNEL_POLICY } from "./lib/public-update-feed.ts";
import { capturePublicReleaseRollout } from "./lib/public-release-rollout.ts";
import { footprintReceiptFailures, footprintReceiptQualifies } from "./lib/footprint-gate.ts";
import { collectReleaseCandidateIdentity } from "./lib/release-candidate-identity.ts";
import { evaluateReleaseReceiptFreshness } from "./lib/release-receipt-freshness.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

// Receipts are JSON written by the other capture scripts, possibly for an older
// candidate. Every field is read defensively (optional chaining, strict
// equality, JavaScript comparison semantics), so no shape is asserted here.
type Receipt = any;

type RequirementStatus = "proved" | "contradicted" | "incomplete" | "indirect" | "missing" | "excluded by decision" | "proved with scoped exclusion";

interface Requirement {
  id: string;
  label: string;
  status: RequirementStatus;
  evidence: string;
  detail: string;
  scopeDecision?: ScopeDecision;
}

function valueFor(name: string): string | null;
function valueFor(name: string, fallback: string): string;
function valueFor(name: string, fallback: string | null = null): string | null {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const phase = args.includes("--phase") ? valueFor("--phase") : "pre";
if (phase !== "pre" && phase !== "post") {
  console.error("--phase must be pre or post");
  process.exit(1);
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
  valueFor("--out", path.join(qaPath, `release-${phase}-audit.json`))
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", path.join(qaPath, `release-${phase}-audit.md`))
);
const candidateAppPath = path.join(candidatePath, "mac-arm64", "Plainsong.app");
const candidateSidecarPath = path.join(
  candidateAppPath,
  "Contents",
  "Resources",
  "sidecar",
  "plainsong-sidecar",
);
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

function writeText(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${String(value).trimEnd()}\n`, "utf8");
}

function readJson(filePath: string): Receipt {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function plistScalar(filePath: string, key: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const result = spawnSync(
    "/usr/bin/plutil",
    ["-extract", key, "raw", "-o", "-", filePath],
    { encoding: "utf8" },
  );
  return result.status === 0 ? String(result.stdout).trim() || null : null;
}

function sha256(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function relative(filePath: string): string {
  return path.relative(repoRoot, filePath);
}

function artifactFiles(pattern: RegExp): string[] {
  if (!fs.existsSync(candidatePath)) return [];
  return fs
    .readdirSync(candidatePath)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(candidatePath, name))
    .sort();
}

function evidenceFile(name: string): string {
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
}: {
  id: string;
  label: string;
  file: string;
  predicate?: (artifact: Receipt) => unknown;
  candidateBound?: boolean;
  candidateIdentityMode?: "release" | null;
  missingDetail: string;
  failedDetail: (artifact: Receipt) => string;
}): Requirement {
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
    : candidateBound ? candidateIdentity.appBundle?.sha256 ?? null : undefined;
  const receiptIdentitySha256 = candidateIdentityMode === "release"
    ? artifact?.candidateIdentity?.releaseSha256
    : candidateBound ? artifact?.candidateIdentity?.appBundle?.sha256 ?? null : undefined;
  const currentCandidateResult = evaluateReleaseReceiptFreshness({
    candidateBound,
    expectedIdentitySha256,
    receiptIdentitySha256,
  });
  const decision = scopeDecisions.find((row) => row.requirement === id);
  const partialDecision = decision?.scope ? decision : null;
  const currentCandidateEvidence = currentCandidateResult.current &&
    (!partialDecision || artifact?.candidateAppUnchanged === true) && (
    candidateIdentityMode === "release"
      ? candidateIdentity.complete
      : !candidateBound || artifact?.candidateAppUnchanged === true
  );
  const proved = currentCandidateEvidence && (partialDecision
    ? partialScopeReceiptQualifies(artifact, partialDecision)
    : artifact?.pass === true && Boolean(predicate(artifact)));
  return {
    id,
    label,
    status: proved ? partialDecision ? "proved with scoped exclusion" : "proved" : "contradicted",
    evidence: relative(file),
    ...(partialDecision ? { scopeDecision: partialDecision } : {}),
    detail: (proved
      ? "The exact-candidate evidence passes its required checks outside any named exclusion."
      : !currentCandidateEvidence
        ? candidateIdentityMode === "release"
          ? "The receipt is not bound to the exact app, DMG, ZIP, blockmap, and beta manifest identity."
          : "The receipt is not bound to the full unchanged candidate app bundle and must be regenerated."
      : failedDetail(artifact)) + (partialDecision
        ? ` Scoped exclusion ${JSON.stringify(partialDecision.scope)}: ${partialDecision.decision}; reason: ${partialDecision.reason}` : ""),
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

function reviewSourceMatchesGates(artifact: Receipt): boolean {
  const reviewIdentity = artifact?.sourceIdentity;
  const sourceGateIdentity = sourceGateEvidence?.sourceIdentity;
  return (
    typeof reviewIdentity?.sourceSnapshotSha256 === "string" &&
    reviewIdentity.sourceSnapshotSha256 === sourceGateIdentity?.sourceSnapshotSha256 &&
    typeof reviewIdentity?.trackedDiffSha256 === "string" &&
    reviewIdentity.trackedDiffSha256 === sourceGateIdentity?.trackedDiffSha256
  );
}

const scopeDecisions = appVersion === packageVersion ? releaseScopeDecisions(appVersion) : [];

const allRequirements: Requirement[] = [
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
    status: dmg && zip && candidateIdentity.complete ? "proved" : "missing",
    evidence: relative(candidatePath),
    detail:
      dmg && zip && candidateIdentity.complete
        ? "The app, DMG, update ZIP, blockmap and beta manifest were found and hashed."
        : `Candidate identity incomplete: ${candidateIdentity.missing.join(", ")}. Found ${dmgFiles.length} DMG and ${zipFiles.length} ZIP artifact(s).`,
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
    id: "memory-footprint",
    label: "The exact candidate stays within the 8 GB Mac memory budgets in every state",
    file: evidenceFile("footprint-8gb.json"),
    candidateBound: true,
    predicate: (artifact) => footprintReceiptQualifies(artifact, 8, "light"),
    missingDetail: "The exact-candidate 8 GB footprint receipt (qa:packaged:macos:footprint) is missing.",
    failedDetail: (artifact) =>
      artifact?.error || `Footprint gate failures: ${[...(artifact?.measurementErrors ?? []), ...footprintReceiptFailures(artifact)].join(", ") || "receipt incomplete"}.`,
  }),
  artifactRequirement({
    id: "memory-footprint-16gb",
    label: "The exact candidate stays within the 16 GB Mac memory budgets in every state",
    file: evidenceFile("footprint-16gb.json"),
    candidateBound: true,
    predicate: (artifact) => footprintReceiptQualifies(artifact, 16, "balanced"),
    missingDetail: "The exact-candidate 16 GB footprint receipt (qa:packaged:macos:footprint) is missing.",
    failedDetail: (artifact) =>
      artifact?.error || `Footprint gate failures: ${[...(artifact?.measurementErrors ?? []), ...footprintReceiptFailures(artifact)].join(", ") || "receipt incomplete"}.`,
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
    predicate: (artifact) => meetingSoakReceiptQualifies(artifact,
      fs.existsSync(candidateSidecarPath) ? sha256(candidateSidecarPath) : null),
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
        artifact?.schemaVersion === 2 &&
        artifact?.channelPolicy?.stableReleaseExists === RELEASE_CHANNEL_POLICY.stableReleaseExists &&
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

// These gates inspect local bytes and receipts only. They never launch the app.
const licenseFiles = ["LICENSE", "THIRD-PARTY-NOTICES.txt", "LICENSES.chromium.html"];
const packagedLicensesPresent = licenseFiles.every((name) => {
  const file = path.join(candidateAppPath, "Contents/Resources", name);
  return fs.existsSync(file) && fs.statSync(file).size > 0;
});
const licenses = phase === "pre" && packagedLicensesPresent
  ? spawnSync(process.execPath, [path.join(repoRoot, "scripts/generate-third-party-notices.ts"),
    "--verify-app", candidateAppPath], { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  : null;
const appBytes = candidateIdentity.appBundle?.entries.reduce(
  (total, entry) => total + (entry.type === "file" ? entry.bytes : 0), 0,
) ?? null;
const localRequirements: Requirement[] = [
  ...allRequirements.filter((requirement) => requirement.id !== "public-update-feed"),
  {
    id: "packaged-licenses", label: "Packaged licenses match the dependency graph",
    status: licenses?.status === 0 ? "proved" : "contradicted",
    evidence: relative(candidateAppPath),
    detail: licenses ? `${licenses.stdout}\n${licenses.stderr}`.trim()
      : "Packaged LICENSE, THIRD-PARTY-NOTICES.txt, or Chromium attributions are missing.",
  },
  {
    id: "package-size", label: "Packaged app is within 450 MiB",
    status: appBytes !== null && appBytes > 0 && appBytes <= 450 * 1024 * 1024 ? "proved" : "contradicted",
    evidence: relative(candidateAppPath), detail: `App bytes: ${appBytes ?? "missing"}; limit: ${450 * 1024 * 1024}.`,
  },
];
const preRequirements = localRequirements.map((requirement): Requirement => {
  const decision = scopeDecisions.find((row) => row.requirement === requirement.id);
  return decision && !decision.scope ? { ...requirement, status: "excluded by decision",
    evidence: "release-scope-exceptions.json", scopeDecision: decision,
    detail: `${decision.decision}; reason: ${decision.reason}. No passing measurement is claimed.` } : requirement;
});
let rollout: Awaited<ReturnType<typeof capturePublicReleaseRollout>> | null = null;
let rolloutError: string | null = null;
if (phase === "post") {
  try {
    if (!dmg || !zip || !appVersion) throw new Error("Missing candidate DMG, ZIP, or version.");
    const downloadBase = `https://github.com/JonathanRReed/Plainsong/releases/download/v${appVersion}/`;
    const asset = (file: string) => ({ name: path.basename(file), bytes: fs.statSync(file).size,
      sha256: sha256(file), url: new URL(path.basename(file), downloadBase).href });
    rollout = await capturePublicReleaseRollout({
      siteUrl: valueFor("--site-url", "https://plainsong.jonathanrreed.com/"),
      version: appVersion, dmg: asset(dmg), zip: asset(zip),
    });
  } catch (error) {
    rolloutError = error instanceof Error ? error.message : String(error);
  }
}
const requirements: Requirement[] = phase === "pre" ? preRequirements : [
  artifactRequirement({
    id: "pre-publication-audit", label: "Pre-publication audit passes for the exact release",
    file: evidenceFile("release-pre-audit.json"), candidateBound: true, candidateIdentityMode: "release",
    predicate: (artifact) => prePublicationAuditProvesRequirements(artifact, preRequirements.map((row) => row.id)),
    missingDetail: "The exact-candidate pre-publication audit is missing.",
    failedDetail: () => "The pre-publication audit is blocked, has the wrong phase, or is incomplete.",
  }),
  ...allRequirements.filter((requirement) => requirement.id === "public-update-feed"),
  {
    id: "public-downloads", label: "Public GitHub DMG and ZIP match candidate hashes and sizes",
    status: rollout?.downloadsPass ? "proved" : "contradicted",
    evidence: "rollout.downloads", detail: rolloutError ?? "See the public download GET receipts in this audit.",
  },
  {
    id: "site-release-metadata", label: "Public download page and llms.txt identify the published candidate",
    status: rollout?.sitePass ? "proved" : "contradicted",
    evidence: "rollout.site", detail: rolloutError ?? "Checks download links, filenames, DMG checksum, release version, and absence of pending markers.",
  },
];

const requirementStatuses: RequirementStatus[] = ["proved", "contradicted", "incomplete", "indirect", "missing", "excluded by decision", "proved with scoped exclusion"];
const counts = Object.fromEntries(
  requirementStatuses.map((status) => [
    status,
    requirements.filter((requirement) => requirement.status === status).length,
  ])
) as Record<RequirementStatus, number>;
const pass = requirements.every((requirement) => requirement.status === "proved" || requirement.status === "excluded by decision" || requirement.status === "proved with scoped exclusion");
const generatedAt = new Date().toISOString();
const report = {
  schemaVersion: 2,
  generatedAt,
  version: appVersion,
  scopeDecisions: scopeDecisions.map((decision) => ({ ...decision,
    status: decision.scope ? "scoped exclusion" : "excluded by decision" })),
  phase,
  publicationReady: phase === "pre" && pass,
  launchDone: phase === "post" && pass,
  rollout,
  rolloutError,
  candidatePath,
  pass,
  status: pass ? "PASS" : "BLOCKED",
  receiptFinal: phase === "post" && pass,
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
  `# Plainsong macOS release audit

Generated: ${generatedAt}
Phase: ${phase}
Status: ${report.status}
Final release receipt: ${report.receiptFinal ? "yes" : "no"}

Pre PASS permits publication after authorization. Post PASS closes rollout. Excluded rows record beta.7 scope decisions and do not claim passing measurements. Missing, indirect, incomplete, or contradicted evidence blocks the selected phase.

## Artifact identity

- DMG: ${report.artifacts.dmg ? `\`${report.artifacts.dmg.path}\`` : "missing"}
- DMG SHA-256: ${report.artifacts.dmg?.sha256 ?? "missing"}
- Update ZIP: ${report.artifacts.updateZip ? `\`${report.artifacts.updateZip.path}\`` : "missing"}
- Update ZIP SHA-256: ${report.artifacts.updateZip?.sha256 ?? "missing"}

## Summary

- Requirements: ${report.summary.total}
- Proved: ${report.summary.proved}
- Proved with scoped exclusion: ${report.summary["proved with scoped exclusion"]}
- Contradicted: ${report.summary.contradicted}
- Incomplete: ${report.summary.incomplete}
- Indirect: ${report.summary.indirect}
- Missing: ${report.summary.missing}
- Excluded by decision: ${report.summary["excluded by decision"]}

## Recorded scope decisions

${report.scopeDecisions.map((row) => `- ${row.requirement}${row.scope ? ` ${JSON.stringify(row.scope)}` : ""}: ${row.status}. ${row.decision}; ${row.reason}.`).join("\n") || "None for this candidate version."}

## Requirements

| ID | Status | Evidence | Detail |
| --- | --- | --- | --- |
${markdownRows}
`
);

console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
