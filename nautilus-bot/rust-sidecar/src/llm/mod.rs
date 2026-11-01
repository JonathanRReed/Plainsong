//! LLM provider abstraction for multiple backends
//!
//! Supports:
//! - Bundled local (S1-mini by Superwhisper, via the text helper)
//! - Apple Foundation Models (on-device, macOS 26+)
//! - Ollama (local)
//! - Ollama Cloud
//! - OpenAI
//! - Anthropic (Claude)
//! - Google (Gemini)
//! - DeepSeek
use serde::{Deserialize, Serialize};

mod action_support;
mod anthropic;
pub mod apple_language_model;
pub(crate) mod builtin_embeddings;
pub mod bundled_local;
pub mod chatgpt_plan;
pub(crate) mod claim_support;
mod cloud;
mod commitment_frames;
mod commitments;
mod deepseek;
pub mod embeddings;
mod extractive_recap;
mod gemini;
pub mod grounded;
pub(crate) mod local_model_load;
mod meeting_facts;
mod meeting_requirements;
mod named_role_support;
mod native_download_control;
pub(crate) mod native_runtime_gate;
pub mod notes_queue;
pub(crate) mod notes_window;
mod source_claims;
pub(crate) use native_runtime_gate::is_operation_busy as native_runtime_is_busy;
pub mod native_text;
#[cfg(test)]
mod notes_probe;
mod ollama;
mod ollama_completion_policy;
mod ollama_prewarm_policy;
mod openai;
pub(crate) mod speech_priority;
pub(crate) mod statement_support;
pub(crate) mod summary_verification;
pub(crate) mod text_helper;
pub mod transport;

pub use anthropic::AnthropicClient;
pub use bundled_local::StyleControl;
pub use chatgpt_plan::ChatGptPlanClient;
pub use cloud::OllamaCloudClient;
pub use deepseek::DeepSeekClient;
pub use embeddings::OllamaEmbedder;
pub use gemini::GeminiClient;
pub use grounded::{
    is_transcript_facts_notes, resolve_summary_instruction, transcript_facts_notes,
    GroundedActionItemsOutput, GroundedOrchestrator, GroundedSegment, GroundedTextOutput,
    GroundingContext, OrchestrationOptions, OrchestrationProgressCallback, OrchestrationStage,
    OrchestrationStrategy,
};
pub use ollama::OllamaClient;
pub use openai::OpenAIClient;

pub(crate) fn speech_prewarm_has_current_headroom(
    provider: crate::asr::AsrProviderType,
    model_id: &str,
    model_mib: f64,
) -> bool {
    local_model_load::asr_prewarm_has_headroom(provider, model_id, model_mib)
}
pub(crate) use ollama_prewarm_policy::prime_available_memory_simulation;
pub use transport::{
    CompletionPurpose, Provider, ProviderRuntime, ProviderSelection, RequestOptions,
};

/// Analysis result with citations
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult {
    pub query: String,
    pub response: String,
    pub citations: Vec<Citation>,
    pub actual_provider: String,
    pub model: String,
    pub processing_time_ms: u64,
    pub provenance: crate::models::AnalysisProvenance,
    /// True only when the structured citations returned by the model were
    /// verified against the provided transcript lines. False means the
    /// response is served uncited (citations missing or unresolvable).
    #[serde(default)]
    pub grounded: bool,
}

/// Citation to transcript
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_kind: Option<String>,
    #[serde(default)]
    pub line_id: Option<String>,
    #[serde(default)]
    pub segment_id: Option<String>,
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
    pub recording_id: Option<String>,
    pub certainty: Option<f64>,
}

/// Action item
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionItem {
    pub task: String,
    pub assignee: Option<String>,
    pub deadline: Option<String>,
}
