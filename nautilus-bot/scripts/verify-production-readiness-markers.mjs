#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const roots = ["src", "electron", "rust-sidecar/src"];
const sourceExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".rs",
  ".ts",
  ".tsx",
]);
const markerPattern = /\b(TODO|FIXME|HACK|XXX)\b|stubbed|Phase 2\.6|coming soon|not implemented/i;
const allowedMarkers = [
  {
    path: "rust-sidecar/src/asr/manager.rs",
    text: "execution path is not implemented in this build",
  },
  {
    path: "rust-sidecar/src/lib.rs",
    text: '-25208 => "not implemented"',
  },
  {
    path: "rust-sidecar/src/lib.rs",
    text: "Clipboard copy is not implemented on this platform yet.",
  },
  {
    path: "rust-sidecar/src/lib.rs",
    text: "Clipboard read is not implemented on this platform yet.",
  },
  {
    path: "rust-sidecar/src/lib.rs",
    text: "System-wide paste is not implemented on this platform yet.",
  },
];

function walk(relativeRoot) {
  const fullRoot = path.join(repoRoot, relativeRoot);
  if (!fs.existsSync(fullRoot)) {
    return [];
  }

  const results = [];
  for (const entry of fs.readdirSync(fullRoot, { withFileTypes: true })) {
    const relativePath = path.join(relativeRoot, entry.name);
    if (shouldSkip(relativePath, entry)) {
      continue;
    }
    if (entry.isDirectory()) {
      results.push(...walk(relativePath));
      continue;
    }
    if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      results.push(relativePath);
    }
  }
  return results;
}

function shouldSkip(relativePath, entry) {
  const normalized = relativePath.split(path.sep).join("/");
  if (entry.isDirectory()) {
    return (
      normalized.endsWith("/__tests__") ||
      normalized.endsWith("/test") ||
      normalized.endsWith("/tests") ||
      normalized.includes("/target/")
    );
  }

  return (
    /\.test\.[cm]?[jt]sx?$/.test(normalized) ||
    /\.spec\.[cm]?[jt]sx?$/.test(normalized)
  );
}

function isAllowed(relativePath, line) {
  const normalized = relativePath.split(path.sep).join("/");
  return allowedMarkers.some(
    (entry) => entry.path === normalized && line.includes(entry.text)
  );
}

const violations = [];
const files = roots.flatMap(walk).sort();

for (const relativePath of files) {
  const body = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
  const lines = body.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!markerPattern.test(line)) {
      return;
    }
    if (isAllowed(relativePath, line)) {
      return;
    }
    const normalized = relativePath.split(path.sep).join("/");
    violations.push(`${normalized}:${index + 1}: ${line.trim()}`);
  });
}

if (violations.length > 0) {
  console.error(
    `Production readiness marker validation failed (${violations.length} issues):`
  );
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(
  `Production readiness marker validation passed: ${files.length} production source files scanned.`
);
