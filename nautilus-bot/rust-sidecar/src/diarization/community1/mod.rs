//! pyannote `speaker-diarization-community-1`, ported to Rust on ONNX Runtime.
//!
//! The reference is pyannote.audio 4.0's `SpeakerDiarization` pipeline with
//! community-1's checkpoint and `config.yaml` (CC BY 4.0, pyannote; the
//! embedding network is WeSpeaker ResNet34 trained on VoxCeleb, CC BY 4.0; the
//! PLDA is from BUT Speech@FIT's VBx). Plainsong runs the same stages:
//!
//! 1. 10 s windows every 1 s through the powerset segmentation network
//!    (`segmentation.onnx`, an unmodified export), decoded to at most two of
//!    three local speakers per 16.875 ms frame;
//! 2. instantaneous speaker count by overlap-add;
//! 3. one WeSpeaker embedding per (window, local speaker), overlap frames
//!    excluded (`embedding.onnx`: the ResNet34 trunk runs once per window and
//!    pools three speakers, where pyannote runs it once per speaker; the
//!    numbers are the same);
//! 4. AHC (centroid linkage, threshold 0.6) to initialise VBx (Fa 0.07,
//!    Fb 0.8) in PLDA space, then constrained assignment of every local
//!    speaker to a global one;
//! 5. reconstruction to a frame-level diarization, with overlap (`regular`)
//!    and with at most one speaker per frame (`exclusive`).
//!
//! Parity with pyannote.audio 4.0.7 (`community1-eval --dump` against
//! `scripts/pyannote-community1/ref_dump.py`, compared by `compare_stages.py`)
//! on ten AMI meetings (headset and far-field), two 75-minute concatenations
//! with a 10 s and a 15 s guest, a 75-minute meeting and two clips: segmentation
//! argmax agrees on at least 99.9995% of frames, embedding cosine is at least
//! 0.9997 (0.9999998 at the 0.1% quantile), the AHC labels and training sets
//! are identical on every file, and the final turns differ from the reference
//! by at most 0.002% DER with the same speaker count everywhere.
//!
//! Nothing here contacts the network: pyannote.audio's telemetry has no
//! counterpart, and the models load only from the verified bundle.

mod ahc;
mod fbank;
mod inference;
mod npy;
mod pipeline;
mod plda;
mod vbx;
mod voiceprint;

pub(crate) use voiceprint::{SignatureSpace, PRODUCT_SPACE};

use anyhow::{Context, Result};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use super::turns::{pad_into_silence, speakers_for, uncovered_spans, RawTurn, MIN_TURN_SECONDS};
use super::{DiarizationMethod, DiarizationResult};
use pipeline::{ClusterTurn, LOCAL_SPEAKERS};

pub(crate) const SEGMENTATION_FILE: &str = "pyannote-community-1-segmentation.onnx";
pub(crate) const EMBEDDING_FILE: &str = "pyannote-community-1-embedding.onnx";
pub(crate) const PLDA_FILE: &str = "pyannote-community-1-plda.npz";
pub(crate) const XVEC_TRANSFORM_FILE: &str = "pyannote-community-1-xvec_transform.npz";

/// The pinned SHA-256 of a bundle file.
pub(super) fn bundle_pin(file_name: &str) -> Result<&'static str> {
    crate::download::COMMUNITY1_BUNDLE
        .iter()
        .find(|file| file.file_name == file_name)
        .map(|file| file.sha256)
        .ok_or_else(|| anyhow::anyhow!("Missing integrity pin for {file_name}"))
}

