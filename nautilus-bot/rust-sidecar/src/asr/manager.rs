use super::{
    platform::{
        macos_speech::AppleSpeechReadiness, EngineDiagnostics, EngineProbe, PlatformEngine,
    },
    provider_cache::ProviderCache,
    AsrProvider, AsrProviderFactory, AsrProviderType, DownloadStatus, ModelInfo,
    TranscriptionOptions, TranscriptionResult,
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Provider-default dispatch leaves runtime selection to the provider. Keep
/// its concrete engine instead of replacing it with that dispatch placeholder.
fn reported_provider_engine(engine: PlatformEngine, reported: Option<String>) -> Option<String> {
    if engine == PlatformEngine::ProviderDefault {
        reported.or_else(|| Some(engine.id().to_string()))
    } else {
        Some(engine.id().to_string())
    }
}

fn restore_source_timestamps(
    mut result: TranscriptionResult,
    timeline: Option<&crate::audio::utils::RetainedFrameTimeline>,
) -> TranscriptionResult {
    let Some(timeline) = timeline.filter(|timeline| !timeline.is_identity()) else {
        return result;
    };
    let mapped_segments: Option<Vec<_>> = result
        .segments
        .iter()
        .map(|segment| timeline.map_span(segment.start_time, segment.end_time))
        .collect();
    let Some(mapped_segments) = mapped_segments else {
        result.segments.clear();
        result.measured_word_timestamps = false;
        result.speaker_turns.clear();
        return result;
    };
    for (segment, (start, end)) in result.segments.iter_mut().zip(mapped_segments) {
        segment.start_time = start;
        segment.end_time = end;
    }
    result.speaker_turns.retain_mut(|turn| {
        let Some((start, end)) = timeline.map_span(turn.start_time, turn.end_time) else {
            return false;
        };
        turn.start_time = start;
        turn.end_time = end;
        true
    });
    result
}

async fn run_owned_asr_task_and_cleanup<T, Work, WorkFuture, Cleanup, CleanupFuture>(
    work: Work,
    cleanup: Cleanup,
) -> std::result::Result<T, tokio::task::JoinError>
where
    T: Send + 'static,
    Work: FnOnce() -> WorkFuture + Send + 'static,
    WorkFuture: std::future::Future<Output = T> + Send + 'static,
    Cleanup: FnOnce() -> CleanupFuture + Send + 'static,
    CleanupFuture: std::future::Future<Output = ()> + Send + 'static,
{
    let waiter_attached = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let worker_waiter_attached = Arc::clone(&waiter_attached);
    let task = tokio::spawn(async move {
        let result = work().await;
        if !worker_waiter_attached.load(std::sync::atomic::Ordering::Acquire) {
            tracing::info!("Finishing cancelled ASR work before releasing its runtime");
        }
        cleanup().await;
        result
    });

    struct DetachOnDrop(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for DetachOnDrop {
        fn drop(&mut self) {
            self.0.store(false, std::sync::atomic::Ordering::Release);
        }
    }
    let _detach_on_drop = DetachOnDrop(waiter_attached);
    task.await
}

async fn run_owned_asr_task<T, Work, WorkFuture, Cleanup, CleanupFuture>(
    work: Work,
    cleanup: Cleanup,
) -> std::result::Result<T, tokio::task::JoinError>
where
    T: Send + 'static,
    Work: FnOnce() -> WorkFuture + Send + 'static,
    WorkFuture: std::future::Future<Output = T> + Send + 'static,
    Cleanup: FnOnce() -> CleanupFuture + Send + 'static,
    CleanupFuture: std::future::Future<Output = ()> + Send + 'static,
{
    run_owned_asr_task_and_cleanup(work, move || async move {
        tokio::spawn(cleanup());
    })
    .await
}

async fn time_benchmark_work<T>(work: impl std::future::Future<Output = T>) -> (T, u64) {
    let start = tokio::time::Instant::now();
    let result = work.await;
    (result, start.elapsed().as_millis() as u64)
}

async fn run_gated_cache_release<F, Fut, T>(
    decision: F,
    clear: impl FnOnce(&crate::llm::native_runtime_gate::RuntimePermit<'_>),
) where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    run_gated_cache_release_from(
        &crate::llm::native_runtime_gate::NATIVE_RUNTIME,
        decision,
        clear,
    )
    .await;
}

async fn run_gated_cache_release_from<F, Fut, T>(
    runtime_gate: &crate::llm::native_runtime_gate::RuntimeGate,
    mut decision: F,
    clear: impl FnOnce(&crate::llm::native_runtime_gate::RuntimePermit<'_>),
) where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    // Inspect keep-warm before waiting, then recheck under the gate. Never
    // hold settings locked while another native operation finishes.
    if decision().await.is_none() {
        return;
    }
    let gate = match runtime_gate.acquire_when_available().await {
        Ok(gate) => gate,
        Err(error) => {
            tracing::warn!("Final dictation cache release refused: {error}");
            return;
        }
    };
    if let Some(_decision_guard) = decision().await {
        clear(&gate);
    }
}

const BENCHMARK_ERROR_MESSAGE_LIMIT: usize = 512;

fn bounded_benchmark_error_message(error: impl std::fmt::Display) -> String {
    let message: String = error
        .to_string()
        .chars()
        .take(BENCHMARK_ERROR_MESSAGE_LIMIT)
        .collect();
    if message.trim().is_empty() {
        "Benchmark failed".to_string()
    } else {
        message
    }
}

fn benchmark_result_from_outcome(
    provider_type: AsrProviderType,
    provider_name: String,
    model_id: String,
    processing_time_ms: u64,
    outcome: std::result::Result<(String, f64), String>,
) -> BenchmarkResult {
    match outcome {
        Ok((transcription, confidence)) => BenchmarkResult {
            provider_type,
            provider_name,
            model_id,
            runtime_status: RuntimeStatus::Ready,
            non_empty_transcript: !transcription.trim().is_empty(),
            processing_time_ms,
            transcription,
            confidence,
            error_message: None,
        },
        Err(error) => BenchmarkResult {
            provider_type,
            provider_name,
            model_id,
            runtime_status: RuntimeStatus::Error,
            non_empty_transcript: false,
            processing_time_ms,
            transcription: String::new(),
            // The existing wire and persistence contracts require a number.
            // Runtime status and non-empty transcript determine usability.
            confidence: 0.0,
            error_message: Some(bounded_benchmark_error_message(error)),
        },
    }
}

#[derive(Clone)]
enum BenchmarkInput {
    Path(PathBuf),
    Bytes(Arc<Vec<u8>>),
}

// Parakeet legacy 110M: one sherpa-onnx CTC graph plus tokens. `encoder.onnx`
// is what `scripts/provision-asr-assets.mjs` writes; `model.onnx` is what older
// in-app downloads left behind. `asr/parakeet.rs` accepts either, so diagnostics
// must too — checking only one is how "Ready" and "model missing" came to
// disagree.
const PARAKEET_ONNX_NAMES: [&str; 2] = ["encoder.onnx", "model.onnx"];
const PARAKEET_VOCAB_NAMES: [&str; 1] = ["tokens.txt"];
// Parakeet TDT v2/v3: three ONNX graphs plus tokens, with the same conservative
// size floors as their pinned artifact contracts in `asr/parakeet.rs`.
const PARAKEET_V3_REQUIRED_FILES: [(&str, u64); 4] = [
    ("encoder.int8.onnx", 64 * 1024 * 1024),
    ("decoder.int8.onnx", 1024 * 1024),
    ("joiner.int8.onnx", 512 * 1024),
    ("tokens.txt", 4096),
];
const ORUKEET_REQUIRED_FILES: [(&str, u64); 6] = [
    ("encoder.int8.onnx", 64 * 1024 * 1024),
    ("decoder.int8.onnx", 1024 * 1024),
    ("joiner.int8.onnx", 512 * 1024),
    ("tokens.txt", 4096),
    ("LICENSE-WEIGHTS", 1024),
    ("NOTICE.md", 512),
];
// Whisper Candle: Whisper Large V3 Turbo via Candle (no Python)
const WHISPER_CANDLE_REQUIRED_FILES: [&str; 4] = [
    "model.safetensors",
    "config.json",
    "tokenizer.json",
    "preprocessor_config.json",
];
// DistilWhisper: Candle native (no Python)
const DISTIL_REQUIRED_FILES: [&str; 4] = [
    "model.safetensors",
    "config.json",
    "tokenizer.json",
    "preprocessor_config.json",
];
/// Manages multiple ASR providers
pub struct AsrManager {
    default_provider: RwLock<AsrProviderType>,
    selected_model_id: RwLock<String>,
    provider_model_ids: RwLock<HashMap<AsrProviderType, String>>,
    /// Legacy global set, kept for provider-info display and backward-compat callers.
    mlx_accelerated_providers: RwLock<HashSet<AsrProviderType>>,
    /// Per-slot MLX flags, these are the authoritative source for routing.
    dictation_mlx_enabled: RwLock<bool>,
    meeting_mlx_enabled: RwLock<bool>,
    /// `transcription.language` as the user set it, mirrored here so the
    /// meeting lane -- which builds its own options and never sees the
    /// settings -- can tell a cloud provider what to listen for.
    transcription_language: RwLock<Option<String>>,
    silence_skip_enabled: RwLock<bool>,
    platform_optimization: RwLock<crate::settings::PlatformOptimizationSettings>,
    last_runtime_errors: RwLock<HashMap<AsrProviderType, String>>,
    provider_inventory_cache: ProviderCache<ProviderInventory>,
    provider_info_cache: ProviderCache<ProviderInfo>,
    remote_processing_gate: RwLock<Option<Arc<crate::remote_processing::RemoteProcessingGate>>>,
    models_dir: PathBuf,
}

fn has_provider_secret_or_env(secret_name: &str, env_name: &str) -> bool {
    // Provider diagnostics are passive; never unlock credentials or migrate
    // secrets while populating the model picker or startup readiness.
    match crate::secrets::has_provider_secret(secret_name) {
        Ok(true) => true,
        _ => std::env::var(env_name)
            .ok()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
    }
}

fn clear_local_route_cache(models_dir: &Path, provider_type: AsrProviderType, model_id: &str) {
    match provider_type {
        AsrProviderType::Whisper => super::whisper::clear_cached_model(model_id),
        AsrProviderType::WhisperCandle => {
            super::whisper_candle::clear_cached_runtime(&models_dir.join("canary"));
        }
        AsrProviderType::DistilWhisper => super::distil_whisper::clear_cached_runtime(),
        AsrProviderType::Moonshine => {
            let model_dir = if model_id == "moonshine-tiny" {
                models_dir.join("moonshine_tiny")
            } else {
                models_dir.join("moonshine")
            };
            super::moonshine::clear_cached_runtime(&model_dir);
        }
        AsrProviderType::Parakeet => {
            super::parakeet::clear_cached_model_runtime(models_dir, model_id)
        }
        AsrProviderType::Qwen3Asr => {
            super::qwen3_asr::clear_cached_runtime(&models_dir.join("qwen3_asr"));
        }
        AsrProviderType::CohereLocal => super::cohere_local::clear_cached_runtime(
            &models_dir.join(super::cohere_local::COHERE_LOCAL_MODEL_DIR),
        ),
        #[cfg(feature = "asr-transcribe-cpp")]
        AsrProviderType::TranscribeCpp => {
            let model_path = models_dir
                .join(super::transcribe_cpp::TRANSCRIBE_CPP_MODEL_DIR)
                .join(super::transcribe_cpp::route_spec_for(model_id).file_name);
            super::transcribe_cpp::clear_cached_runtime_for_model(&model_path);
            // The same model may be resident on the Neural Engine instead.
            if super::transcribe_cpp::route_spec_for(model_id).model_id
                == super::transcribe_cpp::PARAKEET_GGUF_MODEL_ID
            {
                super::neural_engine::stop_helper();
            }
        }
        _ => {}
    }
}

impl AsrManager {
    pub fn new() -> Self {
        let models_dir = crate::paths::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Plainsong")
            .join("models");

        std::fs::create_dir_all(&models_dir).ok();
        migrate_legacy_local_artifacts(&models_dir);

        let provider_model_ids: HashMap<AsrProviderType, String> = AsrProviderType::all()
            .into_iter()
            .map(|provider| (provider, provider.default_model_id().to_string()))
            .collect();

        Self {
            silence_skip_enabled: RwLock::new(false),
            platform_optimization: RwLock::new(
                crate::settings::PlatformOptimizationSettings::default(),
            ),
            // whisper.cpp (Metal/CoreML) with base.en is the fast default route;
            // the Candle/Distil path runs on CPU in F32 and is multi-second.
            default_provider: RwLock::new(AsrProviderType::Whisper),
            selected_model_id: RwLock::new(AsrProviderType::Whisper.default_model_id().to_string()),
            provider_model_ids: RwLock::new(provider_model_ids),
            mlx_accelerated_providers: RwLock::new(HashSet::new()),
            dictation_mlx_enabled: RwLock::new(false),
            meeting_mlx_enabled: RwLock::new(false),
            transcription_language: RwLock::new(None),
            last_runtime_errors: RwLock::new(HashMap::new()),
            provider_inventory_cache: ProviderCache::new(),
            provider_info_cache: ProviderCache::new(),
            remote_processing_gate: RwLock::new(None),
            models_dir,
        }
    }

    pub async fn set_remote_processing_gate(
        &self,
        gate: Arc<crate::remote_processing::RemoteProcessingGate>,
    ) {
        *self.remote_processing_gate.write().await = Some(gate);
    }

    fn normalize_model_id(provider_type: AsrProviderType, model_id: &str) -> String {
        let trimmed = model_id.trim();
        let candidate = if trimmed.is_empty() {
            provider_type.default_model_id()
        } else {
            trimmed
        };

        match provider_type {
            // All current Parakeet routes are pure ONNX. Anything
            // else -- including the retired managed-Python `parakeet-ctc-*`
            // ids -- resolves to v3 so an old settings file still lands on a
            // route that runs.
            AsrProviderType::Parakeet => match candidate {
                "parakeet-tdt-0.6b-v2" => "parakeet-tdt-0.6b-v2".to_string(),
                "parakeet-tdt-0.6b-v3" => "parakeet-tdt-0.6b-v3".to_string(),
                "orukeet-v0.1.0-int8" => "orukeet-v0.1.0-int8".to_string(),
                "parakeet-tdt-ctc-110m" | "parakeet-legacy-110m" => {
                    "parakeet-tdt-ctc-110m".to_string()
                }
                _ => "parakeet-tdt-0.6b-v3".to_string(),
            },
            _ => candidate.to_string(),
        }
    }

    fn provider_with_model(
        provider_type: AsrProviderType,
        selected_model_id: Option<&str>,
    ) -> Box<dyn AsrProvider> {
        match provider_type {
            AsrProviderType::MacosAppleSpeech | AsrProviderType::WindowsSdkDictation => {
                AsrProviderFactory::create(provider_type)
            }
            _ => AsrProviderFactory::create_with_model(provider_type, selected_model_id),
        }
    }

    fn platform_readiness_for_provider(
        provider_type: AsrProviderType,
    ) -> Option<AppleSpeechReadiness> {
        match provider_type {
            AsrProviderType::MacosAppleSpeech => {
                Some(crate::asr::platform::macos_speech::readiness())
            }
            _ => None,
        }
    }

    async fn fresh_apple_speech_readiness() -> Result<AppleSpeechReadiness, String> {
        tokio::task::spawn_blocking(crate::asr::platform::macos_speech::fresh_readiness)
            .await
            .map_err(|error| format!("Apple Speech readiness task failed: {error}"))
    }

    fn engine_probe(
        engine: PlatformEngine,
        apple_speech_readiness: Option<&AppleSpeechReadiness>,
    ) -> EngineProbe {
        if engine == PlatformEngine::MacosAppleSpeech {
            if let Some(readiness) = apple_speech_readiness {
                return crate::asr::platform::macos_speech::probe_from_readiness(readiness);
            }
        }
        engine.probe()
    }

    pub async fn set_selected_model_id(&self, model_id: String) {
        let default_provider = self.get_default_provider().await;
        let normalized = Self::normalize_model_id(default_provider, &model_id);
        self.provider_model_ids
            .write()
            .await
            .insert(default_provider, normalized.clone());
        *self.selected_model_id.write().await = normalized;
        self.invalidate_provider_info_cache().await;
    }

    pub async fn selected_model_id(&self) -> String {
        self.selected_model_id.read().await.clone()
    }

    pub async fn set_provider_model_id(&self, provider_type: AsrProviderType, model_id: String) {
        let normalized = Self::normalize_model_id(provider_type, &model_id);
        self.provider_model_ids
            .write()
            .await
            .insert(provider_type, normalized.clone());

        if self.get_default_provider().await == provider_type {
            *self.selected_model_id.write().await = normalized;
        }
        self.invalidate_provider_info_cache().await;
    }

    pub async fn provider_model_id(&self, provider_type: AsrProviderType) -> String {
        self.provider_model_ids
            .read()
            .await
            .get(&provider_type)
            .cloned()
            .unwrap_or_else(|| provider_type.default_model_id().to_string())
    }

    pub async fn provider_model_map(&self) -> HashMap<AsrProviderType, String> {
        self.provider_model_ids.read().await.clone()
    }

    pub async fn set_mlx_accelerated_providers(&self, providers: HashSet<AsrProviderType>) {
        *self.mlx_accelerated_providers.write().await = providers;
        self.invalidate_provider_info_cache().await;
    }

    pub async fn mlx_accelerated_providers(&self) -> HashSet<AsrProviderType> {
        self.mlx_accelerated_providers.read().await.clone()
    }

    pub async fn set_dictation_mlx_enabled(&self, enabled: bool) {
        *self.dictation_mlx_enabled.write().await = enabled;
        self.invalidate_provider_info_cache().await;
    }

    pub async fn set_meeting_mlx_enabled(&self, enabled: bool) {
        *self.meeting_mlx_enabled.write().await = enabled;
        self.invalidate_provider_info_cache().await;
    }

    pub async fn set_transcription_language(&self, language: Option<String>) {
        *self.transcription_language.write().await = language;
    }

    pub async fn transcription_language(&self) -> Option<String> {
        self.transcription_language.read().await.clone()
    }

    pub async fn dictation_mlx_enabled(&self) -> bool {
        *self.dictation_mlx_enabled.read().await
    }

    pub async fn meeting_mlx_enabled(&self) -> bool {
        *self.meeting_mlx_enabled.read().await
    }

    pub async fn resolve_effective_provider_and_model(
        &self,
        provider_type: AsrProviderType,
        model_id: &str,
    ) -> (AsrProviderType, String, bool) {
        let optimization = self.platform_optimization().await;
        let mlx_accelerated_providers = self.mlx_accelerated_providers().await;
        let effective = Self::effective_provider_selection(
            provider_type,
            model_id,
            &optimization,
            mlx_accelerated_providers.contains(&provider_type),
        );
        (
            effective.provider_type,
            effective.model_id,
            effective.mlx_accelerated,
        )
    }

    pub async fn set_provider_model_map(&self, provider_map: HashMap<AsrProviderType, String>) {
        let mut merged: HashMap<AsrProviderType, String> = AsrProviderType::all()
            .into_iter()
            .map(|provider| {
                let selected = provider_map
                    .get(&provider)
                    .cloned()
                    .unwrap_or_else(|| provider.default_model_id().to_string());
                (provider, Self::normalize_model_id(provider, &selected))
            })
            .collect();

        let default_provider = self.get_default_provider().await;
        let default_selected = merged
            .get(&default_provider)
            .cloned()
            .unwrap_or_else(|| default_provider.default_model_id().to_string());

        *self.provider_model_ids.write().await = std::mem::take(&mut merged);
        *self.selected_model_id.write().await = default_selected;
        self.invalidate_provider_info_cache().await;
    }

    pub async fn set_silence_skip_enabled(&self, enabled: bool) {
        *self.silence_skip_enabled.write().await = enabled;
    }

    pub async fn silence_skip_enabled(&self) -> bool {
        *self.silence_skip_enabled.read().await
    }

    pub async fn set_platform_optimization(
        &self,
        settings: crate::settings::PlatformOptimizationSettings,
    ) {
        *self.platform_optimization.write().await = settings;
        self.invalidate_provider_info_cache().await;
    }

    pub async fn platform_optimization(&self) -> crate::settings::PlatformOptimizationSettings {
        self.platform_optimization.read().await.clone()
    }

    pub async fn clear_runtime_errors(&self) {
        self.last_runtime_errors.write().await.clear();
        self.invalidate_provider_info_cache().await;
    }

    fn effective_provider_selection(
        requested_provider: AsrProviderType,
        requested_model_id: &str,
        optimization: &crate::settings::PlatformOptimizationSettings,
        mlx_enabled: bool,
    ) -> EffectiveProviderSelection {
        let normalized_model_id = Self::normalize_model_id(requested_provider, requested_model_id);
        // The MLX Audio provider used to hijack this selection and swap in a
        // managed-Python route. It is gone, so the requested provider is always
        // the effective one. `optimization` and `mlx_enabled` are kept in the
        // signature because callers still thread real settings through here and
        // a future accelerated route would need them.
        let _ = (optimization, mlx_enabled);

        EffectiveProviderSelection {
            provider_type: requested_provider,
            model_id: normalized_model_id,
            mlx_accelerated: false,
        }
    }

    pub async fn supports_short_keep_warm(
        &self,
        provider_type: AsrProviderType,
        model_id: &str,
    ) -> bool {
        let normalized = Self::normalize_model_id(provider_type, model_id);
        let optimization = self.platform_optimization().await;
        let mlx_accelerated_providers = self.mlx_accelerated_providers().await;
        let effective = Self::effective_provider_selection(
            provider_type,
            normalized.as_str(),
            &optimization,
            mlx_accelerated_providers.contains(&provider_type),
        );
        match effective.provider_type {
            AsrProviderType::Whisper
            | AsrProviderType::WhisperCandle
            | AsrProviderType::DistilWhisper
            | AsrProviderType::Moonshine
            // Both Parakeet routes are native ONNX and hold cached sessions.
            | AsrProviderType::Parakeet
            | AsrProviderType::Qwen3Asr
            // Two cached ONNX sessions and 2 GiB of mapped weights: the most
            // expensive route in the app to reload, so the most worth cooling.
            | AsrProviderType::CohereLocal => true,
            _ => false,
        }
    }

    pub async fn cool_down_local_route(&self, provider_type: AsrProviderType, model_id: &str) {
        let (provider_type, model_id) = self
            .resolved_local_route_for_cleanup(provider_type, model_id)
            .await;
        let _cleanup_gate = match crate::llm::local_model_load::acquire_cleanup_gate().await {
            Ok(permit) => permit,
            Err(error) => {
                tracing::warn!(
                    "Could not acquire the native runtime gate for cache cleanup: {error}"
                );
                return;
            }
        };
        self.clear_resolved_local_route_after_gate(provider_type, &model_id, &_cleanup_gate);
    }

    pub(crate) async fn resolved_local_route_for_cleanup(
        &self,
        provider_type: AsrProviderType,
        model_id: &str,
    ) -> (AsrProviderType, String) {
        let normalized = Self::normalize_model_id(provider_type, model_id);
        let optimization = self.platform_optimization().await;
        let mlx_accelerated_providers = self.mlx_accelerated_providers().await;
        let effective = Self::effective_provider_selection(
            provider_type,
            normalized.as_str(),
            &optimization,
            mlx_accelerated_providers.contains(&provider_type),
        );
        (effective.provider_type, effective.model_id)
    }

    /// Caller must hold the native cleanup gate through this synchronous call.
    pub(crate) fn clear_resolved_local_route_after_gate(
        &self,
        provider_type: AsrProviderType,
        model_id: &str,
        _gate: &crate::llm::native_runtime_gate::RuntimePermit<'_>,
    ) {
        clear_local_route_cache(&self.models_dir, provider_type, model_id);
    }

    pub async fn invalidate_provider_info_cache(&self) {
        self.provider_inventory_cache.invalidate().await;
        self.provider_info_cache.invalidate().await;
    }

    pub async fn get_provider_inventory(&self) -> Result<Vec<ProviderInventory>, String> {
        let (cache_generation, cached_inventory) = self.provider_inventory_cache.snapshot().await;
        let apple_speech_readiness = Self::fresh_apple_speech_readiness().await?;
        if let Some(mut cached) = cached_inventory {
            for provider in &mut cached {
                provider.model_download_bytes = model_download_bytes(provider.provider_type);
            }
            if let Some(apple) = cached
                .iter_mut()
                .find(|provider| provider.provider_type == AsrProviderType::MacosAppleSpeech)
            {
                apple.is_available = apple_speech_readiness.ready;
                apple.platform_readiness = Some(apple_speech_readiness);
            }
            self.provider_inventory_cache
                .publish(cache_generation, cached.clone())
                .await;
            return Ok(cached);
        }

        let provider_models = self.provider_model_map().await;
        let optimization = self.platform_optimization().await;
        let mlx_accelerated_providers = self.mlx_accelerated_providers().await;

        let futures = AsrProviderType::all().into_iter().map(|provider_type| {
            let apple_speech_readiness = apple_speech_readiness.clone();
            let selected_model = provider_models
                .get(&provider_type)
                .cloned()
                .unwrap_or_else(|| provider_type.default_model_id().to_string());
            let effective = Self::effective_provider_selection(
                provider_type,
                selected_model.as_str(),
                &optimization,
                mlx_accelerated_providers.contains(&provider_type),
            );

            async move {
                tokio::task::spawn_blocking(move || {
                    let visible_provider =
                        Self::provider_with_model(provider_type, Some(selected_model.as_str()));
                    let provider = Self::provider_with_model(
                        effective.provider_type,
                        Some(effective.model_id.as_str()),
                    );
                    let platform_readiness = match provider_type {
                        AsrProviderType::MacosAppleSpeech => Some(apple_speech_readiness),
                        _ => None,
                    };
                    let is_available = platform_readiness
                        .as_ref()
                        .map(|readiness| readiness.ready)
                        .unwrap_or_else(|| provider.is_available());
                    ProviderInventory {
                        provider_type,
                        name: visible_provider.name().to_string(),
                        description: visible_provider.description().to_string(),
                        is_available,
                        inference_enabled: Self::is_provider_transcription_enabled(
                            effective.provider_type,
                        ),
                        selected_model_id: selected_model,
                        model_options: provider_type.model_options(),
                        download_status: provider.download_status(),
                        model_download_bytes: model_download_bytes(provider_type),
                        platform_readiness,
                    }
                })
                .await
                .map_err(|e| format!("Task join error: {}", e))
            }
        });

        let results = futures_util::future::join_all(futures).await;

        let mut inventory = Vec::new();
        for res in results {
            match res {
                Ok(item) => inventory.push(item),
                Err(e) => return Err(e),
            }
        }

        self.provider_inventory_cache
            .publish(cache_generation, inventory.clone())
            .await;
        Ok(inventory)
    }

    /// Get a provider by type - creates fresh instance each time
    pub async fn get_provider(&self, provider_type: AsrProviderType) -> Box<dyn AsrProvider> {
        let selected_model = self.provider_model_id(provider_type).await;
        Self::provider_with_model(provider_type, Some(selected_model.as_str()))
    }

    /// Whether the provider has active transcription inference in this build.
    ///
    /// Native Moonshine remains blocked by the route-readiness gate until its
    /// runtime is validated. Call with the effective provider after routing.
    pub fn is_provider_transcription_enabled(provider_type: AsrProviderType) -> bool {
        match provider_type {
            AsrProviderType::Moonshine => false,
            AsrProviderType::Whistle => cfg!(all(target_os = "macos", target_arch = "aarch64")),
            _ => true,
        }
    }

    /// Get the default provider
    pub async fn get_default_provider(&self) -> AsrProviderType {
        *self.default_provider.read().await
    }

    /// Set the default provider
    pub async fn set_default_provider(&self, provider_type: AsrProviderType) {
        *self.default_provider.write().await = provider_type;
        let selected = self.provider_model_id(provider_type).await;
        *self.selected_model_id.write().await = selected;
        self.invalidate_provider_info_cache().await;
    }

    pub async fn get_runtime_diagnostics(
        &self,
        provider_type: AsrProviderType,
    ) -> RuntimeDiagnostics {
        let selected_model = self.provider_model_id(provider_type).await;
        self.get_runtime_diagnostics_for_model(provider_type, &selected_model)
            .await
    }

    pub async fn get_runtime_diagnostics_for_model(
        &self,
        provider_type: AsrProviderType,
        selected_model: &str,
    ) -> RuntimeDiagnostics {
        let optimization = self.platform_optimization().await;
        let mlx_accelerated_providers = self.mlx_accelerated_providers().await;
        let effective = Self::effective_provider_selection(
            provider_type,
            selected_model,
            &optimization,
            mlx_accelerated_providers.contains(&provider_type),
        );
        let provider =
            Self::provider_with_model(effective.provider_type, Some(effective.model_id.as_str()));
        let platform_readiness = Self::platform_readiness_for_provider(effective.provider_type);
        let provider_available = platform_readiness
            .as_ref()
            .map(|readiness| readiness.ready)
            .unwrap_or_else(|| provider.is_available());
        let last_error = self
            .last_runtime_errors
            .read()
            .await
            .get(&effective.provider_type)
            .cloned();

        let diagnostics = runtime_diagnostics_for_provider(
            effective.provider_type,
            effective.model_id.as_str(),
            provider_available,
            last_error.as_deref(),
            platform_readiness.as_ref(),
        );

        RuntimeDiagnostics {
            provider_type,
            runtime_status: diagnostics.runtime_status,
            runtime_message: diagnostics.runtime_message,
            runtime_details: diagnostics.runtime_details,
        }
    }

    async fn transcribe_inner(
        &self,
        provider_type: AsrProviderType,
        file_path: Option<&Path>,
        audio_data: Option<&[u8]>,
        selected_model: Option<&str>,
        // When `Some`, bypasses the global mlx_accelerated_providers set.
        // Use this for slot-aware routing (dictation vs meeting).
        mlx_override: Option<bool>,
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let requested_provider = provider_type;
        let resolved_model = match selected_model {
            Some(value) => Self::normalize_model_id(provider_type, value),
            None => self.provider_model_id(provider_type).await,
        };
        let skip_silence = self.silence_skip_enabled().await;
        let optimization = self.platform_optimization().await;
        let mlx_enabled = match mlx_override {
            Some(b) => b,
            None => self
                .mlx_accelerated_providers()
                .await
                .contains(&requested_provider),
        };
        let effective_selection = Self::effective_provider_selection(
            requested_provider,
            resolved_model.as_str(),
            &optimization,
            mlx_enabled,
        );

        // Optional compaction retains quiet speech and maps results back to source time.
        let processed = if skip_silence {
            audio_data.and_then(
                |bytes| match crate::audio::utils::compact_digital_silence(bytes) {
                    Ok(filtered) => Some(filtered),
                    Err(e) => {
                        tracing::warn!(
                            "Silence skip preprocessing failed, using original audio: {}",
                            e
                        );
                        None
                    }
                },
            )
        } else {
            None
        };
        let effective_audio_data = processed
            .as_ref()
            .map(|wav| wav.bytes.as_slice())
            .or(audio_data);
        let timeline = processed.as_ref().map(|wav| &wav.timeline);

        let mut attempt_errors: Vec<String> = Vec::new();
        let requested_engine =
            Self::select_requested_engine(effective_selection.provider_type, &optimization);
        let exclusive_engine = requested_engine
            .map(|engine| Self::engine_selection_is_exclusive(engine, &optimization))
            .unwrap_or(false);
        let engine_failure_suffix = if exclusive_engine {
            "no provider fallback will be attempted".to_string()
        } else {
            format!(
                "continuing with selected provider '{}'",
                requested_provider.display_name()
            )
        };
        let mut provider_requested_engine =
            requested_engine.unwrap_or(PlatformEngine::ProviderDefault);

        if let Some(engine) = requested_engine {
            let engine_probe = engine.probe();
            if engine != PlatformEngine::ProviderDefault {
                if Self::engine_enabled(engine, &optimization)
                    && engine_probe.ready
                    && engine.supports_provider(effective_selection.provider_type)
                {
                    if !Self::engine_runtime_executable(engine) {
                        attempt_errors.push(format!(
                            "Engine '{}' unavailable: execution path is not implemented in this build; {}",
                            engine.id(),
                            engine_failure_suffix.as_str()
                        ));
                        if exclusive_engine {
                            return Err(anyhow::anyhow!(attempt_errors.join(" | ")));
                        }
                    } else {
                        match self
                            .transcribe_with_platform_engine_attempt(
                                requested_provider,
                                file_path,
                                effective_audio_data,
                                engine,
                            )
                            .await
                        {
                            Ok(result) => return Ok(restore_source_timestamps(result, timeline)),
                            Err(error) => {
                                attempt_errors.push(format!(
                                    "Engine '{}' failed: {}; {}",
                                    engine.id(),
                                    error,
                                    engine_failure_suffix.as_str()
                                ));
                                if exclusive_engine {
                                    return Err(anyhow::anyhow!(attempt_errors.join(" | ")));
                                }
                            }
                        }
                    }
                } else {
                    let reason = if !Self::engine_enabled(engine, &optimization) {
                        "disabled in settings".to_string()
                    } else if !engine_probe.ready {
                        engine_probe.notes.join("; ")
                    } else {
                        "not supported for selected provider".to_string()
                    };
                    attempt_errors.push(format!(
                        "Engine '{}' unavailable: {}; {}",
                        engine.id(),
                        reason,
                        engine_failure_suffix.as_str()
                    ));
                    if exclusive_engine {
                        return Err(anyhow::anyhow!(attempt_errors.join(" | ")));
                    }
                }
                provider_requested_engine = PlatformEngine::ProviderDefault;
            }
        }

        match self
            .transcribe_with_provider_attempt(
                requested_provider,
                effective_selection.provider_type,
                effective_selection.model_id.as_str(),
                file_path,
                effective_audio_data,
                provider_requested_engine,
                PlatformEngine::ProviderDefault,
                effective_selection.mlx_accelerated,
                None,
                options,
            )
            .await
        {
            Ok(result) => return Ok(restore_source_timestamps(result, timeline)),
            Err(primary_error) => {
                attempt_errors.push(format!(
                    "{} failed: {}",
                    requested_provider.display_name(),
                    primary_error
                ));
            }
        }

        Err(anyhow::anyhow!(attempt_errors.join(" | ")))
    }

    async fn transcribe_with_platform_engine_attempt(
        &self,
        requested_provider: AsrProviderType,
        file_path: Option<&Path>,
        audio_data: Option<&[u8]>,
        engine: PlatformEngine,
    ) -> Result<TranscriptionResult> {
        let file_path_owned = file_path.map(PathBuf::from);
        let audio_data_owned = audio_data.map(|bytes| bytes.to_vec());
        let engine_id = engine.id().to_string();
        let platform_result = tokio::task::spawn_blocking(move || {
            crate::asr::platform::transcription::transcribe_with_engine(
                engine,
                file_path_owned.as_deref(),
                audio_data_owned.as_deref(),
            )
        })
        .await
        .map_err(|join_error| {
            anyhow::anyhow!(
                "Native engine '{}' task failed to join: {}",
                engine_id,
                join_error
            )
        })??;

        self.last_runtime_errors
            .write()
            .await
            .remove(&requested_provider);

        Ok(TranscriptionResult {
            text: platform_result.text,
            segments: Vec::new(),
            language: platform_result.language,
            confidence: platform_result.confidence,
            processing_time_ms: platform_result.processing_time_ms,
            model_name: engine.id().to_string(),
            model_id: engine.id().to_string(),
            requested_provider,
            actual_provider: requested_provider,
            requested_engine: Some(engine.id().to_string()),
            actual_engine: Some(engine.id().to_string()),
            optimization_applied: true,
            fallback_reason: None,
            vocabulary_hint_terms_applied: 0,
            measured_word_timestamps: false,
            speaker_turns: Vec::new(),
            vocabulary_candidates: Vec::new(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn transcribe_with_provider_attempt(
        &self,
        requested_provider: AsrProviderType,
        actual_provider: AsrProviderType,
        model_id: &str,
        file_path: Option<&Path>,
        audio_data: Option<&[u8]>,
        requested_engine: PlatformEngine,
        actual_engine: PlatformEngine,
        optimization_applied: bool,
        fallback_reason: Option<String>,
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let provider = Self::provider_with_model(actual_provider, Some(model_id));
        let request = async {
            match (file_path, audio_data) {
                (Some(path), None) => provider.transcribe_path_with_options(path, options).await,
                (None, Some(bytes)) => provider.transcribe_bytes_with_options(bytes, options).await,
                _ => Err(anyhow::anyhow!("Invalid transcription input")),
            }
        };
        tokio::pin!(request);
        let primary_result = if actual_provider.is_remote() {
            let gate = self
                .remote_processing_gate
                .read()
                .await
                .clone()
                .ok_or_else(|| anyhow::anyhow!("Remote processing gate is unavailable"))?;
            let mut grant = gate.grant().map_err(anyhow::Error::msg)?;
            tokio::select! {
                result = &mut request => result,
                _ = grant.cancelled() => Err(anyhow::anyhow!(
                    "Remote processing was revoked while transcription was active"
                )),
            }
        } else {
            request.await
        };

        match primary_result {
            Ok(mut result) => {
                self.last_runtime_errors
                    .write()
                    .await
                    .remove(&actual_provider);
                result.requested_provider = requested_provider;
                result.actual_provider = actual_provider;
                result.requested_engine =
                    reported_provider_engine(requested_engine, result.requested_engine);
                result.actual_engine =
                    reported_provider_engine(actual_engine, result.actual_engine);
                result.optimization_applied |= optimization_applied;
                if result.model_id.trim().is_empty() {
                    result.model_id = model_id.to_string();
                }
                if fallback_reason.is_some() {
                    result.fallback_reason = fallback_reason;
                }
                Ok(result)
            }
            Err(error) => {
                self.last_runtime_errors
                    .write()
                    .await
                    .insert(actual_provider, error.to_string());
                Err(error)
            }
        }
    }

    fn select_requested_engine(
        provider_type: AsrProviderType,
        optimization: &crate::settings::PlatformOptimizationSettings,
    ) -> Option<PlatformEngine> {
        // Apple Speech is a first-class, dictation-only provider. It is not an
        // optimization engine for Whisper (or any other provider), and routing it
        // through the engine layer would make an unavailable Apple route silently
        // fall back to the requested provider.
        if provider_type == AsrProviderType::MacosAppleSpeech {
            return None;
        }

        let selected = match optimization.mode.as_str() {
            "manual" => optimization
                .manual_engine_priority
                .iter()
                .filter_map(|id| PlatformEngine::from_id(id))
                .find(|engine| {
                    Self::engine_enabled(*engine, optimization)
                        && engine.supports_provider(provider_type)
                }),
            _ => {
                if !provider_type.is_local() {
                    return None;
                }

                #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
                if optimization.windows.windows_sdk_dictation_enabled {
                    return Some(PlatformEngine::WindowsSdkDictation);
                }

                #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
                if optimization.windows.foundry_enabled {
                    return Some(PlatformEngine::WindowsFoundryLocal);
                }

                None
            }
        };

        selected
    }

    fn engine_enabled(
        engine: PlatformEngine,
        optimization: &crate::settings::PlatformOptimizationSettings,
    ) -> bool {
        match engine {
            PlatformEngine::ProviderDefault => true,
            PlatformEngine::MacosAppleSpeech => optimization.macos.apple_native_enabled,
            PlatformEngine::MacosMlxSidecar => optimization.macos.mlx_enabled,
            PlatformEngine::WindowsFoundryLocal => optimization.windows.foundry_enabled,
            PlatformEngine::WindowsSdkDictation => {
                optimization.windows.windows_sdk_dictation_enabled
            }
        }
    }

    fn engine_runtime_executable(engine: PlatformEngine) -> bool {
        match engine {
            PlatformEngine::ProviderDefault
            | PlatformEngine::MacosMlxSidecar
            | PlatformEngine::WindowsFoundryLocal => true,
            PlatformEngine::MacosAppleSpeech => {
                cfg!(all(target_os = "macos", target_arch = "aarch64"))
            }
            PlatformEngine::WindowsSdkDictation => {
                cfg!(all(target_os = "windows", target_arch = "x86_64"))
            }
        }
    }

    fn engine_selection_is_exclusive(
        engine: PlatformEngine,
        optimization: &crate::settings::PlatformOptimizationSettings,
    ) -> bool {
        if engine == PlatformEngine::ProviderDefault {
            return false;
        }

        if optimization.mode == "manual" {
            if let Some(first) = optimization
                .manual_engine_priority
                .iter()
                .filter_map(|id| PlatformEngine::from_id(id))
                .next()
            {
                return first == engine && first != PlatformEngine::ProviderDefault;
            }
        }

        match engine {
            PlatformEngine::MacosAppleSpeech => optimization.macos.apple_native_enabled,
            PlatformEngine::WindowsSdkDictation => {
                optimization.windows.windows_sdk_dictation_enabled
            }
            _ => false,
        }
    }

    /// Transcribe using the default provider
    pub async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        let provider_type = self.get_default_provider().await;
        self.transcribe_inner(
            provider_type,
            Some(audio_path),
            None,
            None,
            None,
            &TranscriptionOptions::default(),
        )
        .await
    }

    /// Transcribe bytes using the default provider
    pub async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let provider_type = self.get_default_provider().await;
        self.transcribe_inner(
            provider_type,
            None,
            Some(audio_data),
            None,
            None,
            &TranscriptionOptions::default(),
        )
        .await
    }

    /// Transcribe bytes with a specific provider (uses the global MLX accelerated set).
    pub async fn transcribe_bytes_with_provider(
        &self,
        provider_type: AsrProviderType,
        audio_data: &[u8],
        selected_model: Option<&str>,
    ) -> Result<TranscriptionResult> {
        let mut options =
            meeting_spelling_options(provider_type, self.transcription_language().await);
        options.request_speaker_labels = false;
        let mut result = self
            .transcribe_inner(
                provider_type,
                None,
                Some(audio_data),
                selected_model,
                None,
                &options,
            )
            .await?;
        crate::dictation_vocabulary::apply_to_meeting_result(
            &mut result,
            &options.acoustic_vocabulary,
        );
        Ok(result)
    }

    /// Transcribe bytes for the dictation route slot (uses per-slot dictation MLX flag).
    pub async fn transcribe_bytes_for_dictation(
        &self,
        provider_type: AsrProviderType,
        audio_data: &[u8],
        selected_model: Option<&str>,
    ) -> Result<TranscriptionResult> {
        self.transcribe_bytes_for_dictation_with_options(
            provider_type,
            audio_data,
            selected_model,
            &TranscriptionOptions::default(),
        )
        .await
    }

    /// `transcribe_bytes_for_dictation` with per-request options — the final
    /// dictation decode passes the personal-dictionary vocabulary hint here.
    /// Options ride along through the engine/provider fallback chain, so a
    /// fallback provider that can use them still gets them.
    pub async fn transcribe_bytes_for_dictation_with_options(
        &self,
        provider_type: AsrProviderType,
        audio_data: &[u8],
        selected_model: Option<&str>,
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let mlx_enabled = *self.dictation_mlx_enabled.read().await;
        self.transcribe_inner(
            provider_type,
            None,
            Some(audio_data),
            selected_model,
            Some(mlx_enabled),
            options,
        )
        .await
    }

    /// Run a final dictation decode with the selected cache-retention policy.
    ///
    /// Local decodes whose cache must be released run in an owned task. If the
    /// session caller is cancelled, that task keeps the provider future alive
    /// through native completion and only then takes the cleanup gate and
    /// clears the exact route used by this request.
    pub async fn transcribe_bytes_for_dictation_with_cache_policy(
        self: &Arc<Self>,
        provider_type: AsrProviderType,
        audio_data: &[u8],
        selected_model: Option<&str>,
        options: &TranscriptionOptions,
        keep_warm: bool,
    ) -> Result<TranscriptionResult> {
        if keep_warm || provider_type.is_remote() {
            return self
                .transcribe_bytes_for_dictation_with_options(
                    provider_type,
                    audio_data,
                    selected_model,
                    options,
                )
                .await;
        }

        self.transcribe_bytes_for_dictation_with_release_decision(
            provider_type,
            audio_data,
            selected_model,
            options,
            || async { Some(()) },
        )
        .await
    }

    /// Evaluate retention after native completion, with a decision guard held
    /// through eviction. Production returns the locked current settings here.
    pub(crate) async fn transcribe_bytes_for_dictation_with_release_decision<F, Fut, T>(
        self: &Arc<Self>,
        provider_type: AsrProviderType,
        audio_data: &[u8],
        selected_model: Option<&str>,
        options: &TranscriptionOptions,
        decision: F,
    ) -> Result<TranscriptionResult>
    where
        F: FnMut() -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Option<T>> + Send,
        T: Send,
    {
        if provider_type.is_remote() {
            return self
                .transcribe_bytes_for_dictation_with_options(
                    provider_type,
                    audio_data,
                    selected_model,
                    options,
                )
                .await;
        }
        let model_id = match selected_model {
            Some(model) => Self::normalize_model_id(provider_type, model),
            None => self.provider_model_id(provider_type).await,
        };
        let worker_manager = Arc::clone(self);
        let cleanup_manager = Arc::clone(self);
        let worker_model = model_id.clone();
        let cleanup_route = self
            .resolved_local_route_for_cleanup(provider_type, &model_id)
            .await;
        let audio_data = audio_data.to_vec();
        let options = options.clone();

        run_owned_asr_task(
            move || async move {
                worker_manager
                    .transcribe_bytes_for_dictation_with_options(
                        provider_type,
                        &audio_data,
                        Some(&worker_model),
                        &options,
                    )
                    .await
            },
            move || async move {
                run_gated_cache_release(decision, move |gate| {
                    cleanup_manager.clear_resolved_local_route_after_gate(
                        cleanup_route.0,
                        &cleanup_route.1,
                        gate,
                    );
                })
                .await;
            },
        )
        .await
        .map_err(|error| anyhow::anyhow!("Owned final dictation task failed to join: {error}"))?
    }

    /// Transcribe bytes for the meeting route slot (uses per-slot meeting MLX flag).
    pub async fn transcribe_bytes_for_meeting(
        &self,
        provider_type: AsrProviderType,
        audio_data: &[u8],
        selected_model: Option<&str>,
    ) -> Result<TranscriptionResult> {
        if !provider_type.is_remote() {
            crate::llm::local_model_load::yield_to_dictation().await;
        }
        // Apple Speech reaches meetings only through SpeechAnalyzer, which is
        // the only one of its two engines that returns the per-segment
        // timestamps the meeting transcript is assembled from.
        let mut options =
            meeting_spelling_options(provider_type, self.transcription_language().await);
        if provider_type == AsrProviderType::MacosAppleSpeech {
            // `meetings_supported` can run a bounded probe when nothing has
            // looked yet, so it does not hold a runtime worker.
            let meeting_capable =
                tokio::task::spawn_blocking(crate::asr::platform::macos_speech::meetings_supported)
                    .await
                    .unwrap_or(false);
            if !meeting_capable {
                return Err(anyhow::anyhow!(
                    "Apple Speech serves meetings only through SpeechAnalyzer, which needs macOS 26 or later with the language installed. Choose a meeting-capable provider."
                ));
            }
            // Carried down rather than re-decided inside the route. The gate
            // above reads a probe result; the route used to run its own probe
            // moments later, so an asset or reservation change in between put
            // SFSpeechRecognizer on a meeting the gate had cleared for
            // SpeechAnalyzer.
            options.apple_speech_required_engine =
                Some(crate::asr::platform::macos_speech::AppleSpeechEngine::SpeechAnalyzer);
        }
        let mlx_enabled = *self.meeting_mlx_enabled.read().await;
        let mut result = self
            .transcribe_inner(
                provider_type,
                None,
                Some(audio_data),
                selected_model,
                Some(mlx_enabled),
                &options,
            )
            .await?;

        if let Some(refusal) =
            Self::untimestamped_meeting_refusal(provider_type, &result.text, result.segments.len())
        {
            return Err(anyhow::anyhow!(refusal));
        }
        crate::dictation_vocabulary::apply_to_meeting_result(
            &mut result,
            &options.acoustic_vocabulary,
        );
        Ok(result)
    }

    /// Transcribe a whole recording from disk for the meeting route slot.
    ///
    /// Used only where a provider can take an entire meeting in one request:
    /// a provider's speaker numbering is scoped to one request, so this is the
    /// only shape in which its diarization covers the whole recording.
    ///
    /// The options below reach the provider whichever way the request is
    /// served: path mode goes through `AsrProvider::transcribe_path_with_options`
    /// and bytes mode through `transcribe_bytes_with_options`. They used to be
    /// dropped on the path, which is why the two whole-file providers each
    /// hard-coded `request_speaker_labels: true` inside their own `transcribe`.
    pub async fn transcribe_path_for_meeting(
        &self,
        provider_type: AsrProviderType,
        audio_path: &Path,
        selected_model: Option<&str>,
    ) -> Result<TranscriptionResult> {
        if provider_type == AsrProviderType::MacosAppleSpeech {
            return Err(anyhow::anyhow!(
                "Apple Speech is dictation-only and cannot be routed through meeting transcription. Choose a meeting-capable provider."
            ));
        }
        let mlx_enabled = *self.meeting_mlx_enabled.read().await;
        self.transcribe_inner(
            provider_type,
            Some(audio_path),
            None,
            selected_model,
            Some(mlx_enabled),
            &meeting_transcription_options(self.transcription_language().await),
        )
        .await
    }

    /// Why an Apple Speech result cannot become a meeting transcript.
    ///
    /// A meeting transcript is assembled from per-chunk segments with real
    /// start/end times. SFSpeechRecognizer returns one formatted string and no
    /// segments, so text with no segments means the engine that ran was not
    /// the one the gate chose -- and letting it through saved a meeting with a
    /// full transcript, zero timestamps and no error anywhere. The last net
    /// under the required-engine check the helper call already makes, so a new
    /// path into the meeting route cannot reintroduce the same silence.
    ///
    /// Pure, so the policy is testable without a Mac.
    fn untimestamped_meeting_refusal(
        provider_type: AsrProviderType,
        text: &str,
        segment_count: usize,
    ) -> Option<String> {
        if provider_type != AsrProviderType::MacosAppleSpeech
            || text.trim().is_empty()
            || segment_count > 0
        {
            return None;
        }
        Some(
            "Apple Speech returned a transcript with no timestamps, so SFSpeechRecognizer ran instead of SpeechAnalyzer. The meeting was not saved with an untimed transcript. Install the language for SpeechAnalyzer, or choose another meeting provider."
                .to_string(),
        )
    }

    /// Get info for all providers (Parallelized)
    pub async fn get_all_providers_info(&self) -> Result<Vec<ProviderInfo>, String> {
        let (cache_generation, cached_info) = self.provider_info_cache.snapshot().await;
        let apple_speech_readiness = Self::fresh_apple_speech_readiness().await?;
        if let Some(mut cached) = cached_info {
            for provider in &mut cached {
                provider.model_download_bytes = model_download_bytes(provider.provider_type);
            }
            if let Some(apple) = cached
                .iter_mut()
                .find(|provider| provider.provider_type == AsrProviderType::MacosAppleSpeech)
            {
                let optimization = self.platform_optimization().await;
                let mlx_enabled = self
                    .mlx_accelerated_providers()
                    .await
                    .contains(&AsrProviderType::MacosAppleSpeech);
                let last_error = self
                    .last_runtime_errors
                    .read()
                    .await
                    .get(&AsrProviderType::MacosAppleSpeech)
                    .cloned();
                let diagnostics = runtime_diagnostics_for_provider(
                    AsrProviderType::MacosAppleSpeech,
                    apple.selected_model_id.as_str(),
                    apple_speech_readiness.ready,
                    last_error.as_deref(),
                    Some(&apple_speech_readiness),
                );
                apple.is_available = apple_speech_readiness.ready;
                apple.runtime_status = diagnostics.runtime_status;
                apple.runtime_message = diagnostics.runtime_message;
                apple.runtime_details = diagnostics.runtime_details;
                apple.engine_diagnostics = Self::engine_diagnostics_for_provider(
                    AsrProviderType::MacosAppleSpeech,
                    apple.selected_model_id.as_str(),
                    &optimization,
                    mlx_enabled,
                    Some(&apple_speech_readiness),
                );
                apple.platform_readiness = Some(apple_speech_readiness);
            }
            self.provider_info_cache
                .publish(cache_generation, cached.clone())
                .await;
            return Ok(cached);
        }

        let provider_models = self.provider_model_map().await;
        let last_errors = self.last_runtime_errors.read().await.clone();
        let optimization = self.platform_optimization().await;
        let mlx_accelerated_providers = self.mlx_accelerated_providers().await;

        let futures = AsrProviderType::all().into_iter().map(|provider_type| {
            let apple_speech_readiness = apple_speech_readiness.clone();
            let selected_model = provider_models
                .get(&provider_type)
                .cloned()
                .unwrap_or_else(|| provider_type.default_model_id().to_string());
            let optimization = optimization.clone();
            let mlx_accelerated_providers = mlx_accelerated_providers.clone();
            let mlx_enabled = mlx_accelerated_providers.contains(&provider_type);
            let effective = Self::effective_provider_selection(
                provider_type,
                selected_model.as_str(),
                &optimization,
                mlx_enabled,
            );
            let last_error = last_errors.get(&effective.provider_type).cloned();

            async move {
                tokio::task::spawn_blocking(move || {
                    let visible_provider =
                        Self::provider_with_model(provider_type, Some(selected_model.as_str()));
                    let provider = Self::provider_with_model(
                        effective.provider_type,
                        Some(effective.model_id.as_str()),
                    );
                    let platform_readiness = match provider_type {
                        AsrProviderType::MacosAppleSpeech => Some(apple_speech_readiness),
                        _ => None,
                    };
                    let is_available = platform_readiness
                        .as_ref()
                        .map(|readiness| readiness.ready)
                        .unwrap_or_else(|| provider.is_available());
                    let diagnostics = runtime_diagnostics_for_provider(
                        effective.provider_type,
                        effective.model_id.as_str(),
                        is_available,
                        last_error.as_deref(),
                        platform_readiness.as_ref(),
                    );
                    ProviderInfo {
                        provider_type,
                        name: visible_provider.name().to_string(),
                        description: if effective.mlx_accelerated {
                            format!(
                                "{} MLX acceleration is enabled for the selected model.",
                                visible_provider.description()
                            )
                        } else {
                            visible_provider.description().to_string()
                        },
                        is_available,
                        inference_enabled: Self::is_provider_transcription_enabled(
                            effective.provider_type,
                        ),
                        model_info: provider.model_info(),
                        selected_model_id: selected_model.clone(),
                        model_options: provider_type.model_options(),
                        download_status: provider.download_status(),
                        runtime_status: diagnostics.runtime_status,
                        runtime_message: diagnostics.runtime_message,
                        runtime_details: diagnostics.runtime_details,
                        engine_diagnostics: Self::engine_diagnostics_for_provider(
                            effective.provider_type,
                            effective.model_id.as_str(),
                            &optimization,
                            mlx_enabled,
                            platform_readiness.as_ref(),
                        ),
                        model_download_bytes: model_download_bytes(provider_type),
                        platform_readiness,
                    }
                })
                .await
                .map_err(|e| format!("Task join error: {}", e))
            }
        });

        // Current crate uses futures-util
        let results = futures_util::future::join_all(futures).await;

        let mut infos = Vec::new();
        for res in results {
            match res {
                Ok(info) => infos.push(info),
                Err(e) => return Err(e),
            }
        }

        self.provider_info_cache
            .publish(cache_generation, infos.clone())
            .await;
        Ok(infos)
    }

    fn engine_diagnostics_for_provider(
        provider_type: AsrProviderType,
        selected_model_id: &str,
        optimization: &crate::settings::PlatformOptimizationSettings,
        mlx_enabled: bool,
        apple_speech_readiness: Option<&AppleSpeechReadiness>,
    ) -> EngineDiagnostics {
        let mut diagnostics = EngineDiagnostics::default();
        let effective = Self::effective_provider_selection(
            provider_type,
            selected_model_id,
            optimization,
            mlx_enabled,
        );
        let all_engines = [
            PlatformEngine::ProviderDefault,
            PlatformEngine::MacosMlxSidecar,
            PlatformEngine::MacosAppleSpeech,
            PlatformEngine::WindowsFoundryLocal,
            PlatformEngine::WindowsSdkDictation,
        ];

        for engine in all_engines {
            if !engine.supports_provider(effective.provider_type) {
                continue;
            }
            let enabled = Self::engine_enabled(engine, optimization);
            let probe = Self::engine_probe(engine, apple_speech_readiness);
            if probe.ready && Self::engine_runtime_executable(engine) {
                diagnostics.available_engines.push(engine.id().to_string());
                if engine != PlatformEngine::ProviderDefault && !enabled {
                    diagnostics.notes.push(format!(
                        "Engine '{}' is available but currently disabled in settings.",
                        engine.id()
                    ));
                }
            } else if probe.ready && engine != PlatformEngine::ProviderDefault {
                diagnostics.notes.push(format!(
                    "Engine '{}' is configured but execution path is not implemented in this build.",
                    engine.id()
                ));
            }
            diagnostics.notes.extend(probe.notes);
        }

        let active = Self::select_requested_engine(effective.provider_type, optimization)
            .filter(|engine| {
                *engine == PlatformEngine::ProviderDefault
                    || (Self::engine_enabled(*engine, optimization)
                        && engine.supports_provider(effective.provider_type)
                        && Self::engine_probe(*engine, apple_speech_readiness).ready
                        && Self::engine_runtime_executable(*engine))
            })
            .map(|engine| engine.id().to_string());

        diagnostics.active_engine =
            active.or_else(|| Some(PlatformEngine::ProviderDefault.id().to_string()));

        diagnostics
    }

    async fn resolve_download_model_id(
        &self,
        provider_type: AsrProviderType,
        requested_model_id: Option<&str>,
    ) -> Result<String> {
        let model_id = match requested_model_id {
            Some(value) => Self::normalize_model_id(provider_type, value),
            None => self.provider_model_id(provider_type).await,
        };
        if !provider_type
            .model_options()
            .iter()
            .any(|option| option.id == model_id)
        {
            anyhow::bail!("Model '{model_id}' is not available for {provider_type:?}");
        }
        Ok(model_id)
    }

    /// Download models for a provider
    pub async fn download_models(
        &self,
        provider_type: AsrProviderType,
        requested_model_id: Option<&str>,
        progress_cb: Box<dyn Fn(f32) + Send + Sync>,
    ) -> Result<()> {
        let selected_model = self
            .resolve_download_model_id(provider_type, requested_model_id)
            .await?;
        let optimization = self.platform_optimization().await;
        let mlx_accelerated_providers = self.mlx_accelerated_providers().await;
        let effective = Self::effective_provider_selection(
            provider_type,
            selected_model.as_str(),
            &optimization,
            mlx_accelerated_providers.contains(&provider_type),
        );
        let provider =
            Self::provider_with_model(effective.provider_type, Some(effective.model_id.as_str()));
        let result = provider.download_models(progress_cb).await;
        self.invalidate_provider_info_cache().await;
        result
    }

    /// Get models directory
    pub fn models_dir(&self) -> &PathBuf {
        &self.models_dir
    }

    /// Compare providers with benchmark
    pub async fn benchmark_providers(&self, test_audio: &Path) -> Vec<BenchmarkResult> {
        self.benchmark_providers_with_input(BenchmarkInput::Path(test_audio.to_path_buf()))
            .await
    }

    /// Compare providers using caller-owned audio bytes without creating a
    /// dispatch-layer copy on disk. Each provider worker owns an `Arc` until
    /// its real transcription future and cleanup have finished.
    pub async fn benchmark_providers_bytes(&self, test_audio: Vec<u8>) -> Vec<BenchmarkResult> {
        self.benchmark_providers_with_input(BenchmarkInput::Bytes(Arc::new(test_audio)))
            .await
    }

    async fn benchmark_providers_with_input(
        &self,
        test_audio: BenchmarkInput,
    ) -> Vec<BenchmarkResult> {
        let mut results = Vec::new();

        // This aggregate benchmark has no provider-selection or disclosure UI.
        // Keep it local-only so merely configuring a cloud credential can never
        // cause the selected audio to cross the remote-processing boundary.
        for provider_type in benchmark_provider_types() {
            let selected_model = self.provider_model_id(provider_type).await;
            let provider = Self::provider_with_model(provider_type, Some(selected_model.as_str()));
            if !provider.is_available() || !Self::is_provider_transcription_enabled(provider_type) {
                continue;
            }

            let provider_name = provider.name().to_string();
            let benchmark_input = test_audio.clone();
            let models_dir = self.models_dir.clone();
            let cleanup_model = selected_model.clone();
            let (run, joined_processing_time_ms) = time_benchmark_work(run_owned_asr_task_and_cleanup(
                move || async move {
                    // A warm-up or another model can hold the native gate for
                    // a moment; wait for it as the dictation decode does.
                    let busy_deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
                    let (result, processing_time_ms) = loop {
                        let attempt = match &benchmark_input {
                            BenchmarkInput::Path(audio_path) => {
                                time_benchmark_work(provider.transcribe(audio_path)).await
                            }
                            BenchmarkInput::Bytes(audio_bytes) => {
                                time_benchmark_work(
                                    provider.transcribe_bytes(audio_bytes.as_slice()),
                                )
                                .await
                            }
                        };
                        match &attempt.0 {
                            Err(error)
                                if crate::llm::native_runtime_is_busy(&error.to_string())
                                    && std::time::Instant::now() < busy_deadline =>
                            {
                                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                            }
                            _ => break attempt,
                        }
                    };
                    drop(provider);
                    ((result, processing_time_ms), benchmark_input)
                },
                move || async move {
                    let _cleanup_gate = match crate::llm::local_model_load::acquire_cleanup_gate().await {
                        Ok(permit) => permit,
                        Err(error) => {
                            tracing::warn!(
                                provider = ?provider_type,
                                "Could not acquire the native runtime gate after an ASR benchmark: {error}"
                            );
                            return;
                        }
                    };
                    clear_local_route_cache(&models_dir, provider_type, &cleanup_model);
                },
            ))
            .await;
            let ((transcription, processing_time_ms), _benchmark_input) = match run {
                Ok(result) => result,
                Err(error) => {
                    tracing::error!(
                        provider = ?provider_type,
                        "ASR benchmark task failed before cleanup completed: {error}"
                    );
                    results.push(benchmark_result_from_outcome(
                        provider_type,
                        provider_name,
                        selected_model,
                        joined_processing_time_ms,
                        Err(format!("Benchmark task failed: {error}")),
                    ));
                    continue;
                }
            };
            match transcription {
                Ok(transcription) => {
                    results.push(benchmark_result_from_outcome(
                        provider_type,
                        provider_name,
                        selected_model,
                        processing_time_ms,
                        Ok((transcription.text, transcription.confidence)),
                    ));
                }
                Err(e) => {
                    tracing::error!("Benchmark failed for {}: {}", provider_name, e);
                    results.push(benchmark_result_from_outcome(
                        provider_type,
                        provider_name,
                        selected_model,
                        processing_time_ms,
                        Err(e.to_string()),
                    ));
                }
            }
        }

        results
    }
}

fn benchmark_provider_types() -> impl Iterator<Item = AsrProviderType> {
    AsrProviderType::all()
        .into_iter()
        .filter(|provider| !provider.is_remote())
}

/// Provider information for UI
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub provider_type: AsrProviderType,
    pub name: String,
    pub description: String,
    pub is_available: bool,
    pub inference_enabled: bool,
    pub model_info: ModelInfo,
    pub selected_model_id: String,
    pub model_options: Vec<super::ModelOption>,
    pub download_status: DownloadStatus,
    pub runtime_status: RuntimeStatus,
    pub runtime_message: Option<String>,
    pub runtime_details: RuntimeDetails,
    #[serde(default)]
    pub engine_diagnostics: EngineDiagnostics,
    #[serde(default)]
    pub platform_readiness: Option<crate::asr::platform::macos_speech::AppleSpeechReadiness>,
    /// Bytes a Download fetches per model on this Mac where that is more
    /// than the catalog's single-file size, keyed by model id.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub model_download_bytes: HashMap<String, u64>,
}

/// Read fresh on every request, cached inventory or not: the transcription
/// language picks which Neural Engine build a Parakeet download fetches.
fn model_download_bytes(provider_type: AsrProviderType) -> HashMap<String, u64> {
    #[cfg(feature = "asr-transcribe-cpp")]
    if provider_type == AsrProviderType::TranscribeCpp {
        return HashMap::from([(
            super::transcribe_cpp::PARAKEET_GGUF_MODEL_ID.to_string(),
            super::transcribe_cpp::parakeet_download_bytes(),
        )]);
    }
    let _ = provider_type;
    HashMap::new()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInventory {
    pub provider_type: AsrProviderType,
    pub name: String,
    pub description: String,
    pub is_available: bool,
    pub inference_enabled: bool,
    pub selected_model_id: String,
    pub model_options: Vec<super::ModelOption>,
    pub download_status: DownloadStatus,
    #[serde(default)]
    pub platform_readiness: Option<crate::asr::platform::macos_speech::AppleSpeechReadiness>,
    /// Bytes a Download fetches per model on this Mac where that is more
    /// than the catalog's single-file size, keyed by model id.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub model_download_bytes: HashMap<String, u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeStatus {
    Ready,
    MissingRuntime,
    MissingModel,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDetails {
    pub python_path: Option<String>,
    pub model_path: Option<String>,
    #[serde(default)]
    pub missing_files: Vec<String>,
    pub setup_action: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiagnostics {
    pub provider_type: AsrProviderType,
    pub runtime_status: RuntimeStatus,
    pub runtime_message: Option<String>,
    pub runtime_details: RuntimeDetails,
}

#[derive(Debug, Clone)]
struct RuntimeDiagnosticsInternal {
    runtime_status: RuntimeStatus,
    runtime_message: Option<String>,
    runtime_details: RuntimeDetails,
}

#[derive(Debug, Clone)]
struct EffectiveProviderSelection {
    provider_type: AsrProviderType,
    model_id: String,
    mlx_accelerated: bool,
}

/// Benchmark result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkResult {
    pub provider_type: AsrProviderType,
    pub provider_name: String,
    pub model_id: String,
    pub runtime_status: RuntimeStatus,
    pub non_empty_transcript: bool,
    pub processing_time_ms: u64,
    pub transcription: String,
    pub confidence: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

impl Default for AsrManager {
    fn default() -> Self {
        Self::new()
    }
}

fn runtime_diagnostics_for_provider(
    provider_type: AsrProviderType,
    selected_model_id: &str,
    provider_available: bool,
    last_error: Option<&str>,
    apple_speech_readiness: Option<&AppleSpeechReadiness>,
) -> RuntimeDiagnosticsInternal {
    let models_root = crate::paths::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Plainsong")
        .join("models");

    match provider_type {
        AsrProviderType::Whisper => {
            let model_file = format!("ggml-{}.bin", sanitize_whisper_model_id(selected_model_id));
            let model_path = models_root.join("whisper").join(&model_file);
            if !model_path.exists() {
                return RuntimeDiagnosticsInternal {
                    runtime_status: RuntimeStatus::MissingModel,
                    runtime_message: Some(
                        "Whisper model isn't downloaded yet. Download it in Settings > Models."
                            .to_string(),
                    ),
                    runtime_details: RuntimeDetails {
                        model_path: Some(model_path.to_string_lossy().to_string()),
                        python_path: None,
                        missing_files: vec![model_file],
                        setup_action: Some(
                            "Download a Whisper model in Settings > Models.".to_string(),
                        ),
                    },
                };
            }
            if provider_available {
                return RuntimeDiagnosticsInternal {
                    runtime_status: RuntimeStatus::Ready,
                    runtime_message: Some("Whisper is ready on this Mac.".to_string()),
                    runtime_details: RuntimeDetails {
                        model_path: Some(model_path.to_string_lossy().to_string()),
                        python_path: None,
                        missing_files: Vec::new(),
                        setup_action: None,
                    },
                };
            }
            RuntimeDiagnosticsInternal {
                runtime_status: RuntimeStatus::Error,
                runtime_message: Some(last_error.map(ToString::to_string).unwrap_or_else(|| {
                    "Whisper model exists but failed to initialize.".to_string()
                })),
                runtime_details: RuntimeDetails {
                    model_path: Some(model_path.to_string_lossy().to_string()),
                    python_path: None,
                    missing_files: Vec::new(),
                    setup_action: None,
                },
            }
        }
        AsrProviderType::Parakeet => {
            let normalized_model = AsrManager::normalize_model_id(provider_type, selected_model_id);
            let (model_dir, missing_files) =
                parakeet_model_dir_and_missing_files(models_root.as_path(), &normalized_model);

            if !missing_files.is_empty() {
                let display_name = provider_type.speech_model_name(&normalized_model);
                let (message, setup_action) = (
                    format!(
                        "{display_name} isn't downloaded yet. Download it in Settings > Models."
                    ),
                    format!("Download {display_name} in Settings > Models."),
                );
                return RuntimeDiagnosticsInternal {
                    runtime_status: RuntimeStatus::MissingModel,
                    runtime_message: Some(message),
                    runtime_details: RuntimeDetails {
                        model_path: Some(model_dir.to_string_lossy().to_string()),
                        python_path: None,
                        missing_files,
                        setup_action: Some(setup_action),
                    },
                };
            }

            RuntimeDiagnosticsInternal {
                runtime_status: if provider_available {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::Error
                },
                runtime_message: Some(last_error.map(ToString::to_string).unwrap_or_else(|| {
                    format!(
                        "{} is ready.",
                        provider_type.speech_model_name(&normalized_model)
                    )
                })),
                runtime_details: RuntimeDetails {
                    model_path: Some(model_dir.to_string_lossy().to_string()),
                    python_path: None,
                    missing_files: Vec::new(),
                    setup_action: None,
                },
            }
        }
        AsrProviderType::WhisperCandle => {
            let model_dir = models_root.join("canary");
            let model_ready = WHISPER_CANDLE_REQUIRED_FILES
                .iter()
                .all(|f| model_dir.join(f).exists());
            runtime_native_model(
                provider_available,
                model_dir,
                model_ready,
                &missing_required_files(
                    models_root.join("canary").as_path(),
                    &WHISPER_CANDLE_REQUIRED_FILES,
                ),
                MissingModelCopy {
                    message:
                        "Whisper Candle isn't downloaded yet. Download it in Settings > Models.",
                    setup_action: "Download Whisper Candle in Settings > Models.",
                },
                "Whisper Candle is ready on this Mac.",
                last_error,
            )
        }
        AsrProviderType::DistilWhisper => {
            let model_dir = models_root.join("distil_whisper");
            let model_ready = DISTIL_REQUIRED_FILES
                .iter()
                .all(|f| model_dir.join(f).exists());
            runtime_native_model(
                provider_available,
                model_dir,
                model_ready,
                &missing_required_files(
                    models_root.join("distil_whisper").as_path(),
                    &DISTIL_REQUIRED_FILES,
                ),
                MissingModelCopy {
                    message:
                        "Distil-Whisper isn't downloaded yet. Download it in Settings > Models.",
                    setup_action: "Download Distil-Whisper in Settings > Models.",
                },
                "Distil-Whisper native Candle inference ready.",
                last_error,
            )
        }
        AsrProviderType::MacosAppleSpeech => {
            use crate::asr::platform::macos_speech::AppleSpeechReadinessStatus;

            let readiness = apple_speech_readiness
                .cloned()
                .unwrap_or_else(crate::asr::platform::macos_speech::readiness);
            let runtime_status = match readiness.status {
                AppleSpeechReadinessStatus::Ready if provider_available => RuntimeStatus::Ready,
                AppleSpeechReadinessStatus::UnsupportedPlatform
                | AppleSpeechReadinessStatus::HelperMissing
                | AppleSpeechReadinessStatus::RuntimeUnavailable => RuntimeStatus::MissingRuntime,
                _ => RuntimeStatus::Error,
            };

            RuntimeDiagnosticsInternal {
                runtime_status,
                runtime_message: Some(readiness.message),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: if readiness.helper_present {
                        Vec::new()
                    } else {
                        vec!["nautilus-macos-speech-helper-aarch64-apple-darwin".to_string()]
                    },
                    setup_action: readiness.setup_action,
                },
            }
        }
        AsrProviderType::Moonshine => {
            let normalized_model = AsrManager::normalize_model_id(provider_type, selected_model_id);
            let model_dir = if normalized_model == "moonshine-tiny" {
                models_root.join("moonshine_tiny")
            } else {
                models_root.join("moonshine")
            };
            let model_ready = is_valid_onnx_artifact(&model_dir.join("encoder_model.onnx"))
                && is_valid_onnx_artifact(&model_dir.join("decoder_model_merged.onnx"))
                && is_valid_json_artifact(&model_dir.join("tokenizer.json"), 1024);
            let missing_files = missing_or_invalid_moonshine_files(model_dir.as_path());
            runtime_native_model(
                provider_available,
                model_dir,
                model_ready,
                &missing_files,
                MissingModelCopy {
                    message: "Moonshine isn't downloaded yet. Download it in Settings > Models.",
                    setup_action: "Download Moonshine again in Settings > Models.",
                },
                "Moonshine is ready on this Mac.",
                last_error,
            )
        }

        AsrProviderType::WindowsSdkDictation => {
            let probe = PlatformEngine::WindowsSdkDictation.probe();
            RuntimeDiagnosticsInternal {
                runtime_status: if provider_available && probe.ready {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::MissingRuntime
                },
                runtime_message: Some(if provider_available && probe.ready {
                    "Windows speech recognition is ready.".to_string()
                } else if !probe.notes.is_empty() {
                    probe.notes.join(" ")
                } else {
                    "Windows native speech is unavailable in this build.".to_string()
                }),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: Vec::new(),
                    setup_action: Some(
                        "Use a supported Windows x86_64 build with native speech components installed, or choose another ASR provider."
                            .to_string(),
                    ),
                },
            }
        }
        AsrProviderType::ElevenLabsScribe => {
            let has_key = has_provider_secret_or_env("elevenlabs", "ELEVENLABS_API_KEY");
            RuntimeDiagnosticsInternal {
                runtime_status: if has_key {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::MissingModel
                },
                runtime_message: Some(if has_key {
                    "ElevenLabs Scribe cloud API ready.".to_string()
                } else {
                    "Set ELEVENLABS_API_KEY to enable ElevenLabs Scribe.".to_string()
                }),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: if has_key {
                        Vec::new()
                    } else {
                        vec!["ELEVENLABS_API_KEY".to_string()]
                    },
                    setup_action: if has_key {
                        None
                    } else {
                        Some(
                            "Set ELEVENLABS_API_KEY in Settings > Search & AI > API keys."
                                .to_string(),
                        )
                    },
                },
            }
        }
        AsrProviderType::OpenAiCloud => {
            let has_key = has_provider_secret_or_env("openai", "OPENAI_API_KEY");
            RuntimeDiagnosticsInternal {
                runtime_status: if has_key {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::MissingModel
                },
                runtime_message: Some(if has_key {
                    "OpenAI Whisper cloud API ready.".to_string()
                } else {
                    "Set OPENAI_API_KEY to enable OpenAI Whisper cloud.".to_string()
                }),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: if has_key {
                        Vec::new()
                    } else {
                        vec!["OPENAI_API_KEY".to_string()]
                    },
                    setup_action: if has_key {
                        None
                    } else {
                        Some("Set OPENAI_API_KEY in Settings > Search & AI > API keys.".to_string())
                    },
                },
            }
        }
        AsrProviderType::Groq => {
            let has_key = has_provider_secret_or_env("groq", "GROQ_API_KEY");
            RuntimeDiagnosticsInternal {
                runtime_status: if has_key {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::MissingModel
                },
                runtime_message: Some(if has_key {
                    "Groq Whisper cloud API ready. Ultra-fast transcription at 164x real-time."
                        .to_string()
                } else {
                    "Set GROQ_API_KEY to enable Groq Whisper cloud (ultra-fast).".to_string()
                }),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: if has_key {
                        Vec::new()
                    } else {
                        vec!["GROQ_API_KEY".to_string()]
                    },
                    setup_action: if has_key {
                        None
                    } else {
                        Some("Get API key from https://console.groq.com/keys and set in Settings > Search & AI > API keys.".to_string())
                    },
                },
            }
        }
        AsrProviderType::CohereTranscribe => {
            let has_key = has_provider_secret_or_env("cohere", "CO_API_KEY");
            RuntimeDiagnosticsInternal {
                runtime_status: if has_key {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::MissingModel
                },
                runtime_message: Some(if has_key {
                    "Cohere Transcribe cloud API ready. Low WER, 14 languages supported."
                        .to_string()
                } else {
                    "Set CO_API_KEY to enable Cohere Transcribe cloud.".to_string()
                }),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: if has_key {
                        Vec::new()
                    } else {
                        vec!["CO_API_KEY".to_string()]
                    },
                    setup_action: if has_key {
                        None
                    } else {
                        Some("Get API key from https://dashboard.cohere.com/api-keys and set in Settings > Search & AI > API keys.".to_string())
                    },
                },
            }
        }
        AsrProviderType::MistralVoxtral => {
            let has_key = has_provider_secret_or_env("mistral", "MISTRAL_API_KEY");
            RuntimeDiagnosticsInternal {
                runtime_status: if has_key {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::MissingModel
                },
                runtime_message: Some(if has_key {
                    "Mistral Voxtral Mini Transcribe 2 cloud API ready. Returns speaker labels \
                     and segment timestamps at $0.003/min; a request that asks for timestamps \
                     cannot also carry a language, so meetings auto-detect it."
                        .to_string()
                } else {
                    "Set MISTRAL_API_KEY to enable Mistral Voxtral cloud.".to_string()
                }),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: if has_key {
                        Vec::new()
                    } else {
                        vec!["MISTRAL_API_KEY".to_string()]
                    },
                    setup_action: if has_key {
                        None
                    } else {
                        Some(
                            "Get an API key from https://console.mistral.ai and set it in Settings > Search & AI > API keys."
                                .to_string(),
                        )
                    },
                },
            }
        }
        AsrProviderType::XaiStt => {
            let has_key = has_provider_secret_or_env("xai", "XAI_API_KEY");
            RuntimeDiagnosticsInternal {
                runtime_status: if has_key {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::MissingModel
                },
                runtime_message: Some(if has_key {
                    "xAI Grok speech-to-text cloud API ready for dictation. Your dictionary \
                     terms are sent as key terms; meetings use another route."
                        .to_string()
                } else {
                    "Set XAI_API_KEY to enable xAI Grok speech-to-text.".to_string()
                }),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: if has_key {
                        Vec::new()
                    } else {
                        vec!["XAI_API_KEY".to_string()]
                    },
                    setup_action: if has_key {
                        None
                    } else {
                        Some(
                            "Get an API key from https://console.x.ai and set it in Settings > Search & AI > API keys."
                                .to_string(),
                        )
                    },
                },
            }
        }
        AsrProviderType::Deepgram => {
            let has_key = has_provider_secret_or_env("deepgram", "DEEPGRAM_API_KEY");
            RuntimeDiagnosticsInternal {
                runtime_status: if has_key {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::MissingModel
                },
                runtime_message: Some(if has_key {
                    "Deepgram Nova cloud API ready. Returns speaker labels and word timestamps; \
                     every request opts out of Deepgram's model improvement programme."
                        .to_string()
                } else {
                    "Set DEEPGRAM_API_KEY to enable Deepgram Nova cloud.".to_string()
                }),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: if has_key {
                        Vec::new()
                    } else {
                        vec!["DEEPGRAM_API_KEY".to_string()]
                    },
                    setup_action: if has_key {
                        None
                    } else {
                        Some(
                            "Get an API key from https://console.deepgram.com and set it in Settings > Search & AI > API keys."
                                .to_string(),
                        )
                    },
                },
            }
        }
        AsrProviderType::GeminiTranscribe => {
            let has_key = has_provider_secret_or_env("gemini", "GEMINI_API_KEY");
            RuntimeDiagnosticsInternal {
                runtime_status: if has_key {
                    RuntimeStatus::Ready
                } else {
                    RuntimeStatus::MissingModel
                },
                runtime_message: Some(if has_key {
                    "Gemini 3.5 Transcribe cloud API ready. Google's paid tier does not train on \
                     your prompts; the free tier does."
                        .to_string()
                } else {
                    "Set GEMINI_API_KEY to enable Gemini 3.5 Transcribe cloud.".to_string()
                }),
                runtime_details: RuntimeDetails {
                    model_path: None,
                    python_path: None,
                    missing_files: if has_key {
                        Vec::new()
                    } else {
                        vec!["GEMINI_API_KEY".to_string()]
                    },
                    setup_action: if has_key {
                        None
                    } else {
                        Some(
                            "Get an API key from https://aistudio.google.com/apikey and set it in Settings > Search & AI > API keys."
                                .to_string(),
                        )
                    },
                },
            }
        }
        AsrProviderType::Qwen3Asr => {
            let model_dir = models_root.join("qwen3_asr");
            let model_ready = is_valid_onnx_artifact(&model_dir.join("encoder.int4.onnx"))
                && is_valid_onnx_artifact(&model_dir.join("decoder_init.int4.onnx"))
                && is_valid_onnx_artifact(&model_dir.join("decoder_step.int4.onnx"))
                && is_valid_json_artifact(&model_dir.join("config.json"), 64)
                && is_valid_json_artifact(&model_dir.join("tokenizer.json"), 1024);
            let mut missing_files = missing_or_invalid_qwen3_asr_files(model_dir.as_path());
            // Bytes that look right are not enough: a file this session hashed
            // and found wrong reads as missing, the same rule
            // `Qwen3AsrProvider::is_available` applies.
            let trusted = super::qwen3_asr::artifacts_installed(model_dir.as_path());
            if model_ready && !trusted {
                missing_files
                    .push("a pinned Qwen3-ASR file (failed its integrity check)".to_string());
            }
            let model_ready = model_ready && trusted;
            runtime_native_model(
                provider_available,
                model_dir,
                model_ready,
                &missing_files,
                MissingModelCopy {
                    message: "Qwen3-ASR model files are missing or failed their integrity check.",
                    setup_action: "Download Qwen3-ASR again in Settings > Models.",
                },
                "Qwen3-ASR is ready on this Mac.",
                last_error,
            )
        }
        AsrProviderType::CohereLocal => {
            use super::cohere_local;
            let model_dir = models_root.join(cohere_local::COHERE_LOCAL_MODEL_DIR);
            let mut missing_files = cohere_local::missing_or_invalid_files(model_dir.as_path());
            let model_ready = missing_files.is_empty();
            // Bytes that look right are not enough: a file this session hashed
            // and found wrong reads as missing, like every other local route.
            let trusted = cohere_local::artifacts_installed(model_dir.as_path());
            if model_ready && !trusted {
                missing_files.push(
                    "a pinned Cohere Transcribe file (failed its integrity check)".to_string(),
                );
            }
            let model_ready = model_ready && trusted;
            runtime_native_model(
                provider_available,
                model_dir,
                model_ready,
                &missing_files,
                MissingModelCopy {
                    message:
                        "Cohere Transcribe (local) files are missing or failed their integrity check.",
                    setup_action: "Download Cohere Transcribe (local) in Settings > Models.",
                },
                "Cohere Transcribe (local) is ready on this Mac. It transcribes more slowly than the other local models.",
                last_error,
            )
        }
        AsrProviderType::Whistle => {
            let model_dir = super::whistle::model_dir(&models_root);
            let missing_files = [super::whistle::MODEL_FILE, super::whistle::CLI_FILE]
                .into_iter()
                .filter(|name| !model_dir.join(name).is_file())
                .map(str::to_string)
                .collect::<Vec<_>>();
            runtime_native_model(
                provider_available,
                model_dir,
                missing_files.is_empty(),
                &missing_files,
                MissingModelCopy {
                    message: "Whistle model and native CLI are not downloaded or failed their integrity check.",
                    setup_action: "Download Whistle 2.0 in Settings > Models.",
                },
                "Whistle 2.0 is ready on this Mac.",
                last_error,
            )
        }
        #[cfg(feature = "asr-transcribe-cpp")]
        AsrProviderType::TranscribeCpp => {
            use super::transcribe_cpp;
            let spec = transcribe_cpp::route_spec_for(selected_model_id);
            let model_dir = models_root.join(transcribe_cpp::TRANSCRIBE_CPP_MODEL_DIR);
            let model_path = model_dir.join(spec.file_name);
            let model_present = std::fs::metadata(&model_path)
                .map(|metadata| metadata.is_file() && metadata.len() > 0)
                .unwrap_or(false);
            // Bytes that look right are not enough, same rule as every other
            // local route: a file found wrong this session reads as missing.
            let model_trusted =
                crate::download::is_model_artifact_installed(&model_path, Some(spec.sha256));
            let mut missing_files = Vec::new();
            if !model_present {
                missing_files.push(spec.file_name.to_string());
            } else if !model_trusted {
                missing_files.push(format!("{} (failed its integrity check)", spec.file_name));
            }
            let mut auxiliary_ready = true;
            for aux in transcribe_cpp::auxiliary_specs_for(spec.model_id) {
                let path = model_dir.join(aux.local_file_name);
                let present = std::fs::metadata(&path)
                    .map(|metadata| metadata.is_file() && metadata.len() > 0)
                    .unwrap_or(false);
                let trusted = present
                    && crate::download::is_model_artifact_installed(&path, Some(aux.sha256));
                if !present {
                    missing_files.push(aux.local_file_name.to_string());
                } else if !trusted {
                    missing_files.push(format!(
                        "{} (failed its integrity check)",
                        aux.local_file_name
                    ));
                }
                auxiliary_ready &= present && trusted;
            }
            let ggml_ready = model_present && model_trusted && auxiliary_ready;
            // On a Mac that runs it, Parakeet's download is the Core ML build
            // alone, so a missing ggml file is not a missing model there.
            let ready = ggml_ready
                || (spec.model_id == transcribe_cpp::PARAKEET_GGUF_MODEL_ID
                    && super::neural_engine::serves_without_ggml(
                        &models_root,
                        super::neural_engine::preferred_family(),
                    ));
            if ready && !ggml_ready {
                missing_files.clear();
            }
            runtime_native_model(
                provider_available,
                model_dir,
                ready,
                &missing_files,
                MissingModelCopy {
                    message: MISSING_SPEECH_MODEL_MESSAGE,
                    setup_action: "Download the speech model again in Settings > Models.",
                },
                "The speech model is ready.",
                last_error,
            )
        }
    }
}

