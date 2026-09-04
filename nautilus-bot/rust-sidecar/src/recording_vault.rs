//! The vault: recording audio at rest, and the keys that open it.
//!
//! Unlocking the vault runtime, installing and migrating the database key,
//! encrypting a finalised recording's audio (in resumable phases, so a crash
//! or a full disk cannot lose the only copy), verifying an encrypted item, and
//! staging a decrypted copy for playback plus sweeping it away again.
//!
//! Everything here is `pub(crate)` and re-exported from `lib.rs`, except
//! `sweep_runtime_playback_audio_for_sidecar`, which the sidecar binary calls
//! and which stays `pub`. The move did not rename or re-sign anything.

use super::*;

pub(crate) async fn build_security_status(state: &AppState) -> Result<SecurityStatus, String> {
    let (privacy, vault_unlocked, db_encrypted) = {
        let settings_manager = state.settings_manager.lock().await;
        let privacy = settings_manager.settings().privacy.clone();
        let vault_state = state.vault_state.lock().await;
        (privacy, vault_state.unlocked, vault_state.db_encrypted)
    };

    // Count canonical owned assets rather than recording rows. An open
    // operation keeps the aggregate false because cleanup-pending plaintext
    // shadows still exist even after the encrypted paths were switched.
    let (recordings_encrypted_count, recordings_stored_count, encryption_incomplete) = {
        let db = state.db.lock().await;
        let (encrypted, stored) = db.count_encrypted_recordings().map_err(|e| e.to_string())?;
        let incomplete = db
            .recording_audio_encryption_incomplete()
            .map_err(|e| e.to_string())?;
        (encrypted, stored, incomplete)
    };

    Ok(SecurityStatus {
        vault_initialized: privacy.vault_initialized && !encryption_incomplete,
        vault_unlocked,
        database_encrypted: db_encrypted,
        recordings_encrypted: recordings_encrypted_count == recordings_stored_count
            && !encryption_incomplete,
        recordings_encrypted_count,
        recordings_stored_count,
        // One field, two lanes. Reports the meetings lane: it is the one that
        // sends whole transcripts off to a provider, so it is the answer that
        // matters for a security readout.
        llm_provider: AnalysisProvider::from_settings_value(
            &privacy.ai_lane(settings::AiLane::Meetings).provider,
        )?
        .as_settings_value()
        .to_string(),
        remote_processing_enabled: privacy.remote_processing_enabled,
        export_root: privacy.export_location_label.or_else(|| {
            privacy.export_root.and_then(|path| {
                path.file_name()
                    .and_then(|value| value.to_str())
                    .map(ToString::to_string)
            })
        }),
    })
}

