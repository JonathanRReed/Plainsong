#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const matrixPath = path.resolve(process.cwd(), valueFor("--matrix", "docs/packaged-app-qa-matrix.md"));
const outPath = path.resolve(process.cwd(), valueFor("--out", "artifacts/packaged-qa-evidence-bundle.json"));
const repoRoot = process.cwd();

function evidenceStatusMatches(evidencePath, status) {
  const text = fs.readFileSync(evidencePath, "utf8");
  const escapedStatus = status.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const statusPatterns = [
    new RegExp(`^Status:\\s*${escapedStatus}\\b`, "im"),
    new RegExp(`^-\\s*Status:\\s*${escapedStatus}\\b`, "im"),
    new RegExp(`^Result:\\s*${escapedStatus}\\b`, "im"),
    new RegExp(`"status"\\s*:\\s*"${escapedStatus}"`, "i"),
  ];
  return statusPatterns.some((pattern) => pattern.test(text));
}

function evidenceCheck(evidence, status) {
  const evidencePath = path.resolve(repoRoot, evidence);
  const insideRepo = evidencePath.startsWith(`${repoRoot}${path.sep}`);
  const exists = insideRepo && fs.existsSync(evidencePath);
  const isFile = exists && fs.statSync(evidencePath).isFile();
  return {
    exists,
    statusMatches: isFile ? evidenceStatusMatches(evidencePath, status) : false,
  };
}

const raw = fs.readFileSync(matrixPath, "utf8");
const lines = raw.split(/\r?\n/);
const rows = [];
let currentPlatform = "";

for (const line of lines) {
  const platformHeading = line.match(/^##\s+(macOS|Windows)\s*$/i);
  if (platformHeading) {
    currentPlatform = platformHeading[1] === "macOS" ? "macOS" : "Windows";
    continue;
  }
  if (!line.startsWith("|")) continue;
  const cells = line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  if (cells.length < 5) continue;
  if (cells[0] === "Area" || cells[0] === "---") continue;

  const [area, testCase, status, evidence, owner] = cells;
  const normalizedStatus = status.toUpperCase();
  if (!["PASS", "FAIL", "BLOCKED", "PENDING"].includes(normalizedStatus)) continue;
  const evidenceStatus = evidenceCheck(evidence, normalizedStatus);

  rows.push({
    platform: currentPlatform,
    area,
    testCase,
    status: normalizedStatus,
    evidence,
    owner,
    evidenceExists: evidenceStatus.exists,
    evidenceStatusMatches: evidenceStatus.statusMatches,
  });
}

if (rows.length === 0) {
  console.error(`No QA rows parsed from ${matrixPath}`);
  process.exit(1);
}

function summarizeRows(targetRows) {
  return {
    total: targetRows.length,
    pass: targetRows.filter((row) => row.status === "PASS").length,
    fail: targetRows.filter((row) => row.status === "FAIL").length,
    blocked: targetRows.filter((row) => row.status === "BLOCKED").length,
    pending: targetRows.filter((row) => row.status === "PENDING").length,
  };
}

function isExternalDistributionQaRow(row) {
  if (row.area === "Install" || row.area === "Security" || row.area === "Updates") {
    return true;
  }
  return /notarization|gatekeeper|authenticode|smartscreen|stable channel/i.test(
    `${row.testCase} ${row.evidence}`
  );
}

const productRows = rows.filter((row) => !isExternalDistributionQaRow(row));
const externalDistributionRows = rows.filter(isExternalDistributionQaRow);

const summary = {
  total: rows.length,
  pass: rows.filter((row) => row.status === "PASS").length,
  fail: rows.filter((row) => row.status === "FAIL").length,
  blocked: rows.filter((row) => row.status === "BLOCKED").length,
  pending: rows.filter((row) => row.status === "PENDING").length,
  missingEvidence: rows.filter((row) => !row.evidenceExists).length,
  mismatchedEvidenceStatus: rows.filter((row) => !row.evidenceStatusMatches).length,
  missingPlatform: rows.filter((row) => !row.platform).length,
  byPlatform: {
    macOS: summarizeRows(rows.filter((row) => row.platform === "macOS")),
    Windows: summarizeRows(rows.filter((row) => row.platform === "Windows")),
  },
  product: summarizeRows(productRows),
  externalDistribution: summarizeRows(externalDistributionRows),
  productByPlatform: {
    macOS: summarizeRows(productRows.filter((row) => row.platform === "macOS")),
    Windows: summarizeRows(productRows.filter((row) => row.platform === "Windows")),
  },
  externalDistributionByPlatform: {
    macOS: summarizeRows(externalDistributionRows.filter((row) => row.platform === "macOS")),
    Windows: summarizeRows(externalDistributionRows.filter((row) => row.platform === "Windows")),
  },
};

const report = {
  generatedAt: new Date().toISOString(),
  matrixPath,
  summary,
  rows,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
