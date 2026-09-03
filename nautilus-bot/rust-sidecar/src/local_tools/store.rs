//! The read-only store behind the CLI and MCP server.
//!
//! Opens the sidecar's database with `Database::open_read_only_at_path` and
//! answers every [`MeetingSource`] call from the same `db.rs` queries the app
//! uses, so what the terminal sees is what the Meetings view sees.

use super::{
    clamp_limit, DictationEntry, ExportFormat, ListFilter, MeetingDetail, MeetingSource,
    MeetingSummary, Page, SearchResult, SegmentView, Stats, TranscriptView, DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
};
use crate::db::Database;
use crate::models::{Recording, Transcript};
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub struct ReadOnlyStore {
    db: Database,
    path: PathBuf,
}

impl ReadOnlyStore {
    /// Open the live database read-only, keyed from the same keychain entry
    /// the sidecar uses. A first run from a new binary may prompt macOS for
    /// keychain access; that prompt is macOS's, not Plainsong's, and refusing
    /// it simply fails the open.
    pub fn open() -> Result<Self> {
        let path = Database::default_db_path()?;
        let key = crate::secrets::get_internal_secret(crate::VAULT_DB_KEY_SECRET)
            .context("Could not read Plainsong's database key from the keychain")?;
        Self::open_at(&path, key.as_deref())
    }

    /// Open read-only, probing rather than trusting the keychain: a stored key
    /// does not prove the file is encrypted (the vault used to store the key
    /// and leave the database plaintext), so the keyed open is tried first and
    /// an unkeyed open is the fallback. Whichever one worked is what
    /// [`Stats::database_encrypted`] reports.
    pub fn open_at(path: &Path, key: Option<&str>) -> Result<Self> {
        let db = Database::open_read_only_probing(path, key)?;
        Ok(Self {
            db,
            path: path.to_path_buf(),
        })
    }

    fn project_names(&self) -> Result<HashMap<String, String>> {
        Ok(self
            .db
            .get_projects()?
            .into_iter()
            .map(|project| (project.id, project.name))
            .collect())
    }

    fn summarize(
        &self,
        recording: &Recording,
        projects: &HashMap<String, String>,
        has_transcript: bool,
    ) -> MeetingSummary {
        MeetingSummary {
            id: recording.id.clone(),
            title: recording.title.clone(),
            created_at: recording.created_at,
            duration_seconds: recording.duration,
            project_id: recording.project_id.clone(),
            project: projects
                .get(&recording.project_id)
                .cloned()
                .unwrap_or_else(|| recording.project_id.clone()),
            source_type: recording.source_type.clone(),
            status: recording.status.clone(),
            has_summary: recording
                .summary
                .as_deref()
                .is_some_and(|summary| !summary.trim().is_empty()),
            action_item_count: recording
                .action_items
                .as_deref()
                .map(|items| items.iter().filter(|item| !item.trim().is_empty()).count())
                .unwrap_or(0),
            has_transcript,
        }
    }

    fn has_transcript(&self, recording_id: &str) -> bool {
        self.db
            .has_transcript_content(recording_id)
            .unwrap_or(false)
    }

    fn transcript_view(&self, recording: &Recording, transcript: Transcript) -> TranscriptView {
        let aliases = self
            .db
            .get_speaker_aliases(&recording.id)
            .unwrap_or_default();
        let segments: Vec<SegmentView> = transcript
            .segments
            .iter()
            .enumerate()
            .map(|(index, segment)| SegmentView {
                index,
                start_seconds: segment.start_time,
                end_seconds: segment.end_time,
                speaker: segment.speaker_id.as_ref().map(|speaker_id| {
                    aliases
                        .get(speaker_id)
                        .and_then(|alias| alias.0.clone())
                        .filter(|name| !name.trim().is_empty())
                        .unwrap_or_else(|| speaker_id.clone())
                }),
                text: segment.text.clone(),
            })
            .collect();
        TranscriptView {
            recording_id: recording.id.clone(),
            title: recording.title.clone(),
            language: transcript.language,
            model: transcript.model,
            total_segments: segments.len(),
            segments,
            full_text: transcript.full_text,
        }
    }
}

fn is_dictation(recording: &Recording) -> bool {
    recording.source_type == "dictation"
}