/// The per-request options every meeting transcription uses.
///
/// The meeting lane always asks for speaker labels, even for a ninety-second
/// chunk whose labels it will then throw away. Gemini only returns word
/// timestamps on a request that also asks for diarization or timestamps, and a
/// meeting without timestamps has no timeline to seek, no diarization to merge
/// and no playhead to follow -- so asking is what buys the timings. Whether
/// the labels that come back are *usable* is decided afterwards by
/// `provider_speaker_turns_survive_chunking`, because a provider numbers its
/// speakers per request.
///
/// No vocabulary hint: the personal dictionary is a dictation feature, and
/// Gemini's API refuses it on the same request as timestamps anyway.
///
/// The language is carried because a cloud provider has to be told one; see
/// `TranscriptionOptions::language`.
fn meeting_spelling_options(
    provider: AsrProviderType,
    language: Option<String>,
) -> TranscriptionOptions {
    let mut options = meeting_transcription_options(language);
    if !provider.is_remote() {
        options.acoustic_vocabulary = crate::dictation_vocabulary::for_meeting();
    }
    options
}

fn meeting_transcription_options(language: Option<String>) -> TranscriptionOptions {
    TranscriptionOptions {
        request_speaker_labels: true,
        language,
        ..TranscriptionOptions::default()
    }
}

