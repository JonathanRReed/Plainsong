//! Ollama local LLM adapter using `/api/chat` and typed `/api/show` metadata.

use crate::llm::transport::{
    bounded_body_error_to_llm, classify_http_error, read_error_body, read_json_body,
    CompletionRequest, CompletionResponse, CompletionTransport, ErrorKind, LlmError,
    ModelContextMetadata, Provider, COMPLETION_BODY_LIMIT, MODEL_LIST_BODY_LIMIT,
    MODEL_METADATA_BODY_LIMIT,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

const OLLAMA_DEFAULT_URL: &str = "http://localhost:11434";
const OLLAMA_SHOW_TIMEOUT: Duration = Duration::from_secs(3);
const OLLAMA_METADATA_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy)]
struct CachedModelContext {
    metadata: ModelContextMetadata,
    observed_at: Instant,
}

#[derive(Clone)]
pub struct OllamaClient {
    base_url: String,
    client: reqwest::Client,
    metadata_cache: Arc<RwLock<HashMap<String, CachedModelContext>>>,
    show_timeout: Duration,
}

impl OllamaClient {
    pub fn new() -> Self {
        Self::with_base_url_and_timeout(OLLAMA_DEFAULT_URL, OLLAMA_SHOW_TIMEOUT)
    }

    fn with_base_url_and_timeout(base_url: impl Into<String>, show_timeout: Duration) -> Self {
        Self {
            base_url: base_url.into(),
            client: reqwest::Client::new(),
            metadata_cache: Arc::new(RwLock::new(HashMap::new())),
            show_timeout,
        }
    }

    pub async fn is_available(&self) -> bool {
        self.client
            .get(format!("{}/api/tags", self.base_url))
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
    }

    pub async fn list_models(&self) -> Result<Vec<String>> {
        let response = self
            .client
            .get(format!("{}/api/tags", self.base_url))
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .context("Failed to connect to Ollama")?;
        if !response.status().is_success() {
            let status = response.status();
            let body = read_error_body(response).await;
            anyhow::bail!("Ollama model list error {}: {}", status, body);
        }
        let data: serde_json::Value = read_json_body(response, MODEL_LIST_BODY_LIMIT)
            .await
            .context("Failed to read or parse bounded Ollama response")?;
        let models = data["models"]
            .as_array()
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| model["name"].as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        tracing::info!("Ollama returned {} models", models.len());
        Ok(models)
    }

    async fn cached_model_context(&self, model: &str) -> Option<ModelContextMetadata> {
        let cache = self.metadata_cache.read().await;
        cache.get(model).and_then(|entry| {
            (entry.observed_at.elapsed() <= OLLAMA_METADATA_TTL).then_some(entry.metadata)
        })
    }

    async fn probe_model_context(&self, model: &str) -> Result<ModelContextMetadata, LlmError> {
        let response = self
            .client
            .post(format!("{}/api/show", self.base_url))
            .timeout(self.show_timeout)
            .json(&ShowRequest {
                model,
                verbose: true,
            })
            .send()
            .await
            .map_err(|error| {
                LlmError::from_reqwest(Provider::Ollama, "Failed to probe model metadata", error)
            })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = read_error_body(response).await;
            return Err(classify_http_error(Provider::Ollama, status, body));
        }
        let response: ShowResponse = read_json_body(response, MODEL_METADATA_BODY_LIMIT)
            .await
            .map_err(|error| {
                bounded_body_error_to_llm(Provider::Ollama, "Failed to read model metadata", error)
            })?;
        Ok(response.context_metadata())
    }

    pub async fn invalidate_model_metadata(&self, model: &str) {
        self.metadata_cache.write().await.remove(model);
    }
}

#[async_trait]
impl CompletionTransport for OllamaClient {
    fn provider(&self) -> Provider {
        Provider::Ollama
    }

