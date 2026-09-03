//! Opt-in local voiceprints: deciding whether one diarization cluster is a
//! voice this Mac already has a name for.
//!
//! Everything in this file is pure arithmetic over embeddings that the
//! diarization pipeline already computed. It reads no settings, opens no
//! database, and touches no audio, so the policy — what similarity counts as
//! a match, how far ahead of the runner-up it has to be, when a match is
//! confident enough to apply without being asked — is testable without a
//! microphone, a model file, or a meeting.
//!
//! Two rules are structural rather than tuned, and neither has a setting:
//!
//! 1. **Never across embedding models.** ECAPA-TDNN, CAM++, ResNet34 and
//!    ERes2NetV2 produce vectors in unrelated spaces; a cosine similarity
//!    between two of them is a number with no meaning. A profile recorded
//!    under one model is invisible to a cluster embedded with another.
//! 2. **A name never outvotes the voice.** Attendee lists reorder what the
//!    Confirm menu offers first; they never change which profile the audio
//!    matched. Guessing a speaker from a guest list is not speaker
//!    identification.

use serde::{Deserialize, Serialize};

/// One remembered voice, as it is stored in `speaker_profiles`.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredVoiceProfile {
    pub id: String,
    pub display_name: String,
    /// Reserved link to a meeting attendee (a hash of their address, or an
    /// alias). Nothing writes it yet: recordings do not carry attendees in
    /// this build, so every profile created by the rename flow stores `None`.
    pub linked_identity_hash: Option<String>,
    /// Which embedder produced `centroid`. Matching refuses to cross this.
    pub embedding_model_id: String,
    pub centroid: Vec<f32>,
    pub sample_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// How sure the match is, in the only two grades the UI distinguishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchConfidence {
    /// Clears the accept threshold and the margin: worth a suggestion chip
    /// the reader confirms or rejects.
    Suggest,
    /// Also clears the stricter auto-apply threshold. Only applied without
    /// asking when `meetings.autoApplyConfidentVoices` is on, and the
    /// transcript keeps saying "auto" until a human confirms it.
    Confident,
}

/// A cluster matched to a remembered voice.
#[derive(Debug, Clone, PartialEq)]
pub struct VoiceMatch {
    pub profile_id: String,
    pub display_name: String,
    pub similarity: f32,
    /// The strongest rival profile's similarity, or `None` when this was the
    /// only candidate. Carried so the receipt in the log and the reasoning in
    /// a bug report do not have to be re-derived.
    pub runner_up_similarity: Option<f32>,
    pub confidence: MatchConfidence,
}

impl VoiceMatch {
    /// Similarity as whole percent, for the suggestion chip ("Looks like
    /// Dana, 91%"). Clamped: a chip that reads 103% is a bug report.
    pub fn percent(&self) -> u8 {
        (self.similarity.clamp(0.0, 1.0) * 100.0).round() as u8
    }
}

/// Accept/margin/auto thresholds for one embedding model.
///
/// Calibrated, not guessed — see [`thresholds_for_model`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VoiceprintThresholds {
    /// Cosine similarity a candidate must reach to be suggested at all.
    pub accept: f32,
    /// How far the best candidate must beat the runner-up. Two remembered
    /// voices that both look like this cluster mean the pipeline cannot tell
    /// them apart, and the honest answer is to say nothing.
    pub margin: f32,
    /// Stricter accept threshold for applying a name without being asked.
    pub auto_apply: f32,
}

// ── Calibrated thresholds ────────────────────────────────────────────────
//
// Receipt: `artifacts/qa/voiceprint-recalibration-2026-09-03.md`, produced by
// the opt-in `voiceprint_threshold_calibration` harness in
// `diarization/mod.rs`. It re-derives all four models on the ONNX Runtime fix
// from `artifacts/qa/campplus-divergence-2026-09-02.md` and supersedes the
// first run, `artifacts/qa/voiceprint-calibration-2026-09-02.md`, whose CAM++
// numbers were measured through the corrupted graph. Re-running the old code
// path on the same fixtures reproduced that receipt exactly, so the two are
// directly comparable: no threshold moved, and the three models that do not
// contain the affected `Pad`/`AveragePool` blocks produced bit-identical
// embeddings (cosine 1.000000 at all 36 fixtures) across the two builds.
//
// Fixtures are 6 macOS `say` voices x 6 utterances,
// 16 kHz mono WAV, embedded through this crate's own extractor
// (`diarization/embedder.rs`) at the same 2-second/1-second-overlap
// segmentation `diarize_real` uses, pooled with the same `centroid_of`. That
// gives 90 same-speaker and 540 different-speaker signature pairs per model,
// each pair comparing the exact object the product compares.
//
// (Measuring whole 8-second utterances instead measures a different object,
// and it is not a harmless difference: CAM++ separates speakers cleanly at the
// product's 2-second windows and not at all at 8-second ones. The harness
// therefore mirrors the pipeline rather than approximating it.)
//
// `accept` is the smallest 0.01 step with **zero** false accepts across the
// 540 different-speaker pairs. That is stricter than the <= 1% the brief asked
// for, and it costs nothing: every model still recognizes 100% of same-speaker
// pairs at that step, because on these fixtures the two distributions do not
// overlap at all (the gaps are quoted per model below).
//
// `auto_apply` is `accept + 0.05`, so applying a name unasked always demands
// measurably more evidence than offering to.
//
// `margin` is 0.05 on every model on purpose. It is a rule about two
// *remembered voices* being distinguishable from each other, not a property of
// an embedder, and 36 fixtures from 6 clearly different voices contain no
// near-twin pair that would calibrate it. 0.05 is about a quarter of the
// smallest measured gap between the same-speaker minimum and the
// different-speaker maximum (0.202 on ECAPA-TDNN), so it never blocked a true
// match on the fixtures while still refusing when two profiles are tied.
//
// The fixtures are synthetic speech. Real rooms, real microphones, real
// crosstalk and real overlapping talk are all harder, so these numbers are an
// upper bound on accuracy, not a promise. `docs/beta/KNOWN-LIMITATIONS.md`
// says so where users can read it.

/// Shared runner-up margin. See the note above on why this is not per-model:
/// it is a design rule, deliberately not calibrated, and
/// `artifacts/qa/voiceprint-recalibration-2026-09-03.md` records it as one.
const VOICEPRINT_MATCH_MARGIN: f32 = 0.05;