pub(crate) async fn unlock_vault_runtime(state: &AppState, password: &str) -> Result<(), String> {
    let password = password.trim();
    if password.is_empty() {
        return Err("Vault password cannot be empty".to_string());
    }
    let _storage_guard = state.audio_storage_gate.lock().await;

    let (vault_initialized, existing_salt) = {
        let settings_manager = state.settings_manager.lock().await;
        (
            settings_manager.settings().privacy.vault_initialized,
            settings_manager.settings().privacy.vault_salt.clone(),
        )
    };

    let salt = if let Some(value) = existing_salt.as_deref() {
        crate::crypto::ProjectKeyManager::salt_from_string(value)
            .map_err(|e| format!("Invalid vault salt in settings: {}", e))?
    } else {
        let mut generated = [0u8; VAULT_RECORDING_KEY_SALT_LEN];
        rand::rng().fill_bytes(&mut generated);
        generated
    };

    let recording_key = crate::crypto::ProjectKeyManager::derive_key(password, &salt)
        .map_err(|e| format!("Failed to derive recording key: {}", e))?;

    let unlock_verifier =
        secrets::get_internal_secret(VAULT_UNLOCK_CHECK_SECRET).map_err(|e| e.to_string())?;
    if let Some(blob_hex) = unlock_verifier.as_deref() {
        let blob = hex::decode(blob_hex).map_err(|e| format!("Invalid unlock verifier: {}", e))?;
        let plaintext = crate::crypto::ProjectKeyManager::decrypt(&blob, &recording_key)
            .map_err(|_| "Invalid vault password".to_string())?;
        if plaintext != VAULT_UNLOCK_CHECK_PLAINTEXT {
            return Err("Invalid vault password".to_string());
        }
    } else if vault_initialized {
        return Err("Vault is initialized but unlock verifier is missing".to_string());
    } else {
        let mut settings_manager = state.settings_manager.lock().await;
        if settings_manager.settings().privacy.vault_salt.is_none() {
            settings_manager.settings_mut().privacy.vault_salt =
                Some(crate::crypto::ProjectKeyManager::salt_to_string(&salt));
            settings_manager.save().map_err(|e| e.to_string())?;
        }
    }

    let db_encrypted = {
        let db = state.db.lock().await;
        db.is_encrypted().map_err(|e| e.to_string())?
    };

    let mut vault_state = state.vault_state.lock().await;
    if let Some(mut previous_key) = vault_state.recording_key.take() {
        use zeroize::Zeroize;
        previous_key.zeroize();
    }
    vault_state.unlocked = true;
    vault_state.db_encrypted = db_encrypted;
    vault_state.recording_key = Some(recording_key);
    drop(vault_state);

    if vault_initialized || unlock_verifier.is_some() {
        let recording_ids = {
            let db = state.db.lock().await;
            let mut recording_ids = db
                .list_open_recording_audio_operations()
                .map_err(|error| error.to_string())?
                .into_iter()
                .map(|operation| operation.recording_id)
                .collect::<HashSet<_>>();
            recording_ids.extend(
                db.recording_ids_with_ready_plaintext_audio()
                    .map_err(|error| error.to_string())?,
            );
            recording_ids
        };
        for recording_id in recording_ids {
            let operation = state
                .db
                .lock()
                .await
                .begin_recording_audio_encryption(&recording_id)
                .map_err(|error| error.to_string())?;
            if let Some(operation) = operation {
                encrypt_recording_audio_operation(state, operation, &recording_key, None).await?;
            }
        }
        if !vault_initialized
            && !state
                .db
                .lock()
                .await
                .recording_audio_encryption_incomplete()
                .map_err(|error| error.to_string())?
        {
            let mut settings_manager = state.settings_manager.lock().await;
            settings_manager.settings_mut().privacy.vault_initialized = true;
            settings_manager.save().map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

#[cfg(any(feature = "sqlcipher", test))]
pub(crate) fn persist_and_verify_vault_db_key<SetSecret, GetSecret, ClearSecret>(
    db_key: &str,
    mut set_secret: SetSecret,
    mut get_secret: GetSecret,
    mut clear_secret: ClearSecret,
) -> Result<(), String>
where
    SetSecret: FnMut(&str) -> Result<(), String>,
    GetSecret: FnMut() -> Result<Option<String>, String>,
    ClearSecret: FnMut() -> Result<(), String>,
{
    set_secret(db_key)?;
    match get_secret() {
        Ok(Some(readback)) if readback == db_key => Ok(()),
        Ok(_) => {
            let cleanup = clear_secret();
            let suffix = cleanup
                .err()
                .map(|error| format!("; orphaned secret cleanup also failed: {error}"))
                .unwrap_or_default();
            Err(format!(
                "Secure database key did not verify after persistence{suffix}"
            ))
        }
        Err(error) => {
            let cleanup = clear_secret();
            let suffix = cleanup
                .err()
                .map(|cleanup_error| {
                    format!("; orphaned secret cleanup also failed: {cleanup_error}")
                })
                .unwrap_or_default();
            Err(format!(
                "Could not verify the persisted secure database key: {error}{suffix}"
            ))
        }
    }
}

#[cfg(any(feature = "sqlcipher", test))]
pub(crate) fn install_vault_database_key<SetSecret, GetSecret, ClearSecret, Rekey>(
    db_key: &str,
    set_secret: SetSecret,
    get_secret: GetSecret,
    mut clear_secret: ClearSecret,
    mut rekey: Rekey,
) -> Result<(), String>
where
    SetSecret: FnMut(&str) -> Result<(), String>,
    GetSecret: FnMut() -> Result<Option<String>, String>,
    ClearSecret: FnMut() -> Result<(), String>,
    Rekey: FnMut() -> Result<(), String>,
{
    persist_and_verify_vault_db_key(db_key, set_secret, get_secret, &mut clear_secret)?;
    if let Err(error) = rekey() {
        let cleanup = clear_secret();
        let suffix = cleanup
            .err()
            .map(|cleanup_error| format!("; orphaned secret cleanup also failed: {cleanup_error}"))
            .unwrap_or_default();
        return Err(format!(
            "Failed to encrypt the database after durably storing its key: {error}{suffix}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod vault_key_migration_tests {
    use super::{
        install_vault_database_key, persist_and_verify_vault_db_key, VaultStartupMigration,
    };
    use std::cell::RefCell;
    use std::rc::Rc;

    #[test]
    fn startup_repair_says_nothing_unless_something_happened() {
        assert_eq!(VaultStartupMigration::default().notice(), None);
    }

    #[test]
    fn a_completed_startup_repair_says_so_without_blaming_the_user() {
        let notice = VaultStartupMigration {
            encrypted_now: true,
            failure: None,
        }
        .notice()
        .expect("a repair that ran must be reported");
        assert!(
            notice.contains("finished encrypting its database"),
            "{notice}"
        );
        assert!(notice.contains("nothing was lost"), "{notice}");
    }

    /// The failure notice has to say the state (not encrypted), the cause, and
    /// what to do — and it must not imply the data is gone, because it is not.
    #[test]
    fn a_failed_startup_repair_states_the_state_cause_and_next_action() {
        let notice = VaultStartupMigration {
            encrypted_now: false,
            failure: Some("No space left on device.".to_string()),
        }
        .notice()
        .expect("a failed repair must be reported");
        assert!(notice.contains("still readable without your"), "{notice}");
        assert!(notice.contains("No space left on device."), "{notice}");
        assert!(notice.contains("Your meetings are unchanged."), "{notice}");
        assert!(notice.contains("Settings > Privacy"), "{notice}");
    }

    #[test]
    fn crash_after_verified_key_write_leaves_recoverable_key() {
        let durable = Rc::new(RefCell::new(None::<String>));
        let write_store = Rc::clone(&durable);
        let read_store = Rc::clone(&durable);

        // Stopping here models the old destructive window in reverse: no rekey
        // has happened yet, but the exact key needed to finish it is durable.
        persist_and_verify_vault_db_key(
            "durable-key",
            move |value| {
                *write_store.borrow_mut() = Some(value.to_string());
                Ok(())
            },
            move || Ok(read_store.borrow().clone()),
            || Ok(()),
        )
        .expect("persist and verify key");

        assert_eq!(durable.borrow().as_deref(), Some("durable-key"));
    }

    #[test]
    fn rekey_runs_only_after_verified_secret_readback() {
        let events = Rc::new(RefCell::new(Vec::<&'static str>::new()));
        let durable = Rc::new(RefCell::new(None::<String>));
        let set_events = Rc::clone(&events);
        let get_events = Rc::clone(&events);
        let rekey_events = Rc::clone(&events);
        let write_store = Rc::clone(&durable);
        let read_store = Rc::clone(&durable);

        install_vault_database_key(
            "durable-key",
            move |value| {
                set_events.borrow_mut().push("set");
                *write_store.borrow_mut() = Some(value.to_string());
                Ok(())
            },
            move || {
                get_events.borrow_mut().push("get");
                Ok(read_store.borrow().clone())
            },
            || Ok(()),
            move || {
                rekey_events.borrow_mut().push("rekey");
                Ok(())
            },
        )
        .expect("install key");

        assert_eq!(&*events.borrow(), &["set", "get", "rekey"]);
    }

    #[test]
    fn failed_rekey_removes_orphaned_secret() {
        let durable = Rc::new(RefCell::new(None::<String>));
        let write_store = Rc::clone(&durable);
        let read_store = Rc::clone(&durable);
        let clear_store = Rc::clone(&durable);

        let error = install_vault_database_key(
            "durable-key",
            move |value| {
                *write_store.borrow_mut() = Some(value.to_string());
                Ok(())
            },
            move || Ok(read_store.borrow().clone()),
            move || {
                *clear_store.borrow_mut() = None;
                Ok(())
            },
            || Err("simulated rekey failure".to_string()),
        )
        .expect_err("rekey failure must abort migration");

        assert!(error.contains("simulated rekey failure"));
        assert!(durable.borrow().is_none());
    }
}

pub(crate) async fn migrate_storage_encryption(
    state: &AppState,
    password: &str,
) -> Result<(), String> {
    let password = password.trim();
    if password.len() < 8 {
        return Err("Vault password must be at least 8 characters".to_string());
    }
    let _operation_lease = state
        .operation_coordinator
        .try_acquire(operation_coordinator::OperationKind::VaultMigration)?;
    let _storage_guard = state.audio_storage_gate.lock().await;

    let (already_initialized, existing_salt) = {
        let settings_manager = state.settings_manager.lock().await;
        (
            settings_manager.settings().privacy.vault_initialized,
            settings_manager.settings().privacy.vault_salt.clone(),
        )
    };

    let salt = if let Some(value) = existing_salt.as_deref() {
        crate::crypto::ProjectKeyManager::salt_from_string(value)
            .map_err(|e| format!("Invalid vault salt in settings: {}", e))?
    } else {
        let mut generated = [0u8; VAULT_RECORDING_KEY_SALT_LEN];
        rand::rng().fill_bytes(&mut generated);
        generated
    };

    let recording_key = crate::crypto::ProjectKeyManager::derive_key(password, &salt)
        .map_err(|e| format!("Failed to derive recording key: {}", e))?;

    // Persist the salt before any cross-filesystem migration step. A failed
    // operation remains retryable with the same password/key while the public
    // initialized bit stays false until every bundle is complete.
    if existing_salt.is_none() {
        let mut settings_manager = state.settings_manager.lock().await;
        settings_manager.settings_mut().privacy.vault_salt =
            Some(crate::crypto::ProjectKeyManager::salt_to_string(&salt));
        settings_manager.save().map_err(|error| error.to_string())?;
    }

    let existing_verifier =
        secrets::get_internal_secret(VAULT_UNLOCK_CHECK_SECRET).map_err(|e| e.to_string())?;
    if let Some(blob_hex) = existing_verifier.as_deref() {
        let blob = hex::decode(blob_hex).map_err(|e| format!("Invalid unlock verifier: {}", e))?;
        let plaintext = crate::crypto::ProjectKeyManager::decrypt(&blob, &recording_key)
            .map_err(|_| "Invalid vault password".to_string())?;
        if plaintext != VAULT_UNLOCK_CHECK_PLAINTEXT {
            return Err("Invalid vault password".to_string());
        }
    } else if already_initialized {
        return Err("Vault is initialized but unlock verifier is missing".to_string());
    }

    let existing_db_key =
        secrets::get_internal_secret(VAULT_DB_KEY_SECRET).map_err(|e| e.to_string())?;
    match existing_db_key.as_deref() {
        None => {
            let mut db_key_bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut db_key_bytes);
            let db_key = hex::encode(db_key_bytes);

            #[cfg(feature = "sqlcipher")]
            {
                // The irreversible encryption happens only after Keychain
                // persistence has been read back byte-for-byte. If it fails,
                // remove the orphaned key so the next startup still opens the
                // plaintext file.
                let mut db = state.db.lock().await;
                install_vault_database_key(
                    &db_key,
                    |value| {
                        secrets::set_internal_secret(VAULT_DB_KEY_SECRET, value)
                            .map_err(|error| error.to_string())
                    },
                    || {
                        secrets::get_internal_secret(VAULT_DB_KEY_SECRET)
                            .map_err(|error| error.to_string())
                    },
                    || {
                        secrets::clear_internal_secret(VAULT_DB_KEY_SECRET)
                            .map_err(|error| error.to_string())
                    },
                    || db.change_key(&db_key).map_err(|error| error.to_string()),
                )?;
            }
            #[cfg(not(feature = "sqlcipher"))]
            {
                let _ = &db_key;
                tracing::warn!(
                    "sqlcipher feature is disabled in this build; database encryption migration skipped"
                );
            }
        }
        Some(existing_key) => {
            let _ = existing_key;
            // A stored key is not proof the database is encrypted. Storing the
            // key and encrypting the file are two steps, and for every install
            // that turned the vault on before the `sqlcipher_export` fix the
            // second one silently did nothing. Startup repairs that; retrying
            // here means a user who reaches this screen after a failed repair
            // gets another attempt instead of a permanent no-op.
            #[cfg(feature = "sqlcipher")]
            {
                let mut db = state.db.lock().await;
                if !db.is_encrypted().map_err(|error| error.to_string())? {
                    db.change_key(existing_key).map_err(|error| {
                        format!(
                            "The database key is already stored, but encrypting the database failed: {error}"
                        )
                    })?;
                }
            }
        }
    }
    if existing_verifier.is_none() {
        let verifier =
            crate::crypto::ProjectKeyManager::encrypt(VAULT_UNLOCK_CHECK_PLAINTEXT, &recording_key)
                .map_err(|e| e.to_string())?;
        secrets::set_internal_secret(VAULT_UNLOCK_CHECK_SECRET, &hex::encode(verifier))
            .map_err(|e| e.to_string())?;
    }

    let roots = approved_path_roots()?;
    let recording_ids = {
        let mut db = state.db.lock().await;
        db.backfill_legacy_recording_audio(&roots)
            .map_err(|error| error.to_string())?;
        let mut recording_ids = db
            .list_open_recording_audio_operations()
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|operation| operation.recording_id)
            .collect::<HashSet<_>>();
        recording_ids.extend(
            db.recording_ids_with_ready_plaintext_audio()
                .map_err(|error| error.to_string())?,
        );
        recording_ids
    };

    for recording_id in recording_ids {
        let operation = {
            let mut db = state.db.lock().await;
            db.begin_recording_audio_encryption(&recording_id)
                .map_err(|error| error.to_string())?
        };
        if let Some(operation) = operation {
            encrypt_recording_audio_operation(state, operation, &recording_key, None).await?;
        }
    }

    let encryption_incomplete = state
        .db
        .lock()
        .await
        .recording_audio_encryption_incomplete()
        .map_err(|error| error.to_string())?;
    if encryption_incomplete {
        return Err(
            "Vault encryption remains incomplete; plaintext audio cleanup is journaled for retry"
                .to_string(),
        );
    }

    {
        let mut settings_manager = state.settings_manager.lock().await;
        let privacy = &mut settings_manager.settings_mut().privacy;
        privacy.vault_initialized = true;
        privacy.vault_salt = Some(crate::crypto::ProjectKeyManager::salt_to_string(&salt));
        settings_manager.save().map_err(|e| e.to_string())?;
    }

    let db_encrypted = {
        let db = state.db.lock().await;
        db.is_encrypted().map_err(|e| e.to_string())?
    };

    let mut vault_state = state.vault_state.lock().await;
    vault_state.unlocked = true;
    vault_state.db_encrypted = db_encrypted;
    if let Some(mut previous_key) = vault_state.recording_key.take() {
        use zeroize::Zeroize;
        previous_key.zeroize();
    }
    vault_state.recording_key = Some(recording_key);

    Ok(())
}

pub(crate) fn ensure_regular_file_in_roots(
    path: &Path,
    label: &str,
    approved_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        format!(
            "Failed to inspect {} '{}': {}",
            label,
            path.display(),
            error
        )
    })?;
    if !metadata.file_type().is_file() {
        return Err(format!(
            "{} is not a regular file: '{}'",
            label,
            path.display()
        ));
    }
    let canonical = path.canonicalize().map_err(|error| {
        format!(
            "Failed to resolve {} '{}': {}",
            label,
            path.display(),
            error
        )
    })?;
    let approved = approved_roots.iter().any(|root| {
        let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());
        canonical.starts_with(canonical_root)
    });
    if !approved {
        return Err(format!(
            "{} is outside approved roots: '{}'",
            label,
            path.display()
        ));
    }
    Ok(canonical)
}

/// A `Write` sink that hashes and counts without keeping anything.
///
/// Verification only ever needed the plaintext's length and digest, so buffering
/// a whole decrypted track to compute them was pure waste -- and on a long
/// meeting it was the difference between a few megabytes resident and a few
/// hundred.
pub(crate) struct PlaintextDigestSink {
    hasher: sha2::Sha256,
    bytes: u64,
}

impl PlaintextDigestSink {
    fn new() -> Self {
        use sha2::Digest as _;
        Self {
            hasher: sha2::Sha256::new(),
            bytes: 0,
        }
    }

    fn finish(self) -> (u64, String) {
        use sha2::Digest as _;
        (self.bytes, hex::encode(self.hasher.finalize()))
    }
}

impl std::io::Write for PlaintextDigestSink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        use sha2::Digest as _;
        self.hasher.update(buf);
        self.bytes += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Confirm an encrypted output decrypts back to exactly the journaled plaintext.
///
/// WAV validity is not re-checked here. The journaled SHA-256 was taken from a
/// payload this code already validated as a readable WAV, so a digest match is a
/// strictly stronger statement than re-parsing would be -- and it costs one
/// streaming pass instead of a full-file buffer.
pub(crate) fn verify_encrypted_recording_item(
    path: &Path,
    item: &recording_audio::RecordingAudioOperationItem,
    key: &[u8; 32],
    approved_roots: &[PathBuf],
) -> Result<(), String> {
    let canonical =
        ensure_regular_file_in_roots(path, "encrypted recording output", approved_roots)?;
    let file = std::fs::File::open(&canonical).map_err(|error| {
        format!(
            "Failed to read encrypted recording output '{}': {}",
            canonical.display(),
            error
        )
    })?;
    let mut reader = std::io::BufReader::new(file);
    let mut sink = PlaintextDigestSink::new();

    let mut magic = [0_u8; 8];
    let is_streaming = match std::io::Read::read_exact(&mut reader, &mut magic) {
        Ok(()) => crate::crypto::ProjectKeyManager::is_streaming_payload(&magic),
        // Too short to carry a magic; it cannot be a streaming payload.
        Err(_) => false,
    };
    // Rewind: both decoders expect the payload from byte zero.
    std::io::Seek::seek(&mut reader, std::io::SeekFrom::Start(0)).map_err(|error| {
        format!(
            "Failed to rewind encrypted recording output '{}': {}",
            canonical.display(),
            error
        )
    })?;

    if is_streaming {
        crate::crypto::ProjectKeyManager::decrypt_stream(&mut reader, &mut sink, key).map_err(
            |error| {
                format!(
                    "Failed to verify encrypted recording output '{}': {}",
                    canonical.display(),
                    error
                )
            },
        )?;
    } else {
        // Legacy whole-file payload. These predate the streaming format and are
        // read in full because that format has no frames to stream.
        let mut ciphertext = Vec::new();
        std::io::Read::read_to_end(&mut reader, &mut ciphertext).map_err(|error| {
            format!(
                "Failed to read encrypted recording output '{}': {}",
                canonical.display(),
                error
            )
        })?;
        let plaintext =
            crate::crypto::ProjectKeyManager::decrypt(&ciphertext, key).map_err(|error| {
                format!(
                    "Failed to verify encrypted recording output '{}': {}",
                    canonical.display(),
                    error
                )
            })?;
        std::io::Write::write_all(&mut sink, &plaintext).map_err(|error| error.to_string())?;
    }

    let (recovered_bytes, recovered_hash) = sink.finish();
    if recovered_bytes != item.plaintext_bytes {
        return Err(format!(
            "Encrypted output '{}' recovered {} bytes, expected {}",
            canonical.display(),
            recovered_bytes,
            item.plaintext_bytes
        ));
    }
    if recovered_hash != item.plaintext_sha256 {
        return Err(format!(
            "Encrypted output '{}' failed plaintext hash verification",
            canonical.display()
        ));
    }
    Ok(())
}

/// Encrypt one track from its source file into its staged output.
///
/// Streams: source bytes are hashed and encrypted a frame at a time, so peak
/// memory is one frame rather than the whole track. This used to read the entire
/// track into memory, encrypt it into a second full-size buffer, and write that
/// out -- around three times the track size resident at once, for up to three
/// tracks, on a long meeting.
///
/// `on_progress` receives plaintext bytes processed so far, for the UI.
pub(crate) fn stage_recording_audio_operation_item(
    item: &recording_audio::RecordingAudioOperationItem,
    key: &[u8; 32],
    approved_roots: &[PathBuf],
    mut on_progress: impl FnMut(u64),
) -> Result<(), String> {
    if item.staged_path.parent() != item.source_path.parent()
        || item.target_path.parent() != item.source_path.parent()
    {
        return Err(format!(
            "Recording '{}' '{}' encryption paths are not in the source directory",
            item.recording_id,
            item.role.as_str()
        ));
    }

    let canonical =
        ensure_regular_file_in_roots(&item.source_path, "recording audio source", approved_roots)?;

    // Validate the source as a readable WAV before encrypting it. The
    // path-based validator streams, so this stays O(1) in memory where the old
    // byte-slice check needed the whole file resident.
    match recording_audio::validate_plaintext_wav(&canonical) {
        recording_audio::RecordingAudioValidation::Ready(_) => {}
        recording_audio::RecordingAudioValidation::Missing(reason)
        | recording_audio::RecordingAudioValidation::Failed(reason) => {
            return Err(format!(
                "Recording audio source '{}' is not encryptable: {}",
                canonical.display(),
                reason
            ))
        }
    }

    if item.staged_path.exists() {
        match verify_encrypted_recording_item(&item.staged_path, item, key, approved_roots) {
            Ok(()) => return Ok(()),
            Err(error) => {
                std::fs::remove_file(&item.staged_path).map_err(|remove_error| {
                    format!(
                        "{}; failed to discard invalid staged output '{}': {}",
                        error,
                        item.staged_path.display(),
                        remove_error
                    )
                })?;
                recording_audio::sync_parent_directory(&item.staged_path)
                    .map_err(|sync_error| sync_error.to_string())?;
            }
        }
    }

    let source_file = std::fs::File::open(&canonical).map_err(|error| {
        format!(
            "Failed to read recording audio '{}' for encryption: {}",
            canonical.display(),
            error
        )
    })?;
    // Hash the source on the same pass that encrypts it, so "did this file
    // change after the operation was journaled?" costs no extra read.
    let mut hashing_source = HashingReader::new(std::io::BufReader::new(source_file));

    let staged_file =
        recording_audio::create_new_file(&item.staged_path).map_err(|error| error.to_string())?;
    let staged_guard = recording_audio::DurableTempFile::new(item.staged_path.clone());
    let mut staged_writer = std::io::BufWriter::new(staged_file);

    crate::crypto::ProjectKeyManager::encrypt_stream(
        &mut hashing_source,
        &mut staged_writer,
        key,
        &mut on_progress,
    )
    .map_err(|error| {
        format!(
            "Failed to encrypt recording audio '{}': {}",
            canonical.display(),
            error
        )
    })?;

    let staged_file = staged_writer.into_inner().map_err(|error| {
        format!(
            "Failed to flush staged encrypted audio '{}': {}",
            item.staged_path.display(),
            error
        )
    })?;
    staged_file.sync_all().map_err(|error| {
        format!(
            "Failed to sync staged encrypted audio '{}': {}",
            item.staged_path.display(),
            error
        )
    })?;
    drop(staged_file);

    let (source_bytes, source_hash) = hashing_source.finish();
    if source_bytes != item.plaintext_bytes || source_hash != item.plaintext_sha256 {
        // The staged output is of a file we no longer recognise. The temp guard
        // is still armed, so it is removed when this returns.
        return Err(format!(
            "Recording audio '{}' changed after encryption was journaled",
            canonical.display()
        ));
    }

    verify_encrypted_recording_item(&item.staged_path, item, key, approved_roots)?;
    let _ = staged_guard.disarm();
    Ok(())
}

/// A `Read` adapter that digests and counts everything it passes through.
pub(crate) struct HashingReader<R> {
    inner: R,
    hasher: sha2::Sha256,
    bytes: u64,
}

impl<R: std::io::Read> HashingReader<R> {
    fn new(inner: R) -> Self {
        use sha2::Digest as _;
        Self {
            inner,
            hasher: sha2::Sha256::new(),
            bytes: 0,
        }
    }

    fn finish(self) -> (u64, String) {
        use sha2::Digest as _;
        (self.bytes, hex::encode(self.hasher.finalize()))
    }
}

impl<R: std::io::Read> std::io::Read for HashingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        use sha2::Digest as _;
        let read = self.inner.read(buf)?;
        self.hasher.update(&buf[..read]);
        self.bytes += read as u64;
        Ok(read)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecordingAudioEncryptionCheckpoint {
    Prepared,
    Staged,
    Published,
    Switched,
    CleanupPending,
}

pub(crate) fn stop_after_encryption_checkpoint(
    stop_after: Option<RecordingAudioEncryptionCheckpoint>,
    checkpoint: RecordingAudioEncryptionCheckpoint,
) -> Result<(), String> {
    if stop_after == Some(checkpoint) {
        return Err(format!("injected crash after {:?}", checkpoint));
    }
    Ok(())
}

pub(crate) fn publish_recording_audio_operation_item(
    item: &recording_audio::RecordingAudioOperationItem,
    key: &[u8; 32],
    approved_roots: &[PathBuf],
) -> Result<(), String> {
    if item.target_path.exists() {
        verify_encrypted_recording_item(&item.target_path, item, key, approved_roots)?;
    } else {
        match std::fs::hard_link(&item.staged_path, &item.target_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                verify_encrypted_recording_item(&item.target_path, item, key, approved_roots)?;
            }
            Err(error) => {
                return Err(format!(
                    "Failed to publish encrypted recording audio '{}': {}",
                    item.target_path.display(),
                    error
                ))
            }
        }
        verify_encrypted_recording_item(&item.target_path, item, key, approved_roots)?;
    }

    recording_audio::sync_parent_directory(&item.target_path).map_err(|error| error.to_string())?;
    match std::fs::remove_file(&item.staged_path) {
        Ok(()) => recording_audio::sync_parent_directory(&item.staged_path)
            .map_err(|error| error.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to remove published staging link '{}': {}",
                item.staged_path.display(),
                error
            ))
        }
    }
    Ok(())
}

