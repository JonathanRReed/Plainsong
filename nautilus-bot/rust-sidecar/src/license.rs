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

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::{Mutex, OnceLock};

// ── Config ────────────────────────────────────────────────────────────────────

const LS_API_BASE: &str = "https://api.lemonsqueezy.com/v1/licenses";
const STATE_FILENAME: &str = "nautilus_license.json";
const APP_DIR_NAME: &str = "NautilusBot";
const TRIAL_DAYS: i64 = 30;
const GRACE_PERIOD_DAYS: i64 = 7;
const SECRET_LICENSE_KEY: &str = "license_key";
const SECRET_INSTANCE_ID: &str = "license_instance_id";
const SECRET_DEVICE_ID: &str = "license_device_id";
const SECRET_FIRST_RUN_AT: &str = "license_first_run_at";

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
    #[serde(default, skip_serializing)]
    pub key: String,
    /// The instance ID returned by the LS activate endpoint — stored to avoid
    /// burning extra activation slots on repeated launches.
    #[serde(default, skip_serializing)]
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
    #[serde(default, skip_serializing)]
    pub first_run_at: String,
    /// A stable device identifier (hostname + generated UUID) used as instance_name.
    #[serde(default, skip_serializing)]
    pub device_id: String,
}

/// The public view of license state returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseInfo {
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

/// Unified entitlement object used for all feature and update gating.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entitlement {
    pub trial_active: bool,
    pub license_valid: bool,
    /// "free" | "pro" | "friends"
    pub tier: String,
    pub pro_enabled: bool,
    pub experimental_enabled: bool,
    pub can_update: bool,
}

pub fn build_entitlement(info: &LicenseInfo) -> Entitlement {
    let pro_enabled = info.valid || info.trial_active;
    let experimental_enabled = info.valid && info.tier == Tier::FriendsClub;
    let can_update = info.valid || info.trial_active;
    let tier = if info.valid && info.tier == Tier::FriendsClub {
        "friends".to_string()
    } else if info.valid || info.trial_active {
        "pro".to_string()
    } else {
        "free".to_string()
    };

    Entitlement {
        trial_active: info.trial_active,
        license_valid: info.valid,
        tier,
        pro_enabled,
        experimental_enabled,
        can_update,
    }
}

/// Build entitlement from current persisted state (no network call).
pub fn get_current_entitlement() -> Entitlement {
    let state = load_state();
    let info = info_from_state(&state);
    build_entitlement(&info)
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
    #[cfg(test)]
    {
        let override_lock = TEST_STATE_PATH_OVERRIDE.get_or_init(|| Mutex::new(None));
        if let Some(path) = override_lock
            .lock()
            .expect("state path override lock")
            .clone()
        {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).context("Cannot create test data directory")?;
            }
            return Ok(path);
        }
    }

    let data_dir = dirs::data_dir().context("Cannot determine data directory")?;
    let dir = data_dir.join(APP_DIR_NAME);
    std::fs::create_dir_all(&dir).context("Cannot create data directory")?;
    Ok(dir.join(STATE_FILENAME))
}

#[cfg(test)]
static TEST_SECRET_STORE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

#[cfg(test)]
static TEST_STATE_PATH_OVERRIDE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn secure_secret_get(secret_key: &str) -> Result<Option<String>> {
    #[cfg(test)]
    {
        let store = TEST_SECRET_STORE.get_or_init(|| Mutex::new(HashMap::new()));
        return Ok(store
            .lock()
            .expect("test secret store lock")
            .get(secret_key)
            .cloned());
    }

    #[cfg(not(test))]
    {
        crate::secrets::get_internal_secret(secret_key)
    }
}

fn secure_secret_set(secret_key: &str, value: &str) -> Result<()> {
    #[cfg(test)]
    {
        let store = TEST_SECRET_STORE.get_or_init(|| Mutex::new(HashMap::new()));
        let mut guard = store.lock().expect("test secret store lock");
        if value.is_empty() {
            guard.remove(secret_key);
        } else {
            guard.insert(secret_key.to_string(), value.to_string());
        }
        Ok(())
    }

    #[cfg(not(test))]
    {
        if value.is_empty() {
            crate::secrets::clear_internal_secret(secret_key)
        } else {
            crate::secrets::set_internal_secret(secret_key, value)
        }
    }
}

