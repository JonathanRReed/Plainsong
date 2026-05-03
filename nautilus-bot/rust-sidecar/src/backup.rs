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

const SETTINGS_BACKUP_FILENAME: &str = "settings.json";
const BACKUP_MANIFEST_FILENAME: &str = "manifest.json";

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
enum BackupComponent {
    Database,
    Recordings,
    Settings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    id: String,
    timestamp: DateTime<Utc>,
    backup_type: BackupType,
    components: Vec<BackupComponent>,
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

    /// Create a full data backup now.
    pub async fn create_backup(&self, data_dir: &Path) -> Result<BackupInfo> {
        self.create_backup_with_type(data_dir, BackupType::Full)
            .await
    }

    /// Create a settings-only backup for profile sync and migration.
    pub async fn create_settings_backup(&self, data_dir: &Path) -> Result<BackupInfo> {
        self.create_backup_with_type(data_dir, BackupType::Settings)
            .await
    }

    async fn create_backup_with_type(
        &self,
        data_dir: &Path,
        backup_type: BackupType,
    ) -> Result<BackupInfo> {
        let backup_dir = self
            .config
            .backup_dir
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No backup directory configured"))?;

        // Ensure backup directory exists
        tokio::fs::create_dir_all(backup_dir).await?;

        // Generate backup ID
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
        tokio::fs::create_dir_all(&backup_path).await?;
        let mut components = Vec::new();

        if matches!(backup_type, BackupType::Full | BackupType::Incremental) {
            let db_path = data_dir.join("nautilus.db");
            if db_path.exists() {
                let db_backup = backup_path.join("nautilus.db");
                tokio::fs::copy(&db_path, db_backup).await?;
                components.push(BackupComponent::Database);
            }

            let recordings_dir = data_dir.join("recordings");
            if recordings_dir.exists() {
                let recordings_backup = backup_path.join("recordings");
                copy_dir_recursive(&recordings_dir, &recordings_backup).await?;
                components.push(BackupComponent::Recordings);
            }
        }

        let settings_path = crate::settings::settings_file_path()?;
        if settings_path.exists() {
            let settings_backup = backup_path.join(SETTINGS_BACKUP_FILENAME);
            tokio::fs::copy(&settings_path, settings_backup).await?;
            components.push(BackupComponent::Settings);
        }

        if components.is_empty() {
            return Err(anyhow::anyhow!(
                "Cannot create backup because no backup components were found"
            ));
        }

        write_backup_manifest(
            &backup_path,
            &backup_id,
            timestamp,
            backup_type.clone(),
            &components,
        )
        .await?;

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
            backup_type,
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

        let backup_path = resolve_existing_backup_path(backup_dir, backup_id)?;
        let settings_path = crate::settings::settings_file_path()?;
        restore_backup_into_targets(&backup_path, data_dir, &settings_path).await?;

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
                    backup_type: infer_backup_type(&path),
                });
            }
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

        let safe_backup_id = validate_backup_id(backup_id)?;
        let source = resolve_existing_backup_path(backup_dir, &safe_backup_id)?;

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

        match validate_cloud_folder(&self.config.cloud_folder) {
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
        let source = resolve_existing_backup_path(backup_dir, backup_id)?;

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

fn infer_backup_type(path: &Path) -> BackupType {
    let has_database = path.join("nautilus.db").exists();
    let has_recordings = path.join("recordings").exists();
    let has_settings = path.join(SETTINGS_BACKUP_FILENAME).exists();

    if has_settings && !has_database && !has_recordings {
        return BackupType::Settings;
    }

    BackupType::Full
}

impl Default for BackupManager {
    fn default() -> Self {
        let config = load_persisted_backup_config().unwrap_or_default();
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
    if !candidate.exists() {
        return Err(anyhow::anyhow!("Backup not found: {}", safe_backup_id));
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
    let manifest = BackupManifest {
        id: backup_id.to_string(),
        timestamp,
        backup_type,
        components: components.to_vec(),
    };
    let manifest_json =
        serde_json::to_string_pretty(&manifest).context("Failed to serialize backup manifest")?;
    tokio::fs::write(backup_manifest_path(backup_path), manifest_json)
        .await
        .context("Failed to write backup manifest")?;
    Ok(())
}

async fn read_backup_manifest(backup_path: &Path) -> Result<Option<BackupManifest>> {
    let manifest_path = backup_manifest_path(backup_path);
    if !manifest_path.exists() {
        return Ok(None);
    }

    let raw = tokio::fs::read_to_string(&manifest_path)
        .await
        .with_context(|| format!("Failed to read backup manifest {}", manifest_path.display()))?;
    let manifest: BackupManifest =
        serde_json::from_str(&raw).context("Failed to parse backup manifest")?;
    Ok(Some(manifest))
}

fn detect_backup_components(backup_path: &Path) -> Vec<BackupComponent> {
    let mut components = Vec::new();
    if backup_path.join("nautilus.db").exists() {
        components.push(BackupComponent::Database);
    }
    if backup_path.join("recordings").exists() {
        components.push(BackupComponent::Recordings);
    }
    if backup_path.join(SETTINGS_BACKUP_FILENAME).exists() {
        components.push(BackupComponent::Settings);
    }
    components
}

async fn restore_components_for_backup(backup_path: &Path) -> Result<Vec<BackupComponent>> {
    if let Some(manifest) = read_backup_manifest(backup_path).await? {
        if manifest.components.is_empty() {
            return Err(anyhow::anyhow!(
                "Backup manifest does not list any restorable components"
            ));
        }
        return Ok(manifest.components);
    }

    let components = detect_backup_components(backup_path);
    if components.is_empty() {
        return Err(anyhow::anyhow!(
            "Backup does not contain any restorable components"
        ));
    }
    Ok(components)
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
                source_path: backup_path.join("nautilus.db"),
                live_path: data_dir.join("nautilus.db"),
                staged_path: restore_artifact_path(
                    data_dir,
                    "nautilus.db",
                    "restore-stage",
                    transaction_id,
                ),
                rollback_path: restore_artifact_path(
                    data_dir,
                    "nautilus.db",
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
    if !path.exists() {
        return Ok(());
    }

    if path.is_dir() {
        tokio::fs::remove_dir_all(path)
            .await
            .with_context(|| format!("Failed to remove directory {}", path.display()))?;
    } else {
        tokio::fs::remove_file(path)
            .await
            .with_context(|| format!("Failed to remove file {}", path.display()))?;
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
            tokio::fs::create_dir_all(parent).await?;
        }

        let had_live_target = unit.live_path.exists();
        if had_live_target {
            tokio::fs::rename(&unit.live_path, &unit.rollback_path)
                .await
                .with_context(|| {
                    format!(
                        "Failed to move live {:?} into rollback location",
                        unit.component
                    )
                })?;
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

    cleanup_restore_artifacts(units).await;
    Ok(())
}

async fn restore_backup_into_targets(
    backup_path: &Path,
    data_dir: &Path,
    settings_path: &Path,
) -> Result<()> {
    let components = restore_components_for_backup(backup_path).await?;
    let transaction_id = format!("{}-{}", Utc::now().timestamp_millis(), std::process::id());
    let units = build_restore_units(
        backup_path,
        data_dir,
        settings_path,
        &components,
        &transaction_id,
    );
    stage_restore_units(&units).await?;

    if let Err(err) = commit_restore_units(&units).await {
        cleanup_restore_artifacts(&units).await;
        return Err(err);
    }

    Ok(())
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
    let folder = validate_cloud_folder(&config.cloud_folder)?;
    let destination_root = root.join(folder);
    tokio::fs::create_dir_all(&destination_root).await?;
    let destination = destination_root.join(backup_id);
    let transaction_id = format!("{}-{}", Utc::now().timestamp_millis(), std::process::id());
    let temp_destination =
        destination_root.join(format!(".{}.icloud-stage.{}", backup_id, transaction_id));
    let previous_destination =
        destination_root.join(format!(".{}.icloud-previous.{}", backup_id, transaction_id));

    remove_path_if_exists(&temp_destination).await?;
    remove_path_if_exists(&previous_destination).await?;
    copy_dir_recursive(source, &temp_destination).await?;

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

    #[test]
    fn backup_id_rejects_traversal() {
        assert!(validate_backup_id("../outside").is_err());
        assert!(validate_backup_id("backup/2026").is_err());
        assert!(validate_backup_id("backup\\2026").is_err());
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
        assert!(validate_cloud_folder("Nautilus/../Backups").is_err());
    }

    #[test]
    fn cloud_folder_rejects_unsafe_characters() {
        assert!(validate_cloud_folder("Nautilus:Backups").is_err());
        assert!(validate_cloud_folder("Nautilus\nBackups").is_err());
    }

    #[test]
    fn cloud_folder_accepts_nested_safe_paths() {
        let value = validate_cloud_folder("Nautilus/Backups/2026").expect("valid folder");
        assert_eq!(value, "Nautilus/Backups/2026");
    }

    #[test]
    fn infer_backup_type_detects_settings_only_snapshots() {
        let dir = unique_test_dir("settings");
        fs::create_dir_all(&dir).expect("create test dir");
        fs::write(dir.join(SETTINGS_BACKUP_FILENAME), "{}").expect("write settings backup");

        let inferred = infer_backup_type(&dir);
        let _ = fs::remove_dir_all(&dir);

        assert!(matches!(inferred, BackupType::Settings));
    }

    #[test]
    fn infer_backup_type_prefers_full_when_data_files_exist() {
        let dir = unique_test_dir("full");
        fs::create_dir_all(dir.join("recordings")).expect("create recordings dir");
        fs::write(dir.join(SETTINGS_BACKUP_FILENAME), "{}").expect("write settings backup");

        let inferred = infer_backup_type(&dir);
        let _ = fs::remove_dir_all(&dir);

        assert!(matches!(inferred, BackupType::Full));
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

            fs::write(backup_dir.join("nautilus.db"), "new-db").expect("write backup db");
            fs::write(
                backup_dir.join(SETTINGS_BACKUP_FILENAME),
                "{\"theme\":\"new\"}",
            )
            .expect("write backup settings");
            fs::write(live_data_dir.join("nautilus.db"), "old-db").expect("write live db");
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
                fs::read_to_string(live_data_dir.join("nautilus.db")).expect("read rolled back db"),
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
    fn restore_components_use_manifest_when_present() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let backup_dir = unique_test_dir("manifest");
            fs::create_dir_all(&backup_dir).expect("create backup dir");
            fs::write(backup_dir.join("nautilus.db"), "db").expect("write db");
            write_backup_manifest(
                &backup_dir,
                "backup_20260409_120000",
                Utc::now(),
                BackupType::Settings,
                &[BackupComponent::Settings],
            )
            .await
            .expect("write manifest");

            let components = restore_components_for_backup(&backup_dir)
                .await
                .expect("read restore components");
            assert_eq!(components, vec![BackupComponent::Settings]);

            let _ = fs::remove_dir_all(&backup_dir);
        });
    }

    #[test]
    fn sync_to_icloud_swaps_existing_destination() {
        let runtime = Runtime::new().expect("create tokio runtime");
        runtime.block_on(async {
            let root = unique_test_dir("icloud-sync");
            let source = root.join("source-backup");
            let icloud_root = root.join("icloud");
            let destination = icloud_root.join("NautilusBackups").join("source-backup");

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
            let temp_entries = fs::read_dir(icloud_root.join("NautilusBackups"))
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
