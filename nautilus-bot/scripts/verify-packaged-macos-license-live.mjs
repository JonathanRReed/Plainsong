#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const requiredEnv = "NAUTILUS_QA_LICENSE_KEY";
const expectedCommand = "bun run qa:packaged:macos:license-live";
const fingerprintPattern = /^\[redacted:[a-f0-9]{12}\]$/;
const secretTokenPattern = /(sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9_-]{12,}|license_[A-Za-z0-9_-]{16,})/i;
const forbiddenRawKeyPattern = /"(?:key|licenseKey|license_key)"\s*:/;

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

function fail(message, violations = []) {
  console.error(message);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

const artifactPath = path.resolve(
  repoRoot,
  valueFor("--file", "artifacts/qa/macos/licensing-activate-deactivate-live.json")
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "artifacts/qa/macos/licensing-activate-deactivate.md")
);

if (!fs.existsSync(artifactPath)) {
  fail(`Live license artifact not found: ${path.relative(repoRoot, artifactPath)}`);
}
if (!fs.existsSync(markdownPath)) {
  fail(`Live license Markdown not found: ${path.relative(repoRoot, markdownPath)}`);
}

const raw = fs.readFileSync(artifactPath, "utf8");
const artifact = JSON.parse(raw);
const markdown = fs.readFileSync(markdownPath, "utf8");
const liveKey = process.env[requiredEnv]?.trim() ?? "";
const violations = [];

if (liveKey && raw.includes(liveKey)) {
  violations.push("Artifact contains the raw live license key.");
}
if (liveKey && markdown.includes(liveKey)) {
  violations.push("Markdown contains the raw live license key.");
}
if (secretTokenPattern.test(raw.replaceAll(requiredEnv, ""))) {
  violations.push("Artifact appears to contain a token-like license value.");
}
if (forbiddenRawKeyPattern.test(raw)) {
  violations.push("Artifact must not include raw key-shaped response fields.");
}
if (artifact.status !== "PASS" || artifact.pass !== true) {
  violations.push("Live license artifact must be PASS with pass true.");
}
if (artifact.command !== expectedCommand) {
  violations.push(`command must be ${expectedCommand}.`);
}
if (artifact.requiredEnv !== requiredEnv) {
  violations.push(`requiredEnv must be ${requiredEnv}.`);
}
if (!fingerprintPattern.test(String(artifact.licenseKeyFingerprint ?? ""))) {
  violations.push("licenseKeyFingerprint must be a redacted 12 character hash.");
}
if (!String(artifact.secretPolicy ?? "").includes("License values are never written")) {
  violations.push("secretPolicy must state that license values are never written.");
}

const checks = artifact.checks ?? {};
for (const key of [
  "noTimeout",
  "activationValid",
  "validationAfterActivationValid",
  "deactivationCompleted",
  "validationAfterDeactivationNotValid",
  "rawKeyAbsentFromCacheAfterActivation",
  "rawKeyAbsentFromCacheAfterDeactivation",
]) {
  if (checks[key] !== true) {
    violations.push(`checks.${key} must be true.`);
  }
}

if (artifact.activation?.valid !== true) {
  violations.push("activation.valid must be true.");
}
if (artifact.validationAfterActivation?.valid !== true) {
  violations.push("validationAfterActivation.valid must be true.");
}
if (artifact.validationAfterDeactivation?.valid === true) {
  violations.push("validationAfterDeactivation.valid must not remain true.");
}
if (artifact.rawKeyInCacheAfterActivation !== false) {
  violations.push("rawKeyInCacheAfterActivation must be false.");
}
if (artifact.rawKeyInCacheAfterDeactivation !== false) {
  violations.push("rawKeyInCacheAfterDeactivation must be false.");
}
if (artifact.timedOut !== false) {
  violations.push("timedOut must be false.");
}
if (artifact.sidecarStderr && typeof artifact.sidecarStderr.length !== "number") {
  violations.push("sidecarStderr.length must be numeric when stderr evidence is present.");
}

if (!markdown.includes("Status: PASS")) {
  violations.push("Markdown must contain Status: PASS.");
}
for (const line of [
  "Activation returned a valid entitlement.",
  "Validation after activation returned a valid entitlement.",
  "Deactivation completed through the packaged sidecar command.",
  "The raw license key was not written to the renderer-visible license cache.",
]) {
  if (!markdown.includes(line)) {
    violations.push(`Markdown is missing verified check: ${line}`);
  }
}

if (violations.length > 0) {
  fail(`Live license validation failed (${violations.length} issues):`, violations);
}

console.log("Live license validation passed: activation, validation, deactivation, and secret hygiene verified.");
