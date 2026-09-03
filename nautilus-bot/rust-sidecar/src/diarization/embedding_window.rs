//! Per-model ONNX session policy and input-length guard for the speaker
//! embedders.
//!
//! Both rules here exist because of one measured defect, recorded in
//! `artifacts/qa/campplus-divergence-2026-09-02.md`.
//!
//! # What was measured
//!
//! CAM++ (`campplus_speaker.onnx`, WeSpeaker voxceleb CAM++ LM, opset 14) is
//! the only one of the four embedding models built from D-TDNN context blocks:
//! 52 `AveragePool` nodes with `kernel_shape=[100]`, `strides=[100]` and
//! `ceil_mode=1`, each preceded by a `Pad` that pads by **zero on every axis**
//! (all 52 `pads` constants are `(0,0,0,0,0,0)` -- the PyTorch 1.12 exporter
//! emitted them, they do nothing). ECAPA-TDNN, ResNet34 and ERes2NetV2 contain
//! no `AveragePool` and no `Pad` at all, and are unaffected.
//!
//! The ONNX Runtime 1.28 that `ort` 2.0.0-rc.13 links absorbs those no-op
//! `Pad`s into the pools at `GraphOptimizationLevel::Level1` and above, and in
//! doing so sets `count_include_pad=1` on each pool. Its `AveragePool` kernel
//! then also counts the padding that `ceil_mode=1` adds to the final, partial
//! window, which changes that window's denominator. The result is deterministic
//! and depends only on the input length: the pools see `ceil(T / 2)` positions,
//! so the trailing window is partial unless `ceil(T / 2)` is a multiple of 100.
//!
//! | frames `T` | `ceil(T/2) % 100` | cosine vs the unoptimized graph |
//! |---|---|---|
//! | 198 (what this app feeds) | 99 | 0.9910 |
//! | 199, 200, 399, 400, 599, 600, 799, 800 | 0 | 1.0000 |
//! | 201 | 1 | 0.1216 |
//! | 300 | 50 | 0.0943 |
//!
//! 160 of the 163 lengths swept between 96 and 420 frames diverge. This is
//! therefore **not** a long-input hazard: it is wrong at the length the product
//! actually uses, and only mildly so there by coincidence.
//!
//! # The two rules
//!
//! 1. [`graph_optimization_level_for`] -- build the CAM++ session with graph
//!    optimization **off**, which is the only setting measured to restore
//!    agreement. `optimization.disable_specified_optimizers` was tried first
//!    and is a dead end: naming `PadFusion` (alone and with `NopElimination`
//!    and `ConstantFolding`) left the rewritten graph and the wrong output
//!    bit-identical under both ORT 1.28 and 1.29.
//! 2. [`verified_frame_window`] -- a cap on how many frames a model is fed in
//!    one shot, so a future change to the segmentation cannot silently walk a
//!    model past the lengths that were actually verified. Longer inputs are
//!    split into near-equal windows and the per-window embeddings averaged,
//!    which is what the clusterer already does across segments. The cap is
//!    deliberately independent of rule 1, and holds even if an `ort` upgrade
//!    changes the optimizer's behaviour again.

use ort::session::builder::GraphOptimizationLevel;

/// The longest fbank input, in frames, verified end-to-end for a model.
/// `None` means no length-dependent defect is known and no cap applies.
///
/// CAM++ is capped at 220 frames. The app's own 2 s window is 198 frames, so
/// the cap leaves room for that plus rounding without ever reaching the lengths
/// where a partial pooling window covers half the segment.
pub(crate) const CAMPPLUS_VERIFIED_FRAME_WINDOW: usize = 220;

/// Verified maximum input length for an embedding model artifact id.
///
/// Takes the *artifact* id (what `embedding_model_artifact_id` resolves to),
/// not the id the user picked, so an unknown id cannot dodge the cap by falling
/// back to a different file than the one the cap was measured on.
pub(crate) fn verified_frame_window(artifact_id: &str) -> Option<usize> {
    match artifact_id {
        "campplus_speaker" => Some(CAMPPLUS_VERIFIED_FRAME_WINDOW),
        // ECAPA-TDNN, ResNet34 and ERes2NetV2 agreed with Python `onnxruntime`
        // to six decimals at every length from 96 to 826 frames, at every
        // optimization level. Nothing to cap.
        _ => None,
    }
}

