//! Speaker diarization - identify who is speaking when.
//!
//! This module intentionally supports only real diarization. If the embedding
//! model is not available, the API returns an error instead of synthetic output.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// The ONNX embedding + clustering backend. Gated because it is the only part
/// of this module that needs `ndarray` and `ort`, both of which are optional
/// dependencies pulled in by the `diarization` feature; the module's types,
/// readiness rules and transcript merge are feature-independent and stay
/// compiled in so every call site keeps one shape. Same pattern as
/// `asr::whisper` / `asr::whisper_stub`.
#[cfg(feature = "diarization")]
mod embedder;
pub mod voiceprints;

/// EXPERIMENTAL alternative backend; see the module docs. Off by default.
#[cfg(feature = "diarization-speakrs")]
mod speakrs_backend;

#[cfg(feature = "diarization")]
pub use embedder::{
    generate_segments, EmbeddingClusterer, SEGMENT_OVERLAP_SECONDS, SEGMENT_SECONDS,
};

#[cfg(feature = "diarization")]
use ndarray::Array1;

/// A speaker segment with timing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerSegment {
    pub start_time: f64,
    pub end_time: f64,
    pub speaker_id: String,
    pub confidence: f64,
}

/// Speaker information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Speaker {
    pub id: String,
    pub name: Option<String>,
    pub color: String,
    pub sample_count: usize,
}

/// Diarization result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarizationResult {
    pub segments: Vec<SpeakerSegment>,
    pub speakers: Vec<Speaker>,
    pub duration: f64,
    pub method: DiarizationMethod,
    /// One unit-length voice signature per speaker cluster, keyed by the same
    /// `speaker_id` the segments carry.
    ///
    /// `#[serde(skip)]` on purpose: this is the only place the embeddings the
    /// pipeline computes survive at all, and it must not travel to the
    /// renderer, an export, or an RPC reply. The caller either hands it to the
    /// voiceprint store (when the user turned remembering on) or drops it when
    /// the result goes out of scope.
    #[serde(skip)]
    pub cluster_centroids: HashMap<String, Vec<f32>>,
}

/// Diarization method used
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DiarizationMethod {
    Embedding,
    Model,
}

/// Speaker diarization engine
pub struct DiarizationEngine {
    speakers: HashMap<String, Speaker>,
    model_id: String,
}

impl DiarizationEngine {
    pub fn new() -> Self {
        Self {
            speakers: HashMap::new(),
            model_id: "ecapa_tdnn_speaker".to_string(),
        }
    }

    /// Create an engine that uses a specific diarization model.
    pub fn with_model(model_id: &str) -> Self {
        Self {
            speakers: HashMap::new(),
            model_id: model_id.to_string(),
        }
    }

    /// Run diarization on audio file
    pub async fn diarize(&mut self, audio_path: &Path, duration: f64) -> Result<DiarizationResult> {
        tracing::info!("Running speaker diarization for {:.1}s audio", duration);
        self.diarize_real(audio_path, duration).await
    }

    /// Without the `diarization` feature there is no ONNX runtime to embed with
    /// and no clusterer compiled in. Say that, rather than running an empty
    /// pipeline to the same conclusion by a longer route.
    #[cfg(not(feature = "diarization"))]
    async fn diarize_real(
        &mut self,
        _audio_path: &Path,
        _duration: f64,
    ) -> Result<DiarizationResult> {
        Err(anyhow::anyhow!(
            "Speaker diarization is not compiled into this build (the `diarization` feature is off)."
        ))
    }

    /// Real diarization using speaker embeddings and clustering
    #[cfg(feature = "diarization")]
    async fn diarize_real(
        &mut self,
        audio_path: &Path,
        duration: f64,
    ) -> Result<DiarizationResult> {
        let segments = generate_segments(duration, SEGMENT_SECONDS, SEGMENT_OVERLAP_SECONDS);
        if segments.is_empty() {
            return Ok(DiarizationResult {
                segments: Vec::new(),
                speakers: Vec::new(),
                duration,
                method: DiarizationMethod::Embedding,
                cluster_centroids: HashMap::new(),
            });
        }

        let extractor = embedder::SpeakerEmbeddingExtractor::with_model(&self.model_id)
            .context("Failed to create embedding extractor")?;

        let embeddings: Vec<(f64, f64, Array1<f32>)> =
            extractor.extract_embeddings(audio_path, &segments).await?;

        if embeddings.is_empty() {
            return Err(anyhow::anyhow!(
                "Diarization model returned no embeddings; cannot infer speakers."
            ));
        }

        let segments_for_clustering: Vec<(f64, f64)> = embeddings
            .iter()
            .map(|(start_time, end_time, _)| (*start_time, *end_time))
            .collect();
        // The per-segment embeddings die with this closure. Only the per
        // cluster mean survives, and only in memory: whether any of it is
        // written down is the caller's decision, gated on the opt-in setting.
        let (smoothed, label_centroids) = tokio::task::spawn_blocking(move || {
            let clusterer = EmbeddingClusterer::new();
            let labels = clusterer.cluster(&embeddings);
            let mut grouped: HashMap<usize, Vec<Vec<f32>>> = HashMap::new();
            for (label, (_, _, embedding)) in labels.iter().zip(embeddings.iter()) {
                grouped
                    .entry(*label)
                    .or_default()
                    .push(embedding.iter().copied().collect());
            }
            let centroids: HashMap<usize, Vec<f32>> = grouped
                .into_iter()
                .filter_map(|(label, samples)| {
                    voiceprints::centroid_of(&samples).map(|centroid| (label, centroid))
                })
                .collect();
            (
                clusterer.smooth_segments(&segments_for_clustering, &labels),
                centroids,
            )
        })
        .await
        .context("Failed to join diarization clustering task")?;

        let mut cluster_centroids: HashMap<String, Vec<f32>> = HashMap::new();
        let mut speaker_segments = Vec::new();
        for (start, end, label) in smoothed {
            let speaker_id = format!("S{}", label + 1);
            if !self.speakers.contains_key(&speaker_id) {
                self.speakers
                    .insert(speaker_id.clone(), self.create_speaker(&speaker_id, label));
            }
            if let Some(centroid) = label_centroids.get(&label) {
                cluster_centroids
                    .entry(speaker_id.clone())
                    .or_insert_with(|| centroid.clone());
            }

            speaker_segments.push(SpeakerSegment {
                start_time: start,
                end_time: end,
                speaker_id: speaker_id.clone(),
                confidence: 0.90,
            });
        }

        let mut speakers: Vec<Speaker> = Vec::new();
        for segment in &speaker_segments {
            if speakers
                .iter()
                .any(|speaker| speaker.id == segment.speaker_id)
            {
                continue;
            }
            if let Some(speaker) = self.speakers.get(&segment.speaker_id) {
                speakers.push(speaker.clone());
            }
        }

        tracing::info!(
            "Diarization complete: {} speakers, {} segments",
            speakers.len(),
            speaker_segments.len()
        );

        Ok(DiarizationResult {
            segments: speaker_segments,
            speakers,
            duration,
            method: DiarizationMethod::Embedding,
            cluster_centroids,
        })
    }

