//! Database operations using SQLite
//!
//! Manages recordings, transcripts, projects, and audit logs
//! with full CRUD operations.

use crate::models::*;
use crate::recording_audio::{
    approved_regular_file, encrypted_path_for, historical_companion_candidates,
    is_terminal_encrypted_path, validate_plaintext_wav, RecordingAudioAsset, RecordingAudioBundle,
    RecordingAudioLifecycle, RecordingAudioOperation, RecordingAudioOperationItem,
    RecordingAudioProtection, RecordingAudioRole, RecordingAudioValidation, RecordingCapturePlan,
    ValidatedRecordingAudio,
};
use crate::store::{
    CaptureSessionRecord, ContextSnapshotRecord, DictationInsightTotals, InsertionActionRecord,
    MeetingArtifactRecord, PolicySnapshotRecord, RuntimeEventRecord, TranscriptArtifactRecord,
};
use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{
    params, params_from_iter, types::Value, Connection, OptionalExtension, TransactionBehavior,
};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub type SpeakerAlias = (Option<String>, Option<String>, i64);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeakerAliasUpsert {
    pub speaker_id: String,
    pub name: Option<String>,
    pub color: Option<String>,
    pub sample_count: i64,
}

/// How complete one meeting's stored transcript actually is.
///
/// Kept out of [`Recording`] on purpose: this is storage-policy evidence, not
/// renderer-facing content, and the only thing that reads it is the set of
/// sweeps that would otherwise delete the audio holding the missing minutes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeetingTranscriptCompletion {
    pub complete: bool,
    /// Why the transcript is incomplete, as reported by chunked transcription.
    pub degraded_reason: Option<String>,
    /// When the user accepted losing the audio anyway. Never implies the
    /// transcript became complete.
    pub acknowledged_at: Option<String>,
}

const SENSITIVE_AUDIT_DETAIL_KEYS: [&str; 4] = [
    "context_preview",
    "selected_text",
    "clipboard_text",
    "captured_context_text",
];

const LEGACY_DICTATION_BYTE_COUNT_FLOOR: i64 = 86_400;
const MAX_REPAIRABLE_DICTATION_CAPTURE_MS: i64 = 12 * 60 * 60 * 1_000;
pub(crate) const CURRENT_SCHEMA_VERSION: i64 = 1;

const AUDIT_LOG_APPEND_ONLY_TRIGGER_SQL: &str = "CREATE TRIGGER IF NOT EXISTS audit_log_no_update
     BEFORE UPDATE ON audit_log
     BEGIN
         SELECT RAISE(ABORT, 'audit_log is append-only');
     END;
     CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
     BEFORE DELETE ON audit_log
     BEGIN
         SELECT RAISE(ABORT, 'audit_log is append-only');
     END;";

/// Every application-owned table whose rows Reset Everything must remove.
/// The delete SQL lives beside the classification so the schema-coverage test
/// cannot classify a table as reset-scoped without also wiring it into purge.
const RESET_SCOPED_TABLE_DELETES: [(&str, &str); 22] = [
    ("speaker_aliases", "DELETE FROM speaker_aliases"),
    ("transcript_fts", "DELETE FROM transcript_fts"),
    ("transcript_embeddings", "DELETE FROM transcript_embeddings"),
    ("transcript_artifacts", "DELETE FROM transcript_artifacts"),
    ("meeting_artifacts", "DELETE FROM meeting_artifacts"),
    ("insertion_actions", "DELETE FROM insertion_actions"),
    ("transcripts", "DELETE FROM transcripts"),
    (
        "recording_audio_operation_items",
        "DELETE FROM recording_audio_operation_items",
    ),
    (
        "recording_audio_operations",
        "DELETE FROM recording_audio_operations",
    ),
    (
        "recording_audio_assets",
        "DELETE FROM recording_audio_assets",
    ),
    ("recordings", "DELETE FROM recordings"),
    ("asr_benchmarks", "DELETE FROM asr_benchmarks"),
    ("runtime_events", "DELETE FROM runtime_events"),
    ("capture_sessions", "DELETE FROM capture_sessions"),
    ("context_snapshots", "DELETE FROM context_snapshots"),
    ("policy_snapshots", "DELETE FROM policy_snapshots"),
    (
        "dictation_dictionary_entries",
        "DELETE FROM dictation_dictionary_entries",
    ),
    ("dictation_snippets", "DELETE FROM dictation_snippets"),
    (
        "dictation_command_presets",
        "DELETE FROM dictation_command_presets",
    ),
    (
        "dictation_correction_suggestions",
        "DELETE FROM dictation_correction_suggestions",
    ),
    ("projects", "DELETE FROM projects"),
    ("audit_log", "DELETE FROM audit_log"),
];

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct AuditDetailScrubCounts {
    rows_scanned: usize,
    rows_updated: usize,
    malformed_rows: usize,
    sensitive_fields_removed: usize,
}

fn remove_sensitive_audit_detail_fields(value: &mut serde_json::Value) -> usize {
    match value {
        serde_json::Value::Object(object) => {
            let mut removed = 0;
            for key in SENSITIVE_AUDIT_DETAIL_KEYS {
                if object.remove(key).is_some() {
                    removed += 1;
                }
            }
            removed
                + object
                    .values_mut()
                    .map(remove_sensitive_audit_detail_fields)
                    .sum::<usize>()
        }
        serde_json::Value::Array(values) => values
            .iter_mut()
            .map(remove_sensitive_audit_detail_fields)
            .sum(),
        _ => 0,
    }
}

fn create_audit_log_append_only_triggers(conn: &Connection) -> Result<()> {
    conn.execute_batch(AUDIT_LOG_APPEND_ONLY_TRIGGER_SQL)
        .context("Failed to create audit log append-only triggers")
}

fn drop_audit_log_append_only_triggers(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DROP TRIGGER IF EXISTS audit_log_no_update;
         DROP TRIGGER IF EXISTS audit_log_no_delete;",
    )
    .context("Failed to temporarily disable audit log append-only triggers")
}

fn verify_audit_log_append_only_triggers(conn: &Connection) -> Result<()> {
    let trigger_count: i64 = conn.query_row(
        "SELECT COUNT(*)
         FROM sqlite_schema
         WHERE type = 'trigger'
           AND tbl_name = 'audit_log'
           AND name IN ('audit_log_no_update', 'audit_log_no_delete')",
        [],
        |row| row.get(0),
    )?;
    if trigger_count != 2 {
        anyhow::bail!(
            "Audit log append-only trigger verification failed: expected 2 triggers, found {}",
            trigger_count
        );
    }
    Ok(())
}

pub(crate) fn validate_plaintext_database_file(path: &Path) -> Result<()> {
    let conn = Connection::open(path)
        .with_context(|| format!("Failed to open restored database {}", path.display()))?;
    let schema_version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if schema_version > CURRENT_SCHEMA_VERSION {
        anyhow::bail!(
            "Restored database schema version {} is newer than this binary supports ({})",
            schema_version,
            CURRENT_SCHEMA_VERSION
        );
    }

    let mut stmt = conn.prepare("PRAGMA quick_check")?;
    let results = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if results.len() != 1 || results[0] != "ok" {
        anyhow::bail!(
            "Restored database quick_check failed: {}",
            results.join("; ")
        );
    }
    Ok(())
}

fn table_exists(conn: &Connection, table_name: &str) -> Result<bool> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1
         )",
        [table_name],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn insert_recording_row(
    conn: &Connection,
    recording: &Recording,
    primary_audio_path: &str,
) -> Result<()> {
    conn.execute(
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
            primary_audio_path,
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

/// Normalizes a dictionary/snippet `category_scope` value for persistence.
/// Trims whitespace, drops blank values (-> `None`, meaning "applies
/// regardless of category"), canonicalizes casing of the known category
/// keys (other/messaging/email/notes/worklog/ai_chat/code_editor), and
/// rejects unrecognized keys so a typo'd value (e.g. "ai chat" from a CSV
/// import) fails loudly instead of being stored and silently matching the
/// wrong apps.
fn normalize_category_scope(value: Option<&str>) -> Result<Option<String>> {
    let Some(trimmed) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let Some(category) = crate::settings::dictation_app_category_from_key_strict(trimmed) else {
        anyhow::bail!(
            "Unknown category scope '{}' (expected one of: other, messaging, email, notes, worklog, ai_chat, code_editor)",
            trimmed
        );
    };
    Ok(Some(
        crate::settings::dictation_app_category_to_key(category).to_string(),
    ))
}

fn validated_summary_provenance(
    raw: Option<String>,
    summary: Option<&str>,
) -> Option<AnalysisProvenance> {
    let provenance: AnalysisProvenance = serde_json::from_str(raw.as_deref()?).ok()?;
    let summary = summary?;
    (provenance.version == ANALYSIS_PROVENANCE_VERSION
        && provenance.content_hash == analysis_content_hash(summary))
    .then_some(provenance)
}

fn validated_action_items_provenance(
    raw: Option<String>,
    action_items: &[String],
) -> Option<ActionItemsProvenance> {
    let provenance: ActionItemsProvenance = serde_json::from_str(raw.as_deref()?).ok()?;
    let items_match = provenance.items.len() == action_items.len()
        && provenance
            .items
            .iter()
            .zip(action_items)
            .all(|(item_provenance, item)| {
                item_provenance.content_hash == analysis_content_hash(item)
            });
    (provenance.version == ANALYSIS_PROVENANCE_VERSION
        && provenance.content_hash == action_items_content_hash(action_items)
        && items_match)
        .then_some(provenance)
}

fn preserve_matching_action_item_provenance(
    previous: &ActionItemsProvenance,
    action_items: &[String],
) -> Option<ActionItemsProvenance> {
    let mut unmatched = previous.items.clone();
    let items = action_items
        .iter()
        .map(|item| {
            let content_hash = analysis_content_hash(item);
            unmatched
                .iter()
                .position(|candidate| candidate.content_hash == content_hash)
                .map(|index| unmatched.remove(index))
                .unwrap_or(ActionItemProvenance {
                    content_hash,
                    citations: Vec::new(),
                    grounded: false,
                    generated: false,
                })
        })
        .collect::<Vec<_>>();
    if !items.iter().any(|item| item.generated) {
        return None;
    }

    let mut seen = HashSet::new();
    let citations = items
        .iter()
        .filter(|item| item.generated)
        .flat_map(|item| item.citations.iter().cloned())
        .filter(|citation| {
            let key = serde_json::to_string(citation).unwrap_or_default();
            seen.insert(key)
        })
        .collect();
    let mut next = previous.clone();
    next.content_hash = action_items_content_hash(action_items);
    next.grounded = items.iter().all(|item| item.generated && item.grounded);
    next.citations = citations;
    next.items = items;
    Some(next)
}

pub struct Database {
    conn: Connection,
    encrypted: bool,
}

#[expect(
    dead_code,
    reason = "database module keeps migration and evidence-table helpers beyond current command usage"
)]
impl Database {
    /// Create new database connection with optional encryption
    pub fn new_with_key(key: Option<&str>) -> Result<Self> {
        let app_dir = crate::paths::data_dir()
            .context("Could not find data directory")?
            .join("Plainsong");

        fs::create_dir_all(&app_dir)?;
        Self::open_at_path(&app_dir.join("plainsong.db"), key)
    }

    pub(crate) fn open_at_path(db_path: &Path, key: Option<&str>) -> Result<Self> {
        let conn = Connection::open(db_path)?;

        // SQLCipher reports its library version even for an unkeyed plaintext
        // database, so encryption state must come from the successful key path.
        #[cfg(feature = "sqlcipher")]
        let encrypted = if let Some(key) = key {
            let hex_key = hex::encode(key.as_bytes());
            // Validate hex encoding to prevent SQL injection
            if !hex_key.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(anyhow::anyhow!("Invalid hex encoding in database key"));
            }
            conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", hex_key))?;
            // Reading sqlite_master proves that this key actually opened the
            // file. It has to be a query: rusqlite's `execute` refuses any
            // statement that returns rows, so the previous `execute` here made
            // every keyed open fail before the key was ever tested.
            conn.query_row("SELECT count(*) FROM sqlite_master;", [], |row| {
                row.get::<_, i64>(0)
            })?;
            true
        } else {
            false
        };
        #[cfg(not(feature = "sqlcipher"))]
        let encrypted = {
            let _ = key;
            false
        };

        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let mut db = Self { conn, encrypted };
        db.init_tables()?;