/// Which of community-1's two outputs Plainsong attributes words with.
///
/// `exclusive` keeps at most one speaker per frame (the most active of the
/// overlapping ones), which is what pyannote recommends for reconciling with a
/// transcript. Under the word-owner rule (`word_owner`: an overlapped word
/// goes to the turn it sits deepest inside) it still beat the
/// overlap-preserving output on every set: words with the right speaker
/// 92.5% / 91.5% / 90.9% against 91.8% / 91.0% / 90.2% (five AMI meetings on
/// the headset mix, eleven held-out headset meetings, the five far-field),
/// with fewer wrong (6.0 / 6.7 / 7.7% against 6.7 / 7.3 / 8.4%).
/// Receipts: `artifacts/continuation-2026-10-20/opus-pyannote-c1/deeprec/`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TurnSet {
    Regular,
    Exclusive,
}

pub(crate) const MERGE_TURNS: TurnSet = TurnSet::Exclusive;

/// How far a turn is stretched into the silence beside it
/// ([`pad_into_silence`]). community-1's turns stop where its segmentation
/// hears no speech, but the recognizer still places words there, and the
/// word-owner rule leaves a word no turn touches without a speaker. With the
/// exclusive turns stretched by up to a second, unlabelled words fell from
/// 1.5% / 1.8% / 1.4% to 0.5% (headset, held-out headset, far-field), right
/// rose to 93.2% / 92.5% / 91.5% and wrong by 0.2-0.3 points. Filling every
/// gap gained 0.1-0.2 points more, but would hand a word to a speaker heard
/// minutes away.
const SILENCE_PAD_SECONDS: f64 = 1.0;

/// A speaker with fewer clean windows than this gets no signature. On AMI the
/// only speakers below it were fragments of other voices (8 windows, 52% of
/// its time one person's), and matching them is how a wrong name spreads.
const MIN_SIGNATURE_WINDOWS: usize = 10;

pub(crate) fn bundle_dir() -> PathBuf {
    super::diarization_models_dir().join(crate::download::COMMUNITY1_BUNDLE_DIR)
}

pub(crate) fn is_available() -> bool {
    crate::download::is_community1_bundle_installed(&bundle_dir())
}

/// One speaker's voice signature in one [`SignatureSpace`].
#[derive(Debug, Clone)]
pub(crate) struct SpeakerSignature {
    /// Unit length.
    pub vector: Vec<f32>,
    /// Clean 10 s windows (one local speaker active for at least 20% of the
    /// window) the clustering assigned to this speaker.
    pub windows: usize,
}

/// Both outputs of one run, in seconds, with pyannote's `SPEAKER_nn` labels.
#[derive(Debug, Clone)]
pub(crate) struct Community1Output {
    pub regular: Vec<RawTurn>,
    pub exclusive: Vec<RawTurn>,
    pub speakers: usize,
    /// Per requested space, each labelled speaker's signature.
    pub signatures: Vec<(SignatureSpace, BTreeMap<String, SpeakerSignature>)>,
    pub stage_seconds: BTreeMap<&'static str, f64>,
    pub embedding_device: &'static str,
}

impl Community1Output {
    pub(crate) fn turns(&self, set: TurnSet) -> &[RawTurn] {
        match set {
            TurnSet::Regular => &self.regular,
            TurnSet::Exclusive => &self.exclusive,
        }
    }
}

/// ONNX Runtime intra-op threads. A meeting is background work on a machine
/// the user is still using, so the networks never take every core.
fn inference_threads() -> usize {
    crate::qos::inference_threads()
}

/// Non-finite samples (a corrupt or hand-made file) become silence: one NaN
/// reaches every embedding of the windows it falls in, and NaN embeddings
/// make the clustering crawl.
fn sanitize(samples: &mut [f32]) {
    for sample in samples.iter_mut().filter(|sample| !sample.is_finite()) {
        *sample = 0.0;
    }
}

