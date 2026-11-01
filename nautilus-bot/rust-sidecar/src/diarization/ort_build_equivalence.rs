//! Opt-in probe: do Silero VAD and ECAPA-TDNN give the same numbers on the
//! ONNX Runtime build that carries the Core ML execution provider
//! (`ort-coreml-ep`) as on the plain build?
//!
//! The feature links a different prebuilt ONNX Runtime for the whole app, but
//! registers Core ML only for community-1's embedding session. Run this test
//! from two builds, one with the feature and one without, and compare the two
//! dumps:
//!
//! ```text
//! PLAINSONG_DATA_DIR=<profile with models/diarization/ecapa_tdnn_speaker.onnx> \
//! PLAINSONG_ORT_EQUIV_SILERO=<silero_vad.onnx> \
//! PLAINSONG_ORT_EQUIV_LIST=<file of 16 kHz WAV paths> \
//! PLAINSONG_ORT_EQUIV_OUT=<dump.json> \
//! cargo test --release --lib ort_build_equivalence -- --ignored --nocapture
//! ```

use std::path::PathBuf;
use std::time::Instant;

use crate::audio::silero_vad::{SileroVadDetector, SILERO_VAD_CHUNK_SAMPLES};

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

#[tokio::test]
#[ignore = "needs model files and WAVs staged outside the repo; see the module docs"]
async fn ort_build_equivalence_dump() {
    let (Some(silero), Some(list), Some(out)) = (
        env_path("PLAINSONG_ORT_EQUIV_SILERO"),
        env_path("PLAINSONG_ORT_EQUIV_LIST"),
        env_path("PLAINSONG_ORT_EQUIV_OUT"),
    ) else {
        eprintln!("PLAINSONG_ORT_EQUIV_* not set; nothing to do");
        return;
    };
    crate::download::DownloadManager::new()
        .unwrap()
        .verify_installed_diarization_model("ecapa_tdnn_speaker")
        .await
        .expect("ECAPA-TDNN installed in PLAINSONG_DATA_DIR");
    let extractor =
        super::embedder::SpeakerEmbeddingExtractor::with_model("ecapa_tdnn_speaker").unwrap();
    let wavs: Vec<PathBuf> = std::fs::read_to_string(&list)
        .unwrap()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(PathBuf::from)
        .collect();

    let mut files = Vec::new();
    for wav in &wavs {
        let samples = crate::audio::utils::load_audio_file(wav).unwrap();
        let duration = samples.len() as f64 / 16_000.0;

        let started = Instant::now();
        let mut vad = SileroVadDetector::load(&silero).unwrap();
        let probabilities: Vec<f32> = samples
            .chunks_exact(SILERO_VAD_CHUNK_SAMPLES)
            .map(|chunk| vad.detect_speech_probability(chunk).unwrap())
            .collect();
        let vad_ms = started.elapsed().as_secs_f64() * 1000.0;

        let segments = super::generate_segments(
            duration,
            super::SEGMENT_SECONDS,
            super::SEGMENT_OVERLAP_SECONDS,
        );
        let started = Instant::now();
        let embeddings = extractor.extract_embeddings(wav, &segments).await.unwrap();
        let ecapa_ms = started.elapsed().as_secs_f64() * 1000.0;

        files.push(serde_json::json!({
            "wav": wav.display().to_string(),
            "vadMs": vad_ms,
            "ecapaMs": ecapa_ms,
            "vad": probabilities,
            "ecapa": embeddings
                .iter()
                .map(|(start, end, embedding)| serde_json::json!({
                    "start": start,
                    "end": end,
                    "embedding": embedding.to_vec(),
                }))
                .collect::<Vec<_>>(),
        }));
    }
    std::fs::write(
        &out,
        serde_json::to_vec(&serde_json::json!({
            "coremlEpLinked": cfg!(feature = "ort-coreml-ep"),
            "files": files,
        }))
        .unwrap(),
    )
    .unwrap();
    eprintln!("wrote {} files to {}", wavs.len(), out.display());
}
