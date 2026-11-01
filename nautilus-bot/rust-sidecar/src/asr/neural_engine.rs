//! Parakeet's Core ML build, through a signed helper process.
//!
//! The ggml route (`transcribe_cpp`) keeps Parakeet TDT 0.6B's weights and
//! working buffers in this process: about 1 GB for dictation and 2.6-3.1 GB
//! through a meeting. The same model compiled for Core ML runs in
//! `plainsong-native-asr-helper` (FluidAudio, Apache-2.0), on the Neural
//! Engine on most Macs and on the CPU on the Light tier (8 GB Macs). On the
//! Neural Engine, macOS wires 600-900 MiB of model memory outside any
//! process, which does not fit the Light tier's dictation budget; on the CPU
//! the weights stay clean file-backed pages and the helper's own footprint
//! is tens of MiB, at unchanged word error (2026-10-25 measurements:
//! `artifacts/continuation-2026-10-20/opus-loop/realistic-hardware/ane-memory/report.md`).
//! See the lane receipts for candidate-bound footprint and latency results.
//!
//! What this module owns:
//!
//! - the pinned Core ML model files (Parakeet v3 multilingual, and v2 for
//!   people who dictate in English only), their download and integrity
//!   check, and a "prepared" marker written after the helper has compiled
//!   them for this Mac's Neural Engine;
//! - one helper process at most, spoken to over stdio, loaded on demand and
//!   stopped when idle (`speech_residency`) or when a fallback needs the
//!   memory;
//! - the decision whether the route can run at all. Anything it cannot do --
//!   an Intel Mac, macOS before 14, a missing helper, a compile that failed on
//!   this macOS build, a helper that crashed -- leaves the ggml route to run
//!   exactly as before;
//! - which copy a Parakeet download fetches. Where this route runs, Download
//!   fetches only the Core ML build (and the vocabulary model where it
//!   applies). The ggml file then comes only when this Mac needs it: the
//!   route failed or cannot run here, or an override forces ggml
//!   ([`fetch_ggml_if_needed`]). A ggml file already on disk is never removed.
//!
//! The user sees one "Parakeet" choice; none of this is named in the UI.

use crate::download::VerifiedModelArtifact;
use anyhow::{Context, Result};
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, MutexGuard, OnceLock, TryLockError};
use std::time::{Duration, Instant};

/// Directory under `models/` holding one sub-directory per Core ML model.
pub(crate) const MODEL_DIR: &str = "neural_engine";

pub(crate) const HELPER_BINARY_NAME: &str = "plainsong-native-asr-helper";
/// Version 3 adds `computeUnits` to `load`. A version 2 helper is refused at
/// the handshake (the ggml route serves): it could not honour a CPU-only
/// load, and on the Light tier silently running the Neural Engine instead
/// would bust the dictation budget.
pub(crate) const HELPER_PROTOCOL_VERSION: u64 = 3;
/// The FluidAudio release the helper is built from (`Package.swift`).
pub(crate) const HELPER_ENGINE_VERSION: &str = "0.17.7";

/// `ggml` forces the ggml route, `neural_engine` refuses to fall back (QA
/// only). Unset: Core ML when ready, or after CPU preparation on Light;
/// ggml remains a fallback when Core ML cannot serve.
pub(crate) const RUNTIME_ENV_VAR: &str = "PLAINSONG_PARAKEET_RUNTIME";

const PREPARED_MARKER: &str = ".plainsong-prepared.json";

/// A first compile for the Neural Engine took 14 s on an M4 Pro; slower
/// chips and a busy Mac get generous room before the load is called stuck.
const LOAD_TIMEOUT: Duration = Duration::from_secs(240);
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SAMPLE_COUNT: usize = 16_000 * 60 * 120;

/// Decode runs at roughly 150x real time; the budget is ~10x slower than that
/// measurement plus a floor for a cold machine.
const TRANSCRIBE_TIMEOUT_FLOOR: Duration = Duration::from_secs(20);

/// After the helper fails, the ggml route serves until the backoff ends. It
/// doubles with each consecutive failure, so a helper that fails the same way
/// every time costs a few attempts a day, not one every few minutes.
const FAILURE_BACKOFF_BASE: Duration = Duration::from_secs(10 * 60);
const FAILURE_BACKOFF_MAX: Duration = Duration::from_secs(6 * 60 * 60);

/// Consecutive failed loads of one model on one macOS build before the model
/// is recorded as unable to run here (until the next macOS update).
const LOAD_FAILURES_BEFORE_GIVING_UP: u32 = 3;

/// How often a request waiting for the speech route retries it.
const ROUTE_ACQUIRE_POLL_INTERVAL: Duration = Duration::from_millis(20);

/// A prewarm is nobody's dictation yet: it waits this long for the route.
const PREWARM_ROUTE_WAIT: Duration = Duration::from_secs(30);

/// A compile that cannot start (speech in progress, not enough memory) tries
/// again this often, for at most `PREPARE_DEFER_LIMIT`.
const PREPARE_DEFER_INTERVAL: Duration = Duration::from_secs(30);
const PREPARE_DEFER_LIMIT: Duration = Duration::from_secs(2 * 60 * 60);

/// Admission allowances for the helper's memory, which lives outside this
/// process (helper, Neural Engine driver and, on a first compile, Apple's
/// compiler service). Measured peaks (2026-10-25, ane-memory report): a
/// first Neural Engine compile peaks at 905-937 MiB combined (helper plus
/// wired rise plus ANECompilerService); a cache-warm Neural Engine load
/// peaks at 778-971 MiB, the worst with the vocabulary model. The warm
/// allowance includes driver memory outside the helper, not just the
/// helper's own physical footprint.
const COLD_LOAD_ALLOWANCE: u64 = 1_300 * 1024 * 1024;
const WARM_LOAD_ALLOWANCE: u64 = 1_152 * 1024 * 1024;
/// The same model with `computeUnits = cpuOnly` (Light tier) wires nothing:
/// Core ML maps its ~1.2 GiB of weights as clean file-backed pages, which
/// stay reclaimable and never enter the helper's `phys_footprint` (measured
/// ~20 MiB loaded, 72 MiB peak). Those pages are not claimed here: they are
/// not memory the load allocates, and charging the file's size would refuse
/// loads that measurably fit. The allowances are the measured helper
/// footprint plus a decode's working set: a cold load peaks at 116-246 MiB
/// combined (no ANECompilerService runs on this route), and a warm load
/// needs the ~72 MiB helper peak plus the per-request decode scratch
/// [`RESIDENT_DECODE_ALLOWANCE`] covers on its own.
const CPU_ONLY_COLD_LOAD_ALLOWANCE: u64 = 320 * 1024 * 1024;
const CPU_ONLY_WARM_LOAD_ALLOWANCE: u64 = 256 * 1024 * 1024;
/// Added to a request's allowance while the vocabulary model is loaded: its
/// 101 MB of weights, held by the Neural Engine driver outside the helper,
/// plus the frame scores and term tables the helper keeps per request.
const VOCABULARY_MODEL_ALLOWANCE: u64 = 160 * 1024 * 1024;
/// A decode on a helper that already holds its model: room for the
/// features, encoder output and decoder state of one request, beside the
/// protocol copies counted separately. The model's own 1 GiB is already in
/// use, and so already missing from free memory; claiming it again for
/// every decode refused warm dictations on an 8 GB Mac that had room.
const RESIDENT_DECODE_ALLOWANCE: u64 = 128 * 1024 * 1024;
/// The per-request part of [`VOCABULARY_MODEL_ALLOWANCE`] once the
/// vocabulary model is loaded: frame scores and term tables.
const RESIDENT_VOCABULARY_ALLOWANCE: u64 = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Compute units
// ---------------------------------------------------------------------------

/// Which compute units the helper loads the Core ML model with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ComputeUnits {
    /// The Neural Engine (decoder, joint and encoder). macOS wires the
    /// model's memory outside any process: 599-817 MiB for the v3 build.
    CpuAndNeuralEngine,
    /// The CPU. Nothing is wired; the weights stay clean file-backed pages
    /// and the helper's own footprint is ~20-40 MiB. Decode is ~2x slower
    /// (94 ms vs 51 ms on a 10 s clip) at unchanged word error (7.25% on the
    /// 98-clip dictation corpus, identical transcripts on 95 of them).
    CpuOnly,
}

impl ComputeUnits {
    /// The value the helper's `load` request carries (protocol version 3).
    fn request_value(self) -> &'static str {
        match self {
            Self::CpuAndNeuralEngine => "cpuAndNeuralEngine",
            Self::CpuOnly => "cpuOnly",
        }
    }

    /// The engine name diagnostics and receipts report for this route, so a
    /// Light-tier receipt never claims the Neural Engine did the work.
    pub(crate) fn engine_name(self) -> &'static str {
        match self {
            Self::CpuAndNeuralEngine => "neural_engine",
            Self::CpuOnly => "coreml_cpu",
        }
    }

    /// The allowance for loading the model with these units, cold (a first
    /// compile on the Neural Engine route) or cache-warm.
    fn cold_load_allowance(self) -> u64 {
        match self {
            Self::CpuAndNeuralEngine => COLD_LOAD_ALLOWANCE,
            Self::CpuOnly => CPU_ONLY_COLD_LOAD_ALLOWANCE,
        }
    }

    fn warm_load_allowance(self) -> u64 {
        match self {
            Self::CpuAndNeuralEngine => WARM_LOAD_ALLOWANCE,
            Self::CpuOnly => CPU_ONLY_WARM_LOAD_ALLOWANCE,
        }
    }
}

/// The Light tier runs the Core ML route on the CPU: the Neural Engine's
/// wired memory would push dictation past the tier's 1 GiB budget (~1.2-1.4
/// GiB effective measured, against ~575 MiB on the CPU). `hardware_tier`
/// honours the QA memory simulation, so the footprint gate exercises this.
pub(crate) fn compute_units() -> ComputeUnits {
    compute_units_for_tier(crate::hardware_tier::current())
}

fn compute_units_for_tier(tier: crate::hardware_tier::HardwareTier) -> ComputeUnits {
    match tier {
        crate::hardware_tier::HardwareTier::Light => ComputeUnits::CpuOnly,
        crate::hardware_tier::HardwareTier::Balanced | crate::hardware_tier::HardwareTier::Best => {
            ComputeUnits::CpuAndNeuralEngine
        }
    }
}

/// The engine name the Parakeet Core ML route reports on this Mac.
pub(crate) fn speech_engine_name() -> &'static str {
    compute_units().engine_name()
}

// ---------------------------------------------------------------------------
// Pinned models
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Family {
    /// Parakeet TDT 0.6B v3: 25 European languages.
    Multilingual,
    /// Parakeet TDT 0.6B v2: English only, FluidAudio's English recommendation.
    English,
}

#[derive(Debug)]
pub(crate) struct CoreMlFile {
    pub(crate) path: &'static str,
    pub(crate) size: u64,
    pub(crate) sha256: &'static str,
}

#[derive(Debug)]
pub(crate) struct ModelSpec {
    pub(crate) family: Family,
    pub(crate) model_id: &'static str,
    pub(crate) repo: &'static str,
    pub(crate) revision: &'static str,
    /// The model's name in history and results.
    pub(crate) display_name: &'static str,
    /// What the helper's `load` request calls this family.
    pub(crate) helper_family: &'static str,
    /// Which encoder build the helper loads: `int8` (`Encoder.mlmodelc`) or
    /// `int8-v2` (`Encoder_v2.mlmodelc`, v3 only).
    pub(crate) encoder: &'static str,
    pub(crate) files: &'static [CoreMlFile],
}

const PARAKEET_V3_COREML_REVISION: &str = "7dd20fe6b1797d35f5e3307e8b1732d9a178edfe";
const PARAKEET_V2_COREML_REVISION: &str = "ee09c569f73759e6d44c9bd16766f477b2b36d39";

/// FluidAudio's per-channel int8 encoder rebuild, rather than its default
/// palettized encoder. Quality and total system memory need candidate-bound
/// measurements; helper footprint alone does not establish either.
const PARAKEET_V3_COREML_FILES: &[CoreMlFile] = &[
    CoreMlFile {
        path: "Decoder.mlmodelc/analytics/coremldata.bin",
        size: 243,
        sha256: "4238c4e81ecd0dc94bd7dfbb60f7e2cc824107c1ffe0387b8607b72833dba350",
    },
    CoreMlFile {
        path: "Decoder.mlmodelc/coremldata.bin",
        size: 554,
        sha256: "18647af085d87bd8f3121c8a9b4d4564c1ede038dab63d295b4e745cf2d7fb99",
    },
    CoreMlFile {
        path: "Decoder.mlmodelc/metadata.json",
        size: 3427,
        sha256: "a39e93cd8371b8ded92635c7804fcd0590f0d1dd9415c6d19a0484be073077d9",
    },
    CoreMlFile {
        path: "Decoder.mlmodelc/model.mil",
        size: 13110,
        sha256: "ef2a0a281695398a62fde86ac269c68f73d5b578d7ed3b31f2ba91a2d1ea1f35",
    },
    CoreMlFile {
        path: "Decoder.mlmodelc/weights/weight.bin",
        size: 23604992,
        sha256: "48adf0f0d47c406c8253d4f7fef967436a39da14f5a65e66d5a4b407be355d41",
    },
    CoreMlFile {
        path: "Encoder_v2.mlmodelc/analytics/coremldata.bin",
        size: 243,
        sha256: "af98d71151609799efbbffc00112fcba4bd91adf0b01135a982c574e91822f9c",
    },
    CoreMlFile {
        path: "Encoder_v2.mlmodelc/coremldata.bin",
        size: 478,
        sha256: "70628bd4fd25fb554cc0cebc31356723930c885480132bf3ecd1b5dbe71dd0a2",
    },
    CoreMlFile {
        path: "Encoder_v2.mlmodelc/model.mil",
        size: 1002653,
        sha256: "abc621390840dd064e6833dc098101706621e47e17119ead904f8c383211dd1d",
    },
    CoreMlFile {
        path: "Encoder_v2.mlmodelc/weights/weight.bin",
        size: 594211328,
        sha256: "8d2c79e15a4545e08fe3a21fe741e42b8bf24329db81de8fdfacd92388ea5a66",
    },
    CoreMlFile {
        path: "JointDecisionv3.mlmodelc/analytics/coremldata.bin",
        size: 243,
        sha256: "26def4bf73dd56d29dee21c8ef97cb8969e62f6120ed1adc91e46828e2737b6c",
    },
    CoreMlFile {
        path: "JointDecisionv3.mlmodelc/coremldata.bin",
        size: 521,
        sha256: "f5fc08b741400f0088492c9e839418b1e18522f19cba28d361dd030c5f398342",
    },
    CoreMlFile {
        path: "JointDecisionv3.mlmodelc/metadata.json",
        size: 3453,
        sha256: "d9307211b9a37e0f0ac260c7660b1571a3de25841035cfdf9b58fd40425f890f",
    },
    CoreMlFile {
        path: "JointDecisionv3.mlmodelc/model.mil",
        size: 11775,
        sha256: "be60732943389a047175111a83f8839f3eb39d4803adafa828a0871b2f39818d",
    },
    CoreMlFile {
        path: "JointDecisionv3.mlmodelc/weights/weight.bin",
        size: 12642764,
        sha256: "4e0e63d840032f7f07ddb1d64446051166281e5491bf22da8a945c41f6eedb3e",
    },
    CoreMlFile {
        path: "Preprocessor.mlmodelc/analytics/coremldata.bin",
        size: 243,
        sha256: "c9beeb989c8d66f8be11df59bc6df277ec76cee404f6865b46243835ef562f6d",
    },
    CoreMlFile {
        path: "Preprocessor.mlmodelc/coremldata.bin",
        size: 486,
        sha256: "dbde3f2300842c1fd51ef3ff948a0bcffe65ffd2dca10707f2509f32c1d65b1d",
    },
    CoreMlFile {
        path: "Preprocessor.mlmodelc/metadata.json",
        size: 2841,
        sha256: "2a98699e22d279dd37fa1d238aeb1c6db1df0d6fad687775324157689d8f3acf",
    },
    CoreMlFile {
        path: "Preprocessor.mlmodelc/model.mil",
        size: 28181,
        sha256: "4b8518a956450fec57f06c2a21bdffc26973f7f1fa6842fb38fe917f896b6b93",
    },
    CoreMlFile {
        path: "Preprocessor.mlmodelc/weights/weight.bin",
        size: 491072,
        sha256: "129b76e3aeafa8afa3ea76d995b964b145fe83700d579f6ff42c4c38fa0968ea",
    },
    CoreMlFile {
        path: "parakeet_vocab.json",
        size: 151122,
        sha256: "7ec60e05f1b24480736ec0eed40900f4626bce1fa9a60fd700ec7e2a59198735",
    },
];

const PARAKEET_V2_COREML_FILES: &[CoreMlFile] = &[
    CoreMlFile {
        path: "Decoder.mlmodelc/analytics/coremldata.bin",
        size: 243,
        sha256: "46de1a6fe2e49d19a2125bc91acf020df7f2aea84ba821532aade8427a440b05",
    },
    CoreMlFile {
        path: "Decoder.mlmodelc/coremldata.bin",
        size: 554,
        sha256: "d200ca07694a347f6d02a3886a062ae839831e094e443222f2e48a14945966a8",
    },
    CoreMlFile {
        path: "Decoder.mlmodelc/metadata.json",
        size: 3427,
        sha256: "90a279b822496316458febc0ce761ab05954fadd9d66aa97bea077a35fc8f2b2",
    },
    CoreMlFile {
        path: "Decoder.mlmodelc/model.mil",
        size: 13106,
        sha256: "7b95a5a6b672c652000348a67b6d4d92bb8e176b978c6666fe73c28a4d7ec579",
    },
    CoreMlFile {
        path: "Decoder.mlmodelc/weights/weight.bin",
        size: 14429952,
        sha256: "27d26890221d82322c1092fd99d7b40578e435d5cf4b83c887c42603caf97aba",
    },
    CoreMlFile {
        path: "Encoder.mlmodelc/analytics/coremldata.bin",
        size: 243,
        sha256: "42e638870d73f26b332918a3496ce36793fbb413a81cbd3d16ba01328637a105",
    },
    CoreMlFile {
        path: "Encoder.mlmodelc/coremldata.bin",
        size: 485,
        sha256: "4def7aa848599ad0e17a8b9a982edcdbf33cf92e1f4b798de32e2ca0bc74b030",
    },
    CoreMlFile {
        path: "Encoder.mlmodelc/metadata.json",
        size: 2926,
        sha256: "58222fbc48c13c49d9715567803cd50cb9c23e4360462e0f8ffcea59a2c73c63",
    },
    CoreMlFile {
        path: "Encoder.mlmodelc/model.mil",
        size: 959769,
        sha256: "ed7b19156ca29fa7dfd6891deb9fda4b0e8893f68597c985d135736546a43808",
    },
    CoreMlFile {
        path: "Encoder.mlmodelc/weights/weight.bin",
        size: 445187200,
        sha256: "4adc7ad44f9d05e1bffeb2b06d3bb02861a5c7602dff63a6b494aed3bf8a6c3e",
    },
    CoreMlFile {
        path: "JointDecision.mlmodelc/analytics/coremldata.bin",
        size: 243,
        sha256: "f1183ba213bb94a918c8d2cad19ab045320618f97f6ca662245b3936d7b090f7",
    },
    CoreMlFile {
        path: "JointDecision.mlmodelc/coremldata.bin",
        size: 534,
        sha256: "e2c6752f1c8cf2d3f6f26ec93195c9bfa759ad59edf9f806696a138154f96f11",
    },
    CoreMlFile {
        path: "JointDecision.mlmodelc/metadata.json",
        size: 2936,
        sha256: "ba8d309417b9acd4a175fdb15687de6a941db2f5b06666a60e7cf3cc8e2d3c3c",
    },
    CoreMlFile {
        path: "JointDecision.mlmodelc/model.mil",
        size: 9722,
        sha256: "93bf82042235127cb81ab537dcae47a1c2e7e242ce4ffdaf772981b45eedc4f0",
    },
    CoreMlFile {
        path: "JointDecision.mlmodelc/weights/weight.bin",
        size: 3453388,
        sha256: "ca22a65903a05e64137677da608077578a8606090a598abf4875fa6199aaa19d",
    },
    CoreMlFile {
        path: "Preprocessor.mlmodelc/analytics/coremldata.bin",
        size: 243,
        sha256: "03ab3c1327a054c54c07a40325db967ec574f2c91dcc8192bfa44aa561bcf2d8",
    },
    CoreMlFile {
        path: "Preprocessor.mlmodelc/coremldata.bin",
        size: 494,
        sha256: "d88ea1fc349459c9e100d6a96688c5b29a1f0d865f544be103001724b986b6d6",
    },
    CoreMlFile {
        path: "Preprocessor.mlmodelc/metadata.json",
        size: 2974,
        sha256: "fb16c581ff5e1b962e7cb2181ed892cd32f9f84c12b6e80ff3e089f28e35bcbb",
    },
    CoreMlFile {
        path: "Preprocessor.mlmodelc/model.mil",
        size: 27166,
        sha256: "3e06d16fd061294c8a75be68c43a3b1ed1f593d4a9c35249e9cdbccadc59721e",
    },
    CoreMlFile {
        path: "Preprocessor.mlmodelc/weights/weight.bin",
        size: 298880,
        sha256: "a5f7df6c7f47147ae9486fe18cc7792f9a44d093ec3c6a11e91ef2dc363c48dc",
    },
    CoreMlFile {
        path: "parakeet_vocab.json",
        size: 18762,
        sha256: "57019fe3c745772ca83a1b048a4bb951cd51329504ea33d4d83316b96e279a97",
    },
];

