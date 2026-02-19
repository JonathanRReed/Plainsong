//! LLM provider abstraction for multiple backends
//!
//! Supports:
//! - Ollama (local)
//! - Ollama Cloud
//! - OpenAI
//! - Anthropic (Claude)
//! - Google (Gemini)
//! - DeepSeek
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

mod anthropic;
mod cloud;
mod deepseek;
mod gemini;
mod ollama;
mod openai;

pub use anthropic::AnthropicClient;
pub use cloud::OllamaCloudClient;
pub use deepseek::DeepSeekClient;
pub use gemini::GeminiClient;
pub use ollama::OllamaClient;
pub use openai::OpenAIClient;

/// Provider type for LLM selection
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum LlmProvider {
    #[default]
    Ollama,
    OllamaCloud,
    OpenAI,
    Anthropic,
    Gemini,
    DeepSeek,
}

impl LlmProvider {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Ollama => "Ollama (Local)",
            Self::OllamaCloud => "Ollama Cloud",
            Self::OpenAI => "OpenAI GPT",
            Self::Anthropic => "Anthropic Claude",
            Self::Gemini => "Google Gemini",
            Self::DeepSeek => "DeepSeek",
        }
    }
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
