//! Manual backup creation and cloud synchronization.
//!
//! Backups are only created and uploaded in response to explicit commands. The
//! v1 sidecar does not run a scheduler.
//!
//! Supported cloud targets:
//! - iCloud Drive (direct filesystem sync)
//! - Google Drive (rclone remote)
//! - OneDrive (rclone remote)
//! - Proton Drive (rclone remote)

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::ffi::OsStr;
use std::io::Read as _;
use std::path::{Component, Path, PathBuf};
use tokio::process::Command;

const SETTINGS_BACKUP_FILENAME: &str = "settings.json";
const BACKUP_MANIFEST_FILENAME: &str = "manifest.json";
const BACKUP_MANIFEST_FORMAT_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CloudProvider {
    OneDrive,
    GoogleDrive,
    ProtonDrive,
    ICloud,
}

impl CloudProvider {
    fn default_remote_name(&self) -> Option<&'static str> {
        match self {
            CloudProvider::OneDrive => Some("onedrive"),
            CloudProvider::GoogleDrive => Some("gdrive"),
            CloudProvider::ProtonDrive => Some("protondrive"),
            CloudProvider::ICloud => None,
        }
    }
}

/// Backup configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackupConfig {
    /// Legacy scheduler flag. Retained for config compatibility but always
    /// forced off because v1 backups are manual.
    pub enabled: bool,
    /// Legacy scheduler interval. Retained for config compatibility and ignored.
    pub interval_hours: u32,
    /// Maximum number of valid manual backups to keep.
    pub max_backups: u32,
    /// Backup directory path
    pub backup_dir: Option<PathBuf>,
    /// Opaque reference to an Electron-approved backup directory.
    pub backup_location_id: Option<String>,
    /// Safe, non-path label shown to the renderer.
    pub backup_location_label: Option<String>,
    /// Cached UI state. The approved-location registry is authoritative.
    pub backup_location_approved: bool,
    /// Enable explicit, user-triggered cloud uploads.
    pub cloud_sync: bool,
    /// Cloud provider (if cloud sync enabled)
    pub cloud_provider: Option<CloudProvider>,
    /// rclone remote name override for non-iCloud providers
    pub cloud_remote_name: Option<String>,
    /// Folder under provider root where backups are stored
    pub cloud_folder: String,
    /// Optional iCloud path override
    pub icloud_path: Option<PathBuf>,
    /// Opaque reference to an Electron-confirmed cloud destination.
    pub cloud_location_id: Option<String>,
    /// Safe destination label shown to the renderer.
    pub cloud_location_label: Option<String>,
    /// Cached UI state. The approved-location registry is authoritative.
    pub cloud_location_approved: bool,
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_hours: 24,
            max_backups: 7,
            backup_dir: Some(default_backup_dir()),
            backup_location_id: None,
            backup_location_label: None,
            backup_location_approved: false,
            cloud_sync: false,
            cloud_provider: None,
            cloud_remote_name: None,
            cloud_folder: "PlainsongBackups".to_string(),
            icloud_path: None,
            cloud_location_id: None,
            cloud_location_label: None,
            cloud_location_approved: false,
        }
    }
}

/// Backup metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    /// Backup ID
    pub id: String,
    /// Timestamp when backup was created
    pub timestamp: DateTime<Utc>,
    /// Size in bytes
    pub size_bytes: u64,
    /// Items backed up
    pub items_count: u32,
    /// Backup type
    pub backup_type: BackupType,
}

/// Backup type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BackupType {
    /// Full backup of everything
    Full,
    /// Incremental backup (changes only)
    Incremental,
    /// Settings only
    Settings,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
