//! transcribe.cpp provider — the single-runtime spike (feature `asr-transcribe-cpp`).
//!
//! Plainsong runs three inference stacks today: whisper-rs (ggml, Metal),
//! ONNX Runtime on the CPU for the default Parakeet TDT 0.6B v3 int8 route,
//! and Candle with Metal for the Whisper-derived models. The default dictation
//! engine — Parakeet — is the one that never touches the GPU.
//!
//! [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) (MIT) is
//! a ggml runtime that loads Parakeet TDT, Whisper, Nemotron streaming,
//! Qwen3-ASR, Cohere Transcribe, Voxtral and Moonshine v2 from one GGUF loader
//! with Metal on by default. This module is the spike that measures whether it
//! could replace the custom Parakeet-on-Metal FFI that
//! `docs/model-inventory-upgrades.md` item 1 estimated at 1-2 weeks.
//!
//! - The whole module is behind `asr-transcribe-cpp`, which is off in Cargo's
//!   default set and enabled for macOS builds by
//!   `scripts/sidecar-cargo-features.ts`, so the shipped Mac app contains it
//!   (the Nemotron live preview runs here).
//! - Parakeet TDT 0.6B v3 Q8_0 is the dictation and meeting default for new
//!   installs on Apple Silicon (`settings::fresh_install_dictation_route`);
//!   older installs keep their meeting route unless the user names this one.
//!   Fluid Speech Mini and Underdog Bark 3.0 Pro are optional English models
//!   for dictation and meetings, served from Plainsong's own model release.
//!   Every other batch route here is labelled experimental. None of them is
//!   ever recommended.
//! - The original spike is `artifacts/qa/transcribe-cpp-spike-2026-09-02.md`.
//!   The Parakeet GGUF admission measurements are next to
//!   `parakeet_gguf_memory_budget`.

mod windowing;

use super::{
    streaming_chunk_samples, AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, ModelOption,
    Partial, StreamingAsrProvider, StreamingAsrSession, TranscriptSegment, TranscriptionResult,
    DEFAULT_STREAMING_CHUNK_MS, STREAMING_CHUNK_MS_CHOICES, STREAMING_SAMPLE_RATE_HZ,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, TryLockError};
use std::time::{Duration, Instant};
use transcribe_cpp::{
    Backend, CancelToken, CommitPolicy, Model, ModelOptions, MoonshineStreamingOptions,
    ParakeetStreamOptions, RunOptions, Session, StreamExtension, StreamOptions, TimestampKind,
};

/// Directory under `models/` that holds every GGUF this provider fetches.
/// Flat, one file per model, because a GGUF is a single self-contained file —
/// unlike the ORT Parakeet route, whose four artifacts need their own folder.
pub(crate) const TRANSCRIBE_CPP_MODEL_DIR: &str = "transcribe_cpp";

/// The one route this provider offers: Parakeet TDT 0.6B v3, Q8_0-quantized,
/// the closest GGUF analogue to the int8 ONNX export the app ships today.
pub const PARAKEET_GGUF_MODEL_ID: &str = "parakeet-tdt-0.6b-v3-q8_0";

/// Orukeet r3 converted to the Parakeet-compatible GGUF architecture.
/// English is the only language qualified in Plainsong, and the route stays
/// dictation-only even if the runtime exposes token timing rows.
pub const ORUKEET_R3_GGUF_MODEL_ID: &str = "orukeet-r3-q8_0";

/// English dictation qualification only. This port returns no measured timestamps.
pub const QWEN3_ASR_17_GGUF_MODEL_ID: &str = "qwen3-asr-1.7b-q8_0";

/// Experimental English dictation. Three-minute continuity is not yet qualified.
pub const QWEN3_ASR_06_GGUF_MODEL_ID: &str = "qwen3-asr-0.6b-q6_k";

/// NVIDIA's English-only unified offline and buffered-streaming model.
/// Plainsong exposes batch dictation and experimental English meetings. Live
/// preview still needs its own buffered-stream qualification.
pub const PARAKEET_UNIFIED_EN_GGUF_MODEL_ID: &str = "parakeet-unified-en-0.6b-q8_0";

/// Section 3 of NVIDIA's governing agreement requires this exact sentence in
/// a Notice file when the model is redistributed. The downloaded model card
/// records provenance; the separately downloaded PDF is the agreement itself.
pub const PARAKEET_UNIFIED_EN_ATTRIBUTION_NOTICE: &str =
    "Licensed by NVIDIA Corporation under the NVIDIA Open Model License";

/// Fluid Speech Mini (FluidVoice), a Parakeet TDT 0.6B v3 derivative that
/// Plainsong converts to this runtime's Q8_0 layout. Optional English model for
/// dictation and meetings, never a default: on the 2026-10-21 evaluation it
/// wrote fewer stray words with another voice talking nearby in synthetic audio,
/// but left more real-speech clips empty, made more critical errors in the
/// dictation tests, did worse in synthetic crowd noise and dropped very short
/// replies (`artifacts/continuation-2026-10-20/opus-bark/report.md`).
pub const FLUID_SPEECH_MINI_GGUF_MODEL_ID: &str = "fluid-speech-mini-q8_0";

/// Underdog Bark 3.0 Pro (Conway Research), converted the same way, with
/// `<unk>` typed as a control token so the runtime drops it from text. Optional
/// English model, never a default: better on short distant-microphone clips,
/// with whole-meeting differences within test variation. Synthetic-voice
/// dictation often lost capitals, punctuation and the space between digits and
/// words.
pub const UNDERDOG_BARK_PRO_GGUF_MODEL_ID: &str = "underdog-bark-3.0-pro-q8_0";

/// The attribution FluidVoice asks for, word for word (CC BY 4.0).
pub const FLUID_SPEECH_MINI_ATTRIBUTION: &str =
    "Fluid Speech Mini by FluidVoice. Built on NVIDIA Parakeet TDT 0.6B v3 and Moondream Parakeet Ultra.";

/// The credits Conway Research's NOTICE names (CC BY 4.0).
pub const UNDERDOG_BARK_PRO_ATTRIBUTION: &str = "Underdog Bark 3.0 Pro by Conway Research. Built on NVIDIA Parakeet TDT 0.6B v3 and Moondream Parakeet Ultra; post-trained and compressed by Conway Research.";

/// Plainsong's own release that serves the GGUFs it converted. Upstream
/// publishes neither model in this runtime's layout, so the converted bytes are
/// hosted here and pinned by SHA-256 like every other download.
const PLAINSONG_MODEL_RELEASE_URL: &str =
    "https://github.com/JonathanRReed/Plainsong/releases/download/models-2026-10";

/// Shared weights for the existing streaming preview and experimental English
/// final dictation. Batch selection does not qualify new languages or meetings.
pub const NEMOTRON_STREAMING_GGUF_MODEL_ID: &str = "nemotron-3.5-asr-streaming-0.6b-q8_0";

/// English batch dictation only; numeric accuracy and streaming remain unqualified.
pub const MOONSHINE_STREAM_MEDIUM_MODEL_ID: &str = "moonshine-streaming-medium-q8_0";

/// Mistral's offline audio-LLM, the open-weights accuracy leader on the
/// Artificial Analysis non-streaming board. Measured here on 2026-09-03 and
/// **not** offered as a route: see
/// `artifacts/qa/model-selection-2026-09-03.md`.
pub const VOXTRAL_MINI_3B_GGUF_MODEL_ID: &str = "voxtral-mini-3b-2507-q4_k_m";

/// Mistral's streaming sibling. Also measured, also not a route, for the same
/// reason plus one more: it emits no timestamps at all.
pub const VOXTRAL_REALTIME_4B_GGUF_MODEL_ID: &str = "voxtral-mini-4b-realtime-2602-q4_k_m";

/// Env override for the compute backend, so one binary can measure Metal and
/// CPU without a rebuild. Spike-only: nothing in the app sets it, and the
/// default (`Auto`) is what a user would get.
pub(crate) const BACKEND_ENV_VAR: &str = "PLAINSONG_TRANSCRIBE_CPP_BACKEND";

/// Fallback only when a transducer token has no usable probability. The GGUF
/// Parakeet decoder supplies per-token probabilities through `decoder.cpp`;
/// `token_confidence` below uses those measured values when available. Keep
/// the fallback aligned with `asr/parakeet.rs` for unscored tokens.
const UNSCORED_TRANSDUCER_CONFIDENCE: f64 = 0.88;

/// User-facing copy when the weights are absent or unverified. No runtime or
/// file-format names: the details stay in logs and diagnostics.
const MISSING_SPEECH_MODEL: &str =
    "The speech model is missing or couldn't be verified. Download it again in Settings > Models.";

/// A GGUF this provider knows how to fetch, verify and load.
pub(crate) struct TranscribeCppModelSpec {
    pub model_id: &'static str,
    pub label: &'static str,
    pub display_name: &'static str,
    pub file_name: &'static str,
    pub hf_repo: &'static str,
    /// Pinned repo commit, so the URL is immutable the way every other model
    /// download in this app is.
    pub hf_revision: &'static str,
    /// The GGUF is Plainsong's own conversion, downloaded from
    /// `PLAINSONG_MODEL_RELEASE_URL`. `hf_repo` and `hf_revision` then name
    /// the source the bytes were converted from, and the SHA-256 is the pin.
    pub hosted_by_plainsong: bool,
    pub sha256: &'static str,
    pub size_bytes: u64,
    pub license: &'static str,
    pub upstream_url: &'static str,
    pub languages: &'static [&'static str],
    /// Whether the route catalog is offered this model at all.
    pub offered_as_route: bool,
}

pub(crate) struct TranscribeCppAuxiliarySpec {
    pub source_url: &'static str,
    pub local_file_name: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
}

const ORUKEET_R3_AUXILIARY_SPECS: &[TranscribeCppAuxiliarySpec] = &[
    TranscribeCppAuxiliarySpec {
        source_url: "https://huggingface.co/oruk/orukeet/resolve/b59c13a733fce5cf193230d0fa317ee7f145a108/LICENSE-WEIGHTS",
        local_file_name: "orukeet-r3-LICENSE-WEIGHTS",
        sha256: "23ee78c8bae49cf08ea2f0c84945c66b987ebe4520881fb51b3dad4fb43d07c2",
        size_bytes: 20_137,
    },
    TranscribeCppAuxiliarySpec {
        source_url: "https://huggingface.co/oruk/orukeet/resolve/b59c13a733fce5cf193230d0fa317ee7f145a108/NOTICE.md",
        local_file_name: "orukeet-r3-NOTICE.md",
        sha256: "f1cf43822e52f0a2e5aa3c0b1252d34a17d30cd29303a12eb2f0b151e7433132",
        size_bytes: 4_765,
    },
];

const PARAKEET_UNIFIED_EN_AUXILIARY_SPECS: &[TranscribeCppAuxiliarySpec] = &[
    TranscribeCppAuxiliarySpec {
        source_url: "https://huggingface.co/nvidia/parakeet-unified-en-0.6b/resolve/fe53cd885760c96b6a5f51a0bfd362cb4584a98b/README.md",
        local_file_name: "parakeet-unified-en-0.6b-NVIDIA-MODEL-CARD.md",
        sha256: "505590d4440b38ca33ed4d5b8af2a10c2391ecd8740c945bfdf82825e1a05fb3",
        size_bytes: 17_800,
    },
    TranscribeCppAuxiliarySpec {
        source_url: "https://www.nvidia.com/content/dam/en-zz/Solutions/license-agreements/enterprise-software/nvidia-open-model-license-agreements-24-10-2025.pdf",
        local_file_name: "parakeet-unified-en-0.6b-NVIDIA-OPEN-MODEL-LICENSE.pdf",
        sha256: "4d2fb590aa9b30c47f2058bff17291df7fa2aa0c1bd775a20703da9bb267cfab",
        size_bytes: 79_005,
    },
];

/// CC BY 4.0 asks for the licence text and the credits to travel with the
/// weights, so both files are part of the download and of readiness. The two
/// licence files are the same Creative Commons legal code, byte for byte.
const FLUID_SPEECH_MINI_AUXILIARY_SPECS: &[TranscribeCppAuxiliarySpec] = &[
    TranscribeCppAuxiliarySpec {
        source_url: "https://github.com/JonathanRReed/Plainsong/releases/download/models-2026-10/fluid-speech-mini-LICENSE.txt",
        local_file_name: "fluid-speech-mini-LICENSE.txt",
        sha256: "9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411",
        size_bytes: 18_657,
    },
    TranscribeCppAuxiliarySpec {
        source_url: "https://github.com/JonathanRReed/Plainsong/releases/download/models-2026-10/fluid-speech-mini-NOTICE.txt",
        local_file_name: "fluid-speech-mini-NOTICE.txt",
        sha256: "6ce6d4b65f1ff18dbf9e96ba9dce44c7c7953961dd1ca14e721889de60fcaaad",
        size_bytes: 2_346,
    },
];

const UNDERDOG_BARK_PRO_AUXILIARY_SPECS: &[TranscribeCppAuxiliarySpec] = &[
    TranscribeCppAuxiliarySpec {
        source_url: "https://github.com/JonathanRReed/Plainsong/releases/download/models-2026-10/underdog-bark-3.0-pro-LICENSE.txt",
        local_file_name: "underdog-bark-3.0-pro-LICENSE.txt",
        sha256: "9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411",
        size_bytes: 18_657,
    },
    TranscribeCppAuxiliarySpec {
        source_url: "https://github.com/JonathanRReed/Plainsong/releases/download/models-2026-10/underdog-bark-3.0-pro-NOTICE.txt",
        local_file_name: "underdog-bark-3.0-pro-NOTICE.txt",
        sha256: "c5832f497dd20becaaea71f8dbe616e3658333a63bada5b7b615f8e996832948",
        size_bytes: 2_490,
    },
];

impl TranscribeCppAuxiliarySpec {
    pub(crate) fn url(&self) -> String {
        self.source_url.to_string()
    }

    #[cfg(test)]
    fn source_file_name(&self) -> &str {
        self.source_url.rsplit('/').next().unwrap_or_default()
    }
}

pub(crate) fn auxiliary_specs_for(model_id: &str) -> &'static [TranscribeCppAuxiliarySpec] {
    match model_id {
        ORUKEET_R3_GGUF_MODEL_ID => ORUKEET_R3_AUXILIARY_SPECS,
        PARAKEET_UNIFIED_EN_GGUF_MODEL_ID => PARAKEET_UNIFIED_EN_AUXILIARY_SPECS,
        FLUID_SPEECH_MINI_GGUF_MODEL_ID => FLUID_SPEECH_MINI_AUXILIARY_SPECS,
        UNDERDOG_BARK_PRO_GGUF_MODEL_ID => UNDERDOG_BARK_PRO_AUXILIARY_SPECS,
        _ => &[],
    }
}

impl TranscribeCppModelSpec {
    pub(crate) fn url(&self) -> String {
        if self.hosted_by_plainsong {
            return format!("{PLAINSONG_MODEL_RELEASE_URL}/{}", self.file_name);
        }
        format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            self.hf_repo, self.hf_revision, self.file_name
        )
    }

    /// Download ceiling: the pinned size plus 1 MiB of slack, so a server that
    /// starts streaming a different (larger) file is cut off long before it
    /// fills the disk. The SHA-256 check is what actually rejects it.
    pub(crate) fn max_bytes(&self) -> u64 {
        self.size_bytes + 1024 * 1024
    }

    pub(crate) fn size_mib(&self) -> f64 {
        self.size_bytes as f64 / (1024.0 * 1024.0)
    }
}

/// The 25 languages NVIDIA lists for Parakeet TDT 0.6B v3 — the same set the
/// ORT route in `asr/parakeet.rs` declares, because it is the same weights.
const PARAKEET_V3_LANGUAGES: &[&str] = &[
    "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it", "lv", "lt", "mt",
    "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk",
];

/// The 8 languages Mistral lists on the `Voxtral-Mini-3B-2507` model card.
const VOXTRAL_2507_LANGUAGES: &[&str] = &["en", "fr", "de", "es", "it", "pt", "nl", "hi"];

/// The 13 languages Mistral lists on the `Voxtral-Mini-4B-Realtime-2602` card.
/// The streaming processor is auto-detect only — there is no language hint to
/// send — so this is a coverage claim, not a selector.
const VOXTRAL_REALTIME_LANGUAGES: &[&str] = &[
    "en", "fr", "es", "de", "ru", "zh", "ja", "it", "pt", "nl", "ar", "hi", "ko",
];

pub(crate) const MODEL_SPECS: &[TranscribeCppModelSpec] = &[
    TranscribeCppModelSpec {
        model_id: PARAKEET_GGUF_MODEL_ID,
        label: "Parakeet TDT 0.6B v3 GGUF Q8_0 via transcribe.cpp",
        display_name: "Parakeet TDT 0.6B v3 (GGUF Q8_0)",
        file_name: "parakeet-tdt-0.6b-v3-Q8_0.gguf",
        hf_repo: "handy-computer/parakeet-tdt-0.6b-v3-gguf",
        hf_revision: "85ac09ea12fc4b1112fa76810059364bc6adc9de",
        hosted_by_plainsong: false,
        sha256: "5859f77944efcd8eafa23a6350731960b2b55b2203df51f319665c807d802cc7",
        size_bytes: 739_508_576,
        // Verified on the GGUF repo's own model card metadata
        // (`cardData.license == "cc-by-4.0"`) on 2026-09-02, matching the
        // NVIDIA source weights this conversion is derived from.
        license: "CC-BY-4.0",
        upstream_url: "https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf",
        languages: PARAKEET_V3_LANGUAGES,
        offered_as_route: true,
    },
    TranscribeCppModelSpec {
        model_id: ORUKEET_R3_GGUF_MODEL_ID,
        label: "Orukeet r3 GGUF Q8_0 via transcribe.cpp (experimental, English dictation)",
        display_name: "Orukeet r3 (GGUF Q8_0, experimental)",
        file_name: "orukeet-transcribe-cpp-Q8_0.gguf",
        hf_repo: "oruk/orukeet",
        hf_revision: "b59c13a733fce5cf193230d0fa317ee7f145a108",
        hosted_by_plainsong: false,
        sha256: "cad2f52ac91cad829279422301989687c2cf02e19157352ed25ea501b90dbb7e",
        size_bytes: 739_508_608,
        license: "CC-BY-SA-4.0 weights; NVIDIA attribution applies",
        upstream_url: "https://huggingface.co/oruk/orukeet",
        languages: &["en"],
        offered_as_route: true,
    },
    TranscribeCppModelSpec {
        model_id: QWEN3_ASR_17_GGUF_MODEL_ID,
        label: "Qwen3-ASR 1.7B GGUF Q8_0 (experimental, English dictation)",
        display_name: "Qwen3-ASR 1.7B (GGUF Q8_0, experimental)",
        file_name: "Qwen3-ASR-1.7B-Q8_0.gguf",
        hf_repo: "ldov/Qwen3-ASR-1.7B-gguf",
        hf_revision: "72670a53ff1598622ea968904093b71f767d2ffa",
        hosted_by_plainsong: false,
        sha256: "9a0d81792dfea2d5f278b8a63deb3ea6e02139ce42c2301f32ea19c4f77526b7",
        size_bytes: 2_185_030_624,
        license: "Apache-2.0",
        upstream_url: "https://huggingface.co/Qwen/Qwen3-ASR-1.7B",
        languages: &["en"],
        offered_as_route: true,
    },
    TranscribeCppModelSpec {
        model_id: QWEN3_ASR_06_GGUF_MODEL_ID,
        label: "Qwen3-ASR 0.6B GGUF Q6_K (experimental, English dictation)",
        display_name: "Qwen3-ASR 0.6B (GGUF Q6_K, experimental)",
        file_name: "Qwen3-ASR-0.6B-Q6_K.gguf",
        hf_repo: "handy-computer/Qwen3-ASR-0.6B-gguf",
        hf_revision: "7e7c69a577fa2725dfedbe34b5e999336e30a19b",
        hosted_by_plainsong: false,
        sha256: "3b051f108f03c0c91bbe1a3b2c1ee15e3ed51e4caec2a48751b01f2a21441cc3",
        size_bytes: 690_417_824,
        license: "Apache-2.0",
        upstream_url: "https://huggingface.co/Qwen/Qwen3-ASR-0.6B",
        languages: &["en"],
        offered_as_route: true,
    },
    TranscribeCppModelSpec {
        model_id: PARAKEET_UNIFIED_EN_GGUF_MODEL_ID,
        label: "Parakeet Unified EN 0.6B GGUF Q8_0 (experimental, English dictation and meetings)",
        display_name: "Parakeet Unified EN 0.6B (GGUF Q8_0, experimental)",
        file_name: "parakeet-unified-en-0.6b-Q8_0.gguf",
        hf_repo: "handy-computer/parakeet-unified-en-0.6b-gguf",
        hf_revision: "7e948f21b7bdbac698d3318db9d350f1096f3b6c",
        hosted_by_plainsong: false,
        sha256: "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795",
        size_bytes: 731_357_568,
        license: "NVIDIA Open Model License",
        upstream_url: "https://huggingface.co/nvidia/parakeet-unified-en-0.6b",
        languages: &["en"],
        offered_as_route: true,
    },
    TranscribeCppModelSpec {
        model_id: NEMOTRON_STREAMING_GGUF_MODEL_ID,
        label: "Nemotron 3.5 ASR Streaming 0.6B GGUF Q8_0 (experimental, English dictation)",
        display_name: "Nemotron 3.5 ASR Streaming 0.6B (GGUF Q8_0, experimental)",
        file_name: "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf",
        hf_repo: "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf",
        hf_revision: "6d44e540bc31b0de1dbe174a3cea87f53a7f22fb",
        hosted_by_plainsong: false,
        sha256: "b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c",
        size_bytes: 751_094_240,
        // NVIDIA ships this one under OpenMDW-1.1, not CC-BY-4.0. It is
        // Existing preview and experimental batch dictation share these weights.
        license: "OpenMDW-1.1",
        upstream_url: "https://huggingface.co/handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf",
        // The model card lists 32 language-locales; only English is exercised
        // here, so no language list is claimed.
        languages: &["en"],
        offered_as_route: true,
    },
    TranscribeCppModelSpec {
        model_id: MOONSHINE_STREAM_MEDIUM_MODEL_ID,
        label: "Moonshine Streaming Medium Q8_0 (experimental, English dictation; check numbers)",
        display_name: "Moonshine Streaming Medium (Q8_0, experimental)",
        file_name: "moonshine-streaming-medium-Q8_0.gguf",
        hf_repo: "handy-computer/moonshine-streaming-medium-gguf",
        hf_revision: "0f99e956a9e63d591ddd7f2a20dfead255e96c68",
        hosted_by_plainsong: false,
        sha256: "f7c9564249b508f6012927ec4f9e536087da53a7047f858ca9975bea5f75299e",
        size_bytes: 295_793_568,
        license: "MIT",
        upstream_url: "https://huggingface.co/moonshine-ai/moonshine-streaming-medium",
        languages: &["en"],
        offered_as_route: true,
    },
    TranscribeCppModelSpec {
        model_id: FLUID_SPEECH_MINI_GGUF_MODEL_ID,
        label: "Fluid Speech Mini by FluidVoice (GGUF Q8_0, optional, English)",
        display_name: "Fluid Speech Mini by FluidVoice (GGUF Q8_0)",
        file_name: "fluid-speech-mini-q8_0.gguf",
        // The source the release bytes were converted from; the release
        // README and NOTICE record the steps, which reproduce this digest.
        hf_repo: "FluidVoice-Labs/fluid-speech-mini-gguf",
        hf_revision: "490bcd5de891f5efd0e732434dfb0a4b0899aead",
        hosted_by_plainsong: true,
        sha256: "15dbfb78d8f02d4618447fe25a60dde13f35ad12513842bac41e321ff0fa6219",
        size_bytes: 739_508_608,
        license: "CC-BY-4.0",
        upstream_url: "https://huggingface.co/FluidVoice-Labs/fluid-speech-mini-gguf",
        languages: &["en"],
        offered_as_route: true,
    },
    TranscribeCppModelSpec {
        model_id: UNDERDOG_BARK_PRO_GGUF_MODEL_ID,
        label: "Underdog Bark 3.0 Pro by Conway Research (GGUF Q8_0, optional, English)",
        display_name: "Underdog Bark 3.0 Pro by Conway Research (GGUF Q8_0)",
        file_name: "underdog-bark-3.0-pro-q8_0.gguf",
        hf_repo: "ConwayResearch/Underdog-Bark-3.0-Pro",
        hf_revision: "4b5c51e04aa8d16dda9ecdff71bc29f7360149e4",
        hosted_by_plainsong: true,
        sha256: "017193232ec9ca53f53800877cacd8f8c468040f4a8d377fc07e1e959808ac6f",
        size_bytes: 739_508_608,
        license: "CC-BY-4.0",
        upstream_url: "https://huggingface.co/ConwayResearch/Underdog-Bark-3.0-Pro",
        languages: &["en"],
        offered_as_route: true,
    },
    TranscribeCppModelSpec {
        model_id: VOXTRAL_MINI_3B_GGUF_MODEL_ID,
        label: "Voxtral Mini 3B 2507 GGUF Q4_K_M (measured, not a route)",
        display_name: "Voxtral Mini 3B (2507, GGUF Q4_K_M)",
        file_name: "Voxtral-Mini-3B-2507-Q4_K_M.gguf",
        hf_repo: "handy-computer/Voxtral-Mini-3B-2507-gguf",
        hf_revision: "5690205813042c07cbaa86d2a9dcc585fcd31304",
        hosted_by_plainsong: false,
        sha256: "3a6717aa8f8989108d260cbd237584289eec43cc987e10133c33643515936205",
        size_bytes: 2_984_721_056,
        // Mistral ships Voxtral under Apache-2.0 and the GGUF repo's card
        // metadata repeats it; verified 2026-09-03. Q4_K_M is the smallest and
        // fastest tier upstream publishes, and its LibriSpeech WER (1.94%) is
        // within noise of BF16 (1.88%) — so this is Voxtral at its best case
        // for latency, which is the comparison that had to be made.
        license: "Apache-2.0",
        upstream_url: "https://huggingface.co/handy-computer/Voxtral-Mini-3B-2507-gguf",
        languages: VOXTRAL_2507_LANGUAGES,
        offered_as_route: false,
    },
    TranscribeCppModelSpec {
        model_id: VOXTRAL_REALTIME_4B_GGUF_MODEL_ID,
        label: "Voxtral Mini 4B Realtime 2602 GGUF Q4_K_M (measured, not a route)",
        display_name: "Voxtral Mini 4B Realtime (2602, GGUF Q4_K_M)",
        file_name: "Voxtral-Mini-4B-Realtime-2602-Q4_K_M.gguf",
        hf_repo: "handy-computer/Voxtral-Mini-4B-Realtime-2602-gguf",
        hf_revision: "b3e1c979e3775cbd0a49a65878a0ec7f06789ed7",
        hosted_by_plainsong: false,
        sha256: "39dc1f65539373a406edea7490505822d77c12edff521744678717eef4da4723",
        size_bytes: 2_830_493_984,
        license: "Apache-2.0",
        upstream_url: "https://huggingface.co/handy-computer/Voxtral-Mini-4B-Realtime-2602-gguf",
        languages: VOXTRAL_REALTIME_LANGUAGES,
        offered_as_route: false,
    },
];

pub(crate) fn spec_for(model_id: &str) -> &'static TranscribeCppModelSpec {
    let trimmed = model_id.trim();
    MODEL_SPECS
        .iter()
        .find(|spec| spec.model_id == trimmed)
        .unwrap_or(&MODEL_SPECS[0])
}

/// Restrict saved settings to models offered by the app catalog. Hidden
/// runtime probes such as Voxtral must not become selectable accidentally.
pub(crate) fn route_spec_for(model_id: &str) -> &'static TranscribeCppModelSpec {
    let spec = spec_for(model_id);
    if spec.offered_as_route {
        return spec;
    }
    MODEL_SPECS
        .iter()
        .find(|candidate| candidate.offered_as_route)
        .unwrap_or(&MODEL_SPECS[0])
}

/// Model ids the route catalog is allowed to offer.
pub fn route_model_options() -> Vec<ModelOption> {
    MODEL_SPECS
        .iter()
        .filter(|spec| spec.offered_as_route)
        .map(|spec| ModelOption {
            id: spec.model_id.to_string(),
            label: spec.label.to_string(),
        })
        .collect()
}

