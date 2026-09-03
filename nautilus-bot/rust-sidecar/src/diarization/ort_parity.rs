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

/// The fixed length used by the committed regression reference. 300 frames is
/// deliberately one of the lengths where ORT 1.28's rewrite is catastrophically
/// wrong (cosine 0.094 against the correct answer), so the test fails loudly if
/// the workaround is ever dropped.
const REFERENCE_FRAMES: usize = 300;

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
/// A deterministic fbank-shaped `[1, frames, 80]` tensor, generated from a
/// fixed LCG so the same bytes can be produced in Python without committing a
/// 96 KB blob.
///
/// Every step is exact in binary floating point: `state >> 8` is below 2^24 and
/// therefore exactly representable in `f32`, dividing by 2^23 and multiplying
/// by 4 only move the exponent, and subtracting 1.0 from a value in [0, 2) is
/// exact. So a NumPy transcription of this loop produces bit-identical values.
/// The reference implementation lives beside the receipt as
/// `deterministic_fbank` in the lane's Python harness.
pub(super) fn deterministic_fbank(frames: usize) -> Vec<f32> {
    let mut state: u32 = 0x2545_F491;
    let mut out = Vec::with_capacity(frames * 80);
    for _ in 0..frames * 80 {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let unit = ((state >> 8) as f32) / 8_388_608.0 - 1.0;
        out.push(unit * 4.0);
    }
    out
}

/// Write the deterministic tensor and the app's own CAM++ output for it, so the
/// reference vector baked into [`campplus_matches_the_agreeing_runtime`] can be
/// regenerated and cross-checked against Python `onnxruntime`.
#[test]
#[ignore = "regenerates the committed reference vector; needs the staged models"]
fn ort_parity_reference_dump() -> Result<()> {
    let models_dir = env_dir("PLAINSONG_ORT_PARITY_MODELS")
        .ok_or_else(|| anyhow!("PLAINSONG_ORT_PARITY_MODELS is not set"))?;
    let out_dir = env_dir("PLAINSONG_ORT_PARITY_OUT")
        .ok_or_else(|| anyhow!("PLAINSONG_ORT_PARITY_OUT is not set"))?;
    fs::create_dir_all(&out_dir).context("Failed to create dump directory")?;

    let fbank = deterministic_fbank(REFERENCE_FRAMES);
    write_f32(&out_dir.join("deterministic_fbank_300.f32"), &fbank)?;

    let model_path = models_dir.join("campplus_speaker.onnx");
    let mut session = super::embedder::load_embedding_session(&model_path, "campplus_speaker")?;
    let embedding = raw_embedding(&mut session, &fbank, REFERENCE_FRAMES)?;
    write_f32(&out_dir.join("deterministic_campplus_300.f32"), &embedding)?;

    // Print it in the shape the const below wants, so regenerating is a copy.
    let norm = embedding.iter().map(|v| v * v).sum::<f32>().sqrt();
    println!("norm = {norm}");
    for chunk in embedding.chunks(6) {
        let row: Vec<String> = chunk.iter().map(|v| format!("{v:.6}")).collect();
        println!("    {},", row.join(", "));
    }
    Ok(())
}

