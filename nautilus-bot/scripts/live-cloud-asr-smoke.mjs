#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// This gate posted hardcoded model ids ("whisper-1", "scribe_v1") that a
// vendor could retire out from under it -- which is exactly what happened to
// scribe_v1 on 2026-07-09. Deriving the id from the same Rust source the app
// ships closes that gap: bumping the app's default here is now the only way
// to change what this gate tests, instead of two places that can drift apart.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

async function defaultAsrModelId(providerVariant) {
  const modPath = path.join(repoRoot, "rust-sidecar", "src", "asr", "mod.rs");
  const source = await fs.readFile(modPath, "utf8");
  const fnMatch = source.match(
    /pub fn default_model_id\(&self\) -> &'static str \{([\s\S]*?)\n {4}\}/,
  );
  if (!fnMatch) {
    throw new Error(
      `Could not locate AsrProviderType::default_model_id() in ${modPath} to derive live-smoke model ids from.`,
    );
  }
  // Strip `//` (and `///`) line comments before matching an arm, so a
  // retired/commented-out arm (e.g. a provider mid-migration to a new
  // model id) can never be picked up as if it were live code.
  const fnBodyWithoutComments = fnMatch[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const armMatch = fnBodyWithoutComments.match(
    new RegExp(`AsrProviderType::${providerVariant}\\s*=>\\s*"([^"]+)"`),
  );
  if (!armMatch) {
    throw new Error(
      `Could not find a default_model_id() arm for AsrProviderType::${providerVariant} in ${modPath}.`,
    );
  }
  return armMatch[1];
}

const openAiModelId = await defaultAsrModelId("OpenAiCloud");
const elevenLabsModelId = await defaultAsrModelId("ElevenLabsScribe");

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
  form.append("model", openAiModelId);

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
  form.append("model_id", elevenLabsModelId);

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
