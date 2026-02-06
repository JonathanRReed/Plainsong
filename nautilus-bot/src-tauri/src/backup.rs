//! Automatic backup and cloud synchronization.
//!
//! Supported cloud targets:
//! - iCloud Drive (direct filesystem sync)
//! - Google Drive (rclone remote)
//! - OneDrive (rclone remote)
//! - Proton Drive (rclone remote)

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::process::Command;

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
    /// Enable automatic backups
    pub enabled: bool,
    /// Backup interval in hours
    pub interval_hours: u32,
    /// Maximum number of backups to keep
    pub max_backups: u32,
    /// Backup directory path
    pub backup_dir: Option<PathBuf>,
    /// Enable cloud sync
    pub cloud_sync: bool,
    /// Cloud provider (if cloud sync enabled)
    pub cloud_provider: Option<CloudProvider>,
    /// rclone remote name override for non-iCloud providers
    pub cloud_remote_name: Option<String>,
    /// Folder under provider root where backups are stored
    pub cloud_folder: String,
    /// Optional iCloud path override
    pub icloud_path: Option<PathBuf>,
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_hours: 24,
            max_backups: 7,
            backup_dir: Some(default_backup_dir()),
            cloud_sync: false,
            cloud_provider: None,
            cloud_remote_name: None,
            cloud_folder: "NautilusBackups".to_string(),
            icloud_path: None,
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupType {
    /// Full backup of everything
    Full,
    /// Incremental backup (changes only)
    Incremental,
    /// Settings only
    Settings,
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
        Self { config }
    }

    pub fn config(&self) -> &BackupConfig {
        &self.config
    }

    pub fn set_config(&mut self, mut config: BackupConfig) -> Result<()> {
        if config.backup_dir.is_none() {
            config.backup_dir = Some(default_backup_dir());
        }
        self.config = config;
        self.persist_config()?;
        Ok(())
    }

    /// Create a backup now
    pub async fn create_backup(&self, data_dir: &Path) -> Result<BackupInfo> {
        let backup_dir = self
            .config
            .backup_dir
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No backup directory configured"))?;

        // Ensure backup directory exists
        tokio::fs::create_dir_all(backup_dir).await?;

        // Generate backup ID
        let timestamp = Utc::now();
        let backup_id = format!("backup_{}", timestamp.format("%Y%m%d_%H%M%S"));
        let backup_path = backup_dir.join(&backup_id);
        tokio::fs::create_dir_all(&backup_path).await?;

        // Copy database
        let db_path = data_dir.join("nautilus.db");
        if db_path.exists() {
            let db_backup = backup_path.join("nautilus.db");
            tokio::fs::copy(&db_path, db_backup).await?;
        }

        // Copy recordings
        let recordings_dir = data_dir.join("recordings");
        if recordings_dir.exists() {
            let recordings_backup = backup_path.join("recordings");
            copy_dir_recursive(&recordings_dir, &recordings_backup).await?;
        }

        // Copy settings
        let settings_path = data_dir.join("settings.json");
        if settings_path.exists() {
            let settings_backup = backup_path.join("settings.json");
            tokio::fs::copy(&settings_path, settings_backup).await?;
        }

        let size_bytes = calculate_dir_size(&backup_path).await?;
        let items_count = count_dir_items(&backup_path).await?;

        self.clean_old_backups().await?;

        if self.config.cloud_sync {
            self.sync_backup_to_cloud(&backup_id).await?;
        }

        let info = BackupInfo {
            id: backup_id,
            timestamp,
            size_bytes,
            items_count,
            backup_type: BackupType::Full,
        };

        tracing::info!("Backup created: {} ({} bytes)", info.id, info.size_bytes);
        Ok(info)
    }

    /// Restore from backup
    pub async fn restore_backup(&self, backup_id: &str, data_dir: &Path) -> Result<()> {
        let backup_dir = self
            .config
            .backup_dir
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No backup directory configured"))?;

        let backup_path = backup_dir.join(backup_id);
        if !backup_path.exists() {
            return Err(anyhow::anyhow!("Backup not found: {}", backup_id));
        }

        // Restore database
        let db_backup = backup_path.join("nautilus.db");
        if db_backup.exists() {
            let db_path = data_dir.join("nautilus.db");
            tokio::fs::copy(&db_backup, db_path).await?;
        }

        // Restore recordings
        let recordings_backup = backup_path.join("recordings");
        if recordings_backup.exists() {
            let recordings_dir = data_dir.join("recordings");
            copy_dir_recursive(&recordings_backup, &recordings_dir).await?;
        }

        // Restore settings
        let settings_backup = backup_path.join("settings.json");
        if settings_backup.exists() {
            let settings_path = data_dir.join("settings.json");
            tokio::fs::copy(&settings_backup, settings_path).await?;
        }

        tracing::info!("Backup restored: {}", backup_id);
        Ok(())
    }

    /// List available backups
    pub async fn list_backups(&self) -> Result<Vec<BackupInfo>> {
        let backup_dir = self
            .config
            .backup_dir
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No backup directory configured"))?;

        if !backup_dir.exists() {
            return Ok(Vec::new());
        }

        let mut backups = Vec::new();
        let mut entries = tokio::fs::read_dir(backup_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.is_dir() {
                let metadata = tokio::fs::metadata(&path).await?;
                let modified = metadata.modified()?;
                let timestamp = DateTime::<Utc>::from(modified);
                let size_bytes = calculate_dir_size(&path).await?;
                let items_count = count_dir_items(&path).await?;
                let backup_id = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown")
                    .to_string();

                backups.push(BackupInfo {
                    id: backup_id,
                    timestamp,
                    size_bytes,
                    items_count,
                    backup_type: BackupType::Full,
                });
            }
        }

        backups.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        Ok(backups)
    }

    /// Clean old backups keeping only max_backups
    async fn clean_old_backups(&self) -> Result<()> {
        let backups = self.list_backups().await?;
        if backups.len() <= self.config.max_backups as usize {
            return Ok(());
        }

        let backup_dir = self
            .config
            .backup_dir
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No backup directory configured"))?;
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
        let backup_dir = self
            .config
            .backup_dir
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No backup directory configured"))?;

        let source = backup_dir.join(backup_id);
        if !source.exists() {
            return Err(anyhow::anyhow!("Backup not found: {}", backup_id));
        }

        let zip_path = target_path.join(format!("{}.zip", backup_id));
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
                "Cloud sync enabled",
                "Cloud backup sync is enabled.",
            ));
        } else {
            checks.push(fail_check(
                "cloud_sync_enabled",
                "Cloud sync enabled",
                "Cloud sync is disabled in backup settings.",
            ));
        }

        if let Some(dir) = self.config.backup_dir.as_ref() {
            match tokio::fs::create_dir_all(dir).await {
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
            }
        } else {
            checks.push(fail_check(
                "backup_dir_access",
                "Backup directory access",
                "No backup directory is configured.",
            ));
        }

        let provider = self.config.cloud_provider.clone();
        let Some(provider_value) = provider.as_ref() else {
            checks.push(fail_check(
                "provider_selected",
                "Cloud provider selected",
                "No cloud provider configured.",
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

        checks.push(pass_check(
            "provider_selected",
            "Cloud provider selected",
            &format!("Using provider {:?}", provider_value),
        ));

        let cloud_folder = self.config.cloud_folder.trim();
        if cloud_folder.is_empty() {
            checks.push(fail_check(
                "cloud_folder",
                "Cloud folder configured",
                "Cloud folder cannot be empty.",
            ));
        } else {
            checks.push(pass_check(
                "cloud_folder",
                "Cloud folder configured",
                &format!("Cloud folder: {}", cloud_folder),
            ));
        }

        match provider_value {
            CloudProvider::ICloud => match resolve_icloud_root(self.config.icloud_path.as_ref()) {
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

                let remote = self.config.cloud_remote_name.clone().or_else(|| {
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
            return Err(anyhow::anyhow!("Cloud sync is disabled"));
        }
        let provider = self
            .config
            .cloud_provider
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No cloud provider configured"))?;
        let backup_dir = self
            .config
            .backup_dir
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No backup directory configured"))?;
        let source = backup_dir.join(backup_id);
        if !source.exists() {
            return Err(anyhow::anyhow!("Backup not found: {}", backup_id));
        }

        match provider {
            CloudProvider::ICloud => sync_to_icloud(&self.config, &source).await,
            CloudProvider::GoogleDrive | CloudProvider::OneDrive | CloudProvider::ProtonDrive => {
                sync_to_rclone(provider, &self.config, &source).await
            }
        }
    }

    fn persist_config(&self) -> Result<()> {
        let config_path = backup_config_path()?;
        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(&self.config)?;
        std::fs::write(config_path, json)?;
        Ok(())
    }
}

impl Default for BackupManager {
    fn default() -> Self {
        let config = load_persisted_backup_config().unwrap_or_else(BackupConfig::default);
        Self::new(config)
    }
}

fn default_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Nautilus")
}

fn default_backup_dir() -> PathBuf {
    default_data_dir().join("backups")
}

fn backup_config_path() -> Result<PathBuf> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| anyhow::anyhow!("Could not determine config directory"))?
        .join("Nautilus");
    Ok(config_dir.join("backup-config.json"))
}

fn load_persisted_backup_config() -> Option<BackupConfig> {
    let path = backup_config_path().ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<BackupConfig>(&raw).ok()
}

/// Copy directory recursively
async fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
    tokio::fs::create_dir_all(dst).await?;
    let mut entries = tokio::fs::read_dir(src).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let file_name = entry.file_name();
        let dest_path = dst.join(&file_name);
        if path.is_dir() {
            Box::pin(copy_dir_recursive(&path, &dest_path)).await?;
        } else {
            tokio::fs::copy(&path, dest_path).await?;
        }
    }
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
        use std::fs::File;
        use std::io::{Read, Write};
        use zip::write::SimpleFileOptions;
        use zip::CompressionMethod;

        let file = File::create(&dst_path)
            .with_context(|| format!("Failed to create zip file {}", dst_path.display()))?;
        let mut zip = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        for entry in walkdir::WalkDir::new(&src_path)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            let rel = path
                .strip_prefix(&src_path)
                .with_context(|| format!("Failed to strip path prefix for {}", path.display()))?;
            if rel.as_os_str().is_empty() {
                continue;
            }
            let rel_name = rel.to_string_lossy().replace('\\', "/");
            if path.is_dir() {
                zip.add_directory(rel_name, options)?;
            } else {
                zip.start_file(rel_name, options)?;
                let mut f = File::open(path)?;
                let mut buffer = Vec::new();
                f.read_to_end(&mut buffer)?;
                zip.write_all(&buffer)?;
            }
        }

        zip.finish()?;
        Ok(())
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
    let folder = config.cloud_folder.trim_matches('/');
    let backup_id = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow::anyhow!("Invalid backup path"))?;
    let destination = format!("{remote}:{folder}/{backup_id}");

    let output = Command::new("rclone")
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
    let folder = config.cloud_folder.trim_matches('/');
    let destination = root.join(folder).join(backup_id);

    if destination.exists() {
        tokio::fs::remove_dir_all(&destination).await?;
    }
    copy_dir_recursive(source, &destination).await?;
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
    let version = Command::new("rclone")
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
    let remotes = Command::new("rclone")
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
