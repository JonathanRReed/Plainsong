//! Infrastructure commands: download, provider secrets, license, software updates.
//!
//! These are extracted from lib.rs to reduce its size. They have no dependency on
//! AppState and can be freely moved without affecting the Tauri command registry
//! (they are re-exported via `use crate::commands::infra::*` in lib.rs).

use crate::{download, license, secrets, update};
use tauri::AppHandle;

// ── Helpers (re-used within this module) ─────────────────────────────────────

fn nautilus_data_root() -> Result<std::path::PathBuf, String> {
    crate::nautilus_data_root()
}

fn canonicalize_existing_absolute_path(
    path: &str,
    param: &str,
) -> Result<std::path::PathBuf, String> {
    crate::canonicalize_existing_absolute_path(path, param)
}

// ── Download / Model management ──────────────────────────────────────────────

#[tauri::command]
#[allow(non_snake_case)]
pub async fn download_whisper_model(modelName: String) -> Result<String, String> {
    let manager = download::DownloadManager::new().map_err(|e| e.to_string())?;
    let progress_callback = |progress: download::DownloadProgress| {
        tracing::info!(
            "Download progress: {:.1}% ({}/{})",
            progress.percentage,
            download::format_bytes(progress.bytes_downloaded),
            download::format_bytes(progress.total_bytes)
        );
    };
    let path = manager
        .download_whisper_model(&modelName, progress_callback)
        .await
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn list_downloaded_models() -> Result<Vec<download::DownloadedModel>, String> {
    let manager = download::DownloadManager::new().map_err(|e| e.to_string())?;
    manager
        .list_downloaded_models()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_model(path: String) -> Result<(), String> {
    let manager = download::DownloadManager::new().map_err(|e| e.to_string())?;
    let canonical = canonicalize_existing_absolute_path(&path, "path")?;
    let models_root = nautilus_data_root()?.join("models");
    let models_root = models_root.canonicalize().unwrap_or(models_root);
    if !canonical.starts_with(&models_root) {
        return Err(format!(
            "Refusing to delete model outside managed directory '{}': {}",
            models_root.display(),
            canonical.display()
        ));
    }
    manager
        .delete_model(&canonical)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_available_space() -> Result<u64, String> {
    let manager = download::DownloadManager::new().map_err(|e| e.to_string())?;
    manager
        .get_available_space()
        .await
        .map_err(|e| e.to_string())
}

// ── Provider secrets ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn has_provider_secret(provider: String) -> Result<bool, String> {
    let normalized = crate::normalize_provider_secret_name(&provider)?;
    secrets::has_provider_secret(normalized).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_provider_secret(provider: String, secret: String) -> Result<(), String> {
    let normalized = crate::normalize_provider_secret_name(&provider)?;
    secrets::set_provider_secret(normalized, &secret).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_provider_secret(provider: String) -> Result<(), String> {
    let normalized = crate::normalize_provider_secret_name(&provider)?;
    secrets::clear_provider_secret(normalized).map_err(|e| e.to_string())
}

// ── License ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn validate_license() -> license::LicenseInfo {
    license::validate_license().await
}

#[tauri::command]
pub async fn activate_license(key: String) -> Result<license::LicenseInfo, String> {
    license::activate_license(&key).await
}

#[tauri::command]
pub async fn deactivate_license() -> Result<(), String> {
    license::deactivate_license().await
}

#[tauri::command]
pub fn get_entitlement() -> license::Entitlement {
    license::get_current_entitlement()
}

// ── Software updates ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<Option<update::UpdateInfo>, String> {
    update::UpdateService::new(app)
        .check_for_updates()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    update::UpdateService::new(app)
        .install_update()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_update_status(app: AppHandle) -> Result<update::UpdateStatus, String> {
    Ok(update::UpdateService::new(app).get_status().await)
}

#[tauri::command]
pub async fn get_update_channel(app: AppHandle) -> Result<update::UpdateChannel, String> {
    Ok(update::UpdateService::new(app).get_channel().await)
}

#[tauri::command]
pub async fn set_update_channel(
    app: AppHandle,
    channel: update::UpdateChannel,
) -> Result<(), String> {
    update::UpdateService::new(app)
        .set_channel(channel)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn can_use_beta_channel(app: AppHandle) -> Result<bool, String> {
    Ok(update::UpdateService::new(app).can_use_beta().await)
}

#[tauri::command]
pub async fn get_update_lock_reason(app: AppHandle) -> Result<Option<String>, String> {
    Ok(update::UpdateService::new(app).get_lock_reason().await)
}
