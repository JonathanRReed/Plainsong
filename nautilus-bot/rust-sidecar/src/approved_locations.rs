//! Privileged storage-location registry.
//!
//! Renderer settings may carry opaque IDs and safe labels, but never gain the
//! authority to persist a filesystem or rclone destination. Electron obtains
//! the raw destination from a native picker or confirmation dialog, then calls
//! the internal-only approval commands that write this registry.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

pub const BUILTIN_BACKUP_LOCATION_ID: &str = "builtin-plainsong-backups";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovedLocationPurpose {
    Export,
    Backup,
    CloudBackup,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ApprovedLocationTarget {
    Filesystem { canonical_path: PathBuf },
    Rclone { remote_name: String, folder: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovedLocation {
    id: String,
    purpose: ApprovedLocationPurpose,
    label: String,
    target: ApprovedLocationTarget,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ApprovedLocationFile {
    version: u32,
    locations: Vec<ApprovedLocation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedLocationSummary {
    pub id: String,
    pub label: String,
    pub approved: bool,
}

#[derive(Debug, Clone)]
pub struct ApprovedLocationRegistry {
    path: PathBuf,
}

impl ApprovedLocationRegistry {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn load(&self) -> Result<ApprovedLocationFile> {
        if !self.path.exists() {
            return Ok(ApprovedLocationFile {
                version: 1,
                locations: Vec::new(),
            });
        }
        let raw = std::fs::read_to_string(&self.path)
            .with_context(|| format!("Failed to read {}", self.path.display()))?;
        let mut file: ApprovedLocationFile = serde_json::from_str(&raw)
            .with_context(|| format!("Failed to parse {}", self.path.display()))?;
        if file.version == 0 {
            file.version = 1;
        }
        Ok(file)
    }

    fn save(&self, file: &ApprovedLocationFile) -> Result<()> {
        let parent = self
            .path
            .parent()
            .context("Approved-location registry has no parent directory")?;
        crate::safe_fs::ensure_directory_without_links(parent)?;
        let mut bytes = serde_json::to_vec_pretty(file)?;
        bytes.push(b'\n');
        crate::safe_fs::atomic_write(&self.path, &bytes)
            .context("Failed to persist approved storage locations atomically")
    }

    pub fn approve_filesystem(
        &self,
        purpose: ApprovedLocationPurpose,
        raw_path: &Path,
    ) -> Result<ApprovedLocationSummary> {
        let canonical = validate_picker_directory(raw_path)?;
        reject_sensitive_root(&canonical)?;
        let label = safe_path_label(&canonical);
        let location = ApprovedLocation {
            id: uuid::Uuid::new_v4().to_string(),
            purpose,
            label: label.clone(),
            target: ApprovedLocationTarget::Filesystem {
                canonical_path: canonical,
            },
        };
        let mut file = self.load()?;
        file.locations.retain(|entry| entry.purpose != purpose);
        file.locations.push(location.clone());
        self.save(&file)?;
        Ok(ApprovedLocationSummary {
            id: location.id,
            label,
            approved: true,
        })
    }

    pub fn approve_rclone(
        &self,
        remote_name: &str,
        folder: &str,
    ) -> Result<ApprovedLocationSummary> {
        let remote_name = validate_rclone_remote_name(remote_name)?;
        let folder = validate_relative_cloud_folder(folder)?;
        let label = format!("{}:{}", remote_name, folder);
        let location = ApprovedLocation {
            id: uuid::Uuid::new_v4().to_string(),
            purpose: ApprovedLocationPurpose::CloudBackup,
            label: label.clone(),
            target: ApprovedLocationTarget::Rclone {
                remote_name,
                folder,
            },
        };
        let mut file = self.load()?;
        file.locations
            .retain(|entry| entry.purpose != ApprovedLocationPurpose::CloudBackup);
        file.locations.push(location.clone());
        self.save(&file)?;
        Ok(ApprovedLocationSummary {
            id: location.id,
            label,
            approved: true,
        })
    }

    pub fn resolve_filesystem(
        &self,
        id: &str,
        purpose: ApprovedLocationPurpose,
    ) -> Result<PathBuf> {
        if id == BUILTIN_BACKUP_LOCATION_ID && purpose == ApprovedLocationPurpose::Backup {
            return Ok(crate::backup::default_backup_dir());
        }
        let file = self.load()?;
        let entry = file
            .locations
            .iter()
            .find(|entry| entry.id == id && entry.purpose == purpose)
            .context("Storage location is not approved. Choose it again in Settings")?;
        let ApprovedLocationTarget::Filesystem { canonical_path } = &entry.target else {
            return Err(anyhow::anyhow!(
                "Approved location has the wrong destination type"
            ));
        };
        let current = validate_picker_directory(canonical_path)?;
        if &current != canonical_path {
            return Err(anyhow::anyhow!(
                "Approved storage location changed on disk. Choose it again in Settings"
            ));
        }
        Ok(current)
    }

    pub fn resolve_rclone(&self, id: &str) -> Result<(String, String)> {
        let file = self.load()?;
        let entry = file
            .locations
            .iter()
            .find(|entry| entry.id == id && entry.purpose == ApprovedLocationPurpose::CloudBackup)
            .context("Cloud destination is not approved. Confirm it again in Settings")?;
        let ApprovedLocationTarget::Rclone {
            remote_name,
            folder,
        } = &entry.target
        else {
            return Err(anyhow::anyhow!(
                "Approved location is not an rclone destination"
            ));
        };
        Ok((remote_name.clone(), folder.clone()))
    }

    pub fn summary(&self, id: &str, purpose: ApprovedLocationPurpose) -> ApprovedLocationSummary {
        if id == BUILTIN_BACKUP_LOCATION_ID && purpose == ApprovedLocationPurpose::Backup {
            return ApprovedLocationSummary {
                id: id.to_string(),
                label: "Plainsong backups".to_string(),
                approved: true,
            };
        }
        let entry = self.load().ok().and_then(|file| {
            file.locations
                .into_iter()
                .find(|entry| entry.id == id && entry.purpose == purpose)
        });
        match entry {
            Some(entry) => ApprovedLocationSummary {
                id: entry.id,
                label: entry.label,
                approved: true,
            },
            None => ApprovedLocationSummary {
                id: id.to_string(),
                label: "Location needs reselection".to_string(),
                approved: false,
            },
        }
    }
}

pub fn registry() -> Result<ApprovedLocationRegistry> {
    Ok(ApprovedLocationRegistry::new(
        crate::settings::nautilus_config_dir()?.join("approved-locations.json"),
    ))
}

fn validate_picker_directory(raw_path: &Path) -> Result<PathBuf> {
    if !raw_path.is_absolute() {
        return Err(anyhow::anyhow!("Storage location must be an absolute path"));
    }
    let metadata = std::fs::symlink_metadata(raw_path)
        .with_context(|| format!("Storage location does not exist: {}", raw_path.display()))?;
    if !metadata.file_type().is_dir() {
        return Err(anyhow::anyhow!("Storage location must be a real directory"));
    }
    std::fs::canonicalize(raw_path)
        .with_context(|| format!("Could not resolve storage location {}", raw_path.display()))
}

fn reject_sensitive_root(path: &Path) -> Result<()> {
    if path.parent().is_none() {
        return Err(anyhow::anyhow!(
            "The filesystem root cannot be used as a storage location"
        ));
    }
    if let Some(home) = dirs::home_dir().and_then(|value| value.canonicalize().ok()) {
        if path == home {
            return Err(anyhow::anyhow!(
                "Your home folder is too broad. Choose a dedicated folder"
            ));
        }
        for sensitive in [
            ".ssh",
            ".gnupg",
            ".aws",
            ".config",
            "Library/LaunchAgents",
            "Library/LaunchDaemons",
        ] {
            if path == home.join(sensitive) || path.starts_with(home.join(sensitive)) {
                return Err(anyhow::anyhow!(
                    "That folder contains sensitive system or credential data"
                ));
            }
        }
    }
    Ok(())
}

fn safe_path_label(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Selected folder")
        .to_string()
}

fn validate_rclone_remote_name(raw: &str) -> Result<String> {
    let value = raw.trim().trim_end_matches(':');
    if value.is_empty()
        || value.len() > 64
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err(anyhow::anyhow!("rclone remote name is invalid"));
    }
    Ok(value.to_string())
}

fn validate_relative_cloud_folder(raw: &str) -> Result<String> {
    let path = Path::new(raw.trim());
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(anyhow::anyhow!(
            "Cloud folder must be a non-empty relative path"
        ));
    }
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(anyhow::anyhow!(
                "Cloud folder cannot contain traversal segments"
            ));
        }
    }
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> (PathBuf, ApprovedLocationRegistry) {
        let root = std::env::temp_dir().join(format!(
            "plainsong-approved-location-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create fixture root");
        let registry = ApprovedLocationRegistry::new(root.join("registry.json"));
        (root, registry)
    }

    #[test]
    fn approved_location_accepts_picker_selected_directory() {
        let (root, registry) = fixture("legitimate");
        let destination = root.join("exports");
        std::fs::create_dir(&destination).expect("create destination");
        let summary = registry
            .approve_filesystem(ApprovedLocationPurpose::Export, &destination)
            .expect("approve picker destination");
        assert!(summary.approved);
        assert_eq!(summary.label, "exports");
        assert_eq!(
            registry
                .resolve_filesystem(&summary.id, ApprovedLocationPurpose::Export)
                .expect("resolve approved destination"),
            destination.canonicalize().expect("canonical destination")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn approved_location_rejects_files_and_missing_or_relative_paths() {
        let (root, registry) = fixture("invalid");
        let file = root.join(".zshrc");
        std::fs::write(&file, "alias secret=value").expect("write fixture file");
        assert!(registry
            .approve_filesystem(ApprovedLocationPurpose::Export, &file)
            .is_err());
        assert!(registry
            .approve_filesystem(ApprovedLocationPurpose::Export, Path::new("relative"))
            .is_err());
        assert!(registry
            .approve_filesystem(ApprovedLocationPurpose::Export, &root.join("missing"))
            .is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn approved_location_rejects_home_and_sensitive_system_locations() {
        if let Some(home) = dirs::home_dir().and_then(|path| path.canonicalize().ok()) {
            assert!(reject_sensitive_root(&home).is_err());
            assert!(reject_sensitive_root(&home.join(".ssh")).is_err());
            assert!(reject_sensitive_root(&home.join("Library/LaunchAgents")).is_err());
        }
    }

    #[test]
    fn unregistered_and_wrong_purpose_locations_fail_closed() {
        let (root, registry) = fixture("purpose");
        let destination = root.join("backups");
        std::fs::create_dir(&destination).expect("create destination");
        let summary = registry
            .approve_filesystem(ApprovedLocationPurpose::Backup, &destination)
            .expect("approve backup destination");
        assert!(registry
            .resolve_filesystem(&summary.id, ApprovedLocationPurpose::Export)
            .is_err());
        assert!(registry
            .resolve_filesystem("legacy-absolute-path", ApprovedLocationPurpose::Backup)
            .is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn approved_location_revalidates_symlink_replacement_at_use_time() {
        use std::os::unix::fs::symlink;

        let (root, registry) = fixture("symlink-replacement");
        let destination = root.join("exports");
        let outside = root.join("outside");
        std::fs::create_dir(&destination).expect("create destination");
        std::fs::create_dir(&outside).expect("create outside");
        let summary = registry
            .approve_filesystem(ApprovedLocationPurpose::Export, &destination)
            .expect("approve destination");
        std::fs::remove_dir(&destination).expect("remove destination");
        symlink(&outside, &destination).expect("replace with symlink");
        assert!(registry
            .resolve_filesystem(&summary.id, ApprovedLocationPurpose::Export)
            .is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rclone_approval_rejects_remote_and_folder_injection() {
        let (root, registry) = fixture("rclone");
        assert!(registry.approve_rclone("remote;rm", "Backups").is_err());
        assert!(registry.approve_rclone("gdrive", "../outside").is_err());
        let approved = registry
            .approve_rclone("gdrive:", "PlainsongBackups")
            .expect("approve rclone destination");
        assert_eq!(
            registry
                .resolve_rclone(&approved.id)
                .expect("resolve rclone"),
            ("gdrive".to_string(), "PlainsongBackups".to_string())
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
