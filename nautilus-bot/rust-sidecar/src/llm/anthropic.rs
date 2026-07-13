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
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .unwrap_or_default(),
        }
    }

    /// List available models from Anthropic API
    pub async fn list_models(&self) -> Result<Vec<String>> {
        let Some(ref key) = self.api_key else {
            return Ok(vec![]);
        };

        let response = self
            .client
            .get(format!("{}/models", ANTHROPIC_API_URL))
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .send()
            .await
            .context("Failed to fetch Anthropic models")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("Anthropic model list error {}: {}", status, body);
        }

        let data: serde_json::Value = response
            .json()
            .await
            .context("Failed to parse Anthropic response")?;

        let models: Vec<String> = data["data"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
            .filter(|id| id.contains("claude"))
            .collect();

        tracing::info!("Anthropic returned {} models", models.len());
        Ok(models)
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

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("Anthropic completion error {}: {}", status, body);
        }

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
            grounded: false,
        })
    }

    /// Summarize meeting
    pub async fn summarize(&self, transcript: &str, model: &str) -> Result<String> {
        let system_prompt = "You are Plainsong, a precise and forensic meeting intelligence assistant. \
Your task is to produce a comprehensive, well-structured, and highly readable summary of the following meeting transcript. \
\
Organize the summary into the following sections:\
1. **Executive Summary**: A brief 2-3 sentence overview of the meeting's main purpose and conclusion.\
2. **Key Discussion Points**: Bullet points detailing the most important topics discussed, preserving context and nuance.\
3. **Decisions Made**: A clear list of any final decisions or agreements reached during the meeting.\
4. **Action Items**: A list of tasks assigned, including who is responsible and any mentioned deadlines.\
\
Ensure the tone is professional, objective, and easy to skim. Cite transcript time references where relevant.";

        self.generate(model, transcript, Some(system_prompt)).await
    }

    /// Extract action items
    pub async fn extract_action_items(
        &self,
        transcript: &str,
        model: &str,
    ) -> Result<Vec<ActionItem>> {
        let prompt = format!(
            "You are an expert AI meeting assistant. Extract all actionable items from the following meeting transcript. \
For each action item, clearly identify:\n\
1. The specific task or deliverable\n\
2. Who is responsible (if mentioned, otherwise mark as 'Unassigned')\n\
3. Any deadlines or timeframes mentioned (if none, mark as 'No deadline')\n\n\
Format as a clean, highly readable bulleted list. If there are no action items, simply output 'No action items identified.'\n\n\
Transcript:\n{transcript}\n\n\
Action Items:"
        );

        let response = self.generate(model, &prompt, None).await?;

        // Parse action items from response (supports -, *, and numbered lists)
        let items: Vec<ActionItem> = response
            .lines()
            .filter(|line| {
                let trimmed = line.trim();
                trimmed.starts_with('-')
                    || trimmed.starts_with('*')
                    || trimmed.starts_with("•")
                    || trimmed.chars().next().is_some_and(|c| c.is_ascii_digit())
                        && trimmed.chars().nth(1).is_some_and(|c| c == '.' || c == ')')
            })
            .map(|line| {
                let task = line
                    .trim()
                    .trim_start_matches("- ")
                    .trim_start_matches("* ")
                    .trim_start_matches("• ")
                    .trim_start_matches(|c: char| c.is_ascii_digit())
                    .trim_start_matches(['.', ')'])
                    .trim_start();
                ActionItem {
                    task: task.to_string(),
                    assignee: None,
                    deadline: None,
                }
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
