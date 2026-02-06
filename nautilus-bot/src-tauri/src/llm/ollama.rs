//! Ollama LLM integration for transcript analysis
//!
//! Provides local LLM capabilities for:
//! - Meeting summarization
//! - Action item extraction
//! - Decision identification
//! - Custom queries with citations

use crate::llm::{ActionItem, AnalysisResult, Citation};
use anyhow::{Context, Result};

const OLLAMA_DEFAULT_URL: &str = "http://localhost:11434";

/// Ollama client for local LLM inference
pub struct OllamaClient {
    base_url: String,
    client: reqwest::Client,
}

impl OllamaClient {
    /// Create a new Ollama client
    pub fn new() -> Self {
        Self {
            base_url: OLLAMA_DEFAULT_URL.to_string(),
            client: reqwest::Client::new(),
        }
    }

    /// Check if Ollama is available
    pub async fn is_available(&self) -> bool {
        match self
            .client
            .get(format!("{}/api/tags", self.base_url))
            .send()
            .await
        {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }

    /// List available models
    pub async fn list_models(&self) -> Result<Vec<String>> {
        let response = self
            .client
            .get(format!("{}/api/tags", self.base_url))
            .send()
            .await
            .context("Failed to connect to Ollama")?;

        let data: serde_json::Value = response
            .json()
            .await
            .context("Failed to parse Ollama response")?;

        let models: Vec<String> = data["models"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|m| m["name"].as_str().map(|s| s.to_string()))
            .collect();

        Ok(models)
    }

    /// Generate completion
    pub async fn generate(&self, model: &str, prompt: &str) -> Result<String> {
        let request = GenerateRequest {
            model: model.to_string(),
            prompt: prompt.to_string(),
            stream: false,
            options: Some(GenerationOptions {
                temperature: 0.7,
                num_predict: 1024,
            }),
        };

        let response = self
            .client
            .post(format!("{}/api/generate", self.base_url))
            .json(&request)
            .send()
            .await
            .context("Failed to send request to Ollama")?;

        let data: GenerateResponse = response
            .json()
            .await
            .context("Failed to parse Ollama response")?;

        Ok(data.response)
    }

    /// Analyze transcript with specific query
    pub async fn analyze_transcript(
        &self,
        transcript: &str,
        query: &str,
        model: &str,
    ) -> Result<AnalysisResult> {
        let system_prompt = "You are an AI assistant analyzing meeting transcripts. \
            Provide clear, concise answers based on the transcript provided. \
            Always cite specific timestamps or quotes when making claims. \
            If you're uncertain, say so.";

        let prompt = format!(
            "{system_prompt}\n\n\
            Transcript:\n{transcript}\n\n\
            Query: {query}\n\n\
            Provide your analysis:"
        );

        let start_time = std::time::Instant::now();

        let response = self.generate(model, &prompt).await?;

        // Extract citations from response
        let citations = extract_citations(&response, transcript);

        Ok(AnalysisResult {
            query: query.to_string(),
            response,
            citations,
            model: model.to_string(),
            processing_time_ms: start_time.elapsed().as_millis() as u64,
        })
    }

    /// Summarize meeting
    pub async fn summarize(&self, transcript: &str, model: &str) -> Result<String> {
        let prompt = format!(
            "Provide a concise summary of the following meeting transcript. \
            Focus on key points, decisions, and outcomes:\n\n{transcript}\n\nSummary:"
        );

        self.generate(model, &prompt).await
    }

    /// Extract action items
    pub async fn extract_action_items(
        &self,
        transcript: &str,
        model: &str,
    ) -> Result<Vec<ActionItem>> {
        let prompt = format!(
            "Extract all action items from the following meeting transcript. \
            For each action item, identify:\n\
            1. The task\n\
            2. Who is responsible (if mentioned)\n\
            3. Any deadlines (if mentioned)\n\n\
            Format as a bulleted list.\n\n\
            Transcript:\n{transcript}\n\n\
            Action Items:"
        );

        let response = self.generate(model, &prompt).await?;

        // Parse action items from response
        let items: Vec<ActionItem> = response
            .lines()
            .filter(|line| line.starts_with('-') || line.starts_with('*'))
            .map(|line| ActionItem {
                task: line
                    .trim_start_matches("- ")
                    .trim_start_matches("* ")
                    .to_string(),
                assignee: None,
                deadline: None,
            })
            .collect();

        Ok(items)
    }
}

impl Default for OllamaClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Generate request
#[derive(Debug, serde::Serialize)]
struct GenerateRequest {
    model: String,
    prompt: String,
    stream: bool,
    options: Option<GenerationOptions>,
}

/// Generation options
#[derive(Debug, serde::Serialize)]
struct GenerationOptions {
    temperature: f32,
    num_predict: i32,
}

/// Generate response
#[derive(Debug, serde::Deserialize)]
struct GenerateResponse {
    response: String,
}

/// Extract citations from response
fn extract_citations(response: &str, transcript: &str) -> Vec<Citation> {
    let mut citations = Vec::new();

    // Simple heuristic: look for quoted text in response
    for line in response.lines() {
        if line.contains('"') {
            let parts: Vec<&str> = line.split('"').collect();
            for (i, part) in parts.iter().enumerate() {
                if i % 2 == 1 && !part.is_empty() {
                    if transcript.contains(part) {
                        citations.push(Citation {
                            text: part.to_string(),
                            start_time: None,
                            end_time: None,
                        });
                    }
                }
            }
        }
    }

    citations
}
