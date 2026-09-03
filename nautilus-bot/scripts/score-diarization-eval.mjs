#!/usr/bin/env node
/**
 * Score diarization backend output against a synthetic fixture's ground truth.
 *
 * Input is the `DIAR-EVAL {json}` lines the ignored evaluation tests in
 * `rust-sidecar/src/diarization/mod.rs` print, plus the matching
 * `*.ground-truth.json` written by `make-diarization-eval-fixture.mjs`:
 *
 *   node scripts/score-diarization-eval.mjs \
 *     --ground-truth artifacts/qa/diarization-speakrs/two-speaker-44s.ground-truth.json \
 *     --result run-a.txt --result run-b.txt
 *
 * Metrics, and what each one is worth:
 *
 * - `frameErrorRate`: fraction of 10 ms frames whose predicted speaker
 *   disagrees with the reference, after mapping predicted speaker ids to
 *   reference speakers by the optimal one-to-one assignment (brute force over
 *   permutations; these fixtures have two speakers). This is DER-*style* —
 *   the same confusion + miss + false-alarm accounting a DER tool does with a
 *   0 ms collar — but it is computed on a two-speaker fixture with no
 *   overlapped speech, so it is NOT comparable to a published VoxConverse DER.
 * - `boundaryErrors`: for each reference turn boundary, the distance to the
 *   nearest predicted boundary, plus how many land within 0.5 s.
 * - `speakerCount`: predicted distinct speakers vs reference.
 * - `unattributedSeconds`: reference speech no predicted turn covers.
 */
import fs from "node:fs";

const FRAME_SECONDS = 0.01;
const BOUNDARY_TOLERANCE_SECONDS = 0.5;

function parseArgs(argv) {
  const results = [];
  let groundTruth = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--ground-truth") {
      groundTruth = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--result") {
      results.push(argv[i + 1]);
      i += 1;
    }
  }
  if (!groundTruth || results.length === 0) {
    throw new Error("usage: --ground-truth <json> --result <file> [--result <file>]");
  }
  return { groundTruth, results };
}

function readEvalLines(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("DIAR-EVAL "))
    .map((line) => JSON.parse(line.slice("DIAR-EVAL ".length)));
}

/** Speaker label active at each 10 ms frame, or null where nobody is. */
function frameLabels(turns, durationSeconds) {
  const frames = new Array(Math.round(durationSeconds / FRAME_SECONDS)).fill(null);
  for (const turn of turns) {
    const from = Math.max(0, Math.round(turn.start / FRAME_SECONDS));
    const to = Math.min(frames.length, Math.round(turn.end / FRAME_SECONDS));
    for (let i = from; i < to; i += 1) {
      // First writer wins so overlapping predicted turns stay deterministic.
      if (frames[i] === null) {
        frames[i] = turn.speaker;
      }
    }
  }
  return frames;
}

function permutations(items) {
  if (items.length <= 1) {
    return [items];
  }
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) {
      out.push([items[i], ...tail]);
    }
  }
  return out;
}

function bestMapping(referenceFrames, predictedFrames, referenceSpeakers, predictedSpeakers) {
  // Pad the shorter list so every predicted speaker gets some reference (or
  // an explicit "no match", which scores every one of its frames as an error).
  const width = Math.max(referenceSpeakers.length, predictedSpeakers.length);
  const paddedReference = [...referenceSpeakers];
  while (paddedReference.length < width) {
    paddedReference.push(null);
  }

  let best = null;
  for (const order of permutations(paddedReference)) {
    const mapping = new Map();
    predictedSpeakers.forEach((speaker, index) => mapping.set(speaker, order[index] ?? null));
    let errors = 0;
    for (let i = 0; i < referenceFrames.length; i += 1) {
      const expected = referenceFrames[i];
      const actual = predictedFrames[i] === null ? null : mapping.get(predictedFrames[i]);
      if (expected !== actual) {
        errors += 1;
      }
    }
    if (best === null || errors < best.errors) {
      best = { errors, mapping };
    }
  }
  return best;
}

function boundaries(turns) {
  const values = new Set();
  for (const turn of turns) {
    values.add(Number(turn.start.toFixed(3)));
    values.add(Number(turn.end.toFixed(3)));
  }
  return [...values].sort((a, b) => a - b);
}

function score(reference, prediction) {
  const duration = reference.durationSeconds;
  const referenceFrames = frameLabels(reference.turns, duration);
  const predictedFrames = frameLabels(prediction.turns, duration);

  const referenceSpeakers = [...new Set(reference.turns.map((t) => t.speaker))];
  const predictedSpeakers = [...new Set(prediction.turns.map((t) => t.speaker))];
  const best = bestMapping(referenceFrames, predictedFrames, referenceSpeakers, predictedSpeakers);

  // Interior boundaries only: the start of the first turn and the end of the
  // last are fixed by the file, not decided by the backend.
  const referenceBoundaries = boundaries(reference.turns).filter(
    (value) => value > 0 && value < duration,
  );
  const predictedBoundaries = boundaries(prediction.turns);
  const distances = referenceBoundaries.map((value) =>
    Math.min(...predictedBoundaries.map((candidate) => Math.abs(candidate - value))),
  );
  const within = distances.filter((d) => d <= BOUNDARY_TOLERANCE_SECONDS).length;

  const unattributedFrames = predictedFrames.filter((label, index) => {
    return label === null && referenceFrames[index] !== null;
  }).length;

  return {
    backend: prediction.backend,
    durationSeconds: duration,
    frameErrorRate: Number((best.errors / referenceFrames.length).toFixed(4)),
    speakerCount: { reference: referenceSpeakers.length, predicted: predictedSpeakers.length },
    speakerMapping: Object.fromEntries(best.mapping),
    boundaries: {
      reference: referenceBoundaries.length,
      withinToleranceSeconds: BOUNDARY_TOLERANCE_SECONDS,
      within,
      meanAbsErrorSeconds: Number(
        (distances.reduce((sum, d) => sum + d, 0) / Math.max(1, distances.length)).toFixed(3),
      ),
      maxAbsErrorSeconds: Number(Math.max(...distances, 0).toFixed(3)),
    },
    unattributedSeconds: Number((unattributedFrames * FRAME_SECONDS).toFixed(2)),
    wallSeconds: Number(prediction.wallSeconds.toFixed(2)),
    realtimeFactor: Number((duration / prediction.wallSeconds).toFixed(1)),
    peakRssMb: Number((prediction.peakRssBytes / (1024 * 1024)).toFixed(1)),
  };
}

function main() {
  const { groundTruth, results } = parseArgs(process.argv.slice(2));
  const reference = JSON.parse(fs.readFileSync(groundTruth, "utf8"));
  const rows = results
    .flatMap(readEvalLines)
    .filter((prediction) => Math.abs(prediction.durationSeconds - reference.durationSeconds) < 1)
    .map((prediction) => score(reference, prediction));
  process.stdout.write(`${JSON.stringify({ fixture: reference.audio, rows }, null, 2)}\n`);
}

main();
