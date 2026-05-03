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
  valueFor("--file", "artifacts/cloud-asr-preflight.json")
);
const requiredKeys = ["OPENAI_API_KEY", "ELEVENLABS_API_KEY", "MISTRAL_API_KEY"];
const expectedFixtureSha256 =
  "cb9568ee93b04dba4a309580b45a0369e486682e2e57305ac8f302630bb8e2ea";
const secretPattern = /(sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9_-]{12,}|xai-[A-Za-z0-9_-]{12,})/;

function fail(message, violations = []) {
  console.error(message);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

if (!fs.existsSync(artifactPath)) {
  fail(`Cloud ASR preflight artifact not found: ${path.relative(repoRoot, artifactPath)}`);
}

const raw = fs.readFileSync(artifactPath, "utf8");
const artifact = JSON.parse(raw);
const violations = [];

if (secretPattern.test(raw)) {
  violations.push("Artifact appears to contain a token-like secret value.");
}
if (!["READY", "BLOCKED"].includes(artifact.status)) {
  violations.push(`Invalid status: ${artifact.status}`);
}
if (artifact.command !== "bun run qa:cloud-asr:smoke") {
  violations.push("Command must be bun run qa:cloud-asr:smoke.");
}
if (artifact.liveSmokeOutput !== "artifacts/cloud-asr-smoke.json") {
  violations.push("Live smoke output must be artifacts/cloud-asr-smoke.json.");
}
if (artifact.liveSmokeVerifier !== "scripts/verify-cloud-asr-smoke.mjs") {
  violations.push("Live smoke verifier must be scripts/verify-cloud-asr-smoke.mjs.");
}
if (artifact.fixture !== "scripts/fixtures/live-cloud-smoke.wav") {
  violations.push("Fixture path must be scripts/fixtures/live-cloud-smoke.wav.");
}
if (artifact.fixtureExists !== true) {
  violations.push("Live cloud smoke fixture is missing.");
}
if (artifact.fixtureSha256 !== expectedFixtureSha256) {
  violations.push("fixtureSha256 does not match the checked-in smoke fixture.");
}

const byName = new Map((artifact.requiredEnv ?? []).map((entry) => [entry.name, entry]));
for (const key of requiredKeys) {
  const entry = byName.get(key);
  if (!entry) {
    violations.push(`Missing required env entry: ${key}`);
    continue;
  }
  if (typeof entry.present !== "boolean") {
    violations.push(`Env entry ${key} must use a boolean present field.`);
  }
}
for (const entry of artifact.requiredEnv ?? []) {
  if (!requiredKeys.includes(entry.name)) {
    violations.push(`Unexpected env entry: ${entry.name}`);
  }
}

const computedMissing = requiredKeys.filter((key) => byName.get(key)?.present !== true);
const actualMissing = Array.isArray(artifact.missingEnv) ? artifact.missingEnv : [];
if (JSON.stringify(computedMissing) !== JSON.stringify(actualMissing)) {
  violations.push(
    `missingEnv does not match requiredEnv presence. Expected ${computedMissing.join(", ") || "none"}.`
  );
}
if (artifact.status === "READY" && computedMissing.length > 0) {
  violations.push("READY status cannot have missing env vars.");
}
if (artifact.status === "BLOCKED" && computedMissing.length === 0 && artifact.fixtureExists) {
  violations.push("BLOCKED status requires missing env vars or missing fixture.");
}
if (!String(artifact.secretPolicy ?? "").includes("Secret values are never written")) {
  violations.push("secretPolicy must state that secret values are never written.");
}

if (violations.length > 0) {
  fail(`Cloud ASR preflight validation failed (${violations.length} issues):`, violations);
}

console.log(
  `Cloud ASR preflight validation passed: ${artifact.status}, missing env ${actualMissing.join(", ") || "none"}.`
);