/// Every byte choosing Download for Parakeet fetches on this Mac: the Neural
/// Engine build and, where dictation can be English, the vocabulary model
/// where `download_models` fetches those, otherwise the ggml file. The
/// Models screen and setup show this figure in place of the catalog's size.
pub(crate) fn parakeet_download_bytes() -> u64 {
    super::neural_engine::coreml_download_bytes().unwrap_or_else(parakeet_ggml_bytes)
}

/// The ggml file alone, for the background download that fetches it when
/// this Mac needs it.
pub(crate) fn parakeet_ggml_bytes() -> u64 {
    spec_for(PARAKEET_GGUF_MODEL_ID).size_bytes
}

/// Whether Parakeet's ggml file is on this Mac and not already found wrong in
/// this session. Never hashes.
pub(crate) fn parakeet_ggml_ready(models_root: &Path) -> bool {
    TranscribeCppProvider::with_models_root(models_root, Some(PARAKEET_GGUF_MODEL_ID)).ggml_ready()
}

/// Fetch and verify Parakeet's ggml file, for [`super::neural_engine`]'s
/// background download when the Core ML build cannot serve on this Mac.
pub(crate) async fn download_parakeet_ggml(
    models_root: &Path,
    progress: Arc<dyn Fn(f32) + Send + Sync>,
) -> Result<()> {
    TranscribeCppProvider::with_models_root(models_root, Some(PARAKEET_GGUF_MODEL_ID))
        .download_ggml(progress)
        .await
}

/// How one download's progress (0-100) splits over its parts, by bytes.
#[derive(Clone, Copy, Debug)]
struct DownloadShares {
    neural: f32,
    vocabulary: f32,
}

impl DownloadShares {
    fn new(neural_bytes: u64, vocabulary_bytes: u64) -> Self {
        let total = (neural_bytes + vocabulary_bytes).max(1) as f32;
        Self {
            neural: neural_bytes as f32 / total,
            vocabulary: vocabulary_bytes as f32 / total,
        }
    }

    /// 100 is reported once, by the caller, after every part.
    fn neural(self, p: f32) -> f32 {
        (p * self.neural).min(99.9)
    }

    fn vocabulary(self, p: f32) -> f32 {
        (self.neural * 100.0 + p * self.vocabulary).min(99.9)
    }
}

/// Every model this provider can load, including the ones the route catalog is
/// not offered. `benchmark-latency` uses this so the spike's runtime proof for
/// a streaming-capable family can be measured without making it a route.
pub fn benchmark_model_options() -> Vec<ModelOption> {
    MODEL_SPECS
        .iter()
        .map(|spec| ModelOption {
            id: spec.model_id.to_string(),
            label: spec.label.to_string(),
        })
        .collect()
}

/// Whether this route's Parakeet can transcribe on this Mac: its GGUF is here
/// and not already found wrong in this session, or the Core ML build serves
/// without it. Bytes are checked when a model first loads.
pub(crate) fn parakeet_route_ready(models_root: &Path) -> bool {
    TranscribeCppProvider::with_models_root(models_root, Some(PARAKEET_GGUF_MODEL_ID))
        .is_available()
}

/// The pinned files a request on `model_id` loads first: the Neural Engine
/// model when it serves Parakeet v3, otherwise the GGUF. The auxiliary
/// licence and notice files are never loaded.
pub(crate) fn route_model_artifacts(models_root: &Path, model_id: &str) -> Vec<(PathBuf, String)> {
    let spec = route_spec_for(model_id);
    if spec.model_id == PARAKEET_GGUF_MODEL_ID {
        if let Some(neural) = super::neural_engine::request_spec_for_family(
            models_root,
            super::neural_engine::preferred_family(),
            parakeet_ggml_ready(models_root),
        ) {
            let dir = neural.dir(models_root);
            return neural
                .files
                .iter()
                .map(|file| (dir.join(file.path), file.sha256.to_string()))
                .collect();
        }
    }
    vec![(
        models_root
            .join(TRANSCRIBE_CPP_MODEL_DIR)
            .join(spec.file_name),
        spec.sha256.to_string(),
    )]
}

/// Every pinned (path, sha256) pair, for the export inventory and the test
/// that each one carries a real digest.
pub(crate) fn model_integrity_artifacts(models_root: &Path) -> Vec<(PathBuf, String)> {
    let dir = models_root.join(TRANSCRIBE_CPP_MODEL_DIR);
    let mut artifacts: Vec<(PathBuf, String)> = MODEL_SPECS
        .iter()
        .map(|spec| (dir.join(spec.file_name), spec.sha256.to_string()))
        .collect();
    for spec in MODEL_SPECS {
        artifacts.extend(
            auxiliary_specs_for(spec.model_id)
                .iter()
                .map(|aux| (dir.join(aux.local_file_name), aux.sha256.to_string())),
        );
    }
    artifacts
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BackendChoice {
    /// What a user gets: Metal on this build, CPU everywhere it is missing.
    Auto,
    /// Fail rather than silently fall back — the benchmark needs to know which
    /// device produced a number.
    Metal,
    /// Strict CPU, for the same reason.
    Cpu,
}

impl BackendChoice {
    fn to_backend(self) -> Backend {
        match self {
            BackendChoice::Auto => Backend::Auto,
            BackendChoice::Metal => Backend::Metal,
            BackendChoice::Cpu => Backend::Cpu,
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            BackendChoice::Auto => "auto",
            BackendChoice::Metal => "metal",
            BackendChoice::Cpu => "cpu",
        }
    }
}

/// Parses `PLAINSONG_TRANSCRIBE_CPP_BACKEND`. Anything unrecognised is `Auto`:
/// a typo must not silently pin the slow device.
pub(crate) fn parse_backend_choice(raw: Option<&str>) -> BackendChoice {
    match raw.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "metal" | "gpu" => BackendChoice::Metal,
        "cpu" => BackendChoice::Cpu,
        _ => BackendChoice::Auto,
    }
}

fn backend_choice_from_env() -> BackendChoice {
    parse_backend_choice(std::env::var(BACKEND_ENV_VAR).ok().as_deref())
}

// ---------------------------------------------------------------------------
// Result mapping (pure, so it is testable without a GGUF on disk)
// ---------------------------------------------------------------------------

/// The subset of `transcribe_cpp::Segment` this provider consumes, lifted into
/// a plain struct so segment building can be unit-tested without loading a
/// model.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

fn has_complete_native_word_alignment(transcript: &::transcribe_cpp::Transcript) -> bool {
    let words = &transcript.words;
    matches!(
        transcript.timestamp_kind,
        TimestampKind::Word | TimestampKind::Token
    ) && !words.is_empty()
        && words
            .iter()
            .all(|word| word.t0_ms >= 0 && word.t1_ms >= word.t0_ms)
        && words.windows(2).all(|pair| pair[0].t0_ms <= pair[1].t0_ms)
        && words
            .iter()
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
            .split_whitespace()
            .eq(transcript.text.split_whitespace())
}

fn native_timed_rows(transcript: &::transcribe_cpp::Transcript) -> Vec<RawSegment> {
    if has_complete_native_word_alignment(transcript) {
        return transcript
            .words
            .iter()
            .map(|word| RawSegment {
                start_ms: word.t0_ms,
                end_ms: word.t1_ms,
                text: word.text.clone(),
            })
            .collect();
    }
    transcript
        .segments
        .iter()
        .map(|segment| RawSegment {
            start_ms: segment.t0_ms,
            end_ms: segment.t1_ms,
            text: segment.text.clone(),
        })
        .collect()
}

/// The language to stamp on a result when the runtime detected none.
///
/// transcribe.cpp's Parakeet family has no language head and reports no
/// detected language, and the v3 weights decode 25 languages, so defaulting
/// to English mislabelled every French or German dictation on this route.
/// Mirrors `asr/parakeet.rs`'s `result_language` for the ONNX export of the
/// same weights: an English-only spec says "en", a multilingual one says
/// nothing rather than guess.
fn fallback_result_language(spec: &TranscribeCppModelSpec) -> &'static str {
    if matches!(spec.languages, ["en"]) {
        "en"
    } else {
        ""
    }
}

/// Mean of the finite per-token probabilities, or the documented placeholder
/// when the family reports none (Parakeet's transducer reports NaN).
pub(crate) fn token_confidence(probabilities: &[f32]) -> f64 {
    let finite: Vec<f64> = probabilities
        .iter()
        .filter(|p| p.is_finite())
        .map(|p| f64::from(*p))
        .filter(|p| (0.0..=1.0).contains(p))
        .collect();
    if finite.is_empty() {
        return UNSCORED_TRANSDUCER_CONFIDENCE;
    }
    finite.iter().sum::<f64>() / finite.len() as f64
}

/// Turn the binding's millisecond segments into the second-based
/// `TranscriptSegment` rows the dictation and meeting contracts consume.
///
/// Three properties the meeting timeline depends on, and which the raw rows do
/// not guarantee:
///
/// - times are seconds, monotonically non-decreasing, and never negative;
/// - an end time before its start collapses to the start rather than producing
///   a backwards span that breaks seeking;
/// - a family that returns text with no timed rows at all still yields exactly
///   one segment covering the clip, the way `asr/parakeet.rs` does, so the
///   meeting view never renders an empty transcript for a non-empty decode.
pub(crate) fn build_segments(
    raw: &[RawSegment],
    full_text: &str,
    audio_seconds: f64,
    confidence: f64,
) -> Vec<TranscriptSegment> {
    let clip_end = if audio_seconds.is_finite() && audio_seconds > 0.0 {
        audio_seconds
    } else {
        0.0
    };

    let mut segments: Vec<TranscriptSegment> = Vec::with_capacity(raw.len());
    for row in raw {
        let text = row.text.trim();
        if text.is_empty() {
            continue;
        }
        let start = (row.start_ms.max(0) as f64) / 1000.0;
        let end = (row.end_ms.max(0) as f64) / 1000.0;
        segments.push(TranscriptSegment {
            start_time: start,
            end_time: end.max(start),
            text: text.to_string(),
            confidence,
        });
    }

    if segments.is_empty() {
        let text = full_text.trim();
        if text.is_empty() {
            return Vec::new();
        }
        return vec![TranscriptSegment {
            start_time: 0.0,
            end_time: clip_end,
            text: text.to_string(),
            confidence,
        }];
    }

    segments
}

/// Preserve the runtime's timestamp capability instead of treating an
/// untimed full-text container row as a measured span.
pub(crate) fn build_segments_for_timestamp_kind(
    raw: &[RawSegment],
    full_text: &str,
    audio_seconds: f64,
    confidence: f64,
    timestamp_kind: TimestampKind,
) -> Vec<TranscriptSegment> {
    match timestamp_kind {
        TimestampKind::Segment | TimestampKind::Word | TimestampKind::Token => {
            build_segments(raw, full_text, audio_seconds, confidence)
        }
        TimestampKind::None | TimestampKind::Auto => Vec::new(),
    }
}

/// The longest upstream diagnostic that may be quoted into a user-facing
/// sentence before it stops being a sentence.
const MAX_UPSTREAM_DETAIL_CHARS: usize = 160;

/// Upstream's own message, folded onto one line and capped.
///
/// Only ever applied to the failure classes whose message is a library
/// diagnostic — a path, a GGUF architecture name, an ABI version — never to
/// `Aborted`/`OutputTruncated`, whose payload is derived from what the user
/// said.
pub(crate) fn short_upstream_detail(raw: &str) -> String {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_end_matches(['.', ' ']);
    if trimmed.chars().count() <= MAX_UPSTREAM_DETAIL_CHARS {
        return trimmed.to_string();
    }
    let mut capped: String = trimmed.chars().take(MAX_UPSTREAM_DETAIL_CHARS).collect();
    capped.push('…');
    capped
}

/// Append the upstream diagnostic to a Plainsong sentence, or leave the
/// sentence alone when upstream said nothing usable.
fn with_upstream_detail(sentence: String, raw: &str) -> String {
    let detail = short_upstream_detail(raw);
    if detail.is_empty() {
        return sentence;
    }
    format!("{sentence} transcribe.cpp said: {detail}.")
}

/// One user-facing sentence per failure class: what happened, why, and the next
/// action. Deliberately does NOT include `error.partial()` — a partial
/// transcript is user speech and must not be pasted into a log line or an error
/// toast.
///
/// Three of these classes are packaging or environment faults a user cannot act
/// on without the detail — which GGUF architecture was rejected, which backend
/// was missing, which ABI version disagreed. Those keep a short form of
/// upstream's message in the sentence and log the full one at warn; a bug
/// report that says only "the GGUF is unreadable" cannot be triaged.
pub(crate) fn describe_transcribe_error(model_id: &str, error: &transcribe_cpp::Error) -> String {
    use transcribe_cpp::Error;
    match error {
        Error::ModelFileNotFound(_) => {
            tracing::warn!("transcribe.cpp weights for '{model_id}' are not on disk");
            MISSING_SPEECH_MODEL.to_string()
        }
        Error::ModelLoad(detail) => {
            tracing::warn!("transcribe.cpp could not load '{model_id}': {detail}");
            with_upstream_detail(
                format!(
                    "transcribe.cpp could not load '{model_id}': the GGUF is unreadable or its architecture is not supported by this build. Re-download the model from Settings."
                ),
                detail,
            )
        }
        Error::Backend(detail) => {
            tracing::warn!("transcribe.cpp backend unavailable for '{model_id}': {detail}");
            with_upstream_detail(
                format!(
                    "transcribe.cpp could not use the requested compute backend for '{model_id}'. Unset {BACKEND_ENV_VAR} to let it choose, or use another route."
                ),
                detail,
            )
        }
        Error::OutOfMemory(_) => format!(
            "transcribe.cpp ran out of memory transcribing with '{model_id}'. Close other applications or pick a smaller model."
        ),
        Error::InputTooLong(_) => format!(
            "The recording is longer than '{model_id}' can decode in one pass. Use a shorter clip or a long-form route."
        ),
        Error::Unsupported(_) | Error::NotImplemented(_) => format!(
            "'{model_id}' cannot satisfy this request through transcribe.cpp. Use another route."
        ),
        Error::Aborted { .. } => {
            format!("Transcription with '{model_id}' was cancelled before it finished.")
        }
        Error::OutputTruncated { .. } => format!(
            "transcribe.cpp stopped decoding '{model_id}' at its generation budget, so the transcript is incomplete. Transcribe a shorter clip."
        ),
        Error::Busy(_) => format!(
            "transcribe.cpp is already transcribing with '{model_id}'. Wait for the current transcription to finish."
        ),
        Error::VersionMismatch(detail) | Error::BadStructSize(detail) => {
            tracing::warn!("transcribe.cpp ABI mismatch for '{model_id}': {detail}");
            with_upstream_detail(
                format!(
                    "The bundled transcribe.cpp library does not match the bindings this build was compiled against, so '{model_id}' cannot run. This is a packaging fault; report it."
                ),
                detail,
            )
        }
        Error::InvalidArgument(_) | Error::Nul(_) => format!(
            "transcribe.cpp rejected the request for '{model_id}' as malformed. This is a bug in Plainsong; report it."
        ),
        // `transcribe_cpp::Error` is `#[non_exhaustive]`: a future variant
        // lands here rather than failing to compile, and still says what to do.
        _ => format!(
            "transcribe.cpp failed to transcribe with '{model_id}'. Try again, or use another route."
        ),
    }
}

// ---------------------------------------------------------------------------
// Native runtime, cached per (model file, backend)
// ---------------------------------------------------------------------------

struct CachedRuntime {
    key: String,
    /// Held so the native model outlives the session; also what a future
    /// multi-session path would clone.
    _model: Model,
    session: Session,
    load_ms: u64,
    /// The finest timestamp granularity this family can produce, read from the
    /// loaded model. Asking for more than this is a hard error upstream, not a
    /// silent downgrade — see `timestamp_request_for`.
    max_timestamp_kind: TimestampKind,
}

/// What to ask a loaded model for, given the finest granularity it advertises.
///
/// Prefer measured word rows when available. Families differ:
/// Parakeet advertises `Token`, Voxtral advertises `None`. `transcribe_run`
/// rejects a request finer than `max_timestamp_kind` with
/// `TRANSCRIBE_ERR_UNSUPPORTED_TIMESTAMPS` rather than clamping it, so asking
/// every family for `Segment` makes a timestamp-free family fail to decode at
/// all instead of returning the text it does have. Clamp here, explicitly,
/// rather than passing `Auto`. Word rows avoid splitting subword tokens while
/// retaining alignment that would be lost in a whole-utterance segment.
pub(crate) fn timestamp_request_for(max_timestamp_kind: TimestampKind) -> TimestampKind {
    match max_timestamp_kind {
        TimestampKind::Word | TimestampKind::Token => TimestampKind::Word,
        TimestampKind::Segment => TimestampKind::Segment,
        // `Auto` is not a capability a model reports; treat anything else as
        // "no timed rows available".
        TimestampKind::None | TimestampKind::Auto => TimestampKind::None,
    }
}

fn runtime_cache() -> &'static Mutex<Option<CachedRuntime>> {
    static CACHE: OnceLock<Mutex<Option<CachedRuntime>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    static REGISTRATION: OnceLock<std::sync::Arc<crate::model_residency::IdleModel>> =
        OnceLock::new();
    crate::model_residency::watch_cache(&REGISTRATION, 2 * 1024 * 1024 * 1024, cache);
    cache
}

fn runtime_key(model_path: &Path, backend: BackendChoice) -> String {
    format!("{}::{}", model_path.to_string_lossy(), backend.label())
}

/// Take the cache lock, recovering from poison instead of wedging the route for
/// the life of the process.
///
/// `panic = "unwind"` (see Cargo.toml) means a panic anywhere under the lock —
/// a bug in this module, an allocation failure while materializing a
/// transcript — unwinds and poisons the mutex. Every `lock()?` after that
/// returns `Err` forever, so `clear_cached_runtime()` silently did nothing and
/// the route was dead until the user restarted the app. Poison recovery drops
/// whatever was cached, because a native session that was mid-decode when the
/// unwind happened is exactly the thing not to keep using; the next call
/// reloads.
fn lock_runtime_cache() -> MutexGuard<'static, Option<CachedRuntime>> {
    match runtime_cache().lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            runtime_cache().clear_poison();
            let mut guard = poisoned.into_inner();
            if guard.take().is_some() {
                tracing::warn!(
                    "Dropped the transcribe.cpp runtime that was cached when a panic unwound \
                     through the decode; the next transcription reloads it"
                );
            }
            guard
        }
    }
}

/// Drop any cached native model, so a re-download or a settings change cannot
/// keep serving transcripts from weights that are no longer on disk.
pub(crate) fn clear_cached_runtime() {
    if lock_runtime_cache().take().is_some() {
        tracing::info!("Cleared cached transcribe.cpp runtime");
    }
}

fn runtime_key_matches_model(runtime_key: &str, model_path: &Path) -> bool {
    runtime_key.starts_with(&format!("{}::", model_path.to_string_lossy()))
}

/// Drop the cached runtime only when it belongs to the measured model.
/// Another route may have warmed the shared slot while benchmark cleanup was
/// waiting for the native runtime gate.
pub(crate) fn clear_cached_runtime_for_model(model_path: &Path) {
    let mut cache = lock_runtime_cache();
    if cache
        .as_ref()
        .is_some_and(|runtime| runtime_key_matches_model(&runtime.key, model_path))
    {
        *cache = None;
        tracing::info!(model = %model_path.display(), "Cleared cached transcribe.cpp runtime");
    }
}

/// When the cached runtime last finished a decode or a load.
fn runtime_last_used() -> &'static Mutex<Option<Instant>> {
    static LAST_USED: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    LAST_USED.get_or_init(|| Mutex::new(None))
}

fn mark_runtime_used() {
    *runtime_last_used()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Instant::now());
    super::speech_residency::ensure_idle_release();
}

/// Whether the "Keep speech model ready for" timer governs this cached
/// runtime. Only Parakeet: every other model here (Moonshine, Fluid Speech
/// Mini, Bark and the rest) follows the older dictation keep-warm switch, as
/// `speech_residency::manages_route` and the setting's copy say.
fn runtime_follows_speech_idle_timer(runtime_key: &str) -> bool {
    runtime_key
        .split("::")
        .next()
        .and_then(|path| Path::new(path).file_name())
        .is_some_and(|name| name == spec_for(PARAKEET_GGUF_MODEL_ID).file_name)
}

/// Drop the cached Parakeet runtime if nothing has used it for `idle`. Never
/// waits: a runtime whose lock is held is decoding, which is the opposite of
/// idle.
pub(crate) fn release_parakeet_runtime_if_idle(idle: Duration) -> bool {
    let mut cache = match runtime_cache().try_lock() {
        Ok(cache) => cache,
        Err(_) => return false,
    };
    if !cache
        .as_ref()
        .is_some_and(|runtime| runtime_follows_speech_idle_timer(&runtime.key))
    {
        return false;
    }
    let stale = runtime_last_used()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .is_none_or(|last| last.elapsed() >= idle);
    if stale {
        *cache = None;
    }
    stale
}

/// Drop a cached ggml Parakeet before the Neural Engine copy of the same model
/// loads, so the two are never resident together.
pub(crate) fn clear_cached_parakeet_runtime(models_root: &Path) {
    clear_cached_runtime_for_model(
        &models_root
            .join(TRANSCRIBE_CPP_MODEL_DIR)
            .join(spec_for(PARAKEET_GGUF_MODEL_ID).file_name),
    );
}

/// Wall-clock milliseconds spent loading the cached model, or `None` when no
/// model is loaded. The benchmark reports this; nothing in the app reads it.
pub fn cached_model_load_ms() -> Option<u64> {
    lock_runtime_cache().as_ref().map(|runtime| runtime.load_ms)
}

// ---------------------------------------------------------------------------
// Cancellation and deadline
// ---------------------------------------------------------------------------

/// Wall-clock decode budget per second of audio, and the floor for very short
/// clips. Same numbers as `qwen3_asr.rs`, for the same reason: generous enough
/// that a cold Metal shader compile on a loaded machine is not mistaken for a
/// hang, tight enough that a runaway decode cannot hold the single global
/// runtime forever.
const DECODE_BUDGET_PER_AUDIO_SECOND: f64 = 4.0;
const DECODE_BUDGET_MIN_SECONDS: f64 = 30.0;

/// How often the watchdog re-reads the abandonment flag. Dropping a future
/// raises no signal, so this one has to be polled; the deadline itself is
/// waited on exactly.
const ABANDON_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// How often a request waiting for the runtime retries the lock.
const RUNTIME_ACQUIRE_POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Wall-clock budget for decoding `audio_seconds` of audio.
pub(crate) fn decode_budget_for_audio(audio_seconds: f64) -> Duration {
    Duration::from_secs_f64(
        (audio_seconds.max(0.0) * DECODE_BUDGET_PER_AUDIO_SECOND).max(DECODE_BUDGET_MIN_SECONDS),
    )
}

/// Why a decode stopped before the model finished on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DecodeStop {
    /// The async caller dropped the request (`CancelOnDrop` fired).
    Cancelled,
    /// The wall-clock budget ran out.
    DeadlineExceeded,
}

/// The one control decision, kept pure so it is testable without a GGUF.
pub(crate) fn check_decode_control(
    abandoned: &AtomicBool,
    deadline: Instant,
) -> Result<(), DecodeStop> {
    if abandoned.load(Ordering::Relaxed) {
        return Err(DecodeStop::Cancelled);
    }
    if Instant::now() >= deadline {
        return Err(DecodeStop::DeadlineExceeded);
    }
    Ok(())
}

/// Sets the shared flag when dropped. The async `transcribe` future holds one
/// across its `.await`, so a caller that abandons the request (the sidecar
/// aborts a request's task when Electron gives up on it) flips the flag; the
/// watchdog then cancels the native run instead of leaving the single global
/// runtime locked until the decode finishes on its own.
struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// The error a request that never got the runtime surfaces.
///
/// Both arms exist because the wait is now bounded. Before, a second request
/// blocked on the mutex for as long as the first decode took, with nothing to
/// show the user; `Busy` is the honest name for that, and it is upstream's own
/// name for the same condition.
fn runtime_wait_error(stop: DecodeStop, model_label: &str, budget: Duration) -> anyhow::Error {
    use transcribe_cpp::Error;
    let error = match stop {
        DecodeStop::Cancelled => Error::Aborted {
            message: "the caller abandoned the request while it waited for the runtime".to_string(),
            partial: None,
        },
        DecodeStop::DeadlineExceeded => Error::Busy(format!(
            "another decode held the runtime for the whole {:.0} s budget",
            budget.as_secs_f64()
        )),
    };
    anyhow::anyhow!(describe_transcribe_error(model_label, &error))
}

/// Cancels `token` when the caller abandons the request or the deadline passes.
///
/// transcribe.cpp polls its abort callback between decode steps
/// (`Session::set_cancel_token`), so this thread is what turns an abandoned or
/// runaway decode into a bounded return. It exits as soon as the decode signals
/// that it finished, so a normal transcription pays one thread spawn and no
/// added latency.
struct DecodeWatchdog {
    finished: Arc<(Mutex<bool>, Condvar)>,
    handle: Option<std::thread::JoinHandle<Option<DecodeStop>>>,
}

impl DecodeWatchdog {
    fn spawn(token: CancelToken, abandoned: Arc<AtomicBool>, deadline: Instant) -> Self {
        let finished = Arc::new((Mutex::new(false), Condvar::new()));
        let watched = Arc::clone(&finished);
        let handle = std::thread::spawn(move || {
            let (lock, condvar) = &*watched;
            let mut done = lock.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if *done {
                    return None;
                }
                if let Err(stop) = check_decode_control(&abandoned, deadline) {
                    token.cancel();
                    return Some(stop);
                }
                let wait = deadline
                    .saturating_duration_since(Instant::now())
                    .min(ABANDON_POLL_INTERVAL);
                done = condvar
                    .wait_timeout(done, wait)
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
        });
        Self {
            finished,
            handle: Some(handle),
        }
    }

    fn signal_finished(&self) {
        let (lock, condvar) = &*self.finished;
        *lock.lock().unwrap_or_else(|e| e.into_inner()) = true;
        condvar.notify_all();
    }

    /// Stop watching, and report why the run was cancelled if it was.
    fn finish(mut self) -> Option<DecodeStop> {
        self.signal_finished();
        self.handle
            .take()
            .and_then(|handle| handle.join().unwrap_or(None))
    }
}

impl Drop for DecodeWatchdog {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            self.signal_finished();
            let _ = handle.join();
        }
    }
}

/// Take the runtime lock, but never for longer than the request's own budget.
fn acquire_runtime(
    abandoned: &AtomicBool,
    deadline: Instant,
    model_label: &str,
    budget: Duration,
) -> Result<MutexGuard<'static, Option<CachedRuntime>>> {
    loop {
        match runtime_cache().try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(_)) => return Ok(lock_runtime_cache()),
            Err(TryLockError::WouldBlock) => {
                if let Err(stop) = check_decode_control(abandoned, deadline) {
                    return Err(runtime_wait_error(stop, model_label, budget));
                }
                std::thread::sleep(RUNTIME_ACQUIRE_POLL_INTERVAL);
            }
        }
    }
}

struct NativeRun {
    text: String,
    raw_segments: Vec<RawSegment>,
    token_probabilities: Vec<f32>,
    timestamp_kind: TimestampKind,
    measured_word_timestamps: bool,
    load_ms: u64,
    language: Option<String>,
}

// Only the integrity-verified pinned route and measured PCM range use the
// calibrated reserve. Longer input retains the generic admission policy.
fn moonshine_memory_budget(model_label: &str, sample_count: usize) -> Option<u64> {
    if model_label != spec_for(MOONSHINE_STREAM_MEDIUM_MODEL_ID).file_name
        || sample_count > 180 * 16_000
    {
        return None;
    }
    Some(if sample_count > 30 * 16_000 {
        1536 * 1024 * 1024
    } else {
        0
    })
}

