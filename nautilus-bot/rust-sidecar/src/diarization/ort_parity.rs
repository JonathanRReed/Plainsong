//! Cross-runtime parity probe for the four ONNX speaker embedders.
//!
//! Test-only. Exists because CAM++ was observed to produce a completely
//! different embedding under the Rust `ort` crate than under Python
//! `onnxruntime` for the *same* input tensor once the sequence got long
//! (`artifacts/qa/voiceprint-calibration-2026-09-02.md`), while ECAPA-TDNN
//! agreed to six decimals. This probe is the reproduction: it dumps the exact
//! input tensor and the exact model output to raw little-endian `f32` files so
//! a Python script can run the identical bytes through `onnxruntime` and
//! compare, with no chance of a front-end difference confounding the result.
//!
//! It is `#[ignore]`d and env-gated because it needs the four `.onnx` files
//! (30 MB each, never committed) and a WAV fixture staged outside the repo:
//!
//! ```text
//! PLAINSONG_ORT_PARITY_MODELS=<dir with the four .onnx> \
//! PLAINSONG_ORT_PARITY_WAV=<16 kHz mono wav> \
//! PLAINSONG_ORT_PARITY_OUT=<dump dir> \
//! cargo test --locked --lib ort_parity -- --ignored --nocapture
//! ```
//!
//! See `artifacts/qa/campplus-divergence-2026-09-02.md` for the numbers this
//! produced and the decision that followed.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use ndarray::IxDyn;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;

/// Every embedding model the app ships, in the order the receipt tabulates.
const MODEL_IDS: [&str; 4] = [
    "ecapa_tdnn_speaker",
    "campplus_speaker",
    "resnet34_speaker",
    "eres2netv2_speaker",
];

/// Frame counts swept by default. 198 is what the product actually feeds: a
/// 2.0 s window is 32000 samples, and `compute_fbank_features` turns that into
/// `(32000 - 400) / 160 + 1 = 198` frames. The rest bracket it so a pattern can
/// be located rather than merely observed. Override with a comma-separated
/// `PLAINSONG_ORT_PARITY_FRAMES`.
const DEFAULT_FRAME_COUNTS: [usize; 10] = [100, 198, 200, 220, 240, 250, 260, 280, 300, 400];

fn frame_counts() -> Vec<usize> {
    match std::env::var("PLAINSONG_ORT_PARITY_FRAMES") {
        Ok(raw) if !raw.trim().is_empty() => raw
            .split(',')
            .filter_map(|part| part.trim().parse::<usize>().ok())
            .collect(),
        _ => DEFAULT_FRAME_COUNTS.to_vec(),
    }
}

/// One session configuration the probe measures: a name used in the dump
/// filenames and the receipt's tables, a graph optimization level, and an
/// optional comma-separated list of individual ORT transformers to switch off
/// (`optimization.disable_specified_optimizers`).
struct OptConfig {
    name: &'static str,
    level: GraphOptimizationLevel,
    disabled_optimizers: Option<&'static str>,
}

const OPT_LEVELS: [OptConfig; 5] = [
    OptConfig {
        name: "disable",
        level: GraphOptimizationLevel::Disable,
        disabled_optimizers: None,
    },
    OptConfig {
        name: "level1",
        level: GraphOptimizationLevel::Level1,
        disabled_optimizers: None,
    },
    OptConfig {
        name: "level2",
        level: GraphOptimizationLevel::Level2,
        disabled_optimizers: None,
    },
    OptConfig {
        name: "level3",
        level: GraphOptimizationLevel::Level3,
        disabled_optimizers: None,
    },
    // The surgical fix that was tried first and does NOT work: naming the
    // transformer that rewrites CAM++'s no-op `Pad` into its `AveragePool`.
    // `optimization.disable_specified_optimizers` leaves the rewritten graph
    // and the wrong output bit-identical, under ORT 1.28 and 1.29 alike. Kept
    // in the probe so the dead end stays reproducible rather than folklore.
    OptConfig {
        name: "level3-nopadfusion",
        level: GraphOptimizationLevel::Level3,
        disabled_optimizers: Some("PadFusion"),
    },
];

fn env_dir(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).map(PathBuf::from)
}

/// Comma-separated allow-list from `key`; empty/unset means "everything".
/// A wide frame sweep over four models at four optimization levels takes long
/// enough to be annoying, and once one model at one level is the suspect there
/// is no reason to re-run the other fifteen combinations.
fn env_filter(key: &str) -> Option<Vec<String>> {
    match std::env::var(key) {
        Ok(raw) if !raw.trim().is_empty() => Some(
            raw.split(',')
                .map(|part| part.trim().to_string())
                .filter(|part| !part.is_empty())
                .collect(),
        ),
        _ => None,
    }
}