pub(crate) fn cleanup_recording_audio_operation_source(
    item: &recording_audio::RecordingAudioOperationItem,
    approved_roots: &[PathBuf],
) -> Result<(), String> {
    let metadata = match std::fs::symlink_metadata(&item.source_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            recording_audio::sync_parent_directory(&item.source_path)
                .map_err(|sync_error| sync_error.to_string())?;
            return Ok(());
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect plaintext recording audio '{}': {}",
                item.source_path.display(),
                error
            ))
        }
    };
    if !metadata.file_type().is_file() {
        return Err(format!(
            "Plaintext recording audio source is not a regular file: '{}'",
            item.source_path.display()
        ));
    }
    let canonical = ensure_regular_file_in_roots(
        &item.source_path,
        "plaintext recording audio",
        approved_roots,
    )?;
    let plaintext = std::fs::read(&canonical).map_err(|error| {
        format!(
            "Failed to read plaintext recording audio '{}': {}",
            canonical.display(),
            error
        )
    })?;
    use sha2::{Digest as _, Sha256};
    if plaintext.len() as u64 != item.plaintext_bytes
        || hex::encode(Sha256::digest(&plaintext)) != item.plaintext_sha256
    {
        return Err(format!(
            "Refusing to delete changed plaintext recording audio '{}'",
            canonical.display()
        ));
    }
    std::fs::remove_file(&canonical).map_err(|error| {
        format!(
            "Failed to remove plaintext recording audio '{}': {}",
            canonical.display(),
            error
        )
    })?;
    recording_audio::sync_parent_directory(&canonical).map_err(|error| error.to_string())
}

