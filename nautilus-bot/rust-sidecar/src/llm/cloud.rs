//! Ollama Cloud client using its existing OpenAI-compatible raw HTTP endpoint.

use crate::llm::transport::{
    bounded_body_error_to_llm, classify_http_error, read_error_body, read_json_body,
    CompletionRequest, CompletionResponse, CompletionTransport, ErrorKind, LlmError, Provider,
    COMPLETION_BODY_LIMIT, MODEL_LIST_BODY_LIMIT,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::time::Duration;

const OLLAMA_CLOUD_URL: &str = "https://ollama.com/v1";

#[derive(Clone)]
pub struct OllamaCloudClient {
    base_url: String,
    api_key: Option<String>,
    client: reqwest::Client,
}

impl OllamaCloudClient {
    pub fn new() -> Self {
        Self::with_api_key(None)
    }

    pub fn with_api_key(api_key: Option<String>) -> Self {
        Self {
            base_url: OLLAMA_CLOUD_URL.to_string(),
            api_key: api_key.or_else(|| std::env::var("OLLAMA_CLOUD_API_KEY").ok()),
            client: reqwest::Client::new(),
        }
    }

    pub async fn list_models(&self) -> Result<Vec<String>> {
        let Some(ref key) = self.api_key else {
            tracing::info!("No Ollama Cloud API key configured");
            return Ok(vec![]);
        };
        let response = self
            .client
            .get(format!("{}/models", self.base_url))
            .header("Authorization", format!("Bearer {}", key))
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .context("Failed to connect to Ollama Cloud")?;
        if !response.status().is_success() {
            let status = response.status();
            let body = read_error_body(response).await;
            anyhow::bail!("Ollama Cloud returned status {}: {}", status, body);
        }
        let data: serde_json::Value = read_json_body(response, MODEL_LIST_BODY_LIMIT)
            .await
            .context("Failed to read or parse bounded Ollama Cloud response")?;
        let models = data["data"]
            .as_array()
            .or_else(|| data["models"].as_array())
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| {
                        model["id"]
                            .as_str()
                            .or_else(|| model["name"].as_str())
                            .map(str::to_string)
                    })
                    .collect::<Vec<_>>()
            })
            .context("No models found in Ollama Cloud response")?;
        tracing::info!("Ollama Cloud returned {} models", models.len());
        Ok(models)
    }
}

#[async_trait]
impl CompletionTransport for OllamaCloudClient {
    fn provider(&self) -> Provider {
        Provider::OllamaCloud
    }

    async fn complete(&self, request: &CompletionRequest) -> Result<CompletionResponse, LlmError> {
        let key = self.api_key.as_deref().ok_or_else(|| {
            LlmError::new(
                Provider::OllamaCloud,
                ErrorKind::Configuration,
                "Ollama Cloud API key not configured",
            )
        })?;
        let mut messages = Vec::new();
        if let Some(system) = request.system_prompt.as_deref() {
            messages.push(serde_json::json!({"role": "system", "content": system}));
        }
        messages.push(serde_json::json!({"role": "user", "content": request.prompt}));
        let mut body = serde_json::json!({
            "model": request.model,
            "messages": messages,
            "stream": false,
            "max_tokens": request.options.max_output_tokens,
        });
        if let Some(temperature) = request.options.temperature {
            body["temperature"] = serde_json::json!(temperature);
        }
        if let Some(schema) = request.options.json_schema.as_ref() {
            body["response_format"] = serde_json::json!({
                "type": "json_schema",
                "json_schema": {
                    "name": "nautilus_analysis_response",
                    "strict": true,
                    "schema": schema,
                }
            });
        }

        let response = self
            .client
            .post(format!("{}/chat/completions", self.base_url))
            .header("Authorization", format!("Bearer {}", key))
            .timeout(request.options.timeout)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                LlmError::from_reqwest(Provider::OllamaCloud, "Failed to send request", error)
            })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = read_error_body(response).await;
            return Err(classify_http_error(Provider::OllamaCloud, status, body));
        }
        let data: serde_json::Value = read_json_body(response, COMPLETION_BODY_LIMIT)
            .await
            .map_err(|error| {
                bounded_body_error_to_llm(Provider::OllamaCloud, "Failed to read response", error)
            })?;
        let finish_reason = data["choices"][0]["finish_reason"].as_str();
        if matches!(finish_reason, Some("length")) {
            return Err(LlmError::new(
                Provider::OllamaCloud,
                ErrorKind::OutputLimit,
                "Ollama Cloud stopped because the output token limit was reached",
            ));
        }
        if let Some(reason) = finish_reason.filter(|reason| *reason != "stop") {
            return Err(LlmError::new(
                Provider::OllamaCloud,
                ErrorKind::Upstream,
                format!("Ollama Cloud stopped before completion: {}", reason),
            ));
        }
        let text = data["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if text.trim().is_empty() {
            return Err(LlmError::new(
                Provider::OllamaCloud,
                ErrorKind::EmptyResponse,
                "Ollama Cloud returned an empty completion",
            ));
        }
        Ok(CompletionResponse {
            text,
            model: data["model"].as_str().unwrap_or(&request.model).to_string(),
        })
    }
}

impl Default for OllamaCloudClient {
    fn default() -> Self {
        Self::new()
    }
}