/// Diagnostics for native-inference providers (no Python, no external runtime).
fn runtime_native_model(
    provider_available: bool,
    model_dir: PathBuf,
    model_ready: bool,
    missing_files: &[String],
    missing_model_copy: MissingModelCopy<'_>,
    ready_message: &str,
    last_error: Option<&str>,
) -> RuntimeDiagnosticsInternal {
    if !model_ready {
        return RuntimeDiagnosticsInternal {
            runtime_status: RuntimeStatus::MissingModel,
            runtime_message: Some(missing_model_copy.message.to_string()),
            runtime_details: RuntimeDetails {
                model_path: Some(model_dir.to_string_lossy().to_string()),
                python_path: None,
                missing_files: missing_files.to_vec(),
                setup_action: Some(missing_model_copy.setup_action.to_string()),
            },
        };
    }
    RuntimeDiagnosticsInternal {
        runtime_status: if provider_available {
            RuntimeStatus::Ready
        } else {
            RuntimeStatus::Error
        },
        runtime_message: Some(
            last_error
                .map(ToString::to_string)
                .unwrap_or_else(|| ready_message.to_string()),
        ),
        runtime_details: RuntimeDetails {
            model_path: Some(model_dir.to_string_lossy().to_string()),
            python_path: None,
            missing_files: Vec::new(),
            setup_action: None,
        },
    }
}