/// Extra host bytes the pinned Parakeet v3 GGUF route reserves beyond its
/// calibrated workspace (the model size), or `None` outside the measured range.
///
/// Measured 2026-10-21 with `asr-eval-batch` (release, Metal, M4 Pro 24 GB),
/// process peak physical footprint from `/usr/bin/time -l` and `footprint`:
/// about 1.0 GB after load and across 750 clips of 3-8 s; 1.01, 1.16, 1.32,
/// 1.69 and 1.73 GB for single 15, 120, 236, 415 and 534 s decodes. Mixed
/// 15-534 s sequences settle between 1.2 and 3.0 GB peak (340 decodes, no
/// upward trend after the first ~80), because the ggml scheduler keeps
/// buffers sized for earlier long graphs. So up to 30 s needs only the
/// model-sized workspace, and up to 600 s gets 1.5 GiB more (2.2 GiB in
/// all), covering the ~2.0 GB seen above the loaded baseline. Longer input
/// decodes in one
/// full-attention pass that was not measured, so it keeps the generic rule.
///
/// Fluid Speech Mini and Underdog Bark 3.0 Pro are the same architecture at
/// the same size (697 tensors in the same types, 739,508,608 bytes) and share
/// this budget; their peaks are next to `PARAKEET_GGUF_SHAPED_MODEL_IDS`.
fn parakeet_gguf_memory_budget(
    model_label: &str,
    sample_count: usize,
) -> Option<(&'static str, u64)> {
    let model_id = PARAKEET_GGUF_SHAPED_MODEL_IDS
        .iter()
        .copied()
        .find(|model_id| spec_for(model_id).file_name == model_label)?;
    if sample_count > 600 * 16_000 {
        return None;
    }
    Some((
        model_id,
        if sample_count > 30 * 16_000 {
            1536 * 1024 * 1024
        } else {
            0
        },
    ))
}

/// Pinned routes that are Parakeet TDT 0.6B v3 in this runtime's Q8_0 layout:
/// the default and the two optional English derivatives. Each is admitted on
/// the `ParakeetGguf` profile in `llm::local_model_load`.
///
/// Measured 2026-10-21 with `asr-eval-batch` (release, Metal, M4 Pro 24 GB),
/// process peak footprint from `/usr/bin/time -l`, default / Fluid / Bark Pro
/// in the same build: 982 / 976 / 972 MiB across 20 clips of 0.3-12 s; 1380 /
/// 1317 / 1345 MiB for a single 292 s decode; 1420 / 1418 / 1364 MiB for 20
/// short clips with two 292 s decodes between them. Neither derivative needs
/// more than the default's allowance.
pub(crate) const PARAKEET_GGUF_SHAPED_MODEL_IDS: &[&str] = &[
    PARAKEET_GGUF_MODEL_ID,
    FLUID_SPEECH_MINI_GGUF_MODEL_ID,
    UNDERDOG_BARK_PRO_GGUF_MODEL_ID,
];

/// The admission profile key and extra host bytes for a pinned route whose
/// native footprint was measured in Plainsong, or `None` for the generic rule.
fn calibrated_memory_budget(model_label: &str, sample_count: usize) -> Option<(&'static str, u64)> {
    moonshine_memory_budget(model_label, sample_count)
        .map(|bytes| (MOONSHINE_STREAM_MEDIUM_MODEL_ID, bytes))
        .or_else(|| parakeet_gguf_memory_budget(model_label, sample_count))
}

fn run_native(
    model_path: &Path,
    backend: BackendChoice,
    pcm: &[f32],
    audio_seconds: f64,
    abandoned: &Arc<AtomicBool>,
) -> Result<NativeRun> {
    run_native_with_deadline(model_path, backend, pcm, audio_seconds, abandoned, None)
}

fn retain_runtime_after_admission<T, A>(cache: &mut Option<T>, admission: Result<A>) -> Result<A> {
    admission.inspect_err(|error| {
        if crate::llm::local_model_load::is_headroom_refusal(&format!("{error:#}")) {
            *cache = None;
        }
    })
}

/// The pinned GGUF at `model_path`, verified for this session and opened
/// for transcribe.cpp. It opens the file several times by path, so it gets
/// the inode path (`/.vol/...`), never the shared-offset `/dev/fd`.
fn open_verified_native_model(model_path: &Path) -> Result<crate::download::VerifiedModelArtifact> {
    let file_name = model_path.file_name().and_then(|name| name.to_str());
    let spec = MODEL_SPECS
        .iter()
        .find(|spec| Some(spec.file_name) == file_name)
        .ok_or_else(|| anyhow::anyhow!(MISSING_SPEECH_MODEL))?;
    crate::download::open_verified_model_artifact(model_path, spec.sha256).map_err(|error| {
        tracing::warn!("transcribe.cpp model check failed: {error:#}");
        if crate::download::is_integrity_mismatch(&error) {
            anyhow::anyhow!(MISSING_SPEECH_MODEL)
        } else {
            error
        }
    })
}

fn run_native_with_deadline(
    model_path: &Path,
    backend: BackendChoice,
    pcm: &[f32],
    audio_seconds: f64,
    abandoned: &Arc<AtomicBool>,
    outer_deadline: Option<Instant>,
) -> Result<NativeRun> {
    let model_label = model_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let now = Instant::now();
    let budget = decode_budget_for_audio(audio_seconds).min(
        outer_deadline
            .map(|deadline| deadline.saturating_duration_since(now))
            .unwrap_or(Duration::MAX),
    );
    let deadline = now + budget;

    let _speech_route = if model_label == spec_for(PARAKEET_GGUF_MODEL_ID).file_name {
        let guard = super::neural_engine::acquire_route(abandoned, deadline)
            .map_err(|stop| runtime_wait_error(stop, &model_label, budget))?;
        super::neural_engine::stop_helper();
        if let Some(root) = model_path.parent().and_then(Path::parent) {
            super::parakeet::clear_cached_model_runtime(root, "parakeet-tdt-0.6b-v3");
            super::parakeet::clear_cached_model_runtime(root, "parakeet-tdt-0.6b-v2");
        }
        Some(guard)
    } else {
        None
    };

    let calibrated = calibrated_memory_budget(&model_label, pcm.len());
    let key = runtime_key(model_path, backend);
    let mut cache = acquire_runtime(abandoned, deadline, &model_label, budget)?;

    if cache
        .as_ref()
        .map(|runtime| runtime.key != key)
        .unwrap_or(false)
    {
        *cache = None;
    }

    if cache.is_none() {
        let _model_load = if let Some((model_id, _)) = calibrated {
            crate::llm::local_model_load::admit_asr(
                &[model_path],
                AsrProviderType::TranscribeCpp,
                model_id,
                crate::llm::local_model_load::NativeAllocation::Constructor,
            )?
        } else {
            crate::llm::local_model_load::guard(&[model_path])?
        };
        let started = std::time::Instant::now();
        let verified = open_verified_native_model(model_path)?;
        let verified_ms = started.elapsed().as_millis() as u64;
        let (model, session) = verified.load(|path| {
            let model = Model::load_with(
                path,
                &ModelOptions {
                    backend: backend.to_backend(),
                    device: None,
                },
            )
            .map_err(|error| anyhow::anyhow!(describe_transcribe_error(&model_label, &error)))?;
            let session = model.session().map_err(|error| {
                anyhow::anyhow!(describe_transcribe_error(&model_label, &error))
            })?;
            Ok((model, session))
        })?;
        let load_ms = started.elapsed().as_millis() as u64;
        tracing::info!(
            "transcribe.cpp waited {verified_ms} ms for the integrity check of {model_label}"
        );
        let max_timestamp_kind = model.capabilities().max_timestamp_kind;
        tracing::info!(
            "transcribe.cpp loaded {} on {} in {} ms (max timestamps: {:?})",
            model_path.display(),
            backend.label(),
            load_ms,
            max_timestamp_kind
        );
        *cache = Some(CachedRuntime {
            key,
            _model: model,
            session,
            load_ms,
            max_timestamp_kind,
        });
    }

    let working = if let Some((model_id, host_bytes)) = calibrated {
        crate::llm::local_model_load::admit_asr(
            &[model_path],
            AsrProviderType::TranscribeCpp,
            model_id,
            crate::llm::local_model_load::NativeAllocation::Inference { host_bytes },
        )
    } else {
        crate::llm::local_model_load::working_buffers(&[model_path])
    };
    let _working = retain_runtime_after_admission(&mut cache, working)?;
    let runtime = cache
        .as_mut()
        .ok_or_else(|| anyhow::anyhow!("transcribe.cpp runtime disappeared after loading"))?;

    let options = RunOptions {
        language: batch_language_for_model(&model_label, &runtime._model.capabilities().languages)?,
        // Segment granularity is what the dictation and meeting contracts
        // consume, clamped to what this family can actually produce: a request
        // finer than the model's `max_timestamp_kind` is rejected outright.
        timestamps: timestamp_request_for(runtime.max_timestamp_kind),
        ..RunOptions::default()
    };

    // Install the abort callback, start the watchdog, decode. The watchdog owns
    // the only clone that fires; the token is cleared before the guard is
    // released so the next decode installs its own.
    let token = CancelToken::new();
    runtime.session.set_cancel_token(&token);
    let watchdog = DecodeWatchdog::spawn(token, Arc::clone(abandoned), deadline);
    let outcome = if model_label == spec_for(MOONSHINE_STREAM_MEDIUM_MODEL_ID).file_name {
        run_saved_moonshine_stream(&mut runtime.session, pcm, &options)
    } else {
        runtime.session.run(pcm, &options)
    };
    runtime.session.clear_cancel_token();
    let stop = watchdog.finish();

    let transcript =
        completed_native_transcript(outcome, stop, &model_label, budget, audio_seconds)?;

    let measured_word_timestamps = has_complete_native_word_alignment(&transcript);
    mark_runtime_used();
    Ok(NativeRun {
        text: transcript.text.clone(),
        raw_segments: native_timed_rows(&transcript),
        token_probabilities: transcript.tokens.iter().map(|token| token.p).collect(),
        timestamp_kind: transcript.timestamp_kind,
        measured_word_timestamps,
        load_ms: runtime.load_ms,
        language: transcript.language.clone(),
    })
}

fn run_saved_moonshine_stream(
    session: &mut Session,
    pcm: &[f32],
    options: &RunOptions,
) -> transcribe_cpp::Result<transcribe_cpp::Transcript> {
    let stream_options = StreamOptions {
        family: Some(StreamExtension::MoonshineStreaming(
            MoonshineStreamingOptions {
                // Saved audio only needs the final decode. Keep incremental encoder
                // feeds small without repeatedly decoding partial hypotheses.
                min_decode_interval_ms: Some(i32::MAX),
            },
        )),
        ..StreamOptions::default()
    };
    let transcript = {
        let mut stream = session.stream(options, &stream_options)?;
        for samples in pcm.chunks(16_000) {
            stream.feed(samples)?;
        }
        stream.finalize()?;
        stream.snapshot()
    };
    // The pinned native streaming finalize can return OK at its generation
    // budget. Snapshot before Stream::drop resets the result, then read the
    // retained truncation flag so incomplete text never becomes a success.
    completed_moonshine_stream(transcript, session.was_truncated())
}

fn completed_moonshine_stream(
    transcript: transcribe_cpp::Transcript,
    truncated: bool,
) -> transcribe_cpp::Result<transcribe_cpp::Transcript> {
    if truncated {
        Err(transcribe_cpp::Error::OutputTruncated {
            message: "stream finalize reached the generation budget".into(),
            partial: Some(Box::new(transcript)),
        })
    } else {
        Ok(transcript)
    }
}

fn completed_native_transcript(
    outcome: transcribe_cpp::Result<transcribe_cpp::Transcript>,
    stop: Option<DecodeStop>,
    model_label: &str,
    budget: Duration,
    audio_seconds: f64,
) -> Result<transcribe_cpp::Transcript> {
    outcome.map_err(|error| match stop {
        // The watchdog, not the model, ended this one. Upstream calls
        // it `Aborted` either way, so say which of ours it was.
        Some(DecodeStop::DeadlineExceeded) => anyhow::anyhow!(
            "transcribe.cpp did not finish '{model_label}' within its {:.0} s budget for {audio_seconds:.1} s of audio, so the decode was stopped. Use a shorter clip or another route.",
            budget.as_secs_f64()
        ),
        _ => anyhow::anyhow!(describe_transcribe_error(model_label, &error)),
    })
}

// Long Unified recordings use the fixed contextual windows qualified on the
// frozen public meetings. Other models and short captures keep their path.
fn uses_bounded_unified(model_id: &str, samples: usize) -> bool {
    model_id == PARAKEET_UNIFIED_EN_GGUF_MODEL_ID && samples > 60 * 16_000
}

fn run_bounded_unified(
    model_path: &Path,
    backend: BackendChoice,
    pcm: &[f32],
    abandoned: &Arc<AtomicBool>,
) -> Result<NativeRun> {
    let duration = pcm.len() as f64 / 16_000.0;
    let deadline = Instant::now() + decode_budget_for_audio(duration);
    let windows = windowing::plan(pcm.len());
    let count = windows.len();
    let mut decoded = Vec::with_capacity(count);
    let mut probabilities = Vec::new();
    let mut language = None;
    let mut load_ms = 0;
    for window in windows {
        check_decode_control(abandoned, deadline).map_err(|stop| {
            anyhow::anyhow!("Bounded Unified transcription stopped before completion: {stop:?}")
        })?;
        let samples = &pcm[window.decode_start..window.decode_end];
        let run = run_native_with_deadline(
            model_path,
            backend,
            samples,
            samples.len() as f64 / 16_000.0,
            abandoned,
            Some(deadline),
        )?;
        if !run.text.trim().is_empty() && !run.measured_word_timestamps {
            anyhow::bail!("Bounded Unified transcription requires complete measured word timestamps; no partial transcript was saved.");
        }
        if decoded.is_empty() {
            load_ms = run.load_ms;
            language = run.language;
        }
        probabilities.extend(run.token_probabilities);
        decoded.push((window, run.raw_segments));
    }
    check_decode_control(abandoned, deadline).map_err(|stop| {
        anyhow::anyhow!("Bounded Unified transcription stopped before completion: {stop:?}")
    })?;
    let merged = windowing::merge(decoded, pcm.len())?;
    check_decode_control(abandoned, deadline).map_err(|stop| {
        anyhow::anyhow!("Bounded Unified transcription stopped before completion: {stop:?}")
    })?;
    tracing::info!(
        windows = count,
        removed_duplicates = merged.removed_duplicates,
        unresolved_boundaries = merged.unresolved_count,
        "Completed bounded Unified transcription"
    );
    Ok(NativeRun {
        measured_word_timestamps: !merged.words.is_empty(),
        text: merged.text,
        raw_segments: merged.words,
        token_probabilities: probabilities,
        timestamp_kind: TimestampKind::Word,
        load_ms,
        language,
    })
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

pub struct TranscribeCppProvider {
    model_dir: PathBuf,
    model_id: String,
}

impl TranscribeCppProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        let models_root = crate::paths::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Plainsong")
            .join("models");
        Self::with_models_root(&models_root, selected_model_id)
    }

    /// Select a pinned runtime probe without exposing it as an app route.
    pub fn for_benchmark(model_id: &str) -> Result<Self, String> {
        let spec = MODEL_SPECS
            .iter()
            .find(|spec| spec.model_id == model_id.trim())
            .ok_or_else(|| format!("Unknown transcribe.cpp benchmark model: {model_id}"))?;
        let mut provider = Self::new(None);
        provider.model_id = spec.model_id.to_string();
        Ok(provider)
    }
    /// `asr-eval-batch`: compile the installed vocabulary model now, as the
    /// app's background maintenance would once the speech model serves.
    #[doc(hidden)]
    pub fn prepare_vocabulary_model_for_eval(&self) -> Result<(), String> {
        // Model verification can start speech preparation in the background.
        // Wait through that admission refusal without bypassing its ownership.
        super::neural_engine::prepare_until_settled(
            || {
                super::neural_engine::prepare_blocking(
                    &self.models_root(),
                    &super::neural_engine::PARAKEET_CTC_VOCABULARY,
                )
            },
            Duration::from_secs(1),
            Duration::from_secs(90),
            std::thread::sleep,
        )
        .map_err(|error| error.to_string())
    }

    /// The same provider rooted at an arbitrary models directory, so the
    /// integrity rules can be exercised against real files in a temp dir
    /// instead of the user's data directory.
    pub(crate) fn with_models_root(models_root: &Path, selected_model_id: Option<&str>) -> Self {
        let spec = route_spec_for(selected_model_id.unwrap_or(PARAKEET_GGUF_MODEL_ID));
        Self {
            model_dir: models_root.join(TRANSCRIBE_CPP_MODEL_DIR),
            model_id: spec.model_id.to_string(),
        }
    }

    fn spec(&self) -> &'static TranscribeCppModelSpec {
        spec_for(&self.model_id)
    }

    fn model_path(&self) -> PathBuf {
        self.model_dir.join(self.spec().file_name)
    }

    fn has_required_file(&self) -> bool {
        let model_present = std::fs::metadata(self.model_path())
            .map(|metadata| metadata.is_file() && metadata.len() > 0)
            .unwrap_or(false);
        model_present
            && auxiliary_specs_for(&self.model_id).iter().all(|aux| {
                std::fs::metadata(self.model_dir.join(aux.local_file_name))
                    .map(|metadata| metadata.is_file() && metadata.len() > 0)
                    .unwrap_or(false)
            })
    }

    fn has_trusted_required_file(&self) -> bool {
        crate::download::is_model_artifact_installed(&self.model_path(), Some(self.spec().sha256))
            && auxiliary_specs_for(&self.model_id).iter().all(|aux| {
                crate::download::is_model_artifact_installed(
                    &self.model_dir.join(aux.local_file_name),
                    Some(aux.sha256),
                )
            })
    }

    fn models_root(&self) -> PathBuf {
        self.model_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.model_dir.clone())
    }

    /// The GGUF (and its auxiliary files) is here and not found wrong.
    fn ggml_ready(&self) -> bool {
        self.has_required_file() && self.has_trusted_required_file()
    }

    fn is_parakeet(&self) -> bool {
        self.model_id == PARAKEET_GGUF_MODEL_ID
    }

    /// The Neural Engine model serving this route now, if any. Only Parakeet
    /// TDT 0.6B v3 has one; every other GGUF route runs on ggml as before.
    fn neural_engine_spec(&self) -> Option<&'static super::neural_engine::ModelSpec> {
        if self.model_id != PARAKEET_GGUF_MODEL_ID {
            return None;
        }
        super::neural_engine::route_spec(&self.models_root())
    }

    /// Decode on the Neural Engine. `Err(Engine)` means the caller falls back
    /// to ggml; `Err(Admission)` is returned as the ggml route would return it.
    async fn transcribe_on_neural_engine(
        &self,
        spec: &'static super::neural_engine::ModelSpec,
        audio_path: &Path,
        vocabulary: &[super::AcousticVocabularyTerm],
    ) -> std::result::Result<TranscriptionResult, super::neural_engine::NeuralError> {
        use super::neural_engine::{self, NeuralError};
        let start = std::time::Instant::now();
        let duration = Self::wav_duration_seconds(audio_path);
        let samples = crate::audio::utils::load_audio_file(audio_path)
            .context("Failed to load audio for the speech model")
            .map_err(NeuralError::Admission)?;
        let silent = samples.iter().all(|sample| *sample == 0.0);
        let models_root = self.models_root();
        // Same wait as the ggml route: bounded by the audio's decode budget,
        // and over as soon as the caller drops this future.
        let abandoned = Arc::new(AtomicBool::new(false));
        let _cancel_guard = CancelOnDrop(Arc::clone(&abandoned));
        let route_deadline = std::time::Instant::now() + decode_budget_for_audio(duration);
        let transcript = if silent {
            neural_engine::NeuralTranscript {
                text: String::new(),
                words: Vec::new(),
                processing_ms: 0,
                load_ms: None,
                vocabulary_candidates: Vec::new(),
            }
        } else {
            let vocabulary = vocabulary.to_vec();
            tokio::task::spawn_blocking(move || {
                neural_engine::transcribe_blocking(
                    &models_root,
                    spec,
                    &samples,
                    &vocabulary,
                    &abandoned,
                    route_deadline,
                )
            })
            .await
            .map_err(|error| {
                neural_engine::engine(format!("the decode task panicked: {error}"))
            })??
        };
        let measured = neural_engine::words_align_with_text(&transcript.words, &transcript.text);
        let raw: Vec<RawSegment> = transcript
            .words
            .iter()
            .map(|word| RawSegment {
                start_ms: word.start_ms,
                end_ms: word.end_ms,
                text: word.text.clone(),
            })
            .collect();
        // Same placeholder as the ggml route, which reports no token
        // probabilities for Parakeet: stored quality scores stay comparable
        // whichever runtime decoded the audio.
        let confidence = UNSCORED_TRANSDUCER_CONFIDENCE;
        let segments = build_segments(&raw, &transcript.text, duration, confidence);
        tracing::info!(
            "Parakeet on the {}: model={}, load={:?}ms, decode={}ms, {} chars in {}ms",
            match neural_engine::compute_units() {
                neural_engine::ComputeUnits::CpuOnly => "CPU (Core ML)",
                neural_engine::ComputeUnits::CpuAndNeuralEngine => "Neural Engine",
            },
            spec.model_id,
            transcript.load_ms,
            transcript.processing_ms,
            transcript.text.len(),
            start.elapsed().as_millis()
        );
        let language = match spec.family {
            neural_engine::Family::English => "en".to_string(),
            neural_engine::Family::Multilingual => {
                fallback_result_language(self.spec()).to_string()
            }
        };
        // "neural_engine" on most Macs, "coreml_cpu" on the Light tier, where
        // the same Core ML build decodes on the CPU. Diagnostics and the
        // footprint gate's receipts tell the two apart.
        let engine_name = neural_engine::speech_engine_name().to_string();
        Ok(TranscriptionResult {
            text: transcript.text,
            segments,
            measured_word_timestamps: measured,
            speaker_turns: Vec::new(),
            language,
            confidence,
            processing_time_ms: start.elapsed().as_millis() as u64,
            // The model that decoded, which for English is v2, not the v3
            // file the route is named after.
            model_name: spec.display_name.to_string(),
            model_id: spec.model_id.to_string(),
            requested_provider: AsrProviderType::TranscribeCpp,
            actual_provider: AsrProviderType::TranscribeCpp,
            requested_engine: Some(engine_name.clone()),
            actual_engine: Some(engine_name),
            optimization_applied: false,
            fallback_reason: None,
            vocabulary_hint_terms_applied: 0,
            vocabulary_candidates: transcript.vocabulary_candidates,
        })
    }

    fn wav_duration_seconds(path: &Path) -> f64 {
        match hound::WavReader::open(path) {
            Ok(reader) => {
                let spec = reader.spec();
                if spec.sample_rate == 0 {
                    0.0
                } else {
                    reader.duration() as f64 / spec.sample_rate as f64
                }
            }
            Err(_) => 0.0,
        }
    }
}

impl Default for TranscribeCppProvider {
    fn default() -> Self {
        Self::new(None)
    }
}

#[async_trait]
impl AsrProvider for TranscribeCppProvider {
    fn name(&self) -> &str {
        "transcribe.cpp"
    }

    fn description(&self) -> &str {
        if self.model_id == QWEN3_ASR_06_GGUF_MODEL_ID {
            return "Experimental Qwen3-ASR 0.6B Q6_K for short English dictation. Longer recordings can repeat text and omit speech. No measured timestamps or meeting support.";
        }
        if self.model_id == NEMOTRON_STREAMING_GGUF_MODEL_ID {
            return "Experimental English final dictation with Nemotron 3.5 through transcribe.cpp. Shares verified weights with live preview; meetings and other batch languages remain unqualified.";
        }
        if self.model_id == FLUID_SPEECH_MINI_GGUF_MODEL_ID {
            return "English only. Fewer stray words when someone else talks nearby in our synthetic audio tests; can miss very short replies.";
        }
        if self.model_id == UNDERDOG_BARK_PRO_GGUF_MODEL_ID {
            return "English only. Did better on short distant-microphone meeting clips in our tests; dictation may lose capitals and punctuation.";
        }
        if self.model_id == PARAKEET_GGUF_MODEL_ID {
            return "Parakeet TDT 0.6B v3 in GGUF through transcribe.cpp on Metal: the recommended dictation engine on Apple Silicon. Same weights as the ONNX Parakeet route, a different engine. It decodes one recording at a time.";
        }
        "Experimental model through transcribe.cpp's ggml runtime on Metal."
    }

    /// Readiness reads no bytes, and agrees with the diagnostics in
    /// `asr/manager.rs`: a file is ready when it is present and this session
    /// has not hashed it and found it wrong. `has_required_file` alone only
    /// proves something non-empty is at the path. The load hashes the file
    /// against its pin.
    ///
    /// Parakeet is also ready on the Core ML build alone, where this Mac runs
    /// it: a Download there fetches no ggml file. A build not compiled yet
    /// counts, because the first request compiles it. Readiness only reads
    /// the Neural Engine route's state, so it cannot start a compile.
    fn is_available(&self) -> bool {
        self.ggml_ready()
            || (self.is_parakeet()
                && super::neural_engine::serves_without_ggml(
                    &self.models_root(),
                    super::neural_engine::preferred_family(),
                ))
    }

