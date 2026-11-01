/**
 * Word error rate against a human reference, for comparing ASR routes on the
 * same audio. Used by scripts/eval-asr-wer.ts.
 *
 * Normalization follows the usual Open ASR Leaderboard shape: case,
 * punctuation and spoken-vs-written numbers (including phone numbers,
 * thousands, decimals, percentages, currency and ordinals) are not errors;
 * word substitutions, deletions and insertions are. Formatting that the dictation
 * pipeline adds later (capitals, commas, digits) is scored separately by the
 * dictation quality fixtures, not here.
 */

export interface WordAlignmentCounts {
  substitutions: number;
  deletions: number;
  insertions: number;
}

export interface UtteranceScore extends WordAlignmentCounts {
  referenceWordCount: number;
  errors: number;
  wer: number;
}

export interface CorpusScore extends UtteranceScore {
  utterances: number;
}

const UNITS = new Map(
  [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
    "seventeen", "eighteen", "nineteen",
  ].map((word, value): [string, number] => [word, value]),
);
const TENS = new Map(
  ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"].map(
    (word, index): [string, number] => [word, (index + 2) * 10],
  ),
);
const MULTIPLIERS = new Map<string, number>([
  ["hundred", 100],
  ["thousand", 1000],
  ["million", 1_000_000],
]);
const ORDINALS = new Map<string, number>(
  [
    ["first", 1], ["second", 2], ["third", 3], ["fourth", 4], ["fifth", 5], ["sixth", 6],
    ["seventh", 7], ["eighth", 8], ["ninth", 9], ["tenth", 10], ["eleventh", 11],
    ["twelfth", 12], ["thirteenth", 13], ["fourteenth", 14], ["fifteenth", 15],
    ["sixteenth", 16], ["seventeenth", 17], ["eighteenth", 18], ["nineteenth", 19],
    ["twentieth", 20], ["thirtieth", 30],
  ],
);

function ordinalSuffix(value: number): string {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return "th";
  return ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[value % 10] ?? "th";
}

const isNumberWord = (token: string): boolean =>
  UNITS.has(token) || TENS.has(token) || MULTIPLIERS.has(token);

/**
 * A written ordinal split the way its spoken form is ambiguous: "563rd" ->
 * ["560", "3rd"], "21st" -> ["20", "1st"], "718th" -> ["700", "18th"].
 * "three hundred and twenty second graders" may be 320 second graders or the
 * 322nd graders. The dictation ITN keeps such a phrase as words unless what
 * follows settles it ("563rd night"), and other routes may write either
 * reading. Splitting both the written ordinal and the spoken one at the same
 * place scores any of these renderings as the words spoken,
 * while a different number still differs ("564th" -> ["560", "4th"]).
 * Ordinals up to 20 and round tens/hundreds ("30th", "500th") stay whole.
 */
function splitWrittenOrdinal(token: string): string[] | null {
  const match = /^(\d+)(st|nd|rd|th)$/.exec(token);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value <= 20) return null;
  const lastTwo = value % 100;
  const tail = lastTwo > 20 && lastTwo % 10 !== 0 ? lastTwo % 10 : lastTwo;
  if (tail === 0 || tail === value) return null;
  return [String(value - tail), `${tail}${ordinalSuffix(tail)}`];
}

/**
 * Turns every spoken number into digits and joins numbers read one after the
 * other, so "five five five one two three four", "555-1234" and "5551234"
 * all become "5551234", "twenty twenty" becomes "2020", "four oh one" becomes
 * "401", and "eight point two" becomes "8.2". Ordinals keep their cardinal
 * head apart (see `splitWrittenOrdinal`): "twenty first" and "21st" both
 * become "20 1st".
 */