#[cfg(any(feature = "asr-transcribe-cpp", test))]
const MISSING_SPEECH_MODEL_MESSAGE: &str =
    "The speech model is missing or couldn't be verified. Download it again in Settings > Models.";

struct MissingModelCopy<'a> {
    message: &'a str,
    setup_action: &'a str,
}

fn missing_required_files(model_dir: &Path, required_files: &[&str]) -> Vec<String> {
    required_files
        .iter()
        .filter_map(|name| {
            let path = model_dir.join(name);
            if path.exists() {
                None
            } else {
                Some((*name).to_string())
            }
        })
        .collect()
}

fn missing_or_invalid_moonshine_files(model_dir: &Path) -> Vec<String> {
    let mut missing = Vec::new();
    if !is_valid_onnx_artifact(&model_dir.join("encoder_model.onnx")) {
        missing.push("encoder_model.onnx (valid ONNX model)".to_string());
    }
    if !is_valid_onnx_artifact(&model_dir.join("decoder_model_merged.onnx")) {
        missing.push("decoder_model_merged.onnx (valid ONNX model)".to_string());
    }
    if !is_valid_json_artifact(&model_dir.join("tokenizer.json"), 1024) {
        missing.push("tokenizer.json (valid tokenizer)".to_string());
    }
    missing
}

