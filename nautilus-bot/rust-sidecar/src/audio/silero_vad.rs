//! Silero VAD: a small, MIT-licensed ONNX voice-activity-detection model
//! (<https://github.com/snakers4/silero-vad>) used as a more accurate,
//! optional v2 backend alongside [`super::vad::StreamingVadGate`]'s cheap
//! energy-threshold heuristic.
//!
//! Unlike `StreamingVadGate` (which classifies frames from a single scalar
//! RMS-dB value), Silero VAD is a tiny recurrent network that classifies
//! fixed-size raw-waveform chunks directly (no mel/spectral preprocessing)
//! and carries a small LSTM-style state tensor between chunks. That state
//! must be threaded from call to call in chunk order for the model's
//! temporal context to mean anything, which is why [`SileroVadDetector`] is
//! a `&mut self` stateful type rather than a pure function.
//!
//! # Model contract (verified against the actual upstream ONNX file)
//!
//! Confirmed by downloading and byte-inspecting
//! `snakers4/silero-vad` at the immutable revision pinned by `crate::download`
//! (the file shipped in the `snakers4/silero-vad` GitHub repo) and cross-checking
//! against the upstream Python wrapper
//! (`src/silero_vad/utils_vad.py::OnnxWrapper`) as of the version current at
//! the time this module was written:
//!
//! * Inputs:
//!   * `"input"`: `f32` tensor of shape `[1, context_size + chunk_size]` --
//!     the last `context_size` samples of the *previous* call's input,
//!     followed by the new chunk. This is a wrapper-level convenience the
//!     upstream Python code performs before calling the ONNX session; there
//!     is no separate `"context"` graph input.
//!   * `"state"`: `f32` tensor of shape `[2, 1, 128]` (LSTM-style recurrent
//!     state; batch size fixed at 1 for our single-stream use).
//!   * `"sr"`: `i64` scalar tensor (shape `[1]`) with the sample rate
//!     (16000 or 8000).
//! * Outputs (in this order): `"output"` (the `f32` speech probability) and
//!   `"stateN"` (the updated state tensor, same shape as the `"state"` input).
//! * Chunk size is fixed by sample rate: 512 samples / 64-sample context at
//!   16 kHz, 256 samples / 32-sample context at 8 kHz. No other chunk size
//!   is accepted by the upstream model.
//!
//! The model itself only supports 16 kHz here (matching `VadConfig::default`),
//! but dictation/hands-free capture runs at the input device's native rate
//! (typically 44.1/48 kHz). [`SileroBackedVadGate`] therefore resamples its
//! input down to [`SILERO_VAD_MODEL_SAMPLE_RATE`] before chunking whenever the
//! configured capture rate differs, so the model's `"sr"` contract is honored
//! on every real device.

use crate::audio::vad::{VadBackendKind, VadConfig, VadEdge, VadGate};
use anyhow::{Context, Result};

/// Fixed input chunk size (in samples) Silero VAD requires at 16 kHz.
/// The model does not accept any other chunk length at this sample rate.
pub const SILERO_VAD_CHUNK_SAMPLES: usize = 512;

/// Number of trailing samples from the previous chunk that must be
/// prepended to the next chunk before inference, per the upstream
/// `OnnxWrapper` at 16 kHz.
const SILERO_VAD_CONTEXT_SAMPLES: usize = 64;

/// Recurrent state tensor shape: `[num_layers * directions, batch, hidden]`.
const SILERO_VAD_STATE_SHAPE: [usize; 3] = [2, 1, 128];
const SILERO_VAD_STATE_LEN: usize =
    SILERO_VAD_STATE_SHAPE[0] * SILERO_VAD_STATE_SHAPE[1] * SILERO_VAD_STATE_SHAPE[2];

/// Sample rate the Silero model is run at (and fed to its `"sr"` input).
/// [`SileroBackedVadGate`] resamples device-rate capture input down to this
/// rate before chunking, so the value is always accurate at inference time.
pub const SILERO_VAD_MODEL_SAMPLE_RATE: u32 = 16_000;

/// Backing inference implementation, swappable so unit tests can exercise
/// the chunk-buffering / state-plumbing logic without loading a real ONNX
/// model file (mirrors how `parakeet.rs` / `moonshine.rs` feature-gate their
/// real `ort::Session`-based inference behind `#[cfg(feature = "asr-parakeet")]`
/// and are otherwise untestable in CI without a downloaded model; here we
/// additionally expose a trait seam so the surrounding stateful logic --
/// the part most likely to have an off-by-one bug -- is covered without ort
/// or a model file at all).
trait SileroVadBackend: Send {
    /// Run one inference step. `input` is the full `[context + chunk]`
    /// samples (already concatenated), `state_in` is the current recurrent
    /// state (`SILERO_VAD_STATE_LEN` elements). Returns `(speech_probability,
    /// new_state)` where `new_state` has the same length as `state_in`.
    fn infer(&mut self, input: &[f32], state_in: &[f32]) -> Result<(f32, Vec<f32>)>;
}

/// Real ONNX-backed implementation using `ort`, following the same
/// session-creation pattern as `ParakeetProvider`/`MoonshineProvider`
/// (`Session::builder()...commit_from_file`, `ort::inputs!`, `.run`,
/// `try_extract_array::<f32>()`).
#[cfg(feature = "asr-parakeet")]
struct OrtSileroVadBackend {
    session: ort::session::Session,
}

#[cfg(feature = "asr-parakeet")]
impl OrtSileroVadBackend {
    fn load(onnx_path: &std::path::Path) -> Result<Self> {
        use ort::session::builder::GraphOptimizationLevel;
        use ort::session::Session;

        let session = Session::builder()
            .context("Failed to create Silero VAD ONNX session builder")?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|error| anyhow::anyhow!("Failed to set Silero VAD opt level: {error}"))?
            .commit_from_file(onnx_path)
            .context("Failed to load Silero VAD ONNX model")?;

        Ok(Self { session })
    }
}

#[cfg(feature = "asr-parakeet")]
impl SileroVadBackend for OrtSileroVadBackend {
    fn infer(&mut self, input: &[f32], state_in: &[f32]) -> Result<(f32, Vec<f32>)> {
        use ndarray::{Array, IxDyn};
        use ort::value::Tensor;

        anyhow::ensure!(
            state_in.len() == SILERO_VAD_STATE_LEN,
            "Silero VAD state buffer has wrong length: expected {}, got {}",
            SILERO_VAD_STATE_LEN,
            state_in.len()
        );

        let input_arr: Array<f32, IxDyn> =
            Array::from_shape_vec(IxDyn(&[1, input.len()]), input.to_vec())
                .context("Failed to build Silero VAD input array")?;
        let state_arr: Array<f32, IxDyn> =
            Array::from_shape_vec(IxDyn(&SILERO_VAD_STATE_SHAPE), state_in.to_vec())
                .context("Failed to build Silero VAD state array")?;
        let sr_arr: Array<i64, IxDyn> =
            Array::from_shape_vec(IxDyn(&[1]), vec![i64::from(SILERO_VAD_MODEL_SAMPLE_RATE)])
                .context("Failed to build Silero VAD sample-rate array")?;

        let input_tensor =
            Tensor::from_array(input_arr).context("Failed to create Silero VAD input tensor")?;
        let state_tensor =
            Tensor::from_array(state_arr).context("Failed to create Silero VAD state tensor")?;
        let sr_tensor =
            Tensor::from_array(sr_arr).context("Failed to create Silero VAD sr tensor")?;

        let outputs = self
            .session
            .run(ort::inputs![
                "input" => input_tensor,
                "state" => state_tensor,
                "sr" => sr_tensor,
            ])
            .map_err(|error| anyhow::anyhow!("Silero VAD ONNX inference failed: {error}"))?;

        let prob_array = outputs[0]
            .try_extract_array::<f32>()
            .context("Failed to extract Silero VAD speech-probability output")?;
        let probability = prob_array
            .iter()
            .next()
            .copied()
            .context("Silero VAD output tensor was empty")?;

        let state_out_array = outputs[1]
            .try_extract_array::<f32>()
            .context("Failed to extract Silero VAD updated-state output")?;
        let new_state: Vec<f32> = state_out_array.iter().copied().collect();
        anyhow::ensure!(
            new_state.len() == SILERO_VAD_STATE_LEN,
            "Silero VAD returned unexpected state length: expected {}, got {}",
            SILERO_VAD_STATE_LEN,
            new_state.len()
        );

        Ok((probability, new_state))
    }
}

