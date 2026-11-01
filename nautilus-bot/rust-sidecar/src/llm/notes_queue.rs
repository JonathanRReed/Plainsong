//! Resume persisted memory waits without changing the analysis lane's retry loop.
use std::sync::Arc;
use std::time::Duration;

pub const CANCELLED_NOTICE: &str = "Automatic notes cancelled. Retry when ready.";

pub fn spawn(state: Arc<crate::AppState>, handle: crate::sidecar_handle::SidecarHandle) {
    tokio::spawn(async move {
        let ids = match state.db.lock().await.recording_ids_waiting_for_notes() {
            Ok(ids) => ids,
            Err(error) => {
                tracing::warn!(%error, "Could not restore waiting notes");
                return;
            }
        };
        for id in ids {
            // Capture wins after a restart too. Do not start a recovered
            // notes job merely because the runtime can allocate its weights.
            while state.audio_capture.lock().await.is_recording() {
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
            let waiting = state
                .db
                .lock()
                .await
                .get_recording(&id)
                .ok()
                .flatten()
                .is_some_and(|recording| {
                    recording.analysis_failure.as_deref()
                        == Some(crate::analysis::MEMORY_WAIT_NOTICE)
                });
            if waiting {
                crate::analysis::run_meeting_analysis_until_written(
                    &state,
                    &handle,
                    &id,
                    crate::analysis::MeetingAnalysisMode::MissingOnly,
                )
                .await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db::Database, models::Recording};

    #[test]
    fn waiting_notes_survive_reopening_and_cancelled_notes_do_not_resume() {
        let dir =
            std::env::temp_dir().join(format!("plainsong-notes-queue-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("notes.db");
        {
            let mut db = Database::open_at_path(&path, None).unwrap();
            let recording: Recording = serde_json::from_value(serde_json::json!({
                "id": "waiting", "title": "Waiting", "projectId": "inbox", "duration": 0,
                "createdAt": chrono::Utc::now(), "updatedAt": chrono::Utc::now(),
                "sourceType": "meeting", "audioPath": "", "status": "completed"
            }))
            .unwrap();
            db.create_recording(&recording).unwrap();
            db.set_recording_analysis_failure(
                &recording.id,
                Some(crate::analysis::MEMORY_WAIT_NOTICE),
            )
            .unwrap();
            assert_eq!(
                db.recording_ids_waiting_for_notes().unwrap(),
                [recording.id]
            );
        }
        {
            let mut db = Database::open_at_path(&path, None).unwrap();
            let ids = db.recording_ids_waiting_for_notes().unwrap();
            assert_eq!(ids.len(), 1);
            db.set_recording_analysis_failure(&ids[0], Some(CANCELLED_NOTICE))
                .unwrap();
        }
        let db = Database::open_at_path(&path, None).unwrap();
        assert!(db.recording_ids_waiting_for_notes().unwrap().is_empty());
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
