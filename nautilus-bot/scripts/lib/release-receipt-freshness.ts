export type ReleaseReceiptBinding =
  | { candidateBound: false; expectedIdentitySha256?: unknown; receiptIdentitySha256?: unknown }
  | {
      candidateBound: true;
      expectedIdentitySha256: unknown;
      receiptIdentitySha256: unknown;
    };

export function evaluateReleaseReceiptFreshness({
  candidateBound,
  expectedIdentitySha256,
  receiptIdentitySha256,
}: ReleaseReceiptBinding): { current: boolean; reason: string } {
  if (!candidateBound) {
    return { current: true, reason: "not-candidate-bound" };
  }
  const validSha256 = (value: unknown): value is string =>
    typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
  if (
    !validSha256(expectedIdentitySha256) ||
    !validSha256(receiptIdentitySha256) ||
    expectedIdentitySha256 !== receiptIdentitySha256
  ) {
    return { current: false, reason: "candidate-identity-mismatch" };
  }
  return { current: true, reason: "exact-candidate-identity" };
}
