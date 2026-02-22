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

const violations = [];
let rowCount = 0;

for (const line of lines) {
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

  if (normalizedStatus === "PENDING") {
    violations.push(`${key} -> status is still PENDING`);
  }
  if (!evidence) {
    violations.push(`${key} -> evidence cell is empty`);
  }
  if (!owner) {
    violations.push(`${key} -> owner cell is empty`);
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