pub(crate) fn cleanup_recording_audio_operation_sources(
    db: &mut db::Database,
    operation: &recording_audio::RecordingAudioOperation,
    approved_roots: &[PathBuf],
    stop_after: Option<RecordingAudioEncryptionCheckpoint>,
) -> Result<(), String> {
    db.mark_recording_audio_cleanup_pending(&operation.id)
        .map_err(|error| error.to_string())?;
    stop_after_encryption_checkpoint(
        stop_after,
        RecordingAudioEncryptionCheckpoint::CleanupPending,
    )?;

    let mut cleaned_roles = Vec::new();
    let mut failures = Vec::new();
    for item in &operation.items {
        if item.state == "cleaned" {
            continue;
        }
        match cleanup_recording_audio_operation_source(item, approved_roots) {
            Ok(()) => cleaned_roles.push(item.role),
            Err(error) => failures.push((item.role, error)),
        }
    }
    db.complete_recording_audio_encryption_cleanup(&operation.id, &cleaned_roles, &failures)
        .map_err(|error| error.to_string())?;
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Encrypted recording bundle was published, but plaintext cleanup remains journaled for retry: {}",
            failures
                .iter()
                .map(|(_, error)| error.as_str())
                .collect::<Vec<_>>()
                .join("; ")
        ))
    }
}

