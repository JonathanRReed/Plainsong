//! Entitlement gating logic for updates
//!
//! Controls when users can check for and receive updates based on their
//! license status and tier.

use super::types::UpdateChannel;
use crate::license::{get_tier_activation_limit, LicenseState, Tier};

/// Check if the user is entitled to check for updates.
///
/// Returns true if:
/// - User has a valid license, OR
/// - User has an active trial (within 30 days of first run)
///
/// For beta channel, additionally requires Friends Club tier.
pub fn can_check_for_updates(license: &LicenseState, channel: UpdateChannel) -> bool {
    // Must have valid license or active trial
    let is_entitled = is_valid_or_trial(license);

    if !is_entitled {
        return false;
    }

    // Beta channel requires Friends Club tier
    if channel == UpdateChannel::Beta {
        return license.tier == Tier::FriendsClub;
    }

    true
}

/// Check if the user has a valid license or active trial
fn is_valid_or_trial(license: &LicenseState) -> bool {
    // Valid license
    if !license.key.is_empty() && is_license_valid(license) {
        return true;
    }

    // Active trial (within 30 days)
    is_trial_active(license)
}

/// Check if the license is valid (active status and within tier limits)
fn is_license_valid(license: &LicenseState) -> bool {
    match license.ls_status.as_str() {
        "active" | "inactive" => {
            // Check if within tier activation limits
            let tier_limit = get_tier_activation_limit(&license.tier);
            license.activations_usage <= tier_limit
        }
        _ => false,
    }
}

/// Check if the trial period is still active
fn is_trial_active(license: &LicenseState) -> bool {
    if license.first_run_at.is_empty() {
        return true; // First run, trial is active
    }

    let first_run = match chrono::DateTime::parse_from_rfc3339(&license.first_run_at) {
        Ok(dt) => dt.with_timezone(&chrono::Utc),
        Err(_) => return false,
    };

    let days_elapsed = (chrono::Utc::now() - first_run).num_days();
    days_elapsed < 30
}

/// Check if the user can use the beta channel specifically
///
/// Returns true only if:
/// - User has Friends Club tier, AND
/// - User has valid license or active trial
pub fn can_use_beta_channel(license: &LicenseState) -> bool {
    license.tier == Tier::FriendsClub && is_valid_or_trial(license)
}

/// Get a human-readable message explaining why updates are locked
pub fn get_lock_reason(license: &LicenseState) -> String {
    if license.key.is_empty() {
        "Updates require a license or active trial. Your 30-day trial has expired.".to_string()
    } else if !is_license_valid(license) {
        format!(
            "Your license is {}. Please renew to receive updates.",
            license.ls_status
        )
    } else {
        "Updates are currently unavailable.".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_state(
        tier: Tier,
        key: &str,
        status: &str,
        first_run_days_ago: i64,
    ) -> LicenseState {
        let first_run = chrono::Utc::now() - chrono::Duration::days(first_run_days_ago);
        LicenseState {
            key: key.to_string(),
            instance_id: "test".to_string(),
            tier,
            ls_status: status.to_string(),
            activations_limit: 5,
            activations_usage: 1,
            last_validated_at: chrono::Utc::now().to_rfc3339(),
            first_run_at: first_run.to_rfc3339(),
            device_id: "test-device".to_string(),
        }
    }

    #[test]
    fn test_active_trial_can_check_stable() {
        let state = create_test_state(Tier::None, "", "", 5); // 5 days into trial
        assert!(can_check_for_updates(&state, UpdateChannel::Stable));
    }

    #[test]
    fn test_expired_trial_cannot_check() {
        let state = create_test_state(Tier::None, "", "", 35); // 35 days, trial expired
        assert!(!can_check_for_updates(&state, UpdateChannel::Stable));
    }

    #[test]
    fn test_basic_license_can_check_stable() {
        let state = create_test_state(Tier::Basic, "key-123", "active", 40);
        assert!(can_check_for_updates(&state, UpdateChannel::Stable));
    }

    #[test]
    fn test_basic_license_cannot_check_beta() {
        let state = create_test_state(Tier::Basic, "key-123", "active", 40);
        assert!(!can_check_for_updates(&state, UpdateChannel::Beta));
    }

    #[test]
    fn test_friends_club_can_check_beta() {
        let state = create_test_state(Tier::FriendsClub, "key-123", "active", 40);
        assert!(can_check_for_updates(&state, UpdateChannel::Beta));
    }

    #[test]
    fn test_inactive_license_cannot_check() {
        let state = create_test_state(Tier::Basic, "key-123", "expired", 40);
        assert!(!can_check_for_updates(&state, UpdateChannel::Stable));
    }
}
