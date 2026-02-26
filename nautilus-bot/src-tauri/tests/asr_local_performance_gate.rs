use nautilus_bot_lib::asr::{AsrManager, AsrProviderType};
use nautilus_bot_lib::settings::PlatformOptimizationSettings;
use std::path::PathBuf;

fn perf_fixture_path() -> PathBuf {
    if let Ok(path) = std::env::var("ASR_LOCAL_PERF_FIXTURE") {
        return PathBuf::from(path);
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join("fixtures")
        .join("local-perf-30s.wav")
}

fn quality_fixture_path() -> PathBuf {
    if let Ok(path) = std::env::var("ASR_LOCAL_QUALITY_FIXTURE") {
        return PathBuf::from(path);
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join("fixtures")
        .join("local-quality-gate.wav")
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
    let perf_fixture = perf_fixture_path();
    assert!(
        perf_fixture.exists(),
        "missing local performance fixture wav"
    );
    let quality_fixture = quality_fixture_path();
    assert!(
        quality_fixture.exists(),
        "missing local quality fixture wav"
    );

    let duration_seconds = fixture_duration_seconds(&perf_fixture);
    assert!(duration_seconds >= 29.9, "expected ~30s fixture duration");

    let manager = AsrManager::new();
    let mut optimization = PlatformOptimizationSettings::default();
    optimization.fallback_policy = "fail_fast".to_string();
    manager.set_platform_optimization(optimization).await;
    manager
        .set_provider_model_id(AsrProviderType::Voxtral, "voxtral-local".to_string())
        .await;

    let local_providers = [
        AsrProviderType::Whisper,
        AsrProviderType::Parakeet,
        AsrProviderType::Canary,
        AsrProviderType::DistilWhisper,
        AsrProviderType::Moonshine,
        AsrProviderType::Voxtral,
    ];

    for provider in local_providers {
        let quality_result = manager
            .transcribe_with_provider(provider, &quality_fixture)
            .await
            .unwrap_or_else(|err| {
                panic!(
                    "local ASR quality gate requires provider {:?} to be runnable: {}",
                    provider, err
                )
            });
        assert_eq!(
            quality_result.requested_provider, provider,
            "provider {:?} returned mismatched requested_provider {:?}",
            provider, quality_result.requested_provider
        );
        assert_eq!(
            quality_result.actual_provider, provider,
            "provider {:?} fell back to {:?} in quality gate (fallback_reason={:?})",
            provider, quality_result.actual_provider, quality_result.fallback_reason
        );
        assert!(
            quality_result.fallback_reason.is_none(),
            "provider {:?} emitted fallback_reason in quality gate: {:?}",
            provider,
            quality_result.fallback_reason
        );

        let transcript = quality_result.text.trim();
        assert!(
            !transcript.is_empty(),
            "provider {:?} produced an empty transcript in local quality gate",
            provider
        );
        let token_count = transcript.split_whitespace().count();
        assert!(
            token_count >= 2,
            "provider {:?} produced too few tokens ({}) in local quality gate",
            provider,
            token_count
        );

        let first_pass = manager
            .transcribe_with_provider(provider, &perf_fixture)
            .await
            .unwrap_or_else(|err| {
                panic!(
                    "local ASR performance gate requires provider {:?} to be runnable: {}",
                    provider, err
                )
            });
        assert_eq!(
            first_pass.actual_provider, provider,
            "provider {:?} fell back to {:?} in first perf pass (fallback_reason={:?})",
            provider, first_pass.actual_provider, first_pass.fallback_reason
        );
        assert!(
            first_pass.fallback_reason.is_none(),
            "provider {:?} emitted fallback_reason in first perf pass: {:?}",
            provider,
            first_pass.fallback_reason
        );

        let first_rtf = first_pass.processing_time_ms as f64 / (duration_seconds * 1000.0);
        if first_rtf <= 1.2 {
            continue;
        }

        // Retry once to avoid one-off CI scheduler or lazy-kernel startup spikes.
        // We still require the provider to satisfy the same strict threshold.
        let second_pass = manager
            .transcribe_with_provider(provider, &perf_fixture)
            .await
            .unwrap_or_else(|err| {
                panic!(
                    "local ASR performance gate retry failed for provider {:?}: {}",
                    provider, err
                )
            });
        assert_eq!(
            second_pass.actual_provider, provider,
            "provider {:?} fell back to {:?} in retry perf pass (fallback_reason={:?})",
            provider, second_pass.actual_provider, second_pass.fallback_reason
        );
        assert!(
            second_pass.fallback_reason.is_none(),
            "provider {:?} emitted fallback_reason in retry perf pass: {:?}",
            provider,
            second_pass.fallback_reason
        );
        let second_rtf = second_pass.processing_time_ms as f64 / (duration_seconds * 1000.0);
        assert!(
            second_rtf <= 1.2,
            "provider {:?} failed local RTF gate after retry: first={:.3}, second={:.3}, threshold=1.2",
            provider,
            first_rtf,
            second_rtf
        );
    }
}
