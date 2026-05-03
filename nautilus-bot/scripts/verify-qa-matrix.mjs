#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const fileArgIndex = args.indexOf("--file");
const matrixPath =
  fileArgIndex >= 0 && fileArgIndex < args.length - 1
    ? path.resolve(process.cwd(), args[fileArgIndex + 1])
    : path.resolve(process.cwd(), "docs/packaged-app-qa-matrix.md");

const raw = fs.readFileSync(matrixPath, "utf8");
const lines = raw.split(/\r?\n/);
const repoRoot = process.cwd();

const violations = [];
let rowCount = 0;
let currentPlatform = "";

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

  rowCount += 1;
  const key = `${area} :: ${testCase}`;

  if (!currentPlatform) {
    violations.push(`${key} -> row is not under a supported platform heading`);
  }
  if (normalizedStatus === "PENDING") {
    violations.push(`${key} -> status is still PENDING`);
  }
  if (!owner) {
    violations.push(`${key} -> owner cell is empty`);
  } else if (currentPlatform === "macOS" && owner !== "qa-macos") {
    violations.push(`${key} -> macOS row owner must be qa-macos`);
  } else if (currentPlatform === "Windows" && owner !== "qa-windows") {
    violations.push(`${key} -> Windows row owner must be qa-windows`);
  }
  if (!evidence) {
    violations.push(`${key} -> evidence cell is empty`);
    continue;
  }
  if (
    normalizedStatus === "PASS" &&
    /^(tbd|todo|pending)$/i.test(String(evidence).trim())
  ) {
    violations.push(`${key} -> PASS rows must not use placeholder evidence`);
  }

  const evidencePath = path.resolve(repoRoot, evidence);
  if (!evidencePath.startsWith(`${repoRoot}${path.sep}`)) {
    violations.push(`${key} -> evidence path must stay inside the repo`);
    continue;
  }
  if (currentPlatform && !evidence.includes(`/qa/${currentPlatform.toLowerCase()}/`)) {
    violations.push(`${key} -> evidence path must live under artifacts/qa/${currentPlatform.toLowerCase()}`);
  }
  if (!fs.existsSync(evidencePath)) {
    violations.push(`${key} -> evidence file is missing: ${evidence}`);
    continue;
  }
  if (!fs.statSync(evidencePath).isFile()) {
    violations.push(`${key} -> evidence path is not a file: ${evidence}`);
    continue;
  }
  if (!evidenceStatusMatches(evidencePath, normalizedStatus)) {
    violations.push(
      `${key} -> evidence file does not contain matching ${normalizedStatus} status: ${evidence}`
    );
  }
}

if (rowCount === 0) {
  console.error(`No QA matrix rows detected in ${matrixPath}`);
  process.exit(1);
}

if (violations.length > 0) {
  console.error(`QA matrix validation failed (${violations.length} issues):`);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(`QA matrix validation passed: ${rowCount} rows in ${matrixPath}`);
