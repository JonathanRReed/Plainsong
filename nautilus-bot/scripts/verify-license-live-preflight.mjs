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
  valueFor("--file", "artifacts/qa/macos/licensing-activate-deactivate-live.json")
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "artifacts/qa/macos/licensing-activate-deactivate.md")
);
const requiredEnv = "NAUTILUS_QA_LICENSE_KEY";
const secretPattern = /(license[_-]?key|sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{40,})/i;

function fail(message, violations = []) {
  console.error(message);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

if (!fs.existsSync(artifactPath)) {
  fail(`License live preflight artifact not found: ${path.relative(repoRoot, artifactPath)}`);
}
if (!fs.existsSync(markdownPath)) {
  fail(`License live preflight Markdown not found: ${path.relative(repoRoot, markdownPath)}`);
}

const raw = fs.readFileSync(artifactPath, "utf8");
const artifact = JSON.parse(raw);
const markdown = fs.readFileSync(markdownPath, "utf8");
const violations = [];

if (secretPattern.test(raw.replaceAll(requiredEnv, ""))) {
  violations.push("Artifact appears to contain a token-like license value.");
}
if (!["READY", "BLOCKED", "PASS", "FAIL"].includes(artifact.status)) {
  violations.push(`Invalid status: ${artifact.status}`);
}
if (artifact.command !== "bun run qa:packaged:macos:license-live") {
  violations.push("Command must be bun run qa:packaged:macos:license-live.");
}
if (artifact.requiredEnv !== requiredEnv) {
  violations.push(`requiredEnv must be ${requiredEnv}.`);
}
if (typeof artifact.requiredEnvPresent !== "boolean") {
  violations.push("requiredEnvPresent must be boolean.");
}
if (typeof artifact.sidecarExists !== "boolean") {
  violations.push("sidecarExists must be boolean.");
}
if (!String(artifact.secretPolicy ?? "").includes("License values are never written")) {
  violations.push("secretPolicy must state that license values are never written.");
}
if (!markdown.includes("Status: BLOCKED") && artifact.status === "BLOCKED") {
  violations.push("Markdown must contain matching BLOCKED status.");
}
if (!markdown.includes(requiredEnv)) {
  violations.push(`Markdown must name ${requiredEnv}.`);
}
if (!markdown.includes("License values are never written")) {
  violations.push("Markdown must include secret policy.");
}
if (artifact.status === "READY" && (!artifact.requiredEnvPresent || !artifact.sidecarExists)) {
  violations.push("READY status requires env key and packaged sidecar.");
}
if (artifact.status === "BLOCKED" && artifact.requiredEnvPresent && artifact.sidecarExists) {
  violations.push("BLOCKED preflight needs a missing key or missing sidecar.");
}

if (violations.length > 0) {
  fail(`License live preflight validation failed (${violations.length} issues):`, violations);
}

console.log(
  `License live preflight validation passed: ${artifact.status}, key present ${artifact.requiredEnvPresent ? "yes" : "no"}, sidecar present ${artifact.sidecarExists ? "yes" : "no"}.`
);
