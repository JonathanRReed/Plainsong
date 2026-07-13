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
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .unwrap_or_default(),
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

        tracing::info!("Ollama returned {} models", models.len());
        Ok(models)
    }

    /// Generate completion
    pub async fn generate(&self, model: &str, prompt: &str) -> Result<String> {
        self.generate_inner(model, prompt, None, 0.7).await
    }

    async fn generate_with_format(
        &self,
        model: &str,
        prompt: &str,
        format: serde_json::Value,
    ) -> Result<String> {
        let response = self
            .generate_inner(model, prompt, Some(format), 0.1)
            .await?;

        if response.trim().is_empty() {
            return self.generate_inner(model, prompt, None, 0.1).await;
        }

        Ok(response)
    }

    async fn generate_inner(
        &self,
        model: &str,
        prompt: &str,
        format: Option<serde_json::Value>,
        temperature: f32,
    ) -> Result<String> {
        let request = GenerateRequest {
            model: model.to_string(),
            prompt: prompt.to_string(),
            stream: false,
            format,
            options: Some(GenerationOptions {
                temperature,
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

        let response = if let Some(format) = structured_format_for_query(query) {
            self.generate_with_format(model, &prompt, format).await?
        } else {
            self.generate(model, &prompt).await?
        };

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

    /// Summarize meeting with optional template
    pub async fn summarize(&self, transcript: &str, model: &str) -> Result<String> {
        self.summarize_with_template(transcript, model, None).await
    }

    /// Summarize meeting with a specific template style
    pub async fn summarize_with_template(
        &self,
        transcript: &str,
        model: &str,
        template: Option<&str>,
    ) -> Result<String> {
        let template_instruction = match template {
            Some("standup") => "Format as a standup update: What was done, what is planned, and any blockers.",
            Some("1on1") => "Format as a 1:1 summary: key topics discussed, feedback given, goals and commitments made.",
            Some("sales") => "Format as a sales call summary: prospect information, pain points, objections, next steps, and deal status.",
            Some("interview") => "Format as an interview summary: candidate strengths, weaknesses, key answers, and hiring recommendation.",
            Some("brainstorm") => "Format as a brainstorm summary: ideas generated, top candidates, decisions made, and follow-up actions.",
            _ => "Format as a meeting summary: key points, decisions made, and important outcomes.",
        };

        let prompt = format!(
            "Summarize the following meeting transcript. {template_instruction}\n\nTranscript:\n{transcript}\n\nSummary:"
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
            "You are an expert AI meeting assistant. Extract all actionable items from the following meeting transcript. \
For each action item, clearly identify:\n\
1. The specific task or deliverable\n\
2. Who is responsible (if mentioned, otherwise mark as 'Unassigned')\n\
3. Any deadlines or timeframes mentioned (if none, mark as 'No deadline')\n\n\
Format as a clean, highly readable bulleted list. If there are no action items, simply output 'No action items identified.'\n\n\
Transcript:\n{transcript}\n\n\
Action Items:"
        );

        let response = self.generate(model, &prompt).await?;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<serde_json::Value>,
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

fn structured_format_for_query(query: &str) -> Option<serde_json::Value> {
    let normalized = query.to_ascii_lowercase();
    if !(normalized.contains("return json only") && normalized.contains("citations")) {
        return None;
    }

    if normalized.contains("actionitems") {
        return Some(serde_json::json!({
            "type": "object",
            "properties": {
                "actionItems": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "task": { "type": "string" },
                            "assignee": { "type": ["string", "null"] },
                            "deadline": { "type": ["string", "null"] },
                            "citations": {
                                "type": "array",
                                "items": citation_schema()
                            }
                        },
                        "required": ["task", "assignee", "deadline", "citations"]
                    }
                }
            },
            "required": ["actionItems"]
        }));
    }

    if normalized.contains("\"response\"") {
        return Some(serde_json::json!({
            "type": "object",
            "properties": {
                "response": { "type": "string" },
                "citations": {
                    "type": "array",
                    "items": citation_schema()
                }
            },
            "required": ["response", "citations"]
        }));
    }

    None
}

fn citation_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "recordingId": { "type": "string" },
            "startTime": { "type": "number" },
            "endTime": { "type": "number" },
            "text": { "type": "string" },
            "certainty": { "type": "number" }
        },
        "required": ["recordingId", "startTime", "endTime", "text", "certainty"]
    })
}

#[cfg(test)]
mod tests {
    use super::structured_format_for_query;

    #[test]
    fn structured_format_detects_grounded_analysis_payload() {
        let format = structured_format_for_query(
            "Return JSON only with schema: {\"response\":\"string\",\"citations\":[]}",
        )
        .expect("schema");
        assert!(format["properties"]["response"].is_object());
        assert!(format["properties"]["citations"].is_object());
    }

    #[test]
    fn structured_format_detects_grounded_action_items_payload() {
        let format = structured_format_for_query(
            "Return JSON only with schema: {\"actionItems\":[{\"citations\":[]}]}",
        )
        .expect("schema");
        assert!(format["properties"]["actionItems"].is_object());
    }

    #[test]
    fn structured_format_ignores_free_text_queries() {
        assert!(structured_format_for_query("Summarize this transcript").is_none());
    }
}
