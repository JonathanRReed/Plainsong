//! OS credential storage for provider secrets.
//!
//! Uses the system keychain/credential manager through the `keyring` crate.

use anyhow::{Context, Result};

const SERVICE_NAME: &str = "com.nautilus.app";

fn entry_for(provider: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE_NAME, provider).map_err(anyhow::Error::from)
}

pub fn set_provider_secret(provider: &str, secret: &str) -> Result<()> {
    entry_for(provider)?
        .set_password(secret)
        .with_context(|| format!("failed to persist secret for provider '{provider}'"))
}

pub fn clear_provider_secret(provider: &str) -> Result<()> {
    let entry = entry_for(provider)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(anyhow::anyhow!(e))
            .with_context(|| format!("failed to remove secret for provider '{provider}'")),
    }
}

pub fn has_provider_secret(provider: &str) -> Result<bool> {
    let entry = entry_for(provider)?;
    match entry.get_password() {
        Ok(value) => Ok(!value.is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(anyhow::anyhow!(e))
            .with_context(|| format!("failed to check secret for provider '{provider}'")),
    }
}
