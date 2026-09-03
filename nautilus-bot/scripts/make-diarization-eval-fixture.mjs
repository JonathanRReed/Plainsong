#!/usr/bin/env node
/**
 * Build two-speaker diarization evaluation fixtures with exact ground truth.
 *
 * Plainsong has no multi-speaker recording it can commit: `scripts/fixtures/`
 * only holds single-speaker audio, and real meeting audio is exactly the
 * material this app promises never to ship anywhere. So the fixtures are
 * synthesised from the one real-speech fixture that is already in the tree:
 * `real-speech-44s.wav` plays "A", and a pitch- and formant-shifted copy of it
 * (ffmpeg `asetrate` + `atempo`, which moves the whole spectral envelope and
 * so reads as a different vocal tract rather than the same voice sped up)
 * plays "B". Turns alternate on a fixed grid, which is what makes the ground
 * truth exact rather than hand-labelled.
 *
 * What this does and does not prove: boundary placement and speaker
 * consistency against known turns, on clean, non-overlapping, studio-quality
 * speech from a *single* underlying talker. It is not a DER benchmark. Two
 * voices derived from one recording share prosody and phonetics, so a
 * clustering backend has an easier separation problem than two real people,
 * and there is no overlapped speech at all — the one thing the pyannote
 * pipeline exists to handle. Read the numbers as a smoke test with
 * arithmetic, not as VoxConverse.
 *
 *   node scripts/make-diarization-eval-fixture.mjs [--out-dir <dir>] \
 *     [--turn-seconds <n>] [--label <name>] [--speakers <2|3|4>] \
 *     [--gap-seconds <n>]
 *
 * `--gap-seconds` inserts digital silence between turns. It defaults to 0,
 * which makes a fixture that is wall-to-wall speech -- and a fixture with no
 * silence in it cannot tell a VAD-driven segmentation apart from a metronome,
 * because the VAD correctly reports one speech region covering the whole file.
 * Anything measuring segmentation wants a non-zero gap; real turn boundaries
 * are not butt-joined.
 *
 * `--turn-seconds` matters more than it looks. The default 6 s grid is an
 * exact multiple of the embedding backend's 1 s window hop, so that backend's
 * turn boundaries can land on the reference boundaries for free. Generate a
 * second set at an off-grid turn length (5.3 s is used in the spike receipt)
 * before comparing boundary accuracy between backends, or the comparison
 * measures the fixture rather than the pipelines.
 *
 * Writes, per fixture, a 16 kHz mono 16-bit WAV (gitignored: raw captures are
 * not tracked) and a `.json` ground-truth file listing every turn (tracked, so
 * the receipt's numbers can be recomputed).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceWav = path.join(repoRoot, "scripts/fixtures/real-speech-44s.wav");

/** Default seconds per turn. Long enough that a windowed embedder gets several
 * windows inside a turn; short enough that 44 s holds seven turns. */
const DEFAULT_TURN_SECONDS = 6;
/** Ratios applied to the sample rate before restoring tempo, one per voice
 * after the first. 0.82 is about -3.4 semitones and 1.18 about +2.9: both
 * clearly a different speaker from the source and from each other, and both
 * still natural. A fourth voice would need a shift big enough to sound
 * synthetic, which is why the flag stops at four and the receipt says so. */
const PITCH_RATIOS = [0.82, 1.18, 0.7];
/** Kept for the two-speaker default's ground-truth field. */
const PITCH_RATIO = PITCH_RATIOS[0];
/** Most voices this generator will build. */
const MAX_SPEAKERS = PITCH_RATIOS.length + 1;

function parseArgs(argv) {
  let outDir = path.join(repoRoot, "artifacts/qa/diarization-speakrs");
  let turnSeconds = DEFAULT_TURN_SECONDS;
  let label = "two-speaker";
  let speakers = 2;
  let gapSeconds = 0;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out-dir") {
      outDir = path.resolve(argv[i + 1] ?? "");
      i += 1;
    } else if (argv[i] === "--turn-seconds") {
      turnSeconds = Number(argv[i + 1]);
      if (!Number.isFinite(turnSeconds) || turnSeconds <= 0) {
        throw new Error(`--turn-seconds must be a positive number, got ${argv[i + 1]}`);
      }
      i += 1;
    } else if (argv[i] === "--label") {
      label = argv[i + 1] ?? label;
      i += 1;
    } else if (argv[i] === "--speakers") {
      speakers = Number(argv[i + 1]);
      if (!Number.isInteger(speakers) || speakers < 2 || speakers > MAX_SPEAKERS) {
        throw new Error(
          `--speakers must be an integer between 2 and ${MAX_SPEAKERS}, got ${argv[i + 1]}`,
        );
      }
      i += 1;
    } else if (argv[i] === "--gap-seconds") {
      gapSeconds = Number(argv[i + 1]);
      if (!Number.isFinite(gapSeconds) || gapSeconds < 0) {
        throw new Error(`--gap-seconds must be zero or positive, got ${argv[i + 1]}`);
      }
      i += 1;
    }
  }
  return { outDir, turnSeconds, label, speakers, gapSeconds };
}