pub(crate) const PARAKEET_V3_COREML: ModelSpec = ModelSpec {
    family: Family::Multilingual,
    model_id: "parakeet-tdt-0.6b-v3-coreml",
    repo: "FluidInference/parakeet-tdt-0.6b-v3-coreml",
    revision: PARAKEET_V3_COREML_REVISION,
    display_name: "Parakeet TDT 0.6B v3",
    helper_family: "v3",
    encoder: "int8-v2",
    files: PARAKEET_V3_COREML_FILES,
};

pub(crate) const PARAKEET_V2_COREML: ModelSpec = ModelSpec {
    family: Family::English,
    model_id: "parakeet-tdt-0.6b-v2-coreml",
    repo: "FluidInference/parakeet-tdt-0.6b-v2-coreml",
    revision: PARAKEET_V2_COREML_REVISION,
    display_name: "Parakeet TDT 0.6B v2",
    helper_family: "v2",
    encoder: "int8",
    files: PARAKEET_V2_COREML_FILES,
};

pub(crate) const MODEL_SPECS: [&ModelSpec; 2] = [&PARAKEET_V3_COREML, &PARAKEET_V2_COREML];

const PARAKEET_CTC_VOCABULARY_REVISION: &str = "accdafd8cf8a2ff1cabe3c11e54416b405d409aa";

/// Parakeet CTC 110M (English, CC-BY-4.0): scores the user's vocabulary
/// against the audio beside the transducer decode. Only the mel and encoder
/// graphs, the vocabulary and the tokenizer; the repository's optional
/// head-only graph is not fetched and the helper refuses a folder holding one.
const PARAKEET_CTC_VOCABULARY_FILES: &[CoreMlFile] = &[
    CoreMlFile {
        path: "AudioEncoder.mlmodelc/analytics/coremldata.bin",
        size: 243,
        sha256: "8906c823e9bb3bf6b16d9f0308f98cd70573526333ad85dd767dc3f9ae6b25fa",
    },
    CoreMlFile {
        path: "AudioEncoder.mlmodelc/coremldata.bin",
        size: 505,
        sha256: "a88b002b58193b4c31211754cdfdf220a85f9651dc61caf336ab84400cbc191a",
    },
    CoreMlFile {
        path: "AudioEncoder.mlmodelc/metadata.json",
        size: 3456,
        sha256: "4f288bfe5cbe867ef1e592cdae33578b2fe59ada69182fc12209879558f985c2",
    },
    CoreMlFile {
        path: "AudioEncoder.mlmodelc/model.mil",
        size: 1060924,
        sha256: "2f84ef93a69115e55f3b5d8ce695b3c937de1833d4d229620634fae967cd587e",
    },
    CoreMlFile {
        path: "AudioEncoder.mlmodelc/weights/weight.bin",
        size: 100778304,
        sha256: "af0734b4a5d7465ad9e8bb170f0c53c5e6b91ebb75a9bdf88d3f59ae4ad6aebd",
    },
    CoreMlFile {
        path: "MelSpectrogram.mlmodelc/analytics/coremldata.bin",
        size: 243,
        sha256: "22f2a8cba1de25c984050566b534a1d8caf22a82f9fe6c1c6f3149a0dd7e8ae3",
    },
    CoreMlFile {
        path: "MelSpectrogram.mlmodelc/coremldata.bin",
        size: 330,
        sha256: "3a32ec67c76aa0aa2faef518413c311493e89aeb7fa11289fa4b8653ab8a160c",
    },
    CoreMlFile {
        path: "MelSpectrogram.mlmodelc/metadata.json",
        size: 1962,
        sha256: "5e11d21a65c02bcfc37db43e941978e5d60d59e0efeadfda08e41f33b4f835d3",
    },
    CoreMlFile {
        path: "MelSpectrogram.mlmodelc/model.mil",
        size: 12584,
        sha256: "0a7cb5693b39667295218bac5c7c09053f6bcd4b32699a83d06ac35d14ac6b79",
    },
    CoreMlFile {
        path: "MelSpectrogram.mlmodelc/weights/weight.bin",
        size: 567712,
        sha256: "0a89c055bfde9022029d3cc59a23e949385e063974460d8eaec3a7614c3eaaa8",
    },
    CoreMlFile {
        path: "config.json",
        size: 121,
        sha256: "1fd77c83ea89285c242608d95a7992f146867481adc3938be730a064f3a63305",
    },
    CoreMlFile {
        path: "tokenizer.json",
        size: 360106,
        sha256: "9f7c517c0bf644b1b690ab037bab4d4c53aecd38e047e7154d011013ab9160db",
    },
    CoreMlFile {
        path: "vocab.json",
        size: 16086,
        sha256: "319d386eead79aadc80df9c3ecc8340d1a727efb7c02a8847eb940380dd61e1f",
    },
];

/// Not a route: it never transcribes, so it is not in [`MODEL_SPECS`].
pub(crate) const PARAKEET_CTC_VOCABULARY: ModelSpec = ModelSpec {
    family: Family::English,
    model_id: "parakeet-ctc-110m-coreml",
    repo: "FluidInference/parakeet-ctc-110m-coreml",
    revision: PARAKEET_CTC_VOCABULARY_REVISION,
    display_name: "Parakeet CTC 110M",
    helper_family: VOCABULARY_HELPER_FAMILY,
    encoder: "ctc",
    files: PARAKEET_CTC_VOCABULARY_FILES,
};

const VOCABULARY_HELPER_FAMILY: &str = "vocabulary";

impl ModelSpec {
    pub(crate) fn dir(&self, models_root: &Path) -> PathBuf {
        models_root.join(MODEL_DIR).join(self.model_id)
    }

    fn url(&self, file: &CoreMlFile) -> String {
        format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            self.repo, self.revision, file.path
        )
    }

    pub(crate) fn total_bytes(&self) -> u64 {
        self.files.iter().map(|file| file.size).sum()
    }

    /// Every file is on disk and this session has not found it wrong.
    pub(crate) fn files_installed(&self, models_root: &Path) -> bool {
        let dir = self.dir(models_root);
        self.files.iter().all(|file| {
            crate::download::is_model_artifact_installed(&dir.join(file.path), Some(file.sha256))
        })
    }

    fn spec_for(family: Family) -> &'static ModelSpec {
        match family {
            Family::Multilingual => &PARAKEET_V3_COREML,
            Family::English => &PARAKEET_V2_COREML,
        }
    }
}

/// Pinned (path, sha256) pairs for the startup integrity sweep.
pub(crate) fn model_integrity_artifacts(models_root: &Path) -> Vec<(PathBuf, String)> {
    MODEL_SPECS
        .iter()
        .chain(std::iter::once(&&PARAKEET_CTC_VOCABULARY))
        .flat_map(|spec| {
            let dir = spec.dir(models_root);
            spec.files
                .iter()
                .map(move |file| (dir.join(file.path), file.sha256.to_string()))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Preferences: which family, mirrored from settings
// ---------------------------------------------------------------------------

static ENGLISH_ONLY: AtomicBool = AtomicBool::new(false);

/// Mirror the transcription language from settings. English users get the
/// English model (FluidAudio's recommendation for English); everyone else,
/// including auto-detect, gets the multilingual one.
pub(crate) fn set_transcription_language(language: Option<&str>) {
    ENGLISH_ONLY.store(language_is_english(language), Ordering::Release);
    VOCABULARY_MODEL_WANTED.store(language_may_be_english(language), Ordering::Release);
}

/// English, or automatic detection (which hears English for most people).
pub(crate) fn language_may_be_english(language: Option<&str>) -> bool {
    language
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("auto"))
        .is_none_or(|_| language_is_english(language))
}

pub(crate) fn language_is_english(language: Option<&str>) -> bool {
    language
        .map(str::trim)
        .and_then(|value| value.split(['-', '_']).next())
        .is_some_and(|base| base.eq_ignore_ascii_case("en"))
}

pub(crate) fn preferred_family() -> Family {
    if ENGLISH_ONLY.load(Ordering::Acquire) {
        Family::English
    } else {
        Family::Multilingual
    }
}

// ---------------------------------------------------------------------------
// Platform support
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RuntimeOverride {
    Auto,
    Ggml,
    NeuralEngine,
}

pub(crate) fn runtime_override() -> RuntimeOverride {
    parse_runtime_override(std::env::var(RUNTIME_ENV_VAR).ok().as_deref())
}

fn parse_runtime_override(value: Option<&str>) -> RuntimeOverride {
    match value.map(str::trim) {
        Some("ggml") => RuntimeOverride::Ggml,
        Some("neural_engine") => RuntimeOverride::NeuralEngine,
        _ => RuntimeOverride::Auto,
    }
}

/// `kern.osproductversion`, e.g. "27.2", or `None` off macOS.
fn macos_product_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let mut buffer = [0u8; 64];
        let mut size = buffer.len();
        // The name is a NUL-terminated static; the buffer is local and sized.
        let status = unsafe {
            libc::sysctlbyname(
                c"kern.osproductversion".as_ptr(),
                buffer.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if status != 0 || size == 0 {
            return None;
        }
        let text = std::str::from_utf8(&buffer[..size.min(buffer.len())]).ok()?;
        Some(text.trim_end_matches('\0').trim().to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// `kern.osversion`, the build ("26B5112a"). The Neural Engine's compiled
/// program cache is keyed by it, so a macOS update needs a fresh compile.
fn macos_build() -> String {
    #[cfg(target_os = "macos")]
    {
        let mut buffer = [0u8; 64];
        let mut size = buffer.len();
        // The name is a NUL-terminated static; the buffer is local and sized.
        let status = unsafe {
            libc::sysctlbyname(
                c"kern.osversion".as_ptr(),
                buffer.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if status == 0 && size > 0 {
            if let Ok(text) = std::str::from_utf8(&buffer[..size.min(buffer.len())]) {
                return text.trim_end_matches('\0').trim().to_string();
            }
        }
    }
    "unknown".to_string()
}

pub(crate) fn macos_major_supported(version: Option<&str>) -> bool {
    version
        .and_then(|value| value.split('.').next())
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major >= 14)
}

/// Apple Silicon, macOS 14 or later (FluidAudio's floor), and the helper is
/// where this build expects it.
pub(crate) fn platform_supported() -> bool {
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
        && macos_major_supported(macos_product_version().as_deref())
        && resolve_helper().is_ok()
}

/// Candidate helper locations, packaged first. Inside a packaged `.app` there
/// is exactly one legitimate path, as for the other native helpers.
pub(crate) fn helper_candidates(executable: &Path, repo_root: Option<&Path>) -> Vec<PathBuf> {
    if let Some(app_root) = executable.ancestors().find(|ancestor| {
        ancestor
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
    }) {
        return vec![app_root
            .join("Contents")
            .join("Resources")
            .join("asr-helper")
            .join(HELPER_BINARY_NAME)];
    }
    let mut candidates = Vec::new();
    if let Some(root) = repo_root {
        candidates.push(root.join("dist-native").join(HELPER_BINARY_NAME));
    }
    if let Some(directory) = executable.parent() {
        candidates.push(directory.join(HELPER_BINARY_NAME));
    }
    candidates
}

fn resolve_helper() -> Result<PathBuf> {
    static RESOLVED: OnceLock<Option<PathBuf>> = OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            let executable = std::env::current_exe().ok()?;
            let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(Path::to_path_buf);
            helper_candidates(&executable, repo_root.as_deref())
                .into_iter()
                .find(|candidate| candidate.is_file())
        })
        .clone()
        .context("The speech helper is not installed with this build")
}

// ---------------------------------------------------------------------------
// Preparation (compiling for the Neural Engine) and readiness
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreparedMarker {
    os_build: String,
    engine_version: String,
    /// The encoder build that was compiled; another one needs its own compile.
    #[serde(default)]
    encoder: String,
    /// The compute units the model was prepared with. A Neural Engine
    /// prepare caches the compiled ANE program; a CPU prepare only proves
    /// the model loads. Neither says anything about the other, so a tier
    /// change re-prepares. Markers from before this field was recorded are
    /// Neural Engine prepares.
    #[serde(default = "default_marker_compute_units")]
    compute_units: String,
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    load_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PrepareState {
    /// Compiled on this macOS build: a load takes a fraction of a second.
    Prepared,
    /// Never compiled here, or compiled before a macOS update.
    NeedsPrepare,
    /// The compile failed on this macOS build; the ggml route serves.
    Failed(String),
}

fn default_marker_compute_units() -> String {
    ComputeUnits::CpuAndNeuralEngine.request_value().to_string()
}

fn read_marker(dir: &Path) -> Option<PreparedMarker> {
    let bytes = std::fs::read(dir.join(PREPARED_MARKER)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn prepare_state_for(
    marker: Option<&PreparedMarker>,
    os_build: &str,
    encoder: &str,
    units: ComputeUnits,
) -> PrepareState {
    match marker {
        Some(marker)
            if marker.os_build == os_build
                && marker.engine_version == HELPER_ENGINE_VERSION
                && marker.encoder == encoder
                && marker.compute_units == units.request_value() =>
        {
            if marker.ok {
                PrepareState::Prepared
            } else {
                PrepareState::Failed(marker.error.clone().unwrap_or_default())
            }
        }
        _ => PrepareState::NeedsPrepare,
    }
}

pub(crate) fn prepare_state(models_root: &Path, spec: &ModelSpec) -> PrepareState {
    prepare_state_with_units(models_root, spec, compute_units())
}

fn prepare_state_with_units(
    models_root: &Path,
    spec: &ModelSpec,
    units: ComputeUnits,
) -> PrepareState {
    prepare_state_for(
        read_marker(&spec.dir(models_root)).as_ref(),
        &macos_build(),
        spec.encoder,
        units,
    )
}

fn write_json_atomically(dir: &Path, name: &str, value: &impl serde::Serialize) {
    let path = dir.join(name);
    match serde_json::to_vec_pretty(value) {
        Ok(bytes) => {
            let temp = dir.join(format!("{name}.tmp"));
            if std::fs::write(&temp, bytes)
                .and_then(|()| std::fs::rename(&temp, &path))
                .is_err()
            {
                tracing::warn!("Could not record the speech model's preparation state");
            }
        }
        Err(error) => tracing::warn!("Could not encode the preparation state: {error}"),
    }
}

fn write_marker(dir: &Path, marker: &PreparedMarker) {
    write_json_atomically(dir, PREPARED_MARKER, marker);
}

fn marker_for(
    spec: &ModelSpec,
    os_build: &str,
    units: ComputeUnits,
    outcome: Result<u64, String>,
) -> PreparedMarker {
    let (ok, error, load_ms) = match outcome {
        Ok(load_ms) => (true, None, Some(load_ms)),
        Err(reason) => (false, Some(reason.chars().take(300).collect()), None),
    };
    PreparedMarker {
        os_build: os_build.to_string(),
        engine_version: HELPER_ENGINE_VERSION.to_string(),
        encoder: spec.encoder.to_string(),
        compute_units: units.request_value().to_string(),
        ok,
        error,
        load_ms,
    }
}

/// Failed loads in a row of one model on one macOS build. Kept on disk so a
/// helper that fails the same way at every launch still reaches the limit.
const LOAD_FAILURES_FILE: &str = ".plainsong-load-failures.json";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadFailures {
    os_build: String,
    engine_version: String,
    encoder: String,
    count: u32,
}

/// Count one failed load (or compile) that might not happen again: a timeout,
/// a crash, a kill under memory pressure. Only the limit-th in a row records
/// the model as unable to run on this macOS build. Returns the count.
fn note_load_failure(
    dir: &Path,
    spec: &ModelSpec,
    os_build: &str,
    units: ComputeUnits,
    reason: &str,
) -> u32 {
    let previous = std::fs::read(dir.join(LOAD_FAILURES_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<LoadFailures>(&bytes).ok())
        .filter(|record| {
            record.os_build == os_build
                && record.engine_version == HELPER_ENGINE_VERSION
                && record.encoder == spec.encoder
        })
        .map_or(0, |record| record.count);
    let count = previous.saturating_add(1);
    if count >= LOAD_FAILURES_BEFORE_GIVING_UP {
        write_marker(
            dir,
            &marker_for(
                spec,
                os_build,
                units,
                Err(format!("{count} loads in a row failed; the last: {reason}")),
            ),
        );
        clear_load_failures(dir);
        tracing::warn!(
            "{} failed to load {count} times in a row; it stays on the ggml route until the next macOS update",
            spec.model_id
        );
    } else {
        write_json_atomically(
            dir,
            LOAD_FAILURES_FILE,
            &LoadFailures {
                os_build: os_build.to_string(),
                engine_version: HELPER_ENGINE_VERSION.to_string(),
                encoder: spec.encoder.to_string(),
                count,
            },
        );
    }
    count
}

fn clear_load_failures(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(LOAD_FAILURES_FILE));
}

/// The Core ML model the Parakeet route should use now, or `None` when the
/// ggml route must serve. Cheap enough for every request: a few `stat`s and
/// one small file read.
pub(crate) fn route_spec(models_root: &Path) -> Option<&'static ModelSpec> {
    route_spec_for_family(models_root, preferred_family())
}

pub(crate) fn family_for_language(language: Option<&str>) -> Family {
    if language_is_english(language) {
        Family::English
    } else {
        Family::Multilingual
    }
}

pub(crate) fn route_spec_for_family(
    models_root: &Path,
    family: Family,
) -> Option<&'static ModelSpec> {
    if !route_usable_now() {
        return None;
    }
    // Readiness, status and live preview all ask this, so it only reads:
    // compiling is the background worker's job (`schedule_prepare_if_needed`).
    family_candidates(family).iter().copied().find(|spec| {
        spec.files_installed(models_root)
            && prepare_state(models_root, spec) == PrepareState::Prepared
    })
}

/// This Mac runs Parakeet on the Core ML route at all: Apple Silicon,
/// macOS 14 or later, the helper present, and no override forcing ggml.
pub(crate) fn route_supported() -> bool {
    route_supported_with(runtime_override(), platform_supported())
}

fn route_supported_with(runtime: RuntimeOverride, platform_supported: bool) -> bool {
    runtime != RuntimeOverride::Ggml && platform_supported
}

/// [`route_supported`], and not backing off after a failure.
fn route_usable_now() -> bool {
    route_supported() && !in_failure_backoff()
}

/// Light-tier requests prepare trusted CPU models on first use even when a
/// GGUF is installed. An unprepared model is not a broken model. Other tiers
/// keep serving GGUF while the longer ANE compile runs in the background.
pub(crate) fn request_spec_for_family(
    models_root: &Path,
    family: Family,
    ggml_ready: bool,
) -> Option<&'static ModelSpec> {
    if !route_usable_now() {
        return None;
    }
    request_spec_with_units(models_root, family, ggml_ready, compute_units())
}

fn request_spec_with_units(
    models_root: &Path,
    family: Family,
    ggml_ready: bool,
    units: ComputeUnits,
) -> Option<&'static ModelSpec> {
    let candidates = family_candidates(family);
    let find = |state| {
        candidates.iter().copied().find(|spec| {
            spec.files_installed(models_root)
                && prepare_state_with_units(models_root, spec, units) == state
        })
    };
    find(PrepareState::Prepared).or_else(|| {
        (!ggml_ready || units == ComputeUnits::CpuOnly)
            .then(|| find(PrepareState::NeedsPrepare))
            .flatten()
    })
}

/// Parakeet can serve `family` from the Core ML build alone: now, or once a
/// first request has compiled it. Reads only, like [`route_spec_for_family`].
pub(crate) fn serves_without_ggml(models_root: &Path, family: Family) -> bool {
    request_spec_for_family(models_root, family, false).is_some()
}

/// The next request on `family` compiles the model before it decodes, and no
/// ggml file serves meanwhile. Dictation shows "Preparing model" for it.
pub(crate) fn first_use_compile_pending(
    models_root: &Path,
    family: Family,
    ggml_ready: bool,
) -> bool {
    request_spec_for_family(models_root, family, ggml_ready)
        .is_some_and(|spec| prepare_state(models_root, spec) == PrepareState::NeedsPrepare)
}

/// A Core ML build that can serve `family` is on this Mac, where the route
/// can use it. Whether it serves right now is [`serves_without_ggml`].
pub(crate) fn coreml_files_present(models_root: &Path, family: Family) -> bool {
    route_supported()
        && family_candidates(family)
            .iter()
            .any(|spec| spec.files_installed(models_root))
}

/// Record that this macOS build refused to compile `spec`, as `prepare_with`
/// does, for tests outside this module.
#[cfg(test)]
pub(crate) fn mark_refused_for_test(models_root: &Path, spec: &ModelSpec) {
    write_marker(
        &spec.dir(models_root),
        &marker_for(
            spec,
            &macos_build(),
            compute_units(),
            Err("refused".to_string()),
        ),
    );
}

/// Whether the Core ML bundle in `models/neural_engine/<model_id>` is
/// complete, for the Models screen's list of what is on disk.
pub(crate) fn bundle_installed(models_root: &Path, model_id: &str) -> bool {
    MODEL_SPECS
        .iter()
        .copied()
        .chain(std::iter::once(&PARAKEET_CTC_VOCABULARY))
        .find(|spec| spec.model_id == model_id)
        .is_some_and(|spec| spec.files_installed(models_root))
}

fn family_candidates(family: Family) -> &'static [&'static ModelSpec] {
    match family {
        // English speech decodes fine on the multilingual model too.
        Family::English => &[&PARAKEET_V2_COREML, &PARAKEET_V3_COREML],
        Family::Multilingual => &[&PARAKEET_V3_COREML],
    }
}

/// After a request, compile a verified model that has not been prepared on
/// this macOS build yet (an interrupted first run, a macOS update), in the
/// background. Until it finishes, the ggml route serves.
pub(crate) fn schedule_prepare_if_needed(models_root: &Path, family: Family) {
    if !route_supported() {
        return;
    }
    if let Some(spec) = family_candidates(family).iter().copied().find(|spec| {
        spec.files_installed(models_root)
            && prepare_state(models_root, spec) == PrepareState::NeedsPrepare
    }) {
        schedule_background_prepare(models_root, spec);
    }
}

static PREPARE_BACKOFF: Mutex<Backoff> = Mutex::new(Backoff::new());

/// Compile `spec` on a background thread, at most one at a time. A compile
/// that cannot start yet is retried every `PREPARE_DEFER_INTERVAL`; one that
/// failed waits out an exponential backoff before the next trigger runs it.
fn schedule_background_prepare(models_root: &Path, spec: &'static ModelSpec) {
    static IN_FLIGHT: AtomicBool = AtomicBool::new(false);
    if cfg!(test) {
        return;
    }
    if lock_backoff(&PREPARE_BACKOFF).active(Instant::now()) {
        return;
    }
    if IN_FLIGHT.swap(true, Ordering::AcqRel) {
        return;
    }
    let root = models_root.to_path_buf();
    let spawned = std::thread::Builder::new()
        .name("speech-model-prepare".to_string())
        .spawn(move || {
            let outcome = prepare_until_settled(
                || prepare_blocking(&root, spec),
                PREPARE_DEFER_INTERVAL,
                PREPARE_DEFER_LIMIT,
                std::thread::sleep,
            );
            match outcome {
                Ok(()) => lock_backoff(&PREPARE_BACKOFF).succeed(),
                Err(NeuralError::Engine(failure)) => {
                    let delay =
                        lock_backoff(&PREPARE_BACKOFF).fail(Instant::now(), &failure.reason);
                    tracing::info!(
                        "Preparing {} failed; next attempt in at least {}s: {failure}",
                        spec.model_id,
                        delay.as_secs()
                    );
                    // A compile this macOS build refuses leaves Parakeet with
                    // nothing to run on unless the ggml file is here.
                    if spec.helper_family != VOCABULARY_HELPER_FAMILY {
                        fetch_ggml_if_needed(&root, spec.family);
                    }
                }
                Err(NeuralError::Admission(error)) => {
                    tracing::info!("Preparing {} deferred: {error:#}", spec.model_id);
                }
            }
            IN_FLIGHT.store(false, Ordering::Release);
        });
    if spawned.is_err() {
        IN_FLIGHT.store(false, Ordering::Release);
    }
}

/// Run `attempt` until it settles. `Admission` means "not now" (speech in
/// progress, not enough memory): wait `interval` and try again, for at most
/// `limit` in all.
pub(crate) fn prepare_until_settled(
    mut attempt: impl FnMut() -> Result<(), NeuralError>,
    interval: Duration,
    limit: Duration,
    mut sleep: impl FnMut(Duration),
) -> Result<(), NeuralError> {
    let mut waited = Duration::ZERO;
    let mut identity_retried = false;
    loop {
        match attempt() {
            Err(NeuralError::Engine(failure)) if failure.identity_changed && !identity_retried => {
                identity_retried = true;
                sleep(Duration::from_secs(1));
            }
            Err(NeuralError::Admission(_)) if waited < limit => {
                sleep(interval);
                waited += interval;
            }
            settled => return settled,
        }
    }
}

/// Whether the route could serve right now, for the startup log.
pub(crate) fn status(models_root: &Path) -> serde_json::Value {
    let specs: Vec<serde_json::Value> = MODEL_SPECS
        .iter()
        .map(|spec| {
            let state = prepare_state(models_root, spec);
            serde_json::json!({
                "modelId": spec.model_id,
                "filesTrusted": spec.files_installed(models_root),
                "prepared": state == PrepareState::Prepared,
                "prepareFailed": matches!(state, PrepareState::Failed(_)),
                "downloadBytes": spec.total_bytes(),
            })
        })
        .collect();
    let (failures, last_failure) = {
        let backoff = lock_backoff(&ROUTE_BACKOFF);
        (backoff.consecutive, backoff.last_reason.clone())
    };
    serde_json::json!({
        "platformSupported": platform_supported(),
        "active": route_spec(models_root).map(|spec| spec.model_id),
        "helperRunning": helper_is_running(),
        "consecutiveFailures": failures,
        "lastFailure": last_failure,
        "models": specs,
    })
}

// ---------------------------------------------------------------------------
// Failure backoff
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct Backoff {
    consecutive: u32,
    until: Option<Instant>,
    /// For logs and diagnostics only; never shown in the UI.
    last_reason: Option<String>,
}

impl Backoff {
    const fn new() -> Self {
        Self {
            consecutive: 0,
            until: None,
            last_reason: None,
        }
    }

    fn active(&self, now: Instant) -> bool {
        self.until.is_some_and(|until| now < until)
    }

    fn fail(&mut self, now: Instant, reason: &str) -> Duration {
        self.consecutive = self.consecutive.saturating_add(1);
        let delay = backoff_delay(self.consecutive);
        self.until = Some(now + delay);
        self.last_reason = Some(reason.chars().take(300).collect());
        delay
    }

    fn succeed(&mut self) {
        self.consecutive = 0;
        self.until = None;
    }
}

fn backoff_delay(consecutive: u32) -> Duration {
    let doublings = consecutive.saturating_sub(1).min(16);
    FAILURE_BACKOFF_BASE
        .saturating_mul(1u32 << doublings)
        .min(FAILURE_BACKOFF_MAX)
}

fn lock_backoff(backoff: &'static Mutex<Backoff>) -> MutexGuard<'static, Backoff> {
    backoff.lock().unwrap_or_else(|e| e.into_inner())
}

static ROUTE_BACKOFF: Mutex<Backoff> = Mutex::new(Backoff::new());

fn in_failure_backoff() -> bool {
    if runtime_override() == RuntimeOverride::NeuralEngine {
        return false;
    }
    lock_backoff(&ROUTE_BACKOFF).active(Instant::now())
}

/// Send the next requests to ggml until the backoff ends. Never blocks: the
/// request that failed already dropped its helper on its own blocking thread,
/// so this is safe to call from async code.
pub(crate) fn record_failure(failure: &EngineFailure) {
    let delay = lock_backoff(&ROUTE_BACKOFF).fail(Instant::now(), &failure.reason);
    tracing::warn!(
        "The Neural Engine speech route failed, using the ggml route for {}s: {failure}",
        delay.as_secs()
    );
}

fn record_success() {
    lock_backoff(&ROUTE_BACKOFF).succeed();
}

// ---------------------------------------------------------------------------
// The helper process
// ---------------------------------------------------------------------------

struct HelperProcess {
    child: Child,
    stdin: ChildStdin,
    responses: mpsc::Receiver<std::io::Result<String>>,
    loaded: Option<LoadedModel>,
    /// The vocabulary model is loaded beside the transducer.
    vocabulary_loaded: bool,
    last_used: Instant,
}

/// The model the helper holds, with the compute units it was loaded with:
/// the same directory loaded with other units is a different model to the
/// helper and must be reloaded, not reused.
#[derive(Clone, Debug, PartialEq, Eq)]
struct LoadedModel {
    dir: PathBuf,
    units: ComputeUnits,
}

impl Drop for HelperProcess {
    fn drop(&mut self) {
        // Closing stdin asks for a clean exit; kill covers a wedged helper.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// Lock order: route, compile, helper, ggml cache. Both runtimes hold the
// route through decode so a fallback cannot recreate a second resident copy.
// The background compile runs in its own helper process and never takes it.
pub(crate) fn route_gate() -> &'static Mutex<()> {
    static GATE: Mutex<()> = Mutex::new(());
    &GATE
}

/// One compile at a time: the background one, or a request's first load of a
/// model nothing else can serve. Each costs the route's cold-load allowance.
fn compile_slot() -> &'static Mutex<()> {
    // Tests run in parallel and several hold a compile for seconds with a
    // fake helper; one slot per test thread keeps them from refusing each
    // other while each still exercises the slot.
    #[cfg(test)]
    {
        thread_local! {
            static SLOT: &'static Mutex<()> = Box::leak(Box::new(Mutex::new(())));
        }
        SLOT.with(|slot| *slot)
    }
    #[cfg(not(test))]
    {
        static SLOT: Mutex<()> = Mutex::new(());
        &SLOT
    }
}

/// Wait for a running compile, on the terms of [`acquire_route`].
fn acquire_compile_slot(
    abandoned: &AtomicBool,
    deadline: Instant,
) -> Result<MutexGuard<'static, ()>, super::transcribe_cpp::DecodeStop> {
    loop {
        match compile_slot().try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(error)) => return Ok(error.into_inner()),
            Err(TryLockError::WouldBlock) => {
                super::transcribe_cpp::check_decode_control(abandoned, deadline)?;
                std::thread::sleep(ROUTE_ACQUIRE_POLL_INTERVAL);
            }
        }
    }
}

