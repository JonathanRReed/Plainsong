import { invoke } from "@/lib/electron";
import type {
  PauseSpan,
  Recording,
  Project,
  Transcript,
  AsrProviderInfo,
  AsrProviderInventory,
  AsrProviderType,
  LlmAnalysisResult,
  ActionItem,
  GroundedSummaryResult,
  GroundedActionItemsResult,
  AnalysisProvenance,
  ActionItemsProvenance,
  SearchHit,
  MeetingTranscriptDetails,
} from "@/types";
import type { Settings } from "@/types/settings";
import type { MeetingAttendee } from "@/lib/attendees";
import type { DictationBindingIssue } from "../../electron/dictation-bindings";

export interface DictationStartOptions {
  saveToInbox: boolean;
  projectId?: string;
  profile: "normal_speed" | "power_rewrite";
  contextSource?: "none" | "clipboard" | "selected_text" | "application_context";
  routePreference?: "local" | "cloud";
  languageOverride?: string | null;
  livePreviewEnabled?: boolean;
  deliveryMode?: "system" | "preview";
}

export interface DictationHistoryDetails {
  modePreset: string | null;
  modeLabel: string | null;
  baseModePreset: string | null;
  baseModeLabel: string | null;
  customModeId: string | null;
  customModeName: string | null;
  contextSource: string | null;
  contextAppName: string | null;
  appTarget: string | null;
  activationMatcher: string | null;
  commandApplied: string | null;
  dictionaryAppliedCount: number | null;
  snippetAppliedCount: number | null;
  formattingApplied: boolean | null;
  recentInsertReused: boolean | null;
  pipelineStageKeys: string[];
  promptSource: string | null;
  promptPreview: string | null;
  requestedProvider: string | null;
  actualProvider: string | null;
  modelId: string | null;
  routePreference: string | null;
  resolvedHosting: string | null;
  startupLatencyMs: number | null;
  transcriptionLatencyMs: number | null;
  insertLatencyMs: number | null;
  endToEndMs: number | null;
  /** BCP-47 primary tag the recognizer reported for the spoken audio. */
  detectedLanguage?: string | null;
  /** `whisper_native` | `ai_lane` when translate-to-English ran; null when off. */
  translationRoute?: string | null;
  /** Whether the delivered text is the translated one. */
  translationApplied?: boolean | null;
  /** What the recognizer heard, when the dictation was saved with it. */
  rawTranscript?: string | null;
  /** Whether the kept audio is still on disk; null when none was kept. */
  audioAvailable?: boolean | null;
  /** Set on a "Process again" entry: the dictation whose audio it re-ran. */
  reprocessedFromId?: string | null;
  reprocessedFromCreatedAt?: string | null;
}

export interface DictationInsights {
  totalDictations: number;
  dictatedWords: number;
  averageWordsPerDictation: number;
  activeDays: number;
  lastSevenDaysDictations: number;
  commandsUsed: number;
  backtracksUsed: number;
  snippetsTriggered: number;
  topAppTarget: string | null;
  topAppTargetCount: number;
}

interface MeetingChatCitation {
  text: string;
  startTime?: number | null;
  endTime?: number | null;
  recordingId?: string | null;
  certainty?: number | null;
}

export interface MeetingChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  templateId?: string | null;
  citations: MeetingChatCitation[];
  createdAt: string;
}

interface RelationshipMemoryEvidence {
  recordingId: string;
  recordingTitle: string;
  createdAt: string;
  snippet: string;
}

export interface PersonMemoryProfile {
  id: string;
  name: string;
  recordingCount: number;
  lastSeenAt: string;
  relatedCompanies: string[];
  recentMeetings: RelationshipMemoryEvidence[];
}

export interface CompanyMemoryProfile {
  id: string;
  name: string;
  recordingCount: number;
  lastSeenAt: string;
  relatedPeople: string[];
  recentMeetings: RelationshipMemoryEvidence[];
}

export interface RelationshipMemory {
  people: PersonMemoryProfile[];
  companies: CompanyMemoryProfile[];
}

/**
 * What Plainsong knows about the meeting the user is about to record and the
 * notice they are expected to send themselves. Plainsong never posts the
 * notice into a meeting chat; `message` names the detected meeting app (Zoom,
 * Google Meet) only so the copy can say where the user should send it.
 */
export interface MeetingConsentNoticeStatus {
  surface?: "zoom" | "google_meet" | string | null;
  appName?: string | null;
  appBundleId?: string | null;
  browserUrl?: string | null;
  message: string;
  noticeText: string;
}

export async function startDictation(options?: DictationStartOptions): Promise<void> {
  await invoke("start_dictation", { options });
}

export async function stopDictation(): Promise<string> {
  const result = await invoke<unknown>("stop_dictation");
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const text = (result as { text?: unknown }).text;
    if (typeof text === "string") {
      return text;
    }
  }
  throw new Error("Plainsong returned an invalid dictation stop result.");
}

export interface DictationReprocessResult {
  modePreset: string;
  outputText: string;
  usedAi: boolean;
  provider: string | null;
  modelId: string | null;
}

export async function reprocessDictationText(
  text: string,
  modePreset: string,
  appTarget?: string | null
): Promise<DictationReprocessResult> {
  return await invoke("reprocess_dictation_text", { text, modePreset, appTarget });
}

export async function getDictationHistoryDetails(
  recordingId: string
): Promise<DictationHistoryDetails | null> {
  return await invoke("get_dictation_history_details", { recordingId });
}

export async function getDictationInsights(): Promise<DictationInsights> {
  return await invoke("get_dictation_insights");
}

/**
 * One ranked hit from dictation history search. `snippet` wraps each matched
 * term in `[[`/`]]`; `matchedField` says whether the delivered text
 * (`final`) or what the recognizer heard (`raw`) matched.
 */
export interface DictationHistorySearchHit {
  recordingId: string;
  recordingTitle: string;
  createdAt: string;
  snippet: string;
  matchedField: "final" | "raw" | string;
  score: number;
}

export async function searchDictationHistory(
  query: string,
  options: { limit?: number; offset?: number } = {}
): Promise<DictationHistorySearchHit[]> {
  return await invoke("search_dictation_history", {
    query,
    limit: options.limit ?? 25,
    offset: options.offset ?? 0,
  });
}

/** What "Process again" was asked to do; only `historyId` is required. */
export interface DictationReprocessRequest {
  historyId: string;
  /** A built-in preset id or a custom mode id. Omit for the active mode. */
  modeId?: string | null;
  /** Override the dictation lane's engine for this run only. */
  provider?: string | null;
  modelId?: string | null;
}

