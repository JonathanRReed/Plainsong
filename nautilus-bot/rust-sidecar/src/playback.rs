//! In-app playback tokens for recording audio.
//!
//! The renderer never learns a filesystem path. `prepare_recording_playback`
//! resolves a recording's primary track — decrypting a vault-protected file
//! into the app-owned runtime directory, one frame at a time — and registers
//! it under an unguessable token. The path travels only to the privileged
//! Electron process, which serves the bytes through
//! `plainsong://playback/<token>` and calls `release_recording_playback` when
//! the reader moves on. Releasing drops the decrypted temporary; locking the
//! vault revokes every token through the operation coordinator; sidecar
//! startup and shutdown sweep the runtime directory so nothing outlives the
//! process that wrote it.

use std::collections::{HashMap, HashSet};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

use crate::crypto::ProjectKeyManager;
use crate::recording_audio::ResolvedRecordingAudioBundle;

/// How many meetings may hold decrypted playback audio at once.
///
/// Each distinct meeting costs one full-length plaintext WAV in the runtime
/// directory for as long as a token is live. Tokens for a meeting that is
/// already open cost nothing extra — they share that one file — so the cap
/// counts meetings, not tokens.
pub(crate) const MAX_LIVE_PLAYBACK_RECORDINGS: usize = 3;

/// Whether the served file is the stored plaintext or an app-owned decrypted
/// copy that must be deleted on release.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PlaybackProtection {
    Plaintext,
    Decrypted,
}

impl PlaybackProtection {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Plaintext => "plaintext",
            Self::Decrypted => "decrypted",
        }
    }
}

/// One prepared playback, addressable by its token.
///
/// The resolved audio is held behind an `Arc` shared with every other token
/// for the same recording and with the holder task: the decrypted temporary
/// is written once and deleted when the last of them drops. Before this each
/// prepare decrypted the whole meeting again and pinned another full-length
/// plaintext copy until the vault locked.
pub(crate) struct PlaybackEntry {
    pub recording_id: String,
    pub protection: PlaybackProtection,
    audio: Arc<ResolvedRecordingAudioBundle>,
    /// Fires on release. The task holding the resolved-audio share and the
    /// coordinator lease drops both when it receives this.
    release: Option<oneshot::Sender<()>>,
}

/// What a caller learns when it releases a token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReleasedPlayback {
    pub token: String,
    pub recording_id: String,
    pub protection: PlaybackProtection,
}

#[derive(Default)]
pub(crate) struct PlaybackRegistry {
    entries: Mutex<HashMap<String, PlaybackEntry>>,
}

impl PlaybackRegistry {
    /// 32 lowercase hex characters from a v4 UUID: 122 bits of randomness,
    /// URL-safe, and shaped so the Electron side can validate it strictly.
    pub(crate) fn new_token() -> String {
        uuid::Uuid::new_v4().simple().to_string()
    }