/// ECAPA-TDNN 512, the default embedder. Zero false accepts from 0.61 (3/540
/// at 0.60), 100% true accepts there. Same-speaker minimum 0.8115 against a
/// different-speaker maximum of 0.6096 — a 0.202 gap, the narrowest measured.
/// Unchanged by the CAM++ fix: bit-identical embeddings before and after.
/// Receipt: `artifacts/qa/voiceprint-recalibration-2026-09-03.md`.
const ECAPA_TDNN_THRESHOLDS: VoiceprintThresholds = VoiceprintThresholds {
    accept: 0.61,
    margin: VOICEPRINT_MATCH_MARGIN,
    auto_apply: 0.66,
};

/// CAM++. Zero false accepts from 0.57 (1/540 at 0.56), 100% true accepts
/// there. Same-speaker minimum 0.8226 against a different-speaker maximum of
/// 0.5673 — a 0.255 gap.
///
/// Re-measured on the fixed ONNX Runtime session
/// (`embedding_window::graph_optimization_level_for`); the pre-fix run had
/// 0.8219 / 0.5642 and the same 0.57 threshold, so the corrupted graph did not
/// move the operating point. Receipt:
/// `artifacts/qa/voiceprint-recalibration-2026-09-03.md`.
const CAMPPLUS_THRESHOLDS: VoiceprintThresholds = VoiceprintThresholds {
    accept: 0.57,
    margin: VOICEPRINT_MATCH_MARGIN,
    auto_apply: 0.62,
};

/// ResNet34. Zero false accepts from 0.65 (2/540 at 0.64), 100% true accepts
/// there. Same-speaker minimum 0.8545 against a different-speaker maximum of
/// 0.6471 — a 0.207 gap. Its different-speaker tail is the fattest of the
/// four, which is why its accept threshold is the highest.
/// Unchanged by the CAM++ fix: bit-identical embeddings before and after.
/// Receipt: `artifacts/qa/voiceprint-recalibration-2026-09-03.md`.
const RESNET34_THRESHOLDS: VoiceprintThresholds = VoiceprintThresholds {
    accept: 0.65,
    margin: VOICEPRINT_MATCH_MARGIN,
    auto_apply: 0.70,
};

/// ERes2NetV2 (int8). Zero false accepts from 0.63 (1/540 at 0.62), 100% true
/// accepts there. Same-speaker minimum 0.9146 against a different-speaker
/// maximum of 0.6201 — the widest gap measured, 0.295.
/// Unchanged by the CAM++ fix: bit-identical embeddings before and after.
/// Receipt: `artifacts/qa/voiceprint-recalibration-2026-09-03.md`.
const ERES2NETV2_THRESHOLDS: VoiceprintThresholds = VoiceprintThresholds {
    accept: 0.63,
    margin: VOICEPRINT_MATCH_MARGIN,
    auto_apply: 0.68,
};

/// The thresholds calibrated for `model_id`, or `None` for an embedder this
/// build has never measured.
///
/// `None` is a refusal, not a missing default: matching with a threshold
/// borrowed from another model would be a number with no evidence behind it,
/// and the feature would rather say nothing. All four embedders the app ships
/// are calibrated; a fifth added without a calibration run gets no matching
/// until someone measures it.
pub fn thresholds_for_model(model_id: &str) -> Option<VoiceprintThresholds> {
    match model_id {
        "ecapa_tdnn_speaker" => Some(ECAPA_TDNN_THRESHOLDS),
        "campplus_speaker" => Some(CAMPPLUS_THRESHOLDS),
        "resnet34_speaker" => Some(RESNET34_THRESHOLDS),
        "eres2netv2_speaker" => Some(ERES2NETV2_THRESHOLDS),
        _ => None,
    }
}

/// Most samples kept per remembered voice. The centroid is the mean of these,
/// so the cap bounds both the stored bytes and how long one bad sample can
/// keep dragging the centroid around.
pub const MAX_SAMPLES_PER_PROFILE: usize = 20;

/// Cosine similarity, or `None` when the two vectors cannot be compared
/// (different lengths, empty, non-finite, or a zero-length vector).
///
/// `None` rather than `0.0`: a comparison that could not be made must not
/// look like a comparison that came out badly.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> Option<f32> {
    if a.is_empty() || a.len() != b.len() {
        return None;
    }
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    let denominator = norm_a.sqrt() * norm_b.sqrt();
    if denominator <= f32::EPSILON {
        return None;
    }
    let similarity = dot / denominator;
    similarity.is_finite().then(|| similarity.clamp(-1.0, 1.0))
}

/// The unit-length mean of `samples`, or `None` when there is nothing usable
/// to average.
///
/// This is the rolling centroid: confirming a suggestion appends the cluster's
/// centroid as a sample and recomputes this over the (capped) set, so a voice
/// that is remembered from twenty meetings is described by all twenty rather
/// than by whichever one happened to be last.
pub fn centroid_of(samples: &[Vec<f32>]) -> Option<Vec<f32>> {
    let dimension = samples.iter().find(|sample| !sample.is_empty())?.len();
    let mut sum = vec![0.0f32; dimension];
    let mut counted = 0usize;
    for sample in samples {
        if sample.len() != dimension || sample.iter().any(|value| !value.is_finite()) {
            continue;
        }
        for (slot, value) in sum.iter_mut().zip(sample.iter()) {
            *slot += *value;
        }
        counted += 1;
    }
    if counted == 0 {
        return None;
    }
    let norm = sum.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm <= f32::EPSILON || !norm.is_finite() {
        return None;
    }
    Some(sum.into_iter().map(|value| value / norm).collect())
}

/// Whether a vector is shaped like something this module can compare.
pub fn is_usable_embedding(embedding: &[f32]) -> bool {
    !embedding.is_empty()
        && embedding.iter().all(|value| value.is_finite())
        && embedding.iter().map(|value| value * value).sum::<f32>() > f32::EPSILON
}

