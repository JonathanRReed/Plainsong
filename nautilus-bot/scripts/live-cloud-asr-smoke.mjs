#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const requiredKeys = ["OPENAI_API_KEY", "ELEVENLABS_API_KEY", "MISTRAL_API_KEY"];
const missing = requiredKeys.filter((key) => !process.env[key] || !process.env[key].trim());
if (missing.length > 0) {
  console.error(`Missing required live cloud ASR secrets: ${missing.join(", ")}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outFile = outIndex >= 0 ? args[outIndex + 1] : null;
const fixturePath = path.resolve(
  process.cwd(),
  "scripts/fixtures/live-cloud-smoke.wav"
);
const audio = await fs.readFile(fixturePath);

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
  const text = String(parsed.text || "").trim();
  if (!text) {
    throw new Error("OpenAI ASR returned empty transcript text");
  }

  return { provider: "openai", elapsedMs, textLength: text.length };
}

async function callElevenLabs() {
  const started = Date.now();
  const form = new FormData();
  form.append("audio", new Blob([audio], { type: "audio/wav" }), "live-cloud-smoke.wav");
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
  const text = String(parsed.text || "").trim();
  if (!text) {
    throw new Error("ElevenLabs ASR returned empty transcript text");
  }

  return { provider: "elevenlabs", elapsedMs, textLength: text.length };
}

async function callMistral() {
  const started = Date.now();
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "live-cloud-smoke.wav");
  form.append("model", "voxtral-mini-4b-2602");

  const response = await fetch("https://api.mistral.ai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.MISTRAL_API_KEY}` },
    body: form,
  });

  const elapsedMs = Date.now() - started;
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Mistral ASR failed (${response.status}): ${body}`);
  }

  const parsed = JSON.parse(body);
  const text = String(parsed.text || "").trim();
  if (!text) {
    throw new Error("Mistral ASR returned empty transcript text");
  }

  return { provider: "mistral", elapsedMs, textLength: text.length };
}

const results = [await callOpenAI(), await callElevenLabs(), await callMistral()];
const latencies = results.map((result) => result.elapsedMs).sort((a, b) => a - b);
const medianLatencyMs = latencies[Math.floor(latencies.length / 2)];

if (medianLatencyMs >= 6000) {
  console.error(`Cloud ASR median latency gate failed: ${medianLatencyMs}ms >= 6000ms`);
  console.error(JSON.stringify({ results, medianLatencyMs }, null, 2));
  process.exit(1);
}

const report = {
  fixture: fixturePath,
  generatedAt: new Date().toISOString(),
  medianLatencyMs,
  thresholdMs: 6000,
  results,
};

if (outFile) {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(report, null, 2));
}

console.log(JSON.stringify(report, null, 2));