/// Run the whole pipeline over 16 kHz mono samples from a verified bundle.
/// With `dump`, every stage is written there as `.npy` for the parity harness.
/// Speaker signatures are computed in each of `spaces`. The samples are freed
/// once the embeddings are computed. With `gate`, the native-runtime gate is
/// released between network batches and taken back only while no foreground
/// work (a dictation decode) wants it, and released once both networks are
/// done.
pub(crate) fn diarize_samples(
    bundle: &Path,
    mut samples: Vec<f32>,
    dump: Option<&Path>,
    spaces: &[SignatureSpace],
    mut gate: Option<&mut crate::llm::local_model_load::YieldingGate<'_>>,
) -> Result<Community1Output> {
    crate::qos::run_background(|| {
        sanitize(&mut samples);
        let mut between_batches = || -> Result<()> {
            if let Some(gate) = gate.as_deref_mut() {
                gate.between_batches()?;
            }
            Ok(())
        };
        let mut stage_seconds = BTreeMap::new();
        let mut clock = Instant::now();
        let mut lap = |name: &'static str, stage_seconds: &mut BTreeMap<&'static str, f64>| {
            stage_seconds.insert(name, clock.elapsed().as_secs_f64());
            clock = Instant::now();
        };

        let plda = plda::Plda::load(&bundle.join(XVEC_TRANSFORM_FILE), &bundle.join(PLDA_FILE))
            .map_err(crate::download::mismatch_first)?;
        let mut networks = inference::Networks::load(
            &bundle.join(SEGMENTATION_FILE),
            &bundle.join(EMBEDDING_FILE),
            inference_threads(),
        )
        .map_err(crate::download::mismatch_first)?;
        lap("load", &mut stage_seconds);

        let (seg, raw) = networks.segment(&samples, dump.is_some(), &mut between_batches)?;
        lap("segmentation", &mut stage_seconds);
        let count = pipeline::speaker_count(&seg);
        if count.iter().all(|&c| c == 0) {
            return Ok(Community1Output {
                regular: Vec::new(),
                exclusive: Vec::new(),
                speakers: 0,
                signatures: spaces
                    .iter()
                    .map(|&space| (space, BTreeMap::new()))
                    .collect(),
                stage_seconds,
                embedding_device: networks.embedding_device,
            });
        }
        let embeddings = networks.embed(&samples, &seg, &mut between_batches)?;
        // Clustering runs no native network: free the audio, the sessions and
        // the gate.
        let embedding_device = networks.embedding_device;
        drop(networks);
        drop(samples);
        if let Some(gate) = gate {
            gate.release();
        }
        lap("embeddings", &mut stage_seconds);
        let clustering = pipeline::cluster(&seg, &embeddings, &plda);
        let per_space: Vec<(SignatureSpace, Vec<voiceprint::ClusterSignature>)> = spaces
            .iter()
            .map(|&space| {
                (
                    space,
                    voiceprint::cluster_signatures(space, &clustering, &embeddings, &plda),
                )
            })
            .collect();
        lap("clustering", &mut stage_seconds);

        let (columns, regular) = pipeline::reconstruct(&seg, &clustering.hard, &count);
        let (excl_columns, exclusive) =
            pipeline::reconstruct(&seg, &clustering.hard, &pipeline::exclusive_count(&count));
        let regular_turns = pipeline::binarize(columns, &regular);
        let exclusive_turns = pipeline::binarize(excl_columns, &exclusive);
        lap("reconstruction", &mut stage_seconds);

        // pyannote renames the sorted cluster labels present in the regular
        // output to SPEAKER_00, SPEAKER_01, ...
        let mut present: Vec<usize> = regular_turns.iter().map(|t| t.cluster).collect();
        present.sort_unstable();
        present.dedup();
        let label = |cluster: usize| {
            let rank = present.binary_search(&cluster).unwrap_or(present.len());
            format!("SPEAKER_{rank:02}")
        };
        // A speaker the reconstruction never shows has no label, so no signature.
        let signatures = per_space
            .into_iter()
            .map(|(space, by_cluster)| {
                let labelled = by_cluster
                    .into_iter()
                    .enumerate()
                    .filter(|(cluster, _)| present.binary_search(cluster).is_ok())
                    .filter_map(|(cluster, (vector, windows))| {
                        vector.map(|vector| (label(cluster), SpeakerSignature { vector, windows }))
                    })
                    .collect();
                (space, labelled)
            })
            .collect();
        let to_raw = |turns: &[ClusterTurn]| -> Vec<RawTurn> {
            turns
                .iter()
                .map(|t| RawTurn {
                    start: t.start,
                    end: t.end,
                    speaker: label(t.cluster),
                })
                .collect()
        };

        if let Some(dir) = dump {
            dump_stages(
                dir,
                &seg,
                raw.as_deref(),
                &count,
                &embeddings,
                &clustering,
                columns,
                &regular,
            )?;
        }

        Ok(Community1Output {
            regular: to_raw(&regular_turns),
            exclusive: to_raw(&exclusive_turns),
            speakers: present.len(),
            signatures,
            stage_seconds,
            embedding_device,
        })
    })
}

