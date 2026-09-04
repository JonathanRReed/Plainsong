//! Who said it: speaker aliases, voice clusters and person names.
//!
//! Inferring a speaker's name from what the transcript itself says, matching a
//! voice cluster to a person already known to the database, and the name
//! normalisation that decides whether a candidate is a person at all.
//!
//! Everything here is `pub(crate)` and re-exported from `lib.rs`; the move did
//! not rename or re-sign anything.

use super::*;

pub(crate) fn infer_speaker_aliases_from_segments(
    segments: &[models::TranscriptSegment],
) -> std::collections::HashMap<String, String> {
    let mut aliases = std::collections::HashMap::new();
    let intro_pattern =
        Regex::new(r"\b(?:this is|i am|i'm|my name is)\s+([a-z][a-z'\-]+(?:\s+[a-z][a-z'\-]+)?)\b")
            .expect("valid intro regex");
    let next_pattern = Regex::new(
        r"\b(?:next is|up next is|here is|here's)\s+([a-z][a-z'\-]+(?:\s+[a-z][a-z'\-]+)?)\b",
    )
    .expect("valid next regex");
    let speaker_pattern = Regex::new(r"\b([a-z][a-z'\-]+)\s+(?:speaking|here|talking)\b")
        .expect("valid speaker regex");

    for (index, segment) in segments.iter().enumerate() {
        let Some(speaker_id) = segment
            .speaker_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };

        if !aliases.contains_key(speaker_id) {
            let lowered = segment.text.to_lowercase();

            // Check for "This is X" or "I am X" patterns
            if let Some(captured) = intro_pattern.captures(&lowered) {
                if let Some(name_match) = captured.get(1) {
                    if let Some(name) = normalize_person_name(name_match.as_str()) {
                        aliases.insert(speaker_id.to_string(), name);
                        continue;
                    }
                }
            }

            // Check for "X speaking" or "X here" patterns
            if let Some(captured) = speaker_pattern.captures(&lowered) {
                if let Some(name_match) = captured.get(1) {
                    if let Some(name) = normalize_person_name(name_match.as_str()) {
                        aliases.insert(speaker_id.to_string(), name);
                        continue;
                    }
                }
            }
        }

        let lowered = segment.text.to_lowercase();
        if let Some(captured) = next_pattern.captures(&lowered) {
            if let Some(name_match) = captured.get(1) {
                if let Some(name) = normalize_person_name(name_match.as_str()) {
                    // Find the next segment with a different, real speaker ID.
                    // Uncovered speech remains anonymous and must not create an alias.
                    let next_speaker_id = segments.iter().skip(index + 1).find_map(|candidate| {
                        candidate
                            .speaker_id
                            .as_deref()
                            .map(str::trim)
                            .filter(|id| !id.is_empty() && *id != speaker_id)
                            .map(str::to_string)
                    });
                    if let Some(next_speaker_id) = next_speaker_id {
                        aliases.entry(next_speaker_id).or_insert(name);
                    }
                }
            }
        }
    }

    aliases
}

pub(crate) fn resolve_speaker_name(
    speaker_id: &str,
    existing_name: Option<&str>,
    inferred_name: Option<&str>,
    fallback_name: Option<&str>,
    index: usize,
) -> Option<String> {
    if let Some(name) = existing_name {
        if !is_generic_speaker_name(name) {
            return Some(name.trim().to_string());
        }
    }

    if let Some(name) = default_source_speaker_name(speaker_id) {
        return Some(name.to_string());
    }

    if let Some(name) = inferred_name {
        return Some(name.trim().to_string());
    }

    if let Some(name) = existing_name {
        return Some(name.trim().to_string());
    }

    if let Some(name) = fallback_name {
        return Some(name.trim().to_string());
    }

    Some(format!("Speaker {}", index + 1))
}