/**
 * The new history entry "Process again" saved, plus what produced it. The
 * sidecar inserts nothing and touches no clipboard; the entry is the result.
 */
export interface DictationReprocessOutcome {
  recording: Recording;
  transcript: Transcript;
  finalText: string;
  rawText: string;
  modePreset: string;
  customModeId: string | null;
  customModeName: string | null;
  provider: string;
  modelId: string;
  usedAi: boolean;
  reprocessedFromId: string;
  reprocessedFromCreatedAt: string;
  transcriptionLatencyMs: number;
}

export async function reprocessDictation(
  request: DictationReprocessRequest
): Promise<DictationReprocessOutcome> {
  return await invoke("reprocess_dictation", {
    historyId: request.historyId,
    modeId: request.modeId ?? null,
    provider: request.provider ?? null,
    modelId: request.modelId ?? null,
  });
}

interface CursorInsertSmokeTestResult {
  text: string;
  targetApp?: string | null;
  targetBundleId?: string | null;
  pasted: boolean;
  copied: boolean;
  error?: string | null;
}

export async function smokeTestCursorInsert(
  text?: string
): Promise<CursorInsertSmokeTestResult> {
  return await invoke("smoke_test_cursor_insert", { text });
}

export async function captureSelectedTextForPlayback(): Promise<string | null> {
  return await invoke("capture_selected_text_for_playback");
}

// Keep in sync with the command keys the Rust sidecar actually resolves via
// `dictation_command_selected_text_label` in rust-sidecar/src/dictation_parity.rs.
// That function currently only recognizes a subset of these
// (rewrite_shorter, rewrite_professional, bulletize_selection, and the four
// case-transform commands); the rest are declared here for the full
// renderer metadata layer (src/lib/selected-text-actions.ts) and will 400
// from the backend until the Rust side adds support for them.
export type SelectedTextTransformCommand =
  | "proofread_text"
  | "rewrite_shorter"
  | "expand_text"
  | "continue_writing"
  | "simplify_language"
  | "rewrite_professional"
  | "rewrite_friendly"
  | "rewrite_casual"
  | "summarize_text"
  | "translate_english"
  | "explain_text"
  | "find_bugs"
  | "bulletize_selection"
  | "numbered_list_selection"
  | "polish_text"
  | "prompt_engineer"
  | "uppercase_selection"
  | "lowercase_selection"
  | "title_case_selection"
  | "sentence_case_selection";

export interface SelectedTextTransformResult {
  commandKey: string;
  inputText: string;
  outputText: string;
  targetScope?: "selection" | "focused_field" | null;
  targetApp?: string | null;
  targetBundleId?: string | null;
  pasted: boolean;
  copied: boolean;
  error?: string | null;
  usedAi: boolean;
  provider?: string | null;
  modelId?: string | null;
}

export async function transformSelectedText(
  commandKey: SelectedTextTransformCommand
): Promise<SelectedTextTransformResult> {
  return await invoke("transform_selected_text", { commandKey });
}

export async function getDictationAudioLevel(): Promise<number> {
  return await invoke("get_dictation_audio_level");
}

export async function startRecording(options: {
  mic: boolean;
  systemAudio: boolean;
  projectId: string;
  preferredInputDeviceId?: string;
  template?: string;
  meetingNotes?: string;
  /**
   * The `callId` of the detected call whose offer the reader accepted. The
   * sidecar binds this meeting's auto-stop to that call and to no other, so a
   * meeting started any other way must leave it out.
   */
  detectedCallId?: number;
  /** The conferencing service, stored with the recording as its tag. */
  videoService?: string;
}): Promise<string> {
  return await invoke("begin_meeting_capture", { options });
}

export interface AudioInputDeviceInfo {
  deviceId: string;
  deviceName: string;
  transportType?: "builtin" | "bluetooth" | "usb" | "virtual" | "unknown" | null;
  isDefault: boolean;
  isAvailable: boolean;
  isBluetoothLike: boolean;
  channelCount?: number | null;
  sampleRate?: number | null;
}

export interface AudioInputDeviceInventory {
  devices: AudioInputDeviceInfo[];
  appWideSelectedDeviceId?: string | null;
  dictationOverrideEnabled: boolean;
  dictationSelectedDeviceId?: string | null;
  meetingOverrideEnabled: boolean;
  meetingSelectedDeviceId?: string | null;
}

export async function listAudioInputDevices(): Promise<AudioInputDeviceInventory> {
  return await invoke("list_audio_input_devices");
}

export async function getMeetingConsentNoticeStatus(): Promise<MeetingConsentNoticeStatus> {
  return await invoke("get_meeting_consent_notice_status");
}

export async function stopRecording(recordingId: string): Promise<void> {
  await invoke("end_meeting_capture", { recordingId });
}

/** Mirrors `RecordingPauseSnapshot` in rust-sidecar/src/audio.rs. */
export interface RecordingPauseSnapshot {
  paused: boolean;
  closedPausedMs: number;
  pauseStartedAtMs: number | null;
  spans: PauseSpan[];
}

/**
 * Pause the live meeting: the microphone (and system audio) stay open, but
 * nothing captured until `resumeRecording` reaches the file, the preview, or
 * the transcript. The sidecar answers with the pause ledger and also emits
 * `meeting-recording-state-changed`, which is what every window renders from.
 */
export async function pauseRecording(recordingId: string): Promise<RecordingPauseSnapshot> {
  return await invoke("pause_recording", { recordingId });
}

export async function resumeRecording(recordingId: string): Promise<RecordingPauseSnapshot> {
  return await invoke("resume_recording", { recordingId });
}

/** Mirrors `ActiveCall` in rust-sidecar/src/meeting_detect.rs. */
export interface DetectedCall {
  callId: number;
  app: string;
  appLabel: string;
  videoService: string | null;
  bundleId: string;
  /**
   * Whether the call was found through a window rather than only through the
   * microphone. The title itself never leaves the sidecar: for Google Meet it
   * is the meeting's own name.
   */
  hasCallWindow: boolean;
  confidence: "medium" | "high";
  detectedAtMs: number;
  detectedAt: string;
  dismissed: boolean;
}

/** Mirrors `MeetingCallStatus` in rust-sidecar/src/meeting_detect.rs. */
export interface MeetingCallStatus {
  supported: boolean;
  enabled: boolean;
  accessibilityGranted: boolean;
  activeCall: DetectedCall | null;
}

const EMPTY_MEETING_CALL_STATUS: MeetingCallStatus = {
  supported: false,
  enabled: false,
  accessibilityGranted: false,
  activeCall: null,
};