fn selected(filter: &Option<Vec<String>>, name: &str) -> bool {
    filter
        .as_ref()
        .is_none_or(|allowed| allowed.iter().any(|entry| entry == name))
}

/// Write a slice of `f32` as raw little-endian bytes.
fn write_f32(path: &Path, values: &[f32]) -> Result<()> {
    let mut file = fs::File::create(path)
        .with_context(|| format!("Failed to create dump file {}", path.display()))?;
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    file.write_all(&bytes)
        .with_context(|| format!("Failed to write dump file {}", path.display()))?;
    Ok(())
}

/// Build a session exactly the way `embedder::load_embedding_session` does --
/// through `ort_utils::build_session_with` with `with_intra_threads(1)` -- but
/// with the graph optimization level overridden. `with_optimization_level`
/// applied inside the closure runs after the helper's own call, so the last
/// one wins.
fn session_at(
    model_path: &Path,
    config: &OptConfig,
    optimized_out: Option<PathBuf>,
) -> Result<Session> {
    let level = config.level;
    let disabled_optimizers = config.disabled_optimizers;
    crate::ort_utils::build_session_with(model_path, move |builder| {
        let builder = builder
            .with_intra_threads(1)
            .map_err(|error| anyhow!("Failed to configure ONNX intra-op threads: {error}"))?
            .with_optimization_level(level)
            .map_err(|error| anyhow!("Failed to set ONNX opt level: {error}"))?;
        let builder = match disabled_optimizers {
            Some(list) => builder
                .with_disabled_optimizers(list)
                .map_err(|error| anyhow!("Failed to disable ORT optimizers: {error}"))?,
            None => builder,
        };
        // Serializing the post-optimization graph is what separates "the
        // rewrite is wrong" from "the kernel is wrong": the dumped graph can be
        // replayed under a different ONNX Runtime build with optimization off.
        match optimized_out {
            Some(path) => builder
                .with_optimized_model_path(path)
                .map_err(|error| anyhow!("Failed to set optimized model path: {error}")),
            None => Ok(builder),
        }
    })
}

/// Run one `[1, frames, 80]` tensor through a session and return the flattened
/// output, *without* the pooling and L2 normalization
/// `embedder::finalize_embedding` applies, so the comparison is against the
/// model's raw output rather than against our post-processing.
fn raw_embedding(session: &mut Session, fbank: &[f32], frames: usize) -> Result<Vec<f32>> {
    let array = ndarray::Array::from_shape_vec(IxDyn(&[1, frames, 80]), fbank.to_vec())
        .context("Failed to shape probe input tensor")?;
    let tensor = Tensor::from_array(array).context("Failed to build probe input tensor")?;
    let outputs = session
        .run(ort::inputs![tensor])
        .context("Probe inference failed")?;
    for (_, output) in outputs.iter() {
        if let Ok(view) = output.try_extract_array::<f32>() {
            return Ok(view.iter().copied().collect());
        }
    }
    Err(anyhow!("Probe model produced no f32 output"))
}