    /// Merge diarization results with transcript segments.
    /// Splits transcript segments at diarization boundaries while keeping any
    /// uncovered speech explicitly anonymous (`speaker_id: None`).
    pub fn merge_with_transcript(
        &self,
        diarization: &DiarizationResult,
        transcript_segments: &mut Vec<crate::models::TranscriptSegment>,
    ) {
        tracing::debug!(
            "Merging {} diarization segments with {} transcript segments",
            diarization.segments.len(),
            transcript_segments.len()
        );

        if transcript_segments.is_empty() {
            return;
        }

        let mut sorted_diarization = diarization.segments.clone();
        sorted_diarization.retain(|segment| {
            segment.start_time.is_finite()
                && segment.end_time.is_finite()
                && segment.end_time > segment.start_time
        });
        sorted_diarization.sort_by(|left, right| {
            left.start_time
                .total_cmp(&right.start_time)
                .then_with(|| left.end_time.total_cmp(&right.end_time))
                .then_with(|| left.speaker_id.cmp(&right.speaker_id))
        });

        let mut new_segments: Vec<crate::models::TranscriptSegment> = Vec::new();
        for transcript_segment in transcript_segments.iter() {
            let words: Vec<&str> = transcript_segment.text.split_whitespace().collect();
            let total_duration = transcript_segment.end_time - transcript_segment.start_time;
            if words.is_empty() || !total_duration.is_finite() || total_duration <= 0.0 {
                let mut preserved = transcript_segment.clone();
                preserved.speaker_id = None;
                new_segments.push(preserved);
                continue;
            }

            let mut boundaries = vec![transcript_segment.start_time, transcript_segment.end_time];
            for diarization_segment in &sorted_diarization {
                if diarization_segment.start_time < transcript_segment.end_time
                    && diarization_segment.end_time > transcript_segment.start_time
                {
                    boundaries.push(
                        diarization_segment
                            .start_time
                            .max(transcript_segment.start_time),
                    );
                    boundaries.push(
                        diarization_segment
                            .end_time
                            .min(transcript_segment.end_time),
                    );
                }
            }
            boundaries.sort_by(f64::total_cmp);
            boundaries.dedup_by(|left, right| (*left - *right).abs() < 0.001);

            let total_words = words.len();
            for window in boundaries.windows(2) {
                let segment_start = window[0];
                let segment_end = window[1];
                if segment_end <= segment_start {
                    continue;
                }

                let word_start = ((segment_start - transcript_segment.start_time) / total_duration
                    * total_words as f64)
                    .round() as usize;
                let word_end = ((segment_end - transcript_segment.start_time) / total_duration
                    * total_words as f64)
                    .round() as usize;
                let word_start = word_start.min(total_words);
                let word_end = word_end.min(total_words);
                if word_start >= word_end {
                    continue;
                }

                let mut speaker_id = None;
                let mut best_overlap = 0.0f64;
                for diarization_segment in &sorted_diarization {
                    let overlap = segment_end.min(diarization_segment.end_time)
                        - segment_start.max(diarization_segment.start_time);
                    if overlap > best_overlap {
                        best_overlap = overlap;
                        speaker_id = Some(diarization_segment.speaker_id.clone());
                    }
                }

                let sub_text = words[word_start..word_end].join(" ");
                let id = if boundaries.len() == 2 {
                    transcript_segment.id.clone()
                } else {
                    uuid::Uuid::new_v4().to_string()
                };
                new_segments.push(crate::models::TranscriptSegment {
                    id,
                    start_time: segment_start,
                    end_time: segment_end,
                    text: sub_text,
                    speaker_id,
                    confidence: transcript_segment.confidence,
                });
            }
        }

        *transcript_segments = new_segments;
        tracing::debug!(
            "Merge complete: {} segments after splitting",
            transcript_segments.len()
        );
    }

    fn create_speaker(&self, id: &str, index: usize) -> Speaker {
        let colors = [
            "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899",
        ];
        Speaker {
            id: id.to_string(),
            name: Some(format!("Speaker {}", index + 1)),
            color: colors[index % colors.len()].to_string(),
            sample_count: 0,
        }
    }
}

impl Default for DiarizationEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// The embedding model every install starts on and every fallback lands on.
pub const DEFAULT_EMBEDDING_MODEL_ID: &str = "ecapa_tdnn_speaker";

/// Label for a diarization model, as the picker names it.
///
/// One table so the picker, the readiness probe and the fallback notice cannot
/// name the same model three different ways. An id this build does not know is
/// returned as-is rather than given an invented name.
pub fn model_label(model_id: &str) -> &str {
    #[cfg(feature = "diarization-speakrs")]
    if model_id == crate::download::SPEAKRS_MODEL_ID {
        return "pyannote community-1 (experimental)";
    }
    match model_id {
        "ecapa_tdnn_speaker" => "ECAPA-TDNN 512",
        "resnet34_speaker" => "ResNet34",
        "campplus_speaker" => "CAM++",
        "eres2netv2_speaker" => "ERes2NetV2 (int8)",
        other => other,
    }
}

/// The `.onnx` artifact an embedding-model id actually loads.
///
/// Unknown ids resolve to [`DEFAULT_EMBEDDING_MODEL_ID`], which is what
/// [`embedder::SpeakerEmbeddingExtractor::with_model`] has always done with a
/// filename it does not recognise. Readiness has to agree with the file the run
/// will open, or the picker promises a model the run cannot load.
pub fn embedding_model_artifact_id(model_id: &str) -> &'static str {
    match model_id {
        "resnet34_speaker" => "resnet34_speaker",
        "campplus_speaker" => "campplus_speaker",
        "eres2netv2_speaker" => "eres2netv2_speaker",
        _ => DEFAULT_EMBEDDING_MODEL_ID,
    }
}

