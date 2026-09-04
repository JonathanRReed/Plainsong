//! Ollama local LLM adapter using `/api/chat` and typed `/api/show` metadata.

use crate::llm::transport::{
    bounded_body_error_to_llm, classify_http_error, read_error_body, read_json_body,
    CompletionRequest, CompletionResponse, CompletionTransport, ErrorKind, LlmError,
    ModelContextMetadata, Provider, COMPLETION_BODY_LIMIT, MODEL_LIST_BODY_LIMIT,
    MODEL_METADATA_BODY_LIMIT,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

#[cfg(test)]
mod catalog_contract_tests {
    use super::*;

    #[test]
    fn curated_catalog_has_the_exact_supported_ids() {
        let ids = curated_model_catalog()
            .iter()
            .map(|model| model.id)
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec![
                "gpt-oss:20b",
                "deepseek-r1:8b",
                "ministral-3:8b",
                "llama3:8b",
                "mistral:v0.2",
                "llama3.2:3b",
                "phi:2.7b",
            ]
        );
    }

    #[test]
    fn only_curated_ids_can_be_pulled_and_meta_requires_disclosure() {
        assert!(validate_pull_request("gpt-oss:20b", false).is_ok());
        assert!(validate_pull_request("arbitrary:latest", true).is_err());
        assert!(validate_pull_request("llama3:8b", false).is_err());
        assert!(validate_pull_request("llama3:8b", true).is_ok());
    }

    #[test]
    fn a_different_installed_digest_is_not_ready() {
        let model = curated_model_catalog().into_iter().next().unwrap();
        assert!(!digest_is_ready(&model, Some("sha256:different")));
        assert!(digest_is_ready(
            &model,
            Some(model.expected_manifest_digest.unwrap())
        ));
    }

    #[test]
    fn pull_stream_parser_accepts_a_final_unterminated_record() {
        let mut parser = PullStreamParser::default();
        assert!(
            parser
                .push(b"{\"status\":\"pulling\"}\n{\"status\":\"success\"}")
                .unwrap()
                .len()
                == 1
        );
        let final_records = parser.finish().unwrap();
        assert_eq!(final_records[0]["status"], "success");
    }

    #[test]
    fn pull_stream_parser_rejects_an_oversized_unterminated_record() {
        let mut parser = PullStreamParser::default();
        let oversized = vec![b'x'; OLLAMA_PULL_RECORD_LIMIT + 1];
        assert!(parser
            .push(&oversized)
            .unwrap_err()
            .to_string()
            .contains("too large"));
    }

    #[test]
    fn pull_stream_parser_rejects_invalid_final_json() {
        let mut parser = PullStreamParser::default();
        parser.push(b"{not-json").unwrap();
        assert!(parser
            .finish()
            .unwrap_err()
            .to_string()
            .contains("invalid pull progress"));
    }
}

const OLLAMA_DEFAULT_URL: &str = "http://localhost:11434";
const OLLAMA_SHOW_TIMEOUT: Duration = Duration::from_secs(3);
const OLLAMA_METADATA_TTL: Duration = Duration::from_secs(10 * 60);
const OLLAMA_PULL_RECORD_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct CuratedOllamaModel {
    pub id: &'static str,
    pub display_name: &'static str,
    pub provider: &'static str,
    pub disk_size_bytes: u64,
    pub context_tokens: u64,
    pub minimum_memory_bytes: Option<u64>,
    pub recommended_memory_bytes: Option<u64>,
    pub license: &'static str,
    pub disclosure: Option<&'static str>,
    pub lanes: &'static [&'static str],
    pub expected_manifest_digest: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaCatalogEntry {
    pub id: String,
    pub display_name: String,
    pub provider: String,
    pub disk_size_bytes: u64,
    pub context_tokens: u64,
    pub minimum_memory_bytes: Option<u64>,
    pub recommended_memory_bytes: Option<u64>,
    pub license: String,
    pub disclosure: Option<String>,
    pub lanes: Vec<String>,
    pub expected_manifest_digest: Option<String>,
    pub installed: bool,
    pub installed_digest: Option<String>,
    pub installed_size_bytes: Option<u64>,
    pub ready: bool,
}

#[derive(Debug, Default, Deserialize)]
struct TagsResponse {
    #[serde(default)]
    models: Vec<TagModel>,
}

