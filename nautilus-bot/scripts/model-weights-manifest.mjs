/**
 * Managed model artifact groups and their terms. Coverage tests check the
 * pinned revisions in the listed sidecar download sources. User-supplied
 * models and models managed by external runtimes are outside this manifest.
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
 * data here, rendered by `generate-third-party-notices.ts` like everything
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
 * @property {boolean} [disabled] Kept as license history for earlier downloads;
 *   this version never offers, downloads or runs it.
 */

/** @type {ModelWeightsEntry[]} */
export const MODEL_WEIGHTS = [
{
  "name": "CAM++ Core ML (evaluation only)",
  "usedFor": "Local speaker-embedding comparison only; not an application model option.",
  "repository": "https://huggingface.co/FluidInference/campplus-coreml",
  "revision": "321b18e270a4e19e69ef4a13d179b4eac07cec6a",
  "license": "Apache-2.0",
  "note": "Evaluation only. Fluid Inference conversion of FunASR iic/speech_campplus_sv_zh-cn_16k-common. The upstream ModelScope model card declares Apache License 2.0; verified 2026-10-23. Different weights from the shipped WeSpeaker CAM++ model; stored embeddings are not interchangeable.",
  "files": [
    "CamPlusPlus.mlmodelc/analytics/coremldata.bin",
    "CamPlusPlus.mlmodelc/coremldata.bin",
    "CamPlusPlus.mlmodelc/model.mil",
    "CamPlusPlus.mlmodelc/weights/weight.bin",
    "CamPlusPreprocessor.mlmodelc/analytics/coremldata.bin",
    "CamPlusPreprocessor.mlmodelc/coremldata.bin",
    "CamPlusPreprocessor.mlmodelc/model.mil",
    "CamPlusPreprocessor.mlmodelc/weights/weight.bin",
    "README.md"
  ],
  "artifacts": [
    {
      "path": "CamPlusPlus.mlmodelc/analytics/coremldata.bin",
      "size": 243,
      "sha256": "be20481d48572c431a3ed23606956706d4e224a0c7994ae1ab1920813edafe5f"
    },
    {
      "path": "CamPlusPlus.mlmodelc/coremldata.bin",
      "size": 337,
      "sha256": "800dc33d00a27621ead3e315fe93ec15a1800aa5d4a111c064cb1c44aeebbf3a"
    },
    {
      "path": "CamPlusPlus.mlmodelc/model.mil",
      "size": 971728,
      "sha256": "8605afe81896c1c23d1670132817b580dac9d3789b5805a68c6463412c50c52b"
    },
    {
      "path": "CamPlusPlus.mlmodelc/weights/weight.bin",
      "size": 13854912,
      "sha256": "058c317b6a768cac30fcf89b46676d7df1aa1915357c44ecc7ada4e5b7c11590"
    },
    {
      "path": "CamPlusPreprocessor.mlmodelc/analytics/coremldata.bin",
      "size": 243,
      "sha256": "11e99d94be389165098b54c5de6f8745ed44de70f6fd294a20ca9548c626df77"
    },
    {
      "path": "CamPlusPreprocessor.mlmodelc/coremldata.bin",
      "size": 330,
      "sha256": "64fb697bb216eddb9f691250e45fee44b2ef87b52b047ede0063fe7275571f00"
    },
    {
      "path": "CamPlusPreprocessor.mlmodelc/model.mil",
      "size": 9364,
      "sha256": "c551054a2a8f6ad2dba60ca9fd3512364b1c4114ea4d612bbd90d162487ecdb1"
    },
    {
      "path": "CamPlusPreprocessor.mlmodelc/weights/weight.bin",
      "size": 1778432,
      "sha256": "09f13054339581673c8b5745954471945a61fea54441b6e55f934f041611143a"
    },
    {
      "path": "README.md",
      "size": 1624,
      "sha256": "bab6acd7e88c350ae554b8be4c5194eda6e3548525406fcde06b58d5f96cdbd9"
    }
  ],
  "pinnedIn": "rust-sidecar/src/asr/speech_survey.rs (SURVEY_CAMPPLUS_COREML_REVISION)"
},
{
  "name": "Silero VAD 6.2.1 Core ML (evaluation only)",
  "usedFor": "Local realistic-hardware comparison only; not offered or downloaded by the application.",
  "repository": "https://huggingface.co/FluidInference/silero-vad-coreml",
  "revision": "b419383c55c110e2c9271fa6ee0ea83d03c70d96",
  "license": "MIT",
  "note": "Evaluation only. Silero VAD by Silero Team, converted to Core ML by Fluid Inference.",
  "files": [
    "README.md",
    "silero-vad-unified-256ms-v6.2.1.mlmodelc/analytics/coremldata.bin",
    "silero-vad-unified-256ms-v6.2.1.mlmodelc/coremldata.bin",
    "silero-vad-unified-256ms-v6.2.1.mlmodelc/metadata.json",
    "silero-vad-unified-256ms-v6.2.1.mlmodelc/model.mil",
    "silero-vad-unified-256ms-v6.2.1.mlmodelc/weights/weight.bin"
  ],
  "artifacts": [
    {
      "path": "README.md",
      "size": 2472,
      "sha256": "c31dbec3e24a014a51fc06c645b3cb04897c97ecdbad9a90645466019c933ef4"
    },
    {
      "path": "silero-vad-unified-256ms-v6.2.1.mlmodelc/analytics/coremldata.bin",
      "size": 243,
      "sha256": "8067594eb3126ab8318af507f0c00cabfed40d5fedb8a0ee5075dd02e903d909"
    },
    {
      "path": "silero-vad-unified-256ms-v6.2.1.mlmodelc/coremldata.bin",
      "size": 625,
      "sha256": "7db35a4fd995222a7fb0129713473b15d1462572ab4a2e5e4d56bcaad9e40f41"
    },
    {
      "path": "silero-vad-unified-256ms-v6.2.1.mlmodelc/metadata.json",
      "size": 3335,
      "sha256": "2740be542c611e1ba358e1849b4e265c65cdf0b17192767e1e5de86a31ac94d6"
    },
    {
      "path": "silero-vad-unified-256ms-v6.2.1.mlmodelc/model.mil",
      "size": 176918,
      "sha256": "c6a9d1bf22d413265da0a07a1d14151c3ea2fad296b3aa5859275b33ef1c3270"
    },
    {
      "path": "silero-vad-unified-256ms-v6.2.1.mlmodelc/weights/weight.bin",
      "size": 882304,
      "sha256": "53ecc8b5081146140ab654c89109cf001f2183abddd7a2411c5081feeffff063"
    }
  ],
  "pinnedIn": "rust-sidecar/src/asr/speech_survey.rs (SURVEY_*_COREML_REVISION)"
},
{
  "name": "Community-1 Core ML (evaluation only)",
  "usedFor": "Local realistic-hardware comparison only; not offered or downloaded by the application.",
  "repository": "https://huggingface.co/FluidInference/speaker-diarization-coreml",
  "revision": "df2625ac79a7ac6b65ad868fee6d80f320da4232",
  "license": "CC-BY-4.0",
  "note": "Evaluation only. Converted by Fluid Inference. Community-1 attribution: pyannote, WeSpeaker, and BUT Speech@FIT; modified Core ML conversion. The NOTICE.md scope excludes the legacy models, which are not downloaded.",
  "files": [
    "Embedding.mlmodelc/analytics/coremldata.bin",
    "Embedding.mlmodelc/coremldata.bin",
    "Embedding.mlmodelc/metadata.json",
    "Embedding.mlmodelc/model.mil",
    "Embedding.mlmodelc/weights/weight.bin",
    "FBank.mlmodelc/analytics/coremldata.bin",
    "FBank.mlmodelc/coremldata.bin",
    "FBank.mlmodelc/metadata.json",
    "FBank.mlmodelc/model.mil",
    "FBank.mlmodelc/weights/weight.bin",
    "LICENSE",
    "NOTICE.md",
    "PldaRho.mlmodelc/analytics/coremldata.bin",
    "PldaRho.mlmodelc/coremldata.bin",
    "PldaRho.mlmodelc/metadata.json",
    "PldaRho.mlmodelc/model.mil",
    "PldaRho.mlmodelc/weights/weight.bin",
    "README.md",
    "Segmentation.mlmodelc/analytics/coremldata.bin",
    "Segmentation.mlmodelc/coremldata.bin",
    "Segmentation.mlmodelc/metadata.json",
    "Segmentation.mlmodelc/model.mil",
    "Segmentation.mlmodelc/weights/weight.bin",
    "plda-parameters.json",
    "provenance.json",
    "xvector-transform.json"
  ],
  "artifacts": [
    {
      "path": "Embedding.mlmodelc/analytics/coremldata.bin",
      "size": 243,
      "sha256": "8d6706436639b53830b4dbe8aaf9c9a843f7f582d63e16f3cb8bb7c6ccd58682"
    },
    {
      "path": "Embedding.mlmodelc/coremldata.bin",
      "size": 704,
      "sha256": "4a705bac27d151d9642f37609296042a15602a42253039e0921dc9e75da7e004"
    },
    {
      "path": "Embedding.mlmodelc/metadata.json",
      "size": 2818,
      "sha256": "1854371eb6b438fb8aeac96afb45c999af7902581c06afdfcd7ff3cb1ce66be5"
    },
    {
      "path": "Embedding.mlmodelc/model.mil",
      "size": 78432,
      "sha256": "22fa958aef72a561c21f874a07cbdcd30fdf40ee961c0bc2fb67c119273b46d3"
    },
    {
      "path": "Embedding.mlmodelc/weights/weight.bin",
      "size": 13412288,
      "sha256": "99356b2985b8d43880a657024d941d450b38820451ccff903f76ed4e52d1868b"
    },
    {
      "path": "FBank.mlmodelc/analytics/coremldata.bin",
      "size": 243,
      "sha256": "0e8bd3a8b82ac123580989f490e4d9245127c535857630b543311268accc3f0a"
    },
    {
      "path": "FBank.mlmodelc/coremldata.bin",
      "size": 853,
      "sha256": "57ac436bb0671cbb5527a339134d695f752eb77f7a18966b93c6835335595759"
    },
    {
      "path": "FBank.mlmodelc/metadata.json",
      "size": 3409,
      "sha256": "2623785f5d186893b82d01e84aa33a7704ef763c3309e02055f22dc9d871ce9a"
    },
    {
      "path": "FBank.mlmodelc/model.mil",
      "size": 15667,
      "sha256": "27aaeb21569e81bdbe2eef87789f50a37cfea800039bd134448a9417de2f30ed"
    },
    {
      "path": "FBank.mlmodelc/weights/weight.bin",
      "size": 1776896,
      "sha256": "9e83fdd3ea78064b078069e4d9141603c61c47a27fd19e7e3142ff7476f8db36"
    },
    {
      "path": "LICENSE",
      "size": 19759,
      "sha256": "736763bf08829e36266b8a3bebcc041ac68575424e976490671a7e6b43a525cf"
    },
    {
      "path": "NOTICE.md",
      "size": 1925,
      "sha256": "0964a66893fa5c3a574758257d30d2944669f44eeed5784b30ec3bab902012b3"
    },
    {
      "path": "PldaRho.mlmodelc/analytics/coremldata.bin",
      "size": 243,
      "sha256": "8940ea6044dbcbefa22da8cc41e0b485e1fb5ed89aecaf37c6e0c483a97ddcd7"
    },
    {
      "path": "PldaRho.mlmodelc/coremldata.bin",
      "size": 763,
      "sha256": "4d9741477f721c79b09fcdfe455110c4b7d4272e2de3496bf1729d966d3ee418"
    },
    {
      "path": "PldaRho.mlmodelc/metadata.json",
      "size": 2749,
      "sha256": "b314cf25a93e46b4076883a6f5a2f8848b73c3851bd9d36074d067f35a1c7945"
    },
    {
      "path": "PldaRho.mlmodelc/model.mil",
      "size": 7613,
      "sha256": "83aee2e5310d19b5f202aea97d07a0e12102556d1b32ef3ed08b36f7f9725041"
    },
    {
      "path": "PldaRho.mlmodelc/weights/weight.bin",
      "size": 200192,
      "sha256": "80f7d229202636d372428c90596f11a91545f07da77259f07153aaf225914a36"
    },
    {
      "path": "README.md",
      "size": 4836,
      "sha256": "d0488f898df6da6e9d36f28b0704a65a13578d598c8685a9c5af0f5f8af13978"
    },
    {
      "path": "Segmentation.mlmodelc/analytics/coremldata.bin",
      "size": 243,
      "sha256": "64265f8e7ad41a5f68d630c15288c2499cca5892ad49e20096819cdeac004cdb"
    },
    {
      "path": "Segmentation.mlmodelc/coremldata.bin",
      "size": 812,
      "sha256": "ea51481b8bd3e496ad3cf16f066ddaa37f20e8772eaac76b3393c28de20e06bc"
    },
    {
      "path": "Segmentation.mlmodelc/metadata.json",
      "size": 3410,
      "sha256": "88dbf0b07208fe142e1729c2b4c974ad3599fcb2ae5d5f18fce782b225384124"
    },
    {
      "path": "Segmentation.mlmodelc/model.mil",
      "size": 43063,
      "sha256": "d37e4ce30b406a6b34f765f769b9baed3178cc0c2b2e299c641daa43a052dd3f"
    },
    {
      "path": "Segmentation.mlmodelc/weights/weight.bin",
      "size": 5959360,
      "sha256": "c3189a64946c75bc24fcb98afe89ad78c52bdbadfdf65e857fb1b81e2cc9fbb2"
    },
    {
      "path": "plda-parameters.json",
      "size": 89416,
      "sha256": "38ee28d4269c076cef254ee760bbd811f0738a92e0f01f9699ad372828c5de8f"
    },
    {
      "path": "provenance.json",
      "size": 10048,
      "sha256": "0353430db062715c411ba32e66cb435b9caee2662bccdb298f9e5d1bae760872"
    },
    {
      "path": "xvector-transform.json",
      "size": 177499,
      "sha256": "f7cd5cc16e63e2d89db052a23018ecfc47a311998ed1e9e39838fbac65048688"
    }
  ],
  "pinnedIn": "rust-sidecar/src/asr/speech_survey.rs (SURVEY_*_COREML_REVISION)"
},
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
    name: "S1-mini by Superwhisper (license texts)",
    usedFor: "The built-in cleanup model's own terms.",
    repository: "https://huggingface.co/superwhisper/s1-mini",
    revision: "88f6b15896c73bbb13a3b596e0afe8ea0d5150b4",
    license: "Apache-2.0, with an additional naming term",
    files: ["LICENSE", "NOTICE"],
    pinnedIn: "rust-sidecar/src/llm/bundled_local.rs (artifacts)",
  },
  {
    name: "Qwen3 1.7B by Qwen (GGUF, Q4_K_M)",
    usedFor: "Built-in meeting notes and Ask, Light size.",
    repository: "https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF",
    revision: "dcb19155b962dbb6389f4691a982043a8e651022",
    license: "Apache-2.0",
    note: "Qwen3-1.7B by Qwen, converted to GGUF Q4_K_M by bartowski. The Apache-2.0 license is downloaded from Qwen's upstream repository at the revision listed below.",
    files: ["Qwen_Qwen3-1.7B-Q4_K_M.gguf"],
    pinnedIn: "rust-sidecar/src/llm/native_text.rs (artifacts)",
  },
  {
    name: "Qwen3 1.7B by Qwen (license)",
    usedFor: "License for the Light notes model.",
    repository: "https://huggingface.co/Qwen/Qwen3-1.7B",
    revision: "70d244cc86ccca08cf5af4e1e306ecf908b1ad5e",
    license: "Apache-2.0",
    files: ["LICENSE"],
    pinnedIn: "rust-sidecar/src/llm/native_text.rs (artifacts)",
  },
  {
    name: "Qwen3 4B Instruct by Qwen (GGUF, Q4_K_M)",
    usedFor: "Built-in meeting notes and Ask, Balanced and Best sizes.",
    repository: "https://huggingface.co/bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF",
    revision: "ae44f08e1392f39c0e474af10c3ff8355c8b6688",
    license: "Apache-2.0",
    note: "Qwen3-4B-Instruct-2507 by Qwen, converted to GGUF Q4_K_M by bartowski. The Apache-2.0 license is downloaded from Qwen's upstream repository at the revision listed below.",
    files: ["Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf"],
    pinnedIn: "rust-sidecar/src/llm/native_text.rs (artifacts)",
  },
  {
    name: "Qwen3 4B Instruct by Qwen (license)",
    usedFor: "License for the Balanced and Best notes models.",
    repository: "https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507",
    revision: "cdbee75f17c01a7cc42f958dc650907174af0554",
    license: "Apache-2.0",
    files: ["LICENSE"],
    pinnedIn: "rust-sidecar/src/llm/native_text.rs (artifacts)",
  },
  {
    name: "EmbeddingGemma 300M by Google (ONNX, 8-bit)",
    usedFor:
      "Built-in meaning search over past recordings (optional; downloads only after the user accepts the Gemma Terms of Use in the app).",
    repository: "https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX",
    revision: "5090578d9565bb06545b4552f76e6bc2c93e4a66",
    license: "Gemma Terms of Use",
    note:
      "Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms. These files are a modified version of google/embeddinggemma-300m: onnx-community converted the weights to ONNX and quantized them to 8 bits; Plainsong downloads them unchanged. Use is also subject to the use restrictions in section 3.2 of the terms and the Gemma Prohibited Use Policy (ai.google.dev/gemma/prohibited_use_policy). Plainsong downloads and runs the model only after the user accepts both in the app, records that acceptance, and writes this notice with links to the terms to a NOTICE file beside the downloaded weights.",
    files: ["onnx/model_quantized.onnx", "onnx/model_quantized.onnx_data", "tokenizer.json"],
    pinnedIn: "rust-sidecar/src/llm/builtin_embeddings.rs (MODELS)",
  },
  {
    name: "EmbeddingGemma 2 by Google (ONNX, 8-bit, text encoder)",
    usedFor: "Built-in meaning search over past recordings (the default search model).",
    repository: "https://huggingface.co/onnx-community/embeddinggemma-2-ONNX",
    revision: "daa72c51243991dfcaf9f9137d2c573d8f7790c0",
    license: "Apache-2.0",
    note:
      "ONNX export by onnx-community of google/embeddinggemma-2, quantized to 8 bits. Google's model card asks that deployments adhere to the Gemma Prohibited Use Policy (ai.google.dev/gemma/prohibited_use_policy). Plainsong links that policy beside the model in Settings and writes this request, with the license link, to a NOTICE file beside the downloaded weights.",
    files: ["onnx/model_quantized.onnx", "onnx/model_quantized.onnx_data", "tokenizer.json"],
    pinnedIn: "rust-sidecar/src/llm/builtin_embeddings.rs (MODELS)",
  },
  {
    name: "Qwen3 Embedding 0.6B by Qwen (ONNX, 8-bit)",
    usedFor: "Built-in meaning search over past recordings (optional).",
    repository: "https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX",
    revision: "c25a394dd583836952667c12f008335071b3f43d",
    license: "Apache-2.0",
    note:
      "ONNX export by onnx-community of Qwen/Qwen3-Embedding-0.6B, which is Apache-2.0; the export repository declares no license of its own.",
    files: ["onnx/model_int8.onnx", "tokenizer.json"],
    pinnedIn: "rust-sidecar/src/llm/builtin_embeddings.rs (MODELS)",
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
    name: "Parakeet TDT 0.6b v2 (sherpa-onnx int8 export)",
    usedFor: "English speech recognition on the high-throughput local route.",
    repository:
      "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    revision: "1ab9323565ddb038682214b292f588070a538ce2",
    license: "CC-BY-4.0",
    note:
      "Attribution is a condition of use, not a courtesy: this notice, shipped with the app, is how it is met. Derived from NVIDIA's nvidia/parakeet-tdt-0.6b-v2.",
    files: [
      "encoder.int8.onnx",
      "decoder.int8.onnx",
      "joiner.int8.onnx",
      "tokens.txt",
    ],
    pinnedIn: "rust-sidecar/src/asr/parakeet.rs (PARAKEET_V2_*)",
  },
  {
    name: "Orukeet v0.1.0 int8 (experimental sherpa-onnx export)",
    usedFor: "Opt-in experimental English speech recognition.",
    repository: "https://huggingface.co/oruk/orukeet",
    revision: "b59c13a733fce5cf193230d0fa317ee7f145a108",
    license: "CC-BY-SA-4.0 weights",
    note:
      "The downloaded LICENSE-WEIGHTS and NOTICE.md are retained beside the model. NOTICE.md carries the required NVIDIA attribution for the architecture and derived work.",
    files: [
      "onnx/sherpa-v0.1.0-int8/encoder.int8.onnx",
      "onnx/sherpa-v0.1.0-int8/decoder.int8.onnx",
      "onnx/sherpa-v0.1.0-int8/joiner.int8.onnx",
      "onnx/sherpa-v0.1.0-int8/tokens.txt",
      "onnx/sherpa-v0.1.0-int8/LICENSE-WEIGHTS",
      "onnx/sherpa-v0.1.0-int8/NOTICE.md",
    ],
    pinnedIn: "rust-sidecar/src/asr/parakeet.rs (ORUKEET_*)",
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
    name: "Parakeet TDT 0.6B v3 (GGUF Q8_0)",
    usedFor:
      "Speech recognition through the transcribe.cpp Metal runtime included in macOS builds; the default dictation and meeting model on new Apple Silicon installs. Downloaded when you choose it during setup or in Settings.",
    repository:
      "https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf",
    revision: "85ac09ea12fc4b1112fa76810059364bc6adc9de",
    license: "CC-BY-4.0",
    note:
      "Attribution is a condition of use, not a courtesy: this notice, shipped with the app, is how it is met. A GGUF conversion of NVIDIA's nvidia/parakeet-tdt-0.6b-v3; the GGUF repository's own card metadata declares cc-by-4.0, matching the source weights, verified 2026-09-02.",
    files: ["parakeet-tdt-0.6b-v3-Q8_0.gguf"],
    pinnedIn: "rust-sidecar/src/asr/transcribe_cpp.rs (MODEL_SPECS)",
  },
  {
    name: "Parakeet TDT 0.6B v3 (Core ML, Neural Engine)",
    usedFor:
      "Speech recognition on the Neural Engine of Apple Silicon Macs on macOS 14 or later, through the bundled speech helper (FluidAudio). Downloaded with Parakeet and compiled for this Mac right after; the GGUF build above stays as the fallback.",
    repository: "https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml",
    revision: "7dd20fe6b1797d35f5e3307e8b1732d9a178edfe",
    license: "CC-BY-4.0",
    note:
      "Attribution is a condition of use, not a courtesy: this notice, shipped with the app, is how it is met. A Core ML conversion by FluidInference of NVIDIA's nvidia/parakeet-tdt-0.6b-v3; the repository's card declares cc-by-4.0, verified 2026-10-23. Every file is pinned by SHA-256.",
    files: [
      "Preprocessor.mlmodelc/ (model.mil, coremldata.bin, metadata.json, analytics/coremldata.bin, weights/weight.bin)",
      "Encoder_v2.mlmodelc/ (model.mil, coremldata.bin, analytics/coremldata.bin, weights/weight.bin)",
      "Decoder.mlmodelc/ (same five files as the preprocessor)",
      "JointDecisionv3.mlmodelc/ (same five files as the preprocessor)",
      "parakeet_vocab.json",
    ],
    artifacts: [
          {
                "path": "Decoder.mlmodelc/analytics/coremldata.bin",
                "size": 243,
                "sha256": "4238c4e81ecd0dc94bd7dfbb60f7e2cc824107c1ffe0387b8607b72833dba350"
          },
          {
                "path": "Decoder.mlmodelc/coremldata.bin",
                "size": 554,
                "sha256": "18647af085d87bd8f3121c8a9b4d4564c1ede038dab63d295b4e745cf2d7fb99"
          },
          {
                "path": "Decoder.mlmodelc/metadata.json",
                "size": 3427,
                "sha256": "a39e93cd8371b8ded92635c7804fcd0590f0d1dd9415c6d19a0484be073077d9"
          },
          {
                "path": "Decoder.mlmodelc/model.mil",
                "size": 13110,
                "sha256": "ef2a0a281695398a62fde86ac269c68f73d5b578d7ed3b31f2ba91a2d1ea1f35"
          },
          {
                "path": "Decoder.mlmodelc/weights/weight.bin",
                "size": 23604992,
                "sha256": "48adf0f0d47c406c8253d4f7fef967436a39da14f5a65e66d5a4b407be355d41"
          },
          {
                "path": "Encoder_v2.mlmodelc/analytics/coremldata.bin",
                "size": 243,
                "sha256": "af98d71151609799efbbffc00112fcba4bd91adf0b01135a982c574e91822f9c"
          },
          {
                "path": "Encoder_v2.mlmodelc/coremldata.bin",
                "size": 478,
                "sha256": "70628bd4fd25fb554cc0cebc31356723930c885480132bf3ecd1b5dbe71dd0a2"
          },
          {
                "path": "Encoder_v2.mlmodelc/model.mil",
                "size": 1002653,
                "sha256": "abc621390840dd064e6833dc098101706621e47e17119ead904f8c383211dd1d"
          },
          {
                "path": "Encoder_v2.mlmodelc/weights/weight.bin",
                "size": 594211328,
                "sha256": "8d2c79e15a4545e08fe3a21fe741e42b8bf24329db81de8fdfacd92388ea5a66"
          },
          {
                "path": "JointDecisionv3.mlmodelc/analytics/coremldata.bin",
                "size": 243,
                "sha256": "26def4bf73dd56d29dee21c8ef97cb8969e62f6120ed1adc91e46828e2737b6c"
          },
          {
                "path": "JointDecisionv3.mlmodelc/coremldata.bin",
                "size": 521,
                "sha256": "f5fc08b741400f0088492c9e839418b1e18522f19cba28d361dd030c5f398342"
          },
          {
                "path": "JointDecisionv3.mlmodelc/metadata.json",
                "size": 3453,
                "sha256": "d9307211b9a37e0f0ac260c7660b1571a3de25841035cfdf9b58fd40425f890f"
          },
          {
                "path": "JointDecisionv3.mlmodelc/model.mil",
                "size": 11775,
                "sha256": "be60732943389a047175111a83f8839f3eb39d4803adafa828a0871b2f39818d"
          },
          {
                "path": "JointDecisionv3.mlmodelc/weights/weight.bin",
                "size": 12642764,
                "sha256": "4e0e63d840032f7f07ddb1d64446051166281e5491bf22da8a945c41f6eedb3e"
          },
          {
                "path": "Preprocessor.mlmodelc/analytics/coremldata.bin",
                "size": 243,
                "sha256": "c9beeb989c8d66f8be11df59bc6df277ec76cee404f6865b46243835ef562f6d"
          },
          {
                "path": "Preprocessor.mlmodelc/coremldata.bin",
                "size": 486,
                "sha256": "dbde3f2300842c1fd51ef3ff948a0bcffe65ffd2dca10707f2509f32c1d65b1d"
          },
          {
                "path": "Preprocessor.mlmodelc/metadata.json",
                "size": 2841,
                "sha256": "2a98699e22d279dd37fa1d238aeb1c6db1df0d6fad687775324157689d8f3acf"
          },
          {
                "path": "Preprocessor.mlmodelc/model.mil",
                "size": 28181,
                "sha256": "4b8518a956450fec57f06c2a21bdffc26973f7f1fa6842fb38fe917f896b6b93"
          },
          {
                "path": "Preprocessor.mlmodelc/weights/weight.bin",
                "size": 491072,
                "sha256": "129b76e3aeafa8afa3ea76d995b964b145fe83700d579f6ff42c4c38fa0968ea"
          },
          {
                "path": "parakeet_vocab.json",
                "size": 151122,
                "sha256": "7ec60e05f1b24480736ec0eed40900f4626bce1fa9a60fd700ec7e2a59198735"
          }
    ],
    pinnedIn: "rust-sidecar/src/asr/neural_engine.rs (PARAKEET_V3_COREML_*)",
  },
  {
    name: "Parakeet TDT 0.6B v2 (Core ML, Neural Engine, English)",
    usedFor:
      "English speech recognition on the Neural Engine, for people whose transcription language is set to English. Same helper and fallback as the v3 entry above.",
    repository: "https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v2-coreml",
    revision: "ee09c569f73759e6d44c9bd16766f477b2b36d39",
    license: "CC-BY-4.0",
    note:
      "Attribution is a condition of use, not a courtesy: this notice, shipped with the app, is how it is met. A Core ML conversion by FluidInference of NVIDIA's nvidia/parakeet-tdt-0.6b-v2; the repository's card declares cc-by-4.0, verified 2026-10-23. Every file is pinned by SHA-256.",
    files: [
      "Preprocessor.mlmodelc/ (model.mil, coremldata.bin, metadata.json, analytics/coremldata.bin, weights/weight.bin)",
      "Encoder.mlmodelc/ (same five files)",
      "Decoder.mlmodelc/ (same five files)",
      "JointDecision.mlmodelc/ (same five files)",
      "parakeet_vocab.json",
    ],
    artifacts: [
          {
                "path": "Decoder.mlmodelc/analytics/coremldata.bin",
                "size": 243,
                "sha256": "46de1a6fe2e49d19a2125bc91acf020df7f2aea84ba821532aade8427a440b05"
          },
          {
                "path": "Decoder.mlmodelc/coremldata.bin",
                "size": 554,
                "sha256": "d200ca07694a347f6d02a3886a062ae839831e094e443222f2e48a14945966a8"
          },
          {
                "path": "Decoder.mlmodelc/metadata.json",
                "size": 3427,
                "sha256": "90a279b822496316458febc0ce761ab05954fadd9d66aa97bea077a35fc8f2b2"
          },
          {
                "path": "Decoder.mlmodelc/model.mil",
                "size": 13106,
                "sha256": "7b95a5a6b672c652000348a67b6d4d92bb8e176b978c6666fe73c28a4d7ec579"
          },
          {
                "path": "Decoder.mlmodelc/weights/weight.bin",
                "size": 14429952,
                "sha256": "27d26890221d82322c1092fd99d7b40578e435d5cf4b83c887c42603caf97aba"
          },
          {
                "path": "Encoder.mlmodelc/analytics/coremldata.bin",
                "size": 243,
                "sha256": "42e638870d73f26b332918a3496ce36793fbb413a81cbd3d16ba01328637a105"
          },
          {
                "path": "Encoder.mlmodelc/coremldata.bin",
                "size": 485,
                "sha256": "4def7aa848599ad0e17a8b9a982edcdbf33cf92e1f4b798de32e2ca0bc74b030"
          },
          {
                "path": "Encoder.mlmodelc/metadata.json",
                "size": 2926,
                "sha256": "58222fbc48c13c49d9715567803cd50cb9c23e4360462e0f8ffcea59a2c73c63"
          },
          {
                "path": "Encoder.mlmodelc/model.mil",
                "size": 959769,
                "sha256": "ed7b19156ca29fa7dfd6891deb9fda4b0e8893f68597c985d135736546a43808"
          },
          {
                "path": "Encoder.mlmodelc/weights/weight.bin",
                "size": 445187200,
                "sha256": "4adc7ad44f9d05e1bffeb2b06d3bb02861a5c7602dff63a6b494aed3bf8a6c3e"
          },
          {
                "path": "JointDecision.mlmodelc/analytics/coremldata.bin",
                "size": 243,
                "sha256": "f1183ba213bb94a918c8d2cad19ab045320618f97f6ca662245b3936d7b090f7"
          },
          {
                "path": "JointDecision.mlmodelc/coremldata.bin",
                "size": 534,
                "sha256": "e2c6752f1c8cf2d3f6f26ec93195c9bfa759ad59edf9f806696a138154f96f11"
          },
          {
                "path": "JointDecision.mlmodelc/metadata.json",
                "size": 2936,
                "sha256": "ba8d309417b9acd4a175fdb15687de6a941db2f5b06666a60e7cf3cc8e2d3c3c"
          },
          {
                "path": "JointDecision.mlmodelc/model.mil",
                "size": 9722,
                "sha256": "93bf82042235127cb81ab537dcae47a1c2e7e242ce4ffdaf772981b45eedc4f0"
          },
          {
                "path": "JointDecision.mlmodelc/weights/weight.bin",
                "size": 3453388,
                "sha256": "ca22a65903a05e64137677da608077578a8606090a598abf4875fa6199aaa19d"
          },
          {
                "path": "Preprocessor.mlmodelc/analytics/coremldata.bin",
                "size": 243,
                "sha256": "03ab3c1327a054c54c07a40325db967ec574f2c91dcc8192bfa44aa561bcf2d8"
          },
          {
                "path": "Preprocessor.mlmodelc/coremldata.bin",
                "size": 494,
                "sha256": "d88ea1fc349459c9e100d6a96688c5b29a1f0d865f544be103001724b986b6d6"
          },
          {
                "path": "Preprocessor.mlmodelc/metadata.json",
                "size": 2974,
                "sha256": "fb16c581ff5e1b962e7cb2181ed892cd32f9f84c12b6e80ff3e089f28e35bcbb"
          },
          {
                "path": "Preprocessor.mlmodelc/model.mil",
                "size": 27166,
                "sha256": "3e06d16fd061294c8a75be68c43a3b1ed1f593d4a9c35249e9cdbccadc59721e"
          },
          {
                "path": "Preprocessor.mlmodelc/weights/weight.bin",
                "size": 298880,
                "sha256": "a5f7df6c7f47147ae9486fe18cc7792f9a44d093ec3c6a11e91ef2dc363c48dc"
          },
          {
                "path": "parakeet_vocab.json",
                "size": 18762,
                "sha256": "57019fe3c745772ca83a1b048a4bb951cd51329504ea33d4d83316b96e279a97"
          }
    ],
    pinnedIn: "rust-sidecar/src/asr/neural_engine.rs (PARAKEET_V2_COREML_*)",
  },
  {
    name: "Parakeet CTC 110M (Core ML, vocabulary scoring)",
    usedFor:
      "Spelling names and terms from your dictionary and the built-in list on the Neural Engine route of Apple Silicon Macs: the bundled speech helper (FluidAudio) runs it on the CPU beside the transducer to compare each term with the words heard. Downloaded in the background for English or automatic language; it never writes text by itself.",
    repository: "https://huggingface.co/FluidInference/parakeet-ctc-110m-coreml",
    revision: "accdafd8cf8a2ff1cabe3c11e54416b405d409aa",
    license: "CC-BY-4.0",
    note:
      "Attribution is a condition of use, not a courtesy: this notice, shipped with the app, is how it is met. A Core ML conversion by FluidInference of NVIDIA's nvidia/parakeet-tdt_ctc-110m; the repository's card declares cc-by-4.0 at this revision, verified 2026-10-24. Every file is pinned by SHA-256; the repository's optional head-only graph is not downloaded.",
    files: [
      "MelSpectrogram.mlmodelc/ (model.mil, coremldata.bin, metadata.json, analytics/coremldata.bin, weights/weight.bin)",
      "AudioEncoder.mlmodelc/ (same five files)",
      "config.json",
      "tokenizer.json",
      "vocab.json",
    ],
    artifacts: [
          {
                "path": "AudioEncoder.mlmodelc/analytics/coremldata.bin",
                "size": 243,
                "sha256": "8906c823e9bb3bf6b16d9f0308f98cd70573526333ad85dd767dc3f9ae6b25fa"
          },
          {
                "path": "AudioEncoder.mlmodelc/coremldata.bin",
                "size": 505,
                "sha256": "a88b002b58193b4c31211754cdfdf220a85f9651dc61caf336ab84400cbc191a"
          },
          {
                "path": "AudioEncoder.mlmodelc/metadata.json",
                "size": 3456,
                "sha256": "4f288bfe5cbe867ef1e592cdae33578b2fe59ada69182fc12209879558f985c2"
          },
          {
                "path": "AudioEncoder.mlmodelc/model.mil",
                "size": 1060924,
                "sha256": "2f84ef93a69115e55f3b5d8ce695b3c937de1833d4d229620634fae967cd587e"
          },
          {
                "path": "AudioEncoder.mlmodelc/weights/weight.bin",
                "size": 100778304,
                "sha256": "af0734b4a5d7465ad9e8bb170f0c53c5e6b91ebb75a9bdf88d3f59ae4ad6aebd"
          },
          {
                "path": "MelSpectrogram.mlmodelc/analytics/coremldata.bin",
                "size": 243,
                "sha256": "22f2a8cba1de25c984050566b534a1d8caf22a82f9fe6c1c6f3149a0dd7e8ae3"
          },
          {
                "path": "MelSpectrogram.mlmodelc/coremldata.bin",
                "size": 330,
                "sha256": "3a32ec67c76aa0aa2faef518413c311493e89aeb7fa11289fa4b8653ab8a160c"
          },
          {
                "path": "MelSpectrogram.mlmodelc/metadata.json",
                "size": 1962,
                "sha256": "5e11d21a65c02bcfc37db43e941978e5d60d59e0efeadfda08e41f33b4f835d3"
          },
          {
                "path": "MelSpectrogram.mlmodelc/model.mil",
                "size": 12584,
                "sha256": "0a7cb5693b39667295218bac5c7c09053f6bcd4b32699a83d06ac35d14ac6b79"
          },
          {
                "path": "MelSpectrogram.mlmodelc/weights/weight.bin",
                "size": 567712,
                "sha256": "0a89c055bfde9022029d3cc59a23e949385e063974460d8eaec3a7614c3eaaa8"
          },
          {
                "path": "config.json",
                "size": 121,
                "sha256": "1fd77c83ea89285c242608d95a7992f146867481adc3938be730a064f3a63305"
          },
          {
                "path": "tokenizer.json",
                "size": 360106,
                "sha256": "9f7c517c0bf644b1b690ab037bab4d4c53aecd38e047e7154d011013ab9160db"
          },
          {
                "path": "vocab.json",
                "size": 16086,
                "sha256": "319d386eead79aadc80df9c3ecc8340d1a727efb7c02a8847eb940380dd61e1f"
          }
    ],
    pinnedIn: "rust-sidecar/src/asr/neural_engine.rs (PARAKEET_CTC_VOCABULARY_*)",
  },
  {
    name: "Orukeet r3 (transcribe.cpp GGUF Q8_0)",
    usedFor:
      "Experimental English dictation through the native runtime included in macOS builds. Model downloads are optional.",
    repository: "https://huggingface.co/oruk/orukeet",
    revision: "b59c13a733fce5cf193230d0fa317ee7f145a108",
    license: "CC-BY-SA-4.0",
    note:
      "Derived from NVIDIA Parakeet TDT 0.6B v3. Retains the weight license and NVIDIA foundation attribution as orukeet-r3-LICENSE-WEIGHTS and orukeet-r3-NOTICE.md beside the GGUF. The runtime code license is separate from the weight license.",
    files: ["orukeet-transcribe-cpp-Q8_0.gguf", "LICENSE-WEIGHTS", "NOTICE.md"],
    pinnedIn: "rust-sidecar/src/asr/transcribe_cpp.rs (Orukeet model and attribution artifacts)",
  },
  {
    name: "Moonshine Streaming Medium (GGUF Q8_0)",
    usedFor: "Experimental English dictation through the native transcribe.cpp runtime. Model download is optional.",
    repository: "https://huggingface.co/handy-computer/moonshine-streaming-medium-gguf",
    revision: "0f99e956a9e63d591ddd7f2a20dfead255e96c68",
    license: "MIT",
    note: "GGUF conversion of UsefulSensors/moonshine-streaming-medium. The pinned conversion model card declares MIT and identifies its source revision. English only; no translation or measured timestamps.",
    files: ["moonshine-streaming-medium-Q8_0.gguf"],
    pinnedIn: "rust-sidecar/src/asr/transcribe_cpp.rs (MODEL_SPECS)",
  },
  {
    name: "Qwen3-ASR 1.7B (GGUF Q8_0)",
    usedFor: "Experimental English dictation through the optional native runtime. No measured timestamps or meeting route; model download is optional.",
    repository: "https://huggingface.co/ldov/Qwen3-ASR-1.7B-gguf",
    revision: "72670a53ff1598622ea968904093b71f767d2ffa",
    license: "Apache-2.0",
    files: ["Qwen3-ASR-1.7B-Q8_0.gguf"],
    pinnedIn: "rust-sidecar/src/asr/transcribe_cpp.rs (MODEL_SPECS)",
  },
  {
    name: "Qwen3-ASR 0.6B (GGUF Q6_K)",
    usedFor: "Experimental English dictation through transcribe.cpp. No measured timestamps or meeting route. Long-clip continuity remains unqualified; model download is optional.",
    repository: "https://huggingface.co/handy-computer/Qwen3-ASR-0.6B-gguf",
    revision: "7e7c69a577fa2725dfedbe34b5e999336e30a19b",
    license: "Apache-2.0",
    note: "Runtime-maintainer conversion of Qwen/Qwen3-ASR-0.6B at source revision 5eb144179a02acc5e5ba31e748d22b0cf3e303b0. The pinned conversion retains Apache-2.0 terms in LICENSE and source attribution in NOTICE. SHA-256 3b051f108f03c0c91bbe1a3b2c1ee15e3ed51e4caec2a48751b01f2a21441cc3; 690,417,824 bytes.",
    files: ["Qwen3-ASR-0.6B-Q6_K.gguf"],
    pinnedIn: "rust-sidecar/src/asr/transcribe_cpp.rs (MODEL_SPECS)",
  },
  {
    name: "Parakeet Unified EN 0.6B (GGUF Q8_0)",
    usedFor:
      "Experimental English batch dictation through transcribe.cpp. Live preview and meetings are not enabled for this model.",
    repository:
      "https://huggingface.co/handy-computer/parakeet-unified-en-0.6b-gguf",
    revision: "7e948f21b7bdbac698d3318db9d350f1096f3b6c",
    license: "NVIDIA Open Model License",
    note:
      "Licensed by NVIDIA Corporation under the NVIDIA Open Model License. Converted from NVIDIA's nvidia/parakeet-unified-en-0.6b. The download retains the NVIDIA model card and license beside the GGUF.",
    files: [
      "parakeet-unified-en-0.6b-Q8_0.gguf",
      "parakeet-unified-en-0.6b-NVIDIA-MODEL-CARD.md",
      "parakeet-unified-en-0.6b-NVIDIA-OPEN-MODEL-LICENSE.pdf",
    ],
    pinnedIn: "rust-sidecar/src/asr/transcribe_cpp.rs (Unified EN model and attribution artifacts)",
  },
  {
    name: "Parakeet Unified EN 0.6B NVIDIA model card",
    usedFor: "Source model documentation retained beside the Unified EN GGUF.",
    repository: "https://huggingface.co/nvidia/parakeet-unified-en-0.6b",
    revision: "fe53cd885760c96b6a5f51a0bfd362cb4584a98b",
    license: "NVIDIA Open Model License",
    note: "Licensed by NVIDIA Corporation under the NVIDIA Open Model License.",
    files: ["README.md"],
    pinnedIn: "rust-sidecar/src/asr/transcribe_cpp.rs (PARAKEET_UNIFIED_EN_AUXILIARY_SPECS)",
  },
  {
    name: "Fluid Speech Mini by FluidVoice (GGUF Q8_0, Plainsong conversion)",
    usedFor:
      "Optional English dictation and meetings through transcribe.cpp. Never a default; model download is optional.",
    repository: "https://huggingface.co/FluidVoice-Labs/fluid-speech-mini-gguf",
    revision: "490bcd5de891f5efd0e732434dfb0a4b0899aead",
    license: "CC-BY-4.0",
    note:
      "Fluid Speech Mini by FluidVoice. Built on NVIDIA Parakeet TDT 0.6B v3 and Moondream Parakeet Ultra. Plainsong converted fluid-speech-mini-q2k-q4k.gguf at this revision to transcribe.cpp's Q8_0 Parakeet layout (metadata and token table from handy-computer/parakeet-tdt-0.6b-v3-gguf at 85ac09ea12fc4b1112fa76810059364bc6adc9de) and serves the result, with the CC BY 4.0 text and a NOTICE of these credits and changes, from https://github.com/JonathanRReed/Plainsong/releases/tag/models-2026-10. Download pinned by SHA-256 15dbfb78d8f02d4618447fe25a60dde13f35ad12513842bac41e321ff0fa6219.",
    files: [
      "fluid-speech-mini-q8_0.gguf",
      "fluid-speech-mini-LICENSE.txt",
      "fluid-speech-mini-NOTICE.txt",
    ],
    pinnedIn: "rust-sidecar/src/asr/transcribe_cpp.rs (FLUID_SPEECH_MINI_AUXILIARY_SPECS and MODEL_SPECS)",
  },
  {
    name: "Underdog Bark 3.0 Pro by Conway Research (GGUF Q8_0, Plainsong conversion)",
    usedFor:
      "Optional English dictation and meetings through transcribe.cpp. Never a default; model download is optional.",
    repository: "https://huggingface.co/ConwayResearch/Underdog-Bark-3.0-Pro",
    revision: "4b5c51e04aa8d16dda9ecdff71bc29f7360149e4",
    license: "CC-BY-4.0",
    note:
      "Derived from nvidia/parakeet-tdt-0.6b-v3 (NVIDIA Corporation, CC BY 4.0) and moondream/parakeet-ultra (Moondream, CC BY 4.0); post-trained and compressed by Conway Research. Plainsong converted model.safetensors at this revision to transcribe.cpp's Q8_0 Parakeet layout, with <unk> typed as a control token (metadata and token table from handy-computer/parakeet-tdt-0.6b-v3-gguf at 85ac09ea12fc4b1112fa76810059364bc6adc9de), and serves the result, with the CC BY 4.0 text and a NOTICE of these credits and changes, from https://github.com/JonathanRReed/Plainsong/releases/tag/models-2026-10. Download pinned by SHA-256 017193232ec9ca53f53800877cacd8f8c468040f4a8d377fc07e1e959808ac6f.",
    files: [
      "underdog-bark-3.0-pro-q8_0.gguf",
      "underdog-bark-3.0-pro-LICENSE.txt",
      "underdog-bark-3.0-pro-NOTICE.txt",
    ],
    pinnedIn: "rust-sidecar/src/asr/transcribe_cpp.rs (UNDERDOG_BARK_PRO_AUXILIARY_SPECS and MODEL_SPECS)",
  },
  {
    name: "Nemotron 3.5 ASR Streaming 0.6B (GGUF Q8_0)",
    usedFor:
      "Proving the transcribe.cpp streaming runtime path from `benchmark-latency`. It is never offered as a transcription route.",
    repository:
      "https://huggingface.co/handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf",
    revision: "6d44e540bc31b0de1dbe174a3cea87f53a7f22fb",
    license: "OpenMDW-1.1 (NVIDIA Open Model License terms)",
    note:
      "NVIDIA ships this model under OpenMDW-1.1 rather than the CC-BY-4.0 of the Parakeet weights beside it. It is downloadable only behind the optional transcribe.cpp runtime and is not selectable as a route, so nothing redistributes it.",
    files: ["nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf"],
    pinnedIn: "rust-sidecar/src/asr/transcribe_cpp.rs (MODEL_SPECS)",
  },
  {
    name: "Voxtral Mini 3B 2507 (GGUF Q4_K_M)",
    usedFor:
      "Measuring Mistral's open-weights Voxtral against the shipped Parakeet default on this hardware, from `benchmark-latency`. It is never offered as a transcription route: see artifacts/qa/model-selection-2026-09-03.md.",
    repository:
      "https://huggingface.co/handy-computer/Voxtral-Mini-3B-2507-gguf",
    revision: "5690205813042c07cbaa86d2a9dcc585fcd31304",
    license: "Apache-2.0",
    note:
      "A GGUF conversion of Mistral's mistralai/Voxtral-Mini-3B-2507. The GGUF repository's own card metadata declares apache-2.0, matching the source weights, verified 2026-09-03. Downloadable only behind the optional transcribe.cpp runtime and not selectable as a route, so nothing redistributes it.",
    files: ["Voxtral-Mini-3B-2507-Q4_K_M.gguf"],
    pinnedIn: "rust-sidecar/src/asr/transcribe_cpp.rs (MODEL_SPECS)",
  },
  {
    name: "Voxtral Mini 4B Realtime 2602 (GGUF Q4_K_M)",
    usedFor:
      "Measuring Mistral's open-weights streaming Voxtral against the shipped streaming route on this hardware, from `benchmark-latency`. It is never offered as a transcription route.",
    repository:
      "https://huggingface.co/handy-computer/Voxtral-Mini-4B-Realtime-2602-gguf",
    revision: "b3e1c979e3775cbd0a49a65878a0ec7f06789ed7",
    license: "Apache-2.0",
    note:
      "A GGUF conversion of Mistral's mistralai/Voxtral-Mini-4B-Realtime-2602, apache-2.0 on both the source and the conversion, verified 2026-09-03. Downloadable only behind the optional transcribe.cpp runtime and not selectable as a route.",
    files: ["Voxtral-Mini-4B-Realtime-2602-Q4_K_M.gguf"],
    pinnedIn: "rust-sidecar/src/asr/transcribe_cpp.rs (MODEL_SPECS)",
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
    name: "Cohere Transcribe 03-2026 (ONNX int4 export)",
    usedFor:
      "Speech recognition on the experimental offline high-accuracy route.",
    repository:
      "https://huggingface.co/onnx-community/cohere-transcribe-03-2026-ONNX",
    revision: "31b1c6211c9000d76b077ddd23b74c9090badeba",
    license: "Apache-2.0",
    note:
      "The export repository declares Apache-2.0 in its own right, not only by inheritance from CohereLabs/cohere-transcribe-03-2026, which it also declares Apache-2.0. Every file is additionally pinned by SHA-256 on download.",
    files: [
      "onnx/encoder_model_q4.onnx",
      "onnx/encoder_model_q4.onnx_data",
      "onnx/decoder_model_merged_q4.onnx",
      "onnx/decoder_model_merged_q4.onnx_data",
      "tokenizer.json",
      "config.json",
      "generation_config.json",
      "preprocessor_config.json",
    ],
    pinnedIn: "rust-sidecar/src/asr/cohere_local.rs (COHERE_LOCAL_HF_*)",
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
    name: "Nemotron 3 Diarization (ONNX)",
    usedFor: "Optional experimental local meeting speaker labels with overlap handling.",
    repository: "https://huggingface.co/altunenes/parakeet-rs",
    revision: "4d2a8bc71f5c896ec40faa59732e6716295edaf2",
    license: "OpenMDW-1.1",
    files: ["nemotron-3-diarization/nemotron3_diar_v3.onnx"],
    pinnedIn: "rust-sidecar/src/download/mod.rs (diarization_model_info)",
    note: "Community ONNX conversion of NVIDIA Nemotron 3 Diarization, under the original model's OpenMDW-1.1 license. The runtime source is MIT OR Apache-2.0. Weights download is optional; the speaker-model default is unchanged.",
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
    usedFor: "Nothing in this version. Earlier versions offered it for meeting speaker embeddings.",
    repository: "https://huggingface.co/phoenix124/kept-models",
    revision: "42de48f3d8cb1c33ad29f4dbe2db0801a0759ddf",
    license: "not declared by the repository this file is fetched from",
    pendingLicenseReview: true,
    disabled: true,
    note:
      "Disabled: Plainsong no longer offers, downloads or runs this model, including a copy already on disk, because the mirror it was pinned to declares no license. An earlier download stays on disk until the user removes it in Settings > Meetings. This entry records the gap for those earlier downloads.",
    files: ["diarize-embedding-eres2netv2-int8.onnx"],
    pinnedIn: "rust-sidecar/src/download/mod.rs (refused in download_diarization_model_by_id)",
  },
  {
    name: "pyannote speaker-diarization-community-1 (ONNX, Plainsong conversion)",
    usedFor:
      "Optional local meeting speaker labels with overlap handling, through Plainsong's Rust port of the community-1 pipeline. Model download is optional.",
    repository: "https://huggingface.co/pyannote-community/speaker-diarization-community-1",
    revision: "8a527374977391da736e0daaef26855d949d9685",
    license: "CC-BY-4.0",
    note:
      "pyannote speaker-diarization-community-1 by pyannote (pyannoteAI), CC BY 4.0: powerset segmentation model by Alexis Plaquet and Herv\u00e9 Bredin, WeSpeaker ResNet34 embedding trained on VoxCeleb (CC BY 4.0), PLDA for VBx by BUT Speech@FIT. The repository is the ungated mirror of pyannote/speaker-diarization-community-1. Plainsong exported the segmentation and embedding networks at this revision to ONNX with scripts/pyannote-community1/export_onnx.py (deterministic) and serves them, upstream's plda.npz and xvec_transform.npz unchanged, the CC BY 4.0 text and a NOTICE of these credits and changes from https://github.com/JonathanRReed/Plainsong/releases/tag/models-2026-10, each pinned by SHA-256.",
    files: [
      "pyannote-community-1-segmentation.onnx",
      "pyannote-community-1-embedding.onnx",
      "pyannote-community-1-plda.npz",
      "pyannote-community-1-xvec_transform.npz",
      "pyannote-community-1-LICENSE.txt",
      "pyannote-community-1-NOTICE.txt",
    ],
    pinnedIn: "rust-sidecar/src/download/mod.rs (COMMUNITY1_BUNDLE)",
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
    "from the repository and revision named below (or, where its note says so,",
    "from Plainsong's own release of a conversion of it), verified against a SHA-256",
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
