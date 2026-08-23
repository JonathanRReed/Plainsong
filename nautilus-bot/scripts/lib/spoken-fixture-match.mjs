const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "before",
  "being",
  "contain",
  "could",
  "from",
  "have",
  "into",
  "should",
  "that",
  "their",
  "there",
  "these",
  "this",
  "through",
  "with",
  "would",
]);

function words(value) {
  return (
    String(value ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function uniqueWords(value) {
  return [...new Set(words(value))];
}

export function matchSpokenFixture(transcriptText, fixtureText) {
  const transcriptWords = words(transcriptText);
  const transcriptTokens = [...new Set(transcriptWords)];
  const fixtureTokens = uniqueWords(fixtureText);
  const distinctiveFixtureTokens = fixtureTokens.filter(
    (token) => token.length >= 4 && !STOP_WORDS.has(token),
  );
  const expectedTokens =
    distinctiveFixtureTokens.length > 0 ? distinctiveFixtureTokens : fixtureTokens;
  const transcriptTokenSet = new Set(transcriptTokens);
  const matchedTokens = expectedTokens.filter((token) => transcriptTokenSet.has(token));
  const shortFixture = expectedTokens.length <= 4;
  const minimumCoverage = shortFixture ? 1 : 0.6;
  const minimumOrderedCoverage = shortFixture ? 1 : 0.6;
  const requiredMatchCount = shortFixture
    ? expectedTokens.length
    : Math.max(4, Math.ceil(expectedTokens.length * minimumCoverage));

  let transcriptCursor = -1;
  const orderedMatchedTokens = [];
  for (const token of expectedTokens) {
    const nextIndex = transcriptWords.indexOf(token, transcriptCursor + 1);
    if (nextIndex >= 0) {
      orderedMatchedTokens.push(token);
      transcriptCursor = nextIndex;
    }
  }

  const orderedTokenSet = new Set(orderedMatchedTokens);
  const orderViolations = matchedTokens.filter(
    (token) => !orderedTokenSet.has(token),
  );
  const coverage = expectedTokens.length
    ? matchedTokens.length / expectedTokens.length
    : 0;
  const orderedCoverage = expectedTokens.length
    ? orderedMatchedTokens.length / expectedTokens.length
    : 0;
  const missingTokens = expectedTokens.filter(
    (token) => !transcriptTokenSet.has(token),
  );

  return {
    matched:
      requiredMatchCount > 0 &&
      matchedTokens.length >= requiredMatchCount &&
      coverage >= minimumCoverage &&
      orderedCoverage >= minimumOrderedCoverage,
    requiredMatchCount,
    minimumCoverage,
    minimumOrderedCoverage,
    coverage,
    orderedCoverage,
    matchedTokens,
    orderedMatchedTokens,
    orderViolations,
    missingTokens,
    omissions: missingTokens,
    expectedTokens,
    transcriptTokens,
    transcriptLength: {
      characters: String(transcriptText ?? "").trim().length,
      tokens: transcriptWords.length,
    },
  };
}
