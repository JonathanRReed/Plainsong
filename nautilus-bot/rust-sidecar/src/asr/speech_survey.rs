//! Opt-in comparisons against the current speech-side implementations.
//! The candidate conversions are evaluated by the sibling Swift receipt tool.

const SURVEY_CAMPPLUS_COREML_REVISION: &str = "321b18e270a4e19e69ef4a13d179b4eac07cec6a";
const SURVEY_VAD_COREML_REVISION: &str = "b419383c55c110e2c9271fa6ee0ea83d03c70d96";
const SURVEY_COMMUNITY1_COREML_REVISION: &str = "df2625ac79a7ac6b65ad868fee6d80f320da4232";

#[tokio::test]
#[ignore = "requires an isolated survey root and explicit public audio fixture"]
async fn speech_survey_baseline() -> anyhow::Result<()> {
    use std::{path::PathBuf, time::Instant};
    let value = |key: &str| std::env::var(key).unwrap_or_else(|_| panic!("set {key}"));
    let root = PathBuf::from(value("PLAINSONG_SPEECH_SURVEY_ROOT"));
    assert_eq!(crate::paths::data_dir(), Some(root.join("data")));
    assert_eq!(crate::paths::config_dir(), Some(root.join("config")));
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    let kind = value("PLAINSONG_SPEECH_SURVEY_KIND");
    let audio = PathBuf::from(value("PLAINSONG_SPEECH_SURVEY_AUDIO"));
    let output = value("PLAINSONG_SPEECH_SURVEY_OUT");
    let manager = crate::download::DownloadManager::new()?;
    let mut trials = Vec::new();
    let mut probabilities = Vec::new();
    let mut turns = serde_json::Value::Null;
    let revision;
    let period_ms;
    if kind == "vad" {
        revision = SURVEY_VAD_COREML_REVISION;
        period_ms = Some(32);
        let path = manager.download_silero_vad_model(|_| {}).await?;
        let samples = crate::audio::utils::load_audio_file(&audio)?;
        for _ in 0..5 {
            let started = Instant::now();
            let mut detector = crate::audio::silero_vad::SileroVadDetector::load(&path)?;
            let loaded_ms = started.elapsed().as_secs_f64() * 1000.0;
            probabilities.clear();
            let inference = Instant::now();
            for chunk in samples.chunks(512) {
                let mut padded = [0.0f32; 512];
                padded[..chunk.len()].copy_from_slice(chunk);
                probabilities.push(
                    detector
                        .detect_speech_probability(&padded)
                        .map_err(anyhow::Error::msg)?,
                );
            }
            trials.push(serde_json::json!({"loadMs": loaded_ms,
                "inferenceMs": inference.elapsed().as_secs_f64()*1000.0,
                "totalMs": started.elapsed().as_secs_f64()*1000.0}));
        }
    } else if kind == "campplus" {
        revision = SURVEY_CAMPPLUS_COREML_REVISION;
        period_ms = None;
        manager
            .download_diarization_model_by_id("campplus_speaker", |_| {})
            .await?;
        let rows: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(value("PLAINSONG_SPEECH_SURVEY_WINDOWS"))?)?;
        let windows: Vec<(f64, f64)> = rows
            .iter()
            .map(|r| (r["start"].as_f64().unwrap(), r["end"].as_f64().unwrap()))
            .collect();
        for _ in 0..5 {
            let started = Instant::now();
            let extractor = crate::diarization::embedder::SpeakerEmbeddingExtractor::with_model(
                "campplus_speaker",
            )?;
            let result = extractor.extract_embeddings(&audio, &windows).await?;
            assert_eq!(result.len(), windows.len());
            assert!(result
                .iter()
                .all(|(_, _, v)| v.iter().all(|x| x.is_finite())));
            trials.push(serde_json::json!({"totalMs":started.elapsed().as_secs_f64()*1000.0}));
            turns = serde_json::json!(result.iter().map(|(start,end,v)| serde_json::json!({"start":start,"end":end,"embedding":v.to_vec()})).collect::<Vec<_>>());
        }
    } else if kind == "community1" {
        revision = SURVEY_COMMUNITY1_COREML_REVISION;
        period_ms = None;
        manager
            .download_diarization_model_by_id("pyannote_community1", |_| {})
            .await?;
        for _ in 0..5 {
            let started = Instant::now();
            let result =
                crate::diarization::run_diarization_with_model(&audio, "pyannote_community1")
                    .await?;
            trials.push(serde_json::json!({"totalMs":started.elapsed().as_secs_f64()*1000.0}));
            turns = serde_json::to_value(&result)?;
        }
    } else {
        anyhow::bail!("unknown speech survey kind");
    }
    std::fs::write(
        output,
        serde_json::to_vec_pretty(&serde_json::json!({
            "kind":kind,"implementation":"current Plainsong", "candidateRevision":revision,
        "planningPhysicalBytes":crate::hardware_tier::physical_memory_bytes(),
        "planningTier":format!("{:?}",crate::hardware_tier::current()),
            "framePeriodMs":period_ms,"trials":trials,"probabilities":probabilities,"result":turns,
            "peakPhysicalFootprintBytes":crate::meeting_eval::peak_footprint_bytes(),
        }))?,
    )?;
    Ok(())
}
