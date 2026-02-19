//! File-based credential storage for provider secrets (Dev Mode Fallback).
//!
//! Replaces system keychain with a local JSON file to avoid ACL issues in development.

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

lazy_static::lazy_static! {
    static ref MEMORY_CACHE: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());
}

fn get_secrets_file_path() -> Result<PathBuf> {
    let home = std::env::var("HOME").context("Failed to get HOME directory")?;
    Ok(PathBuf::from(home).join(".nautilus-bot-secrets.json"))
}

fn load_secrets() -> Result<HashMap<String, String>> {
    let path = get_secrets_file_path()?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = fs::read_to_string(&path)
        .with_context(|| format!("failed to read secrets file at {:?}", path))?;
    if content.trim().is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str(&content).with_context(|| "failed to parse secrets JSON")
}

fn save_secrets(secrets: &HashMap<String, String>) -> Result<()> {
    let path = get_secrets_file_path()?;
    let content = serde_json::to_string_pretty(secrets)?;
    fs::write(&path, content).with_context(|| format!("failed to write secrets file at {:?}", path))
}

pub fn set_provider_secret(provider: &str, secret: &str) -> Result<()> {
    eprintln!(
        "!!! SECRETS (FILE): set_provider_secret '{}' (len: {}) !!!",
        provider,
        secret.len()
    );
    let mut secrets = load_secrets().unwrap_or_default();
    secrets.insert(provider.to_string(), secret.to_string());
    save_secrets(&secrets)
}

pub fn clear_provider_secret(provider: &str) -> Result<()> {
    let mut secrets = load_secrets().unwrap_or_default();
    secrets.remove(provider);
    save_secrets(&secrets)
}

pub fn has_provider_secret(provider: &str) -> Result<bool> {
    let secrets = load_secrets().unwrap_or_default();
    Ok(secrets.contains_key(provider) && !secrets.get(provider).unwrap().is_empty())
}

pub fn get_provider_secret(provider: &str) -> Result<Option<String>> {
    eprintln!("!!! SECRETS (FILE): get_provider_secret '{}' !!!", provider);
    let secrets = load_secrets().unwrap_or_default();
    match secrets.get(provider) {
        Some(val) if !val.is_empty() => {
            eprintln!("!!! SECRETS (FILE): Found secret for '{}' !!!", provider);
            Ok(Some(val.clone()))
        }
        _ => {
            eprintln!(
                "!!! SECRETS (FILE): Secret for '{}' is empty/missing !!!",
                provider
            );
            Ok(None)
        }
    }
}

pub fn set_internal_secret(key: &str, secret: &str) -> Result<()> {
    let mut secrets = load_secrets().unwrap_or_default();
    secrets.insert(key.to_string(), secret.to_string());
    save_secrets(&secrets)
}

pub fn get_internal_secret(key: &str) -> Result<Option<String>> {
    let secrets = load_secrets().unwrap_or_default();
    Ok(secrets.get(key).cloned().filter(|s| !s.is_empty()))
}

#[allow(dead_code)]
pub fn clear_internal_secret(key: &str) -> Result<()> {
    let mut secrets = load_secrets().unwrap_or_default();
    secrets.remove(key);
    save_secrets(&secrets)
}