    async fn complete(&self, request: &CompletionRequest) -> Result<CompletionResponse, LlmError> {
        let num_ctx = request
            .options
            .requested_context_tokens
            .and_then(|tokens| i32::try_from(tokens).ok())
            .filter(|tokens| *tokens > 0);
        let mut messages = Vec::with_capacity(2);
        if let Some(system) = request.system_prompt.as_deref() {
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: system.to_string(),
            });
        }
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: request.prompt.clone(),
        });
        let body = ChatRequest {
            model: request.model.clone(),
            messages,
            stream: false,
            format: request.options.json_schema.clone(),
            options: Some(GenerationOptions {
                temperature: request.options.temperature.unwrap_or(0.1),
                num_predict: request.options.max_output_tokens.min(i32::MAX as usize) as i32,
                num_ctx,
            }),
        };
        let response = self
            .client
            .post(format!("{}/api/chat", self.base_url))
            .timeout(request.options.timeout)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                LlmError::from_reqwest(Provider::Ollama, "Failed to send request", error)
            })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = read_error_body(response).await;
            return Err(classify_http_error(Provider::Ollama, status, body));
        }
        let data: ChatResponse = read_json_body(response, COMPLETION_BODY_LIMIT)
            .await
            .map_err(|error| {
                bounded_body_error_to_llm(Provider::Ollama, "Failed to read response", error)
            })?;
        if matches!(data.done_reason.as_deref(), Some("length")) {
            return Err(LlmError::new(
                Provider::Ollama,
                ErrorKind::OutputLimit,
                "Ollama stopped because the output token limit was reached",
            ));
        }
        if let Some(reason) = data
            .done_reason
            .as_deref()
            .filter(|reason| !matches!(*reason, "stop" | "load"))
        {
            return Err(LlmError::new(
                Provider::Ollama,
                ErrorKind::Upstream,
                format!("Ollama stopped before completion: {}", reason),
            ));
        }
        if data.message.content.trim().is_empty() {
            return Err(LlmError::new(
                Provider::Ollama,
                ErrorKind::EmptyResponse,
                "Ollama returned an empty completion",
            ));
        }
        Ok(CompletionResponse {
            text: data.message.content,
            model: request.model.clone(),
        })
    }

    async fn model_context_metadata(&self, model: &str) -> Result<ModelContextMetadata, LlmError> {
        if let Some(metadata) = self.cached_model_context(model).await {
            return Ok(metadata);
        }
        let metadata = self.probe_model_context(model).await?;
        self.metadata_cache.write().await.insert(
            model.to_string(),
            CachedModelContext {
                metadata,
                observed_at: Instant::now(),
            },
        );
        Ok(metadata)
    }

    async fn invalidate_model_context_metadata(&self, model: &str) {
        self.invalidate_model_metadata(model).await;
    }
}

impl Default for OllamaClient {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Serialize)]
struct ShowRequest<'a> {
    model: &'a str,
    verbose: bool,
}

#[derive(Debug, Default, Deserialize)]
struct ShowResponse {
    #[serde(default)]
    parameters: Option<String>,
    #[serde(default)]
    details: ShowDetails,
    #[serde(default)]
    model_info: Option<HashMap<String, Value>>,
}

#[derive(Debug, Default, Deserialize)]
struct ShowDetails {
    #[serde(default)]
    family: Option<String>,
    #[serde(default)]
    families: Option<Vec<String>>,
}

impl ShowResponse {
    fn context_metadata(&self) -> ModelContextMetadata {
        ModelContextMetadata {
            capacity_tokens: self
                .model_info
                .as_ref()
                .and_then(|model_info| extract_context_capacity(model_info, &self.details)),
            default_tokens: self
                .parameters
                .as_deref()
                .and_then(extract_configured_num_ctx),
        }
    }
}

fn extract_context_capacity(
    model_info: &HashMap<String, Value>,
    details: &ShowDetails,
) -> Option<usize> {
    let mut prefixes = Vec::new();
    if let Some(architecture) = model_info
        .get("general.architecture")
        .and_then(Value::as_str)
    {
        prefixes.push(architecture);
    }
    if let Some(family) = details.family.as_deref() {
        prefixes.push(family);
    }
    prefixes.extend(details.families.iter().flatten().map(String::as_str));

    for prefix in prefixes {
        if let Some(tokens) = model_info
            .get(&format!("{}.context_length", prefix))
            .and_then(positive_usize)
        {
            return Some(tokens);
        }
    }
    if let Some(tokens) = model_info
        .get("general.context_length")
        .and_then(positive_usize)
    {
        return Some(tokens);
    }

    let candidates = model_info
        .iter()
        .filter(|(key, _)| key.ends_with(".context_length"))
        .filter_map(|(_, value)| positive_usize(value))
        .collect::<BTreeSet<_>>();
    (candidates.len() == 1)
        .then(|| candidates.into_iter().next())
        .flatten()
}

fn positive_usize(value: &Value) -> Option<usize> {
    if let Some(value) = value.as_u64() {
        return usize::try_from(value).ok().filter(|value| *value > 0);
    }
    if let Some(value) = value.as_i64() {
        return usize::try_from(value).ok().filter(|value| *value > 0);
    }
    value
        .as_str()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
}

