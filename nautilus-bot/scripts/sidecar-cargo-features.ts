/**
 * The single place that decides which opt-in Cargo features the Rust sidecar
 * is compiled with, so that the shipped binary (scripts/build-rust-sidecar.ts),
 * every contributor/CI cargo command (scripts/cargo-sidecar.ts, behind
 * `lint:rust`, `test:rust`, `benchmark:latency`, and .github/workflows/ci.yml),
 * and the third-party notices generator all describe the same build.
 *
 * Platform acceleration features live here instead of in Cargo defaults.
 * Compact meeting storage is also in Cargo defaults; its worker uses macOS
 * conversion tools and keeps WAV storage on other platforms.
 *
 * - `candle-metal` (shipped): Candle's Metal backend for the Candle-based
 *   providers (Whisper large-v3-turbo, Distil-Whisper). The Metal kernels only
 *   build against Apple frameworks. Without it those models run F32 on the CPU:
 *   Distil-Whisper distil-large-v3.5 measured 32.8 s p50 for a 5.3 s utterance
 *   on CPU versus 0.96 s on Metal (M4 Pro, combined dev binary under load;
 *   the shipped binary still owes a quiet-machine re-run).
 * - `asr-transcribe-cpp` (shipped on macOS): local GGUF routes. Unified EN
 *   passed CPU/Metal qualification and native capture. See
 *   docs/evals/unified-native-capture-2026-10-03/README.md. On Apple Silicon,
 *   a new install's dictation default is Parakeet TDT 0.6B v3 Q8_0 through
 *   this runtime (`fresh_install_dictation_route` in settings.rs); meetings
 *   stay on Parakeet ONNX, and every other GGUF route remains experimental.
 * - `ort-coreml` (deliberately NOT shipped): ONNX Runtime's CoreML execution
 *   provider for the ONNX providers that opt in through
 *   `ort_utils::build_session` (Silero VAD, diarization embedders, Moonshine,
 *   the Qwen3 encoder). Measured on Moonshine base it is a regression: 24 s of
 *   CoreML model compilation on first load, the decoder is never offloaded
 *   (its merged graph is a single `If` node CoreML rejects), and the encoder is
 *   split into 75 partitions that run slower than plain CPU. Re-enable only
 *   with a new measurement and per-session opt-outs; see the receipt below.
 * - `ort-coreml-ep` (macOS): compiles `ort`'s Core ML execution provider
 *   API without registering it anywhere by default (that is `ort-coreml`).
 *   On Apple Silicon it does not change the native library: ort-sys
 *   publishes only the Core ML build of ONNX Runtime 1.28 for
 *   aarch64-apple-darwin, and builds with and without the feature link the
 *   same libonnxruntime.a. Parakeet ONNX transcripts (40 real-speech clips),
 *   Silero VAD frame probabilities and ECAPA-TDNN embeddings came out
 *   bit-identical both ways (`diarization/ort_build_equivalence.rs`).
 *   pyannote community-1 opts only its ResNet34 embedding network in, on the
 *   GPU in float32: about 9 ms per 10 s window against 150-290 ms on the
 *   CPU, outputs within 3e-7 of the CPU's. See
 *   rust-sidecar/src/diarization/community1/inference.rs.
 * - `diarization-nemotron` (macOS, optional experimental model): pinned
 *   Nemotron 3 Diarization through the shared ONNX Runtime. The download and
 *   selection remain opt-in. See docs/evals/nemotron-diarization-2026-10-04.
 *
 * The measurements behind this list are in
 * artifacts/qa/acceleration-receipt-2026-09-01.md.
 */
export const MACOS_SIDECAR_CARGO_FEATURES: readonly string[] = Object.freeze([
  "meeting-audio-16k",
  "candle-metal",
  "asr-transcribe-cpp",
  "diarization-nemotron",
  "ort-coreml-ep",
]);

/**
 * Cargo CLI arguments selecting the sidecar's platform feature set.
 *
 * @returns `["--features", "..."]` on Darwin, `[]` elsewhere.
 */
export function sidecarCargoFeatureArgs(
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "darwin") {
    return [];
  }
  return ["--features", MACOS_SIDECAR_CARGO_FEATURES.join(",")];
}