#[derive(Debug, Deserialize)]
struct TagModel {
    name: String,
    #[serde(default)]
    digest: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

const GIB: u64 = 1_073_741_824;

pub fn curated_model_catalog() -> Vec<CuratedOllamaModel> {
    vec![
        CuratedOllamaModel { id: "gpt-oss:20b", display_name: "GPT-OSS 20B", provider: "OpenAI via Ollama", disk_size_bytes: 13_793_440_755, context_tokens: 131_072, minimum_memory_bytes: Some(16 * GIB), recommended_memory_bytes: Some(24 * GIB), license: "Apache-2.0", disclosure: None, lanes: &["meetings"], expected_manifest_digest: Some("sha256:17052f91a42e97930aa6e28a6c6c06a983e6a58dbb00434885a0cf5313e376f7") },
        CuratedOllamaModel { id: "deepseek-r1:8b", display_name: "DeepSeek R1 Distill 8B", provider: "DeepSeek via Ollama", disk_size_bytes: 5_225_375_560, context_tokens: 131_072, minimum_memory_bytes: Some(8 * GIB), recommended_memory_bytes: Some(16 * GIB), license: "MIT", disclosure: Some("This tag currently resolves to DeepSeek-R1-0528-Qwen3-8B, a Qwen3-based distill."), lanes: &["meetings"], expected_manifest_digest: Some("sha256:6995872bfe4c521a67b32da386cd21d5c6e819b6e0d62f79f64ec83be99f5763") },
        CuratedOllamaModel { id: "ministral-3:8b", display_name: "Ministral 3 8B", provider: "Mistral AI via Ollama", disk_size_bytes: 6_022_236_102, context_tokens: 262_144, minimum_memory_bytes: Some(8 * GIB), recommended_memory_bytes: Some(16 * GIB), license: "Apache-2.0", disclosure: None, lanes: &["dictation", "meetings"], expected_manifest_digest: Some("sha256:1922accd5827ebe6829e536369195db25eaf664528dc66206d646ea3bb386b71") },
        CuratedOllamaModel { id: "llama3:8b", display_name: "Llama 3 8B", provider: "Meta via Ollama", disk_size_bytes: 4_661_224_191, context_tokens: 8_192, minimum_memory_bytes: Some(8 * GIB), recommended_memory_bytes: Some(16 * GIB), license: "Meta Llama 3 Community License", disclosure: Some("Installing means you accept the Meta Llama 3 Community License and Acceptable Use Policy."), lanes: &["dictation", "meetings"], expected_manifest_digest: Some("sha256:365c0bd3c000a25d28ddbf732fe1c6add414de7275464c4e4d1c3b5fcb5d8ad1") },
        CuratedOllamaModel { id: "mistral:v0.2", display_name: "Mistral 7B v0.2", provider: "Mistral AI via Ollama", disk_size_bytes: 4_109_864_676, context_tokens: 32_768, minimum_memory_bytes: Some(8 * GIB), recommended_memory_bytes: Some(16 * GIB), license: "Apache-2.0", disclosure: None, lanes: &["dictation", "meetings"], expected_manifest_digest: Some("sha256:61e88e884507ba5e06c49b40e6226884b2a16e872382c2b44a42f2d119d804a5") },
        CuratedOllamaModel { id: "llama3.2:3b", display_name: "Llama 3.2 3B", provider: "Meta via Ollama", disk_size_bytes: 2_019_392_628, context_tokens: 131_072, minimum_memory_bytes: Some(4 * GIB), recommended_memory_bytes: Some(8 * GIB), license: "Llama 3.2 Community License", disclosure: Some("Installing means you accept the Llama 3.2 Community License and Acceptable Use Policy."), lanes: &["dictation", "meetings"], expected_manifest_digest: Some("sha256:a80c4f17acd55265feec403c7aef86be0c25983ab279d83f3bcd3abbcb5b8b72") },
        CuratedOllamaModel { id: "phi:2.7b", display_name: "Phi-2 3B", provider: "Microsoft via Ollama", disk_size_bytes: 1_602_462_823, context_tokens: 2_048, minimum_memory_bytes: Some(4 * GIB), recommended_memory_bytes: Some(8 * GIB), license: "MIT", disclosure: None, lanes: &["dictation"], expected_manifest_digest: Some("sha256:e2fd6321a5fe6bb3ac8a4e6f1cf04477fd2dea2924cf53237a995387e152ee9c") },
    ]
}

pub fn validate_pull_request(model_id: &str, accepted_license: bool) -> Result<CuratedOllamaModel> {
    let model = curated_model_catalog()
        .into_iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| {
            anyhow::anyhow!("Only models in Plainsong's curated Ollama catalog can be installed")
        })?;
    if model.provider.starts_with("Meta ") && !accepted_license {
        anyhow::bail!(
            "Accept the Meta model license before installing {}",
            model.display_name
        );
    }
    Ok(model)
}

fn digest_is_ready(model: &CuratedOllamaModel, installed_digest: Option<&str>) -> bool {
    match model.expected_manifest_digest {
        Some(expected) => installed_digest == Some(expected),
        None => installed_digest.is_some(),
    }
}

#[derive(Default)]
struct PullStreamParser {
    pending: Vec<u8>,
}

impl PullStreamParser {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>> {
        self.pending.extend_from_slice(chunk);
        let mut records = Vec::new();
        while let Some(newline) = self.pending.iter().position(|byte| *byte == b'\n') {
            if newline > OLLAMA_PULL_RECORD_LIMIT {
                anyhow::bail!("Ollama pull progress record is too large");
            }
            let mut record = self.pending.drain(..=newline).collect::<Vec<_>>();
            record.pop();
            if let Some(value) = parse_pull_record(&record)? {
                records.push(value);
            }
        }
        if self.pending.len() > OLLAMA_PULL_RECORD_LIMIT {
            anyhow::bail!("Ollama pull progress record is too large");
        }
        Ok(records)
    }

