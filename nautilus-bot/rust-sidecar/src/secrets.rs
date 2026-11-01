//! Secure credential storage for provider and internal secrets.
//!
//! Production storage uses the OS keychain/credential manager through `keyring`.
//! A one-time migration reads legacy plaintext JSON secrets and moves them into
//! secure storage, then deletes the plaintext file.

use anyhow::{Context, Result};
use keyring::{Entry, Error as KeyringError};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, TryLockError};

const SERVICE_NAME: &str = "com.plainsong.app";
const PROVIDER_PREFIX: &str = "provider:";
const INTERNAL_PREFIX: &str = "internal:";

const LEGACY_INTERNAL_KEYS: [&str; 2] = ["vault_db_key", "vault_unlock_check"];

#[derive(Default)]
struct LegacyMigrationState {
    complete: bool,
    ephemeral_secrets: Option<BTreeMap<String, String>>,
}

impl LegacyMigrationState {
    fn enable_ephemeral_credentials(&mut self) {
        self.ephemeral_secrets.get_or_insert_with(BTreeMap::new);
    }

    fn set_secret(&mut self, account: &str, secret: &str) -> Result<()> {
        if let Some(secrets) = self.ephemeral_secrets.as_mut() {
            secrets.insert(account.to_string(), secret.to_string());
            return Ok(());
        }
        set_secret_for_account(account, secret)
    }

    fn get_secret(&self, account: &str) -> Result<Option<String>> {
        if let Some(secrets) = self.ephemeral_secrets.as_ref() {
            return Ok(secrets
                .get(account)
                .filter(|secret| !secret.is_empty())
                .cloned());
        }
        get_secret_for_account(account)
    }

    fn clear_secret(&mut self, account: &str) -> Result<()> {
        if let Some(secrets) = self.ephemeral_secrets.as_mut() {
            secrets.remove(account);
            return Ok(());
        }
        clear_secret_for_account(account)
    }

    fn migrate_if_needed(&mut self, migrate: impl FnOnce() -> Result<()>) {
        if self.complete || self.ephemeral_secrets.is_some() {
            return;
        }
        match migrate() {
            Ok(()) => self.complete = true,
            Err(error) => {
                // The caller retains the migration lock through its secret
                // operation, so retrying cannot overwrite a newly rotated value.
                tracing::warn!("Legacy secrets migration deferred: {}", error);
            }
        }
    }
}

static LEGACY_MIGRATION_STATE: OnceLock<Mutex<LegacyMigrationState>> = OnceLock::new();

fn legacy_migration_state() -> &'static Mutex<LegacyMigrationState> {
    LEGACY_MIGRATION_STATE.get_or_init(|| {
        let mut state = LegacyMigrationState::default();
        if cfg!(test) {
            state.enable_ephemeral_credentials();
        }
        Mutex::new(state)
    })
}

/// Use only after the sidecar validates explicit QA mode and isolated temporary
/// data/config directories. Credentials stay in this process and never consume
/// the user's legacy secrets file, even when HOME remains unchanged.
pub fn enable_ephemeral_credentials_for_sidecar() {
    let state = legacy_migration_state();
    let mut state = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.enable_ephemeral_credentials();
}

fn normalize_identifier(value: &str, label: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow::anyhow!("{} cannot be empty", label));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(anyhow::anyhow!(
            "{} contains unsupported characters: '{}'",
            label,
            value
        ));
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn provider_account_name(provider: &str) -> Result<String> {
    Ok(format!(
        "{}{}",
        PROVIDER_PREFIX,
        normalize_identifier(provider, "provider")?
    ))
}

fn internal_account_name(key: &str) -> Result<String> {
    Ok(format!(
        "{}{}",
        INTERNAL_PREFIX,
        normalize_identifier(key, "key")?
    ))
}

fn entry_for_account(account: &str) -> Result<Entry> {
    Entry::new(SERVICE_NAME, account)
        .map_err(|e| anyhow::anyhow!("Failed to create secure credential entry: {}", e))
}

