import type { AnalysisProvenance, ActionItemsProvenance } from "./asr";

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
  summaryProvenance?: AnalysisProvenance | null;
  actionItemsProvenance?: ActionItemsProvenance | null;
  meetingNotes?: string | null;
  meetingTemplateId?: string | null;
  meetingCaptureMode?: "mic_only" | "me_and_them" | null;
  notesUpdatedAt?: string | null;
  consentPromptShown?: boolean;
  consentNoticeMode?: string | null;
  consentNoticeSurface?: string | null;
  consentNoticeMessage?: string | null;
  consentNoticeUpdatedAt?: string | null;
  /**
   * Meeting data-integrity facts. Optional because a sidecar that predates
   * them omits them entirely, and the renderer must degrade to making no claim
   * rather than to making a wrong one — see `src/lib/meeting-recovery.ts`,
   * which is the only thing that should read them.
   */
  transcriptComplete?: boolean | null;
  transcriptDegradedReason?: string | null;
  transcriptIncompleteAcknowledgedAt?: string | null;
  captureDegradedSummary?: string | null;
}

interface RecordingMetadata {
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
  speakerId?: string | null;
  confidence: number;
}

export interface MeetingTranscriptDetails {
  segmentCount: number;
  model?: string | null;
  modelId?: string | null;
  requestedProvider?: string | null;
  actualProvider?: string | null;
  qualityScore?: number | null;
  transcriptionLatencyMs?: number | null;
  sourceMode: "me_them" | "speaker_labels" | "single_source" | "unknown" | string;
  hasSourceAwareSpeakers: boolean;
  hasSpeakerLabels: boolean;
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

// ASR Types
export * from "./asr";
export * from "./settings";
