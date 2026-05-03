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
  valueFor("--matrix", "docs/packaged-app-qa-matrix.md")
);
const handoffPath = path.resolve(
  repoRoot,
  valueFor("--handoff", "artifacts/windows-packaged-qa-handoff.json")
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "docs/windows-packaged-qa-handoff.md")
);
const runnerPath = path.resolve(
  repoRoot,
  valueFor("--runner", "scripts/windows-packaged-qa-runner.ps1")
);
const qaBundlePath = path.resolve(
  repoRoot,
  valueFor("--qa-bundle", "artifacts/packaged-qa-evidence-bundle.json")
);

const requiredReturnArtifacts = [
  "docs/evals/benchmark-run-packaged-windows.json",
  "artifacts/benchmark-packaged-windows.json",
  "artifacts/benchmark-gates-packaged-windows.json",
  "artifacts/dictation-app-matrix-gate.json",
  "artifacts/packaged-qa-evidence-bundle.json",
];

function fail(message, violations = []) {
  console.error(message);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

function parseWindowsRows(filePath) {
  const rows = [];
  let platform = null;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (/^##\s+/i.test(line)) {
      platform = line.replace(/^##\s+/i, "").trim();
      continue;
    }
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 5 || cells[0] === "Area" || cells[0] === "---") continue;
    if (platform !== "Windows") continue;
    rows.push({
      area: cells[0],
      testCase: cells[1],
      status: cells[2].toUpperCase(),
      evidence: cells[3],
      owner: cells[4],
    });
  }
  return rows;
}

function rowKey(row) {
  return `${row.area} :: ${row.testCase} :: ${row.evidence}`;
}

function isDistributionOnly(row) {
  return (
    row.area === "Install" ||
    row.area === "Security" ||
    row.area === "Updates" ||
    /signed installer|authenticode|smartscreen|stable channel/i.test(row.testCase)
  );
}

if (!fs.existsSync(matrixPath)) {
  fail(`QA matrix not found: ${path.relative(repoRoot, matrixPath)}`);
}
if (!fs.existsSync(handoffPath)) {
  fail(`Windows QA handoff JSON not found: ${path.relative(repoRoot, handoffPath)}`);
}
if (!fs.existsSync(markdownPath)) {
  fail(`Windows QA handoff Markdown not found: ${path.relative(repoRoot, markdownPath)}`);
}
if (!fs.existsSync(runnerPath)) {
  fail(`Windows QA runner not found: ${path.relative(repoRoot, runnerPath)}`);
}
if (!fs.existsSync(qaBundlePath)) {
  fail(`QA evidence bundle not found: ${path.relative(repoRoot, qaBundlePath)}`);
}

const matrixRows = parseWindowsRows(matrixPath);
const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8"));
const qaBundle = JSON.parse(fs.readFileSync(qaBundlePath, "utf8"));
const markdown = fs.readFileSync(markdownPath, "utf8");
const runner = fs.readFileSync(runnerPath, "utf8");
const handoffRows = Array.isArray(handoff.rows) ? handoff.rows : [];
const violations = [];

if (matrixRows.length === 0) {
  violations.push("No Windows rows were parsed from the packaged QA matrix.");
}
if (handoffRows.length !== matrixRows.length) {
  violations.push(
    `Handoff row count ${handoffRows.length} does not match matrix row count ${matrixRows.length}.`
  );
}

const matrixKeys = new Set(matrixRows.map(rowKey));
const handoffKeys = new Set(handoffRows.map(rowKey));
for (const key of matrixKeys) {
  if (!handoffKeys.has(key)) {
    violations.push(`Handoff is missing matrix row: ${key}`);
  }
}
for (const key of handoffKeys) {
  if (!matrixKeys.has(key)) {
    violations.push(`Handoff contains row not present in matrix: ${key}`);
  }
}

for (const row of handoffRows) {
  const expectedDistribution = isDistributionOnly(row);
  if (row.platform !== "Windows") {
    violations.push(`${rowKey(row)} has non-Windows platform: ${row.platform}`);
  }
  if (row.distributionOnly !== expectedDistribution) {
    violations.push(`${rowKey(row)} has incorrect distributionOnly flag.`);
  }
  if (row.launchBlockingProductRow !== !expectedDistribution) {
    violations.push(`${rowKey(row)} has incorrect launchBlockingProductRow flag.`);
  }
  if (!String(row.command ?? "").includes(row.evidence)) {
    violations.push(`${rowKey(row)} command does not open the evidence file.`);
  }
  if (!Array.isArray(row.acceptanceChecks) || row.acceptanceChecks.length < 3) {
    violations.push(`${rowKey(row)} needs at least three acceptance checks.`);
  }
  if (row.area === "Licensing") {
    const text = row.acceptanceChecks.join(" ");
    if (!/never write raw keys/i.test(text)) {
      violations.push(`${rowKey(row)} must include raw-license-key safety guidance.`);
    }
  }
  if (row.area === "Capture" && /Dictation hotkey/i.test(row.testCase)) {
    const text = row.acceptanceChecks.join(" ");
    if (!/safe scratch fields/i.test(text)) {
      violations.push(`${rowKey(row)} must require safe scratch fields.`);
    }
  }
}