impl MeetingSource for ReadOnlyStore {
    fn list_meetings(&self, filter: &ListFilter) -> Result<Page<MeetingSummary>> {
        let projects = self.project_names()?;
        let project_filter = filter
            .project
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty());
        let mut all: Vec<Recording> = self
            .db
            .get_recordings(None)?
            .into_iter()
            .filter(|recording| !is_dictation(recording))
            .filter(|recording| {
                filter
                    .since
                    .is_none_or(|since| recording.created_at >= since)
            })
            .filter(|recording| {
                project_filter.is_none_or(|wanted| {
                    recording.project_id == wanted
                        || projects
                            .get(&recording.project_id)
                            .is_some_and(|name| name.eq_ignore_ascii_case(wanted))
                })
            })
            .collect();
        all.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        let total = all.len();
        let limit = clamp_limit(Some(filter.limit), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        let items: Vec<MeetingSummary> = all
            .iter()
            .skip(filter.offset)
            .take(limit)
            .map(|recording| {
                let has_transcript = self.has_transcript(&recording.id);
                self.summarize(recording, &projects, has_transcript)
            })
            .collect();
        let next_offset =
            (filter.offset + items.len() < total).then_some(filter.offset + items.len());
        Ok(Page {
            items,
            total,
            next_offset,
        })
    }

    fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        let limit = clamp_limit(Some(limit), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        Ok(self
            .db
            .search_transcripts(query, limit, None)?
            .into_iter()
            .map(|hit| SearchResult {
                recording_id: hit.recording_id,
                title: hit.recording_title,
                text: hit.text,
                start_seconds: hit.start_time,
                end_seconds: hit.end_time,
                score: hit.score,
            })
            .collect())
    }

    fn get_meeting(&self, id: &str) -> Result<Option<MeetingDetail>> {
        let Some(recording) = self.db.get_recording(id)? else {
            return Ok(None);
        };
        let projects = self.project_names()?;
        let has_transcript = self.has_transcript(&recording.id);
        let summary = self.summarize(&recording, &projects, has_transcript);
        Ok(Some(MeetingDetail {
            summary,
            summary_text: recording.summary.clone(),
            notes: recording.meeting_notes.clone(),
            action_items: recording.action_items.clone().unwrap_or_default(),
            template_id: recording.meeting_template_id.clone(),
            capture_mode: recording.meeting_capture_mode.clone(),
            analysis_failure: recording.analysis_failure.clone(),
            // Names only: `attendee_names_for_context` is the one function that
            // turns an attendee list into text for a consumer outside the app,
            // and it drops the address.
            attendee_names: crate::models::attendee_names_for_context(&recording.attendees),
        }))
    }

    fn get_transcript(&self, id: &str) -> Result<Option<TranscriptView>> {
        let Some(recording) = self.db.get_recording(id)? else {
            return Ok(None);
        };
        let Some(transcript) = self.db.get_transcript(id)? else {
            return Ok(None);
        };
        Ok(Some(self.transcript_view(&recording, transcript)))
    }

