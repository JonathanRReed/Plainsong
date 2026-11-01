//! Ollama embedding integration for vector-based transcript search.
//!
//! Uses the Ollama `/api/embed` endpoint to generate embeddings from text,
//! enabling semantic search over transcript segments.

use super::transport::{read_json_body, BATCH_EMBEDDING_BODY_LIMIT, EMBEDDING_BODY_LIMIT};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const OLLAMA_DEFAULT_URL: &str = "http://localhost:11434";

#[derive(Debug, Deserialize)]
struct EmbedResponse {
    embeddings: Vec<Vec<f32>>,
}

#[derive(Debug, Serialize)]
struct BatchEmbedRequest {
    model: String,
    input: Vec<String>,
    truncate: bool,
    options: EmbeddingOptions,
}

#[derive(Debug, Serialize)]
struct EmbeddingOptions {
    num_ctx: i32,
}

#[derive(Clone)]
pub struct OllamaEmbedder {
    base_url: String,
    client: reqwest::Client,
    admission: super::OllamaClient,
    wait_timeout: std::time::Duration,
}

impl OllamaEmbedder {
    pub fn new() -> Self {
        Self {
            base_url: OLLAMA_DEFAULT_URL.to_string(),
            admission: super::OllamaClient::new(),
            client: reqwest::Client::new(),
            wait_timeout: std::time::Duration::from_secs(60),
        }
    }

