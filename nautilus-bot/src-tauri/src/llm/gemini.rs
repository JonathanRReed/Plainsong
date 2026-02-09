//! Google Gemini client for transcript analysis
//!
//! Supports Gemini 1.0 and 1.5 models

use crate::llm::{ActionItem, AnalysisResult, Citation};
use anyhow::{Context, Result};

const GEMINI_API_URL: &str = "https://generativelanguage.googleapis.com/v1beta";

/// Google Gemini client
pub struct GeminiClient {
    api_key: Option<String>,
    client: reqwest::Client,
}

impl GeminiClient {
    /// Create a new Gemini client
    pub fn new() -> Self {
        let api_key = std::env::var("GEMINI_API_KEY").ok();

        Self {
            api_key,
            client: reqwest::Client::new(),
        }
    }

    /// Check if Gemini is available (has API key)
    pub fn is_available(&self) -> bool {
        self.api_key.is_some()
    }

    /// List available models
    pub async fn list_models(&self) -> Result<Vec<String>> {
        let Some(ref key) = self.api_key else {
            return Ok(vec![]);
        };

        let response = self
            .client
            .get(format!("{}/models?key={}", GEMINI_API_URL, key))
            .send()
            .await
            .context("Failed to connect to Gemini API")?;

        let data: serde_json::Value = response
            .json()
            .await
            .context("Failed to parse Gemini response")?;

        let models: Vec<String> = data["models"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|m| m["name"].as_str().map(|s| s.to_string()))
            .filter(|id| id.contains("gemini"))
            .collect();

        Ok(models)
    }

    /// Generate completion
    pub async fn generate(
        &self,
        model: &str,
        prompt: &str,
        _system_prompt: Option<&str>,
    ) -> Result<String> {
        let Some(ref key) = self.api_key else {
            return Err(anyhow::anyhow!("Gemini API key not configured"));
        };

        // Gemini uses models/gemini-pro format
        let model_name = if model.starts_with("models/") {
            model.to_string()
        } else {
            format!("models/{}", model)
        };

        let request_body = serde_json::json!({
            "contents": [
                {
                    "parts": [
                        {
                            "text": prompt
                        }
                    ]
                }
            ],
            "generationConfig": {
                "temperature": 0.7,
                "maxOutputTokens": 1024
            }
        });

        let response = self
            .client
            .post(format!(
                "{}/{}:generateContent?key={}",
                GEMINI_API_URL, model_name, key
            ))
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .await
            .context("Failed to send request to Gemini")?;

        let data: serde_json::Value = response
            .json()
            .await
            .context("Failed to parse Gemini response")?;

        let content = data["candidates"][0]["content"]["parts"][0]["text"]
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
            "{system_prompt}\n\n\
            Transcript:\n{transcript}\n\n\
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

        let prompt = format!("{system_prompt}\n\n{transcript}");

        self.generate(model, &prompt, Some(system_prompt)).await
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

impl Default for GeminiClient {
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
                    });
                }
            }
        }
    }

    citations
}
