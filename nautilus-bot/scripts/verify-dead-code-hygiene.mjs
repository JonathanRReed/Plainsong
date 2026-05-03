#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scanRoots = ["rust-sidecar/src", "src", "electron", "scripts"];
const violations = [];

function walk(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "target" || entry.name === "node_modules") {
        continue;
      }
      files.push(...walk(fullPath));
    } else if (/\.(rs|ts|tsx|js|mjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

for (const root of scanRoots) {
  for (const filePath of walk(path.join(repoRoot, root))) {
    const relativePath = path.relative(repoRoot, filePath);
    if (relativePath === "scripts/verify-dead-code-hygiene.mjs") {
      continue;
    }
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/allow\s*\(\s*dead_code\s*\)/.test(line)) {
        violations.push(`${relativePath}:${index + 1}: replace broad dead-code allow with deletion or a reasoned expect`);
      }
      if (/expect\s*\(\s*dead_code\s*\)/.test(line) && !/reason\s*=/.test(line)) {
        violations.push(`${relativePath}:${index + 1}: expect(dead_code) must include a reason`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error(`Dead-code hygiene validation failed (${violations.length} issues):`);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("Dead-code hygiene validation passed: no broad dead-code suppressions found.");
