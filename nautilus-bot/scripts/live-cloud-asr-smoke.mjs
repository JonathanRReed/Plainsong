#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Mistral used to be smoke-tested here for Voxtral. Voxtral is gone and no
// surviving ASR provider reads a Mistral key, so requiring one would fail the
// run for a capability the app can no longer route to. Mistral remains a valid
// *LLM* provider; that is a different gate.
const requiredKeys = ["OPENAI_API_KEY", "ELEVENLABS_API_KEY"];
const requiredProviders = ["openai", "elevenlabs"];
const thresholdMs = 6000;
const fixtureRelativePath = "scripts/fixtures/live-cloud-smoke.wav";
const missing = requiredKeys.filter((key) => !process.env[key] || !process.env[key].trim());
if (missing.length > 0) {
  console.error(`Missing required live cloud ASR secrets: ${missing.join(", ")}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outFile = outIndex >= 0 ? args[outIndex + 1] : null;
const fixturePath = path.resolve(process.cwd(), fixtureRelativePath);
const audio = await fs.readFile(fixturePath);
const fixtureSha256 = sha256(audio);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeTranscript(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function resultFor(provider, elapsedMs, text) {
  const normalized = normalizeTranscript(text);
  if (!normalized) {
    throw new Error(`${provider} ASR returned empty transcript text`);
  }

  return {
    provider,
    elapsedMs,
    textLength: normalized.length,
    transcriptSha256: sha256(normalized),
  };
}

async function callOpenAI() {
  const started = Date.now();
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "live-cloud-smoke.wav");
  form.append("model", "whisper-1");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });

  const elapsedMs = Date.now() - started;
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI ASR failed (${response.status}): ${body}`);
  }

  const parsed = JSON.parse(body);
  return resultFor("openai", elapsedMs, parsed.text);
}

async function callElevenLabs() {
  const started = Date.now();
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "live-cloud-smoke.wav");
  form.append("model_id", "scribe_v1");

  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    body: form,
  });

  const elapsedMs = Date.now() - started;
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`ElevenLabs ASR failed (${response.status}): ${body}`);
  }

  const parsed = JSON.parse(body);
  return resultFor("elevenlabs", elapsedMs, parsed.text);
}

const results = [await callOpenAI(), await callElevenLabs()];
const latencies = results.map((result) => result.elapsedMs).sort((a, b) => a - b);
const medianLatencyMs = latencies[Math.floor(latencies.length / 2)];
const providers = results.map((result) => result.provider);
const uniqueProviders = new Set(providers);
const missingProviders = requiredProviders.filter((provider) => !uniqueProviders.has(provider));
const extraProviders = providers.filter((provider) => !requiredProviders.includes(provider));

if (
  results.length !== requiredProviders.length ||
  uniqueProviders.size !== requiredProviders.length ||
  missingProviders.length > 0 ||
  extraProviders.length > 0
) {
  console.error("Cloud ASR provider set gate failed.");
  console.error(JSON.stringify({ providers, missingProviders, extraProviders }, null, 2));
  process.exit(1);
}

if (medianLatencyMs >= thresholdMs) {
  console.error(`Cloud ASR median latency gate failed: ${medianLatencyMs}ms >= ${thresholdMs}ms`);
  console.error(JSON.stringify({ results, medianLatencyMs }, null, 2));
  process.exit(1);
}

const report = {
  pass: true,
  fixture: fixtureRelativePath,
  fixtureSha256,
  generatedAt: new Date().toISOString(),
  medianLatencyMs,
  thresholdMs,
  providerCount: results.length,
  requiredProviders,
  secretPolicy: "Secret values and transcript text are never written.",
  results,
};

if (outFile) {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(report, null, 2));
}

console.log(JSON.stringify(report, null, 2));