fn set_secret_for_account(account: &str, secret: &str) -> Result<()> {
    let entry = entry_for_account(account)?;
    entry
        .set_password(secret)
        .map_err(|e| anyhow::anyhow!("Failed to save secret in OS credential store: {}", e))
}

fn get_secret_for_account(account: &str) -> Result<Option<String>> {
    let entry = entry_for_account(account)?;
    match entry.get_password() {
        Ok(secret) if secret.is_empty() => Ok(None),
        Ok(secret) => Ok(Some(secret)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(err) => Err(anyhow::anyhow!(
            "Failed to read secret from OS credential store: {}",
            err
        )),
    }
}

#[cfg(target_os = "macos")]
mod macos_noninteractive {
    use anyhow::{Context, Result};
    use std::ffi::c_void;
    use std::ptr;

    type CfStringRef = *const c_void;
    type CfDictionaryRef = *const c_void;
    type CfTypeRef = *const c_void;
    type CfTypeId = usize;

    const UTF8_ENCODING: u32 = 0x0800_0100;
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;
    const ERR_SEC_INTERACTION_REQUIRED: i32 = -25315;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFBooleanTrue: CfTypeRef;

        fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            count: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> CfDictionaryRef;
        fn CFStringCreateWithBytes(
            allocator: *const c_void,
            bytes: *const u8,
            byte_count: isize,
            encoding: u32,
            is_external_representation: u8,
        ) -> CfStringRef;
        fn CFDataGetBytePtr(data: CfTypeRef) -> *const u8;
        fn CFDataGetLength(data: CfTypeRef) -> isize;
        fn CFDataGetTypeID() -> CfTypeId;
        fn CFGetTypeID(value: CfTypeRef) -> CfTypeId;
        fn CFRelease(value: CfTypeRef);
    }

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        static kSecClass: CfStringRef;
        static kSecClassGenericPassword: CfStringRef;
        static kSecAttrService: CfStringRef;
        static kSecAttrAccount: CfStringRef;
        static kSecReturnData: CfStringRef;
        static kSecUseAuthenticationUI: CfStringRef;
        static kSecUseAuthenticationUIFail: CfStringRef;

        fn SecItemCopyMatching(query: CfDictionaryRef, result: *mut CfTypeRef) -> i32;
    }

    struct OwnedCf(CfTypeRef);

    impl Drop for OwnedCf {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: The wrapper only contains objects returned at +1 by
                // Core Foundation or Security framework create/copy calls.
                unsafe { CFRelease(self.0) };
            }
        }
    }

    fn cf_string(value: &str) -> Result<OwnedCf> {
        // SAFETY: The byte slice remains alive for the duration of the call and
        // Core Foundation copies it into the returned immutable string.
        let string = unsafe {
            CFStringCreateWithBytes(
                ptr::null(),
                value.as_ptr(),
                value.len() as isize,
                UTF8_ENCODING,
                0,
            )
        };
        if string.is_null() {
            anyhow::bail!("Failed to create macOS Keychain query string");
        }
        Ok(OwnedCf(string))
    }

    fn status_has_data(status: i32) -> Result<bool> {
        match status {
            0 => Ok(true),
            ERR_SEC_ITEM_NOT_FOUND => Ok(false),
            ERR_SEC_INTERACTION_NOT_ALLOWED | ERR_SEC_INTERACTION_REQUIRED => {
                anyhow::bail!("Credential lookup requires user interaction")
            }
            _ => anyhow::bail!("Noninteractive macOS Keychain lookup failed ({status})"),
        }
    }

    fn query_secret_data(service: &str, account: &str) -> Result<Option<Vec<u8>>> {
        let service = cf_string(service)?;
        let account = cf_string(account)?;

        // Requesting the data makes this an accessibility check, while
        // kSecUseAuthenticationUIFail guarantees the check cannot display UI.
        let keys = unsafe {
            [
                kSecClass,
                kSecAttrService,
                kSecAttrAccount,
                kSecReturnData,
                kSecUseAuthenticationUI,
            ]
        };
        let values = unsafe {
            [
                kSecClassGenericPassword,
                service.0,
                account.0,
                kCFBooleanTrue,
                kSecUseAuthenticationUIFail,
            ]
        };
        // Null callbacks are safe here because every key and value outlives the
        // synchronous query. Security uses the canonical constant keys.
        let query = unsafe {
            CFDictionaryCreate(
                ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                keys.len() as isize,
                ptr::null(),
                ptr::null(),
            )
        };
        if query.is_null() {
            anyhow::bail!("Failed to create noninteractive macOS Keychain query");
        }
        let query = OwnedCf(query);
        let mut result = ptr::null();
        // SAFETY: The query is an immutable CFDictionary containing valid
        // Security framework keys and values. The copied result is released.
        let status = unsafe { SecItemCopyMatching(query.0, &mut result) };
        let _result = OwnedCf(result);
        if !status_has_data(status)? {
            return Ok(None);
        }
        if result.is_null() {
            anyhow::bail!("macOS Keychain returned no credential data")
        }
        // SAFETY: A successful copy returned a live CF object. The type check
        // happens before either CFData accessor is called.
        if unsafe { CFGetTypeID(result) } != unsafe { CFDataGetTypeID() } {
            anyhow::bail!("macOS Keychain returned an unexpected credential data type")
        }
        let length = unsafe { CFDataGetLength(result) };
        if length < 0 {
            anyhow::bail!("macOS Keychain returned an invalid credential data length")
        }
        if length == 0 {
            return Ok(Some(Vec::new()));
        }
        let bytes = unsafe { CFDataGetBytePtr(result) };
        if bytes.is_null() {
            anyhow::bail!("macOS Keychain returned an invalid credential data pointer")
        }
        // SAFETY: CFData owns at least `length` bytes and `_result` keeps it
        // alive until after this copy completes.
        Ok(Some(unsafe {
            std::slice::from_raw_parts(bytes, length as usize).to_vec()
        }))
    }

    pub(super) fn get_secret(service: &str, account: &str) -> Result<Option<String>> {
        let Some(bytes) = query_secret_data(service, account)? else {
            return Ok(None);
        };
        if bytes.is_empty() {
            return Ok(None);
        }
        String::from_utf8(bytes)
            .map(Some)
            .context("macOS Keychain credential data is not valid UTF-8")
    }

    pub(super) fn has_secret(service: &str, account: &str) -> Result<bool> {
        Ok(query_secret_data(service, account)?.is_some_and(|bytes| !bytes.is_empty()))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn maps_noninteractive_keychain_results_without_collapsing_unknowns() {
            assert!(status_has_data(0).unwrap());
            assert!(!status_has_data(ERR_SEC_ITEM_NOT_FOUND).unwrap());
            assert!(status_has_data(ERR_SEC_INTERACTION_NOT_ALLOWED).is_err());
            assert!(status_has_data(ERR_SEC_INTERACTION_REQUIRED).is_err());
            assert!(status_has_data(-1).is_err());
        }
    }
}