/// The graph optimization level an embedding model's ONNX session is built at.
///
/// Level 3 for everything except CAM++, whose `Pad` + `AveragePool(ceil_mode)`
/// blocks ORT 1.28 rewrites incorrectly (module docs). Measured cost of the
/// exception on an M4 Pro at 198 frames, release profile, load average 25-44 so
/// provisional: inference p50 12.30 ms against 11.67 ms at Level 3 (+5%), and a
/// one-off session build of 254 ms against 147 ms.
pub(crate) fn graph_optimization_level_for(artifact_id: &str) -> GraphOptimizationLevel {
    match artifact_id {
        "campplus_speaker" => GraphOptimizationLevel::Disable,
        _ => GraphOptimizationLevel::Level3,
    }
}

/// Split `num_frames` into consecutive windows of at most `window` frames.
///
/// Returns `(start, len)` pairs covering every frame exactly once. The windows
/// are as near equal as integer division allows rather than "fill the cap, then
/// a short remainder": a 21-frame tail embedded on its own is a much worse
/// speaker estimate than two halves of a 221-frame segment, and the caller
/// averages the results.
///
/// `window == 0` is treated as "do not split", because a zero-length window
/// cannot cover anything and silently returning an empty plan would drop audio.
pub(crate) fn split_into_windows(num_frames: usize, window: usize) -> Vec<(usize, usize)> {
    if num_frames == 0 {
        return Vec::new();
    }
    if window == 0 || num_frames <= window {
        return vec![(0, num_frames)];
    }

    let chunks = num_frames.div_ceil(window);
    let base = num_frames / chunks;
    let remainder = num_frames % chunks;

    let mut plan = Vec::with_capacity(chunks);
    let mut start = 0;
    for index in 0..chunks {
        // The first `remainder` windows take one extra frame, so the plan sums
        // back to `num_frames` exactly.
        let len = base + usize::from(index < remainder);
        plan.push((start, len));
        start += len;
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn campplus_is_the_only_capped_model() {
        assert_eq!(
            verified_frame_window("campplus_speaker"),
            Some(CAMPPLUS_VERIFIED_FRAME_WINDOW)
        );
        for id in [
            "ecapa_tdnn_speaker",
            "resnet34_speaker",
            "eres2netv2_speaker",
        ] {
            assert_eq!(verified_frame_window(id), None, "{id} should not be capped");
        }
    }

    /// The workaround is scoped to the one model that needs it: turning graph
    /// optimization off for the other three would cost speed for nothing.
    #[test]
    fn only_campplus_loses_graph_optimization() {
        assert_eq!(
            graph_optimization_level_for("campplus_speaker"),
            GraphOptimizationLevel::Disable
        );
        for id in [
            "ecapa_tdnn_speaker",
            "resnet34_speaker",
            "eres2netv2_speaker",
        ] {
            assert_eq!(
                graph_optimization_level_for(id),
                GraphOptimizationLevel::Level3,
                "{id} should keep full graph optimization"
            );
        }
    }

    /// The window the app actually cuts -- `generate_segments(duration, 2.0,
    /// 1.0)` -> 32000 samples -> 198 frames -- must pass the guard untouched,
    /// or the guard would change shipped behaviour rather than fence off a
    /// future change.
    #[test]
    fn the_apps_own_two_second_window_is_not_split() {
        assert_eq!(
            split_into_windows(198, CAMPPLUS_VERIFIED_FRAME_WINDOW),
            vec![(0, 198)]
        );
        assert_eq!(
            split_into_windows(220, CAMPPLUS_VERIFIED_FRAME_WINDOW),
            vec![(0, 220)]
        );
    }

    #[test]
    fn long_inputs_split_into_near_equal_windows() {
        assert_eq!(split_into_windows(300, 220), vec![(0, 150), (150, 150)]);
        assert_eq!(split_into_windows(221, 220), vec![(0, 111), (111, 110)]);
        assert_eq!(
            split_into_windows(1000, 220),
            vec![(0, 200), (200, 200), (400, 200), (600, 200), (800, 200)]
        );
    }

    #[test]
    fn every_plan_covers_every_frame_exactly_once() {
        for num_frames in 0..600usize {
            for window in [0usize, 1, 7, 198, 220, 1000] {
                let plan = split_into_windows(num_frames, window);
                let mut cursor = 0;
                for (start, len) in &plan {
                    assert_eq!(*start, cursor, "gap at {num_frames}/{window}");
                    cursor += len;
                }
                assert_eq!(cursor, num_frames, "coverage at {num_frames}/{window}");
                if window > 0 && num_frames > 0 {
                    assert!(
                        plan.iter().all(|(_, len)| *len <= window && *len > 0),
                        "window overrun at {num_frames}/{window}"
                    );
                }
            }
        }
    }

    #[test]
    fn empty_input_produces_no_windows() {
        assert!(split_into_windows(0, CAMPPLUS_VERIFIED_FRAME_WINDOW).is_empty());
    }
}