/// Stateful Silero VAD detector: buffers callers' fixed-size chunks, carries
/// the recurrent state tensor between calls, and reports a speech
/// probability in `[0.0, 1.0]` per chunk.
///
/// Callers MUST provide exactly [`SILERO_VAD_CHUNK_SAMPLES`] samples per
/// call to [`Self::detect_speech_probability`] -- this mirrors how other
/// providers in this codebase (e.g. Parakeet's raw-audio path, Moonshine)
/// are strict about their input contract rather than silently resampling or
/// padding. Buffer to the exact chunk size before calling.
pub struct SileroVadDetector {
    backend: Box<dyn SileroVadBackend + Send>,
    /// Recurrent state carried between chunks; length is always
    /// `SILERO_VAD_STATE_LEN`.
    state: Vec<f32>,
    /// Trailing `SILERO_VAD_CONTEXT_SAMPLES` samples from the previous
    /// chunk, prepended to the next chunk before inference. Starts as
    /// zeros (matching `OnnxWrapper.reset_states()`, which zero-fills
    /// `self._context` too).
    context: Vec<f32>,
}

impl SileroVadDetector {
    /// Load the Silero VAD ONNX model from `onnx_path` and initialize a
    /// fresh (zeroed) recurrent state, ready to process a new audio stream.
    #[cfg(feature = "asr-parakeet")]
    pub fn load(onnx_path: &std::path::Path) -> Result<Self> {
        let backend = OrtSileroVadBackend::load(onnx_path)?;
        Ok(Self::from_backend(Box::new(backend)))
    }

    #[cfg(not(feature = "asr-parakeet"))]
    pub fn load(_onnx_path: &std::path::Path) -> Result<Self> {
        Err(anyhow::anyhow!(
            "Silero VAD support is not compiled in. Rebuild with the `asr-parakeet` feature."
        ))
    }

    fn from_backend(backend: Box<dyn SileroVadBackend + Send>) -> Self {
        Self {
            backend,
            state: vec![0.0; SILERO_VAD_STATE_LEN],
            context: vec![0.0; SILERO_VAD_CONTEXT_SAMPLES],
        }
    }

    /// Reset the recurrent state and context window to zero, as when
    /// starting inference on a new, unrelated audio stream (mirrors
    /// upstream `OnnxWrapper.reset_states()`). Kept for API symmetry /
    /// future reuse-across-sessions callers; only exercised in this
    /// module's own tests today, so it is genuinely unused outside
    /// `#[cfg(test)]` builds (hence the `cfg_attr`-gated `expect` below,
    /// rather than an unconditional one that would be "unfulfilled" when
    /// clippy checks the `--tests` target where it *is* called).
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "kept for API symmetry / future reuse-across-sessions callers; exercised in tests"
        )
    )]
    pub fn reset(&mut self) {
        self.state.iter_mut().for_each(|value| *value = 0.0);
        self.context.iter_mut().for_each(|value| *value = 0.0);
    }

    /// Run Silero VAD on exactly one [`SILERO_VAD_CHUNK_SAMPLES`]-sample
    /// chunk of 16 kHz f32 PCM, returning the model's speech probability in
    /// `[0.0, 1.0]`. Advances (and persists) the recurrent state/context for
    /// the next call.
    ///
    /// Returns an error if `chunk.len() != SILERO_VAD_CHUNK_SAMPLES` --
    /// callers are required to buffer to the exact chunk size themselves
    /// rather than have this method silently pad or truncate.
    pub fn detect_speech_probability(&mut self, chunk: &[f32]) -> Result<f32, String> {
        if chunk.len() != SILERO_VAD_CHUNK_SAMPLES {
            return Err(format!(
                "Silero VAD requires exactly {} samples per chunk, got {}",
                SILERO_VAD_CHUNK_SAMPLES,
                chunk.len()
            ));
        }

        let mut model_input = Vec::with_capacity(SILERO_VAD_CONTEXT_SAMPLES + chunk.len());
        model_input.extend_from_slice(&self.context);
        model_input.extend_from_slice(chunk);

        let (probability, new_state) = self
            .backend
            .infer(&model_input, &self.state)
            .map_err(|error| format!("Silero VAD inference failed: {error}"))?;

        self.state = new_state;
        // Keep the trailing context_size samples of this call's (context ++
        // chunk) input as next call's context, matching
        // `self._context = x[..., -context_size:]` in the upstream wrapper.
        let context_start = model_input.len() - SILERO_VAD_CONTEXT_SAMPLES;
        self.context.clear();
        self.context
            .extend_from_slice(&model_input[context_start..]);

        Ok(probability.clamp(0.0, 1.0))
    }
}

/// Speech-probability threshold above which a Silero chunk counts as
/// "speech" for the hysteresis latch below. Silero's own upstream defaults
/// recommend 0.5 as the standard operating point.
const SILERO_SPEECH_PROBABILITY_THRESHOLD: f32 = 0.5;

/// Streaming linear resampler used to convert device-rate capture audio
/// (typically 44.1/48 kHz) down to [`SILERO_VAD_MODEL_SAMPLE_RATE`] before
/// chunking for the model.
///
/// Linear interpolation is deliberate: it is O(1) per output sample with no
/// allocation (safe for the cpal callback path that drives
/// [`SileroBackedVadGate::push_samples`]), and VAD only needs the coarse
/// spectral envelope to survive, not audiophile-grade anti-aliasing -- the
/// same trade-off `audio::utils::resample` already makes for batch ASR
/// preprocessing. Unlike that batch helper, this one carries its fractional
/// read position and the last input sample across calls, so chunk boundaries
/// introduced by the audio callback cadence don't create discontinuities.
struct StreamingResampler {
    /// Input samples advanced per output sample (`from_rate / to_rate`).
    step: f64,
    /// Fractional position (in input samples) of the next output sample,
    /// relative to the start of `[carry, input...]` for the current call.
    pos: f64,
    /// Last input sample from the previous call, kept so interpolation is
    /// continuous across call boundaries.
    carry: Option<f32>,
}

impl StreamingResampler {
    fn new(from_rate: u32, to_rate: u32) -> Self {
        Self {
            step: f64::from(from_rate.max(1)) / f64::from(to_rate.max(1)),
            pos: 0.0,
            carry: None,
        }
    }

    /// Resample `input` and append the output samples to `output`.
    fn process(&mut self, input: &[f32], output: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }
        let carry_len = usize::from(self.carry.is_some());
        let total_len = carry_len + input.len();
        let sample_at = |index: usize| -> f32 {
            if index < carry_len {
                self.carry.unwrap_or(0.0)
            } else {
                input[index - carry_len]
            }
        };