enum BackupComponent {
    Database,
    Recordings,
    Settings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct BackupFileInventory {
    path: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum BackupDatabaseProtection {
    PortablePlaintext,
    VaultKeyRequired,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RecordingPathFormat {
    RelativeManagedV1,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    format_version: u32,
    complete: bool,
    id: String,
    timestamp: DateTime<Utc>,
    backup_type: BackupType,
    components: Vec<BackupComponent>,
    files: Vec<BackupFileInventory>,
    database_protection: Option<BackupDatabaseProtection>,
    recording_path_format: Option<RecordingPathFormat>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackupRestoreOutcome {
    pub restored_database: bool,
    pub restored_recordings: bool,
    pub restored_settings: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SetupCheckStatus {
    Pass,
    Fail,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSetupCheck {
    pub id: String,
    pub label: String,
    pub status: SetupCheckStatus,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSetupReport {
    pub provider: Option<CloudProvider>,
    pub ready: bool,
    pub checks: Vec<CloudSetupCheck>,
    pub checked_at: DateTime<Utc>,
}

/// Backup manager
pub struct BackupManager {
    config: BackupConfig,
}

impl BackupManager {
    /// Create new backup manager
    pub fn new(mut config: BackupConfig) -> Self {
        if config.backup_dir.is_none() {
            config.backup_dir = Some(default_backup_dir());
        }
        if config.backup_location_id.is_none()
            && config.backup_dir.as_ref() == Some(&default_backup_dir())
        {
            config.backup_location_id =
                Some(crate::approved_locations::BUILTIN_BACKUP_LOCATION_ID.to_string());
            config.backup_location_label = Some("Plainsong backups".to_string());
            config.backup_location_approved = true;
        }
        #[cfg(test)]
        if config.backup_location_id.is_none()
            && config
                .backup_dir
                .as_ref()
                .is_some_and(|path| path.starts_with(std::env::temp_dir()))
        {
            config.backup_location_id = Some("test-approved-backup-location".to_string());
            config.backup_location_label = Some("Test backups".to_string());
            config.backup_location_approved = true;
        }
        config.enabled = false;
        config.max_backups = config.max_backups.max(1);
        Self { config }
    }

    #[cfg(test)]
    pub fn config(&self) -> &BackupConfig {
        &self.config
    }

    pub fn set_config(&mut self, mut config: BackupConfig) -> Result<()> {
        if config.backup_dir.is_none() {
            config.backup_dir = Some(default_backup_dir());
        }
        config.enabled = false;
        config.max_backups = config.max_backups.max(1);
        self.config = config;
        self.persist_config()?;
        Ok(())
    }

    /// Save renderer-editable backup preferences without accepting authority
    /// over a filesystem or cloud destination from renderer JSON.
    pub fn set_config_from_renderer(&mut self, mut config: BackupConfig) -> Result<()> {
        config.backup_dir = self.config.backup_dir.clone();
        config.backup_location_id = self.config.backup_location_id.clone();
        config.backup_location_label = self.config.backup_location_label.clone();
        config.backup_location_approved = self.config.backup_location_approved;
        config.cloud_provider = self.config.cloud_provider.clone();
        config.cloud_remote_name = self.config.cloud_remote_name.clone();
        config.cloud_folder = self.config.cloud_folder.clone();
        config.icloud_path = self.config.icloud_path.clone();
        config.cloud_location_id = self.config.cloud_location_id.clone();
        config.cloud_location_label = self.config.cloud_location_label.clone();
        config.cloud_location_approved = self.config.cloud_location_approved;
        self.set_config(config)
    }

    pub fn set_backup_location_privileged(
        &mut self,
        summary: &crate::approved_locations::ApprovedLocationSummary,
        canonical_path: PathBuf,
    ) -> Result<()> {
        self.config.backup_dir = Some(canonical_path);
        self.config.backup_location_id = Some(summary.id.clone());
        self.config.backup_location_label = Some(summary.label.clone());
        self.config.backup_location_approved = summary.approved;
        self.persist_config()
    }

    pub fn set_cloud_location_privileged(
        &mut self,
        provider: CloudProvider,
        summary: &crate::approved_locations::ApprovedLocationSummary,
        remote_name: Option<String>,
        cloud_folder: String,
        icloud_path: Option<PathBuf>,
    ) -> Result<()> {
        self.config.cloud_provider = Some(provider);
        self.config.cloud_remote_name = remote_name;
        self.config.cloud_folder = cloud_folder;
        self.config.icloud_path = icloud_path;
        self.config.cloud_location_id = Some(summary.id.clone());
        self.config.cloud_location_label = Some(summary.label.clone());
        self.config.cloud_location_approved = summary.approved;
        self.persist_config()
    }

    pub fn config_for_renderer(&self) -> BackupConfig {
        let mut visible = self.config.clone();
        visible.backup_dir = None;
        visible.cloud_remote_name = None;
        visible.icloud_path = None;
        visible
    }

    fn resolved_backup_dir(&self) -> Result<PathBuf> {
        let id = self
            .config
            .backup_location_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("Backup folder needs reselection in Settings"))?;
        #[cfg(test)]
        if id == "test-approved-backup-location" {
            return self
                .config
                .backup_dir
                .clone()
                .ok_or_else(|| anyhow::anyhow!("Test backup directory is missing"));
        }
        crate::approved_locations::registry()?.resolve_filesystem(
            id,
            crate::approved_locations::ApprovedLocationPurpose::Backup,
        )
    }

    fn resolved_cloud_config(&self) -> Result<BackupConfig> {
        let id =
            self.config.cloud_location_id.as_deref().ok_or_else(|| {
                anyhow::anyhow!("Cloud destination needs confirmation in Settings")
            })?;
        let provider = self
            .config
            .cloud_provider
            .clone()
            .ok_or_else(|| anyhow::anyhow!("No cloud provider configured"))?;
        let mut resolved = self.config.clone();
        match provider {
            CloudProvider::ICloud => {
                resolved.icloud_path =
                    Some(crate::approved_locations::registry()?.resolve_filesystem(
                        id,
                        crate::approved_locations::ApprovedLocationPurpose::CloudBackup,
                    )?);
            }
            CloudProvider::GoogleDrive | CloudProvider::OneDrive | CloudProvider::ProtonDrive => {
                let (remote_name, folder) =
                    crate::approved_locations::registry()?.resolve_rclone(id)?;
                resolved.cloud_remote_name = Some(remote_name);
                resolved.cloud_folder = folder;
            }
        }
        Ok(resolved)
    }

    /// Create a full data backup now. If the live database exists, `db_snapshot`
    /// must be a separate, non-empty `VACUUM INTO` snapshot. The live SQLite
    /// file is never copied as a fallback.
    pub async fn create_backup(
        &self,
        data_dir: &Path,
        db_snapshot: Option<&Path>,
    ) -> Result<BackupInfo> {
        let settings_path = crate::settings::settings_file_path()?;
        self.create_backup_with_sources(data_dir, &settings_path, BackupType::Full, db_snapshot)
            .await
    }

    /// Create a settings-only snapshot for manual migration or cloud upload.
    pub async fn create_settings_backup(&self, data_dir: &Path) -> Result<BackupInfo> {
        let settings_path = crate::settings::settings_file_path()?;
        self.create_backup_with_sources(data_dir, &settings_path, BackupType::Settings, None)
            .await
    }

    async fn create_backup_with_sources(
        &self,
        data_dir: &Path,
        settings_path: &Path,
        backup_type: BackupType,
        db_snapshot: Option<&Path>,
    ) -> Result<BackupInfo> {
        let backup_dir = self.resolved_backup_dir()?;
        crate::safe_fs::ensure_directory_without_links(&backup_dir)
            .context("Backup destination contains a linked or invalid directory component")?;

        let database_source = if matches!(backup_type, BackupType::Full | BackupType::Incremental) {
            validated_database_snapshot(data_dir, db_snapshot).await?
        } else {
            None
        };

        let timestamp = Utc::now();
        let backup_prefix = match backup_type {
            BackupType::Full => "backup",
            BackupType::Incremental => "incremental",
            BackupType::Settings => "settings",
        };
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let backup_id = format!(
            "{}_{}_{}",
            backup_prefix,
            timestamp.format("%Y%m%d_%H%M%S"),
            &nonce[..8]
        );
        let backup_path = backup_dir.join(&backup_id);
        let partial_path = backup_dir.join(format!(".{}.partial-{}", backup_id, &nonce[8..16]));
        crate::safe_fs::ensure_directory_without_links(&partial_path).with_context(|| {
            format!(
                "Failed to create partial backup generation {} without following links",
                partial_path.display()
            )
        })?;

        let build_result = async {
            let mut components = Vec::new();

            if matches!(backup_type, BackupType::Full | BackupType::Incremental) {
                if let Some(db_source) = database_source.as_ref() {
                    let backup_database = partial_path.join("plainsong.db");
                    copy_regular_file_without_links(db_source, &backup_database)
                        .await
                        .context("Failed to copy the database snapshot into the backup")?;
                    prepare_database_for_portable_backup(
                        &backup_database,
                        &data_dir.join("recordings"),
                    )
                    .await?;
                    components.push(BackupComponent::Database);
                }

                let recordings_dir = data_dir.join("recordings");
                match tokio::fs::symlink_metadata(&recordings_dir).await {
                    Ok(metadata) if metadata.file_type().is_dir() => {
                        copy_dir_recursive(&recordings_dir, &partial_path.join("recordings"))
                            .await
                            .context("Failed to copy recordings into the backup")?;
                        components.push(BackupComponent::Recordings);
                    }
                    Ok(_) => {
                        return Err(anyhow::anyhow!(
                            "Recordings source must be a real directory, not a file or symlink: {}",
                            recordings_dir.display()
                        ));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(error).with_context(|| {
                            format!(
                                "Failed to inspect recordings source {}",
                                recordings_dir.display()
                            )
                        });
                    }
                }
            }

            if settings_path.is_file() {
                copy_regular_file_without_links(
                    settings_path,
                    &partial_path.join(SETTINGS_BACKUP_FILENAME),
                )
                .await
                .context("Failed to copy settings into the backup")?;
                components.push(BackupComponent::Settings);
            }

            if components.is_empty() {
                return Err(anyhow::anyhow!(
                    "Cannot create backup because no backup components were found"
                ));
            }

            write_backup_manifest(
                &partial_path,
                &backup_id,
                timestamp,
                backup_type.clone(),
                &components,
            )
            .await?;
            validate_complete_backup(&partial_path, Some(&backup_id)).await?;
            sync_backup_tree(&partial_path).await?;

            let size_bytes = calculate_dir_size(&partial_path).await?;
            let items_count = count_dir_items(&partial_path).await?;

            // The hidden generation and its visible destination are siblings under
            // `backup_dir`, so publication never relies on a cross-filesystem move.
            // Refuse to replace anything already at the destination even though the
            // random nonce makes a collision exceptionally unlikely.
            match tokio::fs::symlink_metadata(&backup_path).await {
                Ok(_) => {
                    return Err(anyhow::anyhow!(
                        "Refusing to replace pre-existing backup generation {}",
                        backup_path.display()
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!(
                            "Failed to inspect backup publication target {}",
                            backup_path.display()
                        )
                    });
                }
            }

            crate::safe_fs::ensure_directory_without_links(&backup_dir).with_context(|| {
                format!(
                    "Backup destination changed before publication: {}",
                    backup_dir.display()
                )
            })?;
            crate::safe_fs::publish_directory_without_replacement(&partial_path, &backup_path)
                .with_context(|| {
                    format!(
                        "Failed to atomically publish backup {}",
                        backup_path.display()
                    )
                })?;

            Ok::<_, anyhow::Error>((size_bytes, items_count))
        }
        .await;

        let (size_bytes, items_count) = match build_result {
            Ok(result) => result,
            Err(error) => {
                if let Err(cleanup_error) = remove_path_if_exists(&partial_path).await {
                    tracing::warn!(
                        "Failed to remove partial backup generation {}: {}",
                        partial_path.display(),
                        cleanup_error
                    );
                }
                return Err(error);
            }
        };

        if let Err(error) = self.clean_old_backups().await {
            tracing::warn!(
                "Backup retention cleanup failed after publication: {}",
                error
            );
        }

        let info = BackupInfo {
            id: backup_id,
            timestamp,
            size_bytes,
            items_count,
            backup_type,
        };

        tracing::info!("Backup created: {} ({} bytes)", info.id, info.size_bytes);
        Ok(info)
    }

    /// Restore a complete, validated backup generation.
    pub async fn restore_backup(
        &self,
        backup_id: &str,
        data_dir: &Path,
    ) -> Result<BackupRestoreOutcome> {
        let settings_path = crate::settings::settings_file_path()?;
        self.restore_backup_to_targets(backup_id, data_dir, &settings_path)
            .await
    }

    async fn restore_backup_to_targets(
        &self,
        backup_id: &str,
        data_dir: &Path,
        settings_path: &Path,
    ) -> Result<BackupRestoreOutcome> {
        let backup_dir = self.resolved_backup_dir()?;
        let backup_path = resolve_existing_backup_path(&backup_dir, backup_id)?;
        let manifest = validate_complete_backup(&backup_path, Some(backup_id)).await?;
        if manifest.database_protection == Some(BackupDatabaseProtection::VaultKeyRequired) {
            return Err(anyhow::anyhow!(
                "This backup contains a vault-encrypted database whose Keychain-only key was not included. Portable vault restore is unsupported in v1, and no live data was changed."
            ));
        }
        let live_database = data_dir.join("plainsong.db");
        if manifest.components.contains(&BackupComponent::Database)
            && live_database.is_file()
            && classify_database_protection(&live_database).await?
                == BackupDatabaseProtection::VaultKeyRequired
        {
            return Err(anyhow::anyhow!(
                "Restoring a portable database over a vault-encrypted live database is unsupported in v1. The live vault and its Keychain key were left unchanged."
            ));
        }

        restore_backup_into_targets(
            &backup_path,
            data_dir,
            settings_path,
            &manifest.components,
            &manifest.files,
            manifest.recording_path_format,
        )
        .await?;

        let outcome = BackupRestoreOutcome {
            restored_database: manifest.components.contains(&BackupComponent::Database),
            restored_recordings: manifest.components.contains(&BackupComponent::Recordings),
            restored_settings: manifest.components.contains(&BackupComponent::Settings),
        };
        tracing::info!("Backup restored: {}", backup_id);
        Ok(outcome)
    }

    /// List only complete, validated, visible backup generations.
    pub async fn list_backups(&self) -> Result<Vec<BackupInfo>> {
        let backup_dir = self.resolved_backup_dir()?;

        if !backup_dir.exists() {
            return Ok(Vec::new());
        }

        let mut backups = Vec::new();
        let mut entries = tokio::fs::read_dir(&backup_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let Some(backup_id) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if backup_id.starts_with('.') {
                continue;
            }
            match tokio::fs::symlink_metadata(&path).await {
                Ok(metadata) if metadata.file_type().is_dir() => {}
                Ok(_) => continue,
                Err(error) => {
                    tracing::warn!(
                        "Failed to inspect backup candidate {}: {}",
                        path.display(),
                        error
                    );
                    continue;
                }
            }

            let manifest = match validate_complete_backup(&path, Some(backup_id)).await {
                Ok(manifest) => manifest,
                Err(error) => {
                    tracing::warn!(
                        "Ignoring incomplete or invalid backup generation {}: {}",
                        path.display(),
                        error
                    );
                    continue;
                }
            };
            let size_bytes = calculate_dir_size(&path).await?;
            let items_count = count_dir_items(&path).await?;
            backups.push(BackupInfo {
                id: backup_id.to_string(),
                timestamp: manifest.timestamp,
                size_bytes,
                items_count,
                backup_type: manifest.backup_type,
            });
        }

        backups.sort_by_key(|backup| std::cmp::Reverse(backup.timestamp));
        Ok(backups)
    }

    /// Clean old backups keeping only max_backups
    async fn clean_old_backups(&self) -> Result<()> {
        let backups = self.list_backups().await?;
        if backups.len() <= self.config.max_backups as usize {
            return Ok(());
        }

        let backup_dir = self.resolved_backup_dir()?;
        let to_delete = &backups[self.config.max_backups as usize..];

        for backup in to_delete {
            let path = backup_dir.join(&backup.id);
            if let Err(e) = tokio::fs::remove_dir_all(&path).await {
                tracing::warn!("Failed to delete old backup {}: {}", backup.id, e);
            } else {
                tracing::info!("Deleted old backup: {}", backup.id);
            }
        }
        Ok(())
    }

    /// Export backup to external path as zip archive.
    pub async fn export_backup(&self, backup_id: &str, target_path: &Path) -> Result<()> {
        let backup_dir = self.resolved_backup_dir()?;

        let safe_backup_id = validate_backup_id(backup_id)?;
        let source = resolve_existing_backup_path(&backup_dir, &safe_backup_id)?;
        validate_complete_backup(&source, Some(&safe_backup_id)).await?;

        let zip_path = target_path.join(format!("{}.zip", safe_backup_id));
        create_zip_archive(&source, &zip_path).await?;
        tracing::info!("Backup exported to: {:?}", zip_path);
        Ok(())
    }

    /// Run provider-specific setup checks for cloud backup readiness.
    pub async fn cloud_setup_report(&self) -> CloudSetupReport {
        let mut checks = Vec::new();

        if self.config.cloud_sync {
            checks.push(pass_check(
                "cloud_sync_enabled",
                "Manual cloud sync enabled",
                "Explicit cloud uploads are enabled.",
            ));
        } else {
            checks.push(fail_check(
                "cloud_sync_enabled",
                "Manual cloud sync enabled",
                "Manual cloud uploads are disabled in backup settings.",
            ));
        }

        match self.resolved_backup_dir() {
            Ok(dir) => match tokio::fs::create_dir_all(&dir).await {
                Ok(_) => checks.push(pass_check(
                    "backup_dir_access",
                    "Backup directory access",
                    &format!("Backup directory is writable: {}", dir.display()),
                )),
                Err(e) => checks.push(fail_check(
                    "backup_dir_access",
                    "Backup directory access",
                    &format!("Backup directory is not writable: {}", e),
                )),
            },
            Err(error) => checks.push(fail_check(
                "backup_dir_access",
                "Backup directory access",
                &error.to_string(),
            )),
        }

        let provider = self.config.cloud_provider.clone();
        let Some(provider_value) = provider.as_ref() else {
            checks.push(fail_check(
                "provider_selected",
                "Cloud storage service selected",
                "No cloud storage service is chosen, so there is nowhere to upload to.",
            ));
            let ready = checks
                .iter()
                .all(|check| check.status == SetupCheckStatus::Pass);
            return CloudSetupReport {
                provider,
                ready,
                checks,
                checked_at: Utc::now(),
            };
        };

        let resolved_cloud = match self.resolved_cloud_config() {
            Ok(config) => {
                checks.push(pass_check(
                    "cloud_destination_approved",
                    "Cloud destination approved",
                    "The destination was confirmed in a native dialog.",
                ));
                config
            }
            Err(error) => {
                checks.push(fail_check(
                    "cloud_destination_approved",
                    "Cloud destination approved",
                    &error.to_string(),
                ));
                return CloudSetupReport {
                    provider,
                    ready: false,
                    checks,
                    checked_at: Utc::now(),
                };
            }
        };

        checks.push(pass_check(
            "provider_selected",
            "Cloud storage service selected",
            &format!("Uploads go to {:?}", provider_value),
        ));

        match validate_cloud_folder(&resolved_cloud.cloud_folder) {
            Ok(cloud_folder) => checks.push(pass_check(
                "cloud_folder",
                "Cloud folder configured",
                &format!("Cloud folder: {}", cloud_folder),
            )),
            Err(err) => checks.push(fail_check(
                "cloud_folder",
                "Cloud folder configured",
                &err.to_string(),
            )),
        }

        match provider_value {
            CloudProvider::ICloud => match resolve_icloud_root(resolved_cloud.icloud_path.as_ref())
            {
                Ok(path) => {
                    checks.push(pass_check(
                        "icloud_path_resolved",
                        "iCloud path resolved",
                        &format!("Resolved iCloud path: {}", path.display()),
                    ));

                    if path.exists() {
                        checks.push(pass_check(
                            "icloud_path_exists",
                            "iCloud path exists",
                            &format!("iCloud path exists: {}", path.display()),
                        ));
                    } else {
                        checks.push(fail_check(
                            "icloud_path_exists",
                            "iCloud path exists",
                            &format!("iCloud path does not exist: {}", path.display()),
                        ));
                    }

                    if path.exists() {
                        let probe_file =
                            path.join(format!(".nautilus-write-probe-{}", std::process::id()));
                        match tokio::fs::write(&probe_file, b"ok").await {
                            Ok(_) => {
                                let _ = tokio::fs::remove_file(&probe_file).await;
                                checks.push(pass_check(
                                    "icloud_write_access",
                                    "iCloud write access",
                                    "Successfully wrote and removed a probe file.",
                                ));
                            }
                            Err(e) => checks.push(fail_check(
                                "icloud_write_access",
                                "iCloud write access",
                                &format!("Cannot write to iCloud path: {}", e),
                            )),
                        }
                    }
                }
                Err(e) => checks.push(fail_check(
                    "icloud_path_resolved",
                    "iCloud path resolved",
                    &e.to_string(),
                )),
            },
            CloudProvider::GoogleDrive | CloudProvider::OneDrive | CloudProvider::ProtonDrive => {
                match rclone_version().await {
                    Ok(version) => checks.push(pass_check(
                        "rclone_installed",
                        "rclone installed",
                        &format!("Detected {}", version),
                    )),
                    Err(message) => {
                        checks.push(fail_check("rclone_installed", "rclone installed", &message))
                    }
                }

                let remote = resolved_cloud.cloud_remote_name.clone().or_else(|| {
                    provider_value
                        .default_remote_name()
                        .map(ToString::to_string)
                });
                if let Some(remote_name) = remote.as_ref() {
                    checks.push(pass_check(
                        "rclone_remote_configured",
                        "rclone remote configured",
                        &format!("Configured remote: {}", remote_name),
                    ));

                    match list_rclone_remotes().await {
                        Ok(remotes) => {
                            let key = format!("{}:", remote_name.trim_end_matches(':'));
                            if remotes.iter().any(|entry| entry.trim() == key) {
                                checks.push(pass_check(
                                    "rclone_remote_exists",
                                    "rclone remote exists",
                                    &format!("Remote '{}' exists in rclone config.", remote_name),
                                ));
                            } else {
                                checks.push(fail_check(
                                    "rclone_remote_exists",
                                    "rclone remote exists",
                                    &format!(
                                        "Remote '{}' not found. Run `rclone config` first.",
                                        remote_name
                                    ),
                                ));
                            }
                        }
                        Err(message) => checks.push(fail_check(
                            "rclone_remote_exists",
                            "rclone remote exists",
                            &message,
                        )),
                    }
                } else {
                    checks.push(fail_check(
                        "rclone_remote_configured",
                        "rclone remote configured",
                        "No rclone remote configured.",
                    ));
                }
            }
        }

        let ready = checks
            .iter()
            .all(|check| check.status == SetupCheckStatus::Pass);

        CloudSetupReport {
            provider,
            ready,
            checks,
            checked_at: Utc::now(),
        }
    }

    /// Validate cloud configuration and target availability.
    pub async fn verify_cloud_connection(&self) -> Result<()> {
        let report = self.cloud_setup_report().await;
        if report.ready {
            Ok(())
        } else {
            let failures: Vec<String> = report
                .checks
                .iter()
                .filter(|check| check.status == SetupCheckStatus::Fail)
                .map(|check| format!("{}: {}", check.label, check.message))
                .collect();
            Err(anyhow::anyhow!(
                "Cloud setup verification failed: {}",
                failures.join("; ")
            ))
        }
    }

    /// Sync a backup directory to configured cloud provider.
    pub async fn sync_backup_to_cloud(&self, backup_id: &str) -> Result<()> {
        if !self.config.cloud_sync {
            return Err(anyhow::anyhow!("Manual cloud sync is disabled"));
        }
        let resolved_cloud = self.resolved_cloud_config()?;
        let provider = resolved_cloud
            .cloud_provider
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No cloud provider configured"))?;
        let backup_dir = self.resolved_backup_dir()?;
        let source = resolve_existing_backup_path(&backup_dir, backup_id)?;
        validate_complete_backup(&source, Some(backup_id)).await?;

        match provider {
            CloudProvider::ICloud => sync_to_icloud(&resolved_cloud, &source).await,
            CloudProvider::GoogleDrive | CloudProvider::OneDrive | CloudProvider::ProtonDrive => {
                sync_to_rclone(provider, &resolved_cloud, &source).await
            }
        }
    }

    fn persist_config(&self) -> Result<()> {
        let config_path = backup_config_path()?;
        if let Some(parent) = config_path.parent() {
            crate::safe_fs::ensure_directory_without_links(parent)?;
        }
        let mut json = serde_json::to_vec_pretty(&self.config)?;
        json.push(b'\n');
        crate::safe_fs::atomic_write(&config_path, &json)
            .context("Failed to persist backup configuration atomically")
    }
}

async fn validated_database_snapshot(
    data_dir: &Path,
    db_snapshot: Option<&Path>,
) -> Result<Option<PathBuf>> {
    let live_database = data_dir.join("plainsong.db");
    let live_database_exists = live_database.is_file();

    let Some(snapshot) = db_snapshot else {
        if live_database_exists {
            return Err(anyhow::anyhow!(
                "Cannot create a full backup: the live database exists but no VACUUM INTO snapshot was supplied"
            ));
        }
        return Ok(None);
    };

    let snapshot_metadata = tokio::fs::symlink_metadata(snapshot)
        .await
        .with_context(|| format!("Database snapshot does not exist: {}", snapshot.display()))?;
    if !snapshot_metadata.file_type().is_file() || snapshot_metadata.len() == 0 {
        return Err(anyhow::anyhow!(
            "Database snapshot is not a non-empty regular file: {}",
            snapshot.display()
        ));
    }

    if live_database_exists {
        let canonical_live = tokio::fs::canonicalize(&live_database)
            .await
            .with_context(|| {
                format!(
                    "Failed to resolve live database {}",
                    live_database.display()
                )
            })?;
        let canonical_snapshot = tokio::fs::canonicalize(snapshot).await.with_context(|| {
            format!("Failed to resolve database snapshot {}", snapshot.display())
        })?;
        if canonical_snapshot == canonical_live {
            return Err(anyhow::anyhow!(
                "The live SQLite file cannot be used as its own backup snapshot"
            ));
        }
    }

    Ok(Some(snapshot.to_path_buf()))
}

impl Default for BackupManager {
    fn default() -> Self {
        let config = match load_persisted_backup_config() {
            Ok(Some(config)) => config,
            Ok(None) => BackupConfig::default(),
            Err(error) => {
                tracing::error!("Backup configuration could not be loaded: {error:#}");
                BackupConfig::default()
            }
        };
        Self::new(config)
    }
}

fn default_data_dir() -> PathBuf {
    crate::paths::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Plainsong")
}

pub(crate) fn default_backup_dir() -> PathBuf {
    default_data_dir().join("backups")
}

fn backup_config_path() -> Result<PathBuf> {
    let config_dir = crate::paths::config_dir()
        .ok_or_else(|| anyhow::anyhow!("Could not determine config directory"))?
        .join("Plainsong");
    Ok(config_dir.join("backup-config.json"))
}

fn load_backup_config_from_path(path: &Path) -> Result<Option<BackupConfig>> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Failed to read backup configuration {}", path.display()))
        }
    };
    serde_json::from_str::<BackupConfig>(&raw)
        .with_context(|| format!("Failed to parse backup configuration {}", path.display()))
        .map(Some)
}

fn load_persisted_backup_config() -> Result<Option<BackupConfig>> {
    load_backup_config_from_path(&backup_config_path()?)
}

fn validate_backup_id(raw_backup_id: &str) -> Result<String> {
    let backup_id = raw_backup_id.trim();
    if backup_id.is_empty() {
        return Err(anyhow::anyhow!("Backup ID cannot be empty"));
    }
    if backup_id.len() > 128 {
        return Err(anyhow::anyhow!("Backup ID is too long"));
    }
    if backup_id.contains('/') || backup_id.contains('\\') || backup_id.contains("..") {
        return Err(anyhow::anyhow!(
            "Backup ID contains invalid path characters"
        ));
    }
    if !backup_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(anyhow::anyhow!("Backup ID contains unsupported characters"));
    }

    Ok(backup_id.to_string())
}

fn resolve_existing_backup_path(backup_dir: &Path, backup_id: &str) -> Result<PathBuf> {
    let safe_backup_id = validate_backup_id(backup_id)?;
    let canonical_root = backup_dir.canonicalize().with_context(|| {
        format!(
            "Failed to resolve backup directory {}",
            backup_dir.display()
        )
    })?;

    let candidate = canonical_root.join(&safe_backup_id);
    let candidate_metadata = std::fs::symlink_metadata(&candidate)
        .with_context(|| format!("Backup not found: {}", safe_backup_id))?;
    if !candidate_metadata.file_type().is_dir() {
        return Err(anyhow::anyhow!(
            "Backup is not a visible backup directory: {}",
            safe_backup_id
        ));
    }

    let canonical_candidate = candidate
        .canonicalize()
        .with_context(|| format!("Failed to resolve backup path {}", candidate.display()))?;
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(anyhow::anyhow!(
            "Backup path is outside the configured backup directory"
        ));
    }

    Ok(canonical_candidate)
}

fn validate_cloud_folder(raw_folder: &str) -> Result<String> {
    let folder = raw_folder.trim().trim_matches('/');
    if folder.is_empty() {
        return Err(anyhow::anyhow!("Cloud folder cannot be empty"));
    }

    if folder
        .split('/')
        .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
    {
        return Err(anyhow::anyhow!(
            "Cloud folder cannot contain relative path segments"
        ));
    }

    if folder.chars().any(|c| {
        matches!(
            c,
            ':' | ';'
                | '&'
                | '|'
                | '`'
                | '$'
                | '('
                | ')'
                | '{'
                | '}'
                | '\''
                | '"'
                | '\\'
                | '\n'
                | '\r'
        )
    }) {
        return Err(anyhow::anyhow!(
            "Cloud folder contains unsupported characters"
        ));
    }

    Ok(folder.to_string())
}

#[derive(Debug, Clone, Copy)]
enum RestorePathKind {
    File,
    Directory,
}

#[derive(Debug, Clone)]
struct RestoreUnit {
    component: BackupComponent,
    source_path: PathBuf,
    live_path: PathBuf,
    staged_path: PathBuf,
    rollback_path: PathBuf,
    path_kind: RestorePathKind,
}

fn backup_manifest_path(backup_path: &Path) -> PathBuf {
    backup_path.join(BACKUP_MANIFEST_FILENAME)
}

async fn write_backup_manifest(
    backup_path: &Path,
    backup_id: &str,
    timestamp: DateTime<Utc>,
    backup_type: BackupType,
    components: &[BackupComponent],
) -> Result<()> {
    let database_protection = if components.contains(&BackupComponent::Database) {
        Some(classify_database_protection(&backup_path.join("plainsong.db")).await?)
    } else {
        None
    };
    let recording_path_format = match database_protection {
        Some(BackupDatabaseProtection::PortablePlaintext) => {
            Some(RecordingPathFormat::RelativeManagedV1)
        }
        _ => None,
    };
    let files = build_file_inventory(backup_path).await?;
    let manifest = BackupManifest {
        format_version: BACKUP_MANIFEST_FORMAT_VERSION,
        complete: true,
        id: backup_id.to_string(),
        timestamp,
        backup_type,
        components: components.to_vec(),
        files,
        database_protection,
        recording_path_format,
    };
    let manifest_json =
        serde_json::to_string_pretty(&manifest).context("Failed to serialize backup manifest")?;
    let manifest_path = backup_manifest_path(backup_path);
    tokio::task::spawn_blocking(move || {
        crate::safe_fs::atomic_write(&manifest_path, manifest_json.as_bytes())
    })
    .await
    .context("Failed to join backup-manifest writer")??;
    Ok(())
}

async fn read_backup_manifest(backup_path: &Path) -> Result<BackupManifest> {
    let manifest_path = backup_manifest_path(backup_path);
    let metadata = tokio::fs::symlink_metadata(&manifest_path)
        .await
        .with_context(|| {
            format!(
                "Backup manifest is missing or unreadable: {}",
                manifest_path.display()
            )
        })?;
    if !metadata.file_type().is_file() || metadata.len() == 0 {
        return Err(anyhow::anyhow!(
            "Backup manifest is not a non-empty regular file: {}",
            manifest_path.display()
        ));
    }

    let raw = tokio::fs::read_to_string(&manifest_path)
        .await
        .with_context(|| {
            format!(
                "Backup manifest is missing or unreadable: {}",
                manifest_path.display()
            )
        })?;
    serde_json::from_str(&raw).context("Failed to parse backup manifest")
}

fn backup_type_id_prefix(backup_type: &BackupType) -> &'static str {
    match backup_type {
        BackupType::Full => "backup_",
        BackupType::Incremental => "incremental_",
        BackupType::Settings => "settings_",
    }
}