#[allow(clippy::too_many_arguments)]
fn dump_stages(
    dir: &Path,
    seg: &pipeline::Segmentation,
    raw: Option<&[f32]>,
    count: &[u8],
    embeddings: &[f32],
    clustering: &pipeline::Clustering,
    columns: usize,
    discrete: &[u8],
) -> Result<()> {
    use npy::write_npy;
    std::fs::create_dir_all(dir)?;
    let f32s = |v: &[f32]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
    let f64s = |v: &[f64]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
    let i64s = |v: &[i64]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
    let chunks = seg.chunks;
    let frames = pipeline::FRAMES_PER_CHUNK;
    if let Some(raw) = raw {
        write_npy(
            &dir.join("raw_log_probs.npy"),
            "<f4",
            &[chunks, frames, 7],
            &f32s(raw),
        )?;
    }
    write_npy(
        &dir.join("binarized.npy"),
        "|u1",
        &[chunks, frames, LOCAL_SPEAKERS],
        &seg.data,
    )?;
    write_npy(&dir.join("count.npy"), "|u1", &[count.len()], count)?;
    write_npy(
        &dir.join("embeddings.npy"),
        "<f4",
        &[chunks, LOCAL_SPEAKERS, plda::EMBEDDING_DIM],
        &f32s(embeddings),
    )?;
    let train: Vec<i64> = clustering
        .train
        .iter()
        .flat_map(|&(c, s)| [c as i64, s as i64])
        .collect();
    write_npy(
        &dir.join("train.npy"),
        "<i8",
        &[clustering.train.len(), 2],
        &i64s(&train),
    )?;
    let ahc: Vec<i64> = clustering.ahc_labels.iter().map(|&l| l as i64).collect();
    write_npy(
        &dir.join("ahc_clusters.npy"),
        "<i8",
        &[ahc.len()],
        &i64s(&ahc),
    )?;
    if let Some(gamma) = &clustering.vbx_gamma {
        let (n, k) = gamma.dim();
        let flat: Vec<f64> = gamma.iter().copied().collect();
        write_npy(&dir.join("vbx_q.npy"), "<f8", &[n, k], &f64s(&flat))?;
    }
    write_npy(
        &dir.join("vbx_sp.npy"),
        "<f8",
        &[clustering.vbx_pi.len()],
        &f64s(&clustering.vbx_pi),
    )?;
    let centroids: Vec<f64> = clustering.centroids.iter().flatten().copied().collect();
    write_npy(
        &dir.join("centroids.npy"),
        "<f8",
        &[clustering.centroids.len(), plda::EMBEDDING_DIM],
        &f64s(&centroids),
    )?;
    let hard: Vec<i64> = clustering.hard.iter().map(|&h| i64::from(h)).collect();
    write_npy(
        &dir.join("hard_clusters.npy"),
        "<i8",
        &[chunks, LOCAL_SPEAKERS],
        &i64s(&hard),
    )?;
    write_npy(
        &dir.join("discrete.npy"),
        "|u1",
        &[discrete.len() / columns.max(1), columns],
        discrete,
    )?;
    Ok(())
}