fn migrate_or_hydrate_secret(state_value: &mut String, secret_key: &str) -> Result<bool> {
    match secure_secret_get(secret_key)? {
        Some(stored_value) => {
            if *state_value != stored_value {
                *state_value = stored_value;
            }
            Ok(false)
        }
        None if !state_value.is_empty() => {
            secure_secret_set(secret_key, state_value)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

fn sync_secrets(state: &LicenseState) -> Result<()> {
    secure_secret_set(SECRET_LICENSE_KEY, &state.key)?;
    secure_secret_set(SECRET_INSTANCE_ID, &state.instance_id)?;
    secure_secret_set(SECRET_DEVICE_ID, &state.device_id)?;
    secure_secret_set(SECRET_FIRST_RUN_AT, &state.first_run_at)?;
    Ok(())
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

    let mut needs_persist = false;

    match migrate_or_hydrate_secret(&mut state.key, SECRET_LICENSE_KEY) {
        Ok(changed) => needs_persist |= changed,
        Err(err) => tracing::warn!("Failed to load secure license key: {}", err),
    }
    match migrate_or_hydrate_secret(&mut state.instance_id, SECRET_INSTANCE_ID) {
        Ok(changed) => needs_persist |= changed,
        Err(err) => tracing::warn!("Failed to load secure license instance: {}", err),
    }
    match migrate_or_hydrate_secret(&mut state.first_run_at, SECRET_FIRST_RUN_AT) {
        Ok(changed) => needs_persist |= changed,
        Err(err) => tracing::warn!("Failed to load secure trial anchor: {}", err),
    }
    match migrate_or_hydrate_secret(&mut state.device_id, SECRET_DEVICE_ID) {
        Ok(changed) => needs_persist |= changed,
        Err(err) => tracing::warn!("Failed to load secure device id: {}", err),
    }

    // Set first_run_at on very first launch.
    if state.first_run_at.is_empty() {
        state.first_run_at = chrono::Utc::now().to_rfc3339();
        needs_persist = true;
    }

    // Generate a stable device ID if missing.
    if state.device_id.is_empty() {
        let hostname = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string());
        state.device_id = format!("{}-{}", hostname, uuid::Uuid::new_v4());
        needs_persist = true;
    }

    if needs_persist {
        if let Err(err) = persist_state(&state) {
            tracing::warn!("Failed to persist hardened license state: {}", err);
        }
    }

    state
}

fn persist_state(state: &LicenseState) -> Result<()> {
    sync_secrets(state)?;
    let path = state_path()?;
    let json = serde_json::to_string_pretty(state).context("Serialization error")?;
    std::fs::write(&path, json).context("Failed to write license state")?;
    Ok(())
}

// ── Helper: build LicenseInfo from state ─────────────────────────────────────

fn info_from_state(state: &LicenseState) -> LicenseInfo {
    let valid = is_license_state_valid(state);
    let (trial_days_remaining, nag_required) = trial_status(state, valid);
    let trial_active = trial_days_remaining > 0;
    LicenseInfo {
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

fn is_status_active(state: &LicenseState) -> bool {
    matches!(state.ls_status.as_str(), "active")
}

fn activation_limit_for_state(state: &LicenseState) -> u32 {
    if state.activations_limit > 0 {
        state.activations_limit
    } else {
        get_tier_activation_limit(&state.tier)
    }
}

fn is_within_activation_limit(state: &LicenseState) -> bool {
    let limit = activation_limit_for_state(state);
    if limit == 0 {
        return false;
    }
    state.activations_usage <= limit
}

pub(crate) fn is_license_state_valid(state: &LicenseState) -> bool {
    if state.key.is_empty() {
        return false;
    }
    if !is_status_active(state) {
        return false;
    }
    if !is_within_activation_limit(state) {
        return false;
    }
    within_grace_period(state)
}

fn trial_status(state: &LicenseState, valid: bool) -> (i64, bool) {
    if valid {
        return (0, false);
    }
    if state.first_run_at.is_empty() {
        return (TRIAL_DAYS, false);
    }
    let Ok(first_run) = chrono::DateTime::parse_from_rfc3339(&state.first_run_at)
        .map(|dt| dt.with_timezone(&chrono::Utc))
    else {
        // Fail closed on malformed trial metadata.
        return (0, true);
    };
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

// ── Public async functions called by the desktop shell ───────────────────────

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
        Err(_) => info_from_state(&state),
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
        get_tier_activation_limit(&state.tier)
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
    if !parsed.valid {
        // Explicit server-side invalidation should immediately fail closed.
        state.last_validated_at.clear();
        if state.ls_status == "active" {
            state.ls_status = "inactive".to_string();
        }
        let _ = persist_state(state);

        let msg = parsed
            .error
            .unwrap_or_else(|| format!("License {}", state.ls_status));
        return Err(msg);
    }

    state.last_validated_at = chrono::Utc::now().to_rfc3339();
    let _ = persist_state(state);

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn unique_test_dir(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("nautilus-license-test-{name}-{suffix}"))
    }

    fn set_test_state_path(path: PathBuf) {
        let override_lock = TEST_STATE_PATH_OVERRIDE.get_or_init(|| Mutex::new(None));
        *override_lock.lock().expect("state path override lock") = Some(path);
    }

    fn clear_test_state_path() {
        let override_lock = TEST_STATE_PATH_OVERRIDE.get_or_init(|| Mutex::new(None));
        *override_lock.lock().expect("state path override lock") = None;
    }

    fn clear_test_secret_store() {
        let store = TEST_SECRET_STORE.get_or_init(|| Mutex::new(HashMap::new()));
        store.lock().expect("test secret store lock").clear();
    }

    fn sample_state(status: &str, validated_days_ago: i64) -> LicenseState {
        let last_validated = chrono::Utc::now() - chrono::Duration::days(validated_days_ago);
        LicenseState {
            key: "license-key".to_string(),
            instance_id: "instance-id".to_string(),
            tier: Tier::Pro,
            ls_status: status.to_string(),
            activations_limit: 5,
            activations_usage: 1,
            last_validated_at: last_validated.to_rfc3339(),
            first_run_at: (chrono::Utc::now() - chrono::Duration::days(40)).to_rfc3339(),
            device_id: "test-device".to_string(),
        }
    }

    #[test]
    fn active_license_is_valid_within_grace_period() {
        let state = sample_state("active", 1);
        assert!(is_license_state_valid(&state));
    }

    #[test]
    fn active_license_is_invalid_after_grace_period() {
        let state = sample_state("active", GRACE_PERIOD_DAYS + 1);
        assert!(!is_license_state_valid(&state));
    }

    #[test]
    fn inactive_license_is_invalid() {
        let state = sample_state("inactive", 1);
        assert!(!is_license_state_valid(&state));
    }

    #[test]
    fn malformed_first_run_timestamp_expires_trial() {
        let state = LicenseState {
            key: String::new(),
            instance_id: String::new(),
            tier: Tier::None,
            ls_status: String::new(),
            activations_limit: 0,
            activations_usage: 0,
            last_validated_at: String::new(),
            first_run_at: "not-a-date".to_string(),
            device_id: "test-device".to_string(),
        };

        let (remaining, nag) = trial_status(&state, false);
        assert_eq!(remaining, 0);
        assert!(nag);
    }

    // ── Entitlement tests ────────────────────────────────────────────────

    fn make_info(valid: bool, trial_active: bool, tier: Tier) -> LicenseInfo {
        LicenseInfo {
            tier,
            valid,
            ls_status: if valid {
                "active".to_string()
            } else {
                String::new()
            },
            activations_limit: 5,
            activations_usage: 1,
            last_validated_at: String::new(),
            trial_days_remaining: if trial_active { 20 } else { 0 },
            nag_required: !valid && !trial_active,
            trial_active,
        }
    }

    #[test]
    fn entitlement_trial_active_grants_pro() {
        let info = make_info(false, true, Tier::None);
        let ent = build_entitlement(&info);
        assert!(ent.trial_active);
        assert!(!ent.license_valid);
        assert!(ent.pro_enabled);
        assert!(!ent.experimental_enabled);
        assert!(ent.can_update);
        assert_eq!(ent.tier, "pro");
    }

    #[test]
    fn entitlement_valid_pro_license() {
        let info = make_info(true, false, Tier::Pro);
        let ent = build_entitlement(&info);
        assert!(!ent.trial_active);
        assert!(ent.license_valid);
        assert!(ent.pro_enabled);
        assert!(!ent.experimental_enabled);
        assert!(ent.can_update);
        assert_eq!(ent.tier, "pro");
    }

    #[test]
    fn entitlement_valid_friends_license() {
        let info = make_info(true, false, Tier::FriendsClub);
        let ent = build_entitlement(&info);
        assert!(ent.pro_enabled);
        assert!(ent.experimental_enabled);
        assert!(ent.can_update);
        assert_eq!(ent.tier, "friends");
    }

    #[test]
    fn entitlement_expired_trial_no_license() {
        let info = make_info(false, false, Tier::None);
        let ent = build_entitlement(&info);
        assert!(!ent.trial_active);
        assert!(!ent.license_valid);
        assert!(!ent.pro_enabled);
        assert!(!ent.experimental_enabled);
        assert!(!ent.can_update);
        assert_eq!(ent.tier, "free");
    }

    #[test]
    fn persist_state_writes_cache_without_secret_fields() {
        let _guard = TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("test lock");
        clear_test_secret_store();

        let dir = unique_test_dir("persist-cache");
        let state_path = dir.join("nautilus_license.json");
        set_test_state_path(state_path.clone());

        let state = LicenseState {
            key: "license-key".to_string(),
            instance_id: "instance-id".to_string(),
            tier: Tier::Pro,
            ls_status: "active".to_string(),
            activations_limit: 5,
            activations_usage: 1,
            last_validated_at: "2026-04-09T12:00:00Z".to_string(),
            first_run_at: "2026-04-01T12:00:00Z".to_string(),
            device_id: "device-123".to_string(),
        };

        persist_state(&state).expect("persist license state");

        let raw = fs::read_to_string(&state_path).expect("read persisted state");
        let json: Value = serde_json::from_str(&raw).expect("parse persisted state");
        assert!(json.get("key").is_none());
        assert!(json.get("instanceId").is_none());
        assert!(json.get("firstRunAt").is_none());
        assert!(json.get("deviceId").is_none());
        assert_eq!(
            secure_secret_get(SECRET_LICENSE_KEY).expect("read key"),
            Some("license-key".to_string())
        );
        assert_eq!(
            secure_secret_get(SECRET_INSTANCE_ID).expect("read instance"),
            Some("instance-id".to_string())
        );
        assert_eq!(
            secure_secret_get(SECRET_FIRST_RUN_AT).expect("read first run"),
            Some("2026-04-01T12:00:00Z".to_string())
        );
        assert_eq!(
            secure_secret_get(SECRET_DEVICE_ID).expect("read device"),
            Some("device-123".to_string())
        );

        clear_test_state_path();
        clear_test_secret_store();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_state_migrates_legacy_plaintext_fields_to_secure_store() {
        let _guard = TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("test lock");
        clear_test_secret_store();

        let dir = unique_test_dir("migrate-legacy");
        fs::create_dir_all(&dir).expect("create test dir");
        let state_path = dir.join("nautilus_license.json");
        set_test_state_path(state_path.clone());

        fs::write(
            &state_path,
            serde_json::json!({
                "key": "legacy-key",
                "instanceId": "legacy-instance",
                "tier": "pro",
                "lsStatus": "active",
                "activationsLimit": 5,
                "activationsUsage": 1,
                "lastValidatedAt": "2026-04-09T12:00:00Z",
                "firstRunAt": "2026-04-01T12:00:00Z",
                "deviceId": "legacy-device"
            })
            .to_string(),
        )
        .expect("write legacy state");

        let state = load_state();

        assert_eq!(state.key, "legacy-key");
        assert_eq!(state.instance_id, "legacy-instance");
        assert_eq!(state.first_run_at, "2026-04-01T12:00:00Z");
        assert_eq!(state.device_id, "legacy-device");
        assert_eq!(
            secure_secret_get(SECRET_LICENSE_KEY).expect("read key"),
            Some("legacy-key".to_string())
        );
        assert_eq!(
            secure_secret_get(SECRET_INSTANCE_ID).expect("read instance"),
            Some("legacy-instance".to_string())
        );

        let raw = fs::read_to_string(&state_path).expect("read migrated state");
        let json: Value = serde_json::from_str(&raw).expect("parse migrated state");
        assert!(json.get("key").is_none());
        assert!(json.get("instanceId").is_none());
        assert!(json.get("firstRunAt").is_none());
        assert!(json.get("deviceId").is_none());
        assert_eq!(json.get("tier").and_then(Value::as_str), Some("pro"));

        clear_test_state_path();
        clear_test_secret_store();
        let _ = fs::remove_dir_all(&dir);
    }
}
