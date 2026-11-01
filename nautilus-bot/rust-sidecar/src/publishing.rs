//! Opt-in Markdown publishing. No network or model work belongs here.
use crate::{approved_locations, export::templates, models::Recording, safe_fs, AppState};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path, sync::Arc};
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct PublishConflict(&'static str);

pub(crate) static IO_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PublishConfig {
    pub enabled: bool,
    pub location_id: Option<String>,
    pub template_id: String,
    pub include_transcript: bool,
}
impl Default for PublishConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            location_id: None,
            template_id: "meeting".into(),
            include_transcript: false,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublishStatus {
    pub state: String,
    pub error: Option<String>,
}
#[derive(Clone, Debug)]
pub(crate) struct PublishReceipt {
    pub location_id: String,
    pub filename: String,
    pub hash: String,
    pub attempted_hashes: Vec<String>,
    /// The outbox revision whose file produced `hash`.
    pub revision: i64,
}
pub(crate) struct PublishJob {
    pub recording_id: String,
    pub revision: i64,
    pub location_id: String,
    filename: String,
    contents: Vec<u8>,
    previous: Option<PublishReceipt>,
}

fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn safe_title(title: &str) -> String {
    let normalized: String = title.nfc().collect();
    let mut result = String::new();
    for ch in normalized.chars() {
        // Viramas and tone marks are marks, not letters. A mark only stays
        // when it follows a letter, digit or kept mark it can combine with.
        let combines = unicode_normalization::char::is_combining_mark(ch)
            && result.chars().next_back().is_some_and(|prev| {
                prev.is_alphanumeric() || unicode_normalization::char::is_combining_mark(prev)
            });
        let ch = if combines || ch.is_alphanumeric() || matches!(ch, ' ' | '-' | '_') {
            ch
        } else {
            '_'
        };
        // Leave space below the 255-byte component limit for IDs and suffixes.
        let decomposed_bytes: usize = ch.to_string().nfd().map(char::len_utf8).sum();
        if result.nfd().map(char::len_utf8).sum::<usize>() + decomposed_bytes > 100 {
            break;
        }
        result.push(ch);
    }
    let result = result.trim_matches([' ', '.', '_']).to_string();
    let upper = result.to_ascii_uppercase();
    if result.is_empty()
        || matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && matches!(upper.as_bytes()[3], b'1'..=b'9'))
    {
        format!("Meeting {result}").trim().to_string()
    } else {
        result
    }
}

/// The transcript as the meeting view reads it: each turn under the
/// speaker's current name. Without speaker IDs the stored text is kept.
pub(crate) fn transcript_markdown(
    transcript: &crate::models::Transcript,
    speaker_names: &std::collections::HashMap<String, String>,
) -> String {
    if !transcript.segments.iter().any(|s| {
        s.speaker_id
            .as_deref()
            .is_some_and(|id| !id.trim().is_empty())
    }) {
        return transcript.full_text.clone();
    }
    let mut out = String::new();
    let mut last: Option<String> = None;
    for segment in &transcript.segments {
        let text = segment.text.trim();
        if text.is_empty() {
            continue;
        }
        let speaker = segment
            .speaker_id
            .as_deref()
            .and_then(|id| crate::export::subtitles::speaker_label(id, speaker_names));
        if !out.is_empty() && speaker.is_some() && speaker == last {
            out.push(' ');
            out.push_str(text);
            continue;
        }
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        if let Some(name) = &speaker {
            out.push_str(&format!("**{name}:** "));
        }
        out.push_str(text);
        last = speaker;
    }
    out
}

impl PublishJob {
    #[cfg(test)]
    pub(crate) fn contents_for_test(&self) -> &[u8] {
        &self.contents
    }

