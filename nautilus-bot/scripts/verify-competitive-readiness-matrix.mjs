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

const matrixPath = path.resolve(
  repoRoot,
  valueFor("--matrix", "docs/competitive-readiness-matrix.md")
);
const launchReportPath = path.resolve(
  repoRoot,
  valueFor("--launch-report", "artifacts/launch-readiness-report.json")
);
const promptEvalPath = path.resolve(
  repoRoot,
  valueFor("--prompt-eval", "artifacts/dictation-prompt-eval.json")
);
const launchClaimsPath = path.resolve(
  repoRoot,
  valueFor("--launch-claims", "artifacts/launch-claim-check.json")
);
const qaBundlePath = path.resolve(
  repoRoot,
  valueFor("--qa-bundle", "artifacts/packaged-qa-evidence-bundle.json")
);

function fail(message, violations = []) {
  console.error(message);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseTable(markdown) {
  return markdown
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length === 4)
    .filter((cells) => cells[0] !== "Capability" && cells[0] !== "---")
    .map((cells) => ({
      capability: cells[0],
      bar: cells[1],
      evidence: cells[2],
      status: cells[3],
    }));
}

function evidencePaths(cell) {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

function rowFor(rows, capability) {
  return rows.find((row) => row.capability === capability);
}

function hasBlockedQaRows(bundle, areaPattern) {
  return (bundle?.rows ?? []).some(
    (row) => areaPattern.test(row.area) && row.status === "BLOCKED" && row.owner === "qa-windows"
  );
}

if (!fs.existsSync(matrixPath)) {
  fail(`Competitive readiness matrix not found: ${path.relative(repoRoot, matrixPath)}`);
}

const markdown = fs.readFileSync(matrixPath, "utf8");
const launchReport = readJson(launchReportPath);
const promptEval = readJson(promptEvalPath);
const launchClaims = readJson(launchClaimsPath);
const qaBundle = readJson(qaBundlePath);
const rows = parseTable(markdown);
const violations = [];

const requiredSources = [
  "https://wisprflow.ai",
  "https://whispur.app",
  "https://openwhispr.com",
  "https://github.com/OpenWhispr/openwhispr",
  "https://dybur.com",
  "https://docs.granola.ai/article/transcription",
  "https://docs.granola.ai/help-center/taking-notes/ai-enhanced-notes",
  "https://meetily.ai/open-source",
  "https://getwren.dev",
];

for (const source of requiredSources) {
  if (!markdown.includes(source)) {
    violations.push(`Missing competitive source: ${source}`);
  }
}

const expectedCapabilities = [
  "System-wide dictation",
  "Local-first ASR",
  "Cloud ASR choice",
  "AI cleanup and formatting",
  "Cross-platform packaged behavior",
  "Meeting transcription",
  "AI meeting notes",
  "Privacy and retention",
  "Backup and restore",
  "Launch claim discipline",
];

for (const capability of expectedCapabilities) {
  if (!rowFor(rows, capability)) {
    violations.push(`Missing competitive capability row: ${capability}`);
  }
}

for (const row of rows) {
  if (!["PASS", "BLOCKED"].includes(row.status)) {
    violations.push(`${row.capability} has invalid status ${row.status}.`);
  }
  for (const evidence of evidencePaths(row.evidence)) {
    const fullPath = path.join(repoRoot, evidence);
    if (!fs.existsSync(fullPath)) {
      violations.push(`${row.capability} references missing evidence: ${evidence}`);
    }
  }
}

const expectedStatuses = new Map([
  [
    "System-wide dictation",
    launchReport?.areas?.dictation?.appMatrixPass ? "PASS" : "BLOCKED",
  ],
  [
    "Local-first ASR",
    launchReport?.areas?.dictation?.parityFixturesPass &&
    launchReport?.areas?.dictation?.benchmarkMacosPass &&
    launchReport?.areas?.dictation?.benchmarkWindowsPass
      ? "PASS"
      : "BLOCKED",
  ],
  ["Cloud ASR choice", launchReport?.areas?.trust?.cloudSmokeReady ? "PASS" : "BLOCKED"],
  ["AI cleanup and formatting", promptEval?.summary?.allPass ? "PASS" : "BLOCKED"],
  [
    "Cross-platform packaged behavior",
    launchReport?.blockers?.some((blocker) => blocker.gate === "packaged-qa-matrix")
      ? "BLOCKED"
      : "PASS",
  ],
  [
    "Meeting transcription",
    launchReport?.areas?.meetings?.status === "PASS" ? "PASS" : "BLOCKED",
  ],
  [
    "AI meeting notes",
    hasBlockedQaRows(qaBundle, /^AI$|^Export$/) ? "BLOCKED" : "PASS",
  ],
  [
    "Privacy and retention",
    hasBlockedQaRows(qaBundle, /^Retention$/) ? "BLOCKED" : "PASS",
  ],
  [
    "Backup and restore",
    hasBlockedQaRows(qaBundle, /^Backup$/) ? "BLOCKED" : "PASS",
  ],
  ["Launch claim discipline", launchClaims?.pass ? "PASS" : "BLOCKED"],
]);

for (const [capability, expected] of expectedStatuses) {
  const row = rowFor(rows, capability);
  if (row && row.status !== expected) {
    violations.push(`${capability} status is ${row.status}, expected ${expected}.`);
  }
}

const conclusion = launchReport?.status === "GO"
  ? "The current objective is therefore ready except signing and publishing."
  : "The current objective is therefore still `NO-GO` until `docs/launch-completion-audit.md` reports `READY_EXCEPT_SIGNING_AND_PUBLISHING`.";
if (!markdown.includes(conclusion)) {
  violations.push("Readiness conclusion does not match launch report status.");
}

if (violations.length > 0) {
  fail(`Competitive readiness matrix validation failed (${violations.length} issues):`, violations);
}

const passRows = rows.filter((row) => row.status === "PASS").length;
const blockedRows = rows.filter((row) => row.status === "BLOCKED").length;
console.log(
  `Competitive readiness matrix validation passed: ${passRows} PASS, ${blockedRows} BLOCKED.`
);
