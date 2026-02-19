//! Update Service - Wraps tauri-plugin-updater with entitlement gating

use std::sync::Arc;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;
use lazy_static::lazy_static;

use crate::license::{load_state as load_license_state, LicenseState};
use crate::settings::SettingsManager;

use super::gating;
use super::types::{UpdateChannel, UpdateError, UpdateInfo, UpdateStatus};

lazy_static! {
    static ref CURRENT_CHANNEL: Arc<Mutex<UpdateChannel>> = Arc::new(Mutex::new(UpdateChannel::Stable));
    static ref CURRENT_STATUS: Arc<Mutex<UpdateStatus>> = Arc::new(Mutex::new(UpdateStatus::Unknown));
}

/// Service for checking and installing updates
pub struct UpdateService {
    app_handle: AppHandle,
}

impl UpdateService {
    /// Create a new UpdateService instance
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }
    
    /// Load the update channel from settings
    async fn load_channel_from_settings() -> UpdateChannel {
        if let Ok(settings_manager) = SettingsManager::new() {
            let settings = settings_manager.settings();
            return settings.updates.channel.clone().into();
        }
        UpdateChannel::Stable
    }
    
    /// Save the update channel to settings
    async fn save_channel_to_settings(&self, channel: UpdateChannel) -> Result<(), UpdateError> {
        let mut settings_manager = SettingsManager::new()
            .map_err(|e| UpdateError::InstallFailed(format!("Failed to load settings: {}", e)))?;
        
        settings_manager.settings_mut().updates.channel = channel.into();
        
        settings_manager.save()
            .map_err(|e| UpdateError::InstallFailed(format!("Failed to save settings: {}", e)))?;
        
        Ok(())
    }

    /// Check if updates are currently locked (unlicensed)
    pub async fn are_updates_locked(&self) -> bool {
        let license = load_license_state();
        let channel = Self::load_channel_from_settings().await;
        !gating::can_check_for_updates(&license, channel)
    }

    /// Get the reason why updates are locked (if they are)
    pub async fn get_lock_reason(&self) -> Option<String> {
        let license = load_license_state();
        let channel = Self::load_channel_from_settings().await;
        
        if !gating::can_check_for_updates(&license, channel) {
            Some(gating::get_lock_reason(&license))
        } else {
            None
        }
    }

    /// Get the current update status
    pub async fn get_status(&self) -> UpdateStatus {
        CURRENT_STATUS.lock().await.clone()
    }

    /// Get the current update channel
    pub async fn get_channel(&self) -> UpdateChannel {
        // Always load from settings to ensure consistency
        Self::load_channel_from_settings().await
    }

    /// Set the update channel
    /// 
    /// Returns an error if the user is not entitled to use the requested channel.
    pub async fn set_channel(&self, channel: UpdateChannel) -> Result<(), UpdateError> {
        let license = load_license_state();
        
        // Check if user can use this channel
        if !gating::can_check_for_updates(&license, channel) {
            return Err(UpdateError::NotEntitled);
        }
        
        // Save to settings
        self.save_channel_to_settings(channel).await?;
        
        // Update in-memory cache
        let mut current = CURRENT_CHANNEL.lock().await;
        *current = channel;
        
        Ok(())
    }

    /// Check for available updates
    /// 
    /// This method enforces entitlement checks - it will fail if the user
    /// doesn't have a valid license or active trial.
    /// 
    /// Returns Some(UpdateInfo) if an update is available, None if up to date.
    pub async fn check_for_updates(&self) -> Result<Option<UpdateInfo>, UpdateError> {
        let license = load_license_state();
        let channel = Self::load_channel_from_settings().await;
        
        // Check entitlement
        if !gating::can_check_for_updates(&license, channel) {
            let mut status = CURRENT_STATUS.lock().await;
            *status = UpdateStatus::Locked;
            return Err(UpdateError::NotEntitled);
        }
        
        // Set status to checking
        {
            let mut status = CURRENT_STATUS.lock().await;
            *status = UpdateStatus::Checking;
        }
        
        // Get the updater
        let updater = self.app_handle
            .updater()
            .map_err(|_| UpdateError::NotInitialized)?;
        
        // Check for updates
        match updater.check().await {
            Ok(Some(update)) => {
                let update_info = UpdateInfo {
                    version: update.version,
                    notes: update.body.unwrap_or_else(|| "No release notes available.".to_string()),
                    pub_date: update.date.map(|d| d.to_string()).unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
                    is_beta: channel == UpdateChannel::Beta,
                };
                
                let mut status = CURRENT_STATUS.lock().await;
                *status = UpdateStatus::UpdateAvailable(update_info.clone());
                
                Ok(Some(update_info))
            }
            Ok(None) => {
                let mut status = CURRENT_STATUS.lock().await;
                *status = UpdateStatus::UpToDate;
                Ok(None)
            }
            Err(e) => {
                let error_msg = format!("{}", e);
                let mut status = CURRENT_STATUS.lock().await;
                *status = UpdateStatus::Error(error_msg.clone());
                Err(UpdateError::NetworkFailure(error_msg))
            }
        }
    }

    /// Install an available update
    /// 
    /// This will download and install the update. The app will restart
    /// automatically after installation.
    pub async fn install_update(&self) -> Result<(), UpdateError> {
        let license = load_license_state();
        let channel = Self::load_channel_from_settings().await;
        
        // Re-check entitlement before installing
        if !gating::can_check_for_updates(&license, channel) {
            return Err(UpdateError::NotEntitled);
        }
        
        // Verify we have an update available
        let should_install = {
            let status = CURRENT_STATUS.lock().await;
            matches!(*status, UpdateStatus::UpdateAvailable(_))
        };
        
        if !should_install {
            return Err(UpdateError::InstallFailed("No update available to install".to_string()));
        }
        
        let updater = self.app_handle
            .updater()
            .map_err(|_| UpdateError::NotInitialized)?;
        
        // Check again and install
        match updater.check().await {
            Ok(Some(update)) => {
                // Set downloading status
                {
                    let mut status = CURRENT_STATUS.lock().await;
                    *status = UpdateStatus::Downloading { progress: 0 };
                }
                
                // Download and install
                match update.download_and_install(|_progress, _total| {
                    // Could emit progress events here if needed
                }, || {
                    // Set installing status
                    // Note: This runs in a closure, can't easily access self
                }).await {
                    Ok(_) => {
                        // App will restart automatically
                        Ok(())
                    }
                    Err(e) => {
                        let error_msg = format!("{}", e);
                        let mut status = CURRENT_STATUS.lock().await;
                        *status = UpdateStatus::Error(error_msg.clone());
                        Err(UpdateError::InstallFailed(error_msg))
                    }
                }
            }
            Ok(None) => {
                Err(UpdateError::InstallFailed("Update no longer available".to_string()))
            }
            Err(e) => {
                Err(UpdateError::NetworkFailure(format!("{}", e)))
            }
        }
    }

    /// Check if the user can use the beta channel
    pub async fn can_use_beta(&self) -> bool {
        let license = load_license_state();
        gating::can_use_beta_channel(&license)
    }

    /// Get license state for frontend display
    pub fn get_license_state(&self) -> LicenseState {
        load_license_state()
    }
}


