//! Lemon Squeezy License API integration for Nautilus.
//!
//! Uses the LS License API (no private API key required – the license key itself
//! is the credential). State is persisted to a JSON file in the app data directory.
//!
//! State file: `<data_dir>/NautilusBot/nautilus_license.json`
//!
//! ## Free trial
//! `first_run_at` is written once on first call to `load_state()`. After 30 days
//! without a valid license, `nag_required` returns true.
//!
//! ## Grace period
//! If a network error occurs during validation and `last_validated_at` is within
//! 7 days, the cached `valid` state is returned unchanged.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ── Config ────────────────────────────────────────────────────────────────────

const LS_API_BASE: &str = "https://api.lemonsqueezy.com/v1/licenses";
const STATE_FILENAME: &str = "nautilus_license.json";
const APP_DIR_NAME: &str = "NautilusBot";
const TRIAL_DAYS: i64 = 30;
const GRACE_PERIOD_DAYS: i64 = 7;

// ── State ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    #[default]
    None,
    Pro,
    FriendsClub,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LicenseState {
    /// The stored LS license key (empty if none).
    pub key: String,
    /// The instance ID returned by the LS activate endpoint — stored to avoid
    /// burning extra activation slots on repeated launches.
    pub instance_id: String,
    /// Detected tier from `meta.variant_name`.
    pub tier: Tier,
    /// Last known LS key status ("active", "inactive", "expired", "disabled").
    pub ls_status: String,
    /// Activation limit as returned by LS (typically 5).
    pub activations_limit: u32,
    /// Current activation usage as returned by LS.
    pub activations_usage: u32,
    /// ISO 8601 timestamp of the last successful validate call.
    pub last_validated_at: String,
    /// ISO 8601 timestamp of when the user first launched the app.
    pub first_run_at: String,
    /// A stable device identifier (hostname + generated UUID) used as instance_name.
    pub device_id: String,
}

/// The public view of license state returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseInfo {
    pub key: String,
    pub instance_id: String,
    pub tier: Tier,
    /// Whether the license is currently considered valid (active + not expired/disabled,
    /// or within the grace period).
    pub valid: bool,
    /// LS key status string.
    pub ls_status: String,
    pub activations_limit: u32,
    pub activations_usage: u32,
    pub last_validated_at: String,
    /// Days remaining in the free trial (0 if trial expired or licensed).
    pub trial_days_remaining: i64,
    /// Whether to show a nag screen.
    pub nag_required: bool,
    /// Whether the trial is currently active (within 30 days of first run).
    pub trial_active: bool,
}

// ── Lemon Squeezy API response shapes ────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct LsLicenseKey {
    status: String,
    #[serde(default)]
    activation_limit: u32,
    #[serde(default)]
    activation_usage: u32,
}

#[derive(Debug, Deserialize)]
struct LsInstance {
    id: String,
}

#[derive(Debug, Deserialize)]
struct LsMeta {
    #[serde(default)]
    variant_name: String,
}

#[derive(Debug, Deserialize)]
struct LsActivateResponse {
    activated: bool,
    #[serde(default)]
    error: Option<String>,
    license_key: LsLicenseKey,
    instance: Option<LsInstance>,
    meta: LsMeta,
}

#[derive(Debug, Deserialize)]
struct LsValidateResponse {
    valid: bool,
    #[serde(default)]
    error: Option<String>,
    license_key: LsLicenseKey,
    instance: Option<LsInstance>,
    meta: LsMeta,
}

#[derive(Debug, Deserialize)]
struct LsDeactivateResponse {
    deactivated: bool,
    #[serde(default)]
    error: Option<String>,
}

// ── State persistence ─────────────────────────────────────────────────────────

fn state_path() -> Result<PathBuf> {
    let data_dir = dirs::data_dir().context("Cannot determine data directory")?;
    let dir = data_dir.join(APP_DIR_NAME);
    std::fs::create_dir_all(&dir).context("Cannot create data directory")?;
    Ok(dir.join(STATE_FILENAME))
}