/// Match one cluster centroid against the remembered voices.
///
/// Returns `None` — and it is a real answer, not a failure — when the cluster
/// is unusable, when the embedder is one this build has no calibration for,
/// when no profile was recorded with the same embedder, when nothing clears
/// the accept threshold, or when the top two candidates are too close to
/// separate.
pub fn match_cluster(
    centroid: &[f32],
    embedding_model_id: &str,
    profiles: &[StoredVoiceProfile],
    rejected_profile_ids: &[String],
) -> Option<VoiceMatch> {
    if !is_usable_embedding(centroid) {
        return None;
    }
    let thresholds = thresholds_for_model(embedding_model_id)?;

    let mut candidates: Vec<(&StoredVoiceProfile, f32)> = profiles
        .iter()
        .filter(|profile| profile.embedding_model_id == embedding_model_id)
        .filter(|profile| !rejected_profile_ids.iter().any(|id| id == &profile.id))
        .filter_map(|profile| {
            cosine_similarity(centroid, &profile.centroid).map(|score| (profile, score))
        })
        .collect();
    if candidates.is_empty() {
        return None;
    }

    // Descending similarity, ties broken by id so the answer does not depend
    // on the order SQLite happened to hand back.
    candidates.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.0.id.cmp(&right.0.id))
    });

    let (best, best_score) = candidates[0];
    if best_score < thresholds.accept {
        return None;
    }
    let runner_up_similarity = candidates.get(1).map(|(_, score)| *score);
    if let Some(runner_up) = runner_up_similarity {
        if best_score - runner_up < thresholds.margin {
            return None;
        }
    }

    Some(VoiceMatch {
        profile_id: best.id.clone(),
        display_name: best.display_name.clone(),
        similarity: best_score,
        runner_up_similarity,
        confidence: if best_score >= thresholds.auto_apply {
            MatchConfidence::Confident
        } else {
            MatchConfidence::Suggest
        },
    })
}

/// One speaker cluster's stored voice signature, and what the reader has
/// already said about it.
///
/// Only exists while `meetings.rememberVoices` is on; the columns behind it
/// (on `speaker_aliases`) are `NULL` otherwise.
#[derive(Debug, Clone, PartialEq)]
pub struct ClusterVoiceSignature {
    pub speaker_id: String,
    /// The alias name currently on the cluster, so a caller can tell an
    /// already-named speaker from an unnamed one without a second query.
    pub name: Option<String>,
    pub centroid: Vec<f32>,
    pub embedding_model_id: String,
    /// The remembered voice whose name is on this cluster, if any.
    pub applied_profile_id: Option<String>,
    /// `"auto"` while the app applied it unasked, `"confirmed"` once a human
    /// agreed. `None` when no voice is attached.
    pub match_state: Option<String>,
    /// Voices the reader has said "Not them" about for this cluster.
    pub rejected_profile_ids: Vec<String>,
}

/// The `voice_match_state` value written while a name was applied without
/// being asked. The transcript keeps saying "auto" until a human confirms.
pub const MATCH_STATE_AUTO: &str = "auto";
/// The `voice_match_state` value written once a human confirmed the name.
pub const MATCH_STATE_CONFIRMED: &str = "confirmed";

/// What one cluster's speaker header should show.
#[derive(Debug, Clone, PartialEq)]
pub struct ClusterSuggestion {
    pub speaker_id: String,
    /// The remembered voice whose name is on this cluster, if any.
    pub applied_profile_id: Option<String>,
    pub match_state: Option<String>,
    /// The chip to offer, or `None` when there is nothing honest to suggest.
    pub suggestion: Option<VoiceMatch>,
}

/// Build one entry per cluster that carries a voice signature, ordered so the
/// suggestions worth acting on come first.
///
/// A cluster a human already confirmed is reported without a suggestion: the
/// question has been answered and re-asking it is noise.
pub fn build_suggestions(
    signatures: &[ClusterVoiceSignature],
    profiles: &[StoredVoiceProfile],
    attendees: &[String],
) -> Vec<ClusterSuggestion> {
    let mut suggested: Vec<(String, VoiceMatch)> = Vec::new();
    let mut quiet: Vec<ClusterSuggestion> = Vec::new();

    for signature in signatures {
        let already_settled = signature.match_state.as_deref() == Some(MATCH_STATE_CONFIRMED);
        let matched = if already_settled {
            None
        } else {
            match_cluster(
                &signature.centroid,
                &signature.embedding_model_id,
                profiles,
                &signature.rejected_profile_ids,
            )
        };
        match matched {
            Some(matched) => suggested.push((signature.speaker_id.clone(), matched)),
            None => quiet.push(ClusterSuggestion {
                speaker_id: signature.speaker_id.clone(),
                applied_profile_id: signature.applied_profile_id.clone(),
                match_state: signature.match_state.clone(),
                suggestion: None,
            }),
        }
    }

    rank_matches_by_attendees(&mut suggested, attendees);
    let mut ordered: Vec<ClusterSuggestion> = suggested
        .into_iter()
        .map(|(speaker_id, matched)| {
            let signature = signatures
                .iter()
                .find(|candidate| candidate.speaker_id == speaker_id);
            ClusterSuggestion {
                speaker_id,
                applied_profile_id: signature.and_then(|s| s.applied_profile_id.clone()),
                match_state: signature.and_then(|s| s.match_state.clone()),
                suggestion: Some(matched),
            }
        })
        .collect();
    quiet.sort_by(|left, right| left.speaker_id.cmp(&right.speaker_id));
    ordered.extend(quiet);
    ordered
}

/// Whether a confident match may be applied to this cluster without asking.
///
/// Three conditions, all required: the user turned auto-apply on, the match
/// cleared the stricter per-model threshold, and the cluster does not already
/// carry a name a human chose. Overwriting a name someone typed would be the
/// one unforgivable version of this feature.
pub fn should_auto_apply(
    matched: &VoiceMatch,
    auto_apply_enabled: bool,
    existing_name_is_specific: bool,
) -> bool {
    auto_apply_enabled
        && matches!(matched.confidence, MatchConfidence::Confident)
        && !existing_name_is_specific
}

/// Case- and whitespace-insensitive name equality, the only comparison used
/// against an attendee list.
fn same_person_name(left: &str, right: &str) -> bool {
    left.trim().eq_ignore_ascii_case(right.trim())
}

/// Reorder suggestions so the ones naming a known attendee of this meeting
/// come first, keeping similarity order inside each half.
///
/// This never changes *which* profile a cluster matched — only which
/// suggestion the reader is shown first when several clusters matched at once.
///
/// `attendees` is empty in this build: nothing yet records who was in a
/// meeting. The function is still the one path the caller uses, so the
/// ordering rule is exercised and tested rather than waiting in a branch.
pub fn rank_matches_by_attendees(matches: &mut [(String, VoiceMatch)], attendees: &[String]) {
    matches.sort_by(|left, right| {
        let left_known = attendees
            .iter()
            .any(|attendee| same_person_name(attendee, &left.1.display_name));
        let right_known = attendees
            .iter()
            .any(|attendee| same_person_name(attendee, &right.1.display_name));
        right_known
            .cmp(&left_known)
            .then_with(|| {
                right
                    .1
                    .similarity
                    .partial_cmp(&left.1.similarity)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| left.0.cmp(&right.0))
    });
}

/// The names offered in Confirm, attendees first and then remembered voices,
/// de-duplicated case-insensitively and with blanks dropped.
pub fn confirm_name_options(attendees: &[String], remembered: &[String]) -> Vec<String> {
    let mut options: Vec<String> = Vec::new();
    for name in attendees.iter().chain(remembered.iter()) {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            continue;
        }
        if options
            .iter()
            .any(|existing| same_person_name(existing, trimmed))
        {
            continue;
        }
        options.push(trimmed.to_string());
    }
    options
}

