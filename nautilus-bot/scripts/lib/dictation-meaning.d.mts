export interface DictationMeaningInvariant {
  kind: string;
  label: string;
  anyOf?: string[];
  terms?: string[];
}

export interface DictationMeaningFixture {
  referenceOutput: string;
  criticalInvariants: DictationMeaningInvariant[];
  dictionary?: Array<{ spokenForm: string; replacement: string }>;
}

export interface DictationMeaningScore {
  status: "pass" | "fail" | "needs_human_review";
  needsHumanReview: boolean;
  violations: string[];
  editDistance: number;
  normalizedCandidate: string;
  normalizedReference: string;
}

export function normalizeMeaningText(value: unknown): string;
export function scoreMeaningCandidate(
  fixture: DictationMeaningFixture,
  candidate: string,
): DictationMeaningScore;
