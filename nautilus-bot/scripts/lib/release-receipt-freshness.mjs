const RECEIPT_TIMESTAMP_TOLERANCE_MS = 1_000;

export function evaluateReleaseReceiptFreshness({
  candidateBound,
  candidateBuiltAtMs,
  generatedAt,
  expectedIdentitySha256,
  receiptIdentitySha256,
}) {
  if (!candidateBound) {
    return { current: true, reason: "not-candidate-bound" };
  }
  if (expectedIdentitySha256 !== undefined) {
    const validSha256 = (value) =>
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
  if (!Number.isFinite(candidateBuiltAtMs)) {
    return { current: false, reason: "missing-candidate-timestamp" };
  }

  const generatedAtMs = Date.parse(String(generatedAt ?? ""));
  if (!Number.isFinite(generatedAtMs)) {
    return { current: false, reason: "invalid-generated-at" };
  }

  return generatedAtMs >= candidateBuiltAtMs - RECEIPT_TIMESTAMP_TOLERANCE_MS
    ? { current: true, reason: "current-candidate" }
    : { current: false, reason: "receipt-predates-candidate" };
}
