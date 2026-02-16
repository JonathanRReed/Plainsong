//! Anthropic Claude client for transcript analysis
//!
//! Supports Claude 3 models (Opus, Sonnet, Haiku)

use crate::llm::{ActionItem, AnalysisResult, Citation};
use anyhow::{Context, Result};

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1";

/// Anthropic Claude client
pub struct AnthropicClient {
    api_key: Option<String>,
    client: reqwest::Client,
}

impl AnthropicClient {
    /// Create a new Anthropic client
    pub fn new() -> Self {
        Self::with_api_key(None)
    }

    pub fn with_api_key(api_key: Option<String>) -> Self {
        let resolved_api_key = api_key.or_else(|| std::env::var("ANTHROPIC_API_KEY").ok());

        Self {
            api_key: resolved_api_key,
            client: reqwest::Client::new(),
        }
    }

    /// Check if Anthropic is available (has API key)
    pub fn is_available(&self) -> bool {
        self.api_key.is_some()
    }

    /// List available models
    pub async fn list_models(&self) -> Result<Vec<String>> {
        // Anthropic has a fixed set of models
        Ok(vec![
            "claude-3-opus-20240229".to_string(),
            "claude-3-sonnet-20240229".to_string(),
            "claude-3-haiku-20240307".to_string(),
        ])
    }

    /// Generate completion using Messages API
    pub async fn generate(
        &self,
        model: &str,
        prompt: &str,
        system_prompt: Option<&str>,
    ) -> Result<String> {
        let Some(ref key) = self.api_key else {
            return Err(anyhow::anyhow!("Anthropic API key not configured"));
        };

        let mut request_body = serde_json::json!({
            "model": model,
            "max_tokens": 1024,
            "messages": [
                {
                    "role": "user",
                    "content": prompt
                }
            ]
        });

        if let Some(system) = system_prompt {
            request_body["system"] = serde_json::json!(system);
        }

        let response = self
            .client
            .post(format!("{}/messages", ANTHROPIC_API_URL))
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .await
            .context("Failed to send request to Anthropic")?;

        let data: serde_json::Value = response
            .json()
            .await
            .context("Failed to parse Anthropic response")?;

        let content = data["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .to_string();

        Ok(content)
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
            "Transcript:\n{transcript}\n\n\
            Query: {query}\n\n\
            Provide your analysis:"
        );

        let start_time = std::time::Instant::now();

        let response = self.generate(model, &prompt, Some(system_prompt)).await?;

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
        let system_prompt = "Provide a concise summary of the following meeting transcript. \
            Focus on key points, decisions, and outcomes.";

        self.generate(model, transcript, Some(system_prompt)).await
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

        let response = self.generate(model, &prompt, None).await?;

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

impl Default for AnthropicClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Extract citations from response
fn extract_citations(response: &str, transcript: &str) -> Vec<Citation> {
    let mut citations = Vec::new();

    for line in response.lines() {
        if line.contains('"') {
            let parts: Vec<&str> = line.split('"').collect();
            for (i, part) in parts.iter().enumerate() {
                if i % 2 == 1 && !part.is_empty() && transcript.contains(part) {
                    citations.push(Citation {
                        text: part.to_string(),
                        start_time: None,
                        end_time: None,
                        recording_id: None,
                        certainty: None,
                    });
                }
            }
        }
    }

    citations
}
