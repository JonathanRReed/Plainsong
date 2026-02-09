//! Database operations using SQLite
//!
//! Manages recordings, transcripts, projects, and audit logs
//! with full CRUD operations.

#![allow(dead_code)]

use crate::models::*;
use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::fs;
pub struct Database {
    conn: Connection,
}

impl Database {
    /// Create new database connection with optional encryption
    pub fn new_with_key(_key: Option<&str>) -> Result<Self> {
        let app_dir = dirs::data_dir()
            .context("Could not find data directory")?
            .join("Nautilus");

        fs::create_dir_all(&app_dir)?;

        let db_path = app_dir.join("nautilus.db");
        let conn = Connection::open(db_path)?;

        // Set up encryption if key provided and SQLCipher is enabled
        #[cfg(feature = "sqlcipher")]
        if let Some(key) = _key {
            let hex_key = hex::encode(key.as_bytes());
            conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", hex_key))?;
            // Verify encryption is working
            conn.execute("SELECT count(*) FROM sqlite_master;", [])?;
        }

        let db = Self { conn };
        db.init_tables()?;

        Ok(db)
    }

    /// Create new database (default, no encryption)
    pub fn new() -> Result<Self> {
        Self::new_with_key(None)
    }

    /// Check if database is encrypted
    #[cfg(feature = "sqlcipher")]
    pub fn is_encrypted(&self) -> Result<bool> {
        let cipher_version: Option<String> =
            self.conn
                .query_row("PRAGMA cipher_version;", [], |row| row.get(0))?;
        Ok(cipher_version.is_some())
    }

    /// Check if database is encrypted (fallback when SQLCipher not enabled)
    #[cfg(not(feature = "sqlcipher"))]
    pub fn is_encrypted(&self) -> Result<bool> {
        Ok(false)
    }

    /// Change database key (encrypt or re-encrypt)
    #[cfg(feature = "sqlcipher")]
    pub fn change_key(&self, new_key: &str) -> Result<()> {
        let hex_key = hex::encode(new_key.as_bytes());
        self.conn
            .execute_batch(&format!("PRAGMA rekey = \"x'{}'\";", hex_key))?;
        tracing::info!("Database encryption key changed");
        Ok(())
    }

    /// Log an audit event
    pub fn log_audit_event(
        &mut self,
        event: &str,
        details: Option<serde_json::Value>,
        severity: &str,
    ) -> Result<()> {
        let id = uuid::Uuid::new_v4().to_string();
        let timestamp = Utc::now();
        let details_json = details
            .map(|d| d.to_string())
            .unwrap_or_else(|| "{}".to_string());

        self.conn.execute(
            "INSERT INTO audit_log (id, timestamp, event, details, severity) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, timestamp.to_rfc3339(), event, details_json, severity],
        )?;

        tracing::info!("Audit log: [{}] {}", severity, event);
        Ok(())
    }