        // Emit every output sample whose interpolation neighbors are both
        // available in `[carry, input...]`.
        while self.pos + 1.0 < total_len as f64 {
            let index = self.pos as usize;
            let frac = (self.pos - index as f64) as f32;
            output.push(sample_at(index) * (1.0 - frac) + sample_at(index + 1) * frac);
            self.pos += self.step;
        }

        // Keep the final input sample for next call's interpolation and
        // rebase the read position onto it (the loop guarantees
        // `pos >= total_len - 1` on exit, so the new position is >= 0).
        self.carry = Some(sample_at(total_len - 1));
        self.pos -= (total_len - 1) as f64;
    }
}

/// Messages sent from the background inference worker (see
/// [`SileroBackedVadGate`]) back to the real-time-adjacent caller.
enum SileroWorkerMsg {
    /// A chunk was scored successfully.
    Probability(f32),
    /// Inference failed (model corrupt, ORT runtime error, etc). Sent at most
    /// once; the worker thread exits immediately after, so the gate must
    /// switch to its fallback for the rest of the session.
    Failed(String),
}

/// Silero-backed [`VadGate`] implementation.
///
/// # Why inference is offloaded to a background thread
///
/// Silero's ONNX model is real-time-or-faster on CPU for its target chunk
/// size, but it is still orders of magnitude heavier than
/// `StreamingVadGate::push_frame`'s O(1) arithmetic (a mel-free but still
/// full recurrent-network forward pass per chunk), and its latency is not
/// bounded the way simple arithmetic is -- a page fault, thermal throttle,
/// or OS scheduling hiccup could make one inference call take
/// arbitrarily long. cpal's input callback runs on a real-time-priority
/// audio thread that must never block, so calling `SileroVadDetector`
/// synchronously from it (the way `StreamingVadGate::push_frame` safely can)
/// would risk audio dropouts.
///
/// This mirrors the existing streaming-partials pattern in `audio.rs`
/// (`dictation_partial_buffer` + the `tokio::spawn`ed re-decode task in
/// `lib.rs`): the audio thread only ever does cheap, non-blocking buffer
/// pushes / channel sends, and all heavy decode work happens off-thread.
/// Concretely: [`Self::push_samples`] (called from the cpal callback) only
/// buffers samples locally and does a non-blocking `try_send` of each full
/// chunk to a dedicated background thread that owns the actual
/// `SileroVadDetector` and runs `detect_speech_probability`; results come
/// back over a second channel that `push_samples` drains with `try_recv`
/// (never blocking). If the outbound channel is ever full (the worker
/// falling behind), the newest chunk is simply dropped rather than blocking
/// the audio thread or unboundedly growing memory -- a missed VAD chunk just
/// delays a state-transition decision by one chunk (~32ms), which is
/// immaterial next to the multi-hundred-ms hysteresis windows auto-stop/
/// auto-start already use.
///
/// # Fallback
///
/// If model loading fails (missing/corrupt download) this type is never
/// constructed -- see `build_vad_gate`, which falls back to
/// `EnergyThresholdVadGate` at that point instead. If inference *itself*
/// fails after the gate is already running (a runtime ORT error), the
/// background worker reports it exactly once via `SileroWorkerMsg::Failed`
/// and exits; `push_samples` observes that and permanently switches this
/// gate over to an internal `EnergyThresholdVadGate` for the rest of the
/// session, so a mid-session model failure degrades to the energy heuristic
/// instead of silently disabling auto-stop/auto-start.
pub struct SileroBackedVadGate {
    /// Sends full `SILERO_VAD_CHUNK_SAMPLES`-sized chunks to the background
    /// worker. Dropped (along with the worker thread exiting) once
    /// `fallback` is engaged, since nothing reads from `result_rx` after
    /// that point either.
    chunk_tx: crossbeam::channel::Sender<Vec<f32>>,
    /// Receives speech-probability results (or a failure notice) from the
    /// background worker.
    result_rx: crossbeam::channel::Receiver<SileroWorkerMsg>,
    /// Join handle for the background worker thread; kept so it isn't
    /// detached (and so `Drop` semantics are ordinary), though we never need
    /// to explicitly join it -- the worker exits on its own once `chunk_tx`
    /// is dropped or inference fails.
    _worker: std::thread::JoinHandle<()>,
    /// Samples accumulated so far towards the next full
    /// `SILERO_VAD_CHUNK_SAMPLES` chunk, always at
    /// [`SILERO_VAD_MODEL_SAMPLE_RATE`] (post-resampling).
    pending_samples: Vec<f32>,
    /// Converts device-rate input to [`SILERO_VAD_MODEL_SAMPLE_RATE`] before
    /// chunking. `None` when the capture already runs at the model rate.
    resampler: Option<StreamingResampler>,
    /// Chunks per second at the model rate, i.e.
    /// `SILERO_VAD_MODEL_SAMPLE_RATE / SILERO_VAD_CHUNK_SAMPLES` (a constant
    /// 31.25 regardless of the device rate, since input is resampled to the
    /// model rate before chunking).
    chunks_per_second: f32,
    /// Hysteresis: consecutive speech-probability chunks required before
    /// latching into "speech" (mirrors `StreamingVadGate`'s `min_speech_frames`,
    /// expressed in Silero chunks instead of energy-gate frames).
    min_speech_chunks: u32,
    /// Hysteresis: consecutive low-probability chunks required before
    /// latching back into "silence".
    min_silence_chunks: u32,
    in_speech: bool,
    above_run: u32,
    below_run: u32,
    /// Once set, this gate has permanently given up on Silero for the rest
    /// of its lifetime (a runtime inference failure was reported) and
    /// delegates every subsequent call to `fallback` instead.
    fallback: Option<super::vad::EnergyThresholdVadGate>,
    /// Config stashed so `fallback` can be constructed lazily, only if/when
    /// a runtime failure actually occurs.
    fallback_config: VadConfig,
}

impl SileroBackedVadGate {
    /// Build a gate backed by a freshly loaded [`SileroVadDetector`] at
    /// `onnx_path`, spawning its dedicated background inference thread.
    ///
    /// Returns an error (without spawning anything) if the model fails to
    /// load, so callers (`build_vad_gate`) can fall back to
    /// `EnergyThresholdVadGate` up front rather than ever constructing this
    /// type in a half-working state.
    pub fn load(onnx_path: &std::path::Path, config: &VadConfig) -> Result<Self> {
        let detector = SileroVadDetector::load(onnx_path)
            .context("Failed to load Silero VAD model for streaming gate")?;
        Ok(Self::from_detector(detector, config))
    }