fn passive_secret_presence(account: &str) -> Result<bool> {
    #[cfg(target_os = "macos")]
    {
        macos_noninteractive::has_secret(SERVICE_NAME, account)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(get_secret_for_account(account)?.is_some())
    }
}

fn clear_secret_for_account(account: &str) -> Result<()> {
    let entry = entry_for_account(account)?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(err) => Err(anyhow::anyhow!(
            "Failed to remove secret from OS credential store: {}",
            err
        )),
    }
}

fn legacy_secrets_file_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("Failed to determine home directory")?;
    Ok(home.join(".nautilus-bot-secrets.json"))
}

fn legacy_account_name_for_key(raw_key: &str) -> Result<String> {
    let trimmed = raw_key.trim();
    if let Some(provider) = trimmed.strip_prefix(PROVIDER_PREFIX) {
        return provider_account_name(provider);
    }
    if let Some(internal) = trimmed.strip_prefix(INTERNAL_PREFIX) {
        return internal_account_name(internal);
    }
    if LEGACY_INTERNAL_KEYS
        .iter()
        .any(|known| known.eq_ignore_ascii_case(trimmed))
    {
        return internal_account_name(trimmed);
    }
    provider_account_name(trimmed)
}

trait LegacyMigrationStore {
    fn get(&self, account: &str) -> Result<Option<String>>;
    fn set(&self, account: &str, secret: &str) -> Result<()>;
}

