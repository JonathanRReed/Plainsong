mod meeting_durability_tests {
    use super::*;

    fn meeting(db: &mut Database) {
        let mut recording = sample_recording("durable", "inbox");
        recording.status = "processing".into();
        db.create_recording(&recording).unwrap();
        db.save_transcript(&sample_transcript("durable")).unwrap();
    }

    #[test]
    fn keyword_search_is_ready_before_notes_or_embeddings() {
        let mut db = in_memory_db();
        meeting(&mut db);
        let key = "builtin:embeddinggemma-2:w2";
        assert_eq!(db.semantic_index_coverage(key).unwrap(), (0, 1));
        assert_eq!(db.search_transcripts("Hello", 10, None).unwrap().len(), 1);
        db.save_completed_transcript(&transcript_with_texts(
            "durable",
            &["Priya will review the launch checklist"],
        ))
        .unwrap();
        assert_eq!(db.semantic_index_coverage(key).unwrap(), (0, 1));
        assert_eq!(
            db.recordings_missing_semantic_index(key, 10).unwrap(),
            vec!["durable"]
        );
        let hits = db.search_transcripts("checklist", 10, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].recording_id, "durable");
        assert!(db.search_transcripts("Hello", 10, None).unwrap().is_empty());
    }

    #[test]
    fn completion_works_without_the_optional_search_index() {
        let mut db = in_memory_db();
        meeting(&mut db);
        db.conn.execute_batch("DROP TABLE transcript_fts;").unwrap();
        db.save_completed_transcript(&sample_transcript("durable"))
            .expect("an unavailable search index must not lose a transcript");
        assert_eq!(
            db.get_recording("durable").unwrap().unwrap().status,
            "completed"
        );
        assert_eq!(
            db.get_transcript("durable").unwrap().unwrap().full_text,
            "Hello world"
        );
    }

    #[test]
    fn deletion_works_without_the_optional_search_index() {
        let mut db = in_memory_db();
        meeting(&mut db);
        db.save_completed_transcript(&sample_transcript("durable"))
            .unwrap();
        db.conn.execute_batch("DROP TABLE transcript_fts;").unwrap();
        db.delete_recording("durable")
            .expect("search must not block deletion");
        assert!(db.get_recording("durable").unwrap().is_none());
        assert!(db.get_transcript("durable").unwrap().is_none());
    }

    #[test]
    fn failed_completion_keeps_the_partial_transcript_and_status() {
        let mut db = in_memory_db();
        meeting(&mut db);
        db.conn.execute_batch(
            "CREATE TRIGGER refuse_completion BEFORE UPDATE OF status ON recordings
             WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;"
        ).unwrap();
        let transcript = transcript_with_texts("durable", &["Replacement words"]);
        assert!(db.save_completed_transcript(&transcript).is_err());
        assert_eq!(
            db.get_recording("durable").unwrap().unwrap().status,
            "processing"
        );
        assert_eq!(
            db.get_transcript("durable").unwrap().unwrap().full_text,
            "Hello world"
        );
        assert_eq!(db.search_transcripts("Hello", 10, None).unwrap().len(), 1);
        assert!(db
            .search_transcripts("Replacement", 10, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn read_only_database_keeps_the_partial_transcript() {
        let mut db = in_memory_db();
        meeting(&mut db);
        db.conn.execute_batch("PRAGMA query_only = ON;").unwrap();
        assert!(db
            .save_completed_transcript(&transcript_with_texts("durable", &["Replacement"]))
            .is_err());
        assert_eq!(
            db.get_transcript("durable").unwrap().unwrap().full_text,
            "Hello world"
        );
        assert_eq!(
            db.get_recording("durable").unwrap().unwrap().status,
            "processing"
        );
    }

    #[test]
    fn sqlite_full_keeps_the_partial_transcript_and_status() {
        let mut db = in_memory_db();
        meeting(&mut db);
        let pages: u32 = db
            .conn
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .unwrap();
        db.conn
            .execute_batch(&format!("PRAGMA max_page_count = {pages};"))
            .unwrap();
        let text = "Meeting words ".repeat(32_768);
        let error = db
            .save_completed_transcript(&transcript_with_texts("durable", &[&text]))
            .unwrap_err();
        assert!(matches!(error.downcast_ref::<rusqlite::Error>(),
            Some(rusqlite::Error::SqliteFailure(code, _)) if code.code == rusqlite::ErrorCode::DiskFull));
        assert_eq!(
            db.get_transcript("durable").unwrap().unwrap().full_text,
            "Hello world"
        );
        assert_eq!(
            db.get_recording("durable").unwrap().unwrap().status,
            "processing"
        );
        assert_eq!(db.search_transcripts("Hello", 10, None).unwrap().len(), 1);
    }

    #[test]
    fn competing_writer_can_retry_without_losing_the_partial_transcript() {
        let dir = crate::test_fs::TempDir::new("meeting-concurrent-write");
        let path = dir.path().join("meeting.db");
        let mut first = Database::open_at_path(&path, None).unwrap();
        meeting(&mut first);
        let mut second = Database::open_at_path(&path, None).unwrap();
        second.conn.busy_timeout(std::time::Duration::ZERO).unwrap();
        let lock = first
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert!(second
            .save_completed_transcript(&sample_transcript("durable"))
            .is_err());
        assert_eq!(
            second.get_transcript("durable").unwrap().unwrap().full_text,
            "Hello world"
        );
        lock.commit().unwrap();
        second
            .save_completed_transcript(&sample_transcript("durable"))
            .unwrap();
        assert_eq!(
            first.get_recording("durable").unwrap().unwrap().status,
            "completed"
        );
    }

    #[test]
    fn failed_delete_rolls_back_the_transcript_search_rows_and_aliases() {
        let mut db = in_memory_db();
        meeting(&mut db);
        db.save_completed_transcript(&sample_transcript("durable"))
            .unwrap();
        db.rename_speaker("durable", "speaker_0", "Saved name")
            .unwrap();
        db.conn
            .execute_batch(
                "CREATE TRIGGER refuse_delete BEFORE DELETE ON recordings
             BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END;",
            )
            .unwrap();
        assert!(db.delete_recording("durable").is_err());
        assert!(db.get_recording("durable").unwrap().is_some());
        assert!(db.get_transcript("durable").unwrap().is_some());
        assert_eq!(db.search_transcripts("Hello", 10, None).unwrap().len(), 1);
        assert_eq!(
            db.get_speaker_aliases("durable").unwrap()["speaker_0"]
                .0
                .as_deref(),
            Some("Saved name")
        );
    }

    #[test]
    fn rename_failure_does_not_commit_half_a_speaker_identity() {
        let mut db = in_memory_db();
        meeting(&mut db);
        db.rename_speaker("durable", "speaker_0", "Original")
            .unwrap();
        db.conn.execute_batch(
            "UPDATE speaker_aliases SET voice_profile_id = 'remembered', voice_match_state = 'confirmed';
             CREATE TRIGGER refuse_voice_unlink BEFORE UPDATE OF voice_profile_id ON speaker_aliases
             BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;"
        ).unwrap();
        assert!(db
            .rename_speaker("durable", "speaker_0", "Renamed")
            .is_err());
        assert_eq!(
            db.get_speaker_aliases("durable").unwrap()["speaker_0"]
                .0
                .as_deref(),
            Some("Original")
        );
    }

    #[test]
    fn speaker_rename_survives_reopen_with_unicode() {
        let dir = crate::test_fs::TempDir::new("meeting-speaker-reopen");
        let path = dir.path().join("meeting.db");
        {
            let mut db = Database::open_at_path(&path, None).unwrap();
            meeting(&mut db);
            db.rename_speaker("durable", "speaker_0", "李雷 / Zoë 🦀")
                .unwrap();
        }
        let db = Database::open_at_path(&path, None).unwrap();
        assert_eq!(
            db.get_speaker_aliases("durable").unwrap()["speaker_0"]
                .0
                .as_deref(),
            Some("李雷 / Zoë 🦀")
        );
    }

    #[test]
    fn a_corrupted_search_index_does_not_block_open_or_reading_other_meetings() {
        let dir = crate::test_fs::TempDir::new("meeting-fts-corruption");
        let path = dir.path().join("meeting.db");
        {
            let mut db = Database::open_at_path(&path, None).unwrap();
            meeting(&mut db);
            db.conn
                .execute_batch("UPDATE transcript_fts_data SET block = x'00' WHERE id = 1;")
                .unwrap();
            assert!(db
                .conn
                .execute(
                    "INSERT INTO transcript_fts(transcript_fts) VALUES('integrity-check')",
                    []
                )
                .is_err());
        }
        let db = Database::open_at_path(&path, None).expect("keep primary data available");
        assert_eq!(
            db.get_transcript("durable").unwrap().unwrap().full_text,
            "Hello world"
        );
        assert_eq!(db.search_transcripts("Hello", 10, None).unwrap().len(), 1);
    }

    #[test]
    fn a_corrupted_search_index_does_not_lose_a_completed_transcript() {
        let dir = crate::test_fs::TempDir::new("meeting-fts-rebuild");
        let path = dir.path().join("meeting.db");
        let mut db = Database::open_at_path(&path, None).unwrap();
        meeting(&mut db);
        db.conn
            .execute_batch("UPDATE transcript_fts_data SET block = x'00' WHERE id = 1;")
            .unwrap();
        db.save_completed_transcript(&transcript_with_texts("durable", &["Recovered words"]))
            .expect("the primary transcript must survive an index fault");
        assert_eq!(
            db.get_transcript("durable").unwrap().unwrap().full_text,
            "Recovered words"
        );
        assert_eq!(
            db.search_transcripts("Recovered", 10, None).unwrap().len(),
            1
        );
        assert!(db.search_transcripts("Hello", 10, None).unwrap().is_empty());
        drop(db);
        let mut db = Database::open_at_path(&path, None).unwrap();
        db.conn
            .execute(
                "INSERT INTO transcript_fts(transcript_fts) VALUES('integrity-check')",
                [],
            )
            .unwrap();
        assert_eq!(
            db.search_transcripts("Recovered", 10, None).unwrap().len(),
            1
        );
        assert!(db.search_transcripts("Hello", 10, None).unwrap().is_empty());
        db.delete_recording("durable").unwrap();
        assert!(db
            .search_transcripts("Recovered", 10, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn crash_during_completion_child() {
        let Some(root) = std::env::var_os("PLAINSONG_TEST_CRASH_DATABASE_DIR") else {
            return;
        };
        let root = PathBuf::from(root);
        let mut db = Database::open_at_path(&root.join("meeting.db"), None).unwrap();
        let plan = RecordingCapturePlan {
            recording_id: "durable".into(),
            primary_path: root.join("meeting.wav"),
            mic_path: None,
            system_path: None,
        };
        let mut recording = sample_recording("durable", "inbox");
        recording.status = "processing".into();
        db.create_recording_with_audio_plan(&recording, &plan)
            .unwrap();
        write_test_wav(&plan.primary_path);
        db.save_transcript(&sample_transcript("durable")).unwrap();
        let tx = db.conn.transaction().unwrap();
        tx.execute_batch(
            "UPDATE transcripts SET full_text = 'Uncommitted replacement';
            UPDATE recordings SET status = 'completed';",
        )
        .unwrap();
        std::fs::write(root.join("ready"), b"ready").unwrap();
        loop {
            std::thread::park();
        }
    }

    #[test]
    fn killed_database_writer_keeps_committed_transcript_and_recoverable_audio() {
        let dir = crate::test_fs::TempDir::new("meeting-killed-database");
        crate::test_fs::kill_test_child_at_checkpoint(
            "db::tests::meeting_durability_tests::crash_during_completion_child",
            "PLAINSONG_TEST_CRASH_DATABASE_DIR",
            dir.path(),
        );
        let mut db = Database::open_at_path(&dir.path().join("meeting.db"), None).unwrap();
        assert_eq!(
            db.get_recording("durable").unwrap().unwrap().status,
            "processing"
        );
        assert_eq!(
            db.get_transcript("durable").unwrap().unwrap().full_text,
            "Hello world"
        );
        let bundle = db.load_recording_audio_bundle("durable").unwrap();
        let updates = crate::revalidated_recording_audio_updates(&bundle);
        assert!(crate::revalidated_recording_audio_is_recoverable(&updates));
        db.repair_audio_asset_lifecycles("durable", &updates, Some("error"))
            .unwrap();
        assert_eq!(
            db.get_recording("durable").unwrap().unwrap().status,
            "error"
        );
        assert_eq!(
            db.load_recording_audio_bundle("durable")
                .unwrap()
                .primary
                .unwrap()
                .lifecycle,
            RecordingAudioLifecycle::Ready
        );
        assert_eq!(
            db.get_transcript("durable").unwrap().unwrap().full_text,
            "Hello world"
        );
    }

    #[test]
    fn corrupt_database_is_rejected_without_replacing_its_bytes() {
        let dir = crate::test_fs::TempDir::new("meeting-corrupt-database");
        let path = dir.path().join("meeting.db");
        let bytes = b"corrupted sqlite fixture, keep for recovery";
        std::fs::write(&path, bytes).unwrap();
        assert!(Database::open_at_path(&path, None).is_err());
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}