fn component_file_name(component: BackupComponent) -> &'static str {
    match component {
        BackupComponent::Database => "plainsong.db",
        BackupComponent::Recordings => "recordings",
        BackupComponent::Settings => SETTINGS_BACKUP_FILENAME,
    }
}

fn component_path(backup_path: &Path, component: BackupComponent) -> PathBuf {
    backup_path.join(component_file_name(component))
}

async fn classify_database_protection(path: &Path) -> Result<BackupDatabaseProtection> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut file = std::fs::File::open(&path)
            .with_context(|| format!("Failed to inspect database backup {}", path.display()))?;
        let mut header = [0u8; 16];
        let bytes_read = file.read(&mut header)?;
        if bytes_read == header.len() && &header == b"SQLite format 3\0" {
            Ok(BackupDatabaseProtection::PortablePlaintext)
        } else {
            // SQLCipher intentionally randomizes the SQLite header. Treat every
            // non-plaintext database conservatively as vault-protected so a
            // corrupt or encrypted file is never swapped into live state.
            Ok(BackupDatabaseProtection::VaultKeyRequired)
        }
    })
    .await
    .context("Failed to join database protection inspection")?
}

fn build_file_inventory_entry(path: &Path, relative: String) -> Result<BackupFileInventory> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("Failed to inspect inventory file {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        anyhow::bail!(
            "Backup inventory refuses non-regular file {}",
            path.display()
        );
    }

    let mut file = std::fs::File::open(path)
        .with_context(|| format!("Failed to open inventory file {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    let mut size_bytes = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size_bytes += read as u64;
    }
    Ok(BackupFileInventory {
        path: relative.replace('\\', "/"),
        size_bytes,
        sha256: hex::encode(hasher.finalize()),
    })
}

async fn build_file_inventory(backup_path: &Path) -> Result<Vec<BackupFileInventory>> {
    let root = backup_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();
        for entry in walkdir::WalkDir::new(&root).follow_links(false) {
            let entry =
                entry.with_context(|| format!("Failed to inventory backup {}", root.display()))?;
            if entry.path() == root {
                continue;
            }
            if entry.file_type().is_symlink() {
                anyhow::bail!(
                    "Backup inventory refuses symlink {}",
                    entry.path().display()
                );
            }
            if entry.file_type().is_dir() {
                continue;
            }
            if !entry.file_type().is_file() {
                anyhow::bail!(
                    "Backup inventory contains unsupported entry {}",
                    entry.path().display()
                );
            }

            let relative = entry.path().strip_prefix(&root)?.to_str().ok_or_else(|| {
                anyhow::anyhow!(
                    "Backup inventory path is not valid UTF-8: {}",
                    entry.path().display()
                )
            })?;
            if relative == BACKUP_MANIFEST_FILENAME {
                continue;
            }

            files.push(build_file_inventory_entry(
                entry.path(),
                relative.to_string(),
            )?);
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));
        Ok::<_, anyhow::Error>(files)
    })
    .await
    .context("Failed to join backup inventory task")?
}

fn path_is_safe_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn managed_relative_path(raw: &str, managed_root: &Path) -> Option<String> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return None;
    }
    let relative = path.strip_prefix(managed_root).ok()?;
    if !path_is_safe_relative(relative) {
        return None;
    }
    Some(relative.to_string_lossy().to_string())
}

fn rebased_managed_path(raw: &str, managed_root: &Path) -> Option<String> {
    let relative = Path::new(raw);
    if !path_is_safe_relative(relative) {
        return None;
    }
    Some(managed_root.join(relative).to_string_lossy().to_string())
}

fn sqlite_table_exists(conn: &Connection, table_name: &str) -> Result<bool> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1
         )",
        [table_name],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn rewrite_database_path_column<F>(
    conn: &Connection,
    table_name: &str,
    column_name: &str,
    mut rewrite: F,
) -> Result<()>
where
    F: FnMut(&str) -> Option<String>,
{
    if !sqlite_table_exists(conn, table_name)? {
        return Ok(());
    }
    let select_sql = format!(
        "SELECT rowid, {column_name} FROM {table_name}
         WHERE {column_name} IS NOT NULL AND TRIM({column_name}) <> ''"
    );
    let rows = {
        let mut stmt = conn.prepare(&select_sql)?;
        let mapped = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        mapped.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let update_sql = format!("UPDATE {table_name} SET {column_name} = ?1 WHERE rowid = ?2");
    for (rowid, current) in rows {
        if let Some(updated) = rewrite(&current) {
            conn.execute(&update_sql, params![updated, rowid])?;
        }
    }
    Ok(())
}

fn rewrite_database_recording_paths<F>(conn: &mut Connection, mut rewrite: F) -> Result<()>
where
    F: FnMut(&str) -> Option<String>,
{
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for (table_name, column_name) in [
        ("recordings", "audio_path"),
        ("recording_audio_assets", "path"),
        ("recording_audio_operation_items", "source_path"),
        ("recording_audio_operation_items", "staged_path"),
        ("recording_audio_operation_items", "target_path"),
    ] {
        rewrite_database_path_column(&tx, table_name, column_name, &mut rewrite)?;
    }
    tx.commit()?;
    Ok(())
}

async fn prepare_database_for_portable_backup(
    database_path: &Path,
    managed_recordings_root: &Path,
) -> Result<()> {
    if classify_database_protection(database_path).await?
        == BackupDatabaseProtection::VaultKeyRequired
    {
        return Ok(());
    }

    let database_path = database_path.to_path_buf();
    let managed_recordings_root = managed_recordings_root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        crate::db::validate_plaintext_database_file(&database_path)?;
        let mut conn = Connection::open(&database_path)?;
        rewrite_database_recording_paths(&mut conn, |raw| {
            managed_relative_path(raw, &managed_recordings_root)
        })?;
        drop(conn);
        crate::db::validate_plaintext_database_file(&database_path)
    })
    .await
    .context("Failed to join portable database preparation")??;
    Ok(())
}

