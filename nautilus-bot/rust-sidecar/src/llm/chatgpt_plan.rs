//! ChatGPT-plan text transport through the Electron-owned loopback relay.
//!
//! Electron owns account grants and OAuth material. Rust receives only a
//! process-local relay address and bearer key created by trusted startup code.

use crate::llm::transport::{
    bounded_body_error_to_llm, CompletionRequest, CompletionResponse, CompletionTransport,
    ErrorKind, LlmError, Provider, COMPLETION_BODY_LIMIT, MODEL_LIST_BODY_LIMIT,
};
use async_trait::async_trait;
use reqwest::{redirect::Policy, Url};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const RELAY_URL_ENV: &str = "PLAINSONG_CHATGPT_RELAY_URL";
const RELAY_KEY_ENV: &str = "PLAINSONG_CHATGPT_RELAY_KEY";
const MAX_PROMPT_BYTES: usize = 256 * 1024;
const MAX_INSTRUCTIONS_BYTES: usize = 64 * 1024;
const MAX_TIMEOUT_MS: u128 = 10 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptPlanStatus {
    pub cloud_enabled: bool,
    pub connected: bool,
    pub plan_enabled: bool,
    pub loaded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptPlanModel {
    pub slug: String,
    pub display_name: String,
}

#[derive(Debug, Deserialize)]
struct RelayCompletion {
    text: String,
    model: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayCompletionRequest<'a> {
    model: &'a str,
    text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    instructions: Option<&'a str>,
    timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
struct RelayFailure {
    error: RelayError,
}

#[derive(Debug, Deserialize)]
struct RelayError {
    code: String,
    message: String,
}

#[derive(Clone)]
pub struct ChatGptPlanClient {
    endpoint: Result<Url, String>,
    relay_key: Option<String>,
    client: reqwest::Client,
}

impl ChatGptPlanClient {
    pub fn from_startup_env() -> Self {
        Self::new(
            std::env::var(RELAY_URL_ENV).ok(),
            std::env::var(RELAY_KEY_ENV).ok(),
        )
    }

    fn new(endpoint: Option<String>, relay_key: Option<String>) -> Self {
        let endpoint = endpoint
            .ok_or_else(|| "ChatGPT relay is not available in this app session".to_string())
            .and_then(|value| validate_relay_url(&value));
        let relay_key = relay_key.filter(|value| !value.trim().is_empty());
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .build()
            .expect("fixed ChatGPT relay HTTP client configuration must build");
        Self {
            endpoint,
            relay_key,
            client,
        }
    }

    #[cfg(test)]
    fn for_test(endpoint: String, relay_key: String) -> Self {
        Self::new(Some(endpoint), Some(relay_key))
    }

    fn request(
        &self,
        method: reqwest::Method,
        path: &str,
    ) -> Result<reqwest::RequestBuilder, LlmError> {
        let base = self.endpoint.as_ref().map_err(|message| {
            LlmError::new(Provider::ChatGptPlan, ErrorKind::Configuration, message)
        })?;
        let key = self.relay_key.as_deref().ok_or_else(|| {
            LlmError::new(
                Provider::ChatGptPlan,
                ErrorKind::Configuration,
                "ChatGPT relay is not available in this app session",
            )
        })?;
        let url = base.join(path).map_err(|_| {
            LlmError::new(
                Provider::ChatGptPlan,
                ErrorKind::Configuration,
                "ChatGPT relay URL is invalid",
            )
        })?;
        Ok(self.client.request(method, url).bearer_auth(key))
    }

    pub async fn status(&self) -> Result<ChatGptPlanStatus, LlmError> {
        let response = self
            .request(reqwest::Method::GET, "status")?
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|error| {
                LlmError::from_reqwest(Provider::ChatGptPlan, "ChatGPT relay status failed", error)
            })?;
        parse_success(response, MODEL_LIST_BODY_LIMIT, "ChatGPT relay status").await
    }

    pub async fn list_models(&self) -> Result<Vec<ChatGptPlanModel>, LlmError> {
        let response = self
            .request(reqwest::Method::GET, "models")?
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|error| {
                LlmError::from_reqwest(Provider::ChatGptPlan, "ChatGPT model list failed", error)
            })?;
        parse_success(response, MODEL_LIST_BODY_LIMIT, "ChatGPT model list").await
    }
}

fn validate_relay_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "ChatGPT relay URL is invalid".to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("ChatGPT relay URL must be an http://127.0.0.1:<port>/ root URL".to_string());
    }
    Ok(url)
}

