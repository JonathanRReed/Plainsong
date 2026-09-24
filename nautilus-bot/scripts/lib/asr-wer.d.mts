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

export function normalizeForWer(text: string | null | undefined): string[];
export function alignWords(referenceWords: string[], hypothesisWords: string[]): WordAlignmentCounts;
export function scoreUtterance(reference: string, hypothesis: string): UtteranceScore;
export function aggregateWer(scores: UtteranceScore[]): CorpusScore;
