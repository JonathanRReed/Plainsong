//! Greedy decoding for NeMo Token-and-Duration Transducer (TDT) exports.
//!
//! Parakeet TDT 0.6B v2 and v3 are not the same shape as the CTC export in
//! [`super::parakeet`]. CTC gives one logit matrix and decoding is an argmax per
//! frame with repeat-collapsing. A transducer instead runs three graphs:
//!
//! ```text
//!   encoder  audio_signal [1,128,T] , length [1]  ->  outputs [1,1024,T'] , encoded_lengths [1]
//!   decoder  targets [1,U] , target_length [1] , states.1 [2,1,640] , onnx::Slice_3 [2,1,640]
//!              -> outputs [1,640,U] , prednet_lengths [1] , states [2,1,640] , 162 [2,1,640]
//!   joiner   encoder_outputs [1,1024,T'] , decoder_outputs [1,640,U] -> outputs [..,8198]
//! ```
//!
//! Those names and shapes were read off the shipped graphs rather than assumed.
//!
//! The 8198 joiner outputs are `8192` vocabulary + one blank + **five duration
//! logits**. That last part is what makes it TDT rather than plain RNN-T: at
//! each step the network predicts both a token and how many encoder frames to
//! skip, so decoding advances by a learned stride instead of one frame at a
//! time. Ignoring the duration head still "works" in the sense that it emits
//! text, which is exactly why it is dangerous — the output stays fluent while
//! drifting out of alignment with the audio. Reading it is not optional.
//!
//! The loop is deliberately bounded twice over: `MAX_SYMBOLS_PER_STEP` stops a
//! blank-starved model emitting forever at one time index, and a duration of
//! zero is forced to advance by one frame so the outer loop cannot stall.

use anyhow::{Context, Result};
use ndarray::{Array, IxDyn};
use ort::session::Session;
use ort::value::Tensor;

/// Hidden width of the prediction network (`pred_hidden` in the encoder's ONNX
/// metadata). Both LSTM state tensors are `[layers, batch, 640]`.
const PRED_HIDDEN: usize = 640;

/// Prediction-network LSTM depth (`pred_rnn_layers` in the ONNX metadata).
const PRED_LAYERS: usize = 2;

/// Most tokens emitted at a single encoder frame before we force an advance.
///
/// A transducer is allowed to emit several symbols at one time index, but a
/// model that never predicts blank would otherwise spin here forever. NeMo uses
/// 10 for greedy decoding; matching it keeps output identical on healthy audio
/// while still bounding the pathological case.
const MAX_SYMBOLS_PER_STEP: usize = 10;

/// Number of duration bins on the TDT head, i.e. the tail of the joiner output.
const DURATION_BINS: usize = 5;

/// What the joiner's output row decomposes into.
struct JoinerHead<'a> {
    /// Token logits, including the blank at `blank_id`.
    tokens: &'a [f32],
    /// Duration logits; the argmax index is the number of frames to skip.
    durations: &'a [f32],
}

fn split_joiner_row(row: &[f32]) -> Result<JoinerHead<'_>> {
    if row.len() <= DURATION_BINS {
        return Err(anyhow::anyhow!(
            "Joiner row of {} values is too short to carry {} duration bins",
            row.len(),
            DURATION_BINS
        ));
    }
    let split = row.len() - DURATION_BINS;
    Ok(JoinerHead {
        tokens: &row[..split],
        durations: &row[split..],
    })
}

/// First-wins argmax, matching NeMo's and numpy's tie behaviour.
///
/// `Iterator::max_by` returns the *last* maximum, so using it here would pick a
/// different token from the reference implementation whenever two logits tie —
/// rare, but it would make our transcript differ from NeMo's for no reason
/// anyone could later explain.
fn argmax(values: &[f32]) -> usize {
    let mut best_index = 0usize;
    let mut best_value = f32::NEG_INFINITY;
    for (index, value) in values.iter().enumerate() {
        if *value > best_value {
            best_value = *value;
            best_index = index;
        }
    }
    best_index
}

/// Zeroed LSTM state, used at the start of an utterance.
fn zero_state() -> Array<f32, IxDyn> {
    Array::zeros(IxDyn(&[PRED_LAYERS, 1, PRED_HIDDEN]))
}

