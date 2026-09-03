/**
 * Every model artifact Plainsong downloads, with the terms it arrives under.
 *
 * # Why this file exists
 *
 * THIRD-PARTY-NOTICES.txt is generated from `cargo metadata` and the npm
 * production tree, which between them cover every line of code that ships. It
 * covered no model weights at all -- and weights are third-party material with
 * their own terms, several of which are *not* the license of the code that
 * runs them: Parakeet is CC-BY-4.0 (attribution required), and S1-mini adds a
 * naming clause to Apache-2.0. Shipping an app that downloads half a gigabyte
 * of someone else's weights, with a notices file that does not mention them,
 * is a gap in the notices, not a detail.
 *
 * # Why a manifest and not a hand-edited section
 *
 * The notices file says "This file is generated. Do not edit it by hand." at
 * the top, and the release gate re-generates it and compares. A hand-written
 * section would be erased by the next `licenses:generate`. So the weights are
 * data here, rendered by `generate-third-party-notices.mjs` like everything
 * else, and `model-weights-manifest.test.ts` holds the data to the pins in the
 * Rust source.
 *
 * # What the fields mean
 *
 * `repository` and `revision` are the exact upstream coordinates the download
 * path fetches from, so a reader can go and check the terms themselves.
 * `license` is what upstream declares. Where nothing is declared, this says so
 * rather than guessing: an invented SPDX id in a legal notice is worse than an
 * honest gap, and `pendingLicenseReview` marks the ones a human still owes an
 * answer on.
 *
 * Keep this in sync with the pins it mirrors; the test names the file and
 * constant for each entry.
 */

/**
 * @typedef {object} ModelWeightsEntry
 * @property {string} name Display name, as the app names it.
 * @property {string} usedFor What the app does with it.
 * @property {string} repository Upstream repository page.
 * @property {string} revision Immutable revision the download pins, or the
 *   branch plus a note when the pin is a per-file digest instead.
 * @property {string} license Upstream's declared license, or "not declared".
 * @property {string[]} files The artifacts fetched at that revision.
 * @property {string} pinnedIn Source file holding the pin.
 * @property {string} [note] An extra term or caveat that travels with it.
 * @property {boolean} [pendingLicenseReview] Upstream declares nothing and a
 *   human has not yet resolved it.
 */

