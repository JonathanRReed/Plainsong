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

function uniqueWords(value) {
  const words =
    String(value ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)];
}

export function matchSpokenFixture(transcriptText, fixtureText) {
  const transcriptTokens = uniqueWords(transcriptText);
  const fixtureTokens = uniqueWords(fixtureText);
  const distinctiveFixtureTokens = fixtureTokens.filter(
    (token) => token.length >= 4 && !STOP_WORDS.has(token),
  );
  const expectedTokens =
    distinctiveFixtureTokens.length > 0 ? distinctiveFixtureTokens : fixtureTokens;
  const transcriptTokenSet = new Set(transcriptTokens);
  const matchedTokens = expectedTokens.filter((token) => transcriptTokenSet.has(token));
  const requiredMatchCount = Math.min(3, expectedTokens.length);

  return {
    matched:
      requiredMatchCount > 0 && matchedTokens.length >= requiredMatchCount,
    requiredMatchCount,
    matchedTokens,
    missingTokens: expectedTokens.filter((token) => !transcriptTokenSet.has(token)),
    expectedTokens,
    transcriptTokens,
  };
}
