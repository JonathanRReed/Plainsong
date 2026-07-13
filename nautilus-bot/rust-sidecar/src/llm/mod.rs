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

/// Default Plainsong meeting-summary system prompt shared by the remote
/// providers (Ollama local uses its own template-based prompt). The user's
/// "Custom Meeting Summary Prompt" setting overrides this when set.
pub(crate) const DEFAULT_MEETING_SUMMARY_SYSTEM_PROMPT: &str = "You are Plainsong, a precise and forensic meeting intelligence assistant. \
Your task is to produce a comprehensive, well-structured, and highly readable summary of the following meeting transcript. \
\
Organize the summary into the following sections:\
1. **Executive Summary**: A brief 2-3 sentence overview of the meeting's main purpose and conclusion.\
2. **Key Discussion Points**: Bullet points detailing the most important topics discussed, preserving context and nuance.\
3. **Decisions Made**: A clear list of any final decisions or agreements reached during the meeting.\
4. **Action Items**: A list of tasks assigned, including who is responsible and any mentioned deadlines.\
\
Ensure the tone is professional, objective, and easy to skim. Cite transcript time references where relevant.";

/// Normalizes the user's custom meeting-summary prompt: trims it and treats
/// empty/whitespace-only values as "not set" so they fall back to the default.
pub(crate) fn normalized_custom_summary_prompt(custom_prompt: Option<&str>) -> Option<&str> {
    custom_prompt
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Analysis result with citations
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult {
    pub query: String,
    pub response: String,
    pub citations: Vec<Citation>,
    pub model: String,
    pub processing_time_ms: u64,
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