/// Directory the single-file embedding models are downloaded to.
pub(crate) fn diarization_models_dir() -> std::path::PathBuf {
    crate::paths::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("Plainsong")
        .join("models")
        .join("diarization")
}

/// Readiness of one embedding model inside an explicit directory.
///
/// Takes the directory so the rule is testable against a fixture instead of the
/// user's own data directory.
pub(crate) fn is_embedding_model_available_in(models_dir: &Path, model_id: &str) -> bool {
    let artifact_id = embedding_model_artifact_id(model_id);
    crate::download::is_diarization_model_artifact_trusted(
        artifact_id,
        &models_dir.join(format!("{artifact_id}.onnx")),
    )
}

/// Whether the diarization model the user selected can actually run right now.
///
/// Per-model because the backends have different readiness conditions: the
/// embedding backend needs one verified `.onnx`, the experimental speakrs
/// backend needs a ten-file bundle. Callers that gate an automatic pass on
/// "is diarization available" must ask about the model they are about to run,
/// not about the default one -- this used to probe ECAPA-TDNN whatever the
/// argument said, so a user who picked CAM++ without downloading it passed the
/// gate and then lost speaker labels on every meeting.
pub fn is_model_available(model_id: &str) -> bool {
    #[cfg(feature = "diarization-speakrs")]
    if model_id == crate::download::SPEAKRS_MODEL_ID {
        return speakrs_backend::is_available();
    }
    // `cfg!` rather than `#[cfg]`: a build without the feature has no ONNX
    // runtime and no clusterer compiled in, so nothing it finds on disk can
    // actually run and readiness has to be false -- but the rule itself stays
    // compiled either way, so there is one function to test instead of two.
    cfg!(feature = "diarization")
        && is_embedding_model_available_in(&diarization_models_dir(), model_id)
}

/// The model a run will actually use, and what to tell the user when that is
/// not the one they picked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedDiarizationModel {
    /// The id to hand to [`run_diarization_with_model`].
    pub model_id: String,
    /// Copy for the meeting when the picked model was not on disk and the
    /// default ran in its place. `None` when the picked model ran.
    pub fallback_notice: Option<String>,
}

/// Copy for the one case where the picked model is not downloaded and the
/// default runs instead: state, cause, and the next action, in that order.
pub fn model_fallback_notice(requested_id: &str, ran_id: &str) -> String {
    format!(
        "Speaker labels used {} because {} is not downloaded. Download it under \
         Settings, Speaker separation model, to use it.",
        model_label(ran_id),
        model_label(requested_id)
    )
}

/// Pick the model a run should use given what is on disk.
///
/// `None` means nothing can run: neither the picked model nor the default is
/// downloaded, so the caller must not claim speaker labels at all. Falling back
/// is better than the previous behaviour (an error logged at warn level and a
/// meeting with no speakers) only because the substitution is reported -- a
/// silent swap would be a capability claim the user never agreed to.
pub fn resolve_model_for_run(requested_id: &str) -> Option<ResolvedDiarizationModel> {
    resolve_model_for_run_with(requested_id, is_model_available)
}

/// The rule behind [`resolve_model_for_run`], with readiness passed in so the
/// policy is testable without a models directory or ONNX Runtime.
fn resolve_model_for_run_with(
    requested_id: &str,
    is_available: impl Fn(&str) -> bool,
) -> Option<ResolvedDiarizationModel> {
    if is_available(requested_id) {
        return Some(ResolvedDiarizationModel {
            model_id: requested_id.to_string(),
            fallback_notice: None,
        });
    }
    if requested_id != DEFAULT_EMBEDDING_MODEL_ID && is_available(DEFAULT_EMBEDDING_MODEL_ID) {
        return Some(ResolvedDiarizationModel {
            model_id: DEFAULT_EMBEDDING_MODEL_ID.to_string(),
            fallback_notice: Some(model_fallback_notice(
                requested_id,
                DEFAULT_EMBEDDING_MODEL_ID,
            )),
        });
    }
    None
}

/// Run diarization with a specific speaker embedding model.
pub async fn run_diarization_with_model(
    audio_path: &Path,
    model_id: &str,
) -> Result<DiarizationResult> {
    #[cfg(feature = "diarization-speakrs")]
    if model_id == crate::download::SPEAKRS_MODEL_ID {
        let duration = get_audio_duration(audio_path).await?;
        return speakrs_backend::run(audio_path, duration).await;
    }

    if !is_model_available(model_id) {
        return Err(anyhow::anyhow!(
            "Real diarization model is not available: {} is not downloaded. Install/configure diarization models first.",
            model_label(model_id)
        ));
    }

    let duration = get_audio_duration(audio_path).await?;
    let mut engine = DiarizationEngine::with_model(model_id);
    engine.diarize(audio_path, duration).await
}