/// Headroom kept free beyond the ciphertext itself, in seconds of recording.
///
/// Encryption writes a whole second copy of every track before the plaintext can
/// be removed, and the finalize path that calls it runs with roughly a minute of
/// recording headroom. Filling the volume to the last byte here would leave no
/// room for the journal writes that make the operation recoverable.
///
/// Expressed in seconds rather than a flat byte count so it goes through
/// `audio::meeting_headroom_bytes` and scales with the number of tracks this
/// bundle actually holds -- the same per-track sizing the capture-side space
/// thresholds use. A mic-only meeting is not charged the three-track price.
pub(crate) const RECORDING_ENCRYPTION_MARGIN_SECONDS: u64 = 60;

/// Journal state for an operation deferred because the disk was too full.
pub(crate) const RECORDING_ENCRYPTION_SPACE_PENDING: &str = "space_pending";

pub(crate) fn emit_recording_encryption_status(
    handle: Option<&crate::sidecar_handle::SidecarHandle>,
    recording_id: &str,
    phase: &str,
    processed_bytes: u64,
    total_bytes: u64,
    message: Option<&str>,
) {
    let Some(handle) = handle else {
        return;
    };
    handle.emit_event(
        "recording-audio-encryption-status",
        serde_json::json!({
            "recordingId": recording_id,
            "phase": phase,
            "processedBytes": processed_bytes,
            "totalBytes": total_bytes,
            "message": message,
        }),
    );
}

/// Free space on the volume holding `path`, or `None` if it cannot be measured.
///
/// Unmeasurable means "do not block the user": a platform without the syscall
/// must not make encryption impossible, only unpreflighted.
pub(crate) fn available_space_for_encryption(path: &Path) -> Option<u64> {
    let directory = path.parent()?;
    crate::download::available_space_for_path(directory).ok()
}

/// Encrypt a just-finalized recording's audio bundle into the vault, when the
/// vault is on. A no-op when it is off, or when the bundle is already covered.
///
/// Lifted out of the meeting stop path because two other routes land the same
/// kind of owned audio asset and neither encrypted it: "Import audio..." wrote
/// the converted WAV into the recordings folder and spawned the pipeline, and a
/// kept dictation WAV went in with `protection 'plaintext'` and stayed that
/// way. Both are read back by the same playback, export, retention and
/// migration code as a stopped meeting's audio, so leaving them in the clear
/// left plaintext audio under a vault the UI says is on, and held
/// `get_security_status` at "not every recording is encrypted" forever.
///
/// A locked vault is an error rather than a silent skip: the file is already on
/// disk by the time this runs, so saying nothing would be the quiet failure.
pub(crate) async fn encrypt_finalized_recording_audio(
    state: &AppState,
    handle: Option<&crate::sidecar_handle::SidecarHandle>,
    recording_id: &str,
) -> Result<(), String> {
    let vault_initialized = state
        .settings_manager
        .lock()
        .await
        .settings()
        .privacy
        .vault_initialized;
    if !vault_initialized {
        return Ok(());
    }
    let key = {
        let vault_state = state.vault_state.lock().await;
        if !vault_state.unlocked {
            return Err(
                "Vault locked before the finalized recording bundle could be encrypted".to_string(),
            );
        }
        vault_state.recording_key.ok_or_else(|| {
            "Vault key became unavailable before recording encryption was journaled".to_string()
        })?
    };
    let operation = state
        .db
        .lock()
        .await
        .begin_recording_audio_encryption(recording_id)
        .map_err(|error| error.to_string())?;
    // No operation means there was nothing plaintext left to encrypt.
    let Some(operation) = operation else {
        return Ok(());
    };
    if let Err(error) = encrypt_recording_audio_operation(state, operation, &key, handle).await {
        let mut db = state.db.lock().await;
        let _ = db.update_recording_status(recording_id, "error");
        let _ = db.log_audit_event(
            "recording_audio_encryption_pending",
            Some(serde_json::json!({
                "recording_id": recording_id,
                "error": &error,
            })),
            "warning",
        );
        drop(db);
        return Err(error);
    }
    Ok(())
}

/// Encrypt a recording's audio bundle into the vault.
///
/// Runs the file work on the blocking pool and takes the database lock only for
/// the short journal updates between phases. It previously did all of it inline
/// on the async runtime while holding that lock for the entire operation, so
/// encrypting a long meeting stalled every other database user -- and the whole
/// app with it.
pub(crate) async fn encrypt_recording_audio_operation(
    state: &AppState,
    operation: recording_audio::RecordingAudioOperation,
    key: &[u8; 32],
    handle: Option<&crate::sidecar_handle::SidecarHandle>,
) -> Result<(), String> {
    encrypt_recording_audio_operation_with_checkpoint(state, operation, key, handle, None).await
}

