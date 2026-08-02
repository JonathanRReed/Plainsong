//! Google Gemini client using the existing raw HTTP generateContent endpoint.

use crate::llm::transport::{
    bounded_body_error_to_llm, classify_http_error, read_error_body, read_json_body,
    CompletionRequest, CompletionResponse, CompletionTransport, ErrorKind, LlmError, Provider,
    RequestOptions, COMPLETION_BODY_LIMIT, MODEL_LIST_BODY_LIMIT,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::time::Duration;

const GEMINI_API_URL: &str = "https://generativelanguage.googleapis.com/v1beta";

fn supports_gemini_generate_content(model: &serde_json::Value) -> bool {
    let is_gemini = model["name"]
        .as_str()
        .is_some_and(|name| name.trim_start_matches("models/").starts_with("gemini-"));
    let supports_endpoint = model["supportedGenerationMethods"]
        .as_array()
        .is_some_and(|methods| {
            methods
                .iter()
                .any(|method| method.as_str() == Some("generateContent"))
        });
    is_gemini && supports_endpoint
}

fn parse_completion_response(
    data: &serde_json::Value,
    requested_model: &str,
) -> Result<CompletionResponse, LlmError> {
    if let Some(reason) = data["promptFeedback"]["blockReason"]
        .as_str()
        .map(str::trim)
        .filter(|reason| !reason.is_empty() && *reason != "BLOCK_REASON_UNSPECIFIED")
    {
        let detail = data["promptFeedback"]["blockReasonMessage"]
            .as_str()
            .map(str::trim)
            .filter(|message| !message.is_empty());
        let message = detail
            .map(|detail| format!("Gemini blocked the prompt ({}): {}", reason, detail))
            .unwrap_or_else(|| format!("Gemini blocked the prompt ({})", reason));
        return Err(LlmError::new(Provider::Gemini, ErrorKind::Policy, message));
    }

    let finish_reason = data["candidates"][0]["finishReason"].as_str();
    if matches!(finish_reason, Some("MAX_TOKENS")) {
        return Err(LlmError::new(
            Provider::Gemini,
            ErrorKind::OutputLimit,
            "Gemini stopped because the output token limit was reached",
        ));
    }
    if let Some(reason) = finish_reason.filter(|reason| *reason != "STOP") {
        let detail = data["candidates"][0]["finishMessage"]
            .as_str()
            .map(str::trim)
            .filter(|message| !message.is_empty());
        let message = detail
            .map(|detail| format!("Gemini stopped before completion ({}): {}", reason, detail))
            .unwrap_or_else(|| format!("Gemini stopped before completion: {}", reason));
        let kind = match reason {
            "SAFETY" | "RECITATION" | "LANGUAGE" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII"
            | "IMAGE_SAFETY" => ErrorKind::Policy,
            _ => ErrorKind::Upstream,
        };
        return Err(LlmError::new(Provider::Gemini, kind, message));
    }
    let text = data["candidates"][0]["content"]["parts"]
        .as_array()
        .and_then(|parts| parts.iter().find_map(|part| part["text"].as_str()))
        .unwrap_or_default()
        .to_string();
    if text.trim().is_empty() {
        return Err(LlmError::new(
            Provider::Gemini,
            ErrorKind::EmptyResponse,
            "Gemini returned an empty completion",
        ));
    }
    Ok(CompletionResponse {
        text,
        model: data["modelVersion"]
            .as_str()
            .unwrap_or(requested_model)
            .to_string(),
    })
}

#[derive(Clone)]
pub struct GeminiClient {
    api_key: Option<String>,
    client: reqwest::Client,
}

impl GeminiClient {
    pub fn new() -> Self {
        Self::with_api_key(None)
    }

    pub fn with_api_key(api_key: Option<String>) -> Self {
        Self {
            api_key: api_key.or_else(|| std::env::var("GEMINI_API_KEY").ok()),
            client: reqwest::Client::new(),
        }
    }

    pub async fn list_models(&self) -> Result<Vec<String>> {
        let Some(ref key) = self.api_key else {
            return Ok(vec![]);
        };
        let response = self
            .client
            .get(format!("{}/models", GEMINI_API_URL))
            .header("x-goog-api-key", key)
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .context("Failed to connect to Gemini API")?;
        if !response.status().is_success() {
            let status = response.status();
            let body = read_error_body(response).await;
            anyhow::bail!("Gemini model list error {}: {}", status, body);
        }
        let data: serde_json::Value = read_json_body(response, MODEL_LIST_BODY_LIMIT)
            .await
            .context("Failed to read or parse bounded Gemini response")?;
        Ok(data["models"]
            .as_array()
            .map(|models| {
                models
                    .iter()
                    .filter(|model| supports_gemini_generate_content(model))
                    .filter_map(|model| model["name"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default())
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
impl CompletionTransport for GeminiClient {
    fn provider(&self) -> Provider {
        Provider::Gemini
    }

    async fn complete(&self, request: &CompletionRequest) -> Result<CompletionResponse, LlmError> {
        let key = self.api_key.as_deref().ok_or_else(|| {
            LlmError::new(
                Provider::Gemini,
                ErrorKind::Configuration,
                "Gemini API key not configured",
            )
        })?;
        let model_name = if request.model.starts_with("models/") {
            request.model.clone()
        } else {
            format!("models/{}", request.model)
        };
        let mut generation_config = serde_json::json!({
            "maxOutputTokens": request.options.max_output_tokens,
        });
        if let Some(temperature) = request.options.temperature {
            generation_config["temperature"] = serde_json::json!(temperature);
        }
        if let Some(schema) = request.options.json_schema.as_ref() {
            generation_config["responseMimeType"] = serde_json::json!("application/json");
            generation_config["responseJsonSchema"] = schema.clone();
        }
        let mut body = serde_json::json!({
            "contents": [{"role": "user", "parts": [{"text": request.prompt}]}],
            "generationConfig": generation_config,
        });
        if let Some(system) = request.system_prompt.as_deref() {
            body["systemInstruction"] = serde_json::json!({
                "parts": [{"text": system}]
            });
        }

        let response = self
            .client
            .post(format!("{}/{}:generateContent", GEMINI_API_URL, model_name))
            .header("x-goog-api-key", key)
            .header("Content-Type", "application/json")
            .timeout(request.options.timeout)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                LlmError::from_reqwest(Provider::Gemini, "Failed to send request", error)
            })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = read_error_body(response).await;
            return Err(classify_http_error(Provider::Gemini, status, body));
        }
        let data: serde_json::Value = read_json_body(response, COMPLETION_BODY_LIMIT)
            .await
            .map_err(|error| {
                bounded_body_error_to_llm(Provider::Gemini, "Failed to read response", error)
            })?;
        parse_completion_response(&data, &request.model)
    }
}

impl Default for GeminiClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_filter_requires_generate_content_capability() {
        assert!(supports_gemini_generate_content(&serde_json::json!({
            "name": "models/gemini-2.5-flash",
            "supportedGenerationMethods": ["generateContent", "countTokens"]
        })));
        for rejected in [
            serde_json::json!({
                "name": "models/gemini-embedding-001",
                "supportedGenerationMethods": ["embedContent"]
            }),
            serde_json::json!({
                "name": "models/gemini-stream-only",
                "supportedGenerationMethods": ["streamGenerateContent"]
            }),
            serde_json::json!({"name": "models/gemini-missing-methods"}),
            serde_json::json!({
                "name": "models/text-bison",
                "supportedGenerationMethods": ["generateContent"]
            }),
        ] {
            assert!(!supports_gemini_generate_content(&rejected));
        }
    }

    #[test]
    fn prompt_block_is_reported_as_a_policy_error() {
        let data = serde_json::json!({
            "promptFeedback": {
                "blockReason": "SAFETY",
                "blockReasonMessage": "The request was blocked."
            }
        });

        let error = parse_completion_response(&data, "gemini-2.5-flash")
            .expect_err("prompt block must not be reported as an empty completion");
        assert_eq!(error.kind, ErrorKind::Policy);
        assert!(error.message.contains("The request was blocked."));
    }

    #[test]
    fn candidate_safety_stop_includes_the_provider_message() {
        let data = serde_json::json!({
            "candidates": [{
                "finishReason": "SAFETY",
                "finishMessage": "Response blocked by safety filters."
            }]
        });

        let error = parse_completion_response(&data, "gemini-2.5-flash")
            .expect_err("safety stop must be a policy error");
        assert_eq!(error.kind, ErrorKind::Policy);
        assert!(error
            .message
            .contains("Response blocked by safety filters."));
    }

    #[test]
    fn successful_response_records_the_provider_model_version() {
        let data = serde_json::json!({
            "modelVersion": "gemini-2.5-flash-20260617",
            "candidates": [{
                "finishReason": "STOP",
                "content": {"parts": [{"text": "Grounded result"}]}
            }]
        });

        let response =
            parse_completion_response(&data, "gemini-2.5-flash").expect("successful completion");
        assert_eq!(response.model, "gemini-2.5-flash-20260617");
    }
}