fn missing_or_invalid_qwen3_asr_files(model_dir: &Path) -> Vec<String> {
    let mut missing = Vec::new();
    if !is_valid_onnx_artifact(&model_dir.join("encoder.int4.onnx")) {
        missing.push("encoder.int4.onnx (valid ONNX model)".to_string());
    }
    if !is_valid_onnx_artifact(&model_dir.join("decoder_init.int4.onnx")) {
        missing.push("decoder_init.int4.onnx (valid ONNX model)".to_string());
    }
    if !is_valid_onnx_artifact(&model_dir.join("decoder_step.int4.onnx")) {
        missing.push("decoder_step.int4.onnx (valid ONNX model)".to_string());
    }
    if !std::path::Path::new(&model_dir.join("decoder_weights.int4.data")).exists() {
        missing.push("decoder_weights.int4.data (shared decoder weights)".to_string());
    }
    if !std::path::Path::new(&model_dir.join("embed_tokens.bin")).exists() {
        missing.push("embed_tokens.bin (token embedding cache)".to_string());
    }
    if !is_valid_json_artifact(&model_dir.join("config.json"), 64) {
        missing.push("config.json (valid model config)".to_string());
    }
    if !is_valid_json_artifact(&model_dir.join("tokenizer.json"), 1024) {
        missing.push("tokenizer.json (valid tokenizer)".to_string());
    }
    missing
}

