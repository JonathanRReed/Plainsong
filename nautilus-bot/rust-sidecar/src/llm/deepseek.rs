//! DeepSeek client using its existing OpenAI-compatible raw HTTP endpoint.

use crate::llm::transport::{
    classify_http_error, CompletionRequest, CompletionResponse, CompletionTransport, ErrorKind,
    LlmError, Provider, RequestOptions,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::time::Duration;

const DEEPSEEK_API_URL: &str = "https://api.deepseek.com/v1";

#[derive(Clone)]
pub struct DeepSeekClient {
    api_key: Option<String>,
    client: reqwest::Client,
}

impl DeepSeekClient {
    pub fn new() -> Self {
        Self::with_api_key(None)
    }

    pub fn with_api_key(api_key: Option<String>) -> Self {
        Self {
            api_key: api_key.or_else(|| std::env::var("DEEPSEEK_API_KEY").ok()),
            client: reqwest::Client::new(),
        }
    }

    pub async fn list_models(&self) -> Result<Vec<String>> {
        let Some(ref key) = self.api_key else {
            return Ok(vec![]);
        };
        let response = self
            .client
            .get(format!("{}/models", DEEPSEEK_API_URL))
            .header("Authorization", format!("Bearer {}", key))
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .context("Failed to fetch DeepSeek models")?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("DeepSeek model list error {}: {}", status, body);
        }
        let data: serde_json::Value = response
            .json()
            .await
            .context("Failed to parse DeepSeek response")?;
        let models = data["data"]
            .as_array()
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| model["id"].as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        tracing::info!("DeepSeek returned {} models", models.len());
        Ok(models)
    }

    pub async fn generate(
        &self,
        model: &str,
        prompt: &str,
        system_prompt: Option<&str>,
    ) -> Result<String> {
        let request = CompletionRequest {
            model: model.to_string(),
            system_prompt: system_prompt.map(str::to_string),
            prompt: prompt.to_string(),
            purpose: crate::llm::CompletionPurpose::Generic,
            options: RequestOptions {
                timeout: Duration::from_secs(120),
                max_output_tokens: 1_024,
                temperature: Some(0.7),
                json_schema: None,
                requested_context_tokens: None,
            },
        };
        Ok(self.complete(&request).await?.text)
    }
}

#[async_trait]
impl CompletionTransport for DeepSeekClient {
    fn provider(&self) -> Provider {
        Provider::DeepSeek
    }

    async fn complete(&self, request: &CompletionRequest) -> Result<CompletionResponse, LlmError> {
        let key = self.api_key.as_deref().ok_or_else(|| {
            LlmError::new(
                Provider::DeepSeek,
                ErrorKind::Configuration,
                "DeepSeek API key not configured",
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
            "max_tokens": request.options.max_output_tokens,
        });
        if let Some(temperature) = request.options.temperature {
            body["temperature"] = serde_json::json!(temperature);
        }
        if request.options.json_schema.is_some() {
            body["response_format"] = serde_json::json!({"type": "json_object"});
        }

        let response = self
            .client
            .post(format!("{}/chat/completions", DEEPSEEK_API_URL))
            .header("Authorization", format!("Bearer {}", key))
            .header("Content-Type", "application/json")
            .timeout(request.options.timeout)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                LlmError::from_reqwest(Provider::DeepSeek, "Failed to send request", error)
            })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(classify_http_error(Provider::DeepSeek, status, body));
        }
        let data: serde_json::Value = response.json().await.map_err(|error| {
            LlmError::from_reqwest(Provider::DeepSeek, "Failed to parse response", error)
        })?;
        let finish_reason = data["choices"][0]["finish_reason"].as_str();
        if matches!(finish_reason, Some("length")) {
            return Err(LlmError::new(
                Provider::DeepSeek,
                ErrorKind::OutputLimit,
                "DeepSeek stopped because the output token limit was reached",
            ));
        }
        if let Some(reason) = finish_reason.filter(|reason| *reason != "stop") {
            return Err(LlmError::new(
                Provider::DeepSeek,
                ErrorKind::Upstream,
                format!("DeepSeek stopped before completion: {}", reason),
            ));
        }
        let text = data["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if text.trim().is_empty() {
            return Err(LlmError::new(
                Provider::DeepSeek,
                ErrorKind::EmptyResponse,
                "DeepSeek returned an empty completion",
            ));
        }
        Ok(CompletionResponse {
            text,
            model: data["model"].as_str().unwrap_or(&request.model).to_string(),
        })
    }
}

impl Default for DeepSeekClient {
    fn default() -> Self {
        Self::new()
    }
}
