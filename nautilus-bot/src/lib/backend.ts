import { invoke } from "@/lib/electron";
import type {
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
  SearchHit,
  MeetingTranscriptDetails,
} from "@/types";
import type { Settings } from "@/types/settings";

export interface DictationStartOptions {
  saveToInbox: boolean;
  projectId?: string;
  profile: "normal_speed" | "power_rewrite";
  contextSource?: "none" | "clipboard" | "selected_text" | "application_context";
  routePreference?: "local" | "cloud";
  languageOverride?: string | null;
  livePreviewEnabled?: boolean;
}

export interface DictationHistoryDetails {
  modePreset: string | null;
  modeLabel: string | null;
  baseModePreset: string | null;
  baseModeLabel: string | null;
  customModeId: string | null;
  customModeName: string | null;
  contextSource: string | null;
  contextPreview: string | null;
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

export interface MeetingConsentAutomationStatus {
  mode: "auto_ready" | "manual_required" | string;
  surface?: "zoom" | "google_meet" | string | null;
  appName?: string | null;
  appBundleId?: string | null;
  browserUrl?: string | null;
  canAutomate: boolean;
  message: string;
  noticeText: string;
}

export async function startDictation(options?: DictationStartOptions): Promise<void> {
  await invoke("start_dictation", { options });
}

export async function stopDictation(): Promise<string> {
  return await invoke("stop_dictation");
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
  consentPromptShown?: boolean;
}): Promise<string> {
  return await invoke("start_recording", { options });
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

export async function getMeetingConsentAutomationStatus(): Promise<MeetingConsentAutomationStatus> {
  return await invoke("get_meeting_consent_automation_status");
}

export async function stopRecording(recordingId: string): Promise<void> {
  await invoke("stop_recording", { recordingId });
}

export async function openRecordingAudio(recordingId: string): Promise<void> {
  await invoke("open_recording_audio", { recordingId });
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

export async function renameRecording(recordingId: string, newTitle: string): Promise<void> {
  await invoke("rename_recording", { recordingId, newTitle });
}

export async function updateRecordingNotes(
  recordingId: string,
  meetingNotes: string
): Promise<void> {
  await invoke("update_recording_notes", { recordingId, meetingNotes });
}

export async function updateRecordingAnalysis(
  recordingId: string,
  summary: string | null,
  actionItems: string[]
): Promise<void> {
  await invoke("update_recording_analysis", { recordingId, summary, actionItems });
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

export async function updateTranscriptSegment(
  recordingId: string,
  segmentId: string,
  newText: string
): Promise<boolean> {
  return await invoke("update_transcript_segment", { recordingId, segmentId, newText });
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

export async function exportRecordingV2(
  recordingId: string,
  format: "markdown" | "pdf" | "json" | "text",
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
  format: "markdown" | "plain_text" | "html" | "json" | "csv" | "pdf";
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
  }
): Promise<TemplateExportResult> {
  return await invoke("export_with_template", {
    recordingId,
    templateId,
    target: options?.target,
    preview: options?.preview,
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

export interface DictationCorrectionSuggestion {
  id: string;
  originalText: string;
  correctedText: string;
  spokenForm: string;
  replacement: string;
  appTarget: string | null;
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

export async function downloadAsrModels(providerType: AsrProviderType): Promise<void> {
  await invoke("download_asr_models", { providerType });
}

interface LocalModelRepairReport {
  repairedCount: number;
  removedPaths: string[];
  notes: string[];
}

export async function refreshAsrRuntimeProbes(): Promise<void> {
  await invoke("refresh_asr_runtime_probes");
}

export async function repairLocalModelCache(): Promise<LocalModelRepairReport> {
  return await invoke("repair_local_model_cache");
}

// LLM / AI Analysis APIs
export async function analyzeRecording(
  recordingId: string,
  query: string,
  model?: string
): Promise<LlmAnalysisResult> {
  return await invoke("analyze_recording", { recordingId, query, model });
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
  model?: string
): Promise<ActionItem[]> {
  return await invoke("extract_action_items", { recordingId, model });
}

export async function extractActionItemsGrounded(
  recordingId: string,
  model?: string
): Promise<GroundedActionItemsResult> {
  return await invoke("extract_action_items_grounded", { recordingId, model });
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
export async function checkSystemAudioAvailability(): Promise<boolean> {
  return await invoke("check_system_audio_availability");
}

export async function getLoopbackDeviceName(): Promise<string | null> {
  return await invoke("get_loopback_device_name");
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
  section: "microphone" | "speech" | "accessibility" | "automation"
): Promise<void> {
  await invoke("open_permission_settings", { section });
}

export async function openInstalledPlainsongApp(): Promise<void> {
  await invoke("open_installed_nautilus_app");
}

export async function requestDictationPermissions(): Promise<PermissionDiagnostics> {
  return await invoke("request_dictation_permissions");
}

export async function repairCursorInsertPermissions(): Promise<PermissionDiagnostics> {
  return await invoke("repair_cursor_insert_permissions");
}

export interface DictationShortcutCapabilityStatus {
  nativeShortcutAvailable: boolean;
}

/** Check whether the native hold-to-talk helper is available on this machine. */
export async function getDictationShortcutCapabilityStatus(): Promise<DictationShortcutCapabilityStatus> {
  return await invoke("get_dictation_shortcut_capability_status");
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

export async function listDiarizationModels(): Promise<DiarizationModelOption[]> {
  return await invoke("list_diarization_models");
}

export async function isDiarizationModelAvailable(modelId?: string): Promise<boolean> {
  return await invoke("is_diarization_model_available", { modelId });
}

export async function downloadDiarizationModel(modelId?: string): Promise<void> {
  return await invoke("download_diarization_model", { modelId });
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
  recordingsEncrypted: boolean;
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

type CloudProvider = "one_drive" | "google_drive" | "proton_drive" | "i_cloud";

export interface BackupConfig {
  enabled: boolean;
  intervalHours: number;
  maxBackups: number;
  backupDir: string | null;
  cloudSync: boolean;
  cloudProvider: CloudProvider | null;
  cloudRemoteName: string | null;
  cloudFolder: string;
  icloudPath: string | null;
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
