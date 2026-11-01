use super::*;
use crate::publishing::{PublishConfig, PublishJob, PublishReceipt, PublishStatus};

pub(super) fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS note_publish_config (id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS note_publish_outbox (
            recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', error TEXT,
            PRIMARY KEY(recording_id, revision));
        CREATE TABLE IF NOT EXISTS note_publish_receipts (
            recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
            location_id TEXT NOT NULL, filename TEXT NOT NULL, hash TEXT NOT NULL, attempted_hashes TEXT NOT NULL DEFAULT '[]',
            revision INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(recording_id,location_id));")?;
    let has_revision = conn
        .prepare("SELECT 1 FROM pragma_table_info('note_publish_receipts') WHERE name='revision'")?
        .exists([])?;
    if !has_revision {
        conn.execute_batch(
            "ALTER TABLE note_publish_receipts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
        )?;
    }
    // Triggers share the source transaction, including writes from post-call analysis.
    let enqueue = "INSERT INTO note_publish_outbox(recording_id, revision)
        SELECT NEW.id, COALESCE((SELECT MAX(revision) FROM note_publish_outbox WHERE recording_id=NEW.id),0)+1
        WHERE NEW.source_type='meeting' AND EXISTS(SELECT 1 FROM note_publish_config WHERE json_extract(config,'$.enabled')=1);
        DELETE FROM note_publish_outbox WHERE recording_id=NEW.id AND revision < (SELECT MAX(revision) FROM note_publish_outbox WHERE recording_id=NEW.id);";
    for (name, event) in [("insert", "INSERT"), ("update", "UPDATE OF title, meeting_notes, summary, action_items, meeting_action_completion, status")] {
        conn.execute_batch(&format!("DROP TRIGGER IF EXISTS note_publish_recording_{name}; CREATE TRIGGER note_publish_recording_{name} AFTER {event} ON recordings
            WHEN NEW.status NOT IN ('recording','processing') AND (NEW.meeting_notes IS NOT NULL OR NEW.summary IS NOT NULL OR (NEW.action_items IS NOT NULL AND NEW.action_items != '[]') OR EXISTS(SELECT 1 FROM note_publish_outbox WHERE recording_id=NEW.id))
            BEGIN {enqueue} END;"))?;
    }
    for event in ["INSERT", "UPDATE OF summary, action_items, title"] {
        let name = if event == "INSERT" {
            "insert"
        } else {
            "update"
        };
        conn.execute_batch(&format!("DROP TRIGGER IF EXISTS note_publish_artifact_{name}; CREATE TRIGGER note_publish_artifact_{name} AFTER {event} ON meeting_artifacts BEGIN
            INSERT INTO note_publish_outbox(recording_id,revision)
            SELECT NEW.recording_id,COALESCE((SELECT MAX(revision) FROM note_publish_outbox WHERE recording_id=NEW.recording_id),0)+1
            WHERE EXISTS(SELECT 1 FROM note_publish_config WHERE json_extract(config,'$.enabled')=1)
            AND EXISTS(SELECT 1 FROM recordings WHERE id=NEW.recording_id AND source_type='meeting')
            AND (NEW.summary IS NOT NULL OR NEW.action_items != '[]' OR EXISTS(SELECT 1 FROM recordings WHERE id=NEW.recording_id AND meeting_notes IS NOT NULL) OR EXISTS(SELECT 1 FROM note_publish_outbox WHERE recording_id=NEW.recording_id));
            DELETE FROM note_publish_outbox WHERE recording_id=NEW.recording_id AND revision < (SELECT MAX(revision) FROM note_publish_outbox WHERE recording_id=NEW.recording_id);
        END;"))?;
    }
    // Transcript text and speaker names reach the file only with
    // includeTranscript. Live transcription and diarization write while the
    // meeting is still recording or processing; completing it enqueues once.
    for (table, update, changed) in [
        (
            "transcripts",
            "segments, full_text",
            "OLD.segments IS NOT NEW.segments OR OLD.full_text IS NOT NEW.full_text",
        ),
        ("speaker_aliases", "name", "OLD.name IS NOT NEW.name"),
    ] {
        let named = |row: &str| {
            if table == "speaker_aliases" {
                format!("WHEN {row}.name IS NOT NULL")
            } else {
                String::new()
            }
        };
        for (name, event, row, when) in [
            ("insert", "INSERT".to_string(), "NEW", named("NEW")),
            (
                "update",
                format!("UPDATE OF {update}"),
                "NEW",
                format!("WHEN {changed}"),
            ),
            ("delete", "DELETE".to_string(), "OLD", named("OLD")),
        ] {
            conn.execute_batch(&format!("DROP TRIGGER IF EXISTS note_publish_{table}_{name}; CREATE TRIGGER note_publish_{table}_{name} AFTER {event} ON {table} {when} BEGIN
                INSERT INTO note_publish_outbox(recording_id,revision)
                SELECT r.id,COALESCE((SELECT MAX(revision) FROM note_publish_outbox WHERE recording_id=r.id),0)+1 FROM recordings r
                WHERE r.id={row}.recording_id AND r.source_type='meeting' AND r.status NOT IN ('recording','processing')
                AND EXISTS(SELECT 1 FROM note_publish_config WHERE json_extract(config,'$.enabled')=1 AND json_extract(config,'$.includeTranscript')=1)
                AND (r.meeting_notes IS NOT NULL OR r.summary IS NOT NULL OR (r.action_items IS NOT NULL AND r.action_items != '[]') OR EXISTS(SELECT 1 FROM note_publish_outbox WHERE recording_id=r.id));
                DELETE FROM note_publish_outbox WHERE recording_id={row}.recording_id AND revision < (SELECT MAX(revision) FROM note_publish_outbox WHERE recording_id={row}.recording_id);
            END;"))?;
        }
    }
    Ok(())
}

impl Database {
    pub(crate) fn publish_config(&self) -> Result<PublishConfig> {
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT config FROM note_publish_config WHERE id=1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|s| serde_json::from_str(&s).map_err(Into::into))
            .unwrap_or_else(|| Ok(PublishConfig::default()))
    }

    pub(crate) fn save_publish_config(&mut self, config: &PublishConfig) -> Result<()> {
        self.conn.execute("INSERT INTO note_publish_config(id,config) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET config=excluded.config", [serde_json::to_string(config)?])?;
        Ok(())
    }

    pub(crate) fn publish_status(&self, id: &str) -> Result<PublishStatus> {
        let status = self.conn.query_row("SELECT state,error FROM note_publish_outbox WHERE recording_id=?1 ORDER BY revision DESC LIMIT 1", [id], |r| Ok(PublishStatus {state:r.get(0)?,error:r.get(1)?})).optional()?;
        Ok(status.unwrap_or(PublishStatus {
            state: "none".into(),
            error: None,
        }))
    }

    pub(crate) fn retry_publish(&mut self, id: &str) -> Result<()> {
        self.conn.execute("UPDATE note_publish_outbox SET state='pending',error=NULL,next_attempt=0 WHERE recording_id=?1 AND state!='saved'", [id])?;
        Ok(())
    }

    /// The receipt for the current notes folder.
    pub(crate) fn publish_receipt(&self, id: &str) -> Result<Option<PublishReceipt>> {
        let location_id = self.publish_config()?.location_id;
        Ok(self
            .receipts_where(
                "recording_id=?1 AND location_id=?2",
                params![id, location_id],
            )?
            .pop())
    }

    /// Every receipt for a meeting, including ones in earlier notes folders.
    pub(crate) fn publish_receipts(&self, id: &str) -> Result<Vec<PublishReceipt>> {
        self.receipts_where("recording_id=?1", params![id])
    }

    /// Notes folders that still hold a file Plainsong published.
    pub(crate) fn publish_receipt_locations(&self) -> Result<HashSet<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT location_id FROM note_publish_receipts")?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<HashSet<_>>>()?;
        Ok(ids)
    }

    fn receipts_where(
        &self,
        filter: &str,
        values: impl rusqlite::Params,
    ) -> Result<Vec<PublishReceipt>> {
        let mut stmt = self.conn.prepare(&format!("SELECT location_id,filename,hash,attempted_hashes,revision FROM note_publish_receipts WHERE {filter} ORDER BY location_id"))?;
        let rows = stmt
            .query_map(values, |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect::<rusqlite::Result<Vec<(String, String, String, String, i64)>>>()?;
        rows.into_iter()
            .map(|(location_id, filename, hash, attempted, revision)| {
                Ok(PublishReceipt {
                    location_id,
                    filename,
                    hash,
                    attempted_hashes: serde_json::from_str(&attempted)?,
                    revision,
                })
            })
            .collect()
    }

    pub(crate) fn begin_publish(&mut self, job: &PublishJob) -> Result<()> {
        let planned = job.planned_receipt();
        self.conn.execute("INSERT INTO note_publish_receipts(recording_id,location_id,filename,hash,attempted_hashes) VALUES(?1,?2,?3,'',?4) ON CONFLICT(recording_id,location_id) DO UPDATE SET attempted_hashes=CASE WHEN EXISTS(SELECT 1 FROM json_each(attempted_hashes) WHERE value=?5) THEN attempted_hashes ELSE json_insert(attempted_hashes,'$[#]',?5) END",params![job.recording_id,planned.location_id,planned.filename,serde_json::to_string(&planned.attempted_hashes)?,planned.attempted_hashes[0]])?;
        Ok(())
    }

    /// A row whose job cannot be built is marked failed with the usual
    /// backoff, so it cannot hold the head of the queue.
    pub(crate) fn next_publish_job(&mut self, now: i64) -> Result<Option<PublishJob>> {
        let config = self.publish_config()?;
        if !config.enabled {
            return Ok(None);
        }
        loop {
            let row: Option<(String,i64)> = self.conn.query_row("SELECT o.recording_id,o.revision FROM note_publish_outbox o JOIN recordings r ON r.id=o.recording_id WHERE o.state!='saved' AND o.next_attempt<=?1 AND r.status NOT IN ('recording','processing') ORDER BY o.next_attempt,o.recording_id LIMIT 1", [now], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
            let Some((id, revision)) = row else {
                return Ok(None);
            };
            match self.build_publish_job(&id, revision, config.clone()) {
                Ok(job) => return Ok(Some(job)),
                Err(error) => {
                    tracing::warn!("Could not prepare a meeting's notes file: {error}");
                    // The row's next attempt is now after `now`, so the next
                    // query moves on to another row.
                    anyhow::ensure!(
                        fail_publish(&self.conn, &id, revision, &error, now)? == 1,
                        "Note publishing queue changed while it was read"
                    );
                }
            }
        }
    }

    fn build_publish_job(
        &self,
        id: &str,
        revision: i64,
        config: PublishConfig,
    ) -> Result<PublishJob> {
        let recording = self
            .get_recording(id)?
            .context("Meeting no longer exists")?;
        let transcript = if config.include_transcript {
            self.get_transcript(id)?
                .map(|t| {
                    let names = crate::export_context_for_recording(self, id).speaker_names;
                    crate::publishing::transcript_markdown(&t, &names)
                })
                .unwrap_or_default()
        } else {
            String::new()
        };
        let completion = self.get_meeting_action_completion(id)?;
        let receipt = self.publish_receipt(id)?;
        PublishJob::new(recording, transcript, completion, config, receipt, revision)
    }

    pub(crate) fn finish_publish(
        &mut self,
        job: &PublishJob,
        result: &Result<PublishReceipt>,
        now: i64,
    ) -> Result<()> {
        let tx = self.conn.transaction()?;
        match result {
            Ok(receipt) => {
                tx.execute("INSERT INTO note_publish_receipts(recording_id,location_id,filename,hash,revision) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(recording_id,location_id) DO UPDATE SET filename=excluded.filename,hash=excluded.hash,revision=excluded.revision,attempted_hashes='[]'", params![job.recording_id,receipt.location_id,receipt.filename,receipt.hash,receipt.revision])?;
                tx.execute("UPDATE note_publish_outbox SET state='saved',error=NULL WHERE recording_id=?1 AND revision=?2", params![job.recording_id,job.revision])?;
            }
            Err(error) => {
                fail_publish(&tx, &job.recording_id, job.revision, error, now)?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}

fn fail_publish(
    conn: &Connection,
    id: &str,
    revision: i64,
    error: &anyhow::Error,
    now: i64,
) -> Result<usize> {
    // 5 seconds, doubling to an hour. A new revision starts fresh.
    Ok(conn.execute("UPDATE note_publish_outbox SET state='error',error=?3,next_attempt=?4+MIN(3600,5*(1 << MIN(attempts,10))),attempts=attempts+1 WHERE recording_id=?1 AND revision=?2", params![id,revision,error.to_string(),now])?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Database {
        let db = Database::new_in_memory_for_test().unwrap();
        db.conn.execute("INSERT OR IGNORE INTO projects(id,name,created_at,updated_at) VALUES('publish','Publish','2026-10-23T12:00:00Z','2026-10-23T12:00:00Z')", []).unwrap();
        db.conn.execute("INSERT INTO recordings(id,title,project_id,created_at,updated_at,source_type,status,audio_path) VALUES('meeting','Planning','publish','2026-10-23T12:00:00Z','2026-10-23T12:00:00Z','meeting','completed','')", []).unwrap();
        db
    }
    fn enable(db: &mut Database) {
        db.save_publish_config(&PublishConfig {
            enabled: true,
            location_id: Some("approved".into()),
            ..PublishConfig::default()
        })
        .unwrap();
    }
    #[test]
    fn publishing_is_off_by_default_and_only_queues_committed_edits() {
        let mut db = setup();
        db.update_recording_notes("meeting", Some("Before enabling"))
            .unwrap();
        assert!(db.next_publish_job(0).unwrap().is_none());
        enable(&mut db);
        db.conn.execute_batch("BEGIN; UPDATE recordings SET meeting_notes='rolled back' WHERE id='meeting'; ROLLBACK;").unwrap();
        assert!(db.next_publish_job(0).unwrap().is_none());
        db.update_recording_notes("meeting", Some("Committed"))
            .unwrap();
        assert_eq!(db.next_publish_job(0).unwrap().unwrap().revision, 1);
    }
    #[test]
    fn publishing_outbox_backoff_coalescing_and_idempotence() {
        let mut db = setup();
        enable(&mut db);
        db.update_recording_notes("meeting", Some("One")).unwrap();
        let job = db.next_publish_job(100).unwrap().unwrap();
        db.finish_publish(&job, &Err(anyhow::anyhow!("Folder unavailable")), 100)
            .unwrap();
        assert!(db.next_publish_job(104).unwrap().is_none());
        let job = db.next_publish_job(105).unwrap().unwrap();
        db.finish_publish(&job, &Err(anyhow::anyhow!("Folder unavailable")), 105)
            .unwrap();
        assert!(db.next_publish_job(114).unwrap().is_none());
        db.retry_publish("meeting").unwrap();
        assert!(db.publish_status("meeting").unwrap().error.is_none());
        assert!(db.next_publish_job(106).unwrap().is_some());
        db.update_recording_notes("meeting", Some("Two")).unwrap();
        db.update_recording_notes("meeting", Some("Three")).unwrap();
        let job = db.next_publish_job(106).unwrap().unwrap();
        assert_eq!(job.revision, 3);
        assert_eq!(
            db.conn
                .query_row("SELECT COUNT(*) FROM note_publish_outbox", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let result = Ok(PublishReceipt {
            location_id: "approved".into(),
            filename: "stable.md".into(),
            hash: "hash".into(),
            attempted_hashes: vec![],
            revision: job.revision,
        });
        db.finish_publish(&job, &result, 106).unwrap();
        db.finish_publish(&job, &result, 106).unwrap();
        assert_eq!(db.publish_status("meeting").unwrap().state, "saved");
        assert!(db.next_publish_job(99999).unwrap().is_none());
        db.conn
            .execute(
                "UPDATE recordings SET title='Renamed' WHERE id='meeting'",
                [],
            )
            .unwrap();
        assert_eq!(db.next_publish_job(99999).unwrap().unwrap().revision, 4);
        assert_eq!(
            db.publish_receipt("meeting").unwrap().unwrap().filename,
            "stable.md"
        );
    }
    #[test]
    fn publishing_waits_for_processing_and_tracks_actions_and_deletion() {
        let mut db = setup();
        enable(&mut db);
        db.update_recording_status("meeting", "processing").unwrap();
        db.update_recording_notes("meeting", Some("Still working"))
            .unwrap();
        assert!(db.next_publish_job(1).unwrap().is_none());
        db.update_recording_status("meeting", "completed").unwrap();
        assert!(db.next_publish_job(1).unwrap().is_some());
        db.conn
            .execute(
                "UPDATE recordings SET action_items='[\"Send draft\"]' WHERE id='meeting'",
                [],
            )
            .unwrap();
        let revision = db.next_publish_job(1).unwrap().unwrap().revision;
        db.conn
            .execute(
                "UPDATE recordings SET meeting_action_completion='[]' WHERE id='meeting'",
                [],
            )
            .unwrap();
        assert!(db.next_publish_job(1).unwrap().unwrap().revision > revision);
        db.conn
            .execute("DELETE FROM recordings WHERE id='meeting'", [])
            .unwrap();
        assert!(db.next_publish_job(1).unwrap().is_none());
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn publishing_crash_before_ack_then_rename_keeps_one_file() {
        let mut db = setup();
        enable(&mut db);
        let dir = crate::test_fs::TempDir::new("publish-ack");
        let root = dir.path().canonicalize().unwrap();
        db.update_recording_notes("meeting", Some("Original notes"))
            .unwrap();
        let job = db.next_publish_job(0).unwrap().unwrap();
        db.begin_publish(&job).unwrap();
        job.write(&root).unwrap();
        // Simulate a crash before acknowledgement, followed by a new edit.
        db.conn
            .execute(
                "UPDATE recordings SET title='Renamed' WHERE id='meeting'",
                [],
            )
            .unwrap();
        let job = db.next_publish_job(0).unwrap().unwrap();
        db.begin_publish(&job).unwrap();
        // The folder may fail before this attempted write; retain both hashes.
        db.update_recording_notes("meeting", Some("Latest notes"))
            .unwrap();
        let job = db.next_publish_job(0).unwrap().unwrap();
        db.begin_publish(&job).unwrap();
        let receipt = job.write(&root).unwrap();
        db.finish_publish(&job, &Ok(receipt), 0).unwrap();
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        let path = std::fs::read_dir(root)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let contents = std::fs::read_to_string(path).unwrap();
        assert!(contents.contains("Renamed"));
        assert!(contents.contains("Latest notes"));
        assert!(db
            .publish_receipt("meeting")
            .unwrap()
            .unwrap()
            .attempted_hashes
            .is_empty());
    }
    #[test]
    fn publishing_empty_metadata_does_not_queue_a_file() {
        let mut db = setup();
        enable(&mut db);
        db.conn.execute("INSERT INTO meeting_artifacts(id,recording_id,title,summary,action_items,decisions,deadlines,created_at,updated_at) VALUES('artifact','meeting','Meeting',NULL,'[]','[]','[]','2026-10-23T12:00:00Z','2026-10-23T12:00:00Z')",[]).unwrap();
        assert!(db.next_publish_job(0).unwrap().is_none());
        db.conn
            .execute(
                "UPDATE meeting_artifacts SET title='Renamed' WHERE recording_id='meeting'",
                [],
            )
            .unwrap();
        assert!(db.next_publish_job(0).unwrap().is_none());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn publishing_clearing_the_last_note_updates_the_existing_file() {
        let mut db = setup();
        enable(&mut db);
        let dir = crate::test_fs::TempDir::new("publish-clear");
        let root = dir.path().canonicalize().unwrap();
        db.update_recording_notes("meeting", Some("Private old notes"))
            .unwrap();
        let job = db.next_publish_job(0).unwrap().unwrap();
        let receipt = job.write(&root).unwrap();
        db.finish_publish(&job, &Ok(receipt), 0).unwrap();
        let path = std::fs::read_dir(&root)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("Private old notes"));
        init(&db.conn).unwrap();
        db.update_recording_notes("meeting", None).unwrap();
        let job = db.next_publish_job(0).unwrap().unwrap();
        assert_eq!(job.revision, 2);
        let receipt = job.write(&root).unwrap();
        db.finish_publish(&job, &Ok(receipt), 0).unwrap();
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        assert!(!std::fs::read_to_string(path)
            .unwrap()
            .contains("Private old notes"));
    }

    #[test]
    fn publishing_queue_survives_database_reopen() {
        let temp = crate::test_fs::TempDir::new("publish-db");
        let path = temp.path().join("queue.sqlite");
        let mut db = setup();
        enable(&mut db);
        db.update_recording_notes("meeting", Some("Durable"))
            .unwrap();
        db.backup_to(&path).unwrap();
        drop(db);
        let conn = Connection::open(&path).unwrap();
        init(&conn).unwrap();
        assert_eq!(
            conn.query_row("SELECT recording_id FROM note_publish_outbox", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "meeting"
        );
    }
}

#[cfg(test)]
mod review_tests {
    use super::*;

    fn setup() -> Database {
        let mut db = Database::new_in_memory_for_test().unwrap();
        db.conn.execute("INSERT OR IGNORE INTO projects(id,name,created_at,updated_at) VALUES('publish','Publish','2026-10-23T12:00:00Z','2026-10-23T12:00:00Z')", []).unwrap();
        db.conn.execute("INSERT INTO recordings(id,title,project_id,created_at,updated_at,source_type,status,audio_path) VALUES('meeting','Planning','publish','2026-10-23T12:00:00Z','2026-10-23T12:00:00Z','meeting','completed','')", []).unwrap();
        db.save_publish_config(&PublishConfig {
            enabled: true,
            location_id: Some("approved".into()),
            ..PublishConfig::default()
        })
        .unwrap();
        db
    }

    fn saved(db: &mut Database, job: &PublishJob) {
        let receipt = Ok(PublishReceipt {
            location_id: job.location_id.clone(),
            filename: "meeting.md".into(),
            hash: "hash".into(),
            attempted_hashes: vec![],
            revision: job.revision,
        });
        db.finish_publish(job, &receipt, 0).unwrap();
    }

    #[test]
    fn publishing_build_failure_backs_off_and_lets_other_meetings_publish() {
        let mut db = setup();
        db.conn.execute("INSERT INTO recordings(id,title,project_id,created_at,updated_at,source_type,status,audio_path) VALUES('next','Next','publish','2026-10-23T12:00:00Z','2026-10-23T12:00:00Z','meeting','completed','')", []).unwrap();
        db.update_recording_notes("meeting", Some("Unbuildable"))
            .unwrap();
        db.update_recording_notes("next", Some("Fine")).unwrap();
        // A damaged receipt makes this meeting's job impossible to build.
        db.conn.execute("INSERT INTO note_publish_receipts(recording_id,location_id,filename,hash,attempted_hashes) VALUES('meeting','approved','meeting.md','','not json')", []).unwrap();
        let job = db.next_publish_job(100).unwrap().unwrap();
        assert_eq!(job.recording_id, "next");
        let status = db.publish_status("meeting").unwrap();
        assert_eq!(status.state, "error");
        assert!(status.error.is_some());
        saved(&mut db, &job);
        assert!(db.next_publish_job(104).unwrap().is_none());
        // Retrying after the backoff fails again and backs off further.
        assert!(db.next_publish_job(105).unwrap().is_none());
        assert!(db.next_publish_job(114).unwrap().is_none());
    }

    fn latest_revision(db: &Database) -> i64 {
        db.conn
            .query_row(
                "SELECT COALESCE(MAX(revision),0) FROM note_publish_outbox WHERE recording_id='meeting'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn transcript(text: &str) -> crate::models::Transcript {
        crate::models::Transcript {
            id: "transcript".into(),
            recording_id: "meeting".into(),
            segments: vec![crate::models::TranscriptSegment {
                id: "segment".into(),
                start_time: 0.0,
                end_time: 2.0,
                text: text.into(),
                speaker_id: Some("S1".into()),
                confidence: 1.0,
            }],
            full_text: text.into(),
            language: "en".into(),
            confidence: 1.0,
            model: "test".into(),
            model_id: None,
            requested_provider: None,
            actual_provider: None,
            measured_word_timestamps: false,
            created_at: chrono::Utc::now(),
            heard_through_speakers: vec![],
        }
    }

    fn include_transcript(db: &mut Database, include: bool) {
        db.save_publish_config(&PublishConfig {
            enabled: true,
            location_id: Some("approved".into()),
            include_transcript: include,
            ..PublishConfig::default()
        })
        .unwrap();
    }

    #[test]
    fn publishing_transcript_and_speaker_edits_republish_only_when_included_and_complete() {
        let mut db = setup();
        include_transcript(&mut db, true);
        db.update_recording_status("meeting", "processing").unwrap();
        db.update_recording_notes("meeting", Some("Notes")).unwrap();
        let before = latest_revision(&db);
        // Live transcription writes must not churn the outbox.
        db.save_transcript(&transcript("Hello there")).unwrap();
        db.conn
            .execute("UPDATE transcripts SET full_text='Hello again'", [])
            .unwrap();
        assert_eq!(latest_revision(&db), before);
        db.update_recording_status("meeting", "completed").unwrap();
        let job = db.next_publish_job(0).unwrap().unwrap();
        assert!(
            String::from_utf8_lossy(job.contents_for_test()).contains("**Speaker 1:** Hello there")
        );
        saved(&mut db, &job);

        db.save_transcript(&transcript("Hello, edited")).unwrap();
        let job = db.next_publish_job(0).unwrap().unwrap();
        assert!(String::from_utf8_lossy(job.contents_for_test()).contains("Hello, edited"));
        saved(&mut db, &job);

        db.rename_speaker("meeting", "S1", "Priya").unwrap();
        let job = db.next_publish_job(0).unwrap().unwrap();
        assert!(
            String::from_utf8_lossy(job.contents_for_test()).contains("**Priya:** Hello, edited")
        );
        saved(&mut db, &job);

        let settled = latest_revision(&db);
        db.rename_speaker("meeting", "S1", "Priya").unwrap();
        assert_eq!(latest_revision(&db), settled, "same name is not an edit");

        include_transcript(&mut db, false);
        db.save_transcript(&transcript("Not published")).unwrap();
        db.rename_speaker("meeting", "S1", "Sam").unwrap();
        assert_eq!(latest_revision(&db), settled);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn publish(db: &mut Database, root: &std::path::Path) -> Result<()> {
        let job = db.next_publish_job(0)?.context("no job")?;
        db.begin_publish(&job)?;
        let result = job.write(root);
        db.finish_publish(&job, &result, 0)?;
        result.map(|_| ())
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn publishing_restore_readopts_plainsongs_later_file_but_keeps_user_edits() {
        let dir = crate::test_fs::TempDir::new("publish-restore");
        let base = dir.path().canonicalize().unwrap();
        let root = base.join("notes");
        std::fs::create_dir(&root).unwrap();
        let mut db = setup();
        db.update_recording_notes("meeting", Some("First")).unwrap();
        publish(&mut db, &root).unwrap();
        let backup = base.join("backup.sqlite");
        db.backup_to(&backup).unwrap();
        db.update_recording_notes("meeting", Some("Second"))
            .unwrap();
        publish(&mut db, &root).unwrap();
        drop(db);
        let second_restore = base.join("second-restore.sqlite");
        std::fs::copy(&backup, &second_restore).unwrap();

        // Restoring the backup leaves a receipt older than Plainsong's file.
        let mut db = Database::open_at_path(&backup, None).unwrap();
        db.update_recording_notes("meeting", Some("Third")).unwrap();
        publish(&mut db, &root).unwrap();
        let files: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert_eq!(files.len(), 1, "{files:?}");
        let contents = std::fs::read_to_string(&files[0]).unwrap();
        assert!(contents.contains("Third"));
        drop(db);

        // An edit that keeps Plainsong's front matter is still the user's.
        let edited = contents.replace("Third", "Third, with my edits");
        std::fs::write(&files[0], &edited).unwrap();
        let mut db = Database::open_at_path(&second_restore, None).unwrap();
        db.update_recording_notes("meeting", Some("Fourth"))
            .unwrap();
        let error = publish(&mut db, &root).unwrap_err();
        assert!(error.to_string().contains("outside Plainsong"), "{error}");
        assert_eq!(std::fs::read_to_string(&files[0]).unwrap(), edited);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn publishing_deletion_covers_files_in_earlier_notes_folders() {
        use crate::approved_locations::{ApprovedLocationPurpose, ApprovedLocationRegistry};
        let dir = crate::test_fs::TempDir::new("publish-delete-folders");
        let base = dir.path().canonicalize().unwrap();
        let (first, second) = (base.join("first"), base.join("second"));
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        let registry = ApprovedLocationRegistry::new(base.join("approved.json"));
        let mut db = setup();
        let mut locations = vec![];
        for (folder, notes) in [(&first, "One"), (&second, "Two")] {
            let location = registry
                .approve_filesystem(ApprovedLocationPurpose::Notes, folder)
                .unwrap();
            db.save_publish_config(&PublishConfig {
                enabled: true,
                location_id: Some(location.id.clone()),
                ..PublishConfig::default()
            })
            .unwrap();
            locations.push(location.id);
            db.update_recording_notes("meeting", Some(notes)).unwrap();
            publish(&mut db, folder).unwrap();
        }
        assert_eq!(
            db.publish_receipt_locations().unwrap(),
            locations.iter().cloned().collect()
        );

        // An unapproved folder stops the deletion before any file goes.
        let only_second: std::collections::HashSet<_> = [locations[1].clone()].into();
        let other = ApprovedLocationRegistry::new(base.join("other.json"));
        std::fs::copy(base.join("approved.json"), base.join("other.json")).unwrap();
        other.retain_notes_locations(&only_second).unwrap();
        let receipts = db.publish_receipts("meeting").unwrap();
        assert!(crate::publishing::delete_published_with(&other, receipts.clone()).is_err());
        assert_eq!(std::fs::read_dir(&second).unwrap().count(), 1);

        crate::publishing::delete_published_with(&registry, receipts).unwrap();
        assert_eq!(std::fs::read_dir(&first).unwrap().count(), 0);
        assert_eq!(std::fs::read_dir(&second).unwrap().count(), 0);
    }
}

#[cfg(test)]
mod artifact_tests {
    use super::*;
    #[test]
    fn publishing_captures_generated_artifacts_in_the_source_transaction() {
        let mut db = Database::new_in_memory_for_test().unwrap();
        db.conn.execute("INSERT OR IGNORE INTO projects(id,name,created_at,updated_at) VALUES('publish','Publish','2026-10-23T12:00:00Z','2026-10-23T12:00:00Z')",[]).unwrap();
        db.conn.execute("INSERT INTO recordings(id,title,project_id,created_at,updated_at,source_type,status,audio_path) VALUES('meeting','Planning','publish','2026-10-23T12:00:00Z','2026-10-23T12:00:00Z','meeting','processing','')",[]).unwrap();
        db.save_publish_config(&PublishConfig {
            enabled: true,
            location_id: Some("approved".into()),
            ..PublishConfig::default()
        })
        .unwrap();
        db.conn.execute("INSERT INTO meeting_artifacts(id,recording_id,summary,action_items,decisions,deadlines,created_at,updated_at) VALUES('artifact','meeting','Generated notes','[\"Send draft\"]','[]','[]','2026-10-23T12:00:00Z','2026-10-23T12:00:00Z')",[]).unwrap();
        assert!(db.next_publish_job(0).unwrap().is_none());
        db.update_recording_status("meeting", "completed").unwrap();
        let job = db.next_publish_job(0).unwrap().unwrap();
        let committed_revision = job.revision;
        assert!(committed_revision > 0);
        db.conn.execute("UPDATE meeting_artifacts SET action_items='[\"Updated task\"]' WHERE recording_id='meeting'",[]).unwrap();
        assert!(db.next_publish_job(0).unwrap().unwrap().revision > committed_revision);
    }
}
