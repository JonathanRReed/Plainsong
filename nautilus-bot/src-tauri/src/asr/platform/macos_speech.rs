use super::{EngineProbe, PlatformEngine};

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn probe() -> EngineProbe {
    EngineProbe {
        engine: PlatformEngine::MacosAppleSpeech,
        ready: true,
        notes: vec![
            "Apple Speech runtime available on macOS Apple Silicon".to_string(),
            "SpeechAnalyzer path will be used when available at runtime".to_string(),
        ],
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub fn probe() -> EngineProbe {
    EngineProbe {
        engine: PlatformEngine::MacosAppleSpeech,
        ready: false,
        notes: vec!["Requires macOS on Apple Silicon".to_string()],
    }
}
