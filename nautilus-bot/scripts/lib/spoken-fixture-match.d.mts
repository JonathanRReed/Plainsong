export interface SpokenFixtureMatch {
  matched: boolean;
  requiredMatchCount: number;
  matchedTokens: string[];
  missingTokens: string[];
  expectedTokens: string[];
  transcriptTokens: string[];
}

export function matchSpokenFixture(
  transcriptText: unknown,
  fixtureText: unknown,
): SpokenFixtureMatch;
