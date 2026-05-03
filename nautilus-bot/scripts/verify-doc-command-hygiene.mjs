#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const docs = [
  "README.md",
  "docs/launch-readiness-dashboard.md",
  "docs/launch-completion-audit.md",
  "docs/launch-unblocker-pack.md",
  "docs/final-ship-checklist.md",
  "docs/prelaunch-readiness.md",
  "docs/prelaunch-action-checklist.md",
  "docs/release-gate-evidence.md",
  "docs/packaged-app-qa-matrix.md",
  "docs/strict-release-blocker-register.md",
  "docs/windows-packaged-qa-handoff.md",
  "docs/launch-execution-plan.md",
];

const forbidden = [
  /\bnpm\s+(install|run|test|ci|audit)\b/i,
  /\bnpm\s/i,
  /\bbun\s+run\s+tauri\b/i,
  /\btauri\s+(dev|build)\b/i,
  /\bsrc-tauri\//i,
];

const staleStatusPatterns = [
  {
    pattern: /Current matrix is `49 BLOCKED \/ 0 PASS`/i,
    message: "stale packaged QA matrix count",
  },
  {
    pattern: /still has `16` pending rows/i,
    message: "stale app-matrix pending count",
  },
];
const qaAggregateText = "21 PASS / 31 BLOCKED / 0 PENDING";
const qaMacosText = "21 PASS / 6 BLOCKED / 0 PENDING";
const qaWindowsText = "0 PASS / 25 BLOCKED / 0 PENDING";

const allowed = [
  {
    path: "docs/release-gate-evidence.md",
    text: "stale npm lockfile",
  },
];

function isAllowed(relativePath, line) {
  return allowed.some((entry) => entry.path === relativePath && line.includes(entry.text));
}

const violations = [];

for (const relativePath of docs) {
  const filePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(filePath)) {
    violations.push(`${relativePath}: missing launch-facing doc`);
    continue;
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const docText = lines.join("\n");
  if (
    docText.includes(qaAggregateText) &&
    (!docText.includes(qaMacosText) || !docText.includes(qaWindowsText))
  ) {
    violations.push(
      `${relativePath}: aggregate packaged QA count must include macOS and Windows platform splits`
    );
  }
  lines.forEach((line, index) => {
    if (isAllowed(relativePath, line)) {
      return;
    }
    if (forbidden.some((pattern) => pattern.test(line))) {
      violations.push(`${relativePath}:${index + 1}: ${line.trim()}`);
    }
    for (const stale of staleStatusPatterns) {
      if (stale.pattern.test(line)) {
        violations.push(`${relativePath}:${index + 1}: ${stale.message}: ${line.trim()}`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error(`Doc command hygiene validation failed (${violations.length} issues):`);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(`Doc command hygiene validation passed: ${docs.length} launch docs scanned.`);