function normalizeMeetingCallStatus(value: unknown): MeetingCallStatus {
  if (!value || typeof value !== "object") {
    return EMPTY_MEETING_CALL_STATUS;
  }
  const status = value as Partial<MeetingCallStatus>;
  const call = status.activeCall;
  return {
    supported: status.supported === true,
    enabled: status.enabled === true,
    accessibilityGranted: status.accessibilityGranted === true,
    activeCall:
      call && typeof call === "object" && typeof call.callId === "number"
        ? (call as DetectedCall)
        : null,
  };
}

/** What the call detector currently sees. Cannot start anything. */
export async function getMeetingCallStatus(): Promise<MeetingCallStatus> {
  return normalizeMeetingCallStatus(await invoke("get_meeting_call_status"));
}

/**
 * Wave away one detected call. Scoped to that call: the next call in the
 * same app is offered again.
 */
export async function dismissDetectedCall(callId: number): Promise<MeetingCallStatus> {
  return normalizeMeetingCallStatus(await invoke("dismiss_detected_call", { callId }));
}

export async function openRecordingAudio(recordingId: string): Promise<void> {
  await invoke("open_recording_audio", { recordingId });
}

/**
 * What the main process hands back for in-app playback: a token and the URL
 * the privileged `plainsong://playback` route answers for it. Never a path.
 */
interface PreparedPlayback {
  token: string;
  url: string;
  recordingId: string;
  protection: "plaintext" | "decrypted";
  durationSeconds: number;
}

export async function prepareRecordingPlayback(recordingId: string): Promise<PreparedPlayback> {
  return await invoke("prepare_recording_playback", { recordingId });
}

export async function releaseRecordingPlayback(token: string): Promise<void> {
  await invoke("release_recording_playback", { token });
}

export async function openExportPath(targetPath: string): Promise<void> {
  await invoke("open_export_path", { targetPath });
}

export async function getWaveformData(recordingId: string): Promise<number[]> {
  return await invoke("get_waveform_data", { recordingId });
}

export async function getRecordingWaveform(recordingId: string, points = 400): Promise<number[]> {
  return await invoke("get_recording_waveform", { recordingId, points });
}

export async function getRecordings(projectId?: string): Promise<Recording[]> {
  return await invoke("get_recordings", { projectId });
}

export async function getRecording(recordingId: string): Promise<Recording | null> {
  return await invoke("get_recording", { recordingId });
}

export async function getTranscript(recordingId: string): Promise<Transcript | null> {
  return await invoke("get_transcript", { recordingId });
}

export async function getMeetingTranscriptDetails(
  recordingId: string
): Promise<MeetingTranscriptDetails | null> {
  return await invoke("get_meeting_transcript_details", { recordingId });
}

export async function deleteRecording(recordingId: string): Promise<void> {
  await invoke("delete_recording", { recordingId });
}

/** Re-run the full transcription pipeline for a meeting whose audio file is
 * still on disk (recovery for interrupted or failed transcriptions). */
export async function retranscribeRecording(recordingId: string): Promise<void> {
  await invoke("retranscribe_recording", { recordingId });
}

/**
 * What the sidecar saved for an imported audio file. `null` means the user
 * dismissed the native file picker without choosing anything.
 */
export interface ImportedAudioFile {
  recordingId: string;
  title: string;
  sourceFileName: string;
  durationSeconds: number;
}

/**
 * Open the native "choose an audio file" dialog and import what the user
 * picks as a meeting.
 *
 * The renderer never names a path: Electron's main process shows the picker
 * and hands the chosen path straight to the sidecar. Resolves as soon as the
 * file has been decoded and saved; transcription then runs in the background
 * and reports through the same `recording-status-changed` events a stopped
 * meeting uses.
 */
export async function importAudioFile(): Promise<ImportedAudioFile | null> {
  return (await invoke("select_audio_file_to_import")) as ImportedAudioFile | null;
}

export async function renameRecording(recordingId: string, newTitle: string): Promise<void> {
  await invoke("rename_recording", { recordingId, newTitle });
}

/**
 * Replace a meeting's attendee list. Returns what the sidecar actually
 * stored, which is the sanitized list -- duplicates dropped, fields clipped
 * -- so the caller renders what is on disk rather than what it sent.
 */
export async function updateRecordingAttendees(
  recordingId: string,
  attendees: MeetingAttendee[],
): Promise<MeetingAttendee[]> {
  return await invoke("update_recording_attendees", { recordingId, attendees });
}

export async function updateRecordingNotes(
  recordingId: string,
  meetingNotes: string
): Promise<void> {
  await invoke("update_recording_notes", { recordingId, meetingNotes });
}

export interface RecordingAnalysisPatch {
  summary?: string | null;
  actionItems?: string[];
  summaryProvenance?: AnalysisProvenance;
  actionItemsProvenance?: ActionItemsProvenance;
}

export async function updateRecordingAnalysis(
  recordingId: string,
  patch: RecordingAnalysisPatch
): Promise<Recording> {
  return await invoke("update_recording_analysis", { recordingId, ...patch });
}

export async function updateRecordingTemplate(
  recordingId: string,
  meetingTemplateId: string | null
): Promise<void> {
  await invoke("update_recording_template", { recordingId, meetingTemplateId });
}

export async function getMeetingChatMessages(
  recordingId: string
): Promise<MeetingChatMessage[]> {
  return await invoke("get_meeting_chat_messages", { recordingId });
}

export async function updateMeetingChatMessages(
  recordingId: string,
  messages: MeetingChatMessage[]
): Promise<void> {
  await invoke("update_meeting_chat_messages", { recordingId, messages });
}

export async function editTranscriptSpeakerTurn(
  recordingId: string,
  segmentIds: string[],
  newText: string
): Promise<void> {
  await invoke("edit_transcript_speaker_turn", { recordingId, segmentIds, newText });
}

export async function deleteTranscriptSegments(
  recordingId: string,
  segmentIds: string[]
): Promise<number> {
  return await invoke("delete_transcript_segments", { recordingId, segmentIds });
}

export async function retryMeetingAutoName(recordingId: string): Promise<void> {
  await invoke("retry_meeting_auto_name", { recordingId });
}

/**
 * Re-run the meeting's summary, action items and title after they failed.
 * Progress arrives on the `meeting-analysis-status` event.
 */
export async function retryMeetingAnalysis(recordingId: string): Promise<void> {
  await invoke("retry_meeting_analysis", { recordingId });
}

/** One audio asset's state after a re-check, as the sidecar reports it. */
export interface RecordingAudioAssetReport {
  role: string;
  lifecycle: string;
  error?: string | null;
}

export interface RecordingAudioRevalidation {
  recordingId: string;
  /** Whether enough audio read back intact to re-transcribe from. */
  recoverable: boolean;
  message: string;
  assets: RecordingAudioAssetReport[];
}