    pub(crate) fn new(
        recording: Recording,
        transcript: String,
        completion: Vec<String>,
        config: PublishConfig,
        previous: Option<PublishReceipt>,
        revision: i64,
    ) -> Result<Self> {
        let location_id = config
            .location_id
            .context("Choose a notes folder in Settings")?;
        let manager = templates::TemplateManager::new();
        let template = manager
            .get_template(&config.template_id)
            .context("Choose a Markdown notes format")?;
        anyhow::ensure!(
            template.format == templates::ExportFormat::Markdown,
            "Choose a Markdown notes format"
        );
        let (summary, mut actions) = crate::persisted_template_analysis(&recording, "none");
        for action in actions.iter_mut().skip(1) {
            *action = format!(
                "[{}] {}",
                if completion.contains(action) {
                    "x"
                } else {
                    " "
                },
                action
            );
        }
        let mut rendered = manager.render(
            &config.template_id,
            &templates::RenderData {
                title: recording.title.clone(),
                date: recording.created_at.format("%Y-%m-%d %H:%M").to_string(),
                duration_seconds: recording.duration.max(0) as u64,
                transcript,
                speakers: vec![],
                action_items: actions.clone(),
                summary: summary.clone(),
                source_limitations: crate::export::meeting_source_limitations(&recording),
            },
        )?;
        if !template.template.contains("{{summary}}") {
            if let Some(summary) = summary.as_deref() {
                rendered.push_str(&format!("\n\n## Meeting Summary\n\n{summary}\n"));
            }
        }
        if !template.template.contains("{{action_items}}") && !actions.is_empty() {
            rendered.push_str("\n\n## Action Items\n\n");
            for action in &actions {
                rendered.push_str(&format!("- {action}\n"));
            }
        }
        // JSON strings are valid YAML quoted scalars, even for hostile titles/IDs.
        let header = format!(
            "---\nplainsong_recording_id: {}\nplainsong_revision: {}\ntitle: {}\n",
            serde_json::to_string(&recording.id)?,
            revision,
            serde_json::to_string(&recording.title)?,
        );
        let mut body = format!("---\n\n{rendered}");
        if let Some(notes) = recording
            .meeting_notes
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            body.push_str(&format!("\n\n## Your notes\n\n{notes}\n"));
        }
        let fingerprint = hash(format!("{header}{body}").as_bytes());
        let contents = format!("{header}{FINGERPRINT_KEY}\"{fingerprint}\"\n{body}");
        let previous = previous.filter(|r| r.location_id == location_id);
        let filename = previous
            .as_ref()
            .map(|r| r.filename.clone())
            .unwrap_or_else(|| {
                format!(
                    "{} {}-{}.md",
                    recording.created_at.format("%Y-%m-%d"),
                    safe_title(&recording.title),
                    &hash(recording.id.as_bytes())[..16]
                )
            });
        Ok(Self {
            recording_id: recording.id,
            revision,
            location_id,
            filename,
            contents: contents.into_bytes(),
            previous,
        })
    }

    pub(crate) fn planned_receipt(&self) -> PublishReceipt {
        PublishReceipt {
            location_id: self.location_id.clone(),
            filename: self.filename.clone(),
            hash: String::new(),
            attempted_hashes: vec![hash(&self.contents)],
            revision: 0,
        }
    }

    pub(crate) fn write(&self, root: &Path) -> Result<PublishReceipt> {
        anyhow::ensure!(
            Path::new(&self.filename).components().count() == 1 && self.filename.ends_with(".md"),
            "Published filename is invalid"
        );
        let path = root.join(&self.filename);
        let current = read_hash(&path)?;
        let expected = current.as_deref().filter(|hash| {
            let receipted = self.previous.as_ref().is_some_and(|receipt| {
                *hash == receipt.hash
                    || receipt
                        .attempted_hashes
                        .iter()
                        .any(|attempt| attempt == hash)
            });
            receipted || {
                let since = self.previous.as_ref().map_or(0, |r| r.revision);
                owned_revision(&path, hash, &self.recording_id).is_some_and(|rev| rev >= since)
            }
        });
        checked_write(&path, &self.contents, expected)?;
        Ok(PublishReceipt {
            location_id: self.location_id.clone(),
            filename: self.filename.clone(),
            hash: hash(&self.contents),
            attempted_hashes: vec![],
            revision: self.revision,
        })
    }
}

/// Front matter key whose value is the SHA-256 of the file without that line.
const FINGERPRINT_KEY: &str = "plainsong_sha256: ";

