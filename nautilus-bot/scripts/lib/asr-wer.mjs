/**
 * Word error rate against a human reference, for comparing ASR routes on the
 * same audio. Used by scripts/eval-asr-wer.mjs.
 *
 * Normalization follows the usual Open ASR Leaderboard shape, kept small:
 * case, punctuation and spoken-vs-written numbers are not errors, word
 * substitutions, deletions and insertions are. Formatting that the dictation
 * pipeline adds later (capitals, commas, digits) is scored separately by the
 * dictation quality fixtures, not here.
 */

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

const NUMBER_WORDS = new Map();
ONES.forEach((word, value) => NUMBER_WORDS.set(word, value));
TENS.forEach((word, index) => {
  if (word) NUMBER_WORDS.set(word, index * 10);
});

/** "twenty five" / "twenty-five" -> "25", "three" -> "3"; larger numbers are left alone. */
function collapseNumberWords(tokens) {
  const out = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const value = NUMBER_WORDS.get(token);
    if (value === undefined) {
      out.push(token);
      continue;
    }
    const next = NUMBER_WORDS.get(tokens[index + 1] ?? "");
    if (value >= 20 && value % 10 === 0 && next !== undefined && next > 0 && next < 10) {
      out.push(String(value + next));
      index += 1;
    } else {
      out.push(String(value));
    }
  }
  return out;
}

export function normalizeForWer(text) {
  const tokens =
    String(text ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .replace(/[‘’]/g, "'")
      // Hyphens and slashes split words ("twenty-five", "and/or").
      .replace(/[-/]/g, " ")
      // Keep in-word apostrophes ("don't"), drop every other symbol.
      .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
  return collapseNumberWords(tokens);
}

/**
 * Minimum edit alignment between reference and hypothesis words.
 * Returns the counts of substitutions, deletions and insertions.
 */
export function alignWords(referenceWords, hypothesisWords) {
  const rows = referenceWords.length + 1;
  const cols = hypothesisWords.length + 1;
  // cost[i][j] as a flat array, with a parallel op table for backtracking.
  const cost = new Uint32Array(rows * cols);
  const op = new Uint8Array(rows * cols); // 0 match, 1 sub, 2 del, 3 ins
  for (let i = 1; i < rows; i += 1) {
    cost[i * cols] = i;
    op[i * cols] = 2;
  }
  for (let j = 1; j < cols; j += 1) {
    cost[j] = j;
    op[j] = 3;
  }
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const same = referenceWords[i - 1] === hypothesisWords[j - 1];
      const diagonal = cost[(i - 1) * cols + (j - 1)] + (same ? 0 : 1);
      const deletion = cost[(i - 1) * cols + j] + 1;
      const insertion = cost[i * cols + (j - 1)] + 1;
      let best = diagonal;
      let bestOp = same ? 0 : 1;
      if (deletion < best) {
        best = deletion;
        bestOp = 2;
      }
      if (insertion < best) {
        best = insertion;
        bestOp = 3;
      }
      cost[i * cols + j] = best;
      op[i * cols + j] = bestOp;
    }
  }

  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  let i = rows - 1;
  let j = cols - 1;
  while (i > 0 || j > 0) {
    const current = op[i * cols + j];
    if (i > 0 && j > 0 && (current === 0 || current === 1)) {
      if (current === 1) substitutions += 1;
      i -= 1;
      j -= 1;
    } else if (i > 0 && (current === 2 || j === 0)) {
      deletions += 1;
      i -= 1;
    } else {
      insertions += 1;
      j -= 1;
    }
  }
  return { substitutions, deletions, insertions };
}

export function scoreUtterance(reference, hypothesis) {
  const referenceWords = normalizeForWer(reference);
  const hypothesisWords = normalizeForWer(hypothesis);
  const { substitutions, deletions, insertions } = alignWords(referenceWords, hypothesisWords);
  const errors = substitutions + deletions + insertions;
  return {
    referenceWordCount: referenceWords.length,
    substitutions,
    deletions,
    insertions,
    errors,
    wer: referenceWords.length === 0 ? (errors === 0 ? 0 : 1) : errors / referenceWords.length,
  };
}

/**
 * Corpus WER: total errors over total reference words, so long utterances
 * weigh more than short ones, the way published leaderboards report it.
 */
export function aggregateWer(scores) {
  const totals = scores.reduce(
    (sum, score) => ({
      referenceWordCount: sum.referenceWordCount + score.referenceWordCount,
      substitutions: sum.substitutions + score.substitutions,
      deletions: sum.deletions + score.deletions,
      insertions: sum.insertions + score.insertions,
    }),
    { referenceWordCount: 0, substitutions: 0, deletions: 0, insertions: 0 },
  );
  const errors = totals.substitutions + totals.deletions + totals.insertions;
  return {
    ...totals,
    errors,
    utterances: scores.length,
    wer: totals.referenceWordCount === 0 ? 0 : errors / totals.referenceWordCount,
  };
}