/// `stop_after` injects a simulated crash after a named checkpoint, so the
/// journal's recovery path can be exercised without actually killing the
/// process. Production always passes `None`.
pub(crate) async fn encrypt_recording_audio_operation_with_checkpoint(
    state: &AppState,
    operation: recording_audio::RecordingAudioOperation,
    key: &[u8; 32],
    handle: Option<&crate::sidecar_handle::SidecarHandle>,
    stop_after: Option<RecordingAudioEncryptionCheckpoint>,
) -> Result<(), String> {
    let approved_roots = approved_path_roots()?;
    let recording_id = operation.recording_id.clone();

    // Resume path: the switch already happened, so only source cleanup remains.
    if matches!(operation.state.as_str(), "db_switched" | "cleanup_pending") {
        let mut db = state.db.lock().await;
        return cleanup_recording_audio_operation_sources(
            &mut db,
            &operation,
            &approved_roots,
            stop_after,
        );
    }

    let pending: Vec<_> = operation
        .items
        .iter()
        .filter(|item| !item.target_path.exists())
        .cloned()
        .collect();
    let total_plaintext_bytes: u64 = pending.iter().map(|item| item.plaintext_bytes).sum();

    // Space preflight. Encryption writes a full second copy of every track, and
    // nothing checked for room before starting -- so on the ~1-minute-headroom
    // stop path the encryption step itself could run the disk out and fail the
    // finalize. Defer instead: the recording stays intact and plaintext, and the
    // journal records that it is waiting on free space.
    if let Some(first) = pending.first() {
        let required: u64 = pending
            .iter()
            .map(|item| {
                crate::crypto::ProjectKeyManager::streaming_ciphertext_len(item.plaintext_bytes)
            })
            .sum::<u64>()
            .saturating_add(crate::audio::meeting_headroom_bytes(
                pending.len() as u64,
                RECORDING_ENCRYPTION_MARGIN_SECONDS,
            ));
        let staged_path = first.staged_path.clone();
        let available =
            tokio::task::spawn_blocking(move || available_space_for_encryption(&staged_path))
                .await
                .map_err(|error| format!("Free-space check did not complete: {error}"))?;

        if let Some(available) = available {
            if available < required {
                let message = format!(
                    "Not enough free space to secure this recording: {} MB needed, {} MB available. Free some space and Plainsong will finish securing it.",
                    required / (1024 * 1024),
                    available / (1024 * 1024)
                );
                {
                    let mut db = state.db.lock().await;
                    db.set_recording_audio_operation_state(
                        &operation.id,
                        RECORDING_ENCRYPTION_SPACE_PENDING,
                        Some(&message),
                    )
                    .map_err(|error| error.to_string())?;
                }
                emit_recording_encryption_status(
                    handle,
                    &recording_id,
                    "deferred",
                    0,
                    total_plaintext_bytes,
                    Some(&message),
                );
                tracing::warn!(
                    recording_id = %recording_id,
                    required_bytes = required,
                    available_bytes = available,
                    "Deferring recording encryption until there is free space"
                );
                // Deferred, not failed: the finalize must still succeed.
                return Ok(());
            }
        }
    }

    emit_recording_encryption_status(
        handle,
        &recording_id,
        "securing",
        0,
        total_plaintext_bytes,
        None,
    );

    let result = run_recording_encryption_phases(
        state,
        &operation,
        key,
        &approved_roots,
        handle,
        total_plaintext_bytes,
        stop_after,
    )
    .await;

    match result {
        Ok(()) => {
            emit_recording_encryption_status(
                handle,
                &recording_id,
                "completed",
                total_plaintext_bytes,
                total_plaintext_bytes,
                None,
            );
            Ok(())
        }
        Err(error) => {
            if !error.starts_with("injected crash after") {
                let mut db = state.db.lock().await;
                let _ =
                    db.set_recording_audio_operation_state(&operation.id, "failed", Some(&error));
            }
            emit_recording_encryption_status(
                handle,
                &recording_id,
                "failed",
                0,
                total_plaintext_bytes,
                Some(&error),
            );
            Err(error)
        }
    }
}

/// Stage, publish, switch, clean up -- each file phase on the blocking pool,
/// each journal update under a lock held only for that write.
pub(crate) async fn run_recording_encryption_phases(
    state: &AppState,
    operation: &recording_audio::RecordingAudioOperation,
    key: &[u8; 32],
    approved_roots: &[PathBuf],
    handle: Option<&crate::sidecar_handle::SidecarHandle>,
    total_plaintext_bytes: u64,
    stop_after: Option<RecordingAudioEncryptionCheckpoint>,
) -> Result<(), String> {
    stop_after_encryption_checkpoint(stop_after, RecordingAudioEncryptionCheckpoint::Prepared)?;
    let mut processed_bytes = 0_u64;

    for item in &operation.items {
        let item_for_task = item.clone();
        let roots = approved_roots.to_vec();
        let task_key = *key;
        let already_published = item.target_path.exists();
        let item_bytes = item.plaintext_bytes;

        // Progress leaves the blocking thread through a channel: the handle is
        // borrowed and cannot cross into the task, and draining here keeps the
        // events ordered with the phase transitions below.
        let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel::<u64>();
        let staging = tokio::task::spawn_blocking(move || {
            if already_published {
                verify_encrypted_recording_item(
                    &item_for_task.target_path,
                    &item_for_task,
                    &task_key,
                    &roots,
                )
            } else {
                stage_recording_audio_operation_item(&item_for_task, &task_key, &roots, |bytes| {
                    let _ = progress_tx.send(bytes);
                })
            }
        });

        let base = processed_bytes;
        while let Some(bytes) = progress_rx.recv().await {
            emit_recording_encryption_status(
                handle,
                &operation.recording_id,
                "securing",
                base.saturating_add(bytes),
                total_plaintext_bytes,
                None,
            );
        }

        staging
            .await
            .map_err(|error| format!("Recording encryption task did not complete: {error}"))??;
        processed_bytes = processed_bytes.saturating_add(item_bytes);

        let mut db = state.db.lock().await;
        db.set_recording_audio_operation_item_state(&operation.id, item.role, "staged", None)
            .map_err(|error| error.to_string())?;
    }

    {
        let mut db = state.db.lock().await;
        db.set_recording_audio_operation_state(&operation.id, "outputs_synced", None)
            .map_err(|error| error.to_string())?;
    }
    stop_after_encryption_checkpoint(stop_after, RecordingAudioEncryptionCheckpoint::Staged)?;

    for item in &operation.items {
        let item_for_task = item.clone();
        let roots = approved_roots.to_vec();
        let task_key = *key;
        tokio::task::spawn_blocking(move || {
            publish_recording_audio_operation_item(&item_for_task, &task_key, &roots)
        })
        .await
        .map_err(|error| format!("Recording publication task did not complete: {error}"))??;

        let mut db = state.db.lock().await;
        db.set_recording_audio_operation_item_state(&operation.id, item.role, "published", None)
            .map_err(|error| error.to_string())?;
    }

    {
        let mut db = state.db.lock().await;
        db.set_recording_audio_operation_state(&operation.id, "published", None)
            .map_err(|error| error.to_string())?;
    }
    stop_after_encryption_checkpoint(stop_after, RecordingAudioEncryptionCheckpoint::Published)?;
    {
        let mut db = state.db.lock().await;
        db.switch_recording_audio_encryption(operation)
            .map_err(|error| error.to_string())?;
    }
    stop_after_encryption_checkpoint(stop_after, RecordingAudioEncryptionCheckpoint::Switched)?;

    let refreshed = {
        let db = state.db.lock().await;
        db.load_open_recording_audio_operation(&operation.recording_id)
            .map_err(|error| error.to_string())?
    };
    let Some(refreshed) = refreshed else {
        return Err(format!(
            "Recording audio operation disappeared for '{}'",
            operation.recording_id
        ));
    };

    let mut db = state.db.lock().await;
    cleanup_recording_audio_operation_sources(&mut db, &refreshed, approved_roots, stop_after)
}

pub(crate) fn ensure_runtime_directory(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "Refusing to use runtime decrypted-audio directory component '{}' because it is a symlink",
            path.display()
        )),
        Ok(metadata) if !metadata.is_dir() => Err(format!(
            "Runtime decrypted-audio path component is not a directory: '{}'",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(path).map_err(|create_error| {
                format!(
                    "Failed to create runtime decrypted-audio directory '{}': {}",
                    path.display(),
                    create_error
                )
            })?;
            recording_audio::sync_parent_directory(path).map_err(|error| error.to_string())
        }
        Err(error) => Err(format!(
            "Failed to inspect runtime decrypted-audio directory '{}': {}",
            path.display(),
            error
        )),
    }
}