/// The refusal every voiceprint write returns while "Remember voices" is off.
///
/// One string, because the two write paths must not drift into telling the
/// reader different things about the same switch.
pub const VOICEPRINTS_OFF_MESSAGE: &str =
    "Remembering voices is off. Turn on \"Remember voices\" in Settings > General > Meetings first.";

/// Whether a write to the voiceprint columns may proceed.
///
/// A function rather than an `if` at each call site so that "every write path
/// is gated" is a property one test can check, and so a new write path has
/// something obvious to call. Applies to *every* write, not just the ones that
/// store a signature: "Not them" writes to the same columns, and while the
/// switch is off there are no chips to dismiss in the first place.
pub fn voiceprint_write_allowed(remember_voices: bool) -> Result<(), &'static str> {
    if remember_voices {
        Ok(())
    } else {
        Err(VOICEPRINTS_OFF_MESSAGE)
    }
}

/// One cluster's centroid, held in memory for as long as Plainsong runs.
///
/// See [`SessionClusterVoices`] for why these are not rows.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionClusterVoice {
    pub speaker_id: String,
    pub embedding_model_id: String,
    pub centroid: Vec<f32>,
}

/// How many recordings' worth of session centroids are kept at once.
///
/// A bound, not a tuning knob: this is a cache of numbers nobody asked to
/// keep, so it must not grow with how long the app has been open. The oldest
/// recording is dropped first, which costs a suggestion chip on a meeting
/// nobody has looked at in a while and nothing else.
pub const MAX_SESSION_RECORDINGS: usize = 32;

/// Cluster centroids for meetings diarized since the app started, for
/// clusters that have **not** earned a database row.
///
/// The promise in Settings and in `docs/beta/PRIVACY-AND-CLOUD.md` is that a
/// voice signature is written for a speaker who gets a name — not for every
/// voice that happened to be in the room. Suggesting a name still needs the
/// numbers, though, so they live here: readable for as long as Plainsong is
/// open, gone when it quits, and never on disk. The moment a cluster is named
/// (confirmed, or applied unasked by the stricter auto-apply threshold) its
/// signature is persisted and the database copy takes over.
///
/// The cost is honest and belongs in the docs: reopening a meeting after a
/// restart shows no chips for speakers nobody named, because the only thing
/// that could have produced them was deliberately not kept.
#[derive(Debug, Default)]
pub struct SessionClusterVoices {
    /// Insertion order, oldest first, for eviction.
    order: Vec<String>,
    by_recording: std::collections::HashMap<String, Vec<SessionClusterVoice>>,
}

impl SessionClusterVoices {
    /// Replace what is held for `recording_id`. Unusable vectors are dropped
    /// rather than stored: they cannot be compared, so keeping them would only
    /// make a later `None` look like a match that failed.
    pub fn remember<'a, I>(&mut self, recording_id: &str, embedding_model_id: &str, centroids: I)
    where
        I: IntoIterator<Item = (&'a String, &'a Vec<f32>)>,
    {
        let mut kept: Vec<SessionClusterVoice> = centroids
            .into_iter()
            .filter(|(_, centroid)| is_usable_embedding(centroid))
            .map(|(speaker_id, centroid)| SessionClusterVoice {
                speaker_id: speaker_id.clone(),
                embedding_model_id: embedding_model_id.to_string(),
                centroid: centroid.clone(),
            })
            .collect();
        kept.sort_by(|left, right| left.speaker_id.cmp(&right.speaker_id));

        if kept.is_empty() {
            self.forget(recording_id);
            return;
        }
        if self
            .by_recording
            .insert(recording_id.to_string(), kept)
            .is_none()
        {
            self.order.push(recording_id.to_string());
        }
        while self.order.len() > MAX_SESSION_RECORDINGS {
            let oldest = self.order.remove(0);
            self.by_recording.remove(&oldest);
        }
    }

    /// What is held for one recording, ordered by speaker id.
    pub fn for_recording(&self, recording_id: &str) -> &[SessionClusterVoice] {
        self.by_recording
            .get(recording_id)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// Drop everything held for one recording — it was deleted, or its
    /// signatures are now on disk.
    pub fn forget(&mut self, recording_id: &str) {
        if self.by_recording.remove(recording_id).is_some() {
            self.order.retain(|held| held != recording_id);
        }
    }

    /// How many recordings are held. The eviction bound is the only thing
    /// that reads it, and only from a test.
    #[cfg(test)]
    pub fn recordings_held(&self) -> usize {
        self.by_recording.len()
    }
}

/// Every cluster worth reasoning about for one recording: the persisted
/// signatures, plus the session-only centroids for clusters the database has
/// no signature row for.
///
/// A persisted row always wins. It carries the alias name, the applied
/// profile and the "Not them" list; the session copy carries none of that, so
/// preferring it would quietly forget a rejection.
///
/// `names` and `rejections` are keyed by speaker id and come from the alias
/// table, which has rows for clusters that carry no signature — a rejection is
/// written even for a cluster nobody named, so the same wrong suggestion does
/// not come back.
pub fn merge_session_signatures(
    stored: Vec<ClusterVoiceSignature>,
    session: &[SessionClusterVoice],
    names: &std::collections::HashMap<String, String>,
    rejections: &std::collections::HashMap<String, Vec<String>>,
) -> Vec<ClusterVoiceSignature> {
    let mut merged = stored;
    for held in session {
        if merged
            .iter()
            .any(|signature| signature.speaker_id == held.speaker_id)
        {
            continue;
        }
        merged.push(ClusterVoiceSignature {
            speaker_id: held.speaker_id.clone(),
            name: names.get(&held.speaker_id).cloned(),
            centroid: held.centroid.clone(),
            embedding_model_id: held.embedding_model_id.clone(),
            // Nothing on disk links this cluster to a profile: a link is
            // written at the same moment the signature is.
            applied_profile_id: None,
            match_state: None,
            rejected_profile_ids: rejections
                .get(&held.speaker_id)
                .cloned()
                .unwrap_or_default(),
        });
    }
    merged.sort_by(|left, right| left.speaker_id.cmp(&right.speaker_id));
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, name: &str, model: &str, centroid: Vec<f32>) -> StoredVoiceProfile {
        StoredVoiceProfile {
            id: id.to_string(),
            display_name: name.to_string(),
            linked_identity_hash: None,
            embedding_model_id: model.to_string(),
            centroid,
            sample_count: 1,
            created_at: "2026-09-02T00:00:00Z".to_string(),
            updated_at: "2026-09-02T00:00:00Z".to_string(),
        }
    }