    fn list_dictations(&self, limit: usize, offset: usize) -> Result<Page<DictationEntry>> {
        let mut all: Vec<Recording> = self
            .db
            .get_recordings(None)?
            .into_iter()
            .filter(is_dictation)
            .collect();
        all.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        let total = all.len();
        let limit = clamp_limit(Some(limit), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        let items: Vec<DictationEntry> = all
            .iter()
            .skip(offset)
            .take(limit)
            .map(|recording| {
                let text = self
                    .db
                    .get_transcript(&recording.id)
                    .ok()
                    .flatten()
                    .map(|transcript| transcript.full_text)
                    .filter(|text| !text.trim().is_empty())
                    .unwrap_or_else(|| recording.title.clone());
                DictationEntry {
                    id: recording.id.clone(),
                    created_at: recording.created_at,
                    duration_seconds: recording.duration,
                    status: recording.status.clone(),
                    text,
                }
            })
            .collect();
        let next_offset = (offset + items.len() < total).then_some(offset + items.len());
        Ok(Page {
            items,
            total,
            next_offset,
        })
    }

    fn stats(&self) -> Result<Stats> {
        let recordings = self.db.get_recordings(None)?;
        let projects = self.db.get_projects()?;
        // One query, not one full transcript load per recording: this used to
        // read and deserialize every transcript in the database to answer a
        // question about counts.
        let with_transcripts = self.db.recording_ids_with_transcript_content()?;
        let transcribed = recordings
            .iter()
            .filter(|recording| with_transcripts.contains(&recording.id))
            .count();
        let meetings = recordings
            .iter()
            .filter(|recording| recording.source_type == "meeting")
            .count();
        let dictations = recordings.iter().filter(|r| is_dictation(r)).count();
        Ok(Stats {
            database_path: self.path.display().to_string(),
            database_encrypted: self.db.is_encrypted().unwrap_or(false),
            meetings,
            dictations,
            other_recordings: recordings.len() - meetings - dictations,
            transcribed,
            projects: projects.len(),
            total_duration_seconds: recordings.iter().map(|r| r.duration.max(0)).sum(),
            earliest: recordings.iter().map(|r| r.created_at).min(),
            latest: recordings.iter().map(|r| r.created_at).max(),
        })
    }

    fn export_meeting(&self, id: &str, format: ExportFormat) -> Result<Option<String>> {
        let Some(recording) = self.db.get_recording(id)? else {
            return Ok(None);
        };
        let transcript = self.db.get_transcript(id)?;
        let format = match format {
            ExportFormat::Markdown => crate::export::ExportFormat::Markdown,
            ExportFormat::Json => crate::export::ExportFormat::Json,
            ExportFormat::Text => crate::export::ExportFormat::Text,
        };
        // Same speaker aliases the app's export path passes, so a format that
        // labels its output names the person rather than the capture side.
        let speaker_names = self
            .db
            .get_speaker_aliases(id)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(speaker_id, (name, _, _))| {
                let name = name?.trim().to_string();
                (!name.is_empty()).then_some((speaker_id, name))
            })
            .collect();
        Ok(Some(crate::export::export_recording(
            &recording,
            transcript.as_ref(),
            format,
            true,
            &crate::export::ExportContext { speaker_names },
        )?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TranscriptSegment;
    use chrono::{TimeZone, Utc};

    fn recording(id: &str, source_type: &str, hour: u32) -> Recording {
        Recording {
            id: id.to_string(),
            title: format!("Title {id}"),
            project_id: "inbox".to_string(),
            duration: 120,
            created_at: Utc.with_ymd_and_hms(2026, 8, 1, hour, 0, 0).unwrap(),
            updated_at: Utc::now(),
            source_type: source_type.to_string(),
            audio_path: format!("/tmp/{id}.wav"),
            status: "completed".to_string(),
            summary: Some("A summary.".to_string()),
            action_items: Some(vec!["Do the thing".to_string(), " ".to_string()]),
            summary_provenance: None,
            action_items_provenance: None,
            meeting_notes: Some("Notes here".to_string()),
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
        }
    }

    fn transcript(recording_id: &str, text: &str) -> Transcript {
        Transcript {
            id: format!("t-{recording_id}"),
            recording_id: recording_id.to_string(),
            segments: vec![TranscriptSegment {
                id: format!("{recording_id}-0"),
                start_time: 0.0,
                end_time: 2.5,
                text: text.to_string(),
                speaker_id: Some("speaker_0".to_string()),
                confidence: 0.9,
            }],
            full_text: text.to_string(),
            language: "en".to_string(),
            confidence: 0.9,
            model: "test".to_string(),
            model_id: None,
            requested_provider: None,
            actual_provider: None,
            created_at: Utc::now(),
        }
    }

    /// A populated plaintext database in a temp dir, written by the same
    /// `Database` the sidecar uses, then reopened through the read-only path.
    fn populated_store() -> (crate::test_fs::TempDir, ReadOnlyStore) {
        let dir = crate::test_fs::TempDir::new("local-tools");
        let path = dir.path().join("plainsong.db");
        {
            let mut db = Database::open_at_path(&path, None).unwrap();
            // `create_recording` persists the capture row only; summary,
            // action items and notes arrive through the analysis and notes
            // update paths, the same way the app writes them.
            let action_items = vec!["Do the thing".to_string(), " ".to_string()];
            db.create_recording(&recording("m1", "meeting", 9)).unwrap();
            db.save_transcript(&transcript("m1", "We agreed to ship on Friday"))
                .unwrap();
            db.update_recording_analysis("m1", Some("A summary."), &action_items)
                .unwrap();
            db.update_recording_notes("m1", Some("Notes here")).unwrap();
            db.create_recording(&recording("m2", "meeting", 11))
                .unwrap();
            db.update_recording_analysis("m2", Some("A summary."), &action_items)
                .unwrap();
            db.create_recording(&recording("d1", "dictation", 13))
                .unwrap();
            db.save_transcript(&transcript("d1", "hello world dictation"))
                .unwrap();
        }
        let store = ReadOnlyStore::open_at(&path, None).unwrap();
        (dir, store)
    }

    /// Every install that turned the vault on before the `sqlcipher_export`
    /// fix has a key in the keychain and a plaintext database. The CLI has to
    /// open it, and `stats` has to say what is actually true about the file.
    #[cfg(feature = "sqlcipher")]
    #[test]
    fn stats_reports_encryption_from_the_probe_not_from_the_stored_key() {
        let dir = crate::test_fs::TempDir::new("local-tools-probe");
        let path = dir.path().join("plainsong.db");
        let key = "0123456789abcdef0123456789abcdef";
        {
            let mut db = Database::open_at_path(&path, None).unwrap();
            db.create_recording(&recording("m1", "meeting", 9)).unwrap();
        }

        // Key in hand, plaintext on disk: it opens, and says "no".
        let store = ReadOnlyStore::open_at(&path, Some(key)).expect("plaintext open with a key");
        assert!(!store.stats().unwrap().database_encrypted);
        assert_eq!(store.stats().unwrap().meetings, 1);
        drop(store);

        {
            let mut db = Database::open_at_path(&path, None).unwrap();
            db.change_key(key).unwrap();
        }

        // Genuinely encrypted now, and the same call says "yes".
        let store = ReadOnlyStore::open_at(&path, Some(key)).expect("keyed open");
        let stats = store.stats().unwrap();
        assert!(stats.database_encrypted);
        assert_eq!(stats.meetings, 1);
        // Without the key there is nothing to fall back to, and that is an
        // error rather than an empty answer.
        assert!(ReadOnlyStore::open_at(&path, None).is_err());
    }

    #[test]
    fn lists_meetings_newest_first_without_dictations() {
        let (_dir, store) = populated_store();
        let page = store
            .list_meetings(&ListFilter {
                limit: 10,
                ..ListFilter::default()
            })
            .unwrap();
        let ids: Vec<&str> = page.items.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["m2", "m1"]);
        assert_eq!(page.total, 2);
        assert_eq!(page.next_offset, None);
        assert!(page.items[1].has_transcript);
        assert!(!page.items[0].has_transcript);
        assert_eq!(page.items[0].action_item_count, 1);
        assert_eq!(page.items[0].project, "Inbox");
    }

    #[test]
    fn list_filters_by_since_and_project_and_pages() {
        let (_dir, store) = populated_store();
        let since = Utc.with_ymd_and_hms(2026, 8, 1, 10, 0, 0).unwrap();
        let page = store
            .list_meetings(&ListFilter {
                limit: 10,
                since: Some(since),
                ..ListFilter::default()
            })
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "m2");

        let by_name = store
            .list_meetings(&ListFilter {
                limit: 10,
                project: Some("inbox".to_string()),
                ..ListFilter::default()
            })
            .unwrap();
        assert_eq!(by_name.total, 2);
        let none = store
            .list_meetings(&ListFilter {
                limit: 10,
                project: Some("nope".to_string()),
                ..ListFilter::default()
            })
            .unwrap();
        assert_eq!(none.total, 0);

        let first = store
            .list_meetings(&ListFilter {
                limit: 1,
                ..ListFilter::default()
            })
            .unwrap();
        assert_eq!(first.items.len(), 1);
        assert_eq!(first.next_offset, Some(1));
        let second = store
            .list_meetings(&ListFilter {
                limit: 1,
                offset: 1,
                ..ListFilter::default()
            })
            .unwrap();
        assert_eq!(second.items[0].id, "m1");
        assert_eq!(second.next_offset, None);
    }

    #[test]
    fn detail_transcript_search_dictations_stats_and_export_read_through() {
        let (_dir, store) = populated_store();
        let detail = store.get_meeting("m1").unwrap().unwrap();
        assert_eq!(detail.summary_text.as_deref(), Some("A summary."));
        assert_eq!(detail.notes.as_deref(), Some("Notes here"));
        assert!(store.get_meeting("missing").unwrap().is_none());

        let transcript = store.get_transcript("m1").unwrap().unwrap();
        assert_eq!(transcript.total_segments, 1);
        assert_eq!(transcript.segments[0].speaker.as_deref(), Some("speaker_0"));
        assert!(store.get_transcript("m2").unwrap().is_none());

        let hits = store.search("Friday", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].recording_id, "m1");

        let dictations = store.list_dictations(10, 0).unwrap();
        assert_eq!(dictations.total, 1);
        assert_eq!(dictations.items[0].text, "hello world dictation");

        let stats = store.stats().unwrap();
        assert_eq!(stats.meetings, 2);
        assert_eq!(stats.dictations, 1);
        assert_eq!(stats.transcribed, 2);
        assert!(!stats.database_encrypted);

        let markdown = store
            .export_meeting("m1", ExportFormat::Markdown)
            .unwrap()
            .unwrap();
        assert!(markdown.starts_with("# Title m1"));
        assert!(markdown.contains("We agreed to ship on Friday"));
        assert!(store
            .export_meeting("missing", ExportFormat::Text)
            .unwrap()
            .is_none());
    }
}