    fn init_tables(&self) -> Result<()> {
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                parent_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                encrypted INTEGER DEFAULT 0,
                key_salt TEXT,
                key_hint TEXT
            )",
            [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS recordings (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                project_id TEXT NOT NULL,
                duration INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                source_type TEXT NOT NULL,
                audio_path TEXT,
                status TEXT NOT NULL DEFAULT 'recording'
            )",
            [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS transcripts (
                id TEXT PRIMARY KEY,
                recording_id TEXT NOT NULL,
                segments TEXT,
                full_text TEXT,
                language TEXT,
                confidence REAL,
                model TEXT,
                created_at TEXT NOT NULL
            )",
            [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS audit_log (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                event TEXT NOT NULL,
                details TEXT,
                severity TEXT NOT NULL DEFAULT 'info'
            )",
            [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS speaker_aliases (
                recording_id TEXT NOT NULL,
                speaker_id TEXT NOT NULL,
                name TEXT,
                color TEXT,
                sample_count INTEGER DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (recording_id, speaker_id)
            )",
            [],
        )?;

        self.conn.execute(
            "CREATE TRIGGER IF NOT EXISTS audit_log_no_update
             BEFORE UPDATE ON audit_log
             BEGIN
                 SELECT RAISE(ABORT, 'audit_log is append-only');
             END;",
            [],
        )?;

        self.conn.execute(
            "CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
             BEFORE DELETE ON audit_log
             BEGIN
                 SELECT RAISE(ABORT, 'audit_log is append-only');
             END;",
            [],
        )?;

        self.conn.execute(
            "INSERT OR IGNORE INTO projects (id, name, description, created_at, updated_at) 
             VALUES ('default', 'Inbox', 'Default inbox for new recordings', ?1, ?1)",
            [Utc::now().to_rfc3339()],
        )?;

        Ok(())
    }

    pub fn create_project(&mut self, project: &CreateProjectRequest) -> Result<Project> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now();

        self.conn.execute(
            "INSERT INTO projects (id, name, description, parent_id, created_at, updated_at, encrypted, key_salt, key_hint)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, 0, NULL, NULL)",
            params![
                &id,
                &project.name,
                project.description.as_ref(),
                project.parent_id.as_ref(),
                now.to_rfc3339()
            ],
        )?;

        Ok(Project {
            id,
            name: project.name.clone(),
            description: project.description.clone(),
            parent_id: project.parent_id.clone(),
            created_at: now,
            updated_at: now,
            encrypted: false,
            key_salt: None,
            key_hint: None,
        })
    }

    pub fn get_projects(&self) -> Result<Vec<Project>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, description, parent_id, created_at, updated_at, encrypted, key_salt, key_hint
             FROM projects ORDER BY created_at DESC"
        )?;

