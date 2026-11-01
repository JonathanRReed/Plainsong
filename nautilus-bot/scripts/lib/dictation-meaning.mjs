const SPOKEN_NUMBER_REPLACEMENTS = [
  [/\bzero point five\b/g, "0.5"],
  [/\bfifteen thousand\b/g, "15000"],
  [/\btwelve thousand\b/g, "12000"],
  [/\bsixty\b/g, "60"],
  [/\bforty\b/g, "40"],
  [/\bthree thirty\b/g, "3 30"],
  [/\btwo thirty\b/g, "2 30"],
  [/\bthree hours\b/g, "3 hours"],
  [/\bthree reviewers\b/g, "3 reviewers"],
];

/**
 * Declared spelling normalization keeps semantic punctuation intact for
 * reference matching. Lexical checks below use a punctuation-free view.
 */
function normalizeMeaningSpelling(value) {
  let text = String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/−/g, "-")
    .replace(/[’‘]/g, "'")
    .replace(/\bcan't\b/g, "can not")
    .replace(/\bdon't\b/g, "do not")
    .replace(/\bhaven't\b/g, "have not")
    .replace(/\bwon't\b/g, "will not")
    .replace(/(^|[^\p{L}\p{N}_.])\.(?=[0-9])/gu, (_, prefix) => `${prefix}0.`)
    .replace(/(-?)\$\s*(-?)([0-9][0-9,]*(?:\.[0-9]+)?)/g, "$1$2$3 dollars")
    .replace(/[0-9]+(?:,[0-9]+)+/g, value =>
      /^[0-9]{1,3}(?:,[0-9]{3})+$/.test(value) ? value.replaceAll(",", "") : value)
    .replace(/%/g, " percent")
    .replace(/(^|\s)-(?=\d)/g, "$1negative ");

  for (const [pattern, replacement] of SPOKEN_NUMBER_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }

  return text
    .replace(/\bp\s*\.?\s*m\s*\.?\b/g, "pm")
    .replace(/\ba\s*\.?\s*m\s*\.?\b/g, "am")
    .replace(/[“”]/g, '"')
    .replace(/\?+/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeMeaningText(value) {
  return normalizeMeaningSpelling(value)
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function wordEditDistance(left, right) {
  const a = normalizeMeaningText(left).split(" ").filter(Boolean);
  const b = normalizeMeaningText(right).split(" ").filter(Boolean);
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

function tokens(value) {
  return normalizeMeaningText(value).split(" ").filter(Boolean);
}

function findTokenPhrase(haystackTokens, phrase, start = 0) {
  const phraseTokens = tokens(phrase);
  if (phraseTokens.length === 0) return -1;
  for (let index = start; index <= haystackTokens.length - phraseTokens.length; index += 1) {
    if (phraseTokens.every((token, offset) => haystackTokens[index + offset] === token)) {
      return index;
    }
  }
  return -1;
}

function invariantViolation(invariant, candidate, normalizedCandidate) {
  const candidateTokens = tokens(normalizedCandidate);
  if (invariant.kind === "include") {
    const matched = invariant.anyOf.some((value) => findTokenPhrase(candidateTokens, value) >= 0);
    return matched ? null : `Missing ${invariant.label}`;
  }

  if (invariant.kind === "exclude") {
    const matched = invariant.anyOf.some((value) => findTokenPhrase(candidateTokens, value) >= 0);
    return matched ? `Retained ${invariant.label}` : null;
  }

  if (invariant.kind === "literal_include") {
    const matched = invariant.anyOf.some((value) => String(candidate).includes(value));
    return matched ? null : `Missing exact ${invariant.label}`;
  }

  if (invariant.kind === "ordered") {
    let cursor = 0;
    for (const term of invariant.terms) {
      const normalizedTerm = tokens(term);
      const position = findTokenPhrase(candidateTokens, term, cursor);
      if (position < 0) return `Missing or reordered ${invariant.label}`;
      cursor = position + normalizedTerm.length;
    }
    return null;
  }

  return `Unknown invariant kind for ${invariant.label}`;
}

/**
 * This scorer catches declared lexical invariant violations. A candidate that
 * keeps those invariants but differs from the reference needs human review.
 * The result must not be used as an automated semantic-superiority verdict.
 */
export function scoreMeaningCandidate(fixture, candidate) {
  const normalizedCandidate = normalizeMeaningText(candidate);
  const normalizedReference = normalizeMeaningText(fixture.referenceOutput);
  const violations = fixture.criticalInvariants
    .map((invariant) => invariantViolation(invariant, candidate, normalizedCandidate))
    .filter(Boolean);
  const editDistance = wordEditDistance(candidate, fixture.referenceOutput);

  if (violations.length > 0) {
    return {
      status: "fail",
      needsHumanReview: false,
      violations,
      editDistance,
      normalizedCandidate,
      normalizedReference,
    };
  }

  const matchesReference = normalizeMeaningSpelling(candidate)
    === normalizeMeaningSpelling(fixture.referenceOutput);
  return {
    status: matchesReference ? "pass" : "needs_human_review",
    needsHumanReview: !matchesReference,
    violations: [],
    editDistance,
    normalizedCandidate,
    normalizedReference,
  };
}