/// Get audio file duration
async fn get_audio_duration(audio_path: &Path) -> Result<f64> {
    let audio_path = audio_path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<f64> {
        let reader = hound::WavReader::open(audio_path)?;
        let duration = reader.duration() as f64 / reader.spec().sample_rate as f64;
        Ok(duration)
    })
    .await
    .context("Failed to join diarization WAV duration task")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Install `model_id` into `models_dir` the way a completed download leaves
    /// it: the artifact plus the integrity receipt keyed to its pinned digest.
    /// The bytes are a stand-in -- the receipt records size and mtime against
    /// the pin, so readiness is decided without re-hashing megabytes here.
    async fn install_embedding_model(models_dir: &Path, model_id: &str) {
        let sha256 = crate::download::diarization_model_expected_sha256(model_id)
            .expect("a pinned diarization model");
        let path = models_dir.join(format!("{model_id}.onnx"));
        tokio::fs::create_dir_all(models_dir).await.expect("dir");
        tokio::fs::write(&path, format!("fixture-{model_id}"))
            .await
            .expect("write model");
        crate::download::record_model_integrity_receipt_for_tests(&path, sha256)
            .await
            .expect("receipt");
    }

    fn scratch_models_dir(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(name)
            .join(uuid::Uuid::new_v4().to_string())
    }

    /// The regression: readiness used to probe ECAPA-TDNN whatever it was asked
    /// about, so a user who selected CAM++ without downloading it passed the
    /// gate on the automatic pass and then got no speaker labels at all.
    #[tokio::test]
    async fn readiness_answers_about_the_selected_model_not_the_default() {
        let models_dir = scratch_models_dir("plainsong-diarization-readiness");
        tokio::fs::create_dir_all(&models_dir).await.expect("dir");

        for model_id in [
            "ecapa_tdnn_speaker",
            "resnet34_speaker",
            "campplus_speaker",
            "eres2netv2_speaker",
        ] {
            assert!(
                !is_embedding_model_available_in(&models_dir, model_id),
                "{model_id} is not downloaded yet"
            );
        }

        install_embedding_model(&models_dir, "ecapa_tdnn_speaker").await;
        assert!(is_embedding_model_available_in(
            &models_dir,
            "ecapa_tdnn_speaker"
        ));
        for missing in ["resnet34_speaker", "campplus_speaker", "eres2netv2_speaker"] {
            assert!(
                !is_embedding_model_available_in(&models_dir, missing),
                "{missing} must not be reported available because ECAPA-TDNN is"
            );
        }

        install_embedding_model(&models_dir, "campplus_speaker").await;
        assert!(is_embedding_model_available_in(
            &models_dir,
            "campplus_speaker"
        ));
        assert!(!is_embedding_model_available_in(
            &models_dir,
            "resnet34_speaker"
        ));

        tokio::fs::remove_dir_all(&models_dir).await.ok();
    }

    /// An id outside the four is what `SpeakerEmbeddingExtractor::with_model`
    /// loads ECAPA-TDNN for, so readiness has to answer for ECAPA-TDNN too --
    /// otherwise the probe and the run disagree about the same settings value.
    #[tokio::test]
    async fn an_unknown_model_id_reads_the_default_artifact() {
        assert_eq!(
            embedding_model_artifact_id("not_a_real_model"),
            DEFAULT_EMBEDDING_MODEL_ID
        );
        assert_eq!(
            embedding_model_artifact_id("campplus_speaker"),
            "campplus_speaker"
        );

        let models_dir = scratch_models_dir("plainsong-diarization-unknown-id");
        tokio::fs::create_dir_all(&models_dir).await.expect("dir");
        assert!(!is_embedding_model_available_in(
            &models_dir,
            "not_a_real_model"
        ));

        install_embedding_model(&models_dir, "ecapa_tdnn_speaker").await;
        assert!(is_embedding_model_available_in(
            &models_dir,
            "not_a_real_model"
        ));

        tokio::fs::remove_dir_all(&models_dir).await.ok();
    }

    #[test]
    fn a_missing_selected_model_runs_the_default_and_says_so() {
        let only_default = |id: &str| id == DEFAULT_EMBEDDING_MODEL_ID;

        let resolved = resolve_model_for_run_with("campplus_speaker", only_default)
            .expect("the default can still run");
        assert_eq!(resolved.model_id, DEFAULT_EMBEDDING_MODEL_ID);
        let notice = resolved
            .fallback_notice
            .expect("a substitution is reported");
        assert!(notice.contains("CAM++"), "{notice}");
        assert!(notice.contains("ECAPA-TDNN 512"), "{notice}");
        assert!(notice.contains("not downloaded"), "{notice}");
        assert!(notice.contains("Settings"), "{notice}");
    }

    #[test]
    fn the_selected_model_runs_unannounced_when_it_is_downloaded() {
        let resolved = resolve_model_for_run_with("campplus_speaker", |_| true)
            .expect("the selected model can run");
        assert_eq!(resolved.model_id, "campplus_speaker");
        assert_eq!(resolved.fallback_notice, None);
    }

    /// Nothing downloaded means no speaker labels, not a quiet substitution of
    /// a model that is not there either.
    #[test]
    fn nothing_runs_when_neither_the_selection_nor_the_default_is_downloaded() {
        assert_eq!(
            resolve_model_for_run_with("campplus_speaker", |_| false),
            None
        );
        assert_eq!(
            resolve_model_for_run_with(DEFAULT_EMBEDDING_MODEL_ID, |_| false),
            None
        );
    }

    /// The picker, the readiness probe and the fallback notice all read the
    /// same table, so a meeting cannot be told a model ran under a name the
    /// picker never showed.
    #[test]
    fn model_labels_match_the_picker() {
        assert_eq!(model_label("ecapa_tdnn_speaker"), "ECAPA-TDNN 512");
        assert_eq!(model_label("resnet34_speaker"), "ResNet34");
        assert_eq!(model_label("campplus_speaker"), "CAM++");
        assert_eq!(model_label("eres2netv2_speaker"), "ERes2NetV2 (int8)");
        // No invented name for an id this build does not know.
        assert_eq!(model_label("not_a_real_model"), "not_a_real_model");
    }

    #[tokio::test]
    async fn test_diarization_requires_real_model() {
        if is_model_available(DEFAULT_EMBEDDING_MODEL_ID) {
            return;
        }

        let result =
            run_diarization_with_model(&PathBuf::from("test.wav"), "ecapa_tdnn_speaker").await;
        assert!(result.is_err());
        let message = result.err().map(|e| e.to_string()).unwrap_or_default();
        assert!(message.contains("Real diarization model is not available"));
    }

    #[cfg(feature = "diarization")]
    #[test]
    fn test_embedding_clusterer() {
        use ndarray::array;

        let embeddings = vec![
            (0.0, 2.0, array![1.0, 0.0, 0.0]),
            (2.0, 4.0, array![0.9, 0.1, 0.0]),
            (4.0, 6.0, array![0.0, 1.0, 0.0]),
            (6.0, 8.0, array![0.1, 0.9, 0.0]),
        ];

        let clusterer = EmbeddingClusterer::new();
        let labels = clusterer.cluster(&embeddings);

        assert_eq!(labels.len(), 4);
        assert_eq!(labels[0], labels[1]);
        assert_eq!(labels[2], labels[3]);
        assert_ne!(labels[0], labels[2]);
    }

    #[cfg(feature = "diarization")]
    #[test]
    fn test_ahc_centroid_linkage_prevents_transitive_merge() {
        use ndarray::array;

        // A-B and B-C are close (~0.2 cosine distance), while A-C is far (0.72).
        // Single-linkage (connected-components) would chain-merge A/B/C into
        // one cluster via the transitive link through B. AHC centroid linkage
        // should NOT: it merges the single closest pair, then the centroid of
        // that pair is too far from the third embedding for a further merge.
        // This is the key improvement over single-linkage — it prevents
        // speaker over-merging through acoustic similarity chains.
        //
        // Due to f32 precision, d(B,C) ≈ 0.19999993 is slightly less than
        // d(A,B) ≈ 0.19999998, so B and C merge first. After merging, the
        // centroid of {B,C} is ~0.43 from A — well above the 0.25 threshold.
        let embeddings = vec![
            (0.0, 2.0, array![1.0, 0.0, 0.0]),
            (2.0, 4.0, array![0.8, 0.6, 0.0]),
            (4.0, 6.0, array![0.28, 0.96, 0.0]),
            (6.0, 8.0, array![0.0, 0.0, 1.0]),
        ];

        let clusterer = EmbeddingClusterer::new().with_threshold(0.25);
        let labels = clusterer.cluster(&embeddings);

        assert_eq!(labels.len(), 4);
        // B and C merge (closest pair, dist ≈ 0.2 ≤ 0.25)
        assert_eq!(labels[1], labels[2]);
        // A does NOT merge with {B,C} (centroid distance ≈ 0.43 > 0.25)
        assert_ne!(labels[0], labels[1]);
        // D is its own cluster
        assert_ne!(labels[0], labels[3]);
        assert_ne!(labels[1], labels[3]);
        // 3 distinct speakers (A, {B,C}, D)
        let unique: std::collections::HashSet<_> = labels.iter().copied().collect();
        assert_eq!(unique.len(), 3);
    }

    #[cfg(feature = "diarization")]
    fn reference_ahc_centroid_linkage(
        embeddings: &[(f64, f64, ndarray::Array1<f32>)],
        threshold: f32,
    ) -> Vec<usize> {
        fn cosine_distance(left: &ndarray::Array1<f32>, right: &ndarray::Array1<f32>) -> f32 {
            let dot = left
                .iter()
                .zip(right.iter())
                .map(|(a, b)| a * b)
                .sum::<f32>();
            let left_norm = left.iter().map(|value| value * value).sum::<f32>().sqrt();
            let right_norm = right.iter().map(|value| value * value).sum::<f32>().sqrt();
            if left_norm == 0.0 || right_norm == 0.0 {
                return 1.0;
            }
            (1.0 - dot / (left_norm * right_norm)).max(0.0)
        }

        let n = embeddings.len();
        let mut clusters: Vec<Vec<usize>> = (0..n).map(|index| vec![index]).collect();
        let mut centroids: Vec<ndarray::Array1<f32>> =
            embeddings.iter().map(|(_, _, e)| e.clone()).collect();
        let mut active = vec![true; n];
        let mut num_active = n;

        while num_active > 1 {
            let mut min_dist = f32::INFINITY;
            let mut merge_i = 0;
            let mut merge_j = 0;
            for i in 0..n {
                if !active[i] {
                    continue;
                }
                for j in (i + 1)..n {
                    if !active[j] {
                        continue;
                    }
                    let d = cosine_distance(&centroids[i], &centroids[j]);
                    if d < min_dist {
                        min_dist = d;
                        merge_i = i;
                        merge_j = j;
                    }
                }
            }
            if min_dist > threshold {
                break;
            }
            let moved = std::mem::take(&mut clusters[merge_j]);
            clusters[merge_i].extend(moved);
            active[merge_j] = false;
            num_active -= 1;

            // Recompute centroid
            let len = centroids[merge_i].len();
            let mut new_centroid = vec![0.0f32; len];
            for &member in &clusters[merge_i] {
                for (k, &val) in embeddings[member].2.iter().enumerate() {
                    new_centroid[k] += val;
                }
            }
            let norm: f32 = new_centroid.iter().map(|x| x * x).sum::<f32>().sqrt();
            if norm > 1e-6 {
                for val in &mut new_centroid {
                    *val /= norm;
                }
            }
            centroids[merge_i] = ndarray::Array1::from(new_centroid);
        }

        // Build embedding → cluster mapping and assign labels by first occurrence
        let mut emb_to_cluster = vec![0usize; n];
        for (idx, members) in clusters.iter().enumerate() {
            if active[idx] {
                for &m in members {
                    emb_to_cluster[m] = idx;
                }
            }
        }
        let mut labels = vec![0; n];
        let mut label_map: std::collections::HashMap<usize, usize> =
            std::collections::HashMap::new();
        let mut next_label = 0;
        for i in 0..n {
            let cluster = emb_to_cluster[i];
            let label = *label_map.entry(cluster).or_insert_with(|| {
                let l = next_label;
                next_label += 1;
                l
            });
            labels[i] = label;
        }
        labels
    }

    #[cfg(feature = "diarization")]
    #[test]
    fn ahc_clustering_matches_reference_and_is_deterministic() {
        use ndarray::array;

        let embeddings = vec![
            (0.0, 2.0, array![1.0, 0.0, 0.0]),
            (2.0, 4.0, array![0.0, 1.0, 0.0]),
            (4.0, 6.0, array![0.92, 0.08, 0.0]),
            (6.0, 8.0, array![0.0, 0.0, 1.0]),
            (8.0, 10.0, array![0.08, 0.92, 0.0]),
        ];
        let threshold = 0.25;
        let expected = reference_ahc_centroid_linkage(&embeddings, threshold);
        let clusterer = EmbeddingClusterer::new().with_threshold(threshold);

        for _ in 0..10 {
            assert_eq!(clusterer.cluster(&embeddings), expected);
        }
        // AHC centroid linkage produces the same result as single-linkage
        // for this case because the close pairs (0,2) and (1,4) are
        // well-separated and merge independently.
        assert_eq!(expected, vec![0, 1, 0, 2, 1]);
    }

    #[test]
    fn merge_preserves_uncovered_prefix_gaps_and_suffix_as_none() {
        let diarization = DiarizationResult {
            segments: vec![
                SpeakerSegment {
                    start_time: 2.0,
                    end_time: 4.0,
                    speaker_id: "S1".to_string(),
                    confidence: 0.9,
                },
                SpeakerSegment {
                    start_time: 6.0,
                    end_time: 8.0,
                    speaker_id: "S2".to_string(),
                    confidence: 0.9,
                },
            ],
            speakers: Vec::new(),
            duration: 10.0,
            method: DiarizationMethod::Embedding,
            cluster_centroids: HashMap::new(),
        };
        let original_text = "one two three four five six seven eight nine ten";
        let mut transcript = vec![crate::models::TranscriptSegment {
            id: "segment-1".to_string(),
            start_time: 0.0,
            end_time: 10.0,
            text: original_text.to_string(),
            speaker_id: None,
            confidence: 0.9,
        }];

        DiarizationEngine::new().merge_with_transcript(&diarization, &mut transcript);

        assert_eq!(
            transcript
                .iter()
                .map(|segment| segment.speaker_id.as_deref())
                .collect::<Vec<_>>(),
            vec![None, Some("S1"), None, Some("S2"), None]
        );
        assert_eq!(
            transcript
                .iter()
                .map(|segment| segment.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            original_text
        );
    }

    #[cfg(feature = "diarization")]
    #[test]
    fn merge_keeps_short_runs_removed_by_smoothing_anonymous() {
        let clusterer = EmbeddingClusterer::new();
        let smoothed =
            clusterer.smooth_segments(&[(0.0, 6.0), (6.0, 8.0), (8.0, 14.0)], &[0, 1, 0]);
        assert_eq!(smoothed, vec![(0.0, 6.0, 0), (8.0, 14.0, 0)]);
        let diarization = DiarizationResult {
            segments: smoothed
                .into_iter()
                .map(|(start_time, end_time, label)| SpeakerSegment {
                    start_time,
                    end_time,
                    speaker_id: format!("S{}", label + 1),
                    confidence: 0.9,
                })
                .collect(),
            speakers: Vec::new(),
            duration: 14.0,
            method: DiarizationMethod::Embedding,
            cluster_centroids: HashMap::new(),
        };
        let mut transcript = vec![crate::models::TranscriptSegment {
            id: "segment-1".to_string(),
            start_time: 0.0,
            end_time: 14.0,
            text:
                "one two three four five six seven eight nine ten eleven twelve thirteen fourteen"
                    .to_string(),
            speaker_id: None,
            confidence: 0.9,
        }];

        DiarizationEngine::new().merge_with_transcript(&diarization, &mut transcript);

        assert_eq!(transcript.len(), 3);
        assert_eq!(transcript[0].speaker_id.as_deref(), Some("S1"));
        assert_eq!(transcript[1].speaker_id, None);
        assert_eq!(transcript[1].start_time, 6.0);
        assert_eq!(transcript[1].end_time, 8.0);
        assert_eq!(transcript[2].speaker_id.as_deref(), Some("S1"));
    }
}