fn extract_configured_num_ctx(parameters: &str) -> Option<usize> {
    parameters.lines().rev().find_map(|line| {
        let mut parts = line.split_whitespace();
        (parts.next()? == "num_ctx")
            .then(|| parts.next()?.parse::<i64>().ok())
            .flatten()
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| *value > 0)
    })
}

#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<serde_json::Value>,
    options: Option<GenerationOptions>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct GenerationOptions {
    temperature: f32,
    num_predict: i32,
    #[serde(skip_serializing_if = "invalid_num_ctx")]
    num_ctx: Option<i32>,
}

fn invalid_num_ctx(value: &Option<i32>) -> bool {
    !matches!(value, Some(value) if *value > 0)
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    message: ChatMessage,
    #[serde(default)]
    done_reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::RequestOptions;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn show_response_extracts_architecture_context_and_configured_default() {
        let response: ShowResponse = serde_json::from_value(serde_json::json!({
            "parameters": "temperature 0.7\nnum_ctx 32768\nstop END",
            "details": {"family": "llama"},
            "model_info": {
                "general.architecture": "llama",
                "llama.context_length": 131072
            }
        }))
        .unwrap();
        assert_eq!(
            response.context_metadata(),
            ModelContextMetadata {
                capacity_tokens: Some(131_072),
                default_tokens: Some(32_768),
            }
        );
    }

    #[test]
    fn show_response_supports_family_and_unique_suffix_variants() {
        let family: ShowResponse = serde_json::from_value(serde_json::json!({
            "details": {"family": "gemma3"},
            "model_info": {"gemma3.context_length": "131072"}
        }))
        .unwrap();
        assert_eq!(family.context_metadata().capacity_tokens, Some(131_072));

        let suffix: ShowResponse = serde_json::from_value(serde_json::json!({
            "model_info": {"qwen2.context_length": 32768}
        }))
        .unwrap();
        assert_eq!(suffix.context_metadata().capacity_tokens, Some(32_768));
    }

    #[test]
    fn unknown_or_ambiguous_show_metadata_stays_unknown() {
        let unknown: ShowResponse = serde_json::from_value(serde_json::json!({
            "parameters": "num_ctx 0\nnum_ctx -1\nnum_ctx nope",
            "model_info": {
                "text.context_length": 8192,
                "vision.context_length": 4096
            }
        }))
        .unwrap();
        assert_eq!(unknown.context_metadata(), ModelContextMetadata::default());

        let null_fields: ShowResponse = serde_json::from_value(serde_json::json!({
            "parameters": null,
            "details": {"families": null},
            "model_info": null
        }))
        .unwrap();
        assert_eq!(
            null_fields.context_metadata(),
            ModelContextMetadata::default()
        );

        let configured_only: ShowResponse = serde_json::from_value(serde_json::json!({
            "parameters": "num_ctx 4096",
            "model_info": null
        }))
        .unwrap();
        assert_eq!(
            configured_only.context_metadata(),
            ModelContextMetadata {
                capacity_tokens: None,
                default_tokens: Some(4096),
            }
        );
    }

    #[test]
    fn generation_options_never_serialize_non_positive_num_ctx() {
        for num_ctx in [None, Some(0), Some(-1)] {
            let value = serde_json::to_value(GenerationOptions {
                temperature: 0.1,
                num_predict: 10,
                num_ctx,
            })
            .unwrap();
            assert!(value.get("num_ctx").is_none());
        }
        let value = serde_json::to_value(GenerationOptions {
            temperature: 0.1,
            num_predict: 10,
            num_ctx: Some(8192),
        })
        .unwrap();
        assert_eq!(value["num_ctx"], 8192);
    }

    async fn spawn_show_server(
        responses: Vec<(u16, &'static str, Duration)>,
        request_count: Arc<AtomicUsize>,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for (status, body, delay) in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                request_count.fetch_add(1, Ordering::SeqCst);
                let mut buffer = vec![0_u8; 4096];
                let _ = socket.read(&mut buffer).await;
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                let reason = if status == 200 { "OK" } else { "ERROR" };
                let response = format!(
                    "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status,
                    reason,
                    body.len(),
                    body
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        format!("http://{}", address)
    }

    #[tokio::test]
    async fn show_non_success_status_preserves_body_as_error() {
        let requests = Arc::new(AtomicUsize::new(0));
        let base_url = spawn_show_server(
            vec![(404, r#"{"error":"model not found"}"#, Duration::ZERO)],
            Arc::clone(&requests),
        )
        .await;
        let client = OllamaClient::with_base_url_and_timeout(base_url, Duration::from_secs(1));
        let error = client.model_context_metadata("missing").await.unwrap_err();
        assert_eq!(error.status, Some(404));
        assert!(error.message.contains("model not found"));
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn successful_unknown_metadata_is_cached_and_invalidation_reprobes() {
        let requests = Arc::new(AtomicUsize::new(0));
        let base_url = spawn_show_server(
            vec![
                (200, r#"{"details":{},"model_info":{}}"#, Duration::ZERO),
                (
                    200,
                    r#"{"parameters":"num_ctx 4096","model_info":{"general.architecture":"llama","llama.context_length":8192}}"#,
                    Duration::ZERO,
                ),
            ],
            Arc::clone(&requests),
        )
        .await;
        let client = OllamaClient::with_base_url_and_timeout(base_url, Duration::from_secs(1));
        assert_eq!(
            client.model_context_metadata("model").await.unwrap(),
            ModelContextMetadata::default()
        );
        assert_eq!(
            client.model_context_metadata("model").await.unwrap(),
            ModelContextMetadata::default()
        );
        assert_eq!(requests.load(Ordering::SeqCst), 1);

        client.invalidate_model_metadata("model").await;
        assert_eq!(
            client.model_context_metadata("model").await.unwrap(),
            ModelContextMetadata {
                capacity_tokens: Some(8192),
                default_tokens: Some(4096),
            }
        );
        assert_eq!(requests.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn output_limit_termination_is_rejected_even_with_valid_json_text() {
        let requests = Arc::new(AtomicUsize::new(0));
        let base_url = spawn_show_server(
            vec![(
                200,
                r#"{"message":{"role":"assistant","content":"{\"response\":\"partial\",\"lineIds\":[\"L1\"]}"},"done_reason":"length"}"#,
                Duration::ZERO,
            )],
            requests,
        )
        .await;
        let client = OllamaClient::with_base_url_and_timeout(base_url, Duration::from_secs(1));
        let error = client
            .complete(&CompletionRequest {
                model: "test".to_string(),
                system_prompt: None,
                prompt: "test".to_string(),
                purpose: crate::llm::CompletionPurpose::Summary,
                options: RequestOptions {
                    timeout: Duration::from_secs(1),
                    max_output_tokens: 16,
                    temperature: Some(0.1),
                    json_schema: None,
                    requested_context_tokens: Some(4096),
                    dictation_style: None,
                },
            })
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::OutputLimit);
    }

    #[tokio::test]
    async fn structured_chat_completion_uses_assistant_message_content() {
        let requests = Arc::new(AtomicUsize::new(0));
        let base_url = spawn_show_server(
            vec![(
                200,
                r#"{"message":{"role":"assistant","content":"{\"response\":\"ok\",\"lineIds\":[\"L1\"]}","thinking":"internal trace"},"done_reason":"stop"}"#,
                Duration::ZERO,
            )],
            requests,
        )
        .await;
        let client = OllamaClient::with_base_url_and_timeout(base_url, Duration::from_secs(1));
        let response = client
            .complete(&CompletionRequest {
                model: "gpt-oss:20b".to_string(),
                system_prompt: Some("Return JSON.".to_string()),
                prompt: "Summarize L1.".to_string(),
                purpose: crate::llm::CompletionPurpose::Summary,
                options: RequestOptions {
                    timeout: Duration::from_secs(1),
                    max_output_tokens: 128,
                    temperature: Some(0.1),
                    json_schema: Some(serde_json::json!({
                        "type": "object",
                        "properties": {
                            "response": {"type": "string"},
                            "lineIds": {"type": "array", "items": {"type": "string"}}
                        },
                        "required": ["response", "lineIds"]
                    })),
                    requested_context_tokens: Some(4096),
                    dictation_style: None,
                },
            })
            .await
            .unwrap();
        assert_eq!(response.text, r#"{"response":"ok","lineIds":["L1"]}"#);
    }

    #[tokio::test]
    async fn show_probe_uses_its_own_short_timeout() {
        let requests = Arc::new(AtomicUsize::new(0));
        let base_url = spawn_show_server(
            vec![(
                200,
                r#"{"model_info":{"llama.context_length":8192}}"#,
                Duration::from_millis(100),
            )],
            requests,
        )
        .await;
        let client = OllamaClient::with_base_url_and_timeout(base_url, Duration::from_millis(10));
        let error = client.model_context_metadata("slow").await.unwrap_err();
        assert_eq!(error.kind, ErrorKind::Timeout);
    }
}
