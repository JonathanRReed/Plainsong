export type AppleSpeechReadinessStatus =
  | "ready"
  | "unsupported_platform"
  | "helper_missing"
  | "authorization_not_determined"
  | "authorization_denied"
  | "authorization_restricted"
  | "unsupported_locale"
  | "on_device_unavailable"
  | "recognizer_unavailable"
  | "unknown_authorization"
  | "runtime_unavailable";

/**
 * Which Apple engine the route runs. `speech_analyzer` is macOS 26's
 * SpeechAnalyzer: per-segment timestamps, volatile/finalized streaming, and
 * nothing to download beyond the OS-managed language assets.
 * `sf_speech_recognizer` is the older path, which returns no segment
 * timestamps and so stays dictation-only.
 */
export type AppleSpeechEngine = "speech_analyzer" | "sf_speech_recognizer";

export interface AppleSpeechReadiness {
  status: AppleSpeechReadinessStatus;
  ready: boolean;
  platformSupported: boolean;
  helperPresent: boolean;
  authorization: string;
  locale?: string | null;
  localeSupported: boolean;
  onDeviceAvailable: boolean;
  recognizerAvailable: boolean;
  message: string;
  setupAction?: string | null;
  /**
   * Whether the helper can actually run SpeechAnalyzer here: the macOS 26+ API
   * exists and the transcriber reports itself usable.
   */
  speechAnalyzerAvailable: boolean;
  /** Whether SpeechAnalyzer supports the probed locale at all. */
  speechAnalyzerLocaleSupported: boolean;
  /** Whether that locale's assets are already on disk. */
  speechAnalyzerAssetsInstalled: boolean;
  /**
   * Raw asset state from macOS, plus the helper's `installed_not_allocated`
   * case: macOS reports `installed` only once the locale is allocated to the
   * process, and that allocation does not survive the helper exiting.
   */
  speechAnalyzerAssetStatus: string;
  /** Every locale SpeechAnalyzer supports on this Mac. */
  speechAnalyzerLocales: string[];
  /** The subset of those whose assets macOS already has. */
  speechAnalyzerInstalledLocales: string[];
  /** The engine this route will run for the probed locale. */
  engine: AppleSpeechEngine;
  /** The OS version string reported by the helper (e.g. "26.0.0"). */
  operatingSystemVersion?: string | null;
}

/** The result of asking macOS for one language's SpeechAnalyzer assets. */
export interface AppleSpeechAssetInstall {
  locale: string;
  installed: boolean;
  assetStatus: string;
  engine: AppleSpeechEngine;
}

export interface AppleSpeechLanguageInstallResult {
  install: AppleSpeechAssetInstall | null;
  readiness: AppleSpeechReadiness;
  notes: string[];
}

/** Progress from an in-flight language install, as the sidecar emits it. */
export interface AppleSpeechLanguageInstallProgress {
  stage: string;
  locale: string;
  fraction: number;
  message: string;
}

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
  engineDiagnostics?: AsrEngineDiagnostics;
  platformReadiness?: AppleSpeechReadiness | null;
}

export interface AsrProviderInventory {
  providerType: AsrProviderType;
  name: string;
  description: string;
  isAvailable: boolean;
  inferenceEnabled: boolean;
  selectedModelId: string;
  modelOptions: AsrModelOption[];
  downloadStatus: DownloadStatus;
  platformReadiness?: AppleSpeechReadiness | null;
}

interface AsrModelOption {
  id: string;
  label: string;
}

type AsrRuntimeStatus = "ready" | "missing_runtime" | "missing_model" | "error";

interface AsrRuntimeDetails {
  pythonPath?: string;
  modelPath?: string;
  missingFiles?: string[];
  setupAction?: string | null;
}

interface AsrEngineDiagnostics {
  activeEngine?: string;
  availableEngines: string[];
  notes: string[];
}

