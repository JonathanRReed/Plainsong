export interface DictationLatencyVerificationResult {
  pass: boolean;
  failures: string[];
  budgets: Readonly<{
    minimumSamples: number;
    coldModelPreparationMs: number;
    warmupInferenceMs: number;
    transcriptionMsP50: number;
    transcriptionMsP95: number;
    minimumMemoryBytes: number;
  }>;
}

export const BETA_REFERENCE_BUDGETS: DictationLatencyVerificationResult["budgets"];

export function verifyDictationLatencyReport(
  report: unknown,
  options?: { requireReferenceHardware?: boolean },
): DictationLatencyVerificationResult;
