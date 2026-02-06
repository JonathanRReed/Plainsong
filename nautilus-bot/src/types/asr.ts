export interface AsrProviderInfo {
  providerType: "whisper";
  name: string;
  description: string;
  isAvailable: boolean;
  modelInfo: AsrModelInfo;
  downloadStatus: DownloadStatus;
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

export interface DownloadStatus {
  NotDownloaded?: {};
  Downloading?: { progress: number };
  Downloaded?: {};
  Error?: { 0: string };
}

export interface BenchmarkResult {
  providerType: "whisper";
  providerName: string;
  processingTimeMs: number;
  transcription: string;
  confidence: number;
}

export type AsrProviderType = "whisper";

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
