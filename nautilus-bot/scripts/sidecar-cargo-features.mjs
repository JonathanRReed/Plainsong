/**
 * The single place that decides which opt-in Cargo features the Rust sidecar
 * is compiled with, so that the shipped binary (scripts/build-rust-sidecar.mjs),
 * every contributor/CI cargo command (scripts/cargo-sidecar.mjs, behind
 * `lint:rust`, `test:rust`, `benchmark:latency`, and .github/workflows/ci.yml),
 * and the third-party notices generator all describe the same build.
 *
 * The features are macOS-only by construction, which is why they live here
 * instead of in Cargo.toml's `default` set (non-Darwin builds keep compiling the
 * plain default feature set unchanged):
 *
 * - `candle-metal` (shipped): Candle's Metal backend for the Candle-based
 *   providers (Whisper large-v3-turbo, Distil-Whisper). The Metal kernels only
 *   build against Apple frameworks. Without it those models run F32 on the CPU:
 *   Distil-Whisper distil-large-v3.5 measured 32.8 s p50 for a 5.3 s utterance
 *   on CPU versus 0.96 s on Metal (M4 Pro).
 * - `ort-coreml` (deliberately NOT shipped): ONNX Runtime's CoreML execution
 *   provider for the ONNX providers that opt in through
 *   `ort_utils::build_session` (Silero VAD, diarization embedders, Moonshine,
 *   the Qwen3 encoder). Measured on Moonshine base it is a regression: 24 s of
 *   CoreML model compilation on first load, the decoder is never offloaded
 *   (its merged graph is a single `If` node CoreML rejects), and the encoder is
 *   split into 75 partitions that run slower than plain CPU. Re-enable only
 *   with a new measurement and per-session opt-outs; see the receipt below.
 *
 * The measurements behind this list are in
 * artifacts/qa/acceleration-receipt-2026-09-01.md.
 */
export const MACOS_SIDECAR_CARGO_FEATURES = Object.freeze(["candle-metal"]);

/**
 * Cargo CLI arguments selecting the sidecar's platform feature set.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]} `["--features", "..."]` on Darwin, `[]` elsewhere.
 */
export function sidecarCargoFeatureArgs(platform = process.platform) {
  if (platform !== "darwin") {
    return [];
  }
  return ["--features", MACOS_SIDECAR_CARGO_FEATURES.join(",")];
}
