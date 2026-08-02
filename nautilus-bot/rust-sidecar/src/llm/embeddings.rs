//! Ollama embedding integration for vector-based transcript search.
//!
//! Uses the Ollama `/api/embed` endpoint to generate embeddings from text,
//! enabling semantic search over transcript segments.

use super::transport::{
    read_error_body, read_json_body, BATCH_EMBEDDING_BODY_LIMIT, EMBEDDING_BODY_LIMIT,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const OLLAMA_DEFAULT_URL: &str = "http://localhost:11434";

#[derive(Debug, Serialize)]
struct EmbedRequest {
    model: String,
    input: String,
}

#[derive(Debug, Deserialize)]
struct EmbedResponse {
    embeddings: Vec<Vec<f32>>,
}

#[derive(Debug, Serialize)]
struct BatchEmbedRequest {
    model: String,
    input: Vec<String>,
}

pub struct OllamaEmbedder {
    base_url: String,
    client: reqwest::Client,
}

impl OllamaEmbedder {
    pub fn new() -> Self {
        Self {
            base_url: OLLAMA_DEFAULT_URL.to_string(),
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .expect("reqwest client"),
        }
    }

    pub async fn is_available(&self) -> bool {
        match self
            .client
            .get(format!("{}/api/tags", self.base_url))
            .send()
            .await
        {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }

    pub async fn embed(&self, model: &str, input: &str) -> Result<Vec<f32>> {
        let request = EmbedRequest {
            model: model.to_string(),
            input: input.to_string(),
        };

        let response = self
            .client
            .post(format!("{}/api/embed", self.base_url))
            .json(&request)
            .send()
            .await
            .context("Failed to send embedding request to Ollama")?;

        if !response.status().is_success() {
            let status = response.status();
            let text = read_error_body(response).await;
            anyhow::bail!("Ollama embed returned {}: {}", status, text);
        }

        let data: EmbedResponse = read_json_body(response, EMBEDDING_BODY_LIMIT)
            .await
            .context("Failed to read or parse bounded Ollama embedding response")?;

        data.embeddings
            .into_iter()
            .next()
            .context("Ollama returned no embeddings")
    }

    pub async fn embed_batch(&self, model: &str, inputs: &[String]) -> Result<Vec<Vec<f32>>> {
        if inputs.is_empty() {
            return Ok(Vec::new());
        }

        let request = BatchEmbedRequest {
            model: model.to_string(),
            input: inputs.to_vec(),
        };

        let response = self
            .client
            .post(format!("{}/api/embed", self.base_url))
            .json(&request)
            .send()
            .await
            .context("Failed to send batch embedding request to Ollama")?;

        if !response.status().is_success() {
            let status = response.status();
            let text = read_error_body(response).await;
            anyhow::bail!("Ollama batch embed returned {}: {}", status, text);
        }

        let data: EmbedResponse = read_json_body(response, BATCH_EMBEDDING_BODY_LIMIT)
            .await
            .context("Failed to read or parse bounded Ollama batch embedding response")?;

        Ok(data.embeddings)
    }
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a * norm_b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cosine_similarity_identical() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![1.0, 0.0, 0.0];
        assert!((cosine_similarity(&a, &b) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_cosine_similarity_orthogonal() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        assert!(cosine_similarity(&a, &b).abs() < 1e-6);
    }

    #[test]
    fn test_cosine_similarity_zero_vector() {
        let a = vec![0.0, 0.0];
        let b = vec![1.0, 1.0];
        assert_eq!(cosine_similarity(&a, &b), 0.0);
    }
}