/// CAM++'s embedding for `deterministic_fbank(300)`, as produced by Python
/// `onnxruntime` 1.19.2 on the original graph -- the runtime and the graph the
/// model was published against. The app's own session path, with the
/// `GraphOptimizationLevel::Disable` workaround in place, reproduces this to
/// cosine 1.00000000; without the workaround it scores 0.094.
///
/// Regenerate with `ort_parity_reference_dump` and cross-check against Python
/// before changing a single number here.
#[rustfmt::skip]
const CAMPPLUS_REFERENCE_300: [f32; 512] = [
    -0.16278273, -1.147386, -0.8248255, -0.9851999, 1.5960305, -1.2742232,
    0.23006654, 0.49365544, 0.53751874, 0.10937846, -0.3490845, 0.37342197,
    -0.7242114, -0.05817908, 0.4171368, -0.16702892, -0.64285, -0.8016068,
    1.2625403, 0.046041846, -0.20041391, 0.040986538, 0.55873, 1.0135972,
    -0.57977605, 0.25344008, -0.6576035, -0.30809975, 0.36516058, 0.15008032,
    -0.23953557, 0.4470396, -0.93643373, 0.8612331, -1.7614931, 0.31023484,
    -0.80277073, -0.093948066, -0.5486492, -0.7666762, -0.99477625, 0.09043819,
    -0.014194071, -0.2771337, -0.57765675, -0.7381882, 0.22364855, 0.15754008,
    0.6343324, -1.1192759, 0.46176928, 0.96322036, -0.43791705, -0.9461206,
    -0.82215846, 0.57169384, 0.26037347, 1.2198815, 0.1331234, -0.9772268,
    0.42833793, 0.4088712, -0.06229627, 0.009234399, 0.97560155, -0.15859249,
    -1.7379677, 1.1818359, 0.47249246, 0.056868613, -0.8341987, -0.6978435,
    0.34545374, -0.14368804, -0.75728106, -1.0727582, -0.8899144, -0.84278417,
    -0.27128035, -0.21017241, 0.15576735, 0.6124277, 0.32851398, -0.013032634,
    -0.14135063, -0.8281063, 1.7439628, -0.67577255, 0.72642696, 0.31319183,
    -0.6277634, 0.23287836, 0.03789705, -0.8966118, -1.0180234, -0.10751307,
    -0.10466251, -0.89230007, 0.72238636, 0.030661464, -0.25978696, 0.6943689,
    0.10268092, 0.8186533, 0.41170752, 0.60474205, -0.77159846, 0.12781715,
    1.2629063, 0.22209783, -0.62687206, -0.42743355, 0.09119721, 0.16202137,
    0.42930862, -0.7251897, 1.2858269, 1.4005342, -0.7719767, 0.6612103,
    0.5453788, -0.24401325, 0.8345382, 0.8862847, 0.5509158, 0.8372153,
    -0.8064518, -0.16465329, 0.10145408, 0.23391879, -0.94695413, 0.29401058,
    0.56312126, -0.5993888, -0.5132069, 1.4285021, 1.0411141, 0.7183168,
    0.2034576, -0.7371398, -0.049233705, -0.22047532, 0.8472885, 0.33409515,
    0.3407176, -0.63672477, 0.28109074, -0.34067765, -0.4294284, -0.015004098,
    0.88704836, -0.5944553, 0.38276416, -0.73867446, -0.14090215, 0.35943097,
    0.6124271, 0.1704408, -0.2604847, 0.018142909, -0.89856434, -0.8459948,
    0.042499706, -0.39357066, -0.42152357, -0.9942579, -0.2383256, 0.17302655,
    0.0072746277, 1.0075512, -0.37255853, -0.74508035, 0.5111051, 0.18416762,
    0.5957525, 0.057430744, 0.08789742, 0.8920104, 0.41713285, 0.89207864,
    0.7719351, -0.37679812, 0.5429648, 0.14166185, 0.32922855, 1.2252579,
    -0.095997036, -0.07705155, -0.318336, -0.19551063, -0.3031158, 0.23450297,
    -0.52419376, -1.1826572, 0.13467044, 0.2928453, 0.26488745, 0.51821995,
    -0.4742509, -0.5986807, 0.67638856, -0.42520702, -0.42415512, 0.2611612,
    -0.33224922, -0.0054422915, 0.54679334, -1.06814, 0.027711987, 0.7312888,
    1.0000062, -0.32547393, 0.0032051504, 0.064326584, 0.12015988, -0.72076035,
    0.9230711, 0.15269507, 1.1769061, -0.23822773, 0.329886, -0.4701478,
    -0.09861799, -0.711368, -0.13129379, -0.9153723, -0.47570533, -0.43333793,
    -0.29333535, 0.8346482, 0.08365869, -0.5094632, -0.7572224, 0.18248397,
    0.2962886, -0.8502662, 0.54310167, 0.6297177, -0.6471162, -0.044049002,
    -0.38831085, 0.5302672, 1.4214337, 0.77801293, 0.7068827, 0.14538288,
    -0.8453323, 0.71065795, 0.19427913, -0.33246297, -0.01830145, 0.4180072,
    0.8000545, 0.53188986, -0.09570572, -0.4191668, -0.08604318, -0.3501653,
    0.6704647, -0.49491054, 1.5397239, 0.21134189, 0.7587366, 0.57195127,
    -0.27059543, 0.023652315, 1.1740671, 0.5894995, -0.4187802, -0.4844968,
    -1.3394477, 1.1545091, -1.0429223, 0.055872083, 0.10686022, 0.0029987693,
    0.5291085, 0.53968525, -0.98534364, -0.23372656, 0.14994161, -0.36750716,
    0.1857625, 0.6761407, -0.20473146, 0.7270113, -0.98067915, -0.35090065,
    0.20156044, 0.18904352, -1.9637167, -0.43791014, -0.29703504, 0.5922452,
    -0.22203007, 1.1466125, -0.40940863, -1.6772722, -0.57741606, -0.8646544,
    0.6811685, -0.6159573, -0.111200154, 0.22491312, -1.3719635, -0.6366607,
    1.7025098, 0.24191886, -0.20155227, 0.26633072, 0.42775637, -0.26842713,
    -0.9847357, 1.4797943, -0.19021797, 0.16656393, 0.4108902, 0.8063606,
    -0.18504527, 0.5933782, 0.8579396, -0.33148634, -0.11890437, 0.14796169,
    -0.6078901, 0.53044784, 0.8004853, 0.9210192, -0.54384714, -0.38007128,
    -1.8102232, 0.19808102, -0.75200945, -0.40628046, -0.7784669, -0.7508179,
    -0.14444125, -0.4282835, 0.07949281, -0.7748728, -0.16201013, 0.35321835,
    -0.2556637, 0.14531094, 0.3000635, 1.8512467, -0.59872603, -0.45923644,
    1.0782617, -0.5707362, -0.23939294, -0.9810368, 0.29209417, 0.7434287,
    0.18366203, 0.18713218, -0.7786822, 0.505482, -0.22997296, 1.0390637,
    -0.66632557, 0.43284285, -0.9625777, 1.1594275, -0.038734198, -0.23426527,
    1.2970184, 1.4932394, 0.024702936, 0.36770135, -0.14857271, -0.5920939,
    -0.18142581, 0.6138221, -0.52363384, -0.5450163, -0.35496897, -1.0268598,
    0.19859844, -0.268075, 0.11862862, 0.5181152, -0.2611174, -0.5448354,
    -0.20109762, 0.8501799, 0.19365823, -0.17842117, -0.81892955, -0.5759648,
    0.5663879, 0.737728, 0.012738079, 1.5417695, 0.5556196, -0.16253144,
    0.61375344, -0.32867455, -0.8773168, 0.17259195, -0.7170814, 0.38621122,
    0.7636866, 0.3245569, 0.8871261, 0.5591929, 1.0575627, 1.4382215,
    0.82441664, -0.16356906, 0.043628216, -1.1916586, -0.93638164, -0.009415686,
    0.45879942, 0.24627548, -0.34604025, 0.43561465, -0.43437254, 0.15003765,
    -0.20156384, 0.7011483, -0.9216467, 0.072824, -0.58348095, -0.4389609,
    -0.68595326, -0.19219643, 0.18174195, -0.8203027, 0.3187284, -0.5621431,
    -0.18123621, 0.64794254, 0.43926424, -0.6056042, -0.6246352, -0.24556947,
    -0.21758145, 1.2815354, 0.64133024, -1.3645452, -0.54808694, 0.09494448,
    -0.14767623, -0.52018183, 0.8915083, -0.23620111, 0.15006804, -0.48972046,
    1.007815, -0.6102733, 0.38582587, -1.2615669, -0.84423196, -0.45593706,
    0.6286372, 0.27298635, -0.0487293, 0.46897796, -0.39817595, 1.1331686,
    0.8597468, 0.09693813, 0.10298705, 0.83174723, 0.027146742, 0.59330297,
    -0.85177875, -0.6941318, -0.99233484, 0.81608415, 0.58656526, 0.022818327,
    -0.15745449, 0.7905676, -0.2196057, 0.13037223, -0.9325767, -0.6214706,
    0.73788387, -0.17842913, 0.47278842, -0.06228435, -0.9644034, 0.24859868,
    -0.030714333, 0.5398966, -1.2778239, -0.4088955, 0.9018869, -0.17766394,
    0.030042142, 0.2670896, -0.12838995, -0.23052792, 0.50430584, 0.3387332,
    -0.2930671, 0.07641998, -0.9150689, -0.30347374, -0.5635738, 0.8055314,
    -0.40778896, 0.32359296, -0.22895405, 0.5201528, -0.25635183, 0.8606057,
    -0.575968, -0.5166948,
];

