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
  summary?: string;
  actionItems?: string[];
  meetingNotes?: string | null;
  meetingTemplateId?: string | null;
  notesUpdatedAt?: string | null;
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
  modelId?: string | null;
  requestedProvider?: string | null;
  actualProvider?: string | null;
  requestedEngine?: string | null;
  actualEngine?: string | null;
  optimizationApplied?: boolean | null;
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