    pub(crate) fn register(
        &self,
        token: String,
        recording_id: String,
        audio: Arc<ResolvedRecordingAudioBundle>,
        protection: PlaybackProtection,
        release: oneshot::Sender<()>,
    ) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.insert(
            token,
            PlaybackEntry {
                recording_id,
                protection,
                audio,
                release: Some(release),
            },
        );
    }

    /// The audio a live token for `recording_id` is already serving, if the
    /// file it points at is still there.
    ///
    /// A second prepare for the same meeting shares this instead of decrypting
    /// the whole file again: twenty opens of a two-hour meeting used to leave
    /// twenty full-length plaintext copies in the runtime directory, every one
    /// of them pinned until the vault locked or the app quit. Entries whose
    /// file has vanished underneath them (a sweep, a vault lock racing the
    /// revoke) are released here rather than reused, so a stale token neither
    /// serves a missing file nor counts against the cap.
    pub(crate) fn live_audio(
        &self,
        recording_id: &str,
    ) -> Option<Arc<ResolvedRecordingAudioBundle>> {
        let mut stale = Vec::new();
        let mut reusable = None;
        {
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            let tokens: Vec<String> = entries
                .iter()
                .filter(|(_, entry)| entry.recording_id == recording_id)
                .map(|(token, _)| token.clone())
                .collect();
            for token in tokens {
                let usable = entries
                    .get(&token)
                    .is_some_and(|entry| is_regular_file(&entry.audio.primary));
                if usable {
                    if reusable.is_none() {
                        reusable = entries.get(&token).map(|entry| Arc::clone(&entry.audio));
                    }
                } else if let Some(entry) = entries.remove(&token) {
                    stale.push((token, entry));
                }
            }
        }
        for (token, entry) in stale {
            Self::finish(&token, entry);
        }
        reusable
    }

    /// Refuse a prepare that would open a fourth meeting's plaintext.
    ///
    /// A meeting that is already open is always admitted: its token shares the
    /// file that is already on disk. Fails closed with a message that says what
    /// to do, because the alternative — decrypting without limit — is how a
    /// long meeting's plaintext filled the disk.
    pub(crate) fn admit(&self, recording_id: &str) -> Result<(), String> {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let live: HashSet<&str> = entries
            .values()
            .map(|entry| entry.recording_id.as_str())
            .collect();
        if live.contains(recording_id) || live.len() < MAX_LIVE_PLAYBACK_RECORDINGS {
            return Ok(());
        }
        Err(format!(
            "{MAX_LIVE_PLAYBACK_RECORDINGS} meetings are already open for playback. Close one before opening another."
        ))
    }

    /// Release every token for one recording. Used when a prepare failed on the
    /// Electron side after the sidecar had already registered its token, which
    /// would otherwise leave the plaintext pinned with nobody able to release
    /// it.
    pub(crate) fn release_recording(&self, recording_id: &str) -> Vec<ReleasedPlayback> {
        let removed: Vec<(String, PlaybackEntry)> = {
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            let tokens: Vec<String> = entries
                .iter()
                .filter(|(_, entry)| entry.recording_id == recording_id)
                .map(|(token, _)| token.clone())
                .collect();
            tokens
                .into_iter()
                .filter_map(|token| entries.remove(&token).map(|entry| (token, entry)))
                .collect()
        };
        removed
            .into_iter()
            .filter_map(|(token, entry)| Self::finish(&token, entry))
            .collect()
    }

    /// Remove a token and signal its holder task. Idempotent: an unknown token
    /// is not an error, because the renderer may release after a vault lock
    /// already revoked it.
    pub(crate) fn release(&self, token: &str) -> Option<ReleasedPlayback> {
        let entry = {
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            entries.remove(token)?
        };
        Self::finish(token, entry)
    }

    /// Forget a token without signalling: the holder task is already gone
    /// (it was revoked by the coordinator and is removing itself).
    pub(crate) fn forget(&self, token: &str) -> Option<ReleasedPlayback> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let mut entry = entries.remove(token)?;
        entry.release.take();
        Self::finish(token, entry)
    }

    fn finish(token: &str, mut entry: PlaybackEntry) -> Option<ReleasedPlayback> {
        if let Some(release) = entry.release.take() {
            // The receiver may already be gone (task finished on revoke).
            let _ = release.send(());
        }
        Some(ReleasedPlayback {
            token: token.to_string(),
            recording_id: entry.recording_id,
            protection: entry.protection,
        })
    }
}

/// Whether a path still resolves to a regular file. `symlink_metadata` rather
/// than `metadata`, so a symlink dropped where a decrypted temporary used to
/// be is never mistaken for the file itself.
fn is_regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
}