/// Opt-in threshold calibration for [`voiceprints`].
///
/// Not a gate test and not run by `cargo test`: it needs the four speaker
/// embedding ONNX models on disk and a directory of fixture WAVs, and it
/// exists to produce the numbers in
/// `artifacts/qa/voiceprint-calibration-2026-09-02.md`. It is kept in the tree
/// rather than in a scratch script so the thresholds shipped in
/// `voiceprints.rs` can be re-derived by anyone, with the app's own embedder
/// rather than a re-implementation of it.
#[cfg(all(test, feature = "diarization"))]
mod calibration {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    /// Fixture naming: `<voice>_<index>.wav`, 16 kHz mono.
    fn voice_of(file_name: &str) -> Option<String> {
        let stem = file_name.strip_suffix(".wav")?;
        let (voice, _) = stem.rsplit_once('_')?;
        Some(voice.to_string())
    }

    fn percentile(sorted: &[f32], fraction: f64) -> f32 {
        if sorted.is_empty() {
            return f32::NAN;
        }
        let index = ((sorted.len() - 1) as f64 * fraction).round() as usize;
        sorted[index]
    }

    /// Build one voice signature per fixture, for one model, **exactly the way
    /// the product does**: the same 2-second/1-second-overlap segmentation
    /// `diarize_real` uses, pooled with the same `centroid_of`.
    ///
    /// An earlier version of this harness embedded each fixture as one long
    /// utterance instead. That measured a different object than the one the
    /// app compares, and it mattered: CAM++ separated speakers cleanly at
    /// 2-second windows and not at all at 8-second ones.
    async fn embed_fixtures(
        model_id: &str,
        fixtures: &[PathBuf],
    ) -> BTreeMap<String, Vec<Vec<f32>>> {
        let models_dir = crate::paths::data_dir()
            .expect("PLAINSONG_DATA_DIR must point at the staged models")
            .join("Plainsong")
            .join("models")
            .join("diarization");
        let model_path = models_dir.join(format!("{model_id}.onnx"));
        let sha = crate::download::diarization_model_expected_sha256(model_id)
            .expect("every calibrated model must be a known diarization model");
        crate::download::record_model_integrity_receipt_for_tests(&model_path, sha)
            .await
            .expect("the staged model file must match this build's pinned digest");

        let extractor = embedder::SpeakerEmbeddingExtractor::with_model(model_id)
            .expect("extractor construction");
        assert!(
            extractor.is_model_available(),
            "{model_id}: staged model did not pass integrity verification"
        );

        let mut by_voice: BTreeMap<String, Vec<Vec<f32>>> = BTreeMap::new();
        for fixture in fixtures {
            let voice = voice_of(&fixture.file_name().unwrap().to_string_lossy())
                .expect("fixture names are <voice>_<index>.wav");
            let duration = super::get_audio_duration(fixture)
                .await
                .expect("fixture duration");
            let segments = generate_segments(duration, SEGMENT_SECONDS, SEGMENT_OVERLAP_SECONDS);
            let embeddings = extractor
                .extract_embeddings(fixture, &segments)
                .await
                .expect("fixture embedding");
            let samples: Vec<Vec<f32>> = embeddings
                .into_iter()
                .map(|(_, _, embedding)| embedding.iter().copied().collect())
                .collect();
            let centroid = voiceprints::centroid_of(&samples)
                .expect("a fixture utterance must produce a usable embedding");
            by_voice.entry(voice).or_default().push(centroid);
        }
        by_voice
    }