/** @type {ModelWeightsEntry[]} */
export const MODEL_WEIGHTS = [
  {
    name: "S1-mini by Superwhisper (GGUF)",
    usedFor: "Built-in dictation cleanup (the zero-setup route).",
    repository: "https://huggingface.co/superwhisper/s1-mini-GGUF",
    revision: "34add00a48a2e5d24e5a4ee5405a99620a3a240c",
    license: "Apache-2.0, with an additional naming term",
    note:
      'The license requires the model keep the name "S1-mini" by "Superwhisper", with that exact capitalization, wherever it is used. Its LICENSE and NOTICE files are downloaded alongside the weights and kept beside them on disk.',
    files: ["s1-mini-q4_k_m.gguf"],
    pinnedIn: "rust-sidecar/src/llm/bundled_local.rs (artifacts)",
  },
  {
    name: "S1-mini by Superwhisper (tokenizer and license texts)",
    usedFor: "Tokenizer for the built-in cleanup model, and its own terms.",
    repository: "https://huggingface.co/superwhisper/s1-mini",
    revision: "88f6b15896c73bbb13a3b596e0afe8ea0d5150b4",
    license: "Apache-2.0, with an additional naming term",
    files: ["tokenizer.json", "LICENSE", "NOTICE"],
    pinnedIn: "rust-sidecar/src/llm/bundled_local.rs (artifacts)",
  },
  {
    name: "Whisper (whisper.cpp GGML builds)",
    usedFor:
      "Speech recognition: tiny, tiny.en, base, base.en, small, small.en, medium, medium.en, large-v3 and large-v3-turbo.",
    repository: "https://huggingface.co/ggerganov/whisper.cpp",
    revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
    license: "MIT",
    files: ["ggml-<model>.bin, one per build listed above"],
    pinnedIn: "rust-sidecar/src/asr/whisper.rs (WHISPER_MODELS)",
  },
  {
    name: "Whisper large-v3-turbo (Candle safetensors)",
    usedFor: "Speech recognition through the in-process Candle runtime.",
    repository: "https://huggingface.co/openai/whisper-large-v3-turbo",
    revision: "41f01f3fe87f28c78e2fbf8b568835947dd65ed9",
    license: "MIT",
    files: [
      "model.safetensors",
      "config.json",
      "tokenizer.json",
      "preprocessor_config.json",
    ],
    pinnedIn:
      "rust-sidecar/src/asr/whisper_candle.rs (WHISPER_CANDLE_HF_*, WHISPER_CANDLE_REQUIRED_FILES)",
  },
  {
    name: "Distil-Whisper distil-large-v3.5",
    usedFor: "Faster English-only speech recognition.",
    repository: "https://huggingface.co/distil-whisper/distil-large-v3.5",
    revision: "728a7691f3ff1d3d971528d3203a6e9559165d41",
    license: "Apache-2.0",
    files: [
      "model.safetensors",
      "config.json",
      "tokenizer.json",
      "preprocessor_config.json",
    ],
    pinnedIn:
      "rust-sidecar/src/asr/distil_whisper.rs (DISTIL_HF_*, DISTIL_REQUIRED_FILES)",
  },
  {
    name: "Parakeet TDT 0.6b v3 (sherpa-onnx int8 export)",
    usedFor: "Speech recognition on the fast local route.",
    repository:
      "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    revision: "2bda32ec70b097a55adaa07d9a7173915b43cc78",
    license: "CC-BY-4.0",
    note:
      "Attribution is a condition of use, not a courtesy: this notice, shipped with the app, is how it is met. Derived from NVIDIA's nvidia/parakeet-tdt-0.6b-v3.",
    files: [
      "encoder.int8.onnx",
      "decoder.int8.onnx",
      "joiner.int8.onnx",
      "tokens.txt",
    ],
    pinnedIn: "rust-sidecar/src/asr/parakeet.rs (PARAKEET_V3_*)",
  },
  {
    name: "Parakeet TDT CTC 110m (legacy export)",
    usedFor:
      "Speech recognition for installs that still carry the earlier Parakeet download.",
    repository:
      "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000",
    revision: "3af92f152d32c836acabf38f4c993bc96b80eb2d",
    license: "CC-BY-4.0",
    files: ["model.onnx", "tokens.txt"],
    pinnedIn: "rust-sidecar/src/asr/parakeet.rs (legacy artifact URLs)",
  },
  {
    name: "Moonshine (ONNX)",
    usedFor: "Low-latency English speech recognition, tiny and base.",
    repository: "https://huggingface.co/UsefulSensors/moonshine",
    revision: "48b4e427b587bcf67797a5be706d6ddc4a298149",
    license: "MIT",
    files: [
      "onnx/merged/tiny/float/encoder_model.onnx",
      "onnx/merged/tiny/float/decoder_model_merged.onnx",
      "onnx/merged/base/float/encoder_model.onnx",
      "onnx/merged/base/float/decoder_model_merged.onnx",
    ],
    pinnedIn: "rust-sidecar/src/asr/moonshine.rs (MOONSHINE_ONNX_HF_*)",
  },
  {
    name: "Moonshine tiny (tokenizer)",
    usedFor: "Tokenizer for the Moonshine tiny model.",
    repository: "https://huggingface.co/UsefulSensors/moonshine-tiny",
    revision: "390624ed33d594443aa4aa221f5b9f283b545b5a",
    license: "MIT",
    files: ["tokenizer.json"],
    pinnedIn: "rust-sidecar/src/asr/moonshine.rs (MOONSHINE_TINY_HF_*)",
  },
  {
    name: "Moonshine base (tokenizer)",
    usedFor: "Tokenizer for the Moonshine base model.",
    repository: "https://huggingface.co/UsefulSensors/moonshine-base",
    revision: "7a73d8d55ac0ba2ef3ae761593f6784b51f96dcf",
    license: "MIT",
    files: ["tokenizer.json"],
    pinnedIn: "rust-sidecar/src/asr/moonshine.rs (MOONSHINE_BASE_HF_*)",
  },
  {
    name: "Qwen3-ASR 0.6B (ONNX int4 export)",
    usedFor: "Speech recognition on the multilingual local route.",
    repository: "https://huggingface.co/andrewleech/qwen3-asr-0.6b-onnx",
    revision:
      "main (each of the seven files is pinned by SHA-256 instead of by commit)",
    license: "Apache-2.0",
    note:
      "This is the one model whose revision is a branch. Every file is verified against a pinned SHA-256 on download, so a republished branch is rejected rather than loaded; the digests live beside the URLs in the file below.",
    files: [
      "encoder.int4.onnx",
      "decoder_init.int4.onnx",
      "decoder_step.int4.onnx",
      "decoder_weights.int4.data",
      "embed_tokens.bin",
      "config.json",
      "tokenizer.json",
    ],
    pinnedIn: "rust-sidecar/src/asr/qwen3_asr.rs (QWEN3_ASR_HF_*)",
  },
  {
    name: "Silero VAD",
    usedFor: "Voice-activity detection: deciding when speech starts and stops.",
    repository: "https://github.com/snakers4/silero-vad",
    revision: "76e3dc408eb2a5c655c34e230d2d5459b4439daa",
    license: "MIT",
    files: ["src/silero_vad/data/silero_vad.onnx"],
    pinnedIn: "rust-sidecar/src/download/mod.rs (SILERO_VAD_ONNX_URL)",
  },
  {
    name: "WeSpeaker ECAPA-TDNN 512 (VoxCeleb, LM)",
    usedFor: "Speaker embeddings for meeting diarization.",
    repository: "https://huggingface.co/Wespeaker/wespeaker-ecapa-tdnn512-LM",
    revision: "a2f3dcb1c8702caccc7a55ceb57f5e8d1842112b",
    license: "Apache-2.0",
    files: ["voxceleb_ECAPA512_LM.onnx"],
    pinnedIn: "rust-sidecar/src/download/mod.rs (diarization_model_info)",
  },
  {
    name: "WeSpeaker ResNet34 (VoxCeleb, LM)",
    usedFor: "Speaker embeddings for meeting diarization.",
    repository: "https://huggingface.co/Wespeaker/wespeaker-resnet34-LM",
    revision: "f0c48c298fd835726c27956a5d617bad7115627e",
    license: "Apache-2.0",
    files: ["voxceleb_resnet34_LM.onnx"],
    pinnedIn: "rust-sidecar/src/download/mod.rs (diarization_model_info)",
  },
  {
    name: "WeSpeaker CAM++ (VoxCeleb, LM)",
    usedFor: "Speaker embeddings for meeting diarization.",
    repository:
      "https://huggingface.co/Wespeaker/wespeaker-voxceleb-campplus-LM",
    revision: "c5e01c6fcffcce160861e7e79782828320192b5c",
    license: "Apache-2.0",
    files: ["voxceleb_CAM++_LM.onnx"],
    pinnedIn: "rust-sidecar/src/download/mod.rs (diarization_model_info)",
  },
  {
    name: "ERes2NetV2 speaker embedding (int8)",
    usedFor: "Speaker embeddings for meeting diarization.",
    repository: "https://huggingface.co/phoenix124/kept-models",
    revision: "42de48f3d8cb1c33ad29f4dbe2db0801a0759ddf",
    license: "not declared by the repository this file is fetched from",
    pendingLicenseReview: true,
    note:
      "The mirror this artifact is pinned to declares no license, so none is asserted here. Until that is resolved upstream or the model is replaced, this entry records the gap rather than an assumption.",
    files: ["diarize-embedding-eres2netv2-int8.onnx"],
    pinnedIn: "rust-sidecar/src/download/mod.rs (diarization_model_info)",
  },
];