/// Decrypt one vault-protected recording file into `destination`.
///
/// PSVAULT1 payloads are decrypted frame by frame, so a long meeting never has
/// its plaintext (or its ciphertext) held in memory at once. The pre-streaming
/// legacy layout has no frames and is read whole, because that format cannot
/// be streamed. The destination is created fresh with owner-only permissions
/// and removed again if anything fails midway, so a half-written plaintext
/// never lingers.
pub(crate) fn decrypt_vault_file_to_path(
    source: &Path,
    destination: &Path,
    key: &[u8; 32],
) -> Result<u64, String> {
    let file = std::fs::File::open(source).map_err(|error| {
        format!(
            "Failed to read encrypted recording audio '{}': {}",
            source.display(),
            error
        )
    })?;
    let mut reader = BufReader::new(file);

    let mut magic = [0_u8; 8];
    let is_streaming = match reader.read_exact(&mut magic) {
        Ok(()) => ProjectKeyManager::is_streaming_payload(&magic),
        // Too short to carry a magic; it cannot be a streaming payload.
        Err(_) => false,
    };
    reader.seek(SeekFrom::Start(0)).map_err(|error| {
        format!(
            "Failed to rewind encrypted recording audio '{}': {}",
            source.display(),
            error
        )
    })?;

    let output =
        crate::recording_audio::create_new_file(destination).map_err(|error| error.to_string())?;
    let result = write_decrypted(&mut reader, output, key, is_streaming);
    if result.is_err() {
        let _ = std::fs::remove_file(destination);
    }
    result.map_err(|error| {
        format!(
            "Failed to decrypt recording audio '{}': {}",
            source.display(),
            error
        )
    })
}