/** Minimal WAV reader for the one shape this repo's fixtures use. */
function readPcm16Mono(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${file}: not a RIFF/WAVE file`);
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, offset + 8 + size);
    if (id === "fmt ") {
      format = {
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bitsPerSample: body.readUInt16LE(14),
      };
    } else if (id === "data") {
      data = body;
    }
    offset += 8 + size + (size % 2);
  }
  if (!format || !data) {
    throw new Error(`${file}: missing fmt or data chunk`);
  }
  if (format.channels !== 1 || format.bitsPerSample !== 16) {
    throw new Error(
      `${file}: expected mono 16-bit, got ${format.channels}ch/${format.bitsPerSample}-bit`,
    );
  }
  const samples = new Int16Array(data.byteLength / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = data.readInt16LE(i * 2);
  }
  return { samples, sampleRate: format.sampleRate };
}

function writePcm16Mono(file, samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }
  fs.writeFileSync(file, buffer);
}

function pitchShift(input, output, sampleRate, ratio) {
  const shiftedRate = Math.round(sampleRate * ratio);
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      input,
      "-af",
      `asetrate=${shiftedRate},aresample=${sampleRate},atempo=${(1 / ratio).toFixed(6)}`,
      "-ar",
      String(sampleRate),
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      output,
    ],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `ffmpeg pitch shift failed (${result.status}): ${result.stderr ?? result.error?.message}`,
    );
  }
}

/**
 * Interleave `voices` on a fixed grid until `totalSeconds` of audio exists,
 * looping each voice's source independently so a longer fixture keeps saying
 * new things instead of repeating one 44 s block verbatim.
 */
function buildAlternating(voices, sampleRate, totalSeconds, turnSeconds, gapSeconds) {
  const turnSamples = Math.round(turnSeconds * sampleRate);
  const gapSamples = Math.round(gapSeconds * sampleRate);
  const totalSamples = Math.round(totalSeconds * sampleRate);
  const out = new Int16Array(totalSamples);
  const cursors = voices.map(() => 0);
  const turns = [];

  let written = 0;
  let turnIndex = 0;
  while (written < totalSamples) {
    const voiceIndex = turnIndex % voices.length;
    const voice = voices[voiceIndex];
    const length = Math.min(turnSamples, totalSamples - written);
    for (let i = 0; i < length; i += 1) {
      out[written + i] = voice.samples[(cursors[voiceIndex] + i) % voice.samples.length];
    }
    cursors[voiceIndex] = (cursors[voiceIndex] + length) % voice.samples.length;
    turns.push({
      start: Number((written / sampleRate).toFixed(3)),
      end: Number(((written + length) / sampleRate).toFixed(3)),
      speaker: voice.name,
    });
    written += length;
    // `out` is already zero-filled, so the gap is written by skipping it. The
    // silence is deliberately absolute rather than low-level room tone: this
    // fixture is a smoke test with arithmetic, and a VAD that cannot find a
    // digital-silence boundary would not find a real one either.
    written += gapSamples;
    turnIndex += 1;
  }

  return { samples: out, turns };
}

function main() {
  const { outDir, turnSeconds, label, speakers, gapSeconds } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(outDir, { recursive: true });

  const speakerA = readPcm16Mono(sourceWav);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-diar-fixture-"));
  try {
    const voices = [{ name: "A", samples: speakerA.samples }];
    const ratios = [];
    for (let index = 1; index < speakers; index += 1) {
      const ratio = PITCH_RATIOS[index - 1];
      const name = String.fromCharCode("A".charCodeAt(0) + index);
      const shiftedPath = path.join(scratch, `speaker-${name.toLowerCase()}.wav`);
      pitchShift(sourceWav, shiftedPath, speakerA.sampleRate, ratio);
      // Each shifted voice starts at a different point in the source so two
      // of them are never saying the same words at the same offset, which
      // would make the separation problem easier than any real meeting.
      const shifted = readPcm16Mono(shiftedPath);
      const offset = Math.floor((shifted.samples.length * index) / speakers);
      const rotated = new Int16Array(shifted.samples.length);
      for (let i = 0; i < rotated.length; i += 1) {
        rotated[i] = shifted.samples[(i + offset) % shifted.samples.length];
      }
      voices.push({ name, samples: rotated });
      ratios.push(ratio);
    }

    for (const seconds of [44, 300]) {
      const name = `${label}-${seconds}s`;
      const { samples, turns } = buildAlternating(
        voices,
        speakerA.sampleRate,
        seconds,
        turnSeconds,
        gapSeconds,
      );
      const wavPath = path.join(outDir, `${name}.wav`);
      writePcm16Mono(wavPath, samples, speakerA.sampleRate);
      fs.writeFileSync(
        path.join(outDir, `${name}.ground-truth.json`),
        `${JSON.stringify(
          {
            audio: path.relative(repoRoot, wavPath),
            source: path.relative(repoRoot, sourceWav),
            sampleRate: speakerA.sampleRate,
            durationSeconds: Number(seconds.toFixed(3)),
            turnSeconds,
            gapSeconds,
            pitchRatio: PITCH_RATIO,
            pitchRatios: ratios,
            speakers: voices.map((voice) => voice.name),
            turns,
          },
          null,
          2,
        )}\n`,
      );
      process.stdout.write(`${name}: ${seconds}s, ${turns.length} turns -> ${wavPath}\n`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main();
