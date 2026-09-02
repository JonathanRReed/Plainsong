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

use std::collections::HashMap;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tokio::sync::oneshot;

use crate::crypto::ProjectKeyManager;

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
pub(crate) struct PlaybackEntry {
    pub recording_id: String,
    pub path: PathBuf,
    pub protection: PlaybackProtection,
    /// Fires on release. The task holding the decrypted temp-file guard and the
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
        path: PathBuf,
        protection: PlaybackProtection,
        release: oneshot::Sender<()>,
    ) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.insert(
            token,
            PlaybackEntry {
                recording_id,
                path,
                protection,
                release: Some(release),
            },
        );
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

    pub(crate) fn release_all(&self) -> Vec<ReleasedPlayback> {
        let drained: Vec<(String, PlaybackEntry)> = {
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            entries.drain().collect()
        };
        drained
            .into_iter()
            .filter_map(|(token, entry)| Self::finish(&token, entry))
            .collect()
    }

    pub(crate) fn describe(&self, token: &str) -> Option<(String, PathBuf, PlaybackProtection)> {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.get(token).map(|entry| {
            (
                entry.recording_id.clone(),
                entry.path.clone(),
                entry.protection,
            )
        })
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).len()
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

    fn scratch_dir(label: &str) -> PathBuf {
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

    #[test]
    fn release_signals_the_holder_and_forgets_the_token() {
        let registry = PlaybackRegistry::default();
        let (tx, rx) = oneshot::channel();
        registry.register(
            "tok".to_string(),
            "rec-1".to_string(),
            PathBuf::from("/tmp/a.wav"),
            PlaybackProtection::Decrypted,
            tx,
        );
        assert_eq!(registry.len(), 1);
        let (recording_id, path, protection) = registry.describe("tok").expect("registered");
        assert_eq!(recording_id, "rec-1");
        assert_eq!(path, PathBuf::from("/tmp/a.wav"));
        assert_eq!(protection, PlaybackProtection::Decrypted);

        let released = registry.release("tok").expect("release known token");
        assert_eq!(released.recording_id, "rec-1");
        assert_eq!(registry.len(), 0);
        // The holder task receives the signal exactly once.
        assert!(rx.blocking_recv().is_ok());
        // Releasing again is a no-op, not an error.
        assert!(registry.release("tok").is_none());
        assert!(registry.release("never-registered").is_none());
    }

    #[test]
    fn forget_drops_the_token_without_signalling() {
        let registry = PlaybackRegistry::default();
        let (tx, rx) = oneshot::channel();
        registry.register(
            "tok".to_string(),
            "rec-1".to_string(),
            PathBuf::from("/tmp/a.wav"),
            PlaybackProtection::Plaintext,
            tx,
        );
        let forgotten = registry.forget("tok").expect("forget known token");
        assert_eq!(forgotten.protection, PlaybackProtection::Plaintext);
        // Sender dropped unsent: the receiver sees a closed channel.
        assert!(rx.blocking_recv().is_err());
    }

    #[test]
    fn release_all_drains_every_token() {
        let registry = PlaybackRegistry::default();
        for index in 0..3 {
            let (tx, _rx) = oneshot::channel();
            registry.register(
                format!("tok-{index}"),
                "rec".to_string(),
                PathBuf::from("/tmp/a.wav"),
                PlaybackProtection::Plaintext,
                tx,
            );
        }
        let released = registry.release_all();
        assert_eq!(released.len(), 3);
        assert_eq!(registry.len(), 0);
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