async fn prepare_staged_database_for_restore(
    database_path: &Path,
    managed_recordings_root: &Path,
    recording_path_format: Option<RecordingPathFormat>,
) -> Result<()> {
    let database_path = database_path.to_path_buf();
    let managed_recordings_root = managed_recordings_root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        crate::db::validate_plaintext_database_file(&database_path)?;
        if recording_path_format == Some(RecordingPathFormat::RelativeManagedV1) {
            let mut conn = Connection::open(&database_path)?;
            rewrite_database_recording_paths(&mut conn, |raw| {
                rebased_managed_path(raw, &managed_recordings_root)
            })?;
        }
        crate::db::validate_plaintext_database_file(&database_path)
    })
    .await
    .context("Failed to join staged database validation")??;
    Ok(())
}

async fn validate_complete_backup(
    backup_path: &Path,
    expected_backup_id: Option<&str>,
) -> Result<BackupManifest> {
    let manifest = read_backup_manifest(backup_path).await?;
    if manifest.format_version != BACKUP_MANIFEST_FORMAT_VERSION {
        return Err(anyhow::anyhow!(
            "Unsupported backup manifest format version {}",
            manifest.format_version
        ));
    }
    if !manifest.complete {
        return Err(anyhow::anyhow!("Backup manifest is not marked complete"));
    }
    let manifest_id = validate_backup_id(&manifest.id)?;
    if let Some(expected) = expected_backup_id {
        let expected = validate_backup_id(expected)?;
        if manifest_id != expected {
            return Err(anyhow::anyhow!(
                "Backup manifest ID '{}' does not match directory ID '{}'",
                manifest_id,
                expected
            ));
        }
    }
    let expected_prefix = backup_type_id_prefix(&manifest.backup_type);
    if !manifest_id.starts_with(expected_prefix) {
        return Err(anyhow::anyhow!(
            "Backup manifest type {:?} is inconsistent with generation ID '{}'",
            manifest.backup_type,
            manifest_id
        ));
    }
    if manifest.components.is_empty() {
        return Err(anyhow::anyhow!(
            "Backup manifest does not list any components"
        ));
    }

    let component_set: HashSet<BackupComponent> = manifest.components.iter().copied().collect();
    if component_set.len() != manifest.components.len() {
        return Err(anyhow::anyhow!(
            "Backup manifest contains duplicate components"
        ));
    }
    if manifest.backup_type == BackupType::Settings
        && component_set != HashSet::from([BackupComponent::Settings])
    {
        return Err(anyhow::anyhow!(
            "Settings snapshots must contain only the settings component"
        ));
    }
    if matches!(
        manifest.backup_type,
        BackupType::Full | BackupType::Incremental
    ) && !component_set.contains(&BackupComponent::Database)
        && !component_set.contains(&BackupComponent::Recordings)
    {
        return Err(anyhow::anyhow!(
            "Full and incremental backups must contain database or recording data"
        ));
    }
    if component_set.contains(&BackupComponent::Database) != manifest.database_protection.is_some()
    {
        return Err(anyhow::anyhow!(
            "Backup database protection metadata does not match its components"
        ));
    }
    if manifest.recording_path_format.is_some()
        && manifest.database_protection != Some(BackupDatabaseProtection::PortablePlaintext)
    {
        return Err(anyhow::anyhow!(
            "Relative recording paths require a portable plaintext database"
        ));
    }

    let mut allowed_root_entries = HashSet::from([BACKUP_MANIFEST_FILENAME]);
    for component in &component_set {
        allowed_root_entries.insert(component_file_name(*component));
    }
    let mut root_entries = tokio::fs::read_dir(backup_path)
        .await
        .with_context(|| format!("Failed to inspect backup {}", backup_path.display()))?;
    while let Some(entry) = root_entries.next_entry().await? {
        let entry_name = entry.file_name();
        let entry_name = entry_name.to_str().ok_or_else(|| {
            anyhow::anyhow!(
                "Backup contains a root entry with an invalid file name: {}",
                entry.path().display()
            )
        })?;
        if !allowed_root_entries.contains(entry_name) {
            return Err(anyhow::anyhow!(
                "Backup contains undeclared root entry '{}'",
                entry_name
            ));
        }
    }

    for component in [
        BackupComponent::Database,
        BackupComponent::Recordings,
        BackupComponent::Settings,
    ] {
        let path = component_path(backup_path, component);
        let metadata = tokio::fs::symlink_metadata(&path).await;
        if !component_set.contains(&component) {
            if metadata.is_ok() {
                return Err(anyhow::anyhow!(
                    "Backup contains undeclared {:?} component",
                    component
                ));
            }
            continue;
        }

        let metadata = metadata.with_context(|| {
            format!(
                "Backup manifest declares {:?}, but {} is missing",
                component,
                path.display()
            )
        })?;
        match component {
            BackupComponent::Database => {
                if !metadata.file_type().is_file() || metadata.len() == 0 {
                    return Err(anyhow::anyhow!(
                        "Database component is not a non-empty regular file"
                    ));
                }
            }
            BackupComponent::Recordings => {
                if !metadata.file_type().is_dir() {
                    return Err(anyhow::anyhow!("Recordings component is not a directory"));
                }
                validate_directory_tree_without_symlinks(&path).await?;
            }
            BackupComponent::Settings => {
                if !metadata.file_type().is_file() || metadata.len() == 0 {
                    return Err(anyhow::anyhow!(
                        "Settings component is not a non-empty regular file"
                    ));
                }
                let raw = tokio::fs::read(&path).await.with_context(|| {
                    format!("Failed to read settings component {}", path.display())
                })?;
                serde_json::from_slice::<crate::settings::Settings>(&raw)
                    .context("Settings component is not a valid settings document")?;
            }
        }
    }

    let actual_files = build_file_inventory(backup_path).await?;
    if actual_files != manifest.files {
        return Err(anyhow::anyhow!(
            "Backup file inventory does not match the recorded SHA-256 hashes and sizes"
        ));
    }

    Ok(manifest)
}

fn restore_artifact_path(
    base: &Path,
    file_name: &str,
    suffix: &str,
    transaction_id: &str,
) -> PathBuf {
    base.join(format!(".{}.{}.{}", file_name, suffix, transaction_id))
}

fn build_restore_units(
    backup_path: &Path,
    data_dir: &Path,
    settings_path: &Path,
    components: &[BackupComponent],
    transaction_id: &str,
) -> Vec<RestoreUnit> {
    components
        .iter()
        .map(|component| match component {
            BackupComponent::Database => RestoreUnit {
                component: BackupComponent::Database,
                source_path: backup_path.join("plainsong.db"),
                live_path: data_dir.join("plainsong.db"),
                staged_path: restore_artifact_path(
                    data_dir,
                    "plainsong.db",
                    "restore-stage",
                    transaction_id,
                ),
                rollback_path: restore_artifact_path(
                    data_dir,
                    "plainsong.db",
                    "restore-rollback",
                    transaction_id,
                ),
                path_kind: RestorePathKind::File,
            },
            BackupComponent::Recordings => RestoreUnit {
                component: BackupComponent::Recordings,
                source_path: backup_path.join("recordings"),
                live_path: data_dir.join("recordings"),
                staged_path: restore_artifact_path(
                    data_dir,
                    "recordings",
                    "restore-stage",
                    transaction_id,
                ),
                rollback_path: restore_artifact_path(
                    data_dir,
                    "recordings",
                    "restore-rollback",
                    transaction_id,
                ),
                path_kind: RestorePathKind::Directory,
            },
            BackupComponent::Settings => {
                let settings_parent = settings_path.parent().unwrap_or_else(|| Path::new("."));
                let settings_file_name = settings_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(SETTINGS_BACKUP_FILENAME);
                RestoreUnit {
                    component: BackupComponent::Settings,
                    source_path: backup_path.join(SETTINGS_BACKUP_FILENAME),
                    live_path: settings_path.to_path_buf(),
                    staged_path: restore_artifact_path(
                        settings_parent,
                        settings_file_name,
                        "restore-stage",
                        transaction_id,
                    ),
                    rollback_path: restore_artifact_path(
                        settings_parent,
                        settings_file_name,
                        "restore-rollback",
                        transaction_id,
                    ),
                    path_kind: RestorePathKind::File,
                }
            }
        })
        .collect()
}

async fn remove_path_if_exists(path: &Path) -> Result<()> {
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Failed to inspect restore path {}", path.display()))
        }
    };

    if metadata.file_type().is_symlink() || metadata.is_file() {
        tokio::fs::remove_file(path)
            .await
            .with_context(|| format!("Failed to remove file {}", path.display()))?;
    } else if metadata.is_dir() {
        tokio::fs::remove_dir_all(path)
            .await
            .with_context(|| format!("Failed to remove directory {}", path.display()))?;
    } else {
        anyhow::bail!(
            "Restore path is not a file or directory: {}",
            path.display()
        );
    }
    Ok(())
}

async fn stage_restore_units(units: &[RestoreUnit]) -> Result<()> {
    for unit in units {
        if let Some(parent) = unit.staged_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        remove_path_if_exists(&unit.staged_path).await?;
        remove_path_if_exists(&unit.rollback_path).await?;

        match unit.path_kind {
            RestorePathKind::File => {
                tokio::fs::copy(&unit.source_path, &unit.staged_path)
                    .await
                    .with_context(|| {
                        format!(
                            "Failed to stage {:?} from {}",
                            unit.component,
                            unit.source_path.display()
                        )
                    })?;
            }
            RestorePathKind::Directory => {
                copy_dir_recursive(&unit.source_path, &unit.staged_path)
                    .await
                    .with_context(|| {
                        format!(
                            "Failed to stage {:?} from {}",
                            unit.component,
                            unit.source_path.display()
                        )
                    })?;
            }
        }
    }

    Ok(())
}

async fn build_staged_restore_inventory(units: &[RestoreUnit]) -> Result<Vec<BackupFileInventory>> {
    let units = units.to_vec();
    tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();
        for unit in units {
            match unit.path_kind {
                RestorePathKind::File => {
                    files.push(build_file_inventory_entry(
                        &unit.staged_path,
                        component_file_name(unit.component).to_string(),
                    )?);
                }
                RestorePathKind::Directory => {
                    let metadata =
                        std::fs::symlink_metadata(&unit.staged_path).with_context(|| {
                            format!(
                                "Failed to inspect staged {:?} directory {}",
                                unit.component,
                                unit.staged_path.display()
                            )
                        })?;
                    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
                        anyhow::bail!(
                            "Staged {:?} component is not a regular directory",
                            unit.component
                        );
                    }
                    for entry in walkdir::WalkDir::new(&unit.staged_path).follow_links(false) {
                        let entry = entry.with_context(|| {
                            format!("Failed to inventory staged {:?} component", unit.component)
                        })?;
                        if entry.path() == unit.staged_path {
                            continue;
                        }
                        if entry.file_type().is_symlink() {
                            anyhow::bail!(
                                "Staged restore inventory refuses symlink {}",
                                entry.path().display()
                            );
                        }
                        if entry.file_type().is_dir() {
                            continue;
                        }
                        if !entry.file_type().is_file() {
                            anyhow::bail!(
                                "Staged restore inventory contains unsupported entry {}",
                                entry.path().display()
                            );
                        }
                        let relative = entry
                            .path()
                            .strip_prefix(&unit.staged_path)?
                            .to_str()
                            .ok_or_else(|| {
                                anyhow::anyhow!(
                                    "Staged restore path is not valid UTF-8: {}",
                                    entry.path().display()
                                )
                            })?;
                        files.push(build_file_inventory_entry(
                            entry.path(),
                            format!("{}/{}", component_file_name(unit.component), relative),
                        )?);
                    }
                }
            }
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));
        Ok::<_, anyhow::Error>(files)
    })
    .await
    .context("Failed to join staged restore inventory task")?
}

async fn validate_staged_restore_inventory(
    units: &[RestoreUnit],
    expected: &[BackupFileInventory],
) -> Result<()> {
    let actual = build_staged_restore_inventory(units).await?;
    if actual != expected {
        anyhow::bail!("Staged restore inventory does not match the validated backup manifest");
    }
    Ok(())
}

async fn rollback_restore_units(units: &[RestoreUnit]) {
    for unit in units.iter().rev() {
        let _ = remove_path_if_exists(&unit.live_path).await;
        if unit.rollback_path.exists() {
            let _ = tokio::fs::rename(&unit.rollback_path, &unit.live_path).await;
        }
        let _ = remove_path_if_exists(&unit.staged_path).await;
    }
}

async fn cleanup_restore_artifacts(units: &[RestoreUnit]) {
    for unit in units {
        let _ = remove_path_if_exists(&unit.rollback_path).await;
        let _ = remove_path_if_exists(&unit.staged_path).await;
    }
}

async fn commit_restore_units(units: &[RestoreUnit]) -> Result<()> {
    let mut committed_units: Vec<RestoreUnit> = Vec::new();

    for unit in units {
        if let Some(parent) = unit.live_path.parent() {
            if let Err(error) = tokio::fs::create_dir_all(parent).await {
                rollback_restore_units(&committed_units).await;
                cleanup_restore_artifacts(units).await;
                return Err(error).with_context(|| {
                    format!("Failed to create live parent for {:?}", unit.component)
                });
            }
        }

        let had_live_target = unit.live_path.exists();
        if had_live_target {
            if let Err(error) = tokio::fs::rename(&unit.live_path, &unit.rollback_path).await {
                rollback_restore_units(&committed_units).await;
                cleanup_restore_artifacts(units).await;
                return Err(error).with_context(|| {
                    format!(
                        "Failed to move live {:?} into rollback location",
                        unit.component
                    )
                });
            }
        }

        if let Err(err) = tokio::fs::rename(&unit.staged_path, &unit.live_path).await {
            if had_live_target && unit.rollback_path.exists() {
                let _ = tokio::fs::rename(&unit.rollback_path, &unit.live_path).await;
            }
            rollback_restore_units(&committed_units).await;
            cleanup_restore_artifacts(units).await;
            return Err(anyhow::anyhow!(
                "Failed to commit restored {:?}: {}",
                unit.component,
                err
            ));
        }

        committed_units.push(unit.clone());
    }

    Ok(())
}

