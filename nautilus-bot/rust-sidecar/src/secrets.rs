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
use std::sync::{Mutex, OnceLock};

const SERVICE_NAME: &str = "com.plainsong.app";
const PROVIDER_PREFIX: &str = "provider:";
const INTERNAL_PREFIX: &str = "internal:";

const LEGACY_INTERNAL_KEYS: [&str; 2] = ["vault_db_key", "vault_unlock_check"];

#[derive(Default)]
struct LegacyMigrationState {
    complete: bool,
}

static LEGACY_MIGRATION_STATE: OnceLock<Mutex<LegacyMigrationState>> = OnceLock::new();

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

fn with_legacy_migration<T>(operation: impl FnOnce() -> Result<T>) -> Result<T> {
    let state = LEGACY_MIGRATION_STATE.get_or_init(|| Mutex::new(LegacyMigrationState::default()));
    let mut state = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !state.complete {
        match migrate_legacy_file_inner() {
            Ok(()) => state.complete = true,
            Err(error) => {
                // Keep the state retryable. The caller's secret operation runs while
                // this mutex is still held, so a newly rotated value cannot race a
                // second migration attempt and be replaced by stale plaintext.
                tracing::warn!("Legacy secrets migration deferred: {}", error);
            }
        }
    }
    operation()
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
    with_legacy_migration(|| {
        let account = provider_account_name(provider)?;
        set_secret_for_account(&account, secret)
    })
}

pub fn clear_provider_secret(provider: &str) -> Result<()> {
    with_legacy_migration(|| {
        let account = provider_account_name(provider)?;
        clear_secret_for_account(&account)
    })
}

pub fn has_provider_secret(provider: &str) -> Result<bool> {
    with_legacy_migration(|| {
        let account = provider_account_name(provider)?;
        Ok(get_secret_for_account(&account)?.is_some())
    })
}

pub fn get_provider_secret(provider: &str) -> Result<Option<String>> {
    with_legacy_migration(|| {
        let account = provider_account_name(provider)?;
        get_secret_for_account(&account)
    })
}

pub fn set_internal_secret(key: &str, secret: &str) -> Result<()> {
    with_legacy_migration(|| {
        let account = internal_account_name(key)?;
        set_secret_for_account(&account, secret)
    })
}

pub fn get_internal_secret(key: &str) -> Result<Option<String>> {
    with_legacy_migration(|| {
        let account = internal_account_name(key)?;
        get_secret_for_account(&account)
    })
}

pub fn clear_internal_secret(key: &str) -> Result<()> {
    with_legacy_migration(|| {
        let account = internal_account_name(key)?;
        clear_secret_for_account(&account)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

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
