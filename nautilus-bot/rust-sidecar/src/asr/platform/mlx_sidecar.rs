use super::{EngineProbe, PlatformEngine};

/// The macOS MLX sidecar was always a stub: `download_mlx_assets` in
/// `crate::download` wrote a marker JSON file with no real sidecar binary or
/// runtime behind it, so selecting this engine hard-failed every local
/// transcription. The engine has been retired from the UI and from
/// `PlatformEngine::from_id`'s accepted settings ids; this probe always
/// reports not-ready so any code path that still enumerates
/// `PlatformEngine::MacosMlxSidecar` (e.g. diagnostics) can never treat it as
/// usable.
pub fn probe() -> EngineProbe {
    EngineProbe {
        engine: PlatformEngine::MacosMlxSidecar,
        ready: false,
        notes: vec![
            "macOS MLX sidecar has been retired and is not available in this build.".to_string(),
        ],
    }
}
