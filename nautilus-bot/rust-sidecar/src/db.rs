//! Database operations using SQLite
//!
//! Manages recordings, transcripts, projects, and audit logs
//! with full CRUD operations.

mod compression;
mod meeting_asides;
#[cfg(all(test, feature = "sqlcipher"))]
mod migration_snapshot_tests;
mod publishing;

use crate::diarization::voiceprints::{self, ClusterVoiceSignature, StoredVoiceProfile};
use crate::models::*;
use crate::recording_audio::{
    approved_regular_file, encrypted_path_for, historical_companion_candidates,
    is_terminal_encrypted_path, validate_plaintext_wav, RecordingAudioAsset, RecordingAudioBundle,
    RecordingAudioLifecycle, RecordingAudioOperation, RecordingAudioOperationItem,
    RecordingAudioProtection, RecordingAudioRole, RecordingAudioValidation, RecordingCapturePlan,
    ValidatedRecordingAudio,
};
use crate::semantic_search::{
    EmbeddingScanPage, EmbeddingScanToken, EmbeddingSearchScope, RawEmbeddingRow, SemanticRanker,
    EMBEDDING_PAGE_BYTES, EMBEDDING_PAGE_ROWS, MAX_EMBEDDING_DIMENSIONS,
};
use crate::store::{
    CaptureSessionRecord, ContextSnapshotRecord, DictationHistoryTextRecord,
    DictationInsightTotals, InsertionActionRecord, MeetingArtifactRecord, PolicySnapshotRecord,
    RuntimeEventRecord, TranscriptArtifactRecord,
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

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationDraft {
    pub recording_id: String,
    pub title: String,
    pub text: String,
    pub expected_saved_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MeetingFollowup {
    pub recording_id: String,
    pub meeting_title: String,
    pub task: String,
    pub completed: bool,
    pub needs_review: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MeetingFollowupPage {
    pub items: Vec<MeetingFollowup>,
    pub next_offset: Option<usize>,
}

const SEMANTIC_REVISION_TABLE_SQL: &str = "CREATE TABLE semantic_recall_revision (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0)
)";

fn semantic_revision_triggers() -> Vec<(String, String)> {
    let bump = "SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM semantic_recall_revision
        WHERE id = 1 AND typeof(revision) = 'integer' AND revision >= 0
        AND revision < 9223372036854775807)
        THEN RAISE(ABORT, 'semantic recall revision unavailable or exhausted') END;
        UPDATE semantic_recall_revision SET revision = revision + 1 WHERE id = 1;";
    let mut definitions = vec![
        ("semantic_revision_no_delete".to_string(), "CREATE TRIGGER semantic_revision_no_delete BEFORE DELETE ON semantic_recall_revision BEGIN SELECT RAISE(ABORT, 'semantic recall revision cannot be deleted'); END".to_string()),
        ("semantic_revision_no_replace".to_string(), "CREATE TRIGGER semantic_revision_no_replace BEFORE INSERT ON semantic_recall_revision WHEN EXISTS (SELECT 1 FROM semantic_recall_revision) BEGIN SELECT RAISE(ABORT, 'semantic recall revision cannot be replaced'); END".to_string()),
        ("semantic_revision_update_guard".to_string(), "CREATE TRIGGER semantic_revision_update_guard BEFORE UPDATE ON semantic_recall_revision WHEN NEW.id IS NOT OLD.id OR typeof(NEW.revision) != 'integer' OR OLD.revision >= 9223372036854775807 OR NEW.revision IS NOT OLD.revision + 1 BEGIN SELECT RAISE(ABORT, 'invalid semantic recall revision advance'); END".to_string()),
    ];
    for (table, fields) in [
        (
            "transcript_embeddings",
            &[
                "id",
                "recording_id",
                "segment_id",
                "text",
                "embedding",
                "model",
                "start_time",
                "end_time",
                "created_at",
            ][..],
        ),
        ("recordings", &["id", "title", "source_type"][..]),
        (
            "transcripts",
            &["id", "recording_id", "revision", "segments", "full_text"][..],
        ),
    ] {
        for operation in ["INSERT", "DELETE", "UPDATE"] {
            let mut conditions = Vec::new();
            if operation == "UPDATE" {
                conditions.push(format!(
                    "({})",
                    fields
                        .iter()
                        .map(|field| format!("NEW.{field} IS NOT OLD.{field}"))
                        .collect::<Vec<_>>()
                        .join(" OR ")
                ));
            }
            if table != "transcript_embeddings" {
                let key = if table == "recordings" {
                    "id"
                } else {
                    "recording_id"
                };
                let owners = match operation {
                    "INSERT" => format!("te.recording_id = NEW.{key}"),
                    "DELETE" => format!("te.recording_id = OLD.{key}"),
                    _ => format!("te.recording_id = OLD.{key} OR te.recording_id = NEW.{key}"),
                };
                conditions.push(format!(
                    "EXISTS (SELECT 1 FROM transcript_embeddings te WHERE {owners})"
                ));
            }
            let name = format!(
                "semantic_revision_{table}_{}",
                operation.to_ascii_lowercase()
            );
            let when = if conditions.is_empty() {
                String::new()
            } else {
                format!(" WHEN {}", conditions.join(" AND "))
            };
            let sql = format!(
                "CREATE TRIGGER {name} AFTER {operation} ON {table}{when} BEGIN {bump} END"
            );
            definitions.push((name, sql));
        }
    }
    definitions
}

fn verify_semantic_revision(conn: &Connection) -> Result<i64> {
    let table_sql: String = conn.query_row(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'semantic_recall_revision'",
        [], |row| row.get(0),
    ).context("Semantic recall revision table unavailable")?;
    if table_sql != SEMANTIC_REVISION_TABLE_SQL {
        anyhow::bail!("Semantic recall revision table is malformed");
    }
    for (name, expected) in semantic_revision_triggers() {
        let actual: String = conn
            .query_row(
                "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?1",
                [&name],
                |row| row.get(0),
            )
            .with_context(|| format!("Semantic recall trigger {name} unavailable"))?;
        if actual != expected {
            anyhow::bail!("Semantic recall trigger {name} is malformed");
        }
    }
    let (count, revision): (i64, Option<i64>) = conn.query_row(
        "SELECT COUNT(*), MAX(CASE WHEN id = 1 AND typeof(revision) = 'integer'
         AND revision >= 0 THEN revision END) FROM semantic_recall_revision",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if count != 1 {
        anyhow::bail!("Semantic recall revision singleton unavailable");
    }
    revision.context("Semantic recall revision is malformed")
}

fn initialize_semantic_revision(conn: &Connection) -> Result<()> {
    if !table_exists(conn, "semantic_recall_revision")? {
        conn.execute_batch(SEMANTIC_REVISION_TABLE_SQL)?;
    }
    // Seed the singleton whenever it is missing, not only with a new table: a
    // stop between CREATE and INSERT, or a schema-only copy, would otherwise
    // leave an empty table that refuses every launch. No scan token outlives
    // the process, so a fresh revision cannot validate a stale scan.
    conn.execute(
        "INSERT INTO semantic_recall_revision (id, revision)
         SELECT 1, 0 WHERE NOT EXISTS (SELECT 1 FROM semantic_recall_revision)",
        [],
    )?;
    for (name, sql) in semantic_revision_triggers() {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = ?1)",
            [&name],
            |row| row.get(0),
        )?;
        if !exists {
            conn.execute_batch(&sql)?;
        }
    }
    verify_semantic_revision(conn)?;
    Ok(())
}

fn embedding_scan_filter(scope: &EmbeddingSearchScope) -> Result<(String, Vec<Value>)> {
    if scope.dimensions == 0 || scope.dimensions > MAX_EMBEDDING_DIMENSIONS {
        anyhow::bail!("Invalid semantic embedding dimensions");
    }
    let bytes = scope
        .dimensions
        .checked_mul(4)
        .context("Semantic embedding size overflow")?;
    Ok((
        "te.model = ?1 AND typeof(te.embedding) = 'blob' AND length(te.embedding) = ?2
        AND (?3 IS NULL OR te.recording_id != ?3)
        AND (?4 IS NULL OR r.source_type = ?4)"
            .to_string(),
        vec![
            Value::from(scope.model.clone()),
            Value::from(bytes as i64),
            scope
                .exclude_recording_id
                .clone()
                .map(Value::from)
                .unwrap_or(Value::Null),
            scope
                .source_type
                .clone()
                .map(Value::from)
                .unwrap_or(Value::Null),
        ],
    ))
}

fn embedding_source_signature(conn: &Connection) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    let mut statement = conn.prepare(
        "SELECT r.id,t.id,t.revision,t.segments,t.full_text
        FROM recordings r JOIN transcripts t ON t.recording_id=r.id ORDER BY r.id,t.id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    })?;
    for row in rows {
        hash.update(serde_json::to_vec(&row?)?);
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

const MAX_DICTIONARY_ENTRIES: i64 = 1_000;
const MAX_DICTIONARY_SPOKEN_FORM_BYTES: usize = 256;
const MAX_DICTIONARY_REPLACEMENT_BYTES: usize = 4_096;

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

/// Detail fields the audit log never keeps. Removed on every write and, by the
/// startup scrub, from rows written before a field was listed. The audit log
/// is append-only and outlives a deleted meeting, so it records that something
/// happened, not names, titles or where a file went: an export or a recording
/// path is named after its meeting, and an imported file's name is the
/// reader's own words.
const SENSITIVE_AUDIT_DETAIL_KEYS: [&str; 9] = [
    "context_preview",
    "selected_text",
    "clipboard_text",
    "captured_context_text",
    "export_path",
    "target",
    "audio_path",
    "new_title",
    "source_file_name",
];

const LEGACY_DICTATION_BYTE_COUNT_FLOOR: i64 = 86_400;
const MAX_REPAIRABLE_DICTATION_CAPTURE_MS: i64 = 12 * 60 * 60 * 1_000;
pub(crate) const CURRENT_SCHEMA_VERSION: i64 = 4;

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
const RESET_SCOPED_TABLE_DELETES: [(&str, &str); 38] = [
    // Samples before profiles: the foreign key points that way.
    (
        "speaker_profile_samples",
        "DELETE FROM speaker_profile_samples",
    ),
    ("speaker_profiles", "DELETE FROM speaker_profiles"),
    ("speaker_aliases", "DELETE FROM speaker_aliases"),
    ("transcript_fts", "DELETE FROM transcript_fts"),
    ("dictation_history_fts", "DELETE FROM dictation_history_fts"),
    (
        "dictation_history_text",
        "DELETE FROM dictation_history_text",
    ),
    ("transcript_embeddings", "DELETE FROM transcript_embeddings"),
    (
        "embedding_rebuild_stage",
        "DELETE FROM embedding_rebuild_stage",
    ),
    ("transcript_artifacts", "DELETE FROM transcript_artifacts"),
    ("meeting_artifacts", "DELETE FROM meeting_artifacts"),
    ("meeting_note_recovery", "DELETE FROM meeting_note_recovery"),
    ("recording_asides", "DELETE FROM recording_asides"),
    (
        "meeting_enhanced_note_drafts",
        "DELETE FROM meeting_enhanced_note_drafts",
    ),
    (
        "summary_regeneration_undo",
        "DELETE FROM summary_regeneration_undo",
    ),
    // A cached brief is model-written text about the reader's meetings. It
    // has to go with them.
    ("meeting_briefs", "DELETE FROM meeting_briefs"),
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
        "audio_compression_jobs",
        "DELETE FROM audio_compression_jobs",
    ),
    (
        "audio_compression_totals",
        "DELETE FROM audio_compression_totals",
    ),
    (
        "meeting_audio_finalization",
        "DELETE FROM meeting_audio_finalization",
    ),
    (
        "recording_audio_assets",
        "DELETE FROM recording_audio_assets",
    ),
    // Reset forgets the notes folder and its queue. Files already saved
    // there belong to the user and stay.
    ("note_publish_outbox", "DELETE FROM note_publish_outbox"),
    ("note_publish_receipts", "DELETE FROM note_publish_receipts"),
    ("note_publish_config", "DELETE FROM note_publish_config"),
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
            meeting_notes, meeting_template_id, meeting_capture_mode, imported_source_name,
            notes_updated_at, consent_prompt_shown, consent_notice_mode, consent_notice_surface,
            consent_notice_message, consent_notice_updated_at, video_service
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
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
            &recording.imported_source_name,
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
                .map(|value| value.to_rfc3339()),
            &recording.video_service
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

fn dictation_dictionary_entry_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<DictationDictionaryEntry> {
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
}

/// The `pause_spans` column, parsed. Unreadable JSON is an empty list: a
/// meeting whose pause record is corrupt is still a meeting, and a read must
/// not fail over a marker the timeline can simply omit.
fn parse_pause_spans(raw: Option<String>) -> Vec<crate::recording_pause::PauseSpan> {
    raw.and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn capture_safe_completion(
    complete: bool,
    reason: Option<&str>,
    capture_warning: Option<&str>,
) -> (bool, Option<String>) {
    let capture = capture_warning.map(str::trim).filter(|s| !s.is_empty());
    let reason = reason.map(str::trim).filter(|s| !s.is_empty());
    let merged = match (capture, reason) {
        (Some(capture), Some(reason)) if reason.contains(capture) => Some(reason.to_string()),
        (Some(capture), Some(reason)) if capture.contains(reason) => Some(capture.to_string()),
        (Some(capture), Some(reason)) => Some(format!("{} {}", capture, reason)),
        (Some(capture), None) => Some(capture.to_string()),
        (None, reason) => reason.map(str::to_string),
    };
    (complete && capture.is_none(), merged)
}

fn validated_summary_provenance(
    raw: Option<String>,
    summary: Option<&str>,
) -> Option<AnalysisProvenance> {
    let mut provenance: AnalysisProvenance = serde_json::from_str(raw.as_deref()?).ok()?;
    let summary = summary?;
    // Keep historic citations and attribution, but do not present an older
    // acceptance policy as verification under the current meaning checks.
    provenance.grounded &= provenance.grounding_policy_version
        == Some(crate::models::SUMMARY_GROUNDING_POLICY_VERSION);
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

fn demote_incomplete_analysis(
    incomplete: bool,
    summary: &mut Option<AnalysisProvenance>,
    actions: &mut Option<ActionItemsProvenance>,
) {
    if !incomplete {
        return;
    }
    if let Some(summary) = summary {
        summary.grounded = false;
    }
    if let Some(actions) = actions {
        actions.grounded = false;
        for item in &mut actions.items {
            item.grounded = false;
        }
    }
}

fn action_item_review_status(
    provenance: Option<&ActionItemsProvenance>,
    action_items: &[String],
) -> HashMap<String, bool> {
    let mut review = HashMap::<String, bool>::new();
    if let Some(provenance) = provenance {
        let current_policy = provenance.grounding_policy_version
            == Some(crate::models::SUMMARY_GROUNDING_POLICY_VERSION);
        for (task, evidence) in action_items.iter().zip(&provenance.items) {
            let needs_review = evidence.generated
                && (!current_policy || !evidence.grounded || evidence.citations.is_empty());
            // Equal-text occurrences share one task. Keep every occurrence's warning.
            *review.entry(task.clone()).or_default() |= needs_review;
        }
    }
    review
}

fn preserve_matching_action_item_provenance(
    previous: &ActionItemsProvenance,
    action_items: &[String],
    preserve_positions: bool,
) -> Option<ActionItemsProvenance> {
    let next_hashes = action_items
        .iter()
        .map(|item| analysis_content_hash(item))
        .collect::<Vec<_>>();
    // A full-document save cannot identify which equal-text occurrence survived
    // a structural edit. Indexed mutations supply known positional identity.
    let aligned = previous.items.len() == next_hashes.len()
        && previous
            .items
            .iter()
            .zip(&next_hashes)
            .all(|(item, hash)| item.content_hash == *hash);
    let mut previous_occurrences: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, item) in previous.items.iter().enumerate() {
        previous_occurrences
            .entry(&item.content_hash)
            .or_default()
            .push(index);
    }
    let mut next_counts: HashMap<String, usize> = HashMap::new();
    for hash in &next_hashes {
        *next_counts.entry(hash.clone()).or_default() += 1;
    }
    let items = next_hashes
        .into_iter()
        .enumerate()
        .map(|(index, content_hash)| {
            let occurrence = if aligned
                || (preserve_positions
                    && previous
                        .items
                        .get(index)
                        .is_some_and(|item| item.content_hash == content_hash))
            {
                Some(index)
            } else {
                previous_occurrences
                    .get(content_hash.as_str())
                    .and_then(|indices| {
                        (indices.len() == 1 && next_counts[content_hash.as_str()] == 1)
                            .then_some(indices[0])
                    })
            };
            occurrence
                .map(|index| previous.items[index].clone())
                .unwrap_or(ActionItemProvenance {
                    content_hash,
                    citations: Vec::new(),
                    grounded: false,
                    generated: false,
                    evidence: None,
                    unclear: false,
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

/// Hex-encode a database key for `PRAGMA key`/`rekey`/`ATTACH ... KEY`.
///
/// SQLCipher takes the key as a literal inside the pragma text, which cannot
/// be a bound parameter, so the encoding is also the injection guard: the
/// result is checked to be nothing but hex digits before it is interpolated.
#[cfg(feature = "sqlcipher")]
fn hex_database_key(key: &str) -> Result<String> {
    let hex_key = hex::encode(key.as_bytes());
    if !hex_key.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(anyhow::anyhow!("Invalid hex encoding in database key"));
    }
    Ok(hex_key)
}

/// SQLite refuses a bound parameter in `ATTACH`/`VACUUM INTO`, so paths are
/// inlined as string literals with single quotes doubled.
#[cfg(feature = "sqlcipher")]
fn sql_string_literal(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "''")
}

/// Delete a database file and the journal/WAL companions SQLite may have left
/// beside it. Only ever called on a staging file this process created.
#[cfg(feature = "sqlcipher")]
fn remove_database_file_set(db_path: &Path) {
    let _ = fs::remove_file(db_path);
    if let Some(name) = db_path.file_name().and_then(|name| name.to_str()) {
        for suffix in ["-journal", "-wal", "-shm"] {
            let _ = fs::remove_file(db_path.with_file_name(format!("{name}{suffix}")));
        }
    }
}

/// Whether the file at `db_path` opens as a plaintext SQLite database.
#[cfg(feature = "sqlcipher")]
fn database_reads_as_plaintext(db_path: &Path) -> bool {
    Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|conn| {
            conn.query_row("SELECT count(*) FROM sqlite_master;", [], |row| {
                row.get::<_, i64>(0)
            })
        })
        .is_ok()
}

/// Encrypt the plaintext SQLite database at `db_path` in place.
///
/// This is the operation the vault always claimed to perform. `PRAGMA rekey`
/// does not do it — SQLCipher documents rekey as a no-op on a database that
/// was never keyed, so the app was setting a durable key in the keychain,
/// reporting "database encrypted", and leaving every byte in the clear.
///
/// The sequence is the one SQLCipher documents for exactly this case, plus the
/// durability the app owes a file that holds every transcript on the machine:
///
/// 1. Prove the file really is plaintext, and read its `user_version`.
/// 2. `ATTACH` a fresh keyed database beside it and `sqlcipher_export` into it.
///    `sqlcipher_export` copies schema and rows but not `user_version`, so that
///    is set explicitly — without it the reopened database looks like schema 0
///    and migrations would run again.
/// 3. `DETACH`, close, and fsync the staging file (and its directory) so the
///    bytes are on the platter before anything replaces the original.
/// 4. Verify the staging file: it opens with the key, does *not* open without
///    it, carries the same `user_version`, and has a non-empty schema.
/// 5. `rename` it over the original. Same directory, so this is atomic: a
///    crash leaves either the whole old plaintext file or the whole new
///    encrypted one, never a half-written mixture.
/// 6. Verify once more through the final path.
///
/// Any failure before step 5 removes the staging file and leaves the plaintext
/// original untouched and openable. What this cannot do is scrub the old
/// plaintext blocks: `rename` unlinks the previous inode, it does not overwrite
/// it, so the pre-encryption pages remain unallocated-but-recoverable on the
/// volume until they are reused. On a FileVault volume they are still covered
/// by full-disk encryption; the vault's promise from here forward is the
/// SQLCipher key, and that is what the copy says.
#[cfg(feature = "sqlcipher")]
pub(crate) fn encrypt_plaintext_database_file(db_path: &Path, key: &str) -> Result<()> {
    let hex_key = hex_database_key(key)?;
    if !db_path.is_file() {
        anyhow::bail!("No database to encrypt at {}", db_path.display());
    }
    let file_name = db_path
        .file_name()
        .and_then(|name| name.to_str())
        .context("Database path has no file name")?;
    // Beside the original, so the final rename stays inside one directory and
    // is therefore atomic.
    let staging = db_path.with_file_name(format!("{file_name}.new"));
    remove_database_file_set(&staging);

    let export = (|| -> Result<i64> {
        let conn = Connection::open(db_path)
            .with_context(|| format!("Failed to open {}", db_path.display()))?;
        conn.busy_timeout(std::time::Duration::from_secs(30))?;
        // If this fails the file is already encrypted (or corrupt) and the
        // export would produce nonsense; refuse before touching anything.
        conn.query_row("SELECT count(*) FROM sqlite_master;", [], |row| {
            row.get::<_, i64>(0)
        })
        .context("The database did not open as plaintext, so it was left alone")?;
        let user_version = export_keyed_database(&conn, &staging, key)?;
        conn.close().map_err(|(_, error)| {
            anyhow::Error::new(error).context("Could not close the plaintext database")
        })?;
        Ok(user_version)
    })();

    let user_version = match export {
        Ok(version) => version,
        Err(error) => {
            remove_database_file_set(&staging);
            return Err(error);
        }
    };

    let verified = (|| -> Result<()> {
        fsync_path(&staging).context("Could not flush the encrypted database to disk")?;
        if let Some(parent) = staging.parent() {
            // Best effort: some filesystems refuse a directory fsync. The
            // rename below is still atomic; only its durability across a power
            // loss is weakened, and that is worth a log line, not a failure.
            if let Err(error) = fsync_path(parent) {
                tracing::warn!(
                    "Could not fsync {} after export: {}",
                    parent.display(),
                    error
                );
            }
        }
        if database_reads_as_plaintext(&staging) {
            anyhow::bail!("The replacement database is still readable without a key");
        }
        let staged = Connection::open(&staging)?;
        staged.execute_batch(&format!("PRAGMA key = \"x'{}'\";", hex_key))?;
        let tables: i64 = staged
            .query_row("SELECT count(*) FROM sqlite_master;", [], |row| row.get(0))
            .context("The encrypted database did not open with its own key")?;
        if tables == 0 {
            anyhow::bail!("The encrypted database came out empty");
        }
        let staged_version: i64 = staged.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if staged_version != user_version {
            anyhow::bail!(
                "The encrypted database reports schema version {staged_version}, not {user_version}"
            );
        }
        staged.close().map_err(|(_, error)| error)?;
        Ok(())
    })();

    if let Err(error) = verified {
        remove_database_file_set(&staging);
        return Err(error);
    }

    // The one irreversible step, and the only one after which the plaintext
    // original no longer has a name.
    if let Err(error) = fs::rename(&staging, db_path) {
        remove_database_file_set(&staging);
        return Err(anyhow::Error::new(error).context(format!(
            "Could not put the encrypted database in place at {}",
            db_path.display()
        )));
    }

    let final_check = Connection::open(db_path)
        .context("Could not reopen the database after encrypting it")
        .and_then(|conn| {
            conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", hex_key))?;
            conn.query_row("SELECT count(*) FROM sqlite_master;", [], |row| {
                row.get::<_, i64>(0)
            })
            .context("The encrypted database did not open with its own key")
        })?;
    tracing::info!(
        "Encrypted {} ({} schema objects, schema version {})",
        db_path.display(),
        final_check,
        user_version
    );
    Ok(())
}

/// Export with an explicit destination key. SQLCipher does not copy user_version.
#[cfg(feature = "sqlcipher")]
fn export_keyed_database(conn: &Connection, destination: &Path, key: &str) -> Result<i64> {
    let hex_key = hex_database_key(key)?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    conn.execute_batch(&format!(
        "ATTACH DATABASE '{}' AS plainsong_vault KEY \"x'{}'\";",
        sql_string_literal(destination),
        hex_key
    ))?;
    let exported = conn
        .query_row(
            "SELECT sqlcipher_export('plainsong_vault');",
            [],
            |_| Ok(()),
        )
        .and_then(|()| {
            conn.execute_batch(&format!("PRAGMA plainsong_vault.user_version = {version};"))
        });
    let detached = conn.execute_batch("DETACH DATABASE plainsong_vault;");
    exported?;
    detached?;
    Ok(version)
}

#[cfg(feature = "sqlcipher")]
fn snapshot_before_schema_upgrade(
    conn: &Connection,
    db_path: &Path,
    key: &str,
) -> Result<Option<PathBuf>> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let objects: i64 =
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| row.get(0))?;
    if version >= CURRENT_SCHEMA_VERSION || objects == 0 {
        return Ok(None);
    }
    let directory = db_path.with_file_name(format!(
        "{}.migration-snapshots",
        db_path
            .file_name()
            .context("Database has no filename")?
            .to_string_lossy()
    ));
    fs::create_dir_all(&directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    }
    let name = format!(
        "{}-schema-v{version}-before-v{}-{}.db",
        Utc::now().format("%Y%m%dT%H%M%S%.9fZ"),
        CURRENT_SCHEMA_VERSION,
        uuid::Uuid::new_v4()
    );
    let destination = directory.join(name);
    let staging = destination.with_extension("partial");
    let result = (|| -> Result<()> {
        export_keyed_database(conn, &staging, key)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&staging, fs::Permissions::from_mode(0o600))?;
        }
        fsync_path(&staging)?;
        if database_reads_as_plaintext(&staging) {
            anyhow::bail!("Migration snapshot is readable without its vault key");
        }
        let snapshot =
            Connection::open_with_flags(&staging, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        snapshot.execute_batch(&format!("PRAGMA key = \"x'{}'\";", hex_database_key(key)?))?;
        let integrity: String =
            snapshot.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        let snapshot_version: i64 =
            snapshot.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if integrity != "ok" || snapshot_version != version {
            anyhow::bail!("Migration snapshot failed its integrity or schema-version check");
        }
        drop(snapshot);
        fs::rename(&staging, &destination)?;
        fsync_path(&directory)?;
        let mut snapshots = fs::read_dir(&directory)?.collect::<std::io::Result<Vec<_>>>()?;
        snapshots.retain(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.contains("-schema-v") && name.ends_with(".db"))
                && entry.file_type().is_ok_and(|kind| kind.is_file())
        });
        snapshots.sort_by_key(|entry| entry.file_name());
        for entry in snapshots.iter().take(snapshots.len().saturating_sub(2)) {
            fs::remove_file(entry.path())?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        remove_database_file_set(&staging);
        return Err(error).context("Could not preserve encrypted database before schema migration; migration was not started");
    }
    Ok(Some(destination))
}

/// fsync one path (file or directory).
#[cfg(feature = "sqlcipher")]
fn fsync_path(path: &Path) -> std::io::Result<()> {
    // A directory cannot be opened for writing, and fsync on a read-only
    // descriptor is enough to flush metadata on both APFS and ext4.
    fs::File::open(path)?.sync_all()
}

const CORRECTION_APPROVAL_UNDO_TTL: std::time::Duration = std::time::Duration::from_secs(600);
const CORRECTION_APPROVAL_UNDO_CAP: usize = 32;

#[derive(Clone)]
struct CorrectionApprovalUndoReceipt {
    entry_id: String,
    expected_revision: i64,
    previous_entry: Option<DictationDictionaryEntry>,
    issued_at: std::time::Instant,
}

pub struct Database {
    conn: Connection,
    encrypted: bool,
    correction_approval_undo: HashMap<String, CorrectionApprovalUndoReceipt>,
}

/// Recording id to (text preview, app target), for dictation history lists.
pub type DictationListPreviews =
    std::collections::HashMap<String, (Option<String>, Option<String>)>;

type MeetingActionCompletion = (String, Vec<String>, HashSet<String>);

#[derive(Clone, Copy, Default)]
struct TranscriptSearchFilters<'a> {
    project_ids: Option<&'a [String]>,
    recording_ids: Option<&'a [String]>,
    exclude_recording_id: Option<&'a str>,
    source_type: Option<&'a str>,
    recording_status: Option<&'a str>,
}

fn load_meeting_action_completion(
    conn: &Connection,
    recording_id: &str,
) -> Result<Option<MeetingActionCompletion>> {
    let row = conn
        .query_row(
            "SELECT recordings.source_type,
                    COALESCE(meeting_artifacts.action_items, recordings.action_items),
                    recordings.meeting_action_completion
             FROM recordings
             LEFT JOIN meeting_artifacts ON meeting_artifacts.recording_id = recordings.id
             WHERE recordings.id = ?1",
            [recording_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    Ok(
        row.map(|(source_type, action_items_json, completed_hashes_json)| {
            let action_items = action_items_json
                .and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok())
                .unwrap_or_default();
            let completed_hashes = serde_json::from_str::<Vec<String>>(&completed_hashes_json)
                .unwrap_or_default()
                .into_iter()
                .collect();
            (source_type, action_items, completed_hashes)
        }),
    )
}

fn completed_meeting_action_tasks(
    action_items: &[String],
    completed_hashes: &HashSet<String>,
) -> Vec<String> {
    let mut emitted_hashes = HashSet::new();
    action_items
        .iter()
        .filter_map(|task| {
            let hash = analysis_content_hash(task);
            (completed_hashes.contains(&hash) && emitted_hashes.insert(hash)).then(|| task.clone())
        })
        .collect()
}

#[expect(
    dead_code,
    reason = "database module keeps migration and evidence-table helpers beyond current command usage"
)]
impl Database {
    pub(crate) fn close_for_restore(&mut self) -> Result<()> {
        let placeholder = Connection::open_in_memory()?;
        let original = std::mem::replace(&mut self.conn, placeholder);
        if let Err((original, error)) = original.close() {
            self.conn = original;
            return Err(error).context("Could not close the database before restore");
        }
        self.correction_approval_undo.clear();
        Ok(())
    }

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
            let hex_key = hex_database_key(key)?;
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

        #[cfg(feature = "sqlcipher")]
        if let Some(key) = key {
            snapshot_before_schema_upgrade(&conn, db_path, key)?;
        }
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let mut db = Self {
            conn,
            encrypted,
            correction_approval_undo: HashMap::new(),
        };
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

        // Before `PRAGMA key` and the probe, not after: both of those touch the
        // file, and the sidecar can be holding the rollback journal at exactly
        // that moment. Set later, the very first statements of a read-only open
        // were the ones that could still fail with SQLITE_BUSY.
        conn.busy_timeout(std::time::Duration::from_secs(5))?;

        #[cfg(feature = "sqlcipher")]
        let encrypted = if let Some(key) = key {
            conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", hex_database_key(key)?))?;
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
        conn.execute_batch("PRAGMA query_only = ON;")?;

        let schema_version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if schema_version > CURRENT_SCHEMA_VERSION {
            anyhow::bail!(
                "Database schema version {} is newer than this binary supports ({})",
                schema_version,
                CURRENT_SCHEMA_VERSION
            );
        }

        Ok(Self {
            conn,
            encrypted,
            correction_approval_undo: HashMap::new(),
        })
    }

    /// Open read-only, deciding whether the file is encrypted by trying, not
    /// by asking the keychain.
    ///
    /// A key in the keychain is not evidence that the file on disk is
    /// encrypted: the vault used to store the key and then fail to encrypt
    /// anything, and even now the two are separate steps that a crash can land
    /// between. A reader that assumed `key.is_some() == encrypted` therefore
    /// both refused to open perfectly readable databases and reported
    /// "encrypted: true" about plaintext ones.
    ///
    /// So: try the key if there is one, fall back to an unkeyed open, and let
    /// [`Database::is_encrypted`] report whichever attempt actually worked.
    pub(crate) fn open_read_only_probing(db_path: &Path, key: Option<&str>) -> Result<Self> {
        let Some(key) = key else {
            return Self::open_read_only_at_path(db_path, None);
        };
        match Self::open_read_only_at_path(db_path, Some(key)) {
            Ok(db) => Ok(db),
            Err(keyed_error) => {
                Self::open_read_only_at_path(db_path, None).map_err(|plain_error| {
                    keyed_error.context(format!(
                        "and it is not a readable plaintext database either: {plain_error}"
                    ))
                })
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn new_in_memory_for_test() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let mut db = Self {
            conn,
            encrypted: false,
            correction_approval_undo: HashMap::new(),
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

    /// Encrypt this database, or change the key of one that already is.
    ///
    /// The two cases are not the same operation, and conflating them is what
    /// left the vault unencrypted for every user who turned it on:
    ///
    /// - **Already keyed** — `PRAGMA rekey` re-encrypts every page in place.
    ///   That is what rekey is for and it works.
    /// - **Plaintext** — `PRAGMA rekey` is a documented no-op on a connection
    ///   that was never keyed. It returns success, the file stays plaintext,
    ///   and the caller has no way to tell. The supported route is
    ///   `sqlcipher_export` into a fresh keyed database; see
    ///   [`encrypt_plaintext_database_file`].
    ///
    /// The branch is taken from `self.encrypted`, which is only ever true when
    /// a keyed open actually read `sqlite_master`, so no call site can pick the
    /// wrong one.
    #[cfg(feature = "sqlcipher")]
    pub fn change_key(&mut self, new_key: &str) -> Result<()> {
        if !self.encrypted {
            return self.encrypt_plaintext_file(new_key);
        }
        let hex_key = hex_database_key(new_key)?;
        self.conn
            .execute_batch(&format!("PRAGMA rekey = \"x'{}'\";", hex_key))?;
        // A query, not `execute`, for the same reason as in `open_at_path`.
        self.conn
            .query_row("SELECT count(*) FROM sqlite_master;", [], |row| {
                row.get::<_, i64>(0)
            })?;
        tracing::info!("Database encryption key changed");
        Ok(())
    }

    /// Migrate this handle's plaintext file to an encrypted one and reopen
    /// against the result.
    ///
    /// The live connection is closed first: the migration writes a sibling
    /// file and then renames it over the original, and an open handle on the
    /// old inode would keep reading a file that no longer has a name.
    #[cfg(feature = "sqlcipher")]
    fn encrypt_plaintext_file(&mut self, key: &str) -> Result<()> {
        let db_path = self
            .conn
            .path()
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .context("Cannot encrypt a database that has no file on disk")?;

        let placeholder = Connection::open_in_memory()
            .context("Could not prepare the connection swap for encryption")?;
        let live = std::mem::replace(&mut self.conn, placeholder);
        if let Err((restored, error)) = live.close() {
            // Something is still borrowing the connection; nothing has been
            // touched on disk, so put it back and report.
            self.conn = restored;
            return Err(anyhow::Error::new(error)
                .context("Could not close the database before encrypting it"));
        }

        match encrypt_plaintext_database_file(&db_path, key) {
            Ok(()) => {
                let conn = Connection::open(&db_path)
                    .with_context(|| format!("Failed to reopen {}", db_path.display()))?;
                conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", hex_database_key(key)?))?;
                conn.query_row("SELECT count(*) FROM sqlite_master;", [], |row| {
                    row.get::<_, i64>(0)
                })
                .context("The encrypted database did not open with its own key")?;
                conn.execute_batch("PRAGMA foreign_keys = ON;")?;
                self.conn = conn;
                self.encrypted = true;
                tracing::info!("Database encrypted at {}", db_path.display());
                Ok(())
            }
            Err(error) => {
                // The migration leaves the plaintext original in place on every
                // failure path, so the app keeps working on it.
                match Connection::open(&db_path) {
                    Ok(conn) => {
                        let _ = conn.execute_batch("PRAGMA foreign_keys = ON;");
                        self.conn = conn;
                    }
                    Err(reopen) => {
                        return Err(error.context(format!(
                            "and the plaintext database could not be reopened afterwards: {reopen}"
                        )));
                    }
                }
                Err(error)
            }
        }
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
        Self::log_audit_event_on(&self.conn, event, details, severity)
    }

    /// The audit write itself, against any connection.
    ///
    /// Split out so a change and the record of that change can be written in
    /// one transaction. Two writes under two separate acquisitions of the
    /// database lock leave a window in which a reader sees the change with no
    /// audit record -- and, if the second write fails, leave that disagreement
    /// permanently.
    fn log_audit_event_on(
        conn: &rusqlite::Connection,
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

        conn.execute(
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
                    COALESCE(SUM(CASE WHEN r.created_at >= ?1 THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(MAX(r.duration, 0)), 0)
             FROM recordings r
             LEFT JOIN transcripts t ON t.recording_id = r.id
             WHERE r.source_type = 'dictation'",
        )?;
        let cutoff = (chrono::Utc::now() - chrono::Duration::days(7)).to_rfc3339();
        let row: (i64, i64, i64, i64, i64) = stmt.query_row(params![cutoff], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?;
        totals.total_dictations = row.0.max(0) as u64;
        totals.dictated_words = row.1.max(0) as u64;
        totals.active_days = row.2.max(0) as u64;
        totals.last_seven_days_dictations = row.3.max(0) as u64;
        totals.spoken_seconds = row.4.max(0) as u64;

        // The most recent local days with a dictation, newest first, for the
        // streak. Bounded: a streak longer than a year still reads as 366.
        let mut dates_stmt = self.conn.prepare(
            "SELECT DISTINCT DATE(created_at, 'localtime') AS day
             FROM recordings
             WHERE source_type = 'dictation' AND day IS NOT NULL
             ORDER BY day DESC
             LIMIT 366",
        )?;
        totals.active_dates = dates_stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;

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
        let incomplete = self.get_recording(recording_id)?.is_some_and(|r| {
            !r.transcript_complete
                || r.capture_degraded_summary
                    .is_some_and(|s| !s.trim().is_empty())
        });
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
            let mut summary_provenance =
                validated_summary_provenance(row.get(5)?, summary.as_deref());
            let mut action_items_provenance =
                validated_action_items_provenance(row.get(6)?, &action_items);
            demote_incomplete_analysis(
                incomplete,
                &mut summary_provenance,
                &mut action_items_provenance,
            );
            Ok(MeetingArtifactRecord {
                id: row.get(0)?,
                recording_id: row.get(1)?,
                title: row.get(2)?,
                summary_provenance,
                action_items_provenance,
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
            publishing::init(&self.conn)?;
            compression::init(&self.conn)?;
            meeting_asides::init(&self.conn)?;
            if schema_version < CURRENT_SCHEMA_VERSION {
                self.conn.execute_batch(&format!(
                    "PRAGMA user_version = {};",
                    CURRENT_SCHEMA_VERSION
                ))?;
            }
            Ok(())
        });
        if let Err(error) = migration_result {
            if let Err(rollback_error) = self.conn.execute_batch("ROLLBACK;") {
                return Err(error).context(format!(
                    "Schema migration failed and rollback failed ({rollback_error}); preserve the migration snapshot for recovery"
                ));
            }
            return Err(error)
                .context("Schema migration failed; the database transaction was rolled back");
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
        if let Err(error) = self.backfill_dictation_history_text_if_needed() {
            tracing::warn!(
                "Failed to run dictation history text startup backfill check: {}",
                error
            );
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
                imported_source_name TEXT,
                notes_updated_at TEXT,
                consent_prompt_shown INTEGER NOT NULL DEFAULT 0,
                consent_notice_mode TEXT,
                consent_notice_surface TEXT,
                consent_notice_message TEXT,
                consent_notice_updated_at TEXT,
                video_service TEXT,
                dictation_corrected_text TEXT,
                dictation_draft_text TEXT,
                dictation_draft_base_edit TEXT,
                dictation_draft_updated_at INTEGER,
                meeting_action_completion TEXT NOT NULL DEFAULT '[]'
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
                measured_word_timestamps INTEGER NOT NULL DEFAULT 0,
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
        self.ensure_table_column(
            "transcripts",
            "measured_word_timestamps",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        self.ensure_table_column("transcripts", "revision", "INTEGER NOT NULL DEFAULT 0")?;
        // Which diarizer produced the speaker labels on this transcript, so the
        // meeting header can name it instead of inferring it from the ASR
        // provider (which would be wrong every time a provider-diarization
        // attempt fell back to the local pipeline). NULL means no diarizer has
        // run, which is not the same as "Plainsong ran and found one speaker".
        self.ensure_table_column("transcripts", "diarizer", "TEXT")?;
        self.migrate_transcripts_drop_fallback_columns()?;
        // Microphone rows of a Me + Them meeting that were the far side heard
        // through the speakers: a JSON array of segments kept out of
        // `segments`, `full_text` and search, but not deleted. NULL means none.
        // Added after the fallback-column rebuild, which lists its columns.
        self.ensure_table_column("transcripts", "heard_through_speakers", "TEXT")?;

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

        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meeting_enhanced_note_drafts (
            recording_id TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
            draft_json TEXT NOT NULL
        );",
        )?;

        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meeting_note_recovery (
            id TEXT PRIMARY KEY, recording_id TEXT NOT NULL,
            base_notes TEXT NOT NULL, notes TEXT NOT NULL, created_at TEXT NOT NULL,
            FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
        );",
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
            "CREATE TABLE IF NOT EXISTS summary_regeneration_undo (
                recording_id TEXT PRIMARY KEY,
                undo_token TEXT NOT NULL,
                generated_summary TEXT NOT NULL,
                generated_summary_revision INTEGER NOT NULL,
                prior_summary TEXT,
                prior_summary_provenance TEXT,
                source_fingerprint TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
            )",
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
        // Voiceprints, all opt-in (`meetings.rememberVoices`). These five
        // columns hold the *cluster* side of the feature — one voice signature
        // per speaker turn-group in one meeting — and are written only while
        // the setting is on. The remembered-voice side lives in
        // `speaker_profiles` below.
        self.ensure_table_column("speaker_aliases", "voice_centroid", "BLOB")?;
        self.ensure_table_column("speaker_aliases", "voice_centroid_model_id", "TEXT")?;
        self.ensure_table_column("speaker_aliases", "voice_profile_id", "TEXT")?;
        self.ensure_table_column("speaker_aliases", "voice_match_state", "TEXT")?;
        self.ensure_table_column("speaker_aliases", "voice_rejected_profiles", "TEXT")?;

        // A voice this Mac has been told to remember. Local only: never
        // exported, never readable through the CLI or MCP server, removed by
        // Reset Everything, and encrypted with the rest of the database when
        // the vault is on.
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS speaker_profiles (
                id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                linked_identity_hash TEXT,
                embedding_model_id TEXT NOT NULL,
                centroid BLOB NOT NULL,
                sample_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_speaker_profiles_embedding_model
             ON speaker_profiles(embedding_model_id)",
            [],
        )?;
        // The samples a profile's centroid is the mean of. Capped per profile
        // (`MAX_SAMPLES_PER_PROFILE`) so remembering a voice for a year does
        // not grow without bound, and so one bad sample ages out.
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS speaker_profile_samples (
                id TEXT PRIMARY KEY,
                profile_id TEXT NOT NULL REFERENCES speaker_profiles(id) ON DELETE CASCADE,
                embedding BLOB NOT NULL,
                source_recording_id TEXT,
                created_at TEXT NOT NULL
            )",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_speaker_profile_samples_profile
             ON speaker_profile_samples(profile_id, created_at)",
            [],
        )?;
        // Which speaker of the source meeting a confirmed sample came from, so
        // correcting that speaker's identity can withdraw exactly that sample.
        // NULL for samples written before this column existed.
        self.ensure_table_column("speaker_profile_samples", "source_speaker_id", "TEXT")?;

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
        self.ensure_table_column(
            "dictation_dictionary_entries",
            "revision",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        // A global clock also detects delete/recreate and A -> B -> A edits.
        // Triggers cover every writer, including older clients and SQL imports.
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS dictation_dictionary_revision_clock (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 0)
             );
             INSERT OR IGNORE INTO dictation_dictionary_revision_clock (id, revision) VALUES (1, 0);
             UPDATE dictation_dictionary_revision_clock
             SET revision = MAX(revision, COALESCE((SELECT MAX(revision) FROM dictation_dictionary_entries), 0))
             WHERE id = 1;
             CREATE TRIGGER IF NOT EXISTS dictation_dictionary_revision_insert
             AFTER INSERT ON dictation_dictionary_entries BEGIN
                UPDATE dictation_dictionary_revision_clock SET revision = revision + 1 WHERE id = 1;
                UPDATE dictation_dictionary_entries
                SET revision = (SELECT revision FROM dictation_dictionary_revision_clock WHERE id = 1)
                WHERE id = NEW.id;
             END;
             CREATE TRIGGER IF NOT EXISTS dictation_dictionary_revision_update
             AFTER UPDATE OF id, spoken_form, replacement, app_scope, case_sensitive, enabled,
                             category_scope, created_at, updated_at ON dictation_dictionary_entries BEGIN
                UPDATE dictation_dictionary_revision_clock SET revision = revision + 1 WHERE id = 1;
                UPDATE dictation_dictionary_entries
                SET revision = (SELECT revision FROM dictation_dictionary_revision_clock WHERE id = 1)
                WHERE id = NEW.id;
             END;",
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
            "CREATE INDEX IF NOT EXISTS idx_embeddings_model_id ON transcript_embeddings(model, id)",
            [],
        )?;
        initialize_semantic_revision(&self.conn)?;

        // The searchable text of one dictation: what was delivered and what the
        // recognizer heard before the pipeline touched it. `transcripts` keeps
        // only the delivered text (or the raw text when nothing changed), so
        // the raw side lives here; `reprocessed_from_id` links a "Process
        // again" entry back to the dictation whose audio it re-ran.
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS dictation_history_text (
                recording_id TEXT PRIMARY KEY,
                final_text TEXT NOT NULL,
                raw_text TEXT NOT NULL,
                reprocessed_from_id TEXT,
                mode_preset TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
            )",
            [],
        )?;
        self.ensure_table_column("dictation_history_text", "recognition_review_words", "TEXT")?;
        // Same optional-index contract as transcript_fts above: kept in step
        // by the writers in the same transaction, backfilled at startup, and
        // its absence degrades history search to a LIKE scan.
        if let Err(error) = self.conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS dictation_history_fts USING fts5(
                recording_id UNINDEXED,
                final_text,
                raw_text
            )",
            [],
        ) {
            tracing::warn!(
                "dictation_history_fts table unavailable; dictation history search will be limited: {}",
                error
            );
        }

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
        self.ensure_table_column("recordings", "dictation_corrected_text", "TEXT")?;
        self.ensure_table_column("recordings", "dictation_draft_text", "TEXT")?;
        self.ensure_table_column("recordings", "dictation_draft_base_edit", "TEXT")?;
        self.ensure_table_column("recordings", "dictation_draft_updated_at", "INTEGER")?;
        self.ensure_table_column(
            "recordings",
            "summary_revision",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        self.ensure_table_column("recordings", "action_items", "TEXT")?;
        self.ensure_table_column(
            "recordings",
            "meeting_action_completion",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        self.ensure_table_column("recordings", "meeting_notes", "TEXT")?;
        self.ensure_table_column("recordings", "meeting_template_id", "TEXT")?;
        self.ensure_table_column("recordings", "notes_updated_at", "TEXT")?;
        self.ensure_table_column("recordings", "meeting_capture_mode", "TEXT")?;
        self.ensure_table_column("recordings", "imported_source_name", "TEXT")?;
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
        // Who was in the meeting, as a JSON array of {name, email, isOrganizer}.
        // A column rather than a table because the list is written once, read
        // whole, and never queried across meetings by SQL -- the pre-meeting
        // brief's attendee overlap is computed in Rust over recordings it has
        // already loaded. NULL for every meeting recorded before this existed,
        // which reads back as an empty list.
        self.ensure_table_column("recordings", "attendees", "TEXT")?;

        // The pauses taken during capture, as a JSON list of spans. The audio
        // file skips them, so this is the only record of where the gaps are
        // and how long they were.
        self.ensure_table_column("recordings", "pause_spans", "TEXT")?;
        // The conferencing service the meeting was on, when the calendar event
        // or the detected call it started from named one. A tag from a fixed
        // list, not free text -- see `models::known_video_service`.
        self.ensure_table_column("recordings", "video_service", "TEXT")?;
        // Cached pre-meeting briefs, one row per calendar event.
        //
        // `cache_key` is a hash of everything that went into the answer (see
        // `meeting_brief::brief_cache_key`), so a row whose key no longer
        // matches the current inputs is simply not returned -- there is no
        // expiry to tune and no way to hand back a brief written from
        // evidence that has since changed.
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS meeting_briefs (
                event_id TEXT PRIMARY KEY,
                cache_key TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL
            )",
            [],
        )?;

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
                measured_word_timestamps INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 0,
                diarizer TEXT
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
                measured_word_timestamps,
                created_at,
                revision,
                diarizer
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
                measured_word_timestamps,
                created_at,
                revision,
                diarizer
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

    /// One-time migration for dictations saved before `dictation_history_text`
    /// existed, plus missing FTS rows after a fresh or partially indexed open.
    ///
    /// Older rows never stored the raw transcript, so the delivered text
    /// stands in for both sides: search over them still works, it just cannot
    /// distinguish "what was heard" from "what was delivered".
    fn backfill_dictation_history_text_if_needed(&self) -> Result<()> {
        let _inserted_rows = self.conn.execute(
            "INSERT INTO dictation_history_text (
                recording_id, final_text, raw_text, reprocessed_from_id, mode_preset, created_at
             )
             SELECT r.id, COALESCE(t.full_text, ''), COALESCE(t.full_text, ''), NULL, NULL, r.created_at
             FROM recordings r
             JOIN transcripts t ON t.recording_id = r.id
             WHERE r.source_type = 'dictation'
               AND r.id NOT IN (SELECT recording_id FROM dictation_history_text)",
            [],
        )?;

        if !table_exists(&self.conn, "dictation_history_fts")? {
            return Ok(());
        }
        self.conn.execute(
            "INSERT INTO dictation_history_fts (recording_id, final_text, raw_text)
             SELECT recording_id, final_text, raw_text FROM dictation_history_text
             WHERE recording_id NOT IN (
                 SELECT recording_id FROM dictation_history_fts
                 WHERE recording_id IS NOT NULL
             )",
            [],
        )?;
        Ok(())
    }

    /// Writes (or replaces) a dictation's searchable text and its FTS row in
    /// the caller's transaction, so a transcript can never land without the
    /// text that makes it findable.
    fn write_dictation_history_text_transaction(
        tx: &rusqlite::Transaction<'_>,
        record: &DictationHistoryTextRecord,
    ) -> Result<()> {
        tx.execute(
            "INSERT INTO dictation_history_text (
                recording_id, final_text, raw_text, reprocessed_from_id, mode_preset, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(recording_id) DO UPDATE SET
                final_text = excluded.final_text,
                raw_text = excluded.raw_text,
                recognition_review_words = NULL,
                reprocessed_from_id = excluded.reprocessed_from_id,
                mode_preset = excluded.mode_preset",
            params![
                &record.recording_id,
                &record.final_text,
                &record.raw_text,
                &record.reprocessed_from_id,
                &record.mode_preset,
                record.created_at.to_rfc3339(),
            ],
        )?;
        if table_exists(tx, "dictation_history_fts")? {
            tx.execute(
                "DELETE FROM dictation_history_fts WHERE recording_id = ?1",
                params![&record.recording_id],
            )?;
            tx.execute(
                "INSERT INTO dictation_history_fts (recording_id, final_text, raw_text)
                 VALUES (?1, ?2, ?3)",
                params![&record.recording_id, &record.final_text, &record.raw_text],
            )?;
        }
        Ok(())
    }

    /// Atomically persist a completed dictation: its recording row, transcript
    /// and searchable text. Same contract as `create_recording_with_transcript`
    /// (nothing is visible in history unless all of it committed), plus the
    /// text that history search reads.
    pub fn create_dictation_history_entry(
        &mut self,
        recording: &Recording,
        transcript: &Transcript,
        history_text: &DictationHistoryTextRecord,
        kept_audio: Option<&ValidatedRecordingAudio>,
    ) -> Result<()> {
        self.create_dictation_history_entry_with_recognition_review(
            recording,
            transcript,
            history_text,
            kept_audio,
            None,
        )
    }

    pub fn create_dictation_history_entry_with_recognition_review(
        &mut self,
        recording: &Recording,
        transcript: &Transcript,
        history_text: &DictationHistoryTextRecord,
        kept_audio: Option<&ValidatedRecordingAudio>,
        review_words: Option<&[RecognitionReviewWord]>,
    ) -> Result<()> {
        if recording.id != transcript.recording_id || recording.id != history_text.recording_id {
            anyhow::bail!(
                "Recording id '{}' does not match transcript '{}' / history text '{}'",
                recording.id,
                transcript.recording_id,
                history_text.recording_id
            );
        }
        if kept_audio.is_some() && recording.audio_path.trim().is_empty() {
            anyhow::bail!(
                "Recording '{}' declares kept audio without an audio path",
                recording.id
            );
        }

        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("Failed to start dictation result transaction")?;
        insert_recording_row(&tx, recording, &recording.audio_path)?;
        if let Some(audio) = kept_audio {
            // A kept dictation WAV is owned exactly like a meeting's primary
            // track: the asset row is what manual delete, vault migration and
            // the runtime resolver read, so without it the file would be an
            // orphan the moment the row went away.
            let now = Utc::now().to_rfc3339();
            tx.execute(
                "INSERT INTO recording_audio_assets (
                    recording_id, role, path, lifecycle, protection,
                    plaintext_bytes, plaintext_sha256, created_at, updated_at
                 ) VALUES (?1, 'primary', ?2, 'ready', 'plaintext', ?3, ?4, ?5, ?5)",
                params![
                    &recording.id,
                    &recording.audio_path,
                    i64::try_from(audio.plaintext_bytes)
                        .context("Kept dictation audio is too large for SQLite metadata")?,
                    &audio.plaintext_sha256,
                    &now,
                ],
            )?;
        }
        Self::write_transcript_transaction(&tx, transcript)?;
        Self::write_dictation_history_text_transaction(&tx, history_text)?;
        let review_json = review_words
            .filter(|words| !words.is_empty())
            .map(serde_json::to_string)
            .transpose()?;
        tx.execute(
            "UPDATE dictation_history_text SET recognition_review_words = ?1 WHERE recording_id = ?2",
            params![review_json, &recording.id],
        )?;
        tx.commit()
            .context("Failed to commit dictation recording, transcript and history text")?;
        Ok(())
    }

    /// Atomically persist captured dictation audio after ASR failed. Failed
    /// recovery entries deliberately have no transcript or searchable history
    /// text: the audio is the only result, and the error row exists so the
    /// reader can process it again from History.
    pub fn create_failed_dictation_recovery_entry(
        &mut self,
        recording: &Recording,
        kept_audio: &ValidatedRecordingAudio,
    ) -> Result<()> {
        if recording.audio_path.trim().is_empty() {
            anyhow::bail!(
                "Failed dictation recording '{}' has no audio path",
                recording.id
            );
        }
        if recording.status != "error"
            || recording.transcript_complete
            || recording.transcript_degraded_reason.is_none()
        {
            anyhow::bail!(
                "Recording '{}' is not a failed dictation recovery entry",
                recording.id
            );
        }

        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("Failed to start failed dictation recovery transaction")?;
        insert_recording_row(&tx, recording, &recording.audio_path)?;
        tx.execute(
            "UPDATE recordings
                SET transcript_complete = 0, transcript_degraded_reason = ?2
              WHERE id = ?1",
            params![&recording.id, &recording.transcript_degraded_reason],
        )?;
        let now = Utc::now().to_rfc3339();
        tx.execute(
            "INSERT INTO recording_audio_assets (
                recording_id, role, path, lifecycle, protection,
                plaintext_bytes, plaintext_sha256, created_at, updated_at
             ) VALUES (?1, 'primary', ?2, 'ready', 'plaintext', ?3, ?4, ?5, ?5)",
            params![
                &recording.id,
                &recording.audio_path,
                i64::try_from(kept_audio.plaintext_bytes)
                    .context("Failed dictation audio is too large for SQLite metadata")?,
                &kept_audio.plaintext_sha256,
                &now,
            ],
        )?;
        tx.commit()
            .context("Failed to commit failed dictation recording and audio asset")?;
        Ok(())
    }

    /// A short preview of each dictation's delivered text and the app it went
    /// into, keyed by recording id, for history lists. One query for every
    /// dictation rather than one per row; the preview is capped at 240
    /// characters so a long dictation does not bloat the list payload.
    pub fn get_dictation_list_previews(&self) -> Result<DictationListPreviews> {
        let mut stmt = self.conn.prepare(
            "SELECT r.id,
                    CASE WHEN r.dictation_corrected_text IS NOT NULL
                         THEN SUBSTR(r.dictation_corrected_text, 1, 240)
                         ELSE SUBSTR(TRIM(h.final_text), 1, 240)
                    END,
                    (SELECT NULLIF(TRIM(ia.app_target), '')
                       FROM insertion_actions ia
                      WHERE ia.recording_id = r.id
                      ORDER BY ia.created_at DESC, ia.id DESC
                      LIMIT 1)
               FROM recordings r
               LEFT JOIN dictation_history_text h ON h.recording_id = r.id
              WHERE r.source_type = 'dictation'",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ),
            ))
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn get_dictation_history_text(
        &self,
        recording_id: &str,
    ) -> Result<Option<DictationHistoryTextRecord>> {
        self.conn
            .query_row(
                "SELECT recording_id, final_text, raw_text, reprocessed_from_id, mode_preset, created_at
                 FROM dictation_history_text WHERE recording_id = ?1",
                params![recording_id],
                |row| {
                    Ok(DictationHistoryTextRecord {
                        recording_id: row.get(0)?,
                        final_text: row.get(1)?,
                        raw_text: row.get(2)?,
                        reprocessed_from_id: row.get(3)?,
                        mode_preset: row.get(4)?,
                        created_at: row
                            .get::<_, String>(5)?
                            .parse()
                            .unwrap_or_else(|_| Utc::now()),
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn get_dictation_recognition_review_words(
        &self,
        recording_id: &str,
    ) -> Result<Option<Vec<RecognitionReviewWord>>> {
        let stored: Option<(Option<String>, String, i64)> = self.conn.query_row(
            "SELECT h.recognition_review_words, h.raw_text, r.duration FROM dictation_history_text h JOIN recordings r ON r.id = h.recording_id WHERE h.recording_id = ?1",
            params![recording_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        let Some((Some(json), raw_text, duration)) = stored else {
            return Ok(None);
        };
        // Review hints are optional. Damaged metadata must not hide saved text.
        if json.len() > 128 * 1024 {
            return Ok(None);
        }
        let Ok(mut words) = serde_json::from_str::<Vec<RecognitionReviewWord>>(&json) else {
            return Ok(None);
        };
        words.retain(|entry| {
            !entry.word.trim().is_empty()
                && entry.word.chars().count() <= 128
                && crate::models::recognition_word_occurs_in_source(&raw_text, &entry.word)
                && entry.score.is_finite()
                && (0.0..0.6).contains(&entry.score)
                && entry.start_time.is_finite()
                && entry.end_time.is_finite()
                && entry.start_time >= 0.0
                && entry.end_time > entry.start_time
                && entry.end_time <= duration.max(0) as f64 + 0.5
        });
        words.truncate(128);
        Ok((!words.is_empty()).then_some(words))
    }

    /// Ranked full-text search over saved dictations, newest-first among
    /// equal scores. Falls back to a LIKE scan when FTS5 is unavailable.
    pub fn search_dictation_history(
        &self,
        query: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<DictationHistorySearchHit>> {
        let fts_query = build_fts_query(query);
        if fts_query.is_empty() {
            return Ok(Vec::new());
        }
        let limit = limit.clamp(1, 200);
        let offset = offset.min(10_000);
        let fetch_limit = offset.saturating_add(limit).min(10_200) as i64;

        // `snippet()` column -1 picks whichever indexed column matched best;
        // the CASE beside it reports which one that was so the row can say
        // "heard" or "delivered". Ties on bm25 break newest-first.
        //
        // The bm25 weight list covers EVERY column of the table, `recording_id
        // UNINDEXED` included, and an omitted trailing weight defaults to 1.0.
        // So the three weights below are (recording_id, final_text, raw_text):
        // a two-weight list silently scored raw_text at its default 1.0 and
        // reported "delivered" for a row only the raw side matched.
        let sql = "SELECT
                f.recording_id,
                COALESCE(r.title, ''),
                r.created_at,
                snippet(dictation_history_fts, -1, '[[', ']]', '…', 14),
                CASE WHEN bm25(dictation_history_fts, 0.0, 1.0, 0.0)
                          <= bm25(dictation_history_fts, 0.0, 0.0, 1.0)
                     THEN 'final' ELSE 'raw' END,
                bm25(dictation_history_fts)
             FROM dictation_history_fts f
             JOIN recordings r ON r.id = f.recording_id
             WHERE dictation_history_fts MATCH ?1 AND r.source_type = 'dictation'
             ORDER BY bm25(dictation_history_fts) ASC, r.created_at DESC
             LIMIT ?2";
        let mut stmt = match self.conn.prepare(sql) {
            Ok(statement) => statement,
            Err(error) => {
                tracing::warn!(
                    "Dictation history FTS query unavailable ({}); using LIKE fallback search",
                    error
                );
                return self.search_dictation_history_without_fts(query, limit, offset);
            }
        };
        let rows = stmt.query_map(params![fts_query, fetch_limit], |row| {
            Ok(DictationHistorySearchHit {
                recording_id: row.get(0)?,
                recording_title: row.get(1)?,
                created_at: row
                    .get::<_, String>(2)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
                snippet: row.get(3)?,
                matched_field: row.get(4)?,
                score: row.get(5)?,
            })
        })?;
        let mut hits = rows.collect::<Result<Vec<_>, _>>()?;
        self.merge_corrected_dictation_search_hits(&mut hits, query)?;
        hits.sort_by(|left, right| {
            left.score
                .total_cmp(&right.score)
                .then_with(|| right.created_at.cmp(&left.created_at))
        });
        Ok(hits.into_iter().skip(offset).take(limit).collect())
    }

    fn merge_corrected_dictation_search_hits(
        &self,
        hits: &mut Vec<DictationHistorySearchHit>,
        query: &str,
    ) -> Result<()> {
        let terms = search_terms(query);
        let mut stmt = self.conn.prepare(
            "SELECT id, COALESCE(title, ''), created_at, dictation_corrected_text
             FROM recordings
             WHERE source_type = 'dictation' AND dictation_corrected_text IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        for row in rows {
            let (recording_id, recording_title, created_at, corrected_text) = row?;
            if !terms_match(&corrected_text, &terms) {
                continue;
            }
            hits.retain(|hit| hit.recording_id != recording_id);
            hits.push(DictationHistorySearchHit {
                recording_id,
                recording_title,
                created_at: created_at.parse().unwrap_or_else(|_| Utc::now()),
                snippet: like_snippet(&corrected_text, &terms, 14),
                matched_field: "corrected".to_string(),
                // Saved edits are the text the reader sees, so display their
                // match before evidence from the immutable original text.
                score: f64::MIN,
            });
        }
        Ok(())
    }

    fn search_dictation_history_without_fts(
        &self,
        query: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<DictationHistorySearchHit>> {
        let terms = search_terms(query);
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT r.id, COALESCE(r.title, ''), r.created_at,
                    h.final_text, h.raw_text, r.dictation_corrected_text
             FROM recordings r
             LEFT JOIN dictation_history_text h ON h.recording_id = r.id
             WHERE r.source_type = 'dictation'
             ORDER BY r.created_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                row.get::<_, Option<String>>(5)?,
            ))
        })?;

        let mut hits = Vec::new();
        for row in rows {
            let (recording_id, title, created_at, final_text, raw_text, corrected_text) = row?;
            let (text, matched_field) = if corrected_text
                .as_deref()
                .is_some_and(|text| terms_match(text, &terms))
            {
                (corrected_text.as_deref().unwrap_or_default(), "corrected")
            } else if terms_match(&final_text, &terms) {
                (final_text.as_str(), "final")
            } else if terms_match(&raw_text, &terms) {
                (raw_text.as_str(), "raw")
            } else {
                continue;
            };
            hits.push(DictationHistorySearchHit {
                recording_id,
                recording_title: title,
                created_at: created_at.parse().unwrap_or_else(|_| Utc::now()),
                snippet: like_snippet(text, &terms, 14),
                matched_field: matched_field.to_string(),
                // LIKE has no ranking; every hit ties and the newest-first
                // ORDER BY above decides.
                score: 0.0,
            });
        }
        Ok(hits.into_iter().skip(offset).take(limit).collect())
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

    /// Every recording, newest first (optionally in one project).
    pub fn get_recordings(&self, project_id: Option<&str>) -> Result<Vec<Recording>> {
        self.query_recordings(project_id, None, None)
    }

    /// IDs of notes jobs that were waiting when the sidecar stopped.
    pub(crate) fn recording_ids_waiting_for_notes(&self) -> Result<Vec<String>> {
        let mut query = self.conn.prepare(
            "SELECT id FROM recordings WHERE analysis_failure = ?1 ORDER BY created_at ASC",
        )?;
        let rows = query.query_map([crate::analysis::MEMORY_WAIT_NOTICE], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<Vec<String>>>()
            .map_err(Into::into)
    }

    /// The `limit` newest recordings, across every project.
    ///
    /// The cap belongs in SQL. A caller that only wants the recent few used to
    /// call `get_recordings(None)` and `.take(n)` the result, which deserializes
    /// every row in the library -- action items, provenance JSON, attendee JSON,
    /// pause spans -- to throw all but `n` away. On a Mac with years of
    /// meetings that is the whole library read for a handful of rows.
    pub fn get_recent_recordings(&self, limit: usize) -> Result<Vec<Recording>> {
        self.query_recordings(None, Some(limit), None)
    }

    /// Brief retrieval is bounded to the newest meetings, regardless of dictation volume.
    pub(crate) fn meeting_brief_candidates(
        &self,
        limit: usize,
    ) -> Result<Vec<crate::meeting_brief::BriefCandidate>> {
        self.query_recordings(None, Some(limit), Some("meeting"))?
            .into_iter()
            .map(|recording| {
                let artifact = self.get_meeting_artifact(&recording.id)?;
                let decisions = artifact.map(|value| value.decisions).unwrap_or_default();
                let completed: HashSet<String> = self
                    .get_meeting_action_completion(&recording.id)?
                    .into_iter()
                    .collect();
                let actions = recording.action_items.as_deref().unwrap_or_default();
                let task_review = action_item_review_status(
                    recording.action_items_provenance.as_ref(), actions,
                );
                let mut seen = HashSet::new();
                let action_items: Vec<String> = actions.iter()
                    .filter(|task| !task.trim().is_empty() && !completed.contains(*task)
                        && seen.insert((*task).clone()))
                    .cloned().collect();
                let summary_review = recording.summary.as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .is_some_and(|_| recording.summary_provenance.as_ref()
                        .is_none_or(|value| !value.grounded || value.citations.is_empty()));
                let needs_review = !recording.transcript_complete || summary_review
                    || action_items.iter().any(|task| task_review.get(task).copied().unwrap_or(true))
                    // Artifact decisions have no claim-level verification metadata.
                    || decisions.iter().any(|value| !value.trim().is_empty());
                Ok(crate::meeting_brief::BriefCandidate {
                    recording_id: recording.id,
                    title: recording.title,
                    created_at: recording.created_at,
                    summary: recording.summary,
                    action_items,
                    decisions,
                    attendees: recording.attendees,
                    needs_review,
                })
            }).collect()
    }

    fn query_recordings(
        &self,
        project_id: Option<&str>,
        limit: Option<usize>,
        source_type: Option<&str>,
    ) -> Result<Vec<Recording>> {
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
                    recordings.analysis_failure,
                    recordings.imported_source_name,
                    recordings.pause_spans,
                    recordings.video_service,
                    recordings.attendees,
                    recordings.transcript_complete,
                    recordings.transcript_degraded_reason,
                    recordings.transcript_incomplete_acknowledged_at,
                    recordings.capture_degraded_summary
             FROM recordings
             LEFT JOIN meeting_artifacts ON meeting_artifacts.recording_id = recordings.id
             WHERE (?1 IS NULL OR recordings.project_id = ?1)
               AND (?3 IS NULL OR recordings.source_type = ?3)
             ORDER BY recordings.created_at DESC
             LIMIT ?2",
        )?;

        let pid_param: Option<&str> = project_id;
        // SQLite reads a negative LIMIT as no limit, which is how the
        // unlimited call shares one prepared statement with the capped one.
        let limit_param: i64 = match limit {
            Some(limit) => i64::try_from(limit).unwrap_or(i64::MAX),
            None => -1,
        };

        let recordings = stmt.query_map(params![pid_param, limit_param, source_type], |row| {
            let summary: Option<String> = row.get(9)?;
            let action_items_json: Option<String> = row.get(10)?;
            let action_items: Option<Vec<String>> =
                action_items_json.and_then(|s| serde_json::from_str(&s).ok());
            let mut summary_provenance =
                validated_summary_provenance(row.get(20)?, summary.as_deref());
            let mut action_items_provenance = validated_action_items_provenance(
                row.get(21)?,
                action_items.as_deref().unwrap_or_default(),
            );
            demote_incomplete_analysis(
                row.get::<_, i64>(27)? == 0
                    || row
                        .get::<_, Option<String>>(30)?
                        .is_some_and(|s| !s.trim().is_empty()),
                &mut summary_provenance,
                &mut action_items_provenance,
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
                imported_source_name: row
                    .get::<_, Option<String>>(23)?
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                pause_spans: parse_pause_spans(row.get::<_, Option<String>>(24)?),
                video_service: known_video_service(row.get::<_, Option<String>>(25)?.as_deref()),
                // Sanitized on the way back out as well as on the way in: a
                // hand-edited row is exactly as capable of holding 5000
                // duplicates as a crafted command payload is.
                attendees: crate::models::sanitize_meeting_attendees(
                    row.get::<_, Option<String>>(26)?
                        .and_then(|value| serde_json::from_str(&value).ok())
                        .unwrap_or_default(),
                ),
                transcript_complete: row.get::<_, i64>(27)? != 0,
                transcript_degraded_reason: row.get(28)?,
                transcript_incomplete_acknowledged_at: row
                    .get::<_, Option<String>>(29)?
                    .and_then(|value| value.parse().ok()),
                capture_degraded_summary: row.get(30)?,
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
                    recordings.analysis_failure,
                    recordings.imported_source_name,
                    recordings.pause_spans,
                    recordings.video_service,
                    recordings.attendees,
                    recordings.transcript_complete,
                    recordings.transcript_degraded_reason,
                    recordings.transcript_incomplete_acknowledged_at,
                    recordings.capture_degraded_summary
             FROM recordings
             LEFT JOIN meeting_artifacts ON meeting_artifacts.recording_id = recordings.id
             WHERE recordings.id = ?1",
        )?;

        let result = stmt.query_row([recording_id], |row| {
            let summary: Option<String> = row.get(9)?;
            let action_items_json: Option<String> = row.get(10)?;
            let action_items: Option<Vec<String>> =
                action_items_json.and_then(|s| serde_json::from_str(&s).ok());
            let mut summary_provenance =
                validated_summary_provenance(row.get(20)?, summary.as_deref());
            let mut action_items_provenance = validated_action_items_provenance(
                row.get(21)?,
                action_items.as_deref().unwrap_or_default(),
            );
            demote_incomplete_analysis(
                row.get::<_, i64>(27)? == 0
                    || row
                        .get::<_, Option<String>>(30)?
                        .is_some_and(|s| !s.trim().is_empty()),
                &mut summary_provenance,
                &mut action_items_provenance,
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
                imported_source_name: row
                    .get::<_, Option<String>>(23)?
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                pause_spans: parse_pause_spans(row.get::<_, Option<String>>(24)?),
                video_service: known_video_service(row.get::<_, Option<String>>(25)?.as_deref()),
                // Sanitized on the way back out as well as on the way in: a
                // hand-edited row is exactly as capable of holding 5000
                // duplicates as a crafted command payload is.
                attendees: crate::models::sanitize_meeting_attendees(
                    row.get::<_, Option<String>>(26)?
                        .and_then(|value| serde_json::from_str(&value).ok())
                        .unwrap_or_default(),
                ),
                transcript_complete: row.get::<_, i64>(27)? != 0,
                transcript_degraded_reason: row.get(28)?,
                transcript_incomplete_acknowledged_at: row
                    .get::<_, Option<String>>(29)?
                    .and_then(|value| value.parse().ok()),
                capture_degraded_summary: row.get(30)?,
            })
        });

        match result {
            Ok(recording) => Ok(Some(recording)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn get_meeting_action_completion(&self, recording_id: &str) -> Result<Vec<String>> {
        let (source_type, action_items, completed_hashes) =
            load_meeting_action_completion(&self.conn, recording_id)?
                .context("Recording not found")?;
        if source_type != "meeting" {
            anyhow::bail!("Action completion is only available for meetings");
        }
        Ok(completed_meeting_action_tasks(
            &action_items,
            &completed_hashes,
        ))
    }

    pub(crate) fn list_meeting_followups(
        &self,
        query: Option<&str>,
        offset: usize,
        limit: usize,
        include_completed: bool,
    ) -> Result<MeetingFollowupPage> {
        let query_terms = query
            .map(|query| {
                query
                    .split_whitespace()
                    .map(str::to_lowercase)
                    .collect::<Vec<_>>()
            })
            .filter(|terms| !terms.is_empty());
        let mut statement = self.conn.prepare(
            "SELECT recordings.id,
                    COALESCE(meeting_artifacts.title, recordings.title),
                    COALESCE(meeting_artifacts.action_items, recordings.action_items),
                    recordings.meeting_action_completion,
                    meeting_artifacts.action_items_provenance,
                    recordings.transcript_complete, recordings.capture_degraded_summary
             FROM recordings
             LEFT JOIN meeting_artifacts ON meeting_artifacts.recording_id = recordings.id
             WHERE recordings.source_type = 'meeting'
             ORDER BY recordings.created_at DESC, recordings.id DESC",
        )?;
        let mut rows = statement.query([])?;
        let mut matching_task_index = 0usize;
        let mut items = Vec::with_capacity(limit.saturating_add(1));

        while let Some(row) = rows.next()? {
            let recording_id: String = row.get(0)?;
            let meeting_title: String = row.get(1)?;
            let action_items_json: Option<String> = row.get(2)?;
            let completed_hashes_json: String = row.get(3)?;
            let action_items = action_items_json
                .and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok())
                .unwrap_or_default();
            let mut provenance = validated_action_items_provenance(row.get(4)?, &action_items);
            demote_incomplete_analysis(
                row.get::<_, i64>(5)? == 0
                    || row
                        .get::<_, Option<String>>(6)?
                        .is_some_and(|s| !s.trim().is_empty()),
                &mut None,
                &mut provenance,
            );
            let task_review = action_item_review_status(provenance.as_ref(), &action_items);
            let completed_hashes = serde_json::from_str::<Vec<String>>(&completed_hashes_json)
                .unwrap_or_default()
                .into_iter()
                .collect::<HashSet<_>>();
            let normalized_title = meeting_title.to_lowercase();
            let mut seen_tasks = HashSet::new();

            for task in action_items {
                if task.trim().is_empty() || !seen_tasks.insert(task.clone()) {
                    continue;
                }
                let completed = completed_hashes.contains(&analysis_content_hash(&task));
                let normalized_task = task.to_lowercase();
                if (!include_completed && completed)
                    || query_terms.as_ref().is_some_and(|terms| {
                        !terms.iter().all(|term| {
                            normalized_title.contains(term) || normalized_task.contains(term)
                        })
                    })
                {
                    continue;
                }
                if matching_task_index < offset {
                    matching_task_index += 1;
                    continue;
                }
                items.push(MeetingFollowup {
                    recording_id: recording_id.clone(),
                    meeting_title: meeting_title.clone(),
                    needs_review: task_review.get(&task).copied().unwrap_or(false),
                    task,
                    completed,
                });
                matching_task_index += 1;
                if items.len() > limit {
                    break;
                }
            }
            if items.len() > limit {
                break;
            }
        }

        let has_more = items.len() > limit;
        if has_more {
            items.pop();
        }
        Ok(MeetingFollowupPage {
            next_offset: has_more.then(|| offset + items.len()),
            items,
        })
    }

    /// Replace one existing line and move its completion hash in one guarded write.
    pub fn edit_meeting_action(
        &mut self,
        recording_id: &str,
        expected_items: &[String],
        index: usize,
        replacement: &str,
    ) -> Result<(Recording, Vec<String>)> {
        let replacement = replacement.trim();
        if replacement.is_empty() || replacement.contains('\n') || replacement.contains('\r') {
            anyhow::bail!("Enter one non-empty task line");
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (source_type, mut items, mut hashes) =
            load_meeting_action_completion(&tx, recording_id)?.context("Recording not found")?;
        if source_type != "meeting" {
            anyhow::bail!("Task editing is only available for meetings");
        }
        if items != expected_items {
            anyhow::bail!(
                "Tasks changed. Review the latest task list before retrying. Your draft was kept."
            );
        }
        let old = items.get(index).context("Action item not found")?.clone();
        let old_hash = analysis_content_hash(&old);
        let new_hash = analysis_content_hash(replacement);
        if replacement != old
            && items.iter().enumerate().any(|(i, item)| {
                i != index
                    && (analysis_content_hash(item) == old_hash
                        || analysis_content_hash(item) == new_hash)
            })
        {
            anyhow::bail!("This edit overlaps an identical task. Use the full task editor to resolve duplicates first.");
        }
        let previous_json: Option<String> = tx
            .query_row(
                "SELECT action_items_provenance FROM meeting_artifacts WHERE recording_id = ?1",
                [recording_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let previous = validated_action_items_provenance(previous_json, &items);
        items[index] = replacement.to_string();
        let provenance = previous
            .as_ref()
            .and_then(|previous| preserve_matching_action_item_provenance(previous, &items, true));
        if hashes.remove(&old_hash) {
            hashes.insert(new_hash);
        }
        let current_hashes: HashSet<String> = items
            .iter()
            .map(|item| analysis_content_hash(item))
            .collect();
        hashes.retain(|hash| current_hashes.contains(hash));
        let completed = completed_meeting_action_tasks(&items, &hashes);
        let items_json = serde_json::to_string(&items)?;
        let provenance_json = provenance.as_ref().map(serde_json::to_string).transpose()?;
        let hashes_json = serde_json::to_string(&hashes.iter().collect::<Vec<_>>())?;
        tx.execute("UPDATE recordings SET action_items = ?1, meeting_action_completion = ?2, updated_at = ?3 WHERE id = ?4",
            params![items_json, hashes_json, Utc::now().to_rfc3339(), recording_id])?;
        tx.execute("UPDATE meeting_artifacts SET action_items = ?1, action_items_provenance = ?2, updated_at = ?3 WHERE recording_id = ?4",
            params![items_json, provenance_json, Utc::now().to_rfc3339(), recording_id])?;
        tx.commit()?;
        let recording = self
            .get_recording(recording_id)?
            .context("Recording not found")?;
        Ok((recording, completed))
    }

    pub fn add_meeting_action(
        &mut self,
        recording_id: &str,
        expected_items: &[String],
        replacement: &str,
    ) -> Result<(Recording, Vec<String>)> {
        let replacement = replacement.trim();
        if replacement.is_empty() || replacement.contains('\n') || replacement.contains('\r') {
            anyhow::bail!("Enter one non-empty task line");
        }
        self.mutate_meeting_action_membership(recording_id, expected_items, None, |items| {
            let hash = analysis_content_hash(replacement);
            if items.iter().any(|item| analysis_content_hash(item) == hash) {
                anyhow::bail!("This task already exists. Edit the existing task instead.");
            }
            items.push(replacement.to_string());
            Ok(())
        })
    }

    pub fn delete_meeting_action(
        &mut self,
        recording_id: &str,
        expected_items: &[String],
        index: usize,
    ) -> Result<(Recording, Vec<String>)> {
        self.mutate_meeting_action_membership(recording_id, expected_items, Some(index), |items| {
            if index >= items.len() {
                anyhow::bail!("Action item not found");
            }
            items.remove(index);
            Ok(())
        })
    }

    /// Add or remove one line without overwriting a newer task list.
    fn mutate_meeting_action_membership(
        &mut self,
        recording_id: &str,
        expected_items: &[String],
        removed_index: Option<usize>,
        mutate: impl FnOnce(&mut Vec<String>) -> Result<()>,
    ) -> Result<(Recording, Vec<String>)> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (source_type, mut items, mut hashes) =
            load_meeting_action_completion(&tx, recording_id)?.context("Recording not found")?;
        if source_type != "meeting" {
            anyhow::bail!("Task editing is only available for meetings");
        }
        if items != expected_items {
            anyhow::bail!(
                "Tasks changed. Review the latest task list before retrying. Your draft was kept."
            );
        }
        let previous_json: Option<String> = tx
            .query_row(
                "SELECT action_items_provenance FROM meeting_artifacts WHERE recording_id = ?1",
                [recording_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let mut previous = validated_action_items_provenance(previous_json, &items);
        mutate(&mut items)?;
        // Remove the exact occurrence before matching survivors. Equal task text
        // can carry different source citations on each row.
        if let (Some(index), Some(previous)) = (removed_index, previous.as_mut()) {
            previous.items.remove(index);
        }
        let provenance = previous
            .as_ref()
            .and_then(|previous| preserve_matching_action_item_provenance(previous, &items, true));
        let current_hashes: HashSet<String> = items
            .iter()
            .map(|item| analysis_content_hash(item))
            .collect();
        hashes.retain(|hash| current_hashes.contains(hash));
        let completed = completed_meeting_action_tasks(&items, &hashes);
        let items_json = serde_json::to_string(&items)?;
        let provenance_json = provenance.as_ref().map(serde_json::to_string).transpose()?;
        let hashes_json = serde_json::to_string(&hashes.iter().collect::<Vec<_>>())?;
        let now = Utc::now().to_rfc3339();
        tx.execute("UPDATE recordings SET action_items = ?1, meeting_action_completion = ?2, updated_at = ?3 WHERE id = ?4",
            params![items_json, hashes_json, now, recording_id])?;
        tx.execute("UPDATE meeting_artifacts SET action_items = ?1, action_items_provenance = ?2, updated_at = ?3 WHERE recording_id = ?4",
            params![items_json, provenance_json, now, recording_id])?;
        tx.commit()?;
        let recording = self
            .get_recording(recording_id)?
            .context("Recording not found")?;
        Ok((recording, completed))
    }

    pub fn set_meeting_action_completed(
        &mut self,
        recording_id: &str,
        task: &str,
        completed: bool,
    ) -> Result<Vec<String>> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (source_type, action_items, stored_hashes) =
            load_meeting_action_completion(&tx, recording_id)?.context("Recording not found")?;
        if source_type != "meeting" {
            anyhow::bail!("Action completion is only available for meetings");
        }
        if !action_items.iter().any(|action_item| action_item == task) {
            anyhow::bail!("Action item not found");
        }

        let current_hashes = action_items
            .iter()
            .map(|action_item| analysis_content_hash(action_item))
            .collect::<HashSet<_>>();
        let task_hash = analysis_content_hash(task);
        let mut completed_hashes = stored_hashes
            .intersection(&current_hashes)
            .cloned()
            .collect::<HashSet<_>>();
        if completed {
            completed_hashes.insert(task_hash);
        } else {
            completed_hashes.remove(&task_hash);
        }

        let mut emitted_hashes = HashSet::new();
        let ordered_hashes = action_items
            .iter()
            .map(|action_item| analysis_content_hash(action_item))
            .filter(|hash| completed_hashes.contains(hash) && emitted_hashes.insert(hash.clone()))
            .collect::<Vec<_>>();
        tx.execute(
            "UPDATE recordings SET meeting_action_completion = ?1 WHERE id = ?2",
            params![serde_json::to_string(&ordered_hashes)?, recording_id],
        )?;
        tx.commit()?;

        Ok(completed_meeting_action_tasks(
            &action_items,
            &completed_hashes,
        ))
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

    pub(crate) fn recording_has_transcript(&self, recording_id: &str) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM transcripts WHERE recording_id=?1)",
            [recording_id],
            |row| row.get(0),
        )?)
    }

    pub fn get_transcript(&self, recording_id: &str) -> Result<Option<Transcript>> {
        Ok(self
            .get_transcript_with_revision(recording_id)?
            .map(|(transcript, _revision)| transcript))
    }

    /// Does this recording have a transcript with any text in it?
    ///
    /// The predicate mirrors what a loaded [`Transcript`] would report — a
    /// segment list that is not empty, or a non-blank `full_text` — without
    /// deserializing the segment JSON. `save_transcript` writes compact
    /// `serde_json` output, so an empty list is exactly the two characters
    /// `[]`.
    ///
    /// The point of not loading it: the CLI's `stats` asked this about every
    /// recording on the machine, which meant reading and parsing every
    /// transcript in the database to answer a question about counts.
    const TRANSCRIPT_HAS_CONTENT_SQL: &'static str =
        "(full_text IS NOT NULL AND trim(full_text) <> '') \
         OR (segments IS NOT NULL AND trim(segments) NOT IN ('', '[]', 'null'))";

    pub(crate) fn has_transcript_content(&self, recording_id: &str) -> Result<bool> {
        let found: i64 = self.conn.query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM transcripts WHERE recording_id = ?1 AND ({}))",
                Self::TRANSCRIPT_HAS_CONTENT_SQL
            ),
            [recording_id],
            |row| row.get(0),
        )?;
        Ok(found != 0)
    }

    /// Every recording id whose transcript has content, in one query.
    pub(crate) fn recording_ids_with_transcript_content(&self) -> Result<HashSet<String>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT DISTINCT recording_id FROM transcripts WHERE {}",
            Self::TRANSCRIPT_HAS_CONTENT_SQL
        ))?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<HashSet<String>>>()?;
        Ok(ids)
    }

    pub fn get_transcript_with_revision(
        &self,
        recording_id: &str,
    ) -> Result<Option<(Transcript, i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, recording_id, segments, full_text, language, confidence, model, model_id, requested_provider, actual_provider, measured_word_timestamps, created_at, revision, heard_through_speakers
             FROM transcripts WHERE recording_id = ?1",
        )?;

        let result = stmt.query_row([recording_id], |row| {
            let segments_json: String = row.get(2)?;
            let mut segments: Vec<TranscriptSegment> =
                serde_json::from_str(&segments_json).unwrap_or_default();
            let full_text: String = row.get(3)?;
            let mut measured_word_timestamps = row.get::<_, i64>(10)? != 0;

            if segments.is_empty() && !full_text.trim().is_empty() {
                measured_word_timestamps = false;
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
                measured_word_timestamps,
                created_at: row
                    .get::<_, String>(11)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
                heard_through_speakers: row
                    .get::<_, Option<String>>(13)?
                    .and_then(|json| serde_json::from_str(&json).ok())
                    .unwrap_or_default(),
            };
            Ok((transcript, row.get(12)?))
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
                meeting_notes, meeting_template_id, meeting_capture_mode, imported_source_name,
                notes_updated_at, consent_prompt_shown, consent_notice_mode, consent_notice_surface,
                consent_notice_message, consent_notice_updated_at, video_service
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
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
                &recording.imported_source_name,
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
                    .map(|value| value.to_rfc3339()),
                &recording.video_service
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
        self.clear_idle_audio_compression(recording_id)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for role in roles {
            tx.execute(
                "DELETE FROM recording_audio_assets WHERE recording_id = ?1 AND role = ?2",
                params![recording_id, role.as_str()],
            )?;
        }
        if roles.contains(&RecordingAudioRole::Primary)
            || !tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM recording_audio_assets WHERE recording_id=?1)",
                [recording_id],
                |r| r.get::<_, bool>(0),
            )?
        {
            tx.execute(
                "UPDATE recordings SET audio_path = '', updated_at = ?1 WHERE id = ?2",
                params![&now, recording_id],
            )?;
        }
        tx.execute("UPDATE recordings SET audio_path=COALESCE((SELECT path FROM recording_audio_assets WHERE recording_id=?1 ORDER BY CASE role WHEN 'system' THEN 0 ELSE 1 END LIMIT 1),'') WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM recording_audio_assets WHERE recording_id=?1 AND role='primary')",[recording_id])?;
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
        tx.execute("UPDATE recordings SET audio_path=(SELECT path FROM recording_audio_assets WHERE recording_id=?1 ORDER BY CASE role WHEN 'system' THEN 0 ELSE 1 END LIMIT 1) WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM recording_audio_assets WHERE recording_id=?1 AND role='primary')",[recording_id])?;
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
        anyhow::ensure!(
            !self.has_pending_audio_compression(recording_id)?,
            "Audio compression is pending; vault encryption will retry after it finishes"
        );
        self.clear_idle_audio_compression(recording_id)?;
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
        tx.execute("UPDATE recordings SET audio_path=(SELECT path FROM recording_audio_assets WHERE recording_id=?1 ORDER BY CASE role WHEN 'system' THEN 0 ELSE 1 END LIMIT 1) WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM recording_audio_assets WHERE recording_id=?1 AND role='primary')",[&operation.recording_id])?;
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
                     WHERE recording_id = ?1
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

    pub fn queue_meeting_note_recovery(
        &mut self,
        id: &str,
        recording_id: &str,
        base_notes: &str,
        notes: &str,
    ) -> Result<()> {
        if id.is_empty()
            || id.len() > 128
            || notes.len() > 2_000_000
            || base_notes.len() > 2_000_000
        {
            anyhow::bail!("Invalid meeting note recovery draft");
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM recordings WHERE id=?1)",
            [recording_id],
            |r| r.get(0),
        )?;
        if !exists {
            anyhow::bail!("Recording not found");
        }
        tx.execute("INSERT OR IGNORE INTO meeting_note_recovery (id,recording_id,base_notes,notes,created_at) VALUES (?1,?2,?3,?4,?5)", params![id,recording_id,base_notes,notes,Utc::now().to_rfc3339()])?;
        let stored: (String, String, String) = tx.query_row(
            "SELECT recording_id,base_notes,notes FROM meeting_note_recovery WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        if stored
            != (
                recording_id.to_string(),
                base_notes.to_string(),
                notes.to_string(),
            )
        {
            anyhow::bail!("Recovery draft ID already has different content");
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_meeting_note_recovery(&self) -> Result<Vec<MeetingNoteRecoveryDraft>> {
        let mut statement = self.conn.prepare("SELECT id,recording_id,base_notes,notes FROM meeting_note_recovery ORDER BY created_at,id")?;
        let drafts = statement
            .query_map([], |r| {
                Ok(MeetingNoteRecoveryDraft {
                    id: r.get(0)?,
                    recording_id: r.get(1)?,
                    base_notes: r.get(2)?,
                    notes: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(drafts)
    }

    fn validate_enhanced_note_draft(
        recording_id: &str,
        draft: &MeetingEnhancedNoteDraft,
    ) -> Result<()> {
        if recording_id.is_empty()
            || recording_id.len() > 256
            || draft.text.trim().is_empty()
            || draft.text.len() > 200_000
            || draft.raw_notes_snapshot.len() > 200_000
            || draft.summary_citations.len() > 256
            || draft.action_item_citations.len() > 256
            || draft.generated_at.timestamp() < 946684800
            || draft.generated_at > Utc::now() + chrono::Duration::minutes(5)
            || serde_json::to_vec(draft)?.len() > 1_000_000
        {
            anyhow::bail!("Invalid enhanced meeting note draft");
        }
        for item in &draft.action_item_citations {
            if item.label.trim().is_empty()
                || item.label.len() > 10_000
                || item.citations.len() > 256
            {
                anyhow::bail!("Invalid enhanced meeting note action");
            }
        }
        for citation in draft.summary_citations.iter().chain(
            draft
                .action_item_citations
                .iter()
                .flat_map(|item| &item.citations),
        ) {
            if citation.text.trim().is_empty()
                || citation.text.len() > 20_000
                || citation
                    .recording_id
                    .as_deref()
                    .is_some_and(|id| id != recording_id)
                || citation
                    .source_kind
                    .as_deref()
                    .is_some_and(|kind| !matches!(kind, "transcript" | "meeting_note"))
                || [&citation.line_id, &citation.segment_id].iter().any(|id| {
                    id.as_ref()
                        .is_some_and(|id| id.is_empty() || id.len() > 256)
                })
                || [citation.start_time, citation.end_time]
                    .into_iter()
                    .flatten()
                    .any(|time| !time.is_finite() || time < 0.0)
                || citation.certainty.is_some_and(|certainty| {
                    !certainty.is_finite() || !(0.0..=1.0).contains(&certainty)
                })
                || matches!((citation.start_time, citation.end_time), (Some(start), Some(end)) if end < start)
            {
                anyhow::bail!("Invalid enhanced meeting note citation");
            }
        }
        Ok(())
    }

    pub fn get_meeting_enhanced_note_draft(
        &self,
        recording_id: &str,
    ) -> Result<Option<MeetingEnhancedNoteDraft>> {
        let raw: Option<String> = self.conn.query_row("SELECT d.draft_json FROM meeting_enhanced_note_drafts d JOIN recordings r ON r.id=d.recording_id WHERE d.recording_id=?1 AND r.source_type='meeting'", [recording_id], |row| row.get(0)).optional()?;
        raw.map(|raw| {
            if raw.len() > 1_000_000 {
                anyhow::bail!("Invalid enhanced meeting note draft");
            }
            let draft = serde_json::from_str(&raw)?;
            Self::validate_enhanced_note_draft(recording_id, &draft)?;
            Ok(draft)
        })
        .transpose()
    }

    pub fn save_meeting_enhanced_note_draft(
        &mut self,
        recording_id: &str,
        draft: &MeetingEnhancedNoteDraft,
    ) -> Result<MeetingEnhancedNoteDraft> {
        Self::validate_enhanced_note_draft(recording_id, draft)?;
        let tx = self.conn.transaction()?;
        let source: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT source_type,meeting_notes FROM recordings WHERE id=?1",
                [recording_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((source_type, notes)) = source else {
            anyhow::bail!("Recording not found");
        };
        if source_type != "meeting" {
            anyhow::bail!("Enhanced notes require a meeting recording");
        }
        if notes.as_deref().unwrap_or("") != draft.raw_notes_snapshot {
            anyhow::bail!("Meeting notes changed. Build the draft again from the saved notes.");
        }
        tx.execute("INSERT INTO meeting_enhanced_note_drafts (recording_id,draft_json) VALUES (?1,?2) ON CONFLICT(recording_id) DO UPDATE SET draft_json=excluded.draft_json", params![recording_id,serde_json::to_string(draft)?])?;
        tx.commit()?;
        Ok(draft.clone())
    }

    pub fn delete_meeting_enhanced_note_draft(&mut self, recording_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM meeting_enhanced_note_drafts WHERE recording_id=?1",
            [recording_id],
        )?;
        Ok(())
    }

    pub fn update_recording_notes(
        &mut self,
        recording_id: &str,
        meeting_notes: Option<&str>,
    ) -> Result<()> {
        self.update_recording_notes_recovering(recording_id, meeting_notes, None)
    }

    pub fn update_recording_notes_recovering(
        &mut self,
        recording_id: &str,
        meeting_notes: Option<&str>,
        recovery_id: Option<&str>,
    ) -> Result<()> {
        self.update_recording_notes_recovering_guarded(
            recording_id,
            meeting_notes,
            recovery_id,
            None,
        )
    }

    pub fn update_recording_notes_recovering_guarded(
        &mut self,
        recording_id: &str,
        meeting_notes: Option<&str>,
        recovery_id: Option<&str>,
        expected_notes: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now();
        let tx = self.conn.transaction()?;
        if let Some(id) = recovery_id {
            let owner: Option<String> = tx
                .query_row(
                    "SELECT recording_id FROM meeting_note_recovery WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
                .optional()?;
            if owner.is_some_and(|owner| owner != recording_id) {
                anyhow::bail!("Recovery draft belongs to another recording");
            }
        }
        let existing: Option<Option<String>> = tx
            .query_row(
                "SELECT meeting_notes FROM recordings WHERE id = ?1",
                [recording_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(existing) = existing else {
            anyhow::bail!("Recording not found: {}", recording_id);
        };
        if expected_notes.is_some_and(|expected| existing.as_deref().unwrap_or("") != expected) {
            anyhow::bail!("Meeting notes changed while saving. Retry to merge the latest notes.");
        }
        if existing.as_deref() == meeting_notes {
            if let Some(id) = recovery_id {
                tx.execute("DELETE FROM meeting_note_recovery WHERE id=?1", [id])?;
            }
            tx.commit()?;
            return Ok(());
        }

        let updated = tx.execute(
            "UPDATE recordings
             SET meeting_notes = ?1, notes_updated_at = ?2, updated_at = ?2
             WHERE id = ?3",
            params![meeting_notes, now.to_rfc3339(), recording_id],
        )?;
        if updated != 1 {
            anyhow::bail!("Recording not found: {}", recording_id);
        }
        // Keep the previous summary's source history for comparison, while
        // making it clear that changed notes have not been checked against it.
        let raw: Option<String> = tx
            .query_row(
                "SELECT summary_provenance FROM meeting_artifacts WHERE recording_id = ?1",
                [recording_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let stale = raw.and_then(|raw| {
            let mut value: serde_json::Value = serde_json::from_str(&raw).ok()?;
            value
                .as_object_mut()?
                .insert("grounded".to_string(), serde_json::Value::Bool(false));
            serde_json::to_string(&value).ok()
        });
        tx.execute(
            "UPDATE meeting_artifacts SET summary_provenance = ?1,
             action_items_provenance = NULL, updated_at = ?2 WHERE recording_id = ?3",
            params![stale, now.to_rfc3339(), recording_id],
        )?;
        if let Some(id) = recovery_id {
            tx.execute("DELETE FROM meeting_note_recovery WHERE id=?1", [id])?;
        }
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
    /// Persist the pauses taken during a meeting's capture.
    pub fn set_recording_pause_spans(
        &mut self,
        recording_id: &str,
        spans: &[crate::recording_pause::PauseSpan],
    ) -> Result<()> {
        let json = if spans.is_empty() {
            None
        } else {
            Some(serde_json::to_string(spans)?)
        };
        self.conn.execute(
            "UPDATE recordings SET pause_spans = ?1 WHERE id = ?2",
            params![json, recording_id],
        )?;
        Ok(())
    }

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
        let capture_warning: Option<String> = tx.query_row(
            "SELECT capture_degraded_summary FROM recordings WHERE id = ?1",
            params![recording_id],
            |row| row.get(0),
        )?;
        let (transcript_complete, degraded_reason) = capture_safe_completion(
            transcript_complete,
            degraded_reason,
            capture_warning.as_deref(),
        );
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
    /// recordings retained audio may help recover ASR failures. Known capture
    /// loss remains irrecoverable even when the retained audio is reprocessed.
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
        self.patch_recording_analysis_inner(
            recording_id,
            summary,
            action_items,
            summary_provenance,
            action_items_provenance,
            None,
        )
    }

    pub fn replace_generated_summary_with_undo(
        &mut self,
        recording_id: &str,
        expected_summary: Option<&str>,
        summary: &str,
        provenance: &AnalysisProvenance,
        source_fingerprint: &str,
    ) -> Result<Recording> {
        self.patch_recording_analysis_inner(
            recording_id,
            Some(Some(summary)),
            None,
            Some(provenance),
            None,
            Some((expected_summary, source_fingerprint)),
        )
    }

    fn patch_recording_analysis_inner(
        &mut self,
        recording_id: &str,
        summary: Option<Option<&str>>,
        action_items: Option<&[String]>,
        summary_provenance: Option<&AnalysisProvenance>,
        action_items_provenance: Option<&ActionItemsProvenance>,
        undo_snapshot: Option<(Option<&str>, &str)>,
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
        if undo_snapshot.is_some()
            && summary_provenance.is_some_and(|provenance| !provenance.grounded)
            && previous_summary
                .as_deref()
                .is_some_and(|summary| !summary.trim().is_empty())
        {
            anyhow::bail!("The new recap failed its source checks. Your saved summary was kept. Retry or choose another text model.");
        }
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
                            preserve_matching_action_item_provenance(
                                previous,
                                &next_action_items,
                                false,
                            )
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
        if let Some((expected_summary, source_fingerprint)) = undo_snapshot {
            if recording.summary.as_deref() != expected_summary {
                anyhow::bail!("The summary changed while analysis was running; the stale result was not saved.");
            }
            let prior_provenance_json = recording
                .summary_provenance
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            let prior_summary_revision: i64 = tx.query_row(
                "SELECT summary_revision FROM recordings WHERE id = ?1",
                params![recording_id],
                |row| row.get(0),
            )?;
            tx.execute(
                "INSERT INTO summary_regeneration_undo (
                    recording_id, undo_token, generated_summary, generated_summary_revision,
                    prior_summary, prior_summary_provenance, source_fingerprint, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(recording_id) DO UPDATE SET
                    undo_token = excluded.undo_token,
                    generated_summary = excluded.generated_summary,
                    generated_summary_revision = excluded.generated_summary_revision,
                    prior_summary = excluded.prior_summary,
                    prior_summary_provenance = excluded.prior_summary_provenance,
                    source_fingerprint = excluded.source_fingerprint,
                    created_at = excluded.created_at",
                params![
                    recording_id,
                    uuid::Uuid::new_v4().to_string(),
                    &next_summary,
                    prior_summary_revision + 1,
                    &recording.summary,
                    prior_provenance_json,
                    source_fingerprint,
                    now.to_rfc3339(),
                ],
            )?;
        }
        let updated = tx.execute(
            "UPDATE recordings
             SET summary = ?1,
                 action_items = CASE WHEN ?3 = 1 THEN ?2 ELSE action_items END,
                 summary_revision = summary_revision + CASE WHEN ?6 = 1 THEN 1 ELSE 0 END,
                 updated_at = ?4
             WHERE id = ?5",
            params![
                &next_summary,
                &action_items_json,
                if action_items.is_some() { 1 } else { 0 },
                now.to_rfc3339(),
                recording_id,
                if summary_changed { 1 } else { 0 },
            ],
        )?;
        if updated != 1 {
            anyhow::bail!("Recording not found: {}", recording_id);
        }
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

    pub fn can_undo_summary_regeneration(&self, recording_id: &str) -> Result<bool> {
        Ok(self
            .summary_regeneration_undo_token(recording_id)?
            .is_some())
    }

    pub fn summary_regeneration_undo_token(&self, recording_id: &str) -> Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT undo.undo_token
                 FROM summary_regeneration_undo undo
                 JOIN recordings recording ON recording.id = undo.recording_id
                 WHERE undo.recording_id = ?1
                   AND recording.summary = undo.generated_summary
                   AND recording.summary_revision = undo.generated_summary_revision",
                params![recording_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn summary_regeneration_undo_source_fingerprint(
        &self,
        recording_id: &str,
    ) -> Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT undo.source_fingerprint
                 FROM summary_regeneration_undo undo
                 JOIN recordings recording ON recording.id = undo.recording_id
                 WHERE undo.recording_id = ?1
                   AND recording.summary = undo.generated_summary
                   AND recording.summary_revision = undo.generated_summary_revision",
                params![recording_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn undo_summary_regeneration(
        &mut self,
        recording_id: &str,
        undo_token: &str,
        current_source_fingerprint: Option<&str>,
    ) -> Result<Recording> {
        let now = Utc::now().to_rfc3339();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let snapshot = tx
            .query_row(
                "SELECT generated_summary, generated_summary_revision, prior_summary,
                        prior_summary_provenance
                 FROM summary_regeneration_undo
                 WHERE recording_id = ?1 AND undo_token = ?2",
                params![recording_id, undo_token],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| anyhow::anyhow!("There is no summary regeneration to undo."))?;
        let restored_provenance = snapshot.3.and_then(|raw| {
            let provenance: AnalysisProvenance = serde_json::from_str(&raw).ok()?;
            let prior_fingerprint = provenance
                .prompt_source
                .rsplit_once(":input=")
                .map(|(_, fingerprint)| fingerprint)?;
            (Some(prior_fingerprint) == current_source_fingerprint).then_some(raw)
        });
        let updated = tx.execute(
            "UPDATE recordings
             SET summary = ?1, summary_revision = summary_revision + 1, updated_at = ?2
             WHERE id = ?3 AND summary = ?4 AND summary_revision = ?5",
            params![&snapshot.2, &now, recording_id, &snapshot.0, snapshot.1],
        )?;
        if updated != 1 {
            anyhow::bail!("The summary changed after regeneration, so it cannot be undone.");
        }
        tx.execute(
            "UPDATE meeting_artifacts
             SET summary = ?1, summary_provenance = ?2, updated_at = ?3
             WHERE recording_id = ?4",
            params![&snapshot.2, restored_provenance, &now, recording_id],
        )?;
        tx.execute(
            "DELETE FROM summary_regeneration_undo WHERE recording_id = ?1",
            params![recording_id],
        )?;
        tx.commit()?;
        self.get_recording(recording_id)?
            .ok_or_else(|| anyhow::anyhow!("Recording not found after summary undo"))
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

    /// The cached brief for an event, but only when it was written from the
    /// same inputs. A key mismatch reads as "no cached brief".
    pub fn get_meeting_brief(&self, event_id: &str, cache_key: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT payload FROM meeting_briefs WHERE event_id = ?1 AND cache_key = ?2")?;
        let result = stmt.query_row(params![event_id, cache_key], |row| row.get::<_, String>(0));
        match result {
            Ok(payload) => Ok(Some(payload)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn save_meeting_brief(
        &mut self,
        event_id: &str,
        cache_key: &str,
        payload: &str,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meeting_briefs (event_id, cache_key, payload, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(event_id) DO UPDATE SET
                 cache_key = excluded.cache_key,
                 payload = excluded.payload,
                 created_at = excluded.created_at",
            params![event_id, cache_key, payload, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Replace a meeting's attendee list.
    ///
    /// Called once when a meeting starts from a calendar cue, and again for
    /// every manual add or remove. Sanitized here rather than trusted from
    /// the caller: this is the boundary the renderer writes through.
    pub fn update_recording_attendees(
        &mut self,
        recording_id: &str,
        attendees: Vec<crate::models::MeetingAttendee>,
    ) -> Result<Vec<crate::models::MeetingAttendee>> {
        let sanitized = crate::models::sanitize_meeting_attendees(attendees);
        let encoded = serde_json::to_string(&sanitized)
            .context("Failed to serialize the meeting attendee list")?;
        let updated = self.conn.execute(
            "UPDATE recordings SET attendees = ?1, updated_at = ?2 WHERE id = ?3",
            params![encoded, Utc::now().to_rfc3339(), recording_id],
        )?;
        if updated != 1 {
            anyhow::bail!("Recording not found: {}", recording_id);
        }
        Ok(sanitized)
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
        let heard_through_speakers_json = if transcript.heard_through_speakers.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&transcript.heard_through_speakers)?)
        };
        tx.execute(
            "DELETE FROM transcripts WHERE recording_id = ?1",
            params![&transcript.recording_id],
        )?;
        tx.execute(
            "INSERT INTO transcripts (id, recording_id, segments, full_text, language, confidence, model, model_id, requested_provider, actual_provider, measured_word_timestamps, created_at, revision, heard_through_speakers)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13)",
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
                if transcript.measured_word_timestamps { 1 } else { 0 },
                transcript.created_at.to_rfc3339(),
                heard_through_speakers_json
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
        if !table_exists(tx, "transcript_fts")? {
            return Ok(());
        }
        tx.execute_batch("SAVEPOINT plainsong_transcript_fts_write;")?;
        let result = (|| -> rusqlite::Result<()> {
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
        })();
        if let Err(error) = result {
            tx.execute_batch(
                "ROLLBACK TO plainsong_transcript_fts_write; RELEASE plainsong_transcript_fts_write;",
            )?;
            // Only discard a corrupt virtual index. Disk-full and primary
            // database faults must still roll back the transcript transaction.
            if matches!(&error, rusqlite::Error::SqliteFailure(code, _)
                if code.extended_code == rusqlite::ffi::SQLITE_CORRUPT_VTAB)
            {
                tx.execute("DROP TABLE transcript_fts", [])?;
                tracing::warn!("Removed corrupt transcript search index; using fallback search until startup rebuilds it");
                return Ok(());
            }
            return Err(error.into());
        }
        tx.execute_batch("RELEASE plainsong_transcript_fts_write;")?;
        Ok(())
    }

    pub fn save_transcript(&mut self, transcript: &Transcript) -> Result<()> {
        let tx = self.conn.transaction()?;
        Self::write_transcript_transaction(&tx, transcript)?;
        tx.commit()?;
        Ok(())
    }

    /// Save a meeting's freshly transcribed transcript, replacing any earlier
    /// one. Speaker numbers from the earlier run (S1, S2, …) may now belong to
    /// different people, so their names and voice links go with it; the two
    /// capture sides (Me, Them) are the same people every run and keep theirs.
    /// Without this, re-transcribing showed the old names on whoever the new
    /// run numbered the same, and remembered those voices under them.
    pub fn save_meeting_transcript(&mut self, transcript: &Transcript) -> Result<()> {
        let tx = self.conn.transaction()?;
        Self::write_transcript_transaction(&tx, transcript)?;
        tx.execute(
            "DELETE FROM speaker_aliases
             WHERE recording_id = ?1 AND lower(speaker_id) NOT IN ('me', 'them')",
            params![&transcript.recording_id],
        )?;
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
             SET segments = ?1, full_text = ?2, measured_word_timestamps = 0,
                 revision = revision + 1
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
        expected_segments: &[TranscriptSegmentExpectation],
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

        const CHANGED: &str =
            "Transcript changed. Review the current turn before saving your correction.";
        let expected_ids = expected_segments
            .iter()
            .map(|segment| segment.id.as_str())
            .collect::<HashSet<_>>();
        if expected_ids.len() != expected_segments.len() || expected_ids != requested_ids {
            anyhow::bail!(CHANGED);
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
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

        for expectation in expected_segments {
            let current = segments
                .iter()
                .find(|segment| segment.id == expectation.id)
                .unwrap();
            if current.text != expectation.text
                || current.start_time != expectation.start_time
                || current.end_time != expectation.end_time
                || current.speaker_id != expectation.speaker_id
            {
                anyhow::bail!(CHANGED);
            }
        }

        let first_segment_id = segment_ids[0].as_str();
        let removed_segment_ids = segment_ids[1..]
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        // The kept segment now carries the whole turn's words, so it has to
        // span the whole turn: playback highlighting, jump-to-time and
        // subtitle cues all read these bounds.
        let (turn_start, turn_end) = segments
            .iter()
            .filter(|segment| requested_ids.contains(segment.id.as_str()))
            .fold(
                (f64::INFINITY, f64::NEG_INFINITY),
                |(start, end), segment| (start.min(segment.start_time), end.max(segment.end_time)),
            );
        let mut edited_segments = Vec::with_capacity(segments.len() - removed_segment_ids.len());
        for mut segment in segments {
            if segment.id == first_segment_id {
                segment.text = new_text.to_string();
                if turn_start.is_finite() && turn_end.is_finite() {
                    segment.start_time = turn_start;
                    segment.end_time = turn_end;
                }
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
             SET segments = ?1, full_text = ?2, measured_word_timestamps = 0,
                 revision = revision + 1
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
        self.delete_transcript_segments_transaction(recording_id, segment_ids, None)
    }

    pub fn delete_transcript_segments_guarded(
        &mut self,
        recording_id: &str,
        segment_ids: &[String],
        expected_segments: &[TranscriptSegmentExpectation],
    ) -> Result<usize> {
        self.delete_transcript_segments_transaction(
            recording_id,
            segment_ids,
            Some(expected_segments),
        )
    }

    fn delete_transcript_segments_transaction(
        &mut self,
        recording_id: &str,
        segment_ids: &[String],
        expected_segments: Option<&[TranscriptSegmentExpectation]>,
    ) -> Result<usize> {
        const CHANGED: &str = "Transcript changed. Review the current turn before deleting it.";
        if segment_ids.is_empty() {
            if expected_segments.is_some() {
                anyhow::bail!(CHANGED);
            }
            return Ok(0);
        }
        if let Some(expected) = expected_segments {
            let selected = segment_ids.iter().collect::<HashSet<_>>();
            let expected_ids = expected
                .iter()
                .map(|segment| &segment.id)
                .collect::<HashSet<_>>();
            if selected.len() != segment_ids.len()
                || expected_ids.len() != expected.len()
                || selected != expected_ids
            {
                anyhow::bail!(CHANGED);
            }
        }

        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let stored = tx
            .query_row(
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
                        row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    ))
                },
            )
            .optional()?;
        let Some((segments_json, stored_full_text, confidence, duration)) = stored else {
            if expected_segments.is_some() {
                anyhow::bail!(CHANGED);
            }
            return Ok(0);
        };
        let mut segments: Vec<TranscriptSegment> = serde_json::from_str(&segments_json)
            .with_context(|| {
                format!("Invalid transcript segments for recording: {recording_id}")
            })?;
        if segments.is_empty() && !stored_full_text.trim().is_empty() {
            segments.push(TranscriptSegment {
                id: format!("{recording_id}-full-text"),
                start_time: 0.0,
                end_time: duration.max(0) as f64,
                text: stored_full_text,
                speaker_id: None,
                confidence,
            });
        }

        if let Some(expected) = expected_segments {
            for expectation in expected {
                let mut matching = segments
                    .iter()
                    .filter(|segment| segment.id == expectation.id);
                let Some(current) = matching.next() else {
                    anyhow::bail!(CHANGED);
                };
                if matching.next().is_some()
                    || current.text != expectation.text
                    || current.start_time != expectation.start_time
                    || current.end_time != expectation.end_time
                    || current.speaker_id != expectation.speaker_id
                {
                    anyhow::bail!(CHANGED);
                }
            }
        }

        let selected = segment_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let original_len = segments.len();
        segments.retain(|segment| !selected.contains(segment.id.as_str()));
        let removed = original_len.saturating_sub(segments.len());
        if removed == 0 {
            if expected_segments.is_some() {
                anyhow::bail!(CHANGED);
            }
            return Ok(0);
        }

        let full_text = segments
            .iter()
            .map(|segment| segment.text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let segments_json = serde_json::to_string(&segments)?;
        let updated = tx.execute(
            "UPDATE transcripts
             SET segments = ?1, full_text = ?2, measured_word_timestamps = 0,
                 revision = revision + 1
             WHERE recording_id = ?3",
            params![segments_json, full_text, recording_id],
        )?;
        if updated != 1 {
            anyhow::bail!(CHANGED);
        }
        Self::invalidate_analysis_provenance_transaction(&tx, recording_id)?;
        Self::invalidate_transcript_embeddings_transaction(&tx, recording_id)?;
        Self::rebuild_transcript_fts_transaction(&tx, recording_id, &segments)?;
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
             WHERE length(CAST(spoken_form AS BLOB)) <= ?1
               AND length(CAST(replacement AS BLOB)) <= ?2
             ORDER BY spoken_form ASC, created_at ASC
             LIMIT ?3",
        )?;

        let rows = stmt.query_map(
            params![
                MAX_DICTIONARY_SPOKEN_FORM_BYTES as i64,
                MAX_DICTIONARY_REPLACEMENT_BYTES as i64,
                MAX_DICTIONARY_ENTRIES
            ],
            dictation_dictionary_entry_from_row,
        )?;

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
        if spoken_form.len() > MAX_DICTIONARY_SPOKEN_FORM_BYTES {
            anyhow::bail!("Dictionary spoken form is too long");
        }
        let replacement = request.replacement.trim();
        if replacement.is_empty() {
            anyhow::bail!("Dictionary replacement cannot be empty");
        }
        if replacement.len() > MAX_DICTIONARY_REPLACEMENT_BYTES {
            anyhow::bail!("Dictionary replacement is too long");
        }
        let app_scope = request
            .app_scope
            .as_ref()
            .map(|scope| scope.trim().to_string())
            .filter(|scope| !scope.is_empty());
        let category_scope = normalize_category_scope(request.category_scope.as_deref())?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = tx
            .query_row(
                "SELECT id, spoken_form, replacement, app_scope, case_sensitive, enabled,
                        category_scope, created_at, updated_at
                 FROM dictation_dictionary_entries
                 WHERE spoken_form = ?1 AND replacement = ?2
                   AND app_scope IS ?3 AND case_sensitive = ?4 AND enabled = ?5
                   AND category_scope IS ?6
                 ORDER BY created_at ASC, id ASC
                 LIMIT 1",
                params![
                    spoken_form,
                    replacement,
                    &app_scope,
                    if request.case_sensitive { 1 } else { 0 },
                    if request.enabled { 1 } else { 0 },
                    &category_scope,
                ],
                dictation_dictionary_entry_from_row,
            )
            .optional()?;
        if let Some(existing) = existing {
            tx.commit()?;
            return Ok(existing);
        }

        let entry_count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM dictation_dictionary_entries",
            [],
            |row| row.get(0),
        )?;
        if entry_count >= MAX_DICTIONARY_ENTRIES {
            anyhow::bail!("Dictionary entry limit reached");
        }

        let now = Utc::now();
        let entry = DictationDictionaryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            spoken_form: spoken_form.to_string(),
            replacement: replacement.to_string(),
            app_scope,
            case_sensitive: request.case_sensitive,
            enabled: request.enabled,
            category_scope,
            created_at: now,
            updated_at: now,
        };

        tx.execute(
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
        tx.commit()?;

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
        if spoken_form.len() > MAX_DICTIONARY_SPOKEN_FORM_BYTES {
            anyhow::bail!("Dictionary spoken form is too long");
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
        if replacement.len() > MAX_DICTIONARY_REPLACEMENT_BYTES {
            anyhow::bail!("Dictionary replacement is too long");
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

    pub(crate) fn learn_dictation_correction(
        &mut self,
        spoken_form: &str,
        replacement: &str,
    ) -> Result<LearnDictationCorrectionResult> {
        let spoken_form = spoken_form.trim().to_string();
        let replacement = replacement.trim().to_string();
        if spoken_form.is_empty()
            || replacement.is_empty()
            || spoken_form.len() > MAX_DICTIONARY_SPOKEN_FORM_BYTES
            || replacement.len() > MAX_DICTIONARY_REPLACEMENT_BYTES
        {
            anyhow::bail!("Correction exceeds the dictionary field limits");
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous_entry =
            Self::correction_dictionary_target(&tx, &spoken_form)?.map(|(entry, _)| entry);
        let now = Utc::now();
        let (action, entry_id) = if let Some(previous) = &previous_entry {
            tx.execute(
                "UPDATE dictation_dictionary_entries
                 SET replacement = ?1, updated_at = ?2
                 WHERE id = ?3",
                params![&replacement, now.to_rfc3339(), &previous.id],
            )?;
            ("updated", previous.id.clone())
        } else {
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM dictation_dictionary_entries",
                [],
                |row| row.get(0),
            )?;
            if count >= MAX_DICTIONARY_ENTRIES {
                anyhow::bail!("Dictionary entry limit reached");
            }
            let entry_id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO dictation_dictionary_entries
                 (id, spoken_form, replacement, app_scope, case_sensitive, enabled, category_scope, created_at, updated_at)
                 VALUES (?1, ?2, ?3, NULL, 0, 1, NULL, ?4, ?4)",
                params![&entry_id, &spoken_form, &replacement, now.to_rfc3339()],
            )?;
            ("created", entry_id)
        };
        let (entry, expected_revision) = tx.query_row(
            "SELECT id, spoken_form, replacement, app_scope, case_sensitive, enabled,
                    category_scope, created_at, updated_at, revision
             FROM dictation_dictionary_entries WHERE id = ?1",
            [&entry_id],
            |row| {
                Ok((
                    dictation_dictionary_entry_from_row(row)?,
                    row.get::<_, i64>(9)?,
                ))
            },
        )?;
        tx.execute(
            "DELETE FROM dictation_correction_suggestions
             WHERE spoken_form = ?1 COLLATE NOCASE AND replacement = ?2 COLLATE BINARY",
            params![&spoken_form, &replacement],
        )?;
        tx.commit()?;
        let token =
            self.record_correction_approval_undo(entry_id, expected_revision, previous_entry);
        Ok(LearnDictationCorrectionResult {
            learned: true,
            action: Some(action.to_string()),
            reason: None,
            spoken_form: Some(spoken_form),
            replacement: Some(replacement),
            entry: Some(entry),
            undo_token: Some(token),
        })
    }

    fn correction_dictionary_target(
        conn: &Connection,
        spoken_form: &str,
    ) -> Result<Option<(DictationDictionaryEntry, i64)>> {
        Ok(conn
            .query_row(
                "SELECT id, spoken_form, replacement, app_scope, case_sensitive, enabled,
                    category_scope, created_at, updated_at, revision
             FROM dictation_dictionary_entries
             WHERE app_scope IS NULL AND category_scope IS NULL AND enabled = 1
               AND spoken_form = ?1 COLLATE NOCASE
               AND length(CAST(spoken_form AS BLOB)) <= ?2
               AND length(CAST(replacement AS BLOB)) <= ?3
             ORDER BY spoken_form ASC, created_at ASC, id ASC LIMIT 1",
                params![
                    spoken_form,
                    MAX_DICTIONARY_SPOKEN_FORM_BYTES as i64,
                    MAX_DICTIONARY_REPLACEMENT_BYTES as i64
                ],
                |row| Ok((dictation_dictionary_entry_from_row(row)?, row.get(9)?)),
            )
            .optional()?)
    }

    fn correction_dictionary_snapshot(
        conn: &Connection,
        spoken_form: &str,
    ) -> Result<CorrectionApprovalDictionarySnapshot> {
        Ok(
            match Self::correction_dictionary_target(conn, spoken_form)? {
                Some((entry, revision)) => CorrectionApprovalDictionarySnapshot::Entry {
                    entry_id: entry.id,
                    revision,
                    spoken_form: entry.spoken_form,
                    replacement: entry.replacement,
                },
                None => CorrectionApprovalDictionarySnapshot::Missing,
            },
        )
    }

    fn prune_correction_approval_undo(&mut self) {
        let now = std::time::Instant::now();
        self.correction_approval_undo.retain(|_, receipt| {
            now.saturating_duration_since(receipt.issued_at) < CORRECTION_APPROVAL_UNDO_TTL
        });
    }

    fn record_correction_approval_undo(
        &mut self,
        entry_id: String,
        expected_revision: i64,
        previous_entry: Option<DictationDictionaryEntry>,
    ) -> String {
        self.prune_correction_approval_undo();
        while self.correction_approval_undo.len() >= CORRECTION_APPROVAL_UNDO_CAP {
            let oldest = self
                .correction_approval_undo
                .iter()
                .min_by_key(|(_, receipt)| receipt.issued_at)
                .map(|(token, _)| token.clone());
            if let Some(token) = oldest {
                self.correction_approval_undo.remove(&token);
            } else {
                break;
            }
        }
        let token = uuid::Uuid::new_v4().to_string();
        self.correction_approval_undo.insert(
            token.clone(),
            CorrectionApprovalUndoReceipt {
                entry_id,
                expected_revision,
                previous_entry,
                issued_at: std::time::Instant::now(),
            },
        );
        token
    }

    pub(crate) fn approve_dictation_correction_suggestion(
        &mut self,
        suggestion_id: &str,
        expected_dictionary: &CorrectionApprovalDictionarySnapshot,
    ) -> Result<LearnDictationCorrectionResult> {
        self.prune_correction_approval_undo();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (spoken_form, replacement, updated_at): (String, String, String) = tx.query_row(
            "SELECT spoken_form, replacement, updated_at FROM dictation_correction_suggestions WHERE id = ?1",
            [suggestion_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?.ok_or_else(|| anyhow::anyhow!("Correction suggestion is no longer available"))?;
        let updated_at = chrono::DateTime::parse_from_rfc3339(&updated_at)
            .map_err(|_| {
                anyhow::anyhow!(
                    "This suggestion has an invalid date. Dismiss it and review a new suggestion."
                )
            })?
            .with_timezone(&Utc);
        let age = Utc::now().signed_duration_since(updated_at);
        if age < chrono::Duration::zero()
            || age
                >= chrono::Duration::days(
                    crate::dictation_correction_capture::CORRECTION_SUGGESTION_MAX_AGE_DAYS,
                )
        {
            anyhow::bail!("This suggestion expired or has an invalid date. Dismiss it and review a new suggestion. Your dictionary is unchanged.");
        }
        let spoken_form = spoken_form.trim().to_string();
        let replacement = replacement.trim().to_string();
        if spoken_form.is_empty()
            || replacement.is_empty()
            || spoken_form.len() > MAX_DICTIONARY_SPOKEN_FORM_BYTES
            || replacement.len() > MAX_DICTIONARY_REPLACEMENT_BYTES
        {
            anyhow::bail!("Correction exceeds the dictionary field limits");
        }
        let actual = Self::correction_dictionary_snapshot(&tx, &spoken_form)?;
        if &actual != expected_dictionary {
            anyhow::bail!("Your dictionary changed after this suggestion was shown. Refresh the suggestions and review it again. Your dictionary is unchanged.");
        }
        let previous_entry =
            Self::correction_dictionary_target(&tx, &spoken_form)?.map(|(entry, _)| entry);
        let now = Utc::now();
        let (action, entry_id) = if let Some(previous) = &previous_entry {
            tx.execute(
                "UPDATE dictation_dictionary_entries
                 SET replacement = ?1, updated_at = ?2
                 WHERE id = ?3",
                params![&replacement, now.to_rfc3339(), &previous.id],
            )?;
            ("updated", previous.id.clone())
        } else {
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM dictation_dictionary_entries",
                [],
                |row| row.get(0),
            )?;
            if count >= MAX_DICTIONARY_ENTRIES {
                anyhow::bail!("Dictionary entry limit reached");
            }
            let entry_id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO dictation_dictionary_entries
                 (id, spoken_form, replacement, app_scope, case_sensitive, enabled, category_scope, created_at, updated_at)
                 VALUES (?1, ?2, ?3, NULL, 0, 1, NULL, ?4, ?4)",
                params![&entry_id, &spoken_form, &replacement, now.to_rfc3339()],
            )?;
            ("created", entry_id)
        };
        let (entry, expected_revision) = tx.query_row(
            "SELECT id, spoken_form, replacement, app_scope, case_sensitive, enabled,
                    category_scope, created_at, updated_at, revision
             FROM dictation_dictionary_entries WHERE id = ?1",
            [&entry_id],
            |row| {
                Ok((
                    dictation_dictionary_entry_from_row(row)?,
                    row.get::<_, i64>(9)?,
                ))
            },
        )?;
        let deleted = tx.execute(
            "DELETE FROM dictation_correction_suggestions WHERE id = ?1",
            [suggestion_id],
        )?;
        if deleted != 1 {
            anyhow::bail!("Correction suggestion is no longer available");
        }
        tx.commit()?;

        let token =
            self.record_correction_approval_undo(entry_id, expected_revision, previous_entry);
        Ok(LearnDictationCorrectionResult {
            learned: true,
            action: Some(action.to_string()),
            reason: None,
            spoken_form: Some(spoken_form),
            replacement: Some(replacement),
            entry: Some(entry),
            undo_token: Some(token),
        })
    }

    pub(crate) fn undo_dictation_correction_approval(
        &mut self,
        undo_token: &str,
    ) -> Result<UndoDictationCorrectionApprovalResult> {
        self.prune_correction_approval_undo();
        let receipt = self
            .correction_approval_undo
            .get(undo_token)
            .cloned()
            .ok_or_else(|| {
                anyhow::anyhow!("Undo expired or was already used. Your dictionary is unchanged.")
            })?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (changed, restored) = if let Some(previous) = &receipt.previous_entry {
            let now = Utc::now();
            let changed = tx.execute(
                "UPDATE dictation_dictionary_entries
                 SET spoken_form = ?1, replacement = ?2, app_scope = ?3, case_sensitive = ?4,
                     enabled = ?5, category_scope = ?6, created_at = ?7, updated_at = ?8
                 WHERE id = ?9 AND revision = ?10",
                params![
                    &previous.spoken_form,
                    &previous.replacement,
                    &previous.app_scope,
                    if previous.case_sensitive { 1 } else { 0 },
                    if previous.enabled { 1 } else { 0 },
                    &previous.category_scope,
                    previous.created_at.to_rfc3339(),
                    now.to_rfc3339(),
                    &receipt.entry_id,
                    receipt.expected_revision
                ],
            )?;
            let mut restored = previous.clone();
            restored.updated_at = now;
            (changed, Some(restored))
        } else {
            let changed = tx.execute(
                "DELETE FROM dictation_dictionary_entries WHERE id = ?1 AND revision = ?2",
                params![&receipt.entry_id, receipt.expected_revision],
            )?;
            (changed, None)
        };
        if changed != 1 {
            anyhow::bail!("This dictionary entry changed after approval. Undo left it unchanged.");
        }
        tx.commit()?;
        // Failed transactions keep their receipt; a confirmed undo consumes it once.
        self.correction_approval_undo.remove(undo_token);
        Ok(UndoDictationCorrectionApprovalResult {
            entry_id: receipt.entry_id,
            entry: restored,
        })
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
                approval_dictionary: None,
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

        let mut suggestions = rows.collect::<Result<Vec<_>, _>>()?;
        for suggestion in &mut suggestions {
            suggestion.approval_dictionary = Some(Self::correction_dictionary_snapshot(
                &self.conn,
                &suggestion.spoken_form,
            )?);
        }
        Ok(suggestions)
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
                    && suggestion.source.as_deref() == normalized_source.as_deref()
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
                    approval_dictionary: Some(Self::correction_dictionary_snapshot(
                        &self.conn,
                        normalized_spoken_form,
                    )?),
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
                approval_dictionary: Some(Self::correction_dictionary_snapshot(
                    &self.conn,
                    normalized_spoken_form,
                )?),
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

    pub fn has_learned_global_dictation_correction(
        &self,
        spoken_form: &str,
        replacement: &str,
    ) -> Result<bool> {
        Ok(self
            .list_dictation_dictionary_entries()?
            .iter()
            .any(|entry| {
                entry.enabled
                    && !entry.case_sensitive
                    && entry.app_scope.is_none()
                    && entry.category_scope.is_none()
                    && entry.spoken_form.eq_ignore_ascii_case(spoken_form)
                    && entry.replacement == replacement
            }))
    }

    /// A globally learned rule already resolves matching suggestions from any app.
    /// Keep alternative replacements, including differences in capitalization.
    pub fn clear_learned_dictation_correction_suggestions(
        &mut self,
        spoken_form: &str,
        replacement: &str,
    ) -> Result<usize> {
        Ok(self.conn.execute(
            "DELETE FROM dictation_correction_suggestions
             WHERE spoken_form = ?1 COLLATE NOCASE AND replacement = ?2 COLLATE BINARY",
            params![spoken_form, replacement],
        )?)
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
        self.search_transcripts_filtered(
            query,
            limit,
            TranscriptSearchFilters {
                project_ids,
                ..Default::default()
            },
        )
    }

    pub fn search_transcripts_with_project_scope(
        &self,
        query: &str,
        limit: usize,
        project_ids: Option<&[String]>,
        source_type: Option<&str>,
    ) -> Result<Vec<SearchHit>> {
        self.search_transcripts_filtered(
            query,
            limit,
            TranscriptSearchFilters {
                project_ids,
                source_type,
                ..Default::default()
            },
        )
    }

    pub fn search_transcripts_with_filters(
        &self,
        query: &str,
        limit: usize,
        project_ids: Option<&[String]>,
        source_type: Option<&str>,
        recording_status: Option<&str>,
    ) -> Result<Vec<SearchHit>> {
        self.search_transcripts_filtered(
            query,
            limit,
            TranscriptSearchFilters {
                project_ids,
                source_type,
                recording_status,
                ..Default::default()
            },
        )
    }

    pub fn search_transcripts_with_scope(
        &self,
        query: &str,
        limit: usize,
        exclude_recording_id: Option<&str>,
        source_type: Option<&str>,
    ) -> Result<Vec<SearchHit>> {
        self.search_transcripts_filtered(
            query,
            limit,
            TranscriptSearchFilters {
                exclude_recording_id,
                source_type,
                ..Default::default()
            },
        )
    }

    pub fn search_transcripts_in_recordings(
        &self,
        query: &str,
        limit: usize,
        recording_ids: &[String],
    ) -> Result<Vec<SearchHit>> {
        self.search_transcripts_filtered(
            query,
            limit,
            TranscriptSearchFilters {
                recording_ids: Some(recording_ids),
                ..Default::default()
            },
        )
    }

    fn search_transcripts_filtered(
        &self,
        query: &str,
        limit: usize,
        filters: TranscriptSearchFilters<'_>,
    ) -> Result<Vec<SearchHit>> {
        let TranscriptSearchFilters {
            project_ids,
            recording_ids,
            exclude_recording_id,
            source_type,
            recording_status,
        } = filters;
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

        if let Some(recording_id) = exclude_recording_id {
            sql.push_str(" AND f.recording_id != ?");
            sql.push_str(&placeholder.to_string());
            values.push(Value::from(recording_id.to_string()));
            placeholder += 1;
        }

        if let Some(source_type) = source_type {
            sql.push_str(" AND r.source_type = ?");
            sql.push_str(&placeholder.to_string());
            values.push(Value::from(source_type.to_string()));
            placeholder += 1;
        }

        if let Some(recording_status) = recording_status {
            sql.push_str(" AND r.status = ?");
            sql.push_str(&placeholder.to_string());
            values.push(Value::from(recording_status.to_string()));
            placeholder += 1;
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
                return self.search_transcripts_without_fts(query, limit, filters);
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

        match rows.collect::<Result<Vec<_>, _>>() {
            Ok(hits) => Ok(hits),
            Err(rusqlite::Error::SqliteFailure(code, _))
                if code.extended_code == rusqlite::ffi::SQLITE_CORRUPT_VTAB =>
            {
                tracing::warn!("Corrupt transcript search index; using fallback search");
                self.search_transcripts_without_fts(query, limit, filters)
            }
            Err(error) => Err(error.into()),
        }
    }

    fn search_transcripts_without_fts(
        &self,
        query: &str,
        limit: usize,
        filters: TranscriptSearchFilters<'_>,
    ) -> Result<Vec<SearchHit>> {
        let TranscriptSearchFilters {
            project_ids,
            recording_ids,
            exclude_recording_id,
            source_type,
            recording_status,
        } = filters;
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

        if let Some(recording_id) = exclude_recording_id {
            sql.push_str(" AND t.recording_id != ?");
            sql.push_str(&placeholder.to_string());
            values.push(Value::from(recording_id.to_string()));
            placeholder += 1;
        }

        if let Some(source_type) = source_type {
            sql.push_str(" AND r.source_type = ?");
            sql.push_str(&placeholder.to_string());
            values.push(Value::from(source_type.to_string()));
            placeholder += 1;
        }

        if let Some(recording_status) = recording_status {
            sql.push_str(" AND r.status = ?");
            sql.push_str(&placeholder.to_string());
            values.push(Value::from(recording_status.to_string()));
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
             SET segments = ?1, full_text = ?2, measured_word_timestamps = 0,
                 revision = revision + 1
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

    /// `diarizer` is the stable identifier of whatever produced these speaker
    /// labels -- `deepgram`, `gemini_transcribe`, `mistral_voxtral`, or
    /// `plainsong:<embedding model id>`. It is written in the same transaction
    /// as the segments so the record and the labels cannot disagree.
    /// Store diarized segments, the speaker aliases they imply, and the name of
    /// the diarizer that produced them.
    ///
    /// `audit_details`, when present, is written as a
    /// `meeting_diarization_applied` entry *inside the same transaction*. The
    /// `diarizer` column and that entry record the same fact -- which diarizer
    /// produced the labels now stored -- and they used to be two writes under
    /// two separate acquisitions of the database lock. Between them the column
    /// read as changed with no audit record, and a failure of the second write
    /// left that disagreement permanently. Both now land or neither does.
    pub fn apply_diarization_enrichment(
        &mut self,
        recording_id: &str,
        expected_revision: i64,
        segments: &[TranscriptSegment],
        aliases: &[SpeakerAliasUpsert],
        diarizer: Option<&str>,
        audit_details: Option<serde_json::Value>,
    ) -> Result<bool> {
        self.apply_diarization(
            recording_id,
            expected_revision,
            segments,
            aliases,
            None,
            diarizer,
            audit_details,
        )
    }

    /// The explicit Relabel action: store a re-run's segments and replace the
    /// recording's speaker names with exactly the ones the caller decided.
    ///
    /// A re-run can renumber speakers, so keeping whatever name an id held
    /// before (as [`Self::apply_diarization_enrichment`] does) would leave
    /// "Carol" on the new S2 even when the matcher found that S2 is Ben's
    /// voice. Here every alias row of the recording is rewritten in the same
    /// transaction: `aliases` carry the final names, and `carried_from` maps
    /// each new speaker id to the earlier id whose voice it is. That earlier
    /// row's remembered-voice link, signature and "Not them" list move with
    /// the name; a speaker with no earlier match starts with none of them, and
    /// rows for ids the re-run no longer uses are removed.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_relabelled_diarization(
        &mut self,
        recording_id: &str,
        expected_revision: i64,
        segments: &[TranscriptSegment],
        aliases: &[SpeakerAliasUpsert],
        carried_from: &HashMap<String, String>,
        diarizer: Option<&str>,
        audit_details: Option<serde_json::Value>,
    ) -> Result<bool> {
        self.apply_diarization(
            recording_id,
            expected_revision,
            segments,
            aliases,
            Some(carried_from),
            diarizer,
            audit_details,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_diarization(
        &mut self,
        recording_id: &str,
        expected_revision: i64,
        segments: &[TranscriptSegment],
        aliases: &[SpeakerAliasUpsert],
        relabel_carried_from: Option<&HashMap<String, String>>,
        diarizer: Option<&str>,
        audit_details: Option<serde_json::Value>,
    ) -> Result<bool> {
        let segments_json = serde_json::to_string(segments)?;
        let full_text = segments
            .iter()
            .map(|segment| segment.text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let tx = self.conn.transaction()?;
        let preserve_measured_word_timestamps = tx
            .query_row(
                "SELECT segments, measured_word_timestamps
                 FROM transcripts
                 WHERE recording_id = ?1 AND revision = ?2",
                params![recording_id, expected_revision],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0)),
            )
            .optional()?
            .is_some_and(|(stored_json, measured)| {
                if !measured {
                    return false;
                }
                let Ok(stored) = serde_json::from_str::<Vec<TranscriptSegment>>(&stored_json)
                else {
                    return false;
                };
                stored.len() == segments.len()
                    && stored.iter().zip(segments).all(|(before, after)| {
                        before.id == after.id
                            && before.text == after.text
                            && before.start_time == after.start_time
                            && before.end_time == after.end_time
                    })
            });
        let updated = tx.execute(
            "UPDATE transcripts
             SET segments = ?1, full_text = ?2, revision = revision + 1, diarizer = ?5,
                 measured_word_timestamps = ?6
             WHERE recording_id = ?3 AND revision = ?4",
            params![
                segments_json,
                full_text,
                recording_id,
                expected_revision,
                diarizer,
                if preserve_measured_word_timestamps {
                    1
                } else {
                    0
                }
            ],
        )?;
        if updated == 0 {
            return Ok(false);
        }
        Self::invalidate_analysis_provenance_transaction(&tx, recording_id)?;
        Self::invalidate_transcript_embeddings_transaction(&tx, recording_id)?;
        Self::rebuild_transcript_fts_transaction(&tx, recording_id, segments)?;
        match relabel_carried_from {
            None => {
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
            }
            Some(carried_from) => {
                Self::replace_speaker_aliases_transaction(&tx, recording_id, aliases, carried_from)?
            }
        }
        if let Some(details) = audit_details {
            Self::log_audit_event_on(&tx, "meeting_diarization_applied", Some(details), "info")?;
        }
        tx.commit()?;
        Ok(true)
    }

    /// The diarizer recorded against this recording's transcript, if any has
    /// run. Read separately from `get_transcript` so the transcript model
    /// itself does not grow a field forty-odd construction sites would have to
    /// spell out.
    pub fn get_transcript_diarizer(&self, recording_id: &str) -> Result<Option<String>> {
        let mut statement = self
            .conn
            .prepare("SELECT diarizer FROM transcripts WHERE recording_id = ?1")?;
        let mut rows = statement.query(params![recording_id])?;
        match rows.next()? {
            Some(row) => Ok(row
                .get::<_, Option<String>>(0)?
                .filter(|value| !value.trim().is_empty())),
            None => Ok(None),
        }
    }

    /// Rewrite every alias row of one recording after a relabel. See
    /// [`Self::apply_relabelled_diarization`].
    fn replace_speaker_aliases_transaction(
        tx: &rusqlite::Transaction<'_>,
        recording_id: &str,
        aliases: &[SpeakerAliasUpsert],
        carried_from: &HashMap<String, String>,
    ) -> Result<()> {
        type VoiceColumns = (
            Option<Vec<u8>>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        let mut before: HashMap<String, VoiceColumns> = HashMap::new();
        {
            let mut statement = tx.prepare(
                "SELECT speaker_id, voice_centroid, voice_centroid_model_id,
                        voice_profile_id, voice_match_state, voice_rejected_profiles
                 FROM speaker_aliases WHERE recording_id = ?1",
            )?;
            let rows = statement.query_map(params![recording_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (
                        row.get::<_, Option<Vec<u8>>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ),
                ))
            })?;
            for row in rows {
                let (speaker_id, voice) = row?;
                before.insert(speaker_id, voice);
            }
        }
        tx.execute(
            "DELETE FROM speaker_aliases WHERE recording_id = ?1",
            params![recording_id],
        )?;
        let now = Utc::now().to_rfc3339();
        for alias in aliases {
            let (centroid, centroid_model, profile, match_state, rejected) = carried_from
                .get(&alias.speaker_id)
                .and_then(|old_id| before.get(old_id))
                .cloned()
                .unwrap_or_default();
            tx.execute(
                "INSERT INTO speaker_aliases (
                     recording_id, speaker_id, name, color, sample_count, updated_at,
                     voice_centroid, voice_centroid_model_id, voice_profile_id,
                     voice_match_state, voice_rejected_profiles
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(recording_id, speaker_id) DO UPDATE SET
                     name = excluded.name,
                     color = excluded.color,
                     sample_count = excluded.sample_count,
                     updated_at = excluded.updated_at,
                     voice_centroid = excluded.voice_centroid,
                     voice_centroid_model_id = excluded.voice_centroid_model_id,
                     voice_profile_id = excluded.voice_profile_id,
                     voice_match_state = excluded.voice_match_state,
                     voice_rejected_profiles = excluded.voice_rejected_profiles",
                params![
                    recording_id,
                    alias.speaker_id,
                    alias.name,
                    alias.color,
                    alias.sample_count,
                    now,
                    centroid,
                    centroid_model,
                    profile,
                    match_state,
                    rejected
                ],
            )?;
        }
        Ok(())
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

        let tx = self.conn.transaction()?;
        Self::upsert_speaker_alias_transaction(
            &tx,
            recording_id,
            speaker_id,
            Some(new_name),
            None,
            0,
            false,
        )?;
        // A hand-typed name settles the question the voice link was asking.
        // Leaving `voice_profile_id` and `voice_match_state` behind would keep
        // the transcript saying "auto" over a name a human just chose, and
        // would keep the cluster pointed at a remembered voice the rename was
        // most likely correcting. `remember_speaker_voice` renames first and
        // writes `confirmed` after, so the confirm path is unaffected.
        tx.execute(
            "UPDATE speaker_aliases
             SET voice_profile_id = NULL, voice_match_state = NULL
             WHERE recording_id = ?1 AND speaker_id = ?2",
            params![recording_id, speaker_id],
        )?;
        tx.commit()?;
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

    // ── Voiceprints (opt-in, local only) ─────────────────────────────────
    //
    // Nothing in this block runs unless `meetings.rememberVoices` is on: the
    // callers in lib.rs read the setting first, and the gating test
    // `voiceprint_storage_is_untouched_while_the_setting_is_off` proves the
    // rows stay empty when it is off.

    /// Record one speaker cluster's voice signature against its alias row.
    ///
    /// Overwrites rather than accumulates: a cluster has exactly one current
    /// signature, and re-running speaker identification replaces it.
    pub fn set_cluster_voice_signature(
        &mut self,
        recording_id: &str,
        speaker_id: &str,
        centroid: &[f32],
        embedding_model_id: &str,
    ) -> Result<()> {
        if !voiceprints::is_usable_embedding(centroid) {
            anyhow::bail!("Refusing to store an unusable voice signature");
        }
        let blob = f32_slice_to_blob(centroid);
        self.conn.execute(
            "INSERT INTO speaker_aliases (
                 recording_id, speaker_id, updated_at,
                 voice_centroid, voice_centroid_model_id
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(recording_id, speaker_id) DO UPDATE SET
                 voice_centroid = excluded.voice_centroid,
                 voice_centroid_model_id = excluded.voice_centroid_model_id,
                 updated_at = excluded.updated_at",
            params![
                recording_id,
                speaker_id,
                Utc::now().to_rfc3339(),
                blob,
                embedding_model_id
            ],
        )?;
        Ok(())
    }

    /// Clear every stored voice signature of one recording. Called on any
    /// re-diarization, whichever model ran: the new run's speaker ids may
    /// cover other stretches of audio than the old ones, so even a signature
    /// from the same model no longer describes the speaker it sits under, and
    /// left in place it could outrank the new run's centroid when matching.
    /// Names, the remembered-voice link and the "Not them" list stay; the
    /// caller writes the new run's signatures afterwards. Returns how many
    /// were cleared.
    pub fn clear_cluster_voice_signatures(&mut self, recording_id: &str) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE speaker_aliases
             SET voice_centroid = NULL, voice_centroid_model_id = NULL, updated_at = ?2
             WHERE recording_id = ?1 AND voice_centroid IS NOT NULL",
            params![recording_id, Utc::now().to_rfc3339()],
        )?)
    }

    /// Persist one cluster's voice signature, at the moment that cluster is
    /// given a name — and only when the user turned remembering on.
    ///
    /// This is the *only* path that writes a signature, and it is deliberately
    /// per-cluster. Settings and `docs/beta/PRIVACY-AND-CLOUD.md` both say a
    /// signature is written for a speaker you name, or one Plainsong offers to
    /// name and you confirm; storing one for every cluster a meeting happened
    /// to contain would be a larger privacy surface than the one the reader
    /// agreed to. Unnamed clusters' centroids stay in
    /// [`crate::diarization::voiceprints::SessionClusterVoices`] instead, in
    /// memory, for as long as the app is open.
    ///
    /// The switch is a parameter rather than a settings lookup so that
    /// "nothing is written while it is off" is a property a test can prove
    /// against a real database, without a settings file or a running app.
    /// Returns whether a signature was written.
    ///
    /// Best effort: a signature that could not be stored costs a suggestion,
    /// not the meeting, so an unusable vector is logged rather than raised.
    pub fn record_named_cluster_voice_signature(
        &mut self,
        recording_id: &str,
        speaker_id: &str,
        centroid: &[f32],
        embedding_model_id: &str,
        remember_voices: bool,
    ) -> Result<bool> {
        if !remember_voices {
            return Ok(false);
        }
        match self.set_cluster_voice_signature(
            recording_id,
            speaker_id,
            centroid,
            embedding_model_id,
        ) {
            Ok(()) => Ok(true),
            Err(error) => {
                tracing::warn!(
                    "Could not store the voice signature for speaker {} of {}: {}",
                    speaker_id,
                    recording_id,
                    error
                );
                Ok(false)
            }
        }
    }

    /// Every speaker cluster in one recording that carries a voice signature.
    pub fn get_cluster_voice_signatures(
        &self,
        recording_id: &str,
    ) -> Result<Vec<ClusterVoiceSignature>> {
        let mut stmt = self.conn.prepare(
            "SELECT speaker_id, name, voice_centroid, voice_centroid_model_id,
                    voice_profile_id, voice_match_state, voice_rejected_profiles
             FROM speaker_aliases
             WHERE recording_id = ?1 AND voice_centroid IS NOT NULL
             ORDER BY speaker_id",
        )?;
        let rows = stmt.query_map(params![recording_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })?;

        let mut signatures = Vec::new();
        for row in rows {
            let (speaker_id, name, blob, model_id, profile_id, match_state, rejected) = row?;
            let Some(embedding_model_id) = model_id else {
                continue;
            };
            signatures.push(ClusterVoiceSignature {
                speaker_id,
                name,
                centroid: blob_to_f32_vec(&blob),
                embedding_model_id,
                applied_profile_id: profile_id,
                match_state,
                rejected_profile_ids: rejected
                    .as_deref()
                    .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok())
                    .unwrap_or_default(),
            });
        }
        Ok(signatures)
    }

    /// Attach a remembered voice to a cluster. `state` is `"auto"` while the
    /// app applied it on its own and `"confirmed"` once a human said so.
    pub fn set_cluster_voice_match(
        &mut self,
        recording_id: &str,
        speaker_id: &str,
        profile_id: &str,
        state: &str,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE speaker_aliases
             SET voice_profile_id = ?3, voice_match_state = ?4, updated_at = ?5
             WHERE recording_id = ?1 AND speaker_id = ?2",
            params![
                recording_id,
                speaker_id,
                profile_id,
                state,
                Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    /// Remember that the reader said "Not them" about one profile, so the same
    /// wrong suggestion does not come back on every visit.
    pub fn reject_cluster_voice_match(
        &mut self,
        recording_id: &str,
        speaker_id: &str,
        profile_id: &str,
    ) -> Result<()> {
        let existing: Option<String> = self
            .conn
            .query_row(
                "SELECT voice_rejected_profiles FROM speaker_aliases
                 WHERE recording_id = ?1 AND speaker_id = ?2",
                params![recording_id, speaker_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let mut rejected: Vec<String> = existing
            .as_deref()
            .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok())
            .unwrap_or_default();
        if !rejected.iter().any(|id| id == profile_id) {
            rejected.push(profile_id.to_string());
        }
        let encoded = serde_json::to_string(&rejected)?;
        // An upsert, not an update: a cluster nobody has named has no alias
        // row, and since signatures are only written for named clusters that
        // is the common case for "Not them". Dropping the rejection on the
        // floor would bring the same wrong suggestion back on every visit.
        self.conn.execute(
            "INSERT INTO speaker_aliases (
                 recording_id, speaker_id, updated_at, voice_rejected_profiles
             ) VALUES (?1, ?2, ?5, ?3)
             ON CONFLICT(recording_id, speaker_id) DO UPDATE SET
                 voice_rejected_profiles = excluded.voice_rejected_profiles,
                 voice_profile_id = CASE
                     WHEN speaker_aliases.voice_profile_id = ?4 THEN NULL
                     ELSE speaker_aliases.voice_profile_id END,
                 voice_match_state = CASE
                     WHEN speaker_aliases.voice_profile_id = ?4 THEN NULL
                     ELSE speaker_aliases.voice_match_state END,
                 updated_at = excluded.updated_at",
            params![
                recording_id,
                speaker_id,
                encoded,
                profile_id,
                Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    /// Every "Not them" this recording carries, keyed by speaker id.
    ///
    /// Read separately from [`Self::get_cluster_voice_signatures`] because a
    /// rejection outlives the row that prompted it: an unnamed cluster has a
    /// rejection but no signature, and its centroid is only in memory.
    pub fn get_cluster_voice_rejections(
        &self,
        recording_id: &str,
    ) -> Result<HashMap<String, Vec<String>>> {
        let mut stmt = self.conn.prepare(
            "SELECT speaker_id, voice_rejected_profiles
             FROM speaker_aliases
             WHERE recording_id = ?1 AND voice_rejected_profiles IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![recording_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;
        let mut rejections = HashMap::new();
        for row in rows {
            let (speaker_id, raw) = row?;
            let parsed: Vec<String> = raw
                .as_deref()
                .and_then(|value| serde_json::from_str(value).ok())
                .unwrap_or_default();
            if !parsed.is_empty() {
                rejections.insert(speaker_id, parsed);
            }
        }
        Ok(rejections)
    }

    /// The alias name on each cluster of one recording, for callers that need
    /// to tell a named cluster from an unnamed one.
    pub fn get_cluster_alias_names(&self, recording_id: &str) -> Result<HashMap<String, String>> {
        let mut stmt = self.conn.prepare(
            "SELECT speaker_id, name FROM speaker_aliases
             WHERE recording_id = ?1 AND name IS NOT NULL AND TRIM(name) != ''",
        )?;
        let rows = stmt.query_map(params![recording_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<HashMap<_, _>, _>>()
            .map_err(|e| e.into())
    }

    /// Every remembered voice, newest name first.
    pub fn list_speaker_profiles(&self) -> Result<Vec<StoredVoiceProfile>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, display_name, linked_identity_hash, embedding_model_id,
                    centroid, sample_count, created_at, updated_at
             FROM speaker_profiles
             ORDER BY display_name COLLATE NOCASE, id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(StoredVoiceProfile {
                id: row.get(0)?,
                display_name: row.get(1)?,
                linked_identity_hash: row.get(2)?,
                embedding_model_id: row.get(3)?,
                centroid: blob_to_f32_vec(&row.get::<_, Vec<u8>>(4)?),
                sample_count: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
    }

    /// Remember a voice, or fold a new sample into the one already stored
    /// under this name and embedder.
    ///
    /// Names are matched case-insensitively so "dana" and "Dana" do not become
    /// two profiles for one person, but a name remembered under a *different*
    /// embedder gets its own profile: the two centroids live in unrelated
    /// spaces and averaging them would produce a vector describing nobody.
    pub fn remember_speaker_voice(
        &mut self,
        display_name: &str,
        embedding_model_id: &str,
        centroid: &[f32],
        source_recording_id: Option<&str>,
        linked_identity_hash: Option<&str>,
    ) -> Result<String> {
        self.remember_voice_from(
            display_name,
            embedding_model_id,
            centroid,
            source_recording_id,
            None,
            linked_identity_hash,
        )
    }

    /// [`Self::remember_speaker_voice`] for a sample that one speaker of one
    /// meeting contributed, recorded so a later correction can withdraw it.
    pub fn remember_cluster_voice(
        &mut self,
        display_name: &str,
        embedding_model_id: &str,
        centroid: &[f32],
        recording_id: &str,
        speaker_id: &str,
    ) -> Result<String> {
        self.remember_voice_from(
            display_name,
            embedding_model_id,
            centroid,
            Some(recording_id),
            Some(speaker_id),
            None,
        )
    }

    fn remember_voice_from(
        &mut self,
        display_name: &str,
        embedding_model_id: &str,
        centroid: &[f32],
        source_recording_id: Option<&str>,
        source_speaker_id: Option<&str>,
        linked_identity_hash: Option<&str>,
    ) -> Result<String> {
        let display_name = display_name.trim();
        if display_name.is_empty() {
            anyhow::bail!("A remembered voice needs a name");
        }
        if !voiceprints::is_usable_embedding(centroid) {
            anyhow::bail!("Refusing to remember an unusable voice signature");
        }
        let existing: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM speaker_profiles
                 WHERE display_name = ?1 COLLATE NOCASE AND embedding_model_id = ?2",
                params![display_name, embedding_model_id],
                |row| row.get(0),
            )
            .optional()?;

        let profile_id = match existing {
            Some(id) => id,
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                let now = Utc::now().to_rfc3339();
                self.conn.execute(
                    "INSERT INTO speaker_profiles (
                         id, display_name, linked_identity_hash, embedding_model_id,
                         centroid, sample_count, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)",
                    params![
                        id,
                        display_name,
                        linked_identity_hash,
                        embedding_model_id,
                        f32_slice_to_blob(centroid),
                        now
                    ],
                )?;
                id
            }
        };

        self.insert_speaker_profile_sample(
            &profile_id,
            centroid,
            source_recording_id,
            source_speaker_id,
        )?;
        Ok(profile_id)
    }

    /// Append one sample to a profile, prune to the cap, and recompute the
    /// centroid from what is left.
    pub fn add_speaker_profile_sample(
        &mut self,
        profile_id: &str,
        embedding: &[f32],
        source_recording_id: Option<&str>,
    ) -> Result<()> {
        self.insert_speaker_profile_sample(profile_id, embedding, source_recording_id, None)
    }

    /// [`Self::add_speaker_profile_sample`] for a sample that one speaker of
    /// one meeting contributed by being confirmed as this voice.
    pub fn add_cluster_voice_sample(
        &mut self,
        profile_id: &str,
        embedding: &[f32],
        recording_id: &str,
        speaker_id: &str,
    ) -> Result<()> {
        self.insert_speaker_profile_sample(
            profile_id,
            embedding,
            Some(recording_id),
            Some(speaker_id),
        )
    }

    fn insert_speaker_profile_sample(
        &mut self,
        profile_id: &str,
        embedding: &[f32],
        source_recording_id: Option<&str>,
        source_speaker_id: Option<&str>,
    ) -> Result<()> {
        if !voiceprints::is_usable_embedding(embedding) {
            anyhow::bail!("Refusing to store an unusable voice sample");
        }
        let tx = self.conn.transaction()?;
        let exists: i64 = tx.query_row(
            "SELECT COUNT(*) FROM speaker_profiles WHERE id = ?1",
            params![profile_id],
            |row| row.get(0),
        )?;
        if exists == 0 {
            anyhow::bail!("Remembered voice '{}' was not found", profile_id);
        }
        tx.execute(
            "INSERT INTO speaker_profile_samples (
                 id, profile_id, embedding, source_recording_id, source_speaker_id, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                uuid::Uuid::new_v4().to_string(),
                profile_id,
                f32_slice_to_blob(embedding),
                source_recording_id,
                source_speaker_id,
                Utc::now().to_rfc3339()
            ],
        )?;
        // Oldest first out. `rowid` breaks ties so two samples written inside
        // the same RFC 3339 second still have a deterministic order.
        tx.execute(
            "DELETE FROM speaker_profile_samples
             WHERE profile_id = ?1
               AND rowid NOT IN (
                   SELECT rowid FROM speaker_profile_samples
                   WHERE profile_id = ?1
                   ORDER BY created_at DESC, rowid DESC
                   LIMIT ?2
               )",
            params![profile_id, voiceprints::MAX_SAMPLES_PER_PROFILE as i64],
        )?;

        let samples: Vec<Vec<f32>> = {
            let mut stmt =
                tx.prepare("SELECT embedding FROM speaker_profile_samples WHERE profile_id = ?1")?;
            let rows = stmt.query_map(params![profile_id], |row| {
                Ok(blob_to_f32_vec(&row.get::<_, Vec<u8>>(0)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let centroid = voiceprints::centroid_of(&samples)
            .ok_or_else(|| anyhow::anyhow!("Voice samples did not produce a usable centroid"))?;
        tx.execute(
            "UPDATE speaker_profiles
             SET centroid = ?2, sample_count = ?3, updated_at = ?4
             WHERE id = ?1",
            params![
                profile_id,
                f32_slice_to_blob(&centroid),
                samples.len() as i64,
                Utc::now().to_rfc3339()
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Forget one voice: the profile, its samples, and every cluster this Mac
    /// had attached to it.
    pub fn forget_speaker_voice(&mut self, profile_id: &str) -> Result<bool> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "DELETE FROM speaker_profile_samples WHERE profile_id = ?1",
            params![profile_id],
        )?;
        let removed = tx.execute(
            "DELETE FROM speaker_profiles WHERE id = ?1",
            params![profile_id],
        )?;
        tx.execute(
            "UPDATE speaker_aliases
             SET voice_profile_id = NULL, voice_match_state = NULL
             WHERE voice_profile_id = ?1",
            params![profile_id],
        )?;
        tx.commit()?;
        Ok(removed > 0)
    }

    /// Forget every voice, and every cluster signature that was kept so a
    /// voice could be recognized again. Returns how many voices were removed.
    pub fn forget_all_speaker_voices(&mut self) -> Result<usize> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM speaker_profile_samples", [])?;
        let removed = tx.execute("DELETE FROM speaker_profiles", [])?;
        // The per-cluster signatures are voice data too. "Delete all" that
        // left them behind would be a lie by omission.
        tx.execute(
            "UPDATE speaker_aliases
             SET voice_centroid = NULL, voice_centroid_model_id = NULL,
                 voice_profile_id = NULL, voice_match_state = NULL,
                 voice_rejected_profiles = NULL",
            [],
        )?;
        tx.commit()?;
        Ok(removed)
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
        Self::rebuild_transcript_fts_transaction(&tx, recording_id, &[])?;
        tx.execute(
            "DELETE FROM dictation_history_text WHERE recording_id = ?1",
            params![recording_id],
        )?;
        if table_exists(&tx, "dictation_history_fts")? {
            tx.execute(
                "DELETE FROM dictation_history_fts WHERE recording_id = ?1",
                params![recording_id],
            )?;
        }
        tx.execute(
            "DELETE FROM meeting_artifacts WHERE recording_id = ?1",
            params![recording_id],
        )?;
        tx.execute(
            "DELETE FROM summary_regeneration_undo WHERE recording_id = ?1",
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
        Self::remove_recording_voice_samples_transaction(&tx, recording_id)?;
        tx.execute(
            "DELETE FROM recordings WHERE id = ?1",
            params![recording_id],
        )?;
        tx.commit()?;

        Ok(audio_path)
    }

    /// Remembered voices learned from a deleted meeting: drop the samples it
    /// contributed and recompute each affected voice from what is left. A
    /// voice that only this meeting taught is forgotten with it, so deleting
    /// a meeting leaves no voice data behind.
    fn remove_recording_voice_samples_transaction(
        tx: &rusqlite::Transaction<'_>,
        recording_id: &str,
    ) -> Result<()> {
        let affected: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT DISTINCT profile_id FROM speaker_profile_samples
                 WHERE source_recording_id = ?1",
            )?;
            let rows = stmt.query_map(params![recording_id], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        if affected.is_empty() {
            return Ok(());
        }
        tx.execute(
            "DELETE FROM speaker_profile_samples WHERE source_recording_id = ?1",
            params![recording_id],
        )?;
        Self::recompute_speaker_profiles_transaction(tx, affected)
    }

    /// Recompute each listed voice from the samples it has left, and forget a
    /// voice that has none: a voice taught only by withdrawn samples leaves no
    /// voice data behind.
    fn recompute_speaker_profiles_transaction(
        tx: &rusqlite::Transaction<'_>,
        profile_ids: Vec<String>,
    ) -> Result<()> {
        for profile_id in profile_ids {
            let samples: Vec<Vec<f32>> = {
                let mut stmt = tx.prepare(
                    "SELECT embedding FROM speaker_profile_samples WHERE profile_id = ?1",
                )?;
                let rows = stmt.query_map(params![&profile_id], |row| {
                    Ok(blob_to_f32_vec(&row.get::<_, Vec<u8>>(0)?))
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            match voiceprints::centroid_of(&samples) {
                Some(centroid) => {
                    tx.execute(
                        "UPDATE speaker_profiles
                         SET centroid = ?2, sample_count = ?3, updated_at = ?4
                         WHERE id = ?1",
                        params![
                            &profile_id,
                            f32_slice_to_blob(&centroid),
                            samples.len() as i64,
                            Utc::now().to_rfc3339()
                        ],
                    )?;
                }
                None => {
                    tx.execute(
                        "DELETE FROM speaker_profile_samples WHERE profile_id = ?1",
                        params![&profile_id],
                    )?;
                    tx.execute(
                        "DELETE FROM speaker_profiles WHERE id = ?1",
                        params![&profile_id],
                    )?;
                    tx.execute(
                        "UPDATE speaker_aliases
                         SET voice_profile_id = NULL, voice_match_state = NULL
                         WHERE voice_profile_id = ?1",
                        params![&profile_id],
                    )?;
                }
            }
        }
        Ok(())
    }

    /// Withdraw the remembered-voice samples that one speaker of one meeting
    /// contributed by being confirmed as a voice, and recompute each voice they
    /// were part of. Called when that speaker's identity is corrected: the
    /// confirmation was wrong, so the sample it added describes someone else
    /// and would keep pulling that voice toward them.
    ///
    /// `keep_name` keeps samples of a voice with that name (case-insensitive),
    /// so a rename that keeps the confirmed name is not treated as a
    /// correction. `only_profile` limits the withdrawal to one voice, as "Not
    /// them" does.
    ///
    /// Samples from before samples recorded their speaker are matched through
    /// the speaker's alias row instead: the confirmed voice it points at, from
    /// this meeting, with exactly the signature stored for that speaker.
    ///
    /// Returns how many samples were withdrawn.
    pub fn retract_cluster_voice_samples(
        &mut self,
        recording_id: &str,
        speaker_id: &str,
        keep_name: Option<&str>,
        only_profile: Option<&str>,
    ) -> Result<usize> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        // The confirmed voice and stored signature on the alias row, if any.
        let legacy_match: Option<(String, Vec<u8>)> = tx
            .query_row(
                "SELECT voice_profile_id, voice_centroid
                 FROM speaker_aliases
                 WHERE recording_id = ?1 AND speaker_id = ?2 AND voice_match_state = ?3",
                params![recording_id, speaker_id, voiceprints::MATCH_STATE_CONFIRMED],
                |row| {
                    Ok(row
                        .get::<_, Option<String>>(0)?
                        .zip(row.get::<_, Option<Vec<u8>>>(1)?))
                },
            )
            .optional()?
            .flatten();
        let keep_name = keep_name.map(str::trim).map(str::to_lowercase);

        struct Candidate {
            sample_id: String,
            profile_id: String,
            display_name: String,
            source_speaker_id: Option<String>,
            embedding: Vec<u8>,
        }
        let candidates: Vec<Candidate> = {
            let mut stmt = tx.prepare(
                "SELECT s.id, s.profile_id, p.display_name, s.source_speaker_id, s.embedding
                 FROM speaker_profile_samples s
                 JOIN speaker_profiles p ON p.id = s.profile_id
                 WHERE s.source_recording_id = ?1
                   AND (s.source_speaker_id = ?2 OR s.source_speaker_id IS NULL)",
            )?;
            let rows = stmt.query_map(params![recording_id, speaker_id], |row| {
                Ok(Candidate {
                    sample_id: row.get(0)?,
                    profile_id: row.get(1)?,
                    display_name: row.get(2)?,
                    source_speaker_id: row.get(3)?,
                    embedding: row.get(4)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut withdrawn = Vec::new();
        let mut affected = Vec::new();
        for Candidate {
            sample_id,
            profile_id,
            display_name,
            source_speaker_id,
            embedding,
        } in candidates
        {
            let from_this_speaker = match source_speaker_id {
                Some(_) => true,
                None => legacy_match.as_ref().is_some_and(|(confirmed, centroid)| {
                    *confirmed == profile_id && *centroid == embedding
                }),
            };
            if !from_this_speaker
                || only_profile.is_some_and(|only| only != profile_id)
                || keep_name
                    .as_deref()
                    .is_some_and(|keep| display_name.trim().to_lowercase() == keep)
            {
                continue;
            }
            withdrawn.push(sample_id);
            if !affected.contains(&profile_id) {
                affected.push(profile_id);
            }
        }
        for sample_id in &withdrawn {
            tx.execute(
                "DELETE FROM speaker_profile_samples WHERE id = ?1",
                params![sample_id],
            )?;
        }
        Self::recompute_speaker_profiles_transaction(&tx, affected)?;
        tx.commit()?;
        Ok(withdrawn.len())
    }

    /// Rename a recording
    pub fn rename_recording(&mut self, recording_id: &str, new_title: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        let updated_at = Utc::now().to_rfc3339();
        tx.execute(
            "UPDATE recordings SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_title, updated_at, recording_id],
        )?;
        tx.execute(
            "UPDATE meeting_artifacts SET title = ?1, updated_at = ?2 WHERE recording_id = ?3",
            params![new_title, updated_at, recording_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn rename_recording_if_title_matches(
        &mut self,
        recording_id: &str,
        expected_title: &str,
        new_title: &str,
    ) -> Result<bool> {
        let tx = self.conn.transaction()?;
        let updated_at = Utc::now().to_rfc3339();
        let changed = tx.execute(
            "UPDATE recordings SET title = ?1, updated_at = ?2 WHERE id = ?3 AND title = ?4",
            params![new_title, updated_at, recording_id, expected_title],
        )?;
        if changed == 0 {
            return Ok(false);
        }
        tx.execute(
            "UPDATE meeting_artifacts SET title = ?1, updated_at = ?2 WHERE recording_id = ?3",
            params![new_title, updated_at, recording_id],
        )?;
        tx.commit()?;
        Ok(true)
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

    pub fn get_dictation_edit(&self, recording_id: &str) -> Result<Option<String>> {
        let recording = self.conn.query_row(
            "SELECT source_type, dictation_corrected_text FROM recordings WHERE id = ?1",
            params![recording_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        );
        let (source_type, corrected_text) = match recording {
            Ok(recording) => recording,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                anyhow::bail!("Recording '{}' was not found", recording_id)
            }
            Err(error) => return Err(error.into()),
        };
        if source_type != "dictation" {
            anyhow::bail!("Recording '{}' is not a dictation", recording_id);
        }
        Ok(corrected_text)
    }

    pub fn save_dictation_edit(
        &mut self,
        recording_id: &str,
        text: Option<&str>,
        expected_text: Option<&str>,
    ) -> Result<Option<String>> {
        const MAX_DICTATION_EDIT_BYTES: usize = 1024 * 1024;
        if text.is_some_and(|text| text.len() > MAX_DICTATION_EDIT_BYTES) {
            anyhow::bail!("Dictation edit exceeds the 1 MiB limit");
        }

        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let recording = tx.query_row(
            "SELECT source_type, dictation_corrected_text FROM recordings WHERE id = ?1",
            params![recording_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        );
        let (source_type, stored_text) = match recording {
            Ok(recording) => recording,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                anyhow::bail!("Recording '{}' was not found", recording_id)
            }
            Err(error) => return Err(error.into()),
        };
        if source_type != "dictation" {
            anyhow::bail!("Recording '{}' is not a dictation", recording_id);
        }
        if stored_text.as_deref() == text {
            tx.commit()?;
            return Ok(stored_text);
        }
        if stored_text.as_deref() != expected_text {
            anyhow::bail!(
                "Dictation edit conflict for recording '{}': the saved text changed",
                recording_id
            );
        }

        tx.execute(
            "UPDATE recordings SET dictation_corrected_text = ?2 WHERE id = ?1",
            params![recording_id, text],
        )?;
        tx.commit()?;
        Ok(text.map(str::to_owned))
    }

    pub fn list_dictation_drafts(&self) -> Result<Vec<DictationDraft>> {
        let mut statement = self.conn.prepare(
            "SELECT id, title, dictation_draft_text, dictation_draft_base_edit
             FROM recordings
             WHERE source_type = 'dictation' AND dictation_draft_text IS NOT NULL
             ORDER BY dictation_draft_updated_at DESC, updated_at DESC, id DESC
             LIMIT 50",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(DictationDraft {
                recording_id: row.get(0)?,
                title: row.get(1)?,
                text: row.get(2)?,
                expected_saved_text: row.get(3)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn save_dictation_draft(
        &mut self,
        recording_id: &str,
        text: Option<&str>,
        expected_saved_text: Option<&str>,
    ) -> Result<()> {
        const MAX_DICTATION_DRAFT_BYTES: usize = 1024 * 1024;
        if text.is_some_and(|text| text.len() > MAX_DICTATION_DRAFT_BYTES) {
            anyhow::bail!("Dictation draft exceeds the 1 MiB limit");
        }

        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let source_type = tx
            .query_row(
                "SELECT source_type FROM recordings WHERE id = ?1",
                params![recording_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(source_type) = source_type else {
            anyhow::bail!("Recording '{}' was not found", recording_id);
        };
        if source_type != "dictation" {
            anyhow::bail!("Recording '{}' is not a dictation", recording_id);
        }

        tx.execute(
            "UPDATE recordings
             SET dictation_draft_text = ?2,
                 dictation_draft_base_edit = ?3,
                 dictation_draft_updated_at = ?4
             WHERE id = ?1",
            params![
                recording_id,
                text,
                if text.is_some() {
                    expected_saved_text
                } else {
                    None
                },
                text.map(|_| Utc::now().timestamp_millis()),
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn clear_dictation_draft(
        &mut self,
        recording_id: &str,
        expected_draft_text: &str,
    ) -> Result<bool> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let source_type = tx
            .query_row(
                "SELECT source_type FROM recordings WHERE id = ?1",
                params![recording_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(source_type) = source_type else {
            anyhow::bail!("Recording '{}' was not found", recording_id);
        };
        if source_type != "dictation" {
            anyhow::bail!("Recording '{}' is not a dictation", recording_id);
        }

        let cleared = tx.execute(
            "UPDATE recordings
             SET dictation_draft_text = NULL,
                 dictation_draft_base_edit = NULL,
                 dictation_draft_updated_at = NULL
             WHERE id = ?1 AND dictation_draft_text = ?2",
            params![recording_id, expected_draft_text],
        )? > 0;
        tx.commit()?;
        Ok(cleared)
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

    pub(crate) fn delete_embeddings_with_model(&self, model: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM transcript_embeddings WHERE model = ?1",
            [model],
        )?;
        Ok(())
    }

    /// Whether any recording is still being transcribed or labelled.
    pub(crate) fn any_recording_processing(&self) -> Result<bool> {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM recordings WHERE status = 'processing')",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    #[cfg(test)]
    pub(crate) fn recording_has_embeddings_with_model(
        &self,
        recording_id: &str,
        model: &str,
    ) -> Result<bool> {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM transcript_embeddings
                 WHERE recording_id = ?1 AND model = ?2)",
                params![recording_id, model],
                |row| row.get(0),
            )
            .map_err(Into::into)
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

    /// Recordings that have a transcript and no meaning-search rows under
    /// `model_key`, newest first. Recordings still being captured or
    /// transcribed are left for later.
    pub(crate) fn recordings_missing_semantic_index(
        &self,
        model_key: &str,
        limit: usize,
    ) -> Result<Vec<String>> {
        let mut statement = self.conn.prepare(
            "SELECT r.id FROM recordings r JOIN transcripts t ON t.recording_id = r.id
             WHERE r.status NOT IN ('recording', 'processing')
             AND NOT EXISTS (SELECT 1 FROM transcript_embeddings te
                 WHERE te.recording_id = r.id AND te.model = ?1)
             ORDER BY r.created_at DESC, r.id ASC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![model_key, limit as i64], |row| row.get(0))?;
        rows.collect::<std::result::Result<Vec<String>, _>>()
            .map_err(Into::into)
    }

    /// How many recordings with a transcript have meaning-search rows under
    /// `model_key`, and how many recordings with a transcript there are.
    pub(crate) fn semantic_index_coverage(&self, model_key: &str) -> Result<(i64, i64)> {
        self.conn
            .query_row(
                "SELECT
                    COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM transcript_embeddings te
                        WHERE te.recording_id = r.id AND te.model = ?1) THEN r.id END),
                    COUNT(DISTINCT r.id)
                 FROM recordings r JOIN transcripts t ON t.recording_id = r.id",
                [model_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(Into::into)
    }

    /// A hash of a recording's stored transcript text, rows and timings.
    /// Unlike the revision, which a re-transcription resets to 0, it changes
    /// whenever the words, rows, speakers or times do.
    fn transcript_fingerprint_with(
        conn: &rusqlite::Connection,
        recording_id: &str,
    ) -> Result<Option<String>> {
        use sha2::{Digest, Sha256};
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT t.segments, t.full_text FROM transcripts t
                 JOIN recordings r ON r.id = t.recording_id WHERE t.recording_id = ?1",
                [recording_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        Ok(row.map(|(segments, full_text)| {
            let mut hash = Sha256::new();
            hash.update(segments.as_bytes());
            hash.update([0u8]);
            hash.update(full_text.as_bytes());
            hex::encode(hash.finalize())
        }))
    }

    pub(crate) fn transcript_fingerprint(&self, recording_id: &str) -> Result<Option<String>> {
        Self::transcript_fingerprint_with(&self.conn, recording_id)
    }

    /// The windows stored under `model_key` for one recording, in transcript
    /// order.
    pub(crate) fn semantic_index_windows(
        &self,
        recording_id: &str,
        model_key: &str,
    ) -> Result<Vec<crate::llm::GroundedSegment>> {
        let mut statement = self.conn.prepare(
            "SELECT segment_id, text, start_time, end_time FROM transcript_embeddings
             WHERE recording_id = ?1 AND model = ?2 ORDER BY id ASC",
        )?;
        let rows = statement.query_map(params![recording_id, model_key], |row| {
            Ok(crate::llm::GroundedSegment {
                recording_id: recording_id.to_string(),
                segment_id: row.get(0)?,
                text: row.get(1)?,
                start_time: row.get::<_, Option<f64>>(2)?.unwrap_or(f64::NAN),
                end_time: row.get::<_, Option<f64>>(3)?.unwrap_or(f64::NAN),
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    /// Replace one recording's meaning-search rows, but only while its
    /// transcript still hashes to `expected_fingerprint`. Returns false,
    /// changing nothing, when the transcript changed or the recording is gone:
    /// the vectors describe text that no longer exists.
    pub(crate) fn replace_recording_embeddings(
        &mut self,
        recording_id: &str,
        expected_fingerprint: &str,
        model_key: &str,
        rows: &[(crate::llm::GroundedSegment, Vec<f32>)],
    ) -> Result<bool> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let fingerprint = Self::transcript_fingerprint_with(&tx, recording_id)?;
        if fingerprint.as_deref() != Some(expected_fingerprint) {
            return Ok(false);
        }
        let dimensions = rows.first().map(|(_, vector)| vector.len());
        for (window, vector) in rows {
            if window.recording_id != recording_id
                || vector.is_empty()
                || Some(vector.len()) != dimensions
                || vector.len() > MAX_EMBEDDING_DIMENSIONS
                || vector.iter().any(|value| !value.is_finite())
            {
                anyhow::bail!("Invalid embedding vector");
            }
        }
        tx.execute(
            "DELETE FROM transcript_embeddings WHERE recording_id = ?1",
            [recording_id],
        )?;
        let now = Utc::now().to_rfc3339();
        {
            let mut insert = tx.prepare(
                "INSERT INTO transcript_embeddings
                 (recording_id, segment_id, text, embedding, model, start_time, end_time, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for (window, vector) in rows {
                let blob: Vec<u8> = vector
                    .iter()
                    .flat_map(|value| value.to_le_bytes())
                    .collect();
                insert.execute(params![
                    recording_id,
                    window.segment_id,
                    window.text,
                    blob,
                    model_key,
                    window.start_time,
                    window.end_time,
                    now
                ])?;
            }
        }
        tx.commit()?;
        Ok(true)
    }

    pub fn begin_embedding_rebuild(&self) -> Result<String> {
        self.conn.execute_batch("CREATE TABLE IF NOT EXISTS embedding_rebuild_stage (
            run_id TEXT NOT NULL, recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
            segment_id TEXT NOT NULL, text TEXT NOT NULL, embedding BLOB NOT NULL,
            model TEXT NOT NULL, start_time REAL NOT NULL, end_time REAL NOT NULL,
            created_at TEXT NOT NULL);
            DELETE FROM embedding_rebuild_stage;")?;
        embedding_source_signature(&self.conn)
    }

    pub fn embedding_sources_unchanged(&self, signature: &str) -> Result<bool> {
        Ok(embedding_source_signature(&self.conn)? == signature)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn stage_embedding(
        &self,
        run_id: &str,
        recording_id: &str,
        segment_id: &str,
        text: &str,
        embedding: &[f32],
        model: &str,
        start_time: f64,
        end_time: f64,
    ) -> Result<()> {
        if embedding.is_empty() || embedding.iter().any(|value| !value.is_finite()) {
            anyhow::bail!("Invalid embedding vector");
        }
        let blob: Vec<u8> = embedding
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        self.conn.execute("INSERT INTO embedding_rebuild_stage
            (run_id, recording_id, segment_id, text, embedding, model, start_time, end_time, created_at)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![run_id,recording_id,segment_id,text,blob,model,start_time,end_time,Utc::now().to_rfc3339()])?;
        Ok(())
    }

    pub fn discard_embedding_rebuild(&self, run_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM embedding_rebuild_stage WHERE run_id=?1",
            [run_id],
        )?;
        Ok(())
    }

    pub fn commit_embedding_rebuild(
        &mut self,
        run_id: &str,
        expected_source: &str,
        expected_count: usize,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if embedding_source_signature(&tx)? != expected_source {
            anyhow::bail!(
                "Meetings changed during indexing. The existing search index was kept. Try again."
            );
        }
        let (count, dimensions): (i64,i64) = tx.query_row(
            "SELECT COUNT(*),COUNT(DISTINCT length(embedding)) FROM embedding_rebuild_stage WHERE run_id=?1", [run_id], |row|Ok((row.get(0)?,row.get(1)?)))?;
        if usize::try_from(count).ok() != Some(expected_count) || dimensions > 1 {
            anyhow::bail!("Replacement embeddings are incomplete or inconsistent. The existing search index was kept.");
        }
        tx.execute("DELETE FROM transcript_embeddings", [])?;
        tx.execute("INSERT INTO transcript_embeddings (recording_id,segment_id,text,embedding,model,start_time,end_time,created_at)
            SELECT recording_id,segment_id,text,embedding,model,start_time,end_time,created_at
            FROM embedding_rebuild_stage WHERE run_id=?1", [run_id])?;
        tx.execute(
            "DELETE FROM embedding_rebuild_stage WHERE run_id=?1",
            [run_id],
        )?;
        tx.commit()?;
        Ok(())
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
        model: &str,
    ) -> Result<Vec<SearchHit>> {
        self.search_embeddings_with_scope(query_embedding, limit, model, None, None)
    }

    pub fn has_embeddings_with_scope(
        &self,
        model: &str,
        exclude_recording_id: Option<&str>,
        source_type: Option<&str>,
    ) -> Result<bool> {
        let mut sql = String::from(
            "SELECT EXISTS(
                SELECT 1
                FROM transcript_embeddings te
                JOIN recordings r ON r.id = te.recording_id
                WHERE te.model = ?1",
        );
        let mut values: Vec<Value> = vec![Value::from(model.to_string())];
        let mut placeholder = 2;

        if let Some(recording_id) = exclude_recording_id {
            sql.push_str(" AND te.recording_id != ?");
            sql.push_str(&placeholder.to_string());
            values.push(Value::from(recording_id.to_string()));
            placeholder += 1;
        }

        if let Some(source_type) = source_type {
            sql.push_str(" AND r.source_type = ?");
            sql.push_str(&placeholder.to_string());
            values.push(Value::from(source_type.to_string()));
        }

        sql.push(')');
        self.conn
            .query_row(&sql, params_from_iter(values.iter()), |row| row.get(0))
            .map_err(Into::into)
    }

    pub fn search_embeddings_with_scope(
        &self,
        query_embedding: &[f32],
        limit: usize,
        model: &str,
        exclude_recording_id: Option<&str>,
        source_type: Option<&str>,
    ) -> Result<Vec<SearchHit>> {
        let mut ranker = SemanticRanker::new(query_embedding, limit)?;
        let scope = EmbeddingSearchScope {
            model: model.to_string(),
            dimensions: query_embedding.len(),
            exclude_recording_id: exclude_recording_id.map(str::to_string),
            source_type: source_type.map(str::to_string),
        };
        let token = self.begin_embedding_scan(&scope)?;
        let mut cursor = None;
        loop {
            let page = self.read_embedding_scan_page(&scope, &token, cursor)?;
            cursor = page.next_cursor;
            for row in page.rows {
                ranker.push(row);
            }
            if page.exhausted {
                break;
            }
        }
        self.validate_embedding_scan(&token)?;
        Ok(ranker.finish())
    }

    pub(crate) fn begin_embedding_scan(
        &self,
        scope: &EmbeddingSearchScope,
    ) -> Result<EmbeddingScanToken> {
        embedding_scan_filter(scope)?;
        let tx = self.conn.unchecked_transaction()?;
        let revision = verify_semantic_revision(&tx)?;
        let upper_id = tx.query_row(
            "SELECT MAX(id) FROM transcript_embeddings INDEXED BY idx_embeddings_model_id WHERE model = ?1",
            [&scope.model],
            |row| row.get(0),
        )?;
        tx.commit()?;
        Ok(EmbeddingScanToken { revision, upper_id })
    }

    pub(crate) fn read_embedding_scan_page(
        &self,
        scope: &EmbeddingSearchScope,
        token: &EmbeddingScanToken,
        after: Option<i64>,
    ) -> Result<EmbeddingScanPage> {
        let (filter, mut values) = embedding_scan_filter(scope)?;
        let tx = self.conn.unchecked_transaction()?;
        if verify_semantic_revision(&tx)? != token.revision {
            anyhow::bail!("Semantic recall generation changed");
        }
        let candidates = {
            let lower_bound = if after.is_some() { " AND id > ?2" } else { "" };
            let mut statement = tx.prepare(&format!(
                "SELECT id FROM transcript_embeddings INDEXED BY idx_embeddings_model_id
                 WHERE model = ?1 AND id <= ?3{lower_bound}
                 ORDER BY id ASC LIMIT ?4"
            ))?;
            let rows = statement.query_map(
                params![
                    scope.model,
                    after,
                    token.upper_id,
                    (EMBEDDING_PAGE_ROWS + 1) as i64
                ],
                |row| row.get::<_, i64>(0),
            )?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut exhausted = candidates.len() <= EMBEDDING_PAGE_ROWS;
        let window = &candidates[..candidates.len().min(EMBEDDING_PAGE_ROWS)];
        let mut next_cursor = window.last().copied().or(after);
        values.push(
            window
                .first()
                .copied()
                .map(Value::from)
                .unwrap_or(Value::Null),
        );
        values.push(
            window
                .last()
                .copied()
                .map(Value::from)
                .unwrap_or(Value::Null),
        );
        let sql = format!(
            "SELECT te.id, r.rowid
            FROM transcript_embeddings te INDEXED BY idx_embeddings_model_id
            JOIN recordings r ON r.id = te.recording_id
            WHERE {filter} AND te.id >= ?5 AND te.id <= ?6
            ORDER BY te.id ASC"
        );
        let mut ids = Vec::new();
        let mut bytes = 0usize;
        let encoding: String = tx.query_row("PRAGMA encoding", [], |row| row.get(0))?;
        let text_expansion = match encoding.as_str() {
            "UTF-8" => 1usize,
            "UTF-16le" | "UTF-16be" => 2,
            _ => anyhow::bail!("Unsupported semantic search text encoding"),
        };
        {
            let mut statement = tx.prepare(&sql)?;
            let mut rows = statement.query(params_from_iter(values.iter()))?;
            while let Some(row) = rows.next()? {
                let id: i64 = row.get(0)?;
                let recording_rowid: i64 = row.get(1)?;
                let mut row_bytes = 24usize;
                for column in [
                    "recording_id",
                    "segment_id",
                    "text",
                    "embedding",
                    "created_at",
                ] {
                    let stored_length = tx
                        .blob_open(
                            rusqlite::DatabaseName::Main,
                            "transcript_embeddings",
                            column,
                            id,
                            true,
                        )?
                        .len();
                    let length = stored_length
                        .checked_mul(if column == "embedding" {
                            1
                        } else {
                            text_expansion
                        })
                        .context("Semantic payload size overflow")?;
                    row_bytes = row_bytes
                        .checked_add(length)
                        .context("Semantic payload size overflow")?;
                }
                let title_bytes = tx
                    .blob_open(
                        rusqlite::DatabaseName::Main,
                        "recordings",
                        "title",
                        recording_rowid,
                        true,
                    )?
                    .len()
                    .checked_mul(text_expansion)
                    .context("Semantic payload size overflow")?;
                row_bytes = row_bytes
                    .checked_add(title_bytes)
                    .context("Semantic payload size overflow")?;
                if row_bytes > EMBEDDING_PAGE_BYTES {
                    anyhow::bail!(
                        "Semantic recall resource limit: eligible row exceeds page byte budget"
                    );
                }
                if bytes + row_bytes > EMBEDDING_PAGE_BYTES {
                    exhausted = false;
                    next_cursor = ids.last().copied().or(after);
                    break;
                }
                bytes += row_bytes;
                ids.push(id);
            }
        }
        let mut rows = Vec::with_capacity(ids.len());
        {
            let mut statement = tx.prepare(
                "SELECT te.id, te.created_at, te.embedding,
                te.recording_id, r.title, te.segment_id, te.text, te.start_time, te.end_time
                FROM transcript_embeddings te JOIN recordings r ON r.id = te.recording_id
                WHERE te.id = ?1",
            )?;
            for id in &ids {
                rows.push(statement.query_row([id], |row| {
                    Ok(RawEmbeddingRow {
                        id: row.get(0)?,
                        created_at: row.get(1)?,
                        embedding: row.get(2)?,
                        hit: SearchHit {
                            recording_id: row.get(3)?,
                            recording_title: row.get(4)?,
                            project_id: String::new(),
                            segment_id: row.get(5)?,
                            text: row.get(6)?,
                            start_time: row.get::<_, Option<f64>>(7)?.unwrap_or(f64::NAN),
                            end_time: row.get::<_, Option<f64>>(8)?.unwrap_or(f64::NAN),
                            score: 0.0,
                        },
                    })
                })?);
            }
        }
        if verify_semantic_revision(&tx)? != token.revision {
            anyhow::bail!("Semantic recall generation changed");
        }
        tx.commit()?;
        Ok(EmbeddingScanPage {
            rows,
            next_cursor,
            exhausted,
        })
    }

    pub(crate) fn validate_embedding_scan(&self, token: &EmbeddingScanToken) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        if verify_semantic_revision(&tx)? != token.revision {
            anyhow::bail!("Semantic recall generation changed");
        }
        tx.commit()?;
        Ok(())
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

fn f32_slice_to_blob(values: &[f32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn blob_to_f32_vec(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

/// The lowercase terms of a free-text query, using the same tokenization and
/// two-character floor as `build_fts_query`, so the LIKE fallback and the FTS
/// path agree on what counts as a match.
fn search_terms(query: &str) -> Vec<String> {
    query
        .split(|c: char| !c.is_alphanumeric())
        .map(|token| token.trim().to_lowercase())
        .filter(|token| token.len() >= 2)
        .collect()
}

/// Case-insensitive "any term is a prefix of some word" match, mirroring the
/// `term*` OR-query `build_fts_query` sends to FTS5.
fn terms_match(text: &str, terms: &[String]) -> bool {
    let lowered = text.to_lowercase();
    lowered
        .split(|c: char| !c.is_alphanumeric())
        .any(|word| terms.iter().any(|term| word.starts_with(term.as_str())))
}

/// A short window around the first matched word with every matched word
/// wrapped in `[[`/`]]`, shaped like FTS5's `snippet()` output so the renderer
/// highlights both the same way. `context_words` is the number of words kept
/// on each side of the first match.
fn like_snippet(text: &str, terms: &[String], context_words: usize) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    let is_match = |word: &str| {
        let lowered = word.to_lowercase();
        lowered
            .split(|c: char| !c.is_alphanumeric())
            .any(|part| terms.iter().any(|term| part.starts_with(term.as_str())))
    };
    let first = words.iter().position(|word| is_match(word)).unwrap_or(0);
    let start = first.saturating_sub(context_words);
    let end = (first + context_words + 1).min(words.len());
    let mut snippet = String::new();
    if start > 0 {
        snippet.push('…');
    }
    for (index, word) in words[start..end].iter().enumerate() {
        if index > 0 {
            snippet.push(' ');
        }
        if is_match(word) {
            snippet.push_str("[[");
            snippet.push_str(word);
            snippet.push_str("]]");
        } else {
            snippet.push_str(word);
        }
    }
    if end < words.len() {
        snippet.push('…');
    }
    snippet
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
    include!("db_meeting_durability_tests.rs");
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
            correction_approval_undo: HashMap::new(),
        };
        db.init_tables().expect("init tables");
        db
    }

    fn refuse_transcript_index_writes(db: &Database) {
        db.conn
            .execute_batch(
                "CREATE TRIGGER refuse_transcript_index_write
             BEFORE INSERT ON transcript_fts_content
             BEGIN SELECT RAISE(ABORT, 'injected index write failure'); END;",
            )
            .unwrap();
    }

    fn dictation_fixture(
        id: &str,
        created_at: chrono::DateTime<Utc>,
        final_text: &str,
        raw_text: &str,
    ) -> (Recording, Transcript, DictationHistoryTextRecord) {
        let recording = Recording {
            id: id.to_string(),
            title: format!("Dictation {id}"),
            project_id: "inbox".to_string(),
            duration: 4,
            created_at,
            updated_at: created_at,
            source_type: "dictation".to_string(),
            audio_path: String::new(),
            status: "completed".to_string(),
            summary: None,
            action_items: None,
            summary_provenance: None,
            action_items_provenance: None,
            meeting_notes: None,
            meeting_template_id: None,
            meeting_capture_mode: None,
            imported_source_name: None,
            notes_updated_at: None,
            consent_prompt_shown: false,
            consent_notice_mode: None,
            consent_notice_surface: None,
            consent_notice_message: None,
            consent_notice_updated_at: None,
            analysis_failure: None,
            pause_spans: Vec::new(),
            video_service: None,
            attendees: Vec::new(),
            transcript_complete: true,
            transcript_degraded_reason: None,
            transcript_incomplete_acknowledged_at: None,
            capture_degraded_summary: None,
        };
        let transcript = Transcript {
            heard_through_speakers: Vec::new(),
            id: format!("{id}-transcript"),
            recording_id: id.to_string(),
            segments: vec![TranscriptSegment {
                id: format!("{id}-segment"),
                start_time: 0.0,
                end_time: 4.0,
                text: final_text.to_string(),
                speaker_id: None,
                confidence: 0.9,
            }],
            full_text: final_text.to_string(),
            language: "en".to_string(),
            confidence: 0.9,
            model: "test".to_string(),
            model_id: Some("test".to_string()),
            requested_provider: Some("parakeet".to_string()),
            actual_provider: Some("parakeet".to_string()),
            measured_word_timestamps: false,
            created_at,
        };
        let history = DictationHistoryTextRecord {
            recording_id: id.to_string(),
            final_text: final_text.to_string(),
            raw_text: raw_text.to_string(),
            reprocessed_from_id: None,
            mode_preset: Some("voice".to_string()),
            created_at,
        };
        (recording, transcript, history)
    }

    #[test]
    fn dictation_list_previews_carry_the_words_and_the_app() {
        let mut db = in_memory_db();
        let (recording, transcript, history) =
            dictation_fixture("d-1", Utc::now(), "Ship it today.", "ship it today");
        db.create_dictation_history_entry(&recording, &transcript, &history, None)
            .expect("save dictation");
        let previews = db.get_dictation_list_previews().expect("previews");
        assert_eq!(
            previews.get("d-1"),
            Some(&(Some("Ship it today.".to_string()), None))
        );
    }

    #[test]
    fn dictation_insights_count_speaking_time_and_the_local_days_used() {
        let mut db = in_memory_db();
        let now = Utc::now();
        for (id, created_at) in [
            ("d-today", now),
            ("d-today-2", now),
            ("d-earlier", now - chrono::Duration::days(3)),
        ] {
            let (recording, transcript, history) = dictation_fixture(
                id,
                created_at,
                "Four words right here.",
                "four words right here",
            );
            db.create_dictation_history_entry(&recording, &transcript, &history, None)
                .expect("save dictation");
        }
        let totals = db.get_dictation_insight_totals().expect("totals");
        assert_eq!(totals.dictated_words, 12);
        assert_eq!(totals.spoken_seconds, 12, "three 4 s fixtures");
        assert_eq!(
            totals.active_dates.len(),
            2,
            "two distinct days, newest first"
        );
        assert!(totals.active_dates[0] > totals.active_dates[1]);
    }

    fn seed_dictation_history(db: &mut Database) {
        let base = Utc::now();
        let rows = [
            (
                "dictation-old",
                base - chrono::Duration::hours(3),
                "Ship the quarterly budget summary to finance.",
                "ship the quarterly budget summary to finance",
            ),
            (
                "dictation-new",
                base - chrono::Duration::hours(1),
                "Remind me to water the plants.",
                "remind me to water the plants and email finance",
            ),
            (
                "dictation-other",
                base - chrono::Duration::hours(2),
                "Nothing relevant here.",
                "nothing relevant here",
            ),
        ];
        for (id, created_at, final_text, raw_text) in rows {
            let (recording, transcript, history) =
                dictation_fixture(id, created_at, final_text, raw_text);
            db.create_dictation_history_entry(&recording, &transcript, &history, None)
                .expect("dictation entry");
        }
    }

    #[test]
    fn dictation_history_search_ranks_hits_and_marks_matched_terms() {
        let mut db = in_memory_db();
        seed_dictation_history(&mut db);

        let hits = db
            .search_dictation_history("finance", 10, 0)
            .expect("search");
        let ids: Vec<&str> = hits.iter().map(|hit| hit.recording_id.as_str()).collect();
        assert_eq!(ids.len(), 2, "both texts mentioning finance match: {ids:?}");
        assert!(ids.contains(&"dictation-old"));
        assert!(ids.contains(&"dictation-new"));
        assert!(!ids.contains(&"dictation-other"));

        for hit in &hits {
            assert!(
                hit.snippet.contains("[[") && hit.snippet.contains("]]"),
                "snippet must mark the matched term: {}",
                hit.snippet
            );
        }
        let newest = hits
            .iter()
            .find(|hit| hit.recording_id == "dictation-new")
            .expect("raw-only hit");
        assert_eq!(
            newest.matched_field, "raw",
            "finance appears only in what was heard for the newest row"
        );
        let oldest = hits
            .iter()
            .find(|hit| hit.recording_id == "dictation-old")
            .expect("final hit");
        assert_eq!(oldest.matched_field, "final");

        // Prefix matching, like transcript search.
        let prefix = db.search_dictation_history("quart", 10, 0).expect("search");
        assert_eq!(prefix.len(), 1);
        assert_eq!(prefix[0].recording_id, "dictation-old");

        // Paging is honoured.
        let page = db
            .search_dictation_history("finance", 1, 1)
            .expect("search");
        assert_eq!(page.len(), 1);

        // A query with no usable term is empty, not an error.
        assert!(db
            .search_dictation_history("a", 10, 0)
            .expect("search")
            .is_empty());
    }

    #[test]
    fn corrected_dictation_text_overrides_preview_and_joins_search_without_rewriting_original() {
        let mut db = in_memory_db();
        seed_dictation_history(&mut db);
        db.save_dictation_edit(
            "dictation-old",
            Some("Send the revised forecast to operations."),
            None,
        )
        .unwrap();

        let previews = db.get_dictation_list_previews().unwrap();
        assert_eq!(
            previews.get("dictation-old").unwrap().0.as_deref(),
            Some("Send the revised forecast to operations.")
        );
        let corrected_hits = db.search_dictation_history("forecast", 10, 0).unwrap();
        assert_eq!(corrected_hits.len(), 1);
        assert_eq!(corrected_hits[0].recording_id, "dictation-old");
        assert!(corrected_hits[0].snippet.contains("[[forecast]]"));
        assert_eq!(corrected_hits[0].matched_field, "corrected");

        let original_hits = db.search_dictation_history("quarterly", 10, 0).unwrap();
        assert_eq!(original_hits.len(), 1, "original text stays searchable");
        assert_eq!(original_hits[0].recording_id, "dictation-old");
        assert_eq!(original_hits[0].matched_field, "final");
        assert_eq!(
            db.get_transcript("dictation-old")
                .unwrap()
                .unwrap()
                .full_text,
            "Ship the quarterly budget summary to finance."
        );

        db.save_dictation_edit(
            "dictation-old",
            Some(""),
            Some("Send the revised forecast to operations."),
        )
        .unwrap();
        assert_eq!(
            db.get_dictation_list_previews()
                .unwrap()
                .get("dictation-old")
                .unwrap()
                .0
                .as_deref(),
            Some("")
        );
    }

    #[test]
    fn dictation_history_backfill_repairs_a_partially_populated_index() {
        let mut db = in_memory_db();
        seed_dictation_history(&mut db);
        db.conn
            .execute(
                "DELETE FROM dictation_history_fts WHERE recording_id = 'dictation-old'",
                [],
            )
            .unwrap();
        assert!(db
            .search_dictation_history("quarterly", 10, 0)
            .unwrap()
            .is_empty());
        db.backfill_dictation_history_text_if_needed().unwrap();
        let hits = db.search_dictation_history("quarterly", 10, 0).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].recording_id, "dictation-old");
        db.backfill_dictation_history_text_if_needed().unwrap();
        assert_eq!(
            db.conn
                .query_row("SELECT COUNT(*) FROM dictation_history_fts", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            3
        );
    }

    #[test]
    fn dictation_history_search_falls_back_to_like_without_fts() {
        let mut db = in_memory_db();
        seed_dictation_history(&mut db);
        db.conn
            .execute("DROP TABLE dictation_history_fts", [])
            .unwrap();

        let hits = db
            .search_dictation_history("finance", 10, 0)
            .expect("fallback search must not error");
        let ids: Vec<&str> = hits.iter().map(|hit| hit.recording_id.as_str()).collect();
        assert_eq!(ids, vec!["dictation-new", "dictation-old"], "newest first");
        assert!(
            hits[0].snippet.contains("[[finance]]"),
            "{}",
            hits[0].snippet
        );
        assert_eq!(hits[0].matched_field, "raw");
        assert_eq!(hits[1].matched_field, "final");

        // Writes still succeed with the index gone.
        let (recording, transcript, history) = dictation_fixture(
            "dictation-late",
            Utc::now(),
            "Budget follow-up.",
            "budget follow up",
        );
        db.create_dictation_history_entry(&recording, &transcript, &history, None)
            .expect("write without fts");
        let budget = db
            .search_dictation_history("budget", 10, 0)
            .expect("search");
        assert_eq!(budget.len(), 2);
    }

    #[test]
    fn corrected_dictation_search_fallback_marks_correction_and_preserves_original_search() {
        let mut db = in_memory_db();
        seed_dictation_history(&mut db);
        db.save_dictation_edit(
            "dictation-old",
            Some("Send the revised newword forecast to operations."),
            None,
        )
        .unwrap();
        db.conn
            .execute("DROP TABLE dictation_history_fts", [])
            .unwrap();

        let corrected_hits = db.search_dictation_history("newword", 10, 0).unwrap();
        assert_eq!(corrected_hits.len(), 1);
        assert_eq!(corrected_hits[0].recording_id, "dictation-old");
        assert_eq!(corrected_hits[0].matched_field, "corrected");

        let final_hits = db.search_dictation_history("quarterly", 10, 0).unwrap();
        assert_eq!(final_hits.len(), 1);
        assert_eq!(final_hits[0].recording_id, "dictation-old");
        assert_eq!(final_hits[0].matched_field, "final");

        let raw_hits = db.search_dictation_history("email", 10, 0).unwrap();
        assert_eq!(raw_hits.len(), 1);
        assert_eq!(raw_hits[0].recording_id, "dictation-new");
        assert_eq!(raw_hits[0].matched_field, "raw");

        let original = db
            .get_dictation_history_text("dictation-old")
            .unwrap()
            .unwrap();
        assert_eq!(
            original.final_text,
            "Ship the quarterly budget summary to finance."
        );
        assert_eq!(
            original.raw_text,
            "ship the quarterly budget summary to finance"
        );

        db.save_dictation_edit(
            "dictation-old",
            None,
            Some("Send the revised newword forecast to operations."),
        )
        .unwrap();
        assert!(db
            .search_dictation_history("newword", 10, 0)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn like_snippet_windows_around_the_first_match() {
        let text = "one two three four five six seven eight finance nine ten eleven twelve";
        let terms = search_terms("finance");
        let snippet = like_snippet(text, &terms, 2);
        assert_eq!(snippet, "…seven eight [[finance]] nine ten…");
        assert!(terms_match("Email FINANCE now", &terms));
        assert!(!terms_match("nothing here", &terms));
        assert!(search_terms("a").is_empty());
    }

    #[test]
    fn deleting_a_dictation_removes_its_searchable_text() {
        let mut db = in_memory_db();
        seed_dictation_history(&mut db);

        db.delete_recording("dictation-old").expect("delete");

        assert!(db
            .get_dictation_history_text("dictation-old")
            .expect("read")
            .is_none());
        let hits = db
            .search_dictation_history("quarterly", 10, 0)
            .expect("search");
        assert!(
            hits.is_empty(),
            "deleted rows must leave the index: {hits:?}"
        );
    }

    #[test]
    fn legacy_dictations_are_backfilled_into_history_text_and_fts() {
        let mut db = in_memory_db();
        let (recording, transcript, _) = dictation_fixture(
            "dictation-legacy",
            Utc::now(),
            "Legacy words about a rota.",
            "",
        );
        // The pre-history write path: recording + transcript only.
        db.create_recording_with_transcript(&recording, &transcript)
            .expect("legacy write");
        assert!(db
            .get_dictation_history_text("dictation-legacy")
            .expect("read")
            .is_none());

        db.backfill_dictation_history_text_if_needed()
            .expect("backfill");

        let text = db
            .get_dictation_history_text("dictation-legacy")
            .expect("read")
            .expect("backfilled row");
        assert_eq!(text.final_text, "Legacy words about a rota.");
        assert_eq!(text.raw_text, text.final_text, "raw was never stored");
        assert_eq!(text.reprocessed_from_id, None);
        let hits = db.search_dictation_history("rota", 10, 0).expect("search");
        assert_eq!(hits.len(), 1);

        // Idempotent: a second pass neither duplicates nor fails.
        db.backfill_dictation_history_text_if_needed()
            .expect("second backfill");
        let count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM dictation_history_text", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn reprocessed_entries_keep_their_link_to_the_source_dictation() {
        let mut db = in_memory_db();
        seed_dictation_history(&mut db);
        let (recording, transcript, mut history) = dictation_fixture(
            "dictation-redo",
            Utc::now(),
            "- Water the plants",
            "water the plants",
        );
        history.reprocessed_from_id = Some("dictation-new".to_string());
        history.mode_preset = Some("notes".to_string());
        db.create_dictation_history_entry(&recording, &transcript, &history, None)
            .expect("write");

        let stored = db
            .get_dictation_history_text("dictation-redo")
            .expect("read")
            .expect("row");
        assert_eq!(stored, history);
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

    /// A second process reading the live database must not leave anything
    /// behind for the writer to trip over. A `-wal`/`-shm` pair would also
    /// mean the reader had written to the directory, which the read-only flag
    /// is supposed to make impossible.
    #[test]
    fn read_only_open_creates_no_sidecar_files_and_the_writer_is_not_in_wal_mode() {
        let dir = crate::test_fs::TempDir::new("local-tools");
        let path = dir.path().join("plainsong.db");
        {
            let mut db = Database::open_at_path(&path, None).unwrap();
            db.create_recording(&sample_recording("ro-wal", "inbox"))
                .unwrap();
            // The read-only open in this repo does not attach to a WAL, so the
            // writer must not be using one. If that ever changes, this test is
            // the thing that says so before a user's CLI stops working.
            let mode: String = db
                .conn
                .query_row("PRAGMA journal_mode", [], |row| row.get(0))
                .unwrap();
            assert_ne!(mode.to_ascii_lowercase(), "wal", "writer journal_mode");
        }
        let before: BTreeSet<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(before, BTreeSet::from(["plainsong.db".to_string()]));

        let reader = Database::open_read_only_at_path(&path, None).unwrap();
        assert_eq!(reader.get_recordings(None).unwrap().len(), 1);
        assert!(!reader.has_transcript_content("ro-wal").unwrap());
        assert!(reader
            .recording_ids_with_transcript_content()
            .unwrap()
            .is_empty());
        drop(reader);

        let after: BTreeSet<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            after, before,
            "a read-only open must not create journal, WAL or shm files"
        );
    }

    /// The pre-meeting brief only ever looks at the newest few hundred
    /// meetings. It used to get them by loading the whole library and calling
    /// `.take()`, so the cap bounded the ranking and nothing else. The cap is
    /// in SQL now, and this pins both halves: the right rows, and only those.
    #[test]
    fn get_recent_recordings_caps_in_sql_and_returns_the_newest_first() {
        let dir = crate::test_fs::TempDir::new("recent-recordings");
        let path = dir.path().join("plainsong.db");
        let mut db = Database::open_at_path(&path, None).unwrap();
        for index in 0..8 {
            let mut recording = sample_recording(&format!("r{index}"), "inbox");
            recording.created_at =
                chrono::TimeZone::with_ymd_and_hms(&Utc, 2026, 8, 1 + index, 12, 0, 0)
                    .single()
                    .expect("valid fixture timestamp");
            db.create_recording(&recording).unwrap();
        }

        let recent = db.get_recent_recordings(3).unwrap();
        assert_eq!(
            recent.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["r7", "r6", "r5"],
            "the newest three, newest first"
        );

        // The rows never left SQLite: the statement itself is capped, so the
        // count that comes back is the cap and not a slice of a larger read.
        assert_eq!(db.get_recent_recordings(1).unwrap().len(), 1);
        assert_eq!(db.get_recent_recordings(0).unwrap().len(), 0);
        // A cap larger than the library is not an error, and the unlimited
        // call still returns everything.
        assert_eq!(db.get_recent_recordings(500).unwrap().len(), 8);
        assert_eq!(db.get_recordings(None).unwrap().len(), 8);
    }

    #[test]
    fn transcript_content_predicate_matches_the_loaded_transcript() {
        let dir = crate::test_fs::TempDir::new("local-tools");
        let path = dir.path().join("plainsong.db");
        let mut db = Database::open_at_path(&path, None).unwrap();
        for id in ["with-segments", "text-only", "empty"] {
            db.create_recording(&sample_recording(id, "inbox")).unwrap();
        }
        db.conn
            .execute(
                "INSERT INTO transcripts (id, recording_id, segments, full_text, language, confidence, model, created_at)
                 VALUES ('t1', 'with-segments', '[{\"id\":\"s\",\"start_time\":0.0,\"end_time\":1.0,\"text\":\"hi\",\"speaker_id\":null,\"confidence\":0.9}]', '', 'en', 0.9, 'test', '2026-08-01T00:00:00Z')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO transcripts (id, recording_id, segments, full_text, language, confidence, model, created_at)
                 VALUES ('t2', 'text-only', '[]', 'a sentence', 'en', 0.9, 'test', '2026-08-01T00:00:00Z')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO transcripts (id, recording_id, segments, full_text, language, confidence, model, created_at)
                 VALUES ('t3', 'empty', '[]', '   ', 'en', 0.9, 'test', '2026-08-01T00:00:00Z')",
                [],
            )
            .unwrap();

        assert!(db.has_transcript_content("with-segments").unwrap());
        assert!(db.has_transcript_content("text-only").unwrap());
        assert!(!db.has_transcript_content("empty").unwrap());
        assert!(!db.has_transcript_content("no-such-recording").unwrap());
        assert_eq!(
            db.recording_ids_with_transcript_content().unwrap(),
            HashSet::from(["with-segments".to_string(), "text-only".to_string()])
        );
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

    /// The whole point of item B13. `PRAGMA rekey` on an unkeyed connection is
    /// a documented no-op: it reported success, the file stayed plaintext, and
    /// the app told the user "database encrypted". This is the real migration.
    #[cfg(feature = "sqlcipher")]
    #[test]
    fn plaintext_database_is_really_encrypted_and_keeps_its_schema_version() {
        let dir = crate::test_fs::TempDir::new("vault-migrate");
        let path = dir.path().join("plainsong.db");
        let key = "0123456789abcdef0123456789abcdef";
        {
            let mut db = Database::open_at_path(&path, None).unwrap();
            db.create_recording(&sample_recording("v-1", "inbox"))
                .unwrap();
            assert!(!db.is_encrypted().unwrap());
        }
        // Before: readable by anyone with the file.
        assert!(Database::open_read_only_at_path(&path, None).is_ok());

        let mut db = Database::open_at_path(&path, None).unwrap();
        db.change_key(key).expect("plaintext migration");
        assert!(db.is_encrypted().unwrap());
        // The handle kept working, against the encrypted file.
        assert_eq!(db.get_recordings(None).unwrap().len(), 1);
        db.create_recording(&sample_recording("v-2", "inbox"))
            .unwrap();
        drop(db);

        // After: the plaintext open that worked a moment ago now fails, and
        // the keyed one sees both rows.
        assert!(
            Database::open_read_only_at_path(&path, None).is_err(),
            "the file must no longer open without the key"
        );
        let keyed = Database::open_read_only_at_path(&path, Some(key)).unwrap();
        assert_eq!(keyed.get_recordings(None).unwrap().len(), 2);
        let version: i64 = keyed
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            version, CURRENT_SCHEMA_VERSION,
            "sqlcipher_export does not carry user_version; it has to be set"
        );

        // No staging file survives a successful migration.
        let leftovers: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name != "plainsong.db")
            .collect();
        assert!(leftovers.is_empty(), "leftovers: {leftovers:?}");
    }

    /// Re-keying a database that IS encrypted is the case `PRAGMA rekey` is
    /// actually for; the branch has to keep working.
    #[cfg(feature = "sqlcipher")]
    #[test]
    fn an_encrypted_database_still_rekeys_in_place() {
        let dir = crate::test_fs::TempDir::new("vault-rekey");
        let path = dir.path().join("plainsong.db");
        let first = "0123456789abcdef0123456789abcdef";
        let second = "fedcba9876543210fedcba9876543210";
        {
            let mut db = Database::open_at_path(&path, Some(first)).unwrap();
            db.create_recording(&sample_recording("rk-1", "inbox"))
                .unwrap();
            db.change_key(second).expect("rekey");
            assert!(db.is_encrypted().unwrap());
        }
        assert!(Database::open_read_only_at_path(&path, Some(first)).is_err());
        let reopened = Database::open_read_only_at_path(&path, Some(second)).unwrap();
        assert_eq!(reopened.get_recordings(None).unwrap().len(), 1);
    }

    /// A migration that cannot finish must leave the user with the database
    /// they had, not a half-written one and not nothing.
    #[cfg(feature = "sqlcipher")]
    #[test]
    fn a_failed_migration_leaves_the_plaintext_original_intact() {
        let dir = crate::test_fs::TempDir::new("vault-fail");
        let path = dir.path().join("plainsong.db");
        {
            let mut db = Database::open_at_path(&path, None).unwrap();
            db.create_recording(&sample_recording("f-1", "inbox"))
                .unwrap();
        }

        // A directory where the staging file wants to be: ATTACH cannot create
        // the database, so the export fails at the first step that touches disk.
        let staging = dir.path().join("plainsong.db.new");
        std::fs::create_dir(&staging).unwrap();

        let mut db = Database::open_at_path(&path, None).unwrap();
        let error = db
            .change_key("0123456789abcdef0123456789abcdef")
            .expect_err("migration must fail");
        assert!(!db.is_encrypted().unwrap(), "{error:#}");
        // The handle was reopened against the surviving plaintext file and is
        // still usable, both for reads and for writes.
        assert_eq!(db.get_recordings(None).unwrap().len(), 1);
        db.create_recording(&sample_recording("f-2", "inbox"))
            .unwrap();
        drop(db);

        // The original is still a plaintext database with the user's rows in
        // it, and the failure did not put a key on it.
        let reopened = Database::open_read_only_at_path(&path, None)
            .expect("the plaintext original must still open");
        assert_eq!(reopened.get_recordings(None).unwrap().len(), 2);
        assert!(!reopened.is_encrypted().unwrap());
        drop(reopened);
        std::fs::remove_dir(&staging).unwrap();
    }

    /// The staging file is cleaned up when the export itself fails partway,
    /// so a retry is not blocked by the previous attempt's leftovers.
    #[cfg(feature = "sqlcipher")]
    #[test]
    fn a_failed_migration_removes_its_staging_file() {
        let dir = crate::test_fs::TempDir::new("vault-staging");
        let path = dir.path().join("plainsong.db");
        {
            let mut db = Database::open_at_path(&path, None).unwrap();
            db.create_recording(&sample_recording("s-1", "inbox"))
                .unwrap();
        }
        // An already-encrypted file: the migration refuses at the "prove it is
        // plaintext" step, which is after the staging path has been chosen.
        {
            let mut db = Database::open_at_path(&path, None).unwrap();
            db.change_key("0123456789abcdef0123456789abcdef").unwrap();
        }
        let error = encrypt_plaintext_database_file(&path, "0123456789abcdef0123456789abcdef")
            .expect_err("an encrypted file must not be exported again");
        assert!(
            error.to_string().contains("did not open as plaintext"),
            "{error:#}"
        );
        assert!(
            !dir.path().join("plainsong.db.new").exists(),
            "the staging file must not survive a failed migration"
        );
        // And the encrypted database is untouched.
        let keyed =
            Database::open_read_only_at_path(&path, Some("0123456789abcdef0123456789abcdef"))
                .unwrap();
        assert_eq!(keyed.get_recordings(None).unwrap().len(), 1);
    }

    /// What startup keys off: a keyed open of a plaintext file fails, and a
    /// plaintext open of the same file succeeds. That pair is the whole
    /// "key stored, database never encrypted" detection.
    #[cfg(feature = "sqlcipher")]
    #[test]
    fn a_keyed_open_of_a_plaintext_file_fails_and_the_plaintext_open_does_not() {
        let dir = crate::test_fs::TempDir::new("vault-detect");
        let path = dir.path().join("plainsong.db");
        let key = "0123456789abcdef0123456789abcdef";
        {
            let mut db = Database::open_at_path(&path, None).unwrap();
            db.create_recording(&sample_recording("d-1", "inbox"))
                .unwrap();
        }
        assert!(
            Database::open_at_path(&path, Some(key)).is_err(),
            "a keyed open of a plaintext file must fail; that failure is the signal"
        );
        let mut plaintext =
            Database::open_at_path(&path, None).expect("the plaintext open must succeed");
        assert!(!plaintext.is_encrypted().unwrap());

        // Which is exactly what the startup repair then does.
        plaintext.change_key(key).unwrap();
        assert!(plaintext.is_encrypted().unwrap());
        drop(plaintext);
        assert!(Database::open_at_path(&path, Some(key)).is_ok());
    }

    /// The state every existing vault user is in: a key in the keychain, a
    /// plaintext file on disk. The CLI's read-only open has to survive it and
    /// report it honestly rather than claim encryption that is not there.
    #[cfg(feature = "sqlcipher")]
    #[test]
    fn read_only_probe_reports_the_files_real_state_not_the_keychains() {
        let dir = crate::test_fs::TempDir::new("vault-probe");
        let path = dir.path().join("plainsong.db");
        let key = "0123456789abcdef0123456789abcdef";
        {
            let mut db = Database::open_at_path(&path, None).unwrap();
            db.create_recording(&sample_recording("p-1", "inbox"))
                .unwrap();
        }
        // Key present, file plaintext: opens, and says so.
        let probed = Database::open_read_only_probing(&path, Some(key)).unwrap();
        assert!(!probed.is_encrypted().unwrap());
        assert_eq!(probed.get_recordings(None).unwrap().len(), 1);
        drop(probed);

        let mut db = Database::open_at_path(&path, None).unwrap();
        db.change_key(key).unwrap();
        drop(db);

        // Now genuinely encrypted: the keyed attempt wins.
        let probed = Database::open_read_only_probing(&path, Some(key)).unwrap();
        assert!(probed.is_encrypted().unwrap());
        assert_eq!(probed.get_recordings(None).unwrap().len(), 1);
        drop(probed);

        // Encrypted file, no key: refused with both reasons, not a silent
        // empty result.
        let error = Database::open_read_only_probing(&path, None)
            .err()
            .expect("unkeyed open of an encrypted database must fail");
        assert!(error.to_string().contains("Could not read the database"));
        // A wrong key falls back to the plaintext attempt, which also fails.
        assert!(Database::open_read_only_probing(&path, Some("nope")).is_err());
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
        let future_version = CURRENT_SCHEMA_VERSION + 1;
        conn.execute_batch(&format!("PRAGMA user_version = {future_version};"))
            .unwrap();
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
        assert_eq!(
            version, future_version,
            "rejection must not mutate the future database"
        );
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
            correction_approval_undo: HashMap::new(),
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
    fn pause_spans_round_trip_through_list_and_detail_reads() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("meeting-paused", "inbox"))
            .unwrap();
        assert!(db
            .get_recording("meeting-paused")
            .expect("read")
            .expect("row")
            .pause_spans
            .is_empty());

        let spans = vec![
            crate::recording_pause::PauseSpan {
                started_at_ms: 1_000,
                ended_at_ms: Some(4_000),
                at_seconds: 1.0,
            },
            crate::recording_pause::PauseSpan {
                started_at_ms: 9_000,
                ended_at_ms: Some(9_500),
                at_seconds: 6.0,
            },
        ];
        db.set_recording_pause_spans("meeting-paused", &spans)
            .expect("persist spans");
        assert_eq!(
            db.get_recording("meeting-paused")
                .expect("read")
                .expect("row")
                .pause_spans,
            spans
        );
        let listed = db.get_recordings(None).expect("list");
        assert_eq!(listed[0].pause_spans, spans);

        // Clearing writes NULL, not "[]", and reads back as no spans.
        db.set_recording_pause_spans("meeting-paused", &[])
            .expect("clear spans");
        assert!(db
            .get_recording("meeting-paused")
            .expect("read")
            .expect("row")
            .pause_spans
            .is_empty());
        // Garbage in the column is treated as no spans rather than a failed read.
        assert!(parse_pause_spans(Some("not json".to_string())).is_empty());
    }

    #[test]
    fn a_pause_still_open_is_persisted_so_a_crash_keeps_the_marker() {
        // Spans are written on every pause and resume, not only at stop, so a
        // meeting that crashes while paused still has its markers. The open
        // span (no `endedAtMs`) has to survive the round trip.
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("meeting-open-pause", "inbox"))
            .unwrap();
        let open = vec![crate::recording_pause::PauseSpan {
            started_at_ms: 12_000,
            ended_at_ms: None,
            at_seconds: 42.5,
        }];
        db.set_recording_pause_spans("meeting-open-pause", &open)
            .expect("persist an open span");
        let read = db
            .get_recording("meeting-open-pause")
            .expect("read")
            .expect("row");
        assert_eq!(read.pause_spans, open);
        assert_eq!(read.pause_spans[0].ended_at_ms, None);
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
    fn the_video_service_tag_round_trips_and_only_known_keys_survive() {
        let mut db = in_memory_db();
        let mut tagged = sample_recording("meeting-zoom", "inbox");
        tagged.video_service = Some("zoom".to_string());
        db.create_recording(&tagged).unwrap();
        assert_eq!(
            db.get_recording("meeting-zoom")
                .expect("read")
                .expect("row")
                .video_service
                .as_deref(),
            Some("zoom")
        );
        assert_eq!(
            db.get_recordings(None).expect("list")[0]
                .video_service
                .as_deref(),
            Some("zoom")
        );

        // A meeting that began from "New meeting" carries no tag.
        db.create_recording(&sample_recording("meeting-plain", "inbox"))
            .unwrap();
        assert_eq!(
            db.get_recording("meeting-plain")
                .expect("read")
                .expect("row")
                .video_service,
            None
        );

        // A key an older or newer build wrote that this one does not know is
        // read as no tag rather than shown to the reader verbatim.
        db.conn
            .execute(
                "UPDATE recordings SET video_service = 'carrier_pigeon' WHERE id = 'meeting-plain'",
                [],
            )
            .expect("write an unknown key");
        assert_eq!(
            db.get_recording("meeting-plain")
                .expect("read")
                .expect("row")
                .video_service,
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
            imported_source_name: None,
            notes_updated_at: None,
            consent_prompt_shown: false,
            consent_notice_mode: None,
            consent_notice_surface: None,
            consent_notice_message: None,
            consent_notice_updated_at: None,
            analysis_failure: None,
            attendees: Vec::new(),
            pause_spans: Vec::new(),
            video_service: None,
            transcript_complete: true,
            transcript_degraded_reason: None,
            transcript_incomplete_acknowledged_at: None,
            capture_degraded_summary: None,
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
            heard_through_speakers: Vec::new(),
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
            measured_word_timestamps: false,
            created_at: Utc::now(),
        }
    }

    fn transcript_with_texts(recording_id: &str, texts: &[&str]) -> Transcript {
        let mut transcript = sample_transcript(recording_id);
        transcript.segments = texts
            .iter()
            .enumerate()
            .map(|(index, text)| TranscriptSegment {
                id: format!("{recording_id}-s{index}"),
                start_time: index as f64,
                end_time: index as f64 + 1.0,
                text: (*text).to_string(),
                speaker_id: Some("speaker_0".to_string()),
                confidence: 0.95,
            })
            .collect();
        transcript.full_text = texts.join(" ");
        transcript
    }

    fn sample_multi_segment_transcript(recording_id: &str) -> Transcript {
        Transcript {
            heard_through_speakers: Vec::new(),
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
            measured_word_timestamps: false,
            created_at: Utc::now(),
        }
    }

    fn deletion_expectation(segment: &TranscriptSegment) -> TranscriptSegmentExpectation {
        TranscriptSegmentExpectation {
            id: segment.id.clone(),
            text: segment.text.clone(),
            start_time: segment.start_time,
            end_time: segment.end_time,
            speaker_id: segment.speaker_id.clone(),
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
            grounding_policy_version: Some(crate::models::SUMMARY_GROUNDING_POLICY_VERSION),
            content_hash: analysis_content_hash(summary),
            actual_provider: "ollama".to_string(),
            actual_model: "llama3.2".to_string(),
            prompt_source: "meeting_playbook:auto".to_string(),
            completed_at: Utc::now(),
            citations: vec![AnalysisCitation {
                text: "Canonical transcript evidence".to_string(),
                source_kind: None,
                line_id: Some("L1".to_string()),
                segment_id: Some("s1".to_string()),
                start_time: Some(10.0),
                end_time: Some(12.0),
                recording_id: Some("r1".to_string()),
                certainty: Some(1.0),
            }],
            grounded: true,
            unverified_statements: Vec::new(),
            summary_diagnostics: None,
        }
    }

    fn sample_action_items_provenance(items: &[String]) -> ActionItemsProvenance {
        let citations = sample_summary_provenance("unused").citations;
        ActionItemsProvenance {
            version: ANALYSIS_PROVENANCE_VERSION,
            grounding_policy_version: Some(crate::models::SUMMARY_GROUNDING_POLICY_VERSION),
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
                    evidence: None,
                    unclear: false,
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
        refuse_transcript_index_writes(&db);
        let mut recording = sample_recording("dictation-rollback", "inbox");
        recording.source_type = "dictation".to_string();
        recording.audio_path.clear();
        recording.status = "completed".to_string();
        let transcript = sample_transcript(&recording.id);

        let error = db
            .create_recording_with_transcript(&recording, &transcript)
            .expect_err("recording and transcript must share one transaction");

        assert!(matches!(error.downcast_ref::<rusqlite::Error>(),
            Some(rusqlite::Error::SqliteFailure(code, _)) if code.code == rusqlite::ErrorCode::ConstraintViolation));
        assert!(db.get_recording(&recording.id).unwrap().is_none());
        assert!(db.get_transcript(&recording.id).unwrap().is_none());
    }

    #[test]
    fn failed_dictation_recovery_commits_audio_without_transcript_or_history_text() {
        let mut db = in_memory_db();
        let root = std::env::temp_dir().join(format!(
            "plainsong-failed-dictation-db-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let audio_path = root.join("capture.wav");
        write_test_wav(&audio_path);
        let RecordingAudioValidation::Ready(metadata) = validate_plaintext_wav(&audio_path) else {
            panic!("valid wav fixture");
        };
        let mut recording = sample_recording("failed-dictation", "inbox");
        recording.source_type = "dictation".to_string();
        recording.audio_path = audio_path.to_string_lossy().to_string();
        recording.status = "error".to_string();
        recording.transcript_complete = false;
        recording.transcript_degraded_reason = Some("decoder stopped".to_string());

        db.create_failed_dictation_recovery_entry(&recording, &metadata)
            .unwrap();

        let stored = db.get_recording(&recording.id).unwrap().unwrap();
        assert_eq!(stored.status, "error");
        assert!(!stored.transcript_complete);
        assert_eq!(
            stored.transcript_degraded_reason.as_deref(),
            Some("decoder stopped")
        );
        assert!(db.get_transcript(&recording.id).unwrap().is_none());
        assert!(db
            .get_dictation_history_text(&recording.id)
            .unwrap()
            .is_none());
        let bundle = db.load_recording_audio_bundle(&recording.id).unwrap();
        let primary = bundle.primary.expect("ready primary audio asset");
        assert_eq!(primary.lifecycle, RecordingAudioLifecycle::Ready);
        assert_eq!(primary.path, audio_path);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn failed_dictation_recovery_rolls_back_recording_when_asset_write_fails() {
        let mut db = in_memory_db();
        db.conn
            .execute_batch(
                "CREATE TRIGGER reject_failed_dictation_asset
                 BEFORE INSERT ON recording_audio_assets
                 BEGIN SELECT RAISE(ABORT, 'controlled asset failure'); END;",
            )
            .unwrap();
        let root = std::env::temp_dir().join(format!(
            "plainsong-failed-dictation-rollback-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let audio_path = root.join("capture.wav");
        write_test_wav(&audio_path);
        let RecordingAudioValidation::Ready(metadata) = validate_plaintext_wav(&audio_path) else {
            panic!("valid wav fixture");
        };
        let mut recording = sample_recording("failed-dictation-rollback", "inbox");
        recording.source_type = "dictation".to_string();
        recording.audio_path = audio_path.to_string_lossy().to_string();
        recording.status = "error".to_string();
        recording.transcript_complete = false;
        recording.transcript_degraded_reason = Some("decoder stopped".to_string());

        db.create_failed_dictation_recovery_entry(&recording, &metadata)
            .expect_err("asset failure must roll back recording row");

        assert!(db.get_recording(&recording.id).unwrap().is_none());
        let asset_count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM recording_audio_assets WHERE recording_id = ?1",
                [&recording.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(asset_count, 0);

        let _ = std::fs::remove_dir_all(root);
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

    /// Kept dictation audio is registered as `protection 'plaintext'`, which is
    /// correct as an intermediate state but was also its final state: nothing
    /// ever encrypted it, so with the vault on the words the reader chose to
    /// keep stayed in the clear and `count_encrypted_recordings` reported the
    /// store as partly unencrypted forever. The stop path's encryption step now
    /// runs for it too; this is the database half of that, showing the asset is
    /// one the vault operation can actually pick up and switch.
    #[test]
    fn kept_dictation_audio_is_an_asset_the_vault_operation_can_encrypt() {
        let mut db = in_memory_db();
        let root = std::env::temp_dir().join(format!(
            "plainsong-dictation-vault-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let kept = root.join("dictation.wav");
        write_test_wav(&kept);
        let RecordingAudioValidation::Ready(metadata) = validate_plaintext_wav(&kept) else {
            panic!("valid wav fixture");
        };

        let (mut recording, transcript, history) = dictation_fixture(
            "kept-dictation",
            Utc::now(),
            "Water the plants.",
            "water the plants",
        );
        recording.audio_path = kept.to_string_lossy().to_string();
        db.create_dictation_history_entry(&recording, &transcript, &history, Some(&metadata))
            .expect("dictation entry with kept audio");

        // As written, it is plaintext and the store is not fully encrypted.
        let bundle = db.load_recording_audio_bundle(&recording.id).unwrap();
        assert_eq!(
            bundle.primary.as_ref().unwrap().protection,
            RecordingAudioProtection::Plaintext
        );
        assert_eq!(db.count_encrypted_recordings().unwrap(), (0, 1));

        // The vault's own operation covers it, exactly like a meeting track.
        let operation = db
            .begin_recording_audio_encryption(&recording.id)
            .unwrap()
            .expect("kept dictation audio must open an encryption operation");
        assert_eq!(operation.items.len(), 1);
        assert_eq!(operation.items[0].source_path, kept);

        db.switch_recording_audio_encryption(&operation).unwrap();
        let switched = db.load_recording_audio_bundle(&recording.id).unwrap();
        assert_eq!(
            switched.primary.as_ref().unwrap().protection,
            RecordingAudioProtection::Encrypted
        );
        assert_eq!(db.count_encrypted_recordings().unwrap(), (1, 1));

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

        let degraded = db.get_recording("degraded").unwrap().unwrap();
        assert_eq!(
            degraded.status, "completed",
            "a degraded transcript is still a completed meeting"
        );
        assert!(!degraded.transcript_complete);
        assert_eq!(
            degraded.transcript_degraded_reason.as_deref(),
            Some("chunk 41 of 60 failed")
        );
        let listed = db
            .get_recordings(None)
            .unwrap()
            .into_iter()
            .find(|recording| recording.id == "degraded")
            .unwrap();
        assert!(!listed.transcript_complete);
        let response = serde_json::to_value(listed).unwrap();
        assert_eq!(response["transcriptComplete"], false);
        assert_eq!(
            response["transcriptDegradedReason"],
            "chunk 41 of 60 failed"
        );
        assert!(response.get("transcript_complete").is_none());
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
        assert!(db
            .get_recording("degraded")
            .unwrap()
            .unwrap()
            .transcript_incomplete_acknowledged_at
            .is_some());

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
        assert_eq!(
            db.get_recording(&recording.id)
                .unwrap()
                .unwrap()
                .capture_degraded_summary
                .as_deref(),
            Some("The microphone delivered nothing for about 320s of this 3600s meeting")
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

        let mut transcript = sample_transcript("r1");
        transcript.measured_word_timestamps = true;
        db.save_transcript(&transcript).unwrap();

        let fetched = db.get_transcript("r1").unwrap();
        assert!(fetched.is_some());
        let t = fetched.unwrap();
        assert_eq!(t.full_text, "Hello world");
        assert_eq!(t.segments.len(), 1);
        assert!(t.measured_word_timestamps);
    }

    #[test]
    fn heard_through_speakers_rows_are_kept_but_stay_out_of_text_and_search() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let mut transcript = sample_transcript("r1");
        transcript.heard_through_speakers = vec![TranscriptSegment {
            id: "echo".to_string(),
            start_time: 0.2,
            end_time: 1.0,
            text: "zebracorn launch".to_string(),
            speaker_id: Some("me".to_string()),
            confidence: 0.8,
        }];
        db.save_transcript(&transcript).unwrap();

        let stored = db.get_transcript("r1").unwrap().unwrap();
        assert_eq!(stored.heard_through_speakers.len(), 1);
        assert_eq!(stored.heard_through_speakers[0].text, "zebracorn launch");
        assert_eq!(stored.full_text, "Hello world");
        assert!(db
            .search_transcripts("zebracorn", 10, None)
            .unwrap()
            .is_empty());

        // An edit to the transcript rows leaves the set-aside rows alone.
        db.update_transcript_segments("r1", &stored.segments)
            .unwrap();
        let edited = db.get_transcript("r1").unwrap().unwrap();
        assert_eq!(edited.heard_through_speakers.len(), 1);

        // A transcript without any serialises without the field.
        let plain = sample_transcript("r2");
        let json = serde_json::to_value(&plain).unwrap();
        assert!(json.get("heardThroughSpeakers").is_none());
    }

    #[test]
    fn transcript_timing_provenance_migration_defaults_legacy_rows_to_false() {
        let dir = crate::test_fs::TempDir::new("transcript-timing-migration");
        let path = dir.path().join("plainsong.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                r#"CREATE TABLE transcripts (
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
                    id, recording_id, segments, full_text, language, confidence, model, created_at
                 ) VALUES (
                    'legacy-t', 'legacy-r',
                    '[{"id":"s1","startTime":0.0,"endTime":1.0,"text":"legacy","speakerId":null,"confidence":0.9}]',
                    'legacy', 'en', 0.9, 'legacy-model', '2026-01-01T00:00:00Z'
                 );"#,
            )
            .unwrap();
        }

        let db = Database::open_at_path(&path, None).unwrap();
        let transcript = db.get_transcript("legacy-r").unwrap().unwrap();
        assert!(!transcript.measured_word_timestamps);
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
        refuse_transcript_index_writes(&db);

        let error = db
            .save_completed_transcript(&sample_transcript("r1"))
            .expect_err("an index write failure must roll back completion");
        assert!(matches!(error.downcast_ref::<rusqlite::Error>(),
            Some(rusqlite::Error::SqliteFailure(code, _)) if code.code == rusqlite::ErrorCode::ConstraintViolation));
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
        refuse_transcript_index_writes(&db);

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
            .expect_err("an index write failure must roll back segment replacement");
        assert!(matches!(error.downcast_ref::<rusqlite::Error>(),
            Some(rusqlite::Error::SqliteFailure(code, _)) if code.code == rusqlite::ErrorCode::ConstraintViolation));

        let transcript = db.get_transcript("r1").unwrap().unwrap();
        assert_eq!(transcript.full_text, "Hello world");
        assert_eq!(transcript.segments[0].id, "s1");
        assert_eq!(db.search_transcripts("hello", 10, None).unwrap().len(), 1);
        assert!(db
            .search_transcripts("diarized", 10, None)
            .unwrap()
            .is_empty());
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
            .apply_diarization_enrichment("edited", edit_revision, &stale_segments, &[], None, None)
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
            .apply_diarization_enrichment(
                "deleted",
                delete_revision,
                &stale_segments,
                &[],
                None,
                None
            )
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
            .apply_diarization_enrichment(
                "r1",
                revision,
                &enriched,
                &aliases,
                Some("plainsong:ecapa_tdnn_speaker"),
                Some(serde_json::json!({ "recording_id": "r1" })),
            )
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

    /// The `diarizer` column and the `meeting_diarization_applied` entry record
    /// the same fact, so neither may exist without the other.
    ///
    /// They used to be two writes under two separate acquisitions of the
    /// database lock: a reader between them saw the column changed with nothing
    /// saying why, and a failure of the second write made that permanent.
    #[test]
    fn the_diarizer_column_and_its_audit_entry_are_one_write() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_completed_transcript(&sample_transcript("r1"))
            .unwrap();
        let (_, revision) = db.get_transcript_with_revision("r1").unwrap().unwrap();
        let diarized = vec![TranscriptSegment {
            id: "enriched-0".to_string(),
            start_time: 0.0,
            end_time: 2.5,
            text: "Diarized first".to_string(),
            speaker_id: Some("speaker_0".to_string()),
            confidence: 0.95,
        }];

        // A stale revision: the enrichment does not apply, so nothing may be
        // recorded about a diarizer that did not land.
        assert!(!db
            .apply_diarization_enrichment(
                "r1",
                revision + 99,
                &diarized,
                &[],
                Some("plainsong:campplus_speaker"),
                Some(serde_json::json!({ "recording_id": "r1" })),
            )
            .unwrap());
        assert!(db
            .get_all_audit_log()
            .unwrap()
            .iter()
            .all(|entry| entry.event != "meeting_diarization_applied"));
        assert_eq!(db.get_transcript_diarizer("r1").unwrap(), None);

        // The real write: column and entry together.
        assert!(db
            .apply_diarization_enrichment(
                "r1",
                revision,
                &diarized,
                &[],
                Some("deepgram"),
                Some(serde_json::json!({ "recording_id": "r1", "diarizer": "deepgram" })),
            )
            .unwrap());
        assert_eq!(
            db.get_transcript_diarizer("r1").unwrap().as_deref(),
            Some("deepgram")
        );
        let entries = db.get_all_audit_log().unwrap();
        let applied = entries
            .iter()
            .filter(|entry| entry.event == "meeting_diarization_applied")
            .collect::<Vec<_>>();
        assert_eq!(applied.len(), 1);
        assert_eq!(applied[0].details["diarizer"], "deepgram");
    }

    #[test]
    fn fractional_measured_times_survive_save_and_automatic_speaker_enrichment() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let mut transcript = sample_transcript("r1");
        transcript.measured_word_timestamps = true;
        transcript.segments[0].start_time = 93.16;
        transcript.segments[0].end_time = 93.24000000000001;
        db.save_transcript(&transcript).unwrap();
        let stored = db.get_transcript("r1").unwrap().unwrap();
        assert_eq!(
            stored.segments[0].end_time.to_bits(),
            transcript.segments[0].end_time.to_bits()
        );
        let mut enriched = transcript.segments.clone();
        enriched[0].speaker_id = Some("S1".to_owned());
        assert!(db
            .apply_diarization_enrichment("r1", 0, &enriched, &[], Some("test"), None)
            .unwrap());
        assert!(
            db.get_transcript("r1")
                .unwrap()
                .unwrap()
                .measured_word_timestamps
        );
        let (stored, revision) = db.get_transcript_with_revision("r1").unwrap().unwrap();
        let mut changed = stored.segments;
        changed[0].end_time += 0.000_000_001;
        assert!(db
            .apply_diarization_enrichment("r1", revision, &changed, &[], Some("test"), None)
            .unwrap());
        assert!(
            !db.get_transcript("r1")
                .unwrap()
                .unwrap()
                .measured_word_timestamps
        );
    }

    #[test]
    fn speaker_only_enrichment_preserves_measured_word_timestamps() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let mut transcript = sample_transcript("r1");
        transcript.measured_word_timestamps = true;
        db.save_transcript(&transcript).unwrap();

        let (stored, revision) = db.get_transcript_with_revision("r1").unwrap().unwrap();
        let mut enriched = stored.segments;
        enriched[0].speaker_id = Some("S1".to_string());
        assert!(db
            .apply_diarization_enrichment("r1", revision, &enriched, &[], Some("test"), None)
            .unwrap());

        assert!(
            db.get_transcript("r1")
                .unwrap()
                .unwrap()
                .measured_word_timestamps
        );
    }

    #[test]
    fn relabel_moves_user_names_and_voice_links_to_the_matched_voice() {
        use crate::speakers::{
            is_generic_speaker_name, match_rerun_speakers, resolve_speaker_name,
        };
        let segment = |id: &str, start: f64, end: f64, speaker: &str| TranscriptSegment {
            id: id.to_string(),
            start_time: start,
            end_time: end,
            text: format!("words {id}"),
            speaker_id: Some(speaker.to_string()),
            confidence: 0.9,
        };
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let mut transcript = sample_transcript("r1");
        transcript.segments = vec![
            segment("a", 0.0, 10.0, "S1"),
            segment("b", 10.0, 20.0, "S2"),
            segment("c", 20.0, 30.0, "S3"),
        ];
        db.save_transcript(&transcript).unwrap();
        db.rename_speaker("r1", "S2", "Carol").unwrap();
        db.rename_speaker("r1", "S3", "Ben").unwrap();
        db.set_cluster_voice_match("r1", "S3", "profile-ben", "confirmed")
            .unwrap();
        db.set_cluster_voice_match("r1", "S2", "profile-carol", "auto")
            .unwrap();

        // The re-run folds Carol's short stretch into S1 and renumbers, so
        // Ben's voice is now S2, and a new voice the earlier run never had
        // appears as S3.
        let (stored, revision) = db.get_transcript_with_revision("r1").unwrap().unwrap();
        let before: Vec<(f64, f64, Option<String>)> = stored
            .segments
            .iter()
            .map(|s| (s.start_time, s.end_time, s.speaker_id.clone()))
            .collect();
        let rerun = vec![
            segment("a", 0.0, 10.0, "S1"),
            segment("b", 10.0, 20.0, "S1"),
            segment("c", 20.0, 28.0, "S2"),
            segment("d", 28.0, 30.0, "S3"),
        ];
        let same_voice = match_rerun_speakers(&before, &rerun);
        assert_eq!(same_voice.get("S2").map(String::as_str), Some("S3"));
        let existing = db.get_speaker_aliases("r1").unwrap();
        let aliases = ["S1", "S2", "S3"]
            .iter()
            .enumerate()
            .map(|(index, id)| {
                let carried = same_voice
                    .get(*id)
                    .and_then(|old| existing.get(old))
                    .and_then(|(name, _, _)| name.as_deref())
                    .filter(|name| !is_generic_speaker_name(name));
                SpeakerAliasUpsert {
                    speaker_id: id.to_string(),
                    name: resolve_speaker_name(id, carried, None, None, index),
                    color: Some(format!("#00000{index}")),
                    sample_count: 1,
                }
            })
            .collect::<Vec<_>>();

        assert!(db
            .apply_relabelled_diarization(
                "r1",
                revision,
                &rerun,
                &aliases,
                &same_voice,
                Some("plainsong:test"),
                None,
            )
            .unwrap());

        let names = db.get_speaker_aliases("r1").unwrap();
        let name = |id: &str| names.get(id).and_then(|(name, _, _)| name.clone());
        assert_eq!(
            name("S2").as_deref(),
            Some("Ben"),
            "Ben's name follows Ben's voice"
        );
        assert_ne!(name("S3").as_deref(), Some("Ben"), "S3 is someone new");
        assert!(
            ["S1", "S2", "S3"]
                .iter()
                .all(|id| name(id).as_deref() != Some("Carol")),
            "Carol's voice folded away, so no speaker keeps her name"
        );
        let links: HashMap<String, (Option<String>, Option<String>)> = db
            .conn
            .prepare(
                "SELECT speaker_id, voice_profile_id, voice_match_state
                 FROM speaker_aliases WHERE recording_id = 'r1'",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            links.get("S2"),
            Some(&(
                Some("profile-ben".to_string()),
                Some("confirmed".to_string())
            ))
        );
        assert_eq!(links.get("S1"), Some(&(None, None)));
        assert_eq!(links.get("S3"), Some(&(None, None)));
        assert_eq!(links.len(), 3);
    }

    #[test]
    fn test_get_transcript_synthesizes_segment_from_full_text_when_segments_missing() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("r1", "inbox");
        recording.duration = 14;
        db.create_recording(&recording).unwrap();

        let transcript = Transcript {
            heard_through_speakers: Vec::new(),
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
            measured_word_timestamps: false,
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
    fn rename_recording_updates_artifact_and_visible_meeting_title() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_meeting_artifact(&sample_meeting_artifact())
            .unwrap();
        let artifact_before = db.get_meeting_artifact("r1").unwrap().unwrap();
        db.rename_recording("r1", "Design review").unwrap();
        assert_eq!(
            db.get_recording("r1").unwrap().unwrap().title,
            "Design review"
        );
        assert_eq!(db.get_recordings(None).unwrap()[0].title, "Design review");
        let artifact_after = db.get_meeting_artifact("r1").unwrap().unwrap();
        assert_eq!(artifact_after.title.as_deref(), Some("Design review"));
        assert_eq!(artifact_after.summary, artifact_before.summary);
        assert_eq!(artifact_after.action_items, artifact_before.action_items);
        assert_eq!(
            artifact_after.summary_provenance,
            artifact_before.summary_provenance
        );
        assert_eq!(
            artifact_after.action_items_provenance,
            artifact_before.action_items_provenance
        );
    }

    #[test]
    fn conditional_recording_rename_preserves_a_manual_rename() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_meeting_artifact(&sample_meeting_artifact())
            .unwrap();
        db.rename_recording("r1", "Meeting recording").unwrap();
        let observed_title = db.get_recording("r1").unwrap().unwrap().title;
        db.rename_recording("r1", "My meeting title").unwrap();

        assert!(!db
            .rename_recording_if_title_matches("r1", &observed_title, "Generated title")
            .unwrap());
        assert_eq!(
            db.get_recording("r1").unwrap().unwrap().title,
            "My meeting title"
        );
        assert_eq!(
            db.get_meeting_artifact("r1")
                .unwrap()
                .unwrap()
                .title
                .as_deref(),
            Some("My meeting title")
        );
    }

    #[test]
    fn conditional_recording_rename_updates_matching_title_and_artifact() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_meeting_artifact(&sample_meeting_artifact())
            .unwrap();
        db.rename_recording("r1", "Meeting recording").unwrap();
        let artifact_before = db.get_meeting_artifact("r1").unwrap().unwrap();
        db.conn
            .execute(
                "UPDATE recordings SET meeting_notes = 'New notes' WHERE id = 'r1'",
                [],
            )
            .unwrap();

        assert!(db
            .rename_recording_if_title_matches("r1", "Meeting recording", "Generated title")
            .unwrap());
        let raw_title: String = db
            .conn
            .query_row("SELECT title FROM recordings WHERE id = 'r1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(raw_title, "Generated title");
        assert_eq!(
            db.get_recording("r1").unwrap().unwrap().title,
            "Generated title"
        );
        let artifact_after = db.get_meeting_artifact("r1").unwrap().unwrap();
        assert_eq!(artifact_after.title.as_deref(), Some("Generated title"));
        assert_eq!(artifact_after.summary, artifact_before.summary);
        assert_eq!(artifact_after.action_items, artifact_before.action_items);
    }

    #[test]
    fn conditional_recording_rename_returns_false_for_missing_recording() {
        let mut db = in_memory_db();
        assert!(!db
            .rename_recording_if_title_matches("missing", "Meeting recording", "Generated title")
            .unwrap());
    }

    #[test]
    fn conditional_recording_rename_rolls_back_when_artifact_update_fails() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_meeting_artifact(&sample_meeting_artifact())
            .unwrap();
        db.rename_recording("r1", "Meeting recording").unwrap();
        db.conn
            .execute_batch(
                "CREATE TRIGGER reject_auto_title BEFORE UPDATE OF title ON meeting_artifacts
             BEGIN SELECT RAISE(ABORT, 'QA rejects artifact rename'); END;",
            )
            .unwrap();

        assert!(db
            .rename_recording_if_title_matches("r1", "Meeting recording", "Generated title")
            .is_err());
        let raw_title: String = db
            .conn
            .query_row("SELECT title FROM recordings WHERE id = 'r1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(raw_title, "Meeting recording");
        assert_eq!(
            db.get_meeting_artifact("r1")
                .unwrap()
                .unwrap()
                .title
                .as_deref(),
            Some("Meeting recording")
        );
    }

    #[test]
    fn meeting_action_membership_preserves_untouched_completion_and_citations() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let mut artifact = sample_meeting_artifact();
        artifact.action_items = vec!["Send deck".into(), "Book room".into()];
        artifact.action_items_provenance =
            Some(sample_action_items_provenance(&artifact.action_items));
        db.save_meeting_artifact(&artifact).unwrap();
        db.set_meeting_action_completed("r1", "Send deck", true)
            .unwrap();
        let (added, completed) = db
            .add_meeting_action(
                "r1",
                &artifact.action_items,
                "  Confirm date (Owner: Sam)  ",
            )
            .unwrap();
        assert_eq!(completed, vec!["Send deck"]);
        let added_items = added.action_items.unwrap();
        assert_eq!(added_items[2], "Confirm date (Owner: Sam)");
        let added_provenance = added.action_items_provenance.unwrap();
        assert_eq!(
            added_provenance.items[0],
            artifact.action_items_provenance.as_ref().unwrap().items[0]
        );
        assert!(!added_provenance.items[2].generated);
        assert!(added_provenance.items[2].citations.is_empty());
        let (removed, completed) = db.delete_meeting_action("r1", &added_items, 1).unwrap();
        assert_eq!(completed, vec!["Send deck"]);
        let removed_items = removed.action_items.unwrap();
        assert_eq!(
            removed_items,
            vec!["Send deck", "Confirm date (Owner: Sam)"]
        );
        assert_eq!(
            db.get_meeting_artifact("r1").unwrap().unwrap().action_items,
            removed_items
        );
        assert_eq!(
            removed.action_items_provenance.unwrap().items[0],
            added_provenance.items[0]
        );
        let (_, completed) = db.delete_meeting_action("r1", &removed_items, 0).unwrap();
        assert!(completed.is_empty());
        assert!(db.get_meeting_action_completion("r1").unwrap().is_empty());
    }

    #[test]
    fn meeting_action_membership_deletion_preserves_the_surviving_duplicate_citation() {
        for removed_index in [0, 1] {
            let mut db = in_memory_db();
            db.create_recording(&sample_recording("r1", "inbox"))
                .unwrap();
            let mut artifact = sample_meeting_artifact();
            artifact.action_items = vec!["Same".into(), "Same".into()];
            let mut provenance = sample_action_items_provenance(&artifact.action_items);
            provenance.items[0].citations[0].segment_id = Some("first-source".into());
            provenance.items[1].citations[0].segment_id = Some("second-source".into());
            let survivor = provenance.items[1 - removed_index].clone();
            artifact.action_items_provenance = Some(provenance);
            db.save_meeting_artifact(&artifact).unwrap();
            let (recording, _) = db
                .delete_meeting_action("r1", &artifact.action_items, removed_index)
                .unwrap();
            assert_eq!(
                recording.action_items_provenance.unwrap().items,
                vec![survivor]
            );
        }
    }

    #[test]
    fn full_action_save_withholds_ambiguous_duplicate_provenance() {
        for manual_index in [0, 1] {
            for next_items in [
                vec!["Same".into(), "Unique".into()],
                vec!["Unique".into(), "Same".into(), "Same".into()],
            ] {
                let mut db = in_memory_db();
                db.create_recording(&sample_recording("r1", "inbox"))
                    .unwrap();
                let mut artifact = sample_meeting_artifact();
                artifact.action_items = vec!["Same".into(), "Same".into(), "Unique".into()];
                let mut provenance = sample_action_items_provenance(&artifact.action_items);
                provenance.items[manual_index].generated = false;
                provenance.items[manual_index].grounded = false;
                provenance.items[manual_index].citations.clear();
                let unique = provenance.items[2].clone();
                artifact.action_items_provenance = Some(provenance);
                db.save_meeting_artifact(&artifact).unwrap();
                db.patch_recording_analysis("r1", None, Some(&next_items))
                    .unwrap();
                let saved = db
                    .get_recording("r1")
                    .unwrap()
                    .unwrap()
                    .action_items_provenance
                    .unwrap();
                for (text, item) in next_items.iter().zip(&saved.items) {
                    if text == "Same" {
                        assert!(!item.generated);
                        assert!(!item.grounded);
                        assert!(item.citations.is_empty());
                    } else {
                        assert_eq!(item, &unique);
                    }
                }
            }
        }
    }

    #[test]
    fn indexed_action_edit_and_add_preserve_unaffected_duplicate_slots() {
        for manual_index in [0, 1] {
            let mut db = in_memory_db();
            db.create_recording(&sample_recording("r1", "inbox"))
                .unwrap();
            let mut artifact = sample_meeting_artifact();
            artifact.action_items = vec!["Same".into(), "Same".into(), "Unique".into()];
            let mut provenance = sample_action_items_provenance(&artifact.action_items);
            provenance.items[manual_index].generated = false;
            provenance.items[manual_index].grounded = false;
            provenance.items[manual_index].citations.clear();
            provenance.items[1 - manual_index].citations[0].segment_id =
                Some("exact-source".into());
            let expected = provenance.items[..2].to_vec();
            artifact.action_items_provenance = Some(provenance);
            db.save_meeting_artifact(&artifact).unwrap();
            let (edited, _) = db
                .edit_meeting_action("r1", &artifact.action_items, 2, "Changed")
                .unwrap();
            assert_eq!(edited.action_items_provenance.unwrap().items[..2], expected);
            let (added, _) = db
                .add_meeting_action("r1", &edited.action_items.unwrap(), "Added")
                .unwrap();
            assert_eq!(added.action_items_provenance.unwrap().items[..2], expected);
        }
    }

    #[test]
    fn indexed_action_deletion_preserves_mixed_duplicate_identity_and_completion() {
        for manual_index in [0, 1] {
            for removed_index in [0, 1] {
                let mut db = in_memory_db();
                db.create_recording(&sample_recording("r1", "inbox"))
                    .unwrap();
                let mut artifact = sample_meeting_artifact();
                artifact.action_items = vec!["Same".into(), "Same".into(), "Unique".into()];
                let mut provenance = sample_action_items_provenance(&artifact.action_items);
                provenance.items[manual_index].generated = false;
                provenance.items[manual_index].grounded = false;
                provenance.items[manual_index].citations.clear();
                provenance.items[1 - manual_index].citations[0].segment_id =
                    Some("exact-source".into());
                let expected = vec![
                    provenance.items[1 - removed_index].clone(),
                    provenance.items[2].clone(),
                ];
                artifact.action_items_provenance = Some(provenance);
                db.save_meeting_artifact(&artifact).unwrap();
                db.set_meeting_action_completed("r1", "Same", true).unwrap();
                let (recording, completed) = db
                    .delete_meeting_action("r1", &artifact.action_items, removed_index)
                    .unwrap();
                assert_eq!(recording.action_items_provenance.unwrap().items, expected);
                assert_eq!(completed, vec!["Same"]);
            }
        }
    }

    #[test]
    fn meeting_action_membership_rejects_stale_invalid_and_duplicate_changes() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let artifact = sample_meeting_artifact();
        db.save_meeting_artifact(&artifact).unwrap();
        for task in ["", "  ", "First\nSecond", artifact.action_items[0].as_str()] {
            assert!(db
                .add_meeting_action("r1", &artifact.action_items, task)
                .is_err());
        }
        assert!(db.add_meeting_action("r1", &[], "New task").is_err());
        assert!(db.delete_meeting_action("r1", &[], 0).is_err());
        assert!(db
            .delete_meeting_action("r1", &artifact.action_items, artifact.action_items.len())
            .is_err());
        assert_eq!(
            db.get_recording("r1")
                .unwrap()
                .unwrap()
                .action_items
                .unwrap(),
            artifact.action_items
        );
        assert!(db.add_meeting_action("missing", &[], "New task").is_err());
        let mut dictation = sample_recording("dictation", "inbox");
        dictation.source_type = "dictation".into();
        db.create_recording(&dictation).unwrap();
        assert!(db.add_meeting_action("dictation", &[], "New task").is_err());
        assert!(db.delete_meeting_action("dictation", &[], 0).is_err());
    }

    #[test]
    fn meeting_action_membership_rolls_back_both_add_and_delete() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let artifact = sample_meeting_artifact();
        db.save_meeting_artifact(&artifact).unwrap();
        db.set_meeting_action_completed("r1", &artifact.action_items[0], true)
            .unwrap();
        db.conn.execute_batch("CREATE TRIGGER reject_task_membership BEFORE UPDATE OF action_items ON meeting_artifacts BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
        assert!(db
            .add_meeting_action("r1", &artifact.action_items, "New task")
            .is_err());
        assert!(db
            .delete_meeting_action("r1", &artifact.action_items, 0)
            .is_err());
        assert_eq!(
            db.get_recording("r1")
                .unwrap()
                .unwrap()
                .action_items
                .unwrap(),
            artifact.action_items
        );
        assert_eq!(
            db.get_meeting_action_completion("r1").unwrap(),
            vec![artifact.action_items[0].clone()]
        );
    }

    #[test]
    fn meeting_action_membership_can_remove_last_task_and_preserve_duplicate_completion() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let mut artifact = sample_meeting_artifact();
        artifact.action_items = vec!["Same".into(), "Same".into()];
        db.save_meeting_artifact(&artifact).unwrap();
        db.set_meeting_action_completed("r1", "Same", true).unwrap();
        let (recording, completed) = db
            .delete_meeting_action("r1", &artifact.action_items, 0)
            .unwrap();
        assert_eq!(completed, vec!["Same"]);
        let (recording, completed) = db
            .delete_meeting_action("r1", &recording.action_items.unwrap(), 0)
            .unwrap();
        assert!(recording.action_items.unwrap().is_empty());
        assert!(completed.is_empty());
    }

    #[test]
    fn meeting_action_edit_preserves_completion_and_matching_provenance() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let mut artifact = sample_meeting_artifact();
        artifact.action_items = vec![
            "Send deck (Owner: Jane · Due: Friday)".into(),
            "Book room".into(),
        ];
        artifact.action_items_provenance =
            Some(sample_action_items_provenance(&artifact.action_items));
        db.save_meeting_artifact(&artifact).unwrap();
        db.set_meeting_action_completed("r1", &artifact.action_items[0], true)
            .unwrap();
        let (recording, completed) = db
            .edit_meeting_action(
                "r1",
                &artifact.action_items,
                0,
                "Send deck (Owner: Sam · Due: Monday)",
            )
            .unwrap();
        assert_eq!(completed, vec!["Send deck (Owner: Sam · Due: Monday)"]);
        assert_eq!(db.get_meeting_action_completion("r1").unwrap(), completed);
        let provenance = recording.action_items_provenance.unwrap();
        assert!(!provenance.items[0].generated);
        assert!(provenance.items[0].citations.is_empty());
        assert_eq!(
            provenance.items[1],
            artifact.action_items_provenance.unwrap().items[1]
        );
        assert_eq!(
            db.get_meeting_artifact("r1").unwrap().unwrap().action_items,
            recording.action_items.unwrap()
        );
    }

    #[test]
    fn meeting_action_edit_rejects_conflicts_and_duplicate_identity() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let mut artifact = sample_meeting_artifact();
        artifact.action_items = vec!["First task".into(), "Second task".into()];
        db.save_meeting_artifact(&artifact).unwrap();
        db.set_meeting_action_completed("r1", "Second task", true)
            .unwrap();
        assert!(db
            .edit_meeting_action("r1", &["stale".into()], 0, "New task")
            .is_err());
        assert!(db
            .edit_meeting_action("r1", &artifact.action_items, 0, "Second task")
            .is_err());
        assert_eq!(
            db.get_meeting_action_completion("r1").unwrap(),
            vec!["Second task"]
        );
        assert_eq!(
            db.get_meeting_artifact("r1").unwrap().unwrap().action_items,
            artifact.action_items
        );
        artifact.action_items = vec!["Same".into(), "Same".into()];
        db.save_meeting_artifact(&artifact).unwrap();
        assert!(db
            .edit_meeting_action("r1", &artifact.action_items, 0, "Different")
            .is_err());
    }

    #[test]
    fn meeting_action_edit_rolls_back_if_artifact_write_fails() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let artifact = sample_meeting_artifact();
        db.save_meeting_artifact(&artifact).unwrap();
        db.set_meeting_action_completed("r1", &artifact.action_items[0], true)
            .unwrap();
        db.conn.execute_batch("CREATE TRIGGER reject_task_edit BEFORE UPDATE OF action_items ON meeting_artifacts BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
        assert!(db
            .edit_meeting_action("r1", &artifact.action_items, 0, "Replacement")
            .is_err());
        assert_eq!(
            db.get_recording("r1")
                .unwrap()
                .unwrap()
                .action_items
                .unwrap(),
            artifact.action_items
        );
        assert_eq!(
            db.get_meeting_action_completion("r1").unwrap(),
            vec![artifact.action_items[0].clone()]
        );
    }

    fn brief_test_target() -> crate::meeting_brief::BriefTarget {
        crate::meeting_brief::BriefTarget {
            event_id: "event".into(),
            title: "Weekly Sync".into(),
            attendees: Vec::new(),
        }
    }

    #[test]
    fn meeting_brief_candidates_completion_deduplicates_and_invalidates_cache() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let mut artifact = sample_meeting_artifact();
        artifact.action_items = vec!["Done".into(), "Done".into(), "Open".into()];
        db.save_meeting_artifact(&artifact).unwrap();
        db.set_meeting_action_completed("r1", "Done", true).unwrap();
        let target = brief_test_target();
        let related = crate::meeting_brief::related_meetings(
            &target,
            &db.meeting_brief_candidates(200).unwrap(),
        );
        assert_eq!(related[0].open_items, vec!["Open"]);
        let key = crate::meeting_brief::brief_cache_key(
            &target,
            &[],
            &crate::meeting_brief::brief_evidence_lines(&related),
        );
        db.set_meeting_action_completed("r1", "Done", false)
            .unwrap();
        let related = crate::meeting_brief::related_meetings(
            &target,
            &db.meeting_brief_candidates(200).unwrap(),
        );
        assert_eq!(related[0].open_items, vec!["Done", "Open"]);
        assert_ne!(
            key,
            crate::meeting_brief::brief_cache_key(
                &target,
                &[],
                &crate::meeting_brief::brief_evidence_lines(&related)
            )
        );
    }

    #[test]
    fn meeting_brief_candidates_retain_decision_only_source() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let mut artifact = sample_meeting_artifact();
        artifact.summary = None;
        artifact.action_items.clear();
        db.save_meeting_artifact(&artifact).unwrap();
        let related = crate::meeting_brief::related_meetings(
            &brief_test_target(),
            &db.meeting_brief_candidates(200).unwrap(),
        );
        assert_eq!(related.len(), 1);
        assert_eq!(related[0].decisions, artifact.decisions);
        assert!(related[0].needs_review);
    }

    #[test]
    fn meeting_brief_candidates_filter_dictation_before_recent_cap() {
        let mut db = in_memory_db();
        let mut meeting = sample_recording("r1", "inbox");
        meeting.created_at = Utc::now() - chrono::Duration::days(1);
        db.create_recording(&meeting).unwrap();
        db.save_meeting_artifact(&sample_meeting_artifact())
            .unwrap();
        for index in 0..201 {
            let mut dictation = sample_recording(&format!("dictation-{index}"), "inbox");
            dictation.source_type = "dictation".into();
            db.create_recording(&dictation).unwrap();
        }
        let related = crate::meeting_brief::related_meetings(
            &brief_test_target(),
            &db.meeting_brief_candidates(200).unwrap(),
        );
        assert_eq!(related[0].recording_id, "r1");
        assert_eq!(db.meeting_brief_candidates(1).unwrap().len(), 1);
    }

    #[test]
    fn meeting_brief_candidates_inherit_validated_source_review_and_cache_policy() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let mut artifact = sample_meeting_artifact();
        artifact.decisions.clear();
        artifact.summary_provenance = Some(sample_summary_provenance(
            artifact.summary.as_deref().unwrap(),
        ));
        artifact.action_items_provenance =
            Some(sample_action_items_provenance(&artifact.action_items));
        db.save_meeting_artifact(&artifact).unwrap();
        let target = brief_test_target();
        let related = crate::meeting_brief::related_meetings(
            &target,
            &db.meeting_brief_candidates(200).unwrap(),
        );
        assert!(!related[0].needs_review);
        assert!(crate::meeting_brief::brief_is_grounded(true, &related));
        let key = crate::meeting_brief::brief_cache_key(
            &target,
            &[],
            &crate::meeting_brief::brief_evidence_lines(&related),
        );
        // Current-policy labels alone do not suffice without citations or valid content identity.
        for variant in 0..4 {
            let mut provenance = sample_summary_provenance(artifact.summary.as_deref().unwrap());
            match variant {
                0 => provenance.citations.clear(),
                1 => provenance.grounding_policy_version = None,
                2 => provenance.version += 1,
                _ => provenance.content_hash = "stale".into(),
            }
            artifact.summary_provenance = Some(provenance);
            db.save_meeting_artifact(&artifact).unwrap();
            assert!(db.meeting_brief_candidates(200).unwrap()[0].needs_review);
        }
        artifact.summary_provenance = Some(sample_summary_provenance(
            artifact.summary.as_deref().unwrap(),
        ));
        artifact.summary_provenance.as_mut().unwrap().grounded = false;
        db.save_meeting_artifact(&artifact).unwrap();
        let related = crate::meeting_brief::related_meetings(
            &target,
            &db.meeting_brief_candidates(200).unwrap(),
        );
        assert!(related[0].needs_review);
        assert!(!crate::meeting_brief::brief_is_grounded(true, &related));
        assert_ne!(
            key,
            crate::meeting_brief::brief_cache_key(
                &target,
                &[],
                &crate::meeting_brief::brief_evidence_lines(&related)
            )
        );

        // Proven manual action occurrences need no generated-claim citations.
        artifact.summary = None;
        artifact.summary_provenance = None;
        let provenance = artifact.action_items_provenance.as_mut().unwrap();
        for item in &mut provenance.items {
            item.generated = false;
            item.citations.clear();
        }
        db.save_meeting_artifact(&artifact).unwrap();
        assert!(!db.meeting_brief_candidates(200).unwrap()[0].needs_review);
        // Missing legacy metadata cannot establish the same authority.
        artifact.action_items_provenance = None;
        db.save_meeting_artifact(&artifact).unwrap();
        assert!(db.meeting_brief_candidates(200).unwrap()[0].needs_review);

        artifact.action_items_provenance =
            Some(sample_action_items_provenance(&artifact.action_items));
        artifact
            .action_items_provenance
            .as_mut()
            .unwrap()
            .grounding_policy_version = None;
        db.save_meeting_artifact(&artifact).unwrap();
        assert!(db.meeting_brief_candidates(200).unwrap()[0].needs_review);
        artifact.action_items_provenance =
            Some(sample_action_items_provenance(&artifact.action_items));
        db.save_meeting_artifact(&artifact).unwrap();
        db.conn
            .execute(
                "UPDATE recordings SET transcript_complete = 0 WHERE id = 'r1'",
                [],
            )
            .unwrap();
        assert!(db.meeting_brief_candidates(200).unwrap()[0].needs_review);
    }

    #[test]
    fn meeting_action_completion_round_trips_hashes_without_changing_meeting_content() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_meeting_artifact(&sample_meeting_artifact())
            .unwrap();
        let artifact_before = db.get_meeting_artifact("r1").unwrap().unwrap();

        assert_eq!(
            db.set_meeting_action_completed("r1", "Ship onboarding polish", true)
                .unwrap(),
            vec!["Ship onboarding polish"]
        );
        assert_eq!(
            db.get_meeting_action_completion("r1").unwrap(),
            vec!["Ship onboarding polish"]
        );
        let stored: String = db
            .conn
            .query_row(
                "SELECT meeting_action_completion FROM recordings WHERE id = 'r1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!stored.contains("Ship onboarding polish"));
        assert_eq!(
            serde_json::to_value(db.get_meeting_artifact("r1").unwrap().unwrap()).unwrap(),
            serde_json::to_value(artifact_before).unwrap()
        );
        assert_eq!(
            db.get_recording("r1").unwrap().unwrap().source_type,
            "meeting"
        );
    }

    #[test]
    fn meeting_action_completion_rejects_unknown_tasks_and_prunes_replaced_items() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let mut artifact = sample_meeting_artifact();
        db.save_meeting_artifact(&artifact).unwrap();
        db.set_meeting_action_completed("r1", "Ship onboarding polish", true)
            .unwrap();

        artifact.action_items = vec!["Confirm launch checklist".to_string()];
        db.save_meeting_artifact(&artifact).unwrap();
        assert!(db
            .set_meeting_action_completed("r1", "Ship onboarding polish", false)
            .unwrap_err()
            .to_string()
            .contains("not found"));
        assert_eq!(
            db.set_meeting_action_completed("r1", "Confirm launch checklist", true)
                .unwrap(),
            vec!["Confirm launch checklist"]
        );
        let stored: String = db
            .conn
            .query_row(
                "SELECT meeting_action_completion FROM recordings WHERE id = 'r1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!stored.contains(&analysis_content_hash("Ship onboarding polish")));
    }

    #[test]
    fn meeting_followups_review_only_matching_generated_items() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let mut artifact = sample_meeting_artifact();
        artifact.action_items = vec![
            "Supported".into(),
            "Needs review".into(),
            "No citations".into(),
            "Manual edit".into(),
        ];
        let mut provenance = sample_action_items_provenance(&artifact.action_items);
        provenance.grounded = false;
        provenance.items[1].grounded = false;
        provenance.items[2].citations.clear();
        provenance.items[3].generated = false;
        provenance.items[3].grounded = false;
        provenance.items[3].citations.clear();
        artifact.action_items_provenance = Some(provenance.clone());
        db.save_meeting_artifact(&artifact).unwrap();
        // Artifact content is authoritative even if the recording copy is stale.
        db.conn
            .execute(
                "UPDATE recordings SET action_items = ?1 WHERE id = 'r1'",
                params!["[\"Stale recording task\"]"],
            )
            .unwrap();
        let page = db.list_meeting_followups(None, 0, 25, true).unwrap();
        assert_eq!(
            page.items
                .iter()
                .map(|item| item.needs_review)
                .collect::<Vec<_>>(),
            vec![false, true, true, false]
        );
        assert_eq!(page.items[0].task, "Supported");

        for policy in [
            None,
            Some(crate::models::SUMMARY_GROUNDING_POLICY_VERSION - 1),
        ] {
            provenance.grounding_policy_version = policy;
            artifact.action_items_provenance = Some(provenance.clone());
            db.save_meeting_artifact(&artifact).unwrap();
            let page = db.list_meeting_followups(None, 0, 25, true).unwrap();
            assert_eq!(
                page.items
                    .iter()
                    .map(|item| item.needs_review)
                    .collect::<Vec<_>>(),
                vec![true, true, true, false]
            );
        }
    }

    #[test]
    fn meeting_followups_combine_duplicate_occurrence_review_before_paging() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let mut artifact = sample_meeting_artifact();
        artifact.action_items = vec!["Same task".into(), "Same task".into(), "Other task".into()];
        let mut provenance = sample_action_items_provenance(&artifact.action_items);
        provenance.items[1].grounded = false;
        artifact.action_items_provenance = Some(provenance);
        db.save_meeting_artifact(&artifact).unwrap();
        let first = db.list_meeting_followups(Some("same"), 0, 1, true).unwrap();
        assert_eq!(first.items.len(), 1);
        assert_eq!(first.items[0].task, "Same task");
        assert!(first.items[0].needs_review);
        let second = db.list_meeting_followups(None, 1, 1, true).unwrap();
        assert_eq!(second.items[0].task, "Other task");
        assert!(!second.items[0].needs_review);
    }

    #[test]
    fn meeting_followups_do_not_attribute_invalid_or_absent_provenance() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let mut artifact = sample_meeting_artifact();
        artifact.action_items = vec!["Legacy or edited task".into()];
        let mut valid = sample_action_items_provenance(&artifact.action_items);
        valid.items[0].grounded = false;
        let mut wrong_list = valid.clone();
        wrong_list.content_hash = "wrong".into();
        let mut wrong_item = valid.clone();
        wrong_item.items[0].content_hash = "wrong".into();
        let mut wrong_version = valid;
        wrong_version.version += 1;
        db.save_meeting_artifact(&artifact).unwrap();
        for raw in [
            None,
            Some("malformed".to_string()),
            Some(serde_json::to_string(&wrong_list).unwrap()),
            Some(serde_json::to_string(&wrong_item).unwrap()),
            Some(serde_json::to_string(&wrong_version).unwrap()),
        ] {
            db.conn.execute("UPDATE meeting_artifacts SET action_items_provenance = ?1 WHERE recording_id = 'r1'", params![raw]).unwrap();
            let page = db.list_meeting_followups(None, 0, 25, true).unwrap();
            assert_eq!(page.items.len(), 1);
            assert!(!page.items[0].needs_review);
        }
        db.conn
            .execute(
                "DELETE FROM meeting_artifacts WHERE recording_id = 'r1'",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "UPDATE recordings SET action_items = ?1 WHERE id = 'r1'",
                params![serde_json::to_string(&artifact.action_items).unwrap()],
            )
            .unwrap();
        let legacy = db.list_meeting_followups(None, 0, 25, true).unwrap();
        assert_eq!(legacy.items.len(), 1);
        assert!(!legacy.items[0].needs_review);
    }

    #[test]
    fn meeting_followups_page_across_old_meetings_and_preserve_stored_tasks() {
        let mut db = in_memory_db();
        let base_time = Utc::now();

        for index in 0..32 {
            let recording_id = format!("meeting-{index:02}");
            let mut recording = sample_recording(&recording_id, "inbox");
            recording.title = format!("Planning {index:02}");
            recording.created_at = base_time - chrono::Duration::minutes(index);
            recording.updated_at = recording.created_at;
            db.create_recording(&recording).unwrap();

            let mut artifact = sample_meeting_artifact();
            artifact.id = format!("artifact-{index:02}");
            artifact.recording_id = recording_id;
            artifact.title = Some(recording.title.clone());
            artifact.action_items = vec![format!("Follow up {index:02}")];
            artifact.created_at = recording.created_at;
            artifact.updated_at = recording.updated_at;
            db.save_meeting_artifact(&artifact).unwrap();
        }

        let mut oldest = sample_meeting_artifact();
        oldest.id = "artifact-31".to_string();
        oldest.recording_id = "meeting-31".to_string();
        oldest.title = Some("Older customer review".to_string());
        oldest.action_items = vec![
            "Maya owns renewal by 2026-11-04".to_string(),
            "Maya owns renewal by 2026-11-04".to_string(),
            "  Preserve this stored task exactly  ".to_string(),
            "  ".to_string(),
        ];
        db.save_meeting_artifact(&oldest).unwrap();
        db.conn
            .execute(
                "UPDATE recordings SET action_items = ?1 WHERE id = ?2",
                params!["[\"Stale recording copy\"]", "meeting-31"],
            )
            .unwrap();
        db.set_meeting_action_completed("meeting-31", "Maya owns renewal by 2026-11-04", true)
            .unwrap();

        let mut dictation = sample_recording("dictation", "inbox");
        dictation.source_type = "dictation".to_string();
        dictation.created_at = base_time + chrono::Duration::minutes(1);
        db.create_recording(&dictation).unwrap();
        db.conn
            .execute(
                "UPDATE recordings SET action_items = ?1 WHERE id = ?2",
                params!["[\"Do not return this\"]", "dictation"],
            )
            .unwrap();

        let first = db.list_meeting_followups(None, 0, 30, false).unwrap();
        assert_eq!(first.items.len(), 30);
        assert_eq!(first.next_offset, Some(30));

        let second = db.list_meeting_followups(None, 30, 30, false).unwrap();
        assert_eq!(second.next_offset, None);
        assert_eq!(second.items.len(), 2);
        assert_eq!(second.items[0].recording_id, "meeting-30");
        assert_eq!(second.items[1].recording_id, "meeting-31");
        assert_eq!(
            second.items[1].task,
            "  Preserve this stored task exactly  "
        );
        assert!(!second
            .items
            .iter()
            .any(|item| item.task == "Stale recording copy"));
        assert!(!second
            .items
            .iter()
            .any(|item| item.recording_id == "dictation"));

        let completed = db
            .list_meeting_followups(Some("MAYA 2026"), 0, 30, true)
            .unwrap();
        assert_eq!(completed.items.len(), 1);
        assert!(completed.items[0].completed);
        assert_eq!(completed.items[0].meeting_title, "Older customer review");

        let hidden_completed = db
            .list_meeting_followups(Some("older CUSTOMER"), 0, 30, false)
            .unwrap();
        assert_eq!(hidden_completed.items.len(), 1);
        assert_eq!(
            hidden_completed.items[0].task,
            "  Preserve this stored task exactly  "
        );
    }

    #[test]
    fn rename_recording_rolls_back_when_artifact_title_update_fails() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_meeting_artifact(&sample_meeting_artifact())
            .unwrap();
        db.conn
            .execute_batch(
                "CREATE TRIGGER reject_title BEFORE UPDATE OF title ON meeting_artifacts
             BEGIN SELECT RAISE(ABORT, 'QA rejects artifact rename'); END;",
            )
            .unwrap();
        assert!(db.rename_recording("r1", "Design review").is_err());
        let raw_title: String = db
            .conn
            .query_row("SELECT title FROM recordings WHERE id = 'r1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(raw_title, "Recording r1");
        assert_eq!(
            db.get_recording("r1").unwrap().unwrap().title,
            "Weekly Sync"
        );
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
    fn optional_recognition_metadata_rejects_corrupt_or_unbound_hints() {
        let mut db = in_memory_db();
        let recording = sample_recording("invalid-review", "inbox");
        let history = DictationHistoryTextRecord {
            recording_id: recording.id.clone(),
            final_text: "Hello world".into(),
            raw_text: "Hello world".into(),
            reprocessed_from_id: None,
            mode_preset: None,
            created_at: Utc::now(),
        };
        db.create_dictation_history_entry(
            &recording,
            &sample_transcript(&recording.id),
            &history,
            None,
        )
        .unwrap();
        for value in [
            "bad json",
            r#"[{"word":"absent","score":0.5,"startTime":0,"endTime":1}]"#,
            r#"[{"word":"Hello","score":1.5,"startTime":0,"endTime":1}]"#,
        ] {
            db.conn.execute("UPDATE dictation_history_text SET recognition_review_words = ?1 WHERE recording_id = ?2",
                params![value, &recording.id]).unwrap();
            assert_eq!(
                db.get_dictation_recognition_review_words(&recording.id)
                    .unwrap(),
                None
            );
            assert!(db
                .get_dictation_history_text(&recording.id)
                .unwrap()
                .is_some());
        }
    }

    #[test]
    fn recognition_review_survives_formatted_storage_and_edits_but_not_source_replacement() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("recognition-review", "inbox");
        recording.source_type = "dictation".into();
        let mut transcript = sample_transcript(&recording.id);
        transcript.full_text = "Tailie text.".into();
        let history = DictationHistoryTextRecord {
            recording_id: recording.id.clone(),
            final_text: transcript.full_text.clone(),
            raw_text: "tailie text".into(),
            reprocessed_from_id: None,
            mode_preset: None,
            created_at: Utc::now(),
        };
        let words = vec![RecognitionReviewWord {
            word: "tailie".into(),
            score: 0.533,
            start_time: 1.0,
            end_time: 1.2,
        }];
        db.create_dictation_history_entry_with_recognition_review(
            &recording,
            &transcript,
            &history,
            None,
            Some(&words),
        )
        .unwrap();
        assert_eq!(
            db.get_dictation_recognition_review_words(&recording.id)
                .unwrap(),
            Some(words.clone())
        );
        db.save_dictation_edit(&recording.id, Some("Teletext."), None)
            .unwrap();
        assert_eq!(
            db.get_dictation_recognition_review_words(&recording.id)
                .unwrap(),
            Some(words)
        );
        assert_eq!(
            db.get_dictation_history_text(&recording.id)
                .unwrap()
                .unwrap()
                .raw_text,
            "tailie text"
        );
        let tx = db.conn.transaction().unwrap();
        let replacement = DictationHistoryTextRecord {
            raw_text: "teletext".into(),
            ..history
        };
        Database::write_dictation_history_text_transaction(&tx, &replacement).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            db.get_dictation_recognition_review_words(&recording.id)
                .unwrap(),
            None
        );
    }

    #[test]
    fn dictation_edit_round_trip_preserves_text_and_can_reset() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("dictation-edit", "inbox");
        recording.source_type = "dictation".to_string();
        db.create_recording(&recording).unwrap();
        db.save_transcript(&sample_transcript("dictation-edit"))
            .unwrap();

        let corrected = "  Keep exact spacing.\n\nAnd paragraphs.  ";
        assert_eq!(
            db.save_dictation_edit("dictation-edit", Some(corrected), None)
                .unwrap()
                .as_deref(),
            Some(corrected)
        );
        assert_eq!(
            db.get_dictation_edit("dictation-edit").unwrap().as_deref(),
            Some(corrected)
        );
        assert_eq!(
            db.save_dictation_edit("dictation-edit", None, Some(corrected))
                .unwrap(),
            None
        );
        assert_eq!(db.get_dictation_edit("dictation-edit").unwrap(), None);
        assert_eq!(
            db.get_transcript("dictation-edit")
                .unwrap()
                .unwrap()
                .full_text,
            "Hello world"
        );
    }

    #[test]
    fn dictation_edit_compare_and_swap_preserves_the_saved_text_on_conflict() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("dictation-conflict", "inbox");
        recording.source_type = "dictation".to_string();
        db.create_recording(&recording).unwrap();
        db.save_dictation_edit("dictation-conflict", Some("first edit"), None)
            .unwrap();
        assert_eq!(
            db.save_dictation_edit("dictation-conflict", Some("first edit"), None)
                .unwrap(),
            Some("first edit".to_string()),
            "retrying an unknown save outcome is idempotent"
        );

        let error = db
            .save_dictation_edit(
                "dictation-conflict",
                Some("stale replacement"),
                Some("older edit"),
            )
            .unwrap_err();
        assert!(error.to_string().contains("conflict"));
        assert_eq!(
            db.get_dictation_edit("dictation-conflict").unwrap(),
            Some("first edit".to_string())
        );
    }

    #[test]
    fn dictation_edits_reject_wrong_recording_type_and_oversized_text() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("meeting-edit", "inbox"))
            .unwrap();
        assert!(db
            .save_dictation_edit("meeting-edit", Some("text"), None)
            .unwrap_err()
            .to_string()
            .contains("not a dictation"));

        let mut dictation = sample_recording("large-edit", "inbox");
        dictation.source_type = "dictation".to_string();
        db.create_recording(&dictation).unwrap();
        let oversized = "x".repeat(1024 * 1024 + 1);
        assert!(db
            .save_dictation_edit("large-edit", Some(&oversized), None)
            .unwrap_err()
            .to_string()
            .contains("1 MiB"));
        assert_eq!(db.get_dictation_edit("large-edit").unwrap(), None);
    }

    #[test]
    fn dictation_drafts_preserve_exact_text_and_clear_only_the_expected_revision() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("dictation-draft", "inbox");
        recording.source_type = "dictation".to_string();
        recording.title = "Draft title".to_string();
        db.create_recording(&recording).unwrap();

        let draft = "  Keep exact spacing.\n\nAnd paragraphs.  ";
        db.save_dictation_draft("dictation-draft", Some(draft), Some("saved base"))
            .unwrap();
        let first_draft_updated_at: Option<i64> = db
            .conn
            .query_row(
                "SELECT dictation_draft_updated_at FROM recordings
                 WHERE id = 'dictation-draft'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(first_draft_updated_at.is_some());
        assert_eq!(
            db.list_dictation_drafts().unwrap(),
            vec![DictationDraft {
                recording_id: "dictation-draft".to_string(),
                title: "Draft title".to_string(),
                text: draft.to_string(),
                expected_saved_text: Some("saved base".to_string()),
            }]
        );

        db.save_dictation_draft("dictation-draft", Some(""), None)
            .unwrap();
        assert!(!db.clear_dictation_draft("dictation-draft", draft).unwrap());
        assert_eq!(db.list_dictation_drafts().unwrap()[0].text, "");
        let current_draft_updated_at: Option<i64> = db
            .conn
            .query_row(
                "SELECT dictation_draft_updated_at FROM recordings
                 WHERE id = 'dictation-draft'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(current_draft_updated_at.is_some());
        assert!(current_draft_updated_at >= first_draft_updated_at);
        assert!(db.clear_dictation_draft("dictation-draft", "").unwrap());
        assert!(db.list_dictation_drafts().unwrap().is_empty());

        db.save_dictation_draft("dictation-draft", Some("temporary"), Some("base"))
            .unwrap();
        db.save_dictation_draft("dictation-draft", None, Some("ignored"))
            .unwrap();
        let stored: (Option<String>, Option<String>, Option<i64>) = db
            .conn
            .query_row(
                "SELECT dictation_draft_text, dictation_draft_base_edit,
                        dictation_draft_updated_at
                 FROM recordings WHERE id = 'dictation-draft'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(stored, (None, None, None));
    }

    fn speaker_turn_expectations(ids: &[&str]) -> Vec<TranscriptSegmentExpectation> {
        sample_multi_segment_transcript("r1")
            .segments
            .iter()
            .filter(|segment| ids.contains(&segment.id.as_str()))
            .map(deletion_expectation)
            .collect()
    }

    #[test]
    fn atomic_speaker_turn_edit_rejects_stale_and_mismatched_expectations() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_transcript(&sample_multi_segment_transcript("r1"))
            .unwrap();
        let expected = speaker_turn_expectations(&["s1"]);
        db.edit_transcript_speaker_turn(
            "r1",
            &["s2".into()],
            "Unrelated edit",
            &speaker_turn_expectations(&["s2"]),
        )
        .unwrap();
        db.edit_transcript_speaker_turn("r1", &["s1".into()], "First correction", &expected)
            .unwrap();
        let (before, revision) = db.get_transcript_with_revision("r1").unwrap().unwrap();
        for invalid in [expected, vec![], speaker_turn_expectations(&["s2"])] {
            let error = db
                .edit_transcript_speaker_turn("r1", &["s1".into()], "Stale correction", &invalid)
                .unwrap_err();
            assert!(error.to_string().contains("Transcript changed"));
            let (after, after_revision) = db.get_transcript_with_revision("r1").unwrap().unwrap();
            assert_eq!(after.full_text, before.full_text);
            assert_eq!(after_revision, revision);
        }
        assert_eq!(before.segments[1].text, "Unrelated edit");
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
            &speaker_turn_expectations(&["s2", "s3"]),
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
        // The edited turn still covers s3's audio, not just s2's.
        assert_eq!(updated.segments[1].end_time, 3.0);
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
            .edit_transcript_speaker_turn(
                "r1",
                &["s1".to_string()],
                "   \n",
                &speaker_turn_expectations(&["s1"]),
            )
            .expect_err("blank speaker-turn text must fail");
        assert!(blank.to_string().contains("cannot be blank"));
        let missing = db
            .edit_transcript_speaker_turn(
                "r1",
                &["missing".to_string()],
                "replacement",
                &speaker_turn_expectations(&["missing"]),
            )
            .expect_err("missing segment IDs must fail");
        assert!(missing.to_string().contains("Transcript changed"));
        let duplicate_request = db
            .edit_transcript_speaker_turn(
                "r1",
                &["s1".to_string(), "s1".to_string()],
                "replacement",
                &speaker_turn_expectations(&["s1"]),
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
            .edit_transcript_speaker_turn(
                "r1",
                &["s1".to_string()],
                "replacement",
                &speaker_turn_expectations(&["s1"]),
            )
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
        refuse_transcript_index_writes(&db);

        let error = db
            .edit_transcript_speaker_turn(
                "r1",
                &["s2".to_string(), "s3".to_string()],
                "corrected speaker turn",
                &speaker_turn_expectations(&["s2", "s3"]),
            )
            .expect_err("FTS failure must roll back the speaker-turn edit");
        assert!(matches!(error.downcast_ref::<rusqlite::Error>(),
            Some(rusqlite::Error::SqliteFailure(code, _)) if code.code == rusqlite::ErrorCode::ConstraintViolation));

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
            .apply_diarization_enrichment("r1", revision, &diarized.segments, &[], None, None)
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
            heard_through_speakers: Vec::new(),
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
            measured_word_timestamps: false,
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
    fn guarded_transcript_delete_succeeds_and_rebuilds_fts() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let transcript = sample_multi_segment_transcript("r1");
        let expected = vec![deletion_expectation(&transcript.segments[0])];
        db.save_transcript(&transcript).unwrap();
        db.conn
            .execute("UPDATE recordings SET duration = NULL WHERE id = 'r1'", [])
            .unwrap();

        let removed = db
            .delete_transcript_segments_guarded("r1", &["s1".to_string()], &expected)
            .unwrap();

        assert_eq!(removed, 1);
        let stored = db.get_transcript("r1").unwrap().unwrap();
        assert_eq!(stored.segments.len(), 3);
        assert!(stored.segments.iter().all(|segment| segment.id != "s1"));
        assert!(db.search_transcripts("first", 10, None).unwrap().is_empty());
        assert_eq!(db.search_transcripts("second", 10, None).unwrap().len(), 1);
    }

    #[test]
    fn guarded_transcript_delete_supports_full_text_only_legacy_rows() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let mut transcript = sample_multi_segment_transcript("r1");
        transcript.segments.clear();
        transcript.full_text = "legacy full text".to_string();
        db.save_transcript(&transcript).unwrap();
        db.conn
            .execute("UPDATE recordings SET duration = NULL WHERE id = 'r1'", [])
            .unwrap();
        let synthesized = db.get_transcript("r1").unwrap().unwrap().segments;
        assert_eq!(synthesized.len(), 1);
        assert_eq!(synthesized[0].end_time, 0.0);
        let expected = vec![deletion_expectation(&synthesized[0])];

        assert_eq!(
            db.delete_transcript_segments_guarded("r1", &["r1-full-text".to_string()], &expected,)
                .unwrap(),
            1
        );
        let stored = db.get_transcript("r1").unwrap().unwrap();
        assert!(stored.segments.is_empty());
        assert!(stored.full_text.is_empty());
        assert!(db
            .search_transcripts("legacy", 10, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn guarded_transcript_delete_rejects_changed_quoted_text() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let transcript = sample_multi_segment_transcript("r1");
        let expected = vec![deletion_expectation(&transcript.segments[0])];
        db.save_transcript(&transcript).unwrap();
        db.update_transcript_segment("r1", "s1", "changed first segment")
            .unwrap();

        let error = db
            .delete_transcript_segments_guarded("r1", &["s1".to_string()], &expected)
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Transcript changed. Review the current turn before deleting it."
        );
        let stored = db.get_transcript("r1").unwrap().unwrap();
        assert_eq!(stored.segments.len(), 4);
        assert_eq!(stored.segments[0].text, "changed first segment");
    }

    #[test]
    fn guarded_transcript_delete_is_all_or_nothing_when_a_row_is_missing() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let transcript = sample_multi_segment_transcript("r1");
        let expected = vec![
            deletion_expectation(&transcript.segments[0]),
            deletion_expectation(&transcript.segments[1]),
        ];
        db.save_transcript(&transcript).unwrap();
        db.delete_transcript_segments("r1", &["s2".to_string()])
            .unwrap();

        assert!(db
            .delete_transcript_segments_guarded(
                "r1",
                &["s1".to_string(), "s2".to_string()],
                &expected,
            )
            .is_err());
        let stored = db.get_transcript("r1").unwrap().unwrap();
        assert!(stored.segments.iter().any(|segment| segment.id == "s1"));
        assert!(stored.segments.iter().all(|segment| segment.id != "s2"));
    }

    #[test]
    fn guarded_transcript_delete_rejects_changed_timing_or_speaker() {
        for mutation in ["timing", "speaker"] {
            let mut db = in_memory_db();
            db.create_recording(&sample_recording("r1", "inbox"))
                .unwrap();
            let transcript = sample_multi_segment_transcript("r1");
            let expected = vec![deletion_expectation(&transcript.segments[0])];
            db.save_transcript(&transcript).unwrap();
            let mut changed = transcript.segments.clone();
            if mutation == "timing" {
                changed[0].end_time += 0.25;
            } else {
                changed[0].speaker_id = Some("speaker_9".to_string());
            }
            db.update_transcript_segments("r1", &changed).unwrap();

            assert!(db
                .delete_transcript_segments_guarded("r1", &["s1".to_string()], &expected)
                .is_err());
            assert_eq!(db.get_transcript("r1").unwrap().unwrap().segments.len(), 4);
        }
    }

    #[test]
    fn guarded_transcript_delete_allows_unrelated_edits_and_rejects_bad_expectation_sets() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let transcript = sample_multi_segment_transcript("r1");
        let expected = vec![deletion_expectation(&transcript.segments[0])];
        db.save_transcript(&transcript).unwrap();
        db.update_transcript_segment("r1", "s4", "unrelated edit retained")
            .unwrap();

        assert!(db
            .delete_transcript_segments_guarded("r1", &[], &[])
            .is_err());
        assert!(db
            .delete_transcript_segments_guarded(
                "r1",
                &["s1".to_string(), "s1".to_string()],
                &expected,
            )
            .is_err());
        assert!(db
            .delete_transcript_segments_guarded("r1", &["s1".to_string()], &[])
            .is_err());

        assert_eq!(
            db.delete_transcript_segments_guarded("r1", &["s1".to_string()], &expected)
                .unwrap(),
            1
        );
        let stored = db.get_transcript("r1").unwrap().unwrap();
        assert_eq!(
            stored.segments.last().unwrap().text,
            "unrelated edit retained"
        );
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
        db.replace_generated_summary_with_undo(
            "r1",
            Some("Reviewed roadmap and launch blockers."),
            "Generated",
            &sample_summary_provenance("Generated"),
            "input-1",
        )
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
        for table in [
            "transcript_artifacts",
            "insertion_actions",
            "summary_regeneration_undo",
        ] {
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
                     recording_id, speaker_id, name, sample_count, updated_at,
                     voice_centroid, voice_centroid_model_id
                 ) VALUES (
                     'recording-1', 'speaker-1', 'Private Person', 1, '2026-01-01',
                     X'0000803F', 'ecapa_tdnn_speaker'
                 );
                 INSERT INTO speaker_profiles (
                     id, display_name, embedding_model_id, centroid, sample_count,
                     created_at, updated_at
                 ) VALUES (
                     'profile-1', 'Private Person', 'ecapa_tdnn_speaker', X'0000803F', 1,
                     '2026-01-01', '2026-01-01'
                 );
                 INSERT INTO speaker_profile_samples (
                     id, profile_id, embedding, source_recording_id, created_at
                 ) VALUES (
                     'sample-1', 'profile-1', X'0000803F', 'recording-1', '2026-01-01'
                 );
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

        // This table is created lazily by a rebuild, so seed it before reset.
        db.begin_embedding_rebuild().unwrap();
        db.stage_embedding(
            "reset-fixture",
            "recording-1",
            "segment-1",
            "private staged text",
            &[0.0],
            "test",
            0.0,
            1.0,
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
        const INTENTIONALLY_PRESERVED_APPLICATION_TABLES: [&str; 2] = [
            "semantic_recall_revision",
            "dictation_dictionary_revision_clock",
        ];
        const FTS5_IMPLEMENTATION_TABLES: [&str; 10] = [
            "dictation_history_fts_config",
            "dictation_history_fts_content",
            "dictation_history_fts_data",
            "dictation_history_fts_docsize",
            "dictation_history_fts_idx",
            "transcript_fts_config",
            "transcript_fts_content",
            "transcript_fts_data",
            "transcript_fts_docsize",
            "transcript_fts_idx",
        ];

        let db = in_memory_db();
        db.begin_embedding_rebuild().unwrap();
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

        let hits = db.search_embeddings(&[1.0, 0.0], 10, "m").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].recording_id, "r1");
        assert_eq!(hits[0].recording_title, "Recording r1");
    }

    #[test]
    fn scoped_transcript_search_filters_before_limit_and_keeps_unscoped_behavior() {
        let mut db = in_memory_db();
        let current_texts = vec!["launch current"; 40];
        db.create_recording(&sample_recording("current", "inbox"))
            .unwrap();
        db.save_transcript(&transcript_with_texts("current", &current_texts))
            .unwrap();

        db.create_recording(&sample_recording("prior-meeting", "inbox"))
            .unwrap();
        db.save_transcript(&transcript_with_texts(
            "prior-meeting",
            &["launch decision from last week"],
        ))
        .unwrap();

        let mut dictation = sample_recording("prior-dictation", "inbox");
        dictation.source_type = "dictation".to_string();
        db.create_recording(&dictation).unwrap();
        db.save_transcript(&transcript_with_texts(
            "prior-dictation",
            &["launch reminder dictated earlier"],
        ))
        .unwrap();

        let scoped = db
            .search_transcripts_with_scope("launch", 1, Some("current"), Some("meeting"))
            .unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].recording_id, "prior-meeting");

        let unscoped = db.search_transcripts("launch", 100, None).unwrap();
        assert_eq!(unscoped.len(), 42);
        assert!(unscoped
            .iter()
            .any(|hit| hit.recording_id == "prior-dictation"));
    }

    #[test]
    fn scoped_transcript_like_fallback_applies_filters_before_truncation() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("current", "inbox"))
            .unwrap();
        db.save_transcript(&transcript_with_texts(
            "current",
            &vec!["roadmap current"; 40],
        ))
        .unwrap();
        db.create_recording(&sample_recording("prior-meeting", "inbox"))
            .unwrap();
        db.save_transcript(&transcript_with_texts(
            "prior-meeting",
            &["roadmap from last week"],
        ))
        .unwrap();
        let mut dictation = sample_recording("prior-dictation", "inbox");
        dictation.source_type = "dictation".to_string();
        db.create_recording(&dictation).unwrap();
        db.save_transcript(&transcript_with_texts(
            "prior-dictation",
            &["roadmap dictated note"],
        ))
        .unwrap();
        db.conn.execute("DROP TABLE transcript_fts", []).unwrap();

        let scoped = db
            .search_transcripts_with_scope("roadmap", 1, Some("current"), Some("meeting"))
            .unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].recording_id, "prior-meeting");
    }

    #[test]
    fn project_source_transcript_search_filters_before_limit_and_none_is_global() {
        let mut db = in_memory_db();
        for index in 0..30 {
            let id = format!("dictation-{index:02}");
            let mut recording = sample_recording(&id, "inbox");
            recording.source_type = "dictation".to_string();
            db.create_recording(&recording).unwrap();
            db.save_transcript(&transcript_with_texts(
                &id,
                &["scopeword scopeword scopeword"],
            ))
            .unwrap();
        }
        db.create_recording(&sample_recording("only-meeting", "inbox"))
            .unwrap();
        db.save_transcript(&transcript_with_texts(
            "only-meeting",
            &["scopeword meeting decision"],
        ))
        .unwrap();

        let meetings = db
            .search_transcripts_with_project_scope("scopeword", 1, None, Some("meeting"))
            .unwrap();
        assert_eq!(meetings.len(), 1);
        assert_eq!(meetings[0].recording_id, "only-meeting");

        let global = db
            .search_transcripts_with_project_scope("scopeword", 25, None, None)
            .unwrap();
        assert_eq!(global.len(), 25);
        assert!(global
            .iter()
            .any(|hit| hit.recording_id.starts_with("dictation-")));
    }

    #[test]
    fn project_source_transcript_search_preserves_project_scope() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("allowed-meeting", "allowed"))
            .unwrap();
        db.save_transcript(&transcript_with_texts(
            "allowed-meeting",
            &["projectscope decision"],
        ))
        .unwrap();
        db.create_recording(&sample_recording("other-meeting", "other"))
            .unwrap();
        db.save_transcript(&transcript_with_texts(
            "other-meeting",
            &["projectscope decision"],
        ))
        .unwrap();
        let mut dictation = sample_recording("allowed-dictation", "allowed");
        dictation.source_type = "dictation".to_string();
        db.create_recording(&dictation).unwrap();
        db.save_transcript(&transcript_with_texts(
            "allowed-dictation",
            &["projectscope dictated"],
        ))
        .unwrap();

        let projects = vec!["allowed".to_string()];
        let hits = db
            .search_transcripts_with_project_scope(
                "projectscope",
                25,
                Some(&projects),
                Some("meeting"),
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].recording_id, "allowed-meeting");
    }

    #[test]
    fn project_source_transcript_like_fallback_filters_before_limit() {
        let mut db = in_memory_db();
        for index in 0..30 {
            let id = format!("fallback-dictation-{index:02}");
            let mut recording = sample_recording(&id, "inbox");
            recording.source_type = "dictation".to_string();
            db.create_recording(&recording).unwrap();
            db.save_transcript(&transcript_with_texts(
                &id,
                &["fallbackscope fallbackscope"],
            ))
            .unwrap();
        }
        db.create_recording(&sample_recording("fallback-meeting", "inbox"))
            .unwrap();
        db.save_transcript(&transcript_with_texts(
            "fallback-meeting",
            &["fallbackscope meeting"],
        ))
        .unwrap();
        db.conn.execute("DROP TABLE transcript_fts", []).unwrap();

        let hits = db
            .search_transcripts_with_project_scope("fallbackscope", 1, None, Some("meeting"))
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].recording_id, "fallback-meeting");
    }

    #[test]
    fn status_scoped_transcript_search_filters_before_limit_and_none_is_global() {
        let mut db = in_memory_db();
        for index in 0..30 {
            let id = format!("failed-meeting-{index:02}");
            let mut recording = sample_recording(&id, "inbox");
            recording.status = "error".to_string();
            db.create_recording(&recording).unwrap();
            db.save_transcript(&transcript_with_texts(
                &id,
                &["statusscope statusscope statusscope"],
            ))
            .unwrap();
        }
        let mut ready_meeting = sample_recording("ready-meeting", "inbox");
        ready_meeting.status = "completed".to_string();
        db.create_recording(&ready_meeting).unwrap();
        db.save_transcript(&transcript_with_texts(
            "ready-meeting",
            &["statusscope ready decision"],
        ))
        .unwrap();

        let ready = db
            .search_transcripts_with_filters(
                "statusscope",
                1,
                None,
                Some("meeting"),
                Some("completed"),
            )
            .unwrap();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].recording_id, "ready-meeting");

        let global = db
            .search_transcripts_with_filters("statusscope", 25, None, None, None)
            .unwrap();
        assert_eq!(global.len(), 25);
        assert!(global
            .iter()
            .any(|hit| hit.recording_id.starts_with("failed-meeting-")));
    }

    #[test]
    fn status_scoped_transcript_search_combines_project_source_and_status() {
        let mut db = in_memory_db();
        let mut allowed_ready = sample_recording("allowed-ready", "allowed");
        allowed_ready.status = "completed".to_string();
        db.create_recording(&allowed_ready).unwrap();
        db.save_transcript(&transcript_with_texts(
            "allowed-ready",
            &["combinedscope decision"],
        ))
        .unwrap();
        let mut other_ready = sample_recording("other-ready", "other");
        other_ready.status = "completed".to_string();
        db.create_recording(&other_ready).unwrap();
        db.save_transcript(&transcript_with_texts(
            "other-ready",
            &["combinedscope decision"],
        ))
        .unwrap();
        let mut failed = sample_recording("allowed-failed", "allowed");
        failed.status = "error".to_string();
        db.create_recording(&failed).unwrap();
        db.save_transcript(&transcript_with_texts(
            "allowed-failed",
            &["combinedscope failed"],
        ))
        .unwrap();
        let mut dictation = sample_recording("allowed-dictation", "allowed");
        dictation.source_type = "dictation".to_string();
        db.create_recording(&dictation).unwrap();
        db.save_transcript(&transcript_with_texts(
            "allowed-dictation",
            &["combinedscope dictated"],
        ))
        .unwrap();

        let projects = vec!["allowed".to_string()];
        let hits = db
            .search_transcripts_with_filters(
                "combinedscope",
                25,
                Some(&projects),
                Some("meeting"),
                Some("completed"),
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].recording_id, "allowed-ready");
    }

    #[test]
    fn status_scoped_transcript_like_fallback_filters_before_limit() {
        let mut db = in_memory_db();
        for index in 0..30 {
            let id = format!("fallback-failed-{index:02}");
            let mut recording = sample_recording(&id, "inbox");
            recording.status = "error".to_string();
            db.create_recording(&recording).unwrap();
            db.save_transcript(&transcript_with_texts(
                &id,
                &["statusfallback statusfallback"],
            ))
            .unwrap();
        }
        let mut fallback_ready = sample_recording("fallback-ready", "inbox");
        fallback_ready.status = "completed".to_string();
        db.create_recording(&fallback_ready).unwrap();
        db.save_transcript(&transcript_with_texts(
            "fallback-ready",
            &["statusfallback ready"],
        ))
        .unwrap();
        db.conn.execute("DROP TABLE transcript_fts", []).unwrap();

        let hits = db
            .search_transcripts_with_filters(
                "statusfallback",
                1,
                None,
                Some("meeting"),
                Some("completed"),
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].recording_id, "fallback-ready");
    }

    #[test]
    fn scoped_embedding_search_filters_candidates_before_scoring_and_limit() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("current", "inbox"))
            .unwrap();
        db.create_recording(&sample_recording("prior-meeting", "inbox"))
            .unwrap();
        let mut dictation = sample_recording("prior-dictation", "inbox");
        dictation.source_type = "dictation".to_string();
        db.create_recording(&dictation).unwrap();

        db.save_embedding("current", "s1", "current best", &[1.0, 0.0], "m", 0.0, 1.0)
            .unwrap();
        db.save_embedding(
            "prior-dictation",
            "s2",
            "dictation second",
            &[0.99, 0.01],
            "m",
            0.0,
            1.0,
        )
        .unwrap();
        db.save_embedding(
            "prior-meeting",
            "s3",
            "meeting answer",
            &[0.8, 0.2],
            "m",
            0.0,
            1.0,
        )
        .unwrap();

        let scoped = db
            .search_embeddings_with_scope(&[1.0, 0.0], 1, "m", Some("current"), Some("meeting"))
            .unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].recording_id, "prior-meeting");

        let unscoped = db.search_embeddings(&[1.0, 0.0], 3, "m").unwrap();
        assert_eq!(unscoped.len(), 3);
        assert_eq!(unscoped[0].recording_id, "current");
    }

    #[test]
    fn scoped_embedding_availability_ignores_ineligible_vectors() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("current", "inbox"))
            .unwrap();
        db.save_embedding(
            "current",
            "s1",
            "current meeting",
            &[1.0, 0.0],
            "m",
            0.0,
            1.0,
        )
        .unwrap();

        assert!(db.has_embeddings_with_scope("m", None, None).unwrap());
        assert!(!db
            .has_embeddings_with_scope("m", Some("current"), Some("meeting"))
            .unwrap());

        let mut dictation = sample_recording("prior-dictation", "inbox");
        dictation.source_type = "dictation".to_string();
        db.create_recording(&dictation).unwrap();
        db.save_embedding(
            "prior-dictation",
            "s2",
            "dictated note",
            &[1.0, 0.0],
            "m",
            0.0,
            1.0,
        )
        .unwrap();

        assert!(!db
            .has_embeddings_with_scope("m", Some("current"), Some("meeting"))
            .unwrap());
        assert!(db.has_embeddings_with_scope("m", None, None).unwrap());

        db.create_recording(&sample_recording("prior-meeting", "inbox"))
            .unwrap();
        db.save_embedding(
            "prior-meeting",
            "s3",
            "earlier meeting",
            &[0.8, 0.2],
            "m",
            0.0,
            1.0,
        )
        .unwrap();

        assert!(db
            .has_embeddings_with_scope("m", Some("current"), Some("meeting"))
            .unwrap());
        assert!(!db
            .has_embeddings_with_scope("other-model", None, None)
            .unwrap());
    }

    fn semantic_scan_scope() -> EmbeddingSearchScope {
        EmbeddingSearchScope {
            model: "m".to_string(),
            dimensions: 2,
            exclude_recording_id: None,
            source_type: None,
        }
    }

    fn semantic_scan_fixture() -> Database {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_embedding("r1", "s1", "best", &[1.0, 0.0], "m", 0.0, 1.0)
            .unwrap();
        db
    }

    #[test]
    fn semantic_revision_reseeds_an_empty_singleton_at_startup() {
        let db = in_memory_db();
        db.conn
            .execute_batch(
                "DROP TRIGGER semantic_revision_no_delete;
                 DELETE FROM semantic_recall_revision;",
            )
            .unwrap();
        assert!(verify_semantic_revision(&db.conn).is_err());
        initialize_semantic_revision(&db.conn).unwrap();
        assert_eq!(verify_semantic_revision(&db.conn).unwrap(), 0);
        initialize_semantic_revision(&db.conn).unwrap();
        assert_eq!(verify_semantic_revision(&db.conn).unwrap(), 0);
    }

    #[test]
    fn semantic_scan_finds_best_before_old_50000_cutoff() {
        let db = semantic_scan_fixture();
        db.conn
            .execute_batch(
                "WITH RECURSIVE n(x) AS (
            VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 50000
        ) INSERT INTO transcript_embeddings
            (recording_id, segment_id, text, embedding, model, start_time, end_time, created_at)
            SELECT 'r1', 'duplicate', 'newer', x'000000000000803f', 'm', 0, 1,
                   '9999-01-01' FROM n;",
            )
            .unwrap();
        let hits = db.search_embeddings(&[1.0, 0.0], 1, "m").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "best");
        assert_eq!(hits[0].score, 1.0);
    }

    #[test]
    fn semantic_scan_pages_negative_ids_and_deterministic_duplicate_ties() {
        let db = semantic_scan_fixture();
        db.conn
            .execute("DELETE FROM transcript_embeddings", [])
            .unwrap();
        for id in -2..=(EMBEDDING_PAGE_ROWS as i64 + 2) {
            db.conn.execute("INSERT INTO transcript_embeddings
                (id, recording_id, segment_id, text, embedding, model, start_time, end_time, created_at)
                VALUES (?1, 'r1', 'duplicate', ?2, ?3, 'm', 0, 1, 'same')",
                params![id, id.to_string(), f32_slice_to_blob(&[1.0, 0.0])]).unwrap();
        }
        let scope = semantic_scan_scope();
        let token = db.begin_embedding_scan(&scope).unwrap();
        let first = db.read_embedding_scan_page(&scope, &token, None).unwrap();
        assert_eq!(first.rows.len(), EMBEDDING_PAGE_ROWS);
        assert_eq!(first.rows[0].id, -2);
        assert!(!first.exhausted);
        let second = db
            .read_embedding_scan_page(&scope, &token, first.next_cursor)
            .unwrap();
        assert!(second.exhausted);
        assert_eq!(second.rows.len(), 5);
        assert_eq!(second.rows[0].id, first.next_cursor.unwrap() + 1);
        db.validate_embedding_scan(&token).unwrap();
        let hits = db.search_embeddings(&[1.0, 0.0], 2, "m").unwrap();
        assert_eq!(hits[0].text, (EMBEDDING_PAGE_ROWS + 2).to_string());
        assert_eq!(hits[1].text, (EMBEDDING_PAGE_ROWS + 1).to_string());
    }

    #[test]
    fn semantic_scan_filters_model_dimensions_scope_and_deleted_before_paging() {
        let mut db = semantic_scan_fixture();
        db.create_recording(&sample_recording("r2", "inbox"))
            .unwrap();
        db.conn
            .execute(
                "UPDATE recordings SET source_type = 'meeting' WHERE id = 'r2'",
                [],
            )
            .unwrap();
        db.save_embedding("r2", "s2", "eligible", &[1.0, 0.0], "m", 0.0, 1.0)
            .unwrap();
        db.save_embedding("r2", "s2", "wrong model", &[1.0, 0.0], "other", 0.0, 1.0)
            .unwrap();
        db.save_embedding("r2", "s2", "wrong dimensions", &[1.0], "m", 0.0, 1.0)
            .unwrap();
        db.save_embedding("orphan", "s3", "deleted", &[1.0, 0.0], "m", 0.0, 1.0)
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO transcript_embeddings
            (recording_id, segment_id, text, embedding, model, created_at)
            VALUES ('r2', 'bad', 'trailing bytes', x'0000803f0000000000', 'm', 'same')",
                [],
            )
            .unwrap();
        let mut scope = semantic_scan_scope();
        scope.exclude_recording_id = Some("r1".to_string());
        scope.source_type = Some("meeting".to_string());
        let token = db.begin_embedding_scan(&scope).unwrap();
        let page = db.read_embedding_scan_page(&scope, &token, None).unwrap();
        assert!(page.exhausted);
        assert_eq!(page.rows.len(), 1);
        assert_eq!(page.rows[0].hit.text, "eligible");
    }

    #[test]
    fn semantic_scan_byte_budget_returns_partial_page_and_rejects_oversized_candidate() {
        let db = semantic_scan_fixture();
        let text = "x".repeat(EMBEDDING_PAGE_BYTES / 2);
        for _ in 0..2 {
            db.save_embedding("r1", "large", &text, &[1.0, 0.0], "m", 0.0, 1.0)
                .unwrap();
        }
        let scope = semantic_scan_scope();
        let token = db.begin_embedding_scan(&scope).unwrap();
        let page = db.read_embedding_scan_page(&scope, &token, None).unwrap();
        assert_eq!(page.rows.len(), 2);
        assert!(!page.exhausted);
        let page = db
            .read_embedding_scan_page(&scope, &token, page.next_cursor)
            .unwrap();
        assert_eq!(page.rows.len(), 1);
        assert!(page.exhausted);
        db.conn
            .execute(
                "UPDATE transcript_embeddings SET text = CAST(zeroblob(?1) AS TEXT)
            WHERE segment_id = 's1'",
                [EMBEDDING_PAGE_BYTES as i64 + 1],
            )
            .unwrap();
        let token = db.begin_embedding_scan(&scope).unwrap();
        let error = db
            .read_embedding_scan_page(&scope, &token, None)
            .unwrap_err();
        assert!(error.to_string().contains("resource limit"));
        // Even a malicious huge wrong-size blob is filtered without loading it.
        db.conn
            .execute(
                "UPDATE transcript_embeddings SET embedding = zeroblob(?1)
            WHERE segment_id = 's1'",
                [EMBEDDING_PAGE_BYTES as i64 * 2],
            )
            .unwrap();
        let token = db.begin_embedding_scan(&scope).unwrap();
        assert!(db.read_embedding_scan_page(&scope, &token, None).is_ok());
    }

    #[test]
    fn semantic_scan_invalid_floats_and_times_cannot_reach_hits() {
        let db = semantic_scan_fixture();
        db.save_embedding("r1", "nan", "nan", &[f32::NAN, 0.0], "m", 0.0, 1.0)
            .unwrap();
        db.save_embedding("r1", "inf", "inf", &[f32::INFINITY, 0.0], "m", 0.0, 1.0)
            .unwrap();
        db.save_embedding("r1", "time", "time", &[1.0, 0.0], "m", f64::INFINITY, 1.0)
            .unwrap();
        db.save_embedding("r1", "reversed", "reversed", &[1.0, 0.0], "m", 2.0, 1.0)
            .unwrap();
        db.save_embedding("r1", "negative", "negative", &[1.0, 0.0], "m", -1.0, 1.0)
            .unwrap();
        let hits = db.search_embeddings(&[1.0, 0.0], 10, "m").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "best");
        assert!(db.search_embeddings(&[f32::NAN, 0.0], 10, "m").is_err());
        assert!(db.search_embeddings(&[], 10, "m").is_err());
    }

    #[test]
    fn semantic_scan_relevant_direct_mutations_invalidate_tokens() {
        for sql in [
            "UPDATE transcript_embeddings SET id = -9",
            "UPDATE transcript_embeddings SET text = 'changed'",
            "UPDATE transcript_embeddings SET segment_id = 'changed'",
            "UPDATE transcript_embeddings SET embedding = x'000000000000803f'",
            "UPDATE transcript_embeddings SET model = 'changed'",
            "UPDATE transcript_embeddings SET recording_id = 'changed'",
            "UPDATE transcript_embeddings SET start_time = 0.5",
            "UPDATE transcript_embeddings SET end_time = 2",
            "UPDATE transcript_embeddings SET created_at = 'changed'",
            "DELETE FROM transcript_embeddings",
            "UPDATE recordings SET title = 'changed' WHERE id = 'r1'",
            "UPDATE recordings SET source_type = 'changed' WHERE id = 'r1'",
            "UPDATE recordings SET id = 'changed' WHERE id = 'r1'",
            "DELETE FROM recordings WHERE id = 'r1'",
            "UPDATE transcripts SET id = 'changed'",
            "UPDATE transcripts SET recording_id = 'changed'",
            "UPDATE transcripts SET revision = revision + 1",
            "UPDATE transcripts SET segments = '[1]'",
            "UPDATE transcripts SET full_text = 'changed'",
            "DELETE FROM transcripts",
            "INSERT INTO transcripts (id, recording_id, created_at) VALUES ('new', 'r1', 'same')",
        ] {
            let db = semantic_scan_fixture();
            db.conn
                .execute(
                    "INSERT INTO transcripts (id, recording_id, segments, full_text, created_at)
                VALUES ('t1', 'r1', '[]', 'original', 'same')",
                    [],
                )
                .unwrap();
            let scope = semantic_scan_scope();
            let token = db.begin_embedding_scan(&scope).unwrap();
            db.conn.execute_batch(sql).unwrap();
            assert!(db.validate_embedding_scan(&token).is_err(), "{sql}");
            assert!(
                db.read_embedding_scan_page(&scope, &token, None).is_err(),
                "{sql}"
            );
        }
        let mut db = semantic_scan_fixture();
        let token = db.begin_embedding_scan(&semantic_scan_scope()).unwrap();
        db.save_embedding("r1", "new", "new", &[1.0, 0.0], "m", 0.0, 1.0)
            .unwrap();
        assert!(db.validate_embedding_scan(&token).is_err());
        // An orphan becomes eligible when its recording appears.
        db.save_embedding("r2", "new", "new", &[1.0, 0.0], "m", 0.0, 1.0)
            .unwrap();
        let token = db.begin_embedding_scan(&semantic_scan_scope()).unwrap();
        db.create_recording(&sample_recording("r2", "inbox"))
            .unwrap();
        assert!(db.validate_embedding_scan(&token).is_err());
    }

    #[test]
    fn semantic_scan_notes_status_staging_noops_and_rollback_preserve_revision() {
        let db = semantic_scan_fixture();
        let scope = semantic_scan_scope();
        let token = db.begin_embedding_scan(&scope).unwrap();
        db.conn
            .execute_batch(
                "UPDATE recordings SET meeting_notes = 'notes', status = 'completed', updated_at = 'later';
            UPDATE transcript_embeddings SET text = text;",
            )
            .unwrap();
        let source = db.begin_embedding_rebuild().unwrap();
        db.stage_embedding("run", "r1", "s1", "staged", &[1.0, 0.0], "m", 0.0, 1.0)
            .unwrap();
        db.discard_embedding_rebuild("run").unwrap();
        assert!(db.embedding_sources_unchanged(&source).unwrap());
        db.validate_embedding_scan(&token).unwrap();
        let tx = db.conn.unchecked_transaction().unwrap();
        tx.execute("DELETE FROM transcript_embeddings", []).unwrap();
        tx.rollback().unwrap();
        db.validate_embedding_scan(&token).unwrap();
        initialize_semantic_revision(&db.conn).unwrap();
        assert_eq!(
            db.begin_embedding_scan(&scope).unwrap().revision,
            token.revision
        );
    }

    #[test]
    fn semantic_scan_rebuild_rollback_and_reset_keep_monotonic_revision() {
        let mut db = semantic_scan_fixture();
        let scope = semantic_scan_scope();
        let token = db.begin_embedding_scan(&scope).unwrap();
        let source = db.begin_embedding_rebuild().unwrap();
        db.stage_embedding("run", "r1", "s1", "staged", &[1.0, 0.0], "m", 0.0, 1.0)
            .unwrap();
        db.conn
            .execute_batch(
                "CREATE TRIGGER fail_semantic_swap BEFORE INSERT ON transcript_embeddings
            BEGIN SELECT RAISE(ABORT, 'forced rollback'); END;",
            )
            .unwrap();
        assert!(db.commit_embedding_rebuild("run", &source, 1).is_err());
        db.validate_embedding_scan(&token).unwrap();
        db.conn
            .execute_batch("DROP TRIGGER fail_semantic_swap;")
            .unwrap();
        db.commit_embedding_rebuild("run", &source, 1).unwrap();
        assert!(db.validate_embedding_scan(&token).is_err());
        let swapped = db.begin_embedding_scan(&scope).unwrap();
        db.purge_user_content().unwrap();
        let reset = db.begin_embedding_scan(&scope).unwrap();
        assert!(reset.revision > swapped.revision);
        assert_eq!(reset.upper_id, None);
        assert!(db.validate_embedding_scan(&swapped).is_err());
        initialize_semantic_revision(&db.conn).unwrap();
        assert_eq!(verify_semantic_revision(&db.conn).unwrap(), reset.revision);
    }

    #[test]
    fn semantic_scan_revision_infrastructure_fails_closed_and_overflow_stays_integer() {
        for replacement in [
            "DROP TRIGGER semantic_revision_transcript_embeddings_insert",
            "DROP TRIGGER semantic_revision_transcript_embeddings_insert;
             CREATE TRIGGER semantic_revision_transcript_embeddings_insert AFTER INSERT
             ON transcript_embeddings BEGIN SELECT 1; END",
            "DROP TRIGGER semantic_revision_no_delete; DELETE FROM semantic_recall_revision",
        ] {
            let db = semantic_scan_fixture();
            let scope = semantic_scan_scope();
            let token = db.begin_embedding_scan(&scope).unwrap();
            db.conn.execute_batch(replacement).unwrap();
            assert!(db.begin_embedding_scan(&scope).is_err());
            assert!(db.read_embedding_scan_page(&scope, &token, None).is_err());
            assert!(db.validate_embedding_scan(&token).is_err());
        }
        let db = semantic_scan_fixture();
        assert!(db
            .conn
            .execute("DELETE FROM semantic_recall_revision", [])
            .is_err());
        assert!(db
            .conn
            .execute("UPDATE semantic_recall_revision SET revision = 0", [])
            .is_err());
        db.conn
            .execute_batch(
                "DROP TRIGGER semantic_revision_update_guard;
            UPDATE semantic_recall_revision SET revision = 9223372036854775807;",
            )
            .unwrap();
        let definition = semantic_revision_triggers()
            .into_iter()
            .find(|(name, _)| name == "semantic_revision_update_guard")
            .unwrap()
            .1;
        db.conn.execute_batch(&definition).unwrap();
        assert!(db
            .save_embedding("r1", "overflow", "overflow", &[1.0, 0.0], "m", 0.0, 1.0)
            .is_err());
        let kind: String = db
            .conn
            .query_row(
                "SELECT typeof(revision) FROM semantic_recall_revision",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(kind, "integer");
        assert_eq!(db.embedding_count().unwrap(), 1);
    }

    #[test]
    fn semantic_scan_second_connection_mutations_participate() {
        let path =
            std::env::temp_dir().join(format!("semantic-recall-{}.sqlite", uuid::Uuid::new_v4()));
        {
            let conn = Connection::open(&path).unwrap();
            let mut db = Database {
                conn,
                encrypted: false,
                correction_approval_undo: HashMap::new(),
            };
            db.init_tables().unwrap();
            db.create_recording(&sample_recording("r1", "inbox"))
                .unwrap();
            db.save_embedding("r1", "s1", "best", &[1.0, 0.0], "m", 0.0, 1.0)
                .unwrap();
            let other = Connection::open(&path).unwrap();
            let scope = semantic_scan_scope();
            let token = db.begin_embedding_scan(&scope).unwrap();
            other
                .execute_batch("PRAGMA recursive_triggers = OFF")
                .unwrap();
            assert!(other
                .execute(
                    "INSERT OR REPLACE INTO semantic_recall_revision (id, revision) VALUES (1, 0)",
                    []
                )
                .is_err());
            db.validate_embedding_scan(&token).unwrap();
            other
                .execute("UPDATE recordings SET meeting_notes = 'unrelated'", [])
                .unwrap();
            db.validate_embedding_scan(&token).unwrap();
            other
                .execute("UPDATE recordings SET title = 'changed'", [])
                .unwrap();
            assert!(db.validate_embedding_scan(&token).is_err());
            let token = db.begin_embedding_scan(&scope).unwrap();
            other
                .execute("DELETE FROM transcript_embeddings", [])
                .unwrap();
            assert!(db.validate_embedding_scan(&token).is_err());
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn semantic_scan_invalid_dimensions_fail_before_sql() {
        let db = semantic_scan_fixture();
        let mut scope = semantic_scan_scope();
        for dimensions in [0, MAX_EMBEDDING_DIMENSIONS + 1, usize::MAX] {
            scope.dimensions = dimensions;
            assert!(db.begin_embedding_scan(&scope).is_err());
        }
    }

    #[test]
    fn semantic_scan_utf16_sizes_cover_decoded_utf8_text() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA encoding = 'UTF-16le'").unwrap();
        let mut db = Database {
            conn,
            encrypted: false,
            correction_approval_undo: HashMap::new(),
        };
        db.init_tables().unwrap();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let scope = semantic_scan_scope();
        let text = "漢".repeat(400_000);
        assert!(text.len() > EMBEDDING_PAGE_BYTES);
        db.save_embedding("r1", "large", &text, &[1.0, 0.0], "m", 0.0, 1.0)
            .unwrap();
        let token = db.begin_embedding_scan(&scope).unwrap();
        assert!(db
            .read_embedding_scan_page(&scope, &token, None)
            .unwrap_err()
            .to_string()
            .contains("resource limit"));
        db.delete_embeddings("r1").unwrap();
        db.save_embedding("r1", "small", "漢 budget", &[1.0, 0.0], "m", 0.0, 1.0)
            .unwrap();
        assert_eq!(
            db.search_embeddings(&[1.0, 0.0], 1, "m").unwrap()[0].text,
            "漢 budget"
        );
    }

    #[test]
    fn semantic_scan_ineligible_windows_advance_without_scanning_for_a_full_page() {
        let db = semantic_scan_fixture();
        for index in 0..(EMBEDDING_PAGE_ROWS * 2) {
            db.save_embedding(
                "r1",
                &index.to_string(),
                "Wrong dimension",
                &[1.0, 0.0, 0.0],
                "m",
                0.0,
                1.0,
            )
            .unwrap();
        }
        db.save_embedding(
            "r1",
            "older-range-match",
            "Eligible after sparse windows",
            &[1.0, 0.0],
            "m",
            0.0,
            1.0,
        )
        .unwrap();
        let scope = semantic_scan_scope();
        let token = db.begin_embedding_scan(&scope).unwrap();
        let first = db.read_embedding_scan_page(&scope, &token, None).unwrap();
        assert_eq!(first.rows.len(), 1);
        assert!(!first.exhausted);
        let next = db
            .read_embedding_scan_page(&scope, &token, first.next_cursor)
            .unwrap();
        assert!(next.rows.is_empty());
        assert!(!next.exhausted);
        assert!(next.next_cursor > first.next_cursor);
        assert_eq!(db.search_embeddings(&[1.0, 0.0], 10, "m").unwrap().len(), 2);
    }

    fn embedding_rebuild_fixture() -> Database {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_transcript(&sample_multi_segment_transcript("r1"))
            .unwrap();
        db.save_embedding(
            "r1",
            "old",
            "old searchable fact",
            &[1.0, 0.0],
            "model",
            0.0,
            1.0,
        )
        .unwrap();
        db
    }

    #[test]
    fn embedding_rebuild_keeps_live_vectors_until_atomic_commit() {
        let mut db = embedding_rebuild_fixture();
        let signature = db.begin_embedding_rebuild().unwrap();
        db.stage_embedding(
            "run",
            "r1",
            "new",
            "replacement fact",
            &[1.0, 0.0],
            "model",
            1.0,
            2.0,
        )
        .unwrap();
        assert_eq!(
            db.search_embeddings(&[1.0, 0.0], 10, "model").unwrap()[0].text,
            "old searchable fact"
        );
        db.commit_embedding_rebuild("run", &signature, 1).unwrap();
        let hits = db.search_embeddings(&[1.0, 0.0], 10, "model").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "replacement fact");
    }

    #[test]
    fn embedding_rebuild_discard_and_missing_rows_preserve_old_index() {
        let mut db = embedding_rebuild_fixture();
        let signature = db.begin_embedding_rebuild().unwrap();
        db.stage_embedding(
            "run",
            "r1",
            "new",
            "candidate",
            &[1.0, 0.0],
            "model",
            0.0,
            1.0,
        )
        .unwrap();
        db.discard_embedding_rebuild("run").unwrap();
        assert!(db.commit_embedding_rebuild("run", &signature, 1).is_err());
        assert_eq!(
            db.search_embeddings(&[1.0, 0.0], 10, "model").unwrap()[0].text,
            "old searchable fact"
        );
    }

    #[test]
    fn embedding_rebuild_changed_transcript_cannot_replace_index() {
        let mut db = embedding_rebuild_fixture();
        let signature = db.begin_embedding_rebuild().unwrap();
        db.stage_embedding(
            "run",
            "r1",
            "new",
            "candidate",
            &[1.0, 0.0],
            "model",
            0.0,
            1.0,
        )
        .unwrap();
        let mut transcript = sample_multi_segment_transcript("r1");
        transcript.segments[0].text = "corrected fact".into();
        db.conn
            .execute(
                "UPDATE transcripts SET segments=?1,revision=revision+1 WHERE recording_id='r1'",
                [serde_json::to_string(&transcript.segments).unwrap()],
            )
            .unwrap();
        assert!(db.commit_embedding_rebuild("run", &signature, 1).is_err());
        assert_eq!(
            db.search_embeddings(&[1.0, 0.0], 10, "model").unwrap()[0].text,
            "old searchable fact"
        );
    }

    #[test]
    fn embedding_rebuild_insert_failure_rolls_back_live_deletion() {
        let mut db = embedding_rebuild_fixture();
        let signature = db.begin_embedding_rebuild().unwrap();
        db.stage_embedding(
            "run",
            "r1",
            "new",
            "candidate",
            &[1.0, 0.0],
            "model",
            0.0,
            1.0,
        )
        .unwrap();
        db.conn.execute_batch("CREATE TRIGGER fail_embedding_swap BEFORE INSERT ON transcript_embeddings BEGIN SELECT RAISE(ABORT,'forced swap failure'); END;").unwrap();
        assert!(db.commit_embedding_rebuild("run", &signature, 1).is_err());
        assert_eq!(
            db.search_embeddings(&[1.0, 0.0], 10, "model").unwrap()[0].text,
            "old searchable fact"
        );
    }

    #[test]
    fn embedding_rebuild_preserved_vectors_only_match_their_model_and_dimensions() {
        let db = embedding_rebuild_fixture();
        assert!(db
            .search_embeddings(&[1.0, 0.0], 10, "different-model")
            .unwrap()
            .is_empty());
        assert!(db
            .search_embeddings(&[1.0, 0.0, 0.0], 10, "model")
            .unwrap()
            .is_empty());
        assert_eq!(
            db.search_embeddings(&[1.0, 0.0], 10, "model")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn embedding_rebuild_rejects_mixed_dimensions_and_reset_clears_staging() {
        let mut db = embedding_rebuild_fixture();
        let signature = db.begin_embedding_rebuild().unwrap();
        db.stage_embedding(
            "run",
            "r1",
            "a",
            "candidate",
            &[1.0, 0.0],
            "model",
            0.0,
            1.0,
        )
        .unwrap();
        db.stage_embedding(
            "run",
            "r1",
            "b",
            "candidate",
            &[1.0, 0.0, 0.0],
            "model",
            0.0,
            1.0,
        )
        .unwrap();
        assert!(db.commit_embedding_rebuild("run", &signature, 2).is_err());
        assert_eq!(
            db.search_embeddings(&[1.0, 0.0], 10, "model").unwrap()[0].text,
            "old searchable fact"
        );
        db.purge_user_content().unwrap();
        assert_eq!(
            db.conn
                .query_row("SELECT COUNT(*) FROM embedding_rebuild_stage", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
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
    fn ungrounded_regeneration_cannot_replace_an_existing_summary_or_undo() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("r1", "inbox");
        recording.summary = Some("Original useful recap".into());
        recording.action_items = Some(vec!["Keep this task".into()]);
        db.create_recording(&recording).unwrap();
        db.update_recording_analysis(
            "r1",
            Some("Original useful recap"),
            &["Keep this task".into()],
        )
        .unwrap();
        db.replace_generated_summary_with_undo(
            "r1",
            Some("Original useful recap"),
            "Verified new recap",
            &sample_summary_provenance("Verified new recap"),
            "input-1",
        )
        .unwrap();
        let before = db.get_recording("r1").unwrap().unwrap();
        let token = db.summary_regeneration_undo_token("r1").unwrap();
        let mut provenance = sample_summary_provenance("Unverified firm promise");
        provenance.grounded = false;
        assert!(db
            .replace_generated_summary_with_undo(
                "r1",
                Some("Verified new recap"),
                "Unverified firm promise",
                &provenance,
                "input-1"
            )
            .is_err());
        let after = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(after.summary, before.summary);
        assert_eq!(after.summary_provenance, before.summary_provenance);
        assert_eq!(after.action_items, before.action_items);
        assert_eq!(db.summary_regeneration_undo_token("r1").unwrap(), token);
    }

    #[test]
    fn first_ungrounded_summary_can_be_saved_for_review() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("r1", "inbox");
        recording.summary = None;
        db.create_recording(&recording).unwrap();
        let mut provenance = sample_summary_provenance("First review draft");
        provenance.grounded = false;
        db.replace_generated_summary_with_undo(
            "r1",
            None,
            "First review draft",
            &provenance,
            "input-1",
        )
        .unwrap();
        let saved = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(saved.summary.as_deref(), Some("First review draft"));
        assert!(!saved.summary_provenance.unwrap().grounded);
    }

    #[test]
    fn summary_regeneration_undo_restores_null_summary_and_preserves_other_analysis() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("r1", "inbox");
        recording.summary = None;
        recording.action_items = Some(vec!["Original action".to_string()]);
        db.create_recording(&recording).unwrap();
        let generated = "Generated summary";
        db.replace_generated_summary_with_undo(
            "r1",
            None,
            generated,
            &sample_summary_provenance(generated),
            "input-1",
        )
        .unwrap();
        db.patch_recording_analysis("r1", None, Some(&["Updated action".to_string()]))
            .unwrap();

        assert!(db.can_undo_summary_regeneration("r1").unwrap());
        let token = db.summary_regeneration_undo_token("r1").unwrap().unwrap();
        let restored = db
            .undo_summary_regeneration("r1", &token, Some("input-1"))
            .unwrap();
        assert_eq!(restored.summary, None);
        assert_eq!(
            restored.action_items,
            Some(vec!["Updated action".to_string()])
        );
        assert!(restored.summary_provenance.is_none());
        assert!(!db.can_undo_summary_regeneration("r1").unwrap());
    }

    #[test]
    fn summary_regeneration_undo_restores_exact_prior_provenance_or_clears_it_for_changed_input() {
        for (recording_id, restore_provenance) in [("valid", true), ("changed", false)] {
            let mut db = in_memory_db();
            let prior = "Prior summary";
            let mut prior_provenance = sample_summary_provenance(prior);
            prior_provenance.prompt_source = "meeting_playbook:auto:input=input-1".to_string();
            let generated = "Generated summary";
            let mut recording = sample_recording(recording_id, "inbox");
            recording.summary = Some(prior.to_string());
            db.create_recording(&recording).unwrap();
            db.patch_recording_analysis_with_provenance(
                recording_id,
                Some(Some(prior)),
                None,
                Some(&prior_provenance),
                None,
            )
            .unwrap();
            db.replace_generated_summary_with_undo(
                recording_id,
                Some(prior),
                generated,
                &sample_summary_provenance(generated),
                "input-1",
            )
            .unwrap();

            let token = db
                .summary_regeneration_undo_token(recording_id)
                .unwrap()
                .unwrap();
            let restored = db
                .undo_summary_regeneration(
                    recording_id,
                    &token,
                    restore_provenance.then_some("input-1"),
                )
                .unwrap();
            assert_eq!(restored.summary.as_deref(), Some(prior));
            assert_eq!(
                restored.summary_provenance,
                restore_provenance.then_some(prior_provenance)
            );
        }
    }

    #[test]
    fn summary_regeneration_undo_clears_prior_provenance_from_an_older_input() {
        let mut db = in_memory_db();
        let prior = "Prior summary";
        let mut prior_provenance = sample_summary_provenance(prior);
        prior_provenance.prompt_source = "meeting_playbook:auto:input=old-input".to_string();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.patch_recording_analysis_with_provenance(
            "r1",
            Some(Some(prior)),
            None,
            Some(&prior_provenance),
            None,
        )
        .unwrap();
        db.replace_generated_summary_with_undo(
            "r1",
            Some(prior),
            "Generated",
            &sample_summary_provenance("Generated"),
            "current-input",
        )
        .unwrap();
        let token = db.summary_regeneration_undo_token("r1").unwrap().unwrap();

        let restored = db
            .undo_summary_regeneration("r1", &token, Some("current-input"))
            .unwrap();
        assert_eq!(restored.summary.as_deref(), Some(prior));
        assert!(restored.summary_provenance.is_none());
    }

    #[test]
    fn summary_regeneration_undo_refuses_a_later_manual_summary_edit() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("r1", "inbox");
        recording.summary = Some("Prior".to_string());
        db.create_recording(&recording).unwrap();
        db.patch_recording_analysis("r1", Some("Prior"), None)
            .unwrap();
        db.replace_generated_summary_with_undo(
            "r1",
            Some("Prior"),
            "Generated",
            &sample_summary_provenance("Generated"),
            "input-1",
        )
        .unwrap();
        db.patch_recording_analysis("r1", Some("Manual edit"), None)
            .unwrap();

        assert!(!db.can_undo_summary_regeneration("r1").unwrap());
        assert!(db
            .undo_summary_regeneration("r1", "stale-token", Some("input-1"))
            .is_err());
        assert_eq!(
            db.get_recording("r1").unwrap().unwrap().summary.as_deref(),
            Some("Manual edit")
        );
    }

    #[test]
    fn failed_undo_snapshot_write_rolls_back_generated_summary() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("r1", "inbox");
        recording.summary = Some("Prior".to_string());
        db.create_recording(&recording).unwrap();
        db.patch_recording_analysis("r1", Some("Prior"), None)
            .unwrap();
        db.conn
            .execute_batch(
                "CREATE TRIGGER reject_summary_undo BEFORE INSERT ON summary_regeneration_undo
                 BEGIN SELECT RAISE(ABORT, 'snapshot failure'); END;",
            )
            .unwrap();

        assert!(db
            .replace_generated_summary_with_undo(
                "r1",
                Some("Prior"),
                "Generated",
                &sample_summary_provenance("Generated"),
                "input-1",
            )
            .is_err());
        assert_eq!(
            db.get_recording("r1").unwrap().unwrap().summary.as_deref(),
            Some("Prior")
        );
    }

    #[test]
    fn repeated_summary_generation_keeps_only_the_latest_undo_level() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("r1", "inbox");
        recording.summary = Some("Original".to_string());
        db.create_recording(&recording).unwrap();
        db.patch_recording_analysis("r1", Some("Original"), None)
            .unwrap();
        db.replace_generated_summary_with_undo(
            "r1",
            Some("Original"),
            "First",
            &sample_summary_provenance("First"),
            "input-1",
        )
        .unwrap();
        let stale_token = db.summary_regeneration_undo_token("r1").unwrap().unwrap();
        db.replace_generated_summary_with_undo(
            "r1",
            Some("First"),
            "Second",
            &sample_summary_provenance("Second"),
            "input-1",
        )
        .unwrap();

        assert!(db
            .undo_summary_regeneration("r1", &stale_token, Some("input-1"))
            .is_err());
        let current_token = db.summary_regeneration_undo_token("r1").unwrap().unwrap();
        let restored = db
            .undo_summary_regeneration("r1", &current_token, Some("input-1"))
            .unwrap();
        assert_eq!(restored.summary.as_deref(), Some("First"));
        assert!(!db.can_undo_summary_regeneration("r1").unwrap());
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
            correction_approval_undo: HashMap::new(),
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
    fn older_summary_checks_keep_history_without_current_verification() {
        for policy in [
            None,
            Some(0),
            Some(crate::models::SUMMARY_GROUNDING_POLICY_VERSION - 1),
            Some(crate::models::SUMMARY_GROUNDING_POLICY_VERSION + 1),
        ] {
            let mut db = in_memory_db();
            db.create_recording(&sample_recording("r1", "inbox"))
                .unwrap();
            let summary = "Older source-checked summary";
            let mut provenance = sample_summary_provenance(summary);
            provenance.grounding_policy_version = policy;
            db.patch_recording_analysis_with_provenance(
                "r1",
                Some(Some(summary)),
                None,
                Some(&provenance),
                None,
            )
            .unwrap();
            let raw_before: String = db
                .conn
                .query_row(
                    "SELECT summary_provenance FROM meeting_artifacts WHERE recording_id = 'r1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            if policy.is_none() {
                assert!(!raw_before.contains("groundingPolicyVersion"));
            }
            let recording = db.get_recording("r1").unwrap().unwrap();
            assert_eq!(recording.summary.as_deref(), Some(summary));
            let reloaded = recording.summary_provenance.unwrap();
            assert!(!reloaded.grounded);
            assert_eq!(reloaded.grounding_policy_version, policy);
            assert_eq!(reloaded.citations, provenance.citations);
            assert_eq!(reloaded.actual_model, provenance.actual_model);
            assert_eq!(reloaded.completed_at, provenance.completed_at);
            let raw_after: String = db
                .conn
                .query_row(
                    "SELECT summary_provenance FROM meeting_artifacts WHERE recording_id = 'r1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                raw_before, raw_after,
                "Reading must not rewrite historic evidence"
            );
        }
    }

    #[test]
    fn current_summary_checks_do_not_upgrade_an_unverified_result() {
        let mut provenance = sample_summary_provenance("Needs review");
        provenance.grounded = false;
        let reloaded = validated_summary_provenance(
            Some(serde_json::to_string(&provenance).unwrap()),
            Some("Needs review"),
        )
        .unwrap();
        assert!(!reloaded.grounded);
    }

    #[test]
    fn undo_restores_older_summary_text_without_upgrading_its_checks() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let mut old = sample_summary_provenance("Prior summary");
        old.grounding_policy_version = None;
        old.prompt_source = "meeting_playbook:auto:input=input-1".into();
        db.patch_recording_analysis_with_provenance(
            "r1",
            Some(Some("Prior summary")),
            None,
            Some(&old),
            None,
        )
        .unwrap();
        db.replace_generated_summary_with_undo(
            "r1",
            Some("Prior summary"),
            "New summary",
            &sample_summary_provenance("New summary"),
            "input-1",
        )
        .unwrap();
        let token = db.summary_regeneration_undo_token("r1").unwrap().unwrap();
        let restored = db
            .undo_summary_regeneration("r1", &token, Some("input-1"))
            .unwrap();
        assert_eq!(restored.summary.as_deref(), Some("Prior summary"));
        let provenance = restored.summary_provenance.unwrap();
        assert!(!provenance.grounded);
        assert_eq!(provenance.citations, old.citations);
        assert_eq!(provenance.grounding_policy_version, None);
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
        let stale = after_notes.summary_provenance.unwrap();
        let original = sample_summary_provenance(summary);
        assert!(!stale.grounded);
        assert_eq!(stale.citations, original.citations);
        assert_eq!(stale.actual_model, original.actual_model);
        assert!(after_notes.action_items_provenance.is_none());
        assert_eq!(after_notes.summary.as_deref(), Some(summary));
        assert_eq!(after_notes.action_items, Some(action_items));
    }

    fn sample_enhanced_note_draft() -> MeetingEnhancedNoteDraft {
        MeetingEnhancedNoteDraft {
            text: "Draft decision".into(),
            generated_at: Utc::now(),
            raw_notes_snapshot: "Original notes".into(),
            summary_citations: vec![],
            action_item_citations: vec![],
        }
    }

    #[test]
    fn enhanced_note_draft_preserves_raw_notes_and_recap_and_rejects_stale_source() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("draft-meeting", "inbox"))
            .unwrap();
        db.update_recording_notes("draft-meeting", Some("Original notes"))
            .unwrap();
        db.patch_recording_analysis_with_provenance(
            "draft-meeting",
            Some(Some("Recap")),
            None,
            Some(&sample_summary_provenance("Recap")),
            None,
        )
        .unwrap();
        let before = db.get_recording("draft-meeting").unwrap().unwrap();
        let draft = sample_enhanced_note_draft();
        assert_eq!(
            db.save_meeting_enhanced_note_draft("draft-meeting", &draft)
                .unwrap(),
            draft
        );
        assert_eq!(
            db.get_meeting_enhanced_note_draft("draft-meeting").unwrap(),
            Some(draft.clone())
        );
        let after = db.get_recording("draft-meeting").unwrap().unwrap();
        assert_eq!(before.meeting_notes, after.meeting_notes);
        assert_eq!(before.notes_updated_at, after.notes_updated_at);
        assert_eq!(before.summary, after.summary);
        assert_eq!(before.summary_provenance, after.summary_provenance);
        db.update_recording_notes("draft-meeting", Some("New notes"))
            .unwrap();
        assert!(db
            .save_meeting_enhanced_note_draft("draft-meeting", &draft)
            .is_err());
        assert_eq!(
            db.get_meeting_enhanced_note_draft("draft-meeting").unwrap(),
            Some(draft)
        );
    }

    #[test]
    fn enhanced_note_draft_validates_source_boundaries_and_cascades_deletion() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("draft-dictation", "inbox");
        recording.source_type = "dictation".into();
        recording.meeting_notes = Some("Original notes".into());
        db.create_recording(&recording).unwrap();
        let mut draft = sample_enhanced_note_draft();
        assert!(db
            .save_meeting_enhanced_note_draft("missing", &draft)
            .is_err());
        assert!(db
            .save_meeting_enhanced_note_draft("draft-dictation", &draft)
            .is_err());
        recording.id = "draft-meeting".into();
        recording.source_type = "meeting".into();
        db.create_recording(&recording).unwrap();
        draft.text = " ".into();
        assert!(db
            .save_meeting_enhanced_note_draft("draft-meeting", &draft)
            .is_err());
        draft = sample_enhanced_note_draft();
        draft.generated_at = Utc::now() + chrono::Duration::hours(1);
        assert!(db
            .save_meeting_enhanced_note_draft("draft-meeting", &draft)
            .is_err());
        draft = sample_enhanced_note_draft();
        draft.summary_citations = vec![AnalysisCitation {
            text: "Quote".into(),
            source_kind: None,
            line_id: None,
            segment_id: None,
            start_time: Some(10.0),
            end_time: Some(9.0),
            recording_id: Some("other".into()),
            certainty: None,
        }];
        assert!(db
            .save_meeting_enhanced_note_draft("draft-meeting", &draft)
            .is_err());
        draft = sample_enhanced_note_draft();
        db.save_meeting_enhanced_note_draft("draft-meeting", &draft)
            .unwrap();
        db.delete_meeting_enhanced_note_draft("draft-dictation")
            .unwrap();
        assert!(db
            .get_meeting_enhanced_note_draft("draft-meeting")
            .unwrap()
            .is_some());
        db.conn
            .execute("DELETE FROM recordings WHERE id='draft-meeting'", [])
            .unwrap();
        let count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM meeting_enhanced_note_drafts",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn enhanced_note_draft_delete_and_reset_remove_private_content() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("draft-meeting", "inbox");
        recording.meeting_notes = Some("Original notes".into());
        db.create_recording(&recording).unwrap();
        let draft = sample_enhanced_note_draft();
        db.save_meeting_enhanced_note_draft("draft-meeting", &draft)
            .unwrap();
        db.delete_meeting_enhanced_note_draft("draft-meeting")
            .unwrap();
        assert!(db
            .get_meeting_enhanced_note_draft("draft-meeting")
            .unwrap()
            .is_none());
        db.save_meeting_enhanced_note_draft("draft-meeting", &draft)
            .unwrap();
        db.purge_user_content().unwrap();
        let count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM meeting_enhanced_note_drafts",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn enhanced_note_draft_survives_database_reopen() {
        let root =
            std::env::temp_dir().join(format!("plainsong-enhanced-draft-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("draft.db");
        let draft = sample_enhanced_note_draft();
        {
            let mut db = Database {
                conn: Connection::open(&path).unwrap(),
                encrypted: false,
                correction_approval_undo: HashMap::new(),
            };
            db.conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
            db.init_tables().unwrap();
            let mut recording = sample_recording("draft-meeting", "inbox");
            recording.meeting_notes = Some("Original notes".into());
            db.create_recording(&recording).unwrap();
            db.save_meeting_enhanced_note_draft("draft-meeting", &draft)
                .unwrap();
        }
        let db = Database {
            conn: Connection::open(&path).unwrap(),
            encrypted: false,
            correction_approval_undo: HashMap::new(),
        };
        assert_eq!(
            db.get_meeting_enhanced_note_draft("draft-meeting").unwrap(),
            Some(draft)
        );
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_journal_survives_database_reopen() {
        let root =
            std::env::temp_dir().join(format!("plainsong-recovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("recovery.db");
        {
            let mut db = Database {
                conn: Connection::open(&path).unwrap(),
                encrypted: false,
                correction_approval_undo: HashMap::new(),
            };
            db.conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
            db.init_tables().unwrap();
            db.create_recording(&sample_recording("r1", "inbox"))
                .unwrap();
            db.queue_meeting_note_recovery("d1", "r1", "Original", "Final condition.")
                .unwrap();
        }
        let db = Database {
            conn: Connection::open(&path).unwrap(),
            encrypted: false,
            correction_approval_undo: HashMap::new(),
        };
        let drafts = db.list_meeting_note_recovery().unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].base_notes, "Original");
        assert_eq!(drafts[0].notes, "Final condition.");
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_note_update_preserves_recovery_journal_atomically() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.queue_meeting_note_recovery("d1", "r1", "", "Keep final notes")
            .unwrap();
        db.conn.execute_batch("CREATE TRIGGER reject_notes BEFORE UPDATE OF meeting_notes ON recordings BEGIN SELECT RAISE(ABORT, 'controlled note failure'); END;").unwrap();
        assert!(db
            .update_recording_notes_recovering("r1", Some("Keep final notes"), Some("d1"))
            .is_err());
        assert_eq!(db.list_meeting_note_recovery().unwrap().len(), 1);
        assert!(db
            .get_recording("r1")
            .unwrap()
            .unwrap()
            .meeting_notes
            .is_none());
    }

    #[test]
    fn stale_recovery_write_keeps_newer_notes_and_its_journal() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.update_recording_notes("r1", Some("Newer saved decision"))
            .unwrap();
        db.queue_meeting_note_recovery("d1", "r1", "Old decision", "Recovered condition")
            .unwrap();
        assert!(db
            .update_recording_notes_recovering_guarded(
                "r1",
                Some("Recovered condition"),
                Some("d1"),
                Some("Old decision")
            )
            .is_err());
        assert_eq!(
            db.get_recording("r1")
                .unwrap()
                .unwrap()
                .meeting_notes
                .as_deref(),
            Some("Newer saved decision")
        );
        assert_eq!(db.list_meeting_note_recovery().unwrap().len(), 1);
        db.update_recording_notes_recovering_guarded(
            "r1",
            Some("Newer saved decision\nRecovered condition"),
            Some("d1"),
            Some("Newer saved decision"),
        )
        .unwrap();
        assert!(db.list_meeting_note_recovery().unwrap().is_empty());
    }

    #[test]
    fn recovery_journal_is_idempotent_and_consumed_with_notes() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.queue_meeting_note_recovery("d1", "r1", "", "Final condition stays.")
            .unwrap();
        db.queue_meeting_note_recovery("d1", "r1", "", "Final condition stays.")
            .unwrap();
        assert_eq!(db.list_meeting_note_recovery().unwrap().len(), 1);
        assert!(db
            .queue_meeting_note_recovery("d1", "r1", "", "Different notes")
            .is_err());
        db.update_recording_notes_recovering("r1", Some("Final condition stays."), Some("d1"))
            .unwrap();
        assert!(db.list_meeting_note_recovery().unwrap().is_empty());
        assert_eq!(
            db.get_recording("r1")
                .unwrap()
                .unwrap()
                .meeting_notes
                .as_deref(),
            Some("Final condition stays.")
        );
    }

    #[test]
    fn recovery_cannot_consume_another_meeting_and_deletion_cascades() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.create_recording(&sample_recording("r2", "inbox"))
            .unwrap();
        db.queue_meeting_note_recovery("d1", "r1", "", "Keep this.")
            .unwrap();
        assert!(db
            .update_recording_notes_recovering("r2", Some("Wrong target"), Some("d1"))
            .is_err());
        assert_eq!(db.list_meeting_note_recovery().unwrap().len(), 1);
        assert!(db
            .get_recording("r2")
            .unwrap()
            .unwrap()
            .meeting_notes
            .is_none());
        db.update_recording_status("r1", "completed").unwrap();
        db.delete_recording("r1").unwrap();
        assert!(db.list_meeting_note_recovery().unwrap().is_empty());
    }

    #[test]
    fn recovery_is_consumed_when_notes_already_saved_and_purged_with_user_data() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.update_recording_notes("r1", Some("Saved notes"))
            .unwrap();
        db.queue_meeting_note_recovery("d1", "r1", "", "Saved notes")
            .unwrap();
        db.update_recording_notes_recovering("r1", Some("Saved notes"), Some("d1"))
            .unwrap();
        assert!(db.list_meeting_note_recovery().unwrap().is_empty());
        db.queue_meeting_note_recovery("d2", "r1", "Saved notes", "New notes")
            .unwrap();
        db.purge_user_content().unwrap();
        assert!(db.list_meeting_note_recovery().unwrap().is_empty());
    }

    #[test]
    fn unchanged_notes_preserve_verified_summary_and_timestamps() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.update_recording_notes("r1", Some("My notes")).unwrap();
        let summary = "Generated summary";
        db.patch_recording_analysis_with_provenance(
            "r1",
            Some(Some(summary)),
            None,
            Some(&sample_summary_provenance(summary)),
            None,
        )
        .unwrap();
        let before = db.get_recording("r1").unwrap().unwrap();
        db.update_recording_notes("r1", Some("My notes")).unwrap();
        let after = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(after.notes_updated_at, before.notes_updated_at);
        assert_eq!(after.updated_at, before.updated_at);
        let kept = after.summary_provenance.unwrap();
        assert!(kept.grounded);
        assert_eq!(kept.citations, before.summary_provenance.unwrap().citations);
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
    fn attendees_round_trip_and_are_sanitized_on_the_way_in_and_out() {
        use crate::models::MeetingAttendee;

        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();

        // A meeting recorded before the column existed reads back as nobody,
        // not as a parse failure.
        assert!(db
            .get_recording("r1")
            .unwrap()
            .unwrap()
            .attendees
            .is_empty());

        let stored = db
            .update_recording_attendees(
                "r1",
                vec![
                    MeetingAttendee {
                        name: "  Alice   Brown ".to_string(),
                        email: Some("Alice@Example.com".to_string()),
                        is_organizer: true,
                    },
                    // Same address, different display name: one person.
                    MeetingAttendee {
                        name: "A. Brown".to_string(),
                        email: Some("alice@example.com".to_string()),
                        is_organizer: false,
                    },
                    MeetingAttendee {
                        name: "   ".to_string(),
                        email: None,
                        is_organizer: false,
                    },
                ],
            )
            .unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].name, "Alice Brown");
        assert!(stored[0].is_organizer);

        let reloaded = db.get_recording("r1").unwrap().unwrap();
        assert_eq!(reloaded.attendees, stored);
        let listed = db.get_recordings(None).unwrap();
        assert_eq!(listed[0].attendees, stored);

        // Removing the last attendee is an empty list, not a no-op.
        assert!(db
            .update_recording_attendees("r1", Vec::new())
            .unwrap()
            .is_empty());
        assert!(db
            .get_recording("r1")
            .unwrap()
            .unwrap()
            .attendees
            .is_empty());
    }

    #[test]
    fn a_cached_brief_only_comes_back_for_the_inputs_it_was_written_from() {
        let mut db = in_memory_db();
        assert!(db.get_meeting_brief("event-1", "key-a").unwrap().is_none());

        db.save_meeting_brief("event-1", "key-a", "{\"brief\":\"first\"}")
            .unwrap();
        assert_eq!(
            db.get_meeting_brief("event-1", "key-a").unwrap().as_deref(),
            Some("{\"brief\":\"first\"}")
        );
        // A different input hash is a different brief, so the stored one is
        // simply not offered -- there is no expiry to tune and no way to hand
        // back an answer written from evidence that has since changed.
        assert!(db.get_meeting_brief("event-1", "key-b").unwrap().is_none());

        db.save_meeting_brief("event-1", "key-b", "{\"brief\":\"second\"}")
            .unwrap();
        assert_eq!(
            db.get_meeting_brief("event-1", "key-b").unwrap().as_deref(),
            Some("{\"brief\":\"second\"}"),
            "one row per event; a refresh replaces rather than accumulates"
        );
        assert!(db.get_meeting_brief("event-1", "key-a").unwrap().is_none());
    }

    #[test]
    fn updating_attendees_on_a_missing_recording_is_an_error() {
        let mut db = in_memory_db();
        assert!(db.update_recording_attendees("nope", Vec::new()).is_err());
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

    // ── Voiceprints ──────────────────────────────────────────────────────

    fn unit(values: &[f32]) -> Vec<f32> {
        let norm = values.iter().map(|v| v * v).sum::<f32>().sqrt();
        values.iter().map(|v| v / norm).collect()
    }

    /// The promise on the switch: with remembering off, a finished meeting
    /// leaves no trace of anyone's voice anywhere in the database.
    #[test]
    fn voiceprint_storage_is_untouched_while_the_setting_is_off() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let mut centroids: HashMap<String, Vec<f32>> = HashMap::new();
        centroids.insert("S1".to_string(), unit(&[1.0, 0.0, 0.0]));
        centroids.insert("S2".to_string(), unit(&[0.0, 1.0, 0.0]));

        for (speaker_id, centroid) in &centroids {
            let written = db
                .record_named_cluster_voice_signature(
                    "r1",
                    speaker_id,
                    centroid,
                    "ecapa_tdnn_speaker",
                    false,
                )
                .unwrap();
            assert!(!written);
        }
        assert!(db.get_cluster_voice_signatures("r1").unwrap().is_empty());
        assert!(db.list_speaker_profiles().unwrap().is_empty());
        let signature_rows: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM speaker_aliases WHERE voice_centroid IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(signature_rows, 0);

        // And with it on, the same call writes the cluster it was given.
        assert!(db
            .record_named_cluster_voice_signature(
                "r1",
                "S1",
                &centroids["S1"],
                "ecapa_tdnn_speaker",
                true,
            )
            .unwrap());
        let stored = db.get_cluster_voice_signatures("r1").unwrap();
        assert_eq!(
            stored.len(),
            1,
            "one signature per named cluster, not one per cluster in the room"
        );
        assert_eq!(stored[0].speaker_id, "S1");
    }

    /// A vector that cannot be compared costs a suggestion, not the meeting:
    /// the write is refused and reported as "nothing written", not as an error
    /// that would fail an otherwise finished transcript.
    #[test]
    fn an_unusable_signature_is_declined_rather_than_raised() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        assert!(!db
            .record_named_cluster_voice_signature(
                "r1",
                "S1",
                &[f32::NAN, 1.0],
                "ecapa_tdnn_speaker",
                true,
            )
            .unwrap());
        assert!(db.get_cluster_voice_signatures("r1").unwrap().is_empty());
    }

    #[test]
    fn cluster_voice_signatures_round_trip_and_refuse_unusable_vectors() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let centroid = unit(&[0.3, 0.4, 0.5]);
        db.set_cluster_voice_signature("r1", "S1", &centroid, "ecapa_tdnn_speaker")
            .unwrap();

        let signatures = db.get_cluster_voice_signatures("r1").unwrap();
        assert_eq!(signatures.len(), 1);
        assert_eq!(signatures[0].speaker_id, "S1");
        assert_eq!(signatures[0].embedding_model_id, "ecapa_tdnn_speaker");
        for (stored, original) in signatures[0].centroid.iter().zip(centroid.iter()) {
            assert!((stored - original).abs() < 1e-6, "blob round trip");
        }
        assert_eq!(signatures[0].applied_profile_id, None);
        assert!(signatures[0].rejected_profile_ids.is_empty());

        assert!(db
            .set_cluster_voice_signature("r1", "S2", &[], "ecapa_tdnn_speaker")
            .is_err());
        assert!(db
            .set_cluster_voice_signature("r1", "S2", &[0.0, 0.0], "ecapa_tdnn_speaker")
            .is_err());
        assert!(db
            .set_cluster_voice_signature("r1", "S2", &[f32::NAN, 1.0], "ecapa_tdnn_speaker")
            .is_err());
        assert_eq!(db.get_cluster_voice_signatures("r1").unwrap().len(), 1);

        // Re-running speaker identification replaces the signature rather than
        // accumulating a second one for the same cluster.
        let replacement = unit(&[0.0, 0.0, 1.0]);
        db.set_cluster_voice_signature("r1", "S1", &replacement, "ecapa_tdnn_speaker")
            .unwrap();
        let signatures = db.get_cluster_voice_signatures("r1").unwrap();
        assert_eq!(signatures.len(), 1);
        assert!((signatures[0].centroid[2] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn a_rerun_clears_every_signature_even_the_same_models_and_keeps_names() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.upsert_speaker_alias("r1", "S1", Some("Dana"), None, 0)
            .unwrap();
        db.set_cluster_voice_signature("r1", "S1", &unit(&[1.0, 0.0]), "pyannote_community1")
            .unwrap();
        db.set_cluster_voice_signature("r1", "S2", &unit(&[0.0, 1.0]), "ecapa_tdnn_speaker")
            .unwrap();

        // A re-run with community-1 again still drops community-1's old
        // signature: S1 may now be someone else's stretch of audio.
        assert_eq!(db.clear_cluster_voice_signatures("r1").unwrap(), 2);
        assert!(db.get_cluster_voice_signatures("r1").unwrap().is_empty());
        assert_eq!(
            db.get_cluster_alias_names("r1")
                .unwrap()
                .get("S1")
                .map(String::as_str),
            Some("Dana"),
            "the name stays"
        );

        // The new run's signature is the only one left once written.
        db.set_cluster_voice_signature("r1", "S1", &unit(&[0.0, 1.0]), "pyannote_community1")
            .unwrap();
        let left = db.get_cluster_voice_signatures("r1").unwrap();
        assert_eq!(left.len(), 1);
        assert!((left[0].centroid[1] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn a_new_meeting_transcript_drops_names_tied_to_old_speaker_numbers() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_transcript(&sample_multi_segment_transcript("r1"))
            .unwrap();
        db.upsert_speaker_alias("r1", "S1", Some("Alice"), None, 0)
            .unwrap();
        db.upsert_speaker_alias("r1", "them", Some("Priya"), None, 0)
            .unwrap();

        db.save_meeting_transcript(&sample_multi_segment_transcript("r1"))
            .unwrap();

        let aliases = db.get_speaker_aliases("r1").unwrap();
        assert!(!aliases.contains_key("S1"), "S1 may be someone else now");
        assert_eq!(
            aliases.get("them").and_then(|(name, _, _)| name.as_deref()),
            Some("Priya"),
            "the far side of the call is the same people"
        );
    }

    #[test]
    fn deleting_a_meeting_removes_the_voice_samples_it_taught() {
        let mut db = in_memory_db();
        for id in ["r1", "r2", "r3"] {
            let mut recording = sample_recording(id, "inbox");
            recording.status = "completed".to_string();
            db.create_recording(&recording).unwrap();
        }
        // Dana was heard in r1 and r2; Lee only in r3.
        let dana = db
            .remember_speaker_voice(
                "Dana",
                "ecapa_tdnn_speaker",
                &unit(&[1.0, 0.0, 0.0]),
                Some("r1"),
                None,
            )
            .unwrap();
        db.remember_speaker_voice(
            "Dana",
            "ecapa_tdnn_speaker",
            &unit(&[0.0, 1.0, 0.0]),
            Some("r2"),
            None,
        )
        .unwrap();
        let lee = db
            .remember_speaker_voice(
                "Lee",
                "ecapa_tdnn_speaker",
                &unit(&[0.0, 0.0, 1.0]),
                Some("r3"),
                None,
            )
            .unwrap();
        let samples_from = |db: &Database, recording: &str| -> i64 {
            db.conn
                .query_row(
                    "SELECT COUNT(*) FROM speaker_profile_samples WHERE source_recording_id = ?1",
                    params![recording],
                    |row| row.get(0),
                )
                .unwrap()
        };

        db.delete_recording("r1").unwrap();
        assert_eq!(samples_from(&db, "r1"), 0);
        // Dana is now only what r2 taught.
        let (count, centroid): (i64, Vec<u8>) = db
            .conn
            .query_row(
                "SELECT sample_count, centroid FROM speaker_profiles WHERE id = ?1",
                params![&dana],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        let centroid = blob_to_f32_vec(&centroid);
        assert!((centroid[1] - 1.0).abs() < 1e-5, "{centroid:?}");

        // A voice only one deleted meeting taught goes with it.
        db.delete_recording("r3").unwrap();
        let lee_left: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM speaker_profiles WHERE id = ?1",
                params![&lee],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(lee_left, 0);
        assert_eq!(samples_from(&db, "r3"), 0);
    }

    fn profile_state(db: &Database, profile_id: &str) -> Option<(i64, Vec<f32>)> {
        db.conn
            .query_row(
                "SELECT sample_count, centroid FROM speaker_profiles WHERE id = ?1",
                params![profile_id],
                |row| Ok((row.get(0)?, blob_to_f32_vec(&row.get::<_, Vec<u8>>(1)?))),
            )
            .optional()
            .unwrap()
    }

    #[test]
    fn correcting_a_confirmed_speaker_withdraws_only_the_sample_it_added() {
        let mut db = in_memory_db();
        for id in ["r1", "r2"] {
            let mut recording = sample_recording(id, "inbox");
            recording.status = "completed".to_string();
            db.create_recording(&recording).unwrap();
        }
        // Dana was confirmed in r1. In r2, speaker_1 was wrongly confirmed as
        // Dana too, and speaker_2 rightly.
        let dana = db
            .remember_cluster_voice(
                "Dana",
                "ecapa_tdnn_speaker",
                &unit(&[1.0, 0.0, 0.0]),
                "r1",
                "speaker_0",
            )
            .unwrap();
        db.add_cluster_voice_sample(&dana, &unit(&[0.0, 1.0, 0.0]), "r2", "speaker_1")
            .unwrap();
        db.add_cluster_voice_sample(&dana, &unit(&[1.0, 0.1, 0.0]), "r2", "speaker_2")
            .unwrap();
        assert_eq!(profile_state(&db, &dana).unwrap().0, 3);

        // A rename that keeps the confirmed name is not a correction.
        assert_eq!(
            db.retract_cluster_voice_samples("r2", "speaker_1", Some(" dana "), None)
                .unwrap(),
            0
        );
        // Renaming speaker_1 to someone else withdraws its sample alone.
        assert_eq!(
            db.retract_cluster_voice_samples("r2", "speaker_1", Some("Sam"), None)
                .unwrap(),
            1
        );
        let (count, centroid) = profile_state(&db, &dana).unwrap();
        assert_eq!(count, 2);
        assert!(
            centroid[1].abs() < 0.1,
            "the wrong voice no longer pulls Dana toward it: {centroid:?}"
        );
        // Withdrawing again finds nothing: it is already gone.
        assert_eq!(
            db.retract_cluster_voice_samples("r2", "speaker_1", None, None)
                .unwrap(),
            0
        );
    }

    #[test]
    fn a_voice_taught_only_by_a_withdrawn_confirmation_is_forgotten() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("r1", "inbox");
        recording.status = "completed".to_string();
        db.create_recording(&recording).unwrap();
        let dna = db
            .remember_cluster_voice(
                "Dna",
                "ecapa_tdnn_speaker",
                &unit(&[1.0, 0.0]),
                "r1",
                "speaker_0",
            )
            .unwrap();
        let other = db
            .remember_cluster_voice(
                "Lee",
                "ecapa_tdnn_speaker",
                &unit(&[0.0, 1.0]),
                "r1",
                "speaker_1",
            )
            .unwrap();

        // "Not them" limited to another voice leaves this one alone.
        assert_eq!(
            db.retract_cluster_voice_samples("r1", "speaker_0", None, Some(other.as_str()))
                .unwrap(),
            0
        );
        assert_eq!(
            db.retract_cluster_voice_samples("r1", "speaker_0", Some("Dana"), None)
                .unwrap(),
            1
        );
        assert_eq!(profile_state(&db, &dna), None);
        assert_eq!(profile_state(&db, &other).unwrap().0, 1);
    }

    #[test]
    fn a_sample_from_before_speakers_were_recorded_is_found_through_the_alias() {
        let mut db = in_memory_db();
        let mut recording = sample_recording("r1", "inbox");
        recording.status = "completed".to_string();
        db.create_recording(&recording).unwrap();
        let wrong = unit(&[0.0, 1.0]);
        let dana = db
            .remember_speaker_voice(
                "Dana",
                "ecapa_tdnn_speaker",
                &unit(&[1.0, 0.0]),
                Some("r0"),
                None,
            )
            .unwrap();
        // The pre-migration shape: no speaker on the sample, the confirmation
        // recorded on the alias with the signature that was added.
        db.add_speaker_profile_sample(&dana, &wrong, Some("r1"))
            .unwrap();
        db.set_cluster_voice_signature("r1", "speaker_3", &wrong, "ecapa_tdnn_speaker")
            .unwrap();
        db.set_cluster_voice_match("r1", "speaker_3", &dana, voiceprints::MATCH_STATE_CONFIRMED)
            .unwrap();
        // Another speaker of r1 with no confirmation does not match it.
        assert_eq!(
            db.retract_cluster_voice_samples("r1", "speaker_4", None, None)
                .unwrap(),
            0
        );

        assert_eq!(
            db.retract_cluster_voice_samples("r1", "speaker_3", None, Some(dana.as_str()))
                .unwrap(),
            1
        );
        let (count, centroid) = profile_state(&db, &dana).unwrap();
        assert_eq!(count, 1);
        assert!((centroid[0] - 1.0).abs() < 1e-5, "{centroid:?}");
    }

    #[test]
    fn remembering_a_voice_creates_one_profile_per_name_and_embedder() {
        let mut db = in_memory_db();
        let a = db
            .remember_speaker_voice(
                "  Dana  ",
                "ecapa_tdnn_speaker",
                &unit(&[1.0, 0.0, 0.0]),
                Some("r1"),
                None,
            )
            .unwrap();
        // Same person, different capitalization: folded into the same profile.
        let b = db
            .remember_speaker_voice(
                "dana",
                "ecapa_tdnn_speaker",
                &unit(&[0.9, 0.1, 0.0]),
                Some("r2"),
                None,
            )
            .unwrap();
        assert_eq!(a, b);
        // Same name, different embedder: a separate profile, because the two
        // centroids live in unrelated spaces.
        let c = db
            .remember_speaker_voice(
                "Dana",
                "resnet34_speaker",
                &unit(&[1.0, 0.0, 0.0]),
                Some("r3"),
                None,
            )
            .unwrap();
        assert_ne!(a, c);

        let profiles = db.list_speaker_profiles().unwrap();
        assert_eq!(profiles.len(), 2);
        let folded = profiles.iter().find(|p| p.id == a).unwrap();
        assert_eq!(folded.display_name, "Dana", "the name is trimmed");
        assert_eq!(folded.sample_count, 2);
        assert_eq!(folded.linked_identity_hash, None);
        let norm = folded
            .centroid
            .iter()
            .map(|value| value * value)
            .sum::<f32>()
            .sqrt();
        assert!((norm - 1.0).abs() < 1e-5, "the centroid stays unit length");

        assert!(db
            .remember_speaker_voice("   ", "ecapa_tdnn_speaker", &unit(&[1.0, 0.0]), None, None)
            .is_err());
        assert!(db
            .remember_speaker_voice("Ravi", "ecapa_tdnn_speaker", &[0.0, 0.0], None, None)
            .is_err());
    }

    #[test]
    fn a_profile_keeps_at_most_the_sample_cap_and_averages_what_is_left() {
        let mut db = in_memory_db();
        let cap = crate::diarization::voiceprints::MAX_SAMPLES_PER_PROFILE;
        let profile_id = db
            .remember_speaker_voice("Dana", "ecapa_tdnn_speaker", &unit(&[1.0, 0.0]), None, None)
            .unwrap();
        for _ in 0..(cap + 5) {
            db.add_speaker_profile_sample(&profile_id, &unit(&[0.0, 1.0]), Some("r1"))
                .unwrap();
        }
        let stored: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM speaker_profile_samples WHERE profile_id = ?1",
                params![&profile_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored as usize, cap, "samples are capped");
        let profile = db
            .list_speaker_profiles()
            .unwrap()
            .into_iter()
            .find(|p| p.id == profile_id)
            .unwrap();
        assert_eq!(profile.sample_count as usize, cap);
        // The very first sample has aged out, so the centroid is now the
        // second vector rather than a blend of the two.
        assert!(profile.centroid[1] > 0.99, "oldest samples age out");

        assert!(db
            .add_speaker_profile_sample("no-such-profile", &unit(&[1.0, 0.0]), None)
            .is_err());
        assert!(db
            .add_speaker_profile_sample(&profile_id, &[f32::NAN, 0.0], None)
            .is_err());
    }

    #[test]
    fn rejecting_a_voice_is_remembered_and_clears_an_applied_match() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.set_cluster_voice_signature("r1", "S1", &unit(&[1.0, 0.0]), "ecapa_tdnn_speaker")
            .unwrap();
        db.set_cluster_voice_match("r1", "S1", "p-dana", "auto")
            .unwrap();
        let before = &db.get_cluster_voice_signatures("r1").unwrap()[0];
        assert_eq!(before.applied_profile_id.as_deref(), Some("p-dana"));
        assert_eq!(before.match_state.as_deref(), Some("auto"));

        db.reject_cluster_voice_match("r1", "S1", "p-dana").unwrap();
        let after = &db.get_cluster_voice_signatures("r1").unwrap()[0];
        assert_eq!(after.rejected_profile_ids, vec!["p-dana".to_string()]);
        assert_eq!(after.applied_profile_id, None, "the wrong name is removed");
        assert_eq!(after.match_state, None);

        // A second rejection accumulates; the same one does not duplicate.
        db.reject_cluster_voice_match("r1", "S1", "p-devon")
            .unwrap();
        db.reject_cluster_voice_match("r1", "S1", "p-dana").unwrap();
        let after = &db.get_cluster_voice_signatures("r1").unwrap()[0];
        assert_eq!(
            after.rejected_profile_ids,
            vec!["p-dana".to_string(), "p-devon".to_string()]
        );
    }

    /// A cluster nobody has named has no alias row at all, and since
    /// signatures are only written for named clusters that is the ordinary
    /// case for "Not them". The rejection has to create the row, or the same
    /// wrong suggestion comes back on every visit.
    #[test]
    fn a_rejection_sticks_on_a_cluster_that_has_no_alias_row() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        assert!(db.get_speaker_aliases("r1").unwrap().is_empty());

        db.reject_cluster_voice_match("r1", "S2", "p-dana").unwrap();

        let rejections = db.get_cluster_voice_rejections("r1").unwrap();
        assert_eq!(
            rejections.get("S2").cloned(),
            Some(vec!["p-dana".to_string()])
        );
        assert!(
            db.get_cluster_voice_signatures("r1").unwrap().is_empty(),
            "rejecting a suggestion must not invent a signature"
        );
        let named: Option<Option<String>> = db
            .conn
            .query_row(
                "SELECT name FROM speaker_aliases WHERE recording_id = 'r1' AND speaker_id = 'S2'",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(
            named,
            Some(None),
            "the row exists and carries no name of its own"
        );

        // And a second rejection on the same unnamed cluster accumulates.
        db.reject_cluster_voice_match("r1", "S2", "p-devon")
            .unwrap();
        assert_eq!(
            db.get_cluster_voice_rejections("r1").unwrap().get("S2"),
            Some(&vec!["p-dana".to_string(), "p-devon".to_string()])
        );
    }

    /// Typing a name over a name Plainsong applied by itself has to settle the
    /// question: the transcript stops saying "auto", and the cluster stops
    /// pointing at the remembered voice the rename was most likely correcting.
    #[test]
    fn renaming_a_speaker_clears_the_auto_marker_and_the_voice_link() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_transcript(&sample_transcript("r1")).unwrap();
        db.set_cluster_voice_signature("r1", "speaker_0", &unit(&[1.0, 0.0]), "ecapa_tdnn_speaker")
            .unwrap();
        db.set_cluster_voice_match("r1", "speaker_0", "p-dana", "auto")
            .unwrap();

        db.rename_speaker("r1", "speaker_0", "Ravi").unwrap();

        let signature = &db.get_cluster_voice_signatures("r1").unwrap()[0];
        assert_eq!(signature.name.as_deref(), Some("Ravi"));
        assert_eq!(
            signature.applied_profile_id, None,
            "a hand-typed name unlinks the remembered voice it replaced"
        );
        assert_eq!(signature.match_state, None, "and stops saying \"auto\"");
        assert!(
            !signature.centroid.is_empty(),
            "the meeting's own signature is untouched"
        );
    }

    /// The confirm path renames first and marks the match afterwards, so
    /// clearing the link on rename must not undo the confirmation.
    #[test]
    fn confirming_after_a_rename_still_leaves_the_match_confirmed() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.save_transcript(&sample_transcript("r1")).unwrap();
        db.set_cluster_voice_signature("r1", "speaker_0", &unit(&[1.0, 0.0]), "ecapa_tdnn_speaker")
            .unwrap();

        db.rename_speaker("r1", "speaker_0", "Dana").unwrap();
        db.set_cluster_voice_match("r1", "speaker_0", "p-dana", "confirmed")
            .unwrap();

        let signature = &db.get_cluster_voice_signatures("r1").unwrap()[0];
        assert_eq!(signature.applied_profile_id.as_deref(), Some("p-dana"));
        assert_eq!(signature.match_state.as_deref(), Some("confirmed"));
    }

    #[test]
    fn forgetting_one_voice_removes_its_samples_and_detaches_its_clusters() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let dana = db
            .remember_speaker_voice("Dana", "ecapa_tdnn_speaker", &unit(&[1.0, 0.0]), None, None)
            .unwrap();
        let devon = db
            .remember_speaker_voice(
                "Devon",
                "ecapa_tdnn_speaker",
                &unit(&[0.0, 1.0]),
                None,
                None,
            )
            .unwrap();
        db.set_cluster_voice_signature("r1", "S1", &unit(&[1.0, 0.0]), "ecapa_tdnn_speaker")
            .unwrap();
        db.set_cluster_voice_match("r1", "S1", &dana, "confirmed")
            .unwrap();

        assert!(db.forget_speaker_voice(&dana).unwrap());
        assert!(!db.forget_speaker_voice(&dana).unwrap(), "already gone");
        let remaining = db.list_speaker_profiles().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, devon);
        let orphaned_samples: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM speaker_profile_samples WHERE profile_id = ?1",
                params![&dana],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(orphaned_samples, 0);
        let cluster = &db.get_cluster_voice_signatures("r1").unwrap()[0];
        assert_eq!(cluster.applied_profile_id, None);
        assert_eq!(cluster.match_state, None);
        assert!(
            !cluster.centroid.is_empty(),
            "forgetting one voice keeps the meeting's own signature"
        );
    }

    /// "Delete all" has to mean all: the profiles, their samples, and the
    /// per-cluster signatures that are themselves voice data.
    #[test]
    fn forgetting_all_voices_also_clears_every_cluster_signature() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        let dana = db
            .remember_speaker_voice("Dana", "ecapa_tdnn_speaker", &unit(&[1.0, 0.0]), None, None)
            .unwrap();
        db.remember_speaker_voice(
            "Devon",
            "ecapa_tdnn_speaker",
            &unit(&[0.0, 1.0]),
            None,
            None,
        )
        .unwrap();
        db.set_cluster_voice_signature("r1", "S1", &unit(&[1.0, 0.0]), "ecapa_tdnn_speaker")
            .unwrap();
        db.set_cluster_voice_match("r1", "S1", &dana, "confirmed")
            .unwrap();
        // S2 was never named, so it has no alias row until the rejection
        // creates one. Asserting it landed is the point: before the upsert
        // this leg wrote nothing and the assertion below passed vacuously.
        db.reject_cluster_voice_match("r1", "S2", "p-other")
            .unwrap();
        assert_eq!(
            db.get_cluster_voice_rejections("r1")
                .unwrap()
                .get("S2")
                .cloned(),
            Some(vec!["p-other".to_string()]),
            "a rejection on an unnamed cluster is stored"
        );

        assert_eq!(db.forget_all_speaker_voices().unwrap(), 2);
        assert!(db.list_speaker_profiles().unwrap().is_empty());
        assert!(db.get_cluster_voice_signatures("r1").unwrap().is_empty());
        let leftovers: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM speaker_aliases
                 WHERE voice_centroid IS NOT NULL
                    OR voice_profile_id IS NOT NULL
                    OR voice_match_state IS NOT NULL
                    OR voice_rejected_profiles IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(leftovers, 0);
        let samples: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM speaker_profile_samples", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(samples, 0);
    }

    /// Deleting a meeting takes its cluster signatures with it, but leaves the
    /// remembered voices alone — those belong to the person, not the meeting.
    #[test]
    fn deleting_a_recording_removes_its_signatures_and_keeps_remembered_voices() {
        let mut db = in_memory_db();
        db.create_recording(&sample_recording("r1", "inbox"))
            .unwrap();
        db.remember_speaker_voice("Dana", "ecapa_tdnn_speaker", &unit(&[1.0, 0.0]), None, None)
            .unwrap();
        db.set_cluster_voice_signature("r1", "S1", &unit(&[1.0, 0.0]), "ecapa_tdnn_speaker")
            .unwrap();
        db.update_recording_status("r1", "completed").unwrap();

        db.delete_recording("r1").unwrap();
        assert!(db.get_cluster_voice_signatures("r1").unwrap().is_empty());
        assert_eq!(db.list_speaker_profiles().unwrap().len(), 1);
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
    fn dictionary_create_replay_returns_same_normalized_entry_without_mutation() {
        let mut db = in_memory_db();
        let first = db
            .create_dictation_dictionary_entry(&CreateDictationDictionaryEntryRequest {
                spoken_form: "  open ai  ".to_string(),
                replacement: "  OpenAI  ".to_string(),
                app_scope: Some("   ".to_string()),
                case_sensitive: false,
                enabled: true,
                category_scope: Some("  EMAIL  ".to_string()),
            })
            .unwrap();
        let replay = db
            .create_dictation_dictionary_entry(&CreateDictationDictionaryEntryRequest {
                spoken_form: "open ai".to_string(),
                replacement: "OpenAI".to_string(),
                app_scope: None,
                case_sensitive: false,
                enabled: true,
                category_scope: Some("email".to_string()),
            })
            .unwrap();

        assert_eq!(replay.id, first.id);
        assert_eq!(replay.created_at, first.created_at);
        assert_eq!(replay.updated_at, first.updated_at);
        assert_eq!(replay.spoken_form, "open ai");
        assert_eq!(replay.replacement, "OpenAI");
        assert!(replay.app_scope.is_none());
        assert_eq!(replay.category_scope.as_deref(), Some("email"));
        assert_eq!(db.list_dictation_dictionary_entries().unwrap().len(), 1);
    }

    #[test]
    fn dictionary_create_keeps_distinct_tuple_semantics() {
        let mut db = in_memory_db();
        let requests = [
            CreateDictationDictionaryEntryRequest {
                spoken_form: "jon".into(),
                replacement: "John".into(),
                app_scope: None,
                case_sensitive: false,
                enabled: true,
                category_scope: None,
            },
            CreateDictationDictionaryEntryRequest {
                spoken_form: "jon".into(),
                replacement: "Jon".into(),
                app_scope: None,
                case_sensitive: false,
                enabled: true,
                category_scope: None,
            },
            CreateDictationDictionaryEntryRequest {
                spoken_form: "jon".into(),
                replacement: "John".into(),
                app_scope: Some("Mail".into()),
                case_sensitive: false,
                enabled: true,
                category_scope: None,
            },
            CreateDictationDictionaryEntryRequest {
                spoken_form: "jon".into(),
                replacement: "John".into(),
                app_scope: None,
                case_sensitive: true,
                enabled: true,
                category_scope: None,
            },
            CreateDictationDictionaryEntryRequest {
                spoken_form: "jon".into(),
                replacement: "John".into(),
                app_scope: None,
                case_sensitive: false,
                enabled: false,
                category_scope: None,
            },
            CreateDictationDictionaryEntryRequest {
                spoken_form: "jon".into(),
                replacement: "John".into(),
                app_scope: None,
                case_sensitive: false,
                enabled: true,
                category_scope: Some("email".into()),
            },
        ];

        let ids = requests
            .iter()
            .map(|request| db.create_dictation_dictionary_entry(request).unwrap().id)
            .collect::<HashSet<_>>();
        assert_eq!(ids.len(), requests.len());
        assert_eq!(
            db.list_dictation_dictionary_entries().unwrap().len(),
            requests.len()
        );
    }

    #[test]
    fn dictionary_create_replay_succeeds_at_capacity() {
        let mut db = in_memory_db();
        let request = CreateDictationDictionaryEntryRequest {
            spoken_form: "open ai".into(),
            replacement: "OpenAI".into(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: None,
        };
        let existing = db.create_dictation_dictionary_entry(&request).unwrap();
        let timestamp = Utc::now().to_rfc3339();
        let tx = db.conn.transaction().unwrap();
        for index in 1..MAX_DICTIONARY_ENTRIES {
            tx.execute(
                "INSERT INTO dictation_dictionary_entries (
                    id, spoken_form, replacement, app_scope, case_sensitive, enabled,
                    category_scope, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, NULL, 0, 1, NULL, ?4, ?4)",
                params![
                    format!("capacity-{index}"),
                    format!("spoken-{index}"),
                    format!("replacement-{index}"),
                    &timestamp,
                ],
            )
            .unwrap();
        }
        tx.commit().unwrap();

        let replay = db.create_dictation_dictionary_entry(&request).unwrap();
        assert_eq!(replay.id, existing.id);
        assert_eq!(replay.created_at, existing.created_at);
        assert_eq!(replay.updated_at, existing.updated_at);
        let count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM dictation_dictionary_entries",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, MAX_DICTIONARY_ENTRIES);

        let distinct =
            db.create_dictation_dictionary_entry(&CreateDictationDictionaryEntryRequest {
                replacement: "Open AI".into(),
                ..request
            });
        assert!(distinct
            .unwrap_err()
            .to_string()
            .contains("Dictionary entry limit reached"));
    }

    #[test]
    fn test_dictation_dictionary_entry_rejects_oversized_fields() {
        let mut db = in_memory_db();
        let result = db.create_dictation_dictionary_entry(&CreateDictationDictionaryEntryRequest {
            spoken_form: "a".repeat(MAX_DICTIONARY_SPOKEN_FORM_BYTES + 1),
            replacement: "replacement".to_string(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: None,
        });
        assert!(result.is_err());

        let result = db.create_dictation_dictionary_entry(&CreateDictationDictionaryEntryRequest {
            spoken_form: "word".to_string(),
            replacement: "a".repeat(MAX_DICTIONARY_REPLACEMENT_BYTES + 1),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: None,
        });
        assert!(result.is_err());
    }

    fn queue_undo_fixture(db: &mut Database, spoken: &str, replacement: &str) -> String {
        db.upsert_dictation_correction_suggestion(
            "Sentence not retained in the undo receipt",
            "Corrected sentence not retained",
            spoken,
            replacement,
            None,
            None,
        )
        .unwrap()
        .1
        .id
    }

    fn approval_snapshot(
        db: &Database,
        suggestion_id: &str,
    ) -> CorrectionApprovalDictionarySnapshot {
        db.get_dictation_correction_suggestion(suggestion_id)
            .unwrap()
            .unwrap()
            .approval_dictionary
            .unwrap()
    }

    fn dictionary_revision(db: &Database, id: &str) -> i64 {
        db.conn
            .query_row(
                "SELECT revision FROM dictation_dictionary_entries WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn correction_approval_snapshot_serialization_and_upsert_refresh() {
        assert_eq!(
            serde_json::to_value(CorrectionApprovalDictionarySnapshot::Missing).unwrap(),
            serde_json::json!({"kind": "missing"})
        );
        assert_eq!(
            serde_json::to_value(CorrectionApprovalDictionarySnapshot::Entry {
                entry_id: "entry".into(),
                revision: 42,
                spoken_form: "Jon".into(),
                replacement: "Jonathan".into(),
            })
            .unwrap(),
            serde_json::json!({"kind": "entry", "entryId": "entry", "revision": 42, "spokenForm": "Jon", "replacement": "Jonathan"})
        );
        let mut db = in_memory_db();
        let suggestion = queue_undo_fixture(&mut db, "Jon", "John");
        assert_eq!(
            approval_snapshot(&db, &suggestion),
            CorrectionApprovalDictionarySnapshot::Missing
        );
        let entry = db
            .learn_dictation_correction("Jon", "Manual")
            .unwrap()
            .entry
            .unwrap();
        let expected = CorrectionApprovalDictionarySnapshot::Entry {
            entry_id: entry.id.clone(),
            revision: dictionary_revision(&db, &entry.id),
            spoken_form: entry.spoken_form.clone(),
            replacement: entry.replacement.clone(),
        };
        assert_eq!(approval_snapshot(&db, &suggestion), expected);
        let refreshed = db
            .upsert_dictation_correction_suggestion("Jon", "John", "Jon", "John", None, None)
            .unwrap()
            .1;
        assert_eq!(refreshed.id, suggestion);
        assert_eq!(refreshed.approval_dictionary, Some(expected));
    }

    #[test]
    fn correction_approval_snapshot_rejects_manual_edit_aba_and_recreated_target() {
        let mut db = in_memory_db();
        let entry = db
            .create_dictation_dictionary_entry(&CreateDictationDictionaryEntryRequest {
                spoken_form: "Jon".into(),
                replacement: "Initial".into(),
                app_scope: None,
                case_sensitive: false,
                enabled: true,
                category_scope: None,
            })
            .unwrap();
        let suggestion = queue_undo_fixture(&mut db, "Jon", "John");
        let expected = approval_snapshot(&db, &suggestion);
        db.conn
            .execute(
                "UPDATE dictation_dictionary_entries SET replacement = 'Manual' WHERE id = ?1",
                [&entry.id],
            )
            .unwrap();
        assert!(db
            .approve_dictation_correction_suggestion(&suggestion, &expected)
            .is_err());
        assert_eq!(
            db.list_dictation_dictionary_entries().unwrap()[0].replacement,
            "Manual"
        );
        db.conn
            .execute(
                "UPDATE dictation_dictionary_entries SET replacement = 'Initial' WHERE id = ?1",
                [&entry.id],
            )
            .unwrap();
        assert!(db
            .approve_dictation_correction_suggestion(&suggestion, &expected)
            .is_err());
        let refreshed = approval_snapshot(&db, &suggestion);
        assert_ne!(expected, refreshed);
        db.delete_dictation_dictionary_entry(&entry.id).unwrap();
        db.conn.execute(
            "INSERT INTO dictation_dictionary_entries
             (id, spoken_form, replacement, app_scope, case_sensitive, enabled, category_scope, created_at, updated_at)
             VALUES (?1, 'Jon', 'Initial', NULL, 0, 1, NULL, ?2, ?2)",
            params![&entry.id, Utc::now().to_rfc3339()],
        ).unwrap();
        assert!(db
            .approve_dictation_correction_suggestion(&suggestion, &refreshed)
            .is_err());
        assert!(db
            .get_dictation_correction_suggestion(&suggestion)
            .unwrap()
            .is_some());
        assert!(db.correction_approval_undo.is_empty());
    }

    #[test]
    fn correction_approval_missing_snapshot_rejects_new_dictionary_entry() {
        let mut db = in_memory_db();
        let suggestion = queue_undo_fixture(&mut db, "Jon", "John");
        let expected = approval_snapshot(&db, &suggestion);
        assert_eq!(expected, CorrectionApprovalDictionarySnapshot::Missing);
        db.learn_dictation_correction("Jon", "Manual").unwrap();
        assert!(db
            .approve_dictation_correction_suggestion(&suggestion, &expected)
            .is_err());
        assert_eq!(
            db.list_dictation_dictionary_entries().unwrap()[0].replacement,
            "Manual"
        );
    }

    #[test]
    fn correction_approval_and_learning_leave_inactive_and_scoped_rules_untouched() {
        for (enabled, app_scope, category_scope) in [
            (false, None, Some("email")),
            (false, None, None),
            (true, None, Some("email")),
            (true, Some("Mail"), None),
        ] {
            let mut db = in_memory_db();
            let original = db
                .create_dictation_dictionary_entry(&CreateDictationDictionaryEntryRequest {
                    spoken_form: "Jon".into(),
                    replacement: "Original".into(),
                    app_scope: app_scope.map(str::to_string),
                    case_sensitive: true,
                    enabled,
                    category_scope: category_scope.map(str::to_string),
                })
                .unwrap();
            let original_revision = dictionary_revision(&db, &original.id);
            let suggestion = queue_undo_fixture(&mut db, "Jon", "John");
            let learned = db
                .approve_dictation_correction_suggestion(
                    &suggestion,
                    &approval_snapshot(&db, &suggestion),
                )
                .unwrap();
            let entry = learned.entry.unwrap();
            assert_ne!(entry.id, original.id);
            assert!(entry.enabled);
            assert!(entry.app_scope.is_none());
            assert!(entry.category_scope.is_none());
            assert_eq!(learned.action.as_deref(), Some("created"));
            let entries = db.list_dictation_dictionary_entries().unwrap();
            assert_eq!(
                serde_json::to_value(entries.iter().find(|entry| entry.id == original.id)).unwrap(),
                serde_json::to_value(Some(&original)).unwrap()
            );
            assert_eq!(dictionary_revision(&db, &original.id), original_revision);
            let (text, applied) = crate::dictation_pipeline::apply_learned_dictionary(
                "Hello Jon",
                &entries,
                Some("Notes"),
                crate::text::format::DictationAppCategory::Notes,
            );
            assert_eq!(text, "Hello John");
            assert_eq!(applied, 1);
            db.undo_dictation_correction_approval(learned.undo_token.as_deref().unwrap())
                .unwrap();
            let direct = db
                .learn_dictation_correction("JON", "Jonathan")
                .unwrap()
                .entry
                .unwrap();
            assert_ne!(direct.id, original.id);
            assert!(direct.enabled);
            assert!(direct.app_scope.is_none());
            assert!(direct.category_scope.is_none());
            assert_eq!(dictionary_revision(&db, &original.id), original_revision);
        }
    }

    #[test]
    fn correction_approval_rejects_expired_invalid_and_future_suggestions() {
        let mut db = in_memory_db();
        let suggestion = queue_undo_fixture(&mut db, "Jon", "John");
        let expected = approval_snapshot(&db, &suggestion);
        for timestamp in [
            (Utc::now()
                - chrono::Duration::days(
                    crate::dictation_correction_capture::CORRECTION_SUGGESTION_MAX_AGE_DAYS,
                ))
            .to_rfc3339(),
            "invalid".into(),
            (Utc::now() + chrono::Duration::days(1)).to_rfc3339(),
        ] {
            db.conn
                .execute(
                    "UPDATE dictation_correction_suggestions SET updated_at = ?1 WHERE id = ?2",
                    params![timestamp, &suggestion],
                )
                .unwrap();
            assert!(db
                .approve_dictation_correction_suggestion(&suggestion, &expected)
                .is_err());
            assert!(db
                .get_dictation_correction_suggestion(&suggestion)
                .unwrap()
                .is_some());
            assert!(db.list_dictation_dictionary_entries().unwrap().is_empty());
            assert!(db.correction_approval_undo.is_empty());
        }
    }

    #[test]
    fn direct_correction_learning_undo_restores_prior_entry_and_refuses_newer_edits() {
        let mut db = in_memory_db();
        let original = db
            .learn_dictation_correction("Jon", "Jonathan")
            .unwrap()
            .entry
            .unwrap();
        let learned = db.learn_dictation_correction("Jon", "John").unwrap();
        let restored = db
            .undo_dictation_correction_approval(learned.undo_token.as_deref().unwrap())
            .unwrap()
            .entry
            .unwrap();
        assert_eq!(restored.id, original.id);
        assert_eq!(restored.replacement, "Jonathan");
        let learned = db.learn_dictation_correction("Jon", "John").unwrap();
        db.conn
            .execute(
                "UPDATE dictation_dictionary_entries SET replacement = 'Johnny' WHERE id = ?1",
                [&original.id],
            )
            .unwrap();
        assert!(db
            .undo_dictation_correction_approval(learned.undo_token.as_deref().unwrap())
            .is_err());
        assert_eq!(
            db.list_dictation_dictionary_entries().unwrap()[0].replacement,
            "Johnny"
        );
        let created = db.learn_dictation_correction("Sara", "Sarah").unwrap();
        let undone = db
            .undo_dictation_correction_approval(created.undo_token.as_deref().unwrap())
            .unwrap();
        assert!(undone.entry.is_none());
        assert_eq!(db.list_dictation_dictionary_entries().unwrap().len(), 1);
    }

    #[test]
    fn direct_correction_learning_rolls_back_on_suggestion_delete_failure() {
        let mut db = in_memory_db();
        let original = db
            .learn_dictation_correction("Jon", "Original")
            .unwrap()
            .entry
            .unwrap();
        let suggestion = queue_undo_fixture(&mut db, "Jon", "John");
        let revision = dictionary_revision(&db, &original.id);
        db.conn.execute_batch("CREATE TRIGGER deny_learning_delete BEFORE DELETE ON dictation_correction_suggestions
            BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END;").unwrap();
        assert!(db.learn_dictation_correction("Jon", "John").is_err());
        assert_eq!(
            db.list_dictation_dictionary_entries().unwrap()[0].replacement,
            "Original"
        );
        assert_eq!(dictionary_revision(&db, &original.id), revision);
        assert!(db
            .get_dictation_correction_suggestion(&suggestion)
            .unwrap()
            .is_some());
        db.conn
            .execute_batch("DROP TRIGGER deny_learning_delete;")
            .unwrap();
        assert_eq!(
            db.learn_dictation_correction("Jon", "John")
                .unwrap()
                .action
                .as_deref(),
            Some("updated")
        );
        assert!(db
            .get_dictation_correction_suggestion(&suggestion)
            .unwrap()
            .is_none());
    }

    #[test]
    fn correction_approval_undo_created_entry_and_replay() {
        let mut db = in_memory_db();
        let suggestion = queue_undo_fixture(&mut db, "Jon", "John");
        let learned = db
            .approve_dictation_correction_suggestion(
                &suggestion,
                &approval_snapshot(&db, &suggestion),
            )
            .unwrap();
        let token = learned.undo_token.unwrap();
        let entry = learned.entry.unwrap();
        assert_eq!(learned.action.as_deref(), Some("created"));
        assert!(db
            .get_dictation_correction_suggestion(&suggestion)
            .unwrap()
            .is_none());
        assert!(db.correction_approval_undo[&token].previous_entry.is_none());
        assert!(dictionary_revision(&db, &entry.id) > 0);
        let undone = db.undo_dictation_correction_approval(&token).unwrap();
        assert_eq!(undone.entry_id, entry.id);
        assert!(undone.entry.is_none());
        assert!(db.list_dictation_dictionary_entries().unwrap().is_empty());
        assert!(db.undo_dictation_correction_approval(&token).is_err());
    }

    #[test]
    fn correction_approval_undo_restores_all_prior_fields() {
        let mut db = in_memory_db();
        let original = db
            .create_dictation_dictionary_entry(&CreateDictationDictionaryEntryRequest {
                spoken_form: "jOn".into(),
                replacement: "Original".into(),
                app_scope: None,
                case_sensitive: true,
                enabled: true,
                category_scope: None,
            })
            .unwrap();
        let suggestion = queue_undo_fixture(&mut db, "Jon", "John");
        let learned = db
            .approve_dictation_correction_suggestion(
                &suggestion,
                &approval_snapshot(&db, &suggestion),
            )
            .unwrap();
        assert_eq!(learned.action.as_deref(), Some("updated"));
        let changed_revision = dictionary_revision(&db, &original.id);
        let restored = db
            .undo_dictation_correction_approval(learned.undo_token.as_deref().unwrap())
            .unwrap()
            .entry
            .unwrap();
        assert_eq!(restored.id, original.id);
        assert_eq!(restored.spoken_form, original.spoken_form);
        assert_eq!(restored.replacement, original.replacement);
        assert_eq!(restored.app_scope, original.app_scope);
        assert_eq!(restored.case_sensitive, original.case_sensitive);
        assert_eq!(restored.enabled, original.enabled);
        assert_eq!(restored.category_scope, original.category_scope);
        assert_eq!(restored.created_at, original.created_at);
        assert!(dictionary_revision(&db, &original.id) > changed_revision);
    }

    #[test]
    fn correction_approval_undo_rejects_aba_even_with_same_timestamp() {
        let mut db = in_memory_db();
        let suggestion = queue_undo_fixture(&mut db, "Jon", "John");
        let learned = db
            .approve_dictation_correction_suggestion(
                &suggestion,
                &approval_snapshot(&db, &suggestion),
            )
            .unwrap();
        let entry = learned.entry.unwrap();
        let expected = dictionary_revision(&db, &entry.id);
        db.conn
            .execute(
                "UPDATE dictation_dictionary_entries SET replacement = 'Other' WHERE id = ?1",
                [&entry.id],
            )
            .unwrap();
        db.conn.execute("UPDATE dictation_dictionary_entries SET replacement = ?1, updated_at = ?2 WHERE id = ?3",
            params![&entry.replacement, entry.updated_at.to_rfc3339(), &entry.id]).unwrap();
        assert!(dictionary_revision(&db, &entry.id) > expected);
        assert!(db
            .undo_dictation_correction_approval(learned.undo_token.as_deref().unwrap())
            .is_err());
        assert_eq!(
            db.list_dictation_dictionary_entries().unwrap()[0].replacement,
            "John"
        );
    }

    #[test]
    fn correction_approval_undo_rejects_deleted_and_recreated_identity() {
        let mut db = in_memory_db();
        let suggestion = queue_undo_fixture(&mut db, "Jon", "John");
        let learned = db
            .approve_dictation_correction_suggestion(
                &suggestion,
                &approval_snapshot(&db, &suggestion),
            )
            .unwrap();
        let entry = learned.entry.unwrap();
        let expected = dictionary_revision(&db, &entry.id);
        let token = learned.undo_token.unwrap();
        db.delete_dictation_dictionary_entry(&entry.id).unwrap();
        assert!(db.undo_dictation_correction_approval(&token).is_err());
        db.conn.execute(
            "INSERT INTO dictation_dictionary_entries
             (id, spoken_form, replacement, app_scope, case_sensitive, enabled, category_scope, created_at, updated_at)
             VALUES (?1, ?2, ?3, NULL, 0, 1, NULL, ?4, ?5)",
            params![&entry.id, &entry.spoken_form, &entry.replacement, entry.created_at.to_rfc3339(), entry.updated_at.to_rfc3339()],
        ).unwrap();
        assert!(dictionary_revision(&db, &entry.id) > expected);
        assert!(db.undo_dictation_correction_approval(&token).is_err());
        assert_eq!(
            db.list_dictation_dictionary_entries().unwrap()[0].id,
            entry.id
        );
    }

    #[test]
    fn correction_approval_undo_receipts_expire_and_are_bounded() {
        let mut db = in_memory_db();
        let mut first = String::new();
        let mut latest = String::new();
        for index in 0..=CORRECTION_APPROVAL_UNDO_CAP {
            let suggestion = queue_undo_fixture(
                &mut db,
                &format!("spoken-{index}"),
                &format!("written-{index}"),
            );
            latest = db
                .approve_dictation_correction_suggestion(
                    &suggestion,
                    &approval_snapshot(&db, &suggestion),
                )
                .unwrap()
                .undo_token
                .unwrap();
            if index == 0 {
                first = latest.clone();
                db.correction_approval_undo
                    .get_mut(&first)
                    .unwrap()
                    .issued_at = std::time::Instant::now()
                    .checked_sub(std::time::Duration::from_secs(1))
                    .unwrap();
            }
        }
        assert_eq!(
            db.correction_approval_undo.len(),
            CORRECTION_APPROVAL_UNDO_CAP
        );
        assert!(!db.correction_approval_undo.contains_key(&first));
        assert!(db.undo_dictation_correction_approval(&first).is_err());
        db.correction_approval_undo
            .get_mut(&latest)
            .unwrap()
            .issued_at = std::time::Instant::now()
            .checked_sub(CORRECTION_APPROVAL_UNDO_TTL + std::time::Duration::from_secs(1))
            .unwrap();
        assert!(db.undo_dictation_correction_approval(&latest).is_err());
        assert_eq!(
            db.list_dictation_dictionary_entries().unwrap().len(),
            CORRECTION_APPROVAL_UNDO_CAP + 1
        );
    }

    #[test]
    fn correction_approval_undo_approval_rolls_back_if_suggestion_delete_fails() {
        let mut db = in_memory_db();
        let suggestion = queue_undo_fixture(&mut db, "Jon", "John");
        db.conn.execute_batch("CREATE TRIGGER deny_suggestion_delete BEFORE DELETE ON dictation_correction_suggestions
            BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END;").unwrap();
        assert!(db
            .approve_dictation_correction_suggestion(
                &suggestion,
                &approval_snapshot(&db, &suggestion)
            )
            .is_err());
        assert!(db.list_dictation_dictionary_entries().unwrap().is_empty());
        assert!(db
            .get_dictation_correction_suggestion(&suggestion)
            .unwrap()
            .is_some());
        assert!(db.correction_approval_undo.is_empty());
        db.conn
            .execute_batch("DROP TRIGGER deny_suggestion_delete;")
            .unwrap();
        assert!(db
            .approve_dictation_correction_suggestion(
                &suggestion,
                &approval_snapshot(&db, &suggestion)
            )
            .is_ok());
    }

    #[test]
    fn correction_approval_undo_failed_restore_retains_receipt_for_retry() {
        let mut db = in_memory_db();
        let original = db
            .create_dictation_dictionary_entry(&CreateDictationDictionaryEntryRequest {
                spoken_form: "Jon".into(),
                replacement: "Original".into(),
                app_scope: None,
                case_sensitive: true,
                enabled: true,
                category_scope: None,
            })
            .unwrap();
        let suggestion = queue_undo_fixture(&mut db, "Jon", "John");
        let learned = db
            .approve_dictation_correction_suggestion(
                &suggestion,
                &approval_snapshot(&db, &suggestion),
            )
            .unwrap();
        let token = learned.undo_token.unwrap();
        let expected_revision = dictionary_revision(&db, &original.id);
        db.conn.execute_batch("CREATE TRIGGER deny_dictionary_restore BEFORE UPDATE OF replacement ON dictation_dictionary_entries
            WHEN NEW.replacement = 'Original' BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END;").unwrap();
        assert!(db.undo_dictation_correction_approval(&token).is_err());
        assert_eq!(dictionary_revision(&db, &original.id), expected_revision);
        assert_eq!(
            db.list_dictation_dictionary_entries().unwrap()[0].replacement,
            "John"
        );
        assert!(db.correction_approval_undo.contains_key(&token));
        db.conn
            .execute_batch("DROP TRIGGER deny_dictionary_restore;")
            .unwrap();
        assert_eq!(
            db.undo_dictation_correction_approval(&token)
                .unwrap()
                .entry
                .unwrap()
                .replacement,
            "Original"
        );
    }

    #[test]
    fn correction_approval_undo_old_receipt_cannot_revert_a_newer_approval() {
        let mut db = in_memory_db();
        let first_suggestion = queue_undo_fixture(&mut db, "Jon", "John");
        let first = db
            .approve_dictation_correction_suggestion(
                &first_suggestion,
                &approval_snapshot(&db, &first_suggestion),
            )
            .unwrap();
        let second_suggestion = queue_undo_fixture(&mut db, "Jon", "Jonathan");
        let second = db
            .approve_dictation_correction_suggestion(
                &second_suggestion,
                &approval_snapshot(&db, &second_suggestion),
            )
            .unwrap();
        assert!(db
            .undo_dictation_correction_approval(first.undo_token.as_deref().unwrap())
            .is_err());
        let restored = db
            .undo_dictation_correction_approval(second.undo_token.as_deref().unwrap())
            .unwrap()
            .entry
            .unwrap();
        assert_eq!(restored.replacement, "John");
        assert!(db
            .undo_dictation_correction_approval(first.undo_token.as_deref().unwrap())
            .is_err());
        assert_eq!(
            db.list_dictation_dictionary_entries().unwrap()[0].replacement,
            "John"
        );
    }

    #[test]
    fn correction_approval_undo_migration_preserves_legacy_entries_and_adds_revision() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE dictation_dictionary_entries (
            id TEXT PRIMARY KEY, spoken_form TEXT NOT NULL, replacement TEXT NOT NULL,
            app_scope TEXT, case_sensitive INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
            category_scope TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            INSERT INTO dictation_dictionary_entries VALUES ('legacy', 'Jon', 'Original', NULL, 1, 0,
                'email', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');").unwrap();
        let mut db = Database {
            conn,
            encrypted: false,
            correction_approval_undo: HashMap::new(),
        };
        db.init_tables().unwrap();
        let original = db.list_dictation_dictionary_entries().unwrap().remove(0);
        assert_eq!(original.id, "legacy");
        assert_eq!(original.replacement, "Original");
        assert!(original.case_sensitive);
        assert!(!original.enabled);
        assert_eq!(original.category_scope.as_deref(), Some("email"));
        assert_eq!(dictionary_revision(&db, "legacy"), 0);
        db.conn
            .execute(
                "UPDATE dictation_dictionary_entries SET enabled = 1 WHERE id = 'legacy'",
                [],
            )
            .unwrap();
        assert!(dictionary_revision(&db, "legacy") > 0);
        db.init_tables().unwrap();
        assert!(dictionary_revision(&db, "legacy") > 0);
    }

    #[test]
    fn correction_approval_undo_dictionary_updates_advance_revision_with_recursive_triggers() {
        let mut db = in_memory_db();
        db.conn
            .execute_batch("PRAGMA recursive_triggers = ON;")
            .unwrap();
        let entry = db
            .create_dictation_dictionary_entry(&CreateDictationDictionaryEntryRequest {
                spoken_form: "Jon".into(),
                replacement: "John".into(),
                app_scope: None,
                case_sensitive: false,
                enabled: true,
                category_scope: None,
            })
            .unwrap();
        let initial = dictionary_revision(&db, &entry.id);
        db.update_dictation_dictionary_entry(
            &entry.id,
            &UpdateDictationDictionaryEntryRequest {
                spoken_form: None,
                replacement: None,
                app_scope: None,
                case_sensitive: None,
                enabled: Some(false),
                category_scope: None,
            },
        )
        .unwrap();
        assert!(dictionary_revision(&db, &entry.id) > initial);
    }

    #[test]
    fn learned_global_correction_requires_an_enabled_unscoped_exact_replacement() {
        let mut db = in_memory_db();
        let entry = db
            .create_dictation_dictionary_entry(&CreateDictationDictionaryEntryRequest {
                spoken_form: "janavi".into(),
                replacement: "Jeanne-Oui".into(),
                app_scope: None,
                case_sensitive: false,
                enabled: true,
                category_scope: None,
            })
            .unwrap();
        assert!(db
            .has_learned_global_dictation_correction("JANAVI", "Jeanne-Oui")
            .unwrap());
        assert!(!db
            .has_learned_global_dictation_correction("janavi", "jeanne-oui")
            .unwrap());
        let unchanged = || UpdateDictationDictionaryEntryRequest {
            spoken_form: None,
            replacement: None,
            app_scope: None,
            case_sensitive: None,
            enabled: None,
            category_scope: None,
        };
        for change in [
            UpdateDictationDictionaryEntryRequest {
                enabled: Some(false),
                ..unchanged()
            },
            UpdateDictationDictionaryEntryRequest {
                enabled: Some(true),
                app_scope: Some(Some("Mail".into())),
                ..unchanged()
            },
            UpdateDictationDictionaryEntryRequest {
                app_scope: Some(None),
                category_scope: Some(Some("email".into())),
                ..unchanged()
            },
            UpdateDictationDictionaryEntryRequest {
                category_scope: Some(None),
                case_sensitive: Some(true),
                ..unchanged()
            },
        ] {
            db.update_dictation_dictionary_entry(&entry.id, &change)
                .unwrap();
            assert!(!db
                .has_learned_global_dictation_correction("janavi", "Jeanne-Oui")
                .unwrap());
        }
    }

    #[test]
    fn learned_correction_clears_only_matching_suggestions_across_apps() {
        let mut db = in_memory_db();
        for (spoken, replacement, app) in [
            ("janavi", "Jeanne-Oui", None),
            ("JANAVI", "Jeanne-Oui", Some("TextEdit")),
            ("janavi", "Jeanne-Oui", Some("Mail")),
            ("janavi", "Jeanne", None),
            ("janavi", "jeanne-oui", None),
            ("jon", "John", None),
        ] {
            db.upsert_dictation_correction_suggestion(
                spoken,
                replacement,
                spoken,
                replacement,
                app,
                None,
            )
            .unwrap();
        }
        assert_eq!(
            db.clear_learned_dictation_correction_suggestions("Janavi", "Jeanne-Oui")
                .unwrap(),
            3
        );
        let remaining = db.list_dictation_correction_suggestions().unwrap();
        assert_eq!(remaining.len(), 3);
        assert!(remaining.iter().any(|s| s.replacement == "Jeanne"));
        assert!(remaining.iter().any(|s| s.replacement == "jeanne-oui"));
        assert!(remaining.iter().any(|s| s.spoken_form == "jon"));
        assert_eq!(
            db.clear_learned_dictation_correction_suggestions("Janavi", "Jeanne-Oui")
                .unwrap(),
            0
        );
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

        let (action, in_app) = db
            .upsert_dictation_correction_suggestion(
                "send it to cuban netties",
                "send it to kubernetes",
                "cuban netties",
                "kubernetes",
                Some("Slack"),
                None,
            )
            .unwrap();
        assert_eq!(action, "created");
        assert_ne!(external.id, in_app.id);
        assert!(in_app.source.is_none());

        for (source, expected_id) in [
            (None, in_app.id.as_str()),
            (Some(" external_app_readback "), external.id.as_str()),
        ] {
            let (action, retried) = db
                .upsert_dictation_correction_suggestion(
                    "send it to cuban netties tomorrow",
                    "send it to kubernetes tomorrow",
                    "Cuban Netties",
                    "kubernetes",
                    Some(" slack "),
                    source,
                )
                .unwrap();
            assert_eq!(action, "updated");
            assert_eq!(retried.id, expected_id);
            assert_eq!(retried.source.as_deref(), source.map(str::trim));
        }

        let stored = db.list_dictation_correction_suggestions().unwrap();
        assert_eq!(stored.len(), 2);
        for (id, expected_source) in [
            (in_app.id.as_str(), None),
            (
                external.id.as_str(),
                Some(crate::models::CORRECTION_SUGGESTION_SOURCE_EXTERNAL_APP),
            ),
        ] {
            let row = stored.iter().find(|row| row.id == id).unwrap();
            assert_eq!(row.source.as_deref(), expected_source);
            assert_eq!(row.corrected_text, "send it to kubernetes tomorrow");
        }
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
    fn hostile_search_queries_cannot_inject_sql_or_fts_operators() {
        let mut db = in_memory_db();
        for (id, text) in [("r1", "launch readiness"), ("r2", "unrelated material")] {
            db.create_recording(&sample_recording(id, "inbox")).unwrap();
            let mut transcript = sample_transcript(id);
            for segment in &mut transcript.segments {
                segment.text = text.to_string();
            }
            transcript.full_text = text.to_string();
            db.save_transcript(&transcript).unwrap();
        }
        for query in [
            "launch\" OR 1=1 --",
            "\"; DROP TABLE recordings; --",
            "NEAR(launch, missing, 100)",
            "title:launch NOT missing",
            "***",
            "\0",
        ] {
            let hits = db
                .search_transcripts(query, 10, None)
                .expect("literal search");
            assert!(
                hits.iter().all(|hit| hit.recording_id == "r1"),
                "{query}: {hits:?}"
            );
            let count: i64 = db
                .conn
                .query_row("SELECT COUNT(*) FROM recordings", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 2);
        }
        assert!(!db
            .search_transcripts("launch", 10, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_build_fts_query_sanitizes_input() {
        let query = build_fts_query("launch-ready?! qa");
        assert_eq!(query, "launch* OR ready* OR qa*");
    }
}

#[cfg(test)]
mod capture_completion_policy_tests {
    use super::*;

    #[test]
    fn capture_loss_is_sticky_and_combined_reason_is_idempotent() {
        assert_eq!(
            capture_safe_completion(true, None, Some(" loss ")),
            (false, Some("loss".into()))
        );
        let combined = capture_safe_completion(false, Some("ASR failed"), Some("loss"));
        assert_eq!(combined, (false, Some("loss ASR failed".into())));
        assert_eq!(
            capture_safe_completion(true, combined.1.as_deref(), Some("loss")),
            combined
        );
        assert_eq!(
            capture_safe_completion(true, None, Some("  ")),
            (true, None)
        );
    }
}