/// Take the speech route, but give up when the caller abandons the request or
/// `deadline` passes, the same way the ggml route waits for its runtime.
pub(crate) fn acquire_route(
    abandoned: &AtomicBool,
    deadline: Instant,
) -> Result<MutexGuard<'static, ()>, super::transcribe_cpp::DecodeStop> {
    loop {
        match route_gate().try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(error)) => return Ok(error.into_inner()),
            Err(TryLockError::WouldBlock) => {
                super::transcribe_cpp::check_decode_control(abandoned, deadline)?;
                std::thread::sleep(ROUTE_ACQUIRE_POLL_INTERVAL);
            }
        }
    }
}

fn route_wait_error(stop: super::transcribe_cpp::DecodeStop) -> NeuralError {
    NeuralError::Admission(match stop {
        super::transcribe_cpp::DecodeStop::Cancelled => {
            anyhow::anyhow!("Transcription was cancelled before it finished.")
        }
        super::transcribe_cpp::DecodeStop::DeadlineExceeded => anyhow::anyhow!(
            "Parakeet is still busy with another recording. Wait for it to finish and try again."
        ),
    })
}

/// Whether dictation or a meeting is using speech recognition right now.
fn speech_in_use() -> bool {
    matches!(route_gate().try_lock(), Err(TryLockError::WouldBlock))
        || crate::llm::local_model_load::user_is_waiting_on_speech()
}

fn helper_slot() -> &'static Mutex<Option<HelperProcess>> {
    static SLOT: OnceLock<Mutex<Option<HelperProcess>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn lock_helper() -> MutexGuard<'static, Option<HelperProcess>> {
    match helper_slot().lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            helper_slot().clear_poison();
            let mut guard = poisoned.into_inner();
            guard.take();
            guard
        }
    }
}

pub(crate) fn helper_is_running() -> bool {
    match helper_slot().try_lock() {
        Ok(guard) => guard.is_some(),
        Err(TryLockError::WouldBlock) => true,
        Err(TryLockError::Poisoned(_)) => false,
    }
}

/// Stop the helper and release its models. Waits for an in-flight request.
/// Core ML's system services may retain compiled caches after the child exits;
/// system-wide memory measurements must include that residual use.
pub(crate) fn stop_helper() {
    if lock_helper().take().is_some() {
        tracing::info!("Stopped the speech helper");
    }
}

/// Apply residency to the loaded compute units. Never waits for a busy
/// helper, so pressure and timer checks cannot interrupt a request.
pub(crate) fn release_if_idle(policy: super::speech_residency::ReleasePolicy) -> bool {
    let _route = match route_gate().try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::Poisoned(error)) => error.into_inner(),
        Err(TryLockError::WouldBlock) => return false,
    };
    let mut guard = match helper_slot().try_lock() {
        Ok(guard) => guard,
        Err(_) => return false,
    };
    release_idle_helper(&mut guard, policy)
}

fn release_idle_helper(
    slot: &mut Option<HelperProcess>,
    policy: super::speech_residency::ReleasePolicy,
) -> bool {
    use super::speech_residency::SpeechRoute;
    let stale = slot.as_ref().is_some_and(|helper| {
        let route = match helper.loaded.as_ref().map(|model| model.units) {
            Some(ComputeUnits::CpuOnly) => SpeechRoute::CoreMlCpu,
            _ => SpeechRoute::Other,
        };
        policy
            .release_after(route)
            .is_some_and(|idle| helper.last_used.elapsed() >= idle)
    });
    if stale {
        slot.take();
    }
    stale
}

#[derive(Debug)]
pub(crate) enum NeuralError {
    /// Plainsong's own memory admission said no. Not a helper failure: the
    /// caller retries or reports exactly as it would for the ggml route.
    Admission(anyhow::Error),
    /// The helper, the model or the protocol failed. The ggml route serves.
    Engine(EngineFailure),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EngineFailure {
    pub(crate) reason: String,
    /// The helper itself answered that it cannot do this. A timeout, a
    /// crash, a kill under memory pressure or garbled output is not a
    /// refusal: the same request may well succeed later.
    pub(crate) refused: bool,
    pub(crate) identity_changed: bool,
}

impl std::fmt::Display for EngineFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.reason)
    }
}

impl std::fmt::Display for NeuralError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Admission(error) => write!(f, "{error:#}"),
            Self::Engine(failure) => failure.fmt(f),
        }
    }
}

pub(crate) fn engine(error: impl std::fmt::Display) -> NeuralError {
    NeuralError::Engine(EngineFailure {
        reason: error.to_string(),
        refused: false,
        identity_changed: false,
    })
}

fn model_file_error(error: anyhow::Error) -> NeuralError {
    NeuralError::Engine(EngineFailure {
        identity_changed: crate::download::is_model_artifact_changed(&error),
        reason: format!("{error:#}"),
        refused: false,
    })
}

fn refused(error: impl std::fmt::Display) -> NeuralError {
    NeuralError::Engine(EngineFailure {
        reason: error.to_string(),
        refused: true,
        identity_changed: false,
    })
}

fn spawn_helper() -> Result<HelperProcess, NeuralError> {
    let path = resolve_helper().map_err(engine)?;
    let child = Command::new(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| engine(format!("could not start the speech helper: {error}")))?;
    let mut helper = connect_helper(child)?;
    handshake(&mut helper)?;
    super::speech_residency::ensure_idle_release();
    Ok(helper)
}

/// The helper is up and speaks this build's protocol.
fn handshake(helper: &mut HelperProcess) -> Result<(), NeuralError> {
    let hello = request(
        helper,
        &serde_json::json!({ "op": "hello" }),
        &[],
        HELLO_TIMEOUT,
    )?;
    let version = hello
        .get("protocolVersion")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if hello.get("engine").and_then(serde_json::Value::as_str) != Some("fluidaudio")
        || hello
            .get("engineVersion")
            .and_then(serde_json::Value::as_str)
            != Some(HELPER_ENGINE_VERSION)
    {
        return Err(engine("the speech helper engine does not match this build"));
    }
    if version != HELPER_PROTOCOL_VERSION {
        return Err(engine(format!(
            "the speech helper speaks protocol {version}, this build expects {HELPER_PROTOCOL_VERSION}"
        )));
    }
    Ok(())
}

fn connect_helper(mut child: Child) -> Result<HelperProcess, NeuralError> {
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| engine("no helper stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| engine("no helper stdout"))?;
    #[cfg(unix)]
    {
        let fd = stdin.as_raw_fd();
        // This pipe is owned by this helper. A stuck reader must not defeat
        // the request deadline while we send its audio payload.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            let error = std::io::Error::last_os_error();
            let _ = child.kill();
            let _ = child.wait();
            return Err(engine(error));
        }
    }
    let (sender, responses) = mpsc::sync_channel(1);
    let reader_thread = std::thread::Builder::new()
        .name("speech-helper-reader".into())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match (&mut reader)
                    .take(MAX_RESPONSE_BYTES + 1)
                    .read_line(&mut line)
                {
                    Ok(0) => break,
                    Ok(_) => {
                        if line.len() as u64 > MAX_RESPONSE_BYTES || !line.ends_with('\n') {
                            let _ = sender.send(Err(std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                "invalid speech helper response frame",
                            )));
                            break;
                        }
                        if sender.send(Ok(line)).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(Err(error));
                        break;
                    }
                }
            }
        });
    if let Err(error) = reader_thread {
        let _ = child.kill();
        let _ = child.wait();
        return Err(engine(error));
    }
    Ok(HelperProcess {
        child,
        stdin,
        responses,
        loaded: None,
        vocabulary_loaded: false,
        last_used: Instant::now(),
    })
}

fn request(
    helper: &mut HelperProcess,
    body: &serde_json::Value,
    payload: &[u8],
    timeout: Duration,
) -> Result<serde_json::Value, NeuralError> {
    let mut line = serde_json::to_vec(body).map_err(engine)?;
    line.push(b'\n');
    let deadline = Instant::now() + timeout;
    write_before_deadline(&mut helper.stdin, &line, deadline).map_err(engine)?;
    write_before_deadline(&mut helper.stdin, payload, deadline).map_err(engine)?;
    let response = match helper
        .responses
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
    {
        Ok(Ok(line)) => line,
        Ok(Err(error)) => return Err(engine(format!("could not read the speech helper: {error}"))),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            return Err(engine(format!(
                "the speech helper did not answer within {}s",
                timeout.as_secs()
            )))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let status = helper.child.try_wait().ok().flatten();
            return Err(engine(format!("the speech helper exited ({status:?})")));
        }
    };
    let value: serde_json::Value = serde_json::from_str(response.trim()).map_err(|error| {
        engine(format!(
            "the speech helper answered with something unreadable: {error}"
        ))
    })?;
    if value.get("op") != body.get("op") {
        return Err(engine("the speech helper answered a different operation"));
    }
    if value.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        let code = value
            .get("code")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown");
        let message = value
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("no detail");
        return Err(refused(format!(
            "the speech helper refused ({code}): {message}"
        )));
    }
    Ok(value)
}