        let projects = stmt.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                parent_id: row.get(3)?,
                created_at: row
                    .get::<_, String>(4)?
                    .parse()
                    .unwrap_or_else(|e| { tracing::warn!("Project created_at parse error: {}", e); Utc::now() }),
                updated_at: row
                    .get::<_, String>(5)?
                    .parse()
                    .unwrap_or_else(|e| { tracing::warn!("Project updated_at parse error: {}", e); Utc::now() }),
                encrypted: row.get::<_, i32>(6)? != 0,
                key_salt: row.get(7)?,
                key_hint: row.get(8)?,
            })
        })?;

        projects
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.into())
    }

    pub fn get_recordings(&self, project_id: Option<&str>) -> Result<Vec<Recording>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, project_id, duration, created_at, updated_at, source_type, audio_path, status
             FROM recordings WHERE (?1 IS NULL OR project_id = ?1) ORDER BY created_at DESC"
        )?;

        let pid_param: Option<&str> = project_id;

        let recordings = stmt.query_map(params![pid_param], |row| {
            Ok(Recording {
                id: row.get(0)?,
                title: row.get(1)?,
                project_id: row.get(2)?,
                duration: row.get(3)?,
                created_at: row
                    .get::<_, String>(4)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
                updated_at: row
                    .get::<_, String>(5)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
                source_type: row.get(6)?,
                audio_path: row.get(7)?,
                status: row.get(8)?,
            })
        })?;

        recordings
            .collect::<Result<Vec<_>, rusqlite::Error>>()
            .map_err(|e| e.into())
    }

    pub fn get_recording(&self, recording_id: &str) -> Result<Option<Recording>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, project_id, duration, created_at, updated_at, source_type, audio_path, status
             FROM recordings WHERE id = ?1"
        )?;

        let result = stmt.query_row([recording_id], |row| {
            Ok(Recording {
                id: row.get(0)?,
                title: row.get(1)?,
                project_id: row.get(2)?,
                duration: row.get(3)?,
                created_at: row
                    .get::<_, String>(4)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
                updated_at: row
                    .get::<_, String>(5)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
                source_type: row.get(6)?,
                audio_path: row.get(7)?,
                status: row.get(8)?,
            })
        });

        match result {
            Ok(recording) => Ok(Some(recording)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn update_recording_path(&mut self, recording_id: &str, audio_path: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE recordings SET audio_path = ?1, status = 'completed', updated_at = ?2 WHERE id = ?3",
            params![audio_path, Utc::now().to_rfc3339(), recording_id],
        )?;
        Ok(())
    }

    pub fn get_transcript(&self, recording_id: &str) -> Result<Option<Transcript>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, recording_id, segments, full_text, language, confidence, model, created_at
             FROM transcripts WHERE recording_id = ?1",
        )?;

        let result = stmt.query_row([recording_id], |row| {
            let segments_json: String = row.get(2)?;
            let segments: Vec<TranscriptSegment> =
                serde_json::from_str(&segments_json).unwrap_or_default();

            Ok(Transcript {
                id: row.get(0)?,
                recording_id: row.get(1)?,
                segments,
                full_text: row.get(3)?,
                language: row.get(4)?,
                confidence: row.get(5)?,
                model: row.get(6)?,
                created_at: row
                    .get::<_, String>(7)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
            })
        });

        match result {
            Ok(transcript) => Ok(Some(transcript)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn create_recording(&mut self, recording: &Recording) -> Result<()> {
        self.conn.execute(
            "INSERT INTO recordings (id, title, project_id, duration, created_at, updated_at, source_type, audio_path, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                &recording.id,
                &recording.title,
                &recording.project_id,
                recording.duration,
                recording.created_at.to_rfc3339(),
                recording.updated_at.to_rfc3339(),
                &recording.source_type,
                &recording.audio_path,
                &recording.status
            ],
        )?;
        Ok(())
    }

    pub fn update_recording_status(&mut self, recording_id: &str, status: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE recordings SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, Utc::now().to_rfc3339(), recording_id],
        )?;
        Ok(())
    }

    pub fn save_transcript(&mut self, transcript: &Transcript) -> Result<()> {
        let segments_json = serde_json::to_string(&transcript.segments)?;

        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM transcripts WHERE recording_id = ?1",
            params![&transcript.recording_id],
        )?;
        tx.execute(
            "INSERT INTO transcripts (id, recording_id, segments, full_text, language, confidence, model, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                &transcript.id,
                &transcript.recording_id,
                segments_json,
                &transcript.full_text,
                &transcript.language,
                transcript.confidence,
                &transcript.model,
                transcript.created_at.to_rfc3339()
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn update_transcript_segments(
        &mut self,
        recording_id: &str,
        segments: &[TranscriptSegment],
    ) -> Result<()> {
        let segments_json = serde_json::to_string(segments)?;
        self.conn.execute(
            "UPDATE transcripts SET segments = ?1 WHERE recording_id = ?2",
            params![segments_json, recording_id],
        )?;
        Ok(())
    }

    pub fn upsert_speaker_alias(
        &mut self,
        recording_id: &str,
        speaker_id: &str,
        name: Option<&str>,
        color: Option<&str>,
        sample_count: i64,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO speaker_aliases (recording_id, speaker_id, name, color, sample_count, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(recording_id, speaker_id) DO UPDATE SET
                name = excluded.name,
                color = COALESCE(excluded.color, speaker_aliases.color),
                sample_count = CASE
                    WHEN excluded.sample_count > 0 THEN excluded.sample_count
                    ELSE speaker_aliases.sample_count
                END,
                updated_at = excluded.updated_at",
            params![
                recording_id,
                speaker_id,
                name,
                color,
                sample_count,
                Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn get_speaker_aliases(
        &self,
        recording_id: &str,
    ) -> Result<HashMap<String, (Option<String>, Option<String>, i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT speaker_id, name, color, sample_count
             FROM speaker_aliases WHERE recording_id = ?1",
        )?;

        let rows = stmt.query_map(params![recording_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                ),
            ))
        })?;

        rows.collect::<Result<HashMap<_, _>, _>>()
            .map_err(|e| e.into())
    }

    /// Delete a recording and its associated transcript and speaker aliases
    pub fn delete_recording(&mut self, recording_id: &str) -> Result<String> {
        let audio_path: Option<String> = self
            .conn
            .query_row(
                "SELECT audio_path FROM recordings WHERE id = ?1",
                params![recording_id],
                |row| row.get(0),
            )
            .ok();

        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM speaker_aliases WHERE recording_id = ?1",
            params![recording_id],
        )?;
        tx.execute(
            "DELETE FROM transcripts WHERE recording_id = ?1",
            params![recording_id],
        )?;
        tx.execute(
            "DELETE FROM recordings WHERE id = ?1",
            params![recording_id],
        )?;
        tx.commit()?;

        Ok(audio_path.unwrap_or_default())
    }

    /// Rename a recording
    pub fn rename_recording(&mut self, recording_id: &str, new_title: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE recordings SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_title, Utc::now().to_rfc3339(), recording_id],
        )?;
        Ok(())
    }

    /// Delete a project, reassigning its recordings to the Inbox project
    pub fn delete_project(&mut self, project_id: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        // Reassign recordings to the default Inbox project
        tx.execute(
            "UPDATE recordings SET project_id = 'inbox', updated_at = ?1 WHERE project_id = ?2",
            params![Utc::now().to_rfc3339(), project_id],
        )?;
        tx.execute(
            "DELETE FROM projects WHERE id = ?1",
            params![project_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn get_audit_log(&self) -> Result<Vec<AuditLogEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, timestamp, event, details, severity 
             FROM audit_log ORDER BY timestamp DESC LIMIT 100",
        )?;

        let entries = stmt.query_map([], |row| {
            let details_json: String = row.get(3)?;
            let details: serde_json::Value =
                serde_json::from_str(&details_json).unwrap_or(serde_json::Value::Null);

            Ok(AuditLogEntry {
                id: row.get(0)?,
                timestamp: row
                    .get::<_, String>(1)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
                event: row.get(2)?,
                details,
                severity: row.get(4)?,
            })
        })?;

        entries.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
    }

    pub fn get_all_audit_log(&self) -> Result<Vec<AuditLogEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, timestamp, event, details, severity
             FROM audit_log ORDER BY timestamp ASC",
        )?;

        let entries = stmt.query_map([], |row| {
            let details_json: String = row.get(3)?;
            let details: serde_json::Value =
                serde_json::from_str(&details_json).unwrap_or(serde_json::Value::Null);

            Ok(AuditLogEntry {
                id: row.get(0)?,
                timestamp: row
                    .get::<_, String>(1)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
                event: row.get(2)?,
                details,
                severity: row.get(4)?,
            })
        })?;

        entries.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn in_memory_db() -> Database {
        let conn = Connection::open_in_memory().expect("in-memory db");
        let db = Database { conn };
        db.init_tables().expect("init tables");
        db
    }

    fn sample_project(_id: &str, name: &str) -> CreateProjectRequest {
        CreateProjectRequest {
            name: name.to_string(),
            description: Some("test".to_string()),
            parent_id: None,
        }
    }

    fn sample_recording(id: &str, project_id: &str) -> Recording {
        Recording {
            id: id.to_string(),
            title: format!("Recording {}", id),
            project_id: project_id.to_string(),
            duration: 60,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            source_type: "meeting".to_string(),
            audio_path: format!("/tmp/{}.wav", id),
            status: "recording".to_string(),
        }
    }

    fn sample_transcript(recording_id: &str) -> Transcript {
        Transcript {
            id: format!("t-{}", recording_id),
            recording_id: recording_id.to_string(),
            segments: vec![TranscriptSegment {
                id: "s1".to_string(),
                start_time: 0.0,
                end_time: 5.0,
                text: "Hello world".to_string(),
                speaker_id: Some("speaker_0".to_string()),
                confidence: 0.95,
            }],
            full_text: "Hello world".to_string(),
            language: "en".to_string(),
            confidence: 0.95,
            model: "whisper-base".to_string(),
            created_at: Utc::now(),
        }
    }

    #[test]
    fn test_default_inbox_project_exists() {
        let db = in_memory_db();
        let projects = db.get_projects().unwrap();
        assert!(projects.iter().any(|p| p.name == "Inbox"));
    }

    #[test]
    fn test_create_and_get_projects() {
        let mut db = in_memory_db();
        let req = sample_project("p1", "Alpha");
        let created = db.create_project(&req).unwrap();
        assert_eq!(created.name, "Alpha");

        let projects = db.get_projects().unwrap();
        assert!(projects.iter().any(|p| p.name == "Alpha"));
    }

    #[test]
    fn test_create_and_get_recording() {
        let mut db = in_memory_db();
        let rec = sample_recording("r1", "inbox");
        db.create_recording(&rec).unwrap();

        let fetched = db.get_recording("r1").unwrap();
        assert!(fetched.is_some());
        assert_eq!(fetched.unwrap().title, "Recording r1");
    }

    #[test]
    fn test_get_recordings_filtered_by_project() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox")).unwrap();
        db.create_recording(&sample_recording("r2", "other")).unwrap();

        let all = db.get_recordings(None).unwrap();
        assert_eq!(all.len(), 2);

        let inbox_only = db.get_recordings(Some("inbox")).unwrap();
        assert_eq!(inbox_only.len(), 1);
        assert_eq!(inbox_only[0].id, "r1");
    }

    #[test]
    fn test_update_recording_status() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox")).unwrap();
        db.update_recording_status("r1", "completed").unwrap();

        let rec = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(rec.status, "completed");
    }

    #[test]
    fn test_save_and_get_transcript() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox")).unwrap();

        let transcript = sample_transcript("r1");
        db.save_transcript(&transcript).unwrap();

        let fetched = db.get_transcript("r1").unwrap();
        assert!(fetched.is_some());
        let t = fetched.unwrap();
        assert_eq!(t.full_text, "Hello world");
        assert_eq!(t.segments.len(), 1);
    }

    #[test]
    fn test_rename_recording() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox")).unwrap();
        db.rename_recording("r1", "New Title").unwrap();

        let rec = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(rec.title, "New Title");
    }

    #[test]
    fn test_delete_recording_removes_transcript() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox")).unwrap();
        db.save_transcript(&sample_transcript("r1")).unwrap();

        let audio_path = db.delete_recording("r1").unwrap();
        assert_eq!(audio_path, "/tmp/r1.wav");

        assert!(db.get_recording("r1").unwrap().is_none());
        assert!(db.get_transcript("r1").unwrap().is_none());
    }

    #[test]
    fn test_delete_project_reassigns_recordings() {
        let mut db = in_memory_db();
        let proj = db.create_project(&sample_project("p1", "ToDelete")).unwrap();
        db.create_recording(&sample_recording("r1", &proj.id)).unwrap();

        db.delete_project(&proj.id).unwrap();

        // Recording should be reassigned to inbox
        let rec = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(rec.project_id, "inbox");

        // Project should be gone
        let projects = db.get_projects().unwrap();
        assert!(!projects.iter().any(|p| p.id == proj.id));
    }

    #[test]
    fn test_audit_log_append() {
        let mut db = in_memory_db();
        db.log_audit_event("test_event", Some(serde_json::json!({"key": "value"})), "info")
            .unwrap();

        let log = db.get_audit_log().unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].event, "test_event");
        assert_eq!(log[0].severity, "info");
    }

    #[test]
    fn test_audit_log_append_only_no_update() {
        let mut db = in_memory_db();
        db.log_audit_event("first", None, "info").unwrap();

        // Attempt to UPDATE the audit log should fail due to trigger
        let result = db.conn.execute(
            "UPDATE audit_log SET event = 'modified'",
            [],
        );
        assert!(result.is_err(), "Audit log should be append-only (no updates)");
    }

    #[test]
    fn test_audit_log_append_only_no_delete() {
        let mut db = in_memory_db();
        db.log_audit_event("first", None, "info").unwrap();

        // Attempt to DELETE from audit log should fail due to trigger
        let result = db.conn.execute("DELETE FROM audit_log", []);
        assert!(result.is_err(), "Audit log should be append-only (no deletes)");
    }

    #[test]
    fn test_speaker_alias_upsert() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox")).unwrap();

        db.upsert_speaker_alias("r1", "speaker_0", Some("Alice"), Some("#ff0000"), 100)
            .unwrap();

        let aliases = db.get_speaker_aliases("r1").unwrap();
        assert_eq!(aliases.len(), 1);
        let (name, color, count) = &aliases["speaker_0"];
        assert_eq!(name.as_deref(), Some("Alice"));
        assert_eq!(color.as_deref(), Some("#ff0000"));
        assert_eq!(*count, 100);

        // Upsert to rename
        db.upsert_speaker_alias("r1", "speaker_0", Some("Bob"), None, 0)
            .unwrap();
        let aliases2 = db.get_speaker_aliases("r1").unwrap();
        let (name2, color2, count2) = &aliases2["speaker_0"];
        assert_eq!(name2.as_deref(), Some("Bob"));
        assert_eq!(color2.as_deref(), Some("#ff0000")); // color preserved
        assert_eq!(*count2, 100); // count preserved when 0 passed
    }
}
