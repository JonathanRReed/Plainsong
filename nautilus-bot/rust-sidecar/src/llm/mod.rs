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
mod ollama;
mod openai;

pub use anthropic::AnthropicClient;
pub use cloud::OllamaCloudClient;
pub use deepseek::DeepSeekClient;
pub use embeddings::{cosine_similarity, OllamaEmbedder};
pub use gemini::GeminiClient;
pub use ollama::OllamaClient;
pub use openai::OpenAIClient;

/// Analysis result with citations
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult {
    pub query: String,
    pub response: String,
    pub citations: Vec<Citation>,
    pub model: String,
    pub processing_time_ms: u64,
}

/// Citation to transcript
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    pub text: String,
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