/// The revision of an unedited Plainsong file for `recording_id`, or `None`.
///
/// A restored database can hold a receipt older than the file Plainsong last
/// wrote. The front matter identifies such a file, and the fingerprint proves
/// nobody edited it: an editor that keeps the front matter but changes the
/// body must not be overwritten.
fn pristine_revision(bytes: &[u8], recording_id: &str) -> Option<i64> {
    let text = std::str::from_utf8(bytes).ok()?;
    let front = text.strip_prefix("---\n")?;
    let end = front.find("\n---\n")?;
    let (mut id, mut revision, mut fingerprint) = (None, None, None);
    let mut offset = 4;
    for line in front[..end].split('\n') {
        let span = offset..offset + line.len() + 1;
        offset = span.end;
        let duplicate = if let Some(v) = line.strip_prefix("plainsong_recording_id: ") {
            id.replace(serde_json::from_str::<String>(v).ok()?)
                .is_some()
        } else if let Some(v) = line.strip_prefix("plainsong_revision: ") {
            revision.replace(v.parse::<i64>().ok()?).is_some()
        } else if let Some(v) = line.strip_prefix(FINGERPRINT_KEY) {
            fingerprint
                .replace((serde_json::from_str::<String>(v).ok()?, span))
                .is_some()
        } else {
            false
        };
        if duplicate {
            return None;
        }
    }
    let (fingerprint, span) = fingerprint?;
    let unsigned = [&text[..span.start], &text[span.end..]].concat();
    (id? == recording_id && hash(unsigned.as_bytes()) == fingerprint).then_some(revision?)
}

fn owned_revision(path: &Path, current: &str, recording_id: &str) -> Option<i64> {
    const LIMIT: u64 = 64 * 1024 * 1024;
    let file = safe_fs::open_regular_file_without_links(path).ok()?;
    let mut bytes = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut bytes).ok()?;
    // The bytes checked must be the version `checked_write` will replace.
    if bytes.len() as u64 > LIMIT || hash(&bytes) != current {
        return None;
    }
    pristine_revision(&bytes, recording_id)
}

fn file_hash(mut file: std::fs::File) -> Result<String> {
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 16384];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(hex::encode(digest.finalize()))
}

