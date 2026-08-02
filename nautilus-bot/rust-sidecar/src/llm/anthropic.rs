//! Anthropic Claude client using the existing raw HTTP Messages API style.

use crate::llm::transport::{
    bounded_body_error_to_llm, classify_http_error, read_error_body, read_json_body,
    CompletionRequest, CompletionResponse, CompletionTransport, ErrorKind, LlmError, Provider,
    RequestOptions, COMPLETION_BODY_LIMIT, MODEL_LIST_BODY_LIMIT,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::time::Duration;

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1";

fn build_request_body(request: &CompletionRequest) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": request.model,
        "max_tokens": request.options.max_output_tokens,
        "messages": [{"role": "user", "content": request.prompt}],
    });
    if let Some(system) = request.system_prompt.as_deref() {
        body["system"] = serde_json::json!(system);
    }
    if let Some(schema) = request.options.json_schema.as_ref() {
        body["tools"] = serde_json::json!([{
            "name": "return_analysis_json",
            "description": "Return the analysis result in the required JSON shape.",
            "input_schema": schema,
        }]);
        body["tool_choice"] = serde_json::json!({
            "type": "tool",
            "name": "return_analysis_json",
        });
    }
    body
}

#[derive(Clone)]
pub struct AnthropicClient {
    api_key: Option<String>,
    client: reqwest::Client,
}

impl AnthropicClient {
    pub fn new() -> Self {
        Self::with_api_key(None)
    }

    pub fn with_api_key(api_key: Option<String>) -> Self {
        Self {
            api_key: api_key.or_else(|| std::env::var("ANTHROPIC_API_KEY").ok()),
            client: reqwest::Client::new(),
        }
    }

    pub async fn list_models(&self) -> Result<Vec<String>> {
        let Some(ref key) = self.api_key else {
            return Ok(vec![]);
        };
        let response = self
            .client
            .get(format!("{}/models", ANTHROPIC_API_URL))
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .context("Failed to fetch Anthropic models")?;
        if !response.status().is_success() {
            let status = response.status();
            let body = read_error_body(response).await;
            anyhow::bail!("Anthropic model list error {}: {}", status, body);
        }
        let data: serde_json::Value = read_json_body(response, MODEL_LIST_BODY_LIMIT)
            .await
            .context("Failed to read or parse bounded Anthropic response")?;
        let models = data["data"]
            .as_array()
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| model["id"].as_str().map(str::to_string))
                    .filter(|id| id.contains("claude"))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        tracing::info!("Anthropic returned {} models", models.len());
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
                temperature: None,
                json_schema: None,
                requested_context_tokens: None,
            },
        };
        Ok(self.complete(&request).await?.text)
    }
}

#[async_trait]
impl CompletionTransport for AnthropicClient {
    fn provider(&self) -> Provider {
        Provider::Anthropic
    }

    async fn complete(&self, request: &CompletionRequest) -> Result<CompletionResponse, LlmError> {
        let key = self.api_key.as_deref().ok_or_else(|| {
            LlmError::new(
                Provider::Anthropic,
                ErrorKind::Configuration,
                "Anthropic API key not configured",
            )
        })?;
        let body = build_request_body(request);

        let response = self
            .client
            .post(format!("{}/messages", ANTHROPIC_API_URL))
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .timeout(request.options.timeout)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                LlmError::from_reqwest(Provider::Anthropic, "Failed to send request", error)
            })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = read_error_body(response).await;
            return Err(classify_http_error(Provider::Anthropic, status, body));
        }
        let data: serde_json::Value = read_json_body(response, COMPLETION_BODY_LIMIT)
            .await
            .map_err(|error| {
                bounded_body_error_to_llm(Provider::Anthropic, "Failed to read response", error)
            })?;
        match data["stop_reason"].as_str() {
            Some("max_tokens") => {
                return Err(LlmError::new(
                    Provider::Anthropic,
                    ErrorKind::OutputLimit,
                    "Anthropic stopped because the output token limit was reached",
                ));
            }
            Some("model_context_window_exceeded") => {
                return Err(LlmError::new(
                    Provider::Anthropic,
                    ErrorKind::ContextLimit,
                    "Anthropic stopped because the model context window was exhausted",
                ));
            }
            Some("refusal") => {
                let details = data["stop_details"]["explanation"]
                    .as_str()
                    .or_else(|| data["stop_details"]["category"].as_str())
                    .unwrap_or("request refused by the provider");
                return Err(LlmError::new(
                    Provider::Anthropic,
                    ErrorKind::Policy,
                    format!("Anthropic refused the request: {}", details),
                ));
            }
            Some("end_turn" | "tool_use" | "stop_sequence") | None => {}
            Some(reason) => {
                return Err(LlmError::new(
                    Provider::Anthropic,
                    ErrorKind::Upstream,
                    format!("Anthropic stopped before completion: {}", reason),
                ));
            }
        }
        let text = data["content"]
            .as_array()
            .and_then(|blocks| {
                blocks
                    .iter()
                    .find_map(|block| match block["type"].as_str() {
                        Some("tool_use")
                            if block["name"].as_str() == Some("return_analysis_json") =>
                        {
                            serde_json::to_string(&block["input"]).ok()
                        }
                        Some("text") => block["text"].as_str().map(str::to_string),
                        _ => None,
                    })
            })
            .unwrap_or_default();
        if text.trim().is_empty() {
            return Err(LlmError::new(
                Provider::Anthropic,
                ErrorKind::EmptyResponse,
                "Anthropic returned an empty completion",
            ));
        }
        Ok(CompletionResponse {
            text,
            model: data["model"].as_str().unwrap_or(&request.model).to_string(),
        })
    }
}

impl Default for AnthropicClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::CompletionPurpose;

    #[test]
    fn current_claude_requests_omit_sampling_parameters_and_force_structured_output() {
        let request = CompletionRequest {
            model: "claude-opus-5".to_string(),
            system_prompt: Some("Use only transcript evidence.".to_string()),
            prompt: "Summarize the meeting.".to_string(),
            purpose: CompletionPurpose::Summary,
            options: RequestOptions {
                timeout: Duration::from_secs(30),
                max_output_tokens: 3_072,
                temperature: Some(0.1),
                json_schema: Some(serde_json::json!({
                    "type": "object",
                    "properties": {"response": {"type": "string"}},
                    "required": ["response"],
                    "additionalProperties": false
                })),
                requested_context_tokens: None,
            },
        };

        let body = build_request_body(&request);
        assert_eq!(body["model"], "claude-opus-5");
        assert_eq!(body["max_tokens"], 3_072);
        assert!(body.get("temperature").is_none());
        assert_eq!(body["tool_choice"]["name"], "return_analysis_json");
        assert_eq!(
            body["tools"][0]["input_schema"]["additionalProperties"],
            false
        );
    }
}
