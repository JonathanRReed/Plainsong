//! Backup management commands extracted from lib.rs (Sprint 8 decomposition).

use crate::{backup, AppState};

#[tauri::command]
pub async fn list_backups(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<backup::BackupInfo>, String> {
    let backup_manager = state.backup_manager.lock().await;
    backup_manager
        .list_backups()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_backup(
    state: tauri::State<'_, AppState>,
    data_dir: String,
) -> Result<backup::BackupInfo, String> {
    let path = crate::canonicalize_existing_absolute_path(&data_dir, "data_dir")?;
    let expected_data_root = crate::nautilus_data_root()?;
    if path != expected_data_root {
        return Err(format!(
            "data_dir must be Nautilus data directory '{}', got '{}'",
            expected_data_root.display(),
            path.display()
        ));
    }
    let backup_manager = state.backup_manager.lock().await;
    backup_manager
        .create_backup(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_backup_default(
    state: tauri::State<'_, AppState>,
) -> Result<backup::BackupInfo, String> {
    let data_dir = dirs::data_dir()
        .ok_or("Could not find data directory")?
        .join("Nautilus");
    let backup_manager = state.backup_manager.lock().await;
    backup_manager
        .create_backup(&data_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restore_backup(
    state: tauri::State<'_, AppState>,
    backup_id: String,
    data_dir: String,
) -> Result<(), String> {
    let path = crate::canonicalize_existing_absolute_path(&data_dir, "data_dir")?;
    let expected_data_root = crate::nautilus_data_root()?;
    if path != expected_data_root {
        return Err(format!(
            "data_dir must be Nautilus data directory '{}', got '{}'",
            expected_data_root.display(),
            path.display()
        ));
    }
    let backup_manager = state.backup_manager.lock().await;
    backup_manager
        .restore_backup(&backup_id, &path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_backup_config(
    state: tauri::State<'_, AppState>,
) -> Result<backup::BackupConfig, String> {
    let backup_manager = state.backup_manager.lock().await;
    Ok(backup_manager.config().clone())
}

#[tauri::command]
pub async fn save_backup_config(
    state: tauri::State<'_, AppState>,
    config: backup::BackupConfig,
) -> Result<(), String> {
    let mut backup_manager = state.backup_manager.lock().await;
    backup_manager.set_config(config).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn verify_backup_cloud_connection(
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let backup_manager = state.backup_manager.lock().await;
    backup_manager
        .verify_cloud_connection()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_backup_setup_report(
    state: tauri::State<'_, AppState>,
) -> Result<backup::CloudSetupReport, String> {
    let backup_manager = state.backup_manager.lock().await;
    Ok(backup_manager.cloud_setup_report().await)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn sync_backup_to_cloud(
    state: tauri::State<'_, AppState>,
    backupId: String,
) -> Result<(), String> {
    let backup_manager = state.backup_manager.lock().await;
    backup_manager
        .sync_backup_to_cloud(&backupId)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn export_backup_archive(
    state: tauri::State<'_, AppState>,
    backupId: String,
    targetPath: String,
) -> Result<(), String> {
    let canonical_target = crate::canonicalize_existing_absolute_path(&targetPath, "targetPath")?;
    if !canonical_target.is_dir() {
        return Err(format!(
            "targetPath must be an existing directory, got '{}'",
            canonical_target.display()
        ));
    }
    crate::ensure_path_in_approved_roots(&canonical_target, "targetPath")?;
    let backup_manager = state.backup_manager.lock().await;
    backup_manager
        .export_backup(&backupId, &canonical_target)
        .await
        .map_err(|e| e.to_string())
}
