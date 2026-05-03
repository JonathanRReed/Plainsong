#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const reportPath = path.resolve(
  repoRoot,
  valueFor("--file", "artifacts/launch-readiness-report.json")
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "docs/launch-readiness-dashboard.md")
);

function fail(message, violations = []) {
  console.error(message);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

function boolStatus(value) {
  return value ? "PASS" : "BLOCKED";
}

function isFileEvidence(entry) {
  return /^(artifacts|docs|scripts|src|electron|rust-sidecar)\//.test(entry);
}

function assertFileEvidenceExists(entry, owner) {
  if (!isFileEvidence(entry)) return;
  if (!fs.existsSync(path.join(repoRoot, entry))) {
    violations.push(`${owner} references missing evidence file: ${entry}`);
  }
}

function areaRow(area, status, currentRead) {
  return `| ${area} | \`${status}\` | ${currentRead} |`;
}

if (!fs.existsSync(reportPath)) {
  fail(`Launch readiness report JSON not found: ${path.relative(repoRoot, reportPath)}`);
}
if (!fs.existsSync(markdownPath)) {
  fail(`Launch readiness dashboard Markdown not found: ${path.relative(repoRoot, markdownPath)}`);
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const markdown = fs.readFileSync(markdownPath, "utf8");
const violations = [];
const blockers = Array.isArray(report.blockers) ? report.blockers : [];
const externalBlockers = Array.isArray(report.externalBlockers) ? report.externalBlockers : [];
const nextActions = Array.isArray(report.nextActions) ? report.nextActions : [];
const areas = report.areas ?? {};

if (!["GO", "NO-GO"].includes(report.status)) {
  violations.push(`Invalid launch readiness status: ${report.status}`);
}
if (!markdown.includes(`Overall status: \`${report.status}\``)) {
  violations.push("Markdown overall status does not match JSON status.");
}

const expectedAreaRows = [
  areaRow(
    "Dictation",
    areas.dictation?.status,
    `Local benchmark gates pass on macOS and Windows, packaged benchmark gates are ${areas.dictation?.packagedBenchmarkMacosPass ? "PASS" : "BLOCKED"} on macOS and ${areas.dictation?.packagedBenchmarkWindowsPass ? "PASS" : "BLOCKED"} on Windows, and the launch app matrix is still ${areas.dictation?.appMatrixSummary?.ready}/${areas.dictation?.appMatrixSummary?.total} ready with ${areas.dictation?.appMatrixSummary?.pending} pending.`
  ),
  areaRow(
    "Meetings",
    areas.meetings?.status,
    `Packaged meeting QA remains ${areas.meetings?.qaSummary?.blocked} blocked rows out of ${areas.meetings?.qaSummary?.total}.`
  ),
  areaRow(
    "Trust",
    areas.trust?.status,
    "Internal hardening is in place, but release credentials and packaged trust evidence are still incomplete."
  ),
  areaRow(
    "Launch claims",
    areas.launchClaims?.status,
    "App and language claims still exceed the packaged evidence currently checked into the repo."
  ),
];

for (const row of expectedAreaRows) {
  if (!markdown.includes(row)) {
    violations.push(`Markdown area status row is missing or stale: ${row}`);
  }
}

const dictation = areas.dictation ?? {};
const dictationSummary = dictation.appMatrixSummary ?? {};
const dictationLines = [
  `- macOS benchmark gate: \`${dictation.benchmarkMacosPass ? "PASS" : "FAIL"}\``,
  `- Windows benchmark gate: \`${dictation.benchmarkWindowsPass ? "PASS" : "FAIL"}\``,
  `- macOS packaged benchmark gate: \`${dictation.packagedBenchmarkMacosPass ? "PASS" : "BLOCKED"}\``,
  `- Windows packaged benchmark gate: \`${dictation.packagedBenchmarkWindowsPass ? "PASS" : "BLOCKED"}\``,
  `- Dictation parity fixtures: \`${dictation.parityFixturesPass ? "PASS" : "FAIL"}\``,
  `- Prompt regression fixtures: \`${dictation.promptEvalPass ? "PASS" : "FAIL"}\``,
  `- App matrix gate: \`${dictation.appMatrixPass ? "PASS" : "BLOCKED"}\``,
  `- Launch app matrix: ${dictationSummary.ready}/${dictationSummary.total} ready, ${dictationSummary.supported} supported, ${dictationSummary.partial} partial, ${dictationSummary.clipboardOnly} clipboard-only, ${dictationSummary.pending} pending`,
  `- Missing insertion evidence: ${dictationSummary.missingInsertionEvidence}`,
  `- Rejected insertion evidence artifacts: ${dictationSummary.rejectedInsertionEvidence}`,
  `- Missing packaged benchmark evidence: ${dictationSummary.missingPackagedEvidence}`,
  `- Invalid app-matrix evidence artifacts: ${(dictation.appMatrixEvidenceViolations ?? []).length}`,
];

for (const line of dictationLines) {
  if (!markdown.includes(line)) {
    violations.push(`Markdown dictation line is missing or stale: ${line}`);
  }
}

const meetings = areas.meetings ?? {};
const meetingLines = [
  `- Packaged QA rows in meeting-critical areas: ${meetings.qaSummary?.total}`,
  `- Blocked rows in meeting-critical areas: ${meetings.qaSummary?.blocked}`,
  `- Passed rows in meeting-critical areas: ${meetings.qaSummary?.pass}`,
];
for (const line of meetingLines) {
  if (!markdown.includes(line)) {
    violations.push(`Markdown meetings line is missing or stale: ${line}`);
  }
}

const trust = areas.trust ?? {};
const trustLines = [
  `- Local release path: \`${trust.localReleasePass ? "PASS" : "FAIL"}\``,
  `- QA evidence files present: \`${trust.qaEvidenceSummary?.missingEvidence === 0 ? "PASS" : "BLOCKED"}\``,
  `- QA evidence status matches matrix: \`${trust.qaEvidenceSummary?.mismatchedEvidenceStatus === 0 ? "PASS" : "BLOCKED"}\``,
  `- QA evidence platform ownership: \`${trust.qaEvidenceSummary?.missingPlatform === 0 ? "PASS" : "BLOCKED"}\``,
  `- macOS packaged QA: ${trust.qaEvidenceSummary?.byPlatform?.macOS?.pass ?? 0} PASS / ${trust.qaEvidenceSummary?.byPlatform?.macOS?.blocked ?? 0} BLOCKED / ${trust.qaEvidenceSummary?.byPlatform?.macOS?.pending ?? 0} PENDING`,
  `- Windows packaged QA: ${trust.qaEvidenceSummary?.byPlatform?.Windows?.pass ?? 0} PASS / ${trust.qaEvidenceSummary?.byPlatform?.Windows?.blocked ?? 0} BLOCKED / ${trust.qaEvidenceSummary?.byPlatform?.Windows?.pending ?? 0} PENDING`,
  `- Non-external packaged QA: ${trust.qaEvidenceSummary?.product?.pass ?? 0} PASS / ${trust.qaEvidenceSummary?.product?.blocked ?? 0} BLOCKED / ${trust.qaEvidenceSummary?.product?.pending ?? 0} PENDING`,
  `- External distribution QA: ${trust.qaEvidenceSummary?.externalDistribution?.pass ?? 0} PASS / ${trust.qaEvidenceSummary?.externalDistribution?.blocked ?? 0} BLOCKED / ${trust.qaEvidenceSummary?.externalDistribution?.pending ?? 0} PENDING`,
  `- Cloud smoke ready: \`${boolStatus(trust.cloudSmokeReady)}\``,
  `- Apple release signing ready: \`${boolStatus(trust.appleReleaseSigningReady)}\``,
  `- Windows release signing ready: \`${boolStatus(trust.windowsReleaseSigningReady)}\``,
];
for (const line of trustLines) {
  if (!markdown.includes(line)) {
    violations.push(`Markdown trust line is missing or stale: ${line}`);
  }
}
if (trust.qaEvidenceSummary?.missingPlatform !== 0) {
  violations.push("Launch readiness report requires zero QA rows with missing platform ownership.");
}
if (
  trust.qaEvidenceSummary?.byPlatform?.macOS?.total !== 27 ||
  trust.qaEvidenceSummary?.byPlatform?.Windows?.total !== 25
) {
  violations.push("Launch readiness report must preserve 27 macOS QA rows and 25 Windows QA rows.");
}

const launchClaims = areas.launchClaims ?? {};
const launchClaimsLines = [
  `- Verified launch apps ready for marketing: ${(launchClaims.appMatrixSummary?.supported ?? 0) + (launchClaims.appMatrixSummary?.partial ?? 0)} of ${launchClaims.appMatrixSummary?.total}`,
  `- Languages with packaged evidence: ${launchClaims.languageMatrixSummary?.packagedPass} of ${launchClaims.languageMatrixSummary?.total}`,
];
for (const line of launchClaimsLines) {
  if (!markdown.includes(line)) {
    violations.push(`Markdown launch-claims line is missing or stale: ${line}`);
  }
}

for (const blocker of blockers) {
  if (["apple-release-signing", "windows-release-signing"].includes(blocker.gate)) {
    violations.push(`Signing blocker is incorrectly listed as active completion blocker: ${blocker.gate}.`);
  }
  if (!blocker.gate || !blocker.reason || !blocker.evidence) {
    violations.push(`Malformed blocker entry: ${blocker.gate ?? "missing gate"}`);
    continue;
  }
  assertFileEvidenceExists(blocker.evidence, blocker.gate);
  const line = `- \`${blocker.gate}\`: ${blocker.reason} (${blocker.evidence})`;
  if (!markdown.includes(line)) {
    violations.push(`Markdown blocker list is missing or stale for ${blocker.gate}.`);
  }
}

for (const blocker of externalBlockers) {
  if (!["apple-release-signing", "windows-release-signing"].includes(blocker.gate)) {
    violations.push(`Non-signing blocker is incorrectly listed as external: ${blocker.gate}.`);
  }
  if (!blocker.gate || !blocker.reason || !blocker.evidence) {
    violations.push(`Malformed external blocker entry: ${blocker.gate ?? "missing gate"}`);
    continue;
  }
  assertFileEvidenceExists(blocker.evidence, blocker.gate);
  const line = `- \`${blocker.gate}\`: ${blocker.reason} (${blocker.evidence})`;
  if (!markdown.includes(line)) {
    violations.push(`Markdown external blocker list is missing or stale for ${blocker.gate}.`);
  }
}

for (const [index, action] of nextActions.entries()) {
  const line = `${index + 1}. ${action}`;
  if (!markdown.includes(line)) {
    violations.push(`Markdown next action is missing or stale: ${line}`);
  }
}

const requiredEvidence = [
  "releaseBlockers",
  "qaBundle",
  "benchmarkMacos",
  "benchmarkWindows",
  "packagedBenchmarkMacos",
  "packagedBenchmarkWindows",
  "dictationParity",
  "dictationPromptEval",
  "appMatrixGate",
  "appMatrix",
  "completionAudit",
  "launchUnblockerPack",
  "windowsQaHandoff",
  "windowsQaRunner",
  "languageMatrix",
];
for (const key of requiredEvidence) {
  if (!report.evidence?.[key]) {
    violations.push(`Report evidence map is missing ${key}.`);
    continue;
  }
  assertFileEvidenceExists(report.evidence[key], key);
}

const controlArtifactLines = [
  `- Completion audit: \`${report.evidence?.completionAudit}\``,
  `- Launch unblocker pack: \`${report.evidence?.launchUnblockerPack}\``,
  `- Windows QA handoff: \`${report.evidence?.windowsQaHandoff}\``,
];
for (const line of controlArtifactLines) {
  if (!markdown.includes(line)) {
    violations.push(`Markdown control artifact line is missing or stale: ${line}`);
  }
}

for (const [key, evidence] of Object.entries(report.evidence ?? {})) {
  if (!requiredEvidence.includes(key)) {
    assertFileEvidenceExists(evidence, key);
  }
}

if (violations.length > 0) {
  fail(`Launch readiness report validation failed (${violations.length} issues):`, violations);
}

console.log(
  `Launch readiness report validation passed: ${report.status}, ${blockers.length} active blockers.`
);
