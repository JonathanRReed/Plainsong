export interface AsrProviderInfo {
  providerType: AsrProviderType;
  name: string;
  description: string;
  isAvailable: boolean;
  inferenceEnabled: boolean;
  modelInfo: AsrModelInfo;
  downloadStatus: DownloadStatus;
  runtimeStatus: AsrRuntimeStatus;
  runtimeMessage?: string;
  runtimeDetails: AsrRuntimeDetails;
}

export type AsrRuntimeStatus = "ready" | "missing_runtime" | "missing_model" | "error";

export interface AsrRuntimeDetails {
  pythonPath?: string;
  modelPath?: string;
}

export interface AsrRuntimeDiagnostics {
  providerType: AsrProviderType;
  runtimeStatus: AsrRuntimeStatus;
  runtimeMessage?: string;
  runtimeDetails: AsrRuntimeDetails;
}

export interface AsrModelInfo {
  name: string;
  version: string;
  sizeMb: number;
  parameters: string;
  languages: string[];
  wordErrorRate?: number;
  realTimeFactor?: number;
  license: string;
  sourceUrl: string;
}

export type DownloadStatus =
  | "NotDownloaded"
  | "Downloaded"
  | "Downloading"
  | "Error"
  | { NotDownloaded: Record<string, never> }
  | { Downloaded: Record<string, never> }
  | { Downloading: { progress: number } }
  | { Error: string | { 0: string } };

export interface BenchmarkResult {
  providerType: AsrProviderType;
  providerName: string;
  processingTimeMs: number;
  transcription: string;
  confidence: number;
}

export type AsrProviderType = "whisper" | "parakeet" | "canary" | "distil_whisper";

// LLM Types
export interface LlmAnalysisResult {
  query: string;
  response: string;
  citations: LlmCitation[];
  model: string;
  processingTimeMs: number;
}

export interface LlmCitation {
  text: string;
  startTime?: number;
  endTime?: number;
}

export interface ActionItem {
  task: string;
  assignee?: string;
  deadline?: string;
}

export interface AnalysisTemplate {
  id: string;
  name: string;
  icon: string;
  query: string;
  description: string;
}
