export interface ProviderTranscriptionOnlyBudgets {
  minimumSamples: number;
  coldModelPreparationMs: number;
  warmupInferenceMs: number;
  transcriptionMsP50: number;
  transcriptionMsP95: number;
  minimumMemoryBytes: number;
}

export interface PipelineBudgets {
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
  budgets: Readonly<ProviderTranscriptionOnlyBudgets> | Readonly<PipelineBudgets> | null;
}

export const BETA_REFERENCE_BUDGETS: Readonly<ProviderTranscriptionOnlyBudgets>;
export const PIPELINE_BUDGETS: Readonly<PipelineBudgets>;

export function verifyDictationLatencyReport(
  report: unknown,
  options?: { requireReferenceHardware?: boolean },
): DictationLatencyVerificationResult;
