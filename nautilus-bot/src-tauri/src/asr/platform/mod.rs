use super::AsrProviderType;
use serde::{Deserialize, Serialize};

pub mod macos_speech;
pub mod mlx_sidecar;
pub mod windows_foundry;
pub mod windows_sdk_dictation;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PlatformEngine {
    ProviderDefault,
    MacosAppleSpeech,
    MacosMlxSidecar,
    WindowsFoundryLocal,
    WindowsSdkDictation,
}

impl PlatformEngine {
    pub fn id(self) -> &'static str {
        match self {
            PlatformEngine::ProviderDefault => "provider_default",
            PlatformEngine::MacosAppleSpeech => "macos_apple_speech",
            PlatformEngine::MacosMlxSidecar => "macos_mlx_sidecar",
            PlatformEngine::WindowsFoundryLocal => "windows_foundry_local",
            PlatformEngine::WindowsSdkDictation => "windows_sdk_dictation",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        match id.trim() {
            "provider_default" => Some(Self::ProviderDefault),
            "macos_apple_speech" => Some(Self::MacosAppleSpeech),
            "macos_mlx_sidecar" => Some(Self::MacosMlxSidecar),
            "windows_foundry_local" => Some(Self::WindowsFoundryLocal),
            "windows_sdk_dictation" => Some(Self::WindowsSdkDictation),
            _ => None,
        }
    }

    pub fn supports_provider(self, provider: AsrProviderType) -> bool {
        match self {
            PlatformEngine::ProviderDefault => true,
            PlatformEngine::MacosAppleSpeech | PlatformEngine::WindowsSdkDictation => {
                !provider.is_remote()
            }
            PlatformEngine::MacosMlxSidecar | PlatformEngine::WindowsFoundryLocal => {
                provider.is_local()
            }
        }
    }

    pub fn probe(self) -> EngineProbe {
        match self {
            PlatformEngine::ProviderDefault => EngineProbe {
                engine: self,
                ready: true,
                notes: vec!["Default provider runtime path".to_string()],
            },
            PlatformEngine::MacosAppleSpeech => macos_speech::probe(),
            PlatformEngine::MacosMlxSidecar => mlx_sidecar::probe(),
            PlatformEngine::WindowsFoundryLocal => windows_foundry::probe(),
            PlatformEngine::WindowsSdkDictation => windows_sdk_dictation::probe(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProbe {
    pub engine: PlatformEngine,
    pub ready: bool,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EngineDiagnostics {
    pub active_engine: Option<String>,
    #[serde(default)]
    pub available_engines: Vec<String>,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FallbackPolicy {
    LocalOnly,
    AllowCloud,
    FailFast,
}

impl FallbackPolicy {
    pub fn from_settings(value: &str) -> Self {
        match value.trim() {
            "allow_cloud" => Self::AllowCloud,
            "fail_fast" => Self::FailFast,
            _ => Self::LocalOnly,
        }
    }
}

impl AsrProviderType {
    pub fn is_remote(self) -> bool {
        matches!(
            self,
            AsrProviderType::ElevenLabsScribe
                | AsrProviderType::OpenAiCloud
                | AsrProviderType::Groq
        )
    }

    pub fn is_local(self) -> bool {
        !self.is_remote()
    }
}
