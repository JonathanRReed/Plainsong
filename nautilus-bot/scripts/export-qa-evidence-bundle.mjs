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

const raw = fs.readFileSync(matrixPath, "utf8");
const lines = raw.split(/\r?\n/);
const rows = [];

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

  rows.push({
    area,
    testCase,
    status: normalizedStatus,
    evidence,
    owner,
  });
}

if (rows.length === 0) {
  console.error(`No QA rows parsed from ${matrixPath}`);
  process.exit(1);
}

const summary = {
  total: rows.length,
  pass: rows.filter((row) => row.status === "PASS").length,
  fail: rows.filter((row) => row.status === "FAIL").length,
  blocked: rows.filter((row) => row.status === "BLOCKED").length,
  pending: rows.filter((row) => row.status === "PENDING").length,
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