/** The section body, rendered into THIRD-PARTY-NOTICES.txt. */
export function renderModelWeightsSection() {
  const entries = MODEL_WEIGHTS.map((entry) => {
    const lines = [
      entry.name,
      `  Used for: ${entry.usedFor}`,
      `  License: ${entry.license}`,
      `  Repository: ${entry.repository}`,
      `  Revision: ${entry.revision}`,
      `  Files: ${entry.files.join(", ")}`,
      `  Pinned in: ${entry.pinnedIn}`,
    ];
    if (entry.note) lines.push(`  Note: ${entry.note}`);
    return lines.join("\n");
  });

  const pending = MODEL_WEIGHTS.filter((entry) => entry.pendingLicenseReview);
  const preamble = [
    "None of these ship inside the application. Each is downloaded on request",
    "from the repository and revision named below, verified against a SHA-256",
    "pinned in the source, and stored in the user's own models directory. The",
    "terms are the upstream project's, not Plainsong's, and are reproduced here",
    "because several differ from the license of the code that runs them.",
    "",
    `Model artifacts: ${MODEL_WEIGHTS.length}`,
  ];
  if (pending.length > 0) {
    preamble.push(
      `Artifacts whose upstream declares no license: ${pending.length} (${pending
        .map((entry) => entry.name)
        .join(", ")})`,
    );
  }

  return [preamble.join("\n"), ...entries].join("\n\n");
}