pub(crate) fn prepare_decrypted_recording_audio_directory() -> Result<PathBuf, String> {
    let root = nautilus_data_root()?;
    let runtime_dir = root.join("runtime");
    let decrypted_dir = runtime_dir.join("decrypted-audio");
    ensure_runtime_directory(&runtime_dir)?;
    ensure_runtime_directory(&decrypted_dir)?;
    let canonical = decrypted_dir.canonicalize().map_err(|error| {
        format!(
            "Failed to resolve runtime decrypted-audio directory '{}': {}",
            decrypted_dir.display(),
            error
        )
    })?;
    if canonical != decrypted_dir {
        return Err(format!(
            "Runtime decrypted-audio directory '{}' does not resolve to the exact app-owned path",
            decrypted_dir.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&canonical, std::fs::Permissions::from_mode(0o700)).map_err(
            |error| {
                format!(
                    "Failed to secure runtime decrypted-audio directory '{}': {}",
                    canonical.display(),
                    error
                )
            },
        )?;
    }
    Ok(canonical)
}

pub(crate) fn validate_runtime_recording_audio_metadata(
    asset: &recording_audio::RecordingAudioAsset,
    metadata: &recording_audio::ValidatedRecordingAudio,
) -> Result<(), String> {
    if asset
        .plaintext_bytes
        .is_some_and(|expected| expected != metadata.plaintext_bytes)
    {
        return Err(format!(
            "Recording '{}' '{}' audio plaintext length does not match stored metadata",
            asset.recording_id,
            asset.role.as_str()
        ));
    }
    if asset
        .plaintext_sha256
        .as_deref()
        .is_some_and(|expected| expected != metadata.plaintext_sha256)
    {
        return Err(format!(
            "Recording '{}' '{}' audio plaintext hash does not match stored metadata",
            asset.recording_id,
            asset.role.as_str()
        ));
    }
    Ok(())
}

/// What a runtime resolve has to produce, and how hard it has to look.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuntimeAudioResolveMode {
    /// Post-processing, diarization and export: every ready track, each one
    /// re-decoded and re-hashed against what the database recorded.
    Full,
    /// Playback: the primary mix alone. A temporary this process just
    /// decrypted from an authenticated stream is checked by header, length,
    /// and hash, but is not decoded sample by sample.
    ///
    /// Serving only the primary is not a shortcut — `prepare_recording_playback`
    /// never used any other track. Resolving all three on a dual-track meeting
    /// meant three decryptions and three full-length plaintext files on disk to
    /// play one of them.
    PlaybackPrimary,
}

impl RuntimeAudioResolveMode {
    fn wants(self, role: recording_audio::RecordingAudioRole) -> bool {
        match self {
            Self::Full => true,
            Self::PlaybackPrimary => role == recording_audio::RecordingAudioRole::Primary,
        }
    }
}

pub(crate) fn resolve_recording_audio_bundle_in_directory(
    bundle: &recording_audio::RecordingAudioBundle,
    key: Option<&[u8; 32]>,
    runtime_dir: &Path,
    approved_roots: &[PathBuf],
    mode: RuntimeAudioResolveMode,
) -> Result<recording_audio::ResolvedRecordingAudioBundle, String> {
    let primary_asset = bundle.primary.as_ref().ok_or_else(|| {
        format!(
            "Recording '{}' has no primary audio asset",
            bundle.recording_id
        )
    })?;
    if primary_asset.lifecycle != recording_audio::RecordingAudioLifecycle::Ready {
        return Err(format!(
            "Recording '{}' primary audio is not ready",
            bundle.recording_id
        ));
    }

    let mut temporary_files = Vec::new();
    let mut primary = None;
    let mut mic = None;
    let mut system = None;
    for asset in bundle.assets() {
        if !mode.wants(asset.role) {
            continue;
        }
        if asset.lifecycle != recording_audio::RecordingAudioLifecycle::Ready {
            return Err(format!(
                "Recording '{}' '{}' audio is not ready",
                bundle.recording_id,
                asset.role.as_str()
            ));
        }
        let canonical = ensure_regular_file_in_roots(
            &asset.path,
            &format!(
                "recording '{}' {} audio",
                bundle.recording_id,
                asset.role.as_str()
            ),
            approved_roots,
        )?;
        let runtime_path = match asset.protection {
            recording_audio::RecordingAudioProtection::Plaintext => {
                let metadata = match recording_audio::validate_plaintext_wav(&canonical) {
                    recording_audio::RecordingAudioValidation::Ready(metadata) => metadata,
                    recording_audio::RecordingAudioValidation::Missing(error)
                    | recording_audio::RecordingAudioValidation::Failed(error) => {
                        return Err(format!(
                            "Recording '{}' '{}' audio is invalid: {}",
                            bundle.recording_id,
                            asset.role.as_str(),
                            error
                        ))
                    }
                };
                validate_runtime_recording_audio_metadata(asset, &metadata)?;
                canonical
            }
            recording_audio::RecordingAudioProtection::Encrypted => {
                let key = key.ok_or_else(|| {
                    "Vault is locked. Unlock vault before opening encrypted recordings.".to_string()
                })?;
                let temp_path = runtime_dir.join(format!(
                    "{}-{}.wav",
                    uuid::Uuid::new_v4(),
                    asset.role.as_str()
                ));
                // Streams PSVAULT1 frames straight into the owner-only temp
                // file (a legacy whole-file payload is read whole, the only
                // way that layout can be read), so a long meeting is never held
                // in memory as ciphertext and plaintext at once. Before this
                // the runtime path used the legacy decoder for every file and
                // could not open a recording encrypted by the streaming writer.
                playback::decrypt_vault_file_to_path(&canonical, &temp_path, key).map_err(
                    |error| {
                        format!(
                            "Failed to decrypt recording '{}' '{}' audio. Verify the vault password and retry. ({})",
                            bundle.recording_id,
                            asset.role.as_str(),
                            error
                        )
                    },
                )?;
                let temp_guard = recording_audio::DurableTempFile::new(temp_path.clone());
                match mode {
                    RuntimeAudioResolveMode::Full => {
                        let metadata = match recording_audio::validate_plaintext_wav(&temp_path) {
                            recording_audio::RecordingAudioValidation::Ready(metadata) => metadata,
                            recording_audio::RecordingAudioValidation::Missing(error)
                            | recording_audio::RecordingAudioValidation::Failed(error) => {
                                return Err(format!(
                                    "Decrypted recording '{}' '{}' audio is invalid: {}",
                                    bundle.recording_id,
                                    asset.role.as_str(),
                                    error
                                ))
                            }
                        };
                        validate_runtime_recording_audio_metadata(asset, &metadata)?;
                    }
                    RuntimeAudioResolveMode::PlaybackPrimary => {
                        let plaintext_bytes = recording_audio::measure_plaintext_wav_header(
                            &temp_path,
                        )
                        .map_err(|error| {
                            format!(
                                "Decrypted recording '{}' '{}' audio is invalid: {}",
                                bundle.recording_id,
                                asset.role.as_str(),
                                error
                            )
                        })?;
                        if asset
                            .plaintext_bytes
                            .is_some_and(|expected| expected != plaintext_bytes)
                        {
                            return Err(format!(
                                "Recording '{}' '{}' audio plaintext length does not match stored metadata",
                                bundle.recording_id,
                                asset.role.as_str()
                            ));
                        }
                        let plaintext_sha256 = recording_audio::compute_file_sha256(&temp_path)
                            .map_err(|error| {
                                format!(
                                    "Could not hash decrypted recording '{}' '{}' audio: {}",
                                    bundle.recording_id,
                                    asset.role.as_str(),
                                    error
                                )
                            })?;
                        if asset
                            .plaintext_sha256
                            .as_deref()
                            .is_some_and(|expected| expected != plaintext_sha256)
                        {
                            return Err(format!(
                                "Recording '{}' '{}' audio plaintext hash does not match stored metadata",
                                bundle.recording_id,
                                asset.role.as_str()
                            ));
                        }
                    }
                }
                temporary_files.push(temp_guard);
                temp_path
            }
        };
        match asset.role {
            recording_audio::RecordingAudioRole::Primary => primary = Some(runtime_path),
            recording_audio::RecordingAudioRole::Mic => mic = Some(runtime_path),
            recording_audio::RecordingAudioRole::System => system = Some(runtime_path),
        }
    }

    Ok(recording_audio::ResolvedRecordingAudioBundle::new(
        primary
            .ok_or_else(|| format!("Recording '{}' has no primary audio", bundle.recording_id))?,
        mic,
        system,
        temporary_files,
    ))
}

pub(crate) async fn resolve_recording_audio_bundle_for_runtime(
    state: &AppState,
    recording_id: &str,
) -> Result<recording_audio::ResolvedRecordingAudioBundle, String> {
    resolve_recording_audio_for_runtime(state, recording_id, RuntimeAudioResolveMode::Full).await
}