async fn restore_backup_into_targets(
    backup_path: &Path,
    data_dir: &Path,
    settings_path: &Path,
    components: &[BackupComponent],
    expected_files: &[BackupFileInventory],
    recording_path_format: Option<RecordingPathFormat>,
) -> Result<()> {
    let transaction_id = format!("{}-{}", Utc::now().timestamp_millis(), std::process::id());
    let units = build_restore_units(
        backup_path,
        data_dir,
        settings_path,
        components,
        &transaction_id,
    );
    if let Err(error) = stage_restore_units(&units).await {
        cleanup_restore_artifacts(&units).await;
        return Err(error);
    }

    if let Err(error) = validate_staged_restore_inventory(&units, expected_files).await {
        cleanup_restore_artifacts(&units).await;
        return Err(error.context("Staged backup bytes failed manifest validation"));
    }

    if let Some(database_unit) = units
        .iter()
        .find(|unit| unit.component == BackupComponent::Database)
    {
        if let Err(error) = prepare_staged_database_for_restore(
            &database_unit.staged_path,
            &data_dir.join("recordings"),
            recording_path_format,
        )
        .await
        {
            cleanup_restore_artifacts(&units).await;
            return Err(error.context("Staged database failed validation before restore"));
        }
    }

    if let Err(err) = commit_restore_units(&units).await {
        cleanup_restore_artifacts(&units).await;
        return Err(err);
    }

    if let Some(database_unit) = units
        .iter()
        .find(|unit| unit.component == BackupComponent::Database)
    {
        let live_database = database_unit.live_path.clone();
        let reopen_result = tokio::task::spawn_blocking(move || {
            crate::db::validate_plaintext_database_file(&live_database)
        })
        .await
        .context("Failed to join restored database reopen check")
        .and_then(|result| result);
        if let Err(error) = reopen_result {
            // Do not discard the rollback copy until the database that was
            // actually published has reopened and passed quick_check.
            rollback_restore_units(&units).await;
            cleanup_restore_artifacts(&units).await;
            return Err(error.context("Restored database failed to reopen; live data rolled back"));
        }
    }

    cleanup_restore_artifacts(&units).await;
    Ok(())
}

async fn validate_directory_tree_without_symlinks(path: &Path) -> Result<()> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .with_context(|| format!("Failed to inspect directory {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Err(anyhow::anyhow!(
            "Backup directory tree contains a symlink or non-directory root: {}",
            path.display()
        ));
    }

    let mut entries = tokio::fs::read_dir(path)
        .await
        .with_context(|| format!("Failed to inspect directory {}", path.display()))?;
    while let Some(entry) = entries.next_entry().await? {
        let entry_path = entry.path();
        let metadata = tokio::fs::symlink_metadata(&entry_path)
            .await
            .with_context(|| format!("Failed to inspect {}", entry_path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(anyhow::anyhow!(
                "Backup directory tree contains a symlink: {}",
                entry_path.display()
            ));
        }
        if metadata.file_type().is_dir() {
            Box::pin(validate_directory_tree_without_symlinks(&entry_path)).await?;
        } else if !metadata.file_type().is_file() {
            return Err(anyhow::anyhow!(
                "Backup directory tree contains an unsupported entry: {}",
                entry_path.display()
            ));
        }
    }
    Ok(())
}

/// Copy a directory tree without following symlinks.
async fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
    let source_metadata = tokio::fs::symlink_metadata(src)
        .await
        .with_context(|| format!("Failed to inspect source directory {}", src.display()))?;
    if source_metadata.file_type().is_symlink() || !source_metadata.file_type().is_dir() {
        return Err(anyhow::anyhow!(
            "Refusing to copy a symlink or non-directory source: {}",
            src.display()
        ));
    }
    crate::safe_fs::ensure_directory_without_links(dst)?;
    let mut entries = tokio::fs::read_dir(src).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let file_name = entry.file_name();
        let dest_path = dst.join(&file_name);
        let metadata = tokio::fs::symlink_metadata(&path)
            .await
            .with_context(|| format!("Failed to inspect source entry {}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(anyhow::anyhow!(
                "Refusing to copy symlink from backup directory tree: {}",
                path.display()
            ));
        }
        if metadata.file_type().is_dir() {
            Box::pin(copy_dir_recursive(&path, &dest_path)).await?;
        } else if metadata.file_type().is_file() {
            copy_regular_file_without_links(&path, &dest_path).await?;
        } else {
            return Err(anyhow::anyhow!(
                "Refusing to copy unsupported directory entry: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

async fn copy_regular_file_without_links(src: &Path, dst: &Path) -> Result<u64> {
    let src = src.to_path_buf();
    let dst = dst.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let metadata = std::fs::symlink_metadata(&src)
            .with_context(|| format!("Failed to inspect source file {}", src.display()))?;
        if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
            anyhow::bail!(
                "Refusing to copy a symlink or non-file source: {}",
                src.display()
            );
        }
        let mut copied = 0;
        crate::safe_fs::atomic_replace_with(&dst, |destination| {
            let mut source = crate::safe_fs::open_regular_file_without_links(&src)?;
            copied = std::io::copy(&mut source, destination)
                .with_context(|| format!("Failed to copy source file {}", src.display()))?;
            Ok(())
        })?;
        Ok::<_, anyhow::Error>(copied)
    })
    .await
    .context("Failed to join safe file-copy task")?
}

async fn sync_backup_tree(path: &Path) -> Result<()> {
    let root = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut directories = Vec::new();
        for entry in walkdir::WalkDir::new(&root) {
            let entry = entry.with_context(|| {
                format!("Failed to inspect backup generation {}", root.display())
            })?;
            if entry.file_type().is_file() {
                std::fs::File::open(entry.path())
                    .with_context(|| format!("Failed to open {} for sync", entry.path().display()))?
                    .sync_all()
                    .with_context(|| format!("Failed to sync {}", entry.path().display()))?;
            } else if entry.file_type().is_dir() {
                directories.push(entry.path().to_path_buf());
            }
        }

        #[cfg(unix)]
        for directory in directories.into_iter().rev() {
            std::fs::File::open(&directory)
                .with_context(|| format!("Failed to open {} for sync", directory.display()))?
                .sync_all()
                .with_context(|| format!("Failed to sync {}", directory.display()))?;
        }

        Ok(())
    })
    .await
    .context("Failed to join backup sync task")??;
    Ok(())
}

async fn count_dir_items(path: &Path) -> Result<u32> {
    if path.is_file() {
        return Ok(1);
    }
    let mut count = 0u32;
    let mut entries = tokio::fs::read_dir(path).await?;
    while let Some(entry) = entries.next_entry().await? {
        let child = entry.path();
        if child.is_dir() {
            count += Box::pin(count_dir_items(&child)).await?;
        } else {
            count += 1;
        }
    }
    Ok(count)
}

/// Calculate directory size
async fn calculate_dir_size(path: &Path) -> Result<u64> {
    if path.is_file() {
        let metadata = tokio::fs::metadata(path).await?;
        return Ok(metadata.len());
    }

    let mut total_size = 0u64;
    let mut entries = tokio::fs::read_dir(path).await?;
    while let Some(entry) = entries.next_entry().await? {
        let child = entry.path();
        if child.is_dir() {
            total_size += Box::pin(calculate_dir_size(&child)).await?;
        } else {
            let metadata = tokio::fs::metadata(&child).await?;
            total_size += metadata.len();
        }
    }
    Ok(total_size)
}

/// Create zip archive using deflate compression.
async fn create_zip_archive(src: &Path, dst: &Path) -> Result<()> {
    let src_path = src.to_path_buf();
    let dst_path = dst.to_path_buf();

    tokio::task::spawn_blocking(move || -> Result<()> {
        use zip::write::SimpleFileOptions;
        use zip::CompressionMethod;

        crate::safe_fs::atomic_replace_with(&dst_path, |file| {
            let mut zip = zip::ZipWriter::new(file);
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

            for entry in walkdir::WalkDir::new(&src_path).follow_links(false) {
                let entry = entry.with_context(|| {
                    format!("Failed to walk backup source {}", src_path.display())
                })?;
                if entry.file_type().is_symlink() {
                    anyhow::bail!("Backup archive refuses symlink {}", entry.path().display());
                }
                let path = entry.path();
                let rel = path.strip_prefix(&src_path).with_context(|| {
                    format!("Failed to strip path prefix for {}", path.display())
                })?;
                if rel.as_os_str().is_empty() {
                    continue;
                }
                let rel_name = rel.to_string_lossy().replace('\\', "/");
                if path.is_dir() {
                    zip.add_directory(rel_name, options)?;
                } else {
                    zip.start_file(rel_name, options)?;
                    let mut source = std::fs::File::open(path)?;
                    std::io::copy(&mut source, &mut zip)?;
                }
            }
            zip.finish()?;
            Ok(())
        })
    })
    .await
    .context("Failed to join archive writer task")??;

    Ok(())
}

async fn sync_to_rclone(
    provider: &CloudProvider,
    config: &BackupConfig,
    source: &Path,
) -> Result<()> {
    verify_rclone_remote(provider, config.cloud_remote_name.as_deref()).await?;

    let remote = config
        .cloud_remote_name
        .clone()
        .or_else(|| provider.default_remote_name().map(ToString::to_string))
        .ok_or_else(|| anyhow::anyhow!("No rclone remote configured"))?;

    // Validate remote name contains only safe characters (alphanumeric, dash, underscore)
    if !remote
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err(anyhow::anyhow!(
            "Invalid rclone remote name: contains unsafe characters"
        ));
    }

    let folder = validate_cloud_folder(&config.cloud_folder)?;
    let backup_id = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow::anyhow!("Invalid backup path"))?;
    let destination = format!("{remote}:{folder}/{backup_id}");

    let rclone = rclone_executable().map_err(anyhow::Error::msg)?;
    let output = Command::new(rclone)
        .arg("copy")
        .arg(source)
        .arg(&destination)
        .arg("--checksum")
        .arg("--create-empty-src-dirs")
        .output()
        .await
        .context("Failed to run rclone copy command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(anyhow::anyhow!("rclone sync failed: {}", stderr));
    }

    tracing::info!("Backup synced via rclone to {}", destination);
    Ok(())
}

async fn verify_rclone_remote(
    provider: &CloudProvider,
    remote_override: Option<&str>,
) -> Result<()> {
    rclone_version()
        .await
        .map_err(|e| anyhow::anyhow!("{}", e))?;

    let remote = remote_override
        .map(ToString::to_string)
        .or_else(|| provider.default_remote_name().map(ToString::to_string))
        .ok_or_else(|| anyhow::anyhow!("No rclone remote configured"))?;
    let remote_key = format!("{}:", remote.trim_end_matches(':'));

    let remotes = list_rclone_remotes()
        .await
        .map_err(|e| anyhow::anyhow!("{}", e))?;
    if !remotes.iter().any(|line| line.trim() == remote_key) {
        return Err(anyhow::anyhow!(
            "rclone remote '{}' is not configured. Run `rclone config` and create it first.",
            remote
        ));
    }
    Ok(())
}

async fn sync_to_icloud(config: &BackupConfig, source: &Path) -> Result<()> {
    let root = resolve_icloud_root(config.icloud_path.as_ref())?;
    if !root.exists() {
        return Err(anyhow::anyhow!(
            "iCloud Drive root does not exist: {}",
            root.display()
        ));
    }

    let backup_id = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow::anyhow!("Invalid backup path"))?;
    let folder = validate_cloud_folder(&config.cloud_folder)?;
    let destination_root = root.join(folder);
    crate::safe_fs::ensure_directory_without_links(&destination_root)
        .context("iCloud destination contains a linked or invalid directory component")?;
    let destination = destination_root.join(backup_id);
    let transaction_id = format!("{}-{}", Utc::now().timestamp_millis(), std::process::id());
    let temp_destination =
        destination_root.join(format!(".{}.icloud-stage.{}", backup_id, transaction_id));
    let previous_destination =
        destination_root.join(format!(".{}.icloud-previous.{}", backup_id, transaction_id));

    remove_path_if_exists(&temp_destination).await?;
    remove_path_if_exists(&previous_destination).await?;
    copy_dir_recursive(source, &temp_destination).await?;

    crate::safe_fs::ensure_directory_without_links(&destination_root)
        .context("iCloud destination changed while the backup was being copied")?;

    if destination.exists() {
        tokio::fs::rename(&destination, &previous_destination)
            .await
            .with_context(|| {
                format!(
                    "Failed to stage previous iCloud backup {}",
                    destination.display()
                )
            })?;
    }

    if let Err(err) = tokio::fs::rename(&temp_destination, &destination).await {
        let _ = remove_path_if_exists(&temp_destination).await;
        if previous_destination.exists() {
            let _ = tokio::fs::rename(&previous_destination, &destination).await;
        }
        return Err(anyhow::anyhow!(
            "Failed to commit iCloud sync for {}: {}",
            destination.display(),
            err
        ));
    }

    remove_path_if_exists(&previous_destination).await?;
    tracing::info!("Backup synced to iCloud path {}", destination.display());
    Ok(())
}

fn resolve_icloud_root(override_path: Option<&PathBuf>) -> Result<PathBuf> {
    if let Some(path) = override_path {
        return Ok(path.clone());
    }

    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("Home directory not found"))?;
        return Ok(home
            .join("Library")
            .join("Mobile Documents")
            .join("com~apple~CloudDocs"));
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(path) = std::env::var("ICLOUDDRIVE") {
            return Ok(PathBuf::from(path));
        }
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return Ok(PathBuf::from(profile).join("iCloudDrive"));
        }
    }

    #[allow(unreachable_code)]
    Err(anyhow::anyhow!(
        "Unable to auto-detect iCloud path on this platform; configure icloudPath explicitly."
    ))
}