    /// A unit vector `angle` radians away from `[1, 0, 0]` in the x-y plane,
    /// so cosine similarity to `[1, 0, 0]` is exactly `cos(angle)`.
    fn unit_at(angle: f32) -> Vec<f32> {
        vec![angle.cos(), angle.sin(), 0.0]
    }

    fn from_similarity(similarity: f32) -> Vec<f32> {
        unit_at(similarity.clamp(-1.0, 1.0).acos())
    }

    #[test]
    fn cosine_similarity_matches_hand_computed_values() {
        assert_eq!(cosine_similarity(&[1.0, 0.0], &[1.0, 0.0]), Some(1.0));
        assert_eq!(cosine_similarity(&[1.0, 0.0], &[0.0, 1.0]), Some(0.0));
        assert_eq!(cosine_similarity(&[1.0, 0.0], &[-1.0, 0.0]), Some(-1.0));
        let scaled = cosine_similarity(&[3.0, 0.0], &[7.0, 0.0]).unwrap();
        assert!((scaled - 1.0).abs() < 1e-6, "magnitude must not matter");
    }

    #[test]
    fn cosine_similarity_refuses_uncomparable_vectors() {
        assert_eq!(cosine_similarity(&[], &[]), None);
        assert_eq!(cosine_similarity(&[1.0, 0.0], &[1.0]), None);
        assert_eq!(cosine_similarity(&[0.0, 0.0], &[1.0, 0.0]), None);
        assert_eq!(cosine_similarity(&[f32::NAN, 0.0], &[1.0, 0.0]), None);
        assert_eq!(cosine_similarity(&[f32::INFINITY, 0.0], &[1.0, 0.0]), None);
    }

    #[test]
    fn every_matchable_embedder_has_calibrated_thresholds() {
        for model_id in [
            "ecapa_tdnn_speaker",
            "campplus_speaker",
            "resnet34_speaker",
            "eres2netv2_speaker",
        ] {
            let thresholds = thresholds_for_model(model_id)
                .unwrap_or_else(|| panic!("{model_id} has no calibrated thresholds"));
            assert!(
                thresholds.accept > 0.0 && thresholds.accept < 1.0,
                "{model_id} accept threshold out of range"
            );
            assert!(
                thresholds.auto_apply >= thresholds.accept + 0.05 - f32::EPSILON,
                "{model_id} auto-apply must be measurably stricter than accept"
            );
            assert!(thresholds.margin > 0.0, "{model_id} needs a real margin");
        }
    }

    #[test]
    fn an_unmeasured_embedder_has_no_thresholds_and_never_matches() {
        assert_eq!(thresholds_for_model("wespeaker_256"), None);
        let profiles = vec![profile("p1", "Dana", "wespeaker_256", vec![1.0, 0.0, 0.0])];
        assert_eq!(
            match_cluster(&[1.0, 0.0, 0.0], "wespeaker_256", &profiles, &[]),
            None
        );
    }

    #[test]
    fn matching_never_crosses_embedding_models() {
        // Identical vectors, different embedders: an exact numeric match that
        // means nothing, and must not be reported.
        let profiles = vec![profile(
            "p1",
            "Dana",
            "resnet34_speaker",
            vec![1.0, 0.0, 0.0],
        )];
        assert_eq!(
            match_cluster(&[1.0, 0.0, 0.0], "ecapa_tdnn_speaker", &profiles, &[]),
            None
        );
        assert!(
            match_cluster(&[1.0, 0.0, 0.0], "resnet34_speaker", &profiles, &[]).is_some(),
            "the same embedder must still match"
        );
    }

    /// The exact numbers, pinned. `every_matchable_embedder_has_calibrated_
    /// thresholds` only checks the shape of these constants, so an edit that
    /// moved one by 0.05 would sail through it. These are the operating points
    /// re-derived on the fixed ONNX Runtime session in
    /// `artifacts/qa/voiceprint-recalibration-2026-09-03.md`: the smallest
    /// 0.01 step with zero false accepts over 540 different-speaker pairs, and
    /// that step plus 0.05. Changing one means re-running the harness, not
    /// editing this list.
    #[test]
    fn the_shipped_thresholds_are_the_ones_that_were_measured() {
        for (model_id, accept, auto_apply) in [
            ("ecapa_tdnn_speaker", 0.61f32, 0.66f32),
            ("campplus_speaker", 0.57, 0.62),
            ("resnet34_speaker", 0.65, 0.70),
            ("eres2netv2_speaker", 0.63, 0.68),
        ] {
            let thresholds = thresholds_for_model(model_id).expect("calibrated");
            assert!(
                (thresholds.accept - accept).abs() < 1e-6,
                "{model_id} accept is {} but the receipt measured {accept}",
                thresholds.accept
            );
            assert!(
                (thresholds.auto_apply - auto_apply).abs() < 1e-6,
                "{model_id} auto_apply is {} but the receipt measured {auto_apply}",
                thresholds.auto_apply
            );
            assert!(
                (thresholds.margin - 0.05).abs() < 1e-6,
                "{model_id} margin is {} but the design rule is 0.05",
                thresholds.margin
            );
        }
    }