fn relay_error_kind(code: &str) -> ErrorKind {
    match code {
        "cloud_disabled" | "cancelled" => ErrorKind::Policy,
        "sign_in_required" => ErrorKind::Authentication,
        "permission_required" | "not_eligible" | "access_restricted" => ErrorKind::Permission,
        "usage_limit" => ErrorKind::UsageLimit,
        "busy" => ErrorKind::RateLimit,
        "invalid_request" => ErrorKind::InvalidRequest,
        "invalid_response" => ErrorKind::Parse,
        "unavailable" => ErrorKind::Upstream,
        _ => ErrorKind::Upstream,
    }
}

async fn parse_success<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
    limit: usize,
    context: &str,
) -> Result<T, LlmError> {
    let status = response.status();
    let body = crate::llm::transport::read_bounded_body(response, limit)
        .await
        .map_err(|error| bounded_body_error_to_llm(Provider::ChatGptPlan, context, error))?;
    if !status.is_success() {
        let failure: RelayFailure = serde_json::from_slice(&body).map_err(|_| {
            LlmError::with_status(
                Provider::ChatGptPlan,
                ErrorKind::Parse,
                status,
                "ChatGPT relay returned an invalid error response",
            )
        })?;
        return Err(LlmError::with_status(
            Provider::ChatGptPlan,
            relay_error_kind(&failure.error.code),
            status,
            failure.error.message,
        ));
    }
    serde_json::from_slice(&body).map_err(|_| {
        LlmError::with_status(
            Provider::ChatGptPlan,
            ErrorKind::Parse,
            status,
            "ChatGPT relay returned an invalid response",
        )
    })
}

#[async_trait]
impl CompletionTransport for ChatGptPlanClient {
    fn provider(&self) -> Provider {
        Provider::ChatGptPlan
    }