fn write_before_deadline(
    writer: &mut ChildStdin,
    mut bytes: &[u8],
    deadline: Instant,
) -> std::io::Result<()> {
    while !bytes.is_empty() {
        if Instant::now() >= deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "speech helper write deadline exceeded",
            ));
        }
        match writer.write(bytes) {
            Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
            Ok(n) => bytes = &bytes[n..],
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                #[cfg(unix)]
                {
                    let mut event = libc::pollfd {
                        fd: writer.as_raw_fd(),
                        events: libc::POLLOUT,
                        revents: 0,
                    };
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    let millis = remaining.as_millis().clamp(1, i32::MAX as u128) as i32;
                    // The pipe is nonblocking. Wait for capacity without adding
                    // a fixed sleep to every audio packet in the dictation path.
                    let status = unsafe { libc::poll(&mut event, 1, millis) };
                    if status < 0 {
                        let error = std::io::Error::last_os_error();
                        if error.kind() != std::io::ErrorKind::Interrupted {
                            return Err(error);
                        }
                    }
                }
                #[cfg(not(unix))]
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// Make sure the helper is running with `spec` loaded, returning the load
/// time when this call loaded it. The caller holds admission through its
/// entire operation, including any decode after this load.
fn ensure_loaded(
    slot: &mut Option<HelperProcess>,
    models_root: &Path,
    spec: &ModelSpec,
) -> Result<Option<u64>, NeuralError> {
    let dir = spec.dir(models_root);
    let units = compute_units();
    let loaded = slot.as_ref().is_some_and(|helper| {
        helper.loaded.as_ref()
            == Some(&LoadedModel {
                dir: dir.clone(),
                units,
            })
    });
    let verified = if loaded {
        Vec::new()
    } else {
        verify_spec_files(models_root, spec)?
    };
    let result = ensure_loaded_with(
        slot,
        models_root,
        spec,
        units,
        &macos_build(),
        spawn_helper,
        || evict_resident_parakeet(models_root),
        LOAD_TIMEOUT,
    );
    match &result {
        Ok(_) => {
            if let Err(error) = confirm_spec_files(&verified) {
                // The helper may have read other bytes; it is not kept.
                slot.take();
                return Err(engine(format!("{error:#}")));
            }
        }
        Err(_) => verified.iter().for_each(VerifiedModelArtifact::forget),
    }
    result
}

/// Core ML opens the model folder by path in the Swift helper, so the helper
/// cannot be handed descriptors. Every file is hashed (once per session) and
/// held open before the helper loads, and [`confirm_spec_files`] then
/// requires each path to still name the file that was checked. A swap that
/// is undone before that check is not caught: the residual gap of a
/// path-based loader.
fn verify_spec_files(
    models_root: &Path,
    spec: &ModelSpec,
) -> Result<Vec<VerifiedModelArtifact>, NeuralError> {
    let dir = spec.dir(models_root);
    spec.files
        .iter()
        .map(|file| {
            crate::download::open_verified_model_artifact(&dir.join(file.path), file.sha256)
                .map_err(model_file_error)
        })
        .collect()
}

fn confirm_spec_files(verified: &[VerifiedModelArtifact]) -> anyhow::Result<()> {
    verified
        .iter()
        .try_for_each(VerifiedModelArtifact::confirm_path_unchanged)
}

/// Never two copies of the model: the in-process copies go before the
/// helper loads its own.
fn evict_resident_parakeet(models_root: &Path) {
    super::transcribe_cpp::clear_cached_parakeet_runtime(models_root);
    super::parakeet::clear_cached_model_runtime(models_root, "parakeet-tdt-0.6b-v3");
    super::parakeet::clear_cached_model_runtime(models_root, "parakeet-tdt-0.6b-v2");
}

fn load_request(dir: &Path, spec: &ModelSpec, units: ComputeUnits) -> serde_json::Value {
    if spec.helper_family == VOCABULARY_HELPER_FAMILY {
        return serde_json::json!({
            "op": "loadVocabularyModel",
            "modelDir": dir.to_string_lossy(),
        });
    }
    serde_json::json!({
        "op": "load",
        "modelDir": dir.to_string_lossy(),
        "family": spec.helper_family,
        "encoder": spec.encoder,
        "computeUnits": units.request_value(),
    })
}

#[allow(clippy::too_many_arguments)]
fn ensure_loaded_with(
    slot: &mut Option<HelperProcess>,
    models_root: &Path,
    spec: &ModelSpec,
    units: ComputeUnits,
    os_build: &str,
    spawn: impl FnOnce() -> Result<HelperProcess, NeuralError>,
    evict: impl FnOnce(),
    load_timeout: Duration,
) -> Result<Option<u64>, NeuralError> {
    let dir = spec.dir(models_root);
    if let Some(helper) = slot.as_mut() {
        // The helper holds the model only if the compute units match too: a
        // tier change reloads rather than reuses the other units' model.
        if helper.loaded.as_ref()
            == Some(&LoadedModel {
                dir: dir.clone(),
                units,
            })
        {
            helper.last_used = Instant::now();
            return Ok(None);
        }
    }
    let result = (|| {
        if slot.is_none() {
            // `spawn` returns only after the helper's hello, so a helper that
            // cannot start leaves the resident ggml model where it is.
            *slot = Some(spawn()?);
        }
        evict();
        let helper = slot.as_mut().expect("helper was just started");
        let response = request(helper, &load_request(&dir, spec, units), &[], load_timeout)?;
        helper.loaded = Some(LoadedModel {
            dir: dir.clone(),
            units,
        });
        helper.last_used = Instant::now();
        Ok(response.get("loadMs").and_then(serde_json::Value::as_u64))
    })();
    match &result {
        Ok(_) => clear_load_failures(&dir),
        Err(NeuralError::Engine(failure)) => {
            note_load_failure(&dir, spec, os_build, units, &failure.reason);
        }
        Err(NeuralError::Admission(_)) => {}
    }
    result
}

/// Load the route's model now, so the first words of a dictation are not
/// waiting on it.
pub(crate) fn prewarm(models_root: &Path, spec: &ModelSpec) -> Result<(), NeuralError> {
    let never_abandoned = AtomicBool::new(false);
    let _route = acquire_route(&never_abandoned, Instant::now() + PREWARM_ROUTE_WAIT)
        .map_err(route_wait_error)?;
    let with_vocabulary = vocabulary_model_ready(models_root);
    let _admission = crate::llm::local_model_load::admit_neural_engine_speech(
        compute_units().warm_load_allowance()
            + if with_vocabulary {
                VOCABULARY_MODEL_ALLOWANCE
            } else {
                0
            },
    )
    .map_err(NeuralError::Admission)?;
    let mut slot = lock_helper();
    let result = ensure_loaded(&mut slot, models_root, spec).map(|_| ());
    if result.is_ok() && with_vocabulary {
        let helper = slot.as_mut().expect("helper is loaded");
        if let Err(error) = ensure_vocabulary_loaded(helper, models_root) {
            // Dictation works without it: the next request decodes plainly.
            tracing::info!("The vocabulary model did not load: {error}");
        }
    }
    match &result {
        Ok(()) => record_success(),
        Err(NeuralError::Engine(_)) => {
            slot.take();
        }
        Err(NeuralError::Admission(_)) => {}
    }
    result
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NeuralWord {
    pub(crate) text: String,
    pub(crate) start_ms: i64,
    pub(crate) end_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NeuralTranscript {
    pub(crate) text: String,
    pub(crate) words: Vec<NeuralWord>,
    pub(crate) processing_ms: u64,
    pub(crate) load_ms: Option<u64>,
    pub(crate) vocabulary_candidates: Vec<super::VocabularyCandidate>,
}

fn parse_transcript(value: &serde_json::Value) -> Result<NeuralTranscript, NeuralError> {
    let text = value
        .get("text")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| engine("the speech helper returned no text"))?
        .trim()
        .to_string();
    let words: Option<Vec<NeuralWord>> = value
        .get("words")
        .and_then(serde_json::Value::as_array)
        .and_then(|rows| {
            rows.iter()
                .map(|row| {
                    Some(NeuralWord {
                        text: row.get("text")?.as_str()?.to_string(),
                        start_ms: row.get("startMs")?.as_i64()?,
                        end_ms: row.get("endMs")?.as_i64()?,
                    })
                })
                .collect()
        });
    // The text is the transcript; the timings only decorate it. Timings that
    // do not tile the text are dropped (the result then reports no measured
    // word timings) rather than failing a helper that decoded fine.
    let words = match words {
        Some(words) if words_align_with_text(&words, &text) => words,
        Some(words) if words.is_empty() && text.is_empty() => words,
        _ => {
            if !text.is_empty() {
                tracing::info!(
                    "The speech helper's word timings did not match its text; keeping the text without them"
                );
            }
            Vec::new()
        }
    };
    Ok(NeuralTranscript {
        text,
        words,
        processing_ms: value
            .get("processingMs")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        load_ms: None,
        vocabulary_candidates: parse_vocabulary_candidates(value.get("vocabulary")),
    })
}

/// The helper's acoustic candidates. Anything malformed is dropped: they are
/// optional evidence, and the transcript stands without them.
fn parse_vocabulary_candidates(
    value: Option<&serde_json::Value>,
) -> Vec<super::VocabularyCandidate> {
    let Some(rows) = value
        .and_then(|value| value.get("candidates"))
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };
    let score = |row: &serde_json::Value, key: &str| {
        row.get(key)
            .and_then(serde_json::Value::as_f64)
            .filter(|value| value.is_finite())
            .map(|value| value as f32)
    };
    rows.iter()
        .take(MAX_VOCABULARY_TERMS)
        .filter_map(|row| {
            let word_start = row.get("wordStart")?.as_u64()? as usize;
            let word_end = row.get("wordEnd")?.as_u64()? as usize;
            (word_start < word_end).then_some(())?;
            Some(super::VocabularyCandidate {
                term: row.get("term")?.as_str()?.to_string(),
                heard: row.get("phrase")?.as_str()?.to_string(),
                word_start,
                word_end,
                similarity: score(row, "similarity")?,
                term_score: score(row, "termScore"),
                heard_score: score(row, "originalScore"),
                best_path_score: score(row, "bestPathScore"),
                spoken_form: row
                    .get("alias")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                ctc_heard: row
                    .get("ctcHeard")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect()
}

/// The helper's limits on one request's vocabulary (`main.swift`).
pub(crate) const MAX_VOCABULARY_TERMS: usize = 512;
const MAX_VOCABULARY_TERM_CHARS: usize = 64;
const MAX_SPOKEN_FORMS_PER_TERM: usize = 4;

fn vocabulary_request(terms: &[super::AcousticVocabularyTerm]) -> Option<serde_json::Value> {
    let terms: Vec<serde_json::Value> = terms
        .iter()
        .filter(|term| {
            !term.text.trim().is_empty() && term.text.chars().count() <= MAX_VOCABULARY_TERM_CHARS
        })
        .take(MAX_VOCABULARY_TERMS)
        .map(|term| {
            let spoken: Vec<&str> = term
                .spoken
                .iter()
                .map(String::as_str)
                .filter(|spoken| {
                    !spoken.is_empty() && spoken.chars().count() <= MAX_VOCABULARY_TERM_CHARS
                })
                .take(MAX_SPOKEN_FORMS_PER_TERM)
                .collect();
            serde_json::json!({ "text": term.text, "spoken": spoken, "personalized": !term.built_in })
        })
        .collect();
    (!terms.is_empty()).then(|| serde_json::json!({ "terms": terms }))
}

/// The vocabulary model is verified on disk and compiled for this Mac, so
/// loading it takes a fraction of a second rather than a compile.
pub(crate) fn vocabulary_model_ready(models_root: &Path) -> bool {
    runtime_override() != RuntimeOverride::Ggml
        && PARAKEET_CTC_VOCABULARY.files_installed(models_root)
        && prepare_state(models_root, &PARAKEET_CTC_VOCABULARY) == PrepareState::Prepared
}

fn ensure_vocabulary_loaded(
    helper: &mut HelperProcess,
    models_root: &Path,
) -> Result<(), NeuralError> {
    if helper.vocabulary_loaded {
        return Ok(());
    }
    let spec = &PARAKEET_CTC_VOCABULARY;
    let verified = verify_spec_files(models_root, spec)?;
    // The vocabulary model decodes on the CPU either way; the load request
    // for it carries no compute units.
    let result = request(
        helper,
        &load_request(&spec.dir(models_root), spec, compute_units()),
        &[],
        LOAD_TIMEOUT,
    );
    match result {
        Ok(_) => {
            confirm_spec_files(&verified).map_err(|error| engine(format!("{error:#}")))?;
            helper.vocabulary_loaded = true;
            Ok(())
        }
        Err(error) => {
            verified.iter().for_each(VerifiedModelArtifact::forget);
            Err(error)
        }
    }
}

/// Words that tile the text exactly, in order, with sane times: only then are
/// they reported as measured word timings.
pub(crate) fn words_align_with_text(words: &[NeuralWord], text: &str) -> bool {
    !words.is_empty()
        && words
            .iter()
            .all(|word| word.start_ms >= 0 && word.end_ms >= word.start_ms)
        && words
            .windows(2)
            .all(|pair| pair[0].start_ms <= pair[1].start_ms)
        && words
            .iter()
            .flat_map(|word| word.text.split_whitespace())
            .eq(text.split_whitespace())
}

pub(crate) fn transcription_timeout(samples: usize) -> Duration {
    let audio = Duration::from_secs_f64(samples as f64 / 16_000.0);
    TRANSCRIBE_TIMEOUT_FLOOR + audio / 2
}

/// What a decode request will add, given what the helper already holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DecodeResidency {
    model: bool,
    vocabulary: bool,
}

impl DecodeResidency {
    fn of(slot: &Option<HelperProcess>, dir: &Path, units: ComputeUnits) -> Self {
        slot.as_ref().map_or(
            Self {
                model: false,
                vocabulary: false,
            },
            |helper| Self {
                model: helper
                    .loaded
                    .as_ref()
                    .is_some_and(|loaded| loaded.dir == dir && loaded.units == units),
                vocabulary: helper.vocabulary_loaded,
            },
        )
    }

    /// Whether every model the request uses is already loaded.
    fn resident(self, vocabulary: bool) -> bool {
        self.model && (!vocabulary || self.vocabulary)
    }
}

/// A request handed an unprepared model (including Light with GGUF present,
/// see [`request_spec_for_family`]) prepares it with its
/// first load. It takes the compile slot for that, which first waits out a
/// background compile already running; the guard it returns is `None` when
/// that compile finished the job.
fn compile_before_decode(
    models_root: &Path,
    spec: &ModelSpec,
    abandoned: &AtomicBool,
    deadline: Instant,
) -> Result<Option<MutexGuard<'static, ()>>, NeuralError> {
    if prepare_state(models_root, spec) == PrepareState::Prepared {
        return Ok(None);
    }
    let guard = acquire_compile_slot(abandoned, deadline).map_err(compile_wait_error)?;
    match prepare_state(models_root, spec) {
        PrepareState::Prepared => Ok(None),
        PrepareState::NeedsPrepare => Ok(Some(guard)),
        PrepareState::Failed(reason) => Err(engine(format!(
            "{} could not be prepared on this macOS build: {reason}",
            spec.model_id
        ))),
    }
}

fn compile_wait_error(stop: super::transcribe_cpp::DecodeStop) -> NeuralError {
    NeuralError::Admission(match stop {
        super::transcribe_cpp::DecodeStop::Cancelled => {
            anyhow::anyhow!("Transcription was cancelled before it finished.")
        }
        super::transcribe_cpp::DecodeStop::DeadlineExceeded => {
            anyhow::anyhow!("Parakeet is still getting ready on this Mac. Try again in a moment.")
        }
    })
}

fn transcription_memory_allowance(
    sample_count: usize,
    vocabulary: bool,
    residency: DecodeResidency,
    compiling: bool,
    units: ComputeUnits,
) -> u64 {
    // The validated sample count is capped at two hours. Cover all protocol
    // copies as well as the model/driver allowance, before allocating payloads.
    let model = if residency.model {
        RESIDENT_DECODE_ALLOWANCE
    } else if compiling {
        units.cold_load_allowance()
    } else {
        units.warm_load_allowance()
    };
    let vocabulary = match (vocabulary, residency.vocabulary) {
        (false, _) => 0,
        (true, true) => RESIDENT_VOCABULARY_ALLOWANCE,
        (true, false) => VOCABULARY_MODEL_ALLOWANCE,
    };
    model + sample_count as u64 * 4 * std::mem::size_of::<f32>() as u64 + vocabulary
}

/// Decode 16 kHz mono samples. Blocking; call from `spawn_blocking`. Waits
/// for the speech route only until `route_deadline`, or until the caller sets
/// `abandoned`.
pub(crate) fn transcribe_blocking(
    models_root: &Path,
    spec: &ModelSpec,
    samples: &[f32],
    vocabulary: &[super::AcousticVocabularyTerm],
    abandoned: &AtomicBool,
    route_deadline: Instant,
) -> Result<NeuralTranscript, NeuralError> {
    if samples.len() > MAX_SAMPLE_COUNT || samples.iter().any(|sample| !sample.is_finite()) {
        return Err(NeuralError::Admission(anyhow::anyhow!(
            "Invalid speech audio length or non-finite sample"
        )));
    }
    let _route = acquire_route(abandoned, route_deadline).map_err(route_wait_error)?;
    let compile = compile_before_decode(models_root, spec, abandoned, route_deadline)?;
    let compiling = compile.is_some();
    let units = compute_units();
    let vocabulary = vocabulary_request(vocabulary)
        .filter(|_| vocabulary_model_wanted() && vocabulary_model_ready(models_root));
    // The helper slot is held from here to the end of the decode, so an idle
    // release cannot unload what admission counted as resident.
    let mut slot = lock_helper();
    let residency = DecodeResidency::of(&slot, &spec.dir(models_root), units);
    let _admission = crate::llm::local_model_load::admit_neural_engine_decode(
        transcription_memory_allowance(
            samples.len(),
            vocabulary.is_some(),
            residency,
            compiling,
            units,
        ),
        residency.resident(vocabulary.is_some()),
    )
    .map_err(NeuralError::Admission)?;
    let result = (|| {
        let load_ms = ensure_loaded(&mut slot, models_root, spec)?;
        if compiling {
            // This load was the compile: the next request loads fast.
            write_marker(
                &spec.dir(models_root),
                &marker_for(spec, &macos_build(), units, Ok(load_ms.unwrap_or_default())),
            );
            tracing::info!(
                "Prepared {} ({}) on first use in {:?} ms",
                spec.model_id,
                units.engine_name(),
                load_ms
            );
        }
        drop(compile);
        let helper = slot.as_mut().expect("helper is loaded");
        // A vocabulary model that will not load costs this dictation its
        // vocabulary, not its transcript.
        let vocabulary =
            vocabulary.filter(|_| match ensure_vocabulary_loaded(helper, models_root) {
                Ok(()) => true,
                Err(error) => {
                    tracing::info!("Decoding without the vocabulary model: {error}");
                    false
                }
            });
        let mut payload = Vec::with_capacity(samples.len() * 4);
        for sample in samples {
            payload.extend_from_slice(&sample.to_le_bytes());
        }
        let mut body = serde_json::json!({ "op": "transcribe", "sampleCount": samples.len() });
        if let Some(vocabulary) = vocabulary {
            body["vocabulary"] = vocabulary;
        }
        let response = request(
            helper,
            &body,
            &payload,
            transcription_timeout(samples.len()),
        )?;
        helper.last_used = Instant::now();
        let mut transcript = parse_transcript(&response)?;
        transcript.load_ms = load_ms;
        Ok(transcript)
    })();
    match &result {
        Ok(_) => record_success(),
        Err(NeuralError::Engine(_)) => {
            // A helper that failed mid-request is not trusted with the next one.
            slot.take();
        }
        Err(NeuralError::Admission(_)) => {}
    }
    result
}

/// Prepare a downloaded model for this Mac and record the outcome, so the
/// first dictation does not pay for it. On the Neural Engine route this is
/// the ANE compile; on the CPU route (Light tier) there is nothing to
/// compile -- the pinned `.mlmodelc` bundles are already compiled, and no
/// ANECompilerService runs -- so the prepare is one load that proves the
/// model works here (~4 s measured, against ~12-21 s for the ANE compile).
///
/// The prepare runs in a helper process of its own, outside the speech route
/// and the text runtime, so dictation, meetings (on either runtime) and text
/// work carry on while it runs; its admission covers only its own memory.
/// ANE compilation waits while speech is in use; CPU preparation may run at
/// warning pressure when its cold-load claim fits. Only a load the helper
/// itself refuses records the model as unable
/// to run on this macOS build; a timeout, a crash or a kill under memory
/// pressure counts toward `LOAD_FAILURES_BEFORE_GIVING_UP` instead.
pub(crate) fn prepare_blocking(models_root: &Path, spec: &ModelSpec) -> Result<(), NeuralError> {
    if !platform_supported() {
        return Err(engine("this Mac cannot run the Core ML speech route"));
    }
    if !spec.files_installed(models_root) {
        return Err(engine("the speech model files are not verified"));
    }
    let dir = spec.dir(models_root);
    let units = compute_units();
    if prepare_state_for(
        read_marker(&dir).as_ref(),
        &macos_build(),
        spec.encoder,
        units,
    ) == PrepareState::Prepared
    {
        return Ok(());
    }
    let verified = verify_spec_files(models_root, spec)?;
    let result = prepare_with(
        &dir,
        spec,
        units,
        &macos_build(),
        speech_in_use,
        || {
            if units == ComputeUnits::CpuOnly {
                crate::llm::local_model_load::admit_cpu_speech_prepare(units.cold_load_allowance())
            } else {
                crate::llm::local_model_load::admit_neural_engine_compile(
                    units.cold_load_allowance(),
                )
            }
        },
        spawn_helper,
        LOAD_TIMEOUT,
    );
    match &result {
        Ok(()) => confirm_spec_files(&verified).map_err(|error| {
            // The compile may have read other bytes: it must happen again.
            let _ = std::fs::remove_file(dir.join(PREPARED_MARKER));
            model_file_error(error)
        }),
        Err(_) => {
            verified.iter().for_each(VerifiedModelArtifact::forget);
            result
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn prepare_with<Claim>(
    dir: &Path,
    spec: &ModelSpec,
    units: ComputeUnits,
    os_build: &str,
    speech_in_use: impl FnOnce() -> bool,
    admit: impl FnOnce() -> Result<Claim>,
    spawn: impl FnOnce() -> Result<HelperProcess, NeuralError>,
    load_timeout: Duration,
) -> Result<(), NeuralError> {
    if prepare_state_for(read_marker(dir).as_ref(), os_build, spec.encoder, units)
        == PrepareState::Prepared
    {
        return Ok(());
    }
    // Taken before the speech check: a request that finds no other copy to
    // serve compiles in its own helper under this slot, and a background
    // compile that checked first must not start a second one beside it.
    let _compile = match compile_slot().try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::Poisoned(error)) => error.into_inner(),
        Err(TryLockError::WouldBlock) => {
            return Err(NeuralError::Admission(anyhow::anyhow!(
                "another compile is running"
            )))
        }
    };
    if units == ComputeUnits::CpuAndNeuralEngine && speech_in_use() {
        return Err(NeuralError::Admission(anyhow::anyhow!(
            "speech recognition is in use; the compile waits for it"
        )));
    }
    let _claim = admit().map_err(NeuralError::Admission)?;
    let started = Instant::now();
    // Dropping the helper at the end of this expression ends its process:
    // preparing is not using, so the model is released until something needs it.
    let result = spawn().and_then(|mut helper| {
        request(
            &mut helper,
            &load_request(dir, spec, units),
            &[],
            load_timeout,
        )
        .map(|_| ())
    });
    match &result {
        Ok(()) => {
            let load_ms = started.elapsed().as_millis() as u64;
            write_marker(dir, &marker_for(spec, os_build, units, Ok(load_ms)));
            clear_load_failures(dir);
            tracing::info!(
                "Prepared {} ({}) in {load_ms} ms",
                spec.model_id,
                units.engine_name()
            );
        }
        Err(NeuralError::Engine(failure)) if failure.refused => {
            write_marker(
                dir,
                &marker_for(spec, os_build, units, Err(failure.reason.clone())),
            );
            clear_load_failures(dir);
            tracing::warn!("Preparing {} failed: {failure}", spec.model_id);
        }
        Err(NeuralError::Engine(failure)) => {
            let count = note_load_failure(dir, spec, os_build, units, &failure.reason);
            tracing::warn!(
                "Preparing {} did not finish ({count} in a row): {failure}",
                spec.model_id
            );
        }
        Err(NeuralError::Admission(_)) => {}
    }
    result
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/// Fetch and check `spec`'s pinned files, then start preparing
/// it in the background. Progress runs 0-100 over the bytes.
pub(crate) async fn download_and_prepare(
    models_root: &Path,
    spec: &'static ModelSpec,
    progress: std::sync::Arc<dyn Fn(f32) + Send + Sync>,
) -> Result<()> {
    download_files(models_root, spec, std::sync::Arc::clone(&progress)).await?;
    progress(100.0);
    // A finished download, from either path, clears an earlier failure notice.
    publish_notice(DownloadNotice::IDLE);
    // Not awaited: the compile can take minutes on a busy Mac. Until it is
    // done the ggml route serves, or, with no ggml file here, a request
    // compiles the model itself (`request_spec_for_family`).
    schedule_background_prepare(models_root, spec);
    Ok(())
}

async fn download_files(
    models_root: &Path,
    spec: &'static ModelSpec,
    progress: std::sync::Arc<dyn Fn(f32) + Send + Sync>,
) -> Result<()> {
    use crate::download::DownloadManager;
    let dir = spec.dir(models_root);
    let manager = DownloadManager::new()?;
    let total = spec.total_bytes().max(1) as f64;
    let mut done = 0u64;
    for file in spec.files {
        let destination = dir.join(file.path);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("Failed to create {}", parent.display()))?;
        }
        let file_progress = std::sync::Arc::clone(&progress);
        let before = done as f64;
        let size = file.size as f64;
        manager
            .download_verified_model_asset(
                &spec.url(file),
                &destination,
                Some(file.sha256),
                file.size + 1024,
                move |p| {
                    let fraction = (p.percentage / 100.0).clamp(0.0, 1.0);
                    file_progress(((before + size * fraction) / total * 100.0) as f32);
                },
            )
            .await?;
        done += file.size;
    }
    Ok(())
}

/// Fetch and check the vocabulary model's files without compiling them: the
/// speech model's compile, started just before, holds the single prepare
/// slot. Background maintenance compiles them once the speech model serves.
pub(crate) async fn download_vocabulary_files(
    models_root: &Path,
    progress: std::sync::Arc<dyn Fn(f32) + Send + Sync>,
) -> Result<()> {
    download_files(models_root, &PARAKEET_CTC_VOCABULARY, progress).await
}

/// The Core ML model a Parakeet download fetches on this Mac, in place of the
/// ggml file: the one for the preferred family, when this Mac can run it.
/// `None` means the download is the ggml file, as before this route existed.
pub(crate) fn spec_to_download() -> Option<&'static ModelSpec> {
    spec_to_download_for(route_supported(), preferred_family())
}

fn spec_to_download_for(route_supported: bool, family: Family) -> Option<&'static ModelSpec> {
    route_supported.then(|| ModelSpec::spec_for(family))
}

/// The vocabulary model a Parakeet download also fetches: only beside the
/// Core ML speech model, and only when dictation can be English.
pub(crate) fn vocabulary_spec_to_download() -> Option<&'static ModelSpec> {
    vocabulary_spec_for(spec_to_download(), vocabulary_model_wanted())
}

