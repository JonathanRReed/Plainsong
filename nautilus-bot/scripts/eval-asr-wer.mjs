#!/usr/bin/env node
/**
 * Compare ASR routes by word error rate on the same dictation audio.
 *
 *   # 1. Audio. Record yourself reading each prompt in
 *   #    docs/evals/asr-wer/prompts.json as <id>.wav in the audio directory
 *   #    (any sample rate, mono or stereo). Or, for a quick synthetic set:
 *   node scripts/eval-asr-wer.mjs synthesize [--voice Samantha]
 *
 *   # 2. Score one or more routes (provider[:model], as benchmark-latency takes them).
 *   node scripts/eval-asr-wer.mjs run --route parakeet \
 *        --route transcribe_cpp:qwen3-asr-1.7b-q8_0 --route whisper:large-v3-turbo
 *
 * Options: --set <prompts.json> (default docs/evals/asr-wer/prompts.json),
 * --audio-dir <dir> (default artifacts/asr-wer-audio, gitignored), --out
 * <report.json> (default artifacts/qa/asr-wer-<date>.json), --skip-build.
 *
 * Each utterance runs through the release `benchmark-latency` binary, so it
 * takes the same provider code path dictation does. Synthetic `say` audio is
 * cleaner than real speech and flatters every model; real recordings are the
 * numbers worth quoting.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aggregateWer, scoreUtterance } from "./lib/asr-wer.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const benchmarkBinary = path.join(repoRoot, "rust-sidecar", "target", "release", "benchmark-latency");

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {
    command,
    set: path.join(repoRoot, "docs/evals/asr-wer/prompts.json"),
    audioDir: path.join(repoRoot, "artifacts/asr-wer-audio"),
    out: path.join(repoRoot, `artifacts/qa/asr-wer-${new Date().toISOString().slice(0, 10)}.json`),
    routes: [],
    voice: "Samantha",
    skipBuild: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = () => {
      const next = rest[index + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === "--set") options.set = path.resolve(value());
    else if (flag === "--audio-dir") options.audioDir = path.resolve(value());
    else if (flag === "--out") options.out = path.resolve(value());
    else if (flag === "--route") options.routes.push(value());
    else if (flag === "--voice") options.voice = value();
    else if (flag === "--skip-build") options.skipBuild = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  return options;
}

function loadSet(setPath) {
  const set = JSON.parse(fs.readFileSync(setPath, "utf8"));
  if (!Array.isArray(set.utterances) || set.utterances.length === 0) {
    throw new Error(`${setPath} has no utterances`);
  }
  return set;
}

function synthesize(options) {
  if (process.platform !== "darwin") {
    throw new Error("synthesize uses macOS `say`; record the prompts yourself on other systems");
  }
  const set = loadSet(options.set);
  fs.mkdirSync(options.audioDir, { recursive: true });
  let written = 0;
  for (const utterance of set.utterances) {
    const target = path.join(options.audioDir, `${utterance.id}.wav`);
    if (fs.existsSync(target)) continue;
    const result = spawnSync(
      "say",
      ["-v", options.voice, "-o", target, "--file-format=WAVE", "--data-format=LEI16@16000", utterance.reference],
      { stdio: "inherit" },
    );
    if (result.status !== 0) throw new Error(`say failed for ${utterance.id}`);
    written += 1;
  }
  console.log(`Synthesized ${written} clip(s) into ${options.audioDir} (existing recordings kept).`);
}

function buildBenchmark() {
  const result = spawnSync(
    "node",
    ["scripts/cargo-sidecar.mjs", "build", "--release", "--locked", "--bin", "benchmark-latency"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error("benchmark-latency build failed");
}

function transcribeOnce(route, wavPath, scratchDir) {
  const [provider, ...modelParts] = route.split(":");
  const model = modelParts.join(":");
  const report = path.join(scratchDir, "report.json");
  const args = [
    "--wav", wavPath,
    "--secondary-wav", wavPath,
    "--provider", provider,
    "--runs", "1",
    "--print-transcript",
    "--out", report,
    "--out-e2e", path.join(scratchDir, "report-e2e.json"),
  ];
  if (model) args.push("--model", model);
  const result = spawnSync(benchmarkBinary, args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${route} failed on ${path.basename(wavPath)}:\n${result.stderr.slice(-2000)}`);
  }
  const line = result.stderr.split("\n").find((entry) => entry.startsWith("transcript ["));
  const transcript = line ? line.slice(line.indexOf("]: ") + 3) : "";
  const latency = JSON.parse(fs.readFileSync(report, "utf8"));
  return { transcript, transcriptionMs: latency.transcriptionMsP50 ?? null };
}

function run(options) {
  if (options.routes.length === 0) throw new Error("Pass at least one --route");
  const set = loadSet(options.set);
  const clips = set.utterances.map((utterance) => ({
    ...utterance,
    wav: path.join(options.audioDir, `${utterance.id}.wav`),
  }));
  const missing = clips.filter((clip) => !fs.existsSync(clip.wav)).map((clip) => clip.id);
  if (missing.length > 0) {
    throw new Error(
      `Missing audio for ${missing.join(", ")} in ${options.audioDir}. Record them or run \`synthesize\`.`,
    );
  }
  if (!options.skipBuild) buildBenchmark();

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-wer-"));
  const results = [];
  for (const route of options.routes) {
    const utterances = [];
    for (const clip of clips) {
      const { transcript, transcriptionMs } = transcribeOnce(route, clip.wav, scratchDir);
      const score = scoreUtterance(clip.reference, transcript);
      utterances.push({ id: clip.id, reference: clip.reference, hypothesis: transcript, transcriptionMs, ...score });
      process.stderr.write(`${route} ${clip.id} WER ${(score.wer * 100).toFixed(1)}%\n`);
    }
    const latencies = utterances
      .map((utterance) => utterance.transcriptionMs)
      .filter((value) => typeof value === "number")
      .sort((a, b) => a - b);
    results.push({
      route,
      ...aggregateWer(utterances),
      transcriptionMsP50: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
      utterances,
    });
  }
  fs.rmSync(scratchDir, { recursive: true, force: true });

  const report = {
    schema: "plainsong-asr-wer-report-v1",
    generatedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, cpus: os.cpus()[0]?.model ?? null },
    set: path.relative(repoRoot, options.set),
    audioDir: path.relative(repoRoot, options.audioDir),
    results,
  };
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);

  console.log("\nroute                                     WER     sub  del  ins  p50 ms");
  for (const result of results) {
    console.log(
      `${result.route.padEnd(40)} ${(result.wer * 100).toFixed(2).padStart(6)}%  ${String(result.substitutions).padStart(3)}  ${String(result.deletions).padStart(3)}  ${String(result.insertions).padStart(3)}  ${String(result.transcriptionMsP50 ?? "-").padStart(6)}`,
    );
  }
  console.log(`\nReport: ${path.relative(repoRoot, options.out)}`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "synthesize") synthesize(options);
  else if (options.command === "run") run(options);
  else {
    console.error("Usage: node scripts/eval-asr-wer.mjs <synthesize|run> [options]; see the header of this file.");
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
