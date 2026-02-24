use super::{EngineProbe, PlatformEngine};

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub fn probe() -> EngineProbe {
    let ready = std::env::var("NAUTILUS_WINDOWS_SDK_DICTATION_READY")
        .ok()
        .as_deref()
        == Some("1");

    let notes = if ready {
        vec!["Windows SDK dictation runtime is available".to_string()]
    } else {
        vec![
            "Windows SDK dictation runtime not configured".to_string(),
            "Enable runtime setup before selecting this engine".to_string(),
        ]
    };

    EngineProbe {
        engine: PlatformEngine::WindowsSdkDictation,
        ready,
        notes,
    }
}

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
pub fn probe() -> EngineProbe {
    EngineProbe {
        engine: PlatformEngine::WindowsSdkDictation,
        ready: false,
        notes: vec!["Requires Windows x86_64".to_string()],
    }
}
