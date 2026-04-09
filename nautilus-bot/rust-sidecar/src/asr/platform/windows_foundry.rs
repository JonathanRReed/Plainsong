use super::{EngineProbe, PlatformEngine};
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
use std::path::PathBuf;

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub fn probe() -> EngineProbe {
    let marker = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Nautilus")
        .join("models")
        .join("windows_foundry")
        .join("manifest.json");

    let ready = marker.exists()
        || std::env::var("NAUTILUS_WINDOWS_FOUNDRY_READY")
            .ok()
            .as_deref()
            == Some("1");

    let notes = if ready {
        vec!["Windows Foundry Local runtime marker detected".to_string()]
    } else {
        vec![
            "Windows Foundry Local runtime not detected".to_string(),
            "Run platform bundle setup in Settings -> ASR Models".to_string(),
        ]
    };

    EngineProbe {
        engine: PlatformEngine::WindowsFoundryLocal,
        ready,
        notes,
    }
}

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
pub fn probe() -> EngineProbe {
    EngineProbe {
        engine: PlatformEngine::WindowsFoundryLocal,
        ready: false,
        notes: vec!["Requires Windows x86_64".to_string()],
    }
}