    /// Every shipped threshold number must name, in its own comment, the
    /// measurement receipt it came from.
    ///
    /// A constant with no citation is indistinguishable from a number somebody
    /// guessed, and this file has already carried one set of thresholds that
    /// were measured through a corrupted ONNX graph. The receipts are pulled in
    /// with `include_str!`, so a citation that names a file which has been
    /// deleted or renamed fails the build rather than rotting quietly.
    #[test]
    fn every_shipped_threshold_constant_cites_its_receipt() {
        const SOURCE: &str = include_str!("voiceprints.rs");
        const RECEIPTS: [(&str, &str); 2] = [
            (
                "artifacts/qa/voiceprint-recalibration-2026-09-03.md",
                include_str!("../../../artifacts/qa/voiceprint-recalibration-2026-09-03.md"),
            ),
            (
                "artifacts/qa/voiceprint-calibration-2026-09-02.md",
                include_str!("../../../artifacts/qa/voiceprint-calibration-2026-09-02.md"),
            ),
        ];
        for (path, body) in RECEIPTS {
            assert!(!body.is_empty(), "{path} is empty");
        }

        for name in [
            "VOICEPRINT_MATCH_MARGIN",
            "ECAPA_TDNN_THRESHOLDS",
            "CAMPPLUS_THRESHOLDS",
            "RESNET34_THRESHOLDS",
            "ERES2NETV2_THRESHOLDS",
        ] {
            let declaration = format!("const {name}: ");
            let position = SOURCE
                .find(&declaration)
                .unwrap_or_else(|| panic!("{name} is not declared in this file"));
            // The `///` block immediately above the declaration, and nothing
            // else: a citation three constants further up does not count.
            let mut comment: Vec<&str> = SOURCE[..position]
                .lines()
                .rev()
                .take_while(|line| line.trim_start().starts_with("///"))
                .collect();
            comment.reverse();
            assert!(
                !comment.is_empty(),
                "{name} has no doc comment, so nothing says where its number came from"
            );
            let comment = comment.join("\n");
            assert!(
                RECEIPTS.iter().any(|(path, _)| comment.contains(path)),
                "{name}'s comment names no measurement receipt:\n{comment}"
            );
        }
    }

    /// The four embedders are calibrated separately and their thresholds
    /// genuinely differ, which is the point of per-model calibration. One
    /// shared number here would mean somebody stopped measuring.
    #[test]
    fn thresholds_are_not_one_number_shared_by_every_model() {
        let accepts: std::collections::BTreeSet<u32> = [
            "ecapa_tdnn_speaker",
            "campplus_speaker",
            "resnet34_speaker",
            "eres2netv2_speaker",
        ]
        .into_iter()
        .map(|model_id| (thresholds_for_model(model_id).unwrap().accept * 100.0) as u32)
        .collect();
        assert!(
            accepts.len() > 1,
            "per-model calibration produced one shared accept threshold"
        );
    }

    #[test]
    fn a_confident_lone_candidate_matches_and_reports_its_percent() {
        let profiles = vec![profile(
            "p1",
            "Dana",
            "ecapa_tdnn_speaker",
            from_similarity(0.91),
        )];
        let matched = match_cluster(&[1.0, 0.0, 0.0], "ecapa_tdnn_speaker", &profiles, &[])
            .expect("a lone candidate well above threshold must match");
        assert_eq!(matched.profile_id, "p1");
        assert_eq!(matched.display_name, "Dana");
        assert_eq!(matched.runner_up_similarity, None);
        assert_eq!(matched.percent(), 91);
        assert_eq!(matched.confidence, MatchConfidence::Confident);
    }

    #[test]
    fn a_candidate_below_the_accept_threshold_is_not_suggested() {
        let accept = thresholds_for_model("ecapa_tdnn_speaker").unwrap().accept;
        let profiles = vec![profile(
            "p1",
            "Dana",
            "ecapa_tdnn_speaker",
            from_similarity(accept - 0.01),
        )];
        assert_eq!(
            match_cluster(&[1.0, 0.0, 0.0], "ecapa_tdnn_speaker", &profiles, &[]),
            None
        );
    }

    #[test]
    fn two_close_candidates_produce_no_suggestion_at_all() {
        let profiles = vec![
            profile("p1", "Dana", "ecapa_tdnn_speaker", from_similarity(0.90)),
            profile("p2", "Devon", "ecapa_tdnn_speaker", from_similarity(0.88)),
        ];
        assert_eq!(
            match_cluster(&[1.0, 0.0, 0.0], "ecapa_tdnn_speaker", &profiles, &[]),
            None,
            "0.02 apart is inside the margin; the honest answer is silence"
        );

        let separated = vec![
            profile("p1", "Dana", "ecapa_tdnn_speaker", from_similarity(0.90)),
            profile("p2", "Devon", "ecapa_tdnn_speaker", from_similarity(0.70)),
        ];
        let matched = match_cluster(&[1.0, 0.0, 0.0], "ecapa_tdnn_speaker", &separated, &[])
            .expect("a clear winner must still match");
        assert_eq!(matched.profile_id, "p1");
        assert!(matched.runner_up_similarity.is_some());
    }

    #[test]
    fn a_rejected_profile_stops_being_suggested_and_lets_the_next_one_through() {
        let profiles = vec![
            profile("p1", "Dana", "ecapa_tdnn_speaker", from_similarity(0.95)),
            profile("p2", "Devon", "ecapa_tdnn_speaker", from_similarity(0.80)),
        ];
        let rejected = vec!["p1".to_string()];
        let matched = match_cluster(&[1.0, 0.0, 0.0], "ecapa_tdnn_speaker", &profiles, &rejected)
            .expect("the runner-up becomes the candidate once the top is rejected");
        assert_eq!(matched.profile_id, "p2");
        assert_eq!(matched.runner_up_similarity, None);
    }

    #[test]
    fn a_suggestion_between_the_two_thresholds_is_not_confident() {
        let thresholds = thresholds_for_model("ecapa_tdnn_speaker").unwrap();
        let between = (thresholds.accept + thresholds.auto_apply) / 2.0;
        let profiles = vec![profile(
            "p1",
            "Dana",
            "ecapa_tdnn_speaker",
            from_similarity(between),
        )];
        let matched =
            match_cluster(&[1.0, 0.0, 0.0], "ecapa_tdnn_speaker", &profiles, &[]).unwrap();
        assert_eq!(matched.confidence, MatchConfidence::Suggest);
    }

    #[test]
    fn an_unusable_cluster_centroid_never_matches() {
        let profiles = vec![profile(
            "p1",
            "Dana",
            "ecapa_tdnn_speaker",
            vec![1.0, 0.0, 0.0],
        )];
        for centroid in [
            vec![],
            vec![0.0, 0.0, 0.0],
            vec![f32::NAN, 0.0, 0.0],
            vec![f32::INFINITY, 0.0, 0.0],
        ] {
            assert_eq!(
                match_cluster(&centroid, "ecapa_tdnn_speaker", &profiles, &[]),
                None
            );
        }
    }