/// Where a Parakeet route keeps its artifacts, and which of them are missing or
/// unusable.
///
/// Both routes are native ONNX, so neither reports a `python_path`. The legacy
/// 110M export sits directly in `models/parakeet`; TDT v2/v3 get subdirectories
/// beside it. These paths and filenames have to match `asr/parakeet.rs` exactly
/// -- when they drifted apart, diagnostics reported Ready for a model that
/// transcription then could not find.
fn parakeet_model_dir_and_missing_files(
    models_root: &Path,
    normalized_model: &str,
) -> (PathBuf, Vec<String>) {
    let mut missing_files = Vec::new();

    if normalized_model == "parakeet-tdt-ctc-110m" {
        let model_dir = models_root.join("parakeet");
        let has_onnx = PARAKEET_ONNX_NAMES
            .iter()
            .any(|f| is_valid_onnx_artifact(&model_dir.join(f)));
        let has_vocab = PARAKEET_VOCAB_NAMES
            .iter()
            .any(|f| is_valid_token_list_artifact(&model_dir.join(f), 128));
        if !has_onnx {
            missing_files.push(format!(
                "{} (valid ONNX export)",
                PARAKEET_ONNX_NAMES.join(" or ")
            ));
        }
        if !has_vocab {
            missing_files.push("tokens.txt (valid token list)".to_string());
        }
        return (model_dir, missing_files);
    }

    let model_dir = models_root.join("parakeet").join(normalized_model);
    let required_files: &[_] = if normalized_model == "orukeet-v0.1.0-int8" {
        &ORUKEET_REQUIRED_FILES
    } else {
        &PARAKEET_V3_REQUIRED_FILES
    };
    for &(file_name, min_bytes) in required_files {
        let path = model_dir.join(file_name);
        let ok = if file_name == "tokens.txt" {
            is_valid_token_list_artifact(&path, 128)
        } else if file_name == "LICENSE-WEIGHTS" || file_name == "NOTICE.md" {
            path.metadata()
                .is_ok_and(|metadata| metadata.len() >= min_bytes)
        } else {
            is_valid_sized_artifact(&path, min_bytes)
        };
        if !ok {
            missing_files.push(file_name.to_string());
        }
    }
    (model_dir, missing_files)
}

fn migrate_legacy_local_artifacts(models_root: &Path) {
    let parakeet_dir = models_root.join("parakeet");
    if !parakeet_dir.exists() {
        return;
    }

    let legacy_model = parakeet_dir.join("model.onnx");
    let target_model = parakeet_dir.join("encoder.onnx");
    if is_valid_onnx_artifact(&legacy_model) && !target_model.exists() {
        if let Err(error) = std::fs::copy(&legacy_model, &target_model) {
            tracing::warn!(
                "Failed to migrate legacy Parakeet model.onnx -> encoder.onnx: {}",
                error
            );
        }
    } else if legacy_model.exists() && !target_model.exists() {
        tracing::warn!(
            "Legacy Parakeet model.onnx exists but is invalid; skipping migration and requiring redownload."
        );
    }

    let legacy_vocab = parakeet_dir.join("vocab.txt");
    let target_vocab = parakeet_dir.join("tokens.txt");
    if is_valid_token_list_artifact(&legacy_vocab, 128) && !target_vocab.exists() {
        if let Err(error) = std::fs::copy(&legacy_vocab, &target_vocab) {
            tracing::warn!(
                "Failed to migrate legacy Parakeet vocab.txt -> tokens.txt: {}",
                error
            );
        }
    } else if legacy_vocab.exists() && !target_vocab.exists() {
        tracing::warn!(
            "Legacy Parakeet vocab.txt exists but is invalid; skipping migration and requiring redownload."
        );
    }
}

fn is_valid_onnx_artifact(path: &Path) -> bool {
    is_valid_sized_artifact(path, 4096)
}

/// A binary artifact that exists, clears `min_bytes`, and does not begin with
/// an HTML or JSON error marker.
///
/// The size floor is the part that matters for the large ONNX graphs: a stub or
/// half-extracted file passes the "not an error page" check and then fails deep
/// inside ONNX Runtime, where the message tells the user nothing actionable.
fn is_valid_sized_artifact(path: &Path, min_bytes: u64) -> bool {
    use std::io::Read;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < min_bytes.max(4096) {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 1];
    if file.read_exact(&mut buf).is_err() {
        return false;
    }
    buf[0] != b'<' && buf[0] != b'{'
}

fn is_valid_token_list_artifact(path: &Path, min_bytes: u64) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < min_bytes {
        return false;
    }
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    let trimmed = content.trim_start();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.starts_with('{') {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("<html")
        || lower.starts_with("<!doctype")
        || lower.starts_with("<head")
        || lower.starts_with("<body")
    {
        return false;
    }

    let valid_lines = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| {
            let mut parts = line.split_whitespace();
            let token = parts.next();
            let maybe_id = parts.next_back();
            token.is_some()
                && maybe_id
                    .and_then(|value| value.parse::<usize>().ok())
                    .is_some()
        })
        .take(8)
        .count();

    valid_lines >= 4
}

fn is_valid_json_artifact(path: &Path, min_bytes: u64) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < min_bytes {
        return false;
    }
    let Ok(raw) = std::fs::read(path) else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&raw).is_ok()
}

fn sanitize_whisper_model_id(model_id: &str) -> &'static str {
    match model_id {
        "tiny" => "tiny",
        "tiny.en" => "tiny.en",
        "base" => "base",
        "base.en" => "base.en",
        "small" => "small",
        "small.en" => "small.en",
        "medium" => "medium",
        "medium.en" => "medium.en",
        "large-v3-turbo" => "large-v3-turbo",
        "large-v3" => "large-v3",
        _ => "base.en",
    }
}

#[cfg(test)]
mod tests {
    use super::{
        benchmark_provider_types, benchmark_result_from_outcome, meeting_transcription_options,
        migrate_legacy_local_artifacts, parakeet_model_dir_and_missing_files,
        run_owned_asr_task_and_cleanup, runtime_diagnostics_for_provider, runtime_native_model,
        time_benchmark_work, AsrManager, AsrProviderType, BenchmarkInput, MissingModelCopy,
        RuntimeStatus, BENCHMARK_ERROR_MESSAGE_LIMIT, MISSING_SPEECH_MODEL_MESSAGE,
    };
    use crate::asr::AsrProviderFactory;
    use crate::settings::PlatformOptimizationSettings;
    use std::path::PathBuf;
    use std::sync::Arc;

    #[cfg(feature = "asr-transcribe-cpp")]
    #[test]
    fn parakeet_reports_every_byte_its_download_fetches() {
        use crate::asr::transcribe_cpp::{parakeet_download_bytes, PARAKEET_GGUF_MODEL_ID};
        let bytes = super::model_download_bytes(AsrProviderType::TranscribeCpp);
        assert_eq!(
            bytes.get(PARAKEET_GGUF_MODEL_ID),
            Some(&parakeet_download_bytes())
        );
        assert!(super::model_download_bytes(AsrProviderType::Whisper).is_empty());

        let json = serde_json::to_value(super::ProviderInventory {
            provider_type: AsrProviderType::TranscribeCpp,
            name: String::new(),
            description: String::new(),
            is_available: false,
            inference_enabled: true,
            selected_model_id: PARAKEET_GGUF_MODEL_ID.to_string(),
            model_options: Vec::new(),
            download_status: crate::asr::DownloadStatus::NotDownloaded,
            platform_readiness: None,
            model_download_bytes: bytes,
        })
        .unwrap();
        assert_eq!(
            json["modelDownloadBytes"][PARAKEET_GGUF_MODEL_ID],
            serde_json::json!(parakeet_download_bytes())
        );
    }