/// Reproduce the CAM++ divergence: dump the input tensors and every model's
/// output at every frame count and optimization level, for a Python
/// `onnxruntime` run to compare against.
#[test]
#[ignore = "needs the four .onnx files and a wav fixture staged outside the repo"]
fn ort_parity_dump() -> Result<()> {
    let models_dir = env_dir("PLAINSONG_ORT_PARITY_MODELS")
        .ok_or_else(|| anyhow!("PLAINSONG_ORT_PARITY_MODELS is not set"))?;
    let wav = env_dir("PLAINSONG_ORT_PARITY_WAV")
        .ok_or_else(|| anyhow!("PLAINSONG_ORT_PARITY_WAV is not set"))?;
    let out_dir = env_dir("PLAINSONG_ORT_PARITY_OUT")
        .ok_or_else(|| anyhow!("PLAINSONG_ORT_PARITY_OUT is not set"))?;
    fs::create_dir_all(&out_dir).context("Failed to create dump directory")?;

    let samples = crate::audio::utils::load_audio_file(&wav).context("Failed to load probe wav")?;
    // The app's own front end, so nothing about feature extraction can differ
    // between the two runtimes: both consume the bytes this writes.
    let fbank = super::embedder::compute_fbank_features(&samples, 16000, 80)?;
    let available_frames = fbank.len() / 80;
    println!(
        "probe wav: {} samples, {available_frames} frames",
        samples.len()
    );

    let frame_counts = frame_counts();
    for &frames in &frame_counts {
        assert!(
            frames <= available_frames,
            "probe wav is too short for {frames} frames (has {available_frames})"
        );
        write_f32(
            &out_dir.join(format!("fbank_{frames}.f32")),
            &fbank[..frames * 80],
        )?;
    }

    let optimized_dir = env_dir("PLAINSONG_ORT_PARITY_OPTIMIZED_OUT");
    if let Some(dir) = optimized_dir.as_ref() {
        fs::create_dir_all(dir).context("Failed to create optimized-graph directory")?;
    }
    let model_filter = env_filter("PLAINSONG_ORT_PARITY_ONLY_MODELS");
    let level_filter = env_filter("PLAINSONG_ORT_PARITY_ONLY_LEVELS");

    for model_id in MODEL_IDS {
        if !selected(&model_filter, model_id) {
            continue;
        }
        let model_path = models_dir.join(format!("{model_id}.onnx"));
        assert!(
            model_path.exists(),
            "missing staged model {}",
            model_path.display()
        );
        for config in &OPT_LEVELS {
            let level_name = config.name;
            if !selected(&level_filter, level_name) {
                continue;
            }
            let optimized_out = optimized_dir
                .as_ref()
                .map(|dir| dir.join(format!("optimized_{model_id}_{level_name}.onnx")));
            let mut session = session_at(&model_path, config, optimized_out)?;
            for &frames in &frame_counts {
                let embedding = raw_embedding(&mut session, &fbank[..frames * 80], frames)?;
                write_f32(
                    &out_dir.join(format!("emb_{model_id}_{level_name}_{frames}.f32")),
                    &embedding,
                )?;
            }
            println!("dumped {model_id} @ {level_name}");
        }
    }

    Ok(())
}

/// Cost of the workaround: time a session build and a batch of inferences at
/// the length the product actually feeds, at each optimization level, so the
/// receipt can state what dropping CAM++ to `Disable` costs.
#[test]
#[ignore = "timing probe; needs the staged models and a wav fixture"]
fn ort_parity_timing() -> Result<()> {
    let models_dir = env_dir("PLAINSONG_ORT_PARITY_MODELS")
        .ok_or_else(|| anyhow!("PLAINSONG_ORT_PARITY_MODELS is not set"))?;
    let wav = env_dir("PLAINSONG_ORT_PARITY_WAV")
        .ok_or_else(|| anyhow!("PLAINSONG_ORT_PARITY_WAV is not set"))?;
    let samples = crate::audio::utils::load_audio_file(&wav).context("Failed to load probe wav")?;
    let fbank = super::embedder::compute_fbank_features(&samples, 16000, 80)?;

    let frames = frame_counts().first().copied().unwrap_or(198);
    let iterations: usize = std::env::var("PLAINSONG_ORT_PARITY_ITERATIONS")
        .ok()
        .and_then(|raw| raw.parse().ok())
        .unwrap_or(30);
    let model_filter = env_filter("PLAINSONG_ORT_PARITY_ONLY_MODELS");
    let level_filter = env_filter("PLAINSONG_ORT_PARITY_ONLY_LEVELS");

    println!("frames={frames} iterations={iterations}");
    for model_id in MODEL_IDS {
        if !selected(&model_filter, model_id) {
            continue;
        }
        let model_path = models_dir.join(format!("{model_id}.onnx"));
        for config in &OPT_LEVELS {
            if !selected(&level_filter, config.name) {
                continue;
            }
            let build_start = std::time::Instant::now();
            let mut session = session_at(&model_path, config, None)?;
            let build_ms = build_start.elapsed().as_secs_f64() * 1000.0;

            // One warm-up run so the measured samples exclude the first call's
            // arena allocation.
            let _ = raw_embedding(&mut session, &fbank[..frames * 80], frames)?;
            let mut timings_ms = Vec::with_capacity(iterations);
            for _ in 0..iterations {
                let start = std::time::Instant::now();
                let _ = raw_embedding(&mut session, &fbank[..frames * 80], frames)?;
                timings_ms.push(start.elapsed().as_secs_f64() * 1000.0);
            }
            timings_ms.sort_by(|a, b| a.partial_cmp(b).expect("no NaN timings"));
            let p50 = timings_ms[timings_ms.len() / 2];
            let p95 = timings_ms[(timings_ms.len() * 95 / 100).min(timings_ms.len() - 1)];
            println!(
                "{model_id:>20} {:>20} build {build_ms:8.1} ms   infer p50 {p50:7.2} ms  p95 {p95:7.2} ms",
                config.name
            );
        }
    }
    Ok(())
}