    fn from_detector(mut detector: SileroVadDetector, config: &VadConfig) -> Self {
        // Bounded to a small number of in-flight chunks: the worker is
        // expected to keep up in real time, so this is just enough slack to
        // absorb a brief scheduling hiccup without growing unboundedly. Once
        // full, `push_samples` drops new chunks rather than blocking.
        let (chunk_tx, chunk_rx) = crossbeam::channel::bounded::<Vec<f32>>(4);
        let (result_tx, result_rx) = crossbeam::channel::bounded::<SileroWorkerMsg>(4);

        let worker = std::thread::Builder::new()
            .name("silero-vad-worker".to_string())
            .spawn(move || {
                for chunk in chunk_rx.iter() {
                    match detector.detect_speech_probability(&chunk) {
                        Ok(probability) => {
                            // Best-effort: if the receiver has hung up (gate
                            // dropped), there's nothing left to notify.
                            let _ = result_tx.send(SileroWorkerMsg::Probability(probability));
                        }
                        Err(error) => {
                            let _ = result_tx.send(SileroWorkerMsg::Failed(error));
                            // Stop after the first failure: the caller will
                            // switch to its fallback gate, so there is no
                            // point keeping this worker (and its now-suspect
                            // detector state) alive.
                            return;
                        }
                    }
                }
            })
            .expect("failed to spawn silero-vad-worker thread");

        // The model contract is fixed at 16 kHz, but dictation/hands-free
        // capture runs at the device's native rate (typically 44.1/48 kHz on
        // macOS). Feeding device-rate samples straight in would present
        // time-stretched, pitched-down audio labeled as 16 kHz, so resample
        // to the model rate first. Chunk timing is therefore always at the
        // model rate too.
        let resampler = (config.sample_rate != SILERO_VAD_MODEL_SAMPLE_RATE).then(|| {
            StreamingResampler::new(config.sample_rate.max(1), SILERO_VAD_MODEL_SAMPLE_RATE)
        });
        let chunks_per_second =
            SILERO_VAD_MODEL_SAMPLE_RATE as f32 / SILERO_VAD_CHUNK_SAMPLES as f32;
        let min_speech_chunks = (config.min_speech_duration * chunks_per_second)
            .ceil()
            .max(1.0) as u32;
        let min_silence_chunks = (config.min_silence_duration * chunks_per_second)
            .ceil()
            .max(1.0) as u32;

        Self {
            chunk_tx,
            result_rx,
            _worker: worker,
            pending_samples: Vec::with_capacity(SILERO_VAD_CHUNK_SAMPLES),
            resampler,
            chunks_per_second,
            min_speech_chunks,
            min_silence_chunks,
            in_speech: false,
            above_run: 0,
            below_run: 0,
            fallback: None,
            fallback_config: config.clone(),
        }
    }

    /// Apply one chunk's speech probability to the hysteresis latch,
    /// returning the resulting edge. Same shape of logic as
    /// `StreamingVadGate::push_frame`, just keyed on a probability threshold
    /// instead of an energy-vs-noise-floor comparison.
    fn apply_probability(&mut self, probability: f32) -> VadEdge {
        let is_speech = probability >= SILERO_SPEECH_PROBABILITY_THRESHOLD;
        let mut edge = VadEdge::NoChange;

        if is_speech {
            self.below_run = 0;
            if !self.in_speech {
                self.above_run += 1;
                if self.above_run >= self.min_speech_chunks {
                    self.in_speech = true;
                    self.above_run = 0;
                    edge = VadEdge::SpeechStarted;
                }
            }
        } else {
            self.above_run = 0;
            if self.in_speech {
                self.below_run += 1;
                if self.below_run >= self.min_silence_chunks {
                    self.in_speech = false;
                    self.below_run = 0;
                    edge = VadEdge::SilenceStarted;
                }
            }
        }

        edge
    }

    /// Drain any results the worker has produced since the last call,
    /// applying each to the hysteresis latch in order. Never blocks.
    fn drain_results(&mut self) -> VadEdge {
        let mut most_significant = VadEdge::NoChange;
        loop {
            match self.result_rx.try_recv() {
                Ok(SileroWorkerMsg::Probability(probability)) => {
                    let edge = self.apply_probability(probability);
                    if edge != VadEdge::NoChange {
                        most_significant = edge;
                    }
                }
                Ok(SileroWorkerMsg::Failed(error)) => {
                    tracing::warn!(
                        "Silero VAD inference failed at runtime, falling back to \
                         energy-threshold VAD for the remainder of this session: {}",
                        error
                    );
                    let mut fallback =
                        super::vad::EnergyThresholdVadGate::new(&self.fallback_config);
                    // Feed through any samples buffered towards Silero's next
                    // chunk that never got a chance to be scored, so the
                    // fallback doesn't silently lose that audio.
                    let edge = fallback.push_samples(&self.pending_samples);
                    self.pending_samples.clear();
                    self.fallback = Some(fallback);
                    if edge != VadEdge::NoChange {
                        most_significant = edge;
                    }
                    return most_significant;
                }
                Err(crossbeam::channel::TryRecvError::Empty) => break,
                Err(crossbeam::channel::TryRecvError::Disconnected) => break,
            }
        }
        most_significant
    }
}

impl VadGate for SileroBackedVadGate {
    fn push_samples(&mut self, mono_samples: &[f32]) -> VadEdge {
        // Once we've fallen back, Silero is out of the picture entirely for
        // the rest of this session -- delegate straight through.
        if let Some(fallback) = self.fallback.as_mut() {
            return fallback.push_samples(mono_samples);
        }

        // `pending_samples` is kept at the model rate; the fallback handoffs
        // below feed it into a device-rate energy gate, but at most one
        // partial chunk (~32ms of audio) is ever pending, so the resulting
        // timing skew is immaterial next to the hysteresis windows.
        match self.resampler.as_mut() {
            Some(resampler) => resampler.process(mono_samples, &mut self.pending_samples),
            None => self.pending_samples.extend_from_slice(mono_samples),
        }

        let mut chunk_start = 0;
        while self.pending_samples.len() - chunk_start >= SILERO_VAD_CHUNK_SAMPLES {
            let chunk_end = chunk_start + SILERO_VAD_CHUNK_SAMPLES;
            let chunk = self.pending_samples[chunk_start..chunk_end].to_vec();

            // Non-blocking: if the worker is falling behind and the bounded
            // channel is full, drop this chunk rather than stall the audio
            // thread. A dropped chunk just delays the next VAD decision by
            // one chunk (~32ms) -- immaterial next to the hysteresis windows.
            match self.chunk_tx.try_send(chunk) {
                Ok(()) | Err(crossbeam::channel::TrySendError::Full(_)) => {
                    chunk_start = chunk_end;
                }
                Err(crossbeam::channel::TrySendError::Disconnected(_)) => {
                    // Worker thread exited without going through the normal
                    // `Failed` path (should not happen, but degrade safely
                    // rather than silently stop producing edges). Hand off
                    // every sample we have buffered so far -- including this
                    // and any later still-unchunked tail -- to a fresh
                    // fallback gate rather than dropping audio on the floor.
                    tracing::warn!(
                        "Silero VAD worker channel disconnected unexpectedly; \
                         falling back to energy-threshold VAD"
                    );
                    let mut fallback =
                        super::vad::EnergyThresholdVadGate::new(&self.fallback_config);
                    let edge = fallback.push_samples(&self.pending_samples[chunk_start..]);
                    self.fallback = Some(fallback);
                    self.pending_samples.clear();
                    return edge;
                }
            }
        }
        // Keep any leftover partial chunk for next call.
        if chunk_start > 0 {
            self.pending_samples.drain(0..chunk_start);
        }

        self.drain_results()
    }

    fn is_speaking(&self) -> bool {
        if let Some(fallback) = self.fallback.as_ref() {
            return fallback.is_speaking();
        }
        self.in_speech
    }

    fn frames_per_second(&self) -> f32 {
        if let Some(fallback) = self.fallback.as_ref() {
            return fallback.frames_per_second();
        }
        self.chunks_per_second
    }

    fn backend_name(&self) -> &'static str {
        if self.fallback.is_some() {
            "energy_threshold_fallback"
        } else {
            "silero"
        }
    }
}

