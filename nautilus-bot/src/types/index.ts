import type { AnalysisProvenance, ActionItemsProvenance } from "./asr";

/**
 * The capture mode written for a meeting that came from a file rather than a
 * microphone. Mirrors `IMPORTED_MEETING_CAPTURE_MODE` in
 * rust-sidecar/src/lib.rs.
 */
export const MEETING_CAPTURE_MODE_IMPORTED = "imported";

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
  meetingCaptureMode?: "mic_only" | "me_and_them" | typeof MEETING_CAPTURE_MODE_IMPORTED | null;
  /**
   * The file name an imported meeting came from, without its folder. Absent
   * for every meeting Plainsong recorded itself. Mirrors
   * `imported_source_name` in rust-sidecar/src/models.rs.
   */
  importedSourceName?: string | null;
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
  /**
   * Every pause taken while recording, in order. The saved audio skips the
   * pauses; `atSeconds` is where each gap sits in it. Absent or empty for a
   * meeting that was never paused or that predates the feature.
   */
  pauseSpans?: PauseSpan[];
  /**
   * The conferencing service this meeting was on, when the calendar event or
   * the detected call it started from named one. Mirrors `video_service` in
   * rust-sidecar/src/models.rs, which only stores keys it recognizes.
   */
  videoService?: string | null;
}

/** Mirrors `PauseSpan` in rust-sidecar/src/recording_pause.rs. */
export interface PauseSpan {
  startedAtMs: number;
  endedAtMs: number | null;
  atSeconds: number;
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