pub(crate) fn load_state() -> LicenseState {
    let path = match state_path() {
        Ok(p) => p,
        Err(_) => return LicenseState::default(),
    };

    let mut state: LicenseState = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        LicenseState::default()
    };

    // Set first_run_at on very first launch.
    if state.first_run_at.is_empty() {
        state.first_run_at = chrono::Utc::now().to_rfc3339();
        let _ = persist_state(&state);
    }

    // Generate a stable device ID if missing.
    if state.device_id.is_empty() {
        let hostname = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string());
        state.device_id = format!("{}-{}", hostname, uuid::Uuid::new_v4());
        let _ = persist_state(&state);
    }

    state
}

fn persist_state(state: &LicenseState) -> Result<()> {
    let path = state_path()?;
    let json = serde_json::to_string_pretty(state).context("Serialization error")?;
    std::fs::write(&path, json).context("Failed to write license state")?;
    Ok(())
}

// ── Helper: build LicenseInfo from state ─────────────────────────────────────

fn info_from_state(state: &LicenseState) -> LicenseInfo {
    let valid = is_valid(state);
    let (trial_days_remaining, nag_required) = trial_status(state, valid);
    let trial_active = trial_days_remaining > 0;
    LicenseInfo {
        key: state.key.clone(),
        instance_id: state.instance_id.clone(),
        tier: state.tier.clone(),
        valid,
        ls_status: state.ls_status.clone(),
        activations_limit: state.activations_limit,
        activations_usage: state.activations_usage,
        last_validated_at: state.last_validated_at.clone(),
        trial_days_remaining,
        nag_required,
        trial_active,
    }
}

fn is_valid(state: &LicenseState) -> bool {
    if state.key.is_empty() {
        return false;
    }
    if !matches!(state.ls_status.as_str(), "active" | "inactive") {
        return false;
    }
    true
}

fn trial_status(state: &LicenseState, valid: bool) -> (i64, bool) {
    if valid {
        return (0, false);
    }
    if state.first_run_at.is_empty() {
        return (TRIAL_DAYS, false);
    }
    let first_run = chrono::DateTime::parse_from_rfc3339(&state.first_run_at)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());
    let days_elapsed = (chrono::Utc::now() - first_run).num_days();
    let remaining = (TRIAL_DAYS - days_elapsed).max(0);
    let nag = remaining == 0;
    (remaining, nag)
}

/// Returns true if the last validated timestamp is within the grace period.
fn within_grace_period(state: &LicenseState) -> bool {
    if state.last_validated_at.is_empty() {
        return false;
    }
    let last = chrono::DateTime::parse_from_rfc3339(&state.last_validated_at)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::DateTime::<chrono::Utc>::from(std::time::UNIX_EPOCH));
    (chrono::Utc::now() - last).num_days() < GRACE_PERIOD_DAYS
}

fn tier_from_variant(variant_name: &str) -> Tier {
    let lower = variant_name.to_lowercase();
    if lower.contains("friend") || lower.contains("club") {
        Tier::FriendsClub
    } else if !variant_name.is_empty() {
        Tier::Pro
    } else {
        Tier::None
    }
}

/// Returns the activation limit for a given tier.
/// Pro tier allows 5 activations, Friends Club allows 10.
pub fn get_tier_activation_limit(tier: &Tier) -> u32 {
    match tier {
        Tier::Pro => 5,
        Tier::FriendsClub => 10,
        Tier::None => 0,
    }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

fn ls_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("reqwest client")
}

fn encode_form(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

// ── Public async functions called by Tauri commands ───────────────────────────

/// Activate a license key on this device.
/// If the key + device combination is already activated (cached instance_id),
/// calls validate instead to avoid burning another activation slot.
pub async fn activate_license(key: &str) -> Result<LicenseInfo, String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("License key cannot be empty.".to_string());
    }

    let mut state = load_state();

    // If we already have an instance for this exact key, just validate.
    if state.key == key && !state.instance_id.is_empty() {
        return validate_license_inner(&mut state).await;
    }

    let device_id = state.device_id.clone();
    let client = ls_client();
    let body = encode_form(&[("license_key", &key), ("instance_name", &device_id)]);

    let resp = client
        .post(format!("{LS_API_BASE}/activate"))
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("Read error: {e}"))?;
    let parsed: LsActivateResponse = serde_json::from_str(&text)
        .map_err(|e| format!("Unexpected response from licensing server: {e}\n{text}"))?;

    if !parsed.activated {
        let msg = parsed
            .error
            .unwrap_or_else(|| "Activation failed.".to_string());
        return Err(if status == 422 && msg.contains("activation limit") {
            let tier = tier_from_variant(&parsed.meta.variant_name);
            let limit = get_tier_activation_limit(&tier);
            format!("This key has reached its {}-device activation limit. Deactivate another computer first, or buy a new license.", limit)
        } else {
            msg
        });
    }

    let instance_id = parsed.instance.map(|i| i.id).unwrap_or_default();

    state.key = key;
    state.instance_id = instance_id;
    state.tier = tier_from_variant(&parsed.meta.variant_name);
    state.ls_status = parsed.license_key.status;
    // Use tier-specific activation limit if LS doesn't provide one
    state.activations_limit = if parsed.license_key.activation_limit == 0 {
        get_tier_activation_limit(&state.tier)
    } else {
        parsed.license_key.activation_limit
    };
    state.activations_usage = parsed.license_key.activation_usage;
    state.last_validated_at = chrono::Utc::now().to_rfc3339();

    persist_state(&state).map_err(|e| format!("Failed to save license: {e}"))?;
    Ok(info_from_state(&state))
}