    #[test]
    fn silence_skip_restores_segments_and_speaker_turns_without_repairing_invalid_times() {
        use crate::asr::{SpeakerTurn, TranscriptSegment, TranscriptionResult};
        let mut bytes = Vec::new();
        let mut writer = hound::WavWriter::new(
            std::io::Cursor::new(&mut bytes),
            hound::WavSpec {
                channels: 1,
                sample_rate: 10,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for sample in [vec![0_i16; 10], vec![1; 10]].concat() {
            writer.write_sample(sample).unwrap();
        }
        writer.finalize().unwrap();
        let processed = crate::audio::utils::compact_digital_silence(&bytes).unwrap();
        let result = TranscriptionResult {
            text: "quiet speech".into(),
            segments: vec![
                TranscriptSegment {
                    start_time: 0.5,
                    end_time: 1.0,
                    text: "quiet".into(),
                    confidence: 0.9,
                },
                TranscriptSegment {
                    start_time: 0.5,
                    end_time: 0.5,
                    text: "point".into(),
                    confidence: 0.9,
                },
                TranscriptSegment {
                    start_time: 1.6,
                    end_time: 1.7,
                    text: "invalid".into(),
                    confidence: 0.1,
                },
            ],
            measured_word_timestamps: true,
            speaker_turns: vec![SpeakerTurn {
                start_time: 0.5,
                end_time: 1.0,
                speaker_id: "S1".into(),
                confidence: 0.8,
            }],
            language: "en".into(),
            confidence: 0.9,
            processing_time_ms: 17,
            model_name: "fixture".into(),
            model_id: "fixture".into(),
            requested_provider: AsrProviderType::Whisper,
            actual_provider: AsrProviderType::Whisper,
            requested_engine: None,
            actual_engine: None,
            optimization_applied: false,
            fallback_reason: None,
            vocabulary_hint_terms_applied: 0,
            vocabulary_candidates: Vec::new(),
        };
        let identity = super::restore_source_timestamps(result.clone(), None);
        assert_eq!(identity.segments, result.segments);
        assert!(identity.measured_word_timestamps);
        let mut valid = result.clone();
        valid.segments.truncate(2);
        valid.speaker_turns.push(SpeakerTurn {
            start_time: 1.6,
            end_time: 1.7,
            speaker_id: "invalid".into(),
            confidence: 0.1,
        });
        let restored = super::restore_source_timestamps(valid, Some(&processed.timeline));
        assert_eq!(restored.segments.len(), 2);
        assert_eq!(
            (
                restored.segments[0].start_time,
                restored.segments[0].end_time
            ),
            (1.0, 1.5)
        );
        assert_eq!(
            (
                restored.segments[1].start_time,
                restored.segments[1].end_time
            ),
            (1.0, 1.0)
        );
        assert!(restored.measured_word_timestamps);
        assert_eq!(restored.speaker_turns.len(), 1);
        assert_eq!(
            (
                restored.speaker_turns[0].start_time,
                restored.speaker_turns[0].end_time
            ),
            (1.0, 1.5)
        );
        let unaligned = super::restore_source_timestamps(result, Some(&processed.timeline));
        assert!(unaligned.segments.is_empty());
        assert!(unaligned.speaker_turns.is_empty());
        assert!(!unaligned.measured_word_timestamps);
        assert_eq!(unaligned.processing_time_ms, 17);
        assert_eq!(unaligned.text, "quiet speech");
        assert_eq!(unaligned.model_id, "fixture");
        assert_eq!(unaligned.model_name, "fixture");
    }

    #[tokio::test]
    async fn requested_model_diagnostics_do_not_change_the_selected_model() {
        let manager = AsrManager::new();
        let before = manager.provider_model_id(AsrProviderType::Whisper).await;
        let requested = manager
            .get_runtime_diagnostics_for_model(AsrProviderType::Whisper, "large-v3-turbo")
            .await;
        assert!(requested
            .runtime_details
            .model_path
            .unwrap()
            .ends_with("ggml-large-v3-turbo.bin"));
        assert_eq!(
            manager.provider_model_id(AsrProviderType::Whisper).await,
            before
        );
    }

    #[test]
    fn aggregate_benchmark_never_includes_remote_providers() {
        let providers = benchmark_provider_types().collect::<Vec<_>>();

        assert!(!providers.is_empty());
        assert!(providers.iter().all(|provider| !provider.is_remote()));
        assert!(AsrProviderType::all()
            .into_iter()
            .filter(|provider| provider.is_remote())
            .all(|provider| !providers.contains(&provider)));
    }

    #[test]
    fn benchmark_outcomes_preserve_success_and_expose_unusable_failures() {
        let success = benchmark_result_from_outcome(
            AsrProviderType::Whisper,
            "Whisper".to_string(),
            "base.en".to_string(),
            17,
            Ok(("hello".to_string(), 0.81)),
        );
        assert!(matches!(success.runtime_status, RuntimeStatus::Ready));
        assert!(success.non_empty_transcript);
        assert_eq!(success.transcription, "hello");
        assert_eq!(success.confidence, 0.81);
        assert_eq!(success.error_message, None);

        let failure = benchmark_result_from_outcome(
            AsrProviderType::Whisper,
            "Whisper".to_string(),
            "base.en".to_string(),
            23,
            Err("decode failed ".repeat(BENCHMARK_ERROR_MESSAGE_LIMIT)),
        );
        assert!(matches!(failure.runtime_status, RuntimeStatus::Error));
        assert!(!failure.non_empty_transcript);
        assert!(failure.transcription.is_empty());
        assert_eq!(failure.processing_time_ms, 23);
        assert_eq!(
            failure.error_message.as_deref().unwrap().chars().count(),
            BENCHMARK_ERROR_MESSAGE_LIMIT
        );
    }

    #[tokio::test]
    async fn cache_release_rechecks_current_warmth_and_holds_the_decision_guard() {
        for current_keep_warm in [false, true] {
            let settings = std::sync::Arc::new(tokio::sync::Mutex::new(current_keep_warm));
            let decision_settings = settings.clone();
            let cleared = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let observed = cleared.clone();
            let settings_during_clear = settings.clone();
            super::run_gated_cache_release(
                move || {
                    let decision_settings = Arc::clone(&decision_settings);
                    async move {
                        let guard = decision_settings.lock_owned().await;
                        if *guard {
                            None
                        } else {
                            Some(guard)
                        }
                    }
                },
                move |_gate| {
                    assert!(
                        settings_during_clear.try_lock().is_err(),
                        "Settings must remain locked through eviction"
                    );
                    observed.store(true, std::sync::atomic::Ordering::SeqCst);
                },
            )
            .await;
            assert_eq!(
                cleared.load(std::sync::atomic::Ordering::SeqCst),
                !current_keep_warm
            );
            assert!(settings.try_lock().is_ok());
        }
    }

    #[tokio::test]
    async fn transcript_returns_while_owned_cleanup_waits_for_background_work() {
        let gate = Arc::new(crate::llm::native_runtime_gate::RuntimeGate::new());
        let background = gate.acquire().unwrap();
        let cleanup_gate = Arc::clone(&gate);
        let cleaned = Arc::new(tokio::sync::Notify::new());
        let done = Arc::clone(&cleaned);
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            super::run_owned_asr_task(
                || async { "transcript" },
                move || async move {
                    let _gate = cleanup_gate.acquire_when_available().await.unwrap();
                    done.notify_one();
                },
            ),
        )
        .await
        .expect("cleanup must not delay the transcript")
        .unwrap();
        assert_eq!(result, "transcript");
        drop(background);
        tokio::time::timeout(std::time::Duration::from_secs(1), cleaned.notified())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn keep_warm_cleanup_does_not_wait_for_a_busy_gate() {
        let runtime_gate = crate::llm::native_runtime_gate::RuntimeGate::new();
        let gate = runtime_gate.acquire().unwrap();
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            super::run_gated_cache_release_from(
                &runtime_gate,
                || async { None::<()> },
                |_| panic!("keep warm"),
            ),
        )
        .await
        .expect("keep-warm cleanup does not acquire the gate");
        drop(gate);
    }

    #[tokio::test]
    async fn owned_asr_task_cleans_up_once_after_success_or_error() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        for result in [Ok::<_, &'static str>("done"), Err("failed")] {
            let cleanups = Arc::new(AtomicUsize::new(0));
            let cleanup_count = Arc::clone(&cleanups);
            let actual = run_owned_asr_task_and_cleanup(
                move || async move { result },
                move || async move {
                    cleanup_count.fetch_add(1, Ordering::SeqCst);
                },
            )
            .await
            .unwrap();
            assert_eq!(actual, result);
            assert_eq!(cleanups.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn benchmark_bytes_are_released_after_success_or_error() {
        use std::sync::Arc;

        for result in [Ok::<_, &'static str>(()), Err("failed")] {
            let bytes = Arc::new(vec![1, 2, 3, 4]);
            let weak_bytes = Arc::downgrade(&bytes);
            let cleanup_weak_bytes = weak_bytes.clone();
            let input = BenchmarkInput::Bytes(bytes);

            let (actual, owned_bytes) = run_owned_asr_task_and_cleanup(
                move || async move {
                    let BenchmarkInput::Bytes(bytes) = input else {
                        unreachable!("test provides bytes")
                    };
                    assert_eq!(bytes.as_slice(), &[1, 2, 3, 4]);
                    (result, bytes)
                },
                move || async move {
                    assert!(
                        cleanup_weak_bytes.upgrade().is_some(),
                        "benchmark bytes must remain owned through cleanup"
                    );
                },
            )
            .await
            .expect("worker should join");

            assert_eq!(actual, result);
            drop(owned_bytes);
            assert!(weak_bytes.upgrade().is_none());
        }
    }

    #[tokio::test]
    async fn cancelled_benchmark_waiter_keeps_bytes_until_worker_finishes() {
        use std::sync::Arc;
        use tokio::sync::Notify;

        let bytes = Arc::new(vec![5, 6, 7, 8]);
        let weak_bytes = Arc::downgrade(&bytes);
        let input = BenchmarkInput::Bytes(bytes);
        let finish = Arc::new(Notify::new());
        let cleaned = Arc::new(Notify::new());
        let worker_finish = Arc::clone(&finish);
        let cleanup_done = Arc::clone(&cleaned);
        let waiter = tokio::spawn(async move {
            run_owned_asr_task_and_cleanup(
                move || async move {
                    let BenchmarkInput::Bytes(bytes) = input else {
                        unreachable!("test provides bytes")
                    };
                    worker_finish.notified().await;
                    assert_eq!(bytes.as_slice(), &[5, 6, 7, 8]);
                },
                move || async move { cleanup_done.notify_one() },
            )
            .await
        });

        tokio::task::yield_now().await;
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        assert!(weak_bytes.upgrade().is_some());

        finish.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(1), cleaned.notified())
            .await
            .expect("detached benchmark worker should finish cleanup");
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while weak_bytes.upgrade().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("detached benchmark worker should release its bytes");
    }

    #[test]
    fn benchmark_path_input_never_deletes_the_callers_file() {
        let path = std::env::temp_dir().join(format!(
            "plainsong-benchmark-path-ownership-{}.wav",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, b"caller-owned audio").expect("write test audio");

        let input = BenchmarkInput::Path(path.clone());
        drop(input);

        assert_eq!(
            std::fs::read(&path).expect("benchmark input must not remove caller file"),
            b"caller-owned audio"
        );
        std::fs::remove_file(path).expect("remove test audio");
    }

    /// Opt-in production-path proof for the final-dictation cache policy.
    /// The harness must expose the pinned base.en artifact through a QA-owned
    /// symlink and copy the public AMI crop under an isolated root before
    /// running this one test serially.
    #[cfg(all(target_os = "macos", target_arch = "aarch64", feature = "asr-whisper"))]
    #[tokio::test]
    #[ignore = "requires isolated roots, a QA symlink to the pinned base.en model, and copied public designer audio"]
    async fn final_dictation_live_retention_rechecks_current_setting() {
        use crate::asr::{TranscriptionOptions, VocabularyHint};
        use sha2::{Digest, Sha256};
        use std::os::unix::fs::MetadataExt;
        use std::path::Path;
        use std::sync::Arc;
        use tokio::sync::{oneshot, Mutex};

        let root = PathBuf::from(
            std::env::var("PLAINSONG_DICTATION_CACHE_POLICY_PROBE_ROOT")
                .expect("explicit isolated probe root"),
        );
        assert!(root.is_absolute(), "probe root must be absolute");
        let data_dir = crate::paths::data_dir().unwrap();
        let config_dir = crate::paths::config_dir().unwrap();
        assert!(
            data_dir.is_absolute(),
            "probe data directory must be absolute"
        );
        assert!(
            config_dir.is_absolute(),
            "probe config directory must be absolute"
        );
        assert_eq!(data_dir, root.join("data"));
        assert_eq!(config_dir, root.join("config"));

        let model_path = root.join("data/Plainsong/models/whisper/ggml-base.en.bin");
        let source = PathBuf::from(
            std::env::var("PLAINSONG_READONLY_WHISPER_MODEL_PATH")
                .expect("explicit read-only pinned base.en source"),
        );
        let audio_path = root.join("designer.wav");
        assert!(source.is_absolute(), "model source must be absolute");
        assert_ne!(source, model_path, "QA model path must not be the source");
        let source_leaf_metadata =
            std::fs::symlink_metadata(&source).expect("model source metadata");
        assert!(
            source_leaf_metadata.file_type().is_file(),
            "model source leaf must be a regular file"
        );
        assert!(
            !source_leaf_metadata.file_type().is_symlink(),
            "model source leaf must not be a symlink"
        );
        assert_eq!(
            std::fs::canonicalize(&source).expect("canonical model source"),
            source,
            "model source must already be canonical"
        );
        let alias_metadata =
            std::fs::symlink_metadata(&model_path).expect("QA model alias metadata");
        assert!(
            alias_metadata.file_type().is_symlink(),
            "QA model leaf must be a symlink"
        );
        assert_eq!(
            std::fs::canonicalize(&model_path).expect("canonical QA model target"),
            source,
            "QA model alias must resolve to the exact read-only source"
        );
        assert_eq!(
            std::fs::metadata(&model_path)
                .expect("resolved QA model metadata")
                .len(),
            147_964_211,
            "unexpected QA model target byte size"
        );

        let source_metadata = |path: &Path| {
            let metadata = std::fs::metadata(path).expect("model source metadata");
            (
                metadata.dev(),
                metadata.ino(),
                metadata.len(),
                metadata.mtime(),
                metadata.mtime_nsec(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            )
        };
        // Verification is remembered in memory only, so nothing may appear
        // beside the source: no record, temporary copy or old-style receipt.
        let files_beside_source = |path: &Path| {
            let name = path
                .file_name()
                .expect("model source file name")
                .to_string_lossy()
                .into_owned();
            let mut names = std::fs::read_dir(path.parent().expect("model source directory"))
                .expect("list model source directory")
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|other| other.starts_with(&name) && *other != name)
                .collect::<Vec<_>>();
            names.sort();
            names
        };
        let source_metadata_before = source_metadata(&source);
        let files_beside_source_before = files_beside_source(&source);
        let model_bytes = source_metadata_before.2 as usize;
        assert_eq!(model_bytes, 147_964_211, "unexpected base.en byte size");
        let expected_model_sha = crate::download::whisper_model_expected_sha256("base.en").unwrap();
        assert!(
            crate::download::verify_existing_model_in_process(&source, &expected_model_sha)
                .await
                .expect("streaming verification of read-only base.en source"),
            "read-only base.en source must match its pinned digest"
        );
        let audio = std::fs::read(&audio_path).expect("copied public designer fixture");
        assert_eq!(audio.len(), 531_244, "unexpected designer WAV byte size");
        let audio_sha = hex::encode(Sha256::digest(&audio));
        assert_eq!(
            audio_sha,
            "54ae84d8543fe30ec0e8200bb308e7015511e39c7ca2a555f4f97dcf896b11b3"
        );
        super::super::whisper::clear_cached_model("base.en");
        struct ClearProbeCache;
        impl Drop for ClearProbeCache {
            fn drop(&mut self) {
                super::super::whisper::clear_cached_model("base.en");
            }
        }
        let _clear_probe_cache = ClearProbeCache;

        let manager = Arc::new(AsrManager::new());
        let options = TranscriptionOptions {
            vocabulary_hint: VocabularyHint::new(vec![
                "industrial designer".into(),
                "technical functional designs".into(),
                "interface specifications".into(),
            ]),
            ..Default::default()
        };

        let mut observations = Vec::new();
        for (name, initial_keep_warm, current_keep_warm, expected_cached) in [
            ("offToOn", false, true, true),
            ("onToOff", true, false, false),
        ] {
            super::super::whisper::clear_cached_model("base.en");
            let keep_warm = Arc::new(Mutex::new(initial_keep_warm));
            let decision_keep_warm = Arc::clone(&keep_warm);
            let (decision_reached_tx, decision_reached_rx) = oneshot::channel();
            let (continue_decision_tx, continue_decision_rx) = oneshot::channel();
            let decode_manager = Arc::clone(&manager);
            let decode_audio = audio.clone();
            let decode_options = options.clone();
            let mut first_decision = Some((decision_reached_tx, continue_decision_rx));
            let decode = tokio::spawn(async move {
                decode_manager
                    .transcribe_bytes_for_dictation_with_release_decision(
                        AsrProviderType::Whisper,
                        &decode_audio,
                        Some("base.en"),
                        &decode_options,
                        move || {
                            let first = first_decision.take();
                            let decision_keep_warm = Arc::clone(&decision_keep_warm);
                            async move {
                                if let Some((reached, resume)) = first {
                                    reached
                                        .send(())
                                        .expect("parent waits for the live decision");
                                    resume.await.expect("parent releases the live decision");
                                }
                                let guard = decision_keep_warm.lock_owned().await;
                                if *guard {
                                    None
                                } else {
                                    Some(guard)
                                }
                            }
                        },
                    )
                    .await
            });

            decision_reached_rx
                .await
                .expect("decision callback after native decode");
            assert!(
                super::super::whisper::is_model_cached("base.en"),
                "{name} must populate the exact cache before the live decision"
            );
            *keep_warm.lock().await = current_keep_warm;
            continue_decision_tx
                .send(())
                .expect("decision callback must still be waiting");

            let result = decode
                .await
                .expect("owned dictation probe task must join")
                .expect("production dictation decode must succeed");
            assert!(!result.text.trim().is_empty(), "{name} transcript");
            if !expected_cached {
                tokio::time::timeout(std::time::Duration::from_secs(1), async {
                    while super::super::whisper::is_model_cached("base.en") {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .expect("owned cleanup eventually clears the cache");
            }
            assert_eq!(
                super::super::whisper::is_model_cached("base.en"),
                expected_cached,
                "{name} cache outcome"
            );
            observations.push((
                name,
                initial_keep_warm,
                current_keep_warm,
                expected_cached,
                result,
            ));
        }

        assert_eq!(observations[0].4.text, observations[1].4.text);
        assert!(!super::super::whisper::is_model_cached("base.en"));
        super::super::whisper::clear_cached_model("base.en");

        assert!(
            crate::download::verify_existing_model_in_process(&source, &expected_model_sha)
                .await
                .expect("post-runtime streaming verification of read-only base.en source"),
            "read-only base.en source must retain its pinned digest"
        );
        assert_eq!(
            source_metadata(&source),
            source_metadata_before,
            "model source metadata changed during the probe"
        );
        assert_eq!(
            files_beside_source(&source),
            files_beside_source_before,
            "the probe wrote a file beside the model source"
        );

        std::fs::write(
            root.join("live-retention-results.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "scope": "Copied public audio and a read-only pinned model source exposed through a QA-owned symlink were used through the production final-dictation live-decision path. No microphone, formatting, insertion, download, model copy, file written beside the model, or competitor claim.",
                "provider": "whisper",
                "model": "base.en",
                "modelBytes": model_bytes,
                "modelSha256": expected_model_sha,
                "modelCopyCreated": false,
                "sourceUnchangedAndNothingWrittenBeside": true,
                "audioBytes": audio.len(),
                "audioSha256": audio_sha,
                "timing": "Each result.processingTimeMs is provider inference time and excludes the test barrier.",
                "observations": observations.into_iter().map(
                    |(name, initial_keep_warm, current_keep_warm, cache_present_after_decision, result)| serde_json::json!({
                        "name": name,
                        "initialKeepWarm": initial_keep_warm,
                        "currentKeepWarm": current_keep_warm,
                        "cachePresentBeforeDecision": true,
                        "cachePresentAfterDecision": cache_present_after_decision,
                        "result": result,
                    })
                ).collect::<Vec<_>>(),
                "cachePresentAfterProbe": false,
            }))
            .unwrap(),
        )
        .expect("write probe results");
    }

    #[tokio::test(start_paused = true)]
    async fn benchmark_timing_excludes_delayed_cleanup() {
        let (result, processing_time_ms) = run_owned_asr_task_and_cleanup(
            || async {
                time_benchmark_work(async {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    "transcript"
                })
                .await
            },
            || async {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            },
        )
        .await
        .unwrap();

        assert_eq!(result, "transcript");
        assert_eq!(processing_time_ms, 2_000);
    }

    #[tokio::test]
    async fn cancelling_asr_waiter_retains_worker_allocation_then_cleans_up() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tokio::sync::Notify;

        struct FakeNativeAllocation(Arc<AtomicUsize>);
        impl Drop for FakeNativeAllocation {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }

        let finish = Arc::new(Notify::new());
        let cleaned = Arc::new(Notify::new());
        let cleanups = Arc::new(AtomicUsize::new(0));
        let allocations_dropped = Arc::new(AtomicUsize::new(0));
        let worker_finish = Arc::clone(&finish);
        let cleanup_done = Arc::clone(&cleaned);
        let cleanup_count = Arc::clone(&cleanups);
        let worker_allocations_dropped = Arc::clone(&allocations_dropped);
        let waiter = tokio::spawn(async move {
            super::run_owned_asr_task(
                move || async move {
                    let _allocation = FakeNativeAllocation(worker_allocations_dropped);
                    worker_finish.notified().await;
                },
                move || async move {
                    cleanup_count.fetch_add(1, Ordering::SeqCst);
                    cleanup_done.notify_one();
                },
            )
            .await
        });
        tokio::task::yield_now().await;
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        assert_eq!(cleanups.load(Ordering::SeqCst), 0);
        assert_eq!(allocations_dropped.load(Ordering::SeqCst), 0);

        finish.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(1), cleaned.notified())
            .await
            .expect("detached provider task cleaned up after its worker exited");
        assert_eq!(cleanups.load(Ordering::SeqCst), 1);
        assert_eq!(allocations_dropped.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancelling_aggregate_waiter_does_not_start_the_next_provider() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tokio::sync::Notify;

        let finish = Arc::new(Notify::new());
        let cleaned = Arc::new(Notify::new());
        let started = Arc::new(AtomicUsize::new(0));
        let loop_finish = Arc::clone(&finish);
        let loop_cleaned = Arc::clone(&cleaned);
        let loop_started = Arc::clone(&started);
        let aggregate = tokio::spawn(async move {
            for index in 0..2 {
                let worker_finish = Arc::clone(&loop_finish);
                let cleanup_done = Arc::clone(&loop_cleaned);
                let worker_started = Arc::clone(&loop_started);
                run_owned_asr_task_and_cleanup(
                    move || async move {
                        worker_started.fetch_add(1, Ordering::SeqCst);
                        if index == 0 {
                            worker_finish.notified().await;
                        }
                    },
                    move || async move { cleanup_done.notify_one() },
                )
                .await
                .unwrap();
            }
        });
        while started.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        aggregate.abort();
        assert!(aggregate.await.unwrap_err().is_cancelled());
        finish.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(1), cleaned.notified())
            .await
            .expect("current provider cleaned up");
        tokio::task::yield_now().await;
        assert_eq!(started.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn cloud_meetings_never_receive_local_name_lists() {
        for provider in [
            AsrProviderType::OpenAiCloud,
            AsrProviderType::Deepgram,
            AsrProviderType::GeminiTranscribe,
        ] {
            let options = super::meeting_spelling_options(provider, Some("en".into()));
            assert!(options.acoustic_vocabulary.is_empty());
            assert!(options.vocabulary_hint.is_none());
            assert!(options.request_speaker_labels);
        }
    }

    #[test]
    fn every_meeting_request_asks_for_speaker_labels_because_that_is_what_buys_timestamps() {
        // Gemini returns word timestamps only on a request that also asks for
        // diarization or timestamps. A meeting chunk that stopped asking would
        // come back as one untimed block, and the transcript would lose its
        // timeline, its playhead and any chance of a diarization merge -- a
        // regression that would look like "speakers stopped working" rather
        // than "timestamps stopped arriving".
        let options = meeting_transcription_options(None);
        assert!(options.request_speaker_labels);
        // And never the personal dictionary: it is a dictation feature, and
        // Gemini's API refuses it alongside timestamps.
        assert!(options.vocabulary_hint.is_none());
        assert!(!options.translate_to_english);
    }

    /// A meeting's options have to reach the provider, on the path as well as
    /// on the bytes route.
    ///
    /// They used to be dropped in path mode, so the whole-file providers
    /// hard-coded `request_speaker_labels: true` inside their own `transcribe`
    /// and nothing else -- a language, a keyterm list -- could ever arrive.
    #[tokio::test]
    async fn a_meeting_carries_the_selected_language_to_the_provider() {
        assert_eq!(meeting_transcription_options(None).language, None);
        assert_eq!(
            meeting_transcription_options(Some("fr".to_string())).language,
            Some("fr".to_string())
        );

        // And the manager is where the meeting lane learns it, because it
        // builds its own options and never sees the settings.
        let manager = AsrManager::new();
        assert_eq!(manager.transcription_language().await, None);
        manager
            .set_transcription_language(Some("de".to_string()))
            .await;
        assert_eq!(
            manager.transcription_language().await,
            Some("de".to_string())
        );
    }

    #[test]
    fn native_moonshine_is_gated_out_of_transcription() {
        for provider in AsrProviderType::all() {
            assert_eq!(
                AsrManager::is_provider_transcription_enabled(provider),
                provider != AsrProviderType::Moonshine
                    && (provider != AsrProviderType::Whistle
                        || cfg!(all(target_os = "macos", target_arch = "aarch64"))),
                "Unexpected inference capability for {provider:?}"
            );
        }
    }

    fn temp_models_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "nautilus-asr-manager-tests-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create temp models root");
        root
    }

    /// Diagnostics must look for the same files `asr/parakeet.rs` loads.
    /// When they disagreed, the UI said Ready and transcription said missing.
    #[test]
    fn parakeet_v3_diagnostics_name_every_artifact_that_is_missing() {
        let models_root = temp_models_root();

        let (model_dir, missing) =
            parakeet_model_dir_and_missing_files(&models_root, "parakeet-tdt-0.6b-v3");
        assert_eq!(
            model_dir,
            models_root.join("parakeet").join("parakeet-tdt-0.6b-v3"),
            "v3 lives in its own subdirectory, beside the legacy export"
        );
        assert_eq!(
            missing,
            vec![
                "encoder.int8.onnx",
                "decoder.int8.onnx",
                "joiner.int8.onnx",
                "tokens.txt"
            ]
        );

        let _ = std::fs::remove_dir_all(models_root);
    }

    #[test]
    fn parakeet_v2_diagnostics_use_the_v2_subdirectory() {
        let models_root = temp_models_root();

        let (model_dir, missing) =
            parakeet_model_dir_and_missing_files(&models_root, "parakeet-tdt-0.6b-v2");
        assert_eq!(
            model_dir,
            models_root.join("parakeet").join("parakeet-tdt-0.6b-v2")
        );
        assert_eq!(
            missing,
            vec![
                "encoder.int8.onnx",
                "decoder.int8.onnx",
                "joiner.int8.onnx",
                "tokens.txt"
            ]
        );

        let _ = std::fs::remove_dir_all(models_root);
    }

    #[test]
    fn parakeet_v3_diagnostics_reject_an_undersized_encoder() {
        let models_root = temp_models_root();
        let model_dir = models_root.join("parakeet").join("parakeet-tdt-0.6b-v3");
        std::fs::create_dir_all(&model_dir).expect("create v3 dir");

        for (file_name, min_bytes) in [
            ("decoder.int8.onnx", 1024 * 1024u64),
            ("joiner.int8.onnx", 512 * 1024),
        ] {
            let file = std::fs::File::create(model_dir.join(file_name)).expect("create");
            file.set_len(min_bytes + 1).expect("size");
        }
        // Big enough to look like a binary, far too small to be a 622 MB encoder.
        let encoder = std::fs::File::create(model_dir.join("encoder.int8.onnx")).expect("create");
        encoder.set_len(8192).expect("size");
        let vocab = (0..100)
            .map(|i| format!("tok{i} {i}\n"))
            .collect::<String>();
        std::fs::write(model_dir.join("tokens.txt"), vocab).expect("write tokens");

        let (_, missing) =
            parakeet_model_dir_and_missing_files(&models_root, "parakeet-tdt-0.6b-v3");
        assert_eq!(missing, vec!["encoder.int8.onnx"]);

        let _ = std::fs::remove_dir_all(models_root);
    }

    /// The legacy export is named `encoder.onnx` by the provisioning script and
    /// `model.onnx` by older in-app downloads. `asr/parakeet.rs` accepts both,
    /// so diagnostics must too.
    #[test]
    fn parakeet_legacy_diagnostics_accept_either_graph_filename() {
        for graph_name in ["encoder.onnx", "model.onnx"] {
            let models_root = temp_models_root();
            let model_dir = models_root.join("parakeet");
            std::fs::create_dir_all(&model_dir).expect("create parakeet dir");
            std::fs::write(model_dir.join(graph_name), vec![0u8; 5000]).expect("write graph");
            let vocab = (0..100)
                .map(|i| format!("tok{i} {i}\n"))
                .collect::<String>();
            std::fs::write(model_dir.join("tokens.txt"), vocab).expect("write tokens");

            let (dir, missing) =
                parakeet_model_dir_and_missing_files(&models_root, "parakeet-tdt-ctc-110m");
            assert_eq!(dir, model_dir);
            assert!(
                missing.is_empty(),
                "{graph_name} should satisfy diagnostics"
            );

            let _ = std::fs::remove_dir_all(models_root);
        }
    }

    #[test]
    fn migrates_legacy_parakeet_artifact_names() {
        let models_root = temp_models_root();
        let parakeet = models_root.join("parakeet");
        std::fs::create_dir_all(&parakeet).expect("create parakeet dir");
        let mut legacy_model = vec![0u8; 5000];
        legacy_model[0] = 1;
        std::fs::write(parakeet.join("model.onnx"), legacy_model).expect("write legacy model");
        let vocab_body = (0..100)
            .map(|i| format!("tok{} {}\n", i, i))
            .collect::<String>();
        std::fs::write(parakeet.join("vocab.txt"), vocab_body).expect("write legacy vocab");

        migrate_legacy_local_artifacts(&models_root);

        assert!(parakeet.join("encoder.onnx").exists());
        assert!(parakeet.join("tokens.txt").exists());
        let _ = std::fs::remove_dir_all(models_root);
    }

    #[test]
    fn migration_does_not_overwrite_new_parakeet_artifacts() {
        let models_root = temp_models_root();
        let parakeet = models_root.join("parakeet");
        std::fs::create_dir_all(&parakeet).expect("create parakeet dir");
        let mut legacy_model = vec![0u8; 5000];
        legacy_model[0] = 1;
        std::fs::write(parakeet.join("model.onnx"), legacy_model).expect("write legacy model");
        let vocab_body = (0..100)
            .map(|i| format!("tok{} {}\n", i, i))
            .collect::<String>();
        std::fs::write(parakeet.join("vocab.txt"), vocab_body).expect("write legacy vocab");
        std::fs::write(parakeet.join("encoder.onnx"), b"new-model").expect("write new model");
        std::fs::write(parakeet.join("tokens.txt"), b"new-vocab").expect("write new vocab");

        migrate_legacy_local_artifacts(&models_root);

        let encoder = std::fs::read(parakeet.join("encoder.onnx")).expect("read encoder");
        let tokens = std::fs::read(parakeet.join("tokens.txt")).expect("read tokens");
        assert_eq!(encoder, b"new-model");
        assert_eq!(tokens, b"new-vocab");
        let _ = std::fs::remove_dir_all(models_root);
    }

    #[tokio::test]
    async fn auto_mode_selects_runtime_engine_for_local_provider() {
        let manager = AsrManager::new();
        let optimization = PlatformOptimizationSettings {
            mode: "auto".to_string(),
            ..PlatformOptimizationSettings::default()
        };
        manager.set_platform_optimization(optimization).await;

        let providers = manager
            .get_all_providers_info()
            .await
            .expect("providers should load");
        let distil = providers
            .iter()
            .find(|provider| provider.provider_type == AsrProviderType::DistilWhisper)
            .expect("distil provider should exist");
        assert!(
            distil.engine_diagnostics.active_engine.as_deref().is_some(),
            "expected active engine to be present"
        );
    }

    #[tokio::test]
    async fn apple_speech_engine_override_does_not_replace_whisper() {
        let manager = AsrManager::new();
        let optimization = PlatformOptimizationSettings {
            mode: "manual".to_string(),
            macos: crate::settings::MacosPlatformOptimizationSettings {
                apple_native_enabled: true,
                ..crate::settings::MacosPlatformOptimizationSettings::default()
            },
            manual_engine_priority: vec!["macos_apple_speech".to_string()],
            ..PlatformOptimizationSettings::default()
        };
        manager.set_platform_optimization(optimization).await;

        let providers = manager
            .get_all_providers_info()
            .await
            .expect("providers should load");
        let whisper = providers
            .iter()
            .find(|provider| provider.provider_type == AsrProviderType::Whisper)
            .expect("whisper provider should exist");
        assert_eq!(
            whisper.engine_diagnostics.active_engine.as_deref(),
            Some("provider_default")
        );
        assert!(!whisper
            .engine_diagnostics
            .available_engines
            .iter()
            .any(|engine| engine == "macos_apple_speech"));
    }

    #[test]
    fn apple_speech_diagnostics_reuse_supplied_readiness() {
        use crate::asr::platform::macos_speech::{
            AppleSpeechReadiness, AppleSpeechReadinessStatus,
        };

        let readiness = AppleSpeechReadiness {
            status: AppleSpeechReadinessStatus::Ready,
            ready: true,
            platform_supported: true,
            helper_present: true,
            authorization: "authorized".to_string(),
            locale: Some("en_US".to_string()),
            locale_supported: true,
            on_device_available: true,
            recognizer_available: true,
            message: "synthetic single-probe readiness".to_string(),
            setup_action: None,
            speech_analyzer_available: false,
            speech_analyzer_locale_supported: false,
            speech_analyzer_assets_installed: false,
            speech_analyzer_asset_status: String::new(),
            speech_analyzer_locales: Vec::new(),
            speech_analyzer_installed_locales: Vec::new(),
            engine: crate::asr::platform::macos_speech::AppleSpeechEngine::SfSpeechRecognizer,
            operating_system_version: None,
        };
        let runtime = runtime_diagnostics_for_provider(
            AsrProviderType::MacosAppleSpeech,
            "macos_apple_speech",
            true,
            None,
            Some(&readiness),
        );
        assert_eq!(
            runtime.runtime_message.as_deref(),
            Some(readiness.message.as_str())
        );

        let engine = AsrManager::engine_diagnostics_for_provider(
            AsrProviderType::MacosAppleSpeech,
            "macos_apple_speech",
            &PlatformOptimizationSettings::default(),
            false,
            Some(&readiness),
        );
        assert!(engine
            .available_engines
            .iter()
            .any(|id| id == "macos_apple_speech"));
        assert!(engine
            .notes
            .iter()
            .any(|note| note == "synthetic single-probe readiness"));
    }

    #[tokio::test]
    async fn apple_speech_provider_reports_structured_platform_readiness() {
        let manager = AsrManager::new();
        let providers = manager
            .get_all_providers_info()
            .await
            .expect("providers should load");
        let apple = providers
            .iter()
            .find(|provider| provider.provider_type == AsrProviderType::MacosAppleSpeech)
            .expect("Apple Speech provider should exist");
        let readiness = apple
            .platform_readiness
            .as_ref()
            .expect("Apple Speech should expose structured readiness");

        assert_eq!(apple.is_available, readiness.ready);
        assert_eq!(
            matches!(apple.runtime_status, super::RuntimeStatus::Ready),
            readiness.ready
        );
    }

    #[tokio::test]
    async fn cached_provider_views_refresh_without_locking_the_cache() {
        let manager = AsrManager::new();
        manager
            .get_all_providers_info()
            .await
            .expect("initial provider info should load");
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            manager.get_all_providers_info(),
        )
        .await
        .expect("cached provider info refresh must not deadlock")
        .expect("cached provider info should refresh");

        manager
            .get_provider_inventory()
            .await
            .expect("initial provider inventory should load");
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            manager.get_provider_inventory(),
        )
        .await
        .expect("cached provider inventory refresh must not deadlock")
        .expect("cached provider inventory should refresh");
    }