/**
 * Re-read a meeting's saved audio and repair the lifecycle rows that describe
 * it. A stop-time failure can condemn audio that is actually intact, and every
 * runtime resolver refuses anything not marked `ready`; this is the way back
 * without a relaunch. The meeting's own status is deliberately untouched —
 * re-validating audio is evidence about files, not about transcription.
 */
export async function revalidateRecordingAudio(
  recordingId: string
): Promise<RecordingAudioRevalidation> {
  return await invoke("revalidate_recording_audio", { recordingId });
}

export interface IncompleteTranscriptAcknowledgement {
  recordingId: string;
  acknowledged: boolean;
  reason?: string | null;
}

/**
 * Record that the reader accepts losing the audio of a meeting whose transcript
 * is known incomplete. Storage policy holds that audio back precisely because
 * it is the only complete record of what was said; this releases it. It never
 * claims the transcript became complete — re-transcribing is what does that.
 */
export async function acknowledgeIncompleteTranscript(
  recordingId: string
): Promise<IncompleteTranscriptAcknowledgement> {
  return await invoke("acknowledge_incomplete_transcript", { recordingId });
}

export async function setRecordingSourceType(
  recordingId: string,
  sourceType: "meeting" | "dictation"
): Promise<void> {
  await invoke("set_recording_source_type", { recordingId, sourceType });
}

interface ExportResult {
  format: string;
  redactionLevel: "none" | "basic" | "strict" | string;
  preview: boolean;
  exportPath: string | null;
  content: string | null;
}

/**
 * File formats the sidecar can actually write. `docx` is a Word package built
 * from the Markdown export, so a `preview: true` call for it returns that
 * Markdown, not the bytes of the file.
 */
export type RecordingExportFormat =
  | "markdown"
  | "json"
  | "text"
  | "srt"
  | "vtt"
  | "docx";

export async function exportRecordingV2(
  recordingId: string,
  format: RecordingExportFormat,
  options?: {
    redactionLevel?: "none" | "basic" | "strict";
    target?: string;
    preview?: boolean;
  }
): Promise<ExportResult> {
  return await invoke("export_recording_v2", {
    recordingId,
    format,
    redactionLevel: options?.redactionLevel,
    target: options?.target,
    preview: options?.preview,
  });
}

export interface ExportTemplate {
  id: string;
  name: string;
  description: string;
  format: "markdown" | "plain_text" | "html" | "json" | "csv" | "pdf" | "docx";
  template: string;
  includeSpeakers: boolean;
  includeTimestamps: boolean;
  includeConfidence: boolean;
  customFields: Record<string, string>;
}

interface TemplateExportResult {
  templateId: string;
  preview: boolean;
  exportPath: string | null;
  content: string | null;
}

export async function listExportTemplates(): Promise<ExportTemplate[]> {
  return await invoke("list_export_templates");
}

export async function exportWithTemplate(
  recordingId: string,
  templateId: string,
  options?: {
    target?: string;
    preview?: boolean;
    redactionLevel?: "none" | "basic" | "strict";
  }
): Promise<TemplateExportResult> {
  return await invoke("export_with_template", {
    recordingId,
    templateId,
    target: options?.target,
    preview: options?.preview,
    redactionLevel: options?.redactionLevel,
  });
}

export async function getProjects(): Promise<Project[]> {
  return await invoke("get_projects");
}

export async function createProject(project: {
  name: string;
  description?: string;
  parentId?: string;
}): Promise<Project> {
  return await invoke("create_project", { project });
}