    fn model_info(&self) -> ModelInfo {
        let spec = self.spec();
        let (version, parameters) = if spec.model_id == QWEN3_ASR_17_GGUF_MODEL_ID {
            ("q8_0", "1.7B")
        } else if spec.model_id == QWEN3_ASR_06_GGUF_MODEL_ID {
            ("q6_k", "0.6B")
        } else if spec.model_id == MOONSHINE_STREAM_MEDIUM_MODEL_ID {
            ("q8_0", "245M")
        } else if spec.model_id == ORUKEET_R3_GGUF_MODEL_ID {
            ("r3-q8_0", "600M")
        } else {
            ("q8_0", "600M")
        };
        ModelInfo {
            name: spec.display_name.to_string(),
            version: version.to_string(),
            size_mb: spec.size_mib(),
            parameters: parameters.to_string(),
            languages: spec.languages.iter().map(|code| code.to_string()).collect(),
            // No WER or RTF is claimed here. Upstream publishes both, but they
            // were not measured in Plainsong, and this struct is rendered to
            // users as if it were.
            word_error_rate: None,
            real_time_factor: None,
            license: spec.license.to_string(),
            source_url: spec.upstream_url.to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        self.transcribe_for_family(audio_path, super::neural_engine::preferred_family(), &[])
            .await
    }

    async fn transcribe_path_with_options(
        &self,
        audio_path: &Path,
        options: &super::TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        self.transcribe_for_family(
            audio_path,
            super::neural_engine::family_for_language(options.language.as_deref()),
            &options.acoustic_vocabulary,
        )
        .await
    }

    async fn transcribe_bytes_with_options(
        &self,
        audio_data: &[u8],
        options: &super::TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        let path =
            std::env::temp_dir().join(format!("transcribe_cpp_{}.wav", uuid::Uuid::new_v4()));
        let temp = crate::recording_audio::write_secure_temporary_audio(&path, audio_data)?;
        self.transcribe_path_with_options(temp.path(), options)
            .await
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path =
            std::env::temp_dir().join(format!("transcribe_cpp_{}.wav", uuid::Uuid::new_v4()));
        let temp = crate::recording_audio::write_secure_temporary_audio(&temp_path, audio_data)
            .context("failed to write temp wav for transcribe.cpp")?;
        self.transcribe(temp.path()).await
    }

    async fn prewarm(&self) -> Result<()> {
        if self.is_parakeet()
            && super::neural_engine::first_use_compile_pending(
                &self.models_root(),
                super::neural_engine::preferred_family(),
                self.ggml_ready(),
            )
        {
            // A prewarm would be the ~10 s first-use compile at a warm load's
            // memory allowance; the background compile does it instead.
            super::neural_engine::schedule_prepare_if_needed(
                &self.models_root(),
                super::neural_engine::preferred_family(),
            );
            return Ok(());
        }
        if let Some(spec) = self.neural_engine_spec() {
            let models_root = self.models_root();
            let result = tokio::task::spawn_blocking(move || {
                super::neural_engine::prewarm(&models_root, spec)
            })
            .await
            .context("Speech model prewarm task panicked")?;
            match result {
                Ok(()) => return Ok(()),
                Err(super::neural_engine::NeuralError::Admission(error)) => return Err(error),
                Err(super::neural_engine::NeuralError::Engine(failure)) => {
                    super::neural_engine::record_failure(&failure);
                }
            }
        }
        self.prewarm_on_ggml().await
    }

    fn download_status(&self) -> DownloadStatus {
        // A Parakeet download on a Mac that runs the Core ML build fetches
        // that build alone (`download_models`), so either copy is the
        // download. Under the ggml override only the ggml file counts.
        if self.has_required_file()
            || (self.is_parakeet()
                && super::neural_engine::coreml_files_present(
                    &self.models_root(),
                    super::neural_engine::preferred_family(),
                ))
        {
            DownloadStatus::Downloaded
        } else {
            DownloadStatus::NotDownloaded
        }
    }

    async fn download_models(&self, progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()> {
        let progress_cb: Arc<dyn Fn(f32) + Send + Sync> = Arc::from(progress_cb);
        // Parakeet on a Mac that can run it fetches the Neural Engine build and,
        // where dictation can be English, the vocabulary model, in place of
        // the ggml file, so the size the app showed is what leaves the
        // network (`parakeet_download_bytes`). The ggml file comes later only
        // if this Mac needs it (`neural_engine::fetch_ggml_if_needed`).
        let neural = if self.is_parakeet() {
            super::neural_engine::spec_to_download()
        } else {
            None
        };
        let Some(spec) = neural else {
            self.download_ggml(Arc::clone(&progress_cb)).await?;
            progress_cb(100.0);
            return Ok(());
        };
        let vocabulary = super::neural_engine::vocabulary_spec_to_download();
        let shares = DownloadShares::new(
            spec.total_bytes(),
            vocabulary.map_or(0, |spec| spec.total_bytes()),
        );
        let neural_progress = Arc::clone(&progress_cb);
        super::neural_engine::download_and_prepare(
            &self.models_root(),
            spec,
            Arc::new(move |p| neural_progress(shares.neural(p))),
        )
        .await
        .with_context(|| format!("Failed to download {}", spec.model_id))?;
        if vocabulary.is_some() {
            let vocabulary_progress = Arc::clone(&progress_cb);
            let result = super::neural_engine::download_vocabulary_files(
                &self.models_root(),
                Arc::new(move |p| vocabulary_progress(shares.vocabulary(p))),
            )
            .await;
            // Dictation never waits on it; maintenance fetches it again later.
            if let Err(error) = result {
                tracing::info!("Fetching the vocabulary model failed: {error:#}");
            }
        }
        progress_cb(100.0);
        Ok(())
    }
}

impl TranscribeCppProvider {
    async fn transcribe_for_family(
        &self,
        audio_path: &Path,
        family: super::neural_engine::Family,
        vocabulary: &[super::AcousticVocabularyTerm],
    ) -> Result<TranscriptionResult> {
        let parakeet = self.is_parakeet();
        let models_root = self.models_root();
        let ggml_ready = self.ggml_ready();
        let mut neural_failure = None;
        if let Some(spec) = if parakeet {
            super::neural_engine::request_spec_for_family(&models_root, family, ggml_ready)
        } else {
            None
        } {
            match self
                .transcribe_on_neural_engine(spec, audio_path, vocabulary)
                .await
            {
                Ok(result) => return Ok(result),
                Err(super::neural_engine::NeuralError::Admission(error)) => return Err(error),
                Err(super::neural_engine::NeuralError::Engine(failure)) => {
                    if super::neural_engine::runtime_override()
                        == super::neural_engine::RuntimeOverride::NeuralEngine
                    {
                        anyhow::bail!("The Neural Engine route failed: {failure}");
                    }
                    super::neural_engine::record_failure(&failure);
                    neural_failure = Some(failure);
                }
            }
        }
        if parakeet
            && super::neural_engine::runtime_override()
                == super::neural_engine::RuntimeOverride::NeuralEngine
        {
            anyhow::bail!("The requested speech runtime is not prepared and verified for this Mac");
        }
        if parakeet && !ggml_ready {
            // Nothing else can serve: the Core ML build failed or cannot run
            // here, or this language's build is still to come. The audio is
            // kept by the caller (failed dictations go to History).
            if let Some(download) = super::neural_engine::fetch_ggml_if_needed(&models_root, family)
            {
                if let Some(failure) = &neural_failure {
                    tracing::info!("Parakeet has no other copy to serve this request: {failure}");
                }
                anyhow::bail!(needed_download_message(download));
            }
        }
        if parakeet && crate::hardware_tier::current() == crate::hardware_tier::HardwareTier::Light
        {
            tracing::warn!(
                actual_engine = %format!("transcribe_cpp_{}", backend_choice_from_env().label()),
                dictation_budget_bytes = crate::hardware_tier::HardwareTier::Light.budget().dictation_bytes,
                "Core ML speech is unavailable; GGUF fallback may exceed the Light dictation footprint budget and requires its own native constructor and inference admission"
            );
        }
        let result = self.transcribe_on_ggml(audio_path).await?;
        if parakeet && neural_failure.is_none() {
            // A verified model not compiled for this macOS build yet starts
            // compiling now, in the background, after the user's request.
            super::neural_engine::schedule_prepare_if_needed(&models_root, family);
        }
        Ok(same_model_fallback_result(result, neural_failure.as_ref()))
    }
}

/// What a dictation that Parakeet could not transcribe says while the
/// download it needs runs, or after that download failed. It reaches the
/// dictation HUD, so it is plain copy.
pub(crate) const NEEDED_DOWNLOAD_RUNNING: &str =
    "Parakeet is downloading a file it needs on this Mac. Dictation will be ready when it finishes; see Settings > Models.";
pub(crate) const NEEDED_DOWNLOAD_FAILED: &str =
    "Parakeet couldn't download a file it needs on this Mac. Check your connection; Plainsong will try again.";

fn needed_download_message(download: super::neural_engine::NeededDownload) -> &'static str {
    match download {
        super::neural_engine::NeededDownload::Running => NEEDED_DOWNLOAD_RUNNING,
        super::neural_engine::NeededDownload::Failed => NEEDED_DOWNLOAD_FAILED,
    }
}

/// The ggml route served a request the Neural Engine route could not, with
/// the same model. That is a complete, normal result: no fallback notice in
/// the dictation view, no incomplete meeting transcript. Why the other
/// runtime failed is for logs and diagnostics (`neural_engine::status`).
fn same_model_fallback_result(
    mut result: TranscriptionResult,
    neural_failure: Option<&super::neural_engine::EngineFailure>,
) -> TranscriptionResult {
    if let Some(failure) = neural_failure {
        result.requested_engine = Some(super::neural_engine::speech_engine_name().to_string());
        tracing::warn!(
            "Parakeet served this request on the ggml route after the Neural Engine route failed: {failure}"
        );
    }
    result
}

impl TranscribeCppProvider {
    async fn transcribe_on_ggml(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        // The model id and file stay in logs and Settings diagnostics; the
        // error reaches the dictation HUD, so it uses plain copy.
        if !self.has_required_file() {
            tracing::warn!(
                "transcribe.cpp weights for '{}' are not downloaded",
                self.model_id
            );
            return Err(anyhow::anyhow!(MISSING_SPEECH_MODEL));
        }
        if !self.has_trusted_required_file() {
            tracing::warn!(
                "transcribe.cpp weights for '{}' failed their integrity check",
                self.model_id
            );
            return Err(anyhow::anyhow!(MISSING_SPEECH_MODEL));
        }

        let start = std::time::Instant::now();
        let duration = Self::wav_duration_seconds(audio_path);
        let samples = crate::audio::utils::load_audio_file(audio_path)
            .context("Failed to load audio for transcribe.cpp")?;
        let model_path = self.model_path();
        let backend = backend_choice_from_env();

        // Dropping this future (the sidecar aborts a request's task when the
        // caller gives up) flips the flag; the watchdog cancels the native run
        // at its next decode step and the runtime is free for the next request.
        let abandoned = Arc::new(AtomicBool::new(false));
        let _cancel_guard = CancelOnDrop(Arc::clone(&abandoned));
        let bounded = uses_bounded_unified(&self.model_id, samples.len());
        let run = tokio::task::spawn_blocking(move || {
            if samples.iter().all(|sample| *sample == 0.0) {
                Ok(NativeRun {
                    text: String::new(),
                    raw_segments: Vec::new(),
                    token_probabilities: Vec::new(),
                    timestamp_kind: TimestampKind::None,
                    measured_word_timestamps: false,
                    load_ms: 0,
                    language: None,
                })
            } else if bounded {
                run_bounded_unified(&model_path, backend, &samples, &abandoned)
            } else {
                run_native(&model_path, backend, &samples, duration, &abandoned)
            }
        })
        .await
        .context("transcribe.cpp inference task panicked")??;

        let confidence = token_confidence(&run.token_probabilities);
        let segments = build_segments_for_timestamp_kind(
            &run.raw_segments,
            &run.text,
            duration,
            confidence,
            run.timestamp_kind,
        );
        let text = run.text.trim().to_string();

        tracing::info!(
            "transcribe.cpp transcription complete: model={}, backend={}, load={}ms, {} chars in {}ms",
            self.model_id,
            backend.label(),
            run.load_ms,
            text.len(),
            start.elapsed().as_millis()
        );

        Ok(TranscriptionResult {
            text,
            segments,
            measured_word_timestamps: run.measured_word_timestamps,
            // Parakeet through this runtime returns text and timings, never
            // speaker attribution. Empty is the only honest value: a meeting
            // on this route gets Plainsong's own diarizer, and
            // `resolve_meeting_diarizer` reads this to know that.
            speaker_turns: Vec::new(),
            language: run
                .language
                .filter(|language| !language.trim().is_empty())
                .unwrap_or_else(|| fallback_result_language(self.spec()).to_string()),
            confidence,
            processing_time_ms: start.elapsed().as_millis() as u64,
            model_name: self.spec().display_name.to_string(),
            model_id: self.model_id.clone(),
            requested_provider: AsrProviderType::TranscribeCpp,
            actual_provider: AsrProviderType::TranscribeCpp,
            requested_engine: Some(format!("transcribe_cpp_{}", backend.label())),
            actual_engine: Some(format!("transcribe_cpp_{}", backend.label())),
            optimization_applied: false,
            fallback_reason: None,
            // Parakeet has no prompt or keyterm field, so the dictionary never
            // reaches the recognizer on this route. Claiming otherwise is the
            // exact failure the field exists to prevent.
            vocabulary_hint_terms_applied: 0,
            vocabulary_candidates: Vec::new(),
        })
    }

    async fn prewarm_on_ggml(&self) -> Result<()> {
        if !self.has_trusted_required_file() {
            return Err(anyhow::anyhow!(
                "The transcribe.cpp weights for '{}' are not downloaded and verified yet.",
                self.model_id
            ));
        }
        let model_path = self.model_path();
        let backend = backend_choice_from_env();
        // 20 ms of silence: enough to force the model load and one decode
        // through the real path, short enough that a prewarm is not a
        // transcription.
        let silence = vec![0.0f32; 320];
        let abandoned = Arc::new(AtomicBool::new(false));
        let _cancel_guard = CancelOnDrop(Arc::clone(&abandoned));
        tokio::task::spawn_blocking(move || {
            run_native(&model_path, backend, &silence, 0.02, &abandoned)
        })
        .await
        .context("transcribe.cpp prewarm task panicked")??;
        mark_runtime_used();
        Ok(())
    }

    async fn download_ggml(&self, progress_cb: Arc<dyn Fn(f32) + Send + Sync>) -> Result<()> {
        use crate::download::DownloadManager;

        std::fs::create_dir_all(&self.model_dir)
            .context("Failed to create transcribe.cpp model directory")?;

        let spec = self.spec();
        let manager = DownloadManager::new()?;
        let destination = self.model_path();
        let model_progress = Arc::clone(&progress_cb);
        manager
            .download_verified_model_asset(
                &spec.url(),
                &destination,
                Some(spec.sha256),
                spec.max_bytes(),
                move |p| {
                    model_progress(p.percentage as f32 * 0.99);
                },
            )
            .await?;

        for aux in auxiliary_specs_for(spec.model_id) {
            let url = aux.url();
            let destination = self.model_dir.join(aux.local_file_name);
            let aux_progress = Arc::clone(&progress_cb);
            manager
                .download_verified_model_asset(
                    &url,
                    &destination,
                    Some(aux.sha256),
                    aux.size_bytes + 1024,
                    move |_| aux_progress(99.5),
                )
                .await?;
        }
        progress_cb(100.0);

        // A new file under an old cache entry would otherwise keep serving the
        // previous weights for the life of the process.
        clear_cached_runtime();
        tracing::info!("transcribe.cpp model '{}' downloaded", spec.model_id);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Streaming session (live dictation preview)
// ---------------------------------------------------------------------------

/// The language codes the pinned Nemotron GGUF declares in its own model-card
/// metadata at the revision this app downloads.
///
/// Three different counts are in circulation for this model and it matters
/// which one the gate uses. NVIDIA advertises **40 language-locales**; the GGUF
/// port's card says **32** are supported ("the model's tokenizer recognizes 40,
/// but 8 are adaptation-ready and need fine-tuning"); and the file's own
/// `language:` metadata — the only one that is pinned with the bytes — lists
/// the **28** codes below. The gate uses the 28, because that is the list the
/// artifact on disk actually claims, and being wrong here means showing a live
/// preview in a language the recognizer will garble.
pub(crate) const NEMOTRON_STREAMING_LANGUAGES: &[&str] = &[
    "en", "es", "fr", "it", "pt", "nl", "de", "tr", "ru", "ar", "hi", "ja", "ko", "vi", "uk", "pl",
    "sv", "cs", "nb", "da", "bg", "fi", "hr", "sk", "zh", "hu", "ro", "et",
];

/// The cache-aware right-context that produces `chunk_ms` of look-ahead.
///
/// The encoder advances 80 ms per frame, so `att_context_right` of 0, 3, 6 and
/// 13 are 80, 320, 560 and 1120 ms — the four operating points the GGUF port
/// exposes. An unrecognised size falls back to the default rather than pinning
/// a value the model was not trained on.
pub(crate) fn att_context_right_for_chunk_ms(chunk_ms: u32) -> i32 {
    match chunk_ms {
        80 => 0,
        320 => 3,
        560 => 6,
        1120 => 13,
        _ => att_context_right_for_chunk_ms(DEFAULT_STREAMING_CHUNK_MS),
    }
}

/// How long a single `feed`/`finalize`/`reset` may take before the session is
/// declared dead.
///
/// A live preview that has stopped answering must not hold the dictation stop
/// path open waiting for it. Generous next to a measured per-chunk decode
/// (tens of milliseconds) so ordinary contention never trips it.
const STREAM_CALL_TIMEOUT: Duration = Duration::from_secs(10);

/// What [`TranscribeCppStreamingSession::open`] should do with the live-preview
/// thread after waiting for it to report that its model is loaded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkerDisposition {
    /// The worker answered, or hung up: it is on its way out, so joining it is
    /// bounded and reclaims the thread.
    Join,
    /// It never answered. It may still be inside the native load, so joining
    /// would block the caller for exactly as long as that does.
    Detach,
}

/// Wait for the worker's "ready", with a ceiling, and say what to do with the
/// thread afterwards.
///
/// Split out from `open` so the join-versus-detach decision is testable with a
/// plain channel and no model on disk.
fn await_worker_ready(
    ready_rx: &std::sync::mpsc::Receiver<Result<u64>>,
    timeout: Duration,
    model_label: &str,
) -> (WorkerDisposition, Result<u64>) {
    match ready_rx.recv_timeout(timeout) {
        Ok(Ok(load_ms)) => (WorkerDisposition::Join, Ok(load_ms)),
        Ok(Err(error)) => (WorkerDisposition::Join, Err(error)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => (
            WorkerDisposition::Detach,
            Err(anyhow::anyhow!(
                "The live-preview engine did not load '{model_label}' within {} s.",
                timeout.as_secs()
            )),
        ),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => (
            WorkerDisposition::Join,
            Err(anyhow::anyhow!(
                "The live-preview engine stopped before it could load '{model_label}'."
            )),
        ),
    }
}

/// What one `feed`/`finalize` produced, moved back over the channel.
struct StreamOutcome {
    stable: String,
    volatile: String,
}

enum StreamCommand {
    Feed(Vec<f32>),
    Finalize,
    Reset,
}

/// Opens Nemotron streaming sessions for the dictation live preview.
///
/// Separate from [`TranscribeCppProvider`] on purpose: that one is a route the
/// user can select and it transcribes what gets inserted. This one is never a
/// preview session, and its partials cannot reach inserted text. Final batch
/// dictation can select the same pinned weights independently.
pub struct TranscribeCppStreamingProvider {
    model_dir: PathBuf,
    chunk_ms: u32,
}

impl TranscribeCppStreamingProvider {
    pub fn new() -> Self {
        Self::with_chunk_ms(DEFAULT_STREAMING_CHUNK_MS)
    }

    /// The same provider at a named chunk size. `benchmark-latency --stream`
    /// uses it to measure every entry of `STREAMING_CHUNK_MS_CHOICES`.
    pub fn with_chunk_ms(chunk_ms: u32) -> Self {
        let models_root = crate::paths::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Plainsong")
            .join("models");
        Self::with_models_root(&models_root, chunk_ms)
    }

    pub(crate) fn with_models_root(models_root: &Path, chunk_ms: u32) -> Self {
        Self {
            model_dir: models_root.join(TRANSCRIBE_CPP_MODEL_DIR),
            chunk_ms: if STREAMING_CHUNK_MS_CHOICES.contains(&chunk_ms) {
                chunk_ms
            } else {
                DEFAULT_STREAMING_CHUNK_MS
            },
        }
    }

    pub(crate) fn spec() -> &'static TranscribeCppModelSpec {
        spec_for(NEMOTRON_STREAMING_GGUF_MODEL_ID)
    }

    pub fn model_path(&self) -> PathBuf {
        self.model_dir.join(Self::spec().file_name)
    }

    /// Provision this preview's pinned weights without route normalization.
    pub(crate) fn download_provider(&self) -> TranscribeCppProvider {
        TranscribeCppProvider {
            model_dir: self.model_dir.clone(),
            model_id: Self::spec().model_id.to_string(),
        }
    }

    pub fn chunk_ms(&self) -> u32 {
        self.chunk_ms
    }
}

impl Default for TranscribeCppStreamingProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamingAsrProvider for TranscribeCppStreamingProvider {
    fn streaming_engine_name(&self) -> &str {
        "Nemotron 3.5 ASR Streaming via transcribe.cpp"
    }

    fn streaming_model_id(&self) -> &str {
        NEMOTRON_STREAMING_GGUF_MODEL_ID
    }

    /// Present and not found wrong this session, the same rule the batch
    /// route follows. A half-written GGUF is not a live preview, it is a
    /// crash; the load hashes it first.
    fn is_streaming_available(&self) -> bool {
        let path = self.model_path();
        std::fs::metadata(&path)
            .map(|metadata| metadata.is_file() && metadata.len() > 0)
            .unwrap_or(false)
            && crate::download::is_model_artifact_installed(&path, Some(Self::spec().sha256))
    }

    fn supports_language(&self, language: Option<&str>) -> bool {
        let Some(language) = language else {
            // No language selected means "let the recognizer decide", and this
            // model has language detection. Nothing to refuse.
            return true;
        };
        let normalized = language.trim().to_ascii_lowercase();
        if normalized.is_empty() || normalized == "auto" {
            return true;
        }
        // Accept both `en` and locale forms like `en-US` / `en_US`.
        let base = normalized
            .split(['-', '_'])
            .next()
            .unwrap_or(normalized.as_str());
        NEMOTRON_STREAMING_LANGUAGES.contains(&base)
    }

    fn open_session(&self, language_hint: Option<&str>) -> Result<Box<dyn StreamingAsrSession>> {
        let session = TranscribeCppStreamingSession::open(
            &self.model_path(),
            backend_choice_from_env(),
            language_hint,
            self.chunk_ms,
        )?;
        Ok(Box::new(session))
    }
}

/// One live Nemotron stream, driven from a dedicated OS thread.
///
/// The binding's `Stream<'a>` borrows its `Session` mutably for the stream's
/// whole life, so a struct owning both would be self-referential. Rather than
/// reach for a raw pointer, the model, session and stream all live on one
/// thread and this handle talks to it over a channel. Two things fall out for
/// free: the native calls never touch a tokio worker, and closing the session
/// *joins* that thread — so when `stop_dictation_for_sidecar` closes the
/// preview, the GPU is provably released before the batch decode asks for it.
///
/// The model is loaded per session and dropped when the session closes.
/// Caching it would save the ~0.5 s load on every dictation after the first, at
/// the cost of holding roughly a gigabyte resident for the rest of the app's
/// life; a preview is not worth that, and the load happens while the user is
/// still drawing breath.
pub struct TranscribeCppStreamingSession {
    commands: Option<std::sync::mpsc::Sender<StreamCommand>>,
    replies: std::sync::mpsc::Receiver<Result<StreamOutcome>>,
    worker: Option<std::thread::JoinHandle<()>>,
    chunk_samples: usize,
    fed_samples: u64,
    /// False once a call timed out or the worker died: the thread may still be
    /// inside a native call, so it is detached rather than joined.
    healthy: bool,
    load_ms: u64,
}

impl TranscribeCppStreamingSession {
    /// Milliseconds spent loading the model when this session opened. The
    /// receipt reports it; nothing in the app reads it.
    pub fn load_ms(&self) -> u64 {
        self.load_ms
    }

    fn open(
        model_path: &Path,
        backend: BackendChoice,
        language_hint: Option<&str>,
        chunk_ms: u32,
    ) -> Result<Self> {
        let model_label = model_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let owned_path = model_path.to_path_buf();
        let language = language_hint
            .map(str::trim)
            .filter(|hint| !hint.is_empty() && !hint.eq_ignore_ascii_case("auto"))
            .map(str::to_string);
        let att_context_right = att_context_right_for_chunk_ms(chunk_ms);

        let (command_tx, command_rx) = std::sync::mpsc::channel::<StreamCommand>();
        let (reply_tx, reply_rx) = std::sync::mpsc::channel::<Result<StreamOutcome>>();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u64>>();

        let worker_label = model_label.clone();
        let worker = std::thread::Builder::new()
            .name("plainsong-live-preview".to_string())
            .spawn(move || {
                stream_worker(
                    owned_path,
                    backend,
                    language,
                    att_context_right,
                    worker_label,
                    ready_tx,
                    command_rx,
                    reply_tx,
                );
            })
            .context("Failed to start the live-preview thread")?;

        // Bounded, and detaching on timeout, exactly like `call()` below. A
        // `Model::load_with` that never returns used to park this wait
        // forever: the caller sat on a blocking-pool thread, the preview never
        // opened and never failed, and every later dictation stop paid the
        // close timeout in full.
        let load_ms = match await_worker_ready(&ready_rx, STREAM_CALL_TIMEOUT, &model_label) {
            // Loaded: the worker stays, because it is the session.
            (_, Ok(load_ms)) => load_ms,
            (WorkerDisposition::Join, Err(error)) => {
                // It answered with a failure, or hung up: either way it is on
                // its way out, so joining is bounded and reclaims the thread.
                let _ = worker.join();
                return Err(error);
            }
            (WorkerDisposition::Detach, Err(error)) => {
                // Still inside the native load: joining would block whoever
                // asked for the preview for as long as that does.
                tracing::warn!(
                    "Left the live-preview thread detached: '{}' did not load within {} s",
                    model_label,
                    STREAM_CALL_TIMEOUT.as_secs()
                );
                drop(worker);
                return Err(error);
            }
        };

        Ok(Self {
            commands: Some(command_tx),
            replies: reply_rx,
            worker: Some(worker),
            chunk_samples: streaming_chunk_samples(chunk_ms),
            fed_samples: 0,
            healthy: true,
            load_ms,
        })
    }

    /// Send one command and wait for its reply, marking the session dead if the
    /// worker does not answer.
    fn call(&mut self, command: StreamCommand) -> Result<StreamOutcome> {
        if !self.healthy {
            anyhow::bail!("The live-preview session is no longer running.");
        }
        let Some(commands) = self.commands.as_ref() else {
            anyhow::bail!("The live-preview session is closed.");
        };
        if commands.send(command).is_err() {
            self.healthy = false;
            anyhow::bail!("The live-preview engine stopped.");
        }
        match self.replies.recv_timeout(STREAM_CALL_TIMEOUT) {
            Ok(Ok(outcome)) => Ok(outcome),
            Ok(Err(error)) => Err(error),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                self.healthy = false;
                anyhow::bail!(
                    "The live-preview engine did not answer within {} s.",
                    STREAM_CALL_TIMEOUT.as_secs()
                )
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                self.healthy = false;
                anyhow::bail!("The live-preview engine stopped.")
            }
        }
    }

    fn partial_from(&self, outcome: StreamOutcome) -> Partial {
        Partial {
            stable_prefix: outcome.stable,
            volatile_suffix: outcome.volatile,
            elapsed_audio_s: self.fed_samples as f64 / f64::from(STREAMING_SAMPLE_RATE_HZ),
        }
    }

    /// Shut the worker down. Joins only when the session is still healthy: a
    /// thread that is wedged inside a native call would otherwise block the
    /// dictation stop path forever.
    pub fn close(&mut self) {
        self.commands = None;
        if let Some(worker) = self.worker.take() {
            if self.healthy {
                let _ = worker.join();
            } else {
                tracing::warn!(
                    "Left the live-preview thread detached: it stopped answering, so joining it \
                     would block the dictation stop path"
                );
            }
        }
    }
}

impl Drop for TranscribeCppStreamingSession {
    fn drop(&mut self) {
        self.close();
    }
}

impl StreamingAsrSession for TranscribeCppStreamingSession {
    fn feed(&mut self, pcm16k: &[f32]) -> Result<Partial> {
        self.fed_samples = self.fed_samples.saturating_add(pcm16k.len() as u64);
        let outcome = self.call(StreamCommand::Feed(pcm16k.to_vec()))?;
        Ok(self.partial_from(outcome))
    }

    fn finalize(&mut self) -> Result<Partial> {
        let outcome = self.call(StreamCommand::Finalize)?;
        Ok(self.partial_from(outcome))
    }

    fn reset(&mut self) -> Result<()> {
        self.call(StreamCommand::Reset)?;
        self.fed_samples = 0;
        Ok(())
    }

    fn chunk_samples(&self) -> usize {
        self.chunk_samples
    }
}

/// The body of the live-preview thread: load once, then serve commands until
/// the handle drops.
fn batch_language_for_model(model_file: &str, supported: &[String]) -> Result<Option<String>> {
    if model_file != spec_for(NEMOTRON_STREAMING_GGUF_MODEL_ID).file_name {
        return Ok(None);
    }
    // Final dictation currently offers this model for English only. The
    // native prompt gate requires the artifact's exact locale, not bare en.
    supported
        .iter()
        .find(|language| {
            language
                .split('-')
                .next()
                .is_some_and(|base| base.eq_ignore_ascii_case("en"))
        })
        .cloned()
        .map(Some)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "The Nemotron final-dictation model does not advertise an English locale"
            )
        })
}

fn streaming_language_for_model(
    hint: Option<&str>,
    supported: &[String],
) -> Result<Option<String>> {
    let Some(hint) = hint.map(str::trim).filter(|hint| !hint.is_empty()) else {
        return Ok(None);
    };
    if hint.eq_ignore_ascii_case("auto") {
        return Ok(None);
    }
    let normalized = hint.replace('_', "-");
    let exact = supported
        .iter()
        .find(|language| language.eq_ignore_ascii_case(&normalized));
    let base = normalized.split('-').next().unwrap_or(&normalized);
    let selected = exact.or_else(|| {
        supported.iter().find(|language| {
            language
                .split('-')
                .next()
                .unwrap_or(language)
                .eq_ignore_ascii_case(base)
        })
    });
    selected.cloned().map(Some).ok_or_else(|| {
        anyhow::anyhow!("The streaming preview model does not support the selected language")
    })
}