/// Run community-1 over a recording for the product's diarization pass.
pub(crate) async fn run(audio_path: &Path, duration: f64) -> Result<DiarizationResult> {
    if !is_available() {
        return Err(anyhow::anyhow!(
            "The pyannote community-1 speaker model failed its integrity check. Download it again in Settings > Models."
        ));
    }
    let (_cancel_background, control) = crate::llm::local_model_load::background_job();
    let audio_path = audio_path.to_path_buf();
    let bundle = bundle_dir();
    let output = tokio::task::spawn_blocking(move || -> Result<Community1Output> {
        let mut reader = crate::audio::utils::AudioWindowReader::open(&audio_path)
            .context("Failed to inspect audio for pyannote community-1 diarization")?;
        let mut gate = crate::llm::local_model_load::admit_community1(
            &[bundle.as_path()],
            reader.duration_seconds(),
            crate::audio::utils::AudioWindowReader::decode_scratch_bytes(),
            control,
        )?;
        let samples = reader
            .read_all_with(|| gate.between_batches().map(|_| ()))
            .context("Failed to load audio for pyannote community-1 diarization")?;
        diarize_samples(&bundle, samples, None, &[PRODUCT_SPACE], Some(&mut gate))
    })
    .await
    .context("Failed to join the pyannote community-1 diarization task")??;

    let (mut segments, ids) =
        super::turns::normalize_turns_with_ids(output.turns(MERGE_TURNS), duration);
    let cluster_centroids = product_centroids(&output, &ids);
    let gaps = uncovered_spans(&segments, duration, MIN_TURN_SECONDS);
    let unattributed: f64 = gaps.iter().map(|(start, end)| end - start).sum();
    pad_into_silence(&mut segments, SILENCE_PAD_SECONDS, duration);
    let speakers = speakers_for(&segments);
    tracing::info!(
        "pyannote community-1 diarization complete: {} speakers, {} turns, {:.1}s of {:.1}s unattributed, embeddings on {}, stages {:?}",
        speakers.len(),
        segments.len(),
        unattributed,
        duration,
        output.embedding_device,
        output.stage_seconds
    );
    Ok(DiarizationResult {
        segments,
        speakers,
        duration,
        method: DiarizationMethod::Model,
        cluster_centroids,
        word_activity: None,
    })
}