for (const artifact of requiredReturnArtifacts) {
  if (!handoff.requiredReturnArtifacts?.includes(artifact)) {
    violations.push(`Required return artifact is missing from JSON: ${artifact}`);
  }
  if (!markdown.includes(`\`${artifact}\``)) {
    violations.push(`Required return artifact is missing from Markdown: ${artifact}`);
  }
}

if (handoff.benchmarkCommand !== "bun run benchmark:dictation:packaged:windows") {
  violations.push("benchmarkCommand must be bun run benchmark:dictation:packaged:windows.");
}
if (handoff.appMatrixCommand !== "bun run gate:app-matrix") {
  violations.push("appMatrixCommand must be bun run gate:app-matrix.");
}
if (handoff.refreshCommand !== "bun run gate:blockers:refresh") {
  violations.push("refreshCommand must be bun run gate:blockers:refresh.");
}
if (handoff.runnerPath !== path.relative(repoRoot, runnerPath)) {
  violations.push("runnerPath must point to scripts/windows-packaged-qa-runner.ps1.");
}
if (handoff.qaBundlePath !== path.relative(repoRoot, qaBundlePath)) {
  violations.push("qaBundlePath must point to artifacts/packaged-qa-evidence-bundle.json.");
}
if (!markdown.includes(`\`${path.relative(repoRoot, runnerPath)}\``)) {
  violations.push("Markdown must link the generated Windows QA runner.");
}
if (!runner.includes("bun run benchmark:dictation:packaged:windows")) {
  violations.push("Runner must execute the Windows packaged dictation benchmark.");
}
if (!runner.includes("Read-StatusFromEvidence")) {
  violations.push("Runner must validate evidence statuses.");
}
if (!runner.includes("Required return artifact is missing")) {
  violations.push("Runner must fail when required return artifacts are missing.");
}
if (!runner.includes("Test-EvidenceMetadata")) {
  violations.push("Runner must validate required evidence metadata fields.");
}
if (!runner.includes("${EscapedLabel}:")) {
  violations.push("Runner must brace the metadata label regex variable before the colon.");
}
for (const label of [
  "Build path",
  "Windows version",
  "App version",
  "Tester",
  "Timestamp",
  "Observed result",
]) {
  if (!runner.includes(label)) {
    violations.push(`Runner must require ${label} metadata.`);
  }
}
if (!runner.includes("never write raw keys")) {
  violations.push("Runner must include raw-license-key safety guidance from licensing rows.");
}

const productRows = handoffRows.filter((row) => row.launchBlockingProductRow);
const distributionRows = handoffRows.filter((row) => row.distributionOnly);
const blockedProductRows = productRows.filter((row) => row.status === "BLOCKED");
const blockedDistributionRows = distributionRows.filter((row) => row.status === "BLOCKED");
const expectedSummary = {
  totalRows: handoffRows.length,
  pass: handoffRows.filter((row) => row.status === "PASS").length,
  fail: handoffRows.filter((row) => row.status === "FAIL").length,
  blocked: handoffRows.filter((row) => row.status === "BLOCKED").length,
  pending: handoffRows.filter((row) => row.status === "PENDING").length,
  productRows: productRows.length,
  distributionRows: distributionRows.length,
  blockedProductRows: blockedProductRows.length,
  blockedDistributionRows: blockedDistributionRows.length,
};

for (const [key, value] of Object.entries(expectedSummary)) {
  if (handoff.summary?.[key] !== value) {
    violations.push(`Summary ${key} is ${handoff.summary?.[key]}, expected ${value}.`);
  }
}

const qaBundleWindowsSummary = qaBundle.summary?.byPlatform?.Windows;
if (!qaBundleWindowsSummary) {
  violations.push("QA evidence bundle is missing Windows platform summary.");
} else {
  const expectedBundleSummary = {
    total: expectedSummary.totalRows,
    pass: expectedSummary.pass,
    fail: expectedSummary.fail,
    blocked: expectedSummary.blocked,
    pending: expectedSummary.pending,
  };
  for (const [key, value] of Object.entries(expectedBundleSummary)) {
    if (qaBundleWindowsSummary[key] !== value) {
      violations.push(`QA bundle Windows summary ${key} is ${qaBundleWindowsSummary[key]}, expected ${value}.`);
    }
    if (handoff.qaBundleWindowsSummary?.[key] !== value) {
      violations.push(`Handoff QA bundle Windows summary ${key} is ${handoff.qaBundleWindowsSummary?.[key]}, expected ${value}.`);
    }
  }
  const summaryLine = `- QA bundle Windows summary: ${qaBundleWindowsSummary.pass} PASS / ${qaBundleWindowsSummary.blocked} BLOCKED / ${qaBundleWindowsSummary.pending} PENDING`;
  if (!markdown.includes(summaryLine)) {
    violations.push(`Markdown QA bundle summary line is missing or stale: ${summaryLine}`);
  }
}

for (const row of productRows) {
  if (!runner.includes(row.evidence)) {
    violations.push(`Runner is missing product evidence path: ${row.evidence}`);
  }
}

if (violations.length > 0) {
  fail(`Windows QA handoff validation failed (${violations.length} issues):`, violations);
}

console.log(
  `Windows QA handoff validation passed: ${handoffRows.length} rows, ${productRows.length} product rows, ${distributionRows.length} distribution rows.`
);
