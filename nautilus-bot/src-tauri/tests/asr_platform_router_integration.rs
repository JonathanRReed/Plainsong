use nautilus_bot_lib::asr::{AsrManager, AsrProviderType};
use nautilus_bot_lib::settings::PlatformOptimizationSettings;
use std::path::PathBuf;

#[tokio::test]
async fn default_provider_remains_stable_when_platform_optimization_changes() {
    let manager = AsrManager::new();
    assert_eq!(
        manager.get_default_provider().await,
        AsrProviderType::DistilWhisper
    );

    let optimization = PlatformOptimizationSettings {
        mode: "manual".to_string(),
        manual_engine_priority: vec!["macos_mlx_sidecar".to_string()],
        ..PlatformOptimizationSettings::default()
    };

    manager.set_platform_optimization(optimization).await;

    assert_eq!(
        manager.get_default_provider().await,
        AsrProviderType::DistilWhisper
    );
}

#[tokio::test]
async fn local_only_fallback_does_not_attempt_cloud_providers() {
    let manager = AsrManager::new();

    let optimization = PlatformOptimizationSettings {
        fallback_policy: "local_only".to_string(),
        ..PlatformOptimizationSettings::default()
    };
    manager.set_platform_optimization(optimization).await;

    let missing_audio = PathBuf::from("/nonexistent/nautilus-platform-router.wav");
    let error = manager
        .transcribe_with_provider(AsrProviderType::Whisper, &missing_audio)
        .await
        .expect_err("missing audio should fail");
    let message = error.to_string();

    assert!(!message.contains("OpenAI Whisper (Cloud)"));
    assert!(!message.contains("ElevenLabs Scribe"));
    assert!(!message.contains("Groq Whisper (Cloud)"));
}

#[tokio::test]
async fn allow_cloud_setting_still_uses_selected_provider_only() {
    let manager = AsrManager::new();

    let optimization = PlatformOptimizationSettings {
        fallback_policy: "allow_cloud".to_string(),
        ..PlatformOptimizationSettings::default()
    };
    manager.set_platform_optimization(optimization).await;

    let missing_audio = PathBuf::from("/nonexistent/nautilus-platform-router.wav");
    let error = manager
        .transcribe_with_provider(AsrProviderType::Whisper, &missing_audio)
        .await
        .expect_err("missing audio should fail");
    let message = error.to_string();

    assert!(
        !message.contains("OpenAI Whisper (Cloud)")
            && !message.contains("ElevenLabs Scribe")
            && !message.contains("Groq Whisper (Cloud)"),
        "expected strict selected-provider behavior, got: {}",
        message
    );
}

#[tokio::test]
async fn fail_fast_stops_after_first_failed_route() {
    let manager = AsrManager::new();

    let optimization = PlatformOptimizationSettings {
        fallback_policy: "fail_fast".to_string(),
        ..PlatformOptimizationSettings::default()
    };
    manager.set_platform_optimization(optimization).await;

    let missing_audio = PathBuf::from("/nonexistent/nautilus-platform-router.wav");
    let error = manager
        .transcribe_with_provider(AsrProviderType::Whisper, &missing_audio)
        .await
        .expect_err("missing audio should fail");
    let message = error.to_string();

    assert!(
        !message.contains("Distil Whisper")
            && !message.contains("NVIDIA Parakeet")
            && !message.contains("OpenAI Whisper (Cloud)"),
        "expected fail-fast to skip fallback providers, got: {}",
        message
    );
}

#[tokio::test]
async fn manual_native_engine_selection_is_exclusive() {
    let manager = AsrManager::new();

    let optimization = PlatformOptimizationSettings {
        mode: "manual".to_string(),
        fallback_policy: "local_only".to_string(),
        macos: nautilus_bot_lib::settings::MacosPlatformOptimizationSettings {
            apple_native_enabled: true,
            mlx_enabled: false,
        },
        manual_engine_priority: vec!["macos_apple_speech".to_string()],
        ..PlatformOptimizationSettings::default()
    };
    manager.set_platform_optimization(optimization).await;

    let missing_audio = PathBuf::from("/nonexistent/nautilus-platform-router.wav");
    let error = manager
        .transcribe_with_provider(AsrProviderType::Whisper, &missing_audio)
        .await
        .expect_err("missing audio should fail");
    let message = error.to_string();

    assert!(
        !message.contains("OpenAI Whisper (Cloud)")
            && !message.contains("ElevenLabs Scribe")
            && !message.contains("Groq Whisper (Cloud)")
            && !message.contains("Distil Whisper"),
        "exclusive native route should not trigger provider fallback attempts, got: {}",
        message
    );
    assert!(
        message.contains("no provider fallback will be attempted"),
        "expected explicit exclusive-engine failure context, got: {}",
        message
    );
}
