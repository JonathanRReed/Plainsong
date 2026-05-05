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
  valueFor("--report", "artifacts/competitive-parity-report.json")
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "docs/competitive-parity-report.md")
);
const launchReportPath = path.resolve(
  repoRoot,
  valueFor("--launch-report", "artifacts/launch-readiness-report.json")
);
const matrixPath = path.resolve(
  repoRoot,
  valueFor("--matrix", "docs/competitive-readiness-matrix.md")
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
    fail(`Missing JSON file: ${path.relative(repoRoot, filePath)}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseCompetitiveRows(markdown) {
  return markdown
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length === 4)
    .filter((cells) => cells[0] !== "Capability" && cells[0] !== "---")
    .map((cells) => ({
      capability: cells[0],
      status: cells[3],
    }));
}

if (!fs.existsSync(markdownPath)) {
  fail(`Missing markdown file: ${path.relative(repoRoot, markdownPath)}`);
}
if (!fs.existsSync(matrixPath)) {
  fail(`Missing matrix file: ${path.relative(repoRoot, matrixPath)}`);
}

const report = readJson(reportPath);
const launchReport = readJson(launchReportPath);
const markdown = fs.readFileSync(markdownPath, "utf8");
const matrixMarkdown = fs.readFileSync(matrixPath, "utf8");
const matrixRows = parseCompetitiveRows(matrixMarkdown);
const matrixPass = matrixRows.filter((row) => row.status === "PASS").length;
const matrixBlocked = matrixRows.filter((row) => row.status === "BLOCKED").length;
const violations = [];

const requiredSources = [
  "https://wisprflow.ai/features",
  "https://superwhisper.com/models",
  "https://docs.granola.ai/help-center/getting-started/granola-101",
  "https://docs.granola.ai/article/integrations-with-granola",
  "https://github.com/yazinsai/OpenOats",
];

if (!["PARITY_OR_BETTER_READY", "BLOCKED"].includes(report.status)) {
  violations.push(`Invalid status: ${report.status}`);
}
if (!["PARITY_OR_BETTER_CLAIM_ALLOWED", "DO_NOT_CLAIM_PARITY_OR_BETTER"].includes(report.claimDecision)) {
  violations.push(`Invalid claim decision: ${report.claimDecision}`);
}
if (report.summary?.competitiveRows?.pass !== matrixPass) {
  violations.push("Competitive PASS count does not match matrix.");
}
if (report.summary?.competitiveRows?.blocked !== matrixBlocked) {
  violations.push("Competitive BLOCKED count does not match matrix.");
}
if (report.summary?.launchStatus !== launchReport.status) {
  violations.push("Launch status does not match launch readiness report.");
}

const shouldBeReady = launchReport.status === "GO" && matrixBlocked === 0;
if (shouldBeReady && report.status !== "PARITY_OR_BETTER_READY") {
  violations.push("Report must be ready when launch report is GO and no competitive rows are blocked.");
}
if (!shouldBeReady && report.status !== "BLOCKED") {
  violations.push("Report must be BLOCKED while launch report is not GO or matrix has blocked rows.");
}
if (!shouldBeReady && report.claimDecision !== "DO_NOT_CLAIM_PARITY_OR_BETTER") {
  violations.push("Blocked report must forbid parity-or-better claims.");
}
if (!shouldBeReady && !markdown.includes("Do not claim parity-or-better yet.")) {
  violations.push("Blocked markdown must explicitly forbid parity-or-better claims.");
}
if (shouldBeReady && markdown.includes("Do not claim parity-or-better yet.")) {
  violations.push("Ready markdown must not include the blocked parity warning.");
}

for (const source of requiredSources) {
  if (!markdown.includes(source)) {
    violations.push(`Markdown missing source: ${source}`);
  }
  const hasSource = (report.sourceRegister ?? []).some((entry) =>
    (entry.urls ?? []).includes(source)
  );
  if (!hasSource) {
    violations.push(`JSON missing source: ${source}`);
  }
}

for (const blocker of launchReport.blockers ?? []) {
  const covered = (report.activeBlockers ?? []).some((item) => item.gate === blocker.gate);
  if (!covered) {
    violations.push(`Missing active blocker in parity report: ${blocker.gate}`);
  }
}
for (const row of matrixRows.filter((item) => item.status === "BLOCKED")) {
  const covered = (report.topGaps ?? []).some((item) => item.capability === row.capability);
  if (!covered) {
    violations.push(`Missing blocked capability in top gaps: ${row.capability}`);
  }
}

if (violations.length > 0) {
  fail(`Competitive parity report validation failed (${violations.length} issues):`, violations);
}

console.log(
  `Competitive parity report validation passed: ${report.status}, ${matrixPass} PASS / ${matrixBlocked} BLOCKED.`
);