function normalizeNumbers(tokens: string[]): string[] {
  const out: string[] = [];
  let index = 0;
  const pushNumber = (digits: string): void => {
    const previous = out[out.length - 1];
    if (previous !== undefined && /^\d+(\.\d+)?$/.test(previous) && !previous.includes(".")) {
      out[out.length - 1] = previous + digits;
    } else {
      out.push(digits);
    }
  };
  while (index < tokens.length) {
    const token = tokens[index];
    const nextIsNumeric = (at: number): boolean =>
      at < tokens.length && (isNumberWord(tokens[at]) || /^\d/.test(tokens[at]));

    if (/^\d+(\.\d+)?$/.test(token)) {
      pushNumber(token);
      index += 1;
      continue;
    }
    const split = splitWrittenOrdinal(token);
    if (split) {
      pushNumber(split[0]);
      out.push(split[1]);
      index += 1;
      continue;
    }
    // "oh" (or "o", as LibriSpeech writes it) counts as zero only inside a
    // run of spoken digits.
    if ((token === "oh" || token === "o") && out.length > 0 && /^\d+$/.test(out[out.length - 1]) && nextIsNumeric(index + 1)) {
      pushNumber("0");
      index += 1;
      continue;
    }
    // "point" between two numbers is a decimal point.
    if (token === "point" && out.length > 0 && /^\d+$/.test(out[out.length - 1]) && nextIsNumeric(index + 1)) {
      let decimals = "";
      index += 1;
      while (index < tokens.length && (UNITS.get(tokens[index]) ?? 10) < 10) {
        decimals += String(UNITS.get(tokens[index]));
        index += 1;
      }
      out[out.length - 1] += `.${decimals}`;
      continue;
    }
    if (ORDINALS.has(token)) {
      const value = ORDINALS.get(token)!;
      out.push(`${value}${ordinalSuffix(value)}`);
      index += 1;
      continue;
    }
    if (!isNumberWord(token)) {
      out.push(token);
      index += 1;
      continue;
    }

    // One cardinal group: "four thousand two hundred and fifty" -> 4250.
    // A word that cannot extend the group ("two" after "two", "fourteen"
    // after "two") closes it, and the next group is joined on as digits.
    let total = 0;
    let small = 0;
    let last: "unit" | "teen" | "tens" | "mult" | null = null;
    while (index < tokens.length) {
      const word = tokens[index];
      const unit = UNITS.get(word);
      const tens = TENS.get(word);
      const mult = MULTIPLIERS.get(word);
      if (word === "and" && last === "mult" && isNumberWord(tokens[index + 1] ?? "")) {
        index += 1;
        continue;
      }
      if (unit !== undefined && unit < 10) {
        if (last === null || last === "mult" || (last === "tens" && small % 10 === 0)) {
          small += unit;
          last = "unit";
          index += 1;
          continue;
        }
        break;
      }
      if (unit !== undefined) {
        if (last === null || last === "mult") {
          small += unit;
          last = "teen";
          index += 1;
          continue;
        }
        break;
      }
      if (tens !== undefined) {
        if (last === null || last === "mult") {
          small += tens;
          last = "tens";
          index += 1;
          continue;
        }
        break;
      }
      if (mult !== undefined && last !== null && last !== "mult") {
        if (mult === 100) {
          small *= 100;
        } else {
          total += small * mult;
          small = 0;
        }
        last = "mult";
        index += 1;
        continue;
      }
      break;
    }
    if (last === null) {
      // A bare multiplier ("hundred") with nothing to multiply.
      out.push(token);
      index += 1;
      continue;
    }
    pushNumber(String(total + small));
    // "two hundred and first": the ordinal word that follows is scored
    // apart from the group (see `splitWrittenOrdinal`), so the "and" that
    // joined them goes too, as it does inside a group.
    if (last === "mult" && tokens[index] === "and" && ORDINALS.has(tokens[index + 1] ?? "")) {
      index += 1;
    }
  }
  return out;
}

export function normalizeForWer(text: string | null | undefined): string[] {
  const prepared = String(text ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[‘’]/g, "'")
    // Written forms that read as words: "$12" -> "12 dollars", "8%" ->
    // "8 percent", "4,250" -> "4250", "3:30" -> "330" (a spoken "three
    // thirty" joins the same way).
    .replace(/\$(\d[\d,]*(?:\.\d+)?)/g, "$1 dollars")
    .replace(/%/g, " percent")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/(\d):(\d)/g, "$1$2")
    // Hyphens and slashes split words ("twenty-five", "555-1234", "and/or").
    .replace(/[-/]/g, " ");
  const tokens =
    // Keep decimals ("8.2") and in-word apostrophes ("don't") whole.
    prepared.match(/\p{N}+(?:\.\p{N}+)+|[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
  return normalizeNumbers(tokens.map((token) => (token === "ok" ? "okay" : token)));
}

/**
 * Minimum edit alignment between reference and hypothesis words.
 * Returns the counts of substitutions, deletions and insertions.
 */
export function alignWords(
  referenceWords: string[],
  hypothesisWords: string[],
): WordAlignmentCounts {
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

export function scoreUtterance(reference: string, hypothesis: string): UtteranceScore {
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
export function aggregateWer(scores: UtteranceScore[]): CorpusScore {
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
