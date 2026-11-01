use super::*;
use crate::audio_compression::CompressionJob;

pub(super) fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS audio_compression_jobs (
        id INTEGER PRIMARY KEY,
        recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        source_name TEXT NOT NULL,
        target_name TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        committed INTEGER NOT NULL DEFAULT 0,
        in_progress INTEGER NOT NULL DEFAULT 1,
        next_attempt INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        bytes_saved INTEGER NOT NULL DEFAULT 0,
        UNIQUE(recording_id,role));
        CREATE TABLE IF NOT EXISTS audio_compression_totals (
            id INTEGER PRIMARY KEY CHECK(id=1), bytes_saved INTEGER NOT NULL DEFAULT 0);
        INSERT OR IGNORE INTO audio_compression_totals(id) VALUES(1);",
    )?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meeting_audio_finalization (
        recording_id TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
        ready INTEGER NOT NULL DEFAULT 0);",
    )?;
    Ok(())
}

impl Database {
    pub(crate) fn set_meeting_audio_finalized(
        &self,
        recording_id: &str,
        ready: bool,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meeting_audio_finalization(recording_id,ready) VALUES(?1,?2)
            ON CONFLICT(recording_id) DO UPDATE SET ready=excluded.ready",
            params![recording_id, ready],
        )?;
        Ok(())
    }

    pub(crate) fn meeting_audio_finalized(&self, recording_id: &str) -> Result<bool> {
        let Some(recording) = self.get_recording(recording_id)? else {
            return Ok(false);
        };
        if recording.status != "completed"
            || !recording.transcript_complete
            || self.get_transcript(recording_id)?.is_none()
        {
            return Ok(false);
        }
        let ready: Option<bool> = self
            .conn
            .query_row(
                "SELECT ready FROM meeting_audio_finalization WHERE recording_id=?1",
                [recording_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(ready) = ready {
            return Ok(ready);
        }
        // Legacy meetings require durable successful speaker evidence. Unknown
        // speaker state retains full-rate audio until a successful retry.
        Ok(self.get_transcript_diarizer(recording_id)?.is_some()
            || self
                .get_transcript(recording_id)?
                .is_some_and(|t| crate::transcript_has_source_aware_speakers(&t.segments)))
    }

    pub(crate) fn has_pending_audio_compression(&self, recording_id: &str) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM audio_compression_jobs WHERE recording_id=?1 AND (in_progress=1 OR committed=1))",
            [recording_id],
            |r| r.get(0),
        )?)
    }

    pub(crate) fn compression_job(&self, asset: &RecordingAudioAsset) -> Result<CompressionJob> {
        let directory = asset.path.parent().context("Audio has no parent")?;
        let (id, source, target, committed): (i64, String, String, bool) = self.conn.query_row(
            "SELECT id,source_name,target_name,committed FROM audio_compression_jobs WHERE recording_id=?1 AND role=?2",
            params![asset.recording_id, asset.role.as_str()],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
        for name in [&source, &target] {
            anyhow::ensure!(
                Path::new(name).file_name() == Some(std::ffi::OsStr::new(name)),
                "Invalid compression journal filename"
            );
        }
        Ok(CompressionJob {
            id,
            recording_id: asset.recording_id.clone(),
            role: asset.role,
            source: directory.join(source),
            target: directory.join(target),
            committed,
        })
    }

    pub(crate) fn begin_audio_compression(
        &self,
        asset: &RecordingAudioAsset,
    ) -> Result<CompressionJob> {
        let still_owned: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM recording_audio_assets WHERE recording_id=?1 AND role=?2 AND path=?3)", params![asset.recording_id,asset.role.as_str(),asset.path.to_string_lossy()], |r|r.get(0))?;
        anyhow::ensure!(still_owned, "Audio was removed before compression started");
        let target = format!(
            "{}.flac{}",
            uuid::Uuid::new_v4(),
            if asset.protection == RecordingAudioProtection::Encrypted {
                ".enc"
            } else {
                ""
            }
        );
        let name = asset
            .path
            .file_name()
            .context("Audio has no filename")?
            .to_string_lossy();
        let hash = crate::recording_audio::compute_file_sha256(&asset.path)?;
        self.conn.execute("INSERT OR IGNORE INTO audio_compression_jobs(recording_id,role,source_name,target_name,source_hash) VALUES(?1,?2,?3,?4,?5)",
            params![asset.recording_id,asset.role.as_str(),name,target,hash])?;
        self.compression_job(asset)
    }

    /// Bind both paths and the compressed plaintext's integrity metadata in the
    /// same transaction as the cleanup journal. A crash always leaves a reader
    /// with either the old WAV or the verified compressed file.
    pub(crate) fn commit_audio_compression(
        &mut self,
        job: &CompressionJob,
        metadata: &ValidatedRecordingAudio,
        saved: u64,
    ) -> Result<()> {
        let finalized = self.meeting_audio_finalized(&job.recording_id)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute("UPDATE recording_audio_assets SET path=?1,plaintext_bytes=?2,plaintext_sha256=?3,updated_at=?4 WHERE recording_id=?5 AND role=?6 AND path=?7 AND lifecycle='ready' AND EXISTS(SELECT 1 FROM recordings WHERE id=?5 AND status='completed' AND (source_type<>'meeting' OR ?8))",
            params![job.target.to_string_lossy(),i64::try_from(metadata.plaintext_bytes)?,metadata.plaintext_sha256,Utc::now().to_rfc3339(),job.recording_id,job.role.as_str(),job.source.to_string_lossy(),finalized])?;
        anyhow::ensure!(changed == 1, "Audio changed during compression");
        if job.role == RecordingAudioRole::Primary || !tx.query_row("SELECT EXISTS(SELECT 1 FROM recording_audio_assets WHERE recording_id=?1 AND role='primary')", [&job.recording_id], |r|r.get::<_,bool>(0))? {
            tx.execute(
                "UPDATE recordings SET audio_path=?1 WHERE id=?2",
                params![job.target.to_string_lossy(), job.recording_id],
            )?;
        }
        tx.execute("UPDATE audio_compression_jobs SET committed=1,bytes_saved=?1 WHERE id=?2 AND committed=0",params![i64::try_from(saved)?,job.id])?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn finish_audio_compression(&mut self, job: &CompressionJob) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT OR IGNORE INTO audio_compression_totals(id) VALUES(1)",
            [],
        )?;
        tx.execute("UPDATE audio_compression_totals SET bytes_saved=bytes_saved+COALESCE((SELECT bytes_saved FROM audio_compression_jobs WHERE id=?1 AND committed=1),0) WHERE id=1",[job.id])?;
        tx.execute(
            "DELETE FROM audio_compression_jobs WHERE id=?1 AND committed=1",
            [job.id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn compression_source_unchanged(&self, job: &CompressionJob) -> Result<bool> {
        let hash: String = self.conn.query_row(
            "SELECT source_hash FROM audio_compression_jobs WHERE id=?1",
            [job.id],
            |r| r.get(0),
        )?;
        Ok(crate::recording_audio::compute_file_sha256(&job.source)? == hash)
    }

    pub(crate) fn compression_paths_for_recording(
        &self,
        recording_id: &str,
    ) -> Result<Vec<PathBuf>> {
        let bundle = self.load_recording_audio_bundle(recording_id)?;
        let mut paths = HashSet::new();
        for job in self.compression_jobs_for_bundle(&bundle)? {
            paths.insert(job.source);
            paths.insert(job.target);
        }
        Ok(paths.into_iter().collect())
    }

    pub(crate) fn compression_jobs_for_bundle(
        &self,
        bundle: &RecordingAudioBundle,
    ) -> Result<Vec<CompressionJob>> {
        let Some(anchor) = bundle.assets().next() else {
            return Ok(Vec::new());
        };
        let mut statement = self
            .conn
            .prepare("SELECT role FROM audio_compression_jobs WHERE recording_id=?1")?;
        let roles = statement
            .query_map([&bundle.recording_id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        roles
            .into_iter()
            .map(|role| {
                let mut asset = anchor.clone();
                asset.role = RecordingAudioRole::from_str(&role)?;
                self.compression_job(&asset)
            })
            .collect()
    }

    /// The journal retains the old mix until cleanup. The compatibility path
    /// points to a surviving source; runtime readers rebuild the actual mix.
    pub(crate) fn retire_meeting_mix(
        &mut self,
        bundle: &RecordingAudioBundle,
    ) -> Result<CompressionJob> {
        anyhow::ensure!(
            self.meeting_audio_finalized(&bundle.recording_id)?,
            "Meeting is not finalized"
        );
        let primary = bundle.primary.as_ref().context("No stored mix")?;
        let source = bundle.system.as_ref().context("No call track")?;
        anyhow::ensure!(
            primary.path != source.path && primary.path.parent() == source.path.parent(),
            "Mix cleanup requires distinct files in the recording directory"
        );
        anyhow::ensure!(
            bundle
                .assets()
                .all(|a| a.lifecycle == RecordingAudioLifecycle::Ready),
            "Audio is not ready"
        );
        let hash = crate::recording_audio::compute_file_sha256(&primary.path)?;
        let bytes = std::fs::metadata(&primary.path)?.len();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        anyhow::ensure!(
            !tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM audio_compression_jobs WHERE recording_id=?1)",
                [&bundle.recording_id],
                |r| r.get::<_, bool>(0)
            )?,
            "Audio conversion is pending"
        );
        for asset in bundle.assets() {
            anyhow::ensure!(tx.query_row("SELECT EXISTS(SELECT 1 FROM recording_audio_assets WHERE recording_id=?1 AND role=?2 AND path=?3 AND lifecycle='ready')",params![bundle.recording_id,asset.role.as_str(),asset.path.to_string_lossy()],|r|r.get::<_,bool>(0))?, "Audio changed before mix removal");
        }
        tx.execute("INSERT INTO audio_compression_jobs(recording_id,role,source_name,target_name,source_hash,committed,bytes_saved) VALUES(?1,'primary',?2,?3,?4,1,?5)",params![bundle.recording_id,primary.path.file_name().context("No mix filename")?.to_string_lossy(),source.path.file_name().context("No call filename")?.to_string_lossy(),hash,i64::try_from(bytes)?])?;
        tx.execute(
            "DELETE FROM recording_audio_assets WHERE recording_id=?1 AND role='primary'",
            [&bundle.recording_id],
        )?;
        tx.execute(
            "UPDATE recordings SET audio_path=?1 WHERE id=?2",
            params![source.path.to_string_lossy(), bundle.recording_id],
        )?;
        tx.commit()?;
        self.compression_job(primary)
    }

    pub(crate) fn compression_due(
        &self,
        recording_id: &str,
        role: RecordingAudioRole,
    ) -> Result<bool> {
        Ok(self.conn.query_row("SELECT COALESCE((SELECT next_attempt <= unixepoch() FROM audio_compression_jobs WHERE recording_id=?1 AND role=?2),1)", params![recording_id,role.as_str()], |r| r.get(0))?)
    }

    pub(crate) fn defer_audio_compression(&self, job: &CompressionJob) -> Result<()> {
        self.conn.execute(
            "UPDATE audio_compression_jobs SET next_attempt=unixepoch()+min(86400,300*(1 << min(attempts,9))),attempts=attempts+1,in_progress=1 WHERE id=?1",
            [job.id],
        )?;
        Ok(())
    }

    pub(crate) fn end_compression_attempt(
        &self,
        job: &CompressionJob,
        roots: &[PathBuf],
    ) -> Result<()> {
        let unpublished: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM audio_compression_jobs WHERE id=?1 AND committed=0)",
            [job.id],
            |r| r.get(0),
        )?;
        if unpublished {
            if job.target.exists() {
                let path = crate::ensure_regular_file_in_roots(
                    &job.target,
                    "unpublished compressed audio",
                    roots,
                )
                .map_err(anyhow::Error::msg)?;
                std::fs::remove_file(path)?;
                crate::recording_audio::sync_parent_directory(&job.target)?;
            }
            self.conn.execute(
                "UPDATE audio_compression_jobs SET in_progress=0 WHERE id=?1",
                [job.id],
            )?;
        }
        Ok(())
    }

    pub(crate) fn clear_idle_audio_compression(&self, recording_id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM audio_compression_jobs WHERE recording_id=?1 AND committed=0 AND in_progress=0",[recording_id])?;
        Ok(())
    }

    pub(crate) fn compression_bytes_saved(&self) -> Result<u64> {
        let value: i64 = self.conn.query_row(
            "SELECT COALESCE((SELECT bytes_saved FROM audio_compression_totals WHERE id=1),0)",
            [],
            |r| r.get(0),
        )?;
        Ok(u64::try_from(value)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (Database, RecordingAudioAsset, PathBuf) {
        let mut db = Database::new_in_memory_for_test().unwrap();
        let root =
            std::env::temp_dir().join(format!("plainsong-compression-db-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("source.wav");
        std::fs::write(&source, b"old source").unwrap();
        let now = Utc::now();
        let recording: Recording = serde_json::from_value(serde_json::json!({
            "id":"compression", "title":"Codec fixture", "projectId":"inbox", "duration":3,
            "createdAt":now,"updatedAt":now,"sourceType":"meeting","audioPath":source,"status":"completed"
        })).unwrap();
        db.create_recording(&recording).unwrap();
        db.conn
            .execute(
                "UPDATE recordings SET transcript_complete=1 WHERE id='compression'",
                [],
            )
            .unwrap();
        db.set_meeting_audio_finalized("compression", true).unwrap();
        let transcript = serde_json::from_value(serde_json::json!({"id":"t","recordingId":"compression","fullText":"Fixture","segments":[],"language":"en","confidence":1.0,"model":"fixture","createdAt":now})).unwrap();
        db.save_transcript(&transcript).unwrap();
        db.conn.execute("INSERT INTO recording_audio_assets(recording_id,role,path,lifecycle,protection,created_at,updated_at) VALUES('compression','primary',?1,'ready','plaintext',?2,?2)",params![source.to_string_lossy(),now.to_rfc3339()]).unwrap();
        let asset = db
            .load_recording_audio_bundle("compression")
            .unwrap()
            .primary
            .unwrap();
        (db, asset, root)
    }
    #[test]
    fn compression_journal_resumes_on_either_side_of_atomic_path_switch() {
        let (mut db, asset, root) = setup();
        let job = db.begin_audio_compression(&asset).unwrap();
        assert!(db.has_pending_audio_compression("compression").unwrap());
        assert!(!db.compression_job(&asset).unwrap().committed);
        assert_eq!(
            db.get_recording("compression").unwrap().unwrap().audio_path,
            asset.path.to_string_lossy()
        );
        assert!(asset.path.exists());
        let metadata = ValidatedRecordingAudio {
            plaintext_bytes: 3,
            plaintext_sha256: "verified hash".into(),
            duration_seconds: 3,
        };
        std::fs::write(&job.target, b"new").unwrap();
        db.commit_audio_compression(&job, &metadata, 7).unwrap();
        let current = db
            .load_recording_audio_bundle("compression")
            .unwrap()
            .primary
            .unwrap();
        assert_eq!(current.path, job.target);
        assert_eq!(current.plaintext_sha256, Some(metadata.plaintext_sha256));
        assert_eq!(
            db.get_recording("compression").unwrap().unwrap().audio_path,
            job.target.to_string_lossy()
        );
        assert!(asset.path.exists(), "WAV remains until after the DB switch");
        assert!(db.compression_job(&current).unwrap().committed);
        std::fs::remove_file(&job.source).unwrap();
        db.finish_audio_compression(&job).unwrap();
        db.finish_audio_compression(&job).unwrap();
        assert_eq!(
            db.compression_bytes_saved().unwrap(),
            7,
            "cleanup retry cannot double count savings"
        );
        assert!(!db.has_pending_audio_compression("compression").unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn stale_source_and_pending_transcription_cannot_be_published() {
        let (mut db, asset, root) = setup();
        let job = db.begin_audio_compression(&asset).unwrap();
        assert!(db.compression_source_unchanged(&job).unwrap());
        std::fs::write(&job.source, b"replaced source").unwrap();
        assert!(!db.compression_source_unchanged(&job).unwrap());
        db.conn
            .execute(
                "UPDATE recordings SET status='processing' WHERE id='compression'",
                [],
            )
            .unwrap();
        assert!(db
            .commit_audio_compression(
                &job,
                &ValidatedRecordingAudio {
                    plaintext_bytes: 3,
                    plaintext_sha256: "new".into(),
                    duration_seconds: 3
                },
                7
            )
            .is_err());
        assert_eq!(
            db.load_recording_audio_bundle("compression")
                .unwrap()
                .primary
                .unwrap()
                .path,
            asset.path
        );
        assert!(!db.compression_job(&asset).unwrap().committed);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn conversion_requires_successful_final_transcription_and_speaker_pass() {
        let (mut db, asset, root) = setup();
        let job = db.begin_audio_compression(&asset).unwrap();
        let metadata = ValidatedRecordingAudio {
            plaintext_bytes: 3,
            plaintext_sha256: "new".into(),
            duration_seconds: 3,
        };
        for status in ["pending", "recording", "processing", "error"] {
            db.update_recording_status("compression", status).unwrap();
            assert!(!db.meeting_audio_finalized("compression").unwrap());
            assert!(
                db.commit_audio_compression(&job, &metadata, 7).is_err(),
                "{status}"
            );
        }
        db.update_recording_status("compression", "completed")
            .unwrap();
        db.set_meeting_audio_finalized("compression", false)
            .unwrap();
        assert!(
            db.commit_audio_compression(&job, &metadata, 7).is_err(),
            "failed speaker pass"
        );
        db.set_meeting_audio_finalized("compression", true).unwrap();
        db.conn
            .execute(
                "UPDATE recordings SET transcript_complete=0 WHERE id='compression'",
                [],
            )
            .unwrap();
        assert!(
            db.commit_audio_compression(&job, &metadata, 7).is_err(),
            "partial transcript"
        );
        assert_eq!(
            db.load_recording_audio_bundle("compression")
                .unwrap()
                .primary
                .unwrap()
                .path,
            asset.path
        );
        assert!(job.source.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_conversion_remains_retryable_without_blocking_pruning() {
        let (db, asset, root) = setup();
        let job = db.begin_audio_compression(&asset).unwrap();
        std::fs::write(&job.target, b"partial output").unwrap();
        assert!(db
            .has_pending_audio_compression(&asset.recording_id)
            .unwrap());
        db.end_compression_attempt(&job, std::slice::from_ref(&root))
            .unwrap();
        assert!(!job.target.exists());
        assert!(job.source.exists());
        assert!(!db
            .has_pending_audio_compression(&asset.recording_id)
            .unwrap());
        assert!(!db.compression_job(&asset).unwrap().committed);
        db.clear_idle_audio_compression(&asset.recording_id)
            .unwrap();
        assert!(db.compression_job(&asset).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pending_journal_paths_follow_backup_restore_directory() {
        let (db, mut asset, root) = setup();
        let job = db.begin_audio_compression(&asset).unwrap();
        asset.path = root.join("restored").join(asset.path.file_name().unwrap());
        let moved = db.compression_job(&asset).unwrap();
        assert_eq!(moved.source, root.join("restored/source.wav"));
        assert_eq!(moved.target.file_name(), job.target.file_name());
        std::fs::remove_dir_all(root).unwrap();
    }
}