/// Build a [`VadGate`] for the requested `kind`.
///
/// This is the single factory both `AudioCapture::start_dictation` and
/// `AudioCapture::start_hands_free_monitor` (in `audio.rs`) call -- neither
/// call site branches on `VadBackendKind` itself, so adding a future third
/// backend only requires a change here.
///
/// * `VadBackendKind::EnergyThreshold` always succeeds (no model, no I/O).
/// * `VadBackendKind::Silero` requires `silero_model_path`. If it is `None`
///   (model not downloaded), or loading the model at that path fails for any
///   reason (missing file, corrupt ONNX, incompatible `ort` runtime, etc.),
///   this transparently falls back to `EnergyThreshold` and logs a warning --
///   it never returns an error and never leaves auto-stop/auto-start
///   disabled just because Silero wasn't available. This is what satisfies
///   the "graceful fallback" requirement for hands-free/auto-stop: whatever
///   the user picked in settings, they still get a working VAD gate.
pub fn build_vad_gate(
    kind: VadBackendKind,
    config: &VadConfig,
    silero_model_path: Option<&std::path::Path>,
) -> Box<dyn VadGate + Send> {
    match kind {
        VadBackendKind::EnergyThreshold => {
            Box::new(super::vad::EnergyThresholdVadGate::new(config))
        }
        VadBackendKind::Silero => {
            let Some(path) = silero_model_path else {
                tracing::warn!(
                    "Silero VAD selected but no model path was provided (model not \
                     downloaded); falling back to energy-threshold VAD"
                );
                return Box::new(super::vad::EnergyThresholdVadGate::new(config));
            };
            if !path.exists() {
                tracing::warn!(
                    "Silero VAD selected but model file does not exist at {:?}; \
                     falling back to energy-threshold VAD",
                    path
                );
                return Box::new(super::vad::EnergyThresholdVadGate::new(config));
            }
            match SileroBackedVadGate::load(path, config) {
                Ok(gate) => Box::new(gate),
                Err(error) => {
                    tracing::warn!(
                        "Failed to load Silero VAD model ({}); falling back to \
                         energy-threshold VAD",
                        error
                    );
                    // The file exists but won't load (truncated/corrupt
                    // download): quarantine it so
                    // `is_silero_vad_model_downloaded()` stops reporting the
                    // model as available and the Settings UI offers a fresh
                    // download, instead of silently degrading to the fallback
                    // on every session forever. Only when ort support is
                    // compiled in -- otherwise the load error just means
                    // "feature missing", not "file corrupt".
                    #[cfg(feature = "asr-parakeet")]
                    {
                        let quarantine_path = path.with_extension("onnx.corrupt");
                        match std::fs::rename(path, &quarantine_path) {
                            Ok(()) => tracing::warn!(
                                "Quarantined unloadable Silero VAD model to {:?}; \
                                 re-download it from Settings to restore the Silero backend",
                                quarantine_path
                            ),
                            Err(rename_error) => tracing::warn!(
                                "Failed to quarantine unloadable Silero VAD model {:?}: {}",
                                path,
                                rename_error
                            ),
                        }
                    }
                    Box::new(super::vad::EnergyThresholdVadGate::new(config))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// One recorded `infer()` call: `(model_input, state_in)`.
    type RecordedCall = (Vec<f32>, Vec<f32>);
    type CallLog = Arc<Mutex<Vec<RecordedCall>>>;

    /// Stub backend for exercising chunk-buffering / state-plumbing logic
    /// without an ort session or a downloaded model file. Records every
    /// `(input, state_in)` pair it was called with (via a shared handle so
    /// tests can inspect call history after the fact) and returns a
    /// caller-controlled speech probability plus a deterministic "next
    /// state" derived from the call count, so tests can assert the state
    /// returned by one call is exactly what gets passed into the next.
    struct StubBackend {
        probability: f32,
        call_log: CallLog,
        call_count: Arc<Mutex<u32>>,
    }

    impl SileroVadBackend for StubBackend {
        fn infer(&mut self, input: &[f32], state_in: &[f32]) -> Result<(f32, Vec<f32>)> {
            self.call_log
                .lock()
                .unwrap()
                .push((input.to_vec(), state_in.to_vec()));
            let mut count_guard = self.call_count.lock().unwrap();
            let call_index = *count_guard;
            *count_guard += 1;
            // Deterministic "new state": every element set to call_index + 1,
            // so tests can assert exact propagation between calls.
            let new_state = vec![(call_index + 1) as f32; SILERO_VAD_STATE_LEN];
            Ok((self.probability, new_state))
        }
    }

    fn detector_with_stub(probability: f32) -> (SileroVadDetector, CallLog) {
        let call_log = Arc::new(Mutex::new(Vec::new()));
        let call_count = Arc::new(Mutex::new(0));
        let backend = StubBackend {
            probability,
            call_log: Arc::clone(&call_log),
            call_count,
        };
        (SileroVadDetector::from_backend(Box::new(backend)), call_log)
    }

    #[test]
    fn rejects_wrong_chunk_size() {
        let (mut detector, _log) = detector_with_stub(0.9);
        let too_short = vec![0.0_f32; SILERO_VAD_CHUNK_SAMPLES - 1];
        let result = detector.detect_speech_probability(&too_short);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("exactly 512"));

        let too_long = vec![0.0_f32; SILERO_VAD_CHUNK_SAMPLES + 1];
        assert!(detector.detect_speech_probability(&too_long).is_err());
    }

    #[test]
    fn accepts_exact_chunk_size_and_returns_probability() {
        let (mut detector, _log) = detector_with_stub(0.73);
        let chunk = vec![0.1_f32; SILERO_VAD_CHUNK_SAMPLES];
        let probability = detector
            .detect_speech_probability(&chunk)
            .expect("exact-size chunk should succeed");
        assert!((probability - 0.73).abs() < 1e-6);
    }

    #[test]
    fn clamps_out_of_range_probability() {
        let (mut detector, _log) = detector_with_stub(1.5);
        let chunk = vec![0.1_f32; SILERO_VAD_CHUNK_SAMPLES];
        let probability = detector.detect_speech_probability(&chunk).unwrap();
        assert_eq!(probability, 1.0);

        let (mut detector_neg, _log2) = detector_with_stub(-0.2);
        let probability_neg = detector_neg.detect_speech_probability(&chunk).unwrap();
        assert_eq!(probability_neg, 0.0);
    }

    #[test]
    fn first_call_uses_zeroed_context_and_state() {
        let (mut detector, log) = detector_with_stub(0.5);
        let chunk: Vec<f32> = (0..SILERO_VAD_CHUNK_SAMPLES).map(|i| i as f32).collect();
        detector.detect_speech_probability(&chunk).unwrap();

        let calls = log.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let (model_input, state_in) = &calls[0];

        // Model input must be context_size + chunk_size long, with the
        // first context_size samples zeroed (initial context) and the rest
        // exactly equal to the chunk passed in.
        assert_eq!(
            model_input.len(),
            SILERO_VAD_CONTEXT_SAMPLES + SILERO_VAD_CHUNK_SAMPLES
        );
        assert!(model_input[..SILERO_VAD_CONTEXT_SAMPLES]
            .iter()
            .all(|&value| value == 0.0));
        assert_eq!(&model_input[SILERO_VAD_CONTEXT_SAMPLES..], chunk.as_slice());

        // Initial state must be zeroed, matching reset_states().
        assert_eq!(state_in.len(), SILERO_VAD_STATE_LEN);
        assert!(state_in.iter().all(|&value| value == 0.0));
    }

    #[test]
    fn second_call_context_is_tail_of_first_calls_model_input() {
        let (mut detector, log) = detector_with_stub(0.5);

        let chunk_a: Vec<f32> = (0..SILERO_VAD_CHUNK_SAMPLES).map(|i| i as f32).collect();
        let chunk_b: Vec<f32> = (0..SILERO_VAD_CHUNK_SAMPLES)
            .map(|i| 1000.0 + i as f32)
            .collect();

        detector.detect_speech_probability(&chunk_a).unwrap();
        detector.detect_speech_probability(&chunk_b).unwrap();

        let calls = log.lock().unwrap();
        assert_eq!(calls.len(), 2);

        let (first_model_input, _) = &calls[0];
        let (second_model_input, second_state_in) = &calls[1];

        // The context prefix of call 2 must equal the trailing
        // CONTEXT_SAMPLES of call 1's full model input (context ++ chunk),
        // not just the trailing samples of chunk_a alone.
        let expected_context =
            &first_model_input[first_model_input.len() - SILERO_VAD_CONTEXT_SAMPLES..];
        assert_eq!(
            &second_model_input[..SILERO_VAD_CONTEXT_SAMPLES],
            expected_context
        );
        assert_eq!(
            &second_model_input[SILERO_VAD_CONTEXT_SAMPLES..],
            chunk_b.as_slice()
        );

        // State fed into call 2 must be exactly what call 1 returned (all
        // 1.0s, per StubBackend's deterministic new-state rule).
        assert!(second_state_in.iter().all(|&value| value == 1.0));
    }

    #[test]
    fn reset_zeroes_state_and_context_for_a_fresh_stream() {
        let (mut detector, log) = detector_with_stub(0.5);
        let chunk = vec![0.42_f32; SILERO_VAD_CHUNK_SAMPLES];

        detector.detect_speech_probability(&chunk).unwrap();
        detector.reset();
        detector.detect_speech_probability(&chunk).unwrap();

        let calls = log.lock().unwrap();
        assert_eq!(calls.len(), 2);
        let (second_model_input, second_state_in) = &calls[1];

        // After reset(), the second call should look identical to a fresh
        // detector's first call: zeroed context prefix, zeroed state.
        assert!(second_model_input[..SILERO_VAD_CONTEXT_SAMPLES]
            .iter()
            .all(|&value| value == 0.0));
        assert!(second_state_in.iter().all(|&value| value == 0.0));
    }

    #[test]
    fn state_shape_constant_matches_documented_lstm_shape() {
        // [num_layers * directions, batch, hidden] = [2, 1, 128].
        assert_eq!(SILERO_VAD_STATE_LEN, 2 * 128);
    }
}

#[cfg(test)]
mod gate_tests {
    //! Tests for [`VadBackendKind`] selection (`build_vad_gate`) and the
    //! Silero-backed gate's graceful-fallback behavior, per the task's
    //! requirement that "if the Silero model isn't downloaded/available, or
    //! fails to load, or inference errors at runtime, the system must
    //! transparently fall back to the existing energy-threshold gate".
    use super::*;
    use crate::audio::vad::VadConfig;

    fn test_config() -> VadConfig {
        VadConfig {
            frame_size: 160, // 10ms at 16kHz
            sample_rate: 16_000,
            threshold_db: Some(-40.0),
            min_speech_duration: 0.05,
            min_silence_duration: 0.05,
            padding_seconds: 0.0,
        }
    }

    // --- Backend selection (`VadBackendKind` <-> settings string, `build_vad_gate`) ---

    #[test]
    fn vad_backend_kind_parses_known_settings_strings() {
        assert_eq!(
            VadBackendKind::from_settings_str("energy_threshold"),
            VadBackendKind::EnergyThreshold
        );
        assert_eq!(
            VadBackendKind::from_settings_str("silero"),
            VadBackendKind::Silero
        );
    }

    #[test]
    fn vad_backend_kind_defaults_to_energy_threshold_for_unknown_values() {
        // Unknown/garbage/legacy values must not panic and must not silently
        // select Silero (which could load an attacker/garbage-controlled
        // path elsewhere) -- energy-threshold is always the safe default.
        assert_eq!(
            VadBackendKind::from_settings_str(""),
            VadBackendKind::EnergyThreshold
        );
        assert_eq!(
            VadBackendKind::from_settings_str("some_future_backend"),
            VadBackendKind::EnergyThreshold
        );
    }

    #[test]
    fn vad_backend_kind_round_trips_through_settings_str() {
        for kind in [VadBackendKind::EnergyThreshold, VadBackendKind::Silero] {
            assert_eq!(
                VadBackendKind::from_settings_str(kind.as_settings_str()),
                kind
            );
        }
    }

    #[test]
    fn default_vad_backend_kind_is_energy_threshold() {
        // The always-available, no-download-required backend must be the
        // default so existing users (and fresh installs) get working
        // auto-stop/auto-start without needing to download anything.
        assert_eq!(VadBackendKind::default(), VadBackendKind::EnergyThreshold);
    }

    #[test]
    fn build_vad_gate_energy_threshold_never_touches_silero_path() {
        // Even with a bogus/nonexistent Silero path passed in, requesting
        // EnergyThreshold must succeed and must not attempt to load anything.
        let gate = build_vad_gate(
            VadBackendKind::EnergyThreshold,
            &test_config(),
            Some(std::path::Path::new(
                "/nonexistent/path/should/not/be/read.onnx",
            )),
        );
        assert_eq!(gate.backend_name(), "energy_threshold");
    }

    // --- Graceful fallback: Silero unavailable / fails to load / errors at runtime ---

    #[test]
    fn build_vad_gate_falls_back_when_silero_model_path_is_none() {
        // Model not downloaded: caller (lib.rs's `resolve_silero_vad_model_path`)
        // passes `None` rather than erroring. `build_vad_gate` must still return
        // a working gate driven by the energy-threshold backend, not disable
        // auto-stop/auto-start entirely.
        let gate = build_vad_gate(VadBackendKind::Silero, &test_config(), None);
        assert_eq!(
            gate.backend_name(),
            "energy_threshold",
            "must fall back to energy-threshold when no Silero model path is available"
        );
    }

    #[test]
    fn build_vad_gate_falls_back_when_silero_model_file_does_not_exist() {
        // Model path configured but the file isn't actually there (partial/
        // deleted download, stale settings, etc): still must not error out.
        let gate = build_vad_gate(
            VadBackendKind::Silero,
            &test_config(),
            Some(std::path::Path::new("/nonexistent/silero_vad.onnx")),
        );
        assert_eq!(gate.backend_name(), "energy_threshold");
    }

    #[cfg(feature = "asr-parakeet")]
    #[test]
    fn build_vad_gate_falls_back_when_silero_model_file_is_corrupt() {
        // A file exists at the path but isn't a valid ONNX model (simulates a
        // truncated/corrupt download): `SileroVadDetector::load` -> `ort`
        // session creation must fail, and `build_vad_gate` must catch that
        // and fall back rather than propagate the error up into
        // `start_dictation`/`start_hands_free_monitor`.
        let tmp_dir = std::env::temp_dir().join(format!(
            "plainsong-vad-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp_dir).unwrap();
        let bogus_model_path = tmp_dir.join("silero_vad.onnx");
        std::fs::write(&bogus_model_path, b"not a real onnx model").unwrap();

        let gate = build_vad_gate(
            VadBackendKind::Silero,
            &test_config(),
            Some(&bogus_model_path),
        );
        assert_eq!(
            gate.backend_name(),
            "energy_threshold",
            "a corrupt/invalid model file must fall back, not panic or propagate an error"
        );
        assert!(
            !bogus_model_path.exists(),
            "an unloadable model file must be quarantined (renamed away) so \
             is_silero_vad_model_downloaded() stops reporting it as available"
        );
        assert!(
            tmp_dir.join("silero_vad.onnx.corrupt").exists(),
            "quarantine must preserve the file for diagnosis, not delete it"
        );

        std::fs::remove_dir_all(&tmp_dir).ok();
    }

    /// Backend stub that always fails, used to drive `SileroBackedVadGate`'s
    /// background worker down its error path deterministically (no real
    /// model file / ort session required).
    struct AlwaysFailingBackend;

    impl SileroVadBackend for AlwaysFailingBackend {
        fn infer(&mut self, _input: &[f32], _state_in: &[f32]) -> Result<(f32, Vec<f32>)> {
            Err(anyhow::anyhow!("synthetic inference failure for testing"))
        }
    }

    fn gate_with_always_failing_backend(config: &VadConfig) -> SileroBackedVadGate {
        let detector = SileroVadDetector::from_backend(Box::new(AlwaysFailingBackend));
        SileroBackedVadGate::from_detector(detector, config)
    }

    #[test]
    fn silero_gate_falls_back_to_energy_threshold_after_runtime_inference_failure() {
        let config = test_config();
        let mut gate = gate_with_always_failing_backend(&config);
        assert_eq!(gate.backend_name(), "silero");

        // Feed enough samples for at least one full Silero chunk so the
        // background worker actually runs inference (and fails) at least
        // once. Poll `push_samples` (as the real audio callback would, one
        // tick at a time) until the async failure has propagated back and
        // the gate has switched itself over -- bounded so a regression here
        // fails the test instead of hanging forever.
        let one_chunk = vec![0.1_f32; SILERO_VAD_CHUNK_SAMPLES];
        let mut switched = false;
        for _ in 0..200 {
            gate.push_samples(&one_chunk);
            if gate.backend_name() == "energy_threshold_fallback" {
                switched = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        assert!(
            switched,
            "gate must fall back to energy-threshold after the worker reports an inference failure"
        );

        // Once fallen back, the gate must keep working (not just report its
        // name differently) -- sustained loud samples should still be able
        // to latch into "speech" via the fallback's own logic.
        for _ in 0..20 {
            gate.push_samples(&vec![0.5_f32; 160]);
        }
        assert!(
            gate.is_speaking(),
            "fallback gate must still functionally detect speech after switching over"
        );
    }

    // --- Device-rate input handling (resampling to the model's 16 kHz contract) ---

    #[test]
    fn streaming_resampler_decimates_48k_to_16k_on_exact_grid() {
        // 48k -> 16k is an integer step of 3: outputs must be exactly every
        // third input sample (frac is always 0), regardless of call framing.
        let mut resampler = StreamingResampler::new(48_000, 16_000);
        let input: Vec<f32> = (0..30).map(|i| i as f32).collect();
        let mut output = Vec::new();
        resampler.process(&input, &mut output);
        let expected: Vec<f32> = (0..output.len()).map(|i| (i * 3) as f32).collect();
        assert_eq!(output, expected);
        // ~1/3 of the input length (edge samples may be held as carry).
        assert!((9..=10).contains(&output.len()), "got {}", output.len());
    }

    #[test]
    fn streaming_resampler_is_continuous_across_call_boundaries() {
        // Feeding the same signal in one shot vs. in callback-sized slices
        // must produce identical output: the carry/pos state is what makes
        // the resampler safe to drive from per-callback pushes.
        let signal: Vec<f32> = (0..4410).map(|i| ((i as f32) * 0.013).sin()).collect();

        let mut one_shot = Vec::new();
        StreamingResampler::new(44_100, 16_000).process(&signal, &mut one_shot);

        let mut chunked = Vec::new();
        let mut resampler = StreamingResampler::new(44_100, 16_000);
        for chunk in signal.chunks(441) {
            resampler.process(chunk, &mut chunked);
        }

        assert_eq!(one_shot, chunked);
        // 44.1k -> 16k over 4410 input samples is ~1600 output samples.
        assert!(
            (1595..=1600).contains(&one_shot.len()),
            "got {}",
            one_shot.len()
        );
    }

    #[test]
    fn silero_gate_resamples_device_rate_input_before_chunking() {
        let mut config = test_config();
        config.sample_rate = 48_000;
        let gate_48k = gate_with_always_failing_backend(&config);

        // Chunk timing must be at the model rate (16000/512 = 31.25 chunks/s)
        // regardless of the device rate -- the old bug derived it from the
        // device rate (48000/512 = 93.75), shrinking hysteresis windows 3x.
        assert_eq!(gate_48k.frames_per_second(), 31.25);
        config.sample_rate = 16_000;
        let gate_16k = gate_with_always_failing_backend(&config);
        assert_eq!(gate_16k.frames_per_second(), 31.25);

        // Hysteresis chunk counts must therefore agree across device rates.
        let mut config_1s = test_config();
        config_1s.min_silence_duration = 1.0;
        config_1s.sample_rate = 48_000;
        let gate_a = gate_with_always_failing_backend(&config_1s);
        config_1s.sample_rate = 16_000;
        let gate_b = gate_with_always_failing_backend(&config_1s);
        assert_eq!(gate_a.min_silence_chunks, 32); // ceil(1.0 * 31.25)
        assert_eq!(gate_a.min_silence_chunks, gate_b.min_silence_chunks);

        // 1532 device-rate samples at 48 kHz resample to 511 model-rate
        // samples: one short of a full Silero chunk, so nothing may be
        // dispatched to the worker yet (the old code would have sent two
        // 512-sample device-rate chunks by now).
        let mut config = test_config();
        config.sample_rate = 48_000;
        let mut gate = gate_with_always_failing_backend(&config);
        gate.push_samples(&vec![0.25_f32; 1532]);
        assert_eq!(gate.pending_samples.len(), 511);
        assert_eq!(
            gate.backend_name(),
            "silero",
            "no chunk should have been scored yet"
        );
    }

    #[test]
    fn silero_gate_at_model_rate_does_not_resample() {
        let mut config = test_config();
        config.sample_rate = 16_000;
        let mut gate = gate_with_always_failing_backend(&config);
        assert!(gate.resampler.is_none());
        gate.push_samples(&vec![0.25_f32; 511]);
        assert_eq!(
            gate.pending_samples.len(),
            511,
            "16 kHz input must pass through 1:1"
        );
    }

    #[test]
    fn silero_gate_reports_silero_backend_name_before_any_failure() {
        // Sanity check on the naming contract itself: a healthy gate that
        // hasn't failed yet must identify as "silero", not the fallback name,
        // so callers/logs can distinguish "running as configured" from
        // "degraded to fallback".
        let config = test_config();
        let gate = SileroBackedVadGate::from_detector(
            SileroVadDetector::from_backend(Box::new(AlwaysFailingBackend)),
            &config,
        );
        assert_eq!(gate.backend_name(), "silero");
    }

    /// End-to-end smoke test against the *real* downloaded `silero_vad.onnx`,
    /// exercising the actual `ort` session rather than a stub backend: model
    /// load through the production `build_vad_gate` factory, silence scoring,
    /// real speech latching, and per-chunk inference latency staying inside
    /// the real-time budget.
    ///
    /// `#[ignore]`d because unit-test runs must not depend on a ~2.3MB
    /// network download. To run it, download the model the app itself uses
    /// (URL in `crate::download::SILERO_VAD_MODEL_URL`) and point the env var
    /// at it:
    ///
    /// ```sh
    /// PLAINSONG_SILERO_VAD_MODEL_PATH=/path/to/silero_vad.onnx \
    ///     cargo test --manifest-path rust-sidecar/Cargo.toml --lib \
    ///     silero_real_model_smoke -- --ignored
    /// ```
    #[test]
    #[ignore = "needs the real silero_vad.onnx; set PLAINSONG_SILERO_VAD_MODEL_PATH and pass --ignored"]
    #[cfg(feature = "asr-parakeet")]
    fn silero_real_model_smoke() {
        let model_path = std::env::var_os("PLAINSONG_SILERO_VAD_MODEL_PATH")
            .map(std::path::PathBuf::from)
            .expect("set PLAINSONG_SILERO_VAD_MODEL_PATH to a downloaded silero_vad.onnx");

        // 1. The real model must load through the exact factory production
        // uses, and must come back as Silero -- not the silent fallback.
        let config = VadConfig::default();
        let mut gate = build_vad_gate(VadBackendKind::Silero, &config, Some(&model_path));
        assert_eq!(
            gate.backend_name(),
            "silero",
            "real model failed to load; build_vad_gate silently fell back to energy-threshold"
        );

        // Helper: push audio in real-callback-sized chunks, giving the
        // background worker time to score them, until `stop` says we're done.
        let feed = |gate: &mut Box<dyn VadGate + Send>,
                    samples: &[f32],
                    stop: &dyn Fn(&Box<dyn VadGate + Send>) -> bool| {
            for chunk in samples.chunks(SILERO_VAD_CHUNK_SAMPLES) {
                gate.push_samples(chunk);
                if stop(gate) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            // Let any in-flight results drain.
            for _ in 0..50 {
                gate.push_samples(&[]);
                if stop(gate) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        };

        // 2. Two seconds of digital silence must not read as speech, and must
        // not trip a runtime inference failure (which would switch the
        // backend name to the fallback).
        let silence = vec![0.0_f32; 2 * config.sample_rate as usize];
        feed(&mut gate, &silence, &|_| false);
        assert!(
            !gate.is_speaking(),
            "real Silero model scored digital silence as speech"
        );
        assert_eq!(
            gate.backend_name(),
            "silero",
            "inference failed at runtime on silence (gate degraded to fallback)"
        );

        // 3. Real recorded speech must latch the gate into speech. NOTE:
        // `local-perf-30s.wav` is deliberately NOT used here -- it is a pure
        // sine tone (fine for latency benchmarking, but the model correctly
        // scores it as non-speech, max probability ~0.22).
        // `local-quality-gate.wav` contains actual spoken words.
        let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../scripts/fixtures/local-quality-gate.wav");
        let mut reader = hound::WavReader::open(&fixture_path)
            .unwrap_or_else(|e| panic!("failed to open speech fixture {fixture_path:?}: {e}"));
        let spec = reader.spec();
        assert_eq!(spec.sample_rate, 16_000, "fixture must be 16kHz");
        assert_eq!(spec.channels, 1, "fixture must be mono");
        let speech: Vec<f32> = reader
            .samples::<i16>()
            .map(|s| s.unwrap() as f32 / 32_768.0)
            .collect();
        // Diagnostic pre-pass: score the fixture sequentially with a direct
        // (synchronous) detector and report the probability distribution, so
        // a latching failure below is attributable to either "model scores
        // speech low" or "async gate logic never sees the scores".
        {
            let mut probe =
                SileroVadDetector::load(&model_path).expect("direct detector load failed");
            let mut max_p = 0.0_f32;
            let mut above = 0_usize;
            let mut total = 0_usize;
            for chunk in speech.chunks(SILERO_VAD_CHUNK_SAMPLES).take(600) {
                if chunk.len() < SILERO_VAD_CHUNK_SAMPLES {
                    break;
                }
                let p = probe
                    .detect_speech_probability(chunk)
                    .expect("direct real-model inference failed on speech");
                max_p = max_p.max(p);
                if p >= SILERO_SPEECH_PROBABILITY_THRESHOLD {
                    above += 1;
                }
                total += 1;
            }
            println!(
                "silero_real_model_smoke diagnostic: {total} sequential speech chunks, \
                 max probability {max_p:.3}, {above} above threshold"
            );
        }

        feed(&mut gate, &speech, &|g| g.is_speaking());
        assert!(
            gate.is_speaking(),
            "real Silero model never detected speech in the recorded-speech fixture"
        );
        assert_eq!(
            gate.backend_name(),
            "silero",
            "inference failed at runtime on real speech (gate degraded to fallback)"
        );

        // 4. Device-rate regression: the same recorded speech naively
        // upsampled to 48 kHz (the typical macOS capture rate) must still
        // latch a gate configured with sample_rate=48_000, proving the
        // gate's internal resampling presents the model with valid 16 kHz
        // audio rather than 3x time-stretched input.
        let mut speech_48k = Vec::with_capacity(speech.len() * 3);
        for pair in speech.windows(2) {
            speech_48k.push(pair[0]);
            speech_48k.push(pair[0] + (pair[1] - pair[0]) / 3.0);
            speech_48k.push(pair[0] + (pair[1] - pair[0]) * 2.0 / 3.0);
        }
        let config_48k = VadConfig {
            sample_rate: 48_000,
            frame_size: 1_440, // 30ms at 48kHz, matching audio.rs's scaling
            ..VadConfig::default()
        };
        let mut gate_48k = build_vad_gate(VadBackendKind::Silero, &config_48k, Some(&model_path));
        assert_eq!(gate_48k.backend_name(), "silero");
        feed(&mut gate_48k, &speech_48k, &|g| g.is_speaking());
        assert!(
            gate_48k.is_speaking(),
            "real Silero model never detected speech in 48 kHz device-rate input \
             (gate resampling to the model rate is broken)"
        );
        assert_eq!(
            gate_48k.backend_name(),
            "silero",
            "inference failed at runtime on 48 kHz input (gate degraded to fallback)"
        );

        // 5. Direct (synchronous) detector checks: output must be a sane
        // probability and per-chunk latency must fit the real-time budget --
        // each chunk represents 32ms of audio, so scoring one must take well
        // under that on average for the worker to keep up.
        let mut detector =
            SileroVadDetector::load(&model_path).expect("direct detector load failed");
        let silence_chunk = vec![0.0_f32; SILERO_VAD_CHUNK_SAMPLES];
        let speech_chunk = &speech[..SILERO_VAD_CHUNK_SAMPLES.min(speech.len())];

        let started = std::time::Instant::now();
        let mut iterations = 0_u32;
        let mut last_probability = 0.0_f32;
        for i in 0..200 {
            let chunk: &[f32] = if i % 2 == 0 {
                &silence_chunk
            } else {
                speech_chunk
            };
            last_probability = detector
                .detect_speech_probability(chunk)
                .expect("direct real-model inference failed");
            assert!(
                (0.0..=1.0).contains(&last_probability),
                "speech probability out of range: {last_probability}"
            );
            iterations += 1;
        }
        let average = started.elapsed() / iterations;
        println!(
            "silero_real_model_smoke: {iterations} chunks scored, avg {average:?}/chunk \
             (budget 32ms), last probability {last_probability:.3}"
        );
        assert!(
            average < std::time::Duration::from_millis(32),
            "average real-model inference latency {average:?} exceeds the 32ms real-time budget"
        );
    }
}
