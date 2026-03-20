use super::{
    python_runtime, AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptionResult,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};

const MANIFEST_FILE: &str = "manifest.json";

#[derive(Clone, Copy)]
struct MlxAudioModelSpec {
    id: &'static str,
    label: &'static str,
    name: &'static str,
    version: &'static str,
    parameters: &'static str,
    languages: &'static [&'static str],
    size_mb: f64,
    source_url: &'static str,
    downloadable: bool,
}

const MLX_AUDIO_MODEL_SPECS: &[MlxAudioModelSpec] = &[
    MlxAudioModelSpec {
        id: "mlx-community/whisper-tiny-asr-fp16",
        label: "Whisper Tiny (MLX)",
        name: "Whisper Tiny",
        version: "mlx-community/whisper-tiny-asr-fp16",
        parameters: "tiny",
        languages: &["99+ languages"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/whisper-tiny-asr-fp16",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/whisper-tiny.en-asr-fp16",
        label: "Whisper Tiny English (MLX)",
        name: "Whisper Tiny English",
        version: "mlx-community/whisper-tiny.en-asr-fp16",
        parameters: "tiny",
        languages: &["en"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/whisper-tiny.en-asr-fp16",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/whisper-base-asr-fp16",
        label: "Whisper Base (MLX)",
        name: "Whisper Base",
        version: "mlx-community/whisper-base-asr-fp16",
        parameters: "base",
        languages: &["99+ languages"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/whisper-base-asr-fp16",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/whisper-base.en-asr-fp16",
        label: "Whisper Base English (MLX)",
        name: "Whisper Base English",
        version: "mlx-community/whisper-base.en-asr-fp16",
        parameters: "base",
        languages: &["en"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/whisper-base.en-asr-fp16",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/whisper-small-asr-fp16",
        label: "Whisper Small (MLX)",
        name: "Whisper Small",
        version: "mlx-community/whisper-small-asr-fp16",
        parameters: "small",
        languages: &["99+ languages"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/whisper-small-asr-fp16",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/whisper-small.en-asr-fp16",
        label: "Whisper Small English (MLX)",
        name: "Whisper Small English",
        version: "mlx-community/whisper-small.en-asr-fp16",
        parameters: "small",
        languages: &["en"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/whisper-small.en-asr-fp16",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/whisper-medium-asr-fp16",
        label: "Whisper Medium (MLX)",
        name: "Whisper Medium",
        version: "mlx-community/whisper-medium-asr-fp16",
        parameters: "medium",
        languages: &["99+ languages"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/whisper-medium-asr-fp16",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/whisper-medium.en-asr-fp16",
        label: "Whisper Medium English (MLX)",
        name: "Whisper Medium English",
        version: "mlx-community/whisper-medium.en-asr-fp16",
        parameters: "medium",
        languages: &["en"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/whisper-medium.en-asr-fp16",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/whisper-large-v3-asr-fp16",
        label: "Whisper Large V3 (MLX)",
        name: "Whisper Large V3",
        version: "mlx-community/whisper-large-v3-asr-fp16",
        parameters: "large-v3",
        languages: &["99+ languages"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/whisper-large-v3-asr-fp16",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/whisper-large-v3-turbo-asr-fp16",
        label: "Whisper Large V3 Turbo (MLX)",
        name: "Whisper Large V3 Turbo",
        version: "mlx-community/whisper-large-v3-turbo-asr-fp16",
        parameters: "turbo",
        languages: &["99+ languages"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/whisper-large-v3-turbo-asr-fp16",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/Qwen3-ASR-0.6B-bf16",
        label: "Qwen3-ASR 0.6B (bf16)",
        name: "Qwen3-ASR 0.6B",
        version: "mlx-community/Qwen3-ASR-0.6B-bf16",
        parameters: "0.6B",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/Qwen3-ASR-0.6B-bf16",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/Qwen3-ASR-0.6B-4bit",
        label: "Qwen3-ASR 0.6B (4-bit)",
        name: "Qwen3-ASR 0.6B",
        version: "mlx-community/Qwen3-ASR-0.6B-4bit",
        parameters: "0.6B",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/Qwen3-ASR-0.6B-4bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/Qwen3-ASR-0.6B-5bit",
        label: "Qwen3-ASR 0.6B (5-bit)",
        name: "Qwen3-ASR 0.6B",
        version: "mlx-community/Qwen3-ASR-0.6B-5bit",
        parameters: "0.6B",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/Qwen3-ASR-0.6B-5bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/Qwen3-ASR-0.6B-6bit",
        label: "Qwen3-ASR 0.6B (6-bit)",
        name: "Qwen3-ASR 0.6B",
        version: "mlx-community/Qwen3-ASR-0.6B-6bit",
        parameters: "0.6B",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/Qwen3-ASR-0.6B-6bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/Qwen3-ASR-0.6B-8bit",
        label: "Qwen3-ASR 0.6B (8-bit)",
        name: "Qwen3-ASR 0.6B",
        version: "mlx-community/Qwen3-ASR-0.6B-8bit",
        parameters: "0.6B",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/Qwen3-ASR-0.6B-8bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/Qwen3-ASR-1.7B-4bit",
        label: "Qwen3-ASR 1.7B (4-bit)",
        name: "Qwen3-ASR 1.7B",
        version: "mlx-community/Qwen3-ASR-1.7B-4bit",
        parameters: "1.7B",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/Qwen3-ASR-1.7B-4bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/Qwen3-ASR-1.7B-5bit",
        label: "Qwen3-ASR 1.7B (5-bit)",
        name: "Qwen3-ASR 1.7B",
        version: "mlx-community/Qwen3-ASR-1.7B-5bit",
        parameters: "1.7B",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/Qwen3-ASR-1.7B-5bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/Qwen3-ASR-1.7B-6bit",
        label: "Qwen3-ASR 1.7B (6-bit)",
        name: "Qwen3-ASR 1.7B",
        version: "mlx-community/Qwen3-ASR-1.7B-6bit",
        parameters: "1.7B",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/Qwen3-ASR-1.7B-6bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/Qwen3-ASR-1.7B-8bit",
        label: "Qwen3-ASR 1.7B (8-bit)",
        name: "Qwen3-ASR 1.7B",
        version: "mlx-community/Qwen3-ASR-1.7B-8bit",
        parameters: "1.7B",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/Qwen3-ASR-1.7B-8bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/Qwen3-ASR-1.7B-bf16",
        label: "Qwen3-ASR 1.7B (bf16)",
        name: "Qwen3-ASR 1.7B",
        version: "mlx-community/Qwen3-ASR-1.7B-bf16",
        parameters: "1.7B",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/Qwen3-ASR-1.7B-bf16",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/parakeet-tdt-0.6b-v2",
        label: "Parakeet TDT 0.6B v2 (MLX)",
        name: "Parakeet TDT 0.6B v2",
        version: "mlx-community/parakeet-tdt-0.6b-v2",
        parameters: "0.6B",
        languages: &["en"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v2",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/parakeet-tdt-0.6b-v3",
        label: "Parakeet TDT 0.6B v3 (MLX)",
        name: "Parakeet TDT 0.6B v3",
        version: "mlx-community/parakeet-tdt-0.6b-v3",
        parameters: "0.6B",
        languages: &["25 EU languages"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "UsefulSensors/moonshine-tiny",
        label: "Moonshine Tiny (MLX)",
        name: "Moonshine Tiny",
        version: "UsefulSensors/moonshine-tiny",
        parameters: "27M",
        languages: &["en"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/UsefulSensors/moonshine-tiny",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "UsefulSensors/moonshine-base",
        label: "Moonshine Base (MLX)",
        name: "Moonshine Base",
        version: "UsefulSensors/moonshine-base",
        parameters: "61M",
        languages: &["en"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/UsefulSensors/moonshine-base",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/Voxtral-Mini-3B-2507-bf16",
        label: "Voxtral Mini 3B 2507 (bf16)",
        name: "Voxtral Mini 3B",
        version: "mlx-community/Voxtral-Mini-3B-2507-bf16",
        parameters: "3B",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/Voxtral-Mini-3B-2507-bf16",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit",
        label: "Voxtral Realtime 4B (4-bit)",
        name: "Voxtral Realtime 4B",
        version: "mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit",
        parameters: "4B",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/Voxtral-Mini-4B-Realtime-2602-fp16",
        label: "Voxtral Realtime 4B (fp16)",
        name: "Voxtral Realtime 4B",
        version: "mlx-community/Voxtral-Mini-4B-Realtime-2602-fp16",
        parameters: "4B",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/Voxtral-Mini-4B-Realtime-2602-fp16",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/VibeVoice-ASR-4bit",
        label: "VibeVoice-ASR (4-bit)",
        name: "VibeVoice-ASR",
        version: "mlx-community/VibeVoice-ASR-4bit",
        parameters: "9B",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/VibeVoice-ASR-4bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/VibeVoice-ASR-5bit",
        label: "VibeVoice-ASR (5-bit)",
        name: "VibeVoice-ASR",
        version: "mlx-community/VibeVoice-ASR-5bit",
        parameters: "9B",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/VibeVoice-ASR-5bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/VibeVoice-ASR-6bit",
        label: "VibeVoice-ASR (6-bit)",
        name: "VibeVoice-ASR",
        version: "mlx-community/VibeVoice-ASR-6bit",
        parameters: "9B",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/VibeVoice-ASR-6bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/VibeVoice-ASR-8bit",
        label: "VibeVoice-ASR (8-bit)",
        name: "VibeVoice-ASR",
        version: "mlx-community/VibeVoice-ASR-8bit",
        parameters: "9B",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/VibeVoice-ASR-8bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/VibeVoice-ASR-bf16",
        label: "VibeVoice-ASR (bf16)",
        name: "VibeVoice-ASR",
        version: "mlx-community/VibeVoice-ASR-bf16",
        parameters: "9B",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/VibeVoice-ASR-bf16",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "canary-1b-v2-mlx",
        label: "Canary 1B v2 (local conversion)",
        name: "Canary 1B v2",
        version: "canary-1b-v2-mlx",
        parameters: "1B",
        languages: &["25 EU languages", "ru", "uk"],
        size_mb: 0.0,
        source_url:
            "https://github.com/Blaizzy/mlx-audio/blob/main/mlx_audio/stt/models/canary/README.md",
        downloadable: false,
    },
    MlxAudioModelSpec {
        id: "mlx-community/granite-4.0-1b-speech-bf16",
        label: "Granite Speech 4.0 1B (bf16)",
        name: "Granite Speech 4.0",
        version: "mlx-community/granite-4.0-1b-speech-bf16",
        parameters: "1B",
        languages: &["en", "fr", "de", "es", "pt", "ja"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/granite-4.0-1b-speech-bf16",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/granite-4.0-1b-speech-4bit",
        label: "Granite Speech 4.0 1B (4-bit)",
        name: "Granite Speech 4.0",
        version: "mlx-community/granite-4.0-1b-speech-4bit",
        parameters: "1B",
        languages: &["en", "fr", "de", "es", "pt", "ja"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/granite-4.0-1b-speech-4bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/granite-4.0-1b-speech-mxfp4",
        label: "Granite Speech 4.0 1B (mxfp4)",
        name: "Granite Speech 4.0",
        version: "mlx-community/granite-4.0-1b-speech-mxfp4",
        parameters: "1B",
        languages: &["en", "fr", "de", "es", "pt", "ja"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/granite-4.0-1b-speech-mxfp4",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/granite-4.0-1b-speech-5bit",
        label: "Granite Speech 4.0 1B (5-bit)",
        name: "Granite Speech 4.0",
        version: "mlx-community/granite-4.0-1b-speech-5bit",
        parameters: "1B",
        languages: &["en", "fr", "de", "es", "pt", "ja"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/granite-4.0-1b-speech-5bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/granite-4.0-1b-speech-6bit",
        label: "Granite Speech 4.0 1B (6-bit)",
        name: "Granite Speech 4.0",
        version: "mlx-community/granite-4.0-1b-speech-6bit",
        parameters: "1B",
        languages: &["en", "fr", "de", "es", "pt", "ja"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/granite-4.0-1b-speech-6bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/granite-4.0-1b-speech-8bit",
        label: "Granite Speech 4.0 1B (8-bit)",
        name: "Granite Speech 4.0",
        version: "mlx-community/granite-4.0-1b-speech-8bit",
        parameters: "1B",
        languages: &["en", "fr", "de", "es", "pt", "ja"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/granite-4.0-1b-speech-8bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "facebook/mms-1b",
        label: "MMS 1B",
        name: "MMS 1B",
        version: "facebook/mms-1b",
        parameters: "1B",
        languages: &["many languages"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/facebook/mms-1b",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "facebook/mms-1b-fl102",
        label: "MMS 1B FL102",
        name: "MMS 1B FL102",
        version: "facebook/mms-1b-fl102",
        parameters: "1B",
        languages: &["102 languages"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/facebook/mms-1b-fl102",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "facebook/mms-1b-all",
        label: "MMS 1B All",
        name: "MMS 1B All",
        version: "facebook/mms-1b-all",
        parameters: "1B",
        languages: &["1000+ languages"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/facebook/mms-1b-all",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "facebook/mms-1b-l1107",
        label: "MMS 1B L1107",
        name: "MMS 1B L1107",
        version: "facebook/mms-1b-l1107",
        parameters: "1B",
        languages: &["1,107 languages"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/facebook/mms-1b-l1107",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/FireRedASR2-AED-mlx",
        label: "FireRedASR2-AED",
        name: "FireRedASR2-AED",
        version: "mlx-community/FireRedASR2-AED-mlx",
        parameters: "unknown",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/FireRedASR2-AED-mlx",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/SenseVoiceSmall",
        label: "SenseVoice Small",
        name: "SenseVoice Small",
        version: "mlx-community/SenseVoiceSmall",
        parameters: "small",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/SenseVoiceSmall",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/GLM-ASR-Nano-2512-4bit",
        label: "GLM-ASR Nano 2512 (4-bit)",
        name: "GLM-ASR Nano 2512",
        version: "mlx-community/GLM-ASR-Nano-2512-4bit",
        parameters: "nano",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/GLM-ASR-Nano-2512-4bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/GLM-ASR-Nano-2512-5bit",
        label: "GLM-ASR Nano 2512 (5-bit)",
        name: "GLM-ASR Nano 2512",
        version: "mlx-community/GLM-ASR-Nano-2512-5bit",
        parameters: "nano",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/GLM-ASR-Nano-2512-5bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/GLM-ASR-Nano-2512-6bit",
        label: "GLM-ASR Nano 2512 (6-bit)",
        name: "GLM-ASR Nano 2512",
        version: "mlx-community/GLM-ASR-Nano-2512-6bit",
        parameters: "nano",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/GLM-ASR-Nano-2512-6bit",
        downloadable: true,
    },
    MlxAudioModelSpec {
        id: "mlx-community/GLM-ASR-Nano-2512-8bit",
        label: "GLM-ASR Nano 2512 (8-bit)",
        name: "GLM-ASR Nano 2512",
        version: "mlx-community/GLM-ASR-Nano-2512-8bit",
        parameters: "nano",
        languages: &["multilingual"],
        size_mb: 0.0,
        source_url: "https://huggingface.co/mlx-community/GLM-ASR-Nano-2512-8bit",
        downloadable: true,
    },
];

pub fn default_model_id() -> &'static str {
    "mlx-community/whisper-large-v3-turbo-asr-fp16"
}

pub fn model_options() -> Vec<super::ModelOption> {
    MLX_AUDIO_MODEL_SPECS
        .iter()
        .map(|spec| super::ModelOption {
            id: spec.id.to_string(),
            label: spec.label.to_string(),
        })
        .collect()
}

pub fn supports_visible_provider(provider_type: AsrProviderType) -> bool {
    matches!(
        provider_type,
        AsrProviderType::Moonshine
            | AsrProviderType::Whisper
            | AsrProviderType::Parakeet
            | AsrProviderType::Voxtral
    )
}

pub fn mapped_model_for_visible_route(
    provider_type: AsrProviderType,
    model_id: &str,
) -> Option<&'static str> {
    match provider_type {
        AsrProviderType::Moonshine => match model_id.trim() {
            "moonshine-tiny" => Some("UsefulSensors/moonshine-tiny"),
            "moonshine" | "moonshine-base" => Some("UsefulSensors/moonshine-base"),
            _ => None,
        },
        AsrProviderType::Whisper => match model_id.trim() {
            "tiny" => Some("mlx-community/whisper-tiny-asr-fp16"),
            "tiny.en" => Some("mlx-community/whisper-tiny.en-asr-fp16"),
            "base" => Some("mlx-community/whisper-base-asr-fp16"),
            "base.en" => Some("mlx-community/whisper-base.en-asr-fp16"),
            "small" => Some("mlx-community/whisper-small-asr-fp16"),
            "small.en" => Some("mlx-community/whisper-small.en-asr-fp16"),
            "medium" => Some("mlx-community/whisper-medium-asr-fp16"),
            "medium.en" => Some("mlx-community/whisper-medium.en-asr-fp16"),
            "large-v3" => Some("mlx-community/whisper-large-v3-asr-fp16"),
            "large-v3-turbo" => Some("mlx-community/whisper-large-v3-turbo-asr-fp16"),
            _ => None,
        },
        // parakeet-ctc-0.6b is the v3 multilingual model; legacy 110m has no MLX equivalent
        AsrProviderType::Parakeet => match model_id.trim() {
            "parakeet-ctc-0.6b" | "parakeet-tdt-0.6b-v3" => {
                Some("mlx-community/parakeet-tdt-0.6b-v3")
            }
            _ => None,
        },
        // voxtral-local maps to the smallest downloadable MLX Voxtral model
        AsrProviderType::Voxtral => match model_id.trim() {
            "voxtral-local" => Some("mlx-community/Voxtral-Mini-3B-2507-bf16"),
            _ => None,
        },
        _ => None,
    }
}

pub fn visible_route_for_model(model_id: &str) -> Option<(AsrProviderType, &'static str)> {
    match normalize_model_id(model_id).as_str() {
        "UsefulSensors/moonshine-tiny" => Some((AsrProviderType::Moonshine, "moonshine-tiny")),
        "UsefulSensors/moonshine-base" => Some((AsrProviderType::Moonshine, "moonshine-base")),
        "mlx-community/whisper-tiny-asr-fp16" => Some((AsrProviderType::Whisper, "tiny")),
        "mlx-community/whisper-tiny.en-asr-fp16" => Some((AsrProviderType::Whisper, "tiny.en")),
        "mlx-community/whisper-base-asr-fp16" => Some((AsrProviderType::Whisper, "base")),
        "mlx-community/whisper-base.en-asr-fp16" => Some((AsrProviderType::Whisper, "base.en")),
        "mlx-community/whisper-small-asr-fp16" => Some((AsrProviderType::Whisper, "small")),
        "mlx-community/whisper-small.en-asr-fp16" => Some((AsrProviderType::Whisper, "small.en")),
        "mlx-community/whisper-medium-asr-fp16" => Some((AsrProviderType::Whisper, "medium")),
        "mlx-community/whisper-medium.en-asr-fp16" => Some((AsrProviderType::Whisper, "medium.en")),
        "mlx-community/whisper-large-v3-asr-fp16" => Some((AsrProviderType::Whisper, "large-v3")),
        "mlx-community/whisper-large-v3-turbo-asr-fp16" => {
            Some((AsrProviderType::Whisper, "large-v3-turbo"))
        }
        "mlx-community/parakeet-tdt-0.6b-v3" => {
            Some((AsrProviderType::Parakeet, "parakeet-ctc-0.6b"))
        }
        "mlx-community/Voxtral-Mini-3B-2507-bf16" => {
            Some((AsrProviderType::Voxtral, "voxtral-local"))
        }
        _ => None,
    }
}

fn sanitize_model_id(model_id: &str) -> String {
    model_id
        .trim()
        .replace('/', "__")
        .replace([':', ' '], "_")
}

pub fn normalize_model_id(model_id: &str) -> String {
    let trimmed = model_id.trim();
    if let Some(spec) = MLX_AUDIO_MODEL_SPECS.iter().find(|spec| spec.id == trimmed) {
        spec.id.to_string()
    } else {
        default_model_id().to_string()
    }
}

pub fn model_dir_for(model_id: &str) -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Nautilus")
        .join("models")
        .join("mlx_audio")
        .join(sanitize_model_id(model_id))
}

fn has_local_artifacts(model_dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(model_dir) else {
        return false;
    };

    entries.flatten().any(|entry| {
        let path = entry.path();
        if path.is_dir() {
            return true;
        }
        if !path.is_file() {
            return false;
        }
        path.file_name()
            .and_then(|value| value.to_str())
            .map(|value| value != MANIFEST_FILE)
            .unwrap_or(false)
    })
}

fn has_downloaded_artifacts(model_dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(model_dir) else {
        return false;
    };

    entries.flatten().any(|entry| {
        let path = entry.path();
        if !path.is_file() {
            return false;
        }
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            return false;
        };
        if file_name == MANIFEST_FILE {
            return false;
        }

        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        match extension {
            "json" | "safetensors" | "txt" | "model" | "bin" => std::fs::metadata(&path)
                .map(|metadata| metadata.len() > 64)
                .unwrap_or(false),
            _ => false,
        }
    })
}

pub fn model_is_ready(model_id: &str) -> bool {
    let model_dir = model_dir_for(model_id);
    let spec = model_spec(model_id);
    if spec.downloadable {
        has_downloaded_artifacts(&model_dir)
    } else {
        has_local_artifacts(&model_dir) && has_downloaded_artifacts(&model_dir)
    }
}

fn runtime_ready() -> bool {
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
        && python_runtime::find_python_for_provider("mlx_audio_stt").is_some()
}

fn model_spec(model_id: &str) -> &'static MlxAudioModelSpec {
    MLX_AUDIO_MODEL_SPECS
        .iter()
        .find(|spec| spec.id == model_id)
        .unwrap_or(&MLX_AUDIO_MODEL_SPECS[0])
}

pub struct MlxAudioProvider {
    model_id: String,
    model_dir: PathBuf,
}

impl MlxAudioProvider {
    pub fn new(selected_model_id: Option<&str>) -> Self {
        let model_id = normalize_model_id(selected_model_id.unwrap_or(default_model_id()));
        let model_dir = model_dir_for(&model_id);
        Self {
            model_id,
            model_dir,
        }
    }
}

#[async_trait]
impl AsrProvider for MlxAudioProvider {
    fn name(&self) -> &str {
        "MLX Audio Routes"
    }

    fn description(&self) -> &str {
        "Apple Silicon local route family powered by mlx-audio. Pick a model below and Nautilus runs that route locally with MLX."
    }

    fn is_available(&self) -> bool {
        runtime_ready() && model_is_ready(&self.model_id)
    }

    fn model_info(&self) -> ModelInfo {
        let spec = model_spec(&self.model_id);
        ModelInfo {
            name: spec.name.to_string(),
            version: spec.version.to_string(),
            size_mb: spec.size_mb,
            parameters: spec.parameters.to_string(),
            languages: spec
                .languages
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            word_error_rate: None,
            real_time_factor: None,
            license: "Varies by upstream model".to_string(),
            source_url: spec.source_url.to_string(),
        }
    }

    async fn transcribe(&self, audio_path: &Path) -> Result<TranscriptionResult> {
        if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            anyhow::bail!("MLX Audio requires macOS on Apple Silicon");
        }
        if !model_is_ready(&self.model_id) {
            anyhow::bail!(
                "MLX Audio model '{}' is not downloaded yet. Download it in Settings -> ASR / Providers.",
                self.model_id
            );
        }

        let started = std::time::Instant::now();
        let output = python_runtime::run_python_asr_action(
            "mlx_audio_stt",
            "transcribe",
            Some(self.model_id.as_str()),
            &self.model_dir,
            Some(audio_path),
            3600,
        )
        .await
        .context("MLX Audio transcription failed")?;

        if !output.ok {
            anyhow::bail!(
                "{}",
                output
                    .error
                    .unwrap_or_else(|| "MLX Audio transcription failed".to_string())
            );
        }

        let text = output.text.unwrap_or_default().trim().to_string();
        if text.is_empty() {
            anyhow::bail!("MLX Audio returned an empty transcript");
        }

        Ok(TranscriptionResult {
            text: text.clone(),
            segments: Vec::new(),
            language: output.language.unwrap_or_else(|| "auto".to_string()),
            confidence: output.confidence.unwrap_or(0.9),
            processing_time_ms: started.elapsed().as_millis() as u64,
            model_name: format!("MLX Audio ({})", model_spec(&self.model_id).name),
            model_id: self.model_id.clone(),
            requested_provider: AsrProviderType::MlxAudio,
            actual_provider: AsrProviderType::MlxAudio,
            requested_engine: Some("provider_default".to_string()),
            actual_engine: Some("provider_default".to_string()),
            optimization_applied: false,
            fallback_reason: None,
        })
    }

    async fn transcribe_bytes(&self, audio_data: &[u8]) -> Result<TranscriptionResult> {
        let temp_path =
            std::env::temp_dir().join(format!("nautilus-mlx-audio-{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&temp_path, audio_data).context("failed to write temp wav for MLX Audio")?;
        let result = self.transcribe(&temp_path).await;
        let _ = std::fs::remove_file(&temp_path);
        result
    }

    fn download_status(&self) -> DownloadStatus {
        if model_is_ready(&self.model_id) {
            DownloadStatus::Downloaded
        } else {
            DownloadStatus::NotDownloaded
        }
    }

    async fn download_models(&self, progress_cb: Box<dyn Fn(f32) + Send + Sync>) -> Result<()> {
        if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            anyhow::bail!("MLX Audio downloads require macOS on Apple Silicon");
        }
        let spec = model_spec(&self.model_id);
        if !spec.downloadable {
            anyhow::bail!(
                "MLX Audio model '{}' does not have an official downloadable repo yet. Place the converted model files in '{}' and try again.",
                self.model_id,
                self.model_dir.display()
            );
        }
        std::fs::create_dir_all(&self.model_dir)
            .context("Failed to create MLX Audio model directory")?;
        progress_cb(5.0);
        python_runtime::run_python_asr_action(
            "mlx_audio_stt",
            "download",
            Some(self.model_id.as_str()),
            &self.model_dir,
            None,
            7200,
        )
        .await
        .context("MLX Audio download failed")?;
        progress_cb(100.0);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        default_model_id, mapped_model_for_visible_route, model_dir_for, model_is_ready,
        model_options, visible_route_for_model, MLX_AUDIO_MODEL_SPECS,
    };
    use crate::asr::AsrProviderType;

    #[test]
    fn downloadable_model_is_ready_without_manifest_when_artifacts_exist() {
        let model_id = "mlx-community/SenseVoiceSmall";
        let model_dir = model_dir_for(model_id);
        let _ = std::fs::remove_dir_all(&model_dir);
        std::fs::create_dir_all(&model_dir).expect("create MLX model dir");
        std::fs::write(model_dir.join("config.json"), br#"{"ok":true}"#).expect("write config");
        std::fs::write(model_dir.join("weights.safetensors"), vec![1u8; 256])
            .expect("write weights");

        assert!(model_is_ready(model_id));

        let _ = std::fs::remove_dir_all(&model_dir);
    }

    #[test]
    fn whisper_visible_routes_map_to_exact_mlx_routes() {
        let cases = [
            ("tiny", "mlx-community/whisper-tiny-asr-fp16"),
            ("tiny.en", "mlx-community/whisper-tiny.en-asr-fp16"),
            ("base", "mlx-community/whisper-base-asr-fp16"),
            ("base.en", "mlx-community/whisper-base.en-asr-fp16"),
            ("small", "mlx-community/whisper-small-asr-fp16"),
            ("small.en", "mlx-community/whisper-small.en-asr-fp16"),
            ("medium", "mlx-community/whisper-medium-asr-fp16"),
            ("medium.en", "mlx-community/whisper-medium.en-asr-fp16"),
            ("large-v3", "mlx-community/whisper-large-v3-asr-fp16"),
            (
                "large-v3-turbo",
                "mlx-community/whisper-large-v3-turbo-asr-fp16",
            ),
        ];

        for (visible_model_id, mlx_model_id) in cases {
            assert_eq!(
                mapped_model_for_visible_route(AsrProviderType::Whisper, visible_model_id),
                Some(mlx_model_id)
            );
        }
    }

    #[test]
    fn whisper_mlx_routes_map_back_to_visible_routes() {
        let cases = [
            ("mlx-community/whisper-tiny-asr-fp16", "tiny"),
            ("mlx-community/whisper-tiny.en-asr-fp16", "tiny.en"),
            ("mlx-community/whisper-base-asr-fp16", "base"),
            ("mlx-community/whisper-base.en-asr-fp16", "base.en"),
            ("mlx-community/whisper-small-asr-fp16", "small"),
            ("mlx-community/whisper-small.en-asr-fp16", "small.en"),
            ("mlx-community/whisper-medium-asr-fp16", "medium"),
            ("mlx-community/whisper-medium.en-asr-fp16", "medium.en"),
            ("mlx-community/whisper-large-v3-asr-fp16", "large-v3"),
            (
                "mlx-community/whisper-large-v3-turbo-asr-fp16",
                "large-v3-turbo",
            ),
        ];

        for (mlx_model_id, visible_model_id) in cases {
            assert_eq!(
                visible_route_for_model(mlx_model_id),
                Some((AsrProviderType::Whisper, visible_model_id))
            );
        }
    }

    #[test]
    fn model_options_expose_every_known_model_spec() {
        let options = model_options();

        assert_eq!(options.len(), MLX_AUDIO_MODEL_SPECS.len());
        assert!(options.iter().any(|option| option.id == default_model_id()));
    }
}