    pub async fn is_available(&self) -> bool {
        match self
            .client
            .get(format!("{}/api/tags", self.base_url))
            .timeout(self.wait_timeout)
            .send()
            .await
        {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }

    #[cfg(test)]
    async fn embed(&self, model: &str, input: &str) -> Result<Vec<f32>> {
        self.embed_batch(model, &[input.to_owned()])
            .await?
            .into_iter()
            .next()
            .context("Ollama returned no embeddings")
    }

    pub async fn embed_batch(&self, model: &str, inputs: &[String]) -> Result<Vec<Vec<f32>>> {
        if inputs.is_empty() {
            return Ok(Vec::new());
        }
        if inputs.iter().any(|input| input.len() > 64 * 1024) {
            anyhow::bail!(
                "An embedding input is too large. Meeting text was not truncated or sent."
            );
        }
        let mut embeddings: Vec<Vec<f32>> = Vec::with_capacity(inputs.len());
        let mut offset = 0;
        while offset < inputs.len() {
            let deadline = tokio::time::Instant::now() + self.wait_timeout;
            let owner = self.clone();
            let model = model.to_owned();
            // Admission already limits each batch to eight. Do not retain the whole meeting.
            let batch = inputs[offset..inputs.len().min(offset + 8)].to_vec();
            let (result, receiver) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let outcome = owner.embed_owned(&model, batch, &result, deadline).await;
                let outcome = if let Some(message) = owner.admission.local_refusal() {
                    outcome.context(message)
                } else {
                    outcome
                };
                let _ = result.send(outcome);
            });
            let (data, count) = tokio::time::timeout_at(deadline, receiver).await
                .context("Stopped waiting for Ollama embeddings; the request may still be running and local processing remains protected")?
                .context("Ollama embedding owner ended; completion could not be confirmed")??;
            let dimensions = embeddings
                .first()
                .map(Vec::len)
                .or_else(|| data.embeddings.first().map(Vec::len));
            if data.embeddings.len() != count
                || dimensions.is_none_or(|size| size == 0)
                || data.embeddings.iter().any(|vector| {
                    Some(vector.len()) != dimensions
                        || vector.iter().any(|value| !value.is_finite())
                })
            {
                anyhow::bail!("Ollama returned incomplete or inconsistent embeddings. The batch was not accepted.");
            }
            embeddings.extend(data.embeddings);
            offset += count;
        }
        Ok(embeddings)
    }

    async fn embed_owned(
        &self,
        model: &str,
        inputs: Vec<String>,
        caller: &tokio::sync::oneshot::Sender<Result<(EmbedResponse, usize)>>,
        deadline: tokio::time::Instant,
    ) -> Result<(EmbedResponse, usize)> {
        let (permit, context, count) = self
            .admission
            .prepare_embeddings(model, inputs.len())
            .await?;
        let mut operation = self.admission.local_request_guard(permit);
        let request = BatchEmbedRequest {
            model: model.to_owned(),
            input: inputs.into_iter().take(count).collect(),
            truncate: false,
            options: EmbeddingOptions { num_ctx: context },
        };
        let http_request = self
            .client
            .post(format!("{}/api/embed", self.base_url))
            .timeout(self.admission.local_response_timeout())
            .json(&request);
        if caller.is_closed() || tokio::time::Instant::now() >= deadline {
            anyhow::bail!("Ollama embedding caller budget expired before meeting text was sent");
        }
        operation
            .begin_dispatch("embed")
            .map_err(anyhow::Error::msg)?;
        #[cfg(test)]
        self.admission.wait_after_test_dispatch().await;
        if caller.is_closed() || tokio::time::Instant::now() >= deadline {
            operation.cancel_before_send().map_err(anyhow::Error::msg)?;
            anyhow::bail!("Ollama embedding caller budget expired before meeting text was sent");
        }
        let response = http_request
            .send()
            .await
            .context("Failed to send embedding request to Ollama")?;
        if !response.status().is_success() {
            let status = response.status();
            let text = super::ollama::read_local_error(response, &mut operation).await?;
            anyhow::bail!("Ollama embed returned {}: {}", status, text);
        }
        let response_limit = if count == 1 {
            EMBEDDING_BODY_LIMIT
        } else {
            BATCH_EMBEDDING_BODY_LIMIT
        };
        let data: EmbedResponse = read_json_body(response, response_limit)
            .await
            .context("Failed to read or parse bounded Ollama embedding response")?;
        operation.confirm_terminal().map_err(anyhow::Error::msg)?;
        Ok((data, count))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::ollama::tests::mock_json_server;
    const META: &str = r#"{"model_info":{"general.architecture":"bert","bert.context_length":2048,"bert.embedding_length":768,"bert.attention.head_count":12,"bert.block_count":12}}"#;
    const EMPTY: &str = r#"{"models":[]}"#;
    const TAGS: &str = r#"{"models":[{"name":"model:latest","size":1073741824}]}"#;
    fn test_embedder(url: String, memory: fn() -> Option<u64>) -> OllamaEmbedder {
        let mut embedder = OllamaEmbedder::new();
        embedder.base_url = url.clone();
        embedder.admission = super::super::OllamaClient::with_base_url_and_timeout(
            url,
            std::time::Duration::from_secs(2),
        )
        .with_memory_probe(memory);
        embedder
    }

    #[tokio::test]
    async fn caller_abort_keeps_batch_one_owned_and_never_submits_batch_two() {
        let (url, ready, release, captured) = super::super::ollama::tests::controlled_body_server(
            vec![META, EMPTY, TAGS],
            r#"{"embeddings":[[1,0],[1,0],[1,0],[1,0],[1,0],[1,0],[1,0],[1,0]]}"#,
            None,
        )
        .await;
        let embedder = test_embedder(url, || Some(64 * 1024 * 1024 * 1024));
        let admission = embedder.admission.clone();
        let caller = tokio::spawn(async move {
            let inputs: Vec<_> = (0..10).map(|index| format!("public row {index}")).collect();
            embedder.embed_batch("model", &inputs).await
        });
        ready.await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert!(admission.local_operation().is_err());
        release.send(true).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while admission.local_operation().is_err() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let requests = captured.await.unwrap();
        assert_eq!(
            requests.iter().filter(|row| row.0 == "/api/embed").count(),
            1
        );
        assert_eq!(
            requests.last().unwrap().1["input"]
                .as_array()
                .unwrap()
                .len(),
            8
        );
    }

    #[tokio::test]
    async fn caller_embedding_deadline_keeps_the_gate_until_the_response_finishes() {
        let (url, ready, release, captured) = super::super::ollama::tests::controlled_body_server(
            vec![META, EMPTY, TAGS],
            r#"{"embeddings":[[0.25,0.75]]}"#,
            None,
        )
        .await;
        let mut embedder = test_embedder(url, || Some(64 * 1024 * 1024 * 1024));
        embedder.wait_timeout = std::time::Duration::from_millis(250);
        let admission = embedder.admission.clone();
        let caller = tokio::spawn(async move { embedder.embed("model", "public query").await });
        ready.await.unwrap();
        assert!(caller
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("may still be running"));
        assert!(admission.local_operation().is_err());
        release.send(true).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while admission.local_operation().is_err() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        captured.await.unwrap();
    }

    #[tokio::test]
    async fn truncated_embedding_response_never_releases_local_admission() {
        let (url, ready, release, captured) = super::super::ollama::tests::controlled_body_server(
            vec![META, EMPTY, TAGS],
            r#"{"embeddings":[[1,0]]}"#,
            Some(1000),
        )
        .await;
        let embedder = test_embedder(url, || Some(64 * 1024 * 1024 * 1024));
        let admission = embedder.admission.clone();
        let caller = tokio::spawn(async move { embedder.embed("model", "public query").await });
        ready.await.unwrap();
        release.send(true).unwrap();
        assert!(caller.await.unwrap().is_err());
        assert!(admission
            .local_operation()
            .unwrap_err()
            .contains("may still be running"));
        captured.await.unwrap();
    }

    #[tokio::test]
    async fn embedding_deadline_after_persistence_prevents_post_with_an_open_receiver() {
        let (url, captured) = mock_json_server(vec![META, EMPTY, TAGS]).await;
        let barrier = std::sync::Arc::new(super::super::ollama::DispatchBarrier::default());
        let mut embedder = test_embedder(url, || Some(64 * 1024 * 1024 * 1024));
        embedder.admission = embedder.admission.with_dispatch_barrier(barrier.clone());
        let admission = embedder.admission.clone();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        let (result, mut receiver) = tokio::sync::oneshot::channel();
        let owner = tokio::spawn(async move {
            embedder
                .embed_owned("model", vec!["public query".into()], &result, deadline)
                .await
        });
        barrier.persisted.notified().await;
        tokio::time::pause();
        tokio::time::advance(std::time::Duration::from_secs(11)).await;
        assert!(
            matches!(
                receiver.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
            ),
            "the receiver must still be open after the deadline"
        );
        barrier.release.notify_one();
        tokio::time::resume();
        assert!(owner
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("budget expired"));
        assert!(admission.local_operation().is_ok());
        let requests = captured.await.unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests.iter().all(|row| row.0 != "/api/embed"));
    }

    #[tokio::test]
    async fn a_single_query_returns_its_vector_without_truncation() {
        let (url, captured) =
            mock_json_server(vec![META, EMPTY, TAGS, r#"{"embeddings":[[0.25,0.75]]}"#]).await;
        let embedder = test_embedder(url, || Some(64 * 1024 * 1024 * 1024));
        assert_eq!(
            embedder.embed("model", "public query").await.unwrap(),
            vec![0.25, 0.75]
        );
        let requests = captured.await.unwrap();
        assert_eq!(requests[3].1["input"], serde_json::json!(["public query"]));
        assert_eq!(requests[3].1["truncate"], false);
    }

    #[tokio::test]
    async fn admission_refuses_before_meeting_text_is_sent() {
        for responses in [
            vec![META, EMPTY, TAGS],
            vec![r#"{"remote_model":"cloud"}"#],
            vec![
                META,
                r#"{"models":[{"name":"other","size":1073741824,"context_length":2048}]}"#,
            ],
            vec![r#"{"model_info":{}}"#],
        ] {
            let (url, captured) = mock_json_server(responses).await;
            let embedder = test_embedder(url, || Some(2 * 1024 * 1024 * 1024));
            assert!(embedder
                .embed("model", "PUBLIC_MEETING_MARKER")
                .await
                .is_err());
            assert!(captured
                .await
                .unwrap()
                .iter()
                .all(|row| row.0 != "/api/embed"));
        }
    }

    #[tokio::test]
    async fn batches_are_bounded_ordered_and_never_truncated() {
        let (url, captured) = mock_json_server(vec![
            META,
            EMPTY,
            TAGS,
            r#"{"embeddings":[[1,0],[1,0],[1,0],[1,0],[1,0],[1,0],[1,0],[1,0]]}"#,
            META,
            EMPTY,
            TAGS,
            r#"{"embeddings":[[1,0],[1,0]]}"#,
        ])
        .await;
        let embedder = test_embedder(url, || Some(64 * 1024 * 1024 * 1024));
        let inputs: Vec<_> = (0..10).map(|value| format!("public row {value}")).collect();
        assert_eq!(
            embedder.embed_batch("model", &inputs).await.unwrap().len(),
            10
        );
        let requests = captured.await.unwrap();
        let batches: Vec<_> = requests
            .iter()
            .filter(|row| row.0 == "/api/embed")
            .map(|row| &row.1)
            .collect();
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0]["input"], serde_json::json!(inputs[..8]));
        assert_eq!(batches[1]["input"], serde_json::json!(inputs[8..]));
        for body in batches {
            assert_eq!(body["truncate"], false);
            assert_eq!(body["options"]["num_ctx"], 2048);
            assert!(body.get("keep_alive").is_none());
        }
    }

    #[tokio::test]
    async fn incomplete_vectors_are_not_accepted_and_empty_batches_do_no_work() {
        let (url, captured) =
            mock_json_server(vec![META, EMPTY, TAGS, r#"{"embeddings":[[1,0]]}"#]).await;
        let embedder = test_embedder(url, || Some(64 * 1024 * 1024 * 1024));
        assert!(embedder.embed_batch("model", &[]).await.unwrap().is_empty());
        assert!(embedder
            .embed_batch("model", &["one".into(), "two".into()])
            .await
            .unwrap_err()
            .to_string()
            .contains("incomplete"));
        assert_eq!(captured.await.unwrap().len(), 4);
    }

    #[tokio::test]
    async fn another_local_operation_prevents_embedding_requests() {
        let (url, captured) = mock_json_server(vec![]).await;
        let embedder = test_embedder(url, || Some(64 * 1024 * 1024 * 1024));
        let other = embedder.admission.clone();
        let _lease = other.local_operation().unwrap();
        assert!(embedder
            .embed("model", "public text")
            .await
            .unwrap_err()
            .to_string()
            .contains("Another local text operation"));
        assert!(captured.await.unwrap().is_empty());
    }
}
