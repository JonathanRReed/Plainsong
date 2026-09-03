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
 *   reference speakers by the optimal one-to-one assignment (Hungarian; a run
 *   with a low turn floor can predict dozens of speakers, which is more than
 *   an enumeration of permutations survives). This is DER-*style* —
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

/**
 * Minimum-cost assignment of `rows` to `columns` (Hungarian / Kuhn-Munkres
 * with potentials, the e-maxx formulation). `cost` is rectangular with
 * `rows <= columns`. Returns, per row, the column it was assigned.
 *
 * O(rows^2 * columns), against the factorial of a brute-force search over
 * every speaker permutation. The result is the same mapping — this is the
 * classic assignment problem, and enumeration was only ever a slow way to
 * solve it — but the search space stopped being enumerable the moment a run
 * predicted more than about eight speakers, which is exactly what a low turn
 * floor does. Scoring one 13-speaker prediction exhausted Node's heap.
 */
function minCostAssignment(cost) {
  const n = cost.length;
  const m = cost[0].length;
  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0);
  const way = new Array(m + 1).fill(0);

  for (let i = 1; i <= n; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j += 1) {
        if (used[j]) continue;
        const current = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (current < minv[j]) {
          minv[j] = current;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j += 1) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const assignment = new Array(n).fill(-1);
  for (let j = 1; j <= m; j += 1) {
    if (p[j] > 0) assignment[p[j] - 1] = j - 1;
  }
  return assignment;
}

function bestMapping(referenceFrames, predictedFrames, referenceSpeakers, predictedSpeakers) {
  if (predictedSpeakers.length === 0) {
    const errors = referenceFrames.filter((label) => label !== null).length;
    return { errors, mapping: new Map() };
  }

  const referenceIndex = new Map(referenceSpeakers.map((speaker, i) => [speaker, i]));
  const predictedIndex = new Map(predictedSpeakers.map((speaker, i) => [speaker, i]));

  // agree[p][r]: frames a mapping p→r would score correct.
  // silent[p]:   frames p covers where the reference has nobody, which agree
  //              only when p is mapped to "no reference speaker".
  // base:        frames neither side attributes; they agree under every
  //              mapping, so they sit outside the optimisation.
  const agree = predictedSpeakers.map(() => new Array(referenceSpeakers.length).fill(0));
  const silent = new Array(predictedSpeakers.length).fill(0);
  let base = 0;
  for (let i = 0; i < referenceFrames.length; i += 1) {
    const expected = referenceFrames[i];
    const predicted = predictedFrames[i];
    if (predicted === null) {
      if (expected === null) base += 1;
      continue;
    }
    const p = predictedIndex.get(predicted);
    if (expected === null) {
      silent[p] += 1;
    } else {
      agree[p][referenceIndex.get(expected)] += 1;
    }
  }

  // One column per reference speaker, then one "unmatched" column per
  // predicted speaker so a surplus predicted speaker can always be left
  // unmapped — the padding the permutation search did with nulls.
  const columns = referenceSpeakers.length + predictedSpeakers.length;
  const cost = predictedSpeakers.map((_, p) =>
    new Array(columns)
      .fill(0)
      .map((_unused, j) => -(j < referenceSpeakers.length ? agree[p][j] : silent[p])),
  );
  const assignment = minCostAssignment(cost);

  const mapping = new Map();
  let agreed = base;
  predictedSpeakers.forEach((speaker, p) => {
    const column = assignment[p];
    const matched = column >= 0 && column < referenceSpeakers.length;
    mapping.set(speaker, matched ? referenceSpeakers[column] : null);
    agreed += matched ? agree[p][column] : silent[p];
  });

  return { errors: referenceFrames.length - agreed, mapping };
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
