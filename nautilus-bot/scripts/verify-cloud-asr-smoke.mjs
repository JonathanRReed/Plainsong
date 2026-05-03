#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const requiredProviders = ["openai", "elevenlabs", "mistral"];
const expectedFixtureSha256 =
  "cb9568ee93b04dba4a309580b45a0369e486682e2e57305ac8f302630bb8e2ea";
const expectedFixture = "scripts/fixtures/live-cloud-smoke.wav";
const expectedThresholdMs = 6000;
const secretPattern = /(sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9_-]{12,}|xai-[A-Za-z0-9_-]{12,})/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const forbiddenRawTranscriptKeyPattern = /"(?:text|transcript|body|response)"\s*:/i;

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
  valueFor("--file", "artifacts/cloud-asr-smoke.json")
);

if (!fs.existsSync(artifactPath)) {
  fail(`Cloud ASR smoke artifact not found: ${path.relative(repoRoot, artifactPath)}`);
}

const raw = fs.readFileSync(artifactPath, "utf8");
const artifact = JSON.parse(raw);
const violations = [];

if (secretPattern.test(raw)) {
  violations.push("Artifact appears to contain a token-like secret value.");
}
if (forbiddenRawTranscriptKeyPattern.test(raw)) {
  violations.push("Artifact must not contain raw transcript or response fields.");
}
if (artifact.pass !== true) {
  violations.push("pass must be true.");
}
if (artifact.fixture !== expectedFixture) {
  violations.push(`fixture must be ${expectedFixture}.`);
}
if (artifact.fixtureSha256 !== expectedFixtureSha256) {
  violations.push("fixtureSha256 does not match the checked-in smoke fixture.");
}
if (artifact.thresholdMs !== expectedThresholdMs) {
  violations.push(`thresholdMs must be ${expectedThresholdMs}.`);
}
if (!Number.isFinite(artifact.medianLatencyMs) || artifact.medianLatencyMs < 0) {
  violations.push("medianLatencyMs must be a finite non-negative number.");
} else if (artifact.medianLatencyMs >= expectedThresholdMs) {
  violations.push(`medianLatencyMs must be below ${expectedThresholdMs}.`);
}
if (artifact.providerCount !== requiredProviders.length) {
  violations.push(`providerCount must be ${requiredProviders.length}.`);
}
if (JSON.stringify(artifact.requiredProviders) !== JSON.stringify(requiredProviders)) {
  violations.push(`requiredProviders must be ${requiredProviders.join(", ")}.`);
}
if (!String(artifact.secretPolicy ?? "").includes("Secret values and transcript text are never written")) {
  violations.push("secretPolicy must state that secret values and transcript text are never written.");
}

const results = Array.isArray(artifact.results) ? artifact.results : [];
if (results.length !== requiredProviders.length) {
  violations.push(`results must contain exactly ${requiredProviders.length} entries.`);
}

const seenProviders = new Set();
for (const result of results) {
  if (!requiredProviders.includes(result.provider)) {
    violations.push(`Unexpected provider result: ${result.provider}`);
    continue;
  }
  if (seenProviders.has(result.provider)) {
    violations.push(`Duplicate provider result: ${result.provider}`);
  }
  seenProviders.add(result.provider);

  if (!Number.isFinite(result.elapsedMs) || result.elapsedMs < 0) {
    violations.push(`${result.provider} elapsedMs must be a finite non-negative number.`);
  }
  if (!Number.isFinite(result.textLength) || result.textLength < 1) {
    violations.push(`${result.provider} textLength must be a positive number.`);
  }
  if (!sha256Pattern.test(String(result.transcriptSha256 ?? ""))) {
    violations.push(`${result.provider} transcriptSha256 must be a 64 character lowercase hex hash.`);
  }
}

for (const provider of requiredProviders) {
  if (!seenProviders.has(provider)) {
    violations.push(`Missing provider result: ${provider}`);
  }
}

if (violations.length > 0) {
  fail(`Cloud ASR smoke validation failed (${violations.length} issues):`, violations);
}

console.log(
  `Cloud ASR smoke validation passed: ${results.length} providers, median ${artifact.medianLatencyMs}ms.`
);
