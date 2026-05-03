#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valuesFor(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const values = [];
  for (let i = index + 1; i < args.length && !args[i].startsWith("--"); i += 1) {
    values.push(args[i]);
  }
  return values.length > 0 ? values : fallback;
}

const scanRoots = valuesFor("--roots", ["artifacts", "docs", "scripts"]);
const sensitiveEnvNames = [
  "OPENAI_API_KEY",
  "ELEVENLABS_API_KEY",
  "MISTRAL_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
  "LEMONSQUEEZY_API_KEY",
  "NAUTILUS_QA_LICENSE_KEY",
  "WINDOWS_CERTIFICATE",
  "WINDOWS_CERTIFICATE_PASSWORD",
];
const allowedExtensions = new Set([
  ".env",
  ".json",
  ".md",
  ".mjs",
  ".js",
  ".ts",
  ".tsx",
  ".ps1",
  ".toml",
  ".yml",
  ".yaml",
  ".txt",
]);
const requiredScannedFiles = [
  "docs/launch-inputs.template.env",
];

const secretPatterns = [
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ["anthropic-key", /\bsk-ant-api03-[A-Za-z0-9_-]{20,}\b/g],
  ["google-api-key", /\bAIza[A-Za-z0-9_-]{30,}\b/g],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b/g],
  ["github-fine-grained-token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ["slack-token", /\bxox(?:b|p|a|r|s)-[A-Za-z0-9-]{20,}\b/g],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/gi],
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/g],
];

function fail(message, violations = []) {
  console.error(message);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

function isTextFile(filePath) {
  const extension = path.extname(filePath);
  return allowedExtensions.has(extension);
}

function walk(dirPath, files = []) {
  if (!fs.existsSync(dirPath)) return files;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", "target", "dist", "release"].includes(entry.name)) continue;
      walk(fullPath, files);
      continue;
    }
    if (entry.isFile() && isTextFile(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

function lineFor(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

const files = scanRoots.flatMap((root) => walk(path.join(repoRoot, root)));
const violations = [];
const scannedRelativeFiles = new Set(files.map((filePath) => path.relative(repoRoot, filePath)));
for (const requiredFile of requiredScannedFiles) {
  if (fs.existsSync(path.join(repoRoot, requiredFile)) && !scannedRelativeFiles.has(requiredFile)) {
    violations.push(`Required secret-scan file was not scanned: ${requiredFile}.`);
  }
}
const envValues = sensitiveEnvNames
  .map((name) => ({ name, value: process.env[name]?.trim() ?? "" }))
  .filter((entry) => entry.value.length >= 8);

for (const filePath of files) {
  const relativePath = path.relative(repoRoot, filePath);
  const text = fs.readFileSync(filePath, "utf8");

  for (const [label, pattern] of secretPatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      violations.push(`${relativePath}:${lineFor(text, match.index ?? 0)} matches ${label}.`);
    }
  }

  for (const entry of envValues) {
    let offset = text.indexOf(entry.value);
    while (offset >= 0) {
      violations.push(`${relativePath}:${lineFor(text, offset)} contains value from ${entry.name}.`);
      offset = text.indexOf(entry.value, offset + entry.value.length);
    }
  }
}

if (violations.length > 0) {
  fail(`Secret-safe artifact validation failed (${violations.length} issues):`, violations);
}

console.log(
  `Secret-safe artifact validation passed: ${files.length} files scanned, ${envValues.length} env values checked.`
);
