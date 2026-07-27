#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const matrixTargets = [
  "Apple Notes",
  "Google Docs (Chrome)",
  "Slack",
  "Notion",
  "VS Code",
  "Cursor",
  "Messages",
  "HubSpot (Chrome)",
];
const placeholderScratchTargetPattern = /^(DISPOSABLE QA TARGET|QA scratch note)$/i;

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

function slugFor(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function fail(message, violations = []) {
  console.error(message);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

const targetApp = valueFor("--target-app", "")?.trim() ?? "";
const targetSlug = slugFor(targetApp) || "unknown-target";
const artifactPath = path.resolve(
  repoRoot,
  valueFor("--file", valueFor("--out", `artifacts/qa/macos/app-matrix-insertion-${targetSlug}.json`))
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor(
    "--markdown",
    artifactPath.replace(/\.json$/i, ".md")
  )
);

if (!fs.existsSync(artifactPath)) {
  fail(`App matrix insertion artifact not found: ${path.relative(repoRoot, artifactPath)}`);
}
if (!fs.existsSync(markdownPath)) {
  fail(`App matrix insertion Markdown not found: ${path.relative(repoRoot, markdownPath)}`);
}

const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const markdown = fs.readFileSync(markdownPath, "utf8");
const violations = [];
const expectedTargetApp = targetApp || artifact.targetApp;
const filenameSlug = path
  .basename(artifactPath)
  .replace(/^app-matrix-insertion-/i, "")
  .replace(/\.json$/i, "");

if (artifact.status !== "PASS" || artifact.pass !== true) {
  violations.push("Artifact must be PASS with pass true.");
}
if (!matrixTargets.includes(artifact.targetApp)) {
  violations.push(`targetApp must be one of the frozen matrix targets. Found ${artifact.targetApp}.`);
}
if (expectedTargetApp && artifact.targetApp !== expectedTargetApp) {
  violations.push(`Artifact targetApp ${artifact.targetApp} does not match requested target ${expectedTargetApp}.`);
}
if (slugFor(artifact.targetApp) !== filenameSlug) {
  violations.push(`Artifact targetApp slug must match filename slug ${filenameSlug}.`);
}
if (!artifact.scratchTarget?.trim()) {
  violations.push("scratchTarget must be present.");
} else if (placeholderScratchTargetPattern.test(artifact.scratchTarget.trim())) {
  violations.push("scratchTarget must not be a placeholder.");
}
if (!artifact.sampleText?.trim()) {
  violations.push("sampleText must be present.");
}
if (artifact.checks?.sidecarCommandCompleted !== true) {
  violations.push("checks.sidecarCommandCompleted must be true.");
}
if (artifact.checks?.frontmostMatchedTarget !== true) {
  violations.push("checks.frontmostMatchedTarget must be true.");
}
if (artifact.checks?.pasteReported !== true) {
  violations.push("checks.pasteReported must be true.");
}
if (artifact.checks?.manualObservationAccepted !== true) {
  violations.push("checks.manualObservationAccepted must be true.");
}
if (!["exact", "partial"].includes(artifact.observation?.result)) {
  violations.push("observation.result must be exact or partial.");
}
if (!artifact.observation?.notes?.trim()) {
  violations.push("observation.notes must explain the manual verification.");
}
if (artifact.sidecarExit?.code !== 0) {
  violations.push("sidecarExit.code must be 0.");
}
if (artifact.sidecarResult?.pasted !== true) {
  violations.push("sidecarResult.pasted must be true.");
}
if (
  !(
    (typeof artifact.sidecarResult?.targetApp === "string" &&
      artifact.sidecarResult.targetApp.length > 0) ||
    (typeof artifact.sidecarResult?.targetBundleId === "string" &&
      artifact.sidecarResult.targetBundleId.length > 0)
  )
) {
  violations.push("sidecarResult.targetApp or targetBundleId must be present.");
}

for (const line of [
  "Status: PASS",
  `- App: \`${artifact.targetApp}\``,
  `- Scratch target: \`${artifact.scratchTarget}\``,
  "- Sidecar command completed: yes",
  "- Frontmost app matched target: yes",
  "- Paste reported by sidecar: yes",
  "- Manual observation accepted: yes",
]) {
  if (!markdown.includes(line)) {
    violations.push(`Markdown is missing verified line: ${line}`);
  }
}

if (violations.length > 0) {
  fail(`App matrix insertion validation failed (${violations.length} issues):`, violations);
}

console.log(
  `App matrix insertion validation passed: ${artifact.targetApp}, observed ${artifact.observation.result}.`
);