fn write_decrypted<R: Read>(
    reader: &mut R,
    output: std::fs::File,
    key: &[u8; 32],
    is_streaming: bool,
) -> anyhow::Result<u64> {
    let mut writer = BufWriter::new(output);
    let plaintext_bytes = if is_streaming {
        ProjectKeyManager::decrypt_stream(reader, &mut writer, key)?
    } else {
        let mut ciphertext = Vec::new();
        reader.read_to_end(&mut ciphertext)?;
        let plaintext = ProjectKeyManager::decrypt(&ciphertext, key)?;
        writer.write_all(&plaintext)?;
        plaintext.len() as u64
    };
    writer.flush()?;
    let output = writer
        .into_inner()
        .map_err(|error| anyhow::anyhow!("Failed to flush decrypted audio: {}", error))?;
    output.sync_all()?;
    Ok(plaintext_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "plainsong-playback-{}-{}",
            label,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    #[test]
    fn tokens_are_32_hex_characters() {
        let token = PlaybackRegistry::new_token();
        assert_eq!(token.len(), 32);
        assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(token, PlaybackRegistry::new_token());
    }

    /// A resolved bundle over a real file, with the temp-file guard armed so
    /// dropping the last share deletes it — exactly what a decrypted playback
    /// holds.
    fn decrypted_audio(path: &std::path::Path) -> Arc<ResolvedRecordingAudioBundle> {
        std::fs::write(path, b"RIFF").expect("write temp audio");
        Arc::new(ResolvedRecordingAudioBundle::new(
            path.to_path_buf(),
            None,
            None,
            vec![crate::recording_audio::DurableTempFile::new(
                path.to_path_buf(),
            )],
        ))
    }

    fn plain_audio(path: &std::path::Path) -> Arc<ResolvedRecordingAudioBundle> {
        std::fs::write(path, b"RIFF").expect("write audio");
        Arc::new(ResolvedRecordingAudioBundle::new(
            path.to_path_buf(),
            None,
            None,
            Vec::new(),
        ))
    }

    #[test]
    fn release_signals_the_holder_and_forgets_the_token() {
        let dir = scratch_dir("release");
        let registry = PlaybackRegistry::default();
        let (tx, rx) = oneshot::channel();
        registry.register(
            "tok".to_string(),
            "rec-1".to_string(),
            plain_audio(&dir.join("a.wav")),
            PlaybackProtection::Decrypted,
            tx,
        );

        let released = registry.release("tok").expect("release known token");
        assert_eq!(released.token, "tok");
        assert_eq!(released.recording_id, "rec-1");
        assert_eq!(released.protection, PlaybackProtection::Decrypted);
        // The holder task receives the signal exactly once.
        assert!(rx.blocking_recv().is_ok());
        // Releasing again is a no-op, not an error.
        assert!(registry.release("tok").is_none());
        assert!(registry.release("never-registered").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn forget_drops_the_token_without_signalling() {
        let dir = scratch_dir("forget");
        let registry = PlaybackRegistry::default();
        let (tx, rx) = oneshot::channel();
        registry.register(
            "tok".to_string(),
            "rec-1".to_string(),
            plain_audio(&dir.join("a.wav")),
            PlaybackProtection::Plaintext,
            tx,
        );
        let forgotten = registry.forget("tok").expect("forget known token");
        assert_eq!(forgotten.protection, PlaybackProtection::Plaintext);
        // Sender dropped unsent: the receiver sees a closed channel.
        assert!(rx.blocking_recv().is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_registered_token_releases_independently() {
        let dir = scratch_dir("independent");
        let registry = PlaybackRegistry::default();
        let audio = plain_audio(&dir.join("a.wav"));
        let mut receivers = Vec::new();
        for index in 0..3 {
            let (tx, rx) = oneshot::channel();
            registry.register(
                format!("tok-{index}"),
                "rec".to_string(),
                Arc::clone(&audio),
                PlaybackProtection::Plaintext,
                tx,
            );
            receivers.push(rx);
        }
        for (index, mut receiver) in receivers.into_iter().enumerate() {
            let released = registry
                .release(&format!("tok-{index}"))
                .expect("release known token");
            assert_eq!(released.token, format!("tok-{index}"));
            assert!(receiver.try_recv().is_ok(), "holder {index} was signalled");
        }
        assert!(registry.release("tok-0").is_none(), "tokens are gone");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_prepare_shares_the_first_decrypted_copy() {
        let dir = scratch_dir("share");
        let registry = PlaybackRegistry::default();
        let temp = dir.join("decrypted.wav");
        let audio = decrypted_audio(&temp);
        let (first_tx, _first_rx) = oneshot::channel();
        registry.register(
            "tok-1".to_string(),
            "rec-1".to_string(),
            Arc::clone(&audio),
            PlaybackProtection::Decrypted,
            first_tx,
        );
        // The holder task's share; the registry's is the other one.
        drop(audio);

        let reused = registry
            .live_audio("rec-1")
            .expect("a live token's audio is reused");
        assert_eq!(reused.primary, temp, "the same decrypted file is served");
        assert!(
            registry.live_audio("rec-2").is_none(),
            "another meeting has nothing to share"
        );
        let (second_tx, _second_rx) = oneshot::channel();
        registry.register(
            "tok-2".to_string(),
            "rec-1".to_string(),
            Arc::clone(&reused),
            PlaybackProtection::Decrypted,
            second_tx,
        );
        drop(reused);

        // Releasing one token must not pull the file out from under the other.
        registry.release("tok-1").expect("release the first token");
        assert!(temp.exists(), "the second token is still playing this file");
        registry.release("tok-2").expect("release the second token");
        assert!(!temp.exists(), "the last release deletes the plaintext");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_token_whose_file_vanished_is_released_rather_than_reused() {
        let dir = scratch_dir("stale");
        let registry = PlaybackRegistry::default();
        let temp = dir.join("gone.wav");
        let audio = decrypted_audio(&temp);
        let (tx, mut rx) = oneshot::channel();
        registry.register(
            "tok".to_string(),
            "rec-1".to_string(),
            Arc::clone(&audio),
            PlaybackProtection::Decrypted,
            tx,
        );
        drop(audio);
        std::fs::remove_file(&temp).expect("remove the plaintext behind the token");

        assert!(
            registry.live_audio("rec-1").is_none(),
            "a missing file must not be handed to a new player"
        );
        assert!(rx.try_recv().is_ok(), "the stale holder was signalled");
        assert!(
            registry.release("tok").is_none(),
            "the stale token is no longer registered"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn playback_is_refused_past_the_open_meeting_cap() {
        let dir = scratch_dir("cap");
        let registry = PlaybackRegistry::default();
        let mut senders = Vec::new();
        for index in 0..MAX_LIVE_PLAYBACK_RECORDINGS {
            registry
                .admit(&format!("rec-{index}"))
                .expect("a meeting under the cap is admitted");
            let (tx, rx) = oneshot::channel();
            senders.push(rx);
            registry.register(
                format!("tok-{index}"),
                format!("rec-{index}"),
                decrypted_audio(&dir.join(format!("{index}.wav"))),
                PlaybackProtection::Decrypted,
                tx,
            );
        }

        let error = registry
            .admit("rec-overflow")
            .expect_err("a fourth meeting must be refused");
        assert!(
            error.contains("Close one before opening another"),
            "{error}"
        );
        // A meeting that is already open costs no new plaintext, so it is
        // always admitted — this is what lets a player remount.
        registry
            .admit("rec-0")
            .expect("an open meeting is always admitted");

        registry.release("tok-0").expect("release one meeting");
        registry
            .admit("rec-overflow")
            .expect("the freed slot is usable");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn releasing_a_recording_drops_every_token_it_has() {
        let dir = scratch_dir("release-recording");
        let registry = PlaybackRegistry::default();
        let temp = dir.join("decrypted.wav");
        let audio = decrypted_audio(&temp);
        let mut receivers = Vec::new();
        for index in 0..2 {
            let (tx, rx) = oneshot::channel();
            receivers.push(rx);
            registry.register(
                format!("tok-{index}"),
                "rec-1".to_string(),
                Arc::clone(&audio),
                PlaybackProtection::Decrypted,
                tx,
            );
        }
        let (other_tx, _other_rx) = oneshot::channel();
        registry.register(
            "tok-other".to_string(),
            "rec-2".to_string(),
            plain_audio(&dir.join("other.wav")),
            PlaybackProtection::Plaintext,
            other_tx,
        );
        drop(audio);

        let released = registry.release_recording("rec-1");
        assert_eq!(released.len(), 2, "{released:?}");
        assert!(released.iter().all(|entry| entry.recording_id == "rec-1"));
        for mut receiver in receivers {
            assert!(receiver.try_recv().is_ok(), "every holder was signalled");
        }
        assert!(!temp.exists(), "the abandoned plaintext is gone");
        assert!(
            registry.release("tok-other").is_some(),
            "another meeting's token is untouched"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn streaming_payload_decrypts_to_an_owner_only_file() {
        let dir = scratch_dir("stream");
        let key = [7u8; 32];
        // Larger than one 1 MiB frame so more than one frame is exercised.
        let plaintext: Vec<u8> = (0..(1024 * 1024 + 4096)).map(|i| (i % 251) as u8).collect();
        let source = dir.join("track.wav.enc");
        {
            let mut reader = std::io::Cursor::new(plaintext.clone());
            let mut writer = std::fs::File::create(&source).expect("create ciphertext");
            ProjectKeyManager::encrypt_stream(&mut reader, &mut writer, &key, |_| {})
                .expect("encrypt stream");
        }

        let destination = dir.join("decrypted.wav");
        let bytes =
            decrypt_vault_file_to_path(&source, &destination, &key).expect("decrypt streaming");
        assert_eq!(bytes, plaintext.len() as u64);
        assert_eq!(
            std::fs::read(&destination).expect("read plaintext"),
            plaintext
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&destination)
                .expect("stat plaintext")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "decrypted temp must be owner-only");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_whole_file_payload_still_decrypts() {
        let dir = scratch_dir("legacy");
        let key = [9u8; 32];
        let plaintext = b"RIFF legacy payload".to_vec();
        let source = dir.join("legacy.enc");
        std::fs::write(
            &source,
            ProjectKeyManager::encrypt(&plaintext, &key).expect("legacy encrypt"),
        )
        .expect("write ciphertext");

        let destination = dir.join("legacy.wav");
        let bytes =
            decrypt_vault_file_to_path(&source, &destination, &key).expect("decrypt legacy");
        assert_eq!(bytes, plaintext.len() as u64);
        assert_eq!(
            std::fs::read(&destination).expect("read plaintext"),
            plaintext
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_key_leaves_no_partial_plaintext_behind() {
        let dir = scratch_dir("wrong-key");
        let plaintext = vec![3u8; 2048];
        let source = dir.join("track.enc");
        {
            let mut reader = std::io::Cursor::new(plaintext);
            let mut writer = std::fs::File::create(&source).expect("create ciphertext");
            ProjectKeyManager::encrypt_stream(&mut reader, &mut writer, &[1u8; 32], |_| {})
                .expect("encrypt stream");
        }
        let destination = dir.join("should-not-exist.wav");
        let error = decrypt_vault_file_to_path(&source, &destination, &[2u8; 32])
            .expect_err("wrong key must fail");
        assert!(error.contains("Failed to decrypt"), "{error}");
        assert!(!destination.exists(), "partial plaintext must be removed");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