pub(crate) async fn resolve_recording_audio_for_runtime(
    state: &AppState,
    recording_id: &str,
    mode: RuntimeAudioResolveMode,
) -> Result<recording_audio::ResolvedRecordingAudioBundle, String> {
    let bundle = {
        let db = state.db.lock().await;
        db.load_recording_audio_bundle(recording_id)
            .map_err(|error| error.to_string())?
    };
    let has_encrypted = bundle
        .assets()
        .filter(|asset| mode.wants(asset.role))
        .any(|asset| asset.protection == recording_audio::RecordingAudioProtection::Encrypted);
    let key = if has_encrypted {
        let vault_state = state.vault_state.lock().await;
        if !vault_state.unlocked {
            return Err(
                "Vault is locked. Unlock vault before opening encrypted recordings.".to_string(),
            );
        }
        Some(vault_state.recording_key.ok_or_else(|| {
            "Vault is unlocked but no runtime recording key is available".to_string()
        })?)
    } else {
        None
    };
    let runtime_dir = prepare_decrypted_recording_audio_directory()?;
    let approved_roots = approved_path_roots()?;
    // Streaming decrypt and WAV validation are both blocking file work that
    // runs for tens of seconds on a long meeting. On a tokio worker that
    // stalled every other task sharing the thread — transcription progress,
    // the next command — for as long as it took.
    tokio::task::spawn_blocking(move || {
        resolve_recording_audio_bundle_in_directory(
            &bundle,
            key.as_ref(),
            &runtime_dir,
            &approved_roots,
            mode,
        )
    })
    .await
    .map_err(|error| format!("Preparing recording audio did not finish: {error}"))?
}

pub(crate) fn schedule_recording_audio_bundle_cleanup(
    bundle: recording_audio::ResolvedRecordingAudioBundle,
    delay: Duration,
    mut runtime_audio_lease: operation_coordinator::OperationLease,
) {
    tokio::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = runtime_audio_lease.cancelled() => {}
        }
        drop(bundle);
        drop(runtime_audio_lease);
    });
}

/// What `prepare_recording_playback` answers. The privileged Electron process
/// keeps `path` for itself and hands the renderer only the token: the renderer
/// never learns where audio lives on disk.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedRecordingPlayback {
    token: String,
    recording_id: String,
    path: String,
    protection: playback::PlaybackProtection,
    duration_seconds: i64,
}

pub(crate) async fn prepare_recording_playback_impl(
    state: &Arc<AppState>,
    handle: &sidecar_handle::SidecarHandle,
    recording_id: &str,
) -> Result<PreparedRecordingPlayback, String> {
    let recording = {
        let db = state.db.lock().await;
        db.get_recording(recording_id)
            .map_err(|e| e.to_string())?
            .ok_or("Recording not found")?
    };
    if recording.audio_path.trim().is_empty() {
        return Err("Recording has no audio file path".to_string());
    }

    // Held for as long as the token lives: a vault lock revokes it (and with
    // it the decrypted temp), and a restore or vault migration cannot start
    // underneath an open player.
    let lease = state
        .operation_coordinator
        .try_acquire(operation_coordinator::OperationKind::RuntimeAudio)?;
    // A meeting that is already open is served from the plaintext already on
    // disk. Without this, every prepare decrypted the whole file again and
    // pinned another full-length copy until the vault locked: twenty opens of
    // a two-hour meeting left roughly fourteen gigabytes of plaintext behind.
    let (resolved, reused) = match state.playback_registry.live_audio(recording_id) {
        Some(shared) => (shared, true),
        None => {
            state.playback_registry.admit(recording_id)?;
            let bundle = resolve_recording_audio_for_runtime(
                state,
                recording_id,
                RuntimeAudioResolveMode::PlaybackPrimary,
            )
            .await?;
            (Arc::new(bundle), false)
        }
    };
    let protection = if resolved.holds_temporary_files() {
        playback::PlaybackProtection::Decrypted
    } else {
        playback::PlaybackProtection::Plaintext
    };
    let path = resolved.primary.clone();

    let token = playback::PlaybackRegistry::new_token();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    state.playback_registry.register(
        token.clone(),
        recording_id.to_string(),
        Arc::clone(&resolved),
        protection,
        release_tx,
    );
    spawn_playback_holder(
        Arc::clone(&state.playback_registry),
        handle.clone(),
        token.clone(),
        recording_id.to_string(),
        resolved,
        lease,
        release_rx,
    );

    let mut db = state.db.lock().await;
    let details = serde_json::json!({
        "recording_id": recording_id,
        "protection": protection.as_str(),
        "reused_decrypted_audio": reused,
    });
    if let Err(e) = db.log_audit_event("recording_playback_prepared", Some(details), "info") {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    Ok(PreparedRecordingPlayback {
        token,
        recording_id: recording_id.to_string(),
        path: path.to_string_lossy().to_string(),
        protection,
        duration_seconds: recording.duration,
    })
}

/// Owns one token's share of the decrypted audio and its coordinator lease.
/// Ends on release (the reader moved on) or on revoke (the vault locked).
/// The temp-file guard sits behind the `Arc` every token for this recording
/// shares, so the plaintext is deleted when the last of them lets go.
pub(crate) fn spawn_playback_holder(
    registry: Arc<playback::PlaybackRegistry>,
    handle: sidecar_handle::SidecarHandle,
    token: String,
    recording_id: String,
    bundle: Arc<recording_audio::ResolvedRecordingAudioBundle>,
    mut lease: operation_coordinator::OperationLease,
    release_rx: tokio::sync::oneshot::Receiver<()>,
) {
    tokio::spawn(async move {
        let revoked = tokio::select! {
            _ = release_rx => false,
            _ = lease.cancelled() => true,
        };
        drop(bundle);
        drop(lease);
        if revoked {
            registry.forget(&token);
            handle.emit(
                "recording-playback-revoked",
                serde_json::json!({
                    "token": token,
                    "recordingId": recording_id,
                    "reason": "vault_locked",
                }),
            );
        }
    });
}

pub(crate) async fn release_recording_playback_impl(
    state: &AppState,
    token: &str,
) -> Result<bool, String> {
    let Some(released) = state.playback_registry.release(token) else {
        return Ok(false);
    };
    let mut db = state.db.lock().await;
    let details = serde_json::json!({
        "recording_id": released.recording_id,
        "protection": released.protection.as_str(),
    });
    if let Err(e) = db.log_audit_event("recording_playback_released", Some(details), "info") {
        tracing::warn!("Failed to log audit event: {}", e);
    }
    Ok(true)
}

/// Release every token a recording holds, whatever they are.
///
/// The privileged Electron process calls this when its own prepare failed
/// after the sidecar had already registered a token — a five-minute timeout on
/// a long decrypt is the case that happens — because that token's id never
/// reached anyone who could release it, and the plaintext behind it would sit
/// on disk until the vault locked.
pub(crate) async fn release_recording_playback_for_recording_impl(
    state: &AppState,
    recording_id: &str,
) -> Result<usize, String> {
    let released = state.playback_registry.release_recording(recording_id);
    if released.is_empty() {
        return Ok(0);
    }
    let mut db = state.db.lock().await;
    for entry in &released {
        let details = serde_json::json!({
            "recording_id": entry.recording_id,
            "protection": entry.protection.as_str(),
            "reason": "abandoned_preparation",
        });
        if let Err(e) = db.log_audit_event("recording_playback_released", Some(details), "info") {
            tracing::warn!("Failed to log audit event: {}", e);
        }
    }
    Ok(released.len())
}

/// Delete every decrypted playback temporary the app owns. The sidecar binary
/// calls this at startup (a crash can leave plaintext behind) and at shutdown
/// (nothing may outlive the process that decrypted it).
pub fn sweep_runtime_playback_audio_for_sidecar() -> Result<bool, String> {
    let data_dir = crate::paths::data_dir()
        .ok_or("Could not find data directory while sweeping playback audio")?;
    remove_decrypted_runtime_audio_directory(&data_dir)
}
