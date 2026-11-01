use super::*;
use crate::meeting_asides::{AsideSpan, AsideTicket, MeetingAside};

pub(super) fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS recording_asides (
            id TEXT PRIMARY KEY,
            recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
            dictation_session_id INTEGER NOT NULL,
            sample_rate INTEGER NOT NULL CHECK(sample_rate > 0),
            attached_at_frame INTEGER NOT NULL,
            start_frame INTEGER,
            end_frame INTEGER,
            started_at_ms INTEGER NOT NULL,
            ended_at_ms INTEGER,
            paused_frames INTEGER NOT NULL DEFAULT 0,
            rows_json TEXT,
            deleted INTEGER NOT NULL DEFAULT 0,
            recovery_saved INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_recording_asides_recording ON recording_asides(recording_id);",
    )?;
    Ok(())
}

impl Database {
    pub(crate) fn insert_pending_aside(
        &self,
        recording_id: &str,
        ticket: &AsideTicket,
        session_id: u64,
        rate: u32,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO recording_asides(id,recording_id,dictation_session_id,sample_rate,attached_at_frame,started_at_ms,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![ticket.aside_id, recording_id, session_id, rate, ticket.attached_at_frame, ticket.attached_at_ms, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub(crate) fn close_aside(&self, recording_id: &str, span: &AsideSpan) -> Result<()> {
        self.conn.execute(
            "UPDATE recording_asides SET start_frame=?3,end_frame=?4,ended_at_ms=?5,paused_frames=?6 WHERE id=?1 AND recording_id=?2",
            params![span.aside_id, recording_id, span.start_frame, span.end_frame, span.ended_at_ms, span.paused_frames],
        )?;
        Ok(())
    }

    pub(crate) fn finish_recording_asides(
        &mut self,
        recording_id: &str,
        spans: &[AsideSpan],
    ) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for span in spans {
            self.close_aside(recording_id, span)?;
        }
        // A pending attachment with no written frames began and ended in a pause.
        tx.execute("UPDATE recording_asides SET start_frame=attached_at_frame,end_frame=attached_at_frame,ended_at_ms=?2 WHERE recording_id=?1 AND end_frame IS NULL", params![recording_id, Utc::now().timestamp_millis()])?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn finish_dictation_aside(
        &self,
        recording_id: &str,
        session_id: u64,
        spans: &[AsideSpan],
    ) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for span in spans
            .iter()
            .filter(|span| span.dictation_session_id == session_id && span.end_frame.is_some())
        {
            self.close_aside(recording_id, span)?;
        }
        tx.execute("UPDATE recording_asides SET start_frame=attached_at_frame,end_frame=attached_at_frame,ended_at_ms=?3 WHERE recording_id=?1 AND dictation_session_id=?2 AND end_frame IS NULL", params![recording_id,session_id,Utc::now().timestamp_millis()])?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn aside_spans(&self, recording_id: &str) -> Result<Vec<AsideSpan>> {
        let mut query = self.conn.prepare("SELECT id,dictation_session_id,sample_rate,COALESCE(start_frame,attached_at_frame),end_frame,started_at_ms,ended_at_ms,paused_frames FROM recording_asides WHERE recording_id=?1 ORDER BY attached_at_frame,id")?;
        let rows = query.query_map([recording_id], |r| {
            Ok(AsideSpan {
                aside_id: r.get(0)?,
                dictation_session_id: r.get(1)?,
                sample_rate: r.get(2)?,
                start_frame: r.get(3)?,
                end_frame: r.get(4)?,
                started_at_ms: r.get(5)?,
                ended_at_ms: r.get(6)?,
                paused_frames: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub(crate) fn set_aside_rows(&self, recording_id: &str, asides: &[MeetingAside]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for aside in asides {
            tx.execute("UPDATE recording_asides SET rows_json=?3 WHERE recording_id=?1 AND id=?2 AND deleted=0", params![recording_id, aside.aside_id, serde_json::to_string(&aside.rows)?])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn asides_for_review(&self, recording_id: &str) -> Result<Vec<MeetingAside>> {
        let mut query = self.conn.prepare("SELECT id,COALESCE(start_frame,attached_at_frame)*1.0/sample_rate,COALESCE(end_frame*1.0/sample_rate,(SELECT duration FROM recordings WHERE id=?1)),rows_json FROM recording_asides WHERE recording_id=?1 AND deleted=0 AND (end_frame IS NULL OR end_frame>COALESCE(start_frame,attached_at_frame)) ORDER BY attached_at_frame,id")?;
        let rows = query.query_map([recording_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, f64>(1)?,
                r.get::<_, f64>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?;
        rows.map(|row| {
            let (aside_id, start_time, end_time, json) = row?;
            Ok(MeetingAside {
                aside_id,
                start_time,
                end_time,
                rows: json
                    .map(|json| serde_json::from_str(&json))
                    .transpose()?
                    .unwrap_or_default(),
            })
        })
        .collect()
    }

    pub(crate) fn delete_aside(&self, recording_id: &str, aside_id: &str) -> Result<()> {
        // Keep the mask permanently. Re-transcription must never resurrect deleted text.
        self.conn.execute(
            "UPDATE recording_asides SET deleted=1,rows_json=NULL WHERE recording_id=?1 AND id=?2",
            params![recording_id, aside_id],
        )?;
        Ok(())
    }

    pub(crate) fn unrecovered_aside_spans(&self, recording_id: &str) -> Result<Vec<AsideSpan>> {
        self.aside_spans(recording_id)?
            .into_iter()
            .filter_map(|span| {
                if span.end_frame.is_some() {
                    return None;
                }
                match self.conn.query_row(
                    "SELECT recovery_saved FROM recording_asides WHERE id=?1",
                    [&span.aside_id],
                    |r| r.get::<_, bool>(0),
                ) {
                    Ok(false) => Some(Ok(span)),
                    Ok(true) => None,
                    Err(error) => Some(Err(error.into())),
                }
            })
            .collect()
    }

    pub(crate) fn mark_aside_recovered(&self, aside_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE recording_asides SET recovery_saved=1 WHERE id=?1",
            [aside_id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_journal_survives_restart_and_audio_only_pruning() {
        let root = crate::test_fs::TempDir::new("aside-journal");
        let path = root.path().join("meeting.db");
        {
            let mut db = Database::open_at_path(&path, None).unwrap();
            let recording: Recording = serde_json::from_value(serde_json::json!({"id":"meeting","title":"Meeting","projectId":"default","duration":3,"createdAt":"2026-10-27T00:00:00Z","updatedAt":"2026-10-27T00:00:00Z","sourceType":"meeting","audioPath":"/tmp/asides.wav","status":"recording"})).unwrap();
            db.create_recording(&recording).unwrap();
            db.insert_pending_aside(
                "meeting",
                &AsideTicket {
                    aside_id: "open".into(),
                    attached_at_frame: 120,
                    attached_at_ms: 0,
                },
                1,
                100,
            )
            .unwrap();
        }
        let db = Database::open_at_path(&path, None).unwrap();
        assert_eq!(db.unrecovered_aside_spans("meeting").unwrap().len(), 1);
        assert_eq!(
            db.aside_spans("meeting").unwrap()[0].frames_on_track(100, 400),
            Some(120..400)
        );
        db.conn
            .execute(
                "DELETE FROM recording_audio_assets WHERE recording_id='meeting'",
                [],
            )
            .unwrap();
        assert_eq!(db.aside_spans("meeting").unwrap().len(), 1);
        db.mark_aside_recovered("open").unwrap();
        assert!(db.unrecovered_aside_spans("meeting").unwrap().is_empty());
        assert_eq!(db.aside_spans("meeting").unwrap()[0].end_frame, None);
    }

    #[test]
    fn aside_text_is_separate_and_deletion_preserves_the_mask() {
        let mut db = Database::new_in_memory_for_test().unwrap();
        let recording: Recording = serde_json::from_value(serde_json::json!({"id":"meeting","title":"Meeting","projectId":"default","duration":3,"createdAt":"2026-10-27T00:00:00Z","updatedAt":"2026-10-27T00:00:00Z","sourceType":"meeting","audioPath":"/tmp/asides.wav","status":"recording"})).unwrap();
        db.create_recording(&recording).unwrap();
        let id: String = db
            .conn
            .query_row("SELECT id FROM recordings LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let ticket = AsideTicket {
            aside_id: "aside".into(),
            attached_at_frame: 100,
            attached_at_ms: 1,
        };
        db.insert_pending_aside(&id, &ticket, 7, 100).unwrap();
        let mut spans = db.aside_spans(&id).unwrap();
        assert_eq!(spans[0].frames_on_track(100, 300), Some(100..300));
        spans[0].end_frame = Some(200);
        db.finish_recording_asides(&id, &spans).unwrap();
        let aside = MeetingAside {
            aside_id: "aside".into(),
            start_time: 1.0,
            end_time: 2.0,
            rows: vec![TranscriptSegment {
                id: "row".into(),
                start_time: 1.0,
                end_time: 2.0,
                text: "quartzcanary".into(),
                speaker_id: Some("me".into()),
                confidence: 1.0,
            }],
        };
        db.set_aside_rows(&id, std::slice::from_ref(&aside))
            .unwrap();
        assert_eq!(
            db.asides_for_review(&id).unwrap()[0].rows[0].text,
            "quartzcanary"
        );
        let transcript: Transcript = serde_json::from_value(serde_json::json!({"id":"transcript","recordingId":id,"segments":[],"fullText":"Meeting words","language":"en","confidence":1.0,"model":"test","createdAt":"2026-10-27T00:00:00Z"})).unwrap();
        db.save_meeting_transcript(&transcript).unwrap();
        assert!(db
            .search_transcripts("quartzcanary", 10, None)
            .unwrap()
            .is_empty());
        let saved = db.get_transcript(&id).unwrap().unwrap();
        assert!(!saved.full_text.contains("quartzcanary"));
        assert!(
            crate::group_transcript_segments_for_analysis(&id, &saved.segments)
                .iter()
                .all(|row| !row.text.contains("quartzcanary"))
        );
        db.delete_aside(&id, "aside").unwrap();
        db.set_aside_rows(&id, &[aside]).unwrap();
        assert!(db.asides_for_review(&id).unwrap().is_empty());
        assert_eq!(db.aside_spans(&id).unwrap()[0].end_frame, Some(200));
        db.insert_pending_aside(
            &id,
            &AsideTicket {
                aside_id: "paused-cancel".into(),
                attached_at_frame: 250,
                attached_at_ms: 2,
            },
            8,
            100,
        )
        .unwrap();
        db.insert_pending_aside(
            &id,
            &AsideTicket {
                aside_id: "replacement".into(),
                attached_at_frame: 300,
                attached_at_ms: 3,
            },
            9,
            100,
        )
        .unwrap();
        db.finish_dictation_aside(&id, 8, &[]).unwrap();
        let pending = db.unrecovered_aside_spans(&id).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].dictation_session_id, 9);
        assert_eq!(db.asides_for_review(&id).unwrap().len(), 1);

        db.conn
            .execute("DELETE FROM recordings WHERE id=?1", [&id])
            .unwrap();
        assert!(db.aside_spans(&id).unwrap().is_empty());
    }
}
