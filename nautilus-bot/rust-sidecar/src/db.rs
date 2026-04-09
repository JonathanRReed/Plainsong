//! Database operations using SQLite
//!
//! Manages recordings, transcripts, projects, and audit logs
//! with full CRUD operations.

#![allow(dead_code)]

use crate::models::*;
use crate::store::{
    CaptureSessionRecord, ContextSnapshotRecord, InsertionActionRecord, MeetingArtifactRecord,
    PolicySnapshotRecord, RuntimeEventRecord, TranscriptArtifactRecord,
};
use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{params, params_from_iter, types::Value, Connection};
use std::collections::HashMap;
use std::fs;

pub type SpeakerAlias = (Option<String>, Option<String>, i64);

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
    /// Run database integrity check
    fn run_integrity_check(&self) -> Result<()> {
        let result: String = self
            .conn
            .query_row("PRAGMA integrity_check;", [], |row| row.get(0))?;
        if result != "ok" {
            tracing::warn!("Database integrity check returned: {}", result);
        }
        Ok(())
    }

    /// Run database optimization (VACUUM)
    pub fn vacuum(&self) -> Result<()> {
        self.conn.execute("VACUUM;", [])?;
        tracing::info!("Database VACUUM completed successfully");
        Ok(())
    }

    /// Get database size in bytes
    pub fn size_bytes(&self) -> Result<u64> {
        let page_count: i64 = self
            .conn
            .query_row("PRAGMA page_count;", [], |row| row.get(0))?;
        let page_size: i64 = self
            .conn
            .query_row("PRAGMA page_size;", [], |row| row.get(0))?;
        Ok((page_count * page_size) as u64)
    }

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

    pub fn append_runtime_event(&mut self, entry: &RuntimeEventRecord) -> Result<()> {
        self.conn.execute(
            "INSERT INTO runtime_events (
                id, event_type, surface, session_id, recording_id, payload, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                &entry.id,
                &entry.event_type,
                &entry.surface,
                &entry.session_id,
                &entry.recording_id,
                entry.payload.to_string(),
                entry.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn list_runtime_events(&self, limit: usize) -> Result<Vec<RuntimeEventRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, event_type, surface, session_id, recording_id, payload, created_at
             FROM runtime_events
             ORDER BY created_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            let payload_json: String = row.get(5)?;
            let created_at: String = row.get(6)?;
            Ok(RuntimeEventRecord {
                id: row.get(0)?,
                event_type: row.get(1)?,
                surface: row.get(2)?,
                session_id: row.get(3)?,
                recording_id: row.get(4)?,
                payload: serde_json::from_str(&payload_json).unwrap_or(serde_json::json!({})),
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn save_capture_session(&mut self, session: &CaptureSessionRecord) -> Result<()> {
        self.conn.execute(
            "INSERT INTO capture_sessions (
                id, surface, state, started_at, stopped_at, audio_sources, target_app,
                context_snapshot_id, policy_snapshot_id, provider_plan_id, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                surface = excluded.surface,
                state = excluded.state,
                started_at = excluded.started_at,
                stopped_at = excluded.stopped_at,
                audio_sources = excluded.audio_sources,
                target_app = excluded.target_app,
                context_snapshot_id = excluded.context_snapshot_id,
                policy_snapshot_id = excluded.policy_snapshot_id,
                provider_plan_id = excluded.provider_plan_id,
                updated_at = excluded.updated_at",
            params![
                &session.id,
                &session.surface,
                &session.state,
                session.started_at.to_rfc3339(),
                session.stopped_at.map(|value| value.to_rfc3339()),
                serde_json::to_string(&session.audio_sources)?,
                &session.target_app,
                &session.context_snapshot_id,
                &session.policy_snapshot_id,
                &session.provider_plan_id,
                session.created_at.to_rfc3339(),
                session.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn get_capture_session(&self, session_id: &str) -> Result<Option<CaptureSessionRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, surface, state, started_at, stopped_at, audio_sources, target_app,
                    context_snapshot_id, policy_snapshot_id, provider_plan_id, created_at, updated_at
             FROM capture_sessions WHERE id = ?1",
        )?;
        let result = stmt.query_row([session_id], |row| {
            let audio_sources_json: String = row.get(5)?;
            let started_at: String = row.get(3)?;
            let stopped_at: Option<String> = row.get(4)?;
            let created_at: String = row.get(10)?;
            let updated_at: String = row.get(11)?;
            Ok(CaptureSessionRecord {
                id: row.get(0)?,
                surface: row.get(1)?,
                state: row.get(2)?,
                started_at: chrono::DateTime::parse_from_rfc3339(&started_at)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
                stopped_at: stopped_at.and_then(|value| {
                    chrono::DateTime::parse_from_rfc3339(&value)
                        .ok()
                        .map(|dt| dt.with_timezone(&Utc))
                }),
                audio_sources: serde_json::from_str(&audio_sources_json).unwrap_or_default(),
                target_app: row.get(6)?,
                context_snapshot_id: row.get(7)?,
                policy_snapshot_id: row.get(8)?,
                provider_plan_id: row.get(9)?,
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
                updated_at: chrono::DateTime::parse_from_rfc3339(&updated_at)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
            })
        });
        match result {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn save_context_snapshot(&mut self, snapshot: &ContextSnapshotRecord) -> Result<()> {
        self.conn.execute(
            "INSERT INTO context_snapshots (
                id, frontmost_app, frontmost_bundle_id, window_title, selected_text,
                clipboard_text, meeting_hint, active_mode, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                &snapshot.id,
                &snapshot.frontmost_app,
                &snapshot.frontmost_bundle_id,
                &snapshot.window_title,
                &snapshot.selected_text,
                &snapshot.clipboard_text,
                &snapshot.meeting_hint,
                &snapshot.active_mode,
                snapshot.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn get_context_snapshot(&self, snapshot_id: &str) -> Result<Option<ContextSnapshotRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, frontmost_app, frontmost_bundle_id, window_title, selected_text,
                    clipboard_text, meeting_hint, active_mode, created_at
             FROM context_snapshots WHERE id = ?1",
        )?;
        let result = stmt.query_row([snapshot_id], |row| {
            let created_at: String = row.get(8)?;
            Ok(ContextSnapshotRecord {
                id: row.get(0)?,
                frontmost_app: row.get(1)?,
                frontmost_bundle_id: row.get(2)?,
                window_title: row.get(3)?,
                selected_text: row.get(4)?,
                clipboard_text: row.get(5)?,
                meeting_hint: row.get(6)?,
                active_mode: row.get(7)?,
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
            })
        });
        match result {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn save_policy_snapshot(&mut self, snapshot: &PolicySnapshotRecord) -> Result<()> {
        self.conn.execute(
            "INSERT INTO policy_snapshots (
                id, retention_mode, storage_mode, provider_policy, ai_policy,
                insertion_policy, export_constraints, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                &snapshot.id,
                &snapshot.retention_mode,
                &snapshot.storage_mode,
                snapshot.provider_policy.to_string(),
                snapshot.ai_policy.to_string(),
                snapshot.insertion_policy.to_string(),
                snapshot.export_constraints.to_string(),
                snapshot.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn get_policy_snapshot(&self, snapshot_id: &str) -> Result<Option<PolicySnapshotRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, retention_mode, storage_mode, provider_policy, ai_policy,
                    insertion_policy, export_constraints, created_at
             FROM policy_snapshots WHERE id = ?1",
        )?;
        let result = stmt.query_row([snapshot_id], |row| {
            let provider_policy: String = row.get(3)?;
            let ai_policy: String = row.get(4)?;
            let insertion_policy: String = row.get(5)?;
            let export_constraints: String = row.get(6)?;
            let created_at: String = row.get(7)?;
            Ok(PolicySnapshotRecord {
                id: row.get(0)?,
                retention_mode: row.get(1)?,
                storage_mode: row.get(2)?,
                provider_policy: serde_json::from_str(&provider_policy)
                    .unwrap_or(serde_json::json!({})),
                ai_policy: serde_json::from_str(&ai_policy).unwrap_or(serde_json::json!({})),
                insertion_policy: serde_json::from_str(&insertion_policy)
                    .unwrap_or(serde_json::json!({})),
                export_constraints: serde_json::from_str(&export_constraints)
                    .unwrap_or(serde_json::json!({})),
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
            })
        });
        match result {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn save_transcript_artifact(&mut self, artifact: &TranscriptArtifactRecord) -> Result<()> {
        self.conn.execute(
            "INSERT INTO transcript_artifacts (
                id, recording_id, transcript_id, segment_count, model_id, requested_provider,
                actual_provider, quality_score, startup_latency_ms, transcription_latency_ms,
                insert_latency_ms, end_to_end_ms, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                &artifact.id,
                &artifact.recording_id,
                &artifact.transcript_id,
                artifact.segment_count,
                &artifact.model_id,
                &artifact.requested_provider,
                &artifact.actual_provider,
                artifact.quality_score,
                artifact.startup_latency_ms,
                artifact.transcription_latency_ms,
                artifact.insert_latency_ms,
                artifact.end_to_end_ms,
                artifact.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn get_latest_transcript_artifact(
        &self,
        recording_id: &str,
    ) -> Result<Option<TranscriptArtifactRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, recording_id, transcript_id, segment_count, model_id, requested_provider,
                    actual_provider, quality_score, startup_latency_ms, transcription_latency_ms,
                    insert_latency_ms, end_to_end_ms, created_at
             FROM transcript_artifacts
             WHERE recording_id = ?1
             ORDER BY created_at DESC
             LIMIT 1",
        )?;
        let result = stmt.query_row([recording_id], |row| {
            let created_at: String = row.get(12)?;
            Ok(TranscriptArtifactRecord {
                id: row.get(0)?,
                recording_id: row.get(1)?,
                transcript_id: row.get(2)?,
                segment_count: row.get(3)?,
                model_id: row.get(4)?,
                requested_provider: row.get(5)?,
                actual_provider: row.get(6)?,
                quality_score: row.get(7)?,
                startup_latency_ms: row.get(8)?,
                transcription_latency_ms: row.get(9)?,
                insert_latency_ms: row.get(10)?,
                end_to_end_ms: row.get(11)?,
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
            })
        });
        match result {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn save_insertion_action(&mut self, action: &InsertionActionRecord) -> Result<()> {
        self.conn.execute(
            "INSERT INTO insertion_actions (
                id, session_id, recording_id, requested_mode, actual_mode, pasted, copied,
                failed, undo_token, command_applied, snippet_applied_count, app_target, error,
                created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                &action.id,
                &action.session_id,
                &action.recording_id,
                &action.requested_mode,
                &action.actual_mode,
                if action.pasted { 1 } else { 0 },
                if action.copied { 1 } else { 0 },
                if action.failed { 1 } else { 0 },
                &action.undo_token,
                &action.command_applied,
                action.snippet_applied_count,
                &action.app_target,
                &action.error,
                action.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn get_latest_insertion_action(
        &self,
        recording_id: &str,
    ) -> Result<Option<InsertionActionRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, recording_id, requested_mode, actual_mode, pasted, copied,
                    failed, undo_token, command_applied, snippet_applied_count, app_target,
                    error, created_at
             FROM insertion_actions
             WHERE recording_id = ?1
             ORDER BY created_at DESC
             LIMIT 1",
        )?;
        let result = stmt.query_row([recording_id], |row| {
            let created_at: String = row.get(13)?;
            Ok(InsertionActionRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                recording_id: row.get(2)?,
                requested_mode: row.get(3)?,
                actual_mode: row.get(4)?,
                pasted: row.get::<_, i64>(5)? != 0,
                copied: row.get::<_, i64>(6)? != 0,
                failed: row.get::<_, i64>(7)? != 0,
                undo_token: row.get(8)?,
                command_applied: row.get(9)?,
                snippet_applied_count: row.get(10)?,
                app_target: row.get(11)?,
                error: row.get(12)?,
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
            })
        });
        match result {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn save_meeting_artifact(&mut self, artifact: &MeetingArtifactRecord) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meeting_artifacts (
                id, recording_id, title, summary, action_items, decisions, deadlines,
                template_id, chat_messages, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(recording_id) DO UPDATE SET
                title = excluded.title,
                summary = excluded.summary,
                action_items = excluded.action_items,
                decisions = excluded.decisions,
                deadlines = excluded.deadlines,
                template_id = excluded.template_id,
                chat_messages = excluded.chat_messages,
                updated_at = excluded.updated_at",
            params![
                &artifact.id,
                &artifact.recording_id,
                &artifact.title,
                &artifact.summary,
                serde_json::to_string(&artifact.action_items)?,
                serde_json::to_string(&artifact.decisions)?,
                serde_json::to_string(&artifact.deadlines)?,
                &artifact.template_id,
                serde_json::to_string(&artifact.chat_messages)?,
                artifact.created_at.to_rfc3339(),
                artifact.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn get_meeting_artifact(
        &self,
        recording_id: &str,
    ) -> Result<Option<MeetingArtifactRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, recording_id, title, summary, action_items, decisions, deadlines,
                    template_id, chat_messages, created_at, updated_at
             FROM meeting_artifacts
             WHERE recording_id = ?1",
        )?;
        let result = stmt.query_row([recording_id], |row| {
            let action_items_json: String = row.get(4)?;
            let decisions_json: String = row.get(5)?;
            let deadlines_json: String = row.get(6)?;
            let chat_messages_json: String = row.get(8)?;
            let created_at: String = row.get(9)?;
            let updated_at: String = row.get(10)?;
            Ok(MeetingArtifactRecord {
                id: row.get(0)?,
                recording_id: row.get(1)?,
                title: row.get(2)?,
                summary: row.get(3)?,
                action_items: serde_json::from_str(&action_items_json).unwrap_or_default(),
                decisions: serde_json::from_str(&decisions_json).unwrap_or_default(),
                deadlines: serde_json::from_str(&deadlines_json).unwrap_or_default(),
                template_id: row.get(7)?,
                chat_messages: serde_json::from_str(&chat_messages_json).unwrap_or_default(),
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
                updated_at: chrono::DateTime::parse_from_rfc3339(&updated_at)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
            })
        });
        match result {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.into()),
        }
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
                status TEXT NOT NULL DEFAULT 'recording',
                meeting_notes TEXT,
                meeting_template_id TEXT,
                meeting_capture_mode TEXT,
                notes_updated_at TEXT,
                consent_prompt_shown INTEGER NOT NULL DEFAULT 0,
                consent_notice_mode TEXT,
                consent_notice_surface TEXT,
                consent_notice_message TEXT,
                consent_notice_updated_at TEXT
            )",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_recordings_project_created_at
             ON recordings(project_id, created_at DESC)",
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
                model_id TEXT,
                requested_provider TEXT,
                actual_provider TEXT,
                created_at TEXT NOT NULL
            )",
            [],
        )?;

        // Backward-compatible migrations for existing local DBs.
        let _ = self
            .conn
            .execute("ALTER TABLE transcripts ADD COLUMN model_id TEXT", []);
        let _ = self.conn.execute(
            "ALTER TABLE transcripts ADD COLUMN requested_provider TEXT",
            [],
        );
        let _ = self.conn.execute(
            "ALTER TABLE transcripts ADD COLUMN actual_provider TEXT",
            [],
        );
        self.migrate_transcripts_drop_fallback_columns()?;

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
            "CREATE TABLE IF NOT EXISTS runtime_events (
                id TEXT PRIMARY KEY,
                event_type TEXT NOT NULL,
                surface TEXT,
                session_id TEXT,
                recording_id TEXT,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL
            )",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_runtime_events_created_at
             ON runtime_events(created_at DESC)",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_runtime_events_session
             ON runtime_events(session_id, created_at DESC)",
            [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS capture_sessions (
                id TEXT PRIMARY KEY,
                surface TEXT NOT NULL,
                state TEXT NOT NULL,
                started_at TEXT NOT NULL,
                stopped_at TEXT,
                audio_sources TEXT NOT NULL,
                target_app TEXT,
                context_snapshot_id TEXT,
                policy_snapshot_id TEXT,
                provider_plan_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS context_snapshots (
                id TEXT PRIMARY KEY,
                frontmost_app TEXT,
                frontmost_bundle_id TEXT,
                window_title TEXT,
                selected_text TEXT,
                clipboard_text TEXT,
                meeting_hint TEXT,
                active_mode TEXT,
                created_at TEXT NOT NULL
            )",
            [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS transcript_artifacts (
                id TEXT PRIMARY KEY,
                recording_id TEXT NOT NULL,
                transcript_id TEXT,
                segment_count INTEGER NOT NULL DEFAULT 0,
                model_id TEXT,
                requested_provider TEXT,
                actual_provider TEXT,
                quality_score REAL,
                startup_latency_ms INTEGER,
                transcription_latency_ms INTEGER,
                insert_latency_ms INTEGER,
                end_to_end_ms INTEGER,
                created_at TEXT NOT NULL
            )",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_transcript_artifacts_recording_created_at
             ON transcript_artifacts(recording_id, created_at DESC)",
            [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS insertion_actions (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                recording_id TEXT,
                requested_mode TEXT NOT NULL,
                actual_mode TEXT NOT NULL,
                pasted INTEGER NOT NULL DEFAULT 0,
                copied INTEGER NOT NULL DEFAULT 0,
                failed INTEGER NOT NULL DEFAULT 0,
                undo_token TEXT,
                command_applied TEXT,
                snippet_applied_count INTEGER NOT NULL DEFAULT 0,
                app_target TEXT,
                error TEXT,
                created_at TEXT NOT NULL
            )",
            [],
        )?;
        let _ = self.conn.execute(
            "ALTER TABLE insertion_actions ADD COLUMN app_target TEXT",
            [],
        );
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_insertion_actions_recording_created_at
             ON insertion_actions(recording_id, created_at DESC)",
            [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS meeting_artifacts (
                id TEXT PRIMARY KEY,
                recording_id TEXT NOT NULL UNIQUE,
                title TEXT,
                summary TEXT,
                action_items TEXT NOT NULL,
                decisions TEXT NOT NULL,
                deadlines TEXT NOT NULL,
                template_id TEXT,
                chat_messages TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;
        let _ = self.conn.execute(
            "ALTER TABLE meeting_artifacts ADD COLUMN chat_messages TEXT NOT NULL DEFAULT '[]'",
            [],
        );
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_meeting_artifacts_updated_at
             ON meeting_artifacts(updated_at DESC)",
            [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS policy_snapshots (
                id TEXT PRIMARY KEY,
                retention_mode TEXT NOT NULL,
                storage_mode TEXT NOT NULL,
                provider_policy TEXT NOT NULL,
                ai_policy TEXT NOT NULL,
                insertion_policy TEXT NOT NULL,
                export_constraints TEXT NOT NULL,
                created_at TEXT NOT NULL
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
            "CREATE TABLE IF NOT EXISTS asr_benchmarks (
                id TEXT PRIMARY KEY,
                provider_type TEXT NOT NULL,
                provider_name TEXT NOT NULL,
                model_id TEXT NOT NULL,
                runtime_status TEXT NOT NULL,
                non_empty_transcript INTEGER NOT NULL DEFAULT 0,
                processing_time_ms INTEGER NOT NULL,
                confidence REAL NOT NULL,
                created_at TEXT NOT NULL
            )",
            [],
        )?;
        let _ = self.conn.execute(
            "ALTER TABLE asr_benchmarks ADD COLUMN non_empty_transcript INTEGER NOT NULL DEFAULT 0",
            [],
        );

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS dictation_dictionary_entries (
                id TEXT PRIMARY KEY,
                spoken_form TEXT NOT NULL,
                replacement TEXT NOT NULL,
                app_scope TEXT,
                case_sensitive INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_dictation_dictionary_entries_spoken_form
             ON dictation_dictionary_entries(spoken_form)",
            [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS dictation_snippets (
                id TEXT PRIMARY KEY,
                trigger TEXT NOT NULL,
                expansion TEXT NOT NULL,
                app_scope TEXT,
                case_sensitive INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_dictation_snippets_trigger
             ON dictation_snippets(trigger)",
            [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS dictation_command_presets (
                id TEXT PRIMARY KEY,
                command_key TEXT NOT NULL UNIQUE,
                system_prompt TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS dictation_correction_suggestions (
                id TEXT PRIMARY KEY,
                original_text TEXT NOT NULL,
                corrected_text TEXT NOT NULL,
                spoken_form TEXT NOT NULL,
                replacement TEXT NOT NULL,
                app_target TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_dictation_correction_suggestions_spoken_form
             ON dictation_correction_suggestions(spoken_form)",
            [],
        )?;

        // Use FTS5 for cross-recording transcript retrieval.
        let fts_ready = self
            .conn
            .execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
                    recording_id UNINDEXED,
                    segment_id UNINDEXED,
                    text,
                    start_time UNINDEXED,
                    end_time UNINDEXED
                )",
                [],
            )
            .is_ok();

        if fts_ready {
            if let Err(error) = self.backfill_transcript_fts_if_needed() {
                tracing::warn!(
                    "Failed to run transcript_fts startup backfill check: {}",
                    error
                );
            }
        } else {
            tracing::warn!(
                "transcript_fts table unavailable; cross-recording search will be limited"
            );
        }

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS transcript_embeddings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recording_id TEXT NOT NULL,
                segment_id TEXT NOT NULL,
                text TEXT NOT NULL,
                embedding BLOB NOT NULL,
                model TEXT NOT NULL,
                start_time REAL,
                end_time REAL,
                created_at TEXT NOT NULL
            )",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_embeddings_recording ON transcript_embeddings(recording_id)",
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
        self.conn.execute(
            "INSERT OR IGNORE INTO projects (id, name, description, created_at, updated_at) 
             VALUES ('inbox', 'Inbox', 'Default inbox for new recordings', ?1, ?1)",
            [Utc::now().to_rfc3339()],
        )?;

        // Add summary and action_items columns to recordings table
        let _ = self
            .conn
            .execute("ALTER TABLE recordings ADD COLUMN summary TEXT", []);
        let _ = self
            .conn
            .execute("ALTER TABLE recordings ADD COLUMN action_items TEXT", []);
        let _ = self
            .conn
            .execute("ALTER TABLE recordings ADD COLUMN meeting_notes TEXT", []);
        let _ = self.conn.execute(
            "ALTER TABLE recordings ADD COLUMN meeting_template_id TEXT",
            [],
        );
        let _ = self.conn.execute(
            "ALTER TABLE recordings ADD COLUMN notes_updated_at TEXT",
            [],
        );
        let _ = self.conn.execute(
            "ALTER TABLE recordings ADD COLUMN meeting_capture_mode TEXT",
            [],
        );
        let _ = self.conn.execute(
            "ALTER TABLE recordings ADD COLUMN consent_prompt_shown INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = self.conn.execute(
            "ALTER TABLE recordings ADD COLUMN consent_notice_mode TEXT",
            [],
        );
        let _ = self.conn.execute(
            "ALTER TABLE recordings ADD COLUMN consent_notice_surface TEXT",
            [],
        );
        let _ = self.conn.execute(
            "ALTER TABLE recordings ADD COLUMN consent_notice_message TEXT",
            [],
        );
        let _ = self.conn.execute(
            "ALTER TABLE recordings ADD COLUMN consent_notice_updated_at TEXT",
            [],
        );

        Ok(())
    }

    fn transcripts_has_column(&self, column_name: &str) -> Result<bool> {
        let mut stmt = self.conn.prepare("PRAGMA table_info(transcripts)")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let name: String = row.get(1)?;
            if name == column_name {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn migrate_transcripts_drop_fallback_columns(&self) -> Result<()> {
        let has_fallback_used = self.transcripts_has_column("fallback_used")?;
        let has_fallback_reason = self.transcripts_has_column("fallback_reason")?;
        if !has_fallback_used && !has_fallback_reason {
            return Ok(());
        }

        self.conn.execute_batch(
            "BEGIN IMMEDIATE;
             ALTER TABLE transcripts RENAME TO transcripts_legacy_fallback;
             CREATE TABLE transcripts (
                id TEXT PRIMARY KEY,
                recording_id TEXT NOT NULL,
                segments TEXT,
                full_text TEXT,
                language TEXT,
                confidence REAL,
                model TEXT,
                model_id TEXT,
                requested_provider TEXT,
                actual_provider TEXT,
                created_at TEXT NOT NULL
             );
             INSERT INTO transcripts (
                id,
                recording_id,
                segments,
                full_text,
                language,
                confidence,
                model,
                model_id,
                requested_provider,
                actual_provider,
                created_at
             )
             SELECT
                id,
                recording_id,
                segments,
                full_text,
                language,
                confidence,
                model,
                model_id,
                requested_provider,
                actual_provider,
                created_at
             FROM transcripts_legacy_fallback;
             DROP TABLE transcripts_legacy_fallback;
             COMMIT;",
        )?;
        Ok(())
    }

    fn backfill_transcript_fts_if_needed(&self) -> Result<()> {
        let fts_row_count: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM transcript_fts", [], |row| row.get(0))?;
        if fts_row_count > 0 {
            return Ok(());
        }

        let transcript_row_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM transcripts WHERE json_valid(segments)",
            [],
            |row| row.get(0),
        )?;
        if transcript_row_count == 0 {
            return Ok(());
        }

        #[cfg(debug_assertions)]
        let start = std::time::Instant::now();

        let _inserted_rows = self.conn.execute(
            "INSERT INTO transcript_fts (recording_id, segment_id, text, start_time, end_time)
             SELECT
                t.recording_id,
                COALESCE(json_extract(seg.value, '$.id'), ''),
                COALESCE(json_extract(seg.value, '$.text'), ''),
                COALESCE(json_extract(seg.value, '$.startTime'), 0),
                COALESCE(json_extract(seg.value, '$.endTime'), 0)
             FROM transcripts t
             JOIN json_each(t.segments) AS seg
             WHERE json_valid(t.segments)",
            [],
        )?;

        #[cfg(debug_assertions)]
        tracing::debug!(
            "Backfilled transcript_fts with {} rows in {:?}",
            _inserted_rows,
            start.elapsed()
        );

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
                created_at: row.get::<_, String>(4)?.parse().unwrap_or_else(|e| {
                    tracing::warn!("Project created_at parse error: {}", e);
                    Utc::now()
                }),
                updated_at: row.get::<_, String>(5)?.parse().unwrap_or_else(|e| {
                    tracing::warn!("Project updated_at parse error: {}", e);
                    Utc::now()
                }),
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
            "SELECT recordings.id,
                    COALESCE(meeting_artifacts.title, recordings.title),
                    recordings.project_id,
                    recordings.duration,
                    recordings.created_at,
                    recordings.updated_at,
                    recordings.source_type,
                    recordings.audio_path,
                    recordings.status,
                    COALESCE(meeting_artifacts.summary, recordings.summary),
                    COALESCE(meeting_artifacts.action_items, recordings.action_items),
                    recordings.meeting_notes,
                    COALESCE(meeting_artifacts.template_id, recordings.meeting_template_id),
                    recordings.meeting_capture_mode,
                    recordings.notes_updated_at,
                    recordings.consent_prompt_shown,
                    recordings.consent_notice_mode,
                    recordings.consent_notice_surface,
                    recordings.consent_notice_message,
                    recordings.consent_notice_updated_at
             FROM recordings
             LEFT JOIN meeting_artifacts ON meeting_artifacts.recording_id = recordings.id
             WHERE (?1 IS NULL OR recordings.project_id = ?1)
             ORDER BY recordings.created_at DESC",
        )?;

        let pid_param: Option<&str> = project_id;

        let recordings = stmt.query_map(params![pid_param], |row| {
            let action_items_json: Option<String> = row.get(10)?;
            let action_items = action_items_json.and_then(|s| serde_json::from_str(&s).ok());
            let notes_updated_at = row
                .get::<_, Option<String>>(14)?
                .and_then(|value| value.parse().ok());
            let consent_notice_updated_at = row
                .get::<_, Option<String>>(19)?
                .and_then(|value| value.parse().ok());
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
                summary: row.get(9)?,
                action_items,
                meeting_notes: row.get(11)?,
                meeting_template_id: row.get(12)?,
                meeting_capture_mode: row.get(13)?,
                notes_updated_at,
                consent_prompt_shown: row.get::<_, i64>(15).unwrap_or(0) != 0,
                consent_notice_mode: row.get(16)?,
                consent_notice_surface: row.get(17)?,
                consent_notice_message: row.get(18)?,
                consent_notice_updated_at,
            })
        })?;

        recordings
            .collect::<Result<Vec<_>, rusqlite::Error>>()
            .map_err(|e| e.into())
    }

    pub fn get_recording(&self, recording_id: &str) -> Result<Option<Recording>> {
        let mut stmt = self.conn.prepare(
            "SELECT recordings.id,
                    COALESCE(meeting_artifacts.title, recordings.title),
                    recordings.project_id,
                    recordings.duration,
                    recordings.created_at,
                    recordings.updated_at,
                    recordings.source_type,
                    recordings.audio_path,
                    recordings.status,
                    COALESCE(meeting_artifacts.summary, recordings.summary),
                    COALESCE(meeting_artifacts.action_items, recordings.action_items),
                    recordings.meeting_notes,
                    COALESCE(meeting_artifacts.template_id, recordings.meeting_template_id),
                    recordings.meeting_capture_mode,
                    recordings.notes_updated_at,
                    recordings.consent_prompt_shown,
                    recordings.consent_notice_mode,
                    recordings.consent_notice_surface,
                    recordings.consent_notice_message,
                    recordings.consent_notice_updated_at
             FROM recordings
             LEFT JOIN meeting_artifacts ON meeting_artifacts.recording_id = recordings.id
             WHERE recordings.id = ?1",
        )?;

        let result = stmt.query_row([recording_id], |row| {
            let action_items_json: Option<String> = row.get(10)?;
            let action_items = action_items_json.and_then(|s| serde_json::from_str(&s).ok());
            let notes_updated_at = row
                .get::<_, Option<String>>(14)?
                .and_then(|value| value.parse().ok());
            let consent_notice_updated_at = row
                .get::<_, Option<String>>(19)?
                .and_then(|value| value.parse().ok());
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
                summary: row.get(9)?,
                action_items,
                meeting_notes: row.get(11)?,
                meeting_template_id: row.get(12)?,
                meeting_capture_mode: row.get(13)?,
                notes_updated_at,
                consent_prompt_shown: row.get::<_, i64>(15).unwrap_or(0) != 0,
                consent_notice_mode: row.get(16)?,
                consent_notice_surface: row.get(17)?,
                consent_notice_message: row.get(18)?,
                consent_notice_updated_at,
            })
        });

        match result {
            Ok(recording) => Ok(Some(recording)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn update_recording_path(
        &mut self,
        recording_id: &str,
        audio_path: &str,
        duration_seconds: i64,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE recordings SET audio_path = ?1, duration = ?2, updated_at = ?3 WHERE id = ?4",
            params![
                audio_path,
                duration_seconds,
                Utc::now().to_rfc3339(),
                recording_id
            ],
        )?;
        Ok(())
    }

    pub fn clear_recording_audio_path(&mut self, recording_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE recordings SET audio_path = '', updated_at = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), recording_id],
        )?;
        Ok(())
    }

    pub fn get_transcript(&self, recording_id: &str) -> Result<Option<Transcript>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, recording_id, segments, full_text, language, confidence, model, model_id, requested_provider, actual_provider, created_at
             FROM transcripts WHERE recording_id = ?1",
        )?;

        let result = stmt.query_row([recording_id], |row| {
            let segments_json: String = row.get(2)?;
            let mut segments: Vec<TranscriptSegment> =
                serde_json::from_str(&segments_json).unwrap_or_default();
            let full_text: String = row.get(3)?;

            if segments.is_empty() && !full_text.trim().is_empty() {
                let duration_seconds: i64 = self
                    .conn
                    .query_row(
                        "SELECT duration FROM recordings WHERE id = ?1",
                        [recording_id],
                        |duration_row| duration_row.get(0),
                    )
                    .unwrap_or(0);
                segments.push(TranscriptSegment {
                    id: format!("{}-full-text", recording_id),
                    start_time: 0.0,
                    end_time: duration_seconds.max(0) as f64,
                    text: full_text.clone(),
                    speaker_id: None,
                    confidence: row.get::<_, f64>(5).unwrap_or(0.0),
                });
            }

            Ok(Transcript {
                id: row.get(0)?,
                recording_id: row.get(1)?,
                segments,
                full_text,
                language: row.get(4)?,
                confidence: row.get(5)?,
                model: row.get(6)?,
                model_id: row.get(7)?,
                requested_provider: row.get(8)?,
                actual_provider: row.get(9)?,
                created_at: row
                    .get::<_, String>(10)?
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
            "INSERT INTO recordings (
                id, title, project_id, duration, created_at, updated_at, source_type, audio_path, status,
                meeting_notes, meeting_template_id, meeting_capture_mode, notes_updated_at,
                consent_prompt_shown, consent_notice_mode, consent_notice_surface,
                consent_notice_message, consent_notice_updated_at
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![
                &recording.id,
                &recording.title,
                &recording.project_id,
                recording.duration,
                recording.created_at.to_rfc3339(),
                recording.updated_at.to_rfc3339(),
                &recording.source_type,
                &recording.audio_path,
                &recording.status,
                &recording.meeting_notes,
                &recording.meeting_template_id,
                &recording.meeting_capture_mode,
                recording
                    .notes_updated_at
                    .as_ref()
                    .map(|value| value.to_rfc3339()),
                if recording.consent_prompt_shown { 1 } else { 0 },
                &recording.consent_notice_mode,
                &recording.consent_notice_surface,
                &recording.consent_notice_message,
                recording
                    .consent_notice_updated_at
                    .as_ref()
                    .map(|value| value.to_rfc3339())
            ],
        )?;
        Ok(())
    }

    pub fn update_recording_consent_state(
        &mut self,
        recording_id: &str,
        consent_prompt_shown: bool,
        consent_notice_mode: Option<&str>,
        consent_notice_surface: Option<&str>,
        consent_notice_message: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now();
        self.conn.execute(
            "UPDATE recordings
             SET consent_prompt_shown = ?1,
                 consent_notice_mode = ?2,
                 consent_notice_surface = ?3,
                 consent_notice_message = ?4,
                 consent_notice_updated_at = ?5,
                 updated_at = ?5
             WHERE id = ?6",
            params![
                if consent_prompt_shown { 1 } else { 0 },
                consent_notice_mode,
                consent_notice_surface,
                consent_notice_message,
                now.to_rfc3339(),
                recording_id
            ],
        )?;
        Ok(())
    }

    pub fn update_recording_notes(
        &mut self,
        recording_id: &str,
        meeting_notes: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now();
        self.conn.execute(
            "UPDATE recordings
             SET meeting_notes = ?1, notes_updated_at = ?2, updated_at = ?2
             WHERE id = ?3",
            params![meeting_notes, now.to_rfc3339(), recording_id],
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

    pub fn update_recording_duration(
        &mut self,
        recording_id: &str,
        duration_seconds: i64,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE recordings SET duration = ?1, updated_at = ?2 WHERE id = ?3",
            params![duration_seconds, Utc::now().to_rfc3339(), recording_id],
        )?;
        Ok(())
    }

    pub fn update_recording_analysis(
        &mut self,
        recording_id: &str,
        summary: Option<&str>,
        action_items: &[String],
    ) -> Result<()> {
        let now = Utc::now();
        let action_items_json = serde_json::to_string(action_items)?;
        self.conn.execute(
            "UPDATE recordings SET summary = ?1, action_items = ?2, updated_at = ?3 WHERE id = ?4",
            params![summary, action_items_json, now.to_rfc3339(), recording_id],
        )?;

        let recording = self
            .get_recording(recording_id)?
            .ok_or_else(|| anyhow::anyhow!("Recording not found: {}", recording_id))?;
        let mut artifact =
            self.get_meeting_artifact(recording_id)?
                .unwrap_or(MeetingArtifactRecord {
                    id: uuid::Uuid::new_v4().to_string(),
                    recording_id: recording_id.to_string(),
                    title: Some(recording.title.clone()),
                    summary: None,
                    action_items: Vec::new(),
                    decisions: Vec::new(),
                    deadlines: Vec::new(),
                    template_id: recording.meeting_template_id.clone(),
                    chat_messages: Vec::new(),
                    created_at: now,
                    updated_at: now,
                });
        artifact.title = artifact.title.or(Some(recording.title));
        artifact.summary = summary.map(|value| value.to_string());
        artifact.action_items = action_items.to_vec();
        artifact.template_id = recording.meeting_template_id;
        artifact.updated_at = now;
        self.save_meeting_artifact(&artifact)?;
        Ok(())
    }

    pub fn update_recording_meeting_template(
        &mut self,
        recording_id: &str,
        meeting_template_id: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now();
        self.conn.execute(
            "UPDATE recordings
             SET meeting_template_id = ?1, updated_at = ?2
             WHERE id = ?3",
            params![meeting_template_id, now.to_rfc3339(), recording_id],
        )?;

        if let Some(mut artifact) = self.get_meeting_artifact(recording_id)? {
            artifact.template_id = meeting_template_id.map(|value| value.to_string());
            artifact.updated_at = now;
            self.save_meeting_artifact(&artifact)?;
        }

        Ok(())
    }

    pub fn update_recording_meeting_chat(
        &mut self,
        recording_id: &str,
        messages: &[crate::store::MeetingChatMessageRecord],
    ) -> Result<()> {
        let now = Utc::now();
        let recording = self
            .get_recording(recording_id)?
            .ok_or_else(|| anyhow::anyhow!("Recording not found: {}", recording_id))?;
        let mut artifact =
            self.get_meeting_artifact(recording_id)?
                .unwrap_or(MeetingArtifactRecord {
                    id: uuid::Uuid::new_v4().to_string(),
                    recording_id: recording_id.to_string(),
                    title: Some(recording.title.clone()),
                    summary: recording.summary,
                    action_items: recording.action_items.unwrap_or_default(),
                    decisions: Vec::new(),
                    deadlines: Vec::new(),
                    template_id: recording.meeting_template_id,
                    chat_messages: Vec::new(),
                    created_at: now,
                    updated_at: now,
                });
        artifact.chat_messages = messages.to_vec();
        artifact.updated_at = now;
        self.save_meeting_artifact(&artifact)?;
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
            "INSERT INTO transcripts (id, recording_id, segments, full_text, language, confidence, model, model_id, requested_provider, actual_provider, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                &transcript.id,
                &transcript.recording_id,
                segments_json,
                &transcript.full_text,
                &transcript.language,
                transcript.confidence,
                &transcript.model,
                &transcript.model_id,
                &transcript.requested_provider,
                &transcript.actual_provider,
                transcript.created_at.to_rfc3339()
            ],
        )?;

        let _ = tx.execute(
            "DELETE FROM transcript_fts WHERE recording_id = ?1",
            params![&transcript.recording_id],
        );
        for segment in &transcript.segments {
            let _ = tx.execute(
                "INSERT INTO transcript_fts (recording_id, segment_id, text, start_time, end_time)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    &transcript.recording_id,
                    &segment.id,
                    &segment.text,
                    segment.start_time,
                    segment.end_time
                ],
            );
        }
        tx.commit()?;
        Ok(())
    }

    /// Update the text of a single transcript segment (stored as JSON in transcripts.segments)
    pub fn update_transcript_segment(
        &mut self,
        recording_id: &str,
        segment_id: &str,
        new_text: &str,
    ) -> Result<bool> {
        let Some(mut transcript) = self.get_transcript(recording_id)? else {
            return Ok(false);
        };

        let mut found = false;
        for seg in &mut transcript.segments {
            if seg.id == segment_id {
                seg.text = new_text.to_string();
                found = true;
                break;
            }
        }

        if !found {
            return Ok(false);
        }

        // Rebuild full_text from updated segments
        transcript.full_text = transcript
            .segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");

        let segments_json = serde_json::to_string(&transcript.segments)?;
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE transcripts SET segments = ?1, full_text = ?2 WHERE recording_id = ?3",
            params![segments_json, transcript.full_text, recording_id],
        )?;
        // Update FTS
        let _ = tx.execute(
            "UPDATE transcript_fts SET text = ?1 WHERE recording_id = ?2 AND segment_id = ?3",
            params![new_text, recording_id, segment_id],
        );
        tx.commit()?;
        Ok(true)
    }

    pub fn delete_transcript_segments(
        &mut self,
        recording_id: &str,
        segment_ids: &[String],
    ) -> Result<usize> {
        let Some(mut transcript) = self.get_transcript(recording_id)? else {
            return Ok(0);
        };

        if segment_ids.is_empty() {
            return Ok(0);
        }

        let original_len = transcript.segments.len();
        transcript.segments.retain(|segment| {
            !segment_ids
                .iter()
                .any(|segment_id| segment_id == &segment.id)
        });
        let removed = original_len.saturating_sub(transcript.segments.len());
        if removed == 0 {
            return Ok(0);
        }

        transcript.full_text = transcript
            .segments
            .iter()
            .map(|segment| segment.text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ");

        let segments_json = serde_json::to_string(&transcript.segments)?;
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE transcripts SET segments = ?1, full_text = ?2 WHERE recording_id = ?3",
            params![segments_json, transcript.full_text, recording_id],
        )?;
        {
            let mut delete_stmt = tx.prepare(
                "DELETE FROM transcript_fts WHERE recording_id = ?1 AND segment_id = ?2",
            )?;
            for segment_id in segment_ids {
                let _ = delete_stmt.execute(params![recording_id, segment_id]);
            }
        }
        tx.commit()?;
        Ok(removed)
    }

    pub fn save_asr_benchmark(&mut self, entry: &AsrBenchmarkEntry) -> Result<()> {
        self.conn.execute(
            "INSERT INTO asr_benchmarks (
                id, provider_type, provider_name, model_id, runtime_status, non_empty_transcript, processing_time_ms, confidence, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                &entry.id,
                &entry.provider_type,
                &entry.provider_name,
                &entry.model_id,
                &entry.runtime_status,
                if entry.non_empty_transcript { 1 } else { 0 },
                entry.processing_time_ms,
                entry.confidence,
                entry.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn list_asr_benchmarks(&self, limit: usize) -> Result<Vec<AsrBenchmarkEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, provider_type, provider_name, model_id, runtime_status, non_empty_transcript, processing_time_ms, confidence, created_at
             FROM asr_benchmarks
             ORDER BY created_at DESC
             LIMIT ?1",
        )?;

        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok(AsrBenchmarkEntry {
                id: row.get(0)?,
                provider_type: row.get(1)?,
                provider_name: row.get(2)?,
                model_id: row.get(3)?,
                runtime_status: row.get(4)?,
                non_empty_transcript: row.get::<_, i64>(5)? != 0,
                processing_time_ms: row.get(6)?,
                confidence: row.get(7)?,
                created_at: row
                    .get::<_, String>(8)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
    }

    pub fn list_dictation_snippets(&self) -> Result<Vec<DictationSnippet>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, trigger, expansion, app_scope, case_sensitive, enabled, created_at, updated_at
             FROM dictation_snippets
             ORDER BY trigger ASC, created_at ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(DictationSnippet {
                id: row.get(0)?,
                trigger: row.get(1)?,
                expansion: row.get(2)?,
                app_scope: row.get(3)?,
                case_sensitive: row.get::<_, i64>(4)? != 0,
                enabled: row.get::<_, i64>(5)? != 0,
                created_at: row
                    .get::<_, String>(6)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
                updated_at: row
                    .get::<_, String>(7)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
    }

    pub fn list_dictation_dictionary_entries(&self) -> Result<Vec<DictationDictionaryEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, spoken_form, replacement, app_scope, case_sensitive, enabled, created_at, updated_at
             FROM dictation_dictionary_entries
             ORDER BY spoken_form ASC, created_at ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(DictationDictionaryEntry {
                id: row.get(0)?,
                spoken_form: row.get(1)?,
                replacement: row.get(2)?,
                app_scope: row.get(3)?,
                case_sensitive: row.get::<_, i64>(4)? != 0,
                enabled: row.get::<_, i64>(5)? != 0,
                created_at: row
                    .get::<_, String>(6)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
                updated_at: row
                    .get::<_, String>(7)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
    }

    pub fn create_dictation_dictionary_entry(
        &mut self,
        request: &CreateDictationDictionaryEntryRequest,
    ) -> Result<DictationDictionaryEntry> {
        let spoken_form = request.spoken_form.trim();
        if spoken_form.is_empty() {
            anyhow::bail!("Dictionary spoken form cannot be empty");
        }
        let replacement = request.replacement.trim();
        if replacement.is_empty() {
            anyhow::bail!("Dictionary replacement cannot be empty");
        }

        let now = Utc::now();
        let entry = DictationDictionaryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            spoken_form: spoken_form.to_string(),
            replacement: replacement.to_string(),
            app_scope: request
                .app_scope
                .as_ref()
                .map(|scope| scope.trim().to_string())
                .filter(|scope| !scope.is_empty()),
            case_sensitive: request.case_sensitive,
            enabled: request.enabled,
            created_at: now,
            updated_at: now,
        };

        self.conn.execute(
            "INSERT INTO dictation_dictionary_entries (
                id, spoken_form, replacement, app_scope, case_sensitive, enabled, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                &entry.id,
                &entry.spoken_form,
                &entry.replacement,
                &entry.app_scope,
                if entry.case_sensitive { 1 } else { 0 },
                if entry.enabled { 1 } else { 0 },
                entry.created_at.to_rfc3339(),
                entry.updated_at.to_rfc3339(),
            ],
        )?;

        Ok(entry)
    }

    pub fn update_dictation_dictionary_entry(
        &mut self,
        entry_id: &str,
        request: &UpdateDictationDictionaryEntryRequest,
    ) -> Result<DictationDictionaryEntry> {
        let existing = self
            .list_dictation_dictionary_entries()?
            .into_iter()
            .find(|entry| entry.id == entry_id)
            .ok_or_else(|| anyhow::anyhow!("Dictionary entry '{}' not found", entry_id))?;

        let spoken_form = request
            .spoken_form
            .as_deref()
            .unwrap_or(existing.spoken_form.as_str())
            .trim()
            .to_string();
        if spoken_form.is_empty() {
            anyhow::bail!("Dictionary spoken form cannot be empty");
        }

        let replacement = request
            .replacement
            .as_deref()
            .unwrap_or(existing.replacement.as_str())
            .trim()
            .to_string();
        if replacement.is_empty() {
            anyhow::bail!("Dictionary replacement cannot be empty");
        }

        let app_scope = match &request.app_scope {
            Some(value) => value
                .as_ref()
                .map(|scope| scope.trim().to_string())
                .filter(|scope| !scope.is_empty()),
            None => existing.app_scope.clone(),
        };
        let case_sensitive = request.case_sensitive.unwrap_or(existing.case_sensitive);
        let enabled = request.enabled.unwrap_or(existing.enabled);
        let updated_at = Utc::now();

        self.conn.execute(
            "UPDATE dictation_dictionary_entries
             SET spoken_form = ?1, replacement = ?2, app_scope = ?3, case_sensitive = ?4, enabled = ?5, updated_at = ?6
             WHERE id = ?7",
            params![
                &spoken_form,
                &replacement,
                &app_scope,
                if case_sensitive { 1 } else { 0 },
                if enabled { 1 } else { 0 },
                updated_at.to_rfc3339(),
                entry_id,
            ],
        )?;

        Ok(DictationDictionaryEntry {
            id: entry_id.to_string(),
            spoken_form,
            replacement,
            app_scope,
            case_sensitive,
            enabled,
            created_at: existing.created_at,
            updated_at,
        })
    }

    pub fn delete_dictation_dictionary_entry(&mut self, entry_id: &str) -> Result<()> {
        let deleted = self.conn.execute(
            "DELETE FROM dictation_dictionary_entries WHERE id = ?1",
            params![entry_id],
        )?;
        if deleted == 0 {
            anyhow::bail!("Dictionary entry '{}' not found", entry_id);
        }
        Ok(())
    }

    pub fn list_dictation_correction_suggestions(
        &self,
    ) -> Result<Vec<DictationCorrectionSuggestion>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, original_text, corrected_text, spoken_form, replacement, app_target, created_at, updated_at
             FROM dictation_correction_suggestions
             ORDER BY updated_at DESC, created_at DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(DictationCorrectionSuggestion {
                id: row.get(0)?,
                original_text: row.get(1)?,
                corrected_text: row.get(2)?,
                spoken_form: row.get(3)?,
                replacement: row.get(4)?,
                app_target: row.get(5)?,
                created_at: row
                    .get::<_, String>(6)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
                updated_at: row
                    .get::<_, String>(7)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
    }

    pub fn upsert_dictation_correction_suggestion(
        &mut self,
        original_text: &str,
        corrected_text: &str,
        spoken_form: &str,
        replacement: &str,
        app_target: Option<&str>,
    ) -> Result<(String, DictationCorrectionSuggestion)> {
        let normalized_spoken_form = spoken_form.trim();
        let normalized_replacement = replacement.trim();
        if normalized_spoken_form.is_empty() || normalized_replacement.is_empty() {
            anyhow::bail!("Correction suggestion fields cannot be empty");
        }

        let normalized_app_target = app_target
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let existing = self
            .list_dictation_correction_suggestions()?
            .into_iter()
            .find(|suggestion| {
                suggestion
                    .spoken_form
                    .eq_ignore_ascii_case(normalized_spoken_form)
                    && suggestion.replacement == normalized_replacement
                    && match (
                        suggestion.app_target.as_deref(),
                        normalized_app_target.as_deref(),
                    ) {
                        (Some(left), Some(right)) => left.eq_ignore_ascii_case(right),
                        (None, None) => true,
                        _ => false,
                    }
            });

        let now = Utc::now();
        if let Some(existing) = existing {
            self.conn.execute(
                "UPDATE dictation_correction_suggestions
                 SET original_text = ?1, corrected_text = ?2, spoken_form = ?3, replacement = ?4, app_target = ?5, updated_at = ?6
                 WHERE id = ?7",
                params![
                    original_text.trim(),
                    corrected_text.trim(),
                    normalized_spoken_form,
                    normalized_replacement,
                    &normalized_app_target,
                    now.to_rfc3339(),
                    &existing.id,
                ],
            )?;

            Ok((
                "updated".to_string(),
                DictationCorrectionSuggestion {
                    id: existing.id,
                    original_text: original_text.trim().to_string(),
                    corrected_text: corrected_text.trim().to_string(),
                    spoken_form: normalized_spoken_form.to_string(),
                    replacement: normalized_replacement.to_string(),
                    app_target: normalized_app_target,
                    created_at: existing.created_at,
                    updated_at: now,
                },
            ))
        } else {
            let suggestion = DictationCorrectionSuggestion {
                id: uuid::Uuid::new_v4().to_string(),
                original_text: original_text.trim().to_string(),
                corrected_text: corrected_text.trim().to_string(),
                spoken_form: normalized_spoken_form.to_string(),
                replacement: normalized_replacement.to_string(),
                app_target: normalized_app_target,
                created_at: now,
                updated_at: now,
            };

            self.conn.execute(
                "INSERT INTO dictation_correction_suggestions (
                    id, original_text, corrected_text, spoken_form, replacement, app_target, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    &suggestion.id,
                    &suggestion.original_text,
                    &suggestion.corrected_text,
                    &suggestion.spoken_form,
                    &suggestion.replacement,
                    &suggestion.app_target,
                    suggestion.created_at.to_rfc3339(),
                    suggestion.updated_at.to_rfc3339(),
                ],
            )?;

            Ok(("created".to_string(), suggestion))
        }
    }

    pub fn get_dictation_correction_suggestion(
        &self,
        suggestion_id: &str,
    ) -> Result<Option<DictationCorrectionSuggestion>> {
        Ok(self
            .list_dictation_correction_suggestions()?
            .into_iter()
            .find(|suggestion| suggestion.id == suggestion_id))
    }

    pub fn delete_dictation_correction_suggestion(&mut self, suggestion_id: &str) -> Result<()> {
        let deleted = self.conn.execute(
            "DELETE FROM dictation_correction_suggestions WHERE id = ?1",
            params![suggestion_id],
        )?;
        if deleted == 0 {
            anyhow::bail!("Correction suggestion '{}' not found", suggestion_id);
        }
        Ok(())
    }

    pub fn create_dictation_snippet(
        &mut self,
        request: &CreateDictationSnippetRequest,
    ) -> Result<DictationSnippet> {
        let trigger = request.trigger.trim();
        if trigger.is_empty() {
            anyhow::bail!("Snippet trigger cannot be empty");
        }
        let expansion = request.expansion.trim();
        if expansion.is_empty() {
            anyhow::bail!("Snippet expansion cannot be empty");
        }

        let now = Utc::now();
        let snippet = DictationSnippet {
            id: uuid::Uuid::new_v4().to_string(),
            trigger: trigger.to_string(),
            expansion: expansion.to_string(),
            app_scope: request
                .app_scope
                .as_ref()
                .map(|scope| scope.trim().to_string())
                .filter(|scope| !scope.is_empty()),
            case_sensitive: request.case_sensitive,
            enabled: request.enabled,
            created_at: now,
            updated_at: now,
        };

        self.conn.execute(
            "INSERT INTO dictation_snippets (
                id, trigger, expansion, app_scope, case_sensitive, enabled, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                &snippet.id,
                &snippet.trigger,
                &snippet.expansion,
                &snippet.app_scope,
                if snippet.case_sensitive { 1 } else { 0 },
                if snippet.enabled { 1 } else { 0 },
                snippet.created_at.to_rfc3339(),
                snippet.updated_at.to_rfc3339(),
            ],
        )?;

        Ok(snippet)
    }

    pub fn update_dictation_snippet(
        &mut self,
        snippet_id: &str,
        request: &UpdateDictationSnippetRequest,
    ) -> Result<DictationSnippet> {
        let existing = self
            .list_dictation_snippets()?
            .into_iter()
            .find(|snippet| snippet.id == snippet_id)
            .ok_or_else(|| anyhow::anyhow!("Snippet '{}' not found", snippet_id))?;

        let trigger = request
            .trigger
            .as_deref()
            .unwrap_or(existing.trigger.as_str())
            .trim()
            .to_string();
        if trigger.is_empty() {
            anyhow::bail!("Snippet trigger cannot be empty");
        }

        let expansion = request
            .expansion
            .as_deref()
            .unwrap_or(existing.expansion.as_str())
            .trim()
            .to_string();
        if expansion.is_empty() {
            anyhow::bail!("Snippet expansion cannot be empty");
        }

        let app_scope = match &request.app_scope {
            Some(value) => value
                .as_ref()
                .map(|scope| scope.trim().to_string())
                .filter(|scope| !scope.is_empty()),
            None => existing.app_scope.clone(),
        };
        let case_sensitive = request.case_sensitive.unwrap_or(existing.case_sensitive);
        let enabled = request.enabled.unwrap_or(existing.enabled);
        let updated_at = Utc::now();

        self.conn.execute(
            "UPDATE dictation_snippets
             SET trigger = ?1, expansion = ?2, app_scope = ?3, case_sensitive = ?4, enabled = ?5, updated_at = ?6
             WHERE id = ?7",
            params![
                &trigger,
                &expansion,
                &app_scope,
                if case_sensitive { 1 } else { 0 },
                if enabled { 1 } else { 0 },
                updated_at.to_rfc3339(),
                snippet_id,
            ],
        )?;

        Ok(DictationSnippet {
            id: snippet_id.to_string(),
            trigger,
            expansion,
            app_scope,
            case_sensitive,
            enabled,
            created_at: existing.created_at,
            updated_at,
        })
    }

    pub fn delete_dictation_snippet(&mut self, snippet_id: &str) -> Result<()> {
        let deleted = self.conn.execute(
            "DELETE FROM dictation_snippets WHERE id = ?1",
            params![snippet_id],
        )?;
        if deleted == 0 {
            anyhow::bail!("Snippet '{}' not found", snippet_id);
        }
        Ok(())
    }

    pub fn list_dictation_command_presets(&self) -> Result<Vec<DictationCommandPreset>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, command_key, system_prompt, enabled, created_at, updated_at
             FROM dictation_command_presets
             ORDER BY command_key ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(DictationCommandPreset {
                id: row.get(0)?,
                command_key: row.get(1)?,
                system_prompt: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                created_at: row
                    .get::<_, String>(4)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
                updated_at: row
                    .get::<_, String>(5)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
    }

    pub fn upsert_dictation_command_preset(
        &mut self,
        request: &UpsertDictationCommandPresetRequest,
    ) -> Result<DictationCommandPreset> {
        let command_key = request.command_key.trim().to_ascii_lowercase();
        if command_key.is_empty() {
            anyhow::bail!("Command key cannot be empty");
        }
        let system_prompt = request.system_prompt.trim();
        if system_prompt.is_empty() {
            anyhow::bail!("System prompt cannot be empty");
        }

        let now = Utc::now();
        let existing = self
            .list_dictation_command_presets()?
            .into_iter()
            .find(|preset| preset.command_key == command_key);
        let id = existing
            .as_ref()
            .map(|preset| preset.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let created_at = existing
            .as_ref()
            .map(|preset| preset.created_at)
            .unwrap_or(now);

        self.conn.execute(
            "INSERT INTO dictation_command_presets (id, command_key, system_prompt, enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(command_key) DO UPDATE SET
                system_prompt = excluded.system_prompt,
                enabled = excluded.enabled,
                updated_at = excluded.updated_at",
            params![
                &id,
                &command_key,
                system_prompt,
                if request.enabled { 1 } else { 0 },
                created_at.to_rfc3339(),
                now.to_rfc3339(),
            ],
        )?;

        Ok(DictationCommandPreset {
            id,
            command_key,
            system_prompt: system_prompt.to_string(),
            enabled: request.enabled,
            created_at,
            updated_at: now,
        })
    }

    pub fn delete_dictation_command_preset(&mut self, command_key: &str) -> Result<()> {
        let key = command_key.trim().to_ascii_lowercase();
        if key.is_empty() {
            anyhow::bail!("Command key cannot be empty");
        }
        self.conn.execute(
            "DELETE FROM dictation_command_presets WHERE command_key = ?1",
            params![key],
        )?;
        Ok(())
    }

    pub fn search_transcripts(
        &self,
        query: &str,
        limit: usize,
        project_ids: Option<&[String]>,
    ) -> Result<Vec<SearchHit>> {
        self.search_transcripts_filtered(query, limit, project_ids, None)
    }

    pub fn search_transcripts_in_recordings(
        &self,
        query: &str,
        limit: usize,
        recording_ids: &[String],
    ) -> Result<Vec<SearchHit>> {
        self.search_transcripts_filtered(query, limit, None, Some(recording_ids))
    }

    fn search_transcripts_filtered(
        &self,
        query: &str,
        limit: usize,
        project_ids: Option<&[String]>,
        recording_ids: Option<&[String]>,
    ) -> Result<Vec<SearchHit>> {
        let fts_query = build_fts_query(query);
        if fts_query.is_empty() {
            return Ok(Vec::new());
        }

        let mut sql = String::from(
            "SELECT
                f.recording_id,
                COALESCE(r.title, ''),
                COALESCE(r.project_id, ''),
                COALESCE(f.segment_id, ''),
                COALESCE(f.text, ''),
                COALESCE(f.start_time, 0),
                COALESCE(f.end_time, 0),
                bm25(transcript_fts)
             FROM transcript_fts f
             JOIN recordings r ON r.id = f.recording_id
             WHERE transcript_fts MATCH ?1",
        );

        let mut values: Vec<Value> = vec![Value::from(fts_query)];
        let mut placeholder = 2;

        if let Some(projects) = project_ids {
            if !projects.is_empty() {
                sql.push_str(" AND r.project_id IN (");
                for (index, project_id) in projects.iter().enumerate() {
                    if index > 0 {
                        sql.push_str(", ");
                    }
                    sql.push('?');
                    sql.push_str(&placeholder.to_string());
                    values.push(Value::from(project_id.clone()));
                    placeholder += 1;
                }
                sql.push(')');
            }
        }

        if let Some(recordings) = recording_ids {
            if !recordings.is_empty() {
                sql.push_str(" AND f.recording_id IN (");
                for (index, recording_id) in recordings.iter().enumerate() {
                    if index > 0 {
                        sql.push_str(", ");
                    }
                    sql.push('?');
                    sql.push_str(&placeholder.to_string());
                    values.push(Value::from(recording_id.clone()));
                    placeholder += 1;
                }
                sql.push(')');
            }
        }

        sql.push_str(" ORDER BY bm25(transcript_fts) ASC LIMIT ?");
        sql.push_str(&placeholder.to_string());
        values.push(Value::from(limit as i64));

        let mut stmt = match self.conn.prepare(&sql) {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(
                    "FTS query unavailable ({}); using LIKE fallback search",
                    error
                );
                return self.search_transcripts_without_fts(
                    query,
                    limit,
                    project_ids,
                    recording_ids,
                );
            }
        };
        let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
            let start_time = row
                .get::<_, Option<f64>>(5)?
                .or_else(|| {
                    row.get::<_, String>(5)
                        .ok()
                        .and_then(|value| value.parse().ok())
                })
                .unwrap_or(0.0);
            let end_time = row
                .get::<_, Option<f64>>(6)?
                .or_else(|| {
                    row.get::<_, String>(6)
                        .ok()
                        .and_then(|value| value.parse().ok())
                })
                .unwrap_or(0.0);
            Ok(SearchHit {
                recording_id: row.get(0)?,
                recording_title: row.get(1)?,
                project_id: row.get(2)?,
                segment_id: row.get(3)?,
                text: row.get(4)?,
                start_time,
                end_time,
                score: row.get(7)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
    }

    fn search_transcripts_without_fts(
        &self,
        query: &str,
        limit: usize,
        project_ids: Option<&[String]>,
        recording_ids: Option<&[String]>,
    ) -> Result<Vec<SearchHit>> {
        let normalized_query = query.trim().to_lowercase();
        if normalized_query.is_empty() {
            return Ok(Vec::new());
        }

        let mut sql = String::from(
            "SELECT t.recording_id, r.title, r.project_id, t.segments
             FROM transcripts t
             JOIN recordings r ON r.id = t.recording_id
             WHERE 1=1",
        );
        let mut values: Vec<Value> = Vec::new();
        let mut placeholder = 1;

        if let Some(projects) = project_ids {
            if !projects.is_empty() {
                sql.push_str(" AND r.project_id IN (");
                for (index, project_id) in projects.iter().enumerate() {
                    if index > 0 {
                        sql.push_str(", ");
                    }
                    sql.push('?');
                    sql.push_str(&placeholder.to_string());
                    values.push(Value::from(project_id.clone()));
                    placeholder += 1;
                }
                sql.push(')');
            }
        }

        if let Some(recordings) = recording_ids {
            if !recordings.is_empty() {
                sql.push_str(" AND t.recording_id IN (");
                for (index, recording_id) in recordings.iter().enumerate() {
                    if index > 0 {
                        sql.push_str(", ");
                    }
                    sql.push('?');
                    sql.push_str(&placeholder.to_string());
                    values.push(Value::from(recording_id.clone()));
                    placeholder += 1;
                }
                sql.push(')');
            }
        }

        let mut stmt = self.conn.prepare(&sql)?;
        let mut results = Vec::new();
        let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;

        for row in rows {
            let (recording_id, recording_title, project_id, segments_json) = row?;
            let segments: Vec<TranscriptSegment> =
                serde_json::from_str(&segments_json).unwrap_or_default();

            for segment in segments {
                let text_lower = segment.text.to_lowercase();
                if !text_lower.contains(&normalized_query) {
                    continue;
                }
                results.push(SearchHit {
                    recording_id: recording_id.clone(),
                    recording_title: recording_title.clone(),
                    project_id: project_id.clone(),
                    segment_id: segment.id,
                    text: segment.text,
                    start_time: segment.start_time,
                    end_time: segment.end_time,
                    score: 0.0,
                });
            }
        }

        results.truncate(limit);
        Ok(results)
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

    pub fn get_speaker_aliases(&self, recording_id: &str) -> Result<HashMap<String, SpeakerAlias>> {
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
            "DELETE FROM transcript_fts WHERE recording_id = ?1",
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

    /// Update recording source type (meeting|dictation)
    pub fn update_recording_source_type(
        &mut self,
        recording_id: &str,
        source_type: &str,
    ) -> Result<()> {
        let updated = self.conn.execute(
            "UPDATE recordings SET source_type = ?1, updated_at = ?2 WHERE id = ?3",
            params![source_type, Utc::now().to_rfc3339(), recording_id],
        )?;
        if updated == 0 {
            anyhow::bail!("Recording '{}' was not found", recording_id);
        }
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
        tx.execute("DELETE FROM projects WHERE id = ?1", params![project_id])?;
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

    // ── Embedding storage for vector search ──────────────────────────────

    #[allow(clippy::too_many_arguments)]
    pub fn save_embedding(
        &self,
        recording_id: &str,
        segment_id: &str,
        text: &str,
        embedding: &[f32],
        model: &str,
        start_time: f64,
        end_time: f64,
    ) -> Result<()> {
        let blob: Vec<u8> = embedding.iter().flat_map(|f| f.to_le_bytes()).collect();
        self.conn.execute(
            "INSERT INTO transcript_embeddings (recording_id, segment_id, text, embedding, model, start_time, end_time, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![recording_id, segment_id, text, blob, model, start_time, end_time, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn has_embeddings(&self, recording_id: &str) -> bool {
        self.conn
            .query_row(
                "SELECT COUNT(*) FROM transcript_embeddings WHERE recording_id = ?1",
                params![recording_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0
    }

    pub fn delete_embeddings(&self, recording_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM transcript_embeddings WHERE recording_id = ?1",
            params![recording_id],
        )?;
        Ok(())
    }

    pub fn delete_all_embeddings(&self) -> Result<usize> {
        let count = self.conn.execute("DELETE FROM transcript_embeddings", [])?;
        Ok(count)
    }

    pub fn purge_user_content(&mut self) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM speaker_aliases", [])?;
        tx.execute("DELETE FROM transcripts", [])?;
        let _ = tx.execute("DELETE FROM transcript_fts", []);
        tx.execute("DELETE FROM recordings", [])?;
        tx.execute("DELETE FROM asr_benchmarks", [])?;
        tx.execute("DELETE FROM transcript_embeddings", [])?;
        tx.execute("DELETE FROM projects", [])?;
        tx.execute("DROP TRIGGER IF EXISTS audit_log_no_update", [])?;
        tx.execute("DROP TRIGGER IF EXISTS audit_log_no_delete", [])?;
        tx.execute("DELETE FROM audit_log", [])?;
        tx.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS audit_log_no_update
             BEFORE UPDATE ON audit_log
             BEGIN
                 SELECT RAISE(ABORT, 'audit_log is append-only');
             END;
             CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
             BEFORE DELETE ON audit_log
             BEGIN
                 SELECT RAISE(ABORT, 'audit_log is append-only');
             END;",
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO projects (id, name, description, created_at, updated_at)
             VALUES ('default', 'Inbox', 'Default inbox for new recordings', ?1, ?1)",
            params![&now],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO projects (id, name, description, created_at, updated_at)
             VALUES ('inbox', 'Inbox', 'Default inbox for new recordings', ?1, ?1)",
            params![&now],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn search_embeddings(
        &self,
        query_embedding: &[f32],
        limit: usize,
    ) -> Result<Vec<SearchHit>> {
        let mut stmt = self.conn.prepare(
            "SELECT recording_id, segment_id, text, embedding, start_time, end_time
             FROM transcript_embeddings",
        )?;

        let rows = stmt.query_map([], |row| {
            let recording_id: String = row.get(0)?;
            let segment_id: String = row.get(1)?;
            let text: String = row.get(2)?;
            let blob: Vec<u8> = row.get(3)?;
            let start_time: f64 = row.get(4)?;
            let end_time: f64 = row.get(5)?;
            Ok((recording_id, segment_id, text, blob, start_time, end_time))
        })?;

        let mut scored: Vec<(f64, SearchHit)> = Vec::new();
        for row in rows {
            let (recording_id, segment_id, text, blob, start_time, end_time) = row?;
            let embedding = blob_to_f32_vec(&blob);
            let score = crate::llm::cosine_similarity(query_embedding, &embedding) as f64;
            scored.push((
                score,
                SearchHit {
                    recording_id,
                    recording_title: String::new(),
                    project_id: String::new(),
                    segment_id,
                    text,
                    start_time,
                    end_time,
                    score,
                },
            ));
        }

        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);

        // Backfill recording titles
        let hits: Vec<SearchHit> = scored
            .into_iter()
            .map(|(_, mut hit)| {
                if let Ok(title) = self.conn.query_row(
                    "SELECT title FROM recordings WHERE id = ?1",
                    params![&hit.recording_id],
                    |row| row.get::<_, String>(0),
                ) {
                    hit.recording_title = title;
                }
                hit
            })
            .collect();

        Ok(hits)
    }

    pub fn embedding_count(&self) -> Result<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM transcript_embeddings", [], |row| {
                row.get(0)
            })
            .map_err(|e| e.into())
    }
}

fn blob_to_f32_vec(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

fn build_fts_query(query: &str) -> String {
    let tokens: Vec<String> = query
        .split(|c: char| !c.is_alphanumeric())
        .map(|token| token.trim().to_lowercase())
        .filter(|token| token.len() >= 2)
        .collect();

    if tokens.is_empty() {
        return String::new();
    }

    tokens
        .into_iter()
        .map(|token| format!("{}*", token))
        .collect::<Vec<_>>()
        .join(" OR ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{
        CaptureSessionRecord, ContextSnapshotRecord, InsertionActionRecord, MeetingArtifactRecord,
        PolicySnapshotRecord, RuntimeEventRecord, TranscriptArtifactRecord,
    };
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
            summary: None,
            action_items: None,
            meeting_notes: None,
            meeting_template_id: None,
            meeting_capture_mode: None,
            notes_updated_at: None,
            consent_prompt_shown: false,
            consent_notice_mode: None,
            consent_notice_surface: None,
            consent_notice_message: None,
            consent_notice_updated_at: None,
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
            model_id: Some("base.en".to_string()),
            requested_provider: Some("whisper".to_string()),
            actual_provider: Some("whisper".to_string()),
            created_at: Utc::now(),
        }
    }

    fn sample_runtime_event() -> RuntimeEventRecord {
        RuntimeEventRecord {
            id: "evt-1".to_string(),
            event_type: "dictation.state_changed".to_string(),
            surface: Some("dictation".to_string()),
            session_id: Some("session-1".to_string()),
            recording_id: None,
            payload: serde_json::json!({ "phase": "recording" }),
            created_at: Utc::now(),
        }
    }

    fn sample_capture_session() -> CaptureSessionRecord {
        let now = Utc::now();
        CaptureSessionRecord {
            id: "session-1".to_string(),
            surface: "dictation".to_string(),
            state: "recording".to_string(),
            started_at: now,
            stopped_at: None,
            audio_sources: vec!["microphone".to_string()],
            target_app: Some("Slack".to_string()),
            context_snapshot_id: Some("ctx-1".to_string()),
            policy_snapshot_id: Some("policy-1".to_string()),
            provider_plan_id: Some("distil_whisper/default".to_string()),
            created_at: now,
            updated_at: now,
        }
    }

    fn sample_context_snapshot() -> ContextSnapshotRecord {
        ContextSnapshotRecord {
            id: "ctx-1".to_string(),
            frontmost_app: Some("Slack".to_string()),
            frontmost_bundle_id: Some("com.tinyspeck.slackmacgap".to_string()),
            window_title: Some("Engineering".to_string()),
            selected_text: Some("Ship the release".to_string()),
            clipboard_text: Some("Clipboard context".to_string()),
            meeting_hint: None,
            active_mode: Some("messages".to_string()),
            created_at: Utc::now(),
        }
    }

    fn sample_policy_snapshot() -> PolicySnapshotRecord {
        PolicySnapshotRecord {
            id: "policy-1".to_string(),
            retention_mode: "never".to_string(),
            storage_mode: "always".to_string(),
            provider_policy: serde_json::json!({ "remoteProcessingEnabled": false }),
            ai_policy: serde_json::json!({ "provider": "ollama" }),
            insertion_policy: serde_json::json!({ "mode": "paste" }),
            export_constraints: serde_json::json!({ "includeSpeakers": true }),
            created_at: Utc::now(),
        }
    }

    fn sample_transcript_artifact() -> TranscriptArtifactRecord {
        TranscriptArtifactRecord {
            id: "artifact-1".to_string(),
            recording_id: "recording-1".to_string(),
            transcript_id: Some("transcript-1".to_string()),
            segment_count: 3,
            model_id: Some("distil-large-v3.5".to_string()),
            requested_provider: Some("voxtral".to_string()),
            actual_provider: Some("distil-whisper".to_string()),
            quality_score: Some(0.94),
            startup_latency_ms: Some(90),
            transcription_latency_ms: Some(210),
            insert_latency_ms: Some(18),
            end_to_end_ms: Some(320),
            created_at: Utc::now(),
        }
    }

    fn sample_insertion_action() -> InsertionActionRecord {
        InsertionActionRecord {
            id: "insert-1".to_string(),
            session_id: Some("session-1".to_string()),
            recording_id: Some("recording-1".to_string()),
            requested_mode: "paste".to_string(),
            actual_mode: "paste".to_string(),
            pasted: true,
            copied: true,
            failed: false,
            undo_token: None,
            command_applied: Some("rewrite_shorter".to_string()),
            snippet_applied_count: 2,
            app_target: Some("Slack".to_string()),
            error: None,
            created_at: Utc::now(),
        }
    }

    fn sample_meeting_artifact() -> MeetingArtifactRecord {
        let now = Utc::now();
        MeetingArtifactRecord {
            id: "meeting-artifact-1".to_string(),
            recording_id: "r1".to_string(),
            title: Some("Weekly Sync".to_string()),
            summary: Some("Reviewed roadmap and launch blockers.".to_string()),
            action_items: vec![
                "Ship onboarding polish".to_string(),
                "Confirm launch checklist".to_string(),
            ],
            decisions: vec!["Delay referral program to Q2".to_string()],
            deadlines: vec!["2026-03-10".to_string()],
            template_id: Some("exec-update".to_string()),
            chat_messages: Vec::new(),
            created_at: now,
            updated_at: now,
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
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.create_recording(&sample_recording("r2", "other"))
            .unwrap();

        let all = db.get_recordings(None).unwrap();
        assert_eq!(all.len(), 2);

        let inbox_only = db.get_recordings(Some("inbox")).unwrap();
        assert_eq!(inbox_only.len(), 1);
        assert_eq!(inbox_only[0].id, "r1");
    }

    #[test]
    fn test_update_recording_status() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.update_recording_status("r1", "completed").unwrap();

        let rec = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(rec.status, "completed");
    }

    #[test]
    fn test_save_and_get_transcript() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();

        let transcript = sample_transcript("r1");
        db.save_transcript(&transcript).unwrap();

        let fetched = db.get_transcript("r1").unwrap();
        assert!(fetched.is_some());
        let t = fetched.unwrap();
        assert_eq!(t.full_text, "Hello world");
        assert_eq!(t.segments.len(), 1);
    }

    #[test]
    fn test_get_transcript_synthesizes_segment_from_full_text_when_segments_missing() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("r1", "inbox");
        recording.duration = 14;
        db.create_recording(&recording).unwrap();

        let transcript = Transcript {
            id: "t1".to_string(),
            recording_id: "r1".to_string(),
            segments: Vec::new(),
            full_text: "Captured full transcript text".to_string(),
            language: "en_US".to_string(),
            confidence: 0.91,
            model: "Apple Native Speech".to_string(),
            model_id: Some("macos_apple_speech".to_string()),
            requested_provider: Some("macos_apple_speech".to_string()),
            actual_provider: Some("macos_apple_speech".to_string()),
            created_at: Utc::now(),
        };
        db.save_transcript(&transcript).unwrap();

        let fetched = db.get_transcript("r1").unwrap().unwrap();
        assert_eq!(fetched.full_text, "Captured full transcript text");
        assert_eq!(fetched.segments.len(), 1);
        assert_eq!(fetched.segments[0].text, "Captured full transcript text");
        assert_eq!(fetched.segments[0].start_time, 0.0);
        assert_eq!(fetched.segments[0].end_time, 14.0);
    }

    #[test]
    fn test_rename_recording() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.rename_recording("r1", "New Title").unwrap();

        let rec = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(rec.title, "New Title");
    }

    #[test]
    fn test_update_recording_source_type() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.update_recording_source_type("r1", "dictation").unwrap();

        let rec = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(rec.source_type, "dictation");
    }

    #[test]
    fn test_update_recording_source_type_missing_recording_fails() {
        let mut db = in_memory_db();
        let result = db.update_recording_source_type("missing-id", "dictation");
        assert!(result.is_err());
    }

    #[test]
    fn test_delete_transcript_segments() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();

        let transcript = Transcript {
            id: "t1".to_string(),
            recording_id: "r1".to_string(),
            segments: vec![
                TranscriptSegment {
                    id: "s1".to_string(),
                    start_time: 0.0,
                    end_time: 1.0,
                    text: "first segment".to_string(),
                    speaker_id: None,
                    confidence: 0.9,
                },
                TranscriptSegment {
                    id: "s2".to_string(),
                    start_time: 1.0,
                    end_time: 2.0,
                    text: "second segment".to_string(),
                    speaker_id: None,
                    confidence: 0.9,
                },
            ],
            full_text: "first segment second segment".to_string(),
            language: "en".to_string(),
            confidence: 0.9,
            model: "test".to_string(),
            model_id: None,
            requested_provider: None,
            actual_provider: None,
            created_at: Utc::now(),
        };
        db.save_transcript(&transcript).unwrap();

        let removed = db
            .delete_transcript_segments("r1", &["s1".to_string()])
            .unwrap();
        assert_eq!(removed, 1);

        let updated = db.get_transcript("r1").unwrap().unwrap();
        assert_eq!(updated.segments.len(), 1);
        assert_eq!(updated.segments[0].id, "s2");
        assert_eq!(updated.full_text, "second segment");

        let hits = db.search_transcripts("first", 10, None).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn test_delete_recording_removes_transcript() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_transcript(&sample_transcript("r1")).unwrap();

        let audio_path = db.delete_recording("r1").unwrap();
        assert_eq!(audio_path, "/tmp/r1.wav");

        assert!(db.get_recording("r1").unwrap().is_none());
        assert!(db.get_transcript("r1").unwrap().is_none());
        let hits = db.search_transcripts("hello", 10, None).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn test_delete_project_reassigns_recordings() {
        let mut db = in_memory_db();
        let proj = db
            .create_project(&sample_project("p1", "ToDelete"))
            .unwrap();
        db.create_recording(&sample_recording("r1", &proj.id))
            .unwrap();

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
        db.log_audit_event(
            "test_event",
            Some(serde_json::json!({"key": "value"})),
            "info",
        )
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
        let result = db
            .conn
            .execute("UPDATE audit_log SET event = 'modified'", []);
        assert!(
            result.is_err(),
            "Audit log should be append-only (no updates)"
        );
    }

    #[test]
    fn test_audit_log_append_only_no_delete() {
        let mut db = in_memory_db();
        db.log_audit_event("first", None, "info").unwrap();

        // Attempt to DELETE from audit log should fail due to trigger
        let result = db.conn.execute("DELETE FROM audit_log", []);
        assert!(
            result.is_err(),
            "Audit log should be append-only (no deletes)"
        );
    }

    #[test]
    fn test_append_and_list_runtime_events() {
        let mut db = in_memory_db();
        let event = sample_runtime_event();
        db.append_runtime_event(&event).unwrap();

        let events = db.list_runtime_events(10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "dictation.state_changed");
        assert_eq!(events[0].session_id.as_deref(), Some("session-1"));
        assert_eq!(events[0].payload["phase"], "recording");
    }

    #[test]
    fn test_save_and_get_capture_session() {
        let mut db = in_memory_db();
        let session = sample_capture_session();
        db.save_capture_session(&session).unwrap();

        let fetched = db.get_capture_session("session-1").unwrap().unwrap();
        assert_eq!(fetched.surface, "dictation");
        assert_eq!(fetched.audio_sources, vec!["microphone".to_string()]);
        assert_eq!(fetched.target_app.as_deref(), Some("Slack"));
    }

    #[test]
    fn test_save_and_get_context_snapshot() {
        let mut db = in_memory_db();
        let snapshot = sample_context_snapshot();
        db.save_context_snapshot(&snapshot).unwrap();

        let fetched = db.get_context_snapshot("ctx-1").unwrap().unwrap();
        assert_eq!(fetched.frontmost_app.as_deref(), Some("Slack"));
        assert_eq!(fetched.active_mode.as_deref(), Some("messages"));
        assert_eq!(fetched.selected_text.as_deref(), Some("Ship the release"));
    }

    #[test]
    fn test_save_and_get_policy_snapshot() {
        let mut db = in_memory_db();
        let snapshot = sample_policy_snapshot();
        db.save_policy_snapshot(&snapshot).unwrap();

        let fetched = db.get_policy_snapshot("policy-1").unwrap().unwrap();
        assert_eq!(fetched.retention_mode, "never");
        assert_eq!(fetched.storage_mode, "always");
        assert_eq!(fetched.provider_policy["remoteProcessingEnabled"], false);
        assert_eq!(fetched.insertion_policy["mode"], "paste");
    }

    #[test]
    fn test_save_and_get_transcript_artifact() {
        let mut db = in_memory_db();
        let artifact = sample_transcript_artifact();
        db.save_transcript_artifact(&artifact).unwrap();

        let fetched = db
            .get_latest_transcript_artifact("recording-1")
            .unwrap()
            .unwrap();
        assert_eq!(fetched.transcript_id.as_deref(), Some("transcript-1"));
        assert_eq!(fetched.actual_provider.as_deref(), Some("distil-whisper"));
        assert_eq!(fetched.end_to_end_ms, Some(320));
    }

    #[test]
    fn test_save_and_get_insertion_action() {
        let mut db = in_memory_db();
        let action = sample_insertion_action();
        db.save_insertion_action(&action).unwrap();

        let fetched = db
            .get_latest_insertion_action("recording-1")
            .unwrap()
            .unwrap();
        assert_eq!(fetched.requested_mode, "paste");
        assert_eq!(fetched.command_applied.as_deref(), Some("rewrite_shorter"));
        assert_eq!(fetched.app_target.as_deref(), Some("Slack"));
        assert!(fetched.pasted);
    }

    #[test]
    fn test_save_and_get_meeting_artifact() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_meeting_artifact(&sample_meeting_artifact())
            .unwrap();

        let fetched = db.get_meeting_artifact("r1").unwrap().unwrap();
        assert_eq!(fetched.title.as_deref(), Some("Weekly Sync"));
        assert_eq!(
            fetched.summary.as_deref(),
            Some("Reviewed roadmap and launch blockers.")
        );
        assert_eq!(fetched.deadlines, vec!["2026-03-10".to_string()]);
    }

    #[test]
    fn test_get_recording_prefers_meeting_artifact_values() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("r1", "inbox");
        recording.title = "Legacy Title".to_string();
        recording.summary = Some("Legacy summary".to_string());
        recording.action_items = Some(vec!["Legacy action".to_string()]);
        recording.meeting_template_id = Some("legacy-template".to_string());
        db.create_recording(&recording).unwrap();
        db.save_meeting_artifact(&sample_meeting_artifact())
            .unwrap();

        let fetched = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(fetched.title, "Weekly Sync");
        assert_eq!(
            fetched.summary.as_deref(),
            Some("Reviewed roadmap and launch blockers.")
        );
        assert_eq!(
            fetched.action_items,
            Some(vec![
                "Ship onboarding polish".to_string(),
                "Confirm launch checklist".to_string()
            ])
        );
        assert_eq!(fetched.meeting_template_id.as_deref(), Some("exec-update"));
    }

    #[test]
    fn test_update_recording_analysis_updates_meeting_artifact_values() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("r1", "inbox");
        recording.summary = Some("Legacy summary".to_string());
        recording.action_items = Some(vec!["Legacy action".to_string()]);
        db.create_recording(&recording).unwrap();
        db.save_meeting_artifact(&sample_meeting_artifact())
            .unwrap();

        db.update_recording_analysis(
            "r1",
            Some("Edited summary"),
            &["Edited follow-up".to_string()],
        )
        .unwrap();

        let fetched = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(fetched.summary.as_deref(), Some("Edited summary"));
        assert_eq!(
            fetched.action_items,
            Some(vec!["Edited follow-up".to_string()])
        );

        let artifact = db.get_meeting_artifact("r1").unwrap().unwrap();
        assert_eq!(artifact.summary.as_deref(), Some("Edited summary"));
        assert_eq!(artifact.action_items, vec!["Edited follow-up".to_string()]);
    }

    #[test]
    fn test_update_recording_meeting_template_updates_meeting_artifact_values() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_meeting_artifact(&sample_meeting_artifact())
            .unwrap();

        db.update_recording_meeting_template("r1", Some("standup"))
            .unwrap();

        let fetched = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(fetched.meeting_template_id.as_deref(), Some("standup"));

        let artifact = db.get_meeting_artifact("r1").unwrap().unwrap();
        assert_eq!(artifact.template_id.as_deref(), Some("standup"));
    }

    #[test]
    fn test_speaker_alias_upsert() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();

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

    #[test]
    fn test_dictation_snippet_crud() {
        let mut db = in_memory_db();
        let created = db
            .create_dictation_snippet(&CreateDictationSnippetRequest {
                trigger: "brb".to_string(),
                expansion: "be right back".to_string(),
                app_scope: Some("Slack".to_string()),
                case_sensitive: false,
                enabled: true,
            })
            .unwrap();
        assert_eq!(created.trigger, "brb");

        let list = db.list_dictation_snippets().unwrap();
        assert_eq!(list.len(), 1);

        let updated = db
            .update_dictation_snippet(
                &created.id,
                &UpdateDictationSnippetRequest {
                    trigger: Some("omw".to_string()),
                    expansion: Some("on my way".to_string()),
                    app_scope: Some(None),
                    case_sensitive: Some(true),
                    enabled: Some(true),
                },
            )
            .unwrap();
        assert_eq!(updated.trigger, "omw");
        assert!(updated.app_scope.is_none());
        assert!(updated.case_sensitive);

        db.delete_dictation_snippet(&created.id).unwrap();
        assert!(db.list_dictation_snippets().unwrap().is_empty());
    }

    #[test]
    fn test_dictation_dictionary_entry_crud() {
        let mut db = in_memory_db();
        let created = db
            .create_dictation_dictionary_entry(&CreateDictationDictionaryEntryRequest {
                spoken_form: "open ai".to_string(),
                replacement: "OpenAI".to_string(),
                app_scope: Some("Slack".to_string()),
                case_sensitive: false,
                enabled: true,
            })
            .unwrap();
        assert_eq!(created.spoken_form, "open ai");

        let list = db.list_dictation_dictionary_entries().unwrap();
        assert_eq!(list.len(), 1);

        let updated = db
            .update_dictation_dictionary_entry(
                &created.id,
                &UpdateDictationDictionaryEntryRequest {
                    spoken_form: Some("nautilus bot".to_string()),
                    replacement: Some("NautilusBot".to_string()),
                    app_scope: Some(None),
                    case_sensitive: Some(true),
                    enabled: Some(true),
                },
            )
            .unwrap();
        assert_eq!(updated.spoken_form, "nautilus bot");
        assert!(updated.app_scope.is_none());
        assert!(updated.case_sensitive);

        db.delete_dictation_dictionary_entry(&created.id).unwrap();
        assert!(db.list_dictation_dictionary_entries().unwrap().is_empty());
    }

    #[test]
    fn test_dictation_correction_suggestion_upsert_and_delete() {
        let mut db = in_memory_db();
        let (first_action, first) = db
            .upsert_dictation_correction_suggestion(
                "jon will join",
                "John will join",
                "jon",
                "John",
                Some("Slack"),
            )
            .unwrap();
        assert_eq!(first_action, "created");

        let (second_action, second) = db
            .upsert_dictation_correction_suggestion(
                "jon will join tomorrow",
                "John will join tomorrow",
                "jon",
                "John",
                Some("Slack"),
            )
            .unwrap();
        assert_eq!(second_action, "updated");
        assert_eq!(first.id, second.id);

        let suggestions = db.list_dictation_correction_suggestions().unwrap();
        assert_eq!(suggestions.len(), 1);
        assert_eq!(suggestions[0].corrected_text, "John will join tomorrow");

        db.delete_dictation_correction_suggestion(&second.id)
            .unwrap();
        assert!(db
            .list_dictation_correction_suggestions()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_dictation_command_preset_upsert() {
        let mut db = in_memory_db();
        let first = db
            .upsert_dictation_command_preset(&UpsertDictationCommandPresetRequest {
                command_key: "rewrite_shorter".to_string(),
                system_prompt: "Rewrite to be concise".to_string(),
                enabled: true,
            })
            .unwrap();
        assert_eq!(first.command_key, "rewrite_shorter");

        let second = db
            .upsert_dictation_command_preset(&UpsertDictationCommandPresetRequest {
                command_key: "rewrite_shorter".to_string(),
                system_prompt: "Rewrite to be short and direct".to_string(),
                enabled: true,
            })
            .unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(second.system_prompt, "Rewrite to be short and direct");

        db.delete_dictation_command_preset("rewrite_shorter")
            .unwrap();
        assert!(db.list_dictation_command_presets().unwrap().is_empty());
    }

    #[test]
    fn test_search_transcripts_finds_segments() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.create_recording(&sample_recording("r2", "inbox"))
            .unwrap();

        let mut t1 = sample_transcript("r1");
        t1.segments[0].text = "Discuss launch readiness and QA evidence".to_string();
        t1.full_text = t1.segments[0].text.clone();
        db.save_transcript(&t1).unwrap();

        let mut t2 = sample_transcript("r2");
        t2.segments[0].text = "Weekly standup and project updates".to_string();
        t2.full_text = t2.segments[0].text.clone();
        db.save_transcript(&t2).unwrap();

        let hits = db.search_transcripts("launch qa", 10, None).unwrap();
        assert!(!hits.is_empty());
        assert_eq!(hits[0].recording_id, "r1");
    }

    #[test]
    fn test_fts_startup_backfill_runs_once_when_empty() {
        let db = in_memory_db();
        db.conn
            .execute(
                "INSERT INTO transcripts (
                    id, recording_id, segments, full_text, language, confidence, model, model_id,
                    requested_provider, actual_provider, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    "t-startup",
                    "r-startup",
                    "[{\"id\":\"seg-1\",\"startTime\":0,\"endTime\":1.2,\"text\":\"startup backfill\"}]",
                    "startup backfill",
                    "en",
                    0.9,
                    "whisper-base",
                    "base.en",
                    "whisper",
                    "whisper",
                    Utc::now().to_rfc3339(),
                ],
            )
            .unwrap();

        let before: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM transcript_fts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(before, 0);

        db.backfill_transcript_fts_if_needed().unwrap();

        let first_backfill_count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM transcript_fts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(first_backfill_count, 1);

        db.backfill_transcript_fts_if_needed().unwrap();
        let second_backfill_count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM transcript_fts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(second_backfill_count, 1);
    }

    #[test]
    fn test_fts_startup_backfill_skips_when_already_populated() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_transcript(&sample_transcript("r1")).unwrap();

        let before: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM transcript_fts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(before, 1);

        db.backfill_transcript_fts_if_needed().unwrap();
        let after: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM transcript_fts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after, 1);
    }

    #[test]
    fn test_save_and_list_asr_benchmarks() {
        let mut db = in_memory_db();
        let entry = AsrBenchmarkEntry {
            id: "bench-1".to_string(),
            provider_type: "whisper".to_string(),
            provider_name: "Whisper".to_string(),
            model_id: "large-v3-turbo".to_string(),
            runtime_status: "ready".to_string(),
            non_empty_transcript: true,
            processing_time_ms: 1234,
            confidence: 0.91,
            created_at: Utc::now(),
        };
        db.save_asr_benchmark(&entry).unwrap();
        let rows = db.list_asr_benchmarks(10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].provider_type, "whisper");
        assert!(rows[0].non_empty_transcript);
    }

    #[test]
    fn test_build_fts_query_sanitizes_input() {
        let query = build_fts_query("launch-ready?! qa");
        assert_eq!(query, "launch* OR ready* OR qa*");
    }
}
