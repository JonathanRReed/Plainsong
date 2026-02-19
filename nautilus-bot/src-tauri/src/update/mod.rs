//! Update system module
//!
//! Provides entitlement-gated auto-update functionality for NautilusBot.
//! Wraps tauri-plugin-updater with license-based access control.

pub mod gating;
pub mod service;
pub mod types;

pub use gating::{can_check_for_updates, can_use_beta_channel, get_lock_reason};
pub use service::UpdateService;
pub use types::{UpdateChannel, UpdateError, UpdateInfo, UpdateStatus};
