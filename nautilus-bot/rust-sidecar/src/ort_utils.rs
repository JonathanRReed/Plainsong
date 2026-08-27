//! Shared helpers for ONNX Runtime session creation.
//!
//! The main purpose of this module is to provide [`build_session`] — a thin
//! wrapper around `ort::Session::builder()` that optionally registers the
//! CoreML Execution Provider on macOS when compiled with the `ort-coreml`
//! Cargo feature. CoreML routes eligible ONNX ops to the Apple Neural Engine
//! and GPU, which can accelerate inference for simple models (Silero VAD,
//! Wespeaker speaker embeddings, Moonshine).
//!
//! # When NOT to use CoreML
//!
//! CoreML is deliberately **not** used for:
//! - **Parakeet TDT transducer models**: Empirical reports from the
//!   sherpa-onnx and corti projects show CoreML EP is unstable for
//!   transducer decoders and can be 6× slower than CPU for streaming
//!   Zipformer encoders on Apple Silicon. Parakeet already runs at
//!   30–60× realtime on CPU, so the risk/reward is not favourable.
//! - **Qwen3-ASR int4 decoders**: CoreML does not support int4 matmul
//!   efficiently. The decoders use `build_session_no_coreml` to avoid
//!   EP dispatch overhead. The Qwen3 encoder still uses CoreML.
//!
//! # Graceful fallback
//!
//! If the `ort-coreml` feature is not enabled, ONNX Runtime was not compiled
//! with CoreML support, or CoreML initialization fails, the session silently
//! falls back to the default CPU execution provider. A `tracing` log line
//! records which path was taken so performance issues can be diagnosed.

#![cfg(feature = "ort")]

use anyhow::{Context, Result};
use ort::session::{builder::GraphOptimizationLevel, Session};
use std::path::Path;

/// Build an ONNX Runtime `Session` from `model_path` with graph optimisation
/// level 3 and, on macOS when compiled with `ort-coreml`, the CoreML
/// Execution Provider registered ahead of the default CPU provider.
///
/// All session creation in the sidecar that does not need provider-specific
/// thread counts or other custom options should go through this helper so
/// that CoreML acceleration is applied consistently.
///
/// Use [`build_session_no_coreml`] for models that are known to be unstable
/// or slower with CoreML (e.g. int4-quantized Qwen3-ASR decoders, Parakeet
/// TDT transducers).
pub fn build_session(model_path: &Path) -> Result<Session> {
    build_session_with(model_path, Ok)
}

/// Build a session **without** CoreML EP, falling back to the CPU provider.
///
/// Some models are unstable or slower with CoreML:
/// - **Qwen3-ASR int4 decoders**: CoreML does not support int4 matmul
///   efficiently and may fall back to CPU anyway, but with overhead from
///   the EP dispatch layer.
/// - **Parakeet TDT transducers**: CoreML EP is 6× slower than CPU for
///   streaming transducer decoders (sherpa-onnx/corti reports).
///
/// This function still applies graph optimisation level 3 and the custom
/// configuration closure, just without the CoreML EP registration.
pub fn build_session_no_coreml<F>(model_path: &Path, configure: F) -> Result<Session>
where
    F: FnOnce(
        ort::session::builder::SessionBuilder,
    ) -> Result<ort::session::builder::SessionBuilder>,
{
    let builder = Session::builder()
        .context("Failed to create ONNX session builder")?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|error| anyhow::anyhow!("Failed to set ONNX opt level: {error}"))?;

    let mut builder = configure(builder)?;

    builder.commit_from_file(model_path).map_err(|error| {
        anyhow::anyhow!(
            "Failed to load ONNX model from {}: {error}",
            model_path.display()
        )
    })
}

/// Build a session with a customisation hook, still getting CoreML EP when
/// available. The closure receives the builder after graph optimisation and
/// CoreML EP have been configured, allowing callers to set thread counts or
/// other options before `commit_from_file`.
pub fn build_session_with<F>(model_path: &Path, configure: F) -> Result<Session>
where
    F: FnOnce(
        ort::session::builder::SessionBuilder,
    ) -> Result<ort::session::builder::SessionBuilder>,
{
    #[cfg_attr(not(feature = "ort-coreml"), allow(unused_mut))]
    let mut builder = Session::builder()
        .context("Failed to create ONNX session builder")?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|error| anyhow::anyhow!("Failed to set ONNX opt level: {error}"))?;

    #[cfg(feature = "ort-coreml")]
    {
        use ort::ep::ExecutionProvider;

        let coreml = ort::ep::coreml::CoreML::default()
            .with_compute_units(ort::ep::coreml::ComputeUnits::CPUAndNeuralEngine);

        match coreml.is_available() {
            Ok(true) => {
                tracing::info!("Registering CoreML EP for {}", model_path.display());
                builder = builder
                    .with_execution_providers([coreml.build()])
                    .map_err(|error| anyhow::anyhow!("Failed to register CoreML EP: {error}"))?;
            }
            Ok(false) => {
                tracing::info!(
                    "CoreML EP not available in this ONNX Runtime build; using CPU for {}",
                    model_path.display()
                );
            }
            Err(error) => {
                tracing::warn!(
                    "CoreML EP availability check failed for {}: {error}",
                    model_path.display()
                );
            }
        }
    }

    let mut builder = configure(builder)?;

    builder.commit_from_file(model_path).map_err(|error| {
        anyhow::anyhow!(
            "Failed to load ONNX model from {}: {error}",
            model_path.display()
        )
    })
}