        Ok(db)
    }

    /// Create new database (default, no encryption)
    pub fn new() -> Result<Self> {
        Self::new_with_key(None)
    }

    /// The on-disk path `new_with_key` opens, without creating anything.
    pub(crate) fn default_db_path() -> Result<PathBuf> {
        Ok(crate::paths::data_dir()
            .context("Could not find data directory")?
            .join("Plainsong")
            .join("plainsong.db"))
    }

    /// Open an existing database file for reading only.
    ///
    /// This is the `plainsong` CLI / MCP path. It differs from `open_at_path`
    /// in every way that matters for a second process reading beside a live
    /// sidecar:
    ///
    /// - `SQLITE_OPEN_READ_ONLY`: the connection cannot write, so a bug in the
    ///   reader can never mutate user data, and no migration runs. A file that
    ///   does not exist is an error rather than a freshly created empty store.
    /// - `PRAGMA query_only = ON` as a second belt: even a statement that
    ///   slipped past the flag is refused by SQLite itself.
    /// - `busy_timeout`: the sidecar's writes hold the rollback journal for a
    ///   few milliseconds; a reader waits instead of failing with `SQLITE_BUSY`.
    /// - The schema version is checked but never bumped: a newer schema than
    ///   this binary knows is refused with a plain message.
    ///
    /// The key handling is identical to `open_at_path` so the two paths cannot
    /// drift: same hex-encoded `PRAGMA key`, same `sqlite_master` read that
    /// proves the key actually opened the file.
    pub(crate) fn open_read_only_at_path(db_path: &Path, key: Option<&str>) -> Result<Self> {
        use rusqlite::OpenFlags;

        if !db_path.is_file() {
            anyhow::bail!("No Plainsong database at {}", db_path.display());
        }
        let conn = Connection::open_with_flags(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .with_context(|| format!("Failed to open {} read-only", db_path.display()))?;

        #[cfg(feature = "sqlcipher")]
        let encrypted = if let Some(key) = key {
            let hex_key = hex::encode(key.as_bytes());
            if !hex_key.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(anyhow::anyhow!("Invalid hex encoding in database key"));
            }
            conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", hex_key))?;
            true
        } else {
            false
        };
        #[cfg(not(feature = "sqlcipher"))]
        let encrypted = {
            let _ = key;
            false
        };

        // Proves the key (or its absence) actually opened the file; an
        // encrypted database read without its key fails here, not on the
        // first real query.
        conn.query_row("SELECT count(*) FROM sqlite_master;", [], |row| {
            row.get::<_, i64>(0)
        })
        .context("Could not read the database; is the encryption key right?")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA query_only = ON;")?;

        let schema_version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if schema_version > CURRENT_SCHEMA_VERSION {
            anyhow::bail!(
                "Database schema version {} is newer than this binary supports ({})",
                schema_version,
                CURRENT_SCHEMA_VERSION
            );
        }

        Ok(Self { conn, encrypted })
    }

    #[cfg(test)]
    pub(crate) fn new_in_memory_for_test() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let mut db = Self {
            conn,
            encrypted: false,
        };
        db.init_tables()?;
        Ok(db)
    }

    /// Write a transactionally-consistent snapshot of the live database to
    /// `dest` using `VACUUM INTO`. Unlike a filesystem copy, this is safe to run
    /// while the database is open and possibly mid-write, and (under SQLCipher)
    /// produces an encrypted copy keyed with the same key as the live database.
    /// `dest` must not already exist.
    pub fn backup_to(&self, dest: &Path) -> Result<()> {
        if dest.exists() {
            std::fs::remove_file(dest)
                .with_context(|| format!("Failed to clear stale snapshot at {}", dest.display()))?;
        }
        // VACUUM INTO does not accept bind parameters for the target path, so the
        // path is inlined as a string literal with single quotes doubled.
        let dest_str = dest.to_string_lossy().replace('\'', "''");
        self.conn
            .execute_batch(&format!("VACUUM INTO '{}';", dest_str))
            .context("Failed to snapshot database via VACUUM INTO")?;
        Ok(())
    }

    /// Return the encryption state established by the successful open/rekey path.
    pub fn is_encrypted(&self) -> Result<bool> {
        Ok(self.encrypted)
    }

    /// Change database key (encrypt or re-encrypt)
    #[cfg(feature = "sqlcipher")]
    pub fn change_key(&mut self, new_key: &str) -> Result<()> {
        let hex_key = hex::encode(new_key.as_bytes());
        // Validate hex encoding to prevent SQL injection
        if !hex_key.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(anyhow::anyhow!("Invalid hex encoding in database key"));
        }
        self.conn
            .execute_batch(&format!("PRAGMA rekey = \"x'{}'\";", hex_key))?;
        // A query, not `execute`, for the same reason as in `open_at_path`.
        self.conn
            .query_row("SELECT count(*) FROM sqlite_master;", [], |row| {
                row.get::<_, i64>(0)
            })?;
        self.encrypted = true;
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
            .map(|mut details| {
                remove_sensitive_audit_detail_fields(&mut details);
                serde_json::to_string(&details)
            })
            .transpose()?
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
            let payload = match serde_json::from_str(&payload_json) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(
                        "Failed to parse runtime event payload for event {}: {}",
                        row.get::<_, i64>(0).unwrap_or(0),
                        e
                    );
                    serde_json::json!({})
                }
            };
            let created_at = match chrono::DateTime::parse_from_rfc3339(&created_at) {
                Ok(dt) => dt.with_timezone(&Utc),
                Err(e) => {
                    tracing::warn!(
                        "Failed to parse created_at for event {}: {}",
                        row.get::<_, i64>(0).unwrap_or(0),
                        e
                    );
                    Utc::now()
                }
            };
            Ok(RuntimeEventRecord {
                id: row.get(0)?,
                event_type: row.get(1)?,
                surface: row.get(2)?,
                session_id: row.get(3)?,
                recording_id: row.get(4)?,
                payload,
                created_at,
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

    /// Aggregate counters behind the Dictation insights panel.
    ///
    /// This replaces a per-recording loop that issued two extra queries for
    /// every dictation ever recorded — one for the transcript, one for the
    /// latest insertion action — and counted words by splitting the full
    /// transcript text in memory. Opening Dictation therefore got slower
    /// forever as history accumulated. SQLite does the whole thing here.
    pub fn get_dictation_insight_totals(&self) -> Result<DictationInsightTotals> {
        let mut totals = DictationInsightTotals::default();

        // Per-recording counters, including a word count taken from the stored
        // transcript text rather than by materializing it in Rust.
        let mut stmt = self.conn.prepare(
            "SELECT COUNT(*),
                    COALESCE(SUM(
                        CASE
                            WHEN t.full_text IS NULL OR TRIM(t.full_text) = '' THEN 0
                            ELSE LENGTH(TRIM(t.full_text))
                                 - LENGTH(REPLACE(TRIM(t.full_text), ' ', ''))
                                 + 1
                        END
                    ), 0),
                    COUNT(DISTINCT DATE(r.created_at)),
                    COALESCE(SUM(CASE WHEN r.created_at >= ?1 THEN 1 ELSE 0 END), 0)
             FROM recordings r
             LEFT JOIN transcripts t ON t.recording_id = r.id
             WHERE r.source_type = 'dictation'",
        )?;
        let cutoff = (chrono::Utc::now() - chrono::Duration::days(7)).to_rfc3339();
        let row: (i64, i64, i64, i64) = stmt.query_row(params![cutoff], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?;
        totals.total_dictations = row.0.max(0) as u64;
        totals.dictated_words = row.1.max(0) as u64;
        totals.active_days = row.2.max(0) as u64;
        totals.last_seven_days_dictations = row.3.max(0) as u64;

        // Insertion-action counters, scoped to the most recent action per
        // recording so a retried insert is not counted twice.
        let mut action_stmt = self.conn.prepare(
            "WITH latest AS (
                 SELECT ia.*,
                        ROW_NUMBER() OVER (
                            PARTITION BY ia.recording_id ORDER BY ia.created_at DESC, ia.id DESC
                        ) AS rn
                 FROM insertion_actions ia
                 JOIN recordings r ON r.id = ia.recording_id
                 WHERE r.source_type = 'dictation'
             )
             SELECT
                 COALESCE(SUM(CASE WHEN command_applied IS NOT NULL THEN 1 ELSE 0 END), 0),
                 COALESCE(SUM(CASE WHEN command_applied LIKE 'backtrack\\_%' ESCAPE '\\' THEN 1 ELSE 0 END), 0),
                 COALESCE(SUM(COALESCE(snippet_applied_count, 0)), 0)
             FROM latest WHERE rn = 1",
        )?;
        let action_row: (i64, i64, i64) =
            action_stmt.query_row([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        totals.commands_used = action_row.0.max(0) as u64;
        totals.backtracks_used = action_row.1.max(0) as u64;
        totals.snippets_triggered = action_row.2.max(0) as u64;

        // Most-used destination app.
        let mut app_stmt = self.conn.prepare(
            "WITH latest AS (
                 SELECT ia.recording_id, ia.app_target, ia.created_at, ia.id,
                        ROW_NUMBER() OVER (
                            PARTITION BY ia.recording_id ORDER BY ia.created_at DESC, ia.id DESC
                        ) AS rn
                 FROM insertion_actions ia
                 JOIN recordings r ON r.id = ia.recording_id
                 WHERE r.source_type = 'dictation'
             )
             SELECT TRIM(app_target), COUNT(*) AS uses
             FROM latest
             WHERE rn = 1 AND app_target IS NOT NULL AND TRIM(app_target) <> ''
             GROUP BY TRIM(app_target)
             ORDER BY uses DESC, TRIM(app_target) ASC
             LIMIT 1",
        )?;
        let mut app_rows = app_stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        if let Some(row) = app_rows.next() {
            let (app_target, uses) = row?;
            totals.top_app_target = Some(app_target);
            totals.top_app_target_count = uses.max(0) as u64;
        }

        Ok(totals)
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
                id, recording_id, title, summary, action_items, summary_provenance,
                action_items_provenance, decisions, deadlines, template_id, chat_messages,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(recording_id) DO UPDATE SET
                title = excluded.title,
                summary = excluded.summary,
                action_items = excluded.action_items,
                summary_provenance = excluded.summary_provenance,
                action_items_provenance = excluded.action_items_provenance,
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
                artifact
                    .summary_provenance
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                artifact
                    .action_items_provenance
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
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
            "SELECT id, recording_id, title, summary, action_items, summary_provenance,
                    action_items_provenance, decisions, deadlines, template_id, chat_messages,
                    created_at, updated_at
             FROM meeting_artifacts
             WHERE recording_id = ?1",
        )?;
        let result = stmt.query_row([recording_id], |row| {
            let action_items_json: String = row.get(4)?;
            let action_items: Vec<String> =
                serde_json::from_str(&action_items_json).unwrap_or_default();
            let summary: Option<String> = row.get(3)?;
            let decisions_json: String = row.get(7)?;
            let deadlines_json: String = row.get(8)?;
            let chat_messages_json: String = row.get(10)?;
            let created_at: String = row.get(11)?;
            let updated_at: String = row.get(12)?;
            Ok(MeetingArtifactRecord {
                id: row.get(0)?,
                recording_id: row.get(1)?,
                title: row.get(2)?,
                summary_provenance: validated_summary_provenance(row.get(5)?, summary.as_deref()),
                action_items_provenance: validated_action_items_provenance(
                    row.get(6)?,
                    &action_items,
                ),
                summary,
                action_items,
                decisions: serde_json::from_str(&decisions_json).unwrap_or_default(),
                deadlines: serde_json::from_str(&deadlines_json).unwrap_or_default(),
                template_id: row.get(9)?,
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

    fn init_tables(&mut self) -> Result<()> {
        let schema_version: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if schema_version > CURRENT_SCHEMA_VERSION {
            anyhow::bail!(
                "Database schema version {} is newer than this binary supports ({})",
                schema_version,
                CURRENT_SCHEMA_VERSION
            );
        }

        self.conn.execute_batch("BEGIN IMMEDIATE;")?;
        let migration_result = self.init_schema_v1().and_then(|_| {
            if schema_version < CURRENT_SCHEMA_VERSION {
                self.conn.execute_batch(&format!(
                    "PRAGMA user_version = {};",
                    CURRENT_SCHEMA_VERSION
                ))?;
            }
            Ok(())
        });
        if let Err(error) = migration_result {
            let _ = self.conn.execute_batch("ROLLBACK;");
            return Err(error);
        }
        if let Err(error) = self.conn.execute_batch("COMMIT;") {
            let _ = self.conn.execute_batch("ROLLBACK;");
            return Err(error.into());
        }

        // These potentially expensive data maintenance passes are not schema
        // migrations. Run them only after the versioned DDL has committed so a
        // crash cannot leave user_version claiming a partially-created schema.
        if table_exists(&self.conn, "transcript_fts")? {
            if let Err(error) = self.backfill_transcript_fts_if_needed() {
                tracing::warn!(
                    "Failed to run transcript_fts startup backfill check: {}",
                    error
                );
            }
        }
        self.scrub_sensitive_audit_details()?;
        Ok(())
    }

    fn init_schema_v1(&mut self) -> Result<()> {
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
            "CREATE TABLE IF NOT EXISTS recording_audio_assets (
                recording_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('primary', 'mic', 'system')),
                path TEXT NOT NULL CHECK (TRIM(path) <> ''),
                lifecycle TEXT NOT NULL DEFAULT 'planned'
                    CHECK (lifecycle IN ('planned', 'writing', 'ready', 'missing', 'failed')),
                protection TEXT NOT NULL DEFAULT 'plaintext'
                    CHECK (protection IN ('plaintext', 'encrypted')),
                plaintext_bytes INTEGER CHECK (plaintext_bytes IS NULL OR plaintext_bytes >= 0),
                plaintext_sha256 TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (recording_id, role)
            )",
            [],
        )?;
        self.conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_recording_audio_assets_path
             ON recording_audio_assets(path)",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_recording_audio_assets_reconcile
             ON recording_audio_assets(lifecycle, updated_at)",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_recording_audio_assets_ready_protection
             ON recording_audio_assets(protection, recording_id)
             WHERE lifecycle = 'ready'",
            [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS recording_audio_operations (
                id TEXT PRIMARY KEY,
                recording_id TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind = 'encrypt'),
                state TEXT NOT NULL
                    CHECK (state IN ('prepared', 'outputs_synced', 'published', 'db_switched', 'cleanup_pending', 'complete', 'failed')),
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;
        self.conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_recording_audio_operations_one_open
             ON recording_audio_operations(recording_id, kind)
             WHERE state <> 'complete'",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_recording_audio_operations_reconcile
             ON recording_audio_operations(state, updated_at)",
            [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS recording_audio_operation_items (
                operation_id TEXT NOT NULL,
                recording_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('primary', 'mic', 'system')),
                source_path TEXT NOT NULL,
                staged_path TEXT NOT NULL,
                target_path TEXT NOT NULL,
                plaintext_bytes INTEGER NOT NULL CHECK (plaintext_bytes >= 0),
                plaintext_sha256 TEXT NOT NULL,
                state TEXT NOT NULL
                    CHECK (state IN ('prepared', 'staged', 'published', 'switched', 'cleaned', 'failed')),
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (operation_id, recording_id, role),
                UNIQUE (operation_id, target_path)
            )",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_recording_audio_operation_items_state
             ON recording_audio_operation_items(operation_id, state)",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_recording_audio_operation_items_recording
             ON recording_audio_operation_items(recording_id, role)",
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
                created_at TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 0
            )",
            [],
        )?;

        // Legacy databases predate these columns. Check table metadata first so
        // only the expected duplicate-column case is treated as already migrated;
        // disk, lock, and malformed-schema errors must abort the transaction.
        self.ensure_table_column("transcripts", "model_id", "TEXT")?;
        self.ensure_table_column("transcripts", "requested_provider", "TEXT")?;
        self.ensure_table_column("transcripts", "actual_provider", "TEXT")?;
        self.ensure_table_column("transcripts", "revision", "INTEGER NOT NULL DEFAULT 0")?;
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
                created_at TEXT NOT NULL,
                FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
            )",
            [],
        )?;
        self.ensure_recording_evidence_foreign_keys("transcript_artifacts")?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_transcript_artifacts_recording_created_at
             ON transcript_artifacts(recording_id, created_at DESC)",
            [],
        )?;
        let repaired_dictation_durations = self.repair_legacy_dictation_durations()?;
        if repaired_dictation_durations > 0 {
            tracing::info!(
                repaired_dictation_durations,
                "Repaired legacy dictation durations that were stored as WAV byte counts"
            );
        }

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
                created_at TEXT NOT NULL,
                FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
            )",
            [],
        )?;
        self.ensure_table_column("insertion_actions", "app_target", "TEXT")?;
        self.ensure_recording_evidence_foreign_keys("insertion_actions")?;
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
                summary_provenance TEXT,
                action_items_provenance TEXT,
                decisions TEXT NOT NULL,
                deadlines TEXT NOT NULL,
                template_id TEXT,
                chat_messages TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;
        self.ensure_table_column(
            "meeting_artifacts",
            "chat_messages",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        self.ensure_table_column("meeting_artifacts", "summary_provenance", "TEXT")?;
        self.ensure_table_column("meeting_artifacts", "action_items_provenance", "TEXT")?;
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
        self.ensure_table_column(
            "asr_benchmarks",
            "non_empty_transcript",
            "INTEGER NOT NULL DEFAULT 0",
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS dictation_dictionary_entries (
                id TEXT PRIMARY KEY,
                spoken_form TEXT NOT NULL,
                replacement TEXT NOT NULL,
                app_scope TEXT,
                case_sensitive INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                category_scope TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;
        self.ensure_table_column("dictation_dictionary_entries", "category_scope", "TEXT")?;
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
                category_scope TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;
        self.ensure_table_column("dictation_snippets", "category_scope", "TEXT")?;
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
        // Where the suggestion came from: an edit the user made inside
        // Plainsong, or one read back out of the app the text was inserted
        // into. Rows written before this column existed are the former, which
        // is what a NULL reads as.
        self.ensure_table_column("dictation_correction_suggestions", "source", "TEXT")?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_dictation_correction_suggestions_spoken_form
             ON dictation_correction_suggestions(spoken_form)",
            [],
        )?;

        // Use FTS5 for cross-recording transcript retrieval. Some SQLite builds
        // omit FTS5, so this optional index remains the one schema capability
        // whose absence degrades search rather than preventing database startup.
        if let Err(error) = self.conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
                recording_id UNINDEXED,
                segment_id UNINDEXED,
                text,
                start_time UNINDEXED,
                end_time UNINDEXED
            )",
            [],
        ) {
            tracing::warn!(
                "transcript_fts table unavailable; cross-recording search will be limited: {}",
                error
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
            "INSERT OR IGNORE INTO projects (id, name, description, created_at, updated_at) 
             VALUES ('default', 'Inbox', 'Default inbox for new recordings', ?1, ?1)",
            [Utc::now().to_rfc3339()],
        )?;
        self.conn.execute(
            "INSERT OR IGNORE INTO projects (id, name, description, created_at, updated_at) 
             VALUES ('inbox', 'Inbox', 'Default inbox for new recordings', ?1, ?1)",
            [Utc::now().to_rfc3339()],
        )?;

        self.ensure_table_column("recordings", "summary", "TEXT")?;
        self.ensure_table_column("recordings", "action_items", "TEXT")?;
        self.ensure_table_column("recordings", "meeting_notes", "TEXT")?;
        self.ensure_table_column("recordings", "meeting_template_id", "TEXT")?;
        self.ensure_table_column("recordings", "notes_updated_at", "TEXT")?;
        self.ensure_table_column("recordings", "meeting_capture_mode", "TEXT")?;
        self.ensure_table_column(
            "recordings",
            "consent_prompt_shown",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        self.ensure_table_column("recordings", "consent_notice_mode", "TEXT")?;
        self.ensure_table_column("recordings", "consent_notice_surface", "TEXT")?;
        self.ensure_table_column("recordings", "consent_notice_message", "TEXT")?;
        self.ensure_table_column("recordings", "consent_notice_updated_at", "TEXT")?;
        // Durable record of the last automatic-analysis failure. Without it the
        // meeting AI lane failed with only a `tracing::warn!`, so a default
        // install pointed at an uninstalled Ollama produced no summary, no
        // action items, and no title, and the app said nothing at all.
        self.ensure_table_column("recordings", "analysis_failure", "TEXT")?;

        // Chunked meeting transcription survives per-chunk ASR failures and
        // still returns a transcript, so "completed" alone never meant "the
        // whole meeting was transcribed". That distinction only lived in an
        // in-memory `fallback_reason` and an emitted event, which is not
        // something a storage sweep running hours later can consult — so the
        // transcript-only sweep happily deleted the audio of meetings the code
        // already knew were partially transcribed. It is a column now.
        //
        // Defaulting to 1 is the honest choice for rows written before this
        // existed: they were completed by the same code path and nothing
        // recorded a degradation, so treating them as suspect would refuse
        // retention on an entire back catalogue with no evidence.
        self.ensure_table_column(
            "recordings",
            "transcript_complete",
            "INTEGER NOT NULL DEFAULT 1",
        )?;
        self.ensure_table_column("recordings", "transcript_degraded_reason", "TEXT")?;
        // Set when the user has been told the transcript is incomplete and
        // chose to let storage policy delete the audio anyway. Deliberately
        // separate from `transcript_complete`: acknowledging is a decision
        // about deletion, not a claim that the missing words came back.
        self.ensure_table_column(
            "recordings",
            "transcript_incomplete_acknowledged_at",
            "TEXT",
        )?;
        // A starved capture source is padded with silence so the mixed and
        // per-source WAVs stay frame-aligned, which makes "the microphone was
        // gone" and "nobody spoke" identical in the file. This is where the
        // difference is written down, at stop, so the meeting record carries the
        // caveat instead of the audio quietly implying a complete capture.
        self.ensure_table_column("recordings", "capture_degraded_summary", "TEXT")?;

        Ok(())
    }

    fn repair_legacy_dictation_durations(&self) -> Result<usize> {
        let repaired = self.conn.execute(
            "UPDATE recordings
             SET duration = (
                 SELECT MAX(
                     1,
                     CAST(
                         ROUND(
                             (
                                 latest.end_to_end_ms
                                 - COALESCE(latest.transcription_latency_ms, 0)
                                 - COALESCE(latest.insert_latency_ms, 0)
                             ) / 1000.0
                         ) AS INTEGER
                     )
                 )
                 FROM (
                     SELECT
                         end_to_end_ms,
                         transcription_latency_ms,
                         insert_latency_ms
                     FROM transcript_artifacts
                     WHERE recording_id = recordings.id
                       AND end_to_end_ms IS NOT NULL
                       AND (
                           end_to_end_ms
                           - COALESCE(transcription_latency_ms, 0)
                           - COALESCE(insert_latency_ms, 0)
                       ) BETWEEN 500 AND ?2
                     ORDER BY created_at DESC
                     LIMIT 1
                 ) AS latest
             )
             WHERE source_type = 'dictation'
               AND duration >= ?1
               AND EXISTS (
                   SELECT 1
                   FROM transcript_artifacts
                   WHERE recording_id = recordings.id
                     AND end_to_end_ms IS NOT NULL
                     AND (
                         end_to_end_ms
                         - COALESCE(transcription_latency_ms, 0)
                         - COALESCE(insert_latency_ms, 0)
                     ) BETWEEN 500 AND ?2
               )",
            params![
                LEGACY_DICTATION_BYTE_COUNT_FLOOR,
                MAX_REPAIRABLE_DICTATION_CAPTURE_MS
            ],
        )?;
        Ok(repaired)
    }

    fn scrub_sensitive_audit_details(&mut self) -> Result<AuditDetailScrubCounts> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("Failed to start audit detail startup scrub transaction")?;
        drop_audit_log_append_only_triggers(&tx)?;

        let audit_rows = {
            let mut stmt = tx.prepare(
                "SELECT rowid, typeof(details), CAST(details AS BLOB)
                 FROM audit_log
                 WHERE details IS NOT NULL",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };

        let mut counts = AuditDetailScrubCounts {
            rows_scanned: audit_rows.len(),
            ..AuditDetailScrubCounts::default()
        };
        for (rowid, storage_class, raw_details) in audit_rows {
            if storage_class != "text" {
                counts.malformed_rows += 1;
                continue;
            }
            let Ok(details_json) = std::str::from_utf8(&raw_details) else {
                counts.malformed_rows += 1;
                continue;
            };
            let mut details = match serde_json::from_str::<serde_json::Value>(details_json) {
                Ok(details) => details,
                Err(_) => {
                    counts.malformed_rows += 1;
                    continue;
                }
            };
            let removed = remove_sensitive_audit_detail_fields(&mut details);
            if removed == 0 {
                continue;
            }

            let scrubbed_json = serde_json::to_string(&details)?;
            let updated = tx.execute(
                "UPDATE audit_log SET details = ?1 WHERE rowid = ?2",
                params![scrubbed_json, rowid],
            )?;
            if updated != 1 {
                anyhow::bail!(
                    "Audit detail startup scrub updated an unexpected number of rows: {}",
                    updated
                );
            }
            counts.rows_updated += 1;
            counts.sensitive_fields_removed += removed;
        }

        create_audit_log_append_only_triggers(&tx)?;
        verify_audit_log_append_only_triggers(&tx)?;
        tx.commit()
            .context("Failed to commit audit detail startup scrub")?;

        tracing::info!(
            rows_scanned = counts.rows_scanned,
            rows_updated = counts.rows_updated,
            malformed_rows = counts.malformed_rows,
            sensitive_fields_removed = counts.sensitive_fields_removed,
            "Completed audit detail startup scrub"
        );
        Ok(counts)
    }

    fn ensure_table_column(
        &self,
        table_name: &str,
        column_name: &str,
        column_definition: &str,
    ) -> Result<()> {
        if !table_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            || !column_name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            anyhow::bail!("Invalid SQLite identifier in migration");
        }
        let mut stmt = self
            .conn
            .prepare(&format!("PRAGMA table_info({})", table_name))?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let existing: String = row.get(1)?;
            if existing == column_name {
                return Ok(());
            }
        }
        drop(rows);
        drop(stmt);
        self.conn.execute(
            &format!(
                "ALTER TABLE {} ADD COLUMN {} {}",
                table_name, column_name, column_definition
            ),
            [],
        )?;
        Ok(())
    }

    fn ensure_recording_evidence_foreign_keys(&self, table_name: &str) -> Result<()> {
        let has_cascade = {
            let mut stmt = self
                .conn
                .prepare(&format!("PRAGMA foreign_key_list({})", table_name))?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(6)?,
                ))
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
                .into_iter()
                .any(|(parent, from, on_delete)| {
                    parent == "recordings"
                        && from == "recording_id"
                        && on_delete.eq_ignore_ascii_case("cascade")
                })
        };
        if has_cascade {
            return Ok(());
        }

        // SQLite cannot add a foreign key with ALTER TABLE. Remove already-
        // orphaned evidence and rebuild these two small append-only tables so
        // future parent deletes are enforced atomically by the engine.
        match table_name {
            "transcript_artifacts" => self.conn.execute_batch(
                "DELETE FROM transcript_artifacts
                   WHERE NOT EXISTS (
                       SELECT 1 FROM recordings
                       WHERE recordings.id = transcript_artifacts.recording_id
                   );
                 CREATE TABLE transcript_artifacts_v1 (
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
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
                 );
                 INSERT INTO transcript_artifacts_v1
                    SELECT * FROM transcript_artifacts;
                 DROP TABLE transcript_artifacts;
                 ALTER TABLE transcript_artifacts_v1 RENAME TO transcript_artifacts;",
            )?,
            "insertion_actions" => self.conn.execute_batch(
                "DELETE FROM insertion_actions
                   WHERE recording_id IS NOT NULL
                     AND NOT EXISTS (
                         SELECT 1 FROM recordings
                         WHERE recordings.id = insertion_actions.recording_id
                     );
                 CREATE TABLE insertion_actions_v1 (
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
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
                 );
                 INSERT INTO insertion_actions_v1
                    SELECT * FROM insertion_actions;
                 DROP TABLE insertion_actions;
                 ALTER TABLE insertion_actions_v1 RENAME TO insertion_actions;",
            )?,
            _ => anyhow::bail!("Unsupported recording evidence table migration"),
        }
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
            "ALTER TABLE transcripts RENAME TO transcripts_legacy_fallback;
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
                created_at TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 0
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
                created_at,
                revision
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
                created_at,
                revision
             FROM transcripts_legacy_fallback;
             DROP TABLE transcripts_legacy_fallback;",
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
                    CASE
                        WHEN recordings.action_items IS NULL
                         AND meeting_artifacts.action_items = '[]'
                         AND meeting_artifacts.action_items_provenance IS NULL
                        THEN NULL
                        ELSE COALESCE(meeting_artifacts.action_items, recordings.action_items)
                    END,
                    recordings.meeting_notes,
                    COALESCE(meeting_artifacts.template_id, recordings.meeting_template_id),
                    recordings.meeting_capture_mode,
                    recordings.notes_updated_at,
                    recordings.consent_prompt_shown,
                    recordings.consent_notice_mode,
                    recordings.consent_notice_surface,
                    recordings.consent_notice_message,
                    recordings.consent_notice_updated_at,
                    meeting_artifacts.summary_provenance,
                    meeting_artifacts.action_items_provenance,
                    recordings.analysis_failure
             FROM recordings
             LEFT JOIN meeting_artifacts ON meeting_artifacts.recording_id = recordings.id
             WHERE (?1 IS NULL OR recordings.project_id = ?1)
             ORDER BY recordings.created_at DESC",
        )?;

        let pid_param: Option<&str> = project_id;

        let recordings = stmt.query_map(params![pid_param], |row| {
            let summary: Option<String> = row.get(9)?;
            let action_items_json: Option<String> = row.get(10)?;
            let action_items: Option<Vec<String>> =
                action_items_json.and_then(|s| serde_json::from_str(&s).ok());
            let summary_provenance = validated_summary_provenance(row.get(20)?, summary.as_deref());
            let action_items_provenance = validated_action_items_provenance(
                row.get(21)?,
                action_items.as_deref().unwrap_or_default(),
            );
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
                summary,
                action_items,
                summary_provenance,
                action_items_provenance,
                meeting_notes: row.get(11)?,
                meeting_template_id: row.get(12)?,
                meeting_capture_mode: row.get(13)?,
                notes_updated_at,
                consent_prompt_shown: row.get::<_, i64>(15).unwrap_or(0) != 0,
                consent_notice_mode: row.get(16)?,
                consent_notice_surface: row.get(17)?,
                consent_notice_message: row.get(18)?,
                consent_notice_updated_at,
                analysis_failure: row
                    .get::<_, Option<String>>(22)?
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
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
                    CASE
                        WHEN recordings.action_items IS NULL
                         AND meeting_artifacts.action_items = '[]'
                         AND meeting_artifacts.action_items_provenance IS NULL
                        THEN NULL
                        ELSE COALESCE(meeting_artifacts.action_items, recordings.action_items)
                    END,
                    recordings.meeting_notes,
                    COALESCE(meeting_artifacts.template_id, recordings.meeting_template_id),
                    recordings.meeting_capture_mode,
                    recordings.notes_updated_at,
                    recordings.consent_prompt_shown,
                    recordings.consent_notice_mode,
                    recordings.consent_notice_surface,
                    recordings.consent_notice_message,
                    recordings.consent_notice_updated_at,
                    meeting_artifacts.summary_provenance,
                    meeting_artifacts.action_items_provenance,
                    recordings.analysis_failure
             FROM recordings
             LEFT JOIN meeting_artifacts ON meeting_artifacts.recording_id = recordings.id
             WHERE recordings.id = ?1",
        )?;

        let result = stmt.query_row([recording_id], |row| {
            let summary: Option<String> = row.get(9)?;
            let action_items_json: Option<String> = row.get(10)?;
            let action_items: Option<Vec<String>> =
                action_items_json.and_then(|s| serde_json::from_str(&s).ok());
            let summary_provenance = validated_summary_provenance(row.get(20)?, summary.as_deref());
            let action_items_provenance = validated_action_items_provenance(
                row.get(21)?,
                action_items.as_deref().unwrap_or_default(),
            );
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
                summary,
                action_items,
                summary_provenance,
                action_items_provenance,
                meeting_notes: row.get(11)?,
                meeting_template_id: row.get(12)?,
                meeting_capture_mode: row.get(13)?,
                notes_updated_at,
                consent_prompt_shown: row.get::<_, i64>(15).unwrap_or(0) != 0,
                consent_notice_mode: row.get(16)?,
                consent_notice_surface: row.get(17)?,
                consent_notice_message: row.get(18)?,
                consent_notice_updated_at,
                analysis_failure: row
                    .get::<_, Option<String>>(22)?
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
            })
        });

        match result {
            Ok(recording) => Ok(Some(recording)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Count ready owned audio assets and how many are protected ciphertext, as
    /// `(encrypted, stored)`. The field name remains renderer-compatible even
    /// though the unit is now files rather than recording rows.
    pub fn count_encrypted_recordings(&self) -> Result<(i64, i64)> {
        let stored: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM recording_audio_assets WHERE lifecycle = 'ready'",
            [],
            |row| row.get(0),
        )?;
        let encrypted: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM recording_audio_assets
             WHERE lifecycle = 'ready' AND protection = 'encrypted'",
            [],
            |row| row.get(0),
        )?;
        Ok((encrypted, stored))
    }

    pub fn has_open_recording_audio_operations(&self) -> Result<bool> {
        self.conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM recording_audio_operations WHERE state <> 'complete'
                 )",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub fn recording_audio_encryption_incomplete(&self) -> Result<bool> {
        self.conn
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM recording_audio_assets
                     WHERE lifecycle = 'ready' AND protection = 'plaintext'
                     UNION ALL
                     SELECT 1 FROM recording_audio_operations WHERE state <> 'complete'
                 )",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub fn recording_ids_with_ready_plaintext_audio(&self) -> Result<Vec<String>> {
        let mut statement = self.conn.prepare(
            "SELECT DISTINCT recording_id
             FROM recording_audio_assets
             WHERE lifecycle = 'ready' AND protection = 'plaintext'
             ORDER BY recording_id",
        )?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_transcript(&self, recording_id: &str) -> Result<Option<Transcript>> {
        Ok(self
            .get_transcript_with_revision(recording_id)?
            .map(|(transcript, _revision)| transcript))
    }

    pub fn get_transcript_with_revision(
        &self,
        recording_id: &str,
    ) -> Result<Option<(Transcript, i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, recording_id, segments, full_text, language, confidence, model, model_id, requested_provider, actual_provider, created_at, revision
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

            let transcript = Transcript {
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
            };
            Ok((transcript, row.get(11)?))
        });

        match result {
            Ok(transcript) => Ok(Some(transcript)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn create_recording(&mut self, recording: &Recording) -> Result<()> {
        insert_recording_row(&self.conn, recording, &recording.audio_path)
    }

    /// Atomically persist a completed dictation row and its transcript before
    /// any cursor delivery starts. If transcript serialization, FTS rebuild,
    /// or either database write fails, the recording row is rolled back too,
    /// so history can never expose a transcript-less completed dictation.
    pub fn create_recording_with_transcript(
        &mut self,
        recording: &Recording,
        transcript: &Transcript,
    ) -> Result<()> {
        if recording.id != transcript.recording_id {
            anyhow::bail!(
                "Recording id '{}' does not match transcript recording id '{}'",
                recording.id,
                transcript.recording_id
            );
        }

        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("Failed to start dictation result transaction")?;
        insert_recording_row(&tx, recording, &recording.audio_path)?;
        Self::write_transcript_transaction(&tx, transcript)?;
        tx.commit()
            .context("Failed to commit dictation recording and transcript")?;
        Ok(())
    }

    /// Atomically persist a renderer-compatible recording row and every enabled
    /// audio asset before capture is allowed to create a file or play a stream.
    pub fn create_recording_with_audio_plan(
        &mut self,
        recording: &Recording,
        plan: &RecordingCapturePlan,
    ) -> Result<()> {
        if recording.id != plan.recording_id {
            anyhow::bail!(
                "Recording id '{}' does not match capture plan '{}'",
                recording.id,
                plan.recording_id
            );
        }
        let now = Utc::now().to_rfc3339();
        let primary_path = plan.primary_path.to_string_lossy().to_string();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("Failed to start recording audio plan transaction")?;
        tx.execute(
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
                &primary_path,
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
        for (role, path) in plan.paths() {
            tx.execute(
                "INSERT INTO recording_audio_assets (
                    recording_id, role, path, lifecycle, protection, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, 'planned', 'plaintext', ?4, ?4)",
                params![
                    &recording.id,
                    role.as_str(),
                    path.to_string_lossy().as_ref(),
                    &now
                ],
            )?;
        }
        tx.commit()
            .context("Failed to commit recording audio plan transaction")?;
        Ok(())
    }

    pub fn load_recording_audio_bundle(&self, recording_id: &str) -> Result<RecordingAudioBundle> {
        let mut statement = self.conn.prepare(
            "SELECT role, path, lifecycle, protection, plaintext_bytes,
                    plaintext_sha256, last_error
             FROM recording_audio_assets
             WHERE recording_id = ?1
             ORDER BY CASE role WHEN 'primary' THEN 0 WHEN 'mic' THEN 1 ELSE 2 END",
        )?;
        let rows = statement.query_map(params![recording_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })?;

        let mut bundle = RecordingAudioBundle::empty(recording_id);
        for row in rows {
            let (role, path, lifecycle, protection, plaintext_bytes, plaintext_sha256, last_error) =
                row?;
            bundle.insert(RecordingAudioAsset {
                recording_id: recording_id.to_string(),
                role: RecordingAudioRole::from_str(&role)?,
                path: path.into(),
                lifecycle: RecordingAudioLifecycle::from_str(&lifecycle)?,
                protection: RecordingAudioProtection::from_str(&protection)?,
                plaintext_bytes: plaintext_bytes.and_then(|value| u64::try_from(value).ok()),
                plaintext_sha256,
                last_error,
            })?;
        }
        Ok(bundle)
    }

    /// Recordings that own at least one audio asset stuck in a non-terminal or
    /// condemned state.
    ///
    /// `writing` means a writer thread never got to finish; `failed` means some
    /// path decided the file was unusable. Both are worth re-checking against
    /// the filesystem at startup, including for meetings that already carry a
    /// terminal `error` status — that is exactly the case a stop-time failure
    /// leaves behind, and nothing else would ever look at it again.
    pub fn recording_ids_with_unsettled_audio_assets(&self) -> Result<Vec<String>> {
        let mut statement = self.conn.prepare(
            "SELECT DISTINCT recording_id FROM recording_audio_assets
             WHERE lifecycle IN ('writing', 'failed')",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn mark_audio_assets_writing(&mut self, recording_id: &str) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let asset_count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM recording_audio_assets WHERE recording_id = ?1",
            params![recording_id],
            |row| row.get(0),
        )?;
        if asset_count == 0 {
            anyhow::bail!("Recording '{}' has no planned audio assets", recording_id);
        }
        tx.execute(
            "UPDATE recording_audio_assets
             SET lifecycle = 'writing', last_error = NULL, updated_at = ?1
             WHERE recording_id = ?2 AND lifecycle = 'planned'",
            params![&now, recording_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Commit a finished capture: every validated asset, the duration, the new
    /// status, and how degraded the capture itself was — in one transaction.
    ///
    /// `capture_degraded_summary` is `None` for a clean capture and clears any
    /// previous value, so a re-finalized recording never keeps a stale caveat.
    pub fn finalize_recording_audio(
        &mut self,
        recording_id: &str,
        validated: &[(RecordingAudioRole, ValidatedRecordingAudio)],
        duration_seconds: i64,
        recording_status: &str,
        capture_degraded_summary: Option<&str>,
    ) -> Result<()> {
        if !validated
            .iter()
            .any(|(role, _)| *role == RecordingAudioRole::Primary)
        {
            anyhow::bail!(
                "Recording '{}' has no validated primary audio",
                recording_id
            );
        }
        let now = Utc::now().to_rfc3339();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for (role, metadata) in validated {
            let updated = tx.execute(
                "UPDATE recording_audio_assets
                 SET lifecycle = 'ready', protection = 'plaintext', plaintext_bytes = ?1,
                     plaintext_sha256 = ?2, last_error = NULL, updated_at = ?3
                 WHERE recording_id = ?4 AND role = ?5",
                params![
                    i64::try_from(metadata.plaintext_bytes)
                        .context("Recording audio file is too large for SQLite metadata")?,
                    &metadata.plaintext_sha256,
                    &now,
                    recording_id,
                    role.as_str()
                ],
            )?;
            if updated != 1 {
                anyhow::bail!(
                    "Recording '{}' has no planned '{}' audio asset",
                    recording_id,
                    role.as_str()
                );
            }
        }
        let primary_path: String = tx.query_row(
            "SELECT path FROM recording_audio_assets
             WHERE recording_id = ?1 AND role = 'primary' AND lifecycle = 'ready'",
            params![recording_id],
            |row| row.get(0),
        )?;
        let updated = tx.execute(
            "UPDATE recordings
             SET audio_path = ?1, duration = ?2, status = ?3,
                 capture_degraded_summary = ?4, updated_at = ?5
             WHERE id = ?6",
            params![
                primary_path,
                duration_seconds,
                recording_status,
                capture_degraded_summary,
                &now,
                recording_id
            ],
        )?;
        if updated != 1 {
            anyhow::bail!("Recording '{}' was not found", recording_id);
        }
        tx.commit()?;
        Ok(())
    }

    /// The capture caveat stored for one meeting, if any.
    pub fn get_capture_degraded_summary(&self, recording_id: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT capture_degraded_summary FROM recordings WHERE id = ?1",
                params![recording_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    pub fn set_audio_asset_validation_states(
        &mut self,
        recording_id: &str,
        updates: &[(
            RecordingAudioRole,
            RecordingAudioLifecycle,
            Option<ValidatedRecordingAudio>,
            Option<String>,
        )],
        recording_status: &str,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for (role, lifecycle, metadata, last_error) in updates {
            let plaintext_bytes = metadata
                .as_ref()
                .map(|metadata| i64::try_from(metadata.plaintext_bytes))
                .transpose()
                .context("Recording audio file is too large for SQLite metadata")?;
            let plaintext_sha256 = metadata
                .as_ref()
                .map(|metadata| metadata.plaintext_sha256.as_str());
            let updated = tx.execute(
                "UPDATE recording_audio_assets
                 SET lifecycle = ?1, plaintext_bytes = ?2, plaintext_sha256 = ?3,
                     last_error = ?4, updated_at = ?5
                 WHERE recording_id = ?6 AND role = ?7",
                params![
                    lifecycle.as_str(),
                    plaintext_bytes,
                    plaintext_sha256,
                    last_error,
                    &now,
                    recording_id,
                    role.as_str()
                ],
            )?;
            if updated != 1 {
                anyhow::bail!(
                    "Recording '{}' has no '{}' audio asset",
                    recording_id,
                    role.as_str()
                );
            }
        }
        tx.execute(
            "UPDATE recordings SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![recording_status, &now, recording_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Repair asset lifecycles from a fresh filesystem probe, in one transaction
    /// with an optional recording-status write.
    ///
    /// Unlike [`Self::set_audio_asset_validation_states`] this never clears the
    /// stored plaintext length and hash when the caller has none to offer. An
    /// encrypted asset cannot be re-measured without the vault key, and dropping
    /// its recorded metadata would silently disable the integrity comparison
    /// every runtime resolve makes against it.
    ///
    /// `recording_status` is `None` for repairs that are evidence about files
    /// only and must not restate what happened to the meeting itself.
    pub fn repair_audio_asset_lifecycles(
        &mut self,
        recording_id: &str,
        updates: &[(
            RecordingAudioRole,
            RecordingAudioLifecycle,
            Option<ValidatedRecordingAudio>,
            Option<String>,
        )],
        recording_status: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for (role, lifecycle, metadata, last_error) in updates {
            let plaintext_bytes = metadata
                .as_ref()
                .map(|metadata| i64::try_from(metadata.plaintext_bytes))
                .transpose()
                .context("Recording audio file is too large for SQLite metadata")?;
            let plaintext_sha256 = metadata
                .as_ref()
                .map(|metadata| metadata.plaintext_sha256.as_str());
            let updated = tx.execute(
                "UPDATE recording_audio_assets
                 SET lifecycle = ?1,
                     plaintext_bytes = COALESCE(?2, plaintext_bytes),
                     plaintext_sha256 = COALESCE(?3, plaintext_sha256),
                     last_error = ?4, updated_at = ?5
                 WHERE recording_id = ?6 AND role = ?7",
                params![
                    lifecycle.as_str(),
                    plaintext_bytes,
                    plaintext_sha256,
                    last_error,
                    &now,
                    recording_id,
                    role.as_str()
                ],
            )?;
            if updated != 1 {
                anyhow::bail!(
                    "Recording '{}' has no '{}' audio asset",
                    recording_id,
                    role.as_str()
                );
            }
        }
        if let Some(status) = recording_status {
            tx.execute(
                "UPDATE recordings SET status = ?1, updated_at = ?2 WHERE id = ?3",
                params![status, &now, recording_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Remove ownership rows only after the caller deleted each corresponding
    /// file or confirmed it was already absent.
    pub fn delete_recording_audio_assets(
        &mut self,
        recording_id: &str,
        roles: &[RecordingAudioRole],
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for role in roles {
            tx.execute(
                "DELETE FROM recording_audio_assets WHERE recording_id = ?1 AND role = ?2",
                params![recording_id, role.as_str()],
            )?;
        }
        if roles.contains(&RecordingAudioRole::Primary) {
            tx.execute(
                "UPDATE recordings SET audio_path = '', updated_at = ?1 WHERE id = ?2",
                params![&now, recording_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Atomically switch every selected member to durable ciphertext and update
    /// the renderer-facing primary mirror in the same IMMEDIATE transaction.
    pub fn switch_recording_audio_protection(
        &mut self,
        recording_id: &str,
        replacements: &[(RecordingAudioRole, &Path)],
    ) -> Result<()> {
        if replacements.is_empty() {
            return Ok(());
        }
        let now = Utc::now().to_rfc3339();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for (role, target_path) in replacements {
            let updated = tx.execute(
                "UPDATE recording_audio_assets
                 SET path = ?1, protection = 'encrypted', last_error = NULL, updated_at = ?2
                 WHERE recording_id = ?3 AND role = ?4 AND lifecycle = 'ready'",
                params![
                    target_path.to_string_lossy().as_ref(),
                    &now,
                    recording_id,
                    role.as_str()
                ],
            )?;
            if updated != 1 {
                anyhow::bail!(
                    "Recording '{}' has no ready '{}' audio asset to switch",
                    recording_id,
                    role.as_str()
                );
            }
        }
        if let Some((_, primary_path)) = replacements
            .iter()
            .find(|(role, _)| *role == RecordingAudioRole::Primary)
        {
            tx.execute(
                "UPDATE recordings SET audio_path = ?1, updated_at = ?2 WHERE id = ?3",
                params![primary_path.to_string_lossy().as_ref(), &now, recording_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn has_open_recording_audio_operation(&self) -> Result<bool> {
        self.conn
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM recording_audio_operations WHERE state <> 'complete'
                 )",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub fn load_open_recording_audio_operation(
        &self,
        recording_id: &str,
    ) -> Result<Option<RecordingAudioOperation>> {
        let operation = self.conn.query_row(
            "SELECT id, state, last_error
             FROM recording_audio_operations
             WHERE recording_id = ?1 AND kind = 'encrypt' AND state <> 'complete'",
            params![recording_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        );
        let (id, state, last_error) = match operation {
            Ok(operation) => operation,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let mut statement = self.conn.prepare(
            "SELECT role, source_path, staged_path, target_path, plaintext_bytes,
                    plaintext_sha256, state, last_error
             FROM recording_audio_operation_items
             WHERE operation_id = ?1
             ORDER BY CASE role WHEN 'primary' THEN 0 WHEN 'mic' THEN 1 ELSE 2 END",
        )?;
        let rows = statement.query_map(params![&id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?;
        let mut items = Vec::new();
        for row in rows {
            let (
                role,
                source_path,
                staged_path,
                target_path,
                plaintext_bytes,
                plaintext_sha256,
                item_state,
                item_error,
            ) = row?;
            items.push(RecordingAudioOperationItem {
                operation_id: id.clone(),
                recording_id: recording_id.to_string(),
                role: RecordingAudioRole::from_str(&role)?,
                source_path: source_path.into(),
                staged_path: staged_path.into(),
                target_path: target_path.into(),
                plaintext_bytes: u64::try_from(plaintext_bytes)
                    .context("Invalid negative plaintext byte count")?,
                plaintext_sha256,
                state: item_state,
                last_error: item_error,
            });
        }
        Ok(Some(RecordingAudioOperation {
            id,
            recording_id: recording_id.to_string(),
            state,
            last_error,
            items,
        }))
    }

    pub fn list_open_recording_audio_operations(&self) -> Result<Vec<RecordingAudioOperation>> {
        let recording_ids = {
            let mut statement = self.conn.prepare(
                "SELECT recording_id
                 FROM recording_audio_operations
                 WHERE state <> 'complete'
                 ORDER BY created_at ASC",
            )?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        recording_ids
            .into_iter()
            .map(|recording_id| {
                self.load_open_recording_audio_operation(&recording_id)?
                    .with_context(|| {
                        format!(
                            "Open recording audio operation disappeared for '{}'",
                            recording_id
                        )
                    })
            })
            .collect()
    }

    pub fn begin_recording_audio_encryption(
        &mut self,
        recording_id: &str,
    ) -> Result<Option<RecordingAudioOperation>> {
        if let Some(operation) = self.load_open_recording_audio_operation(recording_id)? {
            return Ok(Some(operation));
        }
        let bundle = self.load_recording_audio_bundle(recording_id)?;
        let mut assets = Vec::new();
        for asset in bundle.assets().filter(|asset| {
            asset.lifecycle == RecordingAudioLifecycle::Ready
                && asset.protection == RecordingAudioProtection::Plaintext
        }) {
            let metadata = match validate_plaintext_wav(&asset.path) {
                RecordingAudioValidation::Ready(metadata) => metadata,
                RecordingAudioValidation::Missing(error)
                | RecordingAudioValidation::Failed(error) => {
                    anyhow::bail!(
                        "Cannot encrypt '{}' audio for recording '{}': {}",
                        asset.role.as_str(),
                        recording_id,
                        error
                    )
                }
            };
            assets.push((asset.role, asset.path.clone(), metadata));
        }
        if assets.is_empty() {
            return Ok(None);
        }

        let operation_id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO recording_audio_operations (
                id, recording_id, kind, state, created_at, updated_at
             ) VALUES (?1, ?2, 'encrypt', 'prepared', ?3, ?3)",
            params![&operation_id, recording_id, &now],
        )?;
        for (role, source_path, metadata) in assets {
            let target_path = encrypted_path_for(&source_path);
            let staged_name = format!(
                "{}.pending-{}-{}",
                target_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("recording.enc"),
                operation_id,
                role.as_str()
            );
            let staged_path = target_path.with_file_name(staged_name);
            tx.execute(
                "INSERT INTO recording_audio_operation_items (
                    operation_id, recording_id, role, source_path, staged_path,
                    target_path, plaintext_bytes, plaintext_sha256, state,
                    created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'prepared', ?9, ?9)",
                params![
                    &operation_id,
                    recording_id,
                    role.as_str(),
                    source_path.to_string_lossy().as_ref(),
                    staged_path.to_string_lossy().as_ref(),
                    target_path.to_string_lossy().as_ref(),
                    i64::try_from(metadata.plaintext_bytes)
                        .context("Recording audio file is too large for SQLite metadata")?,
                    &metadata.plaintext_sha256,
                    &now
                ],
            )?;
        }
        tx.commit()?;
        self.load_open_recording_audio_operation(recording_id)
    }

    pub fn set_recording_audio_operation_state(
        &mut self,
        operation_id: &str,
        state: &str,
        last_error: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE recording_audio_operations
             SET state = ?1, last_error = ?2, updated_at = ?3
             WHERE id = ?4",
            params![state, last_error, Utc::now().to_rfc3339(), operation_id],
        )?;
        Ok(())
    }

    pub fn set_recording_audio_operation_item_state(
        &mut self,
        operation_id: &str,
        role: RecordingAudioRole,
        state: &str,
        last_error: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE recording_audio_operation_items
             SET state = ?1, last_error = ?2, updated_at = ?3
             WHERE operation_id = ?4 AND role = ?5",
            params![
                state,
                last_error,
                Utc::now().to_rfc3339(),
                operation_id,
                role.as_str()
            ],
        )?;
        Ok(())
    }

    /// Atomically publish every encrypted member and the primary compatibility
    /// mirror after all ciphertext files are durable. Replaying a committed
    /// switch is accepted only when every row already names the exact target.
    pub fn switch_recording_audio_encryption(
        &mut self,
        operation: &RecordingAudioOperation,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for item in &operation.items {
            let current = tx.query_row(
                "SELECT path, lifecycle, protection
                 FROM recording_audio_assets
                 WHERE recording_id = ?1 AND role = ?2",
                params![&operation.recording_id, item.role.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            );
            let (current_path, lifecycle, protection) = match current {
                Ok(current) => current,
                Err(rusqlite::Error::QueryReturnedNoRows) => {
                    anyhow::bail!(
                        "Recording '{}' has no '{}' audio asset to switch",
                        operation.recording_id,
                        item.role.as_str()
                    )
                }
                Err(error) => return Err(error.into()),
            };
            let source_path = item.source_path.to_string_lossy();
            let target_path = item.target_path.to_string_lossy();
            if lifecycle != RecordingAudioLifecycle::Ready.as_str() {
                anyhow::bail!(
                    "Recording '{}' '{}' audio is not ready for encryption switch",
                    operation.recording_id,
                    item.role.as_str()
                );
            }
            if current_path == source_path
                && protection == RecordingAudioProtection::Plaintext.as_str()
            {
                tx.execute(
                    "UPDATE recording_audio_assets
                     SET path = ?1, protection = 'encrypted', last_error = NULL, updated_at = ?2
                     WHERE recording_id = ?3 AND role = ?4",
                    params![
                        target_path.as_ref(),
                        &now,
                        &operation.recording_id,
                        item.role.as_str()
                    ],
                )?;
            } else if current_path != target_path
                || protection != RecordingAudioProtection::Encrypted.as_str()
            {
                anyhow::bail!(
                    "Recording '{}' '{}' audio changed before encryption switch",
                    operation.recording_id,
                    item.role.as_str()
                );
            }
            if item.role == RecordingAudioRole::Primary {
                let updated = tx.execute(
                    "UPDATE recordings SET audio_path = ?1, updated_at = ?2 WHERE id = ?3",
                    params![target_path.as_ref(), &now, &operation.recording_id],
                )?;
                if updated != 1 {
                    anyhow::bail!("Recording '{}' was not found", operation.recording_id);
                }
            }
            tx.execute(
                "UPDATE recording_audio_operation_items
                 SET state = 'switched', last_error = NULL, updated_at = ?1
                 WHERE operation_id = ?2 AND recording_id = ?3 AND role = ?4",
                params![
                    &now,
                    &operation.id,
                    &operation.recording_id,
                    item.role.as_str()
                ],
            )?;
        }
        tx.execute(
            "UPDATE recording_audio_operations
             SET state = 'db_switched', last_error = NULL, updated_at = ?1
             WHERE id = ?2",
            params![&now, &operation.id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn mark_recording_audio_cleanup_pending(&mut self, operation_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE recording_audio_operations
             SET state = 'cleanup_pending', last_error = NULL, updated_at = ?1
             WHERE id = ?2 AND state <> 'complete'",
            params![Utc::now().to_rfc3339(), operation_id],
        )?;
        Ok(())
    }

    pub fn complete_recording_audio_encryption_cleanup(
        &mut self,
        operation_id: &str,
        cleaned_roles: &[RecordingAudioRole],
        failures: &[(RecordingAudioRole, String)],
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for role in cleaned_roles {
            tx.execute(
                "UPDATE recording_audio_operation_items
                 SET state = 'cleaned', last_error = NULL, updated_at = ?1
                 WHERE operation_id = ?2 AND role = ?3",
                params![&now, operation_id, role.as_str()],
            )?;
        }
        for (role, error) in failures {
            tx.execute(
                "UPDATE recording_audio_operation_items
                 SET state = 'failed', last_error = ?1, updated_at = ?2
                 WHERE operation_id = ?3 AND role = ?4",
                params![error, &now, operation_id, role.as_str()],
            )?;
        }
        let remaining: i64 = tx.query_row(
            "SELECT COUNT(*) FROM recording_audio_operation_items
             WHERE operation_id = ?1 AND state <> 'cleaned'",
            params![operation_id],
            |row| row.get(0),
        )?;
        let (state, error) = if remaining == 0 {
            ("complete", None)
        } else {
            (
                "cleanup_pending",
                Some(
                    failures
                        .iter()
                        .map(|(_, error)| error.as_str())
                        .collect::<Vec<_>>()
                        .join("; "),
                ),
            )
        };
        tx.execute(
            "UPDATE recording_audio_operations
             SET state = ?1, last_error = ?2, updated_at = ?3
             WHERE id = ?4",
            params![state, error, &now, operation_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Idempotently adopt only exact, explicitly referenced legacy audio files.
    /// No directory scan or orphan inference is performed.
    pub fn backfill_legacy_recording_audio(&mut self, approved_roots: &[PathBuf]) -> Result<usize> {
        let legacy_rows = {
            let mut statement = self.conn.prepare(
                "SELECT id, source_type, audio_path
                 FROM recordings
                 WHERE audio_path IS NOT NULL AND TRIM(audio_path) <> ''",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };

        let now = Utc::now().to_rfc3339();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut inserted = 0_usize;
        for (recording_id, source_type, raw_primary_path) in legacy_rows {
            let primary_path = Path::new(raw_primary_path.trim());
            if !primary_path.is_absolute() || !approved_regular_file(primary_path, approved_roots) {
                continue;
            }

            let primary_exists: bool = tx.query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM recording_audio_assets
                     WHERE recording_id = ?1 AND role = 'primary'
                 )",
                params![&recording_id],
                |row| row.get(0),
            )?;
            if !primary_exists {
                let protection = if is_terminal_encrypted_path(primary_path) {
                    RecordingAudioProtection::Encrypted
                } else {
                    RecordingAudioProtection::Plaintext
                };
                let (lifecycle, plaintext_bytes, plaintext_sha256, last_error) =
                    legacy_asset_metadata(primary_path, protection);
                inserted += tx.execute(
                    "INSERT OR IGNORE INTO recording_audio_assets (
                        recording_id, role, path, lifecycle, protection, plaintext_bytes,
                        plaintext_sha256, last_error, created_at, updated_at
                     ) VALUES (?1, 'primary', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                    params![
                        &recording_id,
                        primary_path.to_string_lossy().as_ref(),
                        lifecycle.as_str(),
                        protection.as_str(),
                        plaintext_bytes,
                        plaintext_sha256,
                        last_error,
                        &now
                    ],
                )?;
            }

            if source_type != "meeting" {
                continue;
            }
            for role in [RecordingAudioRole::Mic, RecordingAudioRole::System] {
                let explicit_exists: bool = tx.query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM recording_audio_assets
                         WHERE recording_id = ?1 AND role = ?2
                     )",
                    params![&recording_id, role.as_str()],
                    |row| row.get(0),
                )?;
                if explicit_exists {
                    continue;
                }
                let Some(candidate) = historical_companion_candidates(primary_path, role)
                    .into_iter()
                    .find(|path| approved_regular_file(path, approved_roots))
                else {
                    continue;
                };
                let protection = if is_terminal_encrypted_path(&candidate) {
                    RecordingAudioProtection::Encrypted
                } else {
                    RecordingAudioProtection::Plaintext
                };
                let (lifecycle, plaintext_bytes, plaintext_sha256, last_error) =
                    legacy_asset_metadata(&candidate, protection);
                inserted += tx.execute(
                    "INSERT OR IGNORE INTO recording_audio_assets (
                        recording_id, role, path, lifecycle, protection, plaintext_bytes,
                        plaintext_sha256, last_error, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                    params![
                        &recording_id,
                        role.as_str(),
                        candidate.to_string_lossy().as_ref(),
                        lifecycle.as_str(),
                        protection.as_str(),
                        plaintext_bytes,
                        plaintext_sha256,
                        last_error,
                        &now
                    ],
                )?;
            }
        }
        tx.commit()?;
        Ok(inserted)
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
        let tx = self.conn.transaction()?;
        let updated = tx.execute(
            "UPDATE recordings
             SET meeting_notes = ?1, notes_updated_at = ?2, updated_at = ?2
             WHERE id = ?3",
            params![meeting_notes, now.to_rfc3339(), recording_id],
        )?;
        if updated != 1 {
            anyhow::bail!("Recording not found: {}", recording_id);
        }
        Self::invalidate_analysis_provenance_transaction(&tx, recording_id)?;
        tx.commit()?;
        Ok(())
    }

    pub fn update_recording_status(&mut self, recording_id: &str, status: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE recordings SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, Utc::now().to_rfc3339(), recording_id],
        )?;
        Ok(())
    }

    /// Record why automatic analysis failed, or clear the record on success.
    ///
    /// `updated_at` is deliberately left alone: a failed analysis pass does not
    /// change the recording's own content, and bumping it would reorder the
    /// user's library on a background failure they did not cause.
    pub fn set_recording_analysis_failure(
        &mut self,
        recording_id: &str,
        failure: Option<&str>,
    ) -> Result<()> {
        let normalized = failure
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        self.conn.execute(
            "UPDATE recordings SET analysis_failure = ?1 WHERE id = ?2",
            params![normalized, recording_id],
        )?;
        Ok(())
    }

    /// Commit a meeting's terminal status and how complete its transcript is,
    /// in one transaction.
    ///
    /// These two facts have to land together. Writing the status first and the
    /// completeness afterwards leaves a window in which the meeting reads as a
    /// clean "completed" — and the transcript-only storage sweep, which runs off
    /// exactly that status, would delete the source audio of a meeting whose
    /// transcript is missing whole chunks.
    ///
    /// A complete transcript also clears any prior acknowledgement: a successful
    /// re-transcription means there is nothing left to acknowledge.
    pub fn complete_recording_with_transcript_state(
        &mut self,
        recording_id: &str,
        status: &str,
        transcript_complete: bool,
        degraded_reason: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let updated = tx.execute(
            "UPDATE recordings
             SET status = ?1,
                 transcript_complete = ?2,
                 transcript_degraded_reason = ?3,
                 transcript_incomplete_acknowledged_at =
                     CASE WHEN ?2 = 1 THEN NULL ELSE transcript_incomplete_acknowledged_at END,
                 updated_at = ?4
             WHERE id = ?5",
            params![
                status,
                i64::from(transcript_complete),
                degraded_reason,
                &now,
                recording_id
            ],
        )?;
        if updated != 1 {
            anyhow::bail!("Recording '{}' was not found", recording_id);
        }
        tx.commit()?;
        Ok(())
    }

    /// Whether a meeting's transcript is known incomplete, and the reason.
    ///
    /// `None` when the recording does not exist.
    pub fn get_transcript_completion(
        &self,
        recording_id: &str,
    ) -> Result<Option<MeetingTranscriptCompletion>> {
        let mut statement = self.conn.prepare(
            "SELECT transcript_complete, transcript_degraded_reason,
                    transcript_incomplete_acknowledged_at
             FROM recordings WHERE id = ?1",
        )?;
        let mut rows = statement.query(params![recording_id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        Ok(Some(MeetingTranscriptCompletion {
            complete: row.get::<_, i64>(0)? != 0,
            degraded_reason: row.get::<_, Option<String>>(1)?,
            acknowledged_at: row.get::<_, Option<String>>(2)?,
        }))
    }

    /// Meetings whose transcript is known incomplete and whose audio the user
    /// has not agreed to lose.
    ///
    /// This is the set every audio-deleting storage sweep has to skip: for these
    /// recordings the saved audio is the only complete record of the meeting.
    pub fn recording_ids_with_unacknowledged_incomplete_transcripts(&self) -> Result<Vec<String>> {
        let mut statement = self.conn.prepare(
            "SELECT id FROM recordings
             WHERE transcript_complete = 0
               AND transcript_incomplete_acknowledged_at IS NULL",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Record that the user accepted losing the audio of an incomplete meeting.
    ///
    /// Returns the degraded reason they were acknowledging, or an error when the
    /// meeting's transcript is not actually flagged incomplete — acknowledging
    /// something that is not true must not be silently accepted.
    pub fn acknowledge_incomplete_transcript(
        &mut self,
        recording_id: &str,
    ) -> Result<Option<String>> {
        let now = Utc::now().to_rfc3339();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state: Option<(i64, Option<String>)> = tx
            .query_row(
                "SELECT transcript_complete, transcript_degraded_reason
                 FROM recordings WHERE id = ?1",
                params![recording_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((complete, reason)) = state else {
            anyhow::bail!("Recording '{}' was not found", recording_id);
        };
        if complete != 0 {
            anyhow::bail!(
                "Recording '{}' does not have an incomplete transcript to acknowledge",
                recording_id
            );
        }
        tx.execute(
            "UPDATE recordings
             SET transcript_incomplete_acknowledged_at = ?1, updated_at = ?1
             WHERE id = ?2",
            params![&now, recording_id],
        )?;
        tx.commit()?;
        Ok(reason)
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
        self.patch_recording_analysis_with_provenance(
            recording_id,
            Some(summary),
            Some(action_items),
            None,
            None,
        )?;
        Ok(())
    }

    /// Patch analysis fields independently while keeping the legacy recording
    /// columns and the richer meeting artifact in one transaction. Missing
    /// fields preserve the last successful value. Provenance is retained when
    /// content is unchanged and invalidated only for the field whose content
    /// actually changed.
    pub fn patch_recording_analysis_with_provenance(
        &mut self,
        recording_id: &str,
        summary: Option<Option<&str>>,
        action_items: Option<&[String]>,
        summary_provenance: Option<&AnalysisProvenance>,
        action_items_provenance: Option<&ActionItemsProvenance>,
    ) -> Result<Recording> {
        let recording = self
            .get_recording(recording_id)?
            .ok_or_else(|| anyhow::anyhow!("Recording not found: {}", recording_id))?;
        if summary.is_none() && action_items.is_none() {
            return Ok(recording);
        }

        let now = Utc::now();
        let existing_artifact = self.get_meeting_artifact(recording_id)?;
        let previous_summary = recording.summary.clone();
        let previous_action_items = recording.action_items.clone().unwrap_or_default();
        let next_summary = summary
            .map(|value| value.map(str::to_string))
            .unwrap_or_else(|| previous_summary.clone());
        let next_action_items = action_items
            .map(|items| items.to_vec())
            .unwrap_or_else(|| previous_action_items.clone());
        let summary_changed = summary.is_some() && next_summary != previous_summary;
        let action_items_changed =
            action_items.is_some() && next_action_items != previous_action_items;

        if let Some(provenance) = summary_provenance {
            let content = next_summary.as_deref().ok_or_else(|| {
                anyhow::anyhow!("Summary provenance cannot be stored without summary content")
            })?;
            if provenance.version != ANALYSIS_PROVENANCE_VERSION
                || provenance.content_hash != analysis_content_hash(content)
            {
                anyhow::bail!("Summary provenance does not match the persisted summary");
            }
        }
        if let Some(provenance) = action_items_provenance {
            let valid_items = provenance.items.len() == next_action_items.len()
                && provenance.items.iter().zip(&next_action_items).all(
                    |(item_provenance, item)| {
                        item_provenance.content_hash == analysis_content_hash(item)
                    },
                );
            if provenance.version != ANALYSIS_PROVENANCE_VERSION
                || provenance.content_hash != action_items_content_hash(&next_action_items)
                || !valid_items
            {
                anyhow::bail!("Action-item provenance does not match the persisted action items");
            }
        }

        let next_summary_provenance = match summary {
            None => recording.summary_provenance.clone(),
            Some(_) => summary_provenance.cloned().or_else(|| {
                if summary_changed {
                    None
                } else {
                    recording.summary_provenance.clone()
                }
            }),
        };
        let next_action_items_provenance = match action_items {
            None => recording.action_items_provenance.clone(),
            Some(_) => action_items_provenance.cloned().or_else(|| {
                if action_items_changed {
                    recording
                        .action_items_provenance
                        .as_ref()
                        .and_then(|previous| {
                            preserve_matching_action_item_provenance(previous, &next_action_items)
                        })
                } else {
                    recording.action_items_provenance.clone()
                }
            }),
        };

        let mut artifact = existing_artifact.unwrap_or(MeetingArtifactRecord {
            id: uuid::Uuid::new_v4().to_string(),
            recording_id: recording_id.to_string(),
            title: Some(recording.title.clone()),
            summary: previous_summary,
            action_items: previous_action_items,
            summary_provenance: recording.summary_provenance.clone(),
            action_items_provenance: recording.action_items_provenance.clone(),
            decisions: Vec::new(),
            deadlines: Vec::new(),
            template_id: recording.meeting_template_id.clone(),
            chat_messages: Vec::new(),
            created_at: now,
            updated_at: now,
        });
        artifact.title = artifact.title.or(Some(recording.title));
        artifact.summary = next_summary.clone();
        artifact.action_items = next_action_items.clone();
        artifact.summary_provenance = next_summary_provenance;
        artifact.action_items_provenance = next_action_items_provenance;
        artifact.template_id = recording.meeting_template_id;
        artifact.updated_at = now;

        let action_items_json = serde_json::to_string(&next_action_items)?;
        let summary_provenance_json = artifact
            .summary_provenance
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let action_items_provenance_json = artifact
            .action_items_provenance
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let decisions_json = serde_json::to_string(&artifact.decisions)?;
        let deadlines_json = serde_json::to_string(&artifact.deadlines)?;
        let chat_messages_json = serde_json::to_string(&artifact.chat_messages)?;
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE recordings
             SET summary = ?1,
                 action_items = CASE WHEN ?3 = 1 THEN ?2 ELSE action_items END,
                 updated_at = ?4
             WHERE id = ?5",
            params![
                &next_summary,
                &action_items_json,
                if action_items.is_some() { 1 } else { 0 },
                now.to_rfc3339(),
                recording_id
            ],
        )?;
        tx.execute(
            "INSERT INTO meeting_artifacts (
                id, recording_id, title, summary, action_items, summary_provenance,
                action_items_provenance, decisions, deadlines, template_id, chat_messages,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(recording_id) DO UPDATE SET
                title = excluded.title,
                summary = excluded.summary,
                action_items = excluded.action_items,
                summary_provenance = excluded.summary_provenance,
                action_items_provenance = excluded.action_items_provenance,
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
                &action_items_json,
                &summary_provenance_json,
                &action_items_provenance_json,
                &decisions_json,
                &deadlines_json,
                &artifact.template_id,
                &chat_messages_json,
                artifact.created_at.to_rfc3339(),
                artifact.updated_at.to_rfc3339(),
            ],
        )?;
        tx.commit()?;

        self.get_recording(recording_id)?
            .ok_or_else(|| anyhow::anyhow!("Recording not found after analysis update"))
    }

    pub fn patch_recording_analysis(
        &mut self,
        recording_id: &str,
        summary: Option<&str>,
        action_items: Option<&[String]>,
    ) -> Result<()> {
        self.patch_recording_analysis_with_provenance(
            recording_id,
            summary.map(Some),
            action_items,
            None,
            None,
        )?;
        Ok(())
    }

    pub fn update_recording_meeting_template(
        &mut self,
        recording_id: &str,
        meeting_template_id: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now();
        let tx = self.conn.transaction()?;
        let updated = tx.execute(
            "UPDATE recordings
             SET meeting_template_id = ?1, updated_at = ?2
             WHERE id = ?3",
            params![meeting_template_id, now.to_rfc3339(), recording_id],
        )?;
        if updated != 1 {
            anyhow::bail!("Recording not found: {}", recording_id);
        }
        tx.execute(
            "UPDATE meeting_artifacts
             SET template_id = ?1, summary_provenance = NULL, updated_at = ?2
             WHERE recording_id = ?3",
            params![meeting_template_id, now.to_rfc3339(), recording_id],
        )?;
        tx.commit()?;
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
                    summary_provenance: recording.summary_provenance,
                    action_items_provenance: recording.action_items_provenance,
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

    fn write_transcript_transaction(
        tx: &rusqlite::Transaction<'_>,
        transcript: &Transcript,
    ) -> Result<()> {
        let segments_json = serde_json::to_string(&transcript.segments)?;
        tx.execute(
            "DELETE FROM transcripts WHERE recording_id = ?1",
            params![&transcript.recording_id],
        )?;
        tx.execute(
            "INSERT INTO transcripts (id, recording_id, segments, full_text, language, confidence, model, model_id, requested_provider, actual_provider, created_at, revision)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0)",
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
        Self::invalidate_analysis_provenance_transaction(tx, &transcript.recording_id)?;
        Self::invalidate_transcript_embeddings_transaction(tx, &transcript.recording_id)?;
        Self::rebuild_transcript_fts_transaction(tx, &transcript.recording_id, &transcript.segments)
    }

    pub fn invalidate_all_summary_provenance(&mut self) -> Result<usize> {
        let updated = self.conn.execute(
            "UPDATE meeting_artifacts
             SET summary_provenance = NULL, updated_at = ?1
             WHERE summary_provenance IS NOT NULL",
            params![Utc::now().to_rfc3339()],
        )?;
        Ok(updated)
    }

    fn invalidate_analysis_provenance_transaction(
        tx: &rusqlite::Transaction<'_>,
        recording_id: &str,
    ) -> Result<()> {
        tx.execute(
            "UPDATE meeting_artifacts
             SET summary_provenance = NULL,
                 action_items_provenance = NULL,
                 updated_at = ?1
             WHERE recording_id = ?2",
            params![Utc::now().to_rfc3339(), recording_id],
        )?;
        Ok(())
    }

    fn invalidate_transcript_embeddings_transaction(
        tx: &rusqlite::Transaction<'_>,
        recording_id: &str,
    ) -> Result<()> {
        tx.execute(
            "DELETE FROM transcript_embeddings WHERE recording_id = ?1",
            params![recording_id],
        )?;
        Ok(())
    }

    fn rebuild_transcript_fts_transaction(
        tx: &rusqlite::Transaction<'_>,
        recording_id: &str,
        segments: &[TranscriptSegment],
    ) -> Result<()> {
        tx.execute(
            "DELETE FROM transcript_fts WHERE recording_id = ?1",
            params![recording_id],
        )?;
        for segment in segments {
            tx.execute(
                "INSERT INTO transcript_fts (recording_id, segment_id, text, start_time, end_time)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    recording_id,
                    &segment.id,
                    &segment.text,
                    segment.start_time,
                    segment.end_time
                ],
            )?;
        }
        Ok(())
    }

    pub fn save_transcript(&mut self, transcript: &Transcript) -> Result<()> {
        let tx = self.conn.transaction()?;
        Self::write_transcript_transaction(&tx, transcript)?;
        tx.commit()?;
        Ok(())
    }

    /// Persist a completed transcript, its FTS rows, and the recording status as
    /// one durable unit. A failure in any write rolls the entire completion back.
    pub fn save_completed_transcript(&mut self, transcript: &Transcript) -> Result<()> {
        let tx = self.conn.transaction()?;
        Self::write_transcript_transaction(&tx, transcript)?;
        let updated = tx.execute(
            "UPDATE recordings SET status = 'completed', updated_at = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), &transcript.recording_id],
        )?;
        if updated != 1 {
            anyhow::bail!("Recording not found: {}", transcript.recording_id);
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
            "UPDATE transcripts
             SET segments = ?1, full_text = ?2, revision = revision + 1
             WHERE recording_id = ?3",
            params![segments_json, transcript.full_text, recording_id],
        )?;
        Self::invalidate_analysis_provenance_transaction(&tx, recording_id)?;
        Self::invalidate_transcript_embeddings_transaction(&tx, recording_id)?;
        Self::rebuild_transcript_fts_transaction(&tx, recording_id, &transcript.segments)?;
        tx.commit()?;
        Ok(true)
    }

    /// Replace one speaker turn in a single transaction. The first requested
    /// segment keeps its position and timing metadata; every remaining requested
    /// segment is removed after all IDs have been proven unique and present.
    pub fn edit_transcript_speaker_turn(
        &mut self,
        recording_id: &str,
        segment_ids: &[String],
        new_text: &str,
    ) -> Result<()> {
        if new_text.trim().is_empty() {
            anyhow::bail!("Transcript text cannot be blank");
        }
        if segment_ids.is_empty() {
            anyhow::bail!("At least one transcript segment is required");
        }

        let mut requested_ids = HashSet::with_capacity(segment_ids.len());
        for segment_id in segment_ids {
            if segment_id.trim().is_empty() {
                anyhow::bail!("Transcript segment IDs cannot be blank");
            }
            if !requested_ids.insert(segment_id.as_str()) {
                anyhow::bail!(
                    "Transcript segment '{}' was requested more than once",
                    segment_id
                );
            }
        }

        let tx = self.conn.transaction()?;
        let stored = tx.query_row(
            "SELECT t.segments, t.full_text, t.confidence, r.duration
             FROM transcripts t
             JOIN recordings r ON r.id = t.recording_id
             WHERE t.recording_id = ?1",
            params![recording_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        );
        let (segments_json, full_text, confidence, duration) = match stored {
            Ok(stored) => stored,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                anyhow::bail!("Transcript not found for recording: {}", recording_id)
            }
            Err(error) => return Err(error.into()),
        };
        let mut segments: Vec<TranscriptSegment> = serde_json::from_str(&segments_json)
            .with_context(|| {
                format!(
                    "Invalid transcript segments for recording: {}",
                    recording_id
                )
            })?;
        if segments.is_empty() && !full_text.trim().is_empty() {
            segments.push(TranscriptSegment {
                id: format!("{}-full-text", recording_id),
                start_time: 0.0,
                end_time: duration.max(0) as f64,
                text: full_text,
                speaker_id: None,
                confidence,
            });
        }

        let mut match_counts = segment_ids
            .iter()
            .map(|segment_id| (segment_id.as_str(), 0usize))
            .collect::<HashMap<_, _>>();
        for segment in &segments {
            if let Some(count) = match_counts.get_mut(segment.id.as_str()) {
                *count += 1;
            }
        }
        for segment_id in segment_ids {
            match match_counts.get(segment_id.as_str()).copied().unwrap_or(0) {
                1 => {}
                0 => anyhow::bail!(
                    "Transcript segment '{}' was not found in recording '{}'",
                    segment_id,
                    recording_id
                ),
                count => anyhow::bail!(
                    "Transcript segment '{}' appears {} times in recording '{}'",
                    segment_id,
                    count,
                    recording_id
                ),
            }
        }

        let first_segment_id = segment_ids[0].as_str();
        let removed_segment_ids = segment_ids[1..]
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let mut edited_segments = Vec::with_capacity(segments.len() - removed_segment_ids.len());
        for mut segment in segments {
            if segment.id == first_segment_id {
                segment.text = new_text.to_string();
                edited_segments.push(segment);
            } else if !removed_segment_ids.contains(segment.id.as_str()) {
                edited_segments.push(segment);
            }
        }

        let full_text = edited_segments
            .iter()
            .map(|segment| segment.text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let segments_json = serde_json::to_string(&edited_segments)?;
        let updated = tx.execute(
            "UPDATE transcripts
             SET segments = ?1, full_text = ?2, revision = revision + 1
             WHERE recording_id = ?3",
            params![segments_json, full_text, recording_id],
        )?;
        if updated != 1 {
            anyhow::bail!("Transcript not found for recording: {}", recording_id);
        }
        Self::invalidate_analysis_provenance_transaction(&tx, recording_id)?;
        Self::invalidate_transcript_embeddings_transaction(&tx, recording_id)?;
        Self::rebuild_transcript_fts_transaction(&tx, recording_id, &edited_segments)?;
        tx.commit()?;
        Ok(())
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
            "UPDATE transcripts
             SET segments = ?1, full_text = ?2, revision = revision + 1
             WHERE recording_id = ?3",
            params![segments_json, transcript.full_text, recording_id],
        )?;
        Self::invalidate_analysis_provenance_transaction(&tx, recording_id)?;
        Self::invalidate_transcript_embeddings_transaction(&tx, recording_id)?;
        Self::rebuild_transcript_fts_transaction(&tx, recording_id, &transcript.segments)?;
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
            "SELECT id, trigger, expansion, app_scope, case_sensitive, enabled, category_scope, created_at, updated_at
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
                category_scope: row.get(6)?,
                created_at: row
                    .get::<_, String>(7)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
                updated_at: row
                    .get::<_, String>(8)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
    }

    pub fn list_dictation_dictionary_entries(&self) -> Result<Vec<DictationDictionaryEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, spoken_form, replacement, app_scope, case_sensitive, enabled, category_scope, created_at, updated_at
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
                category_scope: row.get(6)?,
                created_at: row
                    .get::<_, String>(7)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
                updated_at: row
                    .get::<_, String>(8)?
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
            category_scope: normalize_category_scope(request.category_scope.as_deref())?,
            created_at: now,
            updated_at: now,
        };

        self.conn.execute(
            "INSERT INTO dictation_dictionary_entries (
                id, spoken_form, replacement, app_scope, case_sensitive, enabled, category_scope, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                &entry.id,
                &entry.spoken_form,
                &entry.replacement,
                &entry.app_scope,
                if entry.case_sensitive { 1 } else { 0 },
                if entry.enabled { 1 } else { 0 },
                &entry.category_scope,
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
        let category_scope = match &request.category_scope {
            Some(value) => normalize_category_scope(value.as_deref())?,
            None => existing.category_scope.clone(),
        };
        let updated_at = Utc::now();

        self.conn.execute(
            "UPDATE dictation_dictionary_entries
             SET spoken_form = ?1, replacement = ?2, app_scope = ?3, case_sensitive = ?4, enabled = ?5, category_scope = ?6, updated_at = ?7
             WHERE id = ?8",
            params![
                &spoken_form,
                &replacement,
                &app_scope,
                if case_sensitive { 1 } else { 0 },
                if enabled { 1 } else { 0 },
                &category_scope,
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
            category_scope,
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
            "SELECT id, original_text, corrected_text, spoken_form, replacement, app_target, source, created_at, updated_at
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
                source: row.get(6)?,
                created_at: row
                    .get::<_, String>(7)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
                updated_at: row
                    .get::<_, String>(8)?
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
        source: Option<&str>,
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
        let normalized_source = source
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
                 SET original_text = ?1, corrected_text = ?2, spoken_form = ?3, replacement = ?4, app_target = ?5, source = ?6, updated_at = ?7
                 WHERE id = ?8",
                params![
                    original_text.trim(),
                    corrected_text.trim(),
                    normalized_spoken_form,
                    normalized_replacement,
                    &normalized_app_target,
                    &normalized_source,
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
                    source: normalized_source,
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
                source: normalized_source,
                created_at: now,
                updated_at: now,
            };

            self.conn.execute(
                "INSERT INTO dictation_correction_suggestions (
                    id, original_text, corrected_text, spoken_form, replacement, app_target, source, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    &suggestion.id,
                    &suggestion.original_text,
                    &suggestion.corrected_text,
                    &suggestion.spoken_form,
                    &suggestion.replacement,
                    &suggestion.app_target,
                    &suggestion.source,
                    suggestion.created_at.to_rfc3339(),
                    suggestion.updated_at.to_rfc3339(),
                ],
            )?;

            Ok(("created".to_string(), suggestion))
        }
    }

    /// Drops queued suggestions that have gone stale or overflowed the inbox.
    ///
    /// Returns how many rows were removed. Both bounds matter for a queue that
    /// can be fed by text read out of other applications: expiry means an
    /// unreviewed suggestion does not sit there indefinitely, and the cap means
    /// a run of dictations into a hostile field cannot grow the table without
    /// limit. Newest survives in both cases — an old suggestion the user has
    /// already scrolled past twice is the one they care least about.
    pub fn prune_dictation_correction_suggestions(
        &mut self,
        now: chrono::DateTime<Utc>,
        max_age_days: i64,
        max_entries: usize,
    ) -> Result<usize> {
        let cutoff = now - chrono::Duration::days(max_age_days.max(0));
        let mut removed = self.conn.execute(
            "DELETE FROM dictation_correction_suggestions WHERE updated_at < ?1",
            params![cutoff.to_rfc3339()],
        )?;

        let surviving = self.list_dictation_correction_suggestions()?;
        if surviving.len() > max_entries {
            // `list_...` is already newest-first, so everything past the cap is
            // the oldest tail.
            for suggestion in surviving.into_iter().skip(max_entries) {
                removed += self.conn.execute(
                    "DELETE FROM dictation_correction_suggestions WHERE id = ?1",
                    params![&suggestion.id],
                )?;
            }
        }

        Ok(removed)
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
            category_scope: normalize_category_scope(request.category_scope.as_deref())?,
            created_at: now,
            updated_at: now,
        };

        self.conn.execute(
            "INSERT INTO dictation_snippets (
                id, trigger, expansion, app_scope, case_sensitive, enabled, category_scope, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                &snippet.id,
                &snippet.trigger,
                &snippet.expansion,
                &snippet.app_scope,
                if snippet.case_sensitive { 1 } else { 0 },
                if snippet.enabled { 1 } else { 0 },
                &snippet.category_scope,
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
        let category_scope = match &request.category_scope {
            Some(value) => normalize_category_scope(value.as_deref())?,
            None => existing.category_scope.clone(),
        };
        let updated_at = Utc::now();

        self.conn.execute(
            "UPDATE dictation_snippets
             SET trigger = ?1, expansion = ?2, app_scope = ?3, case_sensitive = ?4, enabled = ?5, category_scope = ?6, updated_at = ?7
             WHERE id = ?8",
            params![
                &trigger,
                &expansion,
                &app_scope,
                if case_sensitive { 1 } else { 0 },
                if enabled { 1 } else { 0 },
                &category_scope,
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
            category_scope,
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
        let full_text = segments
            .iter()
            .map(|segment| segment.text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let tx = self.conn.transaction()?;
        let updated = tx.execute(
            "UPDATE transcripts
             SET segments = ?1, full_text = ?2, revision = revision + 1
             WHERE recording_id = ?3",
            params![segments_json, full_text, recording_id],
        )?;
        if updated != 1 {
            anyhow::bail!("Transcript not found for recording: {}", recording_id);
        }
        Self::invalidate_analysis_provenance_transaction(&tx, recording_id)?;
        Self::invalidate_transcript_embeddings_transaction(&tx, recording_id)?;
        Self::rebuild_transcript_fts_transaction(&tx, recording_id, segments)?;
        tx.commit()?;
        Ok(())
    }

    pub fn apply_diarization_enrichment(
        &mut self,
        recording_id: &str,
        expected_revision: i64,
        segments: &[TranscriptSegment],
        aliases: &[SpeakerAliasUpsert],
    ) -> Result<bool> {
        let segments_json = serde_json::to_string(segments)?;
        let full_text = segments
            .iter()
            .map(|segment| segment.text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let tx = self.conn.transaction()?;
        let updated = tx.execute(
            "UPDATE transcripts
             SET segments = ?1, full_text = ?2, revision = revision + 1
             WHERE recording_id = ?3 AND revision = ?4",
            params![segments_json, full_text, recording_id, expected_revision],
        )?;
        if updated == 0 {
            return Ok(false);
        }
        Self::invalidate_analysis_provenance_transaction(&tx, recording_id)?;
        Self::invalidate_transcript_embeddings_transaction(&tx, recording_id)?;
        Self::rebuild_transcript_fts_transaction(&tx, recording_id, segments)?;
        for alias in aliases {
            Self::upsert_speaker_alias_transaction(
                &tx,
                recording_id,
                &alias.speaker_id,
                alias.name.as_deref(),
                alias.color.as_deref(),
                alias.sample_count,
                true,
            )?;
        }
        tx.commit()?;
        Ok(true)
    }

    fn upsert_speaker_alias_transaction(
        tx: &rusqlite::Transaction<'_>,
        recording_id: &str,
        speaker_id: &str,
        name: Option<&str>,
        color: Option<&str>,
        sample_count: i64,
        preserve_existing_name: bool,
    ) -> Result<()> {
        tx.execute(
            "INSERT INTO speaker_aliases (recording_id, speaker_id, name, color, sample_count, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(recording_id, speaker_id) DO UPDATE SET
                name = CASE
                    WHEN ?7 = 1
                         AND speaker_aliases.name IS NOT NULL
                         AND TRIM(speaker_aliases.name) != ''
                    THEN speaker_aliases.name
                    ELSE excluded.name
                END,
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
                Utc::now().to_rfc3339(),
                if preserve_existing_name { 1 } else { 0 }
            ],
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
        let tx = self.conn.transaction()?;
        Self::upsert_speaker_alias_transaction(
            &tx,
            recording_id,
            speaker_id,
            name,
            color,
            sample_count,
            false,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn rename_speaker(
        &mut self,
        recording_id: &str,
        speaker_id: &str,
        new_name: &str,
    ) -> Result<()> {
        let speaker_id = speaker_id.trim();
        if speaker_id.is_empty() {
            anyhow::bail!("Speaker ID cannot be blank");
        }
        let new_name = new_name.trim();
        if new_name.is_empty() {
            anyhow::bail!("Speaker name cannot be blank");
        }

        let transcript = self.get_transcript(recording_id)?.ok_or_else(|| {
            anyhow::anyhow!("Transcript not found for recording: {}", recording_id)
        })?;
        let speaker_exists = transcript
            .segments
            .iter()
            .any(|segment| segment.speaker_id.as_deref().map(str::trim) == Some(speaker_id));
        if !speaker_exists {
            anyhow::bail!(
                "Speaker '{}' is not present in recording '{}'",
                speaker_id,
                recording_id
            );
        }

        self.upsert_speaker_alias(recording_id, speaker_id, Some(new_name), None, 0)
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

    /// Delete a recording and all of its derived content: transcript, FTS rows,
    /// speaker aliases, meeting artifacts (summary/action items/chat), and
    /// vector embeddings. Returns the stored audio path so callers can remove
    /// the file(s) on disk as well.
    pub fn delete_recording(&mut self, recording_id: &str) -> Result<String> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let stored = tx.query_row(
            "SELECT audio_path, status FROM recordings WHERE id = ?1",
            params![recording_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        );
        let (audio_path, status) = match stored {
            Ok(stored) => stored,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                anyhow::bail!("Recording '{}' was not found", recording_id)
            }
            Err(error) => return Err(error.into()),
        };
        if matches!(status.as_str(), "recording" | "processing") {
            anyhow::bail!(
                "Recording '{}' cannot be deleted while its status is '{}'",
                recording_id,
                status
            );
        }

        tx.execute(
            "DELETE FROM speaker_aliases WHERE recording_id = ?1",
            params![recording_id],
        )?;
        // Keep explicit child deletes even with ON DELETE CASCADE: databases
        // created by older binaries may be opened before their FK rebuild, and
        // this transaction must never leave evidence rows orphaned.
        tx.execute(
            "DELETE FROM transcript_artifacts WHERE recording_id = ?1",
            params![recording_id],
        )?;
        tx.execute(
            "DELETE FROM insertion_actions WHERE recording_id = ?1",
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
            "DELETE FROM meeting_artifacts WHERE recording_id = ?1",
            params![recording_id],
        )?;
        tx.execute(
            "DELETE FROM transcript_embeddings WHERE recording_id = ?1",
            params![recording_id],
        )?;
        tx.execute(
            "DELETE FROM recording_audio_operation_items WHERE recording_id = ?1",
            params![recording_id],
        )?;
        tx.execute(
            "DELETE FROM recording_audio_operations WHERE recording_id = ?1",
            params![recording_id],
        )?;
        tx.execute(
            "DELETE FROM recording_audio_assets WHERE recording_id = ?1",
            params![recording_id],
        )?;
        tx.execute(
            "DELETE FROM recordings WHERE id = ?1",
            params![recording_id],
        )?;
        tx.commit()?;

        Ok(audio_path)
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
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("Failed to start Reset Everything database transaction")?;
        drop_audit_log_append_only_triggers(&tx)?;

        for (table_name, delete_sql) in RESET_SCOPED_TABLE_DELETES {
            if table_exists(&tx, table_name)? {
                tx.execute(delete_sql, []).with_context(|| {
                    format!("Failed to purge reset-scoped table {}", table_name)
                })?;
            }
        }

        tx.execute(
            "INSERT INTO projects (id, name, description, created_at, updated_at)
             VALUES ('default', 'Inbox', 'Default inbox for new recordings', ?1, ?1)",
            params![&now],
        )?;
        tx.execute(
            "INSERT INTO projects (id, name, description, created_at, updated_at)
             VALUES ('inbox', 'Inbox', 'Default inbox for new recordings', ?1, ?1)",
            params![&now],
        )?;

        create_audit_log_append_only_triggers(&tx)?;
        verify_audit_log_append_only_triggers(&tx)?;
        tx.commit()
            .context("Failed to commit Reset Everything database purge")?;
        Ok(())
    }

    pub fn search_embeddings(
        &self,
        query_embedding: &[f32],
        limit: usize,
    ) -> Result<Vec<SearchHit>> {
        // Bound the in-memory cosine-similarity scan so a multi-year meeting
        // library cannot balloon a single Ask into deserializing hundreds of
        // thousands of embedding blobs; the most recent rows win.
        const EMBEDDING_SCAN_LIMIT: usize = 50_000;

        // Join against recordings so segments from deleted meetings can never
        // surface in cross-meeting recall, and titles come back in one pass.
        let mut stmt = self.conn.prepare(
            "SELECT te.recording_id, te.segment_id, te.text, te.embedding,
                    te.start_time, te.end_time, r.title
             FROM transcript_embeddings te
             JOIN recordings r ON r.id = te.recording_id
             ORDER BY te.created_at DESC
             LIMIT ?1",
        )?;

        let rows = stmt.query_map(params![EMBEDDING_SCAN_LIMIT as i64], |row| {
            let recording_id: String = row.get(0)?;
            let segment_id: String = row.get(1)?;
            let text: String = row.get(2)?;
            let blob: Vec<u8> = row.get(3)?;
            let start_time: f64 = row.get(4)?;
            let end_time: f64 = row.get(5)?;
            let recording_title: String = row.get(6)?;
            Ok((
                recording_id,
                segment_id,
                text,
                blob,
                start_time,
                end_time,
                recording_title,
            ))
        })?;

        let mut scored: Vec<(f64, SearchHit)> = Vec::new();
        for row in rows {
            let (recording_id, segment_id, text, blob, start_time, end_time, recording_title) =
                row?;
            let embedding = blob_to_f32_vec(&blob);
            let score = crate::llm::cosine_similarity(query_embedding, &embedding) as f64;
            scored.push((
                score,
                SearchHit {
                    recording_id,
                    recording_title,
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

        Ok(scored.into_iter().map(|(_, hit)| hit).collect())
    }

    pub fn embedding_count(&self) -> Result<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM transcript_embeddings", [], |row| {
                row.get(0)
            })
            .map_err(|e| e.into())
    }
}

fn legacy_asset_metadata(
    path: &Path,
    protection: RecordingAudioProtection,
) -> (
    RecordingAudioLifecycle,
    Option<i64>,
    Option<String>,
    Option<String>,
) {
    if protection == RecordingAudioProtection::Encrypted {
        return (RecordingAudioLifecycle::Ready, None, None, None);
    }
    match validate_plaintext_wav(path) {
        RecordingAudioValidation::Ready(metadata) => (
            RecordingAudioLifecycle::Ready,
            i64::try_from(metadata.plaintext_bytes).ok(),
            Some(metadata.plaintext_sha256),
            None,
        ),
        RecordingAudioValidation::Missing(error) => {
            (RecordingAudioLifecycle::Missing, None, None, Some(error))
        }
        RecordingAudioValidation::Failed(error) => {
            (RecordingAudioLifecycle::Failed, None, None, Some(error))
        }
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
    use std::collections::BTreeSet;

    fn in_memory_db() -> Database {
        let conn = Connection::open_in_memory().expect("in-memory db");
        let mut db = Database {
            conn,
            encrypted: false,
        };
        db.init_tables().expect("init tables");
        db
    }

    #[test]
    fn read_only_open_refuses_writes_and_skips_migrations() {
        let dir = crate::test_fs::TempDir::new("local-tools");
        let path = dir.path().join("plainsong.db");
        // A writer creates the schema and one row the reader can see.
        {
            let mut db = Database::open_at_path(&path, None).unwrap();
            let recording = sample_recording("ro-1", "inbox");
            db.create_recording(&recording).unwrap();
        }

        let reader = Database::open_read_only_at_path(&path, None).unwrap();
        assert_eq!(reader.get_recordings(None).unwrap().len(), 1);

        // Every write path is refused by SQLite itself, not only by policy.
        let insert = reader.conn.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p', 'p', '', '')",
            [],
        );
        assert!(
            insert.is_err(),
            "insert must fail on a read-only connection"
        );
        let bump = reader.conn.execute_batch("PRAGMA user_version = 99;");
        assert!(
            bump.is_err(),
            "pragma write must fail on a read-only connection"
        );
        let query_only: i64 = reader
            .conn
            .query_row("PRAGMA query_only", [], |row| row.get(0))
            .unwrap();
        assert_eq!(query_only, 1);

        // The file on disk still carries the writer's schema version.
        let check = Connection::open(&path).unwrap();
        let version: i64 = check
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn read_only_open_refuses_a_missing_file_instead_of_creating_one() {
        let dir = crate::test_fs::TempDir::new("local-tools");
        let path = dir.path().join("absent.db");
        let error = Database::open_read_only_at_path(&path, None)
            .err()
            .expect("open must fail");
        assert!(error.to_string().contains("No Plainsong database"));
        assert!(
            !path.exists(),
            "a read-only open must never create the file"
        );
    }

    #[test]
    fn read_only_open_refuses_a_newer_schema() {
        let dir = crate::test_fs::TempDir::new("local-tools");
        let path = dir.path().join("future.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "PRAGMA user_version = {};",
                CURRENT_SCHEMA_VERSION + 1
            ))
            .unwrap();
        }
        let error = Database::open_read_only_at_path(&path, None)
            .err()
            .expect("open must fail");
        assert!(error
            .to_string()
            .contains("newer than this binary supports"));
    }

    /// The keyed open used to verify the key with `Connection::execute`,
    /// which rusqlite rejects for any row-returning statement — so every
    /// encrypted open failed before the key was tested. Nothing caught it
    /// because no install had a vault key yet.
    #[cfg(feature = "sqlcipher")]
    #[test]
    fn keyed_open_round_trip() {
        let dir = crate::test_fs::TempDir::new("local-tools");
        let path = dir.path().join("keyed.db");
        let key = "0123456789abcdef0123456789abcdef";
        {
            let mut db = Database::open_at_path(&path, Some(key)).expect("keyed create");
            assert!(db.is_encrypted().unwrap());
            db.create_recording(&sample_recording("k-1", "inbox"))
                .unwrap();
        }
        let reopened = Database::open_at_path(&path, Some(key)).expect("keyed reopen");
        assert_eq!(reopened.get_recordings(None).unwrap().len(), 1);
        assert!(Database::open_at_path(&path, None).is_err());
        // Not covered here: `change_key` on a database that was opened
        // WITHOUT a key. SQLCipher's `PRAGMA rekey` is a silent no-op on an
        // unkeyed connection (the file stays plaintext and a keyed reopen
        // then fails with "file is not a database"), so the vault's
        // plaintext-to-encrypted step needs `sqlcipher_export`, not `rekey`.
        // That is a separate fix with its own migration story; it is
        // recorded, not papered over, here.
    }

    #[cfg(feature = "sqlcipher")]
    #[test]
    fn read_only_open_needs_the_same_key_the_writer_used() {
        let dir = crate::test_fs::TempDir::new("local-tools");
        let path = dir.path().join("cipher.db");
        let key = "0123456789abcdef0123456789abcdef";
        {
            let mut db = Database::open_at_path(&path, Some(key)).unwrap();
            db.create_recording(&sample_recording("enc-1", "inbox"))
                .unwrap();
        }
        let keyed = Database::open_read_only_at_path(&path, Some(key)).unwrap();
        assert!(keyed.is_encrypted().unwrap());
        assert_eq!(keyed.get_recordings(None).unwrap().len(), 1);

        assert!(Database::open_read_only_at_path(&path, None).is_err());
        assert!(Database::open_read_only_at_path(&path, Some("wrong-key")).is_err());
    }

    #[test]
    fn schema_version_one_and_foreign_keys_are_enabled() {
        let db = in_memory_db();
        let version: i64 = db
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let foreign_keys: i64 = db
            .conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();

        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        assert_eq!(foreign_keys, 1);
        assert!(!db.is_encrypted().unwrap());
    }

    #[test]
    fn future_schema_version_is_rejected_before_migration() {
        let path = std::env::temp_dir().join(format!(
            "plainsong-future-schema-{}.db",
            uuid::Uuid::new_v4()
        ));
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA user_version = 2;").unwrap();
        drop(conn);

        let error = Database::open_at_path(&path, None)
            .err()
            .expect("future schemas must not be opened");
        assert!(error
            .to_string()
            .contains("newer than this binary supports"));

        let conn = Connection::open(&path).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 2, "rejection must not mutate the future database");
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn failed_schema_migration_does_not_bump_version_or_commit_partial_ddl() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE VIEW recordings AS SELECT 'blocked' AS id;")
            .unwrap();
        let mut db = Database {
            conn,
            encrypted: false,
        };

        db.init_tables()
            .expect_err("conflicting legacy schema must abort migration");
        let version: i64 = db
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 0);
        assert!(!table_exists(&db.conn, "projects").unwrap());
    }

    #[test]
    fn recording_evidence_foreign_keys_cascade_on_parent_delete() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("cascade", "inbox"))
            .unwrap();
        db.conn
            .execute_batch(
                "INSERT INTO transcript_artifacts (id, recording_id, created_at)
                     VALUES ('artifact', 'cascade', '2026-01-01');
                 INSERT INTO insertion_actions (
                     id, recording_id, requested_mode, actual_mode, created_at
                 ) VALUES ('insertion', 'cascade', 'paste', 'paste', '2026-01-01');
                 DELETE FROM recordings WHERE id = 'cascade';",
            )
            .unwrap();

        for table in ["transcript_artifacts", "insertion_actions"] {
            let count: i64 = db
                .conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table} must cascade with its recording");
        }
    }

    #[test]
    fn analysis_failure_round_trips_through_list_and_detail_reads() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("meeting-1", "inbox"))
            .unwrap();

        // A fresh recording has no recorded failure.
        assert_eq!(
            db.get_recording("meeting-1")
                .unwrap()
                .unwrap()
                .analysis_failure,
            None
        );

        db.set_recording_analysis_failure("meeting-1", Some("summary: Ollama is not running"))
            .unwrap();

        // Both the detail read and the library list must carry it: the list is
        // what the library view renders, and an event alone is lost on reload.
        assert_eq!(
            db.get_recording("meeting-1")
                .unwrap()
                .unwrap()
                .analysis_failure,
            Some("summary: Ollama is not running".to_string())
        );
        let listed = db.get_recordings(None).unwrap();
        assert_eq!(
            listed[0].analysis_failure,
            Some("summary: Ollama is not running".to_string())
        );
    }

    #[test]
    fn a_clean_analysis_pass_clears_a_persisted_failure() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("meeting-2", "inbox"))
            .unwrap();
        db.set_recording_analysis_failure("meeting-2", Some("summary: boom"))
            .unwrap();

        db.set_recording_analysis_failure("meeting-2", None)
            .unwrap();

        assert_eq!(
            db.get_recording("meeting-2")
                .unwrap()
                .unwrap()
                .analysis_failure,
            None
        );
    }

    #[test]
    fn blank_analysis_failures_are_stored_as_absent() {
        // A whitespace-only reason is not a failure the UI can show, and must
        // not light up a "retry" affordance with nothing to explain.
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("meeting-3", "inbox"))
            .unwrap();

        db.set_recording_analysis_failure("meeting-3", Some("   "))
            .unwrap();

        assert_eq!(
            db.get_recording("meeting-3")
                .unwrap()
                .unwrap()
                .analysis_failure,
            None
        );
    }

    #[test]
    fn recording_analysis_failure_serializes_as_camel_case() {
        let mut recording = sample_recording("meeting-4", "inbox");
        recording.analysis_failure = Some("summary: boom".to_string());

        let value = serde_json::to_value(&recording).unwrap();

        // The renderer contract is `analysisFailure`; the struct-level
        // `rename_all = "camelCase"` is what provides it.
        assert_eq!(value["analysisFailure"], "summary: boom");
        assert!(value.get("analysis_failure").is_none());
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
            summary_provenance: None,
            action_items_provenance: None,
            meeting_notes: None,
            meeting_template_id: None,
            meeting_capture_mode: None,
            notes_updated_at: None,
            consent_prompt_shown: false,
            consent_notice_mode: None,
            consent_notice_surface: None,
            consent_notice_message: None,
            consent_notice_updated_at: None,
            analysis_failure: None,
        }
    }

    fn write_test_wav(path: &Path) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("create wav fixture");
        for sample in [100_i16, -100, 50, -50] {
            writer.write_sample(sample).expect("write wav sample");
        }
        writer.finalize().expect("finalize wav fixture");
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

    fn sample_multi_segment_transcript(recording_id: &str) -> Transcript {
        Transcript {
            id: format!("t-{}", recording_id),
            recording_id: recording_id.to_string(),
            segments: vec![
                TranscriptSegment {
                    id: "s1".to_string(),
                    start_time: 0.0,
                    end_time: 1.0,
                    text: "first segment".to_string(),
                    speaker_id: Some("speaker_0".to_string()),
                    confidence: 0.95,
                },
                TranscriptSegment {
                    id: "s2".to_string(),
                    start_time: 1.0,
                    end_time: 2.0,
                    text: "second segment".to_string(),
                    speaker_id: Some("speaker_0".to_string()),
                    confidence: 0.94,
                },
                TranscriptSegment {
                    id: "s3".to_string(),
                    start_time: 2.0,
                    end_time: 3.0,
                    text: "third segment".to_string(),
                    speaker_id: Some("speaker_0".to_string()),
                    confidence: 0.93,
                },
                TranscriptSegment {
                    id: "s4".to_string(),
                    start_time: 3.0,
                    end_time: 4.0,
                    text: "fourth segment".to_string(),
                    speaker_id: Some("speaker_1".to_string()),
                    confidence: 0.92,
                },
            ],
            full_text: "first segment second segment third segment fourth segment".to_string(),
            language: "en".to_string(),
            confidence: 0.94,
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
            requested_provider: Some("parakeet".to_string()),
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

    fn sample_summary_provenance(summary: &str) -> AnalysisProvenance {
        AnalysisProvenance {
            version: ANALYSIS_PROVENANCE_VERSION,
            content_hash: analysis_content_hash(summary),
            actual_provider: "ollama".to_string(),
            actual_model: "llama3.2".to_string(),
            prompt_source: "meeting_playbook:auto".to_string(),
            completed_at: Utc::now(),
            citations: vec![AnalysisCitation {
                text: "Canonical transcript evidence".to_string(),
                line_id: Some("L1".to_string()),
                segment_id: Some("s1".to_string()),
                start_time: Some(10.0),
                end_time: Some(12.0),
                recording_id: Some("r1".to_string()),
                certainty: Some(1.0),
            }],
            grounded: true,
        }
    }

    fn sample_action_items_provenance(items: &[String]) -> ActionItemsProvenance {
        let citations = sample_summary_provenance("unused").citations;
        ActionItemsProvenance {
            version: ANALYSIS_PROVENANCE_VERSION,
            content_hash: action_items_content_hash(items),
            actual_provider: "ollama".to_string(),
            actual_model: "llama3.2".to_string(),
            prompt_source: "plainsong_action_items_v1".to_string(),
            completed_at: Utc::now(),
            citations: citations.clone(),
            grounded: true,
            items: items
                .iter()
                .map(|item| ActionItemProvenance {
                    content_hash: analysis_content_hash(item),
                    citations: citations.clone(),
                    grounded: true,
                    generated: true,
                })
                .collect(),
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
            summary_provenance: None,
            action_items_provenance: None,
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
    fn dictation_result_persistence_commits_recording_and_transcript_together() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("dictation-result", "inbox");
        recording.source_type = "dictation".to_string();
        recording.audio_path.clear();
        recording.status = "completed".to_string();
        let transcript = sample_transcript(&recording.id);

        db.create_recording_with_transcript(&recording, &transcript)
            .unwrap();

        assert!(db.get_recording(&recording.id).unwrap().is_some());
        assert_eq!(
            db.get_transcript(&recording.id)
                .unwrap()
                .expect("dictation transcript")
                .full_text,
            "Hello world"
        );
        assert_eq!(db.search_transcripts("hello", 10, None).unwrap().len(), 1);
    }

    #[test]
    fn dictation_result_persistence_rolls_back_recording_when_transcript_write_fails() {
        let mut db = in_memory_db();
        db.conn.execute("DROP TABLE transcript_fts", []).unwrap();
        let mut recording = sample_recording("dictation-rollback", "inbox");
        recording.source_type = "dictation".to_string();
        recording.audio_path.clear();
        recording.status = "completed".to_string();
        let transcript = sample_transcript(&recording.id);

        let error = db
            .create_recording_with_transcript(&recording, &transcript)
            .expect_err("recording and transcript must share one transaction");

        assert!(error.to_string().contains("transcript_fts"));
        assert!(db.get_recording(&recording.id).unwrap().is_none());
        assert!(db.get_transcript(&recording.id).unwrap().is_none());
    }

    #[test]
    fn recording_audio_schema_uses_the_synthesized_tables_and_status_checks() {
        let db = in_memory_db();
        for table in [
            "recording_audio_assets",
            "recording_audio_operations",
            "recording_audio_operation_items",
        ] {
            let exists: bool = db
                .conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
                    params![table],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(exists, "missing canonical audio table {table}");
        }
        assert!(db
            .conn
            .execute(
                "INSERT INTO recording_audio_assets (
                    recording_id, role, path, lifecycle, protection, created_at, updated_at
                 ) VALUES ('r', 'other', '/tmp/other.wav', 'planned', 'plaintext', 'now', 'now')",
                [],
            )
            .is_err());
        assert!(db
            .conn
            .execute(
                "INSERT INTO recording_audio_operations (
                    id, recording_id, kind, state, created_at, updated_at
                 ) VALUES ('op', 'r', 'delete', 'prepared', 'now', 'now')",
                [],
            )
            .is_err());
    }

    #[test]
    fn planned_bundle_creation_commits_recording_mirror_and_assets_together() {
        let mut db = in_memory_db();
        let root =
            std::env::temp_dir().join(format!("plainsong-plan-db-test-{}", uuid::Uuid::new_v4()));
        let plan = RecordingCapturePlan {
            recording_id: "planned-recording".to_string(),
            primary_path: root.join("recording.wav"),
            mic_path: Some(root.join("recording_mic.wav")),
            system_path: Some(root.join("recording_system.wav")),
        };
        let mut recording = sample_recording("planned-recording", "inbox");
        recording.audio_path.clear();

        db.create_recording_with_audio_plan(&recording, &plan)
            .unwrap();

        let stored = db.get_recording("planned-recording").unwrap().unwrap();
        assert_eq!(stored.audio_path, plan.primary_path.to_string_lossy());
        let bundle = db.load_recording_audio_bundle("planned-recording").unwrap();
        assert_eq!(bundle.assets().count(), 3);
        assert!(bundle
            .assets()
            .all(|asset| asset.lifecycle == RecordingAudioLifecycle::Planned));
        assert!(!plan.primary_path.exists());
        assert!(!plan.mic_path.as_ref().unwrap().exists());
        assert!(!plan.system_path.as_ref().unwrap().exists());
    }

    #[test]
    fn encrypted_bundle_switch_updates_all_assets_and_primary_mirror_atomically() {
        let mut db = in_memory_db();
        let root = std::env::temp_dir().join(format!(
            "plainsong-encryption-switch-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let plan = RecordingCapturePlan {
            recording_id: "encrypt-bundle".to_string(),
            primary_path: root.join("recording.wav"),
            mic_path: Some(root.join("recording_mic.wav")),
            system_path: Some(root.join("recording_system.wav")),
        };
        let mut recording = sample_recording("encrypt-bundle", "inbox");
        recording.audio_path.clear();
        db.create_recording_with_audio_plan(&recording, &plan)
            .unwrap();
        db.mark_audio_assets_writing(&recording.id).unwrap();
        let mut validated = Vec::new();
        for (role, path) in plan.paths() {
            write_test_wav(path);
            let RecordingAudioValidation::Ready(metadata) = validate_plaintext_wav(path) else {
                panic!("valid wav fixture");
            };
            validated.push((role, metadata));
        }
        db.finalize_recording_audio(&recording.id, &validated, 1, "completed", None)
            .unwrap();

        let operation = db
            .begin_recording_audio_encryption(&recording.id)
            .unwrap()
            .unwrap();
        assert_eq!(operation.items.len(), 3);
        db.switch_recording_audio_encryption(&operation).unwrap();

        let switched = db.load_recording_audio_bundle(&recording.id).unwrap();
        assert!(switched.assets().all(|asset| {
            asset.protection == RecordingAudioProtection::Encrypted
                && asset.path.to_string_lossy().ends_with(".enc")
        }));
        assert_eq!(
            db.get_recording(&recording.id).unwrap().unwrap().audio_path,
            switched.primary.as_ref().unwrap().path.to_string_lossy()
        );
        assert_eq!(
            db.load_open_recording_audio_operation(&recording.id)
                .unwrap()
                .unwrap()
                .state,
            "db_switched"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn degraded_transcripts_are_durable_and_hold_audio_back_until_acknowledged() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("degraded", "inbox"))
            .unwrap();
        db.create_recording(&sample_recording("clean", "inbox"))
            .unwrap();

        // Rows written before this column existed must not be treated as
        // suspect: nothing recorded a degradation for them.
        assert_eq!(
            db.get_transcript_completion("clean").unwrap(),
            Some(MeetingTranscriptCompletion {
                complete: true,
                degraded_reason: None,
                acknowledged_at: None,
            })
        );

        db.complete_recording_with_transcript_state(
            "degraded",
            "completed",
            false,
            Some("chunk 41 of 60 failed"),
        )
        .unwrap();
        db.complete_recording_with_transcript_state("clean", "completed", true, None)
            .unwrap();

        assert_eq!(
            db.get_recording("degraded").unwrap().unwrap().status,
            "completed",
            "a degraded transcript is still a completed meeting"
        );
        assert_eq!(
            db.recording_ids_with_unacknowledged_incomplete_transcripts()
                .unwrap(),
            vec!["degraded".to_string()]
        );

        assert_eq!(
            db.acknowledge_incomplete_transcript("degraded").unwrap(),
            Some("chunk 41 of 60 failed".to_string())
        );
        assert!(db
            .recording_ids_with_unacknowledged_incomplete_transcripts()
            .unwrap()
            .is_empty());
        let acknowledged = db.get_transcript_completion("degraded").unwrap().unwrap();
        assert!(
            !acknowledged.complete,
            "acknowledging the loss must not claim the transcript became complete"
        );
        assert_eq!(
            acknowledged.degraded_reason.as_deref(),
            Some("chunk 41 of 60 failed")
        );
        assert!(acknowledged.acknowledged_at.is_some());

        // Acknowledging something that is not true is refused.
        assert!(db.acknowledge_incomplete_transcript("clean").is_err());

        // A clean re-transcription clears both the flag and the acknowledgement.
        db.complete_recording_with_transcript_state("degraded", "completed", true, None)
            .unwrap();
        assert_eq!(
            db.get_transcript_completion("degraded").unwrap(),
            Some(MeetingTranscriptCompletion {
                complete: true,
                degraded_reason: None,
                acknowledged_at: None,
            })
        );
    }

    #[test]
    fn capture_degradation_is_committed_with_the_finalized_audio() {
        let mut db = in_memory_db();
        let root = std::env::temp_dir().join(format!(
            "plainsong-capture-degradation-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let plan = RecordingCapturePlan {
            recording_id: "degraded-capture".to_string(),
            primary_path: root.join("recording.wav"),
            mic_path: None,
            system_path: None,
        };
        let mut recording = sample_recording("degraded-capture", "inbox");
        recording.audio_path.clear();
        db.create_recording_with_audio_plan(&recording, &plan)
            .unwrap();
        db.mark_audio_assets_writing(&recording.id).unwrap();
        write_test_wav(&plan.primary_path);
        let RecordingAudioValidation::Ready(metadata) = validate_plaintext_wav(&plan.primary_path)
        else {
            panic!("valid wav fixture");
        };

        db.finalize_recording_audio(
            &recording.id,
            &[(RecordingAudioRole::Primary, metadata.clone())],
            1,
            "processing",
            Some("The microphone delivered nothing for about 320s of this 3600s meeting"),
        )
        .unwrap();

        assert_eq!(
            db.get_capture_degraded_summary(&recording.id).unwrap(),
            Some(
                "The microphone delivered nothing for about 320s of this 3600s meeting".to_string()
            )
        );

        // A later clean finalize clears the caveat rather than leaving a stale one.
        db.finalize_recording_audio(
            &recording.id,
            &[(RecordingAudioRole::Primary, metadata)],
            1,
            "processing",
            None,
        )
        .unwrap();
        assert_eq!(
            db.get_capture_degraded_summary(&recording.id).unwrap(),
            None
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn asset_repair_preserves_encrypted_metadata_and_finds_unsettled_recordings() {
        let mut db = in_memory_db();
        let root = std::env::temp_dir().join(format!(
            "plainsong-asset-repair-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let plan = RecordingCapturePlan {
            recording_id: "repair-me".to_string(),
            primary_path: root.join("recording.wav"),
            mic_path: None,
            system_path: None,
        };
        let mut recording = sample_recording("repair-me", "inbox");
        recording.audio_path.clear();
        db.create_recording_with_audio_plan(&recording, &plan)
            .unwrap();
        db.mark_audio_assets_writing(&recording.id).unwrap();
        write_test_wav(&plan.primary_path);
        let RecordingAudioValidation::Ready(metadata) = validate_plaintext_wav(&plan.primary_path)
        else {
            panic!("valid wav fixture");
        };
        let expected_hash = metadata.plaintext_sha256.clone();
        db.finalize_recording_audio(
            &recording.id,
            &[(RecordingAudioRole::Primary, metadata)],
            1,
            "processing",
            None,
        )
        .unwrap();

        // A stop-time failure condemns the asset even though the file is fine,
        // leaving the recorded plaintext hash in place (this is what an encrypted
        // asset looks like after `switch_recording_audio_protection`).
        db.conn
            .execute(
                "UPDATE recording_audio_assets
                 SET lifecycle = 'failed', last_error = 'stop failed'
                 WHERE recording_id = ?1",
                params![&recording.id],
            )
            .unwrap();
        db.update_recording_status(&recording.id, "error").unwrap();
        assert_eq!(
            db.recording_ids_with_unsettled_audio_assets().unwrap(),
            vec!["repair-me".to_string()]
        );

        // Repairing without fresh metadata must keep the recorded hash, which is
        // what every runtime resolve compares an encrypted asset against.
        db.repair_audio_asset_lifecycles(
            &recording.id,
            &[(
                RecordingAudioRole::Primary,
                RecordingAudioLifecycle::Ready,
                None,
                None,
            )],
            None,
        )
        .unwrap();

        let repaired = db.load_recording_audio_bundle(&recording.id).unwrap();
        let primary = repaired.primary.as_ref().unwrap();
        assert_eq!(primary.lifecycle, RecordingAudioLifecycle::Ready);
        assert_eq!(primary.plaintext_sha256.as_deref(), Some(&*expected_hash));
        assert!(primary.last_error.is_none());
        assert_eq!(
            db.get_recording(&recording.id).unwrap().unwrap().status,
            "error",
            "a file-only repair must not restate the meeting's own status"
        );
        assert!(db
            .recording_ids_with_unsettled_audio_assets()
            .unwrap()
            .is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_backfill_is_exact_idempotent_and_prefers_encrypted_companions() {
        let mut db = in_memory_db();
        let root = std::env::temp_dir().join(format!(
            "plainsong-audio-backfill-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let primary = root.join("recording_legacy.wav.enc");
        let mic_plain = root.join("recording_legacy_mic.wav");
        let mic_encrypted = root.join("recording_legacy_mic.wav.enc");
        let system = root.join("recording_legacy_system.wav");
        let wrong = root.join("recording_legacy.wav_mic.wav");
        for path in [&primary, &mic_encrypted] {
            std::fs::write(path, b"encrypted fixture").unwrap();
        }
        write_test_wav(&mic_plain);
        write_test_wav(&system);
        write_test_wav(&wrong);

        let mut recording = sample_recording("legacy", "inbox");
        recording.status = "completed".to_string();
        recording.audio_path = primary.to_string_lossy().to_string();
        db.create_recording(&recording).unwrap();

        assert_eq!(
            db.backfill_legacy_recording_audio(std::slice::from_ref(&root))
                .unwrap(),
            3
        );
        let bundle = db.load_recording_audio_bundle("legacy").unwrap();
        assert_eq!(bundle.primary.as_ref().unwrap().path, primary);
        assert_eq!(
            bundle.primary.as_ref().unwrap().protection,
            RecordingAudioProtection::Encrypted
        );
        assert_eq!(bundle.mic.as_ref().unwrap().path, mic_encrypted);
        assert_eq!(bundle.system.as_ref().unwrap().path, system);
        assert_ne!(bundle.mic.as_ref().unwrap().path, wrong);
        assert_eq!(
            db.backfill_legacy_recording_audio(std::slice::from_ref(&root))
                .unwrap(),
            0
        );

        let _ = std::fs::remove_dir_all(&root);
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
    fn repairs_legacy_dictation_byte_counts_from_timing_artifacts() {
        let mut db = in_memory_db();
        let mut dictation = sample_recording("legacy-dictation", "inbox");
        dictation.source_type = "dictation".to_string();
        dictation.duration = 1_748_012;
        dictation.audio_path.clear();
        dictation.status = "completed".to_string();
        db.create_recording(&dictation).unwrap();
        db.save_transcript_artifact(&TranscriptArtifactRecord {
            id: "legacy-artifact".to_string(),
            recording_id: dictation.id.clone(),
            transcript_id: None,
            segment_count: 1,
            model_id: Some("base.en".to_string()),
            requested_provider: Some("whisper".to_string()),
            actual_provider: Some("whisper".to_string()),
            quality_score: Some(0.9),
            startup_latency_ms: Some(113),
            transcription_latency_ms: Some(316),
            insert_latency_ms: Some(2_402),
            end_to_end_ms: Some(21_126),
            created_at: Utc::now(),
        })
        .unwrap();

        assert_eq!(db.repair_legacy_dictation_durations().unwrap(), 1);
        assert_eq!(
            db.get_recording(&dictation.id)
                .unwrap()
                .expect("repaired recording")
                .duration,
            18
        );
        assert_eq!(db.repair_legacy_dictation_durations().unwrap(), 0);
    }

    /// A vault migrated a year ago does not encrypt what was captured since —
    /// capture writes a plain WAV. Only the counts can say what is on disk.
    #[test]
    fn encrypted_recording_count_reflects_the_files_not_the_vault_bit() {
        let db = in_memory_db();
        db.conn
            .execute_batch(
                "INSERT INTO recording_audio_assets (
                    recording_id, role, path, lifecycle, protection, created_at, updated_at
                 ) VALUES
                    ('r1', 'primary', '/tmp/r1.wav.enc', 'ready', 'encrypted', 'now', 'now'),
                    ('r2', 'primary', '/tmp/r2.wav.enc', 'ready', 'encrypted', 'now', 'now'),
                    ('r3', 'primary', '/tmp/r3.wav', 'ready', 'plaintext', 'now', 'now');",
            )
            .unwrap();

        assert_eq!(db.count_encrypted_recordings().unwrap(), (2, 3));
    }

    #[test]
    fn recordings_without_a_file_are_not_counted_as_unencrypted() {
        let db = in_memory_db();
        db.conn
            .execute(
                "INSERT INTO recording_audio_assets (
                    recording_id, role, path, lifecycle, protection, created_at, updated_at
                 ) VALUES ('r1', 'primary', '/tmp/r1.wav.enc', 'ready', 'encrypted', 'now', 'now')",
                [],
            )
            .unwrap();

        assert_eq!(db.count_encrypted_recordings().unwrap(), (1, 1));
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
    fn processing_transcript_persistence_does_not_publish_completion() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.update_recording_status("r1", "processing").unwrap();

        db.save_transcript(&sample_transcript("r1")).unwrap();

        assert_eq!(
            db.get_recording("r1").unwrap().unwrap().status,
            "processing"
        );
        assert!(db.get_transcript("r1").unwrap().is_some());
        assert_eq!(db.search_transcripts("hello", 10, None).unwrap().len(), 1);
    }

    #[test]
    fn completed_transcript_persistence_updates_transcript_fts_and_status_together() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();

        db.save_completed_transcript(&sample_transcript("r1"))
            .unwrap();

        let recording = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(recording.status, "completed");
        let transcript = db.get_transcript("r1").unwrap().unwrap();
        assert_eq!(transcript.segments[0].text, "Hello world");
        let hits = db.search_transcripts("hello", 10, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].segment_id, "s1");
    }

    #[test]
    fn completed_transcript_persistence_rolls_back_when_fts_rebuild_fails() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.conn.execute("DROP TABLE transcript_fts", []).unwrap();

        let error = db
            .save_completed_transcript(&sample_transcript("r1"))
            .expect_err("missing FTS table must fail the completion transaction");
        assert!(error.to_string().contains("transcript_fts"));
        assert!(db.get_transcript("r1").unwrap().is_none());
        assert_eq!(db.get_recording("r1").unwrap().unwrap().status, "recording");
    }

    #[test]
    fn enriched_segment_replacement_keeps_full_text_and_fts_consistent() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_completed_transcript(&sample_transcript("r1"))
            .unwrap();

        let enriched = vec![TranscriptSegment {
            id: "enriched-1".to_string(),
            start_time: 0.0,
            end_time: 5.0,
            text: "Diarized replacement".to_string(),
            speaker_id: Some("S1".to_string()),
            confidence: 0.95,
        }];
        db.update_transcript_segments("r1", &enriched).unwrap();

        let transcript = db.get_transcript("r1").unwrap().unwrap();
        assert_eq!(transcript.full_text, "Diarized replacement");
        assert_eq!(transcript.segments[0].speaker_id.as_deref(), Some("S1"));
        assert!(db.search_transcripts("hello", 10, None).unwrap().is_empty());
        let hits = db.search_transcripts("diarized", 10, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].segment_id, "enriched-1");
    }

    #[test]
    fn enriched_segment_replacement_rolls_back_when_fts_rebuild_fails() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_completed_transcript(&sample_transcript("r1"))
            .unwrap();
        db.conn.execute("DROP TABLE transcript_fts", []).unwrap();

        let enriched = vec![TranscriptSegment {
            id: "enriched-1".to_string(),
            start_time: 0.0,
            end_time: 5.0,
            text: "Diarized replacement".to_string(),
            speaker_id: Some("speaker_1".to_string()),
            confidence: 0.95,
        }];
        let error = db
            .update_transcript_segments("r1", &enriched)
            .expect_err("missing FTS table must roll back segment replacement");
        assert!(error.to_string().contains("transcript_fts"));

        let transcript = db.get_transcript("r1").unwrap().unwrap();
        assert_eq!(transcript.full_text, "Hello world");
        assert_eq!(transcript.segments[0].id, "s1");
    }

    #[test]
    fn stale_diarization_revision_cannot_overwrite_user_edits_or_deletes() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("edited", "inbox"))
            .unwrap();
        db.save_completed_transcript(&sample_transcript("edited"))
            .unwrap();
        let (_, edit_revision) = db.get_transcript_with_revision("edited").unwrap().unwrap();
        db.update_transcript_segment("edited", "s1", "User correction")
            .unwrap();

        let stale_segments = vec![TranscriptSegment {
            id: "s1".to_string(),
            start_time: 0.0,
            end_time: 5.0,
            text: "Hello world".to_string(),
            speaker_id: Some("speaker_1".to_string()),
            confidence: 0.95,
        }];
        assert!(!db
            .apply_diarization_enrichment("edited", edit_revision, &stale_segments, &[])
            .unwrap());
        let edited = db.get_transcript("edited").unwrap().unwrap();
        assert_eq!(edited.full_text, "User correction");
        assert_eq!(edited.segments[0].speaker_id.as_deref(), Some("speaker_0"));

        db.create_recording(&sample_recording("deleted", "inbox"))
            .unwrap();
        db.save_completed_transcript(&sample_transcript("deleted"))
            .unwrap();
        let (_, delete_revision) = db.get_transcript_with_revision("deleted").unwrap().unwrap();
        db.delete_transcript_segments("deleted", &["s1".to_string()])
            .unwrap();
        assert!(!db
            .apply_diarization_enrichment("deleted", delete_revision, &stale_segments, &[])
            .unwrap());
        let deleted = db.get_transcript("deleted").unwrap().unwrap();
        assert!(deleted.segments.is_empty());
        assert!(deleted.full_text.is_empty());
    }

    #[test]
    fn diarization_transcript_fts_and_aliases_roll_back_as_one_transaction() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_completed_transcript(&sample_transcript("r1"))
            .unwrap();
        let (_, revision) = db.get_transcript_with_revision("r1").unwrap().unwrap();
        db.conn
            .execute_batch(
                "CREATE TRIGGER fail_second_diarization_alias
                 BEFORE INSERT ON speaker_aliases
                 WHEN NEW.speaker_id = 'speaker_1'
                 BEGIN
                    SELECT RAISE(ABORT, 'injected alias failure');
                 END;",
            )
            .unwrap();

        let enriched = vec![
            TranscriptSegment {
                id: "enriched-0".to_string(),
                start_time: 0.0,
                end_time: 2.5,
                text: "Diarized first".to_string(),
                speaker_id: Some("speaker_0".to_string()),
                confidence: 0.95,
            },
            TranscriptSegment {
                id: "enriched-1".to_string(),
                start_time: 2.5,
                end_time: 5.0,
                text: "Diarized second".to_string(),
                speaker_id: Some("speaker_1".to_string()),
                confidence: 0.95,
            },
        ];
        let aliases = vec![
            SpeakerAliasUpsert {
                speaker_id: "speaker_0".to_string(),
                name: Some("Alice".to_string()),
                color: Some("#ff0000".to_string()),
                sample_count: 1,
            },
            SpeakerAliasUpsert {
                speaker_id: "speaker_1".to_string(),
                name: Some("Bob".to_string()),
                color: Some("#00ff00".to_string()),
                sample_count: 1,
            },
        ];

        let error = db
            .apply_diarization_enrichment("r1", revision, &enriched, &aliases)
            .expect_err("alias failure must roll back the full enrichment transaction");
        assert!(error.to_string().contains("injected alias failure"));

        let transcript = db.get_transcript("r1").unwrap().unwrap();
        assert_eq!(transcript.full_text, "Hello world");
        assert_eq!(transcript.segments[0].id, "s1");
        assert_eq!(db.search_transcripts("hello", 10, None).unwrap().len(), 1);
        assert!(db
            .search_transcripts("diarized", 10, None)
            .unwrap()
            .is_empty());
        assert!(db.get_speaker_aliases("r1").unwrap().is_empty());
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
    fn atomic_speaker_turn_edit_preserves_order_and_updates_derived_state_once() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_transcript(&sample_multi_segment_transcript("r1"))
            .unwrap();
        let summary = "Generated summary";
        let action_items = vec!["Generated action".to_string()];
        db.patch_recording_analysis_with_provenance(
            "r1",
            Some(Some(summary)),
            Some(&action_items),
            Some(&sample_summary_provenance(summary)),
            Some(&sample_action_items_provenance(&action_items)),
        )
        .unwrap();
        db.save_embedding("r1", "s2", "second segment", &[0.1, 0.2], "m", 1.0, 2.0)
            .unwrap();
        let (_, before_revision) = db.get_transcript_with_revision("r1").unwrap().unwrap();

        db.edit_transcript_speaker_turn(
            "r1",
            &["s2".to_string(), "s3".to_string()],
            "corrected speaker turn",
        )
        .unwrap();

        let (updated, after_revision) = db.get_transcript_with_revision("r1").unwrap().unwrap();
        assert_eq!(after_revision, before_revision + 1);
        assert_eq!(
            updated
                .segments
                .iter()
                .map(|segment| segment.id.as_str())
                .collect::<Vec<_>>(),
            vec!["s1", "s2", "s4"]
        );
        assert_eq!(updated.segments[1].text, "corrected speaker turn");
        assert_eq!(updated.segments[1].start_time, 1.0);
        assert_eq!(
            updated.full_text,
            "first segment corrected speaker turn fourth segment"
        );
        assert!(db.search_transcripts("third", 10, None).unwrap().is_empty());
        assert_eq!(
            db.search_transcripts("corrected", 10, None).unwrap()[0].segment_id,
            "s2"
        );
        assert!(!db.has_embeddings("r1"));
        let recording = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(recording.summary.as_deref(), Some(summary));
        assert_eq!(recording.action_items, Some(action_items));
        assert!(recording.summary_provenance.is_none());
        assert!(recording.action_items_provenance.is_none());
    }

    #[test]
    fn atomic_speaker_turn_edit_rejects_blank_missing_and_non_unique_segments() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_transcript(&sample_multi_segment_transcript("r1"))
            .unwrap();
        let (_, before_revision) = db.get_transcript_with_revision("r1").unwrap().unwrap();

        let blank = db
            .edit_transcript_speaker_turn("r1", &["s1".to_string()], "   \n")
            .expect_err("blank speaker-turn text must fail");
        assert!(blank.to_string().contains("cannot be blank"));
        let missing = db
            .edit_transcript_speaker_turn("r1", &["missing".to_string()], "replacement")
            .expect_err("missing segment IDs must fail");
        assert!(missing.to_string().contains("was not found"));
        let duplicate_request = db
            .edit_transcript_speaker_turn(
                "r1",
                &["s1".to_string(), "s1".to_string()],
                "replacement",
            )
            .expect_err("duplicate requested IDs must fail");
        assert!(duplicate_request
            .to_string()
            .contains("requested more than once"));
        assert_eq!(
            db.get_transcript_with_revision("r1").unwrap().unwrap().1,
            before_revision
        );

        let mut duplicate_segments = sample_multi_segment_transcript("r1");
        duplicate_segments.segments[1].id = "s1".to_string();
        db.save_transcript(&duplicate_segments).unwrap();
        let duplicate_stored = db
            .edit_transcript_speaker_turn("r1", &["s1".to_string()], "replacement")
            .expect_err("stored duplicate segment IDs must fail");
        assert!(duplicate_stored.to_string().contains("appears 2 times"));
    }

    #[test]
    fn atomic_speaker_turn_edit_rolls_back_every_derived_write_on_fts_failure() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_transcript(&sample_multi_segment_transcript("r1"))
            .unwrap();
        let summary = "Generated summary";
        let action_items = vec!["Generated action".to_string()];
        db.patch_recording_analysis_with_provenance(
            "r1",
            Some(Some(summary)),
            Some(&action_items),
            Some(&sample_summary_provenance(summary)),
            Some(&sample_action_items_provenance(&action_items)),
        )
        .unwrap();
        db.save_embedding("r1", "s2", "second segment", &[0.1, 0.2], "m", 1.0, 2.0)
            .unwrap();
        let (_, before_revision) = db.get_transcript_with_revision("r1").unwrap().unwrap();
        db.conn.execute("DROP TABLE transcript_fts", []).unwrap();

        let error = db
            .edit_transcript_speaker_turn(
                "r1",
                &["s2".to_string(), "s3".to_string()],
                "corrected speaker turn",
            )
            .expect_err("FTS failure must roll back the speaker-turn edit");
        assert!(error.to_string().contains("transcript_fts"));

        let (transcript, after_revision) = db.get_transcript_with_revision("r1").unwrap().unwrap();
        assert_eq!(after_revision, before_revision);
        assert_eq!(
            transcript.full_text,
            sample_multi_segment_transcript("r1").full_text
        );
        assert!(db.has_embeddings("r1"));
        let recording = db.get_recording("r1").unwrap().unwrap();
        assert!(recording.summary_provenance.is_some());
        assert!(recording.action_items_provenance.is_some());
    }

    #[test]
    fn every_transcript_mutation_invalidates_embeddings_and_diarization_provenance() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_transcript(&sample_multi_segment_transcript("r1"))
            .unwrap();

        db.save_embedding("r1", "s1", "first segment", &[0.1, 0.2], "m", 0.0, 1.0)
            .unwrap();
        db.update_transcript_segment("r1", "s1", "edited first segment")
            .unwrap();
        assert!(!db.has_embeddings("r1"));

        db.save_embedding("r1", "s3", "third segment", &[0.1, 0.2], "m", 2.0, 3.0)
            .unwrap();
        db.delete_transcript_segments("r1", &["s3".to_string()])
            .unwrap();
        assert!(!db.has_embeddings("r1"));

        let replacement = db.get_transcript("r1").unwrap().unwrap().segments;
        db.save_embedding("r1", "s2", "second segment", &[0.1, 0.2], "m", 1.0, 2.0)
            .unwrap();
        db.update_transcript_segments("r1", &replacement).unwrap();
        assert!(!db.has_embeddings("r1"));

        let summary = "Generated summary";
        let action_items = vec!["Generated action".to_string()];
        db.patch_recording_analysis_with_provenance(
            "r1",
            Some(Some(summary)),
            Some(&action_items),
            Some(&sample_summary_provenance(summary)),
            Some(&sample_action_items_provenance(&action_items)),
        )
        .unwrap();
        db.save_embedding("r1", "s2", "second segment", &[0.1, 0.2], "m", 1.0, 2.0)
            .unwrap();
        let (mut diarized, revision) = db.get_transcript_with_revision("r1").unwrap().unwrap();
        diarized.segments[0].speaker_id = Some("speaker_9".to_string());
        assert!(db
            .apply_diarization_enrichment("r1", revision, &diarized.segments, &[])
            .unwrap());
        assert!(!db.has_embeddings("r1"));
        let recording = db.get_recording("r1").unwrap().unwrap();
        assert!(recording.summary_provenance.is_none());
        assert!(recording.action_items_provenance.is_none());

        db.save_embedding(
            "r1",
            "s1",
            "edited first segment",
            &[0.1, 0.2],
            "m",
            0.0,
            1.0,
        )
        .unwrap();
        db.save_transcript(&sample_multi_segment_transcript("r1"))
            .unwrap();
        assert!(!db.has_embeddings("r1"));
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
    fn delete_recording_rejects_capture_and_processing_states() {
        for status in ["recording", "processing"] {
            let mut db = in_memory_db();
            db.create_recording(&sample_recording("r1", "inbox"))
                .unwrap();
            db.save_transcript(&sample_transcript("r1")).unwrap();
            db.update_recording_status("r1", status).unwrap();

            let error = db
                .delete_recording("r1")
                .expect_err("active recording pipelines must not be deleted");
            assert!(error.to_string().contains(status));
            assert!(db.get_recording("r1").unwrap().is_some());
            assert!(db.get_transcript("r1").unwrap().is_some());
        }
    }

    #[test]
    fn test_delete_recording_removes_transcript() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_transcript(&sample_transcript("r1")).unwrap();
        db.update_recording_status("r1", "completed").unwrap();

        let audio_path = db.delete_recording("r1").unwrap();
        assert_eq!(audio_path, "/tmp/r1.wav");

        assert!(db.get_recording("r1").unwrap().is_none());
        assert!(db.get_transcript("r1").unwrap().is_none());
        let hits = db.search_transcripts("hello", 10, None).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn test_delete_recording_removes_artifacts_and_embeddings() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_transcript(&sample_transcript("r1")).unwrap();
        db.save_meeting_artifact(&sample_meeting_artifact())
            .unwrap();
        db.save_embedding("r1", "s1", "hello world", &[0.1, 0.2, 0.3], "m", 0.0, 1.0)
            .unwrap();
        db.conn
            .execute_batch(
                "INSERT INTO transcript_artifacts (id, recording_id, created_at)
                     VALUES ('artifact-r1', 'r1', '2026-01-01');
                 INSERT INTO insertion_actions (
                     id, recording_id, requested_mode, actual_mode, created_at
                 ) VALUES ('insertion-r1', 'r1', 'paste', 'paste', '2026-01-01');",
            )
            .unwrap();
        assert!(db.has_embeddings("r1"));
        db.update_recording_status("r1", "completed").unwrap();

        db.delete_recording("r1").unwrap();

        assert!(db.get_meeting_artifact("r1").unwrap().is_none());
        assert!(!db.has_embeddings("r1"));
        for table in ["transcript_artifacts", "insertion_actions"] {
            let count: i64 = db
                .conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE recording_id = 'r1'"),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 0, "delete_recording must remove {table}");
        }
    }

    #[test]
    fn test_purge_user_content_removes_meeting_artifacts() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_meeting_artifact(&sample_meeting_artifact())
            .unwrap();

        db.purge_user_content().unwrap();

        assert!(db.get_meeting_artifact("r1").unwrap().is_none());
    }

    #[test]
    fn purge_user_content_clears_every_reset_scoped_table_and_recreates_inboxes() {
        let mut db = in_memory_db();
        db.conn
            .execute_batch(
                "INSERT INTO projects (id, name, created_at, updated_at)
                     VALUES ('user-project', 'User project', '2026-01-01', '2026-01-01');
                 INSERT INTO recordings (
                     id, title, project_id, created_at, updated_at, source_type, status
                 ) VALUES (
                     'recording-1', 'Recording', 'user-project', '2026-01-01',
                     '2026-01-01', 'meeting', 'completed'
                 );
                 INSERT INTO transcripts (
                     id, recording_id, segments, full_text, language, confidence, model, created_at
                 ) VALUES (
                     'transcript-1', 'recording-1', '[]', 'private transcript', 'en', 1.0,
                     'test', '2026-01-01'
                 );
                 INSERT INTO transcript_fts (recording_id, segment_id, text, start_time, end_time)
                     VALUES ('recording-1', 'segment-1', 'private transcript', 0, 1);
                 INSERT INTO transcript_embeddings (
                     recording_id, segment_id, text, embedding, model, created_at
                 ) VALUES (
                     'recording-1', 'segment-1', 'private transcript', X'00000000',
                     'test', '2026-01-01'
                 );
                 INSERT INTO meeting_artifacts (
                     id, recording_id, action_items, decisions, deadlines, chat_messages,
                     created_at, updated_at
                 ) VALUES (
                     'artifact-1', 'recording-1', '[]', '[]', '[]', '[]',
                     '2026-01-01', '2026-01-01'
                 );
                 INSERT INTO speaker_aliases (
                     recording_id, speaker_id, name, sample_count, updated_at
                 ) VALUES ('recording-1', 'speaker-1', 'Private Person', 1, '2026-01-01');
                 INSERT INTO audit_log (id, timestamp, event, details, severity)
                     VALUES ('audit-1', '2026-01-01', 'private', '{}', 'info');
                 INSERT INTO runtime_events (id, event_type, payload, created_at)
                     VALUES ('runtime-1', 'private', '{}', '2026-01-01');
                 INSERT INTO capture_sessions (
                     id, surface, state, started_at, audio_sources, created_at, updated_at
                 ) VALUES (
                     'capture-1', 'dictation', 'completed', '2026-01-01', '[]',
                     '2026-01-01', '2026-01-01'
                 );
                 INSERT INTO context_snapshots (id, selected_text, clipboard_text, created_at)
                     VALUES ('context-1', 'selected', 'clipboard', '2026-01-01');
                 INSERT INTO policy_snapshots (
                     id, retention_mode, storage_mode, provider_policy, ai_policy,
                     insertion_policy, export_constraints, created_at
                 ) VALUES (
                     'policy-1', 'private', 'local', '{}', '{}', '{}', '{}', '2026-01-01'
                 );
                 INSERT INTO transcript_artifacts (id, recording_id, created_at)
                     VALUES ('transcript-artifact-1', 'recording-1', '2026-01-01');
                 INSERT INTO insertion_actions (
                     id, requested_mode, actual_mode, created_at
                 ) VALUES ('insertion-1', 'paste', 'paste', '2026-01-01');
                 INSERT INTO asr_benchmarks (
                     id, provider_type, provider_name, model_id, runtime_status,
                     processing_time_ms, confidence, created_at
                 ) VALUES (
                     'benchmark-1', 'local', 'test', 'test', 'ready', 1, 1.0, '2026-01-01'
                 );
                 INSERT INTO dictation_dictionary_entries (
                     id, spoken_form, replacement, created_at, updated_at
                 ) VALUES ('dictionary-1', 'secret', 'replacement', '2026-01-01', '2026-01-01');
                 INSERT INTO dictation_snippets (
                     id, trigger, expansion, created_at, updated_at
                 ) VALUES ('snippet-1', 'secret', 'private expansion', '2026-01-01', '2026-01-01');
                 INSERT INTO dictation_command_presets (
                     id, command_key, system_prompt, created_at, updated_at
                 ) VALUES ('preset-1', 'private', 'private prompt', '2026-01-01', '2026-01-01');
                 INSERT INTO dictation_correction_suggestions (
                     id, original_text, corrected_text, spoken_form, replacement,
                     created_at, updated_at
                 ) VALUES (
                     'correction-1', 'wrong', 'right', 'wrong', 'right',
                     '2026-01-01', '2026-01-01'
                 );",
            )
            .unwrap();

        db.purge_user_content().unwrap();

        for (table_name, _) in RESET_SCOPED_TABLE_DELETES {
            let row_count: i64 = db
                .conn
                .query_row(&format!("SELECT COUNT(*) FROM {table_name}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            let expected = if table_name == "projects" { 2 } else { 0 };
            assert_eq!(
                row_count, expected,
                "unexpected row count after reset for {table_name}"
            );
        }

        let project_ids = db
            .conn
            .prepare("SELECT id FROM projects ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            project_ids,
            vec!["default".to_string(), "inbox".to_string()]
        );

        verify_audit_log_append_only_triggers(&db.conn).unwrap();
        db.log_audit_event("after_reset", None, "info").unwrap();
        assert!(db.conn.execute("DELETE FROM audit_log", []).is_err());
        assert!(db
            .conn
            .execute("UPDATE audit_log SET event = 'changed'", [])
            .is_err());
    }

    #[test]
    fn reset_schema_coverage_requires_every_application_table_to_be_classified() {
        const INTENTIONALLY_PRESERVED_APPLICATION_TABLES: [&str; 0] = [];
        const FTS5_IMPLEMENTATION_TABLES: [&str; 5] = [
            "transcript_fts_config",
            "transcript_fts_content",
            "transcript_fts_data",
            "transcript_fts_docsize",
            "transcript_fts_idx",
        ];

        let db = in_memory_db();
        let actual_tables: BTreeSet<String> = db
            .conn
            .prepare(
                "SELECT name
                 FROM sqlite_schema
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();

        let reset_scoped: BTreeSet<String> = RESET_SCOPED_TABLE_DELETES
            .iter()
            .map(|(table_name, _)| (*table_name).to_string())
            .collect();
        let intentionally_preserved: BTreeSet<String> = INTENTIONALLY_PRESERVED_APPLICATION_TABLES
            .iter()
            .map(|table_name| (*table_name).to_string())
            .collect();
        assert!(
            reset_scoped.is_disjoint(&intentionally_preserved),
            "a table cannot be both reset-scoped and intentionally preserved"
        );

        let mut classified_tables = reset_scoped;
        classified_tables.extend(intentionally_preserved);
        classified_tables.extend(
            FTS5_IMPLEMENTATION_TABLES
                .iter()
                .map(|table_name| (*table_name).to_string()),
        );

        assert_eq!(
            actual_tables, classified_tables,
            "Every new application table must be explicitly added to Reset Everything or to the intentionally-preserved classification"
        );
    }

    #[test]
    fn purge_user_content_rolls_back_all_rows_and_trigger_changes_on_failure() {
        let mut db = in_memory_db();
        db.conn
            .execute_batch(
                "INSERT INTO speaker_aliases (
                     recording_id, speaker_id, name, sample_count, updated_at
                 ) VALUES ('recording-1', 'speaker-1', 'Private Person', 1, '2026-01-01');
                 INSERT INTO runtime_events (id, event_type, payload, created_at)
                 VALUES ('runtime-1', 'private', '{}', '2026-01-01');",
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO dictation_snippets (
                     id, trigger, expansion, created_at, updated_at
                 ) VALUES ('snippet-1', 'private', 'private', '2026-01-01', '2026-01-01')",
                [],
            )
            .unwrap();
        db.conn
            .execute_batch(
                "CREATE TRIGGER fail_runtime_event_reset
                 BEFORE DELETE ON runtime_events
                 BEGIN
                     SELECT RAISE(ABORT, 'forced reset failure');
                 END;",
            )
            .unwrap();

        assert!(db.purge_user_content().is_err());

        let speaker_alias_count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM speaker_aliases", [], |row| row.get(0))
            .unwrap();
        let runtime_count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM runtime_events", [], |row| row.get(0))
            .unwrap();
        let snippet_count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM dictation_snippets", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(speaker_alias_count, 1);
        assert_eq!(runtime_count, 1);
        assert_eq!(snippet_count, 1);
        verify_audit_log_append_only_triggers(&db.conn).unwrap();
    }

    #[test]
    fn test_search_embeddings_excludes_deleted_recordings() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.create_recording(&sample_recording("r2", "inbox"))
            .unwrap();
        db.save_embedding("r1", "s1", "kept", &[1.0, 0.0], "m", 0.0, 1.0)
            .unwrap();
        // Simulate a legacy orphaned embedding whose recording row is gone.
        db.save_embedding("r2", "s2", "orphaned", &[1.0, 0.0], "m", 0.0, 1.0)
            .unwrap();
        db.conn
            .execute("DELETE FROM recordings WHERE id = 'r2'", [])
            .unwrap();

        let hits = db.search_embeddings(&[1.0, 0.0], 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].recording_id, "r1");
        assert_eq!(hits[0].recording_title, "Recording r1");
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
    fn new_audit_details_recursively_drop_sensitive_context_fields() {
        let mut db = in_memory_db();
        db.log_audit_event(
            "context_test",
            Some(serde_json::json!({
                "context_preview": "remove root",
                "contextPreview": "preserve unrelated alias",
                "keep": "root value",
                "nested": {
                    "selected_text": "remove nested",
                    "selectedText": "preserve unrelated nested alias",
                    "keep_nested": 42,
                },
                "items": [
                    {
                        "clipboard_text": "remove array object",
                        "clipboardText": "preserve unrelated array alias",
                        "keep_array": true,
                    },
                    [
                        {
                            "captured_context_text": "remove deeply nested",
                            "capturedContextText": "preserve unrelated deep alias",
                            "keep_deep": [1, 2, 3],
                        }
                    ]
                ]
            })),
            "info",
        )
        .unwrap();

        let details: String = db
            .conn
            .query_row(
                "SELECT details FROM audit_log WHERE event = 'context_test'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let details: serde_json::Value = serde_json::from_str(&details).unwrap();

        assert_eq!(details["keep"], "root value");
        assert_eq!(details["contextPreview"], "preserve unrelated alias");
        assert_eq!(details["nested"]["keep_nested"], 42);
        assert_eq!(
            details["nested"]["selectedText"],
            "preserve unrelated nested alias"
        );
        assert_eq!(details["items"][0]["keep_array"], true);
        assert_eq!(
            details["items"][0]["clipboardText"],
            "preserve unrelated array alias"
        );
        assert_eq!(
            details["items"][1][0]["keep_deep"],
            serde_json::json!([1, 2, 3])
        );
        assert_eq!(
            details["items"][1][0]["capturedContextText"],
            "preserve unrelated deep alias"
        );
        for sensitive_key in SENSITIVE_AUDIT_DETAIL_KEYS {
            assert!(
                !details.to_string().contains(sensitive_key),
                "sensitive audit key remained: {sensitive_key}"
            );
        }
    }

    #[test]
    fn startup_scrub_updates_only_valid_sensitive_audit_details_and_restores_triggers() {
        let mut db = in_memory_db();
        let original_timestamp = "2026-07-25T12:34:56Z";
        let sensitive_details = r#"{
            "keep":"root",
            "context_preview":"remove",
            "contextPreview":"preserve root alias",
            "nested":{
                "selected_text":"remove",
                "selectedText":"preserve nested alias",
                "keep_nested":{"value":7}
            },
            "array":[{
                "clipboard_text":"remove",
                "clipboardText":"preserve array alias",
                "keep_array":"yes"
            }],
            "captured_context_text":"remove",
            "capturedContextText":"preserve captured alias"
        }"#;
        let malformed_details = r#"{"selected_text":"unterminated"#;
        let clean_details = r#"{ "keep_formatting" : [1, 2, 3] }"#;
        db.conn
            .execute(
                "INSERT INTO audit_log (id, timestamp, event, details, severity)
                 VALUES ('sensitive', ?1, 'legacy_sensitive', ?2, 'warn')",
                params![original_timestamp, sensitive_details],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO audit_log (id, timestamp, event, details, severity)
                 VALUES ('malformed', ?1, 'legacy_malformed', ?2, 'error')",
                params![original_timestamp, malformed_details],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO audit_log (id, timestamp, event, details, severity)
                 VALUES ('clean', ?1, 'legacy_clean', ?2, 'info')",
                params![original_timestamp, clean_details],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO audit_log (id, timestamp, event, details, severity)
                 VALUES ('non-text', ?1, 'legacy_non_text', X'7BFF7D', 'error')",
                [original_timestamp],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO audit_log (id, timestamp, event, details, severity)
                 VALUES (
                     'invalid-utf8', ?1, 'legacy_invalid_utf8', CAST(X'7BFF7D' AS TEXT), 'error'
                 )",
                [original_timestamp],
            )
            .unwrap();

        db.init_tables().unwrap();

        let sensitive_row: (String, String, String, String) = db
            .conn
            .query_row(
                "SELECT timestamp, event, details, severity FROM audit_log WHERE id = 'sensitive'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(sensitive_row.0, original_timestamp);
        assert_eq!(sensitive_row.1, "legacy_sensitive");
        assert_eq!(sensitive_row.3, "warn");
        let scrubbed: serde_json::Value = serde_json::from_str(&sensitive_row.2).unwrap();
        assert_eq!(
            scrubbed,
            serde_json::json!({
                "keep": "root",
                "contextPreview": "preserve root alias",
                "nested": {
                    "selectedText": "preserve nested alias",
                    "keep_nested": {"value": 7}
                },
                "array": [{
                    "clipboardText": "preserve array alias",
                    "keep_array": "yes"
                }],
                "capturedContextText": "preserve captured alias",
            })
        );

        let malformed_after: String = db
            .conn
            .query_row(
                "SELECT details FROM audit_log WHERE id = 'malformed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(malformed_after, malformed_details);
        let clean_after: String = db
            .conn
            .query_row(
                "SELECT details FROM audit_log WHERE id = 'clean'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(clean_after, clean_details);
        let non_text_after: (String, String) = db
            .conn
            .query_row(
                "SELECT typeof(details), hex(details) FROM audit_log WHERE id = 'non-text'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(non_text_after, ("blob".to_string(), "7BFF7D".to_string()));
        let invalid_utf8_after: (String, String) = db
            .conn
            .query_row(
                "SELECT typeof(details), hex(details) FROM audit_log WHERE id = 'invalid-utf8'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            invalid_utf8_after,
            ("text".to_string(), "7BFF7D".to_string())
        );

        let first_scrubbed_json = sensitive_row.2;
        let second_counts = db.scrub_sensitive_audit_details().unwrap();
        assert_eq!(second_counts.rows_scanned, 5);
        assert_eq!(second_counts.rows_updated, 0);
        assert_eq!(second_counts.malformed_rows, 3);
        assert_eq!(second_counts.sensitive_fields_removed, 0);
        let sensitive_after_second_scrub: String = db
            .conn
            .query_row(
                "SELECT details FROM audit_log WHERE id = 'sensitive'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sensitive_after_second_scrub, first_scrubbed_json);

        verify_audit_log_append_only_triggers(&db.conn).unwrap();
        assert!(db
            .conn
            .execute(
                "UPDATE audit_log SET severity = 'info' WHERE id = 'sensitive'",
                []
            )
            .is_err());
        assert!(db
            .conn
            .execute("DELETE FROM audit_log WHERE id = 'sensitive'", [])
            .is_err());
    }

    #[test]
    fn startup_scrub_rolls_back_details_and_restores_triggers_on_failure() {
        let mut db = in_memory_db();
        let original_details = r#"{"context_preview":"must remain after rollback","keep":true}"#;
        db.conn
            .execute(
                "INSERT INTO audit_log (id, timestamp, event, details, severity)
                 VALUES ('sensitive', '2026-07-25T12:34:56Z', 'legacy_sensitive', ?1, 'warn')",
                [original_details],
            )
            .unwrap();
        db.conn
            .execute_batch(
                "CREATE TRIGGER fail_audit_detail_scrub
                 BEFORE UPDATE ON audit_log
                 WHEN OLD.id = 'sensitive'
                 BEGIN
                     SELECT RAISE(ABORT, 'forced audit scrub failure');
                 END;",
            )
            .unwrap();

        assert!(db.scrub_sensitive_audit_details().is_err());

        let details_after: String = db
            .conn
            .query_row(
                "SELECT details FROM audit_log WHERE id = 'sensitive'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(details_after, original_details);
        verify_audit_log_append_only_triggers(&db.conn).unwrap();
        assert!(db
            .conn
            .execute(
                "UPDATE audit_log SET severity = 'info' WHERE id = 'sensitive'",
                []
            )
            .is_err());
        assert!(db
            .conn
            .execute("DELETE FROM audit_log WHERE id = 'sensitive'", [])
            .is_err());
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
        db.create_recording(&sample_recording("recording-1", "inbox"))
            .unwrap();
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
        db.create_recording(&sample_recording("recording-1", "inbox"))
            .unwrap();
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
    fn test_patch_recording_analysis_preserves_prior_success_on_partial_failure() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("r1", "inbox");
        recording.summary = Some("Prior summary".to_string());
        recording.action_items = Some(vec!["Prior action".to_string()]);
        db.create_recording(&recording).unwrap();
        db.update_recording_analysis("r1", Some("Prior summary"), &["Prior action".to_string()])
            .unwrap();

        db.patch_recording_analysis("r1", None, Some(&["New action".to_string()]))
            .unwrap();
        let after_action_only = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(after_action_only.summary.as_deref(), Some("Prior summary"));
        assert_eq!(
            after_action_only.action_items,
            Some(vec!["New action".to_string()])
        );

        db.patch_recording_analysis("r1", Some("New summary"), None)
            .unwrap();
        let after_summary_only = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(after_summary_only.summary.as_deref(), Some("New summary"));
        assert_eq!(
            after_summary_only.action_items,
            Some(vec!["New action".to_string()])
        );
    }

    #[test]
    fn meeting_artifact_migration_adds_provenance_without_losing_legacy_content() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE meeting_artifacts (
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
             );
             INSERT INTO meeting_artifacts (
                id, recording_id, title, summary, action_items, decisions, deadlines,
                template_id, chat_messages, created_at, updated_at
             ) VALUES (
                'legacy-artifact', 'legacy-recording', 'Legacy', 'Saved summary',
                '[\"Saved action\"]', '[]', '[]', NULL, '[]',
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
             );",
        )
        .unwrap();
        let mut db = Database {
            conn,
            encrypted: false,
        };
        db.init_tables().unwrap();

        let artifact = db
            .get_meeting_artifact("legacy-recording")
            .unwrap()
            .unwrap();
        assert_eq!(artifact.summary.as_deref(), Some("Saved summary"));
        assert_eq!(artifact.action_items, vec!["Saved action".to_string()]);
        assert!(artifact.summary_provenance.is_none());
        assert!(artifact.action_items_provenance.is_none());

        let columns = db
            .conn
            .prepare("PRAGMA table_info(meeting_artifacts)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert!(columns.contains(&"summary_provenance".to_string()));
        assert!(columns.contains(&"action_items_provenance".to_string()));
    }

    #[test]
    fn persisted_analysis_reloads_citations_provider_model_and_grounded_state() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let summary = "Persisted grounded summary";
        let action_items = vec!["Ship the release".to_string()];
        let summary_provenance = sample_summary_provenance(summary);
        let action_items_provenance = sample_action_items_provenance(&action_items);

        db.patch_recording_analysis_with_provenance(
            "r1",
            Some(Some(summary)),
            Some(&action_items),
            Some(&summary_provenance),
            Some(&action_items_provenance),
        )
        .unwrap();

        let reloaded = db.get_recording("r1").unwrap().unwrap();
        let summary_reloaded = reloaded.summary_provenance.unwrap();
        assert_eq!(summary_reloaded.actual_provider, "ollama");
        assert_eq!(summary_reloaded.actual_model, "llama3.2");
        assert_eq!(summary_reloaded.citations[0].line_id.as_deref(), Some("L1"));
        assert_eq!(
            summary_reloaded.citations[0].segment_id.as_deref(),
            Some("s1")
        );
        assert_eq!(summary_reloaded.citations[0].start_time, Some(10.0));
        assert!(summary_reloaded.grounded);
        let actions_reloaded = reloaded.action_items_provenance.unwrap();
        assert_eq!(actions_reloaded.items.len(), 1);
        assert_eq!(
            actions_reloaded.items[0].citations[0].text,
            "Canonical transcript evidence"
        );
    }

    #[test]
    fn manual_summary_edit_invalidates_only_stale_summary_provenance() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let summary = "Generated summary";
        let action_items = vec!["Generated action".to_string()];
        db.patch_recording_analysis_with_provenance(
            "r1",
            Some(Some(summary)),
            Some(&action_items),
            Some(&sample_summary_provenance(summary)),
            Some(&sample_action_items_provenance(&action_items)),
        )
        .unwrap();

        db.patch_recording_analysis_with_provenance(
            "r1",
            Some(Some("Edited by the user")),
            None,
            None,
            None,
        )
        .unwrap();

        let reloaded = db.get_recording("r1").unwrap().unwrap();
        assert!(reloaded.summary_provenance.is_none());
        assert!(reloaded.action_items_provenance.is_some());
        assert_eq!(reloaded.action_items, Some(action_items));
    }

    #[test]
    fn transcript_edit_invalidates_stale_citations_without_erasing_analysis_content() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_transcript(&sample_transcript("r1")).unwrap();
        let summary = "Generated summary";
        let action_items = vec!["Generated action".to_string()];
        db.patch_recording_analysis_with_provenance(
            "r1",
            Some(Some(summary)),
            Some(&action_items),
            Some(&sample_summary_provenance(summary)),
            Some(&sample_action_items_provenance(&action_items)),
        )
        .unwrap();

        assert!(db
            .update_transcript_segment("r1", "s1", "Corrected transcript text")
            .unwrap());

        let reloaded = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(reloaded.summary.as_deref(), Some(summary));
        assert_eq!(reloaded.action_items, Some(action_items));
        assert!(reloaded.summary_provenance.is_none());
        assert!(reloaded.action_items_provenance.is_none());
    }

    #[test]
    fn notes_and_playbook_changes_invalidate_only_affected_analysis_provenance() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let summary = "Generated summary";
        let action_items = vec!["Generated action".to_string()];
        db.patch_recording_analysis_with_provenance(
            "r1",
            Some(Some(summary)),
            Some(&action_items),
            Some(&sample_summary_provenance(summary)),
            Some(&sample_action_items_provenance(&action_items)),
        )
        .unwrap();

        db.update_recording_meeting_template("r1", Some("standup"))
            .unwrap();
        let after_template = db.get_recording("r1").unwrap().unwrap();
        assert!(after_template.summary_provenance.is_none());
        assert!(after_template.action_items_provenance.is_some());

        db.patch_recording_analysis_with_provenance(
            "r1",
            Some(Some(summary)),
            None,
            Some(&sample_summary_provenance(summary)),
            None,
        )
        .unwrap();
        db.update_recording_notes("r1", Some("New saved notes"))
            .unwrap();
        let after_notes = db.get_recording("r1").unwrap().unwrap();
        assert!(after_notes.summary_provenance.is_none());
        assert!(after_notes.action_items_provenance.is_none());
        assert_eq!(after_notes.summary.as_deref(), Some(summary));
        assert_eq!(after_notes.action_items, Some(action_items));
    }

    #[test]
    fn summary_only_patch_preserves_absent_action_item_state() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        assert!(db
            .get_recording("r1")
            .unwrap()
            .unwrap()
            .action_items
            .is_none());

        db.patch_recording_analysis_with_provenance(
            "r1",
            Some(Some("Summary only")),
            None,
            Some(&sample_summary_provenance("Summary only")),
            None,
        )
        .unwrap();

        let reloaded = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(reloaded.summary.as_deref(), Some("Summary only"));
        assert!(reloaded.action_items.is_none());
    }

    #[test]
    fn partial_analysis_patch_preserves_previous_success_and_its_provenance() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let old_summary = "Previous successful summary";
        let old_actions = vec!["Previous successful action".to_string()];
        db.patch_recording_analysis_with_provenance(
            "r1",
            Some(Some(old_summary)),
            Some(&old_actions),
            Some(&sample_summary_provenance(old_summary)),
            Some(&sample_action_items_provenance(&old_actions)),
        )
        .unwrap();

        let new_actions = vec!["New successful action".to_string()];
        db.patch_recording_analysis_with_provenance(
            "r1",
            None,
            Some(&new_actions),
            None,
            Some(&sample_action_items_provenance(&new_actions)),
        )
        .unwrap();

        let reloaded = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(reloaded.summary.as_deref(), Some(old_summary));
        assert_eq!(reloaded.action_items, Some(new_actions));
        assert_eq!(
            reloaded.summary_provenance.unwrap().content_hash,
            analysis_content_hash(old_summary)
        );
        assert!(reloaded.action_items_provenance.is_some());
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
    fn rename_speaker_trims_name_and_rejects_blank_or_unknown_speakers() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_transcript(&sample_transcript("r1")).unwrap();

        db.rename_speaker("r1", "speaker_0", "  Alice  ").unwrap();
        let aliases = db.get_speaker_aliases("r1").unwrap();
        assert_eq!(aliases["speaker_0"].0.as_deref(), Some("Alice"));

        assert!(db.rename_speaker("r1", "speaker_0", "   ").is_err());
        assert!(db.rename_speaker("r1", "missing", "Bob").is_err());
        assert_eq!(db.get_speaker_aliases("r1").unwrap().len(), 1);
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
                category_scope: Some("messaging".to_string()),
            })
            .unwrap();
        assert_eq!(created.trigger, "brb");
        assert_eq!(created.category_scope.as_deref(), Some("messaging"));

        let list = db.list_dictation_snippets().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].category_scope.as_deref(), Some("messaging"));

        let updated = db
            .update_dictation_snippet(
                &created.id,
                &UpdateDictationSnippetRequest {
                    trigger: Some("omw".to_string()),
                    expansion: Some("on my way".to_string()),
                    app_scope: Some(None),
                    case_sensitive: Some(true),
                    enabled: Some(true),
                    category_scope: Some(None),
                },
            )
            .unwrap();
        assert_eq!(updated.trigger, "omw");
        assert!(updated.app_scope.is_none());
        assert!(updated.case_sensitive);
        assert!(updated.category_scope.is_none());

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
                category_scope: Some("code_editor".to_string()),
            })
            .unwrap();
        assert_eq!(created.spoken_form, "open ai");
        assert_eq!(created.category_scope.as_deref(), Some("code_editor"));

        let list = db.list_dictation_dictionary_entries().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].category_scope.as_deref(), Some("code_editor"));

        let updated = db
            .update_dictation_dictionary_entry(
                &created.id,
                &UpdateDictationDictionaryEntryRequest {
                    spoken_form: Some("nautilus bot".to_string()),
                    replacement: Some("Plainsong".to_string()),
                    app_scope: Some(None),
                    case_sensitive: Some(true),
                    enabled: Some(true),
                    category_scope: Some(None),
                },
            )
            .unwrap();
        assert_eq!(updated.spoken_form, "nautilus bot");
        assert!(updated.app_scope.is_none());
        assert!(updated.category_scope.is_none());
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
                None,
            )
            .unwrap();
        assert_eq!(first_action, "created");
        assert!(first.source.is_none());

        let (second_action, second) = db
            .upsert_dictation_correction_suggestion(
                "jon will join tomorrow",
                "John will join tomorrow",
                "jon",
                "John",
                Some("Slack"),
                None,
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
    fn correction_suggestions_remember_which_app_they_were_read_out_of() {
        let mut db = in_memory_db();
        let (_, external) = db
            .upsert_dictation_correction_suggestion(
                "send it to cuban netties",
                "send it to kubernetes",
                "cuban netties",
                "kubernetes",
                Some("Slack"),
                Some(crate::models::CORRECTION_SUGGESTION_SOURCE_EXTERNAL_APP),
            )
            .unwrap();
        assert_eq!(
            external.source.as_deref(),
            Some(crate::models::CORRECTION_SUGGESTION_SOURCE_EXTERNAL_APP)
        );

        let stored = db.list_dictation_correction_suggestions().unwrap();
        assert_eq!(
            stored[0].source.as_deref(),
            Some(crate::models::CORRECTION_SUGGESTION_SOURCE_EXTERNAL_APP)
        );
    }

    #[test]
    fn pruning_correction_suggestions_drops_stale_entries_and_holds_the_cap() {
        let mut db = in_memory_db();
        let now = Utc::now();

        for index in 0..5 {
            db.upsert_dictation_correction_suggestion(
                &format!("word{} here", index),
                &format!("term{} here", index),
                &format!("word{}", index),
                &format!("term{}", index),
                Some("Slack"),
                Some(crate::models::CORRECTION_SUGGESTION_SOURCE_EXTERNAL_APP),
            )
            .unwrap();
        }

        // Age two of them past the window by hand; `upsert` always stamps now.
        let stale_ids = db
            .list_dictation_correction_suggestions()
            .unwrap()
            .into_iter()
            .take(2)
            .map(|suggestion| suggestion.id)
            .collect::<Vec<_>>();
        for id in &stale_ids {
            db.conn
                .execute(
                    "UPDATE dictation_correction_suggestions SET updated_at = ?1 WHERE id = ?2",
                    params![(now - chrono::Duration::days(30)).to_rfc3339(), id],
                )
                .unwrap();
        }

        let removed = db
            .prune_dictation_correction_suggestions(now, 7, 10)
            .unwrap();
        assert_eq!(removed, 2);
        assert_eq!(db.list_dictation_correction_suggestions().unwrap().len(), 3);

        // Now squeeze the cap: the newest two survive.
        let removed = db
            .prune_dictation_correction_suggestions(now, 7, 2)
            .unwrap();
        assert_eq!(removed, 1);
        let surviving = db.list_dictation_correction_suggestions().unwrap();
        assert_eq!(surviving.len(), 2);
        assert!(!stale_ids.contains(&surviving[0].id));
    }

    #[test]
    fn pruning_correction_suggestions_leaves_a_healthy_queue_alone() {
        let mut db = in_memory_db();
        db.upsert_dictation_correction_suggestion(
            "jon will join",
            "John will join",
            "jon",
            "John",
            Some("Slack"),
            None,
        )
        .unwrap();

        assert_eq!(
            db.prune_dictation_correction_suggestions(Utc::now(), 7, 60)
                .unwrap(),
            0
        );
        assert_eq!(db.list_dictation_correction_suggestions().unwrap().len(), 1);
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