/// The regression guard: the app's real session path, on a fixed 300-frame
/// tensor, must still agree with the runtime the model was published against.
///
/// `#[ignore]`d because it needs `campplus_speaker.onnx` staged outside the
/// repo -- the model is 29 MB and is downloaded at runtime, so no build of this
/// crate has it. It hard-fails rather than silently skipping when the staging
/// directory is set but the file is missing.
#[test]
#[ignore = "needs campplus_speaker.onnx staged outside the repo"]
fn campplus_matches_the_agreeing_runtime() -> Result<()> {
    let models_dir = env_dir("PLAINSONG_ORT_PARITY_MODELS")
        .ok_or_else(|| anyhow!("PLAINSONG_ORT_PARITY_MODELS is not set"))?;
    let model_path = models_dir.join("campplus_speaker.onnx");
    assert!(
        model_path.exists(),
        "missing staged model {}",
        model_path.display()
    );

    let fbank = deterministic_fbank(REFERENCE_FRAMES);
    let mut session = super::embedder::load_embedding_session(&model_path, "campplus_speaker")?;
    let embedding = raw_embedding(&mut session, &fbank, REFERENCE_FRAMES)?;

    assert_eq!(
        embedding.len(),
        CAMPPLUS_REFERENCE_300.len(),
        "CAM++ embedding dimension changed"
    );

    let dot: f64 = embedding
        .iter()
        .zip(CAMPPLUS_REFERENCE_300.iter())
        .map(|(a, b)| f64::from(*a) * f64::from(*b))
        .sum();
    let norm_a = embedding
        .iter()
        .map(|v| f64::from(*v) * f64::from(*v))
        .sum::<f64>()
        .sqrt();
    let norm_b = CAMPPLUS_REFERENCE_300
        .iter()
        .map(|v| f64::from(*v) * f64::from(*v))
        .sum::<f64>()
        .sqrt();
    let cosine = dot / (norm_a * norm_b);

    assert!(
        cosine > 0.999999,
        "CAM++ diverged from the reference runtime: cosine {cosine:.8}. A value \
         near zero means the graph-optimization workaround in \
         diarization::embedding_window was lost (measured -0.018 with it \
         reverted); see artifacts/qa/campplus-divergence-2026-09-02.md."
    );
    Ok(())
}
