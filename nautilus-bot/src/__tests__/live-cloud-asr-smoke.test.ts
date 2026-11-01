import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "../..");
const expectedTranscript = "Please send the revised meeting notes tomorrow morning.";
const unrelatedTranscript = "Unexpected transcript sentinel about a purple submarine.";
const providerBody = "Untrusted provider body sentinel.";
const openAiKey = "offline-openai-key-sentinel";
const elevenLabsKey = "offline-elevenlabs-key-sentinel";

const preload = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs";
const fixture = fs.readFileSync("scripts/fixtures/live-cloud-smoke.wav");
const source = fs.readFileSync("rust-sidecar/src/asr/mod.rs", "utf8");
const defaults = source.split("pub fn default_model_id(&self)")[1]?.split("\n    }")[0];
assert.ok(defaults, "Missing Rust default model declarations");
const model = (variant) => {
  const value = defaults.match(new RegExp("AsrProviderType::" + variant + "\\s*=>\\s*\"([^\"]+)\""))?.[1];
  assert.ok(value, "Missing provider model default");
  return value;
};
const calls = [];
fs.writeFileSync("fetch-calls.json", "[]");
let clock = 1000;
Object.defineProperty(performance, "now", { value: () => clock, configurable: true });
const timeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (milliseconds) => {
  assert.equal(milliseconds, 6000, "Expected the six-second request deadline");
  return timeout(process.env.SMOKE_SCENARIO === "aborting-body" ? 100 : milliseconds);
};
globalThis.fetch = async (input, init) => {
  const provider = input === "https://api.openai.com/v1/audio/transcriptions" ? "openai"
    : input === "https://api.elevenlabs.io/v1/speech-to-text" ? "elevenlabs" : null;
  assert.ok(provider, "Network attempt outside offline fixture");
  assert.ok(init?.method === "POST" && init.body instanceof FormData, "Expected multipart POST");
  assert.ok(init.signal instanceof AbortSignal && !init.signal.aborted, "Expected request deadline");
  const headers = new Headers(init.headers);
  assert.ok(provider === "openai"
    ? headers.get("Authorization") === "Bearer " + process.env.OPENAI_API_KEY
    : headers.get("xi-api-key") === process.env.ELEVENLABS_API_KEY, "Unexpected credential header");
  const file = init.body.get("file");
  assert.ok(file instanceof Blob && file.type === "audio/wav", "Expected WAV upload");
  assert.ok(file.name === "live-cloud-smoke.wav", "Unexpected upload filename");
  const posted = Buffer.from(await file.arrayBuffer());
  assert.ok(posted.equals(fixture), "Uploaded bytes differ from the owned fixture");
  assert.ok(init.body.get(provider === "openai" ? "model" : "model_id") ===
    model(provider === "openai" ? "OpenAiCloud" : "ElevenLabsScribe"), "Provider model differs from Rust default");
  calls.push(provider);
  fs.writeFileSync("fetch-calls.json", JSON.stringify(calls));
  if (process.env.SMOKE_SCENARIO === "provider-error") {
    return new Response(process.env.SMOKE_PROVIDER_BODY + process.env.OPENAI_API_KEY, { status: 401 });
  }
  if (process.env.SMOKE_SCENARIO === "invalid-json") {
    return new Response(process.env.SMOKE_PROVIDER_BODY + process.env.OPENAI_API_KEY);
  }
  const text = process.env.SMOKE_SCENARIO === "unrelated" ? process.env.SMOKE_UNRELATED
    : process.env.SMOKE_SCENARIO === "empty" ? ""
    : process.env.SMOKE_SCENARIO === "extra-word" ? process.env.SMOKE_EXPECTED + " Extra."
    : "  PLEASE, send the revised meeting notes tomorrow morning!  ";
  const response = new Response(JSON.stringify({ text }));
  const read = response.text.bind(response);
  response.text = async () => {
    if (process.env.SMOKE_SCENARIO === "aborting-body") {
      return new Promise((_resolve, reject) => {
        const keepAlive = setInterval(() => {}, 25);
        const aborted = () => {
          clearInterval(keepAlive);
          fs.writeFileSync("body-aborted", "observed");
          reject(new Error(process.env.SMOKE_PROVIDER_BODY + process.env.OPENAI_API_KEY));
        };
        if (init.signal.aborted) aborted();
        else init.signal.addEventListener("abort", aborted, { once: true });
      });
    }
    if (process.env.SMOKE_SCENARIO === "slow-body") clock += 6500;
    return read();
  };
  return response;
};
`;

describe("live cloud ASR speech smoke", () => {
  it.each([
    "positive", "unrelated", "empty", "extra-word", "provider-error", "invalid-json", "slow-body", "aborting-body", "mutated-fixture",
  ])("checks the real script offline for %s", (scenario) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "plainsong-cloud-smoke-"));
    try {
      for (const folder of ["scripts/fixtures", "rust-sidecar/src/asr", "home", "tmp"]) {
        mkdirSync(path.join(root, folder), { recursive: true });
      }
      for (const relative of [
        "scripts/live-cloud-asr-smoke.ts", "scripts/fixtures/live-cloud-smoke.wav",
        "scripts/fixtures/live-cloud-smoke.json", "rust-sidecar/src/asr/mod.rs",
      ]) {
        copyFileSync(path.join(repo, relative), path.join(root, relative));
      }
      if (scenario === "mutated-fixture") {
        const filename = path.join(root, "scripts/fixtures/live-cloud-smoke.wav");
        const bytes = readFileSync(filename);
        const last = bytes.length - 1;
        bytes[last] = (bytes[last] ?? 0) ^ 1;
        writeFileSync(filename, bytes);
      }
      writeFileSync(path.join(root, "preload.mjs"), preload);
      const result = spawnSync("bun", [
        "--preload", path.join(root, "preload.mjs"),
        path.join(root, "scripts/live-cloud-asr-smoke.ts"), "--out", "receipt.json",
      ], {
        cwd: root,
        env: {
          // Only so the spawn can find Bun; the script itself reads no PATH.
          PATH: process.env.PATH,
          HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"),
          OPENAI_API_KEY: openAiKey, ELEVENLABS_API_KEY: elevenLabsKey,
          SMOKE_SCENARIO: scenario, SMOKE_EXPECTED: expectedTranscript,
          SMOKE_UNRELATED: unrelatedTranscript, SMOKE_PROVIDER_BODY: providerBody,
        },
        encoding: "utf8", timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      const calls: unknown = JSON.parse(readFileSync(path.join(root, "fetch-calls.json"), "utf8"));
      const output = result.stdout + result.stderr;
      for (const sensitive of [openAiKey, elevenLabsKey, unrelatedTranscript, providerBody, expectedTranscript]) {
        expect(output).not.toContain(sensitive);
      }
      if (scenario === "positive") {
        expect(result.status, result.stderr).toBe(0);
        expect(calls).toEqual(["openai", "elevenlabs"]);
        const receiptText = readFileSync(path.join(root, "receipt.json"), "utf8");
        const receipt: unknown = JSON.parse(receiptText);
        expect(receipt).toMatchObject({ pass: true, providerCount: 2, thresholdMs: 6000 });
        for (const sensitive of [openAiKey, elevenLabsKey, expectedTranscript]) {
          expect(receiptText).not.toContain(sensitive);
        }
        expect(receiptText).toMatch(/synthetic speech/i);
        expect(receiptText).toMatch(/connectivity/i);
      } else {
        expect(result.status).not.toBe(0);
        if (scenario === "mutated-fixture") expect(calls).toEqual([]);
        if (scenario === "aborting-body") {
          expect(calls).toEqual(["openai"]);
          expect(readFileSync(path.join(root, "body-aborted"), "utf8")).toBe("observed");
          expect(result.stderr).toContain("ASR response body could not be read");
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
