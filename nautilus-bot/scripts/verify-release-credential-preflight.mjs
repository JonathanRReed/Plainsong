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

const artifactPath = path.resolve(
  repoRoot,
  valueFor("--file", "artifacts/release-credential-preflight.json"),
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "artifacts/release-credential-preflight.md"),
);
const secretPattern =
  /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{30,}|[A-Za-z0-9+/]{40,}={0,2})\b/g;

function fail(message, violations = []) {
  console.error(message);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

if (!fs.existsSync(artifactPath)) {
  fail(`Release credential preflight artifact not found: ${path.relative(repoRoot, artifactPath)}`);
}
if (!fs.existsSync(markdownPath)) {
  fail(`Release credential preflight markdown not found: ${path.relative(repoRoot, markdownPath)}`);
}

const raw = fs.readFileSync(artifactPath, "utf8");
const markdown = fs.readFileSync(markdownPath, "utf8");
const artifact = JSON.parse(raw);
const violations = [];

if (secretPattern.test(raw)) {
  violations.push("Artifact appears to contain a token-like secret or certificate value.");
}
if (!["READY", "BLOCKED"].includes(artifact.status)) {
  violations.push(`Invalid status: ${artifact.status}`);
}
if (!String(artifact.artifactPolicy ?? "").includes("Secret values and certificate contents are never written")) {
  violations.push("Artifact policy must state that secret values and certificate contents are never written.");
}

for (const section of ["macOS", "windows", "publish"]) {
  if (!artifact[section]) {
    violations.push(`Missing section: ${section}.`);
    continue;
  }
  if (typeof artifact[section].ready !== "boolean") {
    violations.push(`${section}.ready must be boolean.`);
  }
  if (!Array.isArray(artifact[section].requiredEnvironment)) {
    violations.push(`${section}.requiredEnvironment must be an array.`);
  }
}

const macEnv = artifact.macOS?.requiredEnvironment ?? [];
const winEnv = artifact.windows?.requiredEnvironment ?? [];
const publishEnv = artifact.publish?.requiredEnvironment ?? [];
const requiredNames = [
  "CSC_LINK or CSC_NAME",
  "CSC_KEY_PASSWORD or Keychain identity",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "WIN_CSC_LINK or WINDOWS_CERTIFICATE",
  "WIN_CSC_KEY_PASSWORD or WINDOWS_CERTIFICATE_PASSWORD",
  "GH_TOKEN or GITHUB_TOKEN",
];
const allNames = [...macEnv, ...winEnv, ...publishEnv].map((entry) => entry.name);
for (const name of requiredNames) {
  if (!allNames.includes(name)) {
    violations.push(`Missing required environment presence row: ${name}.`);
  }
}
for (const entry of [...macEnv, ...winEnv, ...publishEnv]) {
  if (typeof entry.present !== "boolean") {
    violations.push(`${entry.name} present field must be boolean.`);
  }
}

if (!markdown.includes(`Status: ${artifact.status}`)) {
  violations.push("Markdown status does not match JSON status.");
}
if (!markdown.includes("SmartScreen note:")) {
  violations.push("Markdown must include SmartScreen reputation note.");
}
if (!markdown.includes("draft GitHub release first")) {
  violations.push("Markdown must require draft release before public promotion.");
}

const shouldPass =
  artifact.macOS?.ready === true &&
  artifact.windows?.ready === true &&
  artifact.publish?.ready === true;
if (artifact.pass !== shouldPass) {
  violations.push("pass must match macOS, Windows, and publish readiness.");
}
if (artifact.status === "READY" && !shouldPass) {
  violations.push("READY status requires every release credential section to be ready.");
}
if (artifact.status === "BLOCKED" && shouldPass) {
  violations.push("BLOCKED status requires at least one release credential section to be blocked.");
}

if (violations.length > 0) {
  fail(`Release credential preflight validation failed (${violations.length} issues):`, violations);
}

console.log(
  `Release credential preflight validation passed: ${artifact.status}.`,
);
