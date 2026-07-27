//! LLM provider abstraction for multiple backends
//!
//! Supports:
//! - Ollama (local)
//! - Ollama Cloud
//! - OpenAI
//! - Anthropic (Claude)
//! - Google (Gemini)
//! - DeepSeek
use serde::{Deserialize, Serialize};

mod anthropic;
mod cloud;
mod deepseek;
pub mod embeddings;
mod gemini;
pub mod grounded;
mod ollama;
mod openai;
pub mod transport;

pub use anthropic::AnthropicClient;
pub use cloud::OllamaCloudClient;
pub use deepseek::DeepSeekClient;
pub use embeddings::{cosine_similarity, OllamaEmbedder};
pub use gemini::GeminiClient;
pub use grounded::{
    resolve_summary_instruction, GroundedActionItemsOutput, GroundedOrchestrator, GroundedSegment,
    GroundedTextOutput, GroundingContext, OrchestrationOptions, OrchestrationProgressCallback,
    OrchestrationStage, OrchestrationStrategy,
};
pub use ollama::OllamaClient;
pub use openai::OpenAIClient;
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