struct KeyringMigrationStore;

impl LegacyMigrationStore for KeyringMigrationStore {
    fn get(&self, account: &str) -> Result<Option<String>> {
        let entry = entry_for_account(account)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(anyhow::anyhow!(
                "Failed to inspect migration destination in OS credential store: {}",
                error
            )),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<()> {
        set_secret_for_account(account, secret)
    }
}

fn with_legacy_migration<T>(
    operation: impl FnOnce(&mut LegacyMigrationState) -> Result<T>,
) -> Result<T> {
    let state = legacy_migration_state();
    let mut state = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.migrate_if_needed(migrate_legacy_file_inner);
    operation(&mut state)
}

fn read_legacy_secrets_file(path: &Path) -> Result<Option<String>> {
    let path_metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| {
                format!("Failed to inspect legacy secrets file {}", path.display())
            })
        }
    };
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        return Err(anyhow::anyhow!("Legacy secrets path is not a regular file"));
    }

    let mut file = std::fs::File::open(path)
        .with_context(|| format!("Failed to open legacy secrets file {}", path.display()))?;
    let opened_metadata = file
        .metadata()
        .with_context(|| format!("Failed to read metadata for {}", path.display()))?;
    if !opened_metadata.is_file() {
        return Err(anyhow::anyhow!("Legacy secrets path is not a regular file"));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if path_metadata.dev() != opened_metadata.dev()
            || path_metadata.ino() != opened_metadata.ino()
        {
            return Err(anyhow::anyhow!(
                "Legacy secrets file changed while it was being opened"
            ));
        }
    }

    let mut raw = String::new();
    file.read_to_string(&mut raw)
        .with_context(|| format!("Failed to read legacy secrets file {}", path.display()))?;
    Ok(Some(raw))
}

fn legacy_migration_staging_path(path: &Path) -> Result<PathBuf> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("Legacy secrets path has no valid file name")?;
    Ok(path.with_file_name(format!("{file_name}.migrating")))
}

fn stage_legacy_secrets_file(path: &Path) -> Result<Option<PathBuf>> {
    let staged = legacy_migration_staging_path(path)?;
    match std::fs::symlink_metadata(&staged) {
        Ok(_) => return Ok(Some(staged)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "Failed to inspect staged legacy secrets file {}",
                    staged.display()
                )
            })
        }
    }

    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| {
                format!("Failed to inspect legacy secrets file {}", path.display())
            })
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(anyhow::anyhow!("Legacy secrets path is not a regular file"));
    }

    // A same-directory rename atomically claims the plaintext source. If the
    // process stops midway, the next attempt resumes from this deterministic path.
    std::fs::rename(path, &staged).with_context(|| {
        format!(
            "Failed to stage legacy secrets file {} as {}",
            path.display(),
            staged.display()
        )
    })?;
    Ok(Some(staged))
}