#[allow(clippy::too_many_arguments)]
fn stream_worker(
    model_path: PathBuf,
    backend: BackendChoice,
    language: Option<String>,
    att_context_right: i32,
    model_label: String,
    ready_tx: std::sync::mpsc::Sender<Result<u64>>,
    command_rx: std::sync::mpsc::Receiver<StreamCommand>,
    reply_tx: std::sync::mpsc::Sender<Result<StreamOutcome>>,
) {
    let model_load = match crate::llm::local_model_load::guard(&[&model_path]) {
        Ok(permit) => permit,
        Err(error) => {
            let _ = ready_tx.send(Err(error));
            return;
        }
    };
    let started = Instant::now();
    let loaded = open_verified_native_model(&model_path).and_then(|verified| {
        verified.load(|path| {
            Model::load_with(
                path,
                &ModelOptions {
                    backend: backend.to_backend(),
                    device: None,
                },
            )
            .map_err(|error| anyhow::anyhow!(describe_transcribe_error(&model_label, &error)))
        })
    });
    let model = match loaded {
        Ok(model) => model,
        Err(error) => {
            let _ = ready_tx.send(Err(error));
            return;
        }
    };
    if !model.capabilities().supports_streaming {
        let _ = ready_tx.send(Err(anyhow::anyhow!(
            "'{model_label}' is not a streaming model, so it cannot drive the live preview."
        )));
        return;
    }
    // The model advertises locale tags, while Plainsong also uses base codes.
    // Native validation rejects `en` even when the prompt dictionary has it.
    let language =
        match streaming_language_for_model(language.as_deref(), &model.capabilities().languages) {
            Ok(language) => language,
            Err(error) => {
                let _ = ready_tx.send(Err(error));
                return;
            }
        };
    let mut session = match model.session() {
        Ok(session) => session,
        Err(error) => {
            let _ = ready_tx.send(Err(anyhow::anyhow!(describe_transcribe_error(
                &model_label,
                &error
            ))));
            return;
        }
    };
    drop(model_load);
    let _working = match crate::llm::local_model_load::working_buffers(&[&model_path]) {
        Ok(reservation) => reservation,
        Err(error) => {
            let _ = ready_tx.send(Err(error));
            return;
        }
    };
    let load_ms = started.elapsed().as_millis() as u64;
    tracing::info!(
        "Live preview loaded {} on {} in {} ms",
        model_path.display(),
        backend.label(),
        load_ms
    );
    if ready_tx.send(Ok(load_ms)).is_err() {
        return;
    }

    let run_options = RunOptions {
        // Text only: the preview renders words, and asking for alignment makes
        // the family materialize rows nobody reads.
        timestamps: TimestampKind::None,
        language,
        ..RunOptions::default()
    };
    // Cache-aware right context matched to the chunk size the caller feeds.
    // If the family rejects the extension the stream is begun without it
    // rather than failing the preview outright — the model's own default
    // operating point still streams.
    let with_extension = StreamOptions {
        commit_policy: CommitPolicy::Auto,
        stable_prefix_agreement_n: 0,
        family: Some(StreamExtension::ParakeetStream(ParakeetStreamOptions {
            att_context_right: Some(att_context_right),
        })),
    };
    let without_extension = StreamOptions {
        commit_policy: CommitPolicy::Auto,
        ..StreamOptions::default()
    };
    // Probed once, before any audio: begin a stream with the extension and
    // abandon it. Deciding per utterance would mean a failed `begin` inside the
    // reset path, where there is no caller left to tell.
    let stream_options = match session.stream(&run_options, &with_extension) {
        Ok(mut probe) => {
            probe.reset();
            with_extension
        }
        Err(error) => {
            tracing::debug!(
                "Live preview could not set the cache-aware right context ({}); \
                 falling back to the model's default streaming point",
                error
            );
            without_extension
        }
    };

    'session: loop {
        let mut stream = match session.stream(&run_options, &stream_options) {
            Ok(stream) => stream,
            Err(error) => {
                let _ = reply_tx.send(Err(anyhow::anyhow!(describe_transcribe_error(
                    &model_label,
                    &error
                ))));
                return;
            }
        };

        loop {
            let Ok(command) = command_rx.recv() else {
                // The handle dropped: abandon the stream and let the model go.
                return;
            };
            match command {
                StreamCommand::Feed(pcm) => {
                    let outcome = stream
                        .feed(&pcm)
                        .map_err(|error| {
                            anyhow::anyhow!(describe_transcribe_error(&model_label, &error))
                        })
                        .map(|_| {
                            let text = stream.text();
                            StreamOutcome {
                                stable: text.committed,
                                volatile: text.tentative,
                            }
                        });
                    if reply_tx.send(outcome).is_err() {
                        return;
                    }
                }
                StreamCommand::Finalize => {
                    let outcome = stream
                        .finalize()
                        .map_err(|error| {
                            anyhow::anyhow!(describe_transcribe_error(&model_label, &error))
                        })
                        .map(|_| {
                            let text = stream.text();
                            StreamOutcome {
                                stable: text.committed,
                                volatile: text.tentative,
                            }
                        });
                    if reply_tx.send(outcome).is_err() {
                        return;
                    }
                }
                StreamCommand::Reset => {
                    stream.reset();
                    if reply_tx
                        .send(Ok(StreamOutcome {
                            stable: String::new(),
                            volatile: String::new(),
                        }))
                        .is_err()
                    {
                        return;
                    }
                    continue 'session;
                }
            }
        }
    }
}