fn pass_check(id: &str, label: &str, message: &str) -> CloudSetupCheck {
    CloudSetupCheck {
        id: id.to_string(),
        label: label.to_string(),
        status: SetupCheckStatus::Pass,
        message: message.to_string(),
    }
}

fn fail_check(id: &str, label: &str, message: &str) -> CloudSetupCheck {
    CloudSetupCheck {
        id: id.to_string(),
        label: label.to_string(),
        status: SetupCheckStatus::Fail,
        message: message.to_string(),
    }
}

async fn rclone_version() -> std::result::Result<String, String> {
    let version = Command::new(rclone_executable()?)
        .arg("version")
        .output()
        .await
        .map_err(|_| {
            "rclone is not available. Install from https://rclone.org/downloads/".to_string()
        })?;
    if !version.status.success() {
        return Err(
            "rclone is not available. Install from https://rclone.org/downloads/".to_string(),
        );
    }
    let stdout = String::from_utf8_lossy(&version.stdout);
    let first_line = stdout.lines().next().unwrap_or("rclone");
    Ok(first_line.trim().to_string())
}

async fn list_rclone_remotes() -> std::result::Result<Vec<String>, String> {
    let remotes = Command::new(rclone_executable()?)
        .arg("listremotes")
        .output()
        .await
        .map_err(|e| format!("Failed to list rclone remotes: {}", e))?;
    if !remotes.status.success() {
        let stderr = String::from_utf8_lossy(&remotes.stderr).to_string();
        return Err(format!("Could not read rclone remotes: {}", stderr));
    }
    let stdout = String::from_utf8_lossy(&remotes.stdout);
    Ok(stdout.lines().map(|line| line.to_string()).collect())
}

#[cfg(not(windows))]
fn rclone_executable() -> std::result::Result<PathBuf, String> {
    let configured = std::env::var_os("PLAINSONG_RCLONE_PATH");
    let candidates = [
        PathBuf::from("/opt/homebrew/bin/rclone"),
        PathBuf::from("/usr/local/bin/rclone"),
        PathBuf::from("/usr/bin/rclone"),
    ];
    resolve_rclone_executable(configured.as_deref(), &candidates)
}

#[cfg(windows)]
fn rclone_executable() -> std::result::Result<PathBuf, String> {
    if let Some(configured) = std::env::var_os("PLAINSONG_RCLONE_PATH") {
        return resolve_rclone_executable(Some(configured.as_os_str()), &[]);
    }
    Ok(PathBuf::from("rclone.exe"))
}

fn resolve_rclone_executable(
    configured: Option<&OsStr>,
    candidates: &[PathBuf],
) -> std::result::Result<PathBuf, String> {
    if let Some(configured) = configured {
        let configured = Path::new(configured);
        if !configured.is_absolute() {
            return Err("PLAINSONG_RCLONE_PATH must be an absolute path".to_string());
        }
        return validate_rclone_executable(configured);
    }

    candidates
        .iter()
        .find_map(|candidate| validate_rclone_executable(candidate).ok())
        .ok_or_else(|| {
            "rclone is not available. Install it in /opt/homebrew/bin or /usr/local/bin, or set PLAINSONG_RCLONE_PATH to its absolute path."
                .to_string()
        })
}