    /// Apple Speech reaches meeting transcription only through SpeechAnalyzer,
    /// the one of its two engines that returns per-segment timestamps.
    ///
    /// Both branches are asserted, with the capability pinned for each rather
    /// than left to whichever machine runs the suite: read from the process
    /// flag, the "capable" branch never ran anywhere, because nothing has
    /// probed in a fresh test process. Neither branch ever transcribes: the
    /// bytes are not audio.
    #[tokio::test]
    async fn apple_speech_reaches_meeting_transcription_only_through_speech_analyzer() {
        use crate::asr::platform::macos_speech::{
            meeting_capability, set_meeting_capability_for_test, AppleSpeechMeetingCapability,
        };

        let manager = AsrManager::new();
        let restore = meeting_capability();

        set_meeting_capability_for_test(AppleSpeechMeetingCapability::Unsupported);
        let refused = manager
            .transcribe_bytes_for_meeting(
                AsrProviderType::MacosAppleSpeech,
                b"not audio",
                Some("macos_apple_speech"),
            )
            .await
            .expect_err("a route without SpeechAnalyzer must be refused");
        assert!(refused.to_string().contains("serves meetings only"));
        assert!(refused.to_string().contains("SpeechAnalyzer"));
        assert!(refused.to_string().contains("macOS 26"));

        set_meeting_capability_for_test(AppleSpeechMeetingCapability::Supported);
        let decoded = manager
            .transcribe_bytes_for_meeting(
                AsrProviderType::MacosAppleSpeech,
                b"not audio",
                Some("macos_apple_speech"),
            )
            .await
            .expect_err("bytes that are not audio must never transcribe");
        assert!(
            !decoded.to_string().contains("serves meetings only"),
            "a meeting-capable route must get past the capability gate: {decoded}"
        );

        set_meeting_capability_for_test(restore);
    }

    /// The last net under the required-engine check: a text-only Apple Speech
    /// result means SFSpeechRecognizer ran, and saving it produces a meeting
    /// with a full transcript, zero timestamps and no error anywhere.
    #[test]
    fn an_apple_meeting_result_without_timestamps_is_refused() {
        let refusal = |provider, text: &str, segments| {
            AsrManager::untimestamped_meeting_refusal(provider, text, segments)
        };

        let refused = refusal(AsrProviderType::MacosAppleSpeech, "hello there", 0)
            .expect("text with no segments must be refused");
        assert!(refused.contains("SFSpeechRecognizer"), "{refused}");
        assert!(refused.contains("SpeechAnalyzer"), "{refused}");

        // Timestamps present: this is what SpeechAnalyzer returns.
        assert!(refusal(AsrProviderType::MacosAppleSpeech, "hello there", 2).is_none());
        // Nothing was recognized; that is a different (already handled) case
        // and not evidence about which engine ran.
        assert!(refusal(AsrProviderType::MacosAppleSpeech, "   ", 0).is_none());
        // Every other provider's meeting segments come from its own path.
        assert!(refusal(AsrProviderType::Whisper, "hello there", 0).is_none());
    }

    #[tokio::test]
    async fn requested_download_model_overrides_provider_state() {
        let manager = AsrManager::new();
        manager
            .set_provider_model_id(AsrProviderType::Whisper, "base.en".to_string())
            .await;

        assert_eq!(
            manager
                .resolve_download_model_id(AsrProviderType::Whisper, Some("large-v3-turbo"))
                .await
                .expect("requested model should resolve"),
            "large-v3-turbo"
        );
    }

    #[tokio::test]
    async fn download_model_falls_back_to_provider_state_for_legacy_callers() {
        let manager = AsrManager::new();
        manager
            .set_provider_model_id(AsrProviderType::Whisper, "small.en".to_string())
            .await;

        assert_eq!(
            manager
                .resolve_download_model_id(AsrProviderType::Whisper, None)
                .await
                .expect("selected model should resolve"),
            "small.en"
        );
    }

    #[tokio::test]
    async fn download_model_normalizes_legacy_parakeet_ids() {
        let manager = AsrManager::new();

        assert_eq!(
            manager
                .resolve_download_model_id(AsrProviderType::Parakeet, Some("parakeet-ctc-0.6b"),)
                .await
                .expect("legacy Parakeet model should resolve"),
            "parakeet-tdt-0.6b-v3"
        );
    }

    #[tokio::test]
    async fn download_model_preserves_parakeet_v2_as_a_distinct_route() {
        let manager = AsrManager::new();

        assert_eq!(
            manager
                .resolve_download_model_id(AsrProviderType::Parakeet, Some("parakeet-tdt-0.6b-v2"),)
                .await
                .expect("Parakeet v2 should resolve"),
            "parakeet-tdt-0.6b-v2"
        );
    }

    #[tokio::test]
    async fn download_model_rejects_unknown_provider_model_pair() {
        let manager = AsrManager::new();
        let error = manager
            .resolve_download_model_id(AsrProviderType::Whisper, Some("not-a-whisper-model"))
            .await
            .expect_err("unknown model should be rejected");

        assert!(error.to_string().contains("not available"));
    }

    #[tokio::test]
    async fn groq_provider_honors_selected_model_id() {
        let manager = AsrManager::new();
        manager
            .set_provider_model_id(AsrProviderType::Groq, "whisper-large-v3".to_string())
            .await;

        let provider = manager.get_provider(AsrProviderType::Groq).await;
        let model = provider.model_info();

        assert_eq!(model.version, "whisper-large-v3");
    }

    #[tokio::test]
    async fn moonshine_provider_honors_selected_model_id() {
        let manager = AsrManager::new();
        manager
            .set_provider_model_id(AsrProviderType::Moonshine, "moonshine-tiny".to_string())
            .await;

        let provider = manager.get_provider(AsrProviderType::Moonshine).await;
        let model = provider.model_info();

        assert_eq!(model.name, "Moonshine Tiny");
        assert_eq!(model.version, "tiny");
    }

    #[tokio::test]
    async fn mlx_keep_warm_helpers_are_runtime_safe() {
        let manager = AsrManager::new();
        manager
            .set_mlx_accelerated_providers(std::iter::once(AsrProviderType::Whisper).collect())
            .await;

        assert!(
            manager
                .supports_short_keep_warm(AsrProviderType::Whisper, "base.en")
                .await
        );

        manager
            .cool_down_local_route(AsrProviderType::Whisper, "base.en")
            .await;
    }

    #[tokio::test]
    async fn provider_info_reports_selected_model_ids_for_configured_routes() {
        let manager = AsrManager::new();
        manager
            .set_provider_model_id(AsrProviderType::Whisper, "base.en".to_string())
            .await;
        manager
            .set_provider_model_id(
                AsrProviderType::Parakeet,
                "parakeet-tdt-ctc-110m".to_string(),
            )
            .await;
        manager
            .set_provider_model_id(AsrProviderType::Moonshine, "moonshine-tiny".to_string())
            .await;
        manager
            .set_provider_model_id(
                AsrProviderType::OpenAiCloud,
                "gpt-4o-mini-transcribe".to_string(),
            )
            .await;
        manager
            .set_provider_model_id(AsrProviderType::Groq, "whisper-large-v3".to_string())
            .await;

        let providers = manager
            .get_all_providers_info()
            .await
            .expect("providers should load");

        let selected_model_id = |provider_type| {
            providers
                .iter()
                .find(|provider| provider.provider_type == provider_type)
                .map(|provider| provider.selected_model_id.as_str())
                .expect("provider info should exist")
        };

        assert_eq!(selected_model_id(AsrProviderType::Whisper), "base.en");
        assert_eq!(
            selected_model_id(AsrProviderType::Parakeet),
            "parakeet-tdt-ctc-110m"
        );
        assert_eq!(
            selected_model_id(AsrProviderType::Moonshine),
            "moonshine-tiny"
        );
        assert_eq!(
            selected_model_id(AsrProviderType::OpenAiCloud),
            "gpt-4o-mini-transcribe"
        );
        assert_eq!(selected_model_id(AsrProviderType::Groq), "whisper-large-v3");
    }

    #[tokio::test]
    async fn parakeet_provider_preserves_recommended_v3_model_id() {
        let manager = AsrManager::new();
        manager
            .set_provider_model_id(
                AsrProviderType::Parakeet,
                "parakeet-tdt-0.6b-v3".to_string(),
            )
            .await;

        assert_eq!(
            manager.provider_model_id(AsrProviderType::Parakeet).await,
            "parakeet-tdt-0.6b-v3"
        );

        let provider = manager.get_provider(AsrProviderType::Parakeet).await;
        assert_eq!(provider.model_info().version, "0.6b-v3");
    }

    #[test]
    fn missing_speech_model_copy_keeps_file_details_in_diagnostics() {
        let diagnostics = runtime_native_model(
            true,
            PathBuf::from("/models/speech"),
            false,
            &["model.gguf".to_string()],
            MissingModelCopy {
                message: MISSING_SPEECH_MODEL_MESSAGE,
                setup_action: "Download the speech model again in Settings > Models.",
            },
            "Ready",
            None,
        );
        assert_eq!(diagnostics.runtime_message.as_deref(), Some("The speech model is missing or couldn't be verified. Download it again in Settings > Models."));
        assert_eq!(
            diagnostics.runtime_details.missing_files,
            vec!["model.gguf"]
        );
    }

    #[test]
    fn create_with_model_constructs_every_provider_option() {
        for provider_type in AsrProviderType::all() {
            for model_option in provider_type.model_options() {
                let provider = AsrProviderFactory::create_with_model(
                    provider_type,
                    Some(model_option.id.as_str()),
                );
                let model = provider.model_info();

                assert!(
                    !provider.name().trim().is_empty(),
                    "provider name should exist for {:?} {}",
                    provider_type,
                    model_option.id
                );
                assert!(
                    !model.name.trim().is_empty(),
                    "model info should exist for {:?} {}",
                    provider_type,
                    model_option.id
                );
            }
        }
    }
}

#[cfg(test)]
mod engine_reporting_tests {
    use super::*;

    #[test]
    fn default_dispatch_preserves_the_engine_that_ran() {
        for engine in ["coreml_cpu", "neural_engine", "ggml", "provider_default"] {
            assert_eq!(
                reported_provider_engine(PlatformEngine::ProviderDefault, Some(engine.to_string()))
                    .as_deref(),
                Some(engine)
            );
        }
        assert_eq!(
            reported_provider_engine(PlatformEngine::ProviderDefault, None).as_deref(),
            Some("provider_default")
        );
    }

    #[test]
    fn an_explicit_dispatch_reports_its_selected_engine() {
        let engine = PlatformEngine::from_id("macos_apple_speech").unwrap();
        assert_eq!(
            reported_provider_engine(engine, Some("provider_default".to_string())).as_deref(),
            Some("macos_apple_speech")
        );
    }
}
