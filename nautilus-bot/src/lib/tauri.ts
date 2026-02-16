import { invoke } from "@tauri-apps/api/core";
import type { 
  Recording,
  Project,
  Transcript,
  AuditLogEntry,
  AsrProviderInfo, 
  AsrRuntimeDiagnostics,
  AsrProviderType, 
  BenchmarkResult,
  LlmAnalysisResult,
  ActionItem,
  SearchHit,
  AsrBenchmarkEntry,
} from "@/types";
import type { Settings } from "@/types/settings";

export interface DictationStartOptions {
  saveToInbox: boolean;
  projectId?: string;
  profile: "speed" | "accuracy";
}

export async function startDictation(options?: DictationStartOptions): Promise<void> {
  await invoke("start_dictation", { options });
}

export async function stopDictation(): Promise<string> {
  return await invoke("stop_dictation");
}

export async function forceStopDictation(): Promise<string> {
  return await invoke("force_stop_dictation");
}

export async function startRecording(options: {
  mic: boolean;
  systemAudio: boolean;
  projectId: string;
}): Promise<string> {
  return await invoke("start_recording", { options });
}

export async function stopRecording(recordingId: string): Promise<void> {
  await invoke("stop_recording", { recordingId });
}

export async function openRecordingAudio(recordingId: string): Promise<void> {
  await invoke("open_recording_audio", { recordingId });
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

export async function deleteRecording(recordingId: string): Promise<void> {
  await invoke("delete_recording", { recordingId });
}

export async function renameRecording(recordingId: string, newTitle: string): Promise<void> {
  await invoke("rename_recording", { recordingId, newTitle });
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

export async function downloadAsrModels(providerType: AsrProviderType): Promise<void> {
  await invoke("download_asr_models", { providerType });
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

export async function extractActionItems(
  recordingId: string,
  model?: string
): Promise<ActionItem[]> {
  return await invoke("extract_action_items", { recordingId, model });
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

export async function listOllamaModels(): Promise<string[]> {
  return await invoke("list_ollama_models");
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
  accessibilityReady: boolean;
  automationReady: boolean;
  notes: string[];
}

export async function getPermissionDiagnostics(): Promise<PermissionDiagnostics> {
  return await invoke("get_permission_diagnostics");
}

export async function openPermissionSettings(
  section: "microphone" | "accessibility" | "automation"
): Promise<void> {
  await invoke("open_permission_settings", { section });
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