/// Persist this meeting's per-cluster voice signatures and, when the user
/// asked for it, apply a confident match without being asked.
///
/// Every caller reads `meetings.rememberVoices` itself before calling: the
/// promise is "nothing is stored while it is off", and that promise should be
/// visible at the call site rather than buried in here.
///
/// Returns whether any speaker name changed, so the caller knows whether the
/// transcript needs a refresh event.
/// Every cluster worth reasoning about for one recording, and this meeting's
/// attendee names.
///
/// One function, called by the automatic pass and by `suggest_speaker_voices`,
/// so the two can never disagree about which clusters exist or how attendees
/// rank them. Attendee names only reorder what is offered first; the matcher
/// never sees them, because guessing a speaker from a guest list is not
/// speaker identification.
pub(crate) fn cluster_voice_context(
    db: &db::Database,
    session_voices: &StdMutex<diarization::voiceprints::SessionClusterVoices>,
    recording_id: &str,
) -> Result<
    (
        Vec<diarization::voiceprints::ClusterVoiceSignature>,
        Vec<String>,
    ),
    String,
> {
    let stored = db
        .get_cluster_voice_signatures(recording_id)
        .map_err(|e| e.to_string())?;
    let names = db
        .get_cluster_alias_names(recording_id)
        .map_err(|e| e.to_string())?;
    let rejections = db
        .get_cluster_voice_rejections(recording_id)
        .map_err(|e| e.to_string())?;
    let session: Vec<diarization::voiceprints::SessionClusterVoice> = {
        let held = session_voices
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        held.for_recording(recording_id).to_vec()
    };
    let signatures =
        diarization::voiceprints::merge_session_signatures(stored, &session, &names, &rejections);

    // Names only, never addresses: an attendee list is a contact book, and
    // ranking a suggestion does not need one. `attendee_names_for_context` is
    // the single place that drop happens.
    let attendees = db
        .get_recording(recording_id)
        .map_err(|e| e.to_string())?
        .map(|recording| crate::models::attendee_names_for_context(&recording.attendees))
        .unwrap_or_default();

    Ok((signatures, attendees))
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod cluster_voice_context_tests {
    use super::*;
    use crate::models::MeetingAttendee;

    fn recording_with_attendees(id: &str, attendees: Vec<MeetingAttendee>) -> models::Recording {
        models::Recording {
            id: id.to_string(),
            title: "Weekly sync".to_string(),
            project_id: "inbox".to_string(),
            duration: 120,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            source_type: "meeting".to_string(),
            audio_path: format!("/tmp/{id}.wav"),
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
            attendees,
            pause_spans: Vec::new(),
            video_service: None,
            transcript_complete: true,
            transcript_degraded_reason: None,
            transcript_incomplete_acknowledged_at: None,
            capture_degraded_summary: None,
        }
    }

    fn attendee(name: &str, email: Option<&str>) -> MeetingAttendee {
        MeetingAttendee {
            name: name.to_string(),
            email: email.map(str::to_string),
            is_organizer: false,
        }
    }

    /// `create_recording` does not write the attendee column — the calendar
    /// path fills it in afterwards with `update_recording_attendees`, so the
    /// test takes the same route the app does.
    fn create_with_attendees(db: &mut db::Database, id: &str, attendees: Vec<MeetingAttendee>) {
        db.create_recording(&recording_with_attendees(id, Vec::new()))
            .unwrap();
        if !attendees.is_empty() {
            db.update_recording_attendees(id, attendees).unwrap();
        }
    }

    fn open_db() -> (crate::test_fs::TempDir, db::Database) {
        let dir = crate::test_fs::TempDir::new("cluster-voice-context");
        let db = db::Database::open_at_path(&dir.path().join("plainsong.db"), None).unwrap();
        (dir, db)
    }

    fn unit(values: &[f32]) -> Vec<f32> {
        let norm = values.iter().map(|v| v * v).sum::<f32>().sqrt();
        values.iter().map(|v| v / norm).collect()
    }

    /// The meeting's attendees reach the ranking, and their addresses do not.
    #[test]
    fn a_recordings_attendees_reach_the_context_as_names_only() {
        let (_dir, mut db) = open_db();
        create_with_attendees(
            &mut db,
            "r1",
            vec![
                attendee("Dana Okafor", Some("dana@example.com")),
                attendee("  Ravi  Menon ", None),
                attendee("   ", Some("blank@example.com")),
            ],
        );
        let held = StdMutex::new(diarization::voiceprints::SessionClusterVoices::default());

        let (signatures, attendees) = cluster_voice_context(&db, &held, "r1").unwrap();

        assert!(signatures.is_empty(), "nothing has been diarized yet");
        assert_eq!(attendees, vec!["Dana Okafor", "Ravi Menon"]);
        assert!(
            !attendees.iter().any(|name| name.contains('@')),
            "an attendee list is a contact book; only names travel"
        );
    }

    /// A meeting with no attendees at all still works, and ranks by similarity.
    #[test]
    fn a_meeting_without_attendees_has_an_empty_attendee_list() {
        let (_dir, mut db) = open_db();
        db.create_recording(&recording_with_attendees("r1", Vec::new()))
            .unwrap();
        let held = StdMutex::new(diarization::voiceprints::SessionClusterVoices::default());

        let (_, attendees) = cluster_voice_context(&db, &held, "r1").unwrap();
        assert!(attendees.is_empty());
    }

    /// Attendee overlap decides which suggestion is offered first. It must not
    /// decide which profile a cluster matched: a name on an invite is not
    /// evidence about a voice.
    #[test]
    fn attendees_reorder_the_offers_without_changing_any_match() {
        let (_dir, mut db) = open_db();
        create_with_attendees(
            &mut db,
            "r1",
            vec![attendee("Ravi", Some("ravi@example.com"))],
        );

        // Two remembered voices, orthogonal so neither is a rival for the
        // other's cluster.
        let dana = db
            .remember_speaker_voice(
                "Dana",
                "ecapa_tdnn_speaker",
                &unit(&[1.0, 0.0, 0.0]),
                None,
                None,
            )
            .unwrap();
        let ravi = db
            .remember_speaker_voice(
                "Ravi",
                "ecapa_tdnn_speaker",
                &unit(&[0.0, 1.0, 0.0]),
                None,
                None,
            )
            .unwrap();

        // S1 is the stronger match (to Dana); S2 matches Ravi less strongly.
        let held = StdMutex::new(diarization::voiceprints::SessionClusterVoices::default());
        {
            let mut centroids: std::collections::HashMap<String, Vec<f32>> =
                std::collections::HashMap::new();
            centroids.insert("S1".to_string(), unit(&[1.0, 0.02, 0.0]));
            centroids.insert("S2".to_string(), unit(&[0.25, 1.0, 0.0]));
            held.lock()
                .unwrap()
                .remember("r1", "ecapa_tdnn_speaker", centroids.iter());
        }

        let (signatures, attendees) = cluster_voice_context(&db, &held, "r1").unwrap();
        assert_eq!(attendees, vec!["Ravi"]);
        let profiles = db.list_speaker_profiles().unwrap();

        let matched_by_cluster = |offers: &[diarization::voiceprints::ClusterSuggestion]| {
            offers
                .iter()
                .map(|offer| {
                    (
                        offer.speaker_id.clone(),
                        offer
                            .suggestion
                            .as_ref()
                            .map(|matched| matched.profile_id.clone()),
                    )
                })
                .collect::<std::collections::BTreeMap<_, _>>()
        };

        let with_attendee =
            diarization::voiceprints::build_suggestions(&signatures, &profiles, &attendees);
        let without_attendee =
            diarization::voiceprints::build_suggestions(&signatures, &profiles, &[]);

        assert_eq!(
            matched_by_cluster(&with_attendee),
            matched_by_cluster(&without_attendee),
            "attendees must not change which profile any cluster matched"
        );
        assert_eq!(
            with_attendee[0].speaker_id, "S2",
            "the attendee's voice is offered first"
        );
        assert_eq!(
            with_attendee[0]
                .suggestion
                .as_ref()
                .map(|matched| matched.profile_id.as_str()),
            Some(ravi.as_str())
        );
        assert_eq!(
            without_attendee[0].speaker_id, "S1",
            "without the attendee list it is similarity order"
        );
        assert_eq!(
            without_attendee[0]
                .suggestion
                .as_ref()
                .map(|matched| matched.profile_id.as_str()),
            Some(dana.as_str())
        );

        // And Confirm offers the attendee's name ahead of the other voice.
        let remembered: Vec<String> = profiles
            .iter()
            .map(|profile| profile.display_name.clone())
            .collect();
        assert_eq!(
            diarization::voiceprints::confirm_name_options(&attendees, &remembered),
            vec!["Ravi", "Dana"]
        );
    }

    /// The session's centroids are visible to the context, and a persisted
    /// signature for the same cluster takes precedence over them.
    #[test]
    fn session_centroids_fill_the_gaps_the_database_deliberately_leaves() {
        let (_dir, mut db) = open_db();
        db.create_recording(&recording_with_attendees("r1", Vec::new()))
            .unwrap();
        db.set_cluster_voice_signature("r1", "S1", &unit(&[1.0, 0.0]), "ecapa_tdnn_speaker")
            .unwrap();
        db.reject_cluster_voice_match("r1", "S2", "p-old").unwrap();

        let held = StdMutex::new(diarization::voiceprints::SessionClusterVoices::default());
        {
            let mut centroids: std::collections::HashMap<String, Vec<f32>> =
                std::collections::HashMap::new();
            centroids.insert("S1".to_string(), unit(&[0.0, 1.0]));
            centroids.insert("S2".to_string(), unit(&[0.0, 1.0]));
            held.lock()
                .unwrap()
                .remember("r1", "ecapa_tdnn_speaker", centroids.iter());
        }

        let (signatures, _) = cluster_voice_context(&db, &held, "r1").unwrap();
        assert_eq!(signatures.len(), 2);
        assert_eq!(signatures[0].speaker_id, "S1");
        assert!(
            (signatures[0].centroid[0] - 1.0).abs() < 1e-6,
            "the persisted signature wins over the session copy"
        );
        assert_eq!(signatures[1].speaker_id, "S2");
        assert_eq!(
            signatures[1].rejected_profile_ids,
            vec!["p-old".to_string()],
            "a rejection on an unnamed cluster is carried through"
        );
    }
}

pub(crate) async fn store_and_match_cluster_voices(
    state: &AppState,
    recording_id: &str,
    embedding_model_id: &str,
    cluster_centroids: &std::collections::HashMap<String, Vec<f32>>,
    auto_apply_enabled: bool,
) -> Result<bool, String> {
    if cluster_centroids.is_empty() {
        return Ok(false);
    }
    // Nothing is written to the database here. A cluster earns a row when it
    // earns a name; until then its centroid lives in memory only, which is
    // what Settings and PRIVACY-AND-CLOUD.md promise.
    {
        let mut held = state
            .session_cluster_voices
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        held.remember(recording_id, embedding_model_id, cluster_centroids.iter());
    }

    let mut db = state.db.lock().await;
    let (signatures, attendees) =
        cluster_voice_context(&db, &state.session_cluster_voices, recording_id)?;

    // A speaker who already carried a name of their own when diarization ran
    // is the "a speaker you name" case, so their signature is kept.
    for signature in &signatures {
        let named = signature
            .name
            .as_deref()
            .is_some_and(|name| !is_generic_speaker_name(name));
        if named {
            db.record_named_cluster_voice_signature(
                recording_id,
                &signature.speaker_id,
                &signature.centroid,
                &signature.embedding_model_id,
                true,
            )
            .map_err(|e| e.to_string())?;
        }
    }

    if !auto_apply_enabled {
        return Ok(false);
    }

    let profiles = db.list_speaker_profiles().map_err(|e| e.to_string())?;
    let mut applied = false;
    for cluster in diarization::voiceprints::build_suggestions(&signatures, &profiles, &attendees) {
        let Some(matched) = cluster.suggestion.as_ref() else {
            continue;
        };
        let Some(signature) = signatures
            .iter()
            .find(|signature| signature.speaker_id == cluster.speaker_id)
        else {
            continue;
        };
        let existing_is_specific = signature
            .name
            .as_deref()
            .is_some_and(|name| !is_generic_speaker_name(name));
        if !diarization::voiceprints::should_auto_apply(matched, true, existing_is_specific) {
            continue;
        }
        // The name is going on the transcript, so the signature behind it is
        // written too: confirming or rejecting it after a restart needs the
        // numbers, and the cluster is no longer an unnamed one.
        db.record_named_cluster_voice_signature(
            recording_id,
            &cluster.speaker_id,
            &signature.centroid,
            &signature.embedding_model_id,
            true,
        )
        .map_err(|e| e.to_string())?;
        db.upsert_speaker_alias(
            recording_id,
            &cluster.speaker_id,
            Some(&matched.display_name),
            None,
            0,
        )
        .map_err(|e| e.to_string())?;
        db.set_cluster_voice_match(
            recording_id,
            &cluster.speaker_id,
            &matched.profile_id,
            diarization::voiceprints::MATCH_STATE_AUTO,
        )
        .map_err(|e| e.to_string())?;
        applied = true;
    }
    Ok(applied)
}

pub(crate) fn normalize_person_name(raw: &str) -> Option<String> {
    let cleaned = raw
        .trim()
        .trim_matches(|c: char| !c.is_ascii_alphabetic() && c != '\'' && c != '-' && c != ' ')
        .to_lowercase();

    // Block common words that aren't names
    let blocked_words = [
        "here",
        "there",
        "speaking",
        "next",
        "up",
        "and",
        "with",
        "from",
        "the",
        "a",
        "an",
        "you",
        "they",
        "we",
        "going",
        "to",
        "be",
        "talk",
        "talk about",
        "start",
        "begin",
        "now",
        "today",
        "let",
        "let's",
        "do",
        "make",
        "get",
        "take",
        "give",
        "see",
        "want",
        "need",
        "know",
        "think",
        "say",
        "tell",
        "ask",
        "try",
        "use",
        "work",
        "good",
        "new",
        "first",
        "last",
        "just",
        "very",
        "well",
        "back",
        "much",
        "more",
        "some",
        "any",
        "all",
        "each",
        "every",
        "this",
        "that",
        "these",
        "those",
        "then",
        "than",
        "so",
        "if",
        "but",
        "or",
        "as",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "yet",
        "another",
        "other",
        "him",
        "her",
        "his",
        "hers",
        "my",
        "your",
        "our",
        "their",
        "me",
        "us",
        "them",
        "who",
        "what",
        "when",
        "where",
        "why",
        "how",
        "which",
        "whose",
        "test",
        "audio",
        "video",
        "recording",
        "meeting",
        "call",
        "voice",
        "sound",
    ];

    let parts: Vec<&str> = cleaned
        .split_whitespace()
        .filter(|token| !blocked_words.contains(token) && token.len() >= 2)
        .take(2)
        .collect();

    if parts.is_empty() {
        return None;
    }

    let title_cased = parts
        .iter()
        .map(|token| {
            let mut chars = token.chars();
            let Some(first) = chars.next() else {
                return String::new();
            };
            format!("{}{}", first.to_ascii_uppercase(), chars.as_str())
        })
        .collect::<Vec<_>>()
        .join(" ");

    if title_cased.is_empty() {
        None
    } else {
        Some(title_cased)
    }
}

pub(crate) fn is_generic_speaker_name(name: &str) -> bool {
    let trimmed = name.trim().to_lowercase();
    trimmed == "unknown"
        || Regex::new(r"^speaker\s*\d+$")
            .expect("valid speaker regex")
            .is_match(&trimmed)
}