    fn finish(self) -> Result<Vec<Value>> {
        parse_pull_record(&self.pending).map(|value| value.into_iter().collect())
    }
}

fn parse_pull_record(record: &[u8]) -> Result<Option<Value>> {
    let record = record.strip_suffix(b"\r").unwrap_or(record);
    if record.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    serde_json::from_slice(record)
        .map(Some)
        .context("Ollama returned invalid pull progress")
}

fn report_pull_update<F>(update: Value, progress: &F) -> Result<()>
where
    F: Fn(u64, Option<u64>),
{
    if let Some(error) = update.get("error").and_then(Value::as_str) {
        anyhow::bail!("Ollama pull failed: {}", error);
    }
    progress(
        update.get("completed").and_then(Value::as_u64).unwrap_or(0),
        update.get("total").and_then(Value::as_u64),
    );
    Ok(())
}

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
        Ok(self
            .list_installed()
            .await?
            .models
            .into_iter()
            .map(|model| model.name)
            .collect())
    }

    async fn list_installed(&self) -> Result<TagsResponse> {
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
        let data: TagsResponse = read_json_body(response, MODEL_LIST_BODY_LIMIT)
            .await
            .context("Failed to read or parse bounded Ollama response")?;
        tracing::info!("Ollama returned {} models", data.models.len());
        Ok(data)
    }

    pub async fn catalog(&self) -> Result<Vec<OllamaCatalogEntry>> {
        let installed = self.list_installed().await.unwrap_or_default();
        Ok(curated_model_catalog()
            .into_iter()
            .map(|model| {
                let found = installed.models.iter().find(|item| item.name == model.id);
                let installed_digest = found.and_then(|item| item.digest.as_deref());
                OllamaCatalogEntry {
                    id: model.id.to_string(),
                    display_name: model.display_name.to_string(),
                    provider: model.provider.to_string(),
                    disk_size_bytes: model.disk_size_bytes,
                    context_tokens: model.context_tokens,
                    minimum_memory_bytes: model.minimum_memory_bytes,
                    recommended_memory_bytes: model.recommended_memory_bytes,
                    license: model.license.to_string(),
                    disclosure: model.disclosure.map(str::to_string),
                    lanes: model.lanes.iter().map(|lane| (*lane).to_string()).collect(),
                    expected_manifest_digest: model.expected_manifest_digest.map(str::to_string),
                    installed: found.is_some(),
                    installed_digest: installed_digest.map(str::to_string),
                    installed_size_bytes: found.and_then(|item| item.size),
                    ready: found.is_some() && digest_is_ready(&model, installed_digest),
                }
            })
            .collect())
    }

    pub async fn pull_model<F>(
        &self,
        model_id: &str,
        accepted_license: bool,
        cancelled: &std::sync::atomic::AtomicBool,
        cancel_notify: &tokio::sync::Notify,
        progress: F,
    ) -> Result<OllamaCatalogEntry>
    where
        F: Fn(u64, Option<u64>) + Send + Sync,
    {
        let model = validate_pull_request(model_id, accepted_license)?;
        let response = self
            .client
            .post(format!("{}/api/pull", self.base_url))
            .timeout(Duration::from_secs(60 * 60))
            .json(&serde_json::json!({"model": model.id, "stream": true, "insecure": false}))
            .send()
            .await
            .context("Failed to connect to local Ollama")?;
        if !response.status().is_success() {
            let status = response.status();
            let body = read_error_body(response).await;
            anyhow::bail!("Ollama pull error {}: {}", status, body);
        }
        let mut stream = response.bytes_stream();
        let mut parser = PullStreamParser::default();
        loop {
            if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
                anyhow::bail!("Ollama model installation cancelled");
            }
            let chunk = tokio::select! {
                _ = cancel_notify.notified() => anyhow::bail!("Ollama model installation cancelled"),
                chunk = stream.next() => chunk,
            };
            let Some(chunk) = chunk else { break };
            if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
                anyhow::bail!("Ollama model installation cancelled");
            }
            for update in parser.push(&chunk.context("Failed to read Ollama pull response")?)? {
                report_pull_update(update, &progress)?;
            }
        }
        for update in parser.finish()? {
            report_pull_update(update, &progress)?;
        }
        let entry = self
            .catalog()
            .await?
            .into_iter()
            .find(|entry| entry.id == model.id)
            .ok_or_else(|| {
                anyhow::anyhow!("Installed model disappeared from the Ollama catalog")
            })?;
        if !entry.ready {
            anyhow::bail!(
                "Ollama installed {} with digest {}, expected {}",
                model.id,
                entry.installed_digest.as_deref().unwrap_or("missing"),
                model
                    .expected_manifest_digest
                    .unwrap_or("a reported digest")
            );
        }
        Ok(entry)
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
