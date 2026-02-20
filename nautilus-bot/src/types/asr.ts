export interface AsrProviderInfo {
  providerType: AsrProviderType;
  name: string;
  description: string;
  isAvailable: boolean;
  inferenceEnabled: boolean;
  modelInfo: AsrModelInfo;
  selectedModelId: string;
  modelOptions: AsrModelOption[];
  downloadStatus: DownloadStatus;
  runtimeStatus: AsrRuntimeStatus;
  runtimeMessage?: string;
  runtimeDetails: AsrRuntimeDetails;
}

export interface AsrModelOption {
  id: string;
  label: string;
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

export type AsrProviderType =
  | "whisper"
  | "parakeet"
  | "canary"
  | "distil_whisper"
  | "moonshine"
  | "vibevoice"
  | "voxtral"
  | "elevenlabs_scribe"
  | "openai_cloud";

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
  recordingId?: string;
  certainty?: number;
}

export interface ActionItem {
  task: string;
  assignee?: string;
  deadline?: string;
}

export interface SearchHit {
  recordingId: string;
  recordingTitle: string;
  projectId: string;
  segmentId: string;
  text: string;
  startTime: number;
  endTime: number;
  score: number;
}

export interface AsrBenchmarkEntry {
  id: string;
  providerType: string;
  providerName: string;
  modelId: string;
  runtimeStatus: string;
  processingTimeMs: number;
  confidence: number;
  createdAt: string;
}

export interface AnalysisTemplate {
  id: string;
  name: string;
  icon: string;
  query: string;
  description: string;
}