fn vocabulary_spec_for(
    speech: Option<&'static ModelSpec>,
    vocabulary_wanted: bool,
) -> Option<&'static ModelSpec> {
    speech
        .filter(|_| vocabulary_wanted)
        .map(|_| &PARAKEET_CTC_VOCABULARY)
}

/// Bytes a Parakeet download fetches on this Mac when it fetches the Core ML
/// build, so the size the app shows is the size that leaves the network.
/// `None` where the download is the ggml file.
pub(crate) fn coreml_download_bytes() -> Option<u64> {
    coreml_download_bytes_for(spec_to_download(), vocabulary_spec_to_download())
}

fn coreml_download_bytes_for(
    speech: Option<&'static ModelSpec>,
    vocabulary: Option<&'static ModelSpec>,
) -> Option<u64> {
    speech.map(|speech| speech.total_bytes() + vocabulary.map_or(0, ModelSpec::total_bytes))
}

// ---------------------------------------------------------------------------
// The ggml file, fetched only when this Mac needs it
// ---------------------------------------------------------------------------

/// What Parakeet needs on this Mac beside the copy it already has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GgmlNeed {
    /// The ggml file is here, the Core ML build serves without it, or the
    /// user never chose Parakeet's download.
    Nothing,
    /// The Core ML build for this language is still to come (a language
    /// switch); background maintenance fetches it, not the ggml file.
    CoreMlForFamily,
    /// Only the ggml file can serve: the route is backing off after a failure,
    /// failed to compile on this macOS build, cannot run here, or an override
    /// forces ggml.
    Ggml,
}

/// `chosen`: a Parakeet download the user asked for is on this Mac (either
/// copy). `family_build_coming`: the route can run and nothing has ruled out
/// the family's Core ML build; only its files are missing.
fn ggml_need_for(
    ggml_present: bool,
    chosen: bool,
    serves_without_ggml: bool,
    family_build_coming: bool,
) -> GgmlNeed {
    if ggml_present || !chosen || serves_without_ggml {
        GgmlNeed::Nothing
    } else if family_build_coming {
        GgmlNeed::CoreMlForFamily
    } else {
        GgmlNeed::Ggml
    }
}

pub(crate) fn ggml_need(models_root: &Path, family: Family) -> GgmlNeed {
    ggml_need_for(
        super::transcribe_cpp::parakeet_ggml_ready(models_root),
        parakeet_download_chosen(models_root),
        serves_without_ggml(models_root, family),
        family_build_coming(models_root, family),
    )
}

fn family_build_coming(models_root: &Path, family: Family) -> bool {
    let spec = ModelSpec::spec_for(family);
    route_usable_now()
        && !spec.files_installed(models_root)
        && !matches!(prepare_state(models_root, spec), PrepareState::Failed(_))
}

/// Where a download Parakeet needs stands, for the message a dictation that
/// could not be transcribed shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NeededDownload {
    Running,
    Failed,
}

static GGML_FALLBACK_RUNNING: AtomicBool = AtomicBool::new(false);
/// A failed fallback download is tried again only after this backs off, and
/// only when something asks for it (a dictation, a launch, a settings save):
/// never in a loop on its own.
static GGML_FALLBACK_BACKOFF: Mutex<Backoff> = Mutex::new(Backoff::new());

/// Start the ggml download in the background, with the Models-screen notice,
/// when Parakeet cannot serve without it on this Mac ([`GgmlNeed::Ggml`]).
/// It is the download the user already chose, so it needs no new choice.
/// Returns `None` when no download is needed, otherwise how it stands.
pub(crate) fn fetch_ggml_if_needed(models_root: &Path, family: Family) -> Option<NeededDownload> {
    match ggml_need(models_root, family) {
        GgmlNeed::Nothing => None,
        GgmlNeed::CoreMlForFamily => Some(match download_notice().state {
            NoticeState::Failed => NeededDownload::Failed,
            NoticeState::Downloading | NoticeState::Idle => NeededDownload::Running,
        }),
        GgmlNeed::Ggml => Some(start_ggml_fallback(models_root)),
    }
}

fn start_ggml_fallback(models_root: &Path) -> NeededDownload {
    if GGML_FALLBACK_RUNNING.load(Ordering::Acquire) {
        return NeededDownload::Running;
    }
    if lock_backoff(&GGML_FALLBACK_BACKOFF).active(Instant::now()) {
        return NeededDownload::Failed;
    }
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return NeededDownload::Failed;
    };
    if cfg!(test) || GGML_FALLBACK_RUNNING.swap(true, Ordering::AcqRel) {
        return NeededDownload::Running;
    }
    let root = models_root.to_path_buf();
    runtime.spawn(async move {
        let total_bytes = super::transcribe_cpp::parakeet_ggml_bytes();
        tracing::info!("Parakeet needs its ggml file on this Mac; fetching it in the background");
        publish_notice(DownloadNotice::downloading(0.0, total_bytes).needed());
        let progress: std::sync::Arc<dyn Fn(f32) + Send + Sync> = std::sync::Arc::new(move |p| {
            publish_notice(DownloadNotice::downloading(p, total_bytes).needed());
        });
        match super::transcribe_cpp::download_parakeet_ggml(&root, progress).await {
            Ok(()) => {
                lock_backoff(&GGML_FALLBACK_BACKOFF).succeed();
                publish_notice(DownloadNotice::IDLE);
            }
            Err(error) => {
                let delay = lock_backoff(&GGML_FALLBACK_BACKOFF)
                    .fail(Instant::now(), &format!("{error:#}"));
                tracing::warn!(
                    "Fetching Parakeet's ggml file failed; not before {}s again: {error:#}",
                    delay.as_secs()
                );
                publish_notice(DownloadNotice::failed(total_bytes).needed());
            }
        }
        GGML_FALLBACK_RUNNING.store(false, Ordering::Release);
    });
    NeededDownload::Running
}

// ---------------------------------------------------------------------------
// Background download, and the notice the Models screen shows for it
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NoticeState {
    Idle,
    Downloading,
    Failed,
}

/// What a download Plainsong started on its own is doing. The Models screen
/// reads it on open and follows `speech-model-download-notice` events.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadNotice {
    pub(crate) state: NoticeState,
    pub(crate) percent: u8,
    pub(crate) total_bytes: u64,
    /// Parakeet cannot transcribe until this download finishes; otherwise
    /// it works as before while the download runs.
    pub(crate) needed: bool,
}

impl DownloadNotice {
    pub(crate) const IDLE: Self = Self {
        state: NoticeState::Idle,
        percent: 0,
        total_bytes: 0,
        needed: false,
    };

    fn downloading(progress: f32, total_bytes: u64) -> Self {
        let percent = if progress.is_finite() {
            progress.clamp(0.0, 100.0).floor() as u8
        } else {
            0
        };
        Self {
            state: NoticeState::Downloading,
            percent,
            total_bytes,
            needed: false,
        }
    }

    fn failed(total_bytes: u64) -> Self {
        Self {
            state: NoticeState::Failed,
            percent: 0,
            total_bytes,
            needed: false,
        }
    }

    fn needed(self) -> Self {
        Self {
            needed: true,
            ..self
        }
    }

    fn needed_if(self, needed: bool) -> Self {
        Self { needed, ..self }
    }
}

type NoticeSink = Box<dyn Fn(&DownloadNotice) + Send + Sync>;

static NOTICE: Mutex<DownloadNotice> = Mutex::new(DownloadNotice::IDLE);
static NOTICE_SINK: OnceLock<NoticeSink> = OnceLock::new();

/// Where notices go (the sidecar's event channel). Set once at startup;
/// notices before that are still readable through [`download_notice`].
pub(crate) fn set_download_notice_sink(sink: NoticeSink) {
    let _ = NOTICE_SINK.set(sink);
}

