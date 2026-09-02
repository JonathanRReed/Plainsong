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

function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

/**
 * The text between an opening parenthesis (already consumed at `start`) and
 * its matching close, skipping over string literals so a `)` inside a
 * `reason = "..."` cannot end the scan early.
 */
function parenthesisedBody(text, start) {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') {
        i += text[i] === "\\" ? 2 : 1;
      }
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    }
    i += 1;
  }
  return text.slice(start, Math.max(start, i - 1));
}

for (const root of scanRoots) {
  for (const filePath of walk(path.join(repoRoot, root))) {
    const relativePath = path.relative(repoRoot, filePath);
    if (relativePath === "scripts/verify-dead-code-hygiene.mjs") {
      continue;
    }
    const text = fs.readFileSync(filePath, "utf8");
    for (const match of text.matchAll(/allow\s*\(\s*dead_code\s*\)/g)) {
      violations.push(
        `${relativePath}:${lineOf(text, match.index)}: replace broad dead-code allow with deletion or a reasoned expect`,
      );
    }
    // An attribute may span lines (`#[expect(\n    dead_code,\n    reason = "..."\n)]`),
    // so the check reads the whole parenthesised body, not one line of it.
    for (const match of text.matchAll(/expect\s*\(/g)) {
      const body = parenthesisedBody(text, match.index + match[0].length);
      if (/\bdead_code\b/.test(body) && !/\breason\s*=/.test(body)) {
        violations.push(`${relativePath}:${lineOf(text, match.index)}: expect(dead_code) must include a reason`);
      }
    }
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