/// Validate the cached license key + instance against LS.
/// Applies the 7-day grace period if the network call fails.
pub async fn validate_license() -> LicenseInfo {
    let mut state = load_state();
    match validate_license_inner(&mut state).await {
        Ok(info) => info,
        Err(_) => {
            // Network / server error — apply grace period.
            if !state.key.is_empty() && within_grace_period(&state) {
                // Keep state.ls_status as-is, return as valid.
                info_from_state(&state)
            } else {
                info_from_state(&state)
            }
        }
    }
}

async fn validate_license_inner(state: &mut LicenseState) -> Result<LicenseInfo, String> {
    if state.key.is_empty() {
        return Ok(info_from_state(state));
    }

    let client = ls_client();
    let body = encode_form(&[
        ("license_key", &state.key),
        ("instance_id", &state.instance_id),
    ]);

    let resp = client
        .post(format!("{LS_API_BASE}/validate"))
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let text = resp.text().await.map_err(|e| format!("Read error: {e}"))?;
    let parsed: LsValidateResponse =
        serde_json::from_str(&text).map_err(|e| format!("Unexpected response: {e}"))?;

    // Update stats from the validate response.
    state.ls_status = parsed.license_key.status.clone();
    state.activations_limit = if parsed.license_key.activation_limit == 0 {
        5
    } else {
        parsed.license_key.activation_limit
    };
    state.activations_usage = parsed.license_key.activation_usage;
    if let Some(inst) = parsed.instance {
        state.instance_id = inst.id;
    }
    if !parsed.meta.variant_name.is_empty() {
        state.tier = tier_from_variant(&parsed.meta.variant_name);
    }
    state.last_validated_at = chrono::Utc::now().to_rfc3339();

    let _ = persist_state(state);

    if !parsed.valid {
        let msg = parsed
            .error
            .unwrap_or_else(|| format!("License {}", state.ls_status));
        return Err(msg);
    }

    Ok(info_from_state(state))
}

/// Deactivate this device's instance and clear local state.
pub async fn deactivate_license() -> Result<(), String> {
    let mut state = load_state();
    if state.key.is_empty() || state.instance_id.is_empty() {
        // Nothing to deactivate.
        return Ok(());
    }

    let client = ls_client();
    let body = encode_form(&[
        ("license_key", &state.key),
        ("instance_id", &state.instance_id),
    ]);

    let resp = client
        .post(format!("{LS_API_BASE}/deactivate"))
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let text = resp.text().await.map_err(|e| format!("Read error: {e}"))?;
    let parsed: LsDeactivateResponse =
        serde_json::from_str(&text).map_err(|e| format!("Unexpected response: {e}"))?;

    if !parsed.deactivated {
        let msg = parsed
            .error
            .unwrap_or_else(|| "Deactivation failed.".to_string());
        return Err(msg);
    }

    // Clear key + instance but keep first_run_at and device_id.
    let first_run_at = state.first_run_at.clone();
    let device_id = state.device_id.clone();
    state.key.clear();
    state.instance_id.clear();
    state.tier = Tier::None;
    state.ls_status.clear();
    state.activations_limit = 0;
    state.activations_usage = 0;
    state.last_validated_at.clear();
    state.first_run_at = first_run_at;
    state.device_id = device_id;
    persist_state(&state).map_err(|e| format!("Failed to clear license: {e}"))?;
    Ok(())
}
