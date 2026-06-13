use super::{EngineProbe, PlatformEngine};
use std::path::PathBuf;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn probe() -> EngineProbe {
    let sidecar = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Plainsong")
        .join("models")
        .join("mlx")
        .join("manifest.json");

    let ready =
        sidecar.exists() || std::env::var("PLAINSONG_MLX_STUB_READY").ok().as_deref() == Some("1");
    let mut notes = Vec::new();
    if ready {
        notes.push("MLX sidecar assets are ready".to_string());
    } else {
        notes.push("MLX assets missing. Download from ASR Model Downloader.".to_string());
    }

    EngineProbe {
        engine: PlatformEngine::MacosMlxSidecar,
        ready,
        notes,
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub fn probe() -> EngineProbe {
    EngineProbe {
        engine: PlatformEngine::MacosMlxSidecar,
        ready: false,
        notes: vec!["Requires macOS on Apple Silicon".to_string()],
    }
}