pub(crate) fn download_notice() -> DownloadNotice {
    NOTICE.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Replace `current` with `next`, reporting whether anything changed. Whole
/// percents, so a 600 MB download sends about a hundred events, not one per
/// network read.
fn update_notice(current: &mut DownloadNotice, next: DownloadNotice) -> bool {
    if *current == next {
        return false;
    }
    *current = next;
    true
}

fn publish_notice(next: DownloadNotice) {
    let changed = update_notice(
        &mut NOTICE.lock().unwrap_or_else(|e| e.into_inner()),
        next.clone(),
    );
    if changed {
        if let Some(sink) = NOTICE_SINK.get() {
            sink(&next);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MaintenanceStep {
    Download,
    Prepare,
    Nothing,
}

/// `download_chosen`: the Parakeet download the user asked for is on this
/// Mac, as either copy: the Core ML build `download_models` fetches where
/// this route runs, or the ggml file it fetched before (and still fetches
/// where the route cannot run). Maintenance finishes or follows that download and never
/// starts one on its own: a fresh install has Parakeet selected before
/// anyone has chosen Download, and speech models download only on that
/// choice (PRIVACY.md).
fn maintenance_step(
    files_trusted: bool,
    download_chosen: bool,
    state: &PrepareState,
) -> MaintenanceStep {
    match (files_trusted, state) {
        (false, _) if download_chosen => MaintenanceStep::Download,
        (false, _) => MaintenanceStep::Nothing,
        (true, PrepareState::NeedsPrepare) => MaintenanceStep::Prepare,
        (true, PrepareState::Prepared | PrepareState::Failed(_)) => MaintenanceStep::Nothing,
    }
}

static MAINTENANCE_WANTED: AtomicBool = AtomicBool::new(false);
static MAINTENANCE_RUNNING: AtomicBool = AtomicBool::new(false);
static PARAKEET_SELECTED: AtomicBool = AtomicBool::new(false);

/// Fetch or re-prepare the Core ML model the preferred family needs, in the
/// background. Runs at startup (finishing what an earlier version or an
/// interrupted run left undone, re-preparing after a macOS update) and after
/// every settings save, so switching the transcription language fetches the
/// other family now rather than at the next launch. It downloads only once
/// the user's Parakeet download is on disk (see [`maintenance_step`]), and
/// reports progress through [`download_notice`]. When only the ggml file can
/// serve on this Mac and it is missing (a compile this macOS build refused,
/// a runtime override), it fetches that instead ([`fetch_ggml_if_needed`]).
/// No connection-cost check: Plainsong has no metered-network policy for any
/// download yet.
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "called only from the sidecar binary's startup and command paths"
    )
)]
pub(crate) fn schedule_maintenance(models_root: PathBuf, parakeet_selected: bool) {
    static LOGGED: std::sync::Once = std::sync::Once::new();
    LOGGED.call_once(|| {
        tracing::info!(
            parakeet_selected,
            status = %status(&models_root),
            "Neural Engine speech route"
        );
    });
    PARAKEET_SELECTED.store(parakeet_selected, Ordering::Release);
    MAINTENANCE_WANTED.store(true, Ordering::Release);
    if MAINTENANCE_RUNNING.swap(true, Ordering::AcqRel) {
        // The running pass sees `MAINTENANCE_WANTED` and goes round again
        // with the new settings.
        return;
    }
    tokio::spawn(async move {
        loop {
            while MAINTENANCE_WANTED.swap(false, Ordering::AcqRel) {
                if !PARAKEET_SELECTED.load(Ordering::Acquire) {
                    continue;
                }
                fetch_ggml_if_needed(&models_root, preferred_family());
                let Some(spec) = spec_to_download() else {
                    continue;
                };
                let plan = plan_maintenance(&models_root, spec, vocabulary_spec_to_download());
                for (step, spec) in [(plan.speech, spec)].into_iter().chain(plan.vocabulary) {
                    match step {
                        MaintenanceStep::Download => download_with_notice(&models_root, spec).await,
                        MaintenanceStep::Prepare => schedule_background_prepare(&models_root, spec),
                        MaintenanceStep::Nothing => {}
                    }
                }
            }
            MAINTENANCE_RUNNING.store(false, Ordering::Release);
            // A save that landed between the last check and the store above.
            if !MAINTENANCE_WANTED.load(Ordering::Acquire)
                || MAINTENANCE_RUNNING.swap(true, Ordering::AcqRel)
            {
                break;
            }
        }
    });
}

#[derive(Debug)]
struct MaintenancePlan {
    speech: MaintenanceStep,
    vocabulary: Option<(MaintenanceStep, &'static ModelSpec)>,
}

/// One maintenance pass. The vocabulary model (`vocabulary`, present when
/// dictation can be English) follows the speech model: fetched and compiled
/// only once the speech model serves, under the same rule that nothing
/// downloads unless the user chose the Parakeet download.
fn plan_maintenance(
    models_root: &Path,
    speech: &'static ModelSpec,
    vocabulary: Option<&'static ModelSpec>,
) -> MaintenancePlan {
    let chosen = parakeet_download_chosen(models_root);
    let state = prepare_state(models_root, speech);
    let speech_step = maintenance_step(speech.files_installed(models_root), chosen, &state);
    let vocabulary = vocabulary
        .filter(|_| speech_step == MaintenanceStep::Nothing && state == PrepareState::Prepared)
        .map(|spec| {
            let state = prepare_state(models_root, spec);
            (
                maintenance_step(spec.files_installed(models_root), chosen, &state),
                spec,
            )
        });
    MaintenancePlan {
        speech: speech_step,
        vocabulary,
    }
}

/// Mirrored from the language setting by [`set_transcription_language`].
static VOCABULARY_MODEL_WANTED: AtomicBool = AtomicBool::new(true);

fn vocabulary_model_wanted() -> bool {
    VOCABULARY_MODEL_WANTED.load(Ordering::Acquire)
}

/// The user chose Parakeet's Download on this Mac: one complete copy of it is
/// here, the ggml file or a Core ML speech build. Platform and overrides do
/// not matter: the choice was made either way. An interrupted download is
/// not a copy; choosing Download again resumes it.
pub(crate) fn parakeet_download_chosen(models_root: &Path) -> bool {
    super::transcribe_cpp::parakeet_ggml_ready(models_root)
        || MODEL_SPECS
            .iter()
            .any(|spec| spec.files_installed(models_root))
}

async fn download_with_notice(models_root: &Path, spec: &'static ModelSpec) {
    let total_bytes = spec.total_bytes();
    // A speech build is what Parakeet waits for when no ggml file is here (a
    // language switch); the vocabulary model never holds anything up.
    let needed = spec.helper_family != VOCABULARY_HELPER_FAMILY
        && !super::transcribe_cpp::parakeet_ggml_ready(models_root);
    publish_notice(DownloadNotice::downloading(0.0, total_bytes).needed_if(needed));
    let progress: std::sync::Arc<dyn Fn(f32) + Send + Sync> = std::sync::Arc::new(move |p| {
        publish_notice(DownloadNotice::downloading(p, total_bytes).needed_if(needed));
    });
    if let Err(error) = download_and_prepare(models_root, spec, progress).await {
        tracing::warn!(
            "Fetching {} for the Neural Engine failed: {error:#}",
            spec.model_id
        );
        publish_notice(DownloadNotice::failed(total_bytes).needed_if(needed));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pinned_file_has_a_full_digest_and_a_size() {
        for spec in MODEL_SPECS {
            assert_eq!(spec.revision.len(), 40, "{}", spec.model_id);
            assert!(!spec.files.is_empty());
            for file in spec.files {
                assert_eq!(file.sha256.len(), 64, "{}", file.path);
                assert!(file.sha256.chars().all(|c| c.is_ascii_hexdigit()));
                assert!(file.size > 0, "{}", file.path);
            }
        }
    }

    #[test]
    fn each_family_ships_the_four_graphs_and_a_vocabulary() {
        for (spec, joint) in [
            (&PARAKEET_V3_COREML, "JointDecisionv3.mlmodelc"),
            (&PARAKEET_V2_COREML, "JointDecision.mlmodelc"),
        ] {
            let encoder = match spec.encoder {
                "int8-v2" => "Encoder_v2.mlmodelc",
                _ => "Encoder.mlmodelc",
            };
            for graph in ["Preprocessor.mlmodelc", encoder, "Decoder.mlmodelc", joint] {
                assert!(
                    spec.files
                        .iter()
                        .any(|file| file.path == format!("{graph}/weights/weight.bin")),
                    "{} lacks {graph}",
                    spec.model_id
                );
            }
            assert!(spec
                .files
                .iter()
                .any(|file| file.path == "parakeet_vocab.json"));
        }
    }

    #[test]
    fn english_only_means_an_english_language_setting() {
        assert!(language_is_english(Some("en")));
        assert!(language_is_english(Some("en-US")));
        assert!(language_is_english(Some("EN_gb")));
        assert!(!language_is_english(None));
        assert!(!language_is_english(Some("auto")));
        assert!(!language_is_english(Some("fr")));
    }

    #[test]
    fn macos_fourteen_is_the_floor() {
        assert!(!macos_major_supported(Some("13.6.1")));
        assert!(macos_major_supported(Some("14.0")));
        assert!(macos_major_supported(Some("27.2")));
        assert!(!macos_major_supported(None));
        assert!(!macos_major_supported(Some("garbage")));
    }

    #[test]
    fn the_override_only_knows_two_names() {
        assert_eq!(parse_runtime_override(Some("ggml")), RuntimeOverride::Ggml);
        assert_eq!(
            parse_runtime_override(Some("neural_engine")),
            RuntimeOverride::NeuralEngine
        );
        assert_eq!(parse_runtime_override(Some("ane")), RuntimeOverride::Auto);
        assert_eq!(parse_runtime_override(None), RuntimeOverride::Auto);
    }

    #[test]
    fn a_macos_update_or_a_new_engine_needs_a_fresh_compile() {
        let marker = PreparedMarker {
            os_build: "26B5112a".to_string(),
            engine_version: HELPER_ENGINE_VERSION.to_string(),
            encoder: "int8-v2".to_string(),
            compute_units: "cpuAndNeuralEngine".to_string(),
            ok: true,
            error: None,
            load_ms: Some(14_000),
        };
        let ane = ComputeUnits::CpuAndNeuralEngine;
        assert_eq!(
            prepare_state_for(Some(&marker), "26B5112a", "int8-v2", ane),
            PrepareState::Prepared
        );
        assert_eq!(
            prepare_state_for(Some(&marker), "26C1", "int8-v2", ane),
            PrepareState::NeedsPrepare
        );
        let older_engine = PreparedMarker {
            engine_version: "0.0.1".to_string(),
            ..marker.clone()
        };
        assert_eq!(
            prepare_state_for(Some(&older_engine), "26B5112a", "int8-v2", ane),
            PrepareState::NeedsPrepare
        );
        let failed = PreparedMarker {
            ok: false,
            error: Some("compile failed".to_string()),
            ..marker
        };
        assert_eq!(
            prepare_state_for(Some(&failed), "26B5112a", "int8-v2", ane),
            PrepareState::Failed("compile failed".to_string())
        );
        assert_eq!(
            prepare_state_for(None, "26B5112a", "int8-v2", ane),
            PrepareState::NeedsPrepare
        );
    }

    #[test]
    fn a_different_encoder_build_needs_its_own_compile() {
        let marker = PreparedMarker {
            os_build: "26B5112a".to_string(),
            engine_version: HELPER_ENGINE_VERSION.to_string(),
            encoder: "int8".to_string(),
            compute_units: "cpuAndNeuralEngine".to_string(),
            ok: true,
            error: None,
            load_ms: None,
        };
        assert_eq!(
            prepare_state_for(
                Some(&marker),
                "26B5112a",
                "int8-v2",
                ComputeUnits::CpuAndNeuralEngine
            ),
            PrepareState::NeedsPrepare
        );
    }

    #[test]
    fn other_compute_units_need_their_own_prepare() {
        // An ANE prepare says nothing about a CPU load, and a CPU prepare
        // never compiled the ANE program: a tier change re-prepares.
        let ane_marker = PreparedMarker {
            os_build: "26B5112a".to_string(),
            engine_version: HELPER_ENGINE_VERSION.to_string(),
            encoder: "int8-v2".to_string(),
            compute_units: "cpuAndNeuralEngine".to_string(),
            ok: true,
            error: None,
            load_ms: Some(14_000),
        };
        assert_eq!(
            prepare_state_for(
                Some(&ane_marker),
                "26B5112a",
                "int8-v2",
                ComputeUnits::CpuOnly
            ),
            PrepareState::NeedsPrepare
        );
        let cpu_marker = PreparedMarker {
            compute_units: "cpuOnly".to_string(),
            ..ane_marker.clone()
        };
        assert_eq!(
            prepare_state_for(
                Some(&cpu_marker),
                "26B5112a",
                "int8-v2",
                ComputeUnits::CpuOnly
            ),
            PrepareState::Prepared
        );
        assert_eq!(
            prepare_state_for(
                Some(&cpu_marker),
                "26B5112a",
                "int8-v2",
                ComputeUnits::CpuAndNeuralEngine
            ),
            PrepareState::NeedsPrepare
        );
        // A marker from before the field was recorded was an ANE prepare.
        let legacy = serde_json::json!({
            "osBuild": "26B5112a",
            "engineVersion": HELPER_ENGINE_VERSION,
            "encoder": "int8-v2",
            "ok": true,
        });
        let legacy: PreparedMarker = serde_json::from_value(legacy).expect("legacy marker parses");
        assert_eq!(legacy.compute_units, "cpuAndNeuralEngine");
        assert_eq!(
            prepare_state_for(
                Some(&legacy),
                "26B5112a",
                "int8-v2",
                ComputeUnits::CpuAndNeuralEngine
            ),
            PrepareState::Prepared
        );
        assert_eq!(
            prepare_state_for(Some(&legacy), "26B5112a", "int8-v2", ComputeUnits::CpuOnly),
            PrepareState::NeedsPrepare
        );
    }

    #[test]
    fn the_tier_picks_the_compute_units() {
        assert_eq!(
            compute_units_for_tier(crate::hardware_tier::HardwareTier::Light),
            ComputeUnits::CpuOnly
        );
        assert_eq!(
            compute_units_for_tier(crate::hardware_tier::HardwareTier::Balanced),
            ComputeUnits::CpuAndNeuralEngine
        );
        assert_eq!(
            compute_units_for_tier(crate::hardware_tier::HardwareTier::Best),
            ComputeUnits::CpuAndNeuralEngine
        );
        assert_eq!(ComputeUnits::CpuOnly.engine_name(), "coreml_cpu");
        assert_eq!(
            ComputeUnits::CpuAndNeuralEngine.engine_name(),
            "neural_engine"
        );
    }

    #[test]
    fn the_load_request_carries_the_compute_units() {
        let dir = Path::new("/models/neural_engine/parakeet-tdt-0.6b-v3-coreml");
        let cpu = load_request(dir, &PARAKEET_V3_COREML, ComputeUnits::CpuOnly);
        assert_eq!(cpu["computeUnits"], "cpuOnly");
        assert_eq!(cpu["op"], "load");
        let ane = load_request(dir, &PARAKEET_V3_COREML, ComputeUnits::CpuAndNeuralEngine);
        assert_eq!(ane["computeUnits"], "cpuAndNeuralEngine");
        // The vocabulary model's load carries no compute units.
        let vocabulary = load_request(
            Path::new("/models/neural_engine/parakeet-ctc-110m-coreml"),
            &PARAKEET_CTC_VOCABULARY,
            ComputeUnits::CpuOnly,
        );
        assert_eq!(vocabulary["op"], "loadVocabularyModel");
        assert!(vocabulary.get("computeUnits").is_none());
    }

    #[test]
    fn packaged_builds_look_in_exactly_one_place() {
        let packaged =
            Path::new("/Applications/Plainsong.app/Contents/Resources/sidecar/plainsong-sidecar");
        assert_eq!(
            helper_candidates(packaged, Some(Path::new("/repo"))),
            vec![PathBuf::from(
                "/Applications/Plainsong.app/Contents/Resources/asr-helper/plainsong-native-asr-helper"
            )]
        );
        let dev = Path::new("/repo/rust-sidecar/target/release/plainsong-sidecar");
        assert_eq!(
            helper_candidates(dev, Some(Path::new("/repo"))),
            vec![
                PathBuf::from("/repo/dist-native/plainsong-native-asr-helper"),
                PathBuf::from("/repo/rust-sidecar/target/release/plainsong-native-asr-helper"),
            ]
        );
    }

    #[test]
    fn word_timings_count_as_measured_only_when_they_tile_the_text() {
        let words = vec![
            NeuralWord {
                text: "Ship".into(),
                start_ms: 0,
                end_ms: 200,
            },
            NeuralWord {
                text: "it.".into(),
                start_ms: 200,
                end_ms: 400,
            },
        ];
        assert!(words_align_with_text(&words, "Ship it."));
        assert!(!words_align_with_text(&words, "Ship it now."));
        let backwards = vec![
            NeuralWord {
                text: "Ship".into(),
                start_ms: 300,
                end_ms: 400,
            },
            NeuralWord {
                text: "it.".into(),
                start_ms: 100,
                end_ms: 200,
            },
        ];
        assert!(!words_align_with_text(&backwards, "Ship it."));
        assert!(!words_align_with_text(&[], ""));
    }

    #[test]
    fn helper_responses_parse_into_timed_words() {
        let value = serde_json::json!({
            "ok": true, "op": "transcribe", "text": " Hello there. ",
            "processingMs": 61,
            "words": [
                {"text": "Hello", "startMs": 0, "endMs": 320, "confidence": 0.9},
                {"text": "there.", "startMs": 320, "endMs": 700, "confidence": 1.0}
            ]
        });
        let transcript = parse_transcript(&value).unwrap();
        assert_eq!(transcript.text, "Hello there.");
        assert_eq!(transcript.words.len(), 2);
        assert_eq!(transcript.processing_ms, 61);
    }

    #[cfg(unix)]
    fn fake_helper(script: &str) -> HelperProcess {
        let child = Command::new("/usr/bin/python3")
            .args(["-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        connect_helper(child).unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn responses_must_match_the_requested_operation() {
        let mut helper = fake_helper("import sys; sys.stdin.readline(); print('{\"op\":\"unload\",\"ok\":true}', flush=True)");
        assert!(request(
            &mut helper,
            &serde_json::json!({"op":"hello"}),
            &[],
            Duration::from_secs(2)
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn crashed_and_silent_helpers_fail_within_the_deadline() {
        for script in ["import sys; sys.exit(3)", "import time; time.sleep(10)"] {
            let mut helper = fake_helper(script);
            let started = Instant::now();
            assert!(request(
                &mut helper,
                &serde_json::json!({"op":"hello"}),
                &[],
                Duration::from_millis(100)
            )
            .is_err());
            assert!(started.elapsed() < Duration::from_secs(2));
        }
    }

    #[cfg(unix)]
    #[test]
    fn blocked_audio_writes_are_part_of_the_request_deadline() {
        let mut helper = fake_helper("import time; time.sleep(10)");
        let started = Instant::now();
        let result = request(
            &mut helper,
            &serde_json::json!({"op":"transcribe", "sampleCount": 262144}),
            &vec![0; 1024 * 1024],
            Duration::from_millis(100),
        );
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn audio_payloads_flow_through_a_backpressured_pipe_without_losing_bytes() {
        let mut helper = fake_helper("import json, sys; r=json.loads(sys.stdin.buffer.readline()); b=sys.stdin.buffer.read(r['sampleCount']*4); print(json.dumps({'op':'transcribe', 'ok':True, 'receivedBytes':len(b)}), flush=True)");
        let payload = vec![0u8; 160_000 * 4];
        let value = request(
            &mut helper,
            &serde_json::json!({"op":"transcribe", "sampleCount":160_000}),
            &payload,
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(value["receivedBytes"], payload.len());
    }

    #[cfg(unix)]
    #[test]
    fn malformed_and_oversized_response_frames_fail_closed() {
        for script in [
            "import sys; sys.stdin.readline(); print('not json', flush=True)",
            "import sys; sys.stdin.readline(); sys.stdout.write('x' * (16 * 1024 * 1024 + 1)); sys.stdout.flush()",
            "import sys; sys.stdin.readline(); sys.stdout.write('{\"op\":\"hello\",\"ok\":true}'); sys.stdout.flush()",
        ] {
            let mut helper = fake_helper(script);
            assert!(request(&mut helper, &serde_json::json!({"op":"hello"}), &[], Duration::from_secs(2)).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn residency_prewarm_cache_hit_resets_idle_clock() {
        let root = Path::new("/isolated-model-root");
        let mut helper = fake_helper("import time; time.sleep(10)");
        helper.loaded = Some(LoadedModel {
            dir: PARAKEET_V3_COREML.dir(root),
            units: compute_units(),
        });
        helper.last_used = Instant::now() - Duration::from_secs(120);
        let mut slot = Some(helper);
        let touched_at = Instant::now();
        assert_eq!(
            ensure_loaded(&mut slot, root, &PARAKEET_V3_COREML).unwrap(),
            None
        );
        assert!(slot.as_ref().unwrap().last_used >= touched_at);
    }

    #[cfg(unix)]
    #[test]
    fn idle_release_waits_for_inflight_requests_and_kills_the_child() {
        let _route = route_gate().lock().unwrap_or_else(|e| e.into_inner());
        let mut helper = fake_helper("import time; time.sleep(10)");
        helper.last_used = Instant::now() - Duration::from_secs(10);
        let pid = helper.child.id();
        let mut slot = lock_helper();
        assert!(slot.is_none());
        *slot = Some(helper);
        let policy = super::super::speech_residency::ReleasePolicy::current(
            crate::memory_pressure::MemoryPressure::Critical,
        );
        assert!(!release_if_idle(policy));
        super::super::speech_residency::release_for_heavy_work();
        assert!(slot.is_some());
        drop(slot);
        drop(_route);
        assert!(release_if_idle(policy));
        // Drop waits for exit, so memory is gone before another load.
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, -1);
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "poisons the process-wide speech route; run this test alone"]
    fn poisoned_route_does_not_block_idle_release() {
        let poisoned = std::panic::catch_unwind(|| {
            let _route = route_gate().lock().unwrap_or_else(|e| e.into_inner());
            panic!("synthetic route worker panic");
        });
        assert!(poisoned.is_err());
        let helper = fake_helper("import time; time.sleep(10)");
        let pid = helper.child.id();
        *lock_helper() = Some(helper);
        let policy = super::super::speech_residency::ReleasePolicy::current(
            crate::memory_pressure::MemoryPressure::Critical,
        );
        let released = release_if_idle(policy);
        // Restore the process-wide fixture even when the regression fails.
        route_gate().clear_poison();
        if !released {
            stop_helper();
        }
        assert!(
            released,
            "an abandoned route must not prevent pressure release"
        );
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, -1);
    }

    #[cfg(unix)]
    #[test]
    fn warning_pressure_releases_after_a_minute_and_heavy_work_releases_unused_speech() {
        use super::super::speech_residency::ReleasePolicy;
        use crate::memory_pressure::MemoryPressure;
        let _route = route_gate().lock().unwrap_or_else(|e| e.into_inner());
        let mut helper = fake_helper("import time; time.sleep(10)");
        helper.last_used = Instant::now() - Duration::from_secs(59);
        let pid = helper.child.id();
        let mut slot = Some(helper);
        let warning = ReleasePolicy::current(MemoryPressure::Warning);
        assert!(!release_idle_helper(&mut slot, warning));
        slot.as_mut().unwrap().last_used = Instant::now() - Duration::from_secs(60);
        assert!(release_idle_helper(&mut slot, warning));
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, -1);

        let helper = fake_helper("import time; time.sleep(10)");
        let pid = helper.child.id();
        *lock_helper() = Some(helper);
        drop(_route);
        super::super::speech_residency::release_for_heavy_work();
        assert!(lock_helper().is_none());
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, -1);
    }

    #[test]
    fn request_language_does_not_inherit_an_english_only_model_for_auto_or_french() {
        assert_eq!(family_for_language(Some("en-US")), Family::English);
        assert_eq!(family_for_language(Some("fr")), Family::Multilingual);
        assert_eq!(family_for_language(None), Family::Multilingual);
    }

    #[test]
    fn malformed_or_partial_word_timings_cannot_drop_transcript_text() {
        // A healthy helper whose timings do not tile its text keeps its text;
        // the result then has no measured word timings. It is not an engine
        // failure, which would kill the helper and back the route off.
        for words in [
            serde_json::json!([{"text":"Hello", "startMs":0, "endMs":300}]),
            serde_json::json!([{"text":"Hello", "startMs":0, "endMs":300}, {"text":"there."}]),
            serde_json::json!([{"text":"Hello there.", "startMs":300, "endMs":0}]),
            serde_json::json!("not a list"),
        ] {
            let transcript =
                parse_transcript(&serde_json::json!({"text":"Hello there.", "words": words}))
                    .expect("the text survives bad timings");
            assert_eq!(transcript.text, "Hello there.");
            assert!(transcript.words.is_empty());
            assert!(!words_align_with_text(&transcript.words, &transcript.text));
        }
        let missing = parse_transcript(&serde_json::json!({"text":"Hello there."})).unwrap();
        assert_eq!(missing.text, "Hello there.");
        assert!(parse_transcript(&serde_json::json!({"words": []})).is_err());
    }

    #[test]
    fn nonfinite_input_is_a_request_error_and_never_reaches_either_engine() {
        assert!(matches!(
            transcribe_blocking(
                Path::new("/not-a-model-directory"),
                &PARAKEET_V3_COREML,
                &[f32::NAN],
                &[],
                &AtomicBool::new(false),
                Instant::now() + Duration::from_secs(1),
            ),
            Err(NeuralError::Admission(_))
        ));
    }

    /// Hold the speech route as a decode on either runtime would.
    fn hold_route() -> MutexGuard<'static, ()> {
        route_gate().lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn a_transcription_waiting_for_the_route_gives_up_at_its_deadline_or_when_abandoned() {
        let _busy = hold_route();
        let started = Instant::now();
        let result = transcribe_blocking(
            Path::new("/not-a-model-directory"),
            &PARAKEET_V3_COREML,
            &[0.1; 160],
            &[],
            &AtomicBool::new(false),
            Instant::now() + Duration::from_millis(100),
        );
        assert!(
            matches!(result, Err(NeuralError::Admission(_))),
            "{result:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(2));

        let started = Instant::now();
        let result = transcribe_blocking(
            Path::new("/not-a-model-directory"),
            &PARAKEET_V3_COREML,
            &[0.1; 160],
            &[],
            &AtomicBool::new(true),
            Instant::now() + Duration::from_secs(60),
        );
        assert!(
            matches!(result, Err(NeuralError::Admission(_))),
            "{result:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    fn unique_dir(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("plainsong-ne-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A helper that answers hello and then does `on_load` for a load.
    #[cfg(unix)]
    fn fake_spawn(on_load: &str) -> impl FnOnce() -> Result<HelperProcess, NeuralError> {
        let script = format!(
            "import json, os, signal, sys, time\n\
             for line in sys.stdin:\n    \
                 r = json.loads(line)\n    \
                 if r['op'] == 'hello':\n        \
                     print(json.dumps({{'op':'hello','ok':True,'protocolVersion':{HELPER_PROTOCOL_VERSION},'engine':'fluidaudio','engineVersion':'{HELPER_ENGINE_VERSION}'}}), flush=True)\n    \
                 elif r['op'] == 'load':\n        \
                     {on_load}\n"
        );
        move || {
            let mut helper = fake_helper(&script);
            handshake(&mut helper)?;
            Ok(helper)
        }
    }

    #[cfg(unix)]
    const LOAD_OK: &str =
        "time.sleep(0.3); print(json.dumps({'op':'load','ok':True,'loadMs':300}), flush=True)";
    #[cfg(unix)]
    const LOAD_REFUSED: &str = "print(json.dumps({'op':'load','ok':False,'code':'engine_error','message':'compile failed'}), flush=True)";
    #[cfg(unix)]
    const LOAD_HANGS: &str = "time.sleep(30)";
    #[cfg(unix)]
    const LOAD_KILLED: &str = "os.kill(os.getpid(), signal.SIGKILL)";

    #[cfg(unix)]
    #[test]
    fn a_background_compile_runs_while_dictation_holds_the_route() {
        let dir = unique_dir("compile-route");
        let busy = hold_route();
        let (done, finished) = mpsc::channel();
        let compile_dir = dir.clone();
        std::thread::spawn(move || {
            let result = prepare_with(
                &compile_dir,
                &PARAKEET_V3_COREML,
                ComputeUnits::CpuAndNeuralEngine,
                "26B5112a",
                || false,
                || Ok(()),
                fake_spawn(LOAD_OK),
                Duration::from_secs(5),
            );
            let _ = done.send(result);
        });
        // Before, the compile took the route and this waited for it.
        let result = finished
            .recv_timeout(Duration::from_secs(10))
            .expect("the compile finished while the route was held");
        drop(busy);
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(
            prepare_state_for(
                read_marker(&dir).as_ref(),
                "26B5112a",
                PARAKEET_V3_COREML.encoder,
                ComputeUnits::CpuAndNeuralEngine
            ),
            PrepareState::Prepared
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_background_compile_waits_while_speech_is_in_use() {
        let dir = unique_dir("compile-deferred");
        let result = prepare_with(
            &dir,
            &PARAKEET_V3_COREML,
            ComputeUnits::CpuAndNeuralEngine,
            "26B5112a",
            || true,
            || -> Result<()> { panic!("admission must not be asked while speech is in use") },
            || -> Result<HelperProcess, NeuralError> { panic!("no helper may start") },
            Duration::from_secs(1),
        );
        assert!(matches!(result, Err(NeuralError::Admission(_))));
        assert_eq!(
            prepare_state_for(
                read_marker(&dir).as_ref(),
                "26B5112a",
                PARAKEET_V3_COREML.encoder,
                ComputeUnits::CpuAndNeuralEngine
            ),
            PrepareState::NeedsPrepare
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn deferred_compiles_retry_until_they_settle_or_the_limit() {
        let mut attempts = 0;
        let mut slept = Duration::ZERO;
        let result = prepare_until_settled(
            || {
                attempts += 1;
                if attempts < 3 {
                    Err(NeuralError::Admission(anyhow::anyhow!("busy")))
                } else {
                    Ok(())
                }
            },
            Duration::from_secs(30),
            Duration::from_secs(600),
            |delay| slept += delay,
        );
        assert!(result.is_ok());
        assert_eq!((attempts, slept), (3, Duration::from_secs(60)));

        let mut attempts = 0;
        let result = prepare_until_settled(
            || {
                attempts += 1;
                Err(NeuralError::Admission(anyhow::anyhow!("busy")))
            },
            Duration::from_secs(30),
            Duration::from_secs(60),
            |_| {},
        );
        assert!(matches!(result, Err(NeuralError::Admission(_))));
        assert_eq!(attempts, 3);
    }

    #[test]
    fn prepare_retries_an_identity_change_once_without_the_engine_backoff() {
        let mut attempts = 0;
        let mut slept = Duration::ZERO;
        let result = prepare_until_settled(
            || {
                attempts += 1;
                if attempts == 1 {
                    Err(NeuralError::Engine(EngineFailure {
                        reason: "identity changed".to_string(),
                        refused: false,
                        identity_changed: true,
                    }))
                } else {
                    Ok(())
                }
            },
            Duration::from_secs(30),
            Duration::from_secs(600),
            |delay| slept += delay,
        );
        assert!(result.is_ok());
        assert_eq!((attempts, slept), (2, Duration::from_secs(1)));

        let mut attempts = 0;
        let result = prepare_until_settled(
            || {
                attempts += 1;
                Err(NeuralError::Engine(EngineFailure {
                    reason: "still changing".to_string(),
                    refused: false,
                    identity_changed: true,
                }))
            },
            Duration::from_secs(30),
            Duration::from_secs(600),
            |_| {},
        );
        assert!(result.is_err());
        assert_eq!(attempts, 2);

        let mut attempts = 0;
        let result = prepare_until_settled(
            || {
                attempts += 1;
                Err(engine("digest mismatch"))
            },
            Duration::from_secs(30),
            Duration::from_secs(600),
            |_| panic!("no retry"),
        );
        assert!(result.is_err());
        assert_eq!(attempts, 1);
    }

    #[cfg(unix)]
    #[test]
    fn only_a_load_the_helper_refuses_is_recorded_as_permanent() {
        let build = "26B5112a";
        let encoder = PARAKEET_V3_COREML.encoder;
        let units = ComputeUnits::CpuAndNeuralEngine;
        for (label, on_load, timeout) in [
            ("hang", LOAD_HANGS, Duration::from_millis(300)),
            ("killed", LOAD_KILLED, Duration::from_secs(5)),
        ] {
            let dir = unique_dir(label);
            let result = prepare_with(
                &dir,
                &PARAKEET_V3_COREML,
                units,
                build,
                || false,
                || Ok(()),
                fake_spawn(on_load),
                timeout,
            );
            assert!(
                matches!(&result, Err(NeuralError::Engine(failure)) if !failure.refused),
                "{label}: {result:?}"
            );
            assert_eq!(
                prepare_state_for(read_marker(&dir).as_ref(), build, encoder, units),
                PrepareState::NeedsPrepare,
                "{label}"
            );
            let _ = std::fs::remove_dir_all(dir);
        }

        let dir = unique_dir("refused");
        let result = prepare_with(
            &dir,
            &PARAKEET_V3_COREML,
            units,
            build,
            || false,
            || Ok(()),
            fake_spawn(LOAD_REFUSED),
            Duration::from_secs(5),
        );
        assert!(matches!(&result, Err(NeuralError::Engine(failure)) if failure.refused));
        assert!(matches!(
            prepare_state_for(read_marker(&dir).as_ref(), build, encoder, units),
            PrepareState::Failed(reason) if reason.contains("compile failed")
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn repeated_load_failures_on_one_macos_build_give_up_until_an_update() {
        let dir = unique_dir("load-failures");
        let spec = &PARAKEET_V2_COREML;
        let units = ComputeUnits::CpuAndNeuralEngine;
        write_marker(&dir, &marker_for(spec, "26B5112a", units, Ok(14_000)));
        assert_eq!(
            note_load_failure(&dir, spec, "26B5112a", units, "hello timed out"),
            1
        );
        assert_eq!(
            note_load_failure(&dir, spec, "26B5112a", units, "exited"),
            2
        );
        assert_eq!(
            prepare_state_for(read_marker(&dir).as_ref(), "26B5112a", spec.encoder, units),
            PrepareState::Prepared
        );
        // A success in between starts the count again.
        clear_load_failures(&dir);
        assert_eq!(
            note_load_failure(&dir, spec, "26B5112a", units, "exited"),
            1
        );
        assert_eq!(
            note_load_failure(&dir, spec, "26B5112a", units, "exited"),
            2
        );
        // Counts from another macOS build do not carry over.
        assert_eq!(note_load_failure(&dir, spec, "26C1", units, "exited"), 1);
        assert_eq!(note_load_failure(&dir, spec, "26C1", units, "exited"), 2);
        assert_eq!(note_load_failure(&dir, spec, "26C1", units, "exited"), 3);
        assert!(matches!(
            prepare_state_for(read_marker(&dir).as_ref(), "26C1", spec.encoder, units),
            PrepareState::Failed(reason) if reason.contains("3 loads in a row")
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn repeated_failures_back_off_exponentially() {
        assert_eq!(backoff_delay(1), FAILURE_BACKOFF_BASE);
        assert_eq!(backoff_delay(2), FAILURE_BACKOFF_BASE * 2);
        assert_eq!(backoff_delay(3), FAILURE_BACKOFF_BASE * 4);
        assert_eq!(backoff_delay(40), FAILURE_BACKOFF_MAX);
        let mut backoff = Backoff::new();
        let now = Instant::now();
        assert!(!backoff.active(now));
        backoff.fail(now, "exited");
        let second = backoff.fail(now, "exited");
        assert_eq!(second, FAILURE_BACKOFF_BASE * 2);
        assert!(backoff.active(now + FAILURE_BACKOFF_BASE));
        assert!(!backoff.active(now + second));
        backoff.succeed();
        assert!(!backoff.active(now));
        assert_eq!(backoff.fail(now, "exited"), FAILURE_BACKOFF_BASE);
    }

    #[cfg(unix)]
    #[test]
    fn the_helper_says_hello_before_the_resident_ggml_model_is_released() {
        let root = unique_dir("evict");
        let mut evicted = false;
        let mut slot = None;
        let result = ensure_loaded_with(
            &mut slot,
            &root,
            &PARAKEET_V3_COREML,
            ComputeUnits::CpuAndNeuralEngine,
            "26B5112a",
            || Err(engine("the speech helper did not answer within 10s")),
            || evicted = true,
            Duration::from_secs(1),
        );
        assert!(result.is_err());
        assert!(
            !evicted,
            "a helper that never came up must not cost the ggml model"
        );

        let result = ensure_loaded_with(
            &mut slot,
            &root,
            &PARAKEET_V3_COREML,
            ComputeUnits::CpuAndNeuralEngine,
            "26B5112a",
            fake_spawn(LOAD_OK),
            || evicted = true,
            Duration::from_secs(5),
        );
        assert!(result.is_ok(), "{result:?}");
        assert!(evicted);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn a_model_loaded_with_other_compute_units_is_reloaded() {
        let root = unique_dir("reload-units");
        let mut slot = None;
        let units = ComputeUnits::CpuAndNeuralEngine;
        let result = ensure_loaded_with(
            &mut slot,
            &root,
            &PARAKEET_V3_COREML,
            units,
            "26B5112a",
            fake_spawn(LOAD_OK),
            || {},
            Duration::from_secs(5),
        );
        assert!(result.is_ok(), "{result:?}");
        assert!(slot.as_ref().is_some_and(|helper| {
            helper.loaded.as_ref()
                == Some(&LoadedModel {
                    dir: PARAKEET_V3_COREML.dir(&root),
                    units,
                })
        }));
        // Same directory, other compute units: the helper is asked again.
        let result = ensure_loaded_with(
            &mut slot,
            &root,
            &PARAKEET_V3_COREML,
            ComputeUnits::CpuOnly,
            "26B5112a",
            || panic!("the helper is already running"),
            || {},
            Duration::from_secs(5),
        );
        assert_eq!(result.ok().flatten(), Some(300));
        assert!(slot.as_ref().is_some_and(|helper| {
            helper.loaded.as_ref()
                == Some(&LoadedModel {
                    dir: PARAKEET_V3_COREML.dir(&root),
                    units: ComputeUnits::CpuOnly,
                })
        }));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recording_a_failure_never_waits_for_the_helper() {
        // A request in flight holds the helper slot. Before, recording a
        // failure stopped the helper under that lock, from async code.
        let busy = lock_helper();
        let (done, recorded) = mpsc::channel();
        std::thread::spawn(move || {
            record_failure(&EngineFailure {
                reason: "test".to_string(),
                refused: false,
                identity_changed: false,
            });
            let _ = done.send(());
        });
        let result = recorded.recv_timeout(Duration::from_secs(2));
        drop(busy);
        record_success();
        assert!(result.is_ok(), "record_failure blocked on the helper slot");
    }

    #[test]
    fn decode_admission_never_waits_for_the_helper_slot() {
        // transcribe_blocking holds the helper slot through admission, so an
        // admission or speech-precedence step that took it would deadlock.
        let busy = lock_helper();
        let (done, admitted) = mpsc::channel();
        std::thread::spawn(move || {
            for resident in [true, false] {
                drop(crate::llm::local_model_load::admit_neural_engine_decode(
                    1, resident,
                ));
                // More than any Mac has: refused for headroom.
                drop(crate::llm::local_model_load::admit_neural_engine_decode(
                    1 << 50,
                    resident,
                ));
            }
            drop(crate::llm::local_model_load::admit_neural_engine_speech(
                1 << 50,
            ));
            // The precedence retry's release steps, minus stopping other work.
            crate::llm::native_text::end_idle_helper_unless(|_| true);
            crate::llm::speech_priority::PRECEDENCE.wait_for_stopped(Duration::from_millis(1));
            let _ = done.send(());
        });
        let result = admitted.recv_timeout(Duration::from_secs(10));
        drop(busy);
        assert!(
            result.is_ok(),
            "speech admission blocked on the helper slot"
        );
    }

    #[test]
    fn maintenance_downloads_missing_files_and_compiles_stale_ones() {
        assert_eq!(
            maintenance_step(false, true, &PrepareState::Prepared),
            MaintenanceStep::Download
        );
        assert_eq!(
            maintenance_step(true, true, &PrepareState::NeedsPrepare),
            MaintenanceStep::Prepare
        );
        assert_eq!(
            maintenance_step(true, true, &PrepareState::Prepared),
            MaintenanceStep::Nothing
        );
        assert_eq!(
            maintenance_step(true, true, &PrepareState::Failed("x".into())),
            MaintenanceStep::Nothing
        );
    }

    #[test]
    fn maintenance_never_starts_a_download_nobody_chose() {
        for state in [
            PrepareState::Prepared,
            PrepareState::NeedsPrepare,
            PrepareState::Failed("x".into()),
        ] {
            assert_eq!(
                maintenance_step(false, false, &state),
                MaintenanceStep::Nothing,
                "{state:?}"
            );
        }
        // Files already here only need compiling, which fetches nothing.
        assert_eq!(
            maintenance_step(true, false, &PrepareState::NeedsPrepare),
            MaintenanceStep::Prepare
        );
    }

    #[test]
    fn the_parakeet_download_counts_as_chosen_only_once_its_file_is_here() {
        use crate::asr::transcribe_cpp::{
            spec_for, PARAKEET_GGUF_MODEL_ID, TRANSCRIBE_CPP_MODEL_DIR,
        };
        let root = std::env::temp_dir().join(format!("neural-chosen-{}", uuid::Uuid::new_v4()));
        assert!(!parakeet_download_chosen(&root), "fresh install");

        let model_dir = root.join(TRANSCRIBE_CPP_MODEL_DIR);
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(
            model_dir.join(spec_for(PARAKEET_GGUF_MODEL_ID).file_name),
            b"GGUF",
        )
        .unwrap();
        assert!(parakeet_download_chosen(&root));
        let _ = std::fs::remove_dir_all(root);
    }

    /// Write a prepared marker for `spec` that matches this Mac, so the plan
    /// sees a speech model that already serves.
    fn mark_prepared(root: &Path, spec: &ModelSpec) {
        let dir = spec.dir(root);
        std::fs::create_dir_all(&dir).unwrap();
        write_marker(
            &dir,
            &PreparedMarker {
                os_build: macos_build(),
                engine_version: HELPER_ENGINE_VERSION.to_string(),
                encoder: spec.encoder.to_string(),
                compute_units: compute_units().request_value().to_string(),
                ok: true,
                error: None,
                load_ms: None,
            },
        );
        assert_eq!(prepare_state(root, spec), PrepareState::Prepared);
    }

    /// The plan as (speech step, vocabulary step and model id).
    fn plan_for(
        root: &Path,
        speech: &'static ModelSpec,
    ) -> (MaintenanceStep, Option<(MaintenanceStep, &'static str)>) {
        let plan = plan_maintenance(root, speech, Some(&PARAKEET_CTC_VOCABULARY));
        (
            plan.speech,
            plan.vocabulary.map(|(step, spec)| (step, spec.model_id)),
        )
    }

    #[test]
    fn a_fresh_install_starts_neither_download() {
        for speech in MODEL_SPECS {
            let root = std::env::temp_dir().join(format!("neural-fresh-{}", uuid::Uuid::new_v4()));
            assert_eq!(
                plan_for(&root, speech),
                (MaintenanceStep::Nothing, None),
                "{}",
                speech.model_id
            );
            // Even beside a speech model that looks prepared (a marker left
            // behind), the vocabulary model is not fetched without the
            // user's choice.
            mark_prepared(&root, speech);
            assert_eq!(
                plan_for(&root, speech),
                (
                    MaintenanceStep::Nothing,
                    Some((MaintenanceStep::Nothing, PARAKEET_CTC_VOCABULARY.model_id))
                ),
                "{}",
                speech.model_id
            );
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn an_upgrader_with_parakeet_gets_the_speech_model_first() {
        use crate::asr::transcribe_cpp::{
            spec_for, PARAKEET_GGUF_MODEL_ID, TRANSCRIBE_CPP_MODEL_DIR,
        };
        let root = std::env::temp_dir().join(format!("neural-upgrade-{}", uuid::Uuid::new_v4()));
        let model_dir = root.join(TRANSCRIBE_CPP_MODEL_DIR);
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(
            model_dir.join(spec_for(PARAKEET_GGUF_MODEL_ID).file_name),
            b"GGUF",
        )
        .unwrap();
        // `download_with_notice` runs for this step: the visible notice.
        assert_eq!(
            plan_for(&root, &PARAKEET_V3_COREML),
            (MaintenanceStep::Download, None)
        );
        // A marker without its files is fetched again, not trusted.
        mark_prepared(&root, &PARAKEET_V3_COREML);
        assert_eq!(
            plan_for(&root, &PARAKEET_V3_COREML),
            (MaintenanceStep::Download, None)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_vocabulary_model_comes_only_with_the_speech_model_and_english() {
        let id = |spec: Option<&'static ModelSpec>| spec.map(|spec| spec.model_id);
        assert_eq!(id(vocabulary_spec_for(None, true)), None);
        assert_eq!(
            id(vocabulary_spec_for(Some(&PARAKEET_V3_COREML), false)),
            None
        );
        assert_eq!(
            id(vocabulary_spec_for(Some(&PARAKEET_V2_COREML), true)),
            Some(PARAKEET_CTC_VOCABULARY.model_id)
        );
    }

    #[test]
    fn the_core_ml_download_counts_every_pinned_byte() {
        assert_eq!(coreml_download_bytes_for(None, None), None);
        assert_eq!(
            coreml_download_bytes_for(Some(&PARAKEET_V3_COREML), None),
            Some(632_169_729)
        );
        assert_eq!(
            coreml_download_bytes_for(Some(&PARAKEET_V3_COREML), Some(&PARAKEET_CTC_VOCABULARY)),
            Some(632_169_729 + 102_802_576)
        );
        assert_eq!(
            coreml_download_bytes_for(Some(&PARAKEET_V2_COREML), Some(&PARAKEET_CTC_VOCABULARY)),
            Some(464_413_247 + 102_802_576)
        );
    }

    #[test]
    fn download_notices_report_whole_percents_and_skip_repeats() {
        let total = PARAKEET_V2_COREML.total_bytes();
        let mut current = DownloadNotice::IDLE;
        assert!(update_notice(
            &mut current,
            DownloadNotice::downloading(41.2, total)
        ));
        assert_eq!(current.percent, 41);
        assert_eq!(current.state, NoticeState::Downloading);
        assert!(!update_notice(
            &mut current,
            DownloadNotice::downloading(41.9, total)
        ));
        assert!(update_notice(
            &mut current,
            DownloadNotice::downloading(42.0, total)
        ));
        assert_eq!(DownloadNotice::downloading(f32::NAN, total).percent, 0);
        assert_eq!(DownloadNotice::downloading(250.0, total).percent, 100);
        assert_eq!(
            serde_json::to_value(DownloadNotice::downloading(5.0, 10)).unwrap(),
            serde_json::json!({"state":"downloading","percent":5,"totalBytes":10,"needed":false})
        );
        assert_eq!(
            serde_json::to_value(DownloadNotice::failed(10).needed()).unwrap(),
            serde_json::json!({"state":"failed","percent":0,"totalBytes":10,"needed":true})
        );
    }

    #[test]
    fn a_first_use_compile_is_admitted_at_the_cold_load_allowance() {
        let cold = DecodeResidency {
            model: false,
            vocabulary: false,
        };
        let ane = ComputeUnits::CpuAndNeuralEngine;
        assert_eq!(
            transcription_memory_allowance(0, false, cold, true, ane),
            COLD_LOAD_ALLOWANCE
        );
        assert!(
            transcription_memory_allowance(0, false, cold, true, ane)
                > transcription_memory_allowance(0, false, cold, false, ane)
        );
    }

    #[test]
    fn the_cpu_route_admits_against_its_own_smaller_allowances() {
        let cold = DecodeResidency {
            model: false,
            vocabulary: false,
        };
        let cpu = ComputeUnits::CpuOnly;
        assert_eq!(
            transcription_memory_allowance(0, false, cold, true, cpu),
            CPU_ONLY_COLD_LOAD_ALLOWANCE
        );
        assert_eq!(
            transcription_memory_allowance(0, false, cold, false, cpu),
            CPU_ONLY_WARM_LOAD_ALLOWANCE
        );
        // The measured basis for the fit: a CPU load wires nothing, so its
        // allowances are far below the Neural Engine route's, and the Light
        // tier's 1 GiB dictation budget keeps room for the decode.
        const {
            assert!(CPU_ONLY_COLD_LOAD_ALLOWANCE < WARM_LOAD_ALLOWANCE);
            assert!(CPU_ONLY_WARM_LOAD_ALLOWANCE < WARM_LOAD_ALLOWANCE);
        }
        // A resident decode is the same working set on both routes.
        let resident = DecodeResidency {
            model: true,
            vocabulary: false,
        };
        assert_eq!(
            transcription_memory_allowance(0, false, resident, false, cpu),
            transcription_memory_allowance(
                0,
                false,
                resident,
                false,
                ComputeUnits::CpuAndNeuralEngine
            )
        );
    }

    /// Placeholder bytes for every pinned file of `spec`: readiness checks
    /// presence and this session's verdicts, never hashes.
    fn install_files(root: &Path, spec: &ModelSpec) {
        let dir = spec.dir(root);
        for file in spec.files {
            let path = dir.join(file.path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"x").unwrap();
        }
        assert!(spec.files_installed(root), "{}", spec.model_id);
    }

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("neural-{label}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn a_core_ml_build_alone_counts_as_the_parakeet_download() {
        for speech in MODEL_SPECS {
            let root = temp_root("coreml-chosen");
            install_files(&root, speech);
            assert!(parakeet_download_chosen(&root), "{}", speech.model_id);
            assert!(bundle_installed(&root, speech.model_id));
            let _ = std::fs::remove_dir_all(root);
        }
        // The vocabulary model never transcribes, so it is not a copy.
        let root = temp_root("vocabulary-only");
        install_files(&root, &PARAKEET_CTC_VOCABULARY);
        assert!(!parakeet_download_chosen(&root));
        assert!(bundle_installed(&root, PARAKEET_CTC_VOCABULARY.model_id));
        assert!(!bundle_installed(&root, PARAKEET_V3_COREML.model_id));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_ggml_file_is_fetched_only_when_nothing_else_can_serve() {
        // The user never chose Parakeet's download: nothing, ever.
        assert_eq!(ggml_need_for(false, false, false, false), GgmlNeed::Nothing);
        assert_eq!(ggml_need_for(false, false, false, true), GgmlNeed::Nothing);
        // Already here, or the Core ML build serves (now or after its
        // first-use compile).
        assert_eq!(ggml_need_for(true, true, false, false), GgmlNeed::Nothing);
        assert_eq!(ggml_need_for(false, true, true, false), GgmlNeed::Nothing);
        // A language switch: this family's own build comes next.
        assert_eq!(
            ggml_need_for(false, true, false, true),
            GgmlNeed::CoreMlForFamily
        );
        // Backing off after a failure, a compile this macOS refused, a Mac
        // that cannot run the route, or the override forcing ggml.
        assert_eq!(ggml_need_for(false, true, false, false), GgmlNeed::Ggml);
    }

    #[test]
    fn the_ggml_override_makes_the_download_fetch_the_ggml_file() {
        for platform in [true, false] {
            let supported = route_supported_with(RuntimeOverride::Ggml, platform);
            assert!(!supported);
            assert!(spec_to_download_for(supported, Family::Multilingual).is_none());
            assert!(coreml_download_bytes_for(
                spec_to_download_for(supported, Family::English),
                None
            )
            .is_none());
        }
        // Without the override a supported Mac fetches only the Core ML build.
        for runtime in [RuntimeOverride::Auto, RuntimeOverride::NeuralEngine] {
            let supported = route_supported_with(runtime, true);
            assert_eq!(
                spec_to_download_for(supported, Family::Multilingual).map(|spec| spec.model_id),
                Some(PARAKEET_V3_COREML.model_id)
            );
            assert!(!route_supported_with(runtime, false));
        }
        // An install holding only the Core ML build, under the override:
        // nothing serves without ggml, so maintenance fetches the ggml file.
        assert_eq!(ggml_need_for(false, true, false, false), GgmlNeed::Ggml);
    }

    #[test]
    fn light_with_gguf_prepares_trusted_coreml_instead_of_using_gguf() {
        let root = temp_root("light-with-gguf");
        install_files(&root, &PARAKEET_V3_COREML);
        let spec = &PARAKEET_V3_COREML;
        // A copied profile prepared on ANE is not prepared on the Light CPU.
        write_marker(
            &spec.dir(&root),
            &marker_for(
                spec,
                &macos_build(),
                ComputeUnits::CpuAndNeuralEngine,
                Ok(100),
            ),
        );
        assert_eq!(
            prepare_state_with_units(&root, spec, ComputeUnits::CpuOnly),
            PrepareState::NeedsPrepare
        );
        assert_eq!(
            request_spec_with_units(&root, Family::Multilingual, true, ComputeUnits::CpuOnly)
                .map(|s| s.model_id),
            Some(spec.model_id)
        );
        // A missing marker takes the same fast first-use path.
        std::fs::remove_file(spec.dir(&root).join(PREPARED_MARKER)).unwrap();
        assert_eq!(
            request_spec_with_units(&root, Family::Multilingual, true, ComputeUnits::CpuOnly)
                .map(|s| s.model_id),
            Some(spec.model_id)
        );
        // A genuine CPU preparation failure still leaves GGUF as fallback.
        write_marker(
            &spec.dir(&root),
            &marker_for(
                spec,
                &macos_build(),
                ComputeUnits::CpuOnly,
                Err("broken model".into()),
            ),
        );
        assert!(
            request_spec_with_units(&root, Family::Multilingual, true, ComputeUnits::CpuOnly)
                .is_none()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copying_a_matching_preparation_marker_preserves_its_state() {
        let root = temp_root("copied-marker");
        let copied = temp_root("copied-marker-destination");
        let spec = &PARAKEET_V3_COREML;
        std::fs::create_dir_all(spec.dir(&root)).unwrap();
        std::fs::create_dir_all(spec.dir(&copied)).unwrap();
        write_marker(
            &spec.dir(&root),
            &marker_for(spec, "build", ComputeUnits::CpuOnly, Ok(3000)),
        );
        std::fs::copy(
            spec.dir(&root).join(PREPARED_MARKER),
            spec.dir(&copied).join(PREPARED_MARKER),
        )
        .unwrap();
        assert_eq!(
            prepare_state_for(
                read_marker(&spec.dir(&copied)).as_ref(),
                "build",
                spec.encoder,
                ComputeUnits::CpuOnly
            ),
            PrepareState::Prepared
        );
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(copied).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn cpu_prepare_does_not_wait_for_the_ane_speech_policy() {
        let dir = unique_dir("cpu-prepare-during-speech");
        let result = prepare_with(
            &dir,
            &PARAKEET_V3_COREML,
            ComputeUnits::CpuOnly,
            "build",
            || true,
            || Ok(()),
            fake_spawn(LOAD_OK),
            Duration::from_secs(5),
        );
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(
            prepare_state_for(
                read_marker(&dir).as_ref(),
                "build",
                PARAKEET_V3_COREML.encoder,
                ComputeUnits::CpuOnly
            ),
            PrepareState::Prepared
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_core_ml_only_install_serves_by_compiling_on_first_use() {
        let root = temp_root("first-use");
        install_files(&root, &PARAKEET_V3_COREML);
        let family = Family::Multilingual;
        if route_usable_now() {
            // No ggml file: the request compiles the verified model itself.
            assert_eq!(
                request_spec_for_family(&root, family, false).map(|spec| spec.model_id),
                Some(PARAKEET_V3_COREML.model_id)
            );
            assert!(serves_without_ggml(&root, family));
            assert!(first_use_compile_pending(&root, family, false));
            assert!(coreml_files_present(&root, family));
            assert_eq!(ggml_need(&root, family), GgmlNeed::Nothing);
            // With the ggml file here, ggml serves until the background
            // compile finishes, as before.
            let cpu = compute_units() == ComputeUnits::CpuOnly;
            assert_eq!(request_spec_for_family(&root, family, true).is_some(), cpu);
            assert_eq!(first_use_compile_pending(&root, family, true), cpu);

            mark_prepared(&root, &PARAKEET_V3_COREML);
            assert!(!first_use_compile_pending(&root, family, false));
            assert_eq!(
                request_spec_for_family(&root, family, true).map(|spec| spec.model_id),
                Some(PARAKEET_V3_COREML.model_id)
            );
        } else {
            // A Mac that cannot run the route: only the ggml file serves, so
            // the download the user chose fetches it.
            assert!(request_spec_for_family(&root, family, false).is_none());
            assert!(!serves_without_ggml(&root, family));
            assert!(!first_use_compile_pending(&root, family, false));
            assert_eq!(ggml_need(&root, family), GgmlNeed::Ggml);
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_compile_this_macos_refused_leaves_only_the_ggml_file() {
        let root = temp_root("refused");
        install_files(&root, &PARAKEET_V3_COREML);
        write_marker(
            &PARAKEET_V3_COREML.dir(&root),
            &marker_for(
                &PARAKEET_V3_COREML,
                &macos_build(),
                compute_units(),
                Err("refused".to_string()),
            ),
        );
        let family = Family::Multilingual;
        assert!(request_spec_for_family(&root, family, false).is_none());
        assert!(!first_use_compile_pending(&root, family, false));
        assert_eq!(ggml_need(&root, family), GgmlNeed::Ggml);
        // No runtime in a unit test: the start is reported, never spawned.
        assert_eq!(
            fetch_ggml_if_needed(&root, family),
            Some(NeededDownload::Failed)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn a_needed_ggml_download_starts_once_and_never_loops() {
        let root = temp_root("needed");
        install_files(&root, &PARAKEET_V3_COREML);
        write_marker(
            &PARAKEET_V3_COREML.dir(&root),
            &marker_for(
                &PARAKEET_V3_COREML,
                &macos_build(),
                compute_units(),
                Err("refused".to_string()),
            ),
        );
        let family = Family::Multilingual;
        assert_eq!(
            fetch_ggml_if_needed(&root, family),
            Some(NeededDownload::Running)
        );
        // A ggml file on disk ends the need.
        let ggml = root
            .join(crate::asr::transcribe_cpp::TRANSCRIBE_CPP_MODEL_DIR)
            .join(
                crate::asr::transcribe_cpp::spec_for(
                    crate::asr::transcribe_cpp::PARAKEET_GGUF_MODEL_ID,
                )
                .file_name,
            );
        std::fs::create_dir_all(ggml.parent().unwrap()).unwrap();
        std::fs::write(&ggml, b"GGUF").unwrap();
        assert_eq!(fetch_ggml_if_needed(&root, family), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_request_on_an_uncompiled_model_takes_the_compile_slot() {
        let root = temp_root("compile-slot");
        install_files(&root, &PARAKEET_V3_COREML);
        let never = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(30);
        let guard = compile_before_decode(&root, &PARAKEET_V3_COREML, &never, deadline)
            .unwrap_or_else(|_| panic!("the slot is free"));
        assert!(guard.is_some(), "needs a compile");
        drop(guard);

        mark_prepared(&root, &PARAKEET_V3_COREML);
        assert!(matches!(
            compile_before_decode(&root, &PARAKEET_V3_COREML, &never, deadline),
            Ok(None)
        ));

        write_marker(
            &PARAKEET_V3_COREML.dir(&root),
            &marker_for(
                &PARAKEET_V3_COREML,
                &macos_build(),
                compute_units(),
                Err("refused".to_string()),
            ),
        );
        assert!(matches!(
            compile_before_decode(&root, &PARAKEET_V3_COREML, &never, deadline),
            Err(NeuralError::Engine(_))
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn each_family_has_its_own_name_in_history() {
        assert_eq!(PARAKEET_V2_COREML.display_name, "Parakeet TDT 0.6B v2");
        assert_eq!(PARAKEET_V3_COREML.display_name, "Parakeet TDT 0.6B v3");
    }

    /// The helper exits when the sidecar that started it dies, even while
    /// its stdin is still open elsewhere (a wedged load never reads EOF).
    #[cfg(target_os = "macos")]
    #[test]
    fn the_helper_exits_when_its_parent_dies() {
        let helper = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("dist-native")
            .join(HELPER_BINARY_NAME);
        if !helper.is_file() {
            eprintln!("skipping: {} is not built", helper.display());
            return;
        }
        // The outer python keeps the helper's stdin open; the middle one is
        // the helper's parent and exits at once.
        let script = format!(
            "import os, subprocess, sys, time\n\
             r, w = os.pipe()\n\
             pid = os.fork()\n\
             if pid == 0:\n    \
                 p = subprocess.Popen([{helper:?}], stdin=r, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n    \
                 print(p.pid, flush=True)\n    \
                 os._exit(0)\n\
             os.waitpid(pid, 0)\n\
             sys.stdin.readline()\n",
            helper = helper.display().to_string()
        );
        let mut outer = Command::new("/usr/bin/python3")
            .args(["-c", &script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(outer.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let pid: libc::pid_t = line.trim().parse().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut alive = true;
        while Instant::now() < deadline {
            if unsafe { libc::kill(pid, 0) } != 0 {
                alive = false;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if alive {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        drop(outer.stdin.take());
        let _ = outer.wait();
        assert!(!alive, "the helper outlived its parent");
    }

    #[test]
    fn residency_long_input_reserves_the_protocol_buffers() {
        // Rust's payload plus the helper's read buffer, payload and f32 array.
        let protocol_copies = 4 * std::mem::size_of::<f32>() as u64 * MAX_SAMPLE_COUNT as u64;
        let cold = DecodeResidency {
            model: false,
            vocabulary: false,
        };
        let ane = ComputeUnits::CpuAndNeuralEngine;
        assert!(
            transcription_memory_allowance(MAX_SAMPLE_COUNT, false, cold, false, ane)
                >= WARM_LOAD_ALLOWANCE + protocol_copies
        );
        assert_eq!(
            transcription_memory_allowance(0, false, cold, false, ane),
            WARM_LOAD_ALLOWANCE
        );
        assert_eq!(
            transcription_memory_allowance(0, true, cold, false, ane),
            WARM_LOAD_ALLOWANCE + VOCABULARY_MODEL_ALLOWANCE
        );
        let warm = DecodeResidency {
            model: true,
            vocabulary: true,
        };
        assert!(
            transcription_memory_allowance(MAX_SAMPLE_COUNT, true, warm, false, ane)
                >= RESIDENT_DECODE_ALLOWANCE + RESIDENT_VOCABULARY_ALLOWANCE + protocol_copies
        );
    }

    #[test]
    fn a_decode_on_a_loaded_helper_claims_only_its_own_memory() {
        let models = DecodeResidency {
            model: true,
            vocabulary: false,
        };
        let ane = ComputeUnits::CpuAndNeuralEngine;
        let ten_seconds = 16_000 * 10;
        let copies = ten_seconds as u64 * 16;
        assert_eq!(
            transcription_memory_allowance(ten_seconds, false, models, false, ane),
            RESIDENT_DECODE_ALLOWANCE + copies
        );
        assert!(models.resident(false));
        // The vocabulary model still has to load, so this is a load.
        assert_eq!(
            transcription_memory_allowance(ten_seconds, true, models, false, ane),
            RESIDENT_DECODE_ALLOWANCE + VOCABULARY_MODEL_ALLOWANCE + copies
        );
        assert!(!models.resident(true));
        let both = DecodeResidency {
            model: true,
            vocabulary: true,
        };
        assert!(both.resident(true));
        assert!(
            transcription_memory_allowance(ten_seconds, true, both, false, ane)
                < transcription_memory_allowance(
                    ten_seconds,
                    true,
                    DecodeResidency {
                        model: false,
                        vocabulary: false
                    },
                    false,
                    ane
                ) / 4
        );
        // A helper holding another model, or none, is a load.
        assert!(!DecodeResidency::of(&None, Path::new("/m"), ane).resident(false));
    }

    #[test]
    fn vocabulary_request_marks_only_user_terms_for_expanded_matching() {
        let terms = [
            super::super::AcousticVocabularyTerm {
                text: "ExampleName".into(),
                spoken: vec!["example name".into()],
                built_in: false,
            },
            super::super::AcousticVocabularyTerm {
                text: "BuiltInName".into(),
                spoken: Vec::new(),
                built_in: true,
            },
        ];
        let request = vocabulary_request(&terms).unwrap();
        assert_eq!(request["terms"][0]["personalized"], true);
        assert_eq!(request["terms"][0]["spoken"][0], "example name");
        assert_eq!(request["terms"][1]["personalized"], false);
        assert!(vocabulary_request(&[]).is_none());
    }

    #[test]
    fn decode_timeouts_grow_with_the_audio() {
        assert_eq!(transcription_timeout(0), TRANSCRIBE_TIMEOUT_FLOOR);
        assert_eq!(
            transcription_timeout(16_000 * 90),
            TRANSCRIBE_TIMEOUT_FLOOR + Duration::from_secs(45)
        );
    }
}

#[cfg(all(test, target_os = "macos", target_arch = "aarch64"))]
#[path = "speech_residency_probe.rs"]
mod residency_probe;
