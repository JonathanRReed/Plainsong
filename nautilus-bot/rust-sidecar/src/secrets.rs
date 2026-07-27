//! Secure credential storage for provider and internal secrets.
//!
//! Production storage uses the OS keychain/credential manager through `keyring`.
//! A one-time migration reads legacy plaintext JSON secrets and moves them into
//! secure storage, then deletes the plaintext file.

use anyhow::{Context, Result};
use keyring::{Entry, Error as KeyringError};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const SERVICE_NAME: &str = "com.plainsong.app";
const PROVIDER_PREFIX: &str = "provider:";
const INTERNAL_PREFIX: &str = "internal:";

const LEGACY_INTERNAL_KEYS: [&str; 2] = ["vault_db_key", "vault_unlock_check"];

static LEGACY_MIGRATION_ONCE: OnceLock<()> = OnceLock::new();

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

fn migrate_legacy_file_if_needed() {
    LEGACY_MIGRATION_ONCE.get_or_init(|| {
        if let Err(err) = migrate_legacy_file_inner() {
            tracing::warn!("Legacy secrets migration skipped: {}", err);
        }
    });
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

fn migrate_legacy_file_inner() -> Result<()> {
    let path = legacy_secrets_file_path()?;
    let Some(raw) = read_legacy_secrets_file(&path)? else {
        return Ok(());
    };
    if raw.trim().is_empty() {
        std::fs::remove_file(&path).with_context(|| {
            format!(
                "Failed to delete empty legacy secrets file {}",
                path.display()
            )
        })?;
        return Ok(());
    }

    let legacy_map: HashMap<String, String> =
        serde_json::from_str(&raw).context("Failed to parse legacy secrets JSON")?;

    for (legacy_key, secret) in legacy_map {
        if secret.is_empty() {
            continue;
        }
        let account = legacy_account_name_for_key(&legacy_key)?;
        set_secret_for_account(&account, &secret).with_context(|| {
            format!(
                "Failed migrating legacy secret '{}' into secure credential store",
                legacy_key
            )
        })?;
    }

    std::fs::remove_file(&path)
        .with_context(|| format!("Failed to remove legacy secrets file {}", path.display()))?;
    tracing::info!("Migrated legacy plaintext secrets into OS credential store");
    Ok(())
}

pub fn set_provider_secret(provider: &str, secret: &str) -> Result<()> {
    migrate_legacy_file_if_needed();
    let account = provider_account_name(provider)?;
    set_secret_for_account(&account, secret)
}

pub fn clear_provider_secret(provider: &str) -> Result<()> {
    migrate_legacy_file_if_needed();
    let account = provider_account_name(provider)?;
    clear_secret_for_account(&account)
}

pub fn has_provider_secret(provider: &str) -> Result<bool> {
    migrate_legacy_file_if_needed();
    let account = provider_account_name(provider)?;
    Ok(get_secret_for_account(&account)?.is_some())
}

pub fn get_provider_secret(provider: &str) -> Result<Option<String>> {
    migrate_legacy_file_if_needed();
    let account = provider_account_name(provider)?;
    get_secret_for_account(&account)
}

pub fn set_internal_secret(key: &str, secret: &str) -> Result<()> {
    migrate_legacy_file_if_needed();
    let account = internal_account_name(key)?;
    set_secret_for_account(&account, secret)
}

pub fn get_internal_secret(key: &str) -> Result<Option<String>> {
    migrate_legacy_file_if_needed();
    let account = internal_account_name(key)?;
    get_secret_for_account(&account)
}

pub fn clear_internal_secret(key: &str) -> Result<()> {
    migrate_legacy_file_if_needed();
    let account = internal_account_name(key)?;
    clear_secret_for_account(&account)
}

#[cfg(test)]
mod tests {
    use super::*;

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
