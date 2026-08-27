export interface ProviderTranscriptionOnlyBudgets {
  minimumSamples: number;
  coldModelPreparationMs: number;
  warmupInferenceMs: number;
  transcriptionMsP50: number;
  transcriptionMsP95: number;
  minimumMemoryBytes: number;
}

export interface EndToEndBudgets {
  minimumSamples: number;
  formatOffP50Ms: number;
  formatOffP95Ms: number;
  formatOnP50Ms: number;
  formatOnP95Ms: number;
  minimumMemoryBytes: number;
}

export interface DictationLatencyVerificationResult {
  pass: boolean;
  failures: string[];
  /**
   * The budgets object for whichever scope was verified, or `null` when the
   * report's `metricScope` was missing or unrecognized (verification fails
   * before any budget applies).
   */
  budgets: Readonly<ProviderTranscriptionOnlyBudgets> | Readonly<EndToEndBudgets> | null;
}

export const BETA_REFERENCE_BUDGETS: Readonly<ProviderTranscriptionOnlyBudgets>;
export const END_TO_END_BUDGETS: Readonly<EndToEndBudgets>;

export function verifyDictationLatencyReport(
  report: unknown,
  options?: { requireReferenceHardware?: boolean },
): DictationLatencyVerificationResult;