fn migrate_legacy_file_at(path: &Path, store: &dyn LegacyMigrationStore) -> Result<()> {
    let Some(staged) = stage_legacy_secrets_file(path)? else {
        return Ok(());
    };
    let raw = read_legacy_secrets_file(&staged)?
        .context("Staged legacy secrets file disappeared during migration")?;
    if raw.trim().is_empty() {
        std::fs::remove_file(&staged).with_context(|| {
            format!(
                "Failed to delete empty staged legacy secrets file {}",
                staged.display()
            )
        })?;
        return Ok(());
    }

    let legacy_map: BTreeMap<String, String> =
        serde_json::from_str(&raw).context("Failed to parse legacy secrets JSON")?;
    let mut migration_plan = BTreeMap::<String, String>::new();
    for (legacy_key, secret) in legacy_map {
        if secret.is_empty() {
            continue;
        }
        let account = legacy_account_name_for_key(&legacy_key)?;
        if let Some(previous) = migration_plan.insert(account.clone(), secret.clone()) {
            if previous != secret {
                anyhow::bail!(
                    "Legacy secret keys resolve to conflicting values for account '{}'",
                    account
                );
            }
        }
    }

    for (account, legacy_secret) in &migration_plan {
        if store.get(account)?.is_some() {
            continue;
        }
        store.set(account, legacy_secret).with_context(|| {
            format!(
                "Failed migrating legacy account '{}' into secure credential store",
                account
            )
        })?;
        let imported = store.get(account)?.with_context(|| {
            format!(
                "Migrated legacy account '{}' could not be read back",
                account
            )
        })?;
        if imported != *legacy_secret {
            anyhow::bail!(
                "Migrated legacy account '{}' failed read-back verification",
                account
            );
        }
    }

    // Re-read every destination immediately before deleting the only migration
    // source. Existing or concurrently rotated values win; migration only requires
    // that each intended account is now represented in secure storage.
    for account in migration_plan.keys() {
        if store.get(account)?.is_none() {
            anyhow::bail!(
                "Legacy account '{}' is still absent after migration",
                account
            );
        }
    }
    std::fs::remove_file(&staged).with_context(|| {
        format!(
            "Failed to remove staged legacy secrets file {}",
            staged.display()
        )
    })?;
    tracing::info!("Migrated legacy plaintext secrets into OS credential store");
    Ok(())
}

fn migrate_legacy_file_inner() -> Result<()> {
    migrate_legacy_file_at(&legacy_secrets_file_path()?, &KeyringMigrationStore)
}

pub fn set_provider_secret(provider: &str, secret: &str) -> Result<()> {
    with_legacy_migration(|state| {
        let account = provider_account_name(provider)?;
        state.set_secret(&account, secret)
    })
}

pub fn clear_provider_secret(provider: &str) -> Result<()> {
    with_legacy_migration(|state| {
        let account = provider_account_name(provider)?;
        state.clear_secret(&account)
    })
}

pub fn has_provider_secret(provider: &str) -> Result<bool> {
    let account = provider_account_name(provider)?;
    let state = legacy_migration_state();
    let state = match state.try_lock() {
        Ok(state) => state,
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(TryLockError::WouldBlock) => {
            anyhow::bail!("Credential presence is unavailable while the credential store is busy")
        }
    };
    if let Some(secrets) = state.ephemeral_secrets.as_ref() {
        return Ok(secrets
            .get(&account)
            .is_some_and(|secret| !secret.is_empty()));
    }
    let migration_complete = state.complete;

    let present = passive_secret_presence(&account)?;
    if !present && !migration_complete {
        let legacy_path = legacy_secrets_file_path()?;
        match std::fs::symlink_metadata(&legacy_path) {
            Ok(_) => anyhow::bail!(
                "Credential presence is unknown until legacy secret migration completes"
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "Failed to inspect legacy secrets path {}",
                        legacy_path.display()
                    )
                })
            }
        }
    }
    Ok(present)
}

pub fn get_provider_secret(provider: &str) -> Result<Option<String>> {
    get_normalized_secret_noninteractive(
        provider,
        provider_account_name,
        get_secret_for_account_noninteractive,
    )
}

pub fn set_internal_secret(key: &str, secret: &str) -> Result<()> {
    with_legacy_migration(|state| {
        let account = internal_account_name(key)?;
        state.set_secret(&account, secret)
    })
}

pub fn get_internal_secret(key: &str) -> Result<Option<String>> {
    with_legacy_migration(|state| {
        let account = internal_account_name(key)?;
        state.get_secret(&account)
    })
}

