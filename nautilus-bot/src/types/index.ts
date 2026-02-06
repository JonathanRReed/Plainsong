export interface Recording {
  id: string;
  title: string;
  projectId: string;
  duration: number;
  createdAt: string;
  updatedAt: string;
  sourceType: string;
  audioPath: string;
  transcript?: Transcript;
  metadata?: RecordingMetadata;
  status: "recording" | "processing" | "completed" | "error";
}

export interface RecordingMetadata {
  deviceName?: string;
  sampleRate: number;
  channels: number;
  systemAudio: boolean;
  participants?: string[];
}

export interface Transcript {
  id: string;
  recordingId: string;
  segments: TranscriptSegment[];
  fullText: string;
  language: string;
  confidence: number;
  model: string;
  createdAt?: string;
}

export interface TranscriptSegment {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
  speakerId?: string;
  confidence: number;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  parentId?: string;
  createdAt: string;
  updatedAt: string;
  encrypted: boolean;
  keySalt?: string | null;
  keyHint?: string | null;
}

export interface ProjectSettings {
  retentionDays?: number;
  encryptionEnabled: boolean;
  defaultTranscriptionModel: "speed" | "accuracy";
  llmProvider: string;
}

export interface AnalysisResult {
  id: string;
  recordingId: string;
  type: "summary" | "action_items" | "decisions" | "dates" | "custom";
  content: string;
  citations: Citation[];
  createdAt: string;
  model: string;
}

export interface Citation {
  segmentId: string;
  startTime: number;
  endTime: number;
  text: string;
}

export interface ExportBundle {
  id: string;
  recordingId: string;
  format: "markdown" | "pdf" | "json" | "evidence_bundle";
  content: string;
  exportedAt: string;
  target?: string;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  event: string;
  details: Record<string, unknown>;
  severity: "info" | "warning" | "error" | string;
}

// ASR Types
export * from "./asr";
export * from "./settings";