    async fn complete(&self, request: &CompletionRequest) -> Result<CompletionResponse, LlmError> {
        if request.model.trim().is_empty() {
            return Err(LlmError::new(
                Provider::ChatGptPlan,
                ErrorKind::Configuration,
                "Choose a ChatGPT account model before continuing",
            ));
        }
        if request.prompt.len() > MAX_PROMPT_BYTES {
            return Err(LlmError::new(
                Provider::ChatGptPlan,
                ErrorKind::ContextLimit,
                "ChatGPT relay prompt exceeds the 256 KiB limit",
            ));
        }
        if request
            .system_prompt
            .as_ref()
            .is_some_and(|value| value.len() > MAX_INSTRUCTIONS_BYTES)
        {
            return Err(LlmError::new(
                Provider::ChatGptPlan,
                ErrorKind::ContextLimit,
                "ChatGPT relay instructions exceed the 64 KiB limit",
            ));
        }
        let timeout_ms = request.options.timeout.as_millis().clamp(1, MAX_TIMEOUT_MS) as u64;
        let body = RelayCompletionRequest {
            model: &request.model,
            text: &request.prompt,
            instructions: request.system_prompt.as_deref(),
            timeout_ms,
        };
        let response = self
            .request(reqwest::Method::POST, "complete")?
            .header("Content-Type", "application/json")
            .timeout(request.options.timeout)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                LlmError::from_reqwest(Provider::ChatGptPlan, "ChatGPT relay request failed", error)
            })?;
        let data: RelayCompletion =
            parse_success(response, COMPLETION_BODY_LIMIT, "ChatGPT relay completion").await?;
        if data.text.trim().is_empty() {
            return Err(LlmError::new(
                Provider::ChatGptPlan,
                ErrorKind::EmptyResponse,
                "ChatGPT relay returned an empty completion",
            ));
        }
        if data.model.trim().is_empty() {
            return Err(LlmError::new(
                Provider::ChatGptPlan,
                ErrorKind::Parse,
                "ChatGPT relay returned no model identity",
            ));
        }
        Ok(CompletionResponse {
            text: data.text,
            model: data.model,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::transport::{CompletionPurpose, ModelBudget, RequestOptions};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    #[ignore = "requires the isolated Electron-owned relay fixture"]
    async fn electron_owned_relay_roundtrip() {
        let client = ChatGptPlanClient::from_startup_env();
        let status = client.status().await.unwrap();
        assert!(status.cloud_enabled && status.loaded && status.connected && status.plan_enabled);
        let models = client.list_models().await.unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].slug, "fixture-model");
        assert_eq!(models[0].display_name, "Account fixture model");
        let request = CompletionRequest {
            model: "fixture-model".into(),
            system_prompt: Some("Preserve the supplied meaning.".into()),
            prompt: "  Do not approve payment until Marcus confirms.\n".into(),
            purpose: CompletionPurpose::Generic,
            options: RequestOptions::for_budget(
                Duration::from_secs(5),
                ModelBudget {
                    context_window_tokens: 16_384,
                    reserved_output_tokens: 1024,
                    safety_margin_tokens: 512,
                },
            ),
        };
        let completed = client.complete(&request).await.unwrap();
        assert_eq!(completed.model, request.model);
        assert_eq!(completed.text, request.prompt);
    }

    #[test]
    fn exhausted_plan_usage_does_not_retry_as_a_transient_rate_limit() {
        assert!(!relay_error_kind("usage_limit").retryable());
        for code in ["not_eligible", "access_restricted", "invalid_request"] {
            assert!(!relay_error_kind(code).retryable(), "{code}");
        }
        assert!(relay_error_kind("busy").retryable());
    }

    #[test]
    fn relay_url_accepts_only_loopback_root_urls() {
        assert!(validate_relay_url("http://127.0.0.1:49152/").is_ok());
        for value in [
            "https://127.0.0.1:49152/",
            "http://localhost:49152/",
            "http://127.0.0.1/",
            "http://127.0.0.1:49152/path",
            "http://127.0.0.1:49152/?key=no",
            "http://user@127.0.0.1:49152/",
        ] {
            assert!(validate_relay_url(value).is_err(), "{value}");
        }
    }

    async fn one_shot(response: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 16 * 1024];
            let read = stream.read(&mut bytes).await.unwrap();
            stream.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&bytes[..read]).into_owned()
        });
        (format!("http://{address}/"), task)
    }

    #[tokio::test]
    async fn completion_uses_exact_relay_contract_and_preserves_model() {
        let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 42\r\nConnection: close\r\n\r\n{\"text\":\"  exact text  \",\"model\":\"acct-x\"}";
        let (url, request_task) = one_shot(response).await;
        let client = ChatGptPlanClient::for_test(url, "relay-secret".into());
        let request = CompletionRequest {
            model: "acct-x".into(),
            system_prompt: Some("system".into()),
            prompt: "hello".into(),
            purpose: CompletionPurpose::Generic,
            options: RequestOptions::for_budget(
                Duration::from_secs(2),
                ModelBudget {
                    context_window_tokens: 16_384,
                    reserved_output_tokens: 1024,
                    safety_margin_tokens: 512,
                },
            ),
        };
        let result = client.complete(&request).await.unwrap();
        assert_eq!(result.text, "  exact text  ");
        assert_eq!(result.model, "acct-x");
        let raw = request_task.await.unwrap();
        assert!(raw.starts_with("POST /complete HTTP/1.1"));
        assert!(raw
            .to_ascii_lowercase()
            .contains("authorization: bearer relay-secret"));
        assert!(raw.contains("\"model\":\"acct-x\""));
        assert!(raw.contains("\"instructions\":\"system\""));
        assert!(raw.contains("\"text\":\"hello\""));
    }

    #[tokio::test]
    async fn fixed_relay_error_codes_map_to_precise_kinds() {
        for (code, expected) in [
            ("sign_in_required", ErrorKind::Authentication),
            ("permission_required", ErrorKind::Permission),
            ("usage_limit", ErrorKind::UsageLimit),
            ("invalid_request", ErrorKind::InvalidRequest),
            ("invalid_response", ErrorKind::Parse),
            ("unavailable", ErrorKind::Upstream),
            ("cloud_disabled", ErrorKind::Policy),
            ("cancelled", ErrorKind::Policy),
            ("busy", ErrorKind::RateLimit),
        ] {
            assert_eq!(relay_error_kind(code), expected, "{code}");
        }
    }

    #[tokio::test]
    async fn completion_request_timeout_is_reported_without_waiting_for_the_relay() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = ChatGptPlanClient::for_test(
            format!("http://{}/", listener.local_addr().unwrap()),
            "relay-secret".into(),
        );
        let server = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        let request = CompletionRequest {
            model: "acct-x".into(),
            system_prompt: None,
            prompt: "hello".into(),
            purpose: CompletionPurpose::Generic,
            options: RequestOptions::for_budget(
                Duration::from_millis(20),
                ModelBudget {
                    context_window_tokens: 16_384,
                    reserved_output_tokens: 1_024,
                    safety_margin_tokens: 512,
                },
            ),
        };
        let error = client.complete(&request).await.unwrap_err();
        assert_eq!(error.kind, ErrorKind::Timeout);
        server.abort();
    }
}