/// One step of the prediction network: its projection, plus the LSTM state to
/// carry into the next step.
struct DecoderStep {
    projection: Vec<f32>,
    state_h: Array<f32, IxDyn>,
    state_c: Array<f32, IxDyn>,
}

/// Run the prediction network for one token, returning its projection and the
/// LSTM state to carry forward.
fn run_decoder(
    decoder: &mut Session,
    token: i32,
    state_h: Array<f32, IxDyn>,
    state_c: Array<f32, IxDyn>,
) -> Result<DecoderStep> {
    let targets = Array::from_shape_vec(IxDyn(&[1, 1]), vec![token])
        .context("Failed to build decoder targets tensor")?;
    let target_length =
        Array::from_shape_vec(IxDyn(&[1]), vec![1_i32]).context("Failed to build target_length")?;

    let outputs = decoder
        .run(ort::inputs![
            "targets" => Tensor::from_array(targets)?,
            "target_length" => Tensor::from_array(target_length)?,
            "states.1" => Tensor::from_array(state_h)?,
            "onnx::Slice_3" => Tensor::from_array(state_c)?,
        ])
        .map_err(|error| anyhow::anyhow!("Parakeet TDT decoder inference failed: {}", error))?;

    let projection: Vec<f32> = outputs["outputs"]
        .try_extract_array::<f32>()
        .context("Failed to extract decoder outputs")?
        .iter()
        .copied()
        .collect();

    let next_h = outputs["states"]
        .try_extract_array::<f32>()
        .context("Failed to extract decoder state h")?
        .to_owned()
        .into_dyn();
    let next_c = outputs["162"]
        .try_extract_array::<f32>()
        .context("Failed to extract decoder state c")?
        .to_owned()
        .into_dyn();

    Ok(DecoderStep {
        projection,
        state_h: next_h,
        state_c: next_c,
    })
}

/// Greedy TDT decode over one encoded utterance.
///
/// `encoder_out` is `[1, 1024, frames]` flattened in the encoder's own order;
/// `encoder_dim` and `frames` describe it. Returns the emitted token ids, which
/// the caller maps through `tokens.txt`.
pub fn greedy_decode(
    decoder: &mut Session,
    joiner: &mut Session,
    encoder_out: &[f32],
    encoder_dim: usize,
    frames: usize,
    blank_id: usize,
) -> Result<Vec<usize>> {
    if frames == 0 || encoder_dim == 0 {
        return Ok(Vec::new());
    }
    if encoder_out.len() < encoder_dim * frames {
        return Err(anyhow::anyhow!(
            "Encoder output holds {} values, need {} for {}x{}",
            encoder_out.len(),
            encoder_dim * frames,
            encoder_dim,
            frames
        ));
    }

    let mut tokens: Vec<usize> = Vec::new();
    let mut state_h = zero_state();
    let mut state_c = zero_state();

    // The prediction network is primed with blank, as NeMo does for the first
    // step, and only re-run when a real token is emitted.
    let primed = run_decoder(decoder, blank_id as i32, state_h, state_c)?;
    let mut decoder_out = primed.projection;
    state_h = primed.state_h;
    state_c = primed.state_c;

    let mut frame = 0usize;
    while frame < frames {
        let mut symbols_at_frame = 0usize;

        loop {
            // Encoder output is [1, dim, frames], so one frame is a strided
            // column, not a contiguous slice.
            let mut encoder_step = Vec::with_capacity(encoder_dim);
            for d in 0..encoder_dim {
                encoder_step.push(encoder_out[d * frames + frame]);
            }

            let enc = Array::from_shape_vec(IxDyn(&[1, encoder_dim, 1]), encoder_step)
                .context("Failed to build joiner encoder input")?;
            let dec = Array::from_shape_vec(IxDyn(&[1, PRED_HIDDEN, 1]), decoder_out.clone())
                .context("Failed to build joiner decoder input")?;

            let joined = joiner
                .run(ort::inputs![
                    "encoder_outputs" => Tensor::from_array(enc)?,
                    "decoder_outputs" => Tensor::from_array(dec)?,
                ])
                .map_err(|error| {
                    anyhow::anyhow!("Parakeet TDT joiner inference failed: {}", error)
                })?;

            let row: Vec<f32> = joined["outputs"]
                .try_extract_array::<f32>()
                .context("Failed to extract joiner outputs")?
                .iter()
                .copied()
                .collect();

            let head = split_joiner_row(&row)?;
            let token = argmax(head.tokens);
            let duration = argmax(head.durations);

            if token != blank_id {
                tokens.push(token);
                let step = run_decoder(decoder, token as i32, state_h, state_c)?;
                decoder_out = step.projection;
                state_h = step.state_h;
                state_c = step.state_c;
                symbols_at_frame += 1;
            }

            // A zero duration is legal for the network but would leave the
            // frame cursor where it is; only a non-blank emission justifies
            // staying, and even then only up to the symbol cap.
            if duration > 0 {
                frame += duration;
                break;
            }
            if token == blank_id || symbols_at_frame >= MAX_SYMBOLS_PER_STEP {
                frame += 1;
                break;
            }
        }
    }

    Ok(tokens)
}