/// The remembered-voices signature of every speaker that survived turn
/// normalization, keyed by its Plainsong id (`S1`, `S2`, ...).
fn product_centroids(
    output: &Community1Output,
    ids: &std::collections::HashMap<String, String>,
) -> std::collections::HashMap<String, Vec<f32>> {
    output
        .signatures
        .iter()
        .find(|(space, _)| *space == PRODUCT_SPACE)
        .map(|(_, by_label)| {
            by_label
                .iter()
                .filter(|(_, signature)| signature.windows >= MIN_SIGNATURE_WINDOWS)
                .filter_map(|(label, signature)| {
                    ids.get(label)
                        .map(|id| (id.clone(), signature.vector.clone()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Evaluation entry point (`community1-eval` binary): raw regular and
/// exclusive turns in the reference script's JSON shape, plus timings.
pub fn eval_file(bundle: &Path, audio: &Path, dump: Option<&Path>) -> Result<serde_json::Value> {
    let samples = crate::audio::utils::load_audio_file(audio)?;
    let duration = samples.len() as f64 / inference::SAMPLE_RATE as f64;
    let started = Instant::now();
    let output = diarize_samples(bundle, samples, dump, &SignatureSpace::ALL, None)?;
    let run_s = started.elapsed().as_secs_f64();
    let signatures: serde_json::Map<String, serde_json::Value> = output
        .signatures
        .iter()
        .map(|(space, by_label)| {
            let speakers: serde_json::Map<String, serde_json::Value> = by_label
                .iter()
                .map(|(label, signature)| {
                    (
                        label.clone(),
                        serde_json::json!({
                            "windows": signature.windows,
                            "vector": signature.vector,
                        }),
                    )
                })
                .collect();
            (
                space.name().to_string(),
                serde_json::Value::Object(speakers),
            )
        })
        .collect();
    let turns = |turns: &[RawTurn]| -> Vec<serde_json::Value> {
        turns
            .iter()
            .map(|t| {
                serde_json::json!({
                    "start": (t.start * 1000.0).round() / 1000.0,
                    "end": (t.end * 1000.0).round() / 1000.0,
                    "speaker": t.speaker,
                })
            })
            .collect()
    };
    Ok(serde_json::json!({
        "audio": audio.display().to_string(),
        "device": format!("ort segmentation=cpu embedding={}", output.embedding_device),
        "threads": inference_threads(),
        "duration": duration,
        "runS": run_s,
        "rtfx": duration / run_s,
        "stageS": output.stage_seconds,
        "speakers": output.speakers,
        "turns": turns(output.turns(TurnSet::Regular)),
        "exclusiveTurns": turns(output.turns(TurnSet::Exclusive)),
        "signatures": signatures,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signature(vector: &[f32], windows: usize) -> SpeakerSignature {
        SpeakerSignature {
            vector: vector.to_vec(),
            windows,
        }
    }

    #[test]
    fn signatures_reach_the_merge_under_plainsong_ids_and_only_in_the_product_space() {
        let mut product = BTreeMap::new();
        product.insert("SPEAKER_00".to_string(), signature(&[1.0, 0.0], 40));
        product.insert("SPEAKER_01".to_string(), signature(&[0.0, 1.0], 12));
        // Dropped by turn normalization: no Plainsong id, no signature.
        product.insert("SPEAKER_02".to_string(), signature(&[0.6, 0.8], 30));
        let mut other_space = BTreeMap::new();
        other_space.insert("SPEAKER_00".to_string(), signature(&[0.0, -1.0], 40));
        let other = SignatureSpace::ALL
            .into_iter()
            .find(|space| *space != PRODUCT_SPACE)
            .unwrap();
        let output = Community1Output {
            regular: Vec::new(),
            exclusive: Vec::new(),
            speakers: 3,
            signatures: vec![(other, other_space), (PRODUCT_SPACE, product)],
            stage_seconds: BTreeMap::new(),
            embedding_device: "cpu",
        };
        let ids = std::collections::HashMap::from([
            ("SPEAKER_01".to_string(), "S1".to_string()),
            ("SPEAKER_00".to_string(), "S2".to_string()),
        ]);
        let centroids = product_centroids(&output, &ids);
        assert_eq!(centroids.len(), 2);
        assert_eq!(centroids["S1"], vec![0.0, 1.0]);
        assert_eq!(centroids["S2"], vec![1.0, 0.0]);
    }

    #[test]
    fn a_speaker_heard_too_briefly_gets_no_signature() {
        let mut product = BTreeMap::new();
        product.insert(
            "SPEAKER_00".to_string(),
            signature(&[1.0, 0.0], MIN_SIGNATURE_WINDOWS - 1),
        );
        let output = Community1Output {
            regular: Vec::new(),
            exclusive: Vec::new(),
            speakers: 1,
            signatures: vec![(PRODUCT_SPACE, product)],
            stage_seconds: BTreeMap::new(),
            embedding_device: "cpu",
        };
        let ids = std::collections::HashMap::from([("SPEAKER_00".to_string(), "S1".to_string())]);
        assert!(product_centroids(&output, &ids).is_empty());
    }

    #[test]
    fn non_finite_samples_become_silence() {
        let mut samples = vec![0.5, f32::NAN, -0.25, f32::INFINITY, f32::NEG_INFINITY];
        sanitize(&mut samples);
        assert_eq!(samples, vec![0.5, 0.0, -0.25, 0.0, 0.0]);
    }
}

#[cfg(test)]
mod responsiveness_tests {
    #[test]
    fn background_diarization_leaves_cores_for_capture_and_calls() {
        assert!(super::inference_threads() <= 2);
    }
}
