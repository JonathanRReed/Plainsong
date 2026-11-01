use crate::meeting_asides::{aside_frame_ranges, AsideSpan};
use crate::{recording_audio, AppState};
use std::path::Path;

/// Copy PCM without changing its rate or timeline. Export masks every channel;
/// recovery copies only the selected span, bounded by the dictation ceiling.
pub(crate) fn copy_wav(
    source: &Path,
    destination: &Path,
    spans: &[AsideSpan],
    recover: bool,
) -> Result<(), String> {
    let mut reader = hound::WavReader::open(source).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let ranges = aside_frame_ranges(spans, spec.sample_rate, u64::from(reader.duration()));
    let selection = if recover {
        let first = ranges
            .first()
            .ok_or("The aside contains no recorded audio")?;
        first.start
            ..first.end.min(
                first.start
                    + u64::from(spec.sample_rate)
                        * crate::audio::AudioCapture::dictation_max_session_seconds(),
            )
    } else {
        0..u64::from(reader.duration())
    };
    reader
        .seek(u32::try_from(selection.start).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let file = recording_audio::create_new_file(destination).map_err(|e| e.to_string())?;
    let guard = recording_audio::DurableTempFile::new(destination.to_owned());
    let mut writer =
        hound::WavWriter::new(std::io::BufWriter::new(file), spec).map_err(|e| e.to_string())?;
    let count = (selection.end - selection.start) * u64::from(spec.channels);
    let mask = |index: usize| {
        let frame = selection.start + index as u64 / u64::from(spec.channels);
        !recover && ranges.iter().any(|range| range.contains(&frame))
    };
    if spec.sample_format == hound::SampleFormat::Float {
        for (index, sample) in reader.samples::<f32>().take(count as usize).enumerate() {
            let sample = sample.map_err(|e| e.to_string())?;
            writer
                .write_sample(if mask(index) { 0.0 } else { sample })
                .map_err(|e| e.to_string())?;
        }
    } else {
        for (index, sample) in reader.samples::<i32>().take(count as usize).enumerate() {
            let sample = sample.map_err(|e| e.to_string())?;
            writer
                .write_sample(if mask(index) { 0 } else { sample })
                .map_err(|e| e.to_string())?;
        }
    }
    writer.finalize().map_err(|e| e.to_string())?;
    std::fs::File::open(destination)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    guard.disarm();
    Ok(())
}

pub(crate) async fn mask_external_audio(
    state: &AppState,
    recording_id: &str,
    audio: recording_audio::ResolvedRecordingAudioBundle,
) -> Result<recording_audio::ResolvedRecordingAudioBundle, String> {
    let spans = {
        let db = state.db.lock().await;
        let bundle = db
            .load_recording_audio_bundle(recording_id)
            .map_err(|e| e.to_string())?;
        if bundle.mic.is_some() || bundle.system.is_some() {
            return Ok(audio);
        }
        db.aside_spans(recording_id).map_err(|e| e.to_string())?
    };
    if spans.is_empty() {
        return Ok(audio);
    }
    tokio::task::spawn_blocking(move || {
        let path = audio
            .primary
            .with_file_name(format!(".aside-export-{}.wav", uuid::Uuid::new_v4()));
        copy_wav(&audio.primary, &path, &spans, false)?;
        let owner = recording_audio::DurableTempFile::new(path.clone());
        let mut audio = audio.with_source_snapshots(vec![owner]);
        audio.primary = path;
        Ok(audio)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Startup promotes the dictation's own capture checkpoint before recording
/// revalidation. Never reconstruct it from the meeting mic: pauses and another
/// dictation input can make that track empty or contain different speech.
pub(crate) async fn recover_open_asides(
    state: &AppState,
    recording_id: &str,
) -> Result<(), String> {
    let db = state.db.lock().await;
    for span in db
        .unrecovered_aside_spans(recording_id)
        .map_err(|e| e.to_string())?
    {
        db.mark_aside_recovered(&span.aside_id)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_aside_masks_to_end_without_changing_the_source() {
        let root = crate::test_fs::TempDir::new("aside-crash");
        let source = root.path().join("mic.wav");
        let mut writer = hound::WavWriter::create(
            &source,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for _ in 0..1600 {
            writer.write_sample(1234i16).unwrap();
        }
        writer.finalize().unwrap();
        let span = AsideSpan {
            aside_id: "crashed".into(),
            dictation_session_id: 1,
            sample_rate: 16000,
            start_frame: 800,
            end_frame: None,
            started_at_ms: 0,
            ended_at_ms: None,
            paused_frames: 0,
        };
        let export = root.path().join("export.wav");
        let journal = root.path().join("meeting.db");
        {
            let mut db = crate::db::Database::open_at_path(&journal, None).unwrap();
            let recording = serde_json::from_value(serde_json::json!({"id":"meeting","title":"Meeting","projectId":"default","duration":1,"createdAt":"2026-10-27T00:00:00Z","updatedAt":"2026-10-27T00:00:00Z","sourceType":"meeting","audioPath":source,"status":"recording"})).unwrap();
            db.create_recording(&recording).unwrap();
            db.insert_pending_aside(
                "meeting",
                &crate::meeting_asides::AsideTicket {
                    aside_id: span.aside_id.clone(),
                    attached_at_frame: span.start_frame,
                    attached_at_ms: 0,
                },
                1,
                span.sample_rate,
            )
            .unwrap();
        }
        // Reopen from disk after all capture owners have dropped.
        let db = crate::db::Database::open_at_path(&journal, None).unwrap();
        let pending = db.unrecovered_aside_spans("meeting").unwrap();
        assert_eq!(pending.len(), 1);
        db.mark_aside_recovered(&pending[0].aside_id).unwrap();
        assert!(db.unrecovered_aside_spans("meeting").unwrap().is_empty());

        copy_wav(&source, &export, std::slice::from_ref(&span), false).unwrap();

        let samples = |path| {
            hound::WavReader::open(path)
                .unwrap()
                .samples::<i16>()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(samples(&source), vec![1234; 1600]);
        assert_eq!(samples(&export), [vec![1234; 800], vec![0; 800]].concat());
    }
}
