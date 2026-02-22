use nautilus_bot_lib::asr::{AsrManager, AsrProviderType};
use std::path::PathBuf;

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join("fixtures")
        .join("local-perf-30s.wav")
}

#[tokio::test]
async fn smoke_local_providers_print_outcomes() {
    let manager = AsrManager::new();
    manager
        .set_provider_model_id(AsrProviderType::Voxtral, "voxtral-local".to_string())
        .await;
    manager
        .set_provider_model_id(AsrProviderType::VibeVoice, "vibevoice-asr".to_string())
        .await;

    let providers = [
        AsrProviderType::Whisper,
        AsrProviderType::Parakeet,
        AsrProviderType::Moonshine,
        AsrProviderType::Canary,
        AsrProviderType::DistilWhisper,
        AsrProviderType::VibeVoice,
        AsrProviderType::Voxtral,
    ];

    let wav = fixture();
    println!("fixture={} exists={}", wav.display(), wav.exists());

    for p in providers {
        let res = manager.transcribe_with_provider(p, &wav).await;
        match res {
            Ok(r) => {
                println!(
                    "provider={:?} ok text_len={} confidence={} model_id={} actual={:?}",
                    p,
                    r.text.trim().chars().count(),
                    r.confidence,
                    r.model_id,
                    r.actual_provider
                );
            }
            Err(e) => {
                println!("provider={:?} err={}", p, e);
            }
        }
    }
}