export interface DictationDictionaryEntry {
  id: string;
  spokenForm: string;
  replacement: string;
  appScope: string | null;
  caseSensitive: boolean;
  enabled: boolean;
  /** Optional dictation-destination-app category key (see DictationAppCategoryOverride's
   * `category` values: other/messaging/email/notes/worklog/ai_chat/code_editor).
   * `null`/absent means the entry applies regardless of destination-app category. */
  categoryScope: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CreateDictationDictionaryEntryRequest {
  spokenForm: string;
  replacement: string;
  appScope?: string | null;
  caseSensitive?: boolean;
  enabled?: boolean;
  categoryScope?: string | null;
}

interface UpdateDictationDictionaryEntryRequest {
  spokenForm?: string;
  replacement?: string;
  appScope?: string | null;
  caseSensitive?: boolean;
  enabled?: boolean;
  categoryScope?: string | null;
}

interface LearnDictationCorrectionRequest {
  originalText: string;
  correctedText: string;
  appTarget?: string | null;
  force?: boolean;
}

export interface LearnDictationCorrectionResult {
  learned: boolean;
  action?: "created" | "updated" | null;
  reason?: string | null;
  spokenForm?: string | null;
  replacement?: string | null;
  entry?: DictationDictionaryEntry | null;
}

export interface DictationDictionaryCsvImportResult {
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errors: string[];
}

/**
 * How Plainsong came to know about a queued correction. Mirrors
 * `CORRECTION_SUGGESTION_SOURCE_EXTERNAL_APP` in `rust-sidecar/src/models.rs`;
 * `null` means the user retyped the result inside Plainsong, which is also what
 * every row written before the distinction existed reads as.
 */
export const EXTERNAL_APP_CORRECTION_SOURCE = "external_app_readback";

export interface DictationCorrectionSuggestion {
  id: string;
  originalText: string;
  correctedText: string;
  spokenForm: string;
  replacement: string;
  appTarget: string | null;
  source?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueDictationCorrectionSuggestionResult {
  queued: boolean;
  action?: "created" | "updated" | null;
  reason?: string | null;
  spokenForm?: string | null;
  replacement?: string | null;
  suggestion?: DictationCorrectionSuggestion | null;
}

export interface DictationSnippet {
  id: string;
  trigger: string;
  expansion: string;
  appScope: string | null;
  caseSensitive: boolean;
  enabled: boolean;
  /** See DictationDictionaryEntry.categoryScope. */
  categoryScope: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CreateDictationSnippetRequest {
  trigger: string;
  expansion: string;
  appScope?: string | null;
  caseSensitive?: boolean;
  enabled?: boolean;
  categoryScope?: string | null;
}

interface UpdateDictationSnippetRequest {
  trigger?: string;
  expansion?: string;
  appScope?: string | null;
  caseSensitive?: boolean;
  enabled?: boolean;
  categoryScope?: string | null;
}

export interface DictationCommandPreset {
  id: string;
  commandKey: string;
  systemPrompt: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface UpsertDictationCommandPresetRequest {
  commandKey: string;
  systemPrompt: string;
  enabled?: boolean;
}

export async function listDictationDictionaryEntries(): Promise<DictationDictionaryEntry[]> {
  return await invoke("list_dictation_dictionary_entries");
}

export async function createDictationDictionaryEntry(
  request: CreateDictationDictionaryEntryRequest
): Promise<DictationDictionaryEntry> {
  return await invoke("create_dictation_dictionary_entry", { request });
}

export async function updateDictationDictionaryEntry(
  entryId: string,
  request: UpdateDictationDictionaryEntryRequest
): Promise<DictationDictionaryEntry> {
  return await invoke("update_dictation_dictionary_entry", { entryId, request });
}

export async function deleteDictationDictionaryEntry(entryId: string): Promise<void> {
  await invoke("delete_dictation_dictionary_entry", { entryId });
}

export async function learnDictationCorrection(
  request: LearnDictationCorrectionRequest
): Promise<LearnDictationCorrectionResult> {
  return await invoke("learn_dictation_correction", { request });
}

export async function exportDictationDictionaryCsv(): Promise<string> {
  return await invoke("export_dictation_dictionary_csv");
}

export async function importDictationDictionaryCsv(
  csvText: string
): Promise<DictationDictionaryCsvImportResult> {
  return await invoke("import_dictation_dictionary_csv", { csvText });
}

export async function listDictationCorrectionSuggestions(): Promise<DictationCorrectionSuggestion[]> {
  return await invoke("list_dictation_correction_suggestions");
}

export async function queueDictationCorrectionSuggestion(
  request: LearnDictationCorrectionRequest
): Promise<QueueDictationCorrectionSuggestionResult> {
  return await invoke("queue_dictation_correction_suggestion", { request });
}

export async function approveDictationCorrectionSuggestion(
  suggestionId: string
): Promise<LearnDictationCorrectionResult> {
  return await invoke("approve_dictation_correction_suggestion", { suggestionId });
}

export async function rejectDictationCorrectionSuggestion(suggestionId: string): Promise<void> {
  await invoke("reject_dictation_correction_suggestion", { suggestionId });
}

export async function listDictationSnippets(): Promise<DictationSnippet[]> {
  return await invoke("list_dictation_snippets");
}

export async function createDictationSnippet(
  request: CreateDictationSnippetRequest
): Promise<DictationSnippet> {
  return await invoke("create_dictation_snippet", { request });
}

export async function updateDictationSnippet(
  snippetId: string,
  request: UpdateDictationSnippetRequest
): Promise<DictationSnippet> {
  return await invoke("update_dictation_snippet", { snippetId, request });
}

export async function deleteDictationSnippet(snippetId: string): Promise<void> {
  await invoke("delete_dictation_snippet", { snippetId });
}

export async function listDictationCommandPresets(): Promise<DictationCommandPreset[]> {
  return await invoke("list_dictation_command_presets");
}

export async function upsertDictationCommandPreset(
  request: UpsertDictationCommandPresetRequest
): Promise<DictationCommandPreset> {
  return await invoke("upsert_dictation_command_preset", { request });
}

export async function deleteDictationCommandPreset(commandKey: string): Promise<void> {
  await invoke("delete_dictation_command_preset", { commandKey });
}

// ASR Provider APIs
export async function getAsrProviders(): Promise<AsrProviderInfo[]> {
  return await invoke("get_asr_providers");
}

export async function getAsrProviderInventory(): Promise<AsrProviderInventory[]> {
  return await invoke("get_asr_provider_inventory");
}

export async function downloadAsrModels(
  providerType: AsrProviderType,
  modelId: string
): Promise<void> {
  await invoke("download_asr_models", { providerType, modelId });
}

interface LocalModelRepairReport {
  repairedCount: number;
  removedPaths: string[];
  notes: string[];
}

/**
 * One model file the sidecar found under its managed models directory. The
 * size is `metadata.len()` read off the file itself, so a footprint summed
 * from these is measured rather than inferred from the catalogue's expected
 * sizes -- a half-finished download counts as what it actually occupies.
 */
export interface DownloadedModelFile {
  name: string;
  provider: string;
  path: string;
  sizeBytes: number;
}

export async function listDownloadedModels(): Promise<DownloadedModelFile[]> {
  return await invoke("list_downloaded_models");
}

export async function refreshAsrRuntimeProbes(): Promise<void> {
  await invoke("refresh_asr_runtime_probes");
}

export async function repairLocalModelCache(): Promise<LocalModelRepairReport> {
  return await invoke("repair_local_model_cache");
}

// LLM / AI Analysis APIs
export async function cancelAnalysisRun(runId: string): Promise<void> {
  await invoke("cancel_analysis_run", { runId });
}

export async function analyzeRecording(
  recordingId: string,
  query: string,
  model?: string,
  runId?: string
): Promise<LlmAnalysisResult> {
  return await invoke("analyze_recording", { recordingId, query, model, runId });
}

export async function analyzeRecordings(
  recordingIds: string[],
  query: string,
  model?: string
): Promise<LlmAnalysisResult> {
  return await invoke("analyze_recordings", { recordingIds, query, model });
}

export async function summarizeRecordingGrounded(
  recordingId: string,
  model?: string
): Promise<GroundedSummaryResult> {
  return await invoke("summarize_recording_grounded", { recordingId, model });
}

export async function extractActionItems(
  recordingId: string,
  model?: string,
  options: { persist?: boolean; runId?: string } = {}
): Promise<ActionItem[]> {
  return await invoke("extract_action_items", {
    recordingId,
    model,
    persist: options.persist,
    runId: options.runId,
  });
}

export async function extractActionItemsGrounded(
  recordingId: string,
  model?: string,
  options: { persist?: boolean; runId?: string } = {}
): Promise<GroundedActionItemsResult> {
  return await invoke("extract_action_items_grounded", {
    recordingId,
    model,
    persist: options.persist,
    runId: options.runId,
  });
}

/** Ask a question across all meeting transcripts (AutoRAG Memory). */
export async function askMemory(query: string): Promise<LlmAnalysisResult> {
  return await invoke("ask_memory", { query });
}

export async function getRelationshipMemory(): Promise<RelationshipMemory> {
  return await invoke("get_relationship_memory");
}

export async function searchTranscripts(
  query: string,
  limit = 20,
  projectIds?: string[]
): Promise<SearchHit[]> {
  return await invoke("search_transcripts", { query, limit, projectIds });
}

export async function getOllamaStatus(): Promise<boolean> {
  return await invoke("get_ollama_status");
}

interface ReindexResult {
  recordings: number;
  segments: number;
  errors: number;
}

export async function reindexEmbeddings(): Promise<ReindexResult> {
  return await invoke("reindex_embeddings");
}

export async function listOllamaModels(): Promise<string[]> {
  return await invoke("list_ollama_models");
}

export async function listOllamaCloudModels(): Promise<string[]> {
  return await invoke("list_ollama_cloud_models");
}

// System Audio APIs
export type SystemAudioBackend =
  | "core_audio_process_tap"
  | "virtual_loopback"
  | "none";

export type SystemAudioReadiness = "ready" | "unverified" | "unavailable";

export type SystemAudioFailureKind =
  | "unsupported_os"
  | "permission_denied"
  | "route_changed"
  | "silent_stream"
  | "no_eligible_route"
  | "stream_construction"
  | "stream_runtime";

export interface SystemAudioCapability {
  backend: SystemAudioBackend;
  nativeOsSupported: boolean;
  nativeOsEnabled: boolean;
  routeDevice: string | null;
  routeId: string | null;
  nativeSampleRate: number | null;
  nativeChannels: number | null;
  readiness: SystemAudioReadiness;
  ready: boolean;
  reason: SystemAudioFailureKind | null;
  actionableReason: string | null;
}

export interface SystemAudioTestResult {
  capability: SystemAudioCapability;
  callbacks: number;
  capturedFrames: number;
  nonSilentFrames: number;
  peak: number;
  expectedToneHz: number;
  detectedToneAmplitude: number;
  verificationMethod: "known_tone" | "external_audio" | null;
}

export async function getSystemAudioCapability(): Promise<SystemAudioCapability> {
  return await invoke("get_system_audio_capability");
}

export async function testSystemAudioCapture(): Promise<SystemAudioTestResult> {
  return await invoke("test_system_audio_capture");
}

export interface PermissionDiagnostics {
  microphoneReady: boolean;
  microphonePermissionReady?: boolean;
  speechRecognitionReady?: boolean;
  accessibilityReady: boolean;
  accessibilityTrusted?: boolean;
  postEventReady?: boolean;
  automationReady: boolean;
  cursorInsertionReady?: boolean;
  cursorInsertionObserved?: boolean;
  preferredInsertStrategy?:
    | "accessibility_direct_text"
    | "simulated_typing"
    | null;
  availableInsertStrategies?: Array<"accessibility_direct_text" | "simulated_typing">;
  lastCursorInsertStatus?: {
    succeeded: boolean;
    copiedOnly: boolean;
    failureKind?: "automation" | "post_event_access" | "self_target" | "unknown" | null;
    successfulStrategy?:
      | "accessibility_direct_text"
      | "simulated_typing"
      | null;
    attemptedStrategies?: Array<"accessibility_direct_text" | "simulated_typing">;
    message?: string | null;
    observedAtMs: number;
  } | null;
  runningFromDiskImage?: boolean;
  appBundlePath?: string | null;
  recommendedAppBundlePath?: string | null;
  notes: string[];
}

export interface SetupVerificationResult {
  ok: boolean;
  title: string;
  summary: string;
  details: string[];
}

export async function getPermissionDiagnostics(): Promise<PermissionDiagnostics> {
  return await invoke("get_permission_diagnostics");
}

export async function verifyDictationSetup(): Promise<SetupVerificationResult> {
  return await invoke("verify_dictation_setup");
}

export async function verifyMeetingSetup(): Promise<SetupVerificationResult> {
  return await invoke("verify_meeting_setup");
}

export async function verifySystemAudioSetup(): Promise<SetupVerificationResult> {
  return await invoke("verify_system_audio_setup");
}

export async function openPermissionSettings(
  section:
    | "microphone"
    | "speech"
    | "accessibility"
    | "automation"
    | "system_audio"
): Promise<void> {
  await invoke("open_permission_settings", { section });
}

export async function openInstalledPlainsongApp(): Promise<void> {
  await invoke("open_installed_nautilus_app");
}

export async function requestDictationPermissions(): Promise<PermissionDiagnostics> {
  return await invoke("request_dictation_permissions");
}

export async function requestAppleSpeechPermission(): Promise<PermissionDiagnostics> {
  return await invoke("request_apple_speech_permission");
}

export async function repairCursorInsertPermissions(): Promise<PermissionDiagnostics> {
  return await invoke("repair_cursor_insert_permissions");
}

export interface DictationShortcutCapabilityStatus {
  nativeShortcutAvailable: boolean;
  /**
   * Per-binding problems from Electron's last registration pass (see
   * `validateDictationBindings` in electron/dictation-bindings.ts). Absent
   * from older main processes.
   */
  bindingIssues?: DictationBindingIssue[];
}

/** Check whether the native hold-to-talk helper is available on this machine. */
export async function getDictationShortcutCapabilityStatus(): Promise<DictationShortcutCapabilityStatus> {
  return await invoke("get_dictation_shortcut_capability_status");
}

// Must stay in sync with electron/shortcut-registration.ts's own
// ShortcutFieldKey: conflicts are reported by field from there.
export type ShortcutFieldKey =
  | "toggleDictation"
  | "openWindow"
  | "repasteLastDictation"
  | "recopyLastDictation";

export interface ShortcutConflict {
  field: ShortcutFieldKey;
  label: string;
  shortcut: string;
  conflictsWith: string;
  conflictsWithField: ShortcutFieldKey;
}

export interface ShortcutConflictStatus {
  conflicts: ShortcutConflict[];
}

/** Ask whether any configured global shortcuts currently collide on the same key combination. */
export async function getShortcutConflicts(): Promise<ShortcutConflictStatus> {
  return await invoke("get_shortcut_conflicts");
}

/**
 * Re-apply global shortcut registrations now. The electron main process
 * re-runs its registration pass (including respawning the native macOS
 * helper) when this command resolves, so a freshly granted Accessibility
 * permission can activate hold-to-talk without an app restart.
 */
export async function applyGlobalShortcutsNow(): Promise<void> {
  await invoke("apply_global_shortcuts_now");
}

// Diarization types
interface Speaker {
  id: string;
  name: string | null;
  color: string;
  sampleCount: number;
}

interface SpeakerSegment {
  startTime: number;
  endTime: number;
  speakerId: string;
  confidence: number;
}

interface DiarizationResult {
  segments: SpeakerSegment[];
  speakers: Speaker[];
  duration: number;
}

// Diarization APIs
export async function runDiarization(recordingId: string): Promise<DiarizationResult> {
  return await invoke("run_diarization", { recordingId });
}

export interface DiarizationModelOption {
  id: string;
  label: string;
  description: string;
  installed: boolean;
}

/** A remembered voice, as Settings lists it. Never carries the signature itself. */
export interface RememberedVoice {
  id: string;
  displayName: string;
  embeddingModelId: string;
  sampleCount: number;
  createdAt: string;
  updatedAt: string;
}

/** What one speaker cluster's header should offer. */
export interface SpeakerVoiceCluster {
  speakerId: string;
  appliedProfileId: string | null;
  /** "auto" while Plainsong applied the name unasked, "confirmed" once agreed. */
  matchState: "auto" | "confirmed" | null;
  suggestion: {
    profileId: string;
    displayName: string;
    percent: number;
    confident: boolean;
  } | null;
}

export interface SpeakerVoiceSuggestions {
  /** False when "Remember voices" is off; the UI shows nothing rather than an error. */
  enabled: boolean;
  clusters: SpeakerVoiceCluster[];
  /** Names offered in Confirm, attendees first where a meeting has them. */
  nameOptions: string[];
}

export async function suggestSpeakerVoices(
  recordingId: string,
): Promise<SpeakerVoiceSuggestions> {
  return await invoke("suggest_speaker_voices", { recordingId });
}

/**
 * Remember one cluster's voice under a name, and put that name on the speaker.
 *
 * Pass `profileId` to confirm an existing suggestion (the stored voice decides
 * the name), or `name` to remember a new one from the rename flow.
 */
export async function rememberSpeakerVoice(args: {
  recordingId: string;
  speakerId: string;
  profileId?: string;
  name?: string;
}): Promise<{ profileId: string; displayName: string }> {
  return await invoke("remember_speaker_voice", args);
}

export async function rejectSpeakerVoice(
  recordingId: string,
  speakerId: string,
  profileId: string,
): Promise<void> {
  await invoke("reject_speaker_voice", { recordingId, speakerId, profileId });
}

export async function listRememberedVoices(): Promise<RememberedVoice[]> {
  return await invoke("list_remembered_voices");
}

export async function forgetRememberedVoice(profileId: string): Promise<boolean> {
  return await invoke("forget_remembered_voice", { profileId });
}

export async function forgetAllRememberedVoices(): Promise<number> {
  return await invoke("forget_all_remembered_voices");
}

export async function listDiarizationModels(): Promise<DiarizationModelOption[]> {
  return await invoke("list_diarization_models");
}

export async function isDiarizationModelAvailable(modelId?: string): Promise<boolean> {
  return await invoke("is_diarization_model_available", { modelId });
}

export async function downloadDiarizationModel(modelId?: string): Promise<void> {
  return await invoke("download_diarization_model", { modelId });
}

// Silero VAD APIs (opt-in, higher-accuracy hands-free/auto-stop backend)
export async function isSileroVadModelDownloaded(): Promise<boolean> {
  return await invoke("is_silero_vad_model_downloaded");
}

export async function downloadSileroVadModel(): Promise<void> {
  await invoke("download_silero_vad_model");
}

/**
 * Readiness of the bundled zero-setup dictation cleanup model.
 *
 * `ready` is "every pinned file carries a trusted integrity receipt", not
 * "the files are on disk" -- the sidecar refuses to load weights it cannot
 * vouch for, so anything weaker here would show a green row for a model that
 * will not run.
 */
export interface BundledCleanupModelStatus {
  provider: string;
  modelId: string;
  /** License-required name: "S1-mini" by "Superwhisper". */
  displayName: string;
  vendor: string;
  /** Total bytes the download will fetch. */
  downloadBytes: number;
  /** Bytes currently on disk, whether or not they verify. */
  bytesOnDisk: number;
  ready: boolean;
  /** Pinned files that are missing or failed verification. */
  missingFiles: string[];
  path: string;
  /**
   * Which backend a cleanup would actually run on: "metal", "cpu", or
   * "unavailable" in a build without the local runtime. Probed without
   * loading the weights.
   */
  backend: string;
  /**
   * Whether that backend can finish a long dictation inside the pre-insert
   * budget. False on CPU, where a 200-word dictation measured 11-13 s against
   * a 6 s budget — "downloaded" and "usable here" are different questions.
   */
  backendMeetsBudget: boolean;
  /**
   * Whether there is a backend at all. False only in a build compiled without
   * the local runtime, where "this build cannot run it" is a different
   * sentence from "this Mac is slow".
   */
  backendPresent: boolean;
  /** Roughly what the model holds in memory while it is loaded. */
  residentBytes: number;
}

export async function getBundledCleanupModelStatus(): Promise<BundledCleanupModelStatus> {
  return await invoke("get_bundled_cleanup_model_status");
}

export async function downloadBundledCleanupModel(): Promise<BundledCleanupModelStatus> {
  return await invoke("download_bundled_cleanup_model");
}

export async function deleteBundledCleanupModel(): Promise<BundledCleanupModelStatus> {
  return await invoke("delete_bundled_cleanup_model");
}

/**
 * Whether Apple's on-device model can run here.
 *
 * Probed once at sidecar startup and cached, because the answer only changes
 * when the user flips a System Settings switch or an OS model download
 * finishes. Pass `refresh` after sending someone to System Settings.
 */
export interface AppleLanguageModelAvailability {
  provider: string;
  displayName: string;
  available: boolean;
  /** Machine-readable reason when unavailable. */
  reason: string | null;
  /** One sentence the user can act on when unavailable. */
  detail: string | null;
  operatingSystemVersion: string | null;
}

export async function getAppleLanguageModelAvailability(
  refresh = false,
): Promise<AppleLanguageModelAvailability> {
  return await invoke("get_apple_language_model_availability", { refresh });
}

export async function getSpeakers(recordingId: string): Promise<Speaker[]> {
  return await invoke("get_speakers", { recordingId });
}

export async function renameSpeaker(
  recordingId: string,
  speakerId: string,
  newName: string
): Promise<void> {
  await invoke("rename_speaker", { recordingId, speakerId, newName });
}

export async function getSettings(): Promise<Settings> {
  return await invoke("get_settings");
}

interface ResetAppStateResult {
  deletedRecordings: number;
  deletedAudioFiles: number;
  deletedRuntimeAudioDirectory: boolean;
  failedAudioFileDeletions: string[];
  clearedProviderSecrets: string[];
  failedProviderSecretClears: string[];
}

export async function resetAppState(): Promise<ResetAppStateResult> {
  return await invoke("reset_app_state");
}

export async function saveSettings(settings: Settings): Promise<void> {
  await invoke("save_settings", { settings });
}

export async function hasProviderSecret(provider: string): Promise<boolean> {
  return await invoke("has_provider_secret", { provider });
}

export async function setProviderSecret(provider: string, secret: string): Promise<void> {
  await invoke("set_provider_secret", { provider, secret });
}

export async function clearProviderSecret(provider: string): Promise<void> {
  await invoke("clear_provider_secret", { provider });
}

export interface SecurityStatus {
  vaultInitialized: boolean;
  vaultUnlocked: boolean;
  databaseEncrypted: boolean;
  /** True only when every stored recording file is encrypted on disk. */
  recordingsEncrypted: boolean;
  /**
   * How many stored recording files are encrypted, and how many there are.
   * Capture writes a plain WAV, so a vault initialized in the past says
   * nothing about anything recorded since.
   */
  recordingsEncryptedCount: number;
  recordingsStoredCount: number;
  /**
   * The *meetings* AI lane's provider. There are two lanes
   * (`privacy.dictationAi` / `privacy.meetingsAi`) but only one field here:
   * lib.rs reports the meetings lane because it is the one that ships whole
   * transcripts off the machine, which is the answer a security readout is
   * being asked for.
   */
  llmProvider: string;
  remoteProcessingEnabled: boolean;
  exportRoot: string | null;
}

export async function getSecurityStatus(): Promise<SecurityStatus> {
  return await invoke("get_security_status");
}

export async function unlockVault(password: string): Promise<void> {
  await invoke("unlock_vault", { password });
}

export async function lockVault(): Promise<void> {
  await invoke("lock_vault");
}

export async function migrateToEncryptedStorage(password: string): Promise<void> {
  await invoke("migrate_to_encrypted_storage", { password });
}

export interface ApprovedLocationSummary {
  id: string;
  label: string;
  approved: boolean;
}

export async function selectExportLocation(): Promise<ApprovedLocationSummary | null> {
  return await invoke("select_export_location");
}

type CloudProvider = "one_drive" | "google_drive" | "proton_drive" | "i_cloud";

export interface BackupConfig {
  enabled: boolean;
  intervalHours: number;
  maxBackups: number;
  backupDir: string | null;
  backupLocationId?: string | null;
  backupLocationLabel?: string | null;
  backupLocationApproved?: boolean;
  cloudSync: boolean;
  cloudProvider: CloudProvider | null;
  cloudRemoteName: string | null;
  cloudFolder: string;
  icloudPath: string | null;
  cloudLocationId?: string | null;
  cloudLocationLabel?: string | null;
  cloudLocationApproved?: boolean;
}

export interface BackupInfo {
  id: string;
  timestamp: string;
  sizeBytes: number;
  itemsCount: number;
  backupType: "full" | "incremental" | "settings";
}

type SetupCheckStatus = "pass" | "fail";

interface CloudSetupCheck {
  id: string;
  label: string;
  status: SetupCheckStatus;
  message: string;
}

export interface CloudSetupReport {
  provider: CloudProvider | null;
  ready: boolean;
  checks: CloudSetupCheck[];
  checkedAt: string;
}

export async function getBackupConfig(): Promise<BackupConfig> {
  return await invoke("get_backup_config");
}

export async function saveBackupConfig(config: BackupConfig): Promise<void> {
  await invoke("save_backup_config", { config });
}

export async function selectBackupLocation(): Promise<ApprovedLocationSummary | null> {
  return await invoke("select_backup_location");
}

export async function selectCloudBackupLocation(request: {
  provider: CloudProvider;
  remoteName: string | null;
  folder: string;
}): Promise<ApprovedLocationSummary | null> {
  return await invoke("select_cloud_backup_location", request);
}

export async function verifyBackupCloudConnection(): Promise<void> {
  await invoke("verify_backup_cloud_connection");
}

export async function getBackupSetupReport(): Promise<CloudSetupReport> {
  return await invoke("get_backup_setup_report");
}

export async function listBackups(): Promise<BackupInfo[]> {
  return await invoke("list_backups");
}

export async function createBackupDefault(): Promise<BackupInfo> {
  return await invoke("create_backup_default");
}

export async function createSettingsBackupDefault(): Promise<BackupInfo> {
  return await invoke("create_settings_backup_default");
}

export async function restoreBackupDefault(backupId: string): Promise<void> {
  await invoke("restore_backup_default", { backupId });
}

export async function syncBackupToCloud(backupId: string): Promise<void> {
  await invoke("sync_backup_to_cloud", { backupId });
}

// ── Update System ─────────────────────────────────────────────────────────────

export type UpdateChannel = "stable" | "beta";
type UpdateStatus =
  | "unknown"
  | "checking"
  | "upToDate"
  | "updateAvailable"
  | "downloading"
  | "installing"
  | "error";

interface UpdateInfo {
  version: string;
  notes: string;
  pubDate: string;
  isBeta: boolean;
}

export interface UpdateStatusInfo {
  status: UpdateStatus;
  info?: UpdateInfo;
  progress?: number;
  error?: string;
  /** Set when an update exists but this build cannot install it (e.g. unsigned macOS builds). */
  installBlockedReason?: "unsigned";
}

/** Check for available updates. Returns update info if available, null if up to date. */
export async function checkForUpdates(): Promise<UpdateInfo | null> {
  return await invoke("check_for_updates");
}

/** Install the available update. App will restart automatically. */
export async function installUpdate(): Promise<void> {
  await invoke("install_update");
}

/** Get current update status. */
export async function getUpdateStatus(): Promise<UpdateStatusInfo> {
  return await invoke("get_update_status");
}

/** Get current update channel. */
export async function getUpdateChannel(): Promise<UpdateChannel> {
  return await invoke("get_update_channel");
}

/** Set update channel. */
export async function setUpdateChannel(channel: UpdateChannel): Promise<void> {
  await invoke("set_update_channel", { channel });
}

// Dynamic Model Listing APIs
export async function listOpenAiModels(): Promise<string[]> {
  return await invoke("list_openai_models");
}

export async function listAnthropicModels(): Promise<string[]> {
  return await invoke("list_anthropic_models");
}

export async function listGeminiModels(): Promise<string[]> {
  return await invoke("list_gemini_models");
}

export async function listDeepSeekModels(): Promise<string[]> {
  return await invoke("list_deepseek_models");
}

// ── Local tools (CLI / MCP) ─────────────────────────────────────────────────

/** Mirrors `CliToolStatus` in electron/cli-install.ts. */
export interface CliToolStatus {
  binaryPath: string;
  binaryPresent: boolean;
  linkPath: string;
  installed: boolean;
  stale: boolean;
  occupied: boolean;
  manualCommand: string;
}

/** Mirrors `CliInstallResult` in electron/cli-install.ts. */
export type CliInstallResult =
  | { status: "installed"; linkPath: string }
  | { status: "manual"; reason: string; command: string }
  | { status: "unavailable"; reason: string };

export async function getCliToolStatus(): Promise<CliToolStatus> {
  return await invoke("get_cli_tool_status");
}

/** Needs a recent click in the main window; the main process enforces it. */
export async function installCliTool(): Promise<CliInstallResult> {
  return await invoke("install_cli_tool");
}
