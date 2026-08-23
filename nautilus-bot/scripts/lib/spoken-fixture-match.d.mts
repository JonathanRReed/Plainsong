export interface SpokenFixtureMatch {
  matched: boolean;
  requiredMatchCount: number;
  minimumCoverage: number;
  minimumOrderedCoverage: number;
  coverage: number;
  orderedCoverage: number;
  matchedTokens: string[];
  orderedMatchedTokens: string[];
  orderViolations: string[];
  missingTokens: string[];
  omissions: string[];
  expectedTokens: string[];
  transcriptTokens: string[];
  transcriptLength: { characters: number; tokens: number };
}

export function matchSpokenFixture(
  transcriptText: unknown,
  fixtureText: unknown,
): SpokenFixtureMatch;