/// Word end times from a batch decode of the *same* weights, in seconds.
///
/// Only the streaming receipt uses this: "partial latency" is measured from the
/// moment a word finishes being spoken to the moment a partial containing it
/// arrives, and something has to say when each word finished. Taking it from
/// the same model that is being streamed keeps the two sides comparable — a
/// different recognizer's alignment would fold its own segmentation into the
/// number. Nothing in the app calls this.
pub fn streaming_reference_words(model_path: &Path, pcm: &[f32]) -> Result<Vec<(String, f64)>> {
    let model_label = model_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let _model_load = crate::llm::local_model_load::guard(&[model_path])?;
    let model = open_verified_native_model(model_path)?.load(|path| {
        Model::load_with(
            path,
            &ModelOptions {
                backend: backend_choice_from_env().to_backend(),
                device: None,
            },
        )
        .map_err(|error| anyhow::anyhow!(describe_transcribe_error(&model_label, &error)))
    })?;
    let mut session = model
        .session()
        .map_err(|error| anyhow::anyhow!(describe_transcribe_error(&model_label, &error)))?;
    let transcript = session
        .run(
            pcm,
            &RunOptions {
                timestamps: TimestampKind::Word,
                ..RunOptions::default()
            },
        )
        .map_err(|error| anyhow::anyhow!(describe_transcribe_error(&model_label, &error)))?;
    Ok(transcript
        .words
        .iter()
        .map(|word| (word.text.clone(), word.t1_ms as f64 / 1000.0))
        .collect())
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_speech_idle_timer_releases_only_parakeet() {
        let models = Path::new("/models/transcribe_cpp");
        let parakeet = models.join(spec_for(PARAKEET_GGUF_MODEL_ID).file_name);
        assert!(runtime_follows_speech_idle_timer(&runtime_key(
            &parakeet,
            BackendChoice::Auto
        )));
        for other in [
            MOONSHINE_STREAM_MEDIUM_MODEL_ID,
            FLUID_SPEECH_MINI_GGUF_MODEL_ID,
            UNDERDOG_BARK_PRO_GGUF_MODEL_ID,
            QWEN3_ASR_06_GGUF_MODEL_ID,
        ] {
            let path = models.join(spec_for(other).file_name);
            assert!(
                !runtime_follows_speech_idle_timer(&runtime_key(&path, BackendChoice::Auto)),
                "{other} follows the dictation keep-warm switch, not the speech idle timer"
            );
        }
    }

    fn sample_ggml_result() -> TranscriptionResult {
        TranscriptionResult {
            text: "Ship it on Friday, not Monday.".to_string(),
            segments: Vec::new(),
            measured_word_timestamps: true,
            speaker_turns: Vec::new(),
            language: "en".to_string(),
            confidence: 0.9,
            processing_time_ms: 120,
            model_name: spec_for(PARAKEET_GGUF_MODEL_ID).display_name.to_string(),
            model_id: PARAKEET_GGUF_MODEL_ID.to_string(),
            requested_provider: AsrProviderType::TranscribeCpp,
            actual_provider: AsrProviderType::TranscribeCpp,
            requested_engine: Some("transcribe_cpp_metal".to_string()),
            actual_engine: Some("transcribe_cpp_metal".to_string()),
            optimization_applied: false,
            fallback_reason: None,
            vocabulary_hint_terms_applied: 0,
            vocabulary_candidates: Vec::new(),
        }
    }

    #[test]
    fn a_same_model_runtime_fallback_is_a_normal_complete_result() {
        let failure = super::super::neural_engine::EngineFailure {
            reason: "the speech helper did not answer within 240s".to_string(),
            refused: false,
            identity_changed: false,
        };
        let result = same_model_fallback_result(sample_ggml_result(), Some(&failure));
        // A fallback reason is what marks a dictation as a fallback and a
        // meeting transcript as incomplete; the requested engine differing
        // from the actual one is what diagnostics read as a route change.
        assert_eq!(result.fallback_reason, None);
        assert_eq!(
            result.requested_engine.as_deref(),
            Some(super::super::neural_engine::speech_engine_name())
        );
        assert_eq!(
            result.actual_engine.as_deref(),
            Some("transcribe_cpp_metal")
        );
        assert_eq!(result.text, "Ship it on Friday, not Monday.");
    }

    #[tokio::test]
    async fn neural_engine_results_name_the_model_that_decoded() {
        let root =
            std::env::temp_dir().join(format!("transcribe-cpp-identity-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let silence_path = root.join("silence.wav");
        let mut silence = hound::WavWriter::create(
            &silence_path,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for _ in 0..1_600 {
            silence.write_sample(0i16).unwrap();
        }
        silence.finalize().unwrap();
        let provider = TranscribeCppProvider::with_models_root(&root, Some(PARAKEET_GGUF_MODEL_ID));
        for spec in super::super::neural_engine::MODEL_SPECS {
            // Silence never reaches the helper, so this needs no model.
            let result = provider
                .transcribe_on_neural_engine(spec, &silence_path, &[])
                .await
                .unwrap();
            assert_eq!(result.model_id, spec.model_id);
            assert_eq!(result.model_name, spec.display_name);
            assert!(!result.model_name.contains("GGUF"));
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn parakeet_is_not_ready_without_the_file_every_fallback_runs_on() {
        let root =
            std::env::temp_dir().join(format!("transcribe-cpp-ready-{}", uuid::Uuid::new_v4()));
        let provider = TranscribeCppProvider::with_models_root(&root, Some(PARAKEET_GGUF_MODEL_ID));
        assert!(!provider.is_available());
        assert_eq!(provider.download_status(), DownloadStatus::NotDownloaded);
    }

    fn install_coreml_placeholder(root: &Path, spec: &super::super::neural_engine::ModelSpec) {
        let dir = spec.dir(root);
        for file in spec.files {
            let path = dir.join(file.path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"x").unwrap();
        }
    }

    #[test]
    fn parakeet_is_installed_and_ready_on_its_core_ml_build_alone() {
        use super::super::neural_engine;
        let root =
            std::env::temp_dir().join(format!("transcribe-cpp-coreml-{}", uuid::Uuid::new_v4()));
        install_coreml_placeholder(&root, &neural_engine::PARAKEET_V3_COREML);
        let provider = TranscribeCppProvider::with_models_root(&root, Some(PARAKEET_GGUF_MODEL_ID));
        assert!(!provider.ggml_ready());
        assert!(!parakeet_ggml_ready(&root));
        // Where this Mac runs the build, it is the download, and the first
        // request compiles it; elsewhere only the ggml file counts.
        let supported = neural_engine::route_supported();
        assert_eq!(
            provider.download_status() == DownloadStatus::Downloaded,
            supported
        );
        assert_eq!(
            provider.is_available(),
            neural_engine::serves_without_ggml(&root, neural_engine::preferred_family())
        );
        assert_eq!(parakeet_route_ready(&root), provider.is_available());
        if provider.is_available() {
            // The request loads the Core ML files, not a missing GGUF.
            let artifacts = route_model_artifacts(&root, PARAKEET_GGUF_MODEL_ID);
            assert!(artifacts
                .iter()
                .all(|(path, _)| path.starts_with(root.join(neural_engine::MODEL_DIR))));
        }
        // Another transcribe.cpp model is never ready on Parakeet's build.
        let other =
            TranscribeCppProvider::with_models_root(&root, Some(NEMOTRON_STREAMING_GGUF_MODEL_ID));
        assert!(!other.is_available());
        assert_eq!(other.download_status(), DownloadStatus::NotDownloaded);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn parakeet_with_no_copy_that_can_serve_says_what_it_is_waiting_for() {
        use super::super::neural_engine;
        let root =
            std::env::temp_dir().join(format!("transcribe-cpp-needed-{}", uuid::Uuid::new_v4()));
        install_coreml_placeholder(&root, &neural_engine::PARAKEET_V3_COREML);
        // A compile this macOS build refused: only the ggml file could serve.
        neural_engine::mark_refused_for_test(&root, &neural_engine::PARAKEET_V3_COREML);
        assert!(neural_engine::request_spec_for_family(
            &root,
            neural_engine::Family::Multilingual,
            false
        )
        .is_none());
        let wav = root.join("speech.wav");
        let mut writer = hound::WavWriter::create(
            &wav,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for i in 0..1_600 {
            writer
                .write_sample(((i as f32 * 0.05).sin() * 3_000.0) as i16)
                .unwrap();
        }
        writer.finalize().unwrap();
        let provider = TranscribeCppProvider::with_models_root(&root, Some(PARAKEET_GGUF_MODEL_ID));
        let options = super::super::TranscriptionOptions {
            language: Some("fr".to_string()),
            ..Default::default()
        };
        // Not the "model missing" error: the download it needs has started
        // (in a unit test it is reported, never spawned).
        let error = provider
            .transcribe_path_with_options(&wav, &options)
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(error, NEEDED_DOWNLOAD_RUNNING);
        assert!(!error.to_lowercase().contains("gguf"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn a_meeting_on_the_core_ml_build_alone_decodes_there_and_leaves_speakers_to_the_diarizer(
    ) {
        use super::super::neural_engine;
        let root =
            std::env::temp_dir().join(format!("transcribe-cpp-meeting-{}", uuid::Uuid::new_v4()));
        install_coreml_placeholder(&root, &neural_engine::PARAKEET_V3_COREML);
        // Silence decodes without starting the helper, on whichever route the
        // request picked.
        let wav = root.join("meeting.wav");
        let mut writer = hound::WavWriter::create(
            &wav,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for _ in 0..16_000 {
            writer.write_sample(0i16).unwrap();
        }
        writer.finalize().unwrap();
        let provider = TranscribeCppProvider::with_models_root(&root, Some(PARAKEET_GGUF_MODEL_ID));
        let options = super::super::TranscriptionOptions {
            language: Some("de".to_string()),
            ..Default::default()
        };
        let result = provider.transcribe_path_with_options(&wav, &options).await;
        if neural_engine::serves_without_ggml(&root, neural_engine::Family::Multilingual) {
            let result = result.expect("the Core ML build serves the meeting");
            assert_eq!(
                result.actual_engine.as_deref(),
                Some(neural_engine::speech_engine_name())
            );
            assert_eq!(result.model_id, neural_engine::PARAKEET_V3_COREML.model_id);
            // No speaker attribution from the model: the meeting's own
            // diarizer runs, as on the ggml route.
            assert!(result.speaker_turns.is_empty());
            assert!(provider.is_available());
        } else {
            // A Mac that cannot run it: the ggml file it needs is what the
            // meeting waits for, never "model missing".
            assert_eq!(result.unwrap_err().to_string(), NEEDED_DOWNLOAD_RUNNING);
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn needed_download_messages_are_plain_words() {
        let jargon =
            regex::Regex::new(r"(?i)neural engine|core ?ml|ggml|gguf|onnx|\bane\b").unwrap();
        for message in [NEEDED_DOWNLOAD_RUNNING, NEEDED_DOWNLOAD_FAILED] {
            assert!(!jargon.is_match(message), "{message}");
        }
        assert!(NEEDED_DOWNLOAD_FAILED.contains("connection"));
    }

    #[test]
    fn busy_admission_keeps_the_resident_runtime_for_the_next_decode() {
        let mut cache = Some(Box::new(42));
        let resident = cache.as_deref().unwrap() as *const i32;
        let busy: Result<()> = Err(anyhow::anyhow!(
            crate::llm::native_runtime_gate::OPERATION_BUSY
        ));
        assert!(retain_runtime_after_admission(&mut cache, busy).is_err());
        retain_runtime_after_admission(&mut cache, Ok(())).unwrap();
        assert_eq!(cache.as_deref().unwrap() as *const i32, resident);
        assert_eq!(**cache.as_ref().unwrap(), 42);
        let refused: Result<()> = Err(anyhow::anyhow!("Not enough verified memory headroom for native inference working buffers alongside other applications."));
        assert!(retain_runtime_after_admission(&mut cache, refused).is_err());
        assert!(cache.is_none());
    }

    #[test]
    fn multilingual_parakeet_gguf_does_not_claim_english_when_nothing_was_detected() {
        assert_eq!(
            fallback_result_language(spec_for(PARAKEET_GGUF_MODEL_ID)),
            ""
        );
        assert!(spec_for(PARAKEET_GGUF_MODEL_ID).languages.len() > 1);
        for english_only in [
            NEMOTRON_STREAMING_GGUF_MODEL_ID,
            MOONSHINE_STREAM_MEDIUM_MODEL_ID,
            QWEN3_ASR_06_GGUF_MODEL_ID,
            PARAKEET_UNIFIED_EN_GGUF_MODEL_ID,
            FLUID_SPEECH_MINI_GGUF_MODEL_ID,
            UNDERDOG_BARK_PRO_GGUF_MODEL_ID,
        ] {
            assert_eq!(fallback_result_language(spec_for(english_only)), "en");
        }
    }

    #[test]
    fn parakeet_gguf_memory_budget_uses_exact_pcm_boundaries_and_pin() {
        const LONG: u64 = 1536 * 1024 * 1024;
        for model_id in PARAKEET_GGUF_SHAPED_MODEL_IDS {
            let pin = spec_for(model_id).file_name;
            let at = |samples| parakeet_gguf_memory_budget(pin, samples);
            assert_eq!(at(320), Some((*model_id, 0)));
            assert_eq!(at(30 * 16_000), Some((*model_id, 0)));
            assert_eq!(at(30 * 16_000 + 1), Some((*model_id, LONG)));
            assert_eq!(at(600 * 16_000), Some((*model_id, LONG)));
            assert_eq!(at(600 * 16_000 + 1), None);
        }
        // Same weights under another name, or another Parakeet-family GGUF,
        // were not measured and keep the generic rule.
        assert_eq!(
            parakeet_gguf_memory_budget("parakeet-tdt-0.6b-v3-q8_0.gguf", 16_000),
            None
        );
        for other in [ORUKEET_R3_GGUF_MODEL_ID, PARAKEET_UNIFIED_EN_GGUF_MODEL_ID] {
            assert_eq!(
                parakeet_gguf_memory_budget(spec_for(other).file_name, 16_000),
                None
            );
        }
    }

    #[test]
    fn parakeet_shaped_optional_models_match_the_default_size() {
        // The shared allowance rests on the same architecture at the same
        // size; a re-pin that changed either must be measured again.
        let default = spec_for(PARAKEET_GGUF_MODEL_ID);
        for model_id in [
            FLUID_SPEECH_MINI_GGUF_MODEL_ID,
            UNDERDOG_BARK_PRO_GGUF_MODEL_ID,
        ] {
            let spec = spec_for(model_id);
            assert_eq!(spec.model_id, model_id);
            assert!(
                spec.size_bytes.abs_diff(default.size_bytes) <= 64,
                "{model_id}"
            );
        }
    }

    #[test]
    fn calibrated_memory_budget_keys_admission_by_the_measured_route() {
        assert_eq!(
            calibrated_memory_budget(spec_for(PARAKEET_GGUF_MODEL_ID).file_name, 16_000),
            Some((PARAKEET_GGUF_MODEL_ID, 0))
        );
        assert_eq!(
            calibrated_memory_budget(spec_for(MOONSHINE_STREAM_MEDIUM_MODEL_ID).file_name, 16_000),
            Some((MOONSHINE_STREAM_MEDIUM_MODEL_ID, 0))
        );
        assert_eq!(
            calibrated_memory_budget(spec_for(PARAKEET_GGUF_MODEL_ID).file_name, 601 * 16_000),
            None
        );
        assert_eq!(
            calibrated_memory_budget(spec_for(NEMOTRON_STREAMING_GGUF_MODEL_ID).file_name, 16_000),
            None
        );
        for model_id in [
            FLUID_SPEECH_MINI_GGUF_MODEL_ID,
            UNDERDOG_BARK_PRO_GGUF_MODEL_ID,
        ] {
            assert_eq!(
                calibrated_memory_budget(spec_for(model_id).file_name, 16_000),
                Some((model_id, 0))
            );
        }
    }

    #[test]
    fn moonshine_memory_budget_uses_exact_pcm_boundaries_and_pin() {
        let pin = spec_for(MOONSHINE_STREAM_MEDIUM_MODEL_ID).file_name;
        assert_eq!(moonshine_memory_budget(pin, 30 * 16_000), Some(0));
        assert_eq!(
            moonshine_memory_budget(pin, 30 * 16_000 + 1),
            Some(1536 * 1024 * 1024)
        );
        assert_eq!(
            moonshine_memory_budget(pin, 180 * 16_000),
            Some(1536 * 1024 * 1024)
        );
        assert_eq!(moonshine_memory_budget(pin, 180 * 16_000 + 1), None);
        assert_eq!(
            moonshine_memory_budget("moonshine-streaming-medium-q8_0.gguf", 16_000),
            None
        );
        assert_eq!(
            moonshine_memory_budget(spec_for(QWEN3_ASR_06_GGUF_MODEL_ID).file_name, 16_000),
            None
        );
    }

    #[test]
    fn benchmark_cleanup_matches_only_the_measured_model_path() {
        let measured = std::path::Path::new("/models/parakeet.gguf");
        assert!(super::runtime_key_matches_model(
            "/models/parakeet.gguf::metal",
            measured
        ));
        assert!(!super::runtime_key_matches_model(
            "/models/voxtral.gguf::metal",
            measured
        ));
    }

    #[test]
    fn streaming_language_uses_advertised_locale_tags() {
        let languages = ["en-US", "en-GB", "es-US", "es-ES", "fr-FR"].map(str::to_string);
        for hint in ["en", "EN", "en-AU"] {
            assert_eq!(
                super::streaming_language_for_model(Some(hint), &languages).unwrap(),
                Some("en-US".to_string())
            );
        }
        for hint in ["en-GB", "en_GB", " EN-gb "] {
            assert_eq!(
                super::streaming_language_for_model(Some(hint), &languages).unwrap(),
                Some("en-GB".to_string())
            );
        }
        assert_eq!(
            super::streaming_language_for_model(Some("es-ES"), &languages).unwrap(),
            Some("es-ES".to_string())
        );
        for hint in [None, Some(""), Some("auto"), Some("AUTO")] {
            assert_eq!(
                super::streaming_language_for_model(hint, &languages).unwrap(),
                None
            );
        }
        assert!(super::streaming_language_for_model(Some("zz"), &languages).is_err());
    }
    #[test]
    fn preview_download_targets_the_preview_weights() {
        let root = std::path::Path::new("preview-test-models");
        let preview = super::TranscribeCppStreamingProvider::with_models_root(root, 560);
        let download = preview.download_provider();
        assert_eq!(download.model_id, super::NEMOTRON_STREAMING_GGUF_MODEL_ID);
        assert_eq!(download.model_path(), preview.model_path());
        assert_eq!(
            download.spec().sha256,
            super::TranscribeCppStreamingProvider::spec().sha256
        );
    }
    use super::*;

    #[test]
    fn measured_word_rows_preserve_alignment_and_exact_text() {
        let text = "Twenty-five euros.";
        let coarse = ::transcribe_cpp::Segment {
            t0_ms: 0,
            t1_ms: 30000,
            text: text.into(),
            ..Default::default()
        };
        let transcript = ::transcribe_cpp::Transcript {
            text: text.into(),
            timestamp_kind: TimestampKind::Word,
            segments: vec![coarse],
            words: vec![
                ::transcribe_cpp::Word {
                    t0_ms: 29520,
                    t1_ms: 29840,
                    text: "Twenty-five".into(),
                    ..Default::default()
                },
                ::transcribe_cpp::Word {
                    t0_ms: 29920,
                    t1_ms: 30080,
                    text: "euros.".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let rows = native_timed_rows(&transcript);
        assert!(has_complete_native_word_alignment(&transcript));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].start_ms, 29520);
        assert_eq!(rows[1].text, "euros.");
        assert_eq!(
            rows.iter()
                .map(|r| r.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            text
        );
    }

    #[test]
    fn incomplete_or_invalid_word_alignment_keeps_coarse_rows() {
        let coarse = ::transcribe_cpp::Segment {
            t0_ms: 0,
            t1_ms: 1000,
            text: "Keep both words.".into(),
            ..Default::default()
        };
        let mut transcript = ::transcribe_cpp::Transcript {
            text: coarse.text.clone(),
            timestamp_kind: TimestampKind::Word,
            segments: vec![coarse],
            ..Default::default()
        };
        transcript.words = vec![::transcribe_cpp::Word {
            t0_ms: 100,
            t1_ms: 300,
            text: "Keep".into(),
            ..Default::default()
        }];
        assert!(!has_complete_native_word_alignment(&transcript));
        assert_eq!(native_timed_rows(&transcript).len(), 1);
        transcript.words[0].text = transcript.text.clone();
        transcript.words[0].t1_ms = 50;
        assert!(!has_complete_native_word_alignment(&transcript));
        assert_eq!(native_timed_rows(&transcript)[0].start_ms, 0);
        transcript.words[0].t1_ms = 300;
        transcript.timestamp_kind = TimestampKind::None;
        assert!(!has_complete_native_word_alignment(&transcript));
        let rows = native_timed_rows(&transcript);
        assert!(build_segments_for_timestamp_kind(
            &rows,
            &transcript.text,
            1.0,
            0.8,
            TimestampKind::None
        )
        .is_empty());
    }

    /// The bug this guards: the provider used to ask every family for
    /// `Segment` timestamps. Voxtral advertises `max_timestamp_kind == None`,
    /// and `transcribe_run` rejects an over-fine request rather than clamping
    /// it, so a Voxtral decode failed outright with
    /// `TRANSCRIBE_ERR_UNSUPPORTED_TIMESTAMPS` instead of returning its text.
    #[test]
    fn the_timestamp_request_is_clamped_to_what_the_family_can_produce() {
        // Token-capable families also support measured word rows.
        assert_eq!(
            timestamp_request_for(TimestampKind::Token),
            TimestampKind::Word
        );
        assert_eq!(
            timestamp_request_for(TimestampKind::Word),
            TimestampKind::Word
        );
        assert_eq!(
            timestamp_request_for(TimestampKind::Segment),
            TimestampKind::Segment
        );
        // Voxtral (both families), Cohere, Canary, Moonshine: text only.
        assert_eq!(
            timestamp_request_for(TimestampKind::None),
            TimestampKind::None
        );
        // `Auto` is a request, never a reported capability. Treat it as the
        // conservative answer rather than assuming timed rows exist.
        assert_eq!(
            timestamp_request_for(TimestampKind::Auto),
            TimestampKind::None
        );
    }

    /// Every spec the provider can load is uniquely named, pins a full
    /// SHA-256, and pins a 40-character commit rather than a branch. The
    /// download path hashes what it fetches, so a wrong hash is caught at
    /// install time — but a `main` revision would silently change what gets
    /// hashed.
    #[test]
    fn every_model_spec_pins_an_immutable_revision_and_a_full_digest() {
        let mut seen: Vec<&str> = Vec::new();
        for spec in MODEL_SPECS {
            assert!(
                !seen.contains(&spec.model_id),
                "duplicate model id {}",
                spec.model_id
            );
            seen.push(spec.model_id);
            assert_eq!(
                spec.hf_revision.len(),
                40,
                "{} must pin a commit, not a branch",
                spec.model_id
            );
            assert_eq!(spec.sha256.len(), 64, "{} needs a sha256", spec.model_id);
            assert!(
                spec.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "{} sha256 is not hex",
                spec.model_id
            );
            assert!(spec.size_bytes > 0, "{} needs a size", spec.model_id);
            assert!(
                !spec.languages.is_empty(),
                "{} claims no languages",
                spec.model_id
            );
        }
    }

    #[test]
    fn download_progress_splits_by_bytes_and_finishes_only_at_the_end() {
        let close = |left: f32, right: f32| (left - right).abs() < 1e-3;
        let shares = DownloadShares::new(600, 200);
        assert!(close(shares.neural(0.0), 0.0));
        assert!(close(shares.neural(50.0), 37.5));
        assert!(close(shares.neural(100.0), 75.0));
        assert!(close(shares.vocabulary(0.0), 75.0));
        assert!(close(shares.vocabulary(100.0), 99.9));
        let speech_only = DownloadShares::new(600, 0);
        assert!(close(speech_only.neural(100.0), 99.9));
    }

    #[test]
    fn the_parakeet_download_size_is_one_copy_of_the_model() {
        let expected = super::super::neural_engine::coreml_download_bytes().unwrap_or(739_508_576);
        assert_eq!(parakeet_download_bytes(), expected);
        assert_eq!(parakeet_ggml_bytes(), 739_508_576);
        // Never both copies: the Core ML build plus vocabulary stays under
        // the ggml file plus that build.
        assert!(parakeet_download_bytes() < 739_508_576 + 464_413_247);
    }

    #[test]
    fn qwen06_selection_uses_its_own_pinned_artifact_and_metadata() {
        let provider = TranscribeCppProvider::with_models_root(
            Path::new("/models"),
            Some("qwen3-asr-0.6b-q6_k"),
        );
        assert_eq!(provider.model_id, "qwen3-asr-0.6b-q6_k");
        assert_eq!(
            provider.model_path(),
            Path::new("/models/transcribe_cpp/Qwen3-ASR-0.6B-Q6_K.gguf")
        );
        let spec = provider.spec();
        assert_eq!(spec.url(), "https://huggingface.co/handy-computer/Qwen3-ASR-0.6B-gguf/resolve/7e7c69a577fa2725dfedbe34b5e999336e30a19b/Qwen3-ASR-0.6B-Q6_K.gguf");
        assert_eq!(
            spec.sha256,
            "3b051f108f03c0c91bbe1a3b2c1ee15e3ed51e4caec2a48751b01f2a21441cc3"
        );
        assert_eq!(spec.size_bytes, 690_417_824);
        let info = provider.model_info();
        assert_eq!(info.name, "Qwen3-ASR 0.6B (GGUF Q6_K, experimental)");
        assert_eq!(info.parameters, "0.6B");
        assert_eq!(info.version, "q6_k");
        assert_eq!(info.languages, vec!["en"]);
        assert_eq!(info.license, "Apache-2.0");
        assert!(provider.description().contains("0.6B"));
        assert!(route_model_options()
            .iter()
            .any(|option| { option.id == provider.model_id && option.label.contains("0.6B") }));
    }

    #[test]
    fn orukeet_r3_is_a_pinned_english_dictation_route() {
        let spec = spec_for(ORUKEET_R3_GGUF_MODEL_ID);
        assert_eq!(spec.hf_revision, "b59c13a733fce5cf193230d0fa317ee7f145a108");
        assert_eq!(
            spec.sha256,
            "cad2f52ac91cad829279422301989687c2cf02e19157352ed25ea501b90dbb7e"
        );
        assert_eq!(spec.size_bytes, 739_508_608);
        assert_eq!(spec.languages, &["en"]);
        assert!(spec.offered_as_route);
        assert!(route_model_options()
            .iter()
            .any(|option| option.id == ORUKEET_R3_GGUF_MODEL_ID));
        assert_eq!(
            auxiliary_specs_for(ORUKEET_R3_GGUF_MODEL_ID)
                .iter()
                .map(|aux| aux.local_file_name)
                .collect::<Vec<_>>(),
            vec!["orukeet-r3-LICENSE-WEIGHTS", "orukeet-r3-NOTICE.md"]
        );

        let info = TranscribeCppProvider::with_models_root(
            Path::new("/models"),
            Some(ORUKEET_R3_GGUF_MODEL_ID),
        )
        .model_info();
        assert_eq!(info.name, "Orukeet r3 (GGUF Q8_0, experimental)");
        assert_eq!(info.version, "r3-q8_0");
        assert_eq!(info.parameters, "600M");
        assert_eq!(
            info.license,
            "CC-BY-SA-4.0 weights; NVIDIA attribution applies"
        );
    }

    #[test]
    fn unified_en_is_a_pinned_english_batch_route_with_attribution() {
        let spec = spec_for(PARAKEET_UNIFIED_EN_GGUF_MODEL_ID);
        assert_eq!(spec.hf_revision, "7e948f21b7bdbac698d3318db9d350f1096f3b6c");
        assert_eq!(
            spec.sha256,
            "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795"
        );
        assert_eq!(spec.size_bytes, 731_357_568);
        assert_eq!(spec.languages, &["en"]);
        assert_eq!(spec.license, "NVIDIA Open Model License");
        assert!(spec.offered_as_route);
        assert!(route_model_options()
            .iter()
            .any(|option| option.id == PARAKEET_UNIFIED_EN_GGUF_MODEL_ID));

        let attribution = auxiliary_specs_for(PARAKEET_UNIFIED_EN_GGUF_MODEL_ID);
        assert_eq!(attribution.len(), 2);
        assert_eq!(
            attribution[0].local_file_name,
            "parakeet-unified-en-0.6b-NVIDIA-MODEL-CARD.md"
        );
        assert_eq!(
            attribution[0].url(),
            "https://huggingface.co/nvidia/parakeet-unified-en-0.6b/resolve/fe53cd885760c96b6a5f51a0bfd362cb4584a98b/README.md"
        );
        assert_eq!(
            attribution[0].sha256,
            "505590d4440b38ca33ed4d5b8af2a10c2391ecd8740c945bfdf82825e1a05fb3"
        );
        assert_eq!(
            attribution[1].local_file_name,
            "parakeet-unified-en-0.6b-NVIDIA-OPEN-MODEL-LICENSE.pdf"
        );
        assert_eq!(
            attribution[1].url(),
            "https://www.nvidia.com/content/dam/en-zz/Solutions/license-agreements/enterprise-software/nvidia-open-model-license-agreements-24-10-2025.pdf"
        );
        assert_eq!(
            attribution[1].sha256,
            "4d2fb590aa9b30c47f2058bff17291df7fa2aa0c1bd775a20703da9bb267cfab"
        );
        assert_eq!(
            PARAKEET_UNIFIED_EN_ATTRIBUTION_NOTICE,
            "Licensed by NVIDIA Corporation under the NVIDIA Open Model License"
        );

        assert_ne!(
            TranscribeCppStreamingProvider::spec().model_id,
            PARAKEET_UNIFIED_EN_GGUF_MODEL_ID,
            "the Nemotron-only preview must not open Unified with the cache-aware extension"
        );
        assert!(!crate::asr_routing::meeting_route_is_dictation_only(
            AsrProviderType::TranscribeCpp,
            PARAKEET_UNIFIED_EN_GGUF_MODEL_ID,
        ));
    }

    #[test]
    fn optional_english_models_download_from_the_plainsong_release_with_credits() {
        for (model_id, file, sha256, source, revision, credit, description) in [
            (
                FLUID_SPEECH_MINI_GGUF_MODEL_ID,
                "fluid-speech-mini-q8_0.gguf",
                "15dbfb78d8f02d4618447fe25a60dde13f35ad12513842bac41e321ff0fa6219",
                "FluidVoice-Labs/fluid-speech-mini-gguf",
                "490bcd5de891f5efd0e732434dfb0a4b0899aead",
                FLUID_SPEECH_MINI_ATTRIBUTION,
                "English only. Fewer stray words when someone else talks nearby in our synthetic audio tests; can miss very short replies.",
            ),
            (
                UNDERDOG_BARK_PRO_GGUF_MODEL_ID,
                "underdog-bark-3.0-pro-q8_0.gguf",
                "017193232ec9ca53f53800877cacd8f8c468040f4a8d377fc07e1e959808ac6f",
                "ConwayResearch/Underdog-Bark-3.0-Pro",
                "4b5c51e04aa8d16dda9ecdff71bc29f7360149e4",
                UNDERDOG_BARK_PRO_ATTRIBUTION,
                "English only. Did better on short distant-microphone meeting clips in our tests; dictation may lose capitals and punctuation.",
            ),
        ] {
            let spec = spec_for(model_id);
            assert_eq!(spec.model_id, model_id);
            assert_eq!(spec.file_name, file);
            assert!(spec.hosted_by_plainsong);
            assert_eq!(
                spec.url(),
                format!(
                    "https://github.com/JonathanRReed/Plainsong/releases/download/models-2026-10/{file}"
                )
            );
            assert_eq!(spec.sha256, sha256);
            assert_eq!(spec.size_bytes, 739_508_608);
            assert_eq!(spec.hf_repo, source);
            assert_eq!(spec.hf_revision, revision);
            assert_eq!(spec.license, "CC-BY-4.0");
            assert_eq!(spec.languages, &["en"]);
            assert!(spec.offered_as_route);
            assert_eq!(route_spec_for(model_id).model_id, model_id);
            assert!(spec.label.contains("optional, English"), "{}", spec.label);
            assert!(!spec.label.contains("experimental"), "{}", spec.label);

            // The licence text and the credits are part of the download and of
            // readiness, from the same release as the weights.
            let stem = file.trim_end_matches("-q8_0.gguf");
            let aux = auxiliary_specs_for(model_id);
            assert_eq!(
                aux.iter().map(|aux| aux.local_file_name).collect::<Vec<_>>(),
                vec![format!("{stem}-LICENSE.txt"), format!("{stem}-NOTICE.txt")]
            );
            for aux in aux {
                assert_eq!(
                    aux.url(),
                    format!("{PLAINSONG_MODEL_RELEASE_URL}/{}", aux.local_file_name)
                );
                assert_eq!(aux.sha256.len(), 64);
            }
            assert_eq!(
                aux[0].sha256, "9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411",
                "the CC BY 4.0 legal code, byte for byte"
            );

            let provider =
                TranscribeCppProvider::with_models_root(Path::new("/models"), Some(model_id));
            assert_eq!(provider.description(), description);
            let info = provider.model_info();
            assert_eq!(info.name, spec.display_name);
            assert!(info.name.contains(" by "), "{}", info.name);
            assert_eq!(info.languages, vec!["en"]);
            assert_eq!(info.parameters, "600M");
            assert_eq!(fallback_result_language(spec), "en");
            assert!(credit.contains("NVIDIA Parakeet TDT 0.6B v3"), "{credit}");
            assert!(credit.contains("Moondream Parakeet Ultra"), "{credit}");
            assert!(credit.starts_with(spec.display_name.trim_end_matches(" (GGUF Q8_0)")));

            // Both serve dictation and meetings, through the chunked path.
            assert!(!crate::asr_routing::meeting_route_is_dictation_only(
                AsrProviderType::TranscribeCpp,
                model_id,
            ));
            assert!(crate::asr_routing::meeting_model_is_supported(
                AsrProviderType::TranscribeCpp,
                model_id,
            ));
            assert_eq!(
                crate::meeting_transcribe::meeting_transcription_chunk_seconds(
                    AsrProviderType::TranscribeCpp
                ),
                90
            );
            assert!(crate::meeting_transcribe::whole_file_meeting_limits(
                AsrProviderType::TranscribeCpp
            )
            .is_none());
        }
        assert_eq!(
            FLUID_SPEECH_MINI_ATTRIBUTION,
            "Fluid Speech Mini by FluidVoice. Built on NVIDIA Parakeet TDT 0.6B v3 and Moondream Parakeet Ultra."
        );
        assert!(UNDERDOG_BARK_PRO_ATTRIBUTION
            .contains("post-trained and compressed by Conway Research"));
    }

    #[test]
    fn a_timestamp_free_result_never_becomes_a_timed_segment() {
        let raw = [RawSegment {
            start_ms: 0,
            end_ms: 12_500,
            text: "untimed text".to_string(),
        }];
        assert!(build_segments_for_timestamp_kind(
            &raw,
            "untimed text",
            12.5,
            0.91,
            TimestampKind::None,
        )
        .is_empty());
        assert_eq!(
            build_segments_for_timestamp_kind(
                &raw,
                "untimed text",
                12.5,
                0.91,
                TimestampKind::Segment,
            )
            .len(),
            1
        );
    }

    /// Measured on 2026-09-03 and deliberately left out of the picker: both
    /// Voxtral tiers lost the dictation comparison by roughly an order of
    /// magnitude and emit no timestamps at all, so neither can serve meetings
    /// either. `artifacts/qa/model-selection-2026-09-03.md` has the numbers.
    #[test]
    fn the_measured_voxtral_tiers_are_not_offered_as_routes() {
        for model_id in [
            VOXTRAL_MINI_3B_GGUF_MODEL_ID,
            VOXTRAL_REALTIME_4B_GGUF_MODEL_ID,
        ] {
            assert!(
                !spec_for(model_id).offered_as_route,
                "{model_id} must stay out of the route catalog"
            );
            assert!(
                !route_model_options()
                    .iter()
                    .any(|option| option.id == model_id),
                "{model_id} must not be offered in the picker"
            );
            // Nameable from the benchmark, which is the whole point of
            // carrying the spec at all.
            assert!(benchmark_model_options()
                .iter()
                .any(|option| option.id == model_id));
            // A saved settings file naming one must fall back to a real route.
            assert!(route_spec_for(model_id).offered_as_route);
        }
    }

    #[tokio::test]
    #[ignore = "requires pinned Moonshine Medium bytes and explicitly bound public fixtures"]
    async fn moonshine_streaming_production_provider_probe() {
        let root = PathBuf::from(std::env::var("PLAINSONG_MOONSHINE_STREAM_EVAL_ROOT").unwrap());
        let spec = spec_for(MOONSHINE_STREAM_MEDIUM_MODEL_ID);
        let models = root.join("provider-models");
        let directory = models.join(TRANSCRIBE_CPP_MODEL_DIR);
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(spec.file_name);
        if !path.exists() {
            std::fs::hard_link(root.join(spec.file_name), &path).unwrap();
        }
        assert!(
            crate::download::verify_or_record_model_integrity(&path, Some(spec.sha256))
                .await
                .unwrap()
        );
        let provider = TranscribeCppProvider::with_models_root(
            &models,
            Some(MOONSHINE_STREAM_MEDIUM_MODEL_ID),
        );
        assert_eq!(provider.model_info().parameters, "245M");
        let inputs: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(root.join("inputs.json")).unwrap()).unwrap();
        let mut results = Vec::new();
        for input in inputs {
            let result = provider
                .transcribe(Path::new(input["path"].as_str().unwrap()))
                .await
                .unwrap();
            assert_eq!(result.model_id, MOONSHINE_STREAM_MEDIUM_MODEL_ID);
            assert!(!result.measured_word_timestamps);
            if input["name"] == "silence" {
                assert!(result.text.is_empty());
            } else {
                assert!(!result.text.is_empty());
            }
            results.push(serde_json::json!({"name":input["name"],"text":result.text,"processingMs":result.processing_time_ms,"measuredWordTimestamps":result.measured_word_timestamps}));
            std::fs::write(
                root.join("provider-results.json"),
                serde_json::to_vec_pretty(&results).unwrap(),
            )
            .unwrap();
        }
        clear_cached_runtime();
    }

    #[test]
    #[ignore = "requires a pinned Moonshine Streaming candidate and explicitly bound public audio"]
    fn native_moonshine_streaming_candidate_probe() {
        use sha2::{Digest, Sha256};
        let root = PathBuf::from(std::env::var("PLAINSONG_MOONSHINE_STREAM_EVAL_ROOT").unwrap());
        let binding: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("binding.json")).unwrap()).unwrap();
        let path = root.join(binding["file"].as_str().unwrap());
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            binding["size"].as_u64().unwrap()
        );
        assert_eq!(
            hex::encode(Sha256::digest(std::fs::read(&path).unwrap())),
            binding["lfs"]["sha256"].as_str().unwrap()
        );
        let model = Model::load_with(
            &path,
            &ModelOptions {
                backend: Backend::Auto,
                device: None,
            },
        )
        .unwrap();
        let caps = model.capabilities();
        std::fs::write(root.join("runtime.json"), serde_json::to_vec_pretty(&serde_json::json!({"arch":model.arch(),"backend":model.backend().to_string(),"languages":caps.languages,"maxTimestampKind":format!("{:?}",caps.max_timestamp_kind)})).unwrap()).unwrap();
        let inputs: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(root.join("inputs.json")).unwrap()).unwrap();
        let mut results = Vec::new();
        for input in inputs {
            let path = PathBuf::from(input["path"].as_str().unwrap());
            assert_eq!(
                hex::encode(Sha256::digest(std::fs::read(&path).unwrap())),
                input["sha256"].as_str().unwrap()
            );
            let pcm = crate::audio::utils::load_audio_file(&path).unwrap();
            let mut session = model.session().unwrap();
            let token = CancelToken::new();
            session.set_cancel_token(&token);
            let (done, wait) = std::sync::mpsc::channel();
            let watchdog = std::thread::spawn(move || {
                if wait.recv_timeout(Duration::from_secs(45)).is_err() {
                    token.cancel();
                }
            });
            let start = Instant::now();
            let result = session.run(
                &pcm,
                &RunOptions {
                    timestamps: caps.max_timestamp_kind,
                    ..Default::default()
                },
            );
            let _ = done.send(());
            watchdog.join().unwrap();
            let row = match result {
                Ok(result) => {
                    serde_json::json!({"name":input["name"],"text":result.text,"elapsedMs":start.elapsed().as_millis(),"timestampKind":format!("{:?}",result.timestamp_kind)})
                }
                Err(error) => {
                    serde_json::json!({"name":input["name"],"error":error.to_string(),"elapsedMs":start.elapsed().as_millis()})
                }
            };
            println!("{}", row);
            results.push(row);
            std::fs::write(
                root.join("results.json"),
                serde_json::to_vec_pretty(&results).unwrap(),
            )
            .unwrap();
        }
    }

    #[test]
    #[ignore = "requires explicitly selected public audio and cached pinned Nemotron weights"]
    fn native_nemotron_english_hint_probe() {
        use sha2::{Digest, Sha256};
        let root = PathBuf::from(std::env::var("PLAINSONG_NEMOTRON_HINT_ROOT").unwrap());
        let models = PathBuf::from(std::env::var("PLAINSONG_MODELS_ROOT").unwrap());
        let model_path = models
            .join(TRANSCRIBE_CPP_MODEL_DIR)
            .join(spec_for(NEMOTRON_STREAMING_GGUF_MODEL_ID).file_name);
        assert_eq!(
            hex::encode(Sha256::digest(std::fs::read(&model_path).unwrap())),
            spec_for(NEMOTRON_STREAMING_GGUF_MODEL_ID).sha256
        );
        let input: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("input.json")).unwrap()).unwrap();
        let audio = PathBuf::from(input["path"].as_str().unwrap());
        assert_eq!(
            hex::encode(Sha256::digest(std::fs::read(&audio).unwrap())),
            input["sha256"].as_str().unwrap()
        );
        let pcm = crate::audio::utils::load_audio_file(&audio).unwrap();
        let model = Model::load_with(
            &model_path,
            &ModelOptions {
                backend: backend_choice_from_env().to_backend(),
                device: None,
            },
        )
        .unwrap();
        let caps = model.capabilities();
        std::fs::write(
            root.join("languages.json"),
            serde_json::to_vec_pretty(&caps.languages).unwrap(),
        )
        .unwrap();
        let mut session = model.session().unwrap();
        let mut rows = Vec::new();
        let english = caps
            .languages
            .iter()
            .find(|language| language.starts_with("en"))
            .cloned();
        for language in [None, Some("en".to_string()), english] {
            let options = RunOptions {
                language: language.clone(),
                timestamps: timestamp_request_for(caps.max_timestamp_kind),
                ..RunOptions::default()
            };
            let row = match session.run(&pcm, &options) {
                Ok(result) => {
                    serde_json::json!({"hint":language,"text":result.text,"detectedLanguage":result.language})
                }
                Err(error) => serde_json::json!({"hint":language,"error":error.to_string()}),
            };
            rows.push(row);
            std::fs::write(
                root.join("results.json"),
                serde_json::to_vec_pretty(&rows).unwrap(),
            )
            .unwrap();
        }
    }

    #[test]
    fn english_batch_route_uses_an_advertised_locale_without_changing_other_models() {
        let name = spec_for(NEMOTRON_STREAMING_GGUF_MODEL_ID).file_name;
        let languages = vec![
            "hi-IN".to_string(),
            "en-US".to_string(),
            "en-GB".to_string(),
        ];
        assert_eq!(
            batch_language_for_model(name, &languages).unwrap(),
            Some("en-US".into())
        );
        assert!(batch_language_for_model(name, &["hi-IN".into()]).is_err());
        assert_eq!(
            batch_language_for_model(
                spec_for(PARAKEET_UNIFIED_EN_GGUF_MODEL_ID).file_name,
                &languages
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn the_streaming_language_gate_uses_the_list_the_pinned_file_declares() {
        let provider = TranscribeCppStreamingProvider::with_models_root(
            Path::new("/nonexistent"),
            DEFAULT_STREAMING_CHUNK_MS,
        );
        // 28 codes, from the GGUF's own `language:` metadata at the pinned
        // revision. Not NVIDIA's advertised 40 locales, and not the port
        // card's 32: this is the list the artifact on disk claims.
        assert_eq!(NEMOTRON_STREAMING_LANGUAGES.len(), 28);
        for supported in ["en", "es", "ja", "uk", "zh"] {
            assert!(provider.supports_language(Some(supported)), "{supported}");
        }
        // Locale forms resolve to their base language.
        assert!(provider.supports_language(Some("en-US")));
        assert!(provider.supports_language(Some("pt_BR")));
        // "no language selected" is not a refusal: the model detects it.
        assert!(provider.supports_language(None));
        assert!(provider.supports_language(Some("auto")));
        assert!(provider.supports_language(Some("  ")));
        // Anything the file does not declare keeps the older preview.
        for unsupported in ["yue", "th", "he", "sw", "fil"] {
            assert!(
                !provider.supports_language(Some(unsupported)),
                "{unsupported} is not in the pinned list and must not be claimed"
            );
        }
    }

    #[test]
    fn every_offered_chunk_size_maps_to_an_operating_point_the_model_ships() {
        // att_context_right 0/3/6/13 at 80 ms per encoder frame.
        assert_eq!(att_context_right_for_chunk_ms(80), 0);
        assert_eq!(att_context_right_for_chunk_ms(320), 3);
        assert_eq!(att_context_right_for_chunk_ms(560), 6);
        assert_eq!(att_context_right_for_chunk_ms(1120), 13);
        // Every size the app can pick is one of those.
        for chunk_ms in STREAMING_CHUNK_MS_CHOICES {
            assert!(
                [0, 3, 6, 13].contains(&att_context_right_for_chunk_ms(chunk_ms)),
                "{chunk_ms} ms has no operating point"
            );
        }
        // A size the model was not trained on falls back to the default rather
        // than pinning a right-context that does not exist.
        assert_eq!(
            att_context_right_for_chunk_ms(999),
            att_context_right_for_chunk_ms(DEFAULT_STREAMING_CHUNK_MS)
        );
    }

    #[test]
    fn a_chunk_size_outside_the_table_falls_back_to_the_default() {
        for requested in [0u32, 100, 999, 5_000] {
            let provider =
                TranscribeCppStreamingProvider::with_models_root(Path::new("/x"), requested);
            assert_eq!(provider.chunk_ms(), DEFAULT_STREAMING_CHUNK_MS);
        }
        for requested in STREAMING_CHUNK_MS_CHOICES {
            let provider =
                TranscribeCppStreamingProvider::with_models_root(Path::new("/x"), requested);
            assert_eq!(provider.chunk_ms(), requested);
        }
    }

    /// Readiness does not hash. A file that does not match its pin is
    /// refused when a session first verifies it, and from then on is not an
    /// available engine.
    #[test]
    fn a_streaming_model_found_wrong_is_no_longer_an_available_engine() {
        let root = std::env::temp_dir()
            .join("plainsong-streaming-availability")
            .join(uuid::Uuid::new_v4().to_string());
        let dir = root.join(TRANSCRIBE_CPP_MODEL_DIR);
        std::fs::create_dir_all(&dir).expect("create dir");
        let provider =
            TranscribeCppStreamingProvider::with_models_root(&root, DEFAULT_STREAMING_CHUNK_MS);
        assert!(!provider.is_streaming_available(), "no file at all");

        std::fs::write(provider.model_path(), b"not really a gguf").expect("write");
        assert!(provider.is_streaming_available(), "readiness does not hash");
        let refused = open_verified_native_model(&provider.model_path())
            .expect_err("bytes that do not match the pin must not load");
        assert_eq!(refused.to_string(), MISSING_SPEECH_MODEL);
        assert!(
            !provider.is_streaming_available(),
            "a file found wrong is not a usable engine"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn streaming_and_final_dictation_share_the_same_pinned_model() {
        let provider = TranscribeCppStreamingProvider::with_models_root(
            Path::new("/x"),
            DEFAULT_STREAMING_CHUNK_MS,
        );
        assert_eq!(
            provider.streaming_model_id(),
            NEMOTRON_STREAMING_GGUF_MODEL_ID
        );
        // Preview and final dictation use one verified artifact.
        assert!(route_model_options()
            .iter()
            .any(|option| option.id == NEMOTRON_STREAMING_GGUF_MODEL_ID));
        assert!(TranscribeCppStreamingProvider::spec().offered_as_route);
    }

    /// The real thing, when the weights happen to be installed on this machine.
    ///
    /// Skipped rather than failed otherwise: this is a unit-test suite that has
    /// to pass on a checkout with no 716 MB GGUF in it. `--stream` in
    /// `benchmark-latency` is the measured version of the same path, and
    /// `artifacts/qa/streaming-partials-receipt-2026-09-02.md` is its receipt.
    #[test]
    #[ignore = "loads the Nemotron streaming model installed in this Mac's Plainsong folder; pass --ignored"]
    fn an_installed_streaming_engine_transcribes_a_fed_tone_without_panicking() {
        let provider = TranscribeCppStreamingProvider::new();
        if !provider.is_streaming_available() {
            eprintln!("skipping: the Nemotron streaming GGUF is not installed here");
            return;
        }
        let mut session = provider.open_session(Some("en")).expect("open a session");
        assert_eq!(
            session.chunk_samples(),
            streaming_chunk_samples(DEFAULT_STREAMING_CHUNK_MS)
        );
        // Silence: the words do not matter here, the state machine does.
        let chunk = vec![0.0f32; session.chunk_samples()];
        for _ in 0..3 {
            let partial = session.feed(&chunk).expect("feed silence");
            assert!(
                partial.elapsed_audio_s > 0.0,
                "the session must report the audio it has taken"
            );
        }
        let final_partial = session.finalize().expect("finalize");
        assert!(
            final_partial.is_empty(),
            "silence should not produce words: {final_partial:?}"
        );
        session.reset().expect("reset reopens the stream");
        session.feed(&chunk).expect("feed after reset");
    }

    #[test]
    fn every_pinned_model_has_an_immutable_url_and_a_full_length_digest() {
        for spec in MODEL_SPECS {
            assert_eq!(
                spec.sha256.len(),
                64,
                "{} must pin a full SHA-256",
                spec.model_id
            );
            assert!(
                spec.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "{} pinned a non-hex digest",
                spec.model_id
            );
            assert_eq!(
                spec.hf_revision.len(),
                40,
                "{} must pin a full commit sha, not a branch",
                spec.model_id
            );
            let url = spec.url();
            if spec.hosted_by_plainsong {
                // A release asset under a dated tag; the digest is the pin,
                // and `hf_revision` names the converted source.
                assert!(
                    url.starts_with(&format!("{PLAINSONG_MODEL_RELEASE_URL}/")),
                    "{url}"
                );
            } else {
                assert!(url.starts_with("https://huggingface.co/"), "{url}");
                assert!(url.contains(spec.hf_revision), "{url} is not pinned");
            }
            assert!(url.ends_with(spec.file_name), "{url}");
            assert!(spec.size_bytes > 0);
            assert!(spec.max_bytes() > spec.size_bytes);
        }
    }

    #[test]
    fn the_route_catalog_offers_only_explicit_batch_routes() {
        let options = route_model_options();
        assert_eq!(options.len(), 9);
        assert_eq!(
            options
                .iter()
                .map(|option| option.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                PARAKEET_GGUF_MODEL_ID,
                ORUKEET_R3_GGUF_MODEL_ID,
                QWEN3_ASR_17_GGUF_MODEL_ID,
                QWEN3_ASR_06_GGUF_MODEL_ID,
                PARAKEET_UNIFIED_EN_GGUF_MODEL_ID,
                NEMOTRON_STREAMING_GGUF_MODEL_ID,
                MOONSHINE_STREAM_MEDIUM_MODEL_ID,
                FLUID_SPEECH_MINI_GGUF_MODEL_ID,
                UNDERDOG_BARK_PRO_GGUF_MODEL_ID,
            ]
        );
        // Batch selection is explicit and remains experimental.
        assert!(
            MODEL_SPECS
                .iter()
                .any(|spec| spec.model_id == NEMOTRON_STREAMING_GGUF_MODEL_ID
                    && spec.offered_as_route)
        );
    }

    #[test]
    fn an_unknown_model_id_falls_back_to_the_offered_route() {
        assert_eq!(spec_for("nope").model_id, PARAKEET_GGUF_MODEL_ID);
        assert_eq!(spec_for("").model_id, PARAKEET_GGUF_MODEL_ID);
        assert_eq!(
            spec_for("  nemotron-3.5-asr-streaming-0.6b-q8_0  ").model_id,
            NEMOTRON_STREAMING_GGUF_MODEL_ID
        );
    }

    #[test]
    fn integrity_artifacts_cover_every_pinned_file() {
        let artifacts = model_integrity_artifacts(Path::new("/models"));
        let expected = MODEL_SPECS.len()
            + MODEL_SPECS
                .iter()
                .map(|spec| auxiliary_specs_for(spec.model_id).len())
                .sum::<usize>();
        assert_eq!(artifacts.len(), expected);
        for (path, digest) in artifacts {
            assert!(path.starts_with("/models/transcribe_cpp"));
            assert_eq!(digest.len(), 64);
        }
    }

    #[test]
    fn backend_choice_defaults_to_auto_for_anything_unrecognised() {
        assert_eq!(parse_backend_choice(None), BackendChoice::Auto);
        assert_eq!(parse_backend_choice(Some("")), BackendChoice::Auto);
        assert_eq!(parse_backend_choice(Some("vulkan")), BackendChoice::Auto);
        assert_eq!(parse_backend_choice(Some(" METAL ")), BackendChoice::Metal);
        assert_eq!(parse_backend_choice(Some("Cpu")), BackendChoice::Cpu);
    }

    #[test]
    fn segments_are_seconds_and_never_run_backwards() {
        let raw = vec![
            RawSegment {
                start_ms: 0,
                end_ms: 1_500,
                text: " Hello there ".to_string(),
            },
            RawSegment {
                start_ms: 1_500,
                // A family that reports an end before its start must not
                // produce a backwards span; seeking in the meeting view
                // depends on it.
                end_ms: 900,
                text: "friend".to_string(),
            },
        ];
        let segments = build_segments(&raw, "Hello there friend", 3.0, 0.5);
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].start_time, 0.0);
        assert_eq!(segments[0].end_time, 1.5);
        assert_eq!(segments[0].text, "Hello there");
        assert_eq!(segments[1].start_time, 1.5);
        assert_eq!(segments[1].end_time, 1.5);
        assert!(segments.iter().all(|segment| segment.confidence == 0.5));
    }

    #[test]
    fn blank_rows_are_dropped_and_untimed_text_still_yields_one_segment() {
        let raw = vec![RawSegment {
            start_ms: 0,
            end_ms: 0,
            text: "   ".to_string(),
        }];
        let segments = build_segments(&raw, "the whole decode", 5.25, 0.88);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].start_time, 0.0);
        assert_eq!(segments[0].end_time, 5.25);
        assert_eq!(segments[0].text, "the whole decode");
    }

    #[test]
    fn an_empty_decode_produces_no_segments() {
        assert!(build_segments(&[], "   ", 5.0, 0.88).is_empty());
    }

    #[test]
    fn a_negative_or_unknown_clip_length_never_becomes_a_negative_span() {
        let segments = build_segments(&[], "text", f64::NAN, 0.88);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].end_time, 0.0);
    }

    #[test]
    fn confidence_falls_back_to_the_documented_constant_when_no_token_scores_exist() {
        assert_eq!(token_confidence(&[]), UNSCORED_TRANSDUCER_CONFIDENCE);
        assert_eq!(
            token_confidence(&[f32::NAN, f32::NAN]),
            UNSCORED_TRANSDUCER_CONFIDENCE
        );
        // Out-of-range values are not probabilities and must not drag the mean.
        assert_eq!(
            token_confidence(&[2.0, -1.0]),
            UNSCORED_TRANSDUCER_CONFIDENCE
        );
        assert!((token_confidence(&[0.5, 1.0]) - 0.75).abs() < 1e-9);
    }

    #[test]
    fn moonshine_stream_rejects_a_successful_but_truncated_snapshot() {
        let transcript = transcribe_cpp::Transcript {
            text: "unfinished transcript".into(),
            ..transcribe_cpp::Transcript::default()
        };
        let error = completed_moonshine_stream(transcript.clone(), true)
            .expect_err("a truncated stream must not be saved as complete");
        assert!(matches!(
            error,
            transcribe_cpp::Error::OutputTruncated { .. }
        ));
        let message = completed_native_transcript(
            Err(error),
            None,
            MOONSHINE_STREAM_MEDIUM_MODEL_ID,
            Duration::from_secs(180),
            180.0,
        )
        .unwrap_err()
        .to_string();
        assert!(message.contains("incomplete"), "{message}");
        assert!(!message.contains(&transcript.text), "{message}");
        assert_eq!(
            completed_moonshine_stream(transcript.clone(), false)
                .unwrap()
                .text,
            transcript.text
        );
    }

    #[test]
    fn qwen_native_result_rejects_truncated_and_cancelled_partials() {
        use transcribe_cpp::{Error, Transcript};

        let partial = Transcript {
            text: "private unfinished dictation".into(),
            ..Transcript::default()
        };
        for model_id in [QWEN3_ASR_06_GGUF_MODEL_ID, QWEN3_ASR_17_GGUF_MODEL_ID] {
            for (error, stop, expected) in [
                (
                    Error::OutputTruncated {
                        message: partial.text.clone(),
                        partial: Some(Box::new(partial.clone())),
                    },
                    None,
                    "incomplete",
                ),
                (
                    Error::Aborted {
                        message: partial.text.clone(),
                        partial: Some(Box::new(partial.clone())),
                    },
                    Some(DecodeStop::Cancelled),
                    "cancelled",
                ),
                (
                    Error::Aborted {
                        message: partial.text.clone(),
                        partial: Some(Box::new(partial.clone())),
                    },
                    Some(DecodeStop::DeadlineExceeded),
                    "within its 180 s budget for 180.0 s of audio",
                ),
            ] {
                let message = completed_native_transcript(
                    Err(error),
                    stop,
                    model_id,
                    Duration::from_secs(180),
                    180.0,
                )
                .expect_err("partial output must not become a successful transcript")
                .to_string();
                assert!(message.contains(expected), "{message}");
                assert!(message.contains(model_id), "{message}");
                assert!(!message.contains(&partial.text), "{message}");
            }
        }
        let complete = Transcript {
            text: "complete dictation".into(),
            ..Transcript::default()
        };
        assert_eq!(
            completed_native_transcript(
                Ok(complete.clone()),
                None,
                QWEN3_ASR_06_GGUF_MODEL_ID,
                Duration::from_secs(180),
                180.0,
            )
            .unwrap(),
            complete
        );
    }

    #[test]
    fn error_messages_name_the_next_action_and_never_carry_the_partial_transcript() {
        use transcribe_cpp::Error;

        let secret = "the user said something private";
        let truncated = Error::OutputTruncated {
            message: format!("run: {secret}"),
            partial: None,
        };
        let rendered = describe_transcribe_error(PARAKEET_GGUF_MODEL_ID, &truncated);
        assert!(!rendered.contains(secret), "{rendered}");
        assert!(rendered.contains("incomplete"), "{rendered}");
        assert!(rendered.contains("shorter clip"), "{rendered}");

        let missing = describe_transcribe_error(
            PARAKEET_GGUF_MODEL_ID,
            &Error::ModelFileNotFound("whatever".into()),
        );
        assert_eq!(missing, MISSING_SPEECH_MODEL);

        let backend = describe_transcribe_error(
            PARAKEET_GGUF_MODEL_ID,
            &Error::Backend("no metal device".into()),
        );
        assert!(backend.contains(BACKEND_ENV_VAR), "{backend}");

        let busy = describe_transcribe_error(PARAKEET_GGUF_MODEL_ID, &Error::Busy("x".into()));
        assert!(
            busy.contains("Wait for the current transcription"),
            "{busy}"
        );

        // Every message names the route it is about.
        for error in [
            Error::InvalidArgument("x".into()),
            Error::NotImplemented("x".into()),
            Error::ModelLoad("x".into()),
            Error::OutOfMemory("x".into()),
            Error::Unsupported("x".into()),
            Error::BadStructSize("x".into()),
            Error::InputTooLong("x".into()),
            Error::VersionMismatch("x".into()),
            Error::Other("x".into()),
        ] {
            let rendered = describe_transcribe_error(PARAKEET_GGUF_MODEL_ID, &error);
            assert!(rendered.contains(PARAKEET_GGUF_MODEL_ID), "{rendered}");
            assert!(rendered.ends_with('.'), "{rendered}");
        }
    }

    /// The bindings and the library they linked against agree. Cheap, and it
    /// runs in every build of the spike, including a `--no-default-features
    /// --features asr-transcribe-cpp` one that has no whisper.cpp to compare
    /// against.
    #[test]
    fn the_linked_library_matches_the_bindings() {
        let native = transcribe_cpp::version();
        assert!(!native.is_empty(), "libtranscribe reported no version");
        assert_eq!(
            native,
            transcribe_cpp::compiled_version(),
            "the linked libtranscribe disagrees with the bindings it was built against"
        );
    }

    /// The spike's headline risk: whisper-rs vendors its own ggml and
    /// transcribe.cpp vendors another, both statically linked into the same
    /// binary. They do not collide today because transcribe.cpp builds its
    /// tree with hidden visibility (`CMAKE_C_VISIBILITY_PRESET hidden`), so
    /// on Mach-O every one of its ggml symbols is `private external` while
    /// whisper-rs's are plain `external`.
    ///
    /// That is a property of two upstreams' build flags, not a guarantee, so
    /// this test drives ggml itself on both sides, from one process. Version
    /// and language-table calls (what this used to assert) never reach ggml at
    /// all, so they could not have detected interposition: the whole failure
    /// mode is one library's ggml answering for the other's.
    ///
    /// - transcribe.cpp: `devices()`/`device_count()`/`backend_available()` walk
    ///   its ggml backend registry.
    /// - whisper-rs: `print_system_info()` walks *its* ggml backend registry
    ///   (`ggml_backend_reg_count`/`_get`/`_get_proc_address` in whisper.cpp),
    ///   and `SystemInfo::default()` calls `ggml_cpu_has_*` directly.
    ///
    /// Both are model-free. Each is exercised again after the other has run, so
    /// a registry one library initialized under the other's symbols shows up as
    /// a changed answer rather than as a wrong transcript months later. Needs
    /// `asr-whisper`, or there is no second ggml in the binary to conflict with.
    #[cfg(feature = "asr-whisper")]
    #[test]
    fn both_ggml_copies_serve_their_own_library_in_one_process() {
        let devices = transcribe_cpp::devices();
        assert!(
            !devices.is_empty(),
            "transcribe.cpp's ggml registered no compute device"
        );
        assert_eq!(
            devices.len(),
            transcribe_cpp::device_count(),
            "device enumeration and count disagree"
        );
        assert!(
            transcribe_cpp::backend_available(Backend::Cpu),
            "transcribe.cpp's ggml reports no CPU backend"
        );

        // whisper.cpp's own ggml, in the same process.
        let whisper_info = whisper_rs::print_system_info();
        assert!(
            whisper_info.contains("WHISPER"),
            "whisper.cpp reported no system info: {whisper_info}"
        );
        assert!(
            whisper_info.len() > "WHISPER : COREML = 0 | OPENVINO = 0 | ".len(),
            "whisper.cpp's ggml backend registry walk produced nothing: {whisper_info}"
        );
        // ggml_cpu_has_* through whisper-rs's ggml. The values are host-
        // dependent (all four are x86 flags, so all false on Apple silicon);
        // that this returns at all is the point.
        let _ = whisper_rs::SystemInfo::default();

        // Each library still answers for itself after the other was driven.
        assert_eq!(transcribe_cpp::device_count(), devices.len());
        assert_eq!(whisper_rs::print_system_info(), whisper_info);
    }

    #[test]
    fn the_provider_reports_no_word_error_rate_it_did_not_measure() {
        let info = TranscribeCppProvider::new(None).model_info();
        assert!(info.word_error_rate.is_none());
        assert!(info.real_time_factor.is_none());
        assert_eq!(info.license, "CC-BY-4.0");
        assert_eq!(info.languages.len(), 25);
    }

    #[test]
    fn benchmark_selection_preserves_hidden_models_without_changing_routes() {
        let benchmark = TranscribeCppProvider::for_benchmark(VOXTRAL_MINI_3B_GGUF_MODEL_ID)
            .expect("pinned probe model");
        assert_eq!(benchmark.spec().model_id, VOXTRAL_MINI_3B_GGUF_MODEL_ID);
        let normal = TranscribeCppProvider::with_models_root(
            Path::new("/models"),
            Some(VOXTRAL_MINI_3B_GGUF_MODEL_ID),
        );
        assert_eq!(normal.spec().model_id, PARAKEET_GGUF_MODEL_ID);
        assert!(TranscribeCppProvider::for_benchmark("unknown-probe-model").is_err());
    }

    #[test]
    fn only_a_model_the_catalog_offers_survives_normalization() {
        // Hidden Voxtral probes must not survive route normalization.
        assert_eq!(
            spec_for(VOXTRAL_MINI_3B_GGUF_MODEL_ID).model_id,
            VOXTRAL_MINI_3B_GGUF_MODEL_ID
        );
        assert_eq!(
            route_spec_for(VOXTRAL_MINI_3B_GGUF_MODEL_ID).model_id,
            PARAKEET_GGUF_MODEL_ID
        );
        assert_eq!(route_spec_for("").model_id, PARAKEET_GGUF_MODEL_ID);
        assert_eq!(route_spec_for("nope").model_id, PARAKEET_GGUF_MODEL_ID);
        assert_eq!(
            route_spec_for(PARAKEET_GGUF_MODEL_ID).model_id,
            PARAKEET_GGUF_MODEL_ID
        );
        // Whatever it returns is something `model_options()` offers.
        for spec in MODEL_SPECS {
            let normalized = route_spec_for(spec.model_id);
            assert!(
                normalized.offered_as_route,
                "{} normalized to an unoffered route",
                spec.model_id
            );
            assert!(route_model_options()
                .iter()
                .any(|option| option.id == normalized.model_id));
        }
    }

    #[test]
    fn a_packaging_failure_keeps_a_short_form_of_what_the_library_said() {
        use transcribe_cpp::Error;

        let load = describe_transcribe_error(
            PARAKEET_GGUF_MODEL_ID,
            &Error::ModelLoad("unsupported architecture 'canary-1b'".into()),
        );
        assert!(
            load.contains("unsupported architecture 'canary-1b'"),
            "{load}"
        );
        assert!(
            load.contains("Re-download the model from Settings"),
            "{load}"
        );
        assert!(load.ends_with('.'), "{load}");

        let backend = describe_transcribe_error(
            PARAKEET_GGUF_MODEL_ID,
            &Error::Backend("no Metal device on this host".into()),
        );
        assert!(
            backend.contains("no Metal device on this host"),
            "{backend}"
        );
        assert!(backend.contains(BACKEND_ENV_VAR), "{backend}");

        let abi = describe_transcribe_error(
            PARAKEET_GGUF_MODEL_ID,
            &Error::VersionMismatch("library 0.3.0 vs headers 0.2.3".into()),
        );
        assert!(abi.contains("library 0.3.0 vs headers 0.2.3"), "{abi}");

        // An empty upstream message must not leave a dangling clause.
        let empty =
            describe_transcribe_error(PARAKEET_GGUF_MODEL_ID, &Error::ModelLoad(String::new()));
        assert!(!empty.contains("transcribe.cpp said"), "{empty}");
        assert!(empty.ends_with('.'), "{empty}");

        // A long or multi-line diagnostic is folded to one capped line.
        let noisy = short_upstream_detail(&format!("line one\n  line two {}", "x".repeat(400)));
        assert!(!noisy.contains('\n'), "{noisy}");
        assert_eq!(noisy.chars().count(), MAX_UPSTREAM_DETAIL_CHARS + 1);
        assert!(noisy.ends_with('…'), "{noisy}");

        // The classes whose payload comes from the audio still say nothing
        // about it.
        let secret = "the user said something private";
        for error in [
            Error::Aborted {
                message: format!("run: {secret}"),
                partial: None,
            },
            Error::OutputTruncated {
                message: format!("run: {secret}"),
                partial: None,
            },
        ] {
            let rendered = describe_transcribe_error(PARAKEET_GGUF_MODEL_ID, &error);
            assert!(!rendered.contains(secret), "{rendered}");
        }
    }

    // The runtime cache is one process-global mutex, so the tests that take,
    // poison or contend it run one at a time.
    fn cache_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn a_panic_under_the_runtime_lock_does_not_wedge_the_route_forever() {
        let _serialized = cache_test_lock();

        let panicked = std::panic::catch_unwind(|| {
            let _held = runtime_cache().lock().expect("fresh lock");
            panic!("a decode panicked while holding the runtime");
        });
        assert!(panicked.is_err(), "the test needs the panic to unwind");
        assert!(
            runtime_cache().is_poisoned(),
            "the panic should have poisoned the cache"
        );

        // Before: `clear_cached_runtime` matched on `Ok(..)` and silently did
        // nothing, and every later decode failed on the poisoned lock.
        clear_cached_runtime();
        assert!(
            !runtime_cache().is_poisoned(),
            "clear_cached_runtime must clear the poison, not skip over it"
        );

        // The cache is usable again, and empty, so the next decode reloads.
        assert!(lock_runtime_cache().is_none());
        assert_eq!(cached_model_load_ms(), None);
    }

    #[test]
    fn decode_control_stops_on_cancel_and_on_deadline() {
        let flag = AtomicBool::new(false);
        let later = Instant::now() + Duration::from_secs(60);
        assert_eq!(check_decode_control(&flag, later), Ok(()));
        assert_eq!(
            check_decode_control(&flag, Instant::now() - Duration::from_millis(1)),
            Err(DecodeStop::DeadlineExceeded)
        );
        flag.store(true, Ordering::Relaxed);
        assert_eq!(
            check_decode_control(&flag, later),
            Err(DecodeStop::Cancelled)
        );
        // Cancellation wins over an expired deadline: an abandoned request is
        // not a slow one.
        assert_eq!(
            check_decode_control(&flag, Instant::now() - Duration::from_millis(1)),
            Err(DecodeStop::Cancelled)
        );
    }

    #[test]
    fn the_decode_budget_scales_with_the_audio_and_never_goes_below_the_floor() {
        assert_eq!(decode_budget_for_audio(0.0), Duration::from_secs(30));
        assert_eq!(decode_budget_for_audio(-5.0), Duration::from_secs(30));
        assert_eq!(decode_budget_for_audio(1.0), Duration::from_secs(30));
        assert_eq!(decode_budget_for_audio(60.0), Duration::from_secs(240));
    }

    #[test]
    fn dropping_the_cancel_guard_flags_the_decode() {
        let flag = Arc::new(AtomicBool::new(false));
        {
            let _guard = CancelOnDrop(Arc::clone(&flag));
            assert!(!flag.load(Ordering::Relaxed));
        }
        assert!(flag.load(Ordering::Relaxed));
    }

    /// The watchdog against a stub decode: a closure that polls the same
    /// `CancelToken` the native session would poll between decode steps, so the
    /// whole cancel path is exercised without a GGUF on disk.
    fn stub_decode(token: &CancelToken, give_up_after: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < give_up_after {
            if token.is_cancelled() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        false
    }

    #[test]
    fn the_watchdog_cancels_a_stub_decode_when_the_deadline_passes() {
        let token = CancelToken::new();
        let abandoned = Arc::new(AtomicBool::new(false));
        let watchdog = DecodeWatchdog::spawn(
            token.clone(),
            Arc::clone(&abandoned),
            Instant::now() + Duration::from_millis(60),
        );
        assert!(
            stub_decode(&token, Duration::from_secs(5)),
            "the decode should have been cancelled well before it gave up"
        );
        assert_eq!(watchdog.finish(), Some(DecodeStop::DeadlineExceeded));
        assert!(token.is_cancelled());
    }

    #[test]
    fn the_watchdog_cancels_a_stub_decode_when_the_caller_abandons_it() {
        let token = CancelToken::new();
        let abandoned = Arc::new(AtomicBool::new(false));
        let watchdog = DecodeWatchdog::spawn(
            token.clone(),
            Arc::clone(&abandoned),
            Instant::now() + Duration::from_secs(300),
        );
        // What `CancelOnDrop` does when the request's future is dropped.
        abandoned.store(true, Ordering::Relaxed);
        assert!(
            stub_decode(&token, Duration::from_secs(5)),
            "an abandoned request must not keep decoding"
        );
        assert_eq!(watchdog.finish(), Some(DecodeStop::Cancelled));
    }

    #[test]
    fn a_decode_that_finishes_on_time_is_never_cancelled() {
        let token = CancelToken::new();
        let abandoned = Arc::new(AtomicBool::new(false));
        let watchdog = DecodeWatchdog::spawn(
            token.clone(),
            Arc::clone(&abandoned),
            Instant::now() + Duration::from_secs(300),
        );
        assert!(!stub_decode(&token, Duration::from_millis(60)));
        assert_eq!(watchdog.finish(), None);
        assert!(!token.is_cancelled());
    }

    /// The `Busy` arm used to be unreachable: the runtime mutex was taken with
    /// a blocking `lock()`, so a second request waited for as long as the first
    /// decode took, with no way to say so. Now the wait is bounded by the
    /// request's own budget.
    /// With GGUF Parakeet as the dictation route, the re-decode live preview
    /// and the final decode share this one runtime. The stop path drains the
    /// preview first; a final decode that still finds a preview decode in
    /// flight must wait for it and then run, not fail as busy.
    #[test]
    fn a_final_decode_gets_the_runtime_as_soon_as_a_preview_decode_lets_go() {
        let _serialized = cache_test_lock();
        clear_cached_runtime();

        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let preview = std::thread::spawn(move || {
            let _held = runtime_cache().lock().expect("preview holds the runtime");
            held_tx.send(()).expect("signal held");
            std::thread::sleep(Duration::from_millis(60));
        });
        held_rx.recv().expect("preview started");

        let never_abandoned = AtomicBool::new(false);
        let started = Instant::now();
        let acquired = acquire_runtime(
            &never_abandoned,
            Instant::now() + Duration::from_secs(10),
            "parakeet-tdt-0.6b-v3-Q8_0.gguf",
            Duration::from_secs(10),
        );
        let waited = started.elapsed();
        assert!(acquired.is_ok(), "the final decode must get the runtime");
        drop(acquired);
        preview.join().expect("preview thread");
        assert!(
            waited >= Duration::from_millis(40),
            "it waited for the preview, took {waited:?}"
        );
        assert!(
            waited < Duration::from_secs(5),
            "and only for as long as the preview held it, took {waited:?}"
        );
    }

    #[test]
    fn a_request_that_cannot_get_the_runtime_says_so_instead_of_blocking_forever() {
        let _serialized = cache_test_lock();
        clear_cached_runtime();

        let held = runtime_cache().lock().expect("hold the runtime");
        let never_abandoned = AtomicBool::new(false);
        let started = Instant::now();
        // `MutexGuard<Option<CachedRuntime>>` is not `Debug`, so match rather
        // than `expect_err`.
        let error = match acquire_runtime(
            &never_abandoned,
            Instant::now() + Duration::from_millis(80),
            "parakeet-tdt-0.6b-v3-Q8_0.gguf",
            Duration::from_millis(80),
        ) {
            Ok(_) => panic!("the runtime is held, so acquisition must not succeed"),
            Err(error) => error,
        };
        let waited = started.elapsed();
        drop(held);

        assert!(
            waited < Duration::from_secs(5),
            "the wait must be bounded, took {waited:?}"
        );
        let rendered = error.to_string();
        assert!(rendered.contains("already transcribing"), "{rendered}");
        assert!(
            rendered.contains("Wait for the current transcription"),
            "{rendered}"
        );

        // And an abandoned request waiting for the runtime reports the abort,
        // not a timeout it never reached.
        let abandoned = AtomicBool::new(true);
        let rendered = runtime_wait_error(
            check_decode_control(&abandoned, Instant::now() + Duration::from_secs(60))
                .expect_err("abandoned"),
            "parakeet-tdt-0.6b-v3-Q8_0.gguf",
            Duration::from_secs(30),
        )
        .to_string();
        assert!(rendered.contains("was cancelled"), "{rendered}");
    }

    fn write_plausible_but_unverified_gguf(model_path: &Path) {
        std::fs::create_dir_all(model_path.parent().expect("model dir")).expect("create model dir");
        // A GGUF magic and enough bytes to look like weights. The point is that
        // none of that is what readiness turns on.
        let mut bytes = b"GGUF".to_vec();
        bytes.extend(std::iter::repeat_n(0u8, 8192));
        std::fs::write(model_path, bytes).expect("write gguf");
    }

    /// Readiness reads no bytes, but loading hashes them: a GGUF of the right
    /// shape that does not match its pin is refused before any decode and
    /// then reads as missing, which offers the download again.
    #[tokio::test]
    async fn plausible_weights_are_refused_at_load_and_then_read_as_missing() {
        let root =
            std::env::temp_dir().join(format!("transcribe-cpp-trust-{}", uuid::Uuid::new_v4()));
        let provider = TranscribeCppProvider::with_models_root(&root, None);
        let model_path = provider.model_path();
        write_plausible_but_unverified_gguf(&model_path);

        assert!(provider.has_required_file(), "structure check passes");
        assert_eq!(provider.download_status(), DownloadStatus::Downloaded);
        assert!(provider.is_available(), "readiness does not hash");

        let refused = open_verified_native_model(&model_path)
            .expect_err("weights that do not match their pin must not load");
        assert_eq!(refused.to_string(), MISSING_SPEECH_MODEL);
        for jargon in ["GGUF", "transcribe.cpp", "ONNX", "Metal"] {
            assert!(!refused.to_string().contains(jargon), "{refused}");
        }
        assert!(!provider.has_trusted_required_file());
        assert!(!provider.is_available(), "found wrong, so not ready");
        let error = provider
            .transcribe(&root.join("unused.wav"))
            .await
            .expect_err("rejected weights must not transcribe");
        assert_eq!(error.to_string(), MISSING_SPEECH_MODEL);
        let error = provider
            .prewarm()
            .await
            .expect_err("rejected weights must not load");
        assert!(
            error.to_string().contains("not downloaded and verified"),
            "{error}"
        );

        // A new file at the path is a new question.
        std::fs::write(&model_path, vec![0x11u8; 4096]).expect("replace weights");
        assert!(provider.is_available());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    #[ignore = "requires explicitly staged Qwen 1.7B weights and frozen audio"]
    async fn qwen17_production_provider_probe() {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        struct Cleanup;
        impl Drop for Cleanup {
            fn drop(&mut self) {
                clear_cached_runtime();
            }
        }
        let _cleanup = Cleanup;
        let root = PathBuf::from(
            std::env::var("PLAINSONG_QWEN17_EVAL_ROOT").expect("explicit qualification root"),
        );
        let backend = std::env::var(BACKEND_ENV_VAR).expect("explicit backend");
        assert!(matches!(backend.as_str(), "cpu" | "metal"));
        let source = root.join("model.gguf");
        let spec = spec_for(QWEN3_ASR_17_GGUF_MODEL_ID);
        assert_eq!(std::fs::metadata(&source).unwrap().len(), spec.size_bytes);
        let mut file = std::fs::File::open(&source).unwrap();
        let mut hash = Sha256::new();
        let mut buffer = vec![0u8; 1024 * 1024];
        loop {
            let n = file.read(&mut buffer).unwrap();
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        assert_eq!(hex::encode(hash.finalize()), spec.sha256);
        drop(buffer);
        let provider = TranscribeCppProvider::with_models_root(
            &root.join("production-models"),
            Some(QWEN3_ASR_17_GGUF_MODEL_ID),
        );
        std::fs::create_dir_all(&provider.model_dir).unwrap();
        if !provider.model_path().exists() {
            std::fs::copy(&source, provider.model_path()).unwrap();
        }
        assert!(crate::download::verify_or_record_model_integrity(
            &provider.model_path(),
            Some(spec.sha256)
        )
        .await
        .unwrap());
        assert!(provider.is_available());
        assert_eq!(provider.model_info().parameters, "1.7B");
        provider
            .prewarm()
            .await
            .expect("production prewarm must work");
        let mut results = Vec::new();
        for name in [
            "correction.wav",
            "finance.wav",
            "finance-next.wav",
            "silence.wav",
        ] {
            let result = provider
                .transcribe(&root.join(name))
                .await
                .expect("production decode");
            assert_eq!(result.model_id, QWEN3_ASR_17_GGUF_MODEL_ID);
            assert_eq!(result.actual_provider, AsrProviderType::TranscribeCpp);
            assert_eq!(
                result.actual_engine.as_deref(),
                Some(format!("transcribe_cpp_{backend}").as_str())
            );
            assert!(
                result.segments.is_empty(),
                "untimed output must not invent alignment"
            );
            assert!(result.speaker_turns.is_empty());
            if name == "silence.wav" {
                assert!(result.text.is_empty());
            }
            results.push(serde_json::json!({"file":name,"text":result.text,"modelId":result.model_id,"actualEngine":result.actual_engine,"processingMs":result.processing_time_ms,"segments":result.segments.len()}));
        }
        std::fs::write(root.join("provider-metadata.json"), serde_json::to_vec_pretty(&serde_json::json!({"modelOptions":route_model_options(),"modelInfo":provider.model_info(),"available":provider.is_available()})).unwrap()).unwrap();
        crate::shutdown_for_sidecar().await;
        std::fs::write(
            root.join(format!("production-{backend}.json")),
            serde_json::to_vec_pretty(&results).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn bounded_unified_cancelled_job_stops_before_model_loading() {
        let cancelled = Arc::new(AtomicBool::new(true));
        let error = run_bounded_unified(
            Path::new("must-not-load.gguf"),
            BackendChoice::Cpu,
            &vec![0.0; 61 * 16_000],
            &cancelled,
        )
        .err()
        .expect("cancelled job must fail");
        assert!(error.to_string().contains("Cancelled"));
    }

    #[test]
    fn bounded_unified_policy_keeps_short_captures_and_other_models_unchanged() {
        assert!(!uses_bounded_unified(
            PARAKEET_UNIFIED_EN_GGUF_MODEL_ID,
            60 * 16_000
        ));
        assert!(uses_bounded_unified(
            PARAKEET_UNIFIED_EN_GGUF_MODEL_ID,
            60 * 16_000 + 1
        ));
        assert!(!uses_bounded_unified(
            QWEN3_ASR_17_GGUF_MODEL_ID,
            600 * 16_000
        ));
        assert!(!uses_bounded_unified(
            QWEN3_ASR_06_GGUF_MODEL_ID,
            180 * 16_000
        ));
        assert!(!uses_bounded_unified(
            ORUKEET_R3_GGUF_MODEL_ID,
            600 * 16_000
        ));
    }

    #[tokio::test]
    #[ignore = "requires pinned Unified weights and frozen timing excerpts"]
    async fn unified_measured_word_alignment_probe() {
        struct Cleanup;
        impl Drop for Cleanup {
            fn drop(&mut self) {
                clear_cached_runtime();
            }
        }
        let _cleanup = Cleanup;
        let root = PathBuf::from(
            std::env::var("PLAINSONG_QWEN17_EVAL_ROOT").expect("explicit fixture root"),
        );
        let source = PathBuf::from(
            std::env::var("PLAINSONG_UNIFIED_SOURCE_DIR").expect("explicit source model directory"),
        );
        let provider = TranscribeCppProvider::with_models_root(
            &root.join("timing-production-models"),
            Some(PARAKEET_UNIFIED_EN_GGUF_MODEL_ID),
        );
        std::fs::create_dir_all(&provider.model_dir).unwrap();
        let mut assets = vec![(provider.spec().file_name, provider.spec().sha256)];
        assets.extend(
            auxiliary_specs_for(PARAKEET_UNIFIED_EN_GGUF_MODEL_ID)
                .iter()
                .map(|aux| (aux.local_file_name, aux.sha256)),
        );
        for (name, digest) in assets {
            let path = provider.model_dir.join(name);
            if !path.exists() {
                std::fs::copy(source.join(name), &path).unwrap();
            }
            assert!(
                crate::download::verify_or_record_model_integrity(&path, Some(digest))
                    .await
                    .unwrap()
            );
        }
        let mut rows = Vec::new();
        let mut analysis_rows = Vec::new();
        let inputs = std::env::var("PLAINSONG_WORD_ALIGNMENT_AUDIO")
            .map(|file| vec![file])
            .unwrap_or_else(|_| vec!["finance.wav".into(), "finance-next.wav".into()]);
        for name in inputs {
            let started = std::time::Instant::now();
            let r = provider.transcribe(&root.join(&name)).await.unwrap();
            assert!(r.segments.len() > 20);
            assert_eq!(
                r.segments
                    .iter()
                    .map(|s| s.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
                    .split_whitespace()
                    .collect::<Vec<_>>(),
                r.text.split_whitespace().collect::<Vec<_>>()
            );
            if name == "finance.wav" {
                let price = r
                    .segments
                    .iter()
                    .find(|s| s.text == "twenty")
                    .expect("price word");
                assert!((price.start_time - 29.52).abs() < 0.1);
            }
            let transcript_rows = r
                .segments
                .iter()
                .enumerate()
                .map(|(index, segment)| crate::models::TranscriptSegment {
                    id: format!("{name}-word-{index}"),
                    start_time: segment.start_time,
                    end_time: segment.end_time,
                    text: segment.text.clone(),
                    speaker_id: None,
                    confidence: 1.0,
                })
                .collect::<Vec<_>>();
            let passages =
                crate::analysis::group_transcript_segments_for_analysis(&name, &transcript_rows);
            assert!(passages.len() < transcript_rows.len());
            assert_eq!(
                passages
                    .iter()
                    .map(|s| s.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
                transcript_rows
                    .iter()
                    .map(|s| s.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            for passage in &passages {
                let first = transcript_rows
                    .iter()
                    .find(|s| s.id == passage.segment_id)
                    .unwrap();
                assert_eq!(passage.start_time, first.start_time);
                assert!(transcript_rows
                    .iter()
                    .any(|s| s.end_time == passage.end_time));
            }
            let passage_values = passages
                .iter()
                .map(|s| {
                    serde_json::json!({
                        "segmentId":s.segment_id,"text":s.text,"start":s.start_time,"end":s.end_time
                    })
                })
                .collect::<Vec<_>>();
            analysis_rows.push(serde_json::json!({"file":name,"wordRows":transcript_rows.len(),"passages":passage_values,"speakerLabelsAssigned":false}));
            rows.push(serde_json::json!({"file":name,"decodeMs":started.elapsed().as_millis(),"text":r.text,"segments":r.segments,"modelId":r.model_id,"actualEngine":r.actual_engine}));
        }
        std::fs::write(
            root.join("production-analysis-passages.json"),
            serde_json::to_vec_pretty(&analysis_rows).unwrap(),
        )
        .unwrap();
        std::fs::write(
            root.join("production-word-alignment.json"),
            serde_json::to_vec_pretty(&rows).unwrap(),
        )
        .unwrap();
    }

    /// Drives the production provider over the frozen public speech corpus.
    /// The caller supplies a `/tmp` qualification root containing the pinned
    /// GGUF. Test builds keep verification in memory, never the OS Keychain.
    #[tokio::test]
    #[ignore = "requires the pinned Orukeet GGUF and frozen public speech corpus"]
    async fn orukeet_r3_production_provider_probe() {
        use sha2::{Digest, Sha256};
        use std::io::Cursor;

        let qualification_root = PathBuf::from(
            std::env::var("PLAINSONG_ORUKEET_TRANSCRIBE_CPP_EVAL_ROOT")
                .expect("explicit Orukeet transcribe.cpp evaluation root"),
        );
        let backend = std::env::var(BACKEND_ENV_VAR)
            .expect("production probe requires an explicit cpu or metal backend")
            .trim()
            .to_ascii_lowercase();
        assert!(matches!(backend.as_str(), "cpu" | "metal"));
        let expected_engine = format!("transcribe_cpp_{backend}");
        assert!(
            qualification_root.starts_with("/tmp")
                || qualification_root.starts_with(std::env::temp_dir())
        );
        let corpus_root = PathBuf::from("/tmp/plainsong-human-asr-20261003");
        let models_root = qualification_root.join("production-models");
        let provider =
            TranscribeCppProvider::with_models_root(&models_root, Some(ORUKEET_R3_GGUF_MODEL_ID));
        let source = qualification_root.join(provider.spec().file_name);
        let payload = std::fs::read(&source).expect("read pinned Orukeet GGUF");
        assert_eq!(payload.len() as u64, provider.spec().size_bytes);
        assert_eq!(
            hex::encode(Sha256::digest(&payload)),
            provider.spec().sha256
        );
        std::fs::create_dir_all(provider.model_path().parent().expect("model directory"))
            .expect("create model directory");
        std::fs::copy(&source, provider.model_path()).expect("stage pinned Orukeet GGUF");
        crate::download::mark_model_verified_for_tests(
            &provider.model_path(),
            provider.spec().sha256,
        )
        .await
        .expect("mark test model verified");
        for aux in auxiliary_specs_for(ORUKEET_R3_GGUF_MODEL_ID) {
            let source = qualification_root.join(format!("orukeet-{}", aux.source_file_name()));
            let payload = std::fs::read(&source).expect("read pinned attribution file");
            assert_eq!(payload.len() as u64, aux.size_bytes);
            assert_eq!(hex::encode(Sha256::digest(&payload)), aux.sha256);
            let destination = provider.model_dir.join(aux.local_file_name);
            std::fs::copy(source, &destination).expect("stage pinned attribution file");
            crate::download::mark_model_verified_for_tests(&destination, aux.sha256)
                .await
                .expect("mark test attribution verified");
        }
        assert!(provider.is_available());

        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(corpus_root.join("manifest.json")).expect("read public corpus manifest"),
        )
        .expect("parse public corpus manifest");
        let clips = manifest["clips"].as_array().expect("clips array");
        assert_eq!(clips.len(), 8);
        let normalize_words = |text: &str| {
            text.split(|character: char| !character.is_alphanumeric())
                .filter(|word| !word.is_empty())
                .map(str::to_lowercase)
                .collect::<Vec<_>>()
        };
        let mut reference_word_count = 0usize;
        let mut observations = Vec::new();
        for clip in clips {
            let audio = std::fs::read(
                corpus_root.join(clip["audioFile"].as_str().expect("audio filename")),
            )
            .expect("read public audio");
            assert_eq!(
                hex::encode(Sha256::digest(&audio)),
                clip["wavSha256"].as_str().expect("audio digest")
            );
            let started = Instant::now();
            let result = provider
                .transcribe_bytes(&audio)
                .await
                .expect("transcribe clip");
            assert_eq!(result.actual_provider, AsrProviderType::TranscribeCpp);
            assert_eq!(result.model_id, ORUKEET_R3_GGUF_MODEL_ID);
            assert!(!result.text.trim().is_empty());
            let reference = clip["reference"].as_str().expect("reference transcript");
            let reference_words = normalize_words(reference);
            reference_word_count += reference_words.len();
            assert_eq!(normalize_words(&result.text), reference_words);
            assert_eq!(
                result.actual_engine.as_deref(),
                Some(expected_engine.as_str())
            );
            observations.push(serde_json::json!({
                "scope": "public-speech",
                "id": clip["id"],
                "audioSha256": clip["wavSha256"],
                "reference": reference,
                "recognitionMs": started.elapsed().as_millis(),
                "result": result,
            }));
        }
        assert!(reference_word_count >= 200);

        let silence_path = models_root.join("one-second-silence.wav");
        let silence_spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut silence =
            hound::WavWriter::create(&silence_path, silence_spec).expect("create silence fixture");
        for _ in 0..16_000 {
            silence.write_sample(0i16).expect("write silence sample");
        }
        silence.finalize().expect("finalize silence fixture");
        let result = provider
            .transcribe(&silence_path)
            .await
            .expect("transcribe silence");
        assert!(
            result.text.trim().is_empty(),
            "silence produced {:?}",
            result.text
        );
        assert_eq!(
            result.actual_engine.as_deref(),
            Some(expected_engine.as_str())
        );
        observations.push(serde_json::json!({
            "scope": "silence",
            "audioSha256": hex::encode(Sha256::digest(std::fs::read(&silence_path).expect("read silence"))),
            "result": result,
        }));

        let ami_path =
            PathBuf::from("/tmp/plainsong-ami-eval-20261003/ES2004a.Mix-Headset.first600s.wav");
        let ami_audio = std::fs::read(&ami_path).expect("read frozen public AMI excerpt");
        let ami_sha256 = hex::encode(Sha256::digest(&ami_audio));
        assert_eq!(
            ami_sha256,
            "54463cc2b337b9b47b6210de678cd0d9aa464d5b74b4f6c0099608dd60dde309"
        );
        let mut ami_reader = hound::WavReader::new(Cursor::new(ami_audio)).expect("open AMI wav");
        let ami_spec = ami_reader.spec();
        assert_eq!(
            (
                ami_spec.sample_rate,
                ami_spec.channels,
                ami_spec.bits_per_sample
            ),
            (16_000, 1, 16)
        );
        let ami_samples: Vec<i16> = ami_reader.samples::<i16>().map(Result::unwrap).collect();
        assert_eq!(ami_samples.len(), 600 * 16_000);
        for (index, chunk) in ami_samples.chunks(30 * 16_000).enumerate() {
            let mut wav = Cursor::new(Vec::new());
            {
                let mut writer = hound::WavWriter::new(&mut wav, ami_spec).expect("open AMI chunk");
                for sample in chunk {
                    writer.write_sample(*sample).expect("write AMI sample");
                }
                writer.finalize().expect("finalize AMI chunk");
            }
            let started = Instant::now();
            let result = provider
                .transcribe_bytes(wav.get_ref())
                .await
                .expect("transcribe AMI chunk");
            assert_eq!(
                result.actual_engine.as_deref(),
                Some(expected_engine.as_str())
            );
            observations.push(serde_json::json!({
                "scope": "ami-30-second-chunk",
                "sourceSha256": ami_sha256,
                "startSeconds": index * 30,
                "endSeconds": (index + 1) * 30,
                "recognitionMs": started.elapsed().as_millis(),
                "result": result,
            }));
        }
        assert_eq!(observations.len(), 29);
        let receipt_name = if backend == "cpu" {
            "production-orukeet-transcribe-cpp-0.2.3.json".to_string()
        } else {
            format!("production-orukeet-transcribe-cpp-0.2.3-{backend}.json")
        };
        std::fs::write(
            qualification_root.join(receipt_name),
            serde_json::to_vec_pretty(&serde_json::json!({
                "runtime": "transcribe-cpp 0.2.3",
                "backend": backend,
                "modelRevision": provider.spec().hf_revision,
                "modelSha256": provider.spec().sha256,
                "licenseSha256": ORUKEET_R3_AUXILIARY_SPECS[0].sha256,
                "noticeSha256": ORUKEET_R3_AUXILIARY_SPECS[1].sha256,
                "observations": observations,
            }))
            .expect("serialize production receipt"),
        )
        .expect("write production receipt");
        crate::shutdown_for_sidecar().await;
        assert!(
            cached_model_load_ms().is_none(),
            "the native model and session must be dropped before backend shutdown"
        );
    }

    /// Exercises the exact Unified GGUF through the production batch provider.
    /// Run once per backend by setting `PLAINSONG_TRANSCRIBE_CPP_BACKEND` to
    /// `cpu` or `metal`. `PLAINSONG_UNIFIED_PROBE_FIRST_ONLY=1` limits the run
    /// to the first public clip for a quick cross-backend comparison.
    #[tokio::test]
    #[ignore = "requires the pinned Unified GGUF, NVIDIA model card, and frozen public corpora"]
    async fn parakeet_unified_en_production_batch_provider_probe() {
        use sha2::{Digest, Sha256};
        use std::io::Cursor;

        let qualification_root = PathBuf::from("/tmp/plainsong-competitor-interface-20261003");
        let corpus_root = PathBuf::from("/tmp/plainsong-human-asr-20261003");
        let backend = std::env::var(BACKEND_ENV_VAR)
            .expect("production probe requires an explicit cpu or metal backend")
            .trim()
            .to_ascii_lowercase();
        assert!(matches!(backend.as_str(), "cpu" | "metal"));
        let expected_engine = format!("transcribe_cpp_{backend}");
        let first_only = std::env::var("PLAINSONG_UNIFIED_PROBE_FIRST_ONLY")
            .is_ok_and(|value| value.trim() == "1");
        let models_root = qualification_root.join(format!("unified-production-models-{backend}"));
        let provider = TranscribeCppProvider::with_models_root(
            &models_root,
            Some(PARAKEET_UNIFIED_EN_GGUF_MODEL_ID),
        );

        let source = qualification_root.join(provider.spec().file_name);
        let payload = std::fs::read(&source).expect("read pinned Unified GGUF");
        assert_eq!(payload.len() as u64, provider.spec().size_bytes);
        assert_eq!(
            hex::encode(Sha256::digest(&payload)),
            provider.spec().sha256
        );
        std::fs::create_dir_all(provider.model_path().parent().expect("model directory"))
            .expect("create model directory");
        std::fs::copy(&source, provider.model_path()).expect("stage pinned Unified GGUF");
        crate::download::mark_model_verified_for_tests(
            &provider.model_path(),
            provider.spec().sha256,
        )
        .await
        .expect("mark test model verified");
        for aux in auxiliary_specs_for(PARAKEET_UNIFIED_EN_GGUF_MODEL_ID) {
            let source = qualification_root.join(aux.local_file_name);
            let payload = std::fs::read(&source).expect("read pinned NVIDIA model card");
            assert_eq!(payload.len() as u64, aux.size_bytes);
            assert_eq!(hex::encode(Sha256::digest(&payload)), aux.sha256);
            let destination = provider.model_dir.join(aux.local_file_name);
            std::fs::copy(source, &destination).expect("stage pinned NVIDIA model card");
            crate::download::mark_model_verified_for_tests(&destination, aux.sha256)
                .await
                .expect("mark test attribution verified");
        }
        assert!(provider.is_available());

        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(corpus_root.join("manifest.json")).expect("read public corpus manifest"),
        )
        .expect("parse public corpus manifest");
        let clips = manifest["clips"].as_array().expect("clips array");
        assert_eq!(clips.len(), 8);
        let mut observations = Vec::new();
        let clip_limit = if first_only { 1 } else { clips.len() };
        for clip in clips.iter().take(clip_limit) {
            let audio = std::fs::read(
                corpus_root.join(clip["audioFile"].as_str().expect("audio filename")),
            )
            .expect("read public audio");
            assert_eq!(
                hex::encode(Sha256::digest(&audio)),
                clip["wavSha256"].as_str().expect("audio digest")
            );
            let started = Instant::now();
            let result = provider
                .transcribe_bytes(&audio)
                .await
                .expect("transcribe public clip");
            assert_eq!(result.actual_provider, AsrProviderType::TranscribeCpp);
            assert_eq!(result.model_id, PARAKEET_UNIFIED_EN_GGUF_MODEL_ID);
            assert_eq!(
                result.actual_engine.as_deref(),
                Some(expected_engine.as_str())
            );
            assert!(!result.text.trim().is_empty());
            assert!(
                !result.segments.is_empty(),
                "Unified advertises token timestamps, so speech must retain timed segments"
            );
            observations.push(serde_json::json!({
                "scope": "public-speech",
                "id": clip["id"],
                "audioSha256": clip["wavSha256"],
                "reference": clip["reference"],
                "recognitionMs": started.elapsed().as_millis(),
                "result": result,
            }));
        }

        if !first_only {
            let silence_path = models_root.join("one-second-silence.wav");
            let silence_spec = hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut silence = hound::WavWriter::create(&silence_path, silence_spec)
                .expect("create silence fixture");
            for _ in 0..16_000 {
                silence.write_sample(0i16).expect("write silence sample");
            }
            silence.finalize().expect("finalize silence fixture");
            let result = provider
                .transcribe(&silence_path)
                .await
                .expect("transcribe silence");
            assert!(
                result.text.trim().is_empty(),
                "silence produced {:?}",
                result.text
            );
            assert!(
                result.segments.is_empty(),
                "silence must not gain fake timed segments"
            );
            observations.push(serde_json::json!({"scope": "silence", "result": result}));

            let ami_path =
                PathBuf::from("/tmp/plainsong-ami-eval-20261003/ES2004a.Mix-Headset.first600s.wav");
            let ami_audio = std::fs::read(&ami_path).expect("read frozen public AMI excerpt");
            let ami_sha256 = hex::encode(Sha256::digest(&ami_audio));
            assert_eq!(
                ami_sha256,
                "54463cc2b337b9b47b6210de678cd0d9aa464d5b74b4f6c0099608dd60dde309"
            );
            let mut ami_reader =
                hound::WavReader::new(Cursor::new(ami_audio)).expect("open AMI wav");
            let ami_spec = ami_reader.spec();
            assert_eq!((ami_spec.sample_rate, ami_spec.channels), (16_000, 1));
            let ami_samples: Vec<i16> = ami_reader.samples::<i16>().map(Result::unwrap).collect();
            for (index, chunk) in ami_samples.chunks(30 * 16_000).take(20).enumerate() {
                let mut wav = Cursor::new(Vec::new());
                {
                    let mut writer =
                        hound::WavWriter::new(&mut wav, ami_spec).expect("open AMI chunk");
                    for sample in chunk {
                        writer.write_sample(*sample).expect("write AMI sample");
                    }
                    writer.finalize().expect("finalize AMI chunk");
                }
                let started = Instant::now();
                let result = provider
                    .transcribe_bytes(wav.get_ref())
                    .await
                    .expect("transcribe AMI chunk");
                assert_eq!(result.actual_provider, AsrProviderType::TranscribeCpp);
                assert_eq!(result.model_id, PARAKEET_UNIFIED_EN_GGUF_MODEL_ID);
                assert_eq!(
                    result.actual_engine.as_deref(),
                    Some(expected_engine.as_str())
                );
                observations.push(serde_json::json!({
                    "scope": "ami-30-second-chunk",
                    "sourceSha256": ami_sha256,
                    "startSeconds": index * 30,
                    "endSeconds": (index + 1) * 30,
                    "recognitionMs": started.elapsed().as_millis(),
                    "result": result,
                }));
            }
            assert_eq!(observations.len(), 29);
        }

        let receipt_name = if first_only {
            format!("production-unified-transcribe-cpp-0.2.3-{backend}-first.json")
        } else {
            format!("production-unified-transcribe-cpp-0.2.3-{backend}.json")
        };
        std::fs::write(
            qualification_root.join(receipt_name),
            serde_json::to_vec_pretty(&serde_json::json!({
                "runtime": "transcribe-cpp 0.2.3",
                "backend": backend,
                "modelRevision": provider.spec().hf_revision,
                "modelSha256": provider.spec().sha256,
                "attributionSha256": PARAKEET_UNIFIED_EN_AUXILIARY_SPECS[0].sha256,
                "observations": observations,
            }))
            .expect("serialize production receipt"),
        )
        .expect("write production receipt");
        crate::shutdown_for_sidecar().await;
        assert!(
            cached_model_load_ms().is_none(),
            "the native model and session must be dropped before backend shutdown"
        );
    }

    #[test]
    fn the_provider_is_rooted_at_the_models_directory_it_is_given() {
        let provider = TranscribeCppProvider::with_models_root(Path::new("/models"), None);
        assert_eq!(
            provider.model_path(),
            Path::new("/models/transcribe_cpp/parakeet-tdt-0.6b-v3-Q8_0.gguf")
        );
        assert!(!provider.is_available(), "nothing is on disk at /models");
    }

    /// The ordinary open: the worker reported its load time, so the thread is
    /// finishing and joining it costs nothing.
    #[test]
    fn a_worker_that_reports_its_load_time_is_joined() {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u64>>();
        ready_tx.send(Ok(512)).expect("send ready");
        let (disposition, outcome) =
            await_worker_ready(&ready_rx, Duration::from_secs(5), "nemotron.gguf");
        assert_eq!(disposition, WorkerDisposition::Join);
        assert_eq!(outcome.expect("a load time"), 512);
    }

    /// It answered with a failure -- a missing file, a non-streaming model --
    /// so it is on its way out and the error is the caller's.
    #[test]
    fn a_worker_that_reports_a_load_failure_is_joined() {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u64>>();
        ready_tx
            .send(Err(anyhow::anyhow!("could not read the weights")))
            .expect("send failure");
        let (disposition, outcome) =
            await_worker_ready(&ready_rx, Duration::from_secs(5), "nemotron.gguf");
        assert_eq!(disposition, WorkerDisposition::Join);
        assert!(outcome
            .expect_err("a failure")
            .to_string()
            .contains("could not read the weights"));
    }

    /// The worker died without a word. Its channel is gone, so joining is
    /// bounded and the caller still gets a named failure.
    #[test]
    fn a_worker_that_hangs_up_is_joined_and_named() {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u64>>();
        drop(ready_tx);
        let (disposition, outcome) =
            await_worker_ready(&ready_rx, Duration::from_secs(5), "nemotron.gguf");
        assert_eq!(disposition, WorkerDisposition::Join);
        assert!(outcome
            .expect_err("a failure")
            .to_string()
            .contains("nemotron.gguf"));
    }

    /// The finding this exists for: a `Model::load_with` that never returns
    /// used to park `open` forever on a blocking-pool thread, so the preview
    /// neither opened nor failed and every later stop paid the close timeout
    /// in full. The wait is now bounded and the thread is detached, exactly
    /// like a `feed` that stops answering.
    #[test]
    fn a_load_that_never_answers_times_out_and_detaches() {
        // Held open on purpose: a live sender with nothing to say is the
        // wedged load, not a hang-up.
        let (_ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u64>>();
        let started = Instant::now();
        let (disposition, outcome) =
            await_worker_ready(&ready_rx, Duration::from_millis(120), "nemotron.gguf");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the wait must be bounded by its timeout, not by the load"
        );
        assert_eq!(
            disposition,
            WorkerDisposition::Detach,
            "a thread that may still be inside the native load must not be joined"
        );
        let error = outcome.expect_err("a failure").to_string();
        assert!(error.contains("nemotron.gguf"), "{error}");
        assert!(error.contains("did not load"), "{error}");
    }

    /// The open path uses the same ceiling as every other call into the
    /// engine, so "the preview stopped answering" means one thing.
    #[test]
    fn the_open_wait_uses_the_same_ceiling_as_every_other_call() {
        const SOURCE: &str = include_str!("transcribe_cpp.rs");
        let start = SOURCE.find("    fn open(").expect("open must exist");
        let end = start
            + SOURCE[start..]
                .find("\n    }\n")
                .expect("open must be closed");
        let body = &SOURCE[start..end];
        assert!(
            body.contains("await_worker_ready(&ready_rx, STREAM_CALL_TIMEOUT"),
            "open must wait with the shared ceiling rather than blocking forever"
        );
        assert!(
            !body.contains("ready_rx.recv()"),
            "an unbounded recv on the ready channel is the wedge this replaced"
        );
    }

    /// Loads each optional English GGUF through the production provider, from
    /// the files staged for the `models-2026-10` release, and transcribes one
    /// clip. `PLAINSONG_OPTIONAL_ASR_STAGING_DIR` holds the GGUFs and their
    /// LICENSE/NOTICE files; `PLAINSONG_OPTIONAL_ASR_PROBE_WAV` is a 16 kHz
    /// mono WAV of English speech. Files are copied (APFS clones) into a
    /// temporary models root, never the user's data directory.
    #[tokio::test]
    #[ignore = "requires the staged optional GGUFs and an English WAV"]
    async fn optional_english_models_production_provider_probe() {
        struct Cleanup;
        impl Drop for Cleanup {
            fn drop(&mut self) {
                clear_cached_runtime();
            }
        }
        let _cleanup = Cleanup;
        let staging = PathBuf::from(
            std::env::var("PLAINSONG_OPTIONAL_ASR_STAGING_DIR").expect("explicit staging dir"),
        );
        let wav = PathBuf::from(
            std::env::var("PLAINSONG_OPTIONAL_ASR_PROBE_WAV").expect("explicit English WAV"),
        );
        let root = crate::test_fs::TempDir::new("optional-asr-probe");
        for model_id in [
            FLUID_SPEECH_MINI_GGUF_MODEL_ID,
            UNDERDOG_BARK_PRO_GGUF_MODEL_ID,
        ] {
            let provider = TranscribeCppProvider::with_models_root(root.path(), Some(model_id));
            std::fs::create_dir_all(&provider.model_dir).unwrap();
            let mut assets = vec![(provider.spec().file_name, provider.spec().sha256)];
            assets.extend(
                auxiliary_specs_for(model_id)
                    .iter()
                    .map(|aux| (aux.local_file_name, aux.sha256)),
            );
            for (name, digest) in assets {
                let path = provider.model_dir.join(name);
                std::fs::copy(staging.join(name), &path).unwrap();
                assert!(
                    crate::download::verify_or_record_model_integrity(&path, Some(digest))
                        .await
                        .unwrap(),
                    "{name} does not match its pin"
                );
            }
            assert!(provider.is_available());
            let result = provider.transcribe(&wav).await.unwrap();
            assert_eq!(result.model_id, model_id);
            assert_eq!(result.language, "en");
            assert!(
                !result.text.trim().is_empty(),
                "{model_id} returned no text"
            );
            assert!(!result.text.contains("<unk>"), "{}", result.text);
            println!("{model_id}: {}", result.text);
        }
    }
}
