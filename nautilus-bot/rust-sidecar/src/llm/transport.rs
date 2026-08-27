use async_trait::async_trait;
use reqwest::StatusCode;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;

use super::{
    AnthropicClient, DeepSeekClient, GeminiClient, OllamaClient, OllamaCloudClient, OpenAIClient,
};

pub(crate) const MODEL_LIST_BODY_LIMIT: usize = 4 * 1024 * 1024;
pub(crate) const COMPLETION_BODY_LIMIT: usize = 8 * 1024 * 1024;
pub(crate) const MODEL_METADATA_BODY_LIMIT: usize = 8 * 1024 * 1024;
pub(crate) const EMBEDDING_BODY_LIMIT: usize = 16 * 1024 * 1024;
pub(crate) const BATCH_EMBEDDING_BODY_LIMIT: usize = 64 * 1024 * 1024;
const ERROR_BODY_READ_LIMIT: usize = 64 * 1024;
const ERROR_MESSAGE_SNIPPET_LIMIT: usize = 8 * 1024;

#[derive(Debug, Error)]
pub(crate) enum BoundedBodyError {
    #[error("response body exceeds the {limit}-byte limit (declared length: {declared:?})")]
    TooLarge { limit: usize, declared: Option<u64> },
    #[error("failed while reading response body: {0}")]
    Read(#[source] reqwest::Error),
    #[error("response body is not valid JSON: {0}")]
    Json(#[source] serde_json::Error),
}

pub(crate) async fn read_bounded_body(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, BoundedBodyError> {
    let declared = response.content_length();
    if declared.is_some_and(|length| length > limit as u64) {
        return Err(BoundedBodyError::TooLarge { limit, declared });
    }

    let capacity = declared
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or_default()
        .min(limit);
    let mut body = Vec::with_capacity(capacity);
    while let Some(chunk) = response.chunk().await.map_err(BoundedBodyError::Read)? {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(BoundedBodyError::TooLarge { limit, declared });
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub(crate) async fn read_json_body<T: DeserializeOwned>(
    response: reqwest::Response,
    limit: usize,
) -> Result<T, BoundedBodyError> {
    let body = read_bounded_body(response, limit).await?;
    serde_json::from_slice(&body).map_err(BoundedBodyError::Json)
}

pub(crate) async fn read_error_body(response: reqwest::Response) -> String {
    match read_bounded_body(response, ERROR_BODY_READ_LIMIT).await {
        Ok(body) => body_snippet(&body),
        Err(error) => format!("Provider error response could not be retained safely: {error}"),
    }
}

fn body_snippet(body: &[u8]) -> String {
    let truncated = body.len() > ERROR_MESSAGE_SNIPPET_LIMIT;
    let kept = &body[..body.len().min(ERROR_MESSAGE_SNIPPET_LIMIT)];
    let mut snippet = String::from_utf8_lossy(kept).into_owned();
    if truncated {
        snippet.push_str("… [response truncated]");
    }
    snippet
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Provider {
    Ollama,
    OpenAi,
    Anthropic,
    Gemini,
    DeepSeek,
    OllamaCloud,
}

impl Provider {
    pub fn from_settings_value(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "ollama" => Ok(Self::Ollama),
            "openai" => Ok(Self::OpenAi),
            "anthropic" => Ok(Self::Anthropic),
            "gemini" => Ok(Self::Gemini),
            "deepseek" => Ok(Self::DeepSeek),
            "ollama-cloud" => Ok(Self::OllamaCloud),
            unknown => Err(format!(
                "Unsupported analysis provider '{}'. Choose ollama, openai, anthropic, gemini, deepseek, or ollama-cloud.",
                unknown
            )),
        }
    }

    pub fn as_settings_value(self) -> &'static str {
        match self {
            Self::Ollama => "ollama",
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
            Self::DeepSeek => "deepseek",
            Self::OllamaCloud => "ollama-cloud",
        }
    }

    pub fn is_remote(self) -> bool {
        !matches!(self, Self::Ollama)
    }

    pub fn provider_secret_name(self) -> Option<&'static str> {
        match self {
            Self::OpenAi => Some("openai"),
            Self::Anthropic => Some("anthropic"),
            Self::Gemini => Some("gemini"),
            Self::DeepSeek => Some("deepseek"),
            Self::OllamaCloud => Some("ollama-cloud"),
            Self::Ollama => None,
        }
    }

    pub fn environment_key_name(self) -> Option<&'static str> {
        match self {
            Self::OpenAi => Some("OPENAI_API_KEY"),
            Self::Anthropic => Some("ANTHROPIC_API_KEY"),
            Self::Gemini => Some("GEMINI_API_KEY"),
            Self::DeepSeek => Some("DEEPSEEK_API_KEY"),
            Self::OllamaCloud => Some("OLLAMA_CLOUD_API_KEY"),
            Self::Ollama => None,
        }
    }

    /// Fallback model used when a lane has no explicit model configured.
    ///
    /// Verified live against each provider's documentation on 2026-08-27 (see
    /// the model-currency audit); do not restore any of the prior values from
    /// training-data memory without re-checking the provider's own docs first:
    /// - Ollama/OllamaCloud: `llama3.2` is a generation behind and has no MLX
    ///   build; `qwen3.5:4b` is the current small/fast tier
    ///   (https://ollama.com/library/qwen3.5).
    /// - OpenAi: `gpt-4o-mini` is superseded; `gpt-5.6-luna` is the current
    ///   cost-optimized tier
    ///   (https://developers.openai.com/api/docs/models).
    /// - Gemini: `gemini-2.0-flash` was shut down by Google; `gemini-3.7-flash`
    ///   is the current flagship Flash model ($0.75/$3.75 per Mtok) and the
    ///   right quality tradeoff for meeting summarization on a BYOK app --
    ///   `gemini-3.5-flash-lite` is cheaper/faster but a lower-quality choice
    ///   for this workload (product decision, verified live)
    ///   (https://ai.google.dev/gemini-api/docs/models).
    /// - DeepSeek: `deepseek-chat` was retired 2026-07-24 and no longer
    ///   resolves; `deepseek-v4-flash` is its documented non-thinking-mode
    ///   successor (https://api-docs.deepseek.com/updates/).
    pub fn default_model(self) -> &'static str {
        match self {
            Self::Ollama => "qwen3.5:4b",
            Self::OpenAi => "gpt-5.6-luna",
            Self::Anthropic => "claude-opus-5",
            Self::Gemini => "gemini-3.7-flash",
            Self::DeepSeek => "deepseek-v4-flash",
            Self::OllamaCloud => "qwen3.5:4b",
        }
    }

    pub fn model_budget(self, model: &str, purpose: CompletionPurpose) -> ModelBudget {
        let normalized = model.to_ascii_lowercase();
        let context_window_tokens = match self {
            Self::Ollama => model_context_hint(&normalized).unwrap_or(4_096),
            Self::OllamaCloud => model_context_hint(&normalized).unwrap_or(32_768),
            Self::OpenAi => {
                // The gpt-5.x family (shipped under codenames -- gpt-5.6-sol,
                // -terra, -luna, -cyber -- see
                // https://developers.openai.com/api/docs/models) carries a
                // ~1M-token window; every prior GPT-5.x string used to fall
                // through to the 16K catch-all below.
                if normalized.starts_with("gpt-5") {
                    1_000_000
                } else if normalized.contains("gpt-4o")
                    || normalized.contains("gpt-4.1")
                    || normalized.starts_with("o1")
                    || normalized.starts_with("o3")
                    || normalized.starts_with("o4")
                {
                    128_000
                } else {
                    16_384
                }
            }
            Self::Anthropic => anthropic_context_window(&normalized),
            Self::Gemini => {
                // Every currently-documented Gemini generation from 1.5
                // onward (1.5, 2.x, 3.x) advertises a ~1M-token input window
                // (https://ai.google.dev/gemini-api/docs/models); only
                // pre-1.5 / unrecognized names fall back conservatively.
                if normalized.contains("1.5")
                    || normalized.contains("2.")
                    || normalized.contains("3.")
                {
                    1_000_000
                } else {
                    32_768
                }
            }
            Self::DeepSeek => 64_000,
        };

        let reserved_output_tokens = match purpose {
            CompletionPurpose::Title => 128,
            CompletionPurpose::Map => 2_048,
            CompletionPurpose::Reduce => 2_048,
            CompletionPurpose::ActionItems => 2_048,
            CompletionPurpose::Summary => 3_072,
            CompletionPurpose::Ask => 2_048,
            CompletionPurpose::Generic => 1_024,
        };

        ModelBudget {
            context_window_tokens,
            reserved_output_tokens,
            safety_margin_tokens: 512,
        }
    }
}

fn anthropic_context_window(model: &str) -> usize {
    if [
        "claude-fable-5",
        "claude-mythos-5",
        "claude-opus-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-5",
        "claude-sonnet-4-6",
    ]
    .iter()
    .any(|prefix| model.starts_with(prefix))
    {
        1_000_000
    } else {
        200_000
    }
}

fn model_context_hint(model: &str) -> Option<usize> {
    for (needle, tokens) in [
        ("128k", 128_000),
        ("64k", 64_000),
        ("32k", 32_000),
        ("16k", 16_000),
        ("8k", 8_000),
        ("4k", 4_000),
    ] {
        if model.contains(needle) {
            return Some(tokens);
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionPurpose {
    Generic,
    Ask,
    Summary,
    ActionItems,
    Map,
    Reduce,
    Title,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelBudget {
    pub context_window_tokens: usize,
    pub reserved_output_tokens: usize,
    pub safety_margin_tokens: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ModelContextMetadata {
    /// Maximum context capacity advertised by the model itself.
    pub capacity_tokens: Option<usize>,
    /// Positive `num_ctx` configured by the model's Modelfile, when present.
    pub default_tokens: Option<usize>,
}

impl ModelBudget {
    pub fn available_input_tokens(self) -> usize {
        self.context_window_tokens
            .saturating_sub(self.reserved_output_tokens)
            .saturating_sub(self.safety_margin_tokens)
    }
}

#[derive(Debug, Clone)]
pub struct RequestOptions {
    /// Deadline for one provider HTTP request, not the full multi-call job.
    pub timeout: Duration,
    pub max_output_tokens: usize,
    pub temperature: Option<f32>,
    pub json_schema: Option<Value>,
    /// Provider-neutral context allocation hint. Only Ollama serializes this,
    /// after validating it as a positive `num_ctx`; cloud adapters ignore it.
    pub requested_context_tokens: Option<usize>,
}

impl RequestOptions {
    #[cfg(test)]
    pub fn for_budget(timeout: Duration, budget: ModelBudget) -> Self {
        Self {
            timeout,
            max_output_tokens: budget.reserved_output_tokens,
            temperature: Some(0.1),
            json_schema: None,
            requested_context_tokens: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CompletionRequest {
    pub model: String,
    pub system_prompt: Option<String>,
    pub prompt: String,
    /// Provider-neutral stage metadata used by orchestration diagnostics and tests.
    pub purpose: CompletionPurpose,
    pub options: RequestOptions,
}

#[derive(Debug, Clone)]
pub struct CompletionResponse {
    pub text: String,
    pub model: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    Configuration,
    Policy,
    Authentication,
    Permission,
    InvalidRequest,
    ContextLimit,
    RateLimit,
    Timeout,
    Transport,
    Upstream,
    Parse,
    EmptyResponse,
    OutputLimit,
}

impl ErrorKind {
    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::RateLimit | Self::Timeout | Self::Transport | Self::Upstream
        )
    }
}

#[derive(Debug, Error, Clone)]
#[error("{provider} {kind:?}: {message}")]
pub struct LlmError {
    pub provider: &'static str,
    pub kind: ErrorKind,
    pub message: String,
    pub status: Option<u16>,
}

impl LlmError {
    pub fn new(provider: Provider, kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            provider: provider.as_settings_value(),
            kind,
            message: message.into(),
            status: None,
        }
    }

    pub fn with_status(
        provider: Provider,
        kind: ErrorKind,
        status: StatusCode,
        message: impl Into<String>,
    ) -> Self {
        Self {
            provider: provider.as_settings_value(),
            kind,
            message: message.into(),
            status: Some(status.as_u16()),
        }
    }

    pub fn from_reqwest(provider: Provider, context: &str, error: reqwest::Error) -> Self {
        let kind = if error.is_timeout() {
            ErrorKind::Timeout
        } else if error.is_connect() || error.is_request() {
            ErrorKind::Transport
        } else if error.is_decode() {
            ErrorKind::Parse
        } else {
            ErrorKind::Transport
        };
        Self::new(
            provider,
            kind,
            format!("{}: {}", context, error.without_url()),
        )
    }
}

pub(crate) fn bounded_body_error_to_llm(
    provider: Provider,
    context: &str,
    error: BoundedBodyError,
) -> LlmError {
    match error {
        BoundedBodyError::Read(error) => LlmError::from_reqwest(provider, context, error),
        other => LlmError::new(provider, ErrorKind::Parse, format!("{context}: {other}")),
    }
}

pub fn classify_http_error(provider: Provider, status: StatusCode, body: String) -> LlmError {
    let lower = body.to_ascii_lowercase();
    let kind = match status.as_u16() {
        _ if is_context_limit_message(&lower) => ErrorKind::ContextLimit,
        413 if provider == Provider::Ollama => ErrorKind::ContextLimit,
        400 | 413 | 422 => ErrorKind::InvalidRequest,
        401 => ErrorKind::Authentication,
        403 => ErrorKind::Permission,
        429 => ErrorKind::RateLimit,
        408 | 504 => ErrorKind::Timeout,
        500..=599 => ErrorKind::Upstream,
        _ => ErrorKind::Upstream,
    };
    LlmError::with_status(provider, kind, status, body)
}

fn is_context_limit_message(message: &str) -> bool {
    [
        "context length",
        "context window",
        "context limit",
        "context size",
        "input length",
        "input too long",
        "prompt is too long",
        "prompt too long",
        "too many tokens",
        "token limit",
        "maximum prompt length",
        "failed to create new sequence",
        "no kv cache slot",
    ]
    .iter()
    .any(|needle| message.contains(needle))
        || ((message.contains("failed to allocate") || message.contains("unable to allocate"))
            && (message.contains("context") || message.contains("kv cache")))
}

#[async_trait]
pub trait CompletionTransport: Send + Sync {
    fn provider(&self) -> Provider;

    async fn complete(&self, request: &CompletionRequest) -> Result<CompletionResponse, LlmError>;

    async fn model_context_metadata(&self, _model: &str) -> Result<ModelContextMetadata, LlmError> {
        Ok(ModelContextMetadata::default())
    }

    async fn invalidate_model_context_metadata(&self, _model: &str) {}
}

#[derive(Clone)]
pub enum ProviderTransport {
    Ollama(OllamaClient),
    OpenAi(OpenAIClient),
    Anthropic(AnthropicClient),
    Gemini(GeminiClient),
    DeepSeek(DeepSeekClient),
    OllamaCloud(OllamaCloudClient),
}

impl ProviderTransport {
    pub fn new(provider: Provider, api_key: Option<String>, ollama: &OllamaClient) -> Self {
        match provider {
            Provider::Ollama => Self::Ollama(ollama.clone()),
            Provider::OpenAi => Self::OpenAi(OpenAIClient::with_api_key(api_key)),
            Provider::Anthropic => Self::Anthropic(AnthropicClient::with_api_key(api_key)),
            Provider::Gemini => Self::Gemini(GeminiClient::with_api_key(api_key)),
            Provider::DeepSeek => Self::DeepSeek(DeepSeekClient::with_api_key(api_key)),
            Provider::OllamaCloud => Self::OllamaCloud(OllamaCloudClient::with_api_key(api_key)),
        }
    }
}

#[async_trait]
impl CompletionTransport for ProviderTransport {
    fn provider(&self) -> Provider {
        match self {
            Self::Ollama(_) => Provider::Ollama,
            Self::OpenAi(_) => Provider::OpenAi,
            Self::Anthropic(_) => Provider::Anthropic,
            Self::Gemini(_) => Provider::Gemini,
            Self::DeepSeek(_) => Provider::DeepSeek,
            Self::OllamaCloud(_) => Provider::OllamaCloud,
        }
    }

    async fn complete(&self, request: &CompletionRequest) -> Result<CompletionResponse, LlmError> {
        match self {
            Self::Ollama(client) => client.complete(request).await,
            Self::OpenAi(client) => client.complete(request).await,
            Self::Anthropic(client) => client.complete(request).await,
            Self::Gemini(client) => client.complete(request).await,
            Self::DeepSeek(client) => client.complete(request).await,
            Self::OllamaCloud(client) => client.complete(request).await,
        }
    }

    async fn model_context_metadata(&self, model: &str) -> Result<ModelContextMetadata, LlmError> {
        match self {
            Self::Ollama(client) => client.model_context_metadata(model).await,
            Self::Gemini(client) => client.model_context_metadata(model).await,
            _ => Ok(ModelContextMetadata::default()),
        }
    }

    async fn invalidate_model_context_metadata(&self, model: &str) {
        match self {
            Self::Ollama(client) => client.invalidate_model_context_metadata(model).await,
            Self::Gemini(client) => client.invalidate_model_context_metadata(model).await,
            _ => {}
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProviderSelection {
    pub provider: Provider,
    pub model: String,
    pub remote_processing_enabled: bool,
    pub remote_processing_gate: Arc<crate::remote_processing::RemoteProcessingGate>,
    pub api_key: Option<String>,
    pub timeout: Duration,
}

pub struct ProviderRuntime {
    selection: ProviderSelection,
    transport: ProviderTransport,
}

impl ProviderRuntime {
    pub fn new(selection: ProviderSelection, ollama: &OllamaClient) -> Result<Self, LlmError> {
        if selection.provider.is_remote() && !selection.remote_processing_enabled {
            return Err(LlmError::new(
                selection.provider,
                ErrorKind::Policy,
                format!(
                    "Remote provider '{}' is blocked by policy. Enable Settings > Security > Remote processing to continue.",
                    selection.provider.as_settings_value()
                ),
            ));
        }
        if selection.provider.is_remote()
            && selection
                .api_key
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_none()
        {
            return Err(LlmError::new(
                selection.provider,
                ErrorKind::Configuration,
                format!(
                    "Missing provider secret for '{}'. Add an API key in Settings > AI & Keys.",
                    selection.provider.as_settings_value()
                ),
            ));
        }

        let transport =
            ProviderTransport::new(selection.provider, selection.api_key.clone(), ollama);
        Ok(Self {
            selection,
            transport,
        })
    }

    pub fn provider(&self) -> Provider {
        self.selection.provider
    }

    pub fn model(&self) -> &str {
        &self.selection.model
    }

    pub fn model_budget(&self, purpose: CompletionPurpose) -> ModelBudget {
        self.selection
            .provider
            .model_budget(&self.selection.model, purpose)
    }

    fn enforce_live_remote_policy(&self) -> Result<(), LlmError> {
        if self.selection.provider.is_remote()
            && !self.selection.remote_processing_gate.is_allowed()
        {
            return Err(LlmError::new(
                self.selection.provider,
                ErrorKind::Policy,
                "Remote processing was disabled while analysis was running; the active request was cancelled and no further meeting data was sent.",
            ));
        }
        Ok(())
    }

    async fn complete_with_live_policy(
        &self,
        request: &CompletionRequest,
    ) -> Result<CompletionResponse, LlmError> {
        self.enforce_live_remote_policy()?;
        tracing::debug!(
            provider = self.selection.provider.as_settings_value(),
            purpose = ?request.purpose,
            model = %request.model,
            "Starting LLM completion"
        );
        if !self.selection.provider.is_remote() {
            return self.transport.complete(request).await;
        }

        let mut grant = self
            .selection
            .remote_processing_gate
            .grant()
            .map_err(|message| {
                LlmError::new(self.selection.provider, ErrorKind::Policy, message)
            })?;
        let completion = self.transport.complete(request);
        tokio::pin!(completion);
        tokio::select! {
            result = &mut completion => result,
            _ = grant.cancelled() => Err(LlmError::new(
                self.selection.provider,
                ErrorKind::Policy,
                "Remote processing was disabled while analysis was running; the active request was cancelled and no further meeting data was sent.",
            )),
        }
    }

    pub async fn execute(
        &self,
        purpose: CompletionPurpose,
        system_prompt: Option<String>,
        prompt: String,
        mut options: RequestOptions,
    ) -> Result<CompletionResponse, LlmError> {
        self.enforce_live_remote_policy()?;
        options.timeout = options.timeout.min(self.selection.timeout);
        let request = CompletionRequest {
            model: self.selection.model.clone(),
            system_prompt,
            prompt,
            purpose,
            options,
        };
        self.complete_with_live_policy(&request).await
    }
}

#[async_trait]
impl CompletionTransport for ProviderRuntime {
    fn provider(&self) -> Provider {
        self.selection.provider
    }

    async fn complete(&self, request: &CompletionRequest) -> Result<CompletionResponse, LlmError> {
        self.enforce_live_remote_policy()?;
        let mut request = request.clone();
        request.model = self.selection.model.clone();
        request.options.timeout = request.options.timeout.min(self.selection.timeout);
        self.complete_with_live_policy(&request).await
    }

    async fn model_context_metadata(&self, _model: &str) -> Result<ModelContextMetadata, LlmError> {
        self.transport
            .model_context_metadata(&self.selection.model)
            .await
    }

    async fn invalidate_model_context_metadata(&self, _model: &str) {
        self.transport
            .invalidate_model_context_metadata(&self.selection.model)
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn bounded_body_rejects_oversized_declared_body() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n123456789")
                .await
                .unwrap();
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}/oversized"))
            .send()
            .await
            .unwrap();

        let error = read_bounded_body(response, 8)
            .await
            .expect_err("declared oversized bodies must be rejected before parsing");
        assert!(matches!(
            error,
            BoundedBodyError::TooLarge {
                limit: 8,
                declared: Some(9)
            }
        ));
        server.await.unwrap();
    }

    #[test]
    fn model_budget_reserves_input_and_output_space() {
        let budget = Provider::Ollama.model_budget("llama3.2", CompletionPurpose::Summary);
        assert_eq!(budget.context_window_tokens, 4_096);
        assert_eq!(budget.reserved_output_tokens, 3_072);
        assert!(budget.available_input_tokens() < budget.context_window_tokens);
    }

    #[test]
    fn anthropic_defaults_to_current_opus_and_uses_current_context_windows() {
        assert_eq!(Provider::Anthropic.default_model(), "claude-opus-5");
        assert_eq!(
            Provider::Anthropic
                .model_budget("claude-opus-5", CompletionPurpose::Summary)
                .context_window_tokens,
            1_000_000
        );
        assert_eq!(
            Provider::Anthropic
                .model_budget("claude-sonnet-4-20250514", CompletionPurpose::Summary)
                .context_window_tokens,
            200_000
        );
    }

    #[test]
    fn default_models_are_not_retired_provider_identifiers() {
        // Regression coverage for the 2026-08-27 model-currency audit: every
        // fallback below was verified live against its provider's own docs
        // (see the doc comment on `Provider::default_model`). None of these
        // may be reverted to a pre-audit value without re-checking live docs.
        assert_eq!(Provider::Ollama.default_model(), "qwen3.5:4b");
        assert_eq!(Provider::OllamaCloud.default_model(), "qwen3.5:4b");
        assert_eq!(Provider::OpenAi.default_model(), "gpt-5.6-luna");
        assert_eq!(Provider::Gemini.default_model(), "gemini-3.7-flash");
        assert_eq!(Provider::DeepSeek.default_model(), "deepseek-v4-flash");
    }

    #[test]
    fn openai_gpt5_family_gets_its_real_million_token_window() {
        // gpt-4o-mini (the old default) still resolves via the gpt-4o branch.
        assert_eq!(
            Provider::OpenAi
                .model_budget("gpt-4o-mini", CompletionPurpose::Summary)
                .context_window_tokens,
            128_000
        );
        for model in [
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.6-cyber",
        ] {
            assert_eq!(
                Provider::OpenAi
                    .model_budget(model, CompletionPurpose::Summary)
                    .context_window_tokens,
                1_000_000,
                "{model} must not fall through to the 16K catch-all"
            );
        }
        // A genuinely unrecognized model still gets the conservative fallback.
        assert_eq!(
            Provider::OpenAi
                .model_budget("some-future-mini-model", CompletionPurpose::Summary)
                .context_window_tokens,
            16_384
        );
    }

    #[test]
    fn gemini_3x_family_gets_its_real_million_token_window() {
        for model in [
            "gemini-3.5-flash-lite",
            "gemini-3.5-flash",
            "gemini-3.6-flash",
            "gemini-3.7-flash",
            "gemini-2.5-pro",
        ] {
            assert_eq!(
                Provider::Gemini
                    .model_budget(model, CompletionPurpose::Summary)
                    .context_window_tokens,
                1_000_000,
                "{model} must not fall through to the 32K catch-all"
            );
        }
        assert_eq!(
            Provider::Gemini
                .model_budget("gemini-pro", CompletionPurpose::Summary)
                .context_window_tokens,
            32_768
        );
    }

    #[test]
    fn impossible_model_budget_does_not_manufacture_input_capacity() {
        let budget = ModelBudget {
            context_window_tokens: 600,
            reserved_output_tokens: 100,
            safety_margin_tokens: 512,
        };
        assert_eq!(budget.available_input_tokens(), 0);
    }

    #[test]
    fn unknown_analysis_providers_are_rejected_instead_of_routing_to_ollama() {
        assert_eq!(
            Provider::from_settings_value("ollama").unwrap(),
            Provider::Ollama
        );
        assert!(Provider::from_settings_value("groq").is_err());
        assert!(Provider::from_settings_value("ollmaa").is_err());
    }

    #[tokio::test]
    async fn live_remote_policy_stops_subsequent_calls() {
        let gate = Arc::new(crate::remote_processing::RemoteProcessingGate::new(true));
        let runtime = ProviderRuntime::new(
            ProviderSelection {
                provider: Provider::OpenAi,
                model: "gpt-4o-mini".to_string(),
                remote_processing_enabled: true,
                remote_processing_gate: Arc::clone(&gate),
                api_key: Some("not-used".to_string()),
                timeout: Duration::from_secs(1),
            },
            &OllamaClient::new(),
        )
        .unwrap();
        gate.set_allowed(false);
        let error = runtime
            .complete(&CompletionRequest {
                model: "ignored".to_string(),
                system_prompt: None,
                prompt: "meeting data".to_string(),
                purpose: CompletionPurpose::Summary,
                options: RequestOptions::for_budget(
                    Duration::from_secs(1),
                    Provider::OpenAi.model_budget("gpt-4o-mini", CompletionPurpose::Summary),
                ),
            })
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Policy);
    }

    #[test]
    fn http_error_classification_is_provider_independent() {
        assert_eq!(
            classify_http_error(
                Provider::Gemini,
                StatusCode::TOO_MANY_REQUESTS,
                "busy".into()
            )
            .kind,
            ErrorKind::RateLimit
        );
        assert_eq!(
            classify_http_error(
                Provider::Anthropic,
                StatusCode::PAYLOAD_TOO_LARGE,
                "too large".into()
            )
            .kind,
            ErrorKind::InvalidRequest
        );
        assert_eq!(
            classify_http_error(
                Provider::OpenAi,
                StatusCode::BAD_REQUEST,
                "context limit exceeded".into()
            )
            .kind,
            ErrorKind::ContextLimit
        );
        assert_eq!(
            classify_http_error(
                Provider::Ollama,
                StatusCode::INTERNAL_SERVER_ERROR,
                "unable to allocate context KV cache".into()
            )
            .kind,
            ErrorKind::ContextLimit
        );
        assert_eq!(
            classify_http_error(
                Provider::Ollama,
                StatusCode::PAYLOAD_TOO_LARGE,
                "request too large".into()
            )
            .kind,
            ErrorKind::ContextLimit
        );
    }
}
