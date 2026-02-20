//! DeepSeek client for transcript analysis
//!
//! DeepSeek uses an OpenAI-compatible API with competitive pricing
//! Offers V3 for general chat and R1 for advanced reasoning

#![allow(dead_code)]

use crate::llm::{ActionItem, AnalysisResult, Citation};
use anyhow::{Context, Result};

const DEEPSEEK_API_URL: &str = "https://api.deepseek.com/v1";

pub struct DeepSeekClient {
    api_key: Option<String>,
    client: reqwest::Client,
}

impl DeepSeekClient {
    pub fn new() -> Self {
        Self::with_api_key(None)
    }

    pub fn with_api_key(api_key: Option<String>) -> Self {
        let resolved_api_key = api_key.or_else(|| std::env::var("DEEPSEEK_API_KEY").ok());

        Self {
            api_key: resolved_api_key,
            client: reqwest::Client::new(),
        }
    }

    pub fn is_available(&self) -> bool {
        self.api_key.is_some()
    }

    /// List available models from DeepSeek API
    pub async fn list_models(&self) -> Result<Vec<String>> {
        let Some(ref key) = self.api_key else {
            return Ok(vec![]);
        };

        let response = self
            .client
            .get(format!("{}/models", DEEPSEEK_API_URL))
            .header("Authorization", format!("Bearer {}", key))
            .send()
            .await
            .context("Failed to fetch DeepSeek models")?;

        let data: serde_json::Value = response
            .json()
            .await
            .context("Failed to parse DeepSeek response")?;

        let models: Vec<String> = data["data"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
            .collect();

        tracing::info!("DeepSeek returned {} models", models.len());
        Ok(models)
    }

    pub async fn generate(
        &self,
        model: &str,
        prompt: &str,
        system_prompt: Option<&str>,
    ) -> Result<String> {
        let Some(ref key) = self.api_key else {
            return Err(anyhow::anyhow!("DeepSeek API key not configured"));
        };

        let mut messages = vec![];

        if let Some(system) = system_prompt {
            messages.push(serde_json::json!({
                "role": "system",
                "content": system
            }));
        }

        messages.push(serde_json::json!({
            "role": "user",
            "content": prompt
        }));

        let request_body = serde_json::json!({
            "model": model,
            "messages": messages,
            "temperature": 0.7,
            "max_tokens": 1024
        });

        let response = self
            .client
            .post(format!("{}/chat/completions", DEEPSEEK_API_URL))
            .header("Authorization", format!("Bearer {}", key))
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .await
            .context("Failed to send request to DeepSeek")?;

        let data: serde_json::Value = response
            .json()
            .await
            .context("Failed to parse DeepSeek response")?;

        let content = data["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string();

        Ok(content)
    }

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

        let citations = extract_citations(&response, transcript);

        Ok(AnalysisResult {
            query: query.to_string(),
            response,
            citations,
            model: model.to_string(),
            processing_time_ms: start_time.elapsed().as_millis() as u64,
        })
    }

    pub async fn summarize(&self, transcript: &str, model: &str) -> Result<String> {
        let system_prompt = "You are Nautilus, a precise and forensic meeting intelligence assistant. \
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

impl Default for DeepSeekClient {
    fn default() -> Self {
        Self::new()
    }
}

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