/// Read an internal secret without allowing the OS credential store to show UI.
/// Startup uses this path so a locked credential store fails closed instead of
/// opening the database without a key or asking for user interaction.
pub fn get_internal_secret_noninteractive(key: &str) -> Result<Option<String>> {
    get_normalized_secret_noninteractive(
        key,
        internal_account_name,
        get_secret_for_account_noninteractive,
    )
}

fn get_normalized_secret_noninteractive(
    identifier: &str,
    account_name: impl FnOnce(&str) -> Result<String>,
    read: impl FnOnce(&str) -> Result<Option<String>>,
) -> Result<Option<String>> {
    let account = account_name(identifier)?;
    Ok(read(&account)?.filter(|secret| !secret.is_empty()))
}

fn get_secret_for_account_noninteractive(account: &str) -> Result<Option<String>> {
    let state = legacy_migration_state();
    let state = match state.try_lock() {
        Ok(state) => state,
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(TryLockError::WouldBlock) => {
            anyhow::bail!("Credential lookup is unavailable while the credential store is busy")
        }
    };
    if let Some(secrets) = state.ephemeral_secrets.as_ref() {
        return Ok(secrets
            .get(account)
            .filter(|secret| !secret.is_empty())
            .cloned());
    }
    let migration_complete = state.complete;
    drop(state);

    #[cfg(target_os = "macos")]
    let secret = macos_noninteractive::get_secret(SERVICE_NAME, account)?;
    #[cfg(not(target_os = "macos"))]
    let secret = get_secret_for_account(account)?;

    if secret.is_none() && !migration_complete {
        let legacy_path = legacy_secrets_file_path()?;
        let staged_path = legacy_migration_staging_path(&legacy_path)?;
        for path in [&legacy_path, &staged_path] {
            match std::fs::symlink_metadata(path) {
                Ok(_) => anyhow::bail!(
                    "A legacy credential migration is pending; unlock credentials and retry from an explicit vault action"
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!("Failed to inspect legacy secrets path {}", path.display())
                    })
                }
            }
        }
    }
    Ok(secret)
}