interface AsrModelInfo {
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
  modelId: string;
  runtimeStatus: AsrRuntimeStatus;
  nonEmptyTranscript: boolean;
  processingTimeMs: number;
  transcription: string;
  confidence: number;
}

// Kept in lockstep with `AsrProviderType` in rust-sidecar/src/asr/mod.rs. Any
// engine listed here is offered to users, so an engine that cannot start must
// not appear -- `mlx_audio` and `voxtral` were removed because both required a
// managed Python venv with torch/transformers that no install ever provisioned.
export type AsrProviderType =
  | "whisper"
  | "parakeet"
  | "whisper_candle"
  | "distil_whisper"
  | "macos_apple_speech"
  | "moonshine"
  | "windows_sdk_dictation"
  | "elevenlabs_scribe"
  | "openai_cloud"
  | "groq"
  | "cohere_transcribe"
  // The same Cohere Transcribe weights as `cohere_transcribe`, run locally on
  // ONNX Runtime. Experimental, never a default: no language detection, and
  // its segment times are estimated rather than measured.
  | "cohere_local"
  | "qwen3_asr"
  | "deepgram"
  | "mistral_voxtral"
  | "gemini_transcribe"
  // The transcribe.cpp spike route. The sidecar only reports it when it was
  // built with `--features asr-transcribe-cpp` (off by default and absent from
  // the release feature list), so no shipped build ever sends it -- but the
  // renderer has to be able to render it honestly when a developer build does,
  // instead of dropping an unknown provider out of the picker.
  | "transcribe_cpp";

// LLM Types
export interface LlmAnalysisResult {
  query: string;
  response: string;
  citations: LlmCitation[];
  actualProvider: string;
  model: string;
  processingTimeMs: number;
  provenance: AnalysisProvenance;
  /** False when the model's citations could not be verified and the
   * response is returned uncited instead of discarded. */
  grounded?: boolean;
}

export interface LlmCitation {
  text: string;
  lineId?: string;
  segmentId?: string;
  startTime?: number;
  endTime?: number;
  recordingId?: string;
  certainty?: number;
}

export interface AnalysisProvenance {
  version: number;
  contentHash: string;
  actualProvider: string;
  actualModel: string;
  promptSource: string;
  completedAt: string;
  citations: LlmCitation[];
  grounded: boolean;
}

export interface ActionItemProvenance {
  contentHash: string;
  citations: LlmCitation[];
  grounded: boolean;
}

export interface ActionItemsProvenance extends AnalysisProvenance {
  items: ActionItemProvenance[];
}

export interface RecordingAnalysisProgressEvent {
  recordingId: string;
  runId?: string;
  target: "summary" | "actionItems" | "ask" | string;
  stage: "planning" | "mapping" | "reducing" | "synthesizing" | "completed";
  strategy: "direct" | "chunked";
  completed: number;
  total: number;
  pass: number;
  message: string;
  updatedAt: string;
}

export interface RecordingAnalysisFailedEvent {
  recordingId: string;
  runId?: string;
  target: "summary" | "actionItems" | "ask" | string;
  reason: string;
  updatedAt: string;
}

export interface ActionItem {
  task: string;
  assignee?: string;
  deadline?: string;
}

export interface GroundedSummaryResult {
  summary: string;
  citations: LlmCitation[];
  actualProvider: string;
  model: string;
  processingTimeMs: number;
  /** False when the model's citations could not be verified and the
   * summary is returned uncited instead of discarded. */
  grounded?: boolean;
  provenance: AnalysisProvenance;
}

export interface GroundedActionItem extends ActionItem {
  citations: LlmCitation[];
  grounded?: boolean;
}

export interface GroundedActionItemsResult {
  items: GroundedActionItem[];
  actualProvider: string;
  model: string;
  processingTimeMs: number;
  grounded?: boolean;
  provenance: ActionItemsProvenance;
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
  nonEmptyTranscript: boolean;
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