/// Blank index for the shipped v3 export: `tokens.txt` carries `<blk> 8192`,
/// and the joiner's 8193 token logits line up with ids `0..=8192`.
pub const V3_BLANK_ID: usize = 8192;

/// Blank index for the English-only v2 export: `tokens.txt` carries
/// `<blk> 1024`, and the joiner's token head lines up with ids `0..=1024`.
pub const V2_BLANK_ID: usize = 1024;

/// Encoder hidden width (`outputs [1, 1024, frames]`).
pub const V3_ENCODER_DIM: usize = 1024;

/// Encoder hidden width for the v2 export. It matches v3, but remains a
/// separate contract so a future upstream re-export cannot silently change
/// one model's runtime shape.
pub const V2_ENCODER_DIM: usize = 1024;

/// Turn SentencePiece pieces into text. `▁` marks a word boundary.
pub fn detokenize(vocab: &[String], token_ids: &[usize]) -> String {
    let mut text = String::new();
    for id in token_ids {
        let Some(piece) = vocab.get(*id) else {
            continue;
        };
        if let Some(rest) = piece.strip_prefix('\u{2581}') {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(rest);
        } else {
            text.push_str(piece);
        }
    }
    text.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joiner_row_splits_vocabulary_from_duration_bins() {
        // 8198 = 8192 vocabulary + blank + 5 durations, the shipped v3 shape.
        let row = vec![0.0f32; 8198];
        let head = split_joiner_row(&row).expect("split");
        assert_eq!(head.tokens.len(), 8193);
        assert_eq!(head.durations.len(), DURATION_BINS);
    }

    #[test]
    fn a_row_too_short_for_durations_is_rejected_rather_than_silently_split() {
        // Reading a CTC row as if it were TDT would otherwise treat real
        // vocabulary logits as durations and skip frames at random.
        assert!(split_joiner_row(&[0.0; 4]).is_err());
        assert!(split_joiner_row(&[]).is_err());
    }

    #[test]
    fn argmax_picks_the_largest_and_is_stable_on_ties() {
        assert_eq!(argmax(&[0.1, 0.9, 0.4]), 1);
        assert_eq!(argmax(&[1.0, 1.0, 0.5]), 0);
        assert_eq!(argmax(&[]), 0);
    }

    #[test]
    fn lstm_state_matches_the_exported_prediction_network() {
        let state = zero_state();
        assert_eq!(state.shape(), &[PRED_LAYERS, 1, PRED_HIDDEN]);
        assert!(state.iter().all(|value| *value == 0.0));
    }

    #[test]
    fn detokenizer_restores_word_boundaries_from_sentencepiece_pieces() {
        let vocab = vec![
            "\u{2581}hello".to_string(),
            "\u{2581}wor".to_string(),
            "ld".to_string(),
            "!".to_string(),
        ];
        assert_eq!(detokenize(&vocab, &[0, 1, 2, 3]), "hello world!");
        // An id past the end of the vocabulary is skipped rather than panicking:
        // a decode bug should not take the sidecar down with it.
        assert_eq!(detokenize(&vocab, &[0, 999]), "hello");
    }

    /// End-to-end decode against the real v3 export.
    ///
    /// Ignored by default because it needs the ~639 MB model. Run with the
    /// model directory in the environment:
    ///
    /// ```text
    /// PLAINSONG_PARAKEET_V3_DIR="$HOME/Library/Application Support/Plainsong/models/parakeet/parakeet-tdt-0.6b-v3" \
    ///   cargo test --lib parakeet_v3_real_model -- --ignored --nocapture
    /// ```
    ///
    /// The repo ships `test_wavs/{en,de,es,fr}.wav`, so this also demonstrates
    /// the multilingual claim rather than asserting it.
    #[test]
    #[ignore]
    fn parakeet_v3_real_model_transcribes_the_shipped_clips() {
        use ort::session::Session;
        use std::path::PathBuf;

        let Ok(dir) = std::env::var("PLAINSONG_PARAKEET_V3_DIR") else {
            eprintln!("PLAINSONG_PARAKEET_V3_DIR not set; skipping");
            return;
        };
        let dir = PathBuf::from(dir);

        let vocab: Vec<String> = std::fs::read_to_string(dir.join("tokens.txt"))
            .expect("tokens.txt")
            .lines()
            .map(|line| match line.rfind(' ') {
                Some(index) => line[..index].to_string(),
                None => line.to_string(),
            })
            .collect();
        assert_eq!(
            vocab.get(V3_BLANK_ID).map(String::as_str),
            Some("<blk>"),
            "blank id must line up with tokens.txt"
        );

        let mut encoder = Session::builder()
            .expect("session builder")
            .commit_from_file(dir.join("encoder.int8.onnx"))
            .expect("encoder");
        let mut decoder = Session::builder()
            .expect("session builder")
            .commit_from_file(dir.join("decoder.int8.onnx"))
            .expect("decoder");
        let mut joiner = Session::builder()
            .expect("session builder")
            .commit_from_file(dir.join("joiner.int8.onnx"))
            .expect("joiner");

        for language in ["en", "de", "es", "fr"] {
            let wav_path = dir.join("test_wavs").join(format!("{language}.wav"));
            let mut reader = hound::WavReader::open(&wav_path).expect("wav");
            let samples: Vec<f32> = reader
                .samples::<i16>()
                .map(|sample| sample.expect("sample") as f32 / i16::MAX as f32)
                .collect();

            let mel = crate::audio::mel::MelSpectrogram::parakeet_v3_defaults();
            let spec = mel.compute_normalized(&samples);
            let n_mels = spec.len();
            let n_frames = spec[0].len();
            assert_eq!(n_mels, 128, "v3 encoder declares feat_dim 128");

            let mut flat = Vec::with_capacity(n_mels * n_frames);
            for bin in &spec {
                flat.extend(bin.iter().copied());
            }
            let signal = Array::from_shape_vec(IxDyn(&[1, n_mels, n_frames]), flat).expect("mel");
            let length = Array::from_shape_vec(IxDyn(&[1]), vec![n_frames as i64]).expect("length");

            let encoded = encoder
                .run(ort::inputs![
                    "audio_signal" => Tensor::from_array(signal).expect("signal"),
                    "length" => Tensor::from_array(length).expect("len"),
                ])
                .expect("encoder run");

            let encoder_array = encoded["outputs"]
                .try_extract_array::<f32>()
                .expect("encoder outputs");
            let shape = encoder_array.shape().to_vec();
            let frames = shape[2];
            let values: Vec<f32> = encoder_array.iter().copied().collect();
            assert_eq!(shape[1], V3_ENCODER_DIM);

            let tokens = greedy_decode(
                &mut decoder,
                &mut joiner,
                &values,
                V3_ENCODER_DIM,
                frames,
                V3_BLANK_ID,
            )
            .expect("decode");
            let text = detokenize(&vocab, &tokens);
            eprintln!("[{language}] {text}");

            assert!(
                !text.is_empty(),
                "{language}.wav decoded to nothing; the duration head or blank id is wrong"
            );

            // English is pinned exactly. A transducer with a mis-read duration
            // head still emits fluent text, so "not empty" proves very little —
            // only a known transcript catches decode that has drifted out of
            // alignment with the audio.
            if language == "en" {
                assert_eq!(
                    text,
                    "Ask not what your country can do for you. Ask what you can do for your country."
                );
            }

            // de and fr also decode to correct, idiomatic sentences. es decodes
            // to text that does not look like Spanish; en/de/fr being right
            // means the frontend, blank id and duration head are sound, so this
            // is either a mislabelled upstream fixture or a genuine miss on
            // that clip. Recorded rather than asserted, and worth settling
            // before Spanish appears in any language list we publish.
        }
    }
}