    /// Opt-in diarization accuracy check on a two-speaker fixture.
    ///
    /// Runs the whole embed → cluster → smooth path a real meeting runs and
    /// scores it against a ground-truth turn list, so a claim about one
    /// embedder being better than another has a number behind it. This is what
    /// established that CAM++ does not merely fail voiceprint matching in this
    /// build but cannot separate two speakers at all.
    ///
    /// Fixture: `<PLAINSONG_VOICEPRINT_FIXTURES>/../twospeaker/twospeaker.wav`
    /// plus `twospeaker.json` (`{"duration":…, "turns":[{speaker,start,end}]}`).
    #[tokio::test]
    #[ignore = "needs the speaker embedding models and a two-speaker fixture on disk; opt in with PLAINSONG_VOICEPRINT_CALIBRATION=1"]
    async fn diarization_cluster_eval() {
        if std::env::var("PLAINSONG_VOICEPRINT_CALIBRATION").as_deref() != Ok("1") {
            eprintln!("skipped: set PLAINSONG_VOICEPRINT_CALIBRATION=1 to run");
            return;
        }
        let fixture_dir = PathBuf::from(
            std::env::var("PLAINSONG_TWO_SPEAKER_FIXTURE")
                .expect("PLAINSONG_TWO_SPEAKER_FIXTURE must name the fixture directory"),
        );
        let audio = fixture_dir.join("twospeaker.wav");
        let truth: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(fixture_dir.join("twospeaker.json")).expect("truth file"),
        )
        .expect("truth json");
        let turns: Vec<(String, f64, f64)> = truth["turns"]
            .as_array()
            .expect("turns array")
            .iter()
            .map(|turn| {
                (
                    turn["speaker"].as_str().unwrap().to_string(),
                    turn["start"].as_f64().unwrap(),
                    turn["end"].as_f64().unwrap(),
                )
            })
            .collect();
        let duration = truth["duration"].as_f64().unwrap();

