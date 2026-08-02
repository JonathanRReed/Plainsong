//! OpenAI GPT client for transcript analysis.
//!
//! The adapter keeps the existing raw HTTP chat-completions integration while
//! implementing the provider-neutral completion transport used by analysis.

use crate::llm::transport::{
    bounded_body_error_to_llm, classify_http_error, read_error_body, read_json_body,
    CompletionRequest, CompletionResponse, CompletionTransport, ErrorKind, LlmError, Provider,
    RequestOptions, COMPLETION_BODY_LIMIT, MODEL_LIST_BODY_LIMIT,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::time::Duration;

const OPENAI_API_URL: &str = "https://api.openai.com/v1";

fn supports_openai_chat_completions(model_id: &str) -> bool {
    let normalized = model_id.trim().to_ascii_lowercase();
    let base = normalized
        .strip_prefix("ft:")
        .and_then(|fine_tuned| fine_tuned.split(':').next())
        .unwrap_or(&normalized);
    let supported_family = base.starts_with("gpt-3.5-turbo")
        || base.starts_with("gpt-4")
        || base.starts_with("gpt-5")
        || base.starts_with("chatgpt-")
        || ["o1", "o3", "o4"].iter().any(|family| {
            base == *family
                || base
                    .strip_prefix(family)
                    .is_some_and(|tail| tail.starts_with('-'))
        });
    let incompatible_variant = [
        "audio",
        "codex",
        "embedding",
        "image",
        "instruct",
        "moderation",
        "realtime",
        "transcribe",
        "tts",
    ]
    .iter()
    .any(|marker| base.split(['-', '_', '.']).any(|part| part == *marker));

    // OpenAI's model-list response does not publish endpoint capabilities. Keep an
    // explicit registry of chat families and fail closed on modality-only variants
    // instead of treating any ID that happens to contain "gpt" as text-capable.
    supported_family && !incompatible_variant
}

fn parse_completion_response(
    data: &serde_json::Value,
    requested_model: &str,
) -> Result<CompletionResponse, LlmError> {
    if let Some(refusal) = data["choices"][0]["message"]["refusal"]
        .as_str()
        .map(str::trim)
        .filter(|refusal| !refusal.is_empty())
    {
        return Err(LlmError::new(Provider::OpenAi, ErrorKind::Policy, refusal));
    }

    let finish_reason = data["choices"][0]["finish_reason"].as_str();
    if matches!(finish_reason, Some("length")) {
        return Err(LlmError::new(
            Provider::OpenAi,
            ErrorKind::OutputLimit,
            "OpenAI stopped because the output token limit was reached",
        ));
    }
    if let Some(reason) = finish_reason.filter(|reason| *reason != "stop") {
        return Err(LlmError::new(
            Provider::OpenAi,
            ErrorKind::Upstream,
            format!("OpenAI stopped before completion: {}", reason),
        ));
    }
    let text = data["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    if text.trim().is_empty() {
        return Err(LlmError::new(
            Provider::OpenAi,
            ErrorKind::EmptyResponse,
            "OpenAI returned an empty completion",
        ));
    }
    Ok(CompletionResponse {
        text,
        model: data["model"]
            .as_str()
            .unwrap_or(requested_model)
            .to_string(),
    })
}

#[derive(Clone)]
pub struct OpenAIClient {
    api_key: Option<String>,
    client: reqwest::Client,
}

impl OpenAIClient {
    pub fn new() -> Self {
        Self::with_api_key(None)
    }

    pub fn with_api_key(api_key: Option<String>) -> Self {
        let resolved_api_key = api_key.or_else(|| std::env::var("OPENAI_API_KEY").ok());
        Self {
            api_key: resolved_api_key,
            client: reqwest::Client::new(),
        }
    }

    pub async fn list_all_models(&self) -> Result<Vec<String>> {
        let Some(ref key) = self.api_key else {
            return Ok(vec![]);
        };
        let response = self
            .client
            .get(format!("{}/models", OPENAI_API_URL))
            .header("Authorization", format!("Bearer {}", key))
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .context("Failed to connect to OpenAI")?;
        if !response.status().is_success() {
            let status = response.status();
            let body = read_error_body(response).await;
            anyhow::bail!("OpenAI model list error {}: {}", status, body);
        }
        let data: serde_json::Value = read_json_body(response, MODEL_LIST_BODY_LIMIT)
            .await
            .context("Failed to read or parse bounded OpenAI response")?;
        Ok(data["data"]
            .as_array()
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| model["id"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default())
    }

    pub async fn list_models(&self) -> Result<Vec<String>> {
        let models = self
            .list_all_models()
            .await?
            .into_iter()
            .filter(|id| supports_openai_chat_completions(id))
            .collect::<Vec<_>>();
        tracing::info!("OpenAI returned {} models", models.len());
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
impl CompletionTransport for OpenAIClient {
    fn provider(&self) -> Provider {
        Provider::OpenAi
    }

    async fn complete(&self, request: &CompletionRequest) -> Result<CompletionResponse, LlmError> {
        let key = self.api_key.as_deref().ok_or_else(|| {
            LlmError::new(
                Provider::OpenAi,
                ErrorKind::Configuration,
                "OpenAI API key not configured",
            )
        })?;
        let mut messages = Vec::new();
        if let Some(system) = request.system_prompt.as_deref() {
            messages.push(serde_json::json!({"role": "system", "content": system}));
        }
        messages.push(serde_json::json!({"role": "user", "content": request.prompt}));

        let reasoning_model = {
            let model = request.model.to_ascii_lowercase();
            model.starts_with("o1") || model.starts_with("o3") || model.starts_with("o4")
        };
        let mut body = serde_json::json!({
            "model": request.model,
            "messages": messages,
        });
        if reasoning_model {
            body["max_completion_tokens"] = serde_json::json!(request.options.max_output_tokens);
        } else {
            body["max_tokens"] = serde_json::json!(request.options.max_output_tokens);
            if let Some(temperature) = request.options.temperature {
                body["temperature"] = serde_json::json!(temperature);
            }
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
            .post(format!("{}/chat/completions", OPENAI_API_URL))
            .header("Authorization", format!("Bearer {}", key))
            .header("Content-Type", "application/json")
            .timeout(request.options.timeout)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                LlmError::from_reqwest(Provider::OpenAi, "Failed to send request", error)
            })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = read_error_body(response).await;
            return Err(classify_http_error(Provider::OpenAi, status, body));
        }
        let data: serde_json::Value = read_json_body(response, COMPLETION_BODY_LIMIT)
            .await
            .map_err(|error| {
                bounded_body_error_to_llm(Provider::OpenAi, "Failed to read response", error)
            })?;
        parse_completion_response(&data, &request.model)
    }
}

impl Default for OpenAIClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_filter_excludes_non_completion_modalities() {
        for accepted in [
            "gpt-4o-mini",
            "gpt-5",
            "o3-mini",
            "chatgpt-4o-latest",
            "ft:gpt-4o-mini:plainsong:meeting:abc123",
        ] {
            assert!(supports_openai_chat_completions(accepted), "{accepted}");
        }
        for rejected in [
            "gpt-4o-mini-transcribe",
            "gpt-4o-realtime-preview",
            "gpt-4o-mini-tts",
            "gpt-image-1",
            "gpt-3.5-turbo-instruct",
            "text-embedding-3-large",
            "omni-moderation-latest",
            "gpt-5-codex",
        ] {
            assert!(!supports_openai_chat_completions(rejected), "{rejected}");
        }
    }

    #[test]
    fn structured_output_refusal_is_a_policy_error_with_provider_message() {
        let data = serde_json::json!({
            "model": "gpt-5-mini-2026-06-01",
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "content": null,
                    "refusal": "I cannot provide that analysis."
                }
            }]
        });

        let error = parse_completion_response(&data, "gpt-5-mini")
            .expect_err("refusal must not be reported as an empty completion");
        assert_eq!(error.kind, ErrorKind::Policy);
        assert_eq!(error.message, "I cannot provide that analysis.");
    }
}
