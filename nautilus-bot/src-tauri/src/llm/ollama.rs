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

        tracing::info!("Ollama returned {} models", models.len());
        Ok(models)
    }

    /// Validate that a specific model is available
    pub async fn validate_model(&self, model: &str) -> Result<bool> {
        let models = self.list_models().await?;
        Ok(models.iter().any(|m| m == model))
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

    /// Summarize meeting with optional template
    pub async fn summarize(&self, transcript: &str, model: &str) -> Result<String> {
        self.summarize_with_template(transcript, model, None).await
    }

    /// Summarize meeting with a specific template style
    pub async fn summarize_with_template(&self, transcript: &str, model: &str, template: Option<&str>) -> Result<String> {
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

    /// Generate a short descriptive title for a meeting
    pub async fn generate_title(&self, transcript: &str, model: &str) -> Result<String> {
        let snippet = &transcript[..transcript.len().min(1500)];
        let prompt = format!(
            "Generate a short, descriptive title (4-8 words) for this meeting or conversation. \
            Return ONLY the title text, no quotes, no punctuation at the end, no explanation:\n\n{snippet}\n\nTitle:"
        );
        let raw = self.generate(model, &prompt).await?;
        let title = raw.trim().trim_matches('"').trim_matches('\'').trim_matches('.').trim().to_string();
        if title.is_empty() || title.len() > 120 {
            return Err(anyhow::anyhow!("Generated title was empty or too long"));
        }
        Ok(title)
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

    /// Identify speaker names from transcript using LLM
    /// Returns a map of speaker identifiers to their likely names
    pub async fn identify_speakers(
        &self,
        transcript: &str,
        model: &str,
    ) -> Result<std::collections::HashMap<String, String>> {
        let prompt = format!(
            "You are an expert at identifying speaker names from meeting transcripts. \
Analyze the transcript and identify ALL unique speakers and their names.\n\n\
Rules:\n\
1. Look for self-introductions: 'This is [Name]', 'I am [Name]', 'My name is [Name]', '[Name] speaking'\n\
2. Look for introductions of others: 'Here is [Name]', 'Next is [Name]', 'Now [Name] will speak'\n\
3. Each DIFFERENT speaker gets a different number (speaker_1, speaker_2, etc.)\n\
4. Only extract ACTUAL PERSON NAMES - ignore common words, test, audio, meeting, etc.\n\
5. Names should be properly capitalized (e.g., 'Jonathan', 'Arioc', 'The Prime Time')\n\
6. If a name is mentioned but not clearly a speaker introduction, don't assign it\n\n\
Output format - list each speaker you identified:\n\
speaker_1: [Name of first speaker]\n\
speaker_2: [Name of second speaker]\n\n\
If you can only identify one speaker, just output speaker_1.\n\
If you cannot identify any speakers with confidence, output nothing.\n\n\
Transcript:\n{transcript}\n\n\
Speakers identified:"
        );

        let response = self.generate(model, &prompt).await?;
        
        let mut speakers = std::collections::HashMap::new();
        for line in response.lines() {
            let line = line.trim();
            if let Some((speaker_id, name)) = line.split_once(':') {
                let speaker_id = speaker_id.trim().to_string();
                let name = name.trim().to_string();
                // Filter out obvious non-names
                if !name.is_empty() 
                    && name.to_lowercase() != "none"
                    && name.to_lowercase() != "unknown"
                    && name.to_lowercase() != "speaker"
                    && name.len() > 1
                    && name.chars().next().map(|c| c.is_alphabetic()).unwrap_or(false) {
                    speakers.insert(speaker_id, name);
                }
            }
        }
        
        Ok(speakers)
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
