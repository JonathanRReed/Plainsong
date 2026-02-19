//! Update system types and enums

use serde::{Deserialize, Serialize};

/// Available update channels
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    /// Stable releases for all entitled users
    #[default]
    Stable,
    /// Beta releases for Friends Club tier only
    Beta,
}

impl std::fmt::Display for UpdateChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UpdateChannel::Stable => write!(f, "stable"),
            UpdateChannel::Beta => write!(f, "beta"),
        }
    }
}

impl From<String> for UpdateChannel {
    fn from(s: String) -> Self {
        match s.to_lowercase().as_str() {
            "beta" => UpdateChannel::Beta,
            _ => UpdateChannel::Stable,
        }
    }
}

impl From<crate::settings::UpdateChannel> for UpdateChannel {
    fn from(channel: crate::settings::UpdateChannel) -> Self {
        match channel {
            crate::settings::UpdateChannel::Beta => UpdateChannel::Beta,
            crate::settings::UpdateChannel::Stable => UpdateChannel::Stable,
        }
    }
}

/// Errors that can occur during update operations
#[derive(Debug)]
pub enum UpdateError {
    /// User is not entitled to check for updates (no trial, no valid license)
    NotEntitled,
    /// Network failure during update check
    NetworkFailure(String),
    /// Invalid signature on update package
    InvalidSignature,
    /// Failed to install update
    InstallFailed(String),
    /// Updater not initialized
    NotInitialized,
    /// Update check already in progress
    AlreadyChecking,
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UpdateError::NotEntitled => {
                write!(f, "Updates require a valid license or active trial")
            }
            UpdateError::NetworkFailure(msg) => write!(f, "Network error: {}", msg),
            UpdateError::InvalidSignature => write!(f, "Update signature verification failed"),
            UpdateError::InstallFailed(msg) => write!(f, "Installation failed: {}", msg),
            UpdateError::NotInitialized => write!(f, "Update service not initialized"),
            UpdateError::AlreadyChecking => write!(f, "Update check already in progress"),
        }
    }
}

impl std::error::Error for UpdateError {}

/// Information about an available update
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// New version available
    pub version: String,
    /// Release notes
    pub notes: String,
    /// Publication date (ISO 8601)
    pub pub_date: String,
    /// Whether this is a beta release
    pub is_beta: bool,
}

/// Current update status for the UI
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStatus {
    /// No update check performed yet
    Unknown,
    /// Currently checking for updates
    Checking,
    /// No updates available
    UpToDate,
    /// Update available
    UpdateAvailable(UpdateInfo),
    /// Downloading update
    Downloading { progress: u8 },
    /// Installing update
    Installing,
    /// Update check/install failed
    Error(String),
    /// Updates locked (unlicensed)
    Locked,
}

impl Default for UpdateStatus {
    fn default() -> Self {
        UpdateStatus::Unknown
    }
}
