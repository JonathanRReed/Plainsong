use nautilus_bot_lib::asr::{AsrManager, AsrProviderType};
use std::path::PathBuf;

fn fixture() -> PathBuf {
    if let Ok(path) = std::env::var("ASR_LOCAL_SMOKE_FIXTURE") {
        return PathBuf::from(path);
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join("fixtures")
        .join("local-quality-gate.wav")
}

fn strict_smoke_gate_enabled() -> bool {
    std::env::var("ASR_LOCAL_SMOKE_REQUIRE_ALL")
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        })
        .unwrap_or(false)
}

#[tokio::test]
async fn smoke_local_providers_print_outcomes() {
    let manager = AsrManager::new();
    manager
        .set_provider_model_id(AsrProviderType::Voxtral, "voxtral-local".to_string())
        .await;

    let providers = [
        AsrProviderType::Whisper,
        AsrProviderType::Parakeet,
        AsrProviderType::Moonshine,
        AsrProviderType::WhisperCandle,
        AsrProviderType::DistilWhisper,
        AsrProviderType::Voxtral,
    ];

    let wav = fixture();
    println!("fixture={} exists={}", wav.display(), wav.exists());

    let require_all = strict_smoke_gate_enabled();
    let mut failures: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for p in providers {
        let res = manager.transcribe_with_provider(p, &wav).await;
        match res {
            Ok(r) => {
                let transcript = r.text.trim();
                if r.requested_provider != p {
                    failures.push(format!(
                        "{:?}: requested_provider mismatch (expected {:?}, got {:?})",
                        p, p, r.requested_provider
                    ));
                }
                if r.actual_provider != p {
                    failures.push(format!(
                        "{:?}: provider fallback detected (actual {:?}, fallback_reason={:?})",
                        p, r.actual_provider, r.fallback_reason
                    ));
                }
                if r.fallback_reason.is_some() {
                    failures.push(format!(
                        "{:?}: fallback_reason present ({:?})",
                        p, r.fallback_reason
                    ));
                }
                if transcript.is_empty() {
                    failures.push(format!("{:?}: empty transcript", p));
                } else if transcript.split_whitespace().count() < 2 {
                    failures.push(format!(
                        "{:?}: transcript too short for smoke gate ('{}')",
                        p, transcript
                    ));
                }
                println!(
                    "provider={:?} ok text_len={} confidence={} model_id={} actual={:?}",
                    p,
                    transcript.chars().count(),
                    r.confidence,
                    r.model_id,
                    r.actual_provider
                );
            }
            Err(e) => {
                println!("provider={:?} err={}", p, e);
                if require_all {
                    failures.push(format!("{:?}: {}", p, e));
                } else {
                    skipped.push(format!("{:?}: {}", p, e));
                }
            }
        }
    }

    if !require_all && !skipped.is_empty() {
        println!(
            "skipped local providers due to missing optional assets:\n{}",
            skipped.join("\n")
        );
    }

    assert!(
        failures.is_empty(),
        "one or more local providers failed smoke checks:\n{}",
        failures.join("\n")
    );
}
