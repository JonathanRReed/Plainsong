import { invoke } from "@tauri-apps/api/core";
import type {
  Recording,
  Project,
  Transcript,
  AuditLogEntry,
  AsrProviderInfo,
  AsrModelOption,
  AsrRuntimeDiagnostics,
  AsrProviderType,
  BenchmarkResult,
  LlmAnalysisResult,
  ActionItem,
  GroundedSummaryResult,
  GroundedActionItemsResult,
  SearchHit,
  AsrBenchmarkEntry,
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
  contextSource: string | null;
  contextPreview: string | null;
  contextAppName: string | null;
  appTarget: string | null;
  activationMatcher: string | null;
  commandApplied: string | null;
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

export interface MeetingChatCitation {
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

export interface RelationshipMemoryEvidence {
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
  modePreset: string
): Promise<DictationReprocessResult> {
  return await invoke("reprocess_dictation_text", { text, modePreset });
}

export async function getDictationHistoryDetails(
  recordingId: string
): Promise<DictationHistoryDetails | null> {
  return await invoke("get_dictation_history_details", { recordingId });
}

export async function forceStopDictation(): Promise<string> {
  return await invoke("force_stop_dictation");
}

export interface CursorInsertSmokeTestResult {
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

export async function getDictationAudioLevel(): Promise<number> {
  return await invoke("get_dictation_audio_level");
}

export async function startRecording(options: {
  mic: boolean;
  systemAudio: boolean;
  projectId: string;
  template?: string;
  meetingNotes?: string;
  consentPromptShown?: boolean;
}): Promise<string> {
  return await invoke("start_recording", { options });
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

export async function deleteProject(projectId: string): Promise<void> {
  await invoke("delete_project", { projectId });
}

export async function exportRecording(
  recordingId: string,
  format: "markdown" | "pdf" | "json",
  target?: string
): Promise<string> {
  return await invoke("export_recording", { recordingId, format, target });
}

export interface ExportResult {
  format: string;
  redactionLevel: "none" | "basic" | "strict" | string;
  preview: boolean;
  exportPath: string | null;
  content: string | null;
}

export type EvidenceVerificationStatus = "pass" | "fail";

export interface EvidenceVerificationCheck {
  id: string;
  label: string;
  status: EvidenceVerificationStatus;
  message: string;
}

export interface EvidenceVerificationResult {
  valid: boolean;
  checkedAt: string;
  schemaVersion: string | null;
  format: string | null;
  keyId: string | null;
  checks: EvidenceVerificationCheck[];
}

export async function exportRecordingV2(
  recordingId: string,
  format: "markdown" | "pdf" | "json" | "text" | "evidence_bundle",
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

export async function verifyEvidenceBundle(targetPath: string): Promise<EvidenceVerificationResult> {
  return await invoke("verify_evidence_bundle", { targetPath });
}

export interface ExportTemplateField {
  id: string;
  label: string;
  type: string;
  required: boolean;
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

export interface TemplateExportResult {
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
  createdAt: string;
  updatedAt: string;
}

export interface CreateDictationDictionaryEntryRequest {
  spokenForm: string;
  replacement: string;
  appScope?: string | null;
  caseSensitive?: boolean;
  enabled?: boolean;
}

export interface UpdateDictationDictionaryEntryRequest {
  spokenForm?: string;
  replacement?: string;
  appScope?: string | null;
  caseSensitive?: boolean;
  enabled?: boolean;
}

export interface DictationSnippet {
  id: string;
  trigger: string;
  expansion: string;
  appScope: string | null;
  caseSensitive: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDictationSnippetRequest {
  trigger: string;
  expansion: string;
  appScope?: string | null;
  caseSensitive?: boolean;
  enabled?: boolean;
}

export interface UpdateDictationSnippetRequest {
  trigger?: string;
  expansion?: string;
  appScope?: string | null;
  caseSensitive?: boolean;
  enabled?: boolean;
}

export interface DictationCommandPreset {
  id: string;
  commandKey: string;
  systemPrompt: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertDictationCommandPresetRequest {
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

export async function getAuditLog(): Promise<AuditLogEntry[]> {
  return await invoke("get_audit_log");
}

// ASR Provider APIs
export async function getAsrProviders(): Promise<AsrProviderInfo[]> {
  return await invoke("get_asr_providers");
}

export async function getAsrRuntimeDiagnostics(
  providerType: AsrProviderType
): Promise<AsrRuntimeDiagnostics> {
  return await invoke("get_asr_runtime_diagnostics", { providerType });
}

export async function getDefaultAsrProvider(): Promise<AsrProviderType> {
  return await invoke("get_default_asr_provider");
}

export async function setDefaultAsrProvider(providerType: AsrProviderType): Promise<void> {
  await invoke("set_default_asr_provider", { providerType });
}

export async function getAsrProviderModel(providerType: AsrProviderType): Promise<string> {
  return await invoke("get_asr_provider_model", { providerType });
}

export async function setAsrProviderModel(
  providerType: AsrProviderType,
  modelId: string
): Promise<void> {
  await invoke("set_asr_provider_model", { providerType, modelId });
}

export async function getAsrProviderModelOptions(
  providerType: AsrProviderType
): Promise<AsrModelOption[]> {
  return await invoke("get_asr_provider_model_options", { providerType });
}

export async function listOpenAiAsrModels(): Promise<string[]> {
  return await invoke("list_openai_asr_models");
}

export async function listElevenlabsAsrModels(): Promise<string[]> {
  return await invoke("list_elevenlabs_asr_models");
}

export async function downloadAsrModels(providerType: AsrProviderType): Promise<void> {
  await invoke("download_asr_models", { providerType });
}

export async function downloadPlatformAssets(engine: string): Promise<string> {
  return await invoke("download_platform_assets", { engine });
}

export interface LocalModelRepairReport {
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

export async function benchmarkAsrProviders(testAudioPath: string): Promise<BenchmarkResult[]> {
  return await invoke("benchmark_asr_providers", { testAudioPath });
}

export async function benchmarkAsrProvidersBytes(audioBytes: Uint8Array): Promise<BenchmarkResult[]> {
  return await invoke("benchmark_asr_providers_bytes", { audioBytes: Array.from(audioBytes) });
}

export async function listAsrBenchmarks(limit = 50): Promise<AsrBenchmarkEntry[]> {
  return await invoke("list_asr_benchmarks", { limit });
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

export async function summarizeRecording(
  recordingId: string,
  model?: string
): Promise<string> {
  return await invoke("summarize_recording", { recordingId, model });
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

/** Ask a question across all meeting transcripts (AutoRAG Memory). Requires Pro or trial. */
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

export interface EmbeddingStatus {
  embeddingCount: number;
  ollamaAvailable: boolean;
}

export interface ReindexResult {
  recordings: number;
  segments: number;
  errors: number;
}

export async function reindexEmbeddings(): Promise<ReindexResult> {
  return await invoke("reindex_embeddings");
}

export async function getEmbeddingStatus(): Promise<EmbeddingStatus> {
  return await invoke("get_embedding_status");
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

export async function openInstalledNautilusApp(): Promise<void> {
  await invoke("open_installed_nautilus_app");
}

export async function requestDictationPermissions(): Promise<PermissionDiagnostics> {
  return await invoke("request_dictation_permissions");
}

export async function repairCursorInsertPermissions(): Promise<PermissionDiagnostics> {
  return await invoke("repair_cursor_insert_permissions");
}

// Model Download APIs
export async function downloadWhisperModel(modelName: string): Promise<string> {
  return await invoke("download_whisper_model", { modelName });
}

export async function listDownloadedModels(): Promise<DownloadedModel[]> {
  return await invoke("list_downloaded_models");
}

export async function deleteModel(path: string): Promise<void> {
  await invoke("delete_model", { path });
}

export async function getAvailableSpace(): Promise<number> {
  return await invoke("get_available_space");
}

// Types for model downloads
export interface DownloadedModel {
  name: string;
  provider: string;
  path: string;
  sizeBytes: number;
  downloadedAt: string;
}

// Diarization types
export interface Speaker {
  id: string;
  name: string | null;
  color: string;
  sampleCount: number;
}

export interface SpeakerSegment {
  startTime: number;
  endTime: number;
  speakerId: string;
  confidence: number;
}

export interface DiarizationResult {
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

export interface ResetAppStateResult {
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

export interface ShortcutApplyStatus {
  ok: boolean;
  message: string;
}

export async function applyGlobalShortcutsNow(): Promise<ShortcutApplyStatus> {
  return await invoke("apply_global_shortcuts_now");
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

export type CloudProvider = "one_drive" | "google_drive" | "proton_drive" | "i_cloud";

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

export type SetupCheckStatus = "pass" | "fail";

export interface CloudSetupCheck {
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

export async function syncBackupToCloud(backupId: string): Promise<void> {
  await invoke("sync_backup_to_cloud", { backupId });
}

export async function exportBackupArchive(backupId: string, targetPath: string): Promise<void> {
  await invoke("export_backup_archive", { backupId, targetPath });
}

// ── License ───────────────────────────────────────────────────────────────────

export type LicenseTier = "none" | "pro" | "friends_club";
export type LicenseLsStatus = "active" | "inactive" | "expired" | "disabled" | "";

export interface LicenseInfo {
  key: string;
  instanceId: string;
  tier: LicenseTier;
  valid: boolean;
  lsStatus: LicenseLsStatus;
  activationsLimit: number;
  activationsUsage: number;
  lastValidatedAt: string;
  trialDaysRemaining: number;
  nagRequired: boolean;
  trialActive: boolean;
}

/** Called on startup to check cached license status against Lemon Squeezy. */
export async function validateLicense(): Promise<LicenseInfo> {
  return await invoke("validate_license");
}

/** Activate a new license key (calls LS activate endpoint). */
export async function activateLicense(key: string): Promise<LicenseInfo> {
  return await invoke("activate_license", { key });
}

/** Deactivate this device (calls LS deactivate endpoint, clears local state). */
export async function deactivateLicense(): Promise<void> {
  await invoke("deactivate_license");
}

export interface EntitlementInfo {
  trialActive: boolean;
  licenseValid: boolean;
  tier: "free" | "pro" | "friends";
  proEnabled: boolean;
  experimentalEnabled: boolean;
  canUpdate: boolean;
}

/** Get current entitlement (no network call, reads cached license state). */
export async function getEntitlement(): Promise<EntitlementInfo> {
  return await invoke("get_entitlement");
}

// ── Update System ─────────────────────────────────────────────────────────────

export type UpdateChannel = "stable" | "beta";
export type UpdateStatus =
  | "unknown"
  | "checking"
  | "upToDate"
  | "updateAvailable"
  | "downloading"
  | "installing"
  | "error"
  | "locked";

export interface UpdateInfo {
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

/** Set update channel (requires appropriate license tier). */
export async function setUpdateChannel(channel: UpdateChannel): Promise<void> {
  await invoke("set_update_channel", { channel });
}

/** Check if user can use beta channel (Friends Club tier). */
export async function canUseBetaChannel(): Promise<boolean> {
  return await invoke("can_use_beta_channel");
}

/** Get reason why updates are locked, or null if not locked. */
export async function getUpdateLockReason(): Promise<string | null> {
  return await invoke("get_update_lock_reason");
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
