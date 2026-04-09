//! Update system module
//!
//! Provides entitlement-gated auto-update functionality for NautilusBot.

pub mod gating;
pub mod types;

pub use gating::{can_check_for_updates, can_use_beta_channel, get_lock_reason};
pub use types::{UpdateChannel, UpdateError, UpdateInfo, UpdateStatus};