    #[test]
    fn centroid_of_averages_and_normalizes() {
        let centroid = centroid_of(&[vec![1.0, 0.0], vec![0.0, 1.0]]).unwrap();
        let expected = (0.5f32).sqrt();
        assert!((centroid[0] - expected).abs() < 1e-6);
        assert!((centroid[1] - expected).abs() < 1e-6);
        let norm = centroid.iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-6, "centroid must be unit length");
    }

    #[test]
    fn centroid_of_skips_unusable_samples_and_refuses_an_empty_result() {
        let centroid = centroid_of(&[
            vec![1.0, 0.0],
            vec![f32::NAN, 0.0],
            vec![1.0, 0.0, 0.0],
            vec![1.0, 0.0],
        ])
        .expect("the two good samples still produce a centroid");
        assert!((centroid[0] - 1.0).abs() < 1e-6);

        assert_eq!(centroid_of(&[]), None);
        assert_eq!(centroid_of(&[vec![]]), None);
        assert_eq!(centroid_of(&[vec![0.0, 0.0]]), None);
    }

    #[test]
    fn attendee_names_reorder_suggestions_without_changing_them() {
        let mut matches = vec![
            (
                "S1".to_string(),
                VoiceMatch {
                    profile_id: "p1".into(),
                    display_name: "Dana".into(),
                    similarity: 0.95,
                    runner_up_similarity: None,
                    confidence: MatchConfidence::Confident,
                },
            ),
            (
                "S2".to_string(),
                VoiceMatch {
                    profile_id: "p2".into(),
                    display_name: "Devon".into(),
                    similarity: 0.80,
                    runner_up_similarity: None,
                    confidence: MatchConfidence::Suggest,
                },
            ),
        ];
        rank_matches_by_attendees(&mut matches, &["  devon ".to_string()]);
        assert_eq!(matches[0].0, "S2", "a known attendee is offered first");
        assert_eq!(matches[1].0, "S1");
        assert_eq!(
            matches[1].1.profile_id, "p1",
            "ranking must not reassign a cluster to a different profile"
        );

        rank_matches_by_attendees(&mut matches, &[]);
        assert_eq!(
            matches[0].0, "S1",
            "with no attendee list, similarity order stands"
        );
    }

    fn signature(speaker_id: &str, similarity: f32) -> ClusterVoiceSignature {
        ClusterVoiceSignature {
            speaker_id: speaker_id.to_string(),
            name: None,
            centroid: from_similarity(similarity),
            embedding_model_id: "ecapa_tdnn_speaker".to_string(),
            applied_profile_id: None,
            match_state: None,
            rejected_profile_ids: Vec::new(),
        }
    }

    #[test]
    fn build_suggestions_reports_every_cluster_and_suggests_only_where_it_can() {
        let profiles = vec![profile(
            "p1",
            "Dana",
            "ecapa_tdnn_speaker",
            vec![1.0, 0.0, 0.0],
        )];
        // S1 is a strong match; S2 is nowhere near anything remembered.
        let signatures = vec![signature("S1", 0.93), signature("S2", 0.20)];
        let built = build_suggestions(&signatures, &profiles, &[]);
        assert_eq!(built.len(), 2, "every signed cluster is reported");
        assert_eq!(built[0].speaker_id, "S1");
        assert_eq!(built[0].suggestion.as_ref().unwrap().display_name, "Dana");
        assert_eq!(built[1].speaker_id, "S2");
        assert!(built[1].suggestion.is_none());
    }

    #[test]
    fn a_confirmed_cluster_is_never_asked_about_again() {
        let profiles = vec![profile(
            "p1",
            "Dana",
            "ecapa_tdnn_speaker",
            vec![1.0, 0.0, 0.0],
        )];
        let mut signatures = vec![signature("S1", 0.93)];
        signatures[0].match_state = Some(MATCH_STATE_CONFIRMED.to_string());
        signatures[0].applied_profile_id = Some("p1".to_string());
        let built = build_suggestions(&signatures, &profiles, &[]);
        assert_eq!(built.len(), 1);
        assert!(built[0].suggestion.is_none());
        assert_eq!(built[0].match_state.as_deref(), Some(MATCH_STATE_CONFIRMED));
        assert_eq!(built[0].applied_profile_id.as_deref(), Some("p1"));

        // An auto-applied one is still open: it has not been agreed to.
        signatures[0].match_state = Some(MATCH_STATE_AUTO.to_string());
        let built = build_suggestions(&signatures, &profiles, &[]);
        assert!(built[0].suggestion.is_some());
        assert_eq!(built[0].match_state.as_deref(), Some(MATCH_STATE_AUTO));
    }

    #[test]
    fn auto_apply_needs_the_switch_the_confidence_and_an_unnamed_cluster() {
        let confident = VoiceMatch {
            profile_id: "p1".into(),
            display_name: "Dana".into(),
            similarity: 0.95,
            runner_up_similarity: None,
            confidence: MatchConfidence::Confident,
        };
        let merely_suggested = VoiceMatch {
            confidence: MatchConfidence::Suggest,
            ..confident.clone()
        };
        assert!(should_auto_apply(&confident, true, false));
        assert!(
            !should_auto_apply(&confident, false, false),
            "the switch is off"
        );
        assert!(
            !should_auto_apply(&merely_suggested, true, false),
            "a suggestion is not confident enough to apply unasked"
        );
        assert!(
            !should_auto_apply(&confident, true, true),
            "a name a human chose is never overwritten"
        );
    }

    #[test]
    fn confirm_offers_attendees_first_then_remembered_names() {
        let options = confirm_name_options(
            &["Dana".to_string(), "  ".to_string(), "Devon".to_string()],
            &["devon".to_string(), "Ravi".to_string()],
        );
        assert_eq!(options, vec!["Dana", "Devon", "Ravi"]);
    }

    #[test]
    fn every_voiceprint_write_is_refused_while_the_switch_is_off() {
        assert_eq!(voiceprint_write_allowed(true), Ok(()));
        let refusal = voiceprint_write_allowed(false).expect_err("the switch is off");
        assert_eq!(refusal, VOICEPRINTS_OFF_MESSAGE);
        // The refusal has to say what to do about it, not just that it failed.
        assert!(refusal.contains("Remember voices"), "{refusal}");
        assert!(
            refusal.contains("Settings > General > Meetings"),
            "{refusal}"
        );
    }

    // ── Session-only centroids ───────────────────────────────────────────

    fn centroids(pairs: &[(&str, Vec<f32>)]) -> std::collections::HashMap<String, Vec<f32>> {
        pairs
            .iter()
            .map(|(id, centroid)| (id.to_string(), centroid.clone()))
            .collect()
    }

    #[test]
    fn session_centroids_are_held_per_recording_and_ordered_by_speaker() {
        let mut held = SessionClusterVoices::default();
        let map = centroids(&[("S2", vec![0.0, 1.0, 0.0]), ("S1", vec![1.0, 0.0, 0.0])]);
        held.remember("r1", "ecapa_tdnn_speaker", map.iter());

        let voices = held.for_recording("r1");
        assert_eq!(voices.len(), 2);
        assert_eq!(voices[0].speaker_id, "S1");
        assert_eq!(voices[1].speaker_id, "S2");
        assert_eq!(voices[0].embedding_model_id, "ecapa_tdnn_speaker");
        assert!(
            held.for_recording("r-other").is_empty(),
            "one recording's voices never leak into another"
        );
    }

    #[test]
    fn session_centroids_drop_vectors_that_cannot_be_compared() {
        let mut held = SessionClusterVoices::default();
        let map = centroids(&[
            ("S1", vec![1.0, 0.0]),
            ("S2", vec![]),
            ("S3", vec![0.0, 0.0]),
            ("S4", vec![f32::NAN, 1.0]),
        ]);
        held.remember("r1", "ecapa_tdnn_speaker", map.iter());
        let kept: Vec<&str> = held
            .for_recording("r1")
            .iter()
            .map(|voice| voice.speaker_id.as_str())
            .collect();
        assert_eq!(kept, vec!["S1"]);
    }

    #[test]
    fn session_centroids_are_bounded_and_forgettable() {
        let mut held = SessionClusterVoices::default();
        for index in 0..(MAX_SESSION_RECORDINGS + 3) {
            held.remember(
                &format!("r{index}"),
                "ecapa_tdnn_speaker",
                centroids(&[("S1", vec![1.0, 0.0])]).iter(),
            );
        }
        assert_eq!(held.recordings_held(), MAX_SESSION_RECORDINGS);
        assert!(
            held.for_recording("r0").is_empty(),
            "the oldest recording is evicted first"
        );
        let newest = format!("r{}", MAX_SESSION_RECORDINGS + 2);
        assert_eq!(held.for_recording(&newest).len(), 1);

        held.forget(&newest);
        assert!(held.for_recording(&newest).is_empty());
        assert_eq!(held.recordings_held(), MAX_SESSION_RECORDINGS - 1);
    }

    #[test]
    fn re_diarizing_replaces_a_recordings_session_voices_without_growing_the_bound() {
        let mut held = SessionClusterVoices::default();
        held.remember(
            "r1",
            "ecapa_tdnn_speaker",
            centroids(&[("S1", vec![1.0, 0.0]), ("S2", vec![0.0, 1.0])]).iter(),
        );
        held.remember(
            "r1",
            "campplus_speaker",
            centroids(&[("S1", vec![0.0, 1.0])]).iter(),
        );
        assert_eq!(held.recordings_held(), 1);
        let voices = held.for_recording("r1");
        assert_eq!(voices.len(), 1, "the previous run is replaced, not merged");
        assert_eq!(voices[0].embedding_model_id, "campplus_speaker");
    }

    #[test]
    fn a_stored_signature_wins_over_the_session_copy_of_the_same_cluster() {
        let stored = vec![ClusterVoiceSignature {
            speaker_id: "S1".to_string(),
            name: Some("Dana".to_string()),
            centroid: vec![1.0, 0.0],
            embedding_model_id: "ecapa_tdnn_speaker".to_string(),
            applied_profile_id: Some("p1".to_string()),
            match_state: Some(MATCH_STATE_CONFIRMED.to_string()),
            rejected_profile_ids: vec!["p9".to_string()],
        }];
        let session = vec![
            SessionClusterVoice {
                speaker_id: "S1".to_string(),
                embedding_model_id: "ecapa_tdnn_speaker".to_string(),
                centroid: vec![0.0, 1.0],
            },
            SessionClusterVoice {
                speaker_id: "S2".to_string(),
                embedding_model_id: "ecapa_tdnn_speaker".to_string(),
                centroid: vec![0.0, 1.0],
            },
        ];
        let mut names = std::collections::HashMap::new();
        names.insert("S2".to_string(), "Speaker 2".to_string());
        let mut rejections = std::collections::HashMap::new();
        rejections.insert("S2".to_string(), vec!["p3".to_string()]);

        let merged = merge_session_signatures(stored, &session, &names, &rejections);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].speaker_id, "S1");
        assert_eq!(
            merged[0].centroid,
            vec![1.0, 0.0],
            "the persisted centroid is the one that counts"
        );
        assert_eq!(merged[0].applied_profile_id.as_deref(), Some("p1"));
        assert_eq!(merged[1].speaker_id, "S2");
        assert_eq!(merged[1].name.as_deref(), Some("Speaker 2"));
        assert_eq!(merged[1].applied_profile_id, None);
        assert_eq!(merged[1].match_state, None);
        assert_eq!(
            merged[1].rejected_profile_ids,
            vec!["p3".to_string()],
            "a rejection on an unnamed cluster still suppresses the suggestion"
        );
    }

    /// The point of holding centroids in memory: a cluster nobody has named
    /// can still be offered a name, which is the only reason not to persist it
    /// would otherwise cost the feature anything.
    #[test]
    fn a_session_only_cluster_is_still_matched_and_still_respects_a_rejection() {
        let profiles = vec![profile(
            "p1",
            "Dana",
            "ecapa_tdnn_speaker",
            vec![1.0, 0.0, 0.0],
        )];
        let session = vec![SessionClusterVoice {
            speaker_id: "S1".to_string(),
            embedding_model_id: "ecapa_tdnn_speaker".to_string(),
            centroid: from_similarity(0.95),
        }];
        let empty_names = std::collections::HashMap::new();
        let no_rejections = std::collections::HashMap::new();

        let merged = merge_session_signatures(Vec::new(), &session, &empty_names, &no_rejections);
        let offered = build_suggestions(&merged, &profiles, &[]);
        assert_eq!(offered.len(), 1);
        assert_eq!(
            offered[0]
                .suggestion
                .as_ref()
                .map(|matched| matched.display_name.as_str()),
            Some("Dana")
        );

        let mut rejections = std::collections::HashMap::new();
        rejections.insert("S1".to_string(), vec!["p1".to_string()]);
        let merged = merge_session_signatures(Vec::new(), &session, &empty_names, &rejections);
        let offered = build_suggestions(&merged, &profiles, &[]);
        assert_eq!(offered.len(), 1);
        assert!(
            offered[0].suggestion.is_none(),
            "\"Not them\" survives even though the cluster has no signature row"
        );
    }
}