fn read_hash(path: &Path) -> Result<Option<String>> {
    match safe_fs::open_regular_file_without_links(path) {
        Ok(file) => Ok(Some(file_hash(file)?)),
        Err(error)
            if error.chain().any(|e| {
                e.downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn checked_write(path: &Path, contents: &[u8], expected: Option<&str>) -> Result<()> {
    let current = read_hash(path)?;
    let next_hash = hash(contents);
    // A crash between rename and DB acknowledgement is an idempotent retry.
    if current.as_deref() == Some(&next_hash) {
        return Ok(());
    }
    if current.is_some() && current.as_deref() != expected {
        return Err(PublishConflict("The published file was changed outside Plainsong. Your version was kept. Move it aside, then Retry.").into());
    }
    checked_replace(path, contents, current.as_deref())
}

// Exchange keeps the displaced inode until its hash is checked. An editor
// replacing the file after our first check cannot lose its version.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn checked_replace(path: &Path, contents: &[u8], expected: Option<&str>) -> Result<()> {
    use std::{
        ffi::CString,
        io::Write,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::ffi::OsStrExt,
        },
    };
    let root = path.parent().context("Missing notes folder")?;
    let directory = safe_fs::open_directory_without_following_links(root)?;
    let stage_name = format!(".plainsong-{}.md", uuid::Uuid::new_v4());
    let from = CString::new(stage_name)?;
    let to = CString::new(path.file_name().context("Missing filename")?.as_bytes())?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            from.as_ptr(),
            libc::O_CREAT | libc::O_EXCL | libc::O_RDWR | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    anyhow::ensure!(fd >= 0, std::io::Error::last_os_error());
    let mut staged = unsafe { std::fs::File::from_raw_fd(fd) };
    if let Err(error) = staged.write_all(contents).and_then(|_| staged.sync_all()) {
        unsafe { libc::unlinkat(directory.as_raw_fd(), from.as_ptr(), 0) };
        return Err(error.into());
    }
    let result = rename_entries(directory.as_raw_fd(), &from, &to, expected.is_some());
    if result != 0 {
        let error = std::io::Error::last_os_error();
        unsafe { libc::unlinkat(directory.as_raw_fd(), from.as_ptr(), 0) };
        return Err(error.into());
    }
    if let Some(expected) = expected {
        let old_fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                from.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        // A displaced file that can't be read is treated as the user's.
        let verified = old_fd >= 0 && {
            let old = unsafe { std::fs::File::from_raw_fd(old_fd) };
            file_hash(old).is_ok_and(|hash| hash == expected)
        };
        if !verified {
            let stem = path.file_stem().context("Missing filename")?;
            let kept = keep_visible(directory.as_raw_fd(), &from, None, &stem.to_string_lossy());
            directory.sync_all()?;
            return Err(PublishConflict(if kept.is_some() {
                "The file changed while saving. Your version was kept in a conflict file."
            } else {
                "The file changed while saving. Your version couldn't be renamed and is in a hidden .plainsong file in the notes folder."
            })
            .into());
        }
        unsafe { libc::unlinkat(directory.as_raw_fd(), from.as_ptr(), 0) };
    }
    directory.sync_all()?;
    Ok(())
}

/// Moves `hidden` to a visible name and returns it: `preferred` when that
/// name is free, otherwise a conflict name, shortened if the folder rejects
/// a long one. Never replaces an entry.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn keep_visible(
    directory: libc::c_int,
    hidden: &std::ffi::CStr,
    preferred: Option<&std::ffi::CStr>,
    stem: &str,
) -> Option<String> {
    let id = uuid::Uuid::new_v4();
    let stem = stem.trim_start_matches('.');
    let mut short = String::new();
    for ch in stem.chars() {
        if short.len() + ch.len_utf8() > 60 {
            break;
        }
        short.push(ch);
    }
    let candidates = preferred
        .map(|name| name.to_string_lossy().into_owned())
        .into_iter()
        .chain(
            [stem, short.as_str()]
                .into_iter()
                .filter(|s| !s.is_empty())
                .map(|s| format!("{s} (conflict {id}).md")),
        )
        .chain([format!("Plainsong conflict {id}.md")]);
    for name in candidates {
        let Ok(target) = std::ffi::CString::new(name.as_str()) else {
            continue;
        };
        if rename_entries(directory, hidden, &target, false) == 0 {
            return Some(name);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn rename_entries(
    fd: libc::c_int,
    from: &std::ffi::CStr,
    to: &std::ffi::CStr,
    exchange: bool,
) -> libc::c_int {
    unsafe extern "C" {
        fn renameatx_np(
            fromfd: libc::c_int,
            from: *const libc::c_char,
            tofd: libc::c_int,
            to: *const libc::c_char,
            flags: libc::c_uint,
        ) -> libc::c_int;
    }
    unsafe {
        renameatx_np(
            fd,
            from.as_ptr(),
            fd,
            to.as_ptr(),
            if exchange { 2 } else { 4 },
        )
    }
}
#[cfg(target_os = "linux")]
fn rename_entries(
    fd: libc::c_int,
    from: &std::ffi::CStr,
    to: &std::ffi::CStr,
    exchange: bool,
) -> libc::c_int {
    unsafe {
        libc::renameat2(
            fd,
            from.as_ptr(),
            fd,
            to.as_ptr(),
            if exchange {
                libc::RENAME_EXCHANGE
            } else {
                libc::RENAME_NOREPLACE
            },
        )
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn checked_replace(path: &Path, contents: &[u8], expected: Option<&str>) -> Result<()> {
    anyhow::ensure!(
        expected.is_none(),
        "Safe automatic replacement is unavailable on this platform. Your file was kept."
    );
    let stage = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    safe_fs::atomic_write(&stage, contents)?;
    let result = std::fs::hard_link(&stage, path);
    let _ = std::fs::remove_file(stage);
    result?;
    Ok(())
}

pub fn spawn_note_publishing(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if state
                .sidecar_shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                break;
            }
            if state
                .operation_coordinator
                .is_active(crate::operation_coordinator::OperationKind::Capture)
            {
                continue;
            }
            let Ok(_lease) = state
                .operation_coordinator
                .try_acquire(crate::operation_coordinator::OperationKind::NotePublish)
            else {
                continue;
            };
            let _guard = IO_GATE.lock().await;
            let job = {
                let mut db = state.db.lock().await;
                db.next_publish_job(chrono::Utc::now().timestamp())
                    .and_then(|job| {
                        if let Some(ref job) = job {
                            db.begin_publish(job)?;
                        }
                        Ok(job)
                    })
            };
            let job = match job {
                Ok(Some(job)) => job,
                Ok(None) => continue,
                Err(error) => {
                    tracing::warn!("Could not read note publishing queue: {error}");
                    continue;
                }
            };
            let result=tokio::task::spawn_blocking(move || {
                let result=approved_locations::registry().and_then(|r| r.resolve_filesystem(&job.location_id,approved_locations::ApprovedLocationPurpose::Notes)).and_then(|root| job.write(&root)).map_err(|error| {
                    if error.downcast_ref::<PublishConflict>().is_some() {error} else {anyhow::anyhow!("The notes folder is unavailable or could not be written. Check its connection and permissions, or choose it again in Settings.")}
                });
                (job,result)
            }).await;
            if let Ok((job, result)) = result {
                if let Err(error) = state.db.lock().await.finish_publish(
                    &job,
                    &result,
                    chrono::Utc::now().timestamp(),
                ) {
                    tracing::warn!("Could not acknowledge note publishing: {error}");
                }
            }
        }
    });
}

pub(crate) fn delete_published(receipts: Vec<PublishReceipt>) -> Result<()> {
    delete_published_with(&approved_locations::registry()?, receipts)
}

/// Deletes the file each receipt names in that receipt's own folder, which
/// may be an earlier notes folder. Every folder is resolved before any file
/// is touched, so an unavailable folder deletes nothing.
pub(crate) fn delete_published_with(
    registry: &approved_locations::ApprovedLocationRegistry,
    receipts: Vec<PublishReceipt>,
) -> Result<()> {
    let resolved = receipts
        .into_iter()
        .map(|receipt| {
            registry
                .resolve_filesystem(
                    &receipt.location_id,
                    approved_locations::ApprovedLocationPurpose::Notes,
                )
                .map(|root| (root, receipt))
                .context(
                    "A notes folder for this meeting is unavailable. Keep its file when deleting this meeting.",
                )
        })
        .collect::<Result<Vec<_>>>()?;
    for (root, receipt) in resolved {
        delete_at_receipt(&root, &receipt)?;
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn delete_at_receipt(root: &Path, receipt: &PublishReceipt) -> Result<()> {
    delete_at_receipt_observed(root, receipt, &|_| {})
}

/// `after_move` sees the moved-aside path, so tests can play an editor that
/// writes between the move and the recheck.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn delete_at_receipt_observed(
    root: &Path,
    receipt: &PublishReceipt,
    after_move: &dyn Fn(&Path),
) -> Result<()> {
    use std::{
        ffi::CString,
        os::fd::{AsRawFd, FromRawFd},
    };
    anyhow::ensure!(
        Path::new(&receipt.filename).components().count() == 1 && receipt.filename.ends_with(".md"),
        "Published filename is invalid"
    );
    let directory = safe_fs::open_directory_without_following_links(root)?;
    let filename = CString::new(receipt.filename.as_str())?;
    let read_at = |name: &std::ffi::CStr| -> Result<Option<String>> {
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(error.into());
        }
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        anyhow::ensure!(
            file.metadata()?.is_file(),
            "Published notes must be a regular file"
        );
        Ok(Some(file_hash(file)?))
    };
    // A crash between writing and acknowledging leaves an attempted hash.
    let published =
        |hash: &str| hash == receipt.hash || receipt.attempted_hashes.iter().any(|a| a == hash);
    if let Some(current) = read_at(&filename)? {
        anyhow::ensure!(
            published(&current),
            "The published file was changed outside Plainsong. Keep it when deleting this meeting."
        );
        let kept = CString::new(format!(".plainsong-deleted-{}.md", uuid::Uuid::new_v4()))?;
        anyhow::ensure!(
            rename_entries(directory.as_raw_fd(), &filename, &kept, false) == 0,
            "Couldn't remove the published file. Keep it when deleting this meeting."
        );
        after_move(&root.join(kept.to_string_lossy().as_ref()));
        if read_at(&kept).is_ok_and(|hash| hash.as_deref() == Some(current.as_str())) {
            anyhow::ensure!(
                unsafe { libc::unlinkat(directory.as_raw_fd(), kept.as_ptr(), 0) } == 0,
                "Couldn't remove the saved copy. Its version was kept in the notes folder."
            );
        } else {
            // Changed or unreadable after the move: it may hold the user's edits.
            let stem = Path::new(&receipt.filename)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let kept_as = keep_visible(directory.as_raw_fd(), &kept, Some(&filename), &stem);
            directory.sync_all()?;
            match kept_as {
                Some(name) => anyhow::bail!(
                    "The published file changed during deletion. Your version was kept as \"{name}\" in the notes folder."
                ),
                None => anyhow::bail!(
                    "The published file changed during deletion. It couldn't be renamed and is in a hidden .plainsong file in the notes folder."
                ),
            }
        }
        directory.sync_all()?;
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn delete_at_receipt(_root: &Path, _receipt: &PublishReceipt) -> Result<()> {
    anyhow::bail!("Deleting a published file is unavailable on this platform. Keep it when deleting this meeting.")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn publishing_sanitizes_hostile_unicode_reserved_and_long_titles() {
        for title in [
            "../../secret",
            "CON",
            "nul",
            "COM1",
            "LPT9",
            "a/b\\c:d\0e",
            " \u{202e} ",
            "...",
        ] {
            let safe = safe_title(title);
            assert!(!safe.is_empty());
            assert!(!safe.contains(['/', '\\', ':', '\0', '\u{202e}']));
            assert!(!matches!(
                safe.as_str(),
                "CON" | "nul" | "COM1" | "LPT9" | ".."
            ));
        }
        assert_eq!(safe_title("Cafe\u{301}"), safe_title("Café"));
        assert!(safe_title(&"会".repeat(300)).len() <= 100);
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn publishing_atomic_write_conflict_crash_retry_and_missing_folder() {
        let dir = crate::test_fs::TempDir::new("publish-write");
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("meeting.md");
        checked_write(&path, b"first", None).unwrap();
        checked_write(&path, b"first", None).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"first");
        checked_write(&path, b"second", Some(&hash(b"first"))).unwrap();
        std::fs::write(&path, b"My edits").unwrap();
        assert!(checked_write(&path, b"third", Some(&hash(b"second")))
            .unwrap_err()
            .to_string()
            .contains("outside Plainsong"));
        assert_eq!(std::fs::read(&path).unwrap(), b"My edits");
        assert!(checked_write(&root.join("missing/meeting.md"), b"notes", None).is_err());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    }
    #[cfg(unix)]
    #[test]
    fn publishing_refuses_linked_files_and_ancestors() {
        let dir = crate::test_fs::TempDir::new("publish-links");
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("private"), b"private").unwrap();
        std::os::unix::fs::symlink(root.join("private"), root.join("notes.md")).unwrap();
        assert!(checked_write(&root.join("notes.md"), b"notes", None).is_err());
        std::os::unix::fs::symlink(&root, root.join("link")).unwrap();
        assert!(checked_write(&root.join("link/other.md"), b"notes", None).is_err());
        assert_eq!(std::fs::read(root.join("private")).unwrap(), b"private");
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod render_tests {
    use super::*;
    fn recording(title: &str) -> Recording {
        serde_json::from_value(serde_json::json!({"id":"id/../\n---","title":title,"projectId":"p","duration":60,"createdAt":"2026-10-23T12:00:00Z","updatedAt":"2026-10-23T12:00:00Z","sourceType":"meeting","audioPath":"","status":"completed","summary":"Saved summary","actionItems":["Send draft"],"meetingNotes":"My notes","transcriptComplete":true})).unwrap()
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn publishing_rename_reuses_file_and_frontmatter_and_templates_keep_notes() {
        let dir = crate::test_fs::TempDir::new("publish-rename");
        let root = dir.path().canonicalize().unwrap();
        let config = PublishConfig {
            enabled: true,
            location_id: Some("approved".into()),
            ..PublishConfig::default()
        };
        let original = PublishJob::new(
            recording("Original"),
            String::new(),
            vec![],
            config.clone(),
            None,
            1,
        )
        .unwrap();
        let receipt = original.write(&root).unwrap();
        let renamed = PublishJob::new(
            recording("Renamed\n---\nevil: true"),
            String::new(),
            vec![],
            config.clone(),
            Some(receipt),
            2,
        )
        .unwrap();
        renamed.write(&root).unwrap();
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        let contents = String::from_utf8(renamed.contents.clone()).unwrap();
        assert!(contents.contains("plainsong_recording_id: \"id/../\\n---\""));
        assert!(contents.contains("title: \"Renamed\\n---\\nevil: true\""));
        assert!(contents.contains("My notes"));
        for template in ["meeting", "journal", "interview", "research"] {
            let job = PublishJob::new(
                recording("Title"),
                String::new(),
                vec!["Send draft".into()],
                PublishConfig {
                    template_id: template.into(),
                    ..config.clone()
                },
                None,
                1,
            )
            .unwrap();
            let contents = String::from_utf8(job.contents).unwrap();
            assert!(contents.contains("Saved summary"), "{template}");
            assert!(contents.contains("[x] Send draft"), "{template}");
            assert!(!contents.contains("Private transcript"));
        }
        let job = PublishJob::new(
            recording("Title"),
            "Private transcript".into(),
            vec![],
            PublishConfig {
                include_transcript: true,
                ..config
            },
            None,
            1,
        )
        .unwrap();
        assert!(String::from_utf8(job.contents)
            .unwrap()
            .contains("Private transcript"));
    }
}

#[cfg(all(test, target_os = "macos"))]
mod race_tests {
    use super::*;
    #[test]
    fn publishing_preserves_an_editor_version_that_wins_the_hash_check_race() {
        let dir = crate::test_fs::TempDir::new("publish-race");
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("meeting.md");
        std::fs::write(&path, b"Editor replaced this after the initial check").unwrap();
        let result = checked_replace(&path, b"New notes", Some(&hash(b"Last published notes")));
        assert!(result.unwrap_err().to_string().contains("conflict file"));
        assert_eq!(std::fs::read(&path).unwrap(), b"New notes");
        let conflict = std::fs::read_dir(root)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains("conflict")
            })
            .unwrap();
        assert_eq!(
            std::fs::read(conflict).unwrap(),
            b"Editor replaced this after the initial check"
        );
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod deletion_tests {
    use super::*;
    #[test]
    fn publishing_deletion_keeps_external_edits_and_refuses_links_and_traversal() {
        let dir = crate::test_fs::TempDir::new("publish-delete");
        let root = dir.path().canonicalize().unwrap();
        let receipt = PublishReceipt {
            location_id: "approved".into(),
            filename: "meeting.md".into(),
            hash: hash(b"Published"),
            attempted_hashes: vec![],
            revision: 1,
        };
        std::fs::write(root.join("meeting.md"), b"External edit").unwrap();
        assert!(delete_at_receipt(&root, &receipt).is_err());
        assert_eq!(
            std::fs::read(root.join("meeting.md")).unwrap(),
            b"External edit"
        );
        std::fs::write(root.join("meeting.md"), b"Published").unwrap();
        delete_at_receipt(&root, &receipt).unwrap();
        assert!(!root.join("meeting.md").exists());
        delete_at_receipt(&root, &receipt).unwrap();
        std::fs::write(root.join("other.md"), b"Published").unwrap();
        std::os::unix::fs::symlink(root.join("other.md"), root.join("meeting.md")).unwrap();
        assert!(delete_at_receipt(&root, &receipt).is_err());
        assert!(root.join("other.md").exists());
        assert!(delete_at_receipt(
            &root,
            &PublishReceipt {
                filename: "../outside.md".into(),
                ..receipt
            }
        )
        .is_err());
    }
}

#[cfg(test)]
mod ownership_tests {
    use super::*;

    fn published(id: &str, revision: i64) -> String {
        let recording: Recording = serde_json::from_value(serde_json::json!({"id":id,"title":"Plan","projectId":"p","duration":60,"createdAt":"2026-10-23T12:00:00Z","updatedAt":"2026-10-23T12:00:00Z","sourceType":"meeting","audioPath":"","status":"completed","summary":"Saved summary","actionItems":["Send draft"],"meetingNotes":"Body","transcriptComplete":true})).unwrap();
        let config = PublishConfig {
            enabled: true,
            location_id: Some("approved".into()),
            ..PublishConfig::default()
        };
        let job =
            PublishJob::new(recording, String::new(), vec![], config, None, revision).unwrap();
        String::from_utf8(job.contents).unwrap()
    }

    #[test]
    fn publishing_fingerprint_identifies_only_unedited_plainsong_files() {
        let file = published("meeting", 7);
        assert_eq!(pristine_revision(file.as_bytes(), "meeting"), Some(7));
        assert_eq!(pristine_revision(file.as_bytes(), "other"), None);
        for edited in [
            file.replace("Body", "Body, edited"),
            file.replace("plainsong_revision: 7", "plainsong_revision: 9"),
            file.replace("\n", "\r\n"),
            format!("{file}\n"),
            // A second ID line cannot redirect ownership.
            file.replacen("---\n", "---\nplainsong_recording_id: \"meeting\"\n", 1),
        ] {
            assert_eq!(
                pristine_revision(edited.as_bytes(), "meeting"),
                None,
                "{edited}"
            );
        }
        let unsigned: String = file
            .lines()
            .filter(|l| !l.starts_with(FINGERPRINT_KEY))
            .map(|l| format!("{l}\n"))
            .collect();
        assert_eq!(pristine_revision(unsigned.as_bytes(), "meeting"), None);
        assert_eq!(pristine_revision(b"\xff\xfe", "meeting"), None);
    }
}

#[cfg(test)]
mod title_tests {
    use super::*;
    #[test]
    fn publishing_titles_keep_combining_marks_in_indic_and_thai_scripts() {
        // Virama and Thai tone marks are Unicode marks but not alphabetic.
        assert_eq!(safe_title("नमस्ते टीम"), "नमस्ते टीम");
        assert_eq!(safe_title("ประชุมก่อนเที่ยง"), "ประชุมก่อนเที่ยง");
        assert_eq!(safe_title("\u{301}Plan"), "Plan");
        assert_eq!(safe_title("a/\u{301}b"), "a__b");
        assert!(safe_title(&format!("a{}", "\u{301}".repeat(500))).len() <= 100);
        assert!(!safe_title("a\u{202e}b").contains('\u{202e}'));
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod visibility_tests {
    use super::*;

    fn names(root: &Path) -> Vec<String> {
        std::fs::read_dir(root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    fn conflict_copy(root: &Path) -> Vec<u8> {
        let name = names(root)
            .into_iter()
            .find(|n| n.contains("conflict"))
            .unwrap_or_else(|| panic!("no conflict copy in {:?}", names(root)));
        std::fs::read(root.join(name)).unwrap()
    }

    fn assert_nothing_hidden(root: &Path) {
        let names = names(root);
        assert!(names.iter().all(|n| !n.starts_with('.')), "{names:?}");
    }

    #[test]
    fn publishing_keeps_an_unreadable_displaced_file_visible() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::test_fs::TempDir::new("publish-unreadable");
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("meeting.md");
        std::fs::write(&path, b"Editor version").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        assert!(checked_replace(&path, b"New notes", Some(&hash(b"Published"))).is_err());
        assert_nothing_hidden(&root);
        for name in names(&root) {
            std::fs::set_permissions(root.join(name), std::fs::Permissions::from_mode(0o644))
                .unwrap();
        }
        assert_eq!(std::fs::read(&path).unwrap(), b"New notes");
        assert_eq!(conflict_copy(&root), b"Editor version");
    }

    #[test]
    fn publishing_keeps_a_conflict_copy_visible_when_the_name_is_too_long() {
        let dir = crate::test_fs::TempDir::new("publish-long-conflict");
        let root = dir.path().canonicalize().unwrap();
        let path = root.join(format!("{}.md", "a".repeat(240)));
        std::fs::write(&path, b"Editor version").unwrap();
        assert!(checked_replace(&path, b"New notes", Some(&hash(b"Published"))).is_err());
        assert_nothing_hidden(&root);
        assert_eq!(std::fs::read(&path).unwrap(), b"New notes");
        assert_eq!(conflict_copy(&root), b"Editor version");
    }

    #[test]
    fn publishing_deletion_restores_a_file_edited_mid_delete() {
        let dir = crate::test_fs::TempDir::new("publish-delete-race");
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("meeting.md");
        let receipt = PublishReceipt {
            location_id: "approved".into(),
            filename: "meeting.md".into(),
            hash: hash(b"Published"),
            attempted_hashes: vec![],
            revision: 1,
        };
        std::fs::write(&path, b"Published").unwrap();
        let edit = |kept: &Path| std::fs::write(kept, b"Edited during delete").unwrap();
        let error = delete_at_receipt_observed(&root, &receipt, &edit).unwrap_err();
        assert!(error.to_string().contains("meeting.md"), "{error}");
        assert_nothing_hidden(&root);
        assert_eq!(std::fs::read(&path).unwrap(), b"Edited during delete");

        // The editor also saved a new file under the original name.
        std::fs::write(&path, b"Published").unwrap();
        let edit_and_recreate = |kept: &Path| {
            std::fs::write(kept, b"Second edit").unwrap();
            std::fs::write(kept.with_file_name("meeting.md"), b"New file").unwrap();
        };
        assert!(delete_at_receipt_observed(&root, &receipt, &edit_and_recreate).is_err());
        assert_nothing_hidden(&root);
        assert_eq!(std::fs::read(&path).unwrap(), b"New file");
        assert_eq!(conflict_copy(&root), b"Second edit");
    }
}

#[cfg(test)]
mod portable_tests {
    use super::*;
    #[test]
    fn publishing_first_write_never_replaces_an_unowned_file() {
        let dir = crate::test_fs::TempDir::new("publish-exclusive");
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("notes.md");
        checked_write(&path, b"First notes", None).unwrap();
        assert!(checked_write(&path, b"Different notes", None).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"First notes");
    }
}
