#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
const qaPath = path.join(candidatePath, "qa");
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", path.join(qaPath, "release-readiness-audit.json"))
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", path.join(qaPath, "release-readiness-audit.md"))
);

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
  const proved = Boolean(predicate(artifact));
  return {
    id,
    label,
    status: proved ? "proved" : "contradicted",
    evidence: relative(file),
    detail: proved
      ? "The exact-candidate evidence passes its required checks."
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
const trustPath = evidenceFile("macos-trust.json");
const trust = readJson(trustPath);
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
  nonDistributionTrustChecks.length > 0 &&
  nonDistributionTrustChecks.every(([, passed]) => passed === true);

const requirements = [
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
    missingDetail: "The exact-candidate update metadata artifact is missing.",
    failedDetail: () => "The update metadata verifier reports a mismatch or missing artifact.",
  }),
  artifactRequirement({
    id: "local-transcription",
    label: "Real local Whisper transcription passes",
    file: evidenceFile("transcription-whisper-e2e.json"),
    missingDetail: "The exact-candidate real-model transcription artifact is missing.",
    failedDetail: (artifact) =>
      artifact?.error || "The real local Whisper transcription checks did not all pass.",
  }),
  artifactRequirement({
    id: "backup-restore",
    label: "Backup and restore preserve settings and data",
    file: evidenceFile("backup-create-restore.json"),
    missingDetail: "The exact-candidate backup and restore artifact is missing.",
    failedDetail: (artifact) =>
      artifact?.error || "The backup and restore checks did not all pass.",
  }),
  artifactRequirement({
    id: "retention",
    label: "Every retention policy passes",
    file: evidenceFile("retention-policies.json"),
    missingDetail: "The exact-candidate retention artifact is missing.",
    failedDetail: (artifact) =>
      artifact?.error || "One or more retention-policy scenarios failed.",
  }),
  artifactRequirement({
    id: "exports",
    label: "Standard exports and meeting templates pass",
    file: evidenceFile("exports.json"),
    missingDetail: "The exact-candidate export artifact is missing.",
    failedDetail: (artifact) =>
      artifact?.error || "One or more export or template checks failed.",
  }),
  artifactRequirement({
    id: "host-matrix",
    label: "Every required macOS host row has verifier-clean support evidence",
    file: evidenceFile("app-matrix-preflight.json"),
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
    file: evidenceFile("meeting-mic.json"),
    missingDetail: "The exact-candidate microphone meeting artifact is missing.",
    failedDetail: (artifact) =>
      artifact?.error || "The microphone meeting checks did not all pass.",
  }),
  artifactRequirement({
    id: "meeting-system-audio",
    label: "Real system-audio capture passes with a known tone",
    file: evidenceFile("system-audio-test.json"),
    missingDetail: "The exact-candidate system-audio artifact is missing.",
    failedDetail: (artifact) =>
      artifact?.result?.capability?.actionableReason ||
      artifact?.reason ||
      "The known-tone system-audio checks did not all pass.",
  }),
  artifactRequirement({
    id: "source-gates",
    label: "Current source lint, tests, builds, IPC, dead-code, and dependency gates pass",
    file: evidenceFile("source-gates.json"),
    missingDetail:
      "A current-revision source-gate receipt has not been attached to this candidate.",
    failedDetail: (artifact) =>
      artifact?.error || "One or more current source gates failed.",
  }),
  artifactRequirement({
    id: "rendered-first-run",
    label: "Rendered first-run and daily UX pass on the exact candidate",
    file: evidenceFile("rendered-ux.json"),
    missingDetail:
      "A machine-readable rendered UX walkthrough is not attached to this candidate.",
    failedDetail: (artifact) =>
      artifact?.error || "One or more rendered UX checks failed.",
  }),
  artifactRequirement({
    id: "security-scan",
    label: "Current-revision security scan is complete with no unresolved launch finding",
    file: evidenceFile("security-scan.json"),
    missingDetail:
      "The Codex Security scan has not produced an exact-candidate completion artifact.",
    failedDetail: (artifact) =>
      artifact?.error || "The security scan is incomplete or has unresolved launch findings.",
  }),
  {
    id: "apple-distribution",
    label: "App, DMG, and ZIP are Apple accepted, stapled, and Gatekeeper approved",
    status: trust?.pass === true ? "proved" : trust ? "incomplete" : "missing",
    evidence: relative(trustPath),
    detail:
      trust?.pass === true
        ? "The exact release passes the complete macOS trust gate."
        : "The exact release is signed but still lacks notarization tickets, stapling, or Gatekeeper acceptance.",
  },
  artifactRequirement({
    id: "clean-install",
    label: "Quarantined clean install and first-run permission flow pass",
    file: evidenceFile("clean-install.json"),
    missingDetail: "No exact-candidate clean-install artifact exists yet.",
    failedDetail: (artifact) =>
      artifact?.error || "The clean-install or permission walkthrough failed.",
  }),
  artifactRequirement({
    id: "signed-updater",
    label: "Signed and notarized N-to-N+1 updater flow preserves user state",
    file: evidenceFile("updater-n-to-n-plus-1.json"),
    missingDetail: "No signed N-to-N+1 updater acceptance artifact exists yet.",
    failedDetail: (artifact) =>
      artifact?.error || "The signed updater acceptance checks failed.",
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
process.exit(0);