        for model_id in [
            "ecapa_tdnn_speaker",
            "campplus_speaker",
            "resnet34_speaker",
            "eres2netv2_speaker",
        ] {
            let models_dir = crate::paths::data_dir()
                .expect("PLAINSONG_DATA_DIR must point at the staged models")
                .join("Plainsong")
                .join("models")
                .join("diarization");
            let model_path = models_dir.join(format!("{model_id}.onnx"));
            let sha = crate::download::diarization_model_expected_sha256(model_id).unwrap();
            crate::download::record_model_integrity_receipt_for_tests(&model_path, sha)
                .await
                .expect("integrity receipt");

            let mut engine = DiarizationEngine::with_model(model_id);
            let result = engine
                .diarize(&audio, duration)
                .await
                .expect("diarization must run");

            // Score at 0.1 s resolution over the fixture, under the label
            // permutation that favours the model — a diarizer is not asked to
            // guess which speaker is called what.
            let mut pairs: Vec<(String, String)> = Vec::new();
            let mut step = 0.0f64;
            while step < duration {
                let truth_speaker = turns
                    .iter()
                    .find(|(_, start, end)| step >= *start && step < *end)
                    .map(|(speaker, _, _)| speaker.clone());
                let predicted = result
                    .segments
                    .iter()
                    .find(|segment| step >= segment.start_time && step < segment.end_time)
                    .map(|segment| segment.speaker_id.clone());
                if let (Some(truth_speaker), Some(predicted)) = (truth_speaker, predicted) {
                    pairs.push((truth_speaker, predicted));
                }
                step += 0.1;
            }
            let truth_labels: std::collections::BTreeSet<&String> =
                pairs.iter().map(|(t, _)| t).collect();
            let predicted_labels: std::collections::BTreeSet<&String> =
                pairs.iter().map(|(_, p)| p).collect();
            // Two ground-truth speakers, so the only permutations are identity
            // and swap; score both and keep the better one.
            let truth_vec: Vec<&String> = truth_labels.into_iter().collect();
            let predicted_vec: Vec<&String> = predicted_labels.into_iter().collect();
            let mut best_correct = 0usize;
            for assignment in [true, false] {
                let correct = pairs
                    .iter()
                    .filter(|(truth_label, predicted_label)| {
                        let truth_index = truth_vec.iter().position(|t| *t == truth_label).unwrap();
                        let mapped = if assignment {
                            predicted_vec.get(truth_index)
                        } else {
                            predicted_vec.get(predicted_vec.len().saturating_sub(1 + truth_index))
                        };
                        mapped.is_some_and(|m| *m == predicted_label)
                    })
                    .count();
                best_correct = best_correct.max(correct);
            }
            let frame_error = if pairs.is_empty() {
                1.0
            } else {
                1.0 - best_correct as f64 / pairs.len() as f64
            };
            println!(
                "{model_id}: speakers={} (truth 2)  scored_frames={}  frame_error={:.1}%",
                result.speakers.len(),
                pairs.len(),
                frame_error * 100.0
            );
        }
    }

    #[tokio::test]
    #[ignore = "needs the speaker embedding models and say-voice fixtures on disk; opt in with PLAINSONG_VOICEPRINT_CALIBRATION=1"]
    async fn voiceprint_threshold_calibration() {
        if std::env::var("PLAINSONG_VOICEPRINT_CALIBRATION").as_deref() != Ok("1") {
            eprintln!("skipped: set PLAINSONG_VOICEPRINT_CALIBRATION=1 to run");
            return;
        }
        let fixtures_dir = PathBuf::from(
            std::env::var("PLAINSONG_VOICEPRINT_FIXTURES")
                .expect("PLAINSONG_VOICEPRINT_FIXTURES must name the fixture directory"),
        );
        let mut fixtures: Vec<PathBuf> = std::fs::read_dir(&fixtures_dir)
            .expect("fixture directory")
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.extension().is_some_and(|ext| ext == "wav"))
            .collect();
        fixtures.sort();
        assert!(!fixtures.is_empty(), "no fixtures found");

        for model_id in [
            "ecapa_tdnn_speaker",
            "campplus_speaker",
            "resnet34_speaker",
            "eres2netv2_speaker",
        ] {
            let by_voice = embed_fixtures(model_id, &fixtures).await;
            let dimension = by_voice.values().next().unwrap()[0].len();

            let mut same: Vec<f32> = Vec::new();
            let mut different: Vec<f32> = Vec::new();
            let voices: Vec<&String> = by_voice.keys().collect();
            for (i, left_voice) in voices.iter().enumerate() {
                let left = &by_voice[*left_voice];
                for a in 0..left.len() {
                    for b in (a + 1)..left.len() {
                        same.push(voiceprints::cosine_similarity(&left[a], &left[b]).unwrap());
                    }
                }
                for right_voice in voices.iter().skip(i + 1) {
                    let right = &by_voice[*right_voice];
                    for left_sample in left {
                        for right_sample in right {
                            different.push(
                                voiceprints::cosine_similarity(left_sample, right_sample).unwrap(),
                            );
                        }
                    }
                }
            }
            same.sort_by(|a, b| a.partial_cmp(b).unwrap());
            different.sort_by(|a, b| a.partial_cmp(b).unwrap());

            println!("=== {model_id} (dim {dimension}) ===");
            println!("voices: {}", voices.len());
            println!(
                "same-speaker  n={:<4} min={:.4} p05={:.4} p50={:.4} p95={:.4} max={:.4}",
                same.len(),
                same[0],
                percentile(&same, 0.05),
                percentile(&same, 0.50),
                percentile(&same, 0.95),
                same[same.len() - 1]
            );
            println!(
                "diff-speaker  n={:<4} min={:.4} p50={:.4} p95={:.4} p99={:.4} max={:.4}",
                different.len(),
                different[0],
                percentile(&different, 0.50),
                percentile(&different, 0.95),
                percentile(&different, 0.99),
                different[different.len() - 1]
            );
            for step in 40..=95 {
                let threshold = step as f32 / 100.0;
                let false_accepts = different.iter().filter(|s| **s >= threshold).count();
                let true_accepts = same.iter().filter(|s| **s >= threshold).count();
                let far = false_accepts as f64 / different.len() as f64;
                let tar = true_accepts as f64 / same.len() as f64;
                println!(
                    "  t={threshold:.2} FAR={far:.4} ({false_accepts}/{}) TAR={tar:.4} ({true_accepts}/{})",
                    different.len(),
                    same.len()
                );
            }
        }
    }
}

