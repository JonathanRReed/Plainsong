//! Ollama Cloud client for hosted LLM inference
//!
//! Similar API to local Ollama but hosted in the cloud

use crate::llm::{ActionItem, AnalysisResult, Citation};
use anyhow::{Context, Result};

const OLLAMA_CLOUD_URL: &str = "https://api.ollama.com";

/// Ollama Cloud client for hosted LLM inference
pub struct OllamaCloudClient {
    base_url: String,
    api_key: Option<String>,
    client: reqwest::Client,
}

impl OllamaCloudClient {
    /// Create a new Ollama Cloud client
    pub fn new() -> Self {
        Self::with_api_key(None)
    }

    pub fn with_api_key(api_key: Option<String>) -> Self {
        let resolved_api_key = api_key.or_else(|| std::env::var("OLLAMA_CLOUD_API_KEY").ok());

        Self {
            base_url: OLLAMA_CLOUD_URL.to_string(),
            api_key: resolved_api_key,
            client: reqwest::Client::new(),
        }
    }

    /// Check if Ollama Cloud is available
    pub async fn is_available(&self) -> bool {
        // Cloud is always "available" if we have an API key
        self.api_key.is_some()
    }

    /// List available models
    pub async fn list_models(&self) -> Result<Vec<String>> {
        // Ollama Cloud uses OpenAI-compatible API
        let mut request = self.client.get(format!("{}/v1/models", self.base_url));

        if let Some(ref key) = self.api_key {
            request = request.header("Authorization", format!("Bearer {}", key));
        }

        match request.send().await {
            Ok(response) if response.status().is_success() => {
                match response.json::<serde_json::Value>().await {
                    Ok(data) => {
                        let models: Vec<String> = data["data"]
                            .as_array()
                            .or_else(|| data["models"].as_array())
                            .unwrap_or(&vec![])
                            .iter()
                            .filter_map(|m| {
                                m["id"].as_str()
                                    .or_else(|| m["name"].as_str())
                                    .map(|s| s.to_string())
                            })
                            .collect();
                        
                        if models.is_empty() {
                            tracing::warn!("Ollama Cloud returned empty model list, using defaults");
                            return Ok(Self::default_models());
                        }
                        
                        tracing::info!("Ollama Cloud returned {} models", models.len());
                        Ok(models)
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse Ollama Cloud response: {}, using defaults", e);
                        Ok(Self::default_models())
                    }
                }
            }
            Ok(response) => {
                tracing::warn!("Ollama Cloud returned status {}, using default models", response.status());
                Ok(Self::default_models())
            }
            Err(e) => {
                tracing::warn!("Failed to connect to Ollama Cloud: {}, using default models", e);
                Ok(Self::default_models())
            }
        }
    }

    fn default_models() -> Vec<String> {
        vec![
            "llama3.2".to_string(),
            "llama3.3".to_string(),
            "llama4".to_string(),
            "mistral".to_string(),
            "mixtral".to_string(),
            "codellama".to_string(),
            "deepseek-r1".to_string(),
            "qwen2.5".to_string(),
            "phi4".to_string(),
        ]
    }

    /// Generate completion
    pub async fn generate(&self, model: &str, prompt: &str) -> Result<String> {
        let request_body = serde_json::json!({
            "model": model,
            "prompt": prompt,
            "stream": false,
            "options": {
                "temperature": 0.7,
                "num_predict": 1024,
            }
        });

        let mut request = self
            .client
            .post(format!("{}/v1/generate", self.base_url))
            .json(&request_body);

        if let Some(ref key) = self.api_key {
            request = request.header("Authorization", format!("Bearer {}", key));
        }

        let response = request
            .send()
            .await
            .context("Failed to send request to Ollama Cloud")?;

        let data: serde_json::Value = response
            .json()
            .await
            .context("Failed to parse Ollama Cloud response")?;

        Ok(data["response"].as_str().unwrap_or("").to_string())
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

impl Default for OllamaCloudClient {
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
