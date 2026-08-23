export function evaluateReleaseReceiptFreshness(input: {
  candidateBound: boolean;
  candidateBuiltAtMs: number | null;
  generatedAt: unknown;
  expectedIdentitySha256?: unknown;
  receiptIdentitySha256?: unknown;
}): {
  current: boolean;
  reason: string;
};