/// Evaluation harness for comparing diarization backends on a fixture with
/// known turns. Ignored by default: each test downloads model weights and runs
/// real inference, which is neither hermetic nor fast enough for `bun run
/// test:rust`. One backend per test, run in separate processes, because peak
/// RSS is a process high-water mark and would otherwise be reported as the max
/// of both.
///
///   PLAINSONG_DATA_DIR=<scratch> PLAINSONG_DIAR_EVAL_AUDIO=<wav> \
///     cargo test --features diarization-speakrs --lib \
///     diarization::eval_tests::eval_embedding_backend -- --ignored --nocapture
///
/// Each test prints one JSON line prefixed `DIAR-EVAL ` so a scorer can pick
/// it out of cargo's output; `scripts/score-diarization-eval.mjs` compares
/// those turns against the fixture's ground truth.
#[cfg(test)]
mod eval_tests {
    use super::*;

    fn eval_audio_path() -> std::path::PathBuf {
        let raw = std::env::var("PLAINSONG_DIAR_EVAL_AUDIO")
            .expect("set PLAINSONG_DIAR_EVAL_AUDIO to the fixture WAV");
        std::path::PathBuf::from(raw)
    }

    /// Peak resident set size of this process so far, in bytes. macOS reports
    /// `ru_maxrss` in bytes (Linux uses kilobytes), and this harness only ever
    /// runs on the macOS dev machine, so no unit conversion is applied.
    fn peak_rss_bytes() -> u64 {
        // SAFETY: `getrusage` only writes into the provided `rusage`, which is
        // zeroed and lives for the whole call.
        unsafe {
            let mut usage: libc::rusage = std::mem::zeroed();
            if libc::getrusage(libc::RUSAGE_SELF, &mut usage) != 0 {
                return 0;
            }
            usage.ru_maxrss as u64
        }
    }

    fn report(
        backend: &str,
        audio: &std::path::Path,
        elapsed: std::time::Duration,
        result: &DiarizationResult,
    ) {
        let turns: Vec<serde_json::Value> = result
            .segments
            .iter()
            .map(|segment| {
                serde_json::json!({
                    "start": segment.start_time,
                    "end": segment.end_time,
                    "speaker": segment.speaker_id,
                })
            })
            .collect();
        let line = serde_json::json!({
            "backend": backend,
            "audio": audio.to_string_lossy(),
            "durationSeconds": result.duration,
            "wallSeconds": elapsed.as_secs_f64(),
            "peakRssBytes": peak_rss_bytes(),
            "speakerCount": result.speakers.len(),
            "turns": turns,
        });
        println!("DIAR-EVAL {line}");
    }

    #[tokio::test]
    #[ignore = "evaluation harness: downloads models and runs real inference"]
    async fn eval_embedding_backend() {
        let audio = eval_audio_path();
        let manager = crate::download::DownloadManager::new().expect("download manager");
        manager
            .download_diarization_model_by_id(
                "ecapa_tdnn_speaker",
                |_: crate::download::DownloadProgress| {},
            )
            .await
            .expect("ECAPA-TDNN model");

        let started = std::time::Instant::now();
        let result = run_diarization_with_model(&audio, "ecapa_tdnn_speaker")
            .await
            .expect("embedding diarization");
        report("embedding-ecapa_tdnn", &audio, started.elapsed(), &result);
    }

    #[cfg(feature = "diarization-speakrs")]
    #[tokio::test]
    #[ignore = "evaluation harness: downloads models and runs real inference"]
    async fn eval_speakrs_backend() {
        let audio = eval_audio_path();
        let manager = crate::download::DownloadManager::new().expect("download manager");
        manager
            .download_speakrs_bundle(|_: crate::download::DownloadProgress| {})
            .await
            .expect("speakrs bundle");

        let started = std::time::Instant::now();
        let result = run_diarization_with_model(&audio, crate::download::SPEAKRS_MODEL_ID)
            .await
            .expect("speakrs diarization");
        report("speakrs-community1", &audio, started.elapsed(), &result);
    }
}