pub fn clear_internal_secret(key: &str) -> Result<()> {
    with_legacy_migration(|state| {
        let account = internal_account_name(key)?;
        state.clear_secret(&account)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[test]
    fn shared_credentials_are_ephemeral_in_tests() {
        let state = legacy_migration_state();
        let state = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(state.ephemeral_secrets.is_some());
    }

    #[derive(Default)]
    struct MemoryMigrationStore {
        values: RefCell<BTreeMap<String, String>>,
        fail_once_for: RefCell<Option<String>>,
    }

    impl LegacyMigrationStore for MemoryMigrationStore {
        fn get(&self, account: &str) -> Result<Option<String>> {
            Ok(self.values.borrow().get(account).cloned())
        }

        fn set(&self, account: &str, secret: &str) -> Result<()> {
            if self.fail_once_for.borrow().as_deref() == Some(account) {
                self.fail_once_for.borrow_mut().take();
                anyhow::bail!("injected migration failure for {account}");
            }
            self.values
                .borrow_mut()
                .insert(account.to_string(), secret.to_string());
            Ok(())
        }
    }

    fn unique_test_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "plainsong-secrets-{label}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn ephemeral_credentials_leave_legacy_secrets_unread_and_unchanged() {
        let root = unique_test_dir("ephemeral");
        std::fs::create_dir_all(&root).expect("create test directory");
        let path = root.join("legacy.json");
        let original = br#"{"provider:test":"preserved-secret"}"#;
        std::fs::write(&path, original).expect("write legacy file");
        let store = MemoryMigrationStore::default();
        let attempted = Cell::new(false);
        let mut state = LegacyMigrationState::default();
        state.enable_ephemeral_credentials();

        for _ in 0..2 {
            state.migrate_if_needed(|| {
                attempted.set(true);
                migrate_legacy_file_at(&path, &store)
            });
        }

        assert!(
            !attempted.get(),
            "migration must not inspect the legacy file"
        );
        assert!(store.values.borrow().is_empty());
        assert_eq!(
            std::fs::read(&path).expect("legacy file remains"),
            original.to_vec()
        );
        assert!(!legacy_migration_staging_path(&path)
            .expect("staging path")
            .exists());
        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn ephemeral_credentials_persist_across_separate_operations() {
        let mut state = LegacyMigrationState::default();
        state.enable_ephemeral_credentials();
        let first_provider = provider_account_name("FIRST").expect("provider account");
        let second_provider = provider_account_name("second").expect("provider account");
        let internal = internal_account_name("first").expect("internal account");

        state
            .set_secret(&first_provider, "first-value")
            .expect("set first provider");
        state
            .set_secret(&second_provider, "second-value")
            .expect("set second provider");
        state
            .set_secret(&internal, "internal-value")
            .expect("set internal credential");
        // Re-enabling QA storage must not erase credentials already saved.
        state.enable_ephemeral_credentials();
        assert_eq!(
            state.get_secret(&first_provider).unwrap().as_deref(),
            Some("first-value")
        );
        assert_eq!(
            state.get_secret(&second_provider).unwrap().as_deref(),
            Some("second-value")
        );
        assert_eq!(
            state.get_secret(&internal).unwrap().as_deref(),
            Some("internal-value")
        );

        state
            .set_secret(&first_provider, "updated-value")
            .expect("overwrite first provider");
        assert_eq!(
            state.get_secret(&first_provider).unwrap().as_deref(),
            Some("updated-value")
        );
        state
            .clear_secret(&first_provider)
            .expect("delete first provider");
        state
            .clear_secret(&first_provider)
            .expect("deleting a missing credential is harmless");
        assert_eq!(state.get_secret(&first_provider).unwrap(), None);
        assert_eq!(
            state.get_secret(&second_provider).unwrap().as_deref(),
            Some("second-value")
        );
        assert_eq!(
            state.get_secret(&internal).unwrap().as_deref(),
            Some("internal-value")
        );

        let mut other_process_state = LegacyMigrationState::default();
        other_process_state.enable_ephemeral_credentials();
        assert_eq!(
            other_process_state.get_secret(&second_provider).unwrap(),
            None
        );
        assert_eq!(other_process_state.get_secret(&internal).unwrap(), None);
    }

    #[test]
    fn empty_ephemeral_credentials_are_absent() {
        let mut state = LegacyMigrationState::default();
        state.enable_ephemeral_credentials();
        let account = provider_account_name("test").expect("provider account");
        assert_eq!(state.get_secret(&account).unwrap(), None);
        state.set_secret(&account, "").expect("store empty value");
        assert_eq!(state.get_secret(&account).unwrap(), None);
    }

    #[test]
    fn provider_noninteractive_read_normalizes_account_before_lookup() {
        let observed_account = RefCell::new(None);

        let secret =
            get_normalized_secret_noninteractive("  OpenAI  ", provider_account_name, |account| {
                observed_account.replace(Some(account.to_string()));
                Ok(Some("secret".to_string()))
            })
            .expect("provider secret lookup");

        assert_eq!(
            observed_account.into_inner().as_deref(),
            Some("provider:openai")
        );
        assert_eq!(secret.as_deref(), Some("secret"));
    }

    #[test]
    fn noninteractive_read_rejects_invalid_identifier_before_lookup() {
        let attempted = Cell::new(false);

        let error =
            get_normalized_secret_noninteractive("bad/provider", provider_account_name, |_| {
                attempted.set(true);
                Ok(Some("secret".to_string()))
            })
            .expect_err("invalid provider must be rejected");

        assert!(!attempted.get());
        assert!(error.to_string().contains("unsupported characters"));
    }

    #[test]
    fn noninteractive_read_treats_empty_and_missing_secrets_as_absent() {
        let empty = get_normalized_secret_noninteractive("openai", provider_account_name, |_| {
            Ok(Some(String::new()))
        })
        .expect("empty provider secret lookup");
        let missing =
            get_normalized_secret_noninteractive("openai", provider_account_name, |_| Ok(None))
                .expect("missing provider secret lookup");

        assert_eq!(empty, None);
        assert_eq!(missing, None);
    }

    #[test]
    fn persistent_credentials_migrate_legacy_secrets_once() {
        let root = unique_test_dir("persistent");
        std::fs::create_dir_all(&root).expect("create test directory");
        let path = root.join("legacy.json");
        std::fs::write(&path, br#"{"provider:test":"imported-secret"}"#)
            .expect("write legacy file");
        let store = MemoryMigrationStore::default();
        let mut state = LegacyMigrationState::default();

        state.migrate_if_needed(|| migrate_legacy_file_at(&path, &store));

        assert!(state.complete);
        assert_eq!(
            store
                .values
                .borrow()
                .get("provider:test")
                .map(String::as_str),
            Some("imported-secret")
        );
        assert!(!path.exists());
        assert!(!legacy_migration_staging_path(&path)
            .expect("staging path")
            .exists());
        state.migrate_if_needed(|| panic!("completed migration must not run again"));
        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn failed_legacy_migration_remains_retryable() {
        let mut state = LegacyMigrationState::default();
        state.migrate_if_needed(|| anyhow::bail!("synthetic migration failure"));
        assert!(!state.complete);

        let attempted = Cell::new(false);
        state.migrate_if_needed(|| {
            attempted.set(true);
            Ok(())
        });
        assert!(attempted.get());
        assert!(state.complete);
    }

    #[test]
    fn missing_legacy_file_is_a_normal_no_op() {
        let root = unique_test_dir("missing");
        let path = root.join("legacy.json");

        assert_eq!(
            read_legacy_secrets_file(&path).expect("missing file must not fail"),
            None
        );
    }

    #[test]
    fn regular_legacy_file_is_read_from_the_validated_handle() {
        let root = unique_test_dir("regular");
        std::fs::create_dir_all(&root).expect("create test directory");
        let path = root.join("legacy.json");
        std::fs::write(&path, "{\"provider:test\":\"secret\"}").expect("write legacy file");

        assert_eq!(
            read_legacy_secrets_file(&path)
                .expect("regular file must be readable")
                .as_deref(),
            Some("{\"provider:test\":\"secret\"}")
        );

        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn resumed_migration_does_not_clobber_a_newer_secret() {
        let root = unique_test_dir("resume");
        std::fs::create_dir_all(&root).expect("create test directory");
        let path = root.join("legacy.json");
        std::fs::write(&path, r#"{"provider:a":"stale-a","provider:b":"stale-b"}"#)
            .expect("write legacy file");
        let store = MemoryMigrationStore {
            fail_once_for: RefCell::new(Some("provider:b".to_string())),
            ..MemoryMigrationStore::default()
        };

        migrate_legacy_file_at(&path, &store).expect_err("second account should fail once");
        assert!(!path.exists());
        assert!(legacy_migration_staging_path(&path)
            .expect("staging path")
            .exists());
        store
            .values
            .borrow_mut()
            .insert("provider:a".to_string(), "rotated-a".to_string());

        migrate_legacy_file_at(&path, &store).expect("migration should resume");

        assert_eq!(
            store.values.borrow().get("provider:a").map(String::as_str),
            Some("rotated-a")
        );
        assert_eq!(
            store.values.borrow().get("provider:b").map(String::as_str),
            Some("stale-b")
        );
        assert!(!legacy_migration_staging_path(&path)
            .expect("staging path")
            .exists());
        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[cfg(unix)]
    #[test]
    fn legacy_file_symlinks_are_rejected() {
        use std::os::unix::fs::symlink;

        let root = unique_test_dir("symlink");
        std::fs::create_dir_all(&root).expect("create test directory");
        let target = root.join("target.json");
        let path = root.join("legacy.json");
        std::fs::write(&target, "{}").expect("write target");
        symlink(&target, &path).expect("create symlink");

        let error = read_legacy_secrets_file(&path).expect_err("symlink must be rejected");
        assert!(error
            .to_string()
            .contains("Legacy secrets path is not a regular file"));

        std::fs::remove_dir_all(root).expect("remove test directory");
    }
}