fn validate_rclone_executable(path: &Path) -> std::result::Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|_| format!("rclone executable does not exist: {}", path.display()))?;
    let metadata = canonical
        .metadata()
        .map_err(|error| format!("Could not inspect rclone executable: {error}"))?;
    if !metadata.is_file() {
        return Err(format!(
            "rclone executable is not a regular file: {}",
            canonical.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(format!(
                "rclone executable is not executable: {}",
                canonical.display()
            ));
        }
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::runtime::Runtime;

    fn unique_test_dir(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("nautilus-backup-test-{name}-{suffix}"))
    }

    #[cfg(unix)]
    #[test]
    fn rclone_resolution_ignores_path_and_accepts_explicit_executable() {
        use std::os::unix::fs::PermissionsExt;

        let root = unique_test_dir("rclone-executable");
        fs::create_dir_all(&root).expect("create rclone test root");
        let executable = root.join("custom-rclone");
        fs::write(&executable, b"#!/bin/sh\nexit 0\n").expect("write fake rclone");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
            .expect("make fake rclone executable");

        assert_eq!(
            resolve_rclone_executable(Some(executable.as_os_str()), &[])
                .expect("resolve explicit rclone"),
            executable.canonicalize().expect("canonical fake rclone")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn rclone_resolution_rejects_non_executable_and_directory() {
        let root = unique_test_dir("rclone-invalid");
        fs::create_dir_all(&root).expect("create rclone test root");
        let plain_file = root.join("plain-rclone");
        fs::write(&plain_file, b"not executable").expect("write plain file");

        assert!(resolve_rclone_executable(Some(plain_file.as_os_str()), &[]).is_err());
        assert!(resolve_rclone_executable(Some(root.as_os_str()), &[]).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn backup_id_rejects_traversal() {
        assert!(validate_backup_id("../outside").is_err());
        assert!(validate_backup_id("backup/2026").is_err());
        assert!(validate_backup_id("backup\\2026").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn restore_cleanup_removes_links_without_touching_their_targets() {
        use std::os::unix::fs::symlink;

        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("restore-cleanup-links");
            let outside = root.join("outside");
            let directory_link = root.join("directory-link");
            let broken_link = root.join("broken-link");
            fs::create_dir_all(&outside).expect("create outside directory");
            fs::write(outside.join("sentinel.txt"), "keep").expect("write sentinel");
            symlink(&outside, &directory_link).expect("create directory link");
            symlink(root.join("missing"), &broken_link).expect("create broken link");

            remove_path_if_exists(&directory_link)
                .await
                .expect("remove directory link");
            remove_path_if_exists(&broken_link)
                .await
                .expect("remove broken link");

            assert!(outside.join("sentinel.txt").is_file());
            assert!(fs::symlink_metadata(&directory_link).is_err());
            assert!(fs::symlink_metadata(&broken_link).is_err());
            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn backup_id_accepts_expected_characters() {
        let value = validate_backup_id("backup_20260219_154500").expect("valid backup id");
        assert_eq!(value, "backup_20260219_154500");
    }

    #[test]
    fn backup_id_accepts_nonce_suffix() {
        let value = validate_backup_id("settings_20260502_223442_a1b2c3d4")
            .expect("valid backup id with nonce");
        assert_eq!(value, "settings_20260502_223442_a1b2c3d4");
    }

    #[test]
    fn cloud_folder_rejects_relative_segments() {
        assert!(validate_cloud_folder("../backups").is_err());
        assert!(validate_cloud_folder("Plainsong/../Backups").is_err());
    }

    #[test]
    fn cloud_folder_rejects_unsafe_characters() {
        assert!(validate_cloud_folder("Plainsong:Backups").is_err());
        assert!(validate_cloud_folder("Plainsong\nBackups").is_err());
    }

    #[test]
    fn cloud_folder_accepts_nested_safe_paths() {
        let value = validate_cloud_folder("Plainsong/Backups/2026").expect("valid folder");
        assert_eq!(value, "Plainsong/Backups/2026");
    }

    #[cfg(unix)]
    #[test]
    fn backup_creation_rejects_an_approved_root_replaced_by_a_symlink() {
        use std::os::unix::fs::symlink;

        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("approved-root-swap");
            let destination = root.join("backups");
            let outside = root.join("outside");
            let data_dir = root.join("data");
            let settings_path = root.join("config/settings.json");
            fs::create_dir_all(&destination).expect("create approved destination");
            fs::create_dir_all(&outside).expect("create outside destination");
            write_settings(&settings_path, "dark");
            let manager = manager_for(destination.clone(), 7);

            fs::remove_dir(&destination).expect("remove approved destination");
            symlink(&outside, &destination).expect("replace destination with symlink");

            manager
                .create_backup_with_sources(&data_dir, &settings_path, BackupType::Settings, None)
                .await
                .expect_err("a swapped approved root must fail closed");
            assert!(directory_entry_names(&outside).is_empty());
            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn malformed_backup_config_is_reported_instead_of_treated_as_missing() {
        let root = unique_test_dir("malformed-config");
        fs::create_dir_all(&root).expect("create config root");
        let path = root.join("backup-config.json");
        fs::write(&path, "{\"cloudSync\":").expect("write truncated config");

        let error = load_backup_config_from_path(&path)
            .expect_err("truncated config must remain distinguishable from a missing file");
        assert!(error.to_string().contains("parse backup configuration"));
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn recursive_copy_rejects_nested_file_and_directory_symlinks() {
        use std::os::unix::fs::symlink;

        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("nested-symlinks");
            let source = root.join("source");
            let destination = root.join("destination");
            let external_file = root.join("private.txt");
            let external_directory = root.join("private-directory");
            fs::create_dir_all(source.join("nested")).expect("create source");
            fs::create_dir_all(&external_directory).expect("create external directory");
            fs::write(&external_file, "private").expect("write external file");
            symlink(&external_file, source.join("nested/file-link"))
                .expect("create nested file symlink");

            let file_error = copy_dir_recursive(&source, &destination)
                .await
                .expect_err("nested file symlink must be rejected");
            assert!(file_error.to_string().contains("symlink"));

            fs::remove_file(source.join("nested/file-link")).expect("remove file symlink");
            symlink(&external_directory, source.join("nested/directory-link"))
                .expect("create nested directory symlink");
            let directory_error = copy_dir_recursive(&source, &destination)
                .await
                .expect_err("nested directory symlink must be rejected");
            assert!(directory_error.to_string().contains("symlink"));

            let _ = fs::remove_dir_all(&root);
        });
    }

    #[cfg(unix)]
    #[test]
    fn backup_archive_replaces_a_link_leaf_without_writing_through_it() {
        use std::os::unix::fs::symlink;

        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("archive-link");
            fs::create_dir_all(&root).expect("create archive test root");
            let root = root.canonicalize().expect("canonical archive test root");
            let source = root.join("source");
            let outside = root.join("outside.zip");
            let destination = root.join("backup.zip");
            fs::create_dir_all(&source).expect("create source");
            fs::write(source.join("settings.json"), "{}").expect("write archive source");
            fs::write(&outside, "keep me").expect("write outside target");
            symlink(&outside, &destination).expect("create archive link");

            create_zip_archive(&source, &destination)
                .await
                .expect("safe archive export");

            assert_eq!(
                fs::read_to_string(&outside).expect("read outside target"),
                "keep me"
            );
            assert!(!fs::symlink_metadata(&destination)
                .expect("inspect archive destination")
                .file_type()
                .is_symlink());

            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn staged_restore_inventory_rejects_bytes_changed_after_source_validation() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("staged-integrity");
            let backup_path = root.join("backup");
            let data_dir = root.join("data");
            let settings_path = root.join("config/settings.json");
            fs::create_dir_all(&backup_path).expect("create backup source");
            write_settings(&backup_path.join(SETTINGS_BACKUP_FILENAME), "dark");
            let expected = build_file_inventory(&backup_path)
                .await
                .expect("build validated inventory");
            let units = build_restore_units(
                &backup_path,
                &data_dir,
                &settings_path,
                &[BackupComponent::Settings],
                "test-transaction",
            );
            stage_restore_units(&units).await.expect("stage restore");
            write_settings(&units[0].staged_path, "light");

            let error = validate_staged_restore_inventory(&units, &expected)
                .await
                .expect_err("changed staged bytes must be rejected");
            assert!(error.to_string().contains("inventory"));

            cleanup_restore_artifacts(&units).await;
            let _ = fs::remove_dir_all(&root);
        });
    }

    fn manager_for(backup_dir: PathBuf, max_backups: u32) -> BackupManager {
        BackupManager::new(BackupConfig {
            backup_dir: Some(backup_dir),
            max_backups,
            ..BackupConfig::default()
        })
    }

    fn write_settings(path: &Path, theme: &str) {
        let settings = crate::settings::Settings {
            theme: theme.to_string(),
            ..crate::settings::Settings::default()
        };
        let json = serde_json::to_string_pretty(&settings).expect("serialize settings");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create settings parent");
        }
        fs::write(path, json).expect("write settings");
    }

    fn directory_entry_names(path: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(path)
            .expect("read directory")
            .map(|entry| {
                entry
                    .expect("read entry")
                    .file_name()
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        names.sort();
        names
    }

    #[test]
    fn backup_config_disables_legacy_scheduler_fields() {
        let manager = BackupManager::new(BackupConfig {
            enabled: true,
            max_backups: 0,
            ..BackupConfig::default()
        });
        assert!(!manager.config().enabled);
        assert_eq!(manager.config().max_backups, 1);
    }

    #[test]
    fn backup_dir_renderer_config_cannot_replace_privileged_destination() {
        let approved_dir = unique_test_dir("approved-renderer-destination");
        let mut manager = BackupManager::new(BackupConfig {
            backup_dir: Some(approved_dir.clone()),
            backup_location_id: Some("approved-backup-location".to_string()),
            backup_location_label: Some("Beta backups".to_string()),
            backup_location_approved: true,
            ..BackupConfig::default()
        });

        let malicious_dir = unique_test_dir("renderer-controlled-destination");
        manager
            .set_config_from_renderer(BackupConfig {
                max_backups: 3,
                backup_dir: Some(malicious_dir),
                backup_location_id: Some("renderer-id".to_string()),
                backup_location_label: Some("Renderer path".to_string()),
                backup_location_approved: true,
                ..BackupConfig::default()
            })
            .expect("ordinary backup preferences should still save");

        assert_eq!(manager.config().max_backups, 3);
        assert_eq!(manager.config().backup_dir.as_ref(), Some(&approved_dir));
        assert_eq!(
            manager.config().backup_location_id.as_deref(),
            Some("approved-backup-location")
        );
        assert_eq!(
            manager.config().backup_location_label.as_deref(),
            Some("Beta backups")
        );
        assert!(manager.config().backup_location_approved);
    }

    #[test]
    fn backup_dir_legacy_custom_location_fails_closed_until_reselected() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let legacy_dir = unique_test_dir("legacy-unapproved-destination");
            std::fs::create_dir_all(&legacy_dir).expect("create legacy destination");
            let manager = BackupManager::new(BackupConfig {
                backup_dir: Some(legacy_dir.clone()),
                backup_location_id: Some("legacy-unapproved-location".to_string()),
                backup_location_label: Some("Legacy backups".to_string()),
                backup_location_approved: false,
                ..BackupConfig::default()
            });

            let error = manager
                .list_backups()
                .await
                .expect_err("unapproved legacy destination must fail closed");
            assert!(error.to_string().contains("not approved"));
            let _ = std::fs::remove_dir_all(legacy_dir);
        });
    }

    #[test]
    fn full_backup_rejects_live_database_without_snapshot_before_publication() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("snapshot-required");
            let data_dir = root.join("data");
            let backup_dir = root.join("backups");
            let settings_path = root.join("config/settings.json");
            fs::create_dir_all(&data_dir).expect("create data dir");
            fs::write(data_dir.join("plainsong.db"), "live-db").expect("write live database");
            write_settings(&settings_path, "dark");

            let manager = manager_for(backup_dir.clone(), 7);
            let error = manager
                .create_backup_with_sources(&data_dir, &settings_path, BackupType::Full, None)
                .await
                .expect_err("full backup must require a snapshot");
            assert!(error.to_string().contains("no VACUUM INTO snapshot"));
            assert!(directory_entry_names(&backup_dir).is_empty());

            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn full_backup_rejects_the_live_database_as_snapshot_source() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("live-db-fallback");
            let data_dir = root.join("data");
            let backup_dir = root.join("backups");
            let settings_path = root.join("config/settings.json");
            fs::create_dir_all(&data_dir).expect("create data dir");
            let live_database = data_dir.join("plainsong.db");
            fs::write(&live_database, "live-db").expect("write live database");
            write_settings(&settings_path, "dark");

            let manager = manager_for(backup_dir.clone(), 7);
            let error = manager
                .create_backup_with_sources(
                    &data_dir,
                    &settings_path,
                    BackupType::Full,
                    Some(&live_database),
                )
                .await
                .expect_err("live database must not be copied as its own snapshot");
            assert!(error.to_string().contains("live SQLite file"));
            assert!(directory_entry_names(&backup_dir).is_empty());

            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn invalid_settings_generation_is_never_published_and_only_partial_is_removed() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("atomic-failure");
            let data_dir = root.join("data");
            let backup_dir = root.join("backups");
            let settings_path = root.join("config/settings.json");
            let existing_id = "settings_20260409_115959_deadbeef";
            let existing = backup_dir.join(existing_id);
            fs::create_dir_all(&existing).expect("create existing generation");
            write_settings(&existing.join(SETTINGS_BACKUP_FILENAME), "light");
            write_backup_manifest(
                &existing,
                existing_id,
                Utc::now(),
                BackupType::Settings,
                &[BackupComponent::Settings],
            )
            .await
            .expect("write existing manifest");
            fs::create_dir_all(&data_dir).expect("create data dir");
            fs::create_dir_all(settings_path.parent().expect("settings parent"))
                .expect("create config dir");
            fs::write(&settings_path, "not-json").expect("write invalid settings");

            let manager = manager_for(backup_dir.clone(), 7);
            let error = manager
                .create_backup_with_sources(&data_dir, &settings_path, BackupType::Settings, None)
                .await
                .expect_err("invalid settings must fail manifest validation");
            assert!(error.to_string().contains("valid settings document"));
            assert_eq!(
                directory_entry_names(&backup_dir),
                vec![existing_id.to_string()]
            );
            assert!(validate_complete_backup(&existing, Some(existing_id))
                .await
                .is_ok());

            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn settings_snapshot_is_atomically_published_with_only_settings() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("settings-publication");
            let data_dir = root.join("data");
            let backup_dir = root.join("backups");
            let settings_path = root.join("config/settings.json");
            fs::create_dir_all(&data_dir).expect("create data dir");
            fs::write(data_dir.join("plainsong.db"), "live-db").expect("write live database");
            fs::create_dir_all(data_dir.join("recordings")).expect("create recordings");
            fs::write(data_dir.join("recordings/meeting.wav"), "audio").expect("write recording");
            write_settings(&settings_path, "dark");

            let manager = manager_for(backup_dir.clone(), 7);
            let info = manager
                .create_backup_with_sources(&data_dir, &settings_path, BackupType::Settings, None)
                .await
                .expect("create settings snapshot");
            let generation = backup_dir.join(&info.id);
            assert!(generation.is_dir());
            assert!(generation.join(SETTINGS_BACKUP_FILENAME).is_file());
            assert!(!generation.join("plainsong.db").exists());
            assert!(!generation.join("recordings").exists());
            assert!(directory_entry_names(&backup_dir)
                .iter()
                .all(|name| !name.starts_with('.')));

            let manifest = validate_complete_backup(&generation, Some(&info.id))
                .await
                .expect("validate published generation");
            assert_eq!(manifest.backup_type, BackupType::Settings);
            assert_eq!(manifest.components, vec![BackupComponent::Settings]);
            let listed = manager.list_backups().await.expect("list backups");
            assert_eq!(listed.len(), 1);
            assert_eq!(listed[0].id, info.id);

            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn full_and_settings_generations_remain_distinguishable() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("generation-types");
            let data_dir = root.join("data");
            let backup_dir = root.join("backups");
            let settings_path = root.join("config/settings.json");
            let snapshot_path = root.join("plainsong-snapshot.db");
            fs::create_dir_all(&data_dir).expect("create data dir");
            fs::write(data_dir.join("plainsong.db"), "live-db").expect("write live database");
            fs::write(&snapshot_path, "snapshot-db").expect("write database snapshot");
            write_settings(&settings_path, "dark");

            let manager = manager_for(backup_dir, 7);
            let settings_info = manager
                .create_backup_with_sources(&data_dir, &settings_path, BackupType::Settings, None)
                .await
                .expect("create settings snapshot");
            let full_info = manager
                .create_backup_with_sources(
                    &data_dir,
                    &settings_path,
                    BackupType::Full,
                    Some(&snapshot_path),
                )
                .await
                .expect("create full backup");

            assert!(settings_info.id.starts_with("settings_"));
            assert_eq!(settings_info.backup_type, BackupType::Settings);
            assert!(full_info.id.starts_with("backup_"));
            assert_eq!(full_info.backup_type, BackupType::Full);

            let listed = manager.list_backups().await.expect("list backups");
            assert_eq!(listed.len(), 2);
            assert_eq!(
                listed
                    .iter()
                    .find(|backup| backup.id == settings_info.id)
                    .map(|backup| &backup.backup_type),
                Some(&BackupType::Settings)
            );
            assert_eq!(
                listed
                    .iter()
                    .find(|backup| backup.id == full_info.id)
                    .map(|backup| &backup.backup_type),
                Some(&BackupType::Full)
            );

            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn backup_creation_never_uploads_without_an_explicit_sync_command() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("manual-cloud-sync");
            let data_dir = root.join("data");
            let backup_dir = root.join("backups");
            let settings_path = root.join("config/settings.json");
            fs::create_dir_all(&data_dir).expect("create data dir");
            write_settings(&settings_path, "dark");

            let manager = BackupManager::new(BackupConfig {
                backup_dir: Some(backup_dir.clone()),
                cloud_sync: true,
                cloud_provider: None,
                ..BackupConfig::default()
            });
            let info = manager
                .create_backup_with_sources(&data_dir, &settings_path, BackupType::Settings, None)
                .await
                .expect("manual backup creation must not attempt a cloud upload");
            assert!(backup_dir.join(info.id).is_dir());

            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn manual_backup_publication_applies_max_backup_retention() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("manual-retention");
            let data_dir = root.join("data");
            let backup_dir = root.join("backups");
            let settings_path = root.join("config/settings.json");
            fs::create_dir_all(&data_dir).expect("create data dir");
            write_settings(&settings_path, "light");

            let manager = manager_for(backup_dir.clone(), 1);
            let first = manager
                .create_backup_with_sources(&data_dir, &settings_path, BackupType::Settings, None)
                .await
                .expect("create first manual snapshot");
            write_settings(&settings_path, "dark");
            let second = manager
                .create_backup_with_sources(&data_dir, &settings_path, BackupType::Settings, None)
                .await
                .expect("create second manual snapshot");

            let listed = manager.list_backups().await.expect("list retained backups");
            assert_eq!(listed.len(), 1);
            assert_eq!(listed[0].id, second.id);
            assert!(!backup_dir.join(first.id).exists());

            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn listing_ignores_hidden_partials_and_invalid_visible_generations() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("listing-validation");
            let backup_dir = root.join("backups");
            let hidden = backup_dir.join(".backup_20260409_120000.partial-test");
            let missing_manifest = backup_dir.join("backup_20260409_120001_deadbeef");
            let missing_component = backup_dir.join("settings_20260409_120002_deadbeef");
            let incomplete_manifest = backup_dir.join("settings_20260409_120003_deadbeef");
            let mismatched_type = backup_dir.join("backup_20260409_120004_deadbeef");
            let undeclared_entry = backup_dir.join("settings_20260409_120005_deadbeef");
            fs::create_dir_all(&hidden).expect("create hidden partial");
            fs::create_dir_all(&missing_manifest).expect("create invalid backup");
            fs::create_dir_all(&missing_component).expect("create missing component backup");
            fs::create_dir_all(&incomplete_manifest).expect("create incomplete backup");
            fs::create_dir_all(&mismatched_type).expect("create type mismatch backup");
            fs::create_dir_all(&undeclared_entry).expect("create undeclared entry backup");
            write_backup_manifest(
                &missing_component,
                "settings_20260409_120002_deadbeef",
                Utc::now(),
                BackupType::Settings,
                &[BackupComponent::Settings],
            )
            .await
            .expect("write manifest");
            write_settings(&incomplete_manifest.join(SETTINGS_BACKUP_FILENAME), "dark");
            let incomplete = BackupManifest {
                format_version: BACKUP_MANIFEST_FORMAT_VERSION,
                complete: false,
                id: "settings_20260409_120003_deadbeef".to_string(),
                timestamp: Utc::now(),
                backup_type: BackupType::Settings,
                components: vec![BackupComponent::Settings],
                files: build_file_inventory(&incomplete_manifest)
                    .await
                    .expect("inventory incomplete generation"),
                database_protection: None,
                recording_path_format: None,
            };
            fs::write(
                backup_manifest_path(&incomplete_manifest),
                serde_json::to_string_pretty(&incomplete).expect("serialize incomplete manifest"),
            )
            .expect("write incomplete manifest");

            write_settings(&mismatched_type.join(SETTINGS_BACKUP_FILENAME), "dark");
            write_backup_manifest(
                &mismatched_type,
                "backup_20260409_120004_deadbeef",
                Utc::now(),
                BackupType::Settings,
                &[BackupComponent::Settings],
            )
            .await
            .expect("write mismatched manifest");

            write_settings(&undeclared_entry.join(SETTINGS_BACKUP_FILENAME), "dark");
            fs::write(undeclared_entry.join("unexpected.json"), "{}").expect("write extra file");
            write_backup_manifest(
                &undeclared_entry,
                "settings_20260409_120005_deadbeef",
                Utc::now(),
                BackupType::Settings,
                &[BackupComponent::Settings],
            )
            .await
            .expect("write manifest with undeclared entry");

            let manager = manager_for(backup_dir, 7);
            assert!(manager
                .list_backups()
                .await
                .expect("list backups")
                .is_empty());

            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn restore_rejects_hash_mismatch_without_mutating_live_settings() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("hash-mismatch");
            let data_dir = root.join("data");
            let backup_dir = root.join("backups");
            let settings_path = root.join("config/settings.json");
            fs::create_dir_all(&data_dir).expect("create data dir");
            write_settings(&settings_path, "dark");

            let manager = manager_for(backup_dir.clone(), 7);
            let info = manager
                .create_backup_with_sources(&data_dir, &settings_path, BackupType::Settings, None)
                .await
                .expect("create settings backup");
            write_settings(
                &backup_dir.join(&info.id).join(SETTINGS_BACKUP_FILENAME),
                "system",
            );
            write_settings(&settings_path, "light");

            let error = manager
                .restore_backup_to_targets(&info.id, &data_dir, &settings_path)
                .await
                .expect_err("hash mismatch must reject restore");
            assert!(error.to_string().contains("inventory"));
            let live: crate::settings::Settings = serde_json::from_str(
                &fs::read_to_string(&settings_path).expect("read live settings"),
            )
            .expect("parse live settings");
            assert_eq!(live.theme, "light");

            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn restore_rejects_database_that_fails_quick_check() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("quick-check");
            let backup_root = root.join("backups");
            let backup_id = "backup_20260802_120000_deadbeef";
            let generation = backup_root.join(backup_id);
            let data_dir = root.join("data");
            let settings_path = root.join("config/settings.json");
            fs::create_dir_all(&generation).expect("create generation");
            fs::create_dir_all(&data_dir).expect("create data dir");

            let corrupt_database = generation.join("plainsong.db");
            let conn = Connection::open(&corrupt_database).expect("create sqlite database");
            conn.execute_batch(
                "CREATE TABLE payload (id INTEGER PRIMARY KEY, value TEXT);
                 INSERT INTO payload (value) VALUES (zeroblob(8192));
                 PRAGMA user_version = 1;",
            )
            .expect("seed sqlite database");
            drop(conn);
            let mut bytes = fs::read(&corrupt_database).expect("read sqlite database");
            bytes[100..116].fill(0xff);
            fs::write(&corrupt_database, bytes).expect("corrupt sqlite page");

            write_backup_manifest(
                &generation,
                backup_id,
                Utc::now(),
                BackupType::Full,
                &[BackupComponent::Database],
            )
            .await
            .expect("write manifest for corrupt database");

            let live_database = data_dir.join("plainsong.db");
            let live_conn = Connection::open(&live_database).expect("create live database");
            live_conn
                .execute_batch(
                    "CREATE TABLE live_sentinel (value TEXT NOT NULL);
                     INSERT INTO live_sentinel (value) VALUES ('known-good-live-data');
                     PRAGMA user_version = 1;",
                )
                .expect("seed live database");
            drop(live_conn);
            let live_before = fs::read(&live_database).expect("read live database before restore");
            let manager = manager_for(backup_root, 7);
            let error = manager
                .restore_backup_to_targets(backup_id, &data_dir, &settings_path)
                .await
                .expect_err("quick_check must reject corrupt database");
            assert!(error.to_string().contains("validation"));
            assert_eq!(
                fs::read(&live_database).expect("read live database after rejection"),
                live_before
            );

            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn full_restore_rebases_managed_recording_paths() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("recording-path-rebase");
            let source_data = root.join("source-data");
            let target_data = root.join("target-data");
            let backup_dir = root.join("backups");
            let source_settings = root.join("source-config/settings.json");
            let target_settings = root.join("target-config/settings.json");
            let snapshot = root.join("snapshot.db");
            let source_recording = source_data.join("recordings/nested/meeting.wav");
            fs::create_dir_all(source_recording.parent().expect("recording parent"))
                .expect("create source recordings");
            fs::write(&source_recording, "audio").expect("write source recording");
            write_settings(&source_settings, "dark");

            let conn = Connection::open(&snapshot).expect("create database snapshot");
            conn.execute_batch(
                "CREATE TABLE recordings (id TEXT PRIMARY KEY, audio_path TEXT);
                 CREATE TABLE recording_audio_assets (
                    recording_id TEXT, role TEXT, path TEXT
                 );
                 CREATE TABLE recording_audio_operation_items (
                    operation_id TEXT, recording_id TEXT, role TEXT,
                    source_path TEXT, staged_path TEXT, target_path TEXT
                 );
                 PRAGMA user_version = 1;",
            )
            .expect("create recording path tables");
            conn.execute(
                "INSERT INTO recordings (id, audio_path) VALUES ('r1', ?1)",
                [source_recording.to_string_lossy().as_ref()],
            )
            .expect("seed source recording path");
            conn.execute(
                "INSERT INTO recording_audio_assets (recording_id, role, path)
                 VALUES ('r1', 'primary', ?1)",
                [source_recording.to_string_lossy().as_ref()],
            )
            .expect("seed source asset path");
            conn.execute(
                "INSERT INTO recording_audio_operation_items (
                    operation_id, recording_id, role, source_path, staged_path, target_path
                 ) VALUES ('op1', 'r1', 'primary', ?1, ?2, ?3)",
                params![
                    source_recording.to_string_lossy().as_ref(),
                    source_data
                        .join("recordings/nested/.meeting.stage")
                        .to_string_lossy()
                        .as_ref(),
                    source_data
                        .join("recordings/nested/meeting.wav.enc")
                        .to_string_lossy()
                        .as_ref(),
                ],
            )
            .expect("seed operation paths");
            drop(conn);

            let manager = manager_for(backup_dir, 7);
            let info = manager
                .create_backup_with_sources(
                    &source_data,
                    &source_settings,
                    BackupType::Full,
                    Some(&snapshot),
                )
                .await
                .expect("create portable full backup");
            let stored_backup = Connection::open(
                manager
                    .config()
                    .backup_dir
                    .as_ref()
                    .expect("backup dir")
                    .join(&info.id)
                    .join("plainsong.db"),
            )
            .expect("open backup database");
            let stored_path: String = stored_backup
                .query_row(
                    "SELECT audio_path FROM recordings WHERE id = 'r1'",
                    [],
                    |row| row.get(0),
                )
                .expect("read portable stored path");
            assert_eq!(
                PathBuf::from(stored_path),
                PathBuf::from("nested/meeting.wav")
            );
            let stored_asset_path: String = stored_backup
                .query_row(
                    "SELECT path FROM recording_audio_assets WHERE recording_id = 'r1'",
                    [],
                    |row| row.get(0),
                )
                .expect("read portable asset path");
            assert_eq!(
                PathBuf::from(stored_asset_path),
                PathBuf::from("nested/meeting.wav")
            );
            let stored_operation_paths: (String, String, String) = stored_backup
                .query_row(
                    "SELECT source_path, staged_path, target_path
                     FROM recording_audio_operation_items WHERE operation_id = 'op1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("read portable operation paths");
            assert_eq!(
                stored_operation_paths,
                (
                    "nested/meeting.wav".to_string(),
                    "nested/.meeting.stage".to_string(),
                    "nested/meeting.wav.enc".to_string(),
                )
            );
            drop(stored_backup);

            manager
                .restore_backup_to_targets(&info.id, &target_data, &target_settings)
                .await
                .expect("restore portable full backup");

            let restored =
                Connection::open(target_data.join("plainsong.db")).expect("open restored database");
            let restored_path: String = restored
                .query_row(
                    "SELECT audio_path FROM recordings WHERE id = 'r1'",
                    [],
                    |row| row.get(0),
                )
                .expect("read rebased path");
            assert_eq!(
                PathBuf::from(restored_path),
                target_data.join("recordings/nested/meeting.wav")
            );
            let restored_asset_path: String = restored
                .query_row(
                    "SELECT path FROM recording_audio_assets WHERE recording_id = 'r1'",
                    [],
                    |row| row.get(0),
                )
                .expect("read rebased asset path");
            assert_eq!(
                PathBuf::from(restored_asset_path),
                target_data.join("recordings/nested/meeting.wav")
            );
            let restored_operation_paths: (String, String, String) = restored
                .query_row(
                    "SELECT source_path, staged_path, target_path
                     FROM recording_audio_operation_items WHERE operation_id = 'op1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("read rebased operation paths");
            assert_eq!(
                restored_operation_paths,
                (
                    target_data
                        .join("recordings/nested/meeting.wav")
                        .to_string_lossy()
                        .to_string(),
                    target_data
                        .join("recordings/nested/.meeting.stage")
                        .to_string_lossy()
                        .to_string(),
                    target_data
                        .join("recordings/nested/meeting.wav.enc")
                        .to_string_lossy()
                        .to_string(),
                )
            );
            assert!(target_data.join("recordings/nested/meeting.wav").is_file());

            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn vault_database_restore_is_rejected_before_live_mutation() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("vault-restore-rejection");
            let backup_root = root.join("backups");
            let backup_id = "backup_20260802_120001_deadbeef";
            let generation = backup_root.join(backup_id);
            let data_dir = root.join("data");
            let settings_path = root.join("config/settings.json");
            fs::create_dir_all(&generation).expect("create generation");
            fs::create_dir_all(&data_dir).expect("create data dir");
            fs::write(generation.join("plainsong.db"), [0x7au8; 4096])
                .expect("write encrypted-looking database");
            write_backup_manifest(
                &generation,
                backup_id,
                Utc::now(),
                BackupType::Full,
                &[BackupComponent::Database],
            )
            .await
            .expect("write vault manifest");
            let live_database = data_dir.join("plainsong.db");
            fs::write(&live_database, "live-database").expect("write live database");

            let manager = manager_for(backup_root, 7);
            let error = manager
                .restore_backup_to_targets(backup_id, &data_dir, &settings_path)
                .await
                .expect_err("vault restore must be rejected");
            assert!(error.to_string().contains("Keychain-only key"));
            assert_eq!(
                fs::read_to_string(live_database).expect("read live database"),
                "live-database"
            );

            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn settings_restore_copies_only_settings_and_reports_runtime_scope() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("settings-restore");
            let data_dir = root.join("data");
            let backup_dir = root.join("backups");
            let settings_path = root.join("config/settings.json");
            fs::create_dir_all(&data_dir).expect("create data dir");
            fs::write(data_dir.join("plainsong.db"), "live-db").expect("write live database");
            write_settings(&settings_path, "dark");

            let manager = manager_for(backup_dir, 7);
            let info = manager
                .create_backup_with_sources(&data_dir, &settings_path, BackupType::Settings, None)
                .await
                .expect("create settings snapshot");
            write_settings(&settings_path, "light");

            let outcome = manager
                .restore_backup_to_targets(&info.id, &data_dir, &settings_path)
                .await
                .expect("restore settings snapshot");
            assert_eq!(
                outcome,
                BackupRestoreOutcome {
                    restored_database: false,
                    restored_recordings: false,
                    restored_settings: true,
                }
            );
            assert_eq!(
                fs::read_to_string(data_dir.join("plainsong.db")).expect("read live database"),
                "live-db"
            );
            let restored: crate::settings::Settings = serde_json::from_str(
                &fs::read_to_string(&settings_path).expect("read restored settings"),
            )
            .expect("parse restored settings");
            assert_eq!(restored.theme, "dark");

            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn restore_commit_rolls_back_when_later_unit_fails() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("restore-rollback");
            let backup_dir = root.join("backup");
            let live_data_dir = root.join("live-data");
            let config_dir = root.join("config");
            let settings_path = config_dir.join("settings.json");
            fs::create_dir_all(&backup_dir).expect("create backup dir");
            fs::create_dir_all(&live_data_dir).expect("create live data dir");
            fs::create_dir_all(&config_dir).expect("create config dir");

            fs::write(backup_dir.join("plainsong.db"), "new-db").expect("write backup db");
            fs::write(
                backup_dir.join(SETTINGS_BACKUP_FILENAME),
                "{\"theme\":\"new\"}",
            )
            .expect("write backup settings");
            fs::write(live_data_dir.join("plainsong.db"), "old-db").expect("write live db");
            fs::write(&settings_path, "{\"theme\":\"old\"}").expect("write live settings");

            let units = build_restore_units(
                &backup_dir,
                &live_data_dir,
                &settings_path,
                &[BackupComponent::Database, BackupComponent::Settings],
                "tx-rollback",
            );

            stage_restore_units(&units)
                .await
                .expect("stage restore units");
            remove_path_if_exists(&units[1].staged_path)
                .await
                .expect("remove staged settings to force failure");

            let err = commit_restore_units(&units)
                .await
                .expect_err("commit should fail");
            assert!(err.to_string().contains("Failed to commit restored"));
            assert_eq!(
                fs::read_to_string(live_data_dir.join("plainsong.db"))
                    .expect("read rolled back db"),
                "old-db"
            );
            assert_eq!(
                fs::read_to_string(&settings_path).expect("read rolled back settings"),
                "{\"theme\":\"old\"}"
            );

            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn restore_rejects_manifest_with_missing_declared_component() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("restore-manifest-validation");
            let backup_root = root.join("backups");
            let backup_id = "settings_20260409_120000_deadbeef";
            let generation = backup_root.join(backup_id);
            let data_dir = root.join("data");
            let settings_path = root.join("config/settings.json");
            fs::create_dir_all(&generation).expect("create generation");
            fs::create_dir_all(&data_dir).expect("create data dir");
            write_settings(&settings_path, "light");
            write_backup_manifest(
                &generation,
                backup_id,
                Utc::now(),
                BackupType::Settings,
                &[BackupComponent::Settings],
            )
            .await
            .expect("write manifest");

            let manager = manager_for(backup_root, 7);
            let error = manager
                .restore_backup_to_targets(backup_id, &data_dir, &settings_path)
                .await
                .expect_err("missing component must block restore");
            assert!(error.to_string().contains("is missing"));
            let live: crate::settings::Settings = serde_json::from_str(
                &fs::read_to_string(&settings_path).expect("read live settings"),
            )
            .expect("parse live settings");
            assert_eq!(live.theme, "light");

            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn restore_rejects_missing_and_type_inconsistent_manifests() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("restore-manifest-presence-and-type");
            let backup_root = root.join("backups");
            let missing_id = "settings_20260409_120010_deadbeef";
            let inconsistent_id = "backup_20260409_120011_deadbeef";
            let missing_generation = backup_root.join(missing_id);
            let inconsistent_generation = backup_root.join(inconsistent_id);
            let data_dir = root.join("data");
            let settings_path = root.join("config/settings.json");
            fs::create_dir_all(&missing_generation).expect("create missing manifest generation");
            fs::create_dir_all(&inconsistent_generation)
                .expect("create inconsistent manifest generation");
            fs::create_dir_all(&data_dir).expect("create data dir");
            write_settings(&settings_path, "light");
            write_settings(&missing_generation.join(SETTINGS_BACKUP_FILENAME), "dark");
            write_settings(
                &inconsistent_generation.join(SETTINGS_BACKUP_FILENAME),
                "dark",
            );
            write_backup_manifest(
                &inconsistent_generation,
                inconsistent_id,
                Utc::now(),
                BackupType::Settings,
                &[BackupComponent::Settings],
            )
            .await
            .expect("write inconsistent manifest");

            let manager = manager_for(backup_root, 7);
            let missing_error = manager
                .restore_backup_to_targets(missing_id, &data_dir, &settings_path)
                .await
                .expect_err("missing manifest must block restore");
            assert!(missing_error.to_string().contains("manifest"));

            let inconsistent_error = manager
                .restore_backup_to_targets(inconsistent_id, &data_dir, &settings_path)
                .await
                .expect_err("type mismatch must block restore");
            assert!(inconsistent_error.to_string().contains("inconsistent"));

            let live: crate::settings::Settings = serde_json::from_str(
                &fs::read_to_string(&settings_path).expect("read live settings"),
            )
            .expect("parse live settings");
            assert_eq!(live.theme, "light");

            let _ = fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn sync_to_icloud_swaps_existing_destination() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("icloud-sync");
            let source = root.join("source-backup");
            let icloud_root = root.join("icloud");
            let destination = icloud_root.join("PlainsongBackups").join("source-backup");

            fs::create_dir_all(&source).expect("create source dir");
            fs::create_dir_all(&destination).expect("create destination dir");
            fs::write(source.join("settings.json"), "{\"version\":\"new\"}")
                .expect("write new backup");
            fs::write(destination.join("settings.json"), "{\"version\":\"old\"}")
                .expect("write existing backup");

            let config = BackupConfig {
                cloud_sync: true,
                cloud_provider: Some(CloudProvider::ICloud),
                icloud_path: Some(icloud_root.clone()),
                ..BackupConfig::default()
            };

            sync_to_icloud(&config, &source)
                .await
                .expect("sync to icloud should succeed");

            assert_eq!(
                fs::read_to_string(destination.join("settings.json")).expect("read synced backup"),
                "{\"version\":\"new\"}"
            );
            let temp_entries = fs::read_dir(icloud_root.join("PlainsongBackups"))
                .expect("read icloud folder")
                .filter_map(|entry| entry.ok())
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".source-backup")
                })
                .count();
            assert_eq!(temp_entries, 0);

            let _ = fs::remove_dir_all(&root);
        });
    }
}
