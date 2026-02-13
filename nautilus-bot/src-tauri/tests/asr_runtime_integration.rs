use nautilus_bot_lib::asr::{AsrManager, AsrProviderType};
use std::path::PathBuf;

#[tokio::test]
async fn runtime_diagnostics_cover_all_providers() {
    let manager = AsrManager::new();
    manager
        .set_selected_model_id("nonexistent-model".to_string())
        .await;
    let diagnostics = manager
        .get_all_providers_info()
        .await
        .expect("provider diagnostics should load");

    let provider_types: Vec<_> = diagnostics.iter().map(|d| d.provider_type).collect();
    for provider in AsrProviderType::all() {
        assert!(
            provider_types.contains(&provider),
            "missing diagnostics for provider {:?}",
            provider
        );
    }
}

#[tokio::test]
async fn fallback_failures_are_explicit() {
    let manager = AsrManager::new();
    manager
        .set_selected_model_id("nonexistent-model".to_string())
        .await;
    manager.set_allow_whisper_fallback(true).await;

    let missing_audio = PathBuf::from("/nonexistent/nautilus-test-audio.wav");
    let error = manager
        .transcribe_with_provider(AsrProviderType::Parakeet, &missing_audio)
        .await
        .expect_err("missing file should force a deterministic error");
    let message = error.to_string().to_lowercase();
    assert!(
        message.contains("fallback") || message.contains("whisper"),
        "expected explicit fallback error context, got: {}",
        message
    );
}

#[tokio::test]
async fn asr_errors_surface_non_empty_messages() {
    let manager = AsrManager::new();
    manager
        .set_selected_model_id("nonexistent-model".to_string())
        .await;
    manager.set_allow_whisper_fallback(false).await;

    let error = manager
        .transcribe_bytes(&[])
        .await
        .expect_err("empty audio should return an error");
    let message = error.to_string();
    assert!(
        !message.trim().is_empty(),
        "expected non-empty error message"
    );
}
