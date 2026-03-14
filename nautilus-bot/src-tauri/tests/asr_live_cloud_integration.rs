use nautilus_bot_lib::asr::{
    elevenlabs_scribe::ElevenLabsScribeProvider, openai_cloud::OpenAiCloudWhisperProvider,
    voxtral::VoxtralProvider, AsrProvider,
};
use std::path::PathBuf;

fn fixture_wav() -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join("fixtures")
        .join("live-cloud-smoke.wav");
    std::fs::read(&path)
        .expect("failed to read fixed WAV fixture scripts/fixtures/live-cloud-smoke.wav")
}

fn env_present(name: &str) -> bool {
    let value = std::env::var(name).unwrap_or_default();
    !value.trim().is_empty()
}

fn live_cloud_required() -> bool {
    std::env::var("ASR_LIVE_CLOUD_REQUIRED")
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
async fn live_cloud_asr_providers_pass_and_meet_latency_gate() {
    let mut missing = Vec::new();
    if !env_present("OPENAI_API_KEY") {
        missing.push("OPENAI_API_KEY");
    }
    if !env_present("ELEVENLABS_API_KEY") {
        missing.push("ELEVENLABS_API_KEY");
    }
    if !env_present("MISTRAL_API_KEY") {
        missing.push("MISTRAL_API_KEY");
    }

    if !missing.is_empty() {
        if live_cloud_required() {
            panic!(
                "missing required live cloud ASR secret(s): {}",
                missing.join(", ")
            );
        }
        eprintln!(
            "[asr_live_cloud_integration] skipped; missing secrets: {}",
            missing.join(", ")
        );
        return;
    }

    let wav = fixture_wav();

    let started_openai = std::time::Instant::now();
    let openai = OpenAiCloudWhisperProvider::new(Some("whisper-1"));
    let openai_result = openai
        .transcribe_bytes(&wav)
        .await
        .expect("OpenAI live ASR transcription failed");
    assert!(
        !openai_result.text.trim().is_empty(),
        "OpenAI live ASR returned empty transcript"
    );
    let openai_ms = started_openai.elapsed().as_millis() as u64;

    let started_eleven = std::time::Instant::now();
    let eleven = ElevenLabsScribeProvider::new(Some("scribe_v2"));
    let eleven_result = eleven
        .transcribe_bytes(&wav)
        .await
        .expect("ElevenLabs live ASR transcription failed");
    assert!(
        !eleven_result.text.trim().is_empty(),
        "ElevenLabs live ASR returned empty transcript"
    );
    let eleven_ms = started_eleven.elapsed().as_millis() as u64;

    let started_mistral = std::time::Instant::now();
    let mistral = VoxtralProvider::new(Some("voxtral-cloud"));
    let mistral_result = mistral
        .transcribe_bytes(&wav)
        .await
        .expect("Mistral live ASR transcription failed");
    assert!(
        !mistral_result.text.trim().is_empty(),
        "Mistral live ASR returned empty transcript"
    );
    let mistral_ms = started_mistral.elapsed().as_millis() as u64;

    let mut latencies = [openai_ms, eleven_ms, mistral_ms];
    latencies.sort_unstable();
    let median_ms = latencies[latencies.len() / 2];
    assert!(
        median_ms < 6_000,
        "cloud ASR median latency gate failed: {}ms >= 6000ms",
        median_ms
    );
}
