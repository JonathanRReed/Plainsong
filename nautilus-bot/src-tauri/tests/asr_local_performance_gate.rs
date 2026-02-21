use nautilus_bot_lib::asr::{AsrManager, AsrProviderType};
use std::path::PathBuf;

fn perf_fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join("fixtures")
        .join("local-perf-30s.wav")
}

fn fixture_duration_seconds(path: &std::path::Path) -> f64 {
    let reader =
        hound::WavReader::open(path).expect("failed to open local performance fixture wav");
    let spec = reader.spec();
    if spec.sample_rate == 0 {
        return 0.0;
    }
    reader.duration() as f64 / spec.sample_rate as f64
}

#[tokio::test]
async fn local_asr_rtf_gate_under_1_2x() {
    let fixture = perf_fixture_path();
    assert!(fixture.exists(), "missing local performance fixture wav");

    let duration_seconds = fixture_duration_seconds(&fixture);
    assert!(duration_seconds >= 29.9, "expected ~30s fixture duration");

    let manager = AsrManager::new();
    manager
        .set_provider_model_id(AsrProviderType::Voxtral, "voxtral-local".to_string())
        .await;
    manager
        .set_provider_model_id(AsrProviderType::VibeVoice, "vibevoice-asr".to_string())
        .await;

    let local_providers = [
        AsrProviderType::Whisper,
        AsrProviderType::Parakeet,
        AsrProviderType::Canary,
        AsrProviderType::DistilWhisper,
        AsrProviderType::Moonshine,
        AsrProviderType::VibeVoice,
        AsrProviderType::Voxtral,
    ];

    for provider in local_providers {
        let result = manager
            .transcribe_with_provider(provider, &fixture)
            .await
            .unwrap_or_else(|err| {
                panic!(
                    "local ASR performance gate requires provider {:?} to be runnable: {}",
                    provider, err
                )
            });

        let rtf = result.processing_time_ms as f64 / (duration_seconds * 1000.0);
        assert!(
            rtf <= 1.2,
            "provider {:?} failed local RTF gate: {:.3} > 1.2",
            provider,
            rtf
        );
    }
}
