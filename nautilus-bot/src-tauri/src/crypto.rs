//! Per-project encryption key management
//!
//! Security model:
//! - Argon2id key derivation (memory-hard)
//! - AES-256-GCM authenticated encryption
//! - Random salt and nonce for each encryption event
//! - Key zeroization on lock/drop

#![allow(dead_code)]

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use anyhow::{Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use zeroize::Zeroize;

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

/// Project key manager
pub struct ProjectKeyManager;

impl ProjectKeyManager {
    /// Generate a new random salt for key derivation
    pub fn generate_salt() -> [u8; SALT_LEN] {
        let mut salt = [0u8; SALT_LEN];
        rand::thread_rng().fill_bytes(&mut salt);
        salt
    }

    /// Derive encryption key from password and salt using Argon2id
    pub fn derive_key(password: &str, salt: &[u8]) -> [u8; KEY_LEN] {
        let params = Params::new(19_456, 2, 1, Some(KEY_LEN)).expect("invalid argon2 parameters");
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

        let mut key = [0u8; KEY_LEN];
        argon2
            .hash_password_into(password.as_bytes(), salt, &mut key)
            .expect("argon2 key derivation failed");
        key
    }

    /// Encrypt data with AES-256-GCM.
    /// Format: [nonce (12 bytes)] [ciphertext+tag]
    pub fn encrypt(data: &[u8], key: &[u8; KEY_LEN]) -> Result<Vec<u8>> {
        let cipher = Aes256Gcm::new_from_slice(key).context("Invalid AES key")?;

        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, data)
            .map_err(|_| anyhow::anyhow!("Encryption failed"))?;

        let mut result = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        result.extend_from_slice(&nonce_bytes);
        result.extend_from_slice(&ciphertext);
        Ok(result)
    }

    /// Decrypt data with AES-256-GCM.
    pub fn decrypt(encrypted: &[u8], key: &[u8; KEY_LEN]) -> Result<Vec<u8>> {
        if encrypted.len() <= NONCE_LEN {
            return Err(anyhow::anyhow!("Invalid encrypted payload"));
        }

        let cipher = Aes256Gcm::new_from_slice(key).context("Invalid AES key")?;

        let (nonce_bytes, ciphertext) = encrypted.split_at(NONCE_LEN);
        let nonce = Nonce::from_slice(nonce_bytes);

        cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| anyhow::anyhow!("Decryption failed or integrity check mismatch"))
    }

    /// Salt to hex string
    pub fn salt_to_string(salt: &[u8]) -> String {
        hex::encode(salt)
    }

    /// Salt from hex string
    pub fn salt_from_string(salt_str: &str) -> Result<[u8; SALT_LEN]> {
        let decoded = hex::decode(salt_str).context("Invalid salt encoding")?;

        if decoded.len() != SALT_LEN {
            return Err(anyhow::anyhow!("Invalid salt length"));
        }

        let mut salt = [0u8; SALT_LEN];
        salt.copy_from_slice(&decoded);
        Ok(salt)
    }
}

impl Default for ProjectKeyManager {
    fn default() -> Self {
        Self
    }
}

/// Encrypted project data wrapper
#[derive(Debug, Clone)]
pub struct EncryptedProjectData {
    /// Encrypted payload
    pub ciphertext: Vec<u8>,
    /// Key salt (hex encoded)
    pub salt: String,
}

/// Project encryption state
#[derive(Debug, Clone)]
pub struct ProjectEncryption {
    pub project_id: String,
    pub key: Option<[u8; KEY_LEN]>,
    pub salt: [u8; SALT_LEN],
}

impl ProjectEncryption {
    /// Create new encryption state with password
    pub fn new_with_password(project_id: String, password: &str) -> Self {
        let salt = ProjectKeyManager::generate_salt();
        let key = ProjectKeyManager::derive_key(password, &salt);

        Self {
            project_id,
            key: Some(key),
            salt,
        }
    }

    /// Create from stored salt (key not yet derived)
    pub fn from_salt(project_id: String, salt: [u8; SALT_LEN]) -> Self {
        Self {
            project_id,
            key: None,
            salt,
        }
    }

    /// Unlock with password
    pub fn unlock(&mut self, password: &str) -> bool {
        let derived = ProjectKeyManager::derive_key(password, &self.salt);
        self.key = Some(derived);
        true
    }

    /// Lock (clear key from memory)
    pub fn lock(&mut self) {
        if let Some(mut key) = self.key.take() {
            key.zeroize();
        }
    }

    /// Check if unlocked
    pub fn is_unlocked(&self) -> bool {
        self.key.is_some()
    }

    /// Encrypt data if unlocked
    pub fn encrypt(&self, data: &[u8]) -> Result<Vec<u8>> {
        match self.key {
            Some(key) => ProjectKeyManager::encrypt(data, &key),
            None => Err(anyhow::anyhow!("Project encryption not unlocked")),
        }
    }

    /// Decrypt data if unlocked
    pub fn decrypt(&self, encrypted: &[u8]) -> Result<Vec<u8>> {
        match self.key {
            Some(key) => ProjectKeyManager::decrypt(encrypted, &key),
            None => Err(anyhow::anyhow!("Project encryption not unlocked")),
        }
    }
}

impl Drop for ProjectEncryption {
    fn drop(&mut self) {
        self.lock();
    }
}

/// Manager for active project encryption sessions
pub struct ProjectEncryptionManager {
    /// Active encryption sessions (project_id -> encryption state)
    sessions: std::collections::HashMap<String, ProjectEncryption>,
}

impl ProjectEncryptionManager {
    pub fn new() -> Self {
        Self {
            sessions: std::collections::HashMap::new(),
        }
    }

    /// Initialize encryption for a project
    pub fn initialize_project(&mut self, project_id: String, password: &str) -> [u8; SALT_LEN] {
        let encryption = ProjectEncryption::new_with_password(project_id.clone(), password);
        let salt = encryption.salt;
        self.sessions.insert(project_id, encryption);
        salt
    }

    /// Unlock a project with password
    pub fn unlock_project(
        &mut self,
        project_id: &str,
        password: &str,
        salt: [u8; SALT_LEN],
    ) -> bool {
        let mut encryption = ProjectEncryption::from_salt(project_id.to_string(), salt);
        let success = encryption.unlock(password);
        if success {
            self.sessions.insert(project_id.to_string(), encryption);
        }
        success
    }

    /// Lock a project
    pub fn lock_project(&mut self, project_id: &str) {
        if let Some(session) = self.sessions.get_mut(project_id) {
            session.lock();
        }
    }

    /// Remove a project session
    pub fn remove_project(&mut self, project_id: &str) {
        self.sessions.remove(project_id);
    }

    /// Check if project is unlocked
    pub fn is_unlocked(&self, project_id: &str) -> bool {
        self.sessions
            .get(project_id)
            .map(|s| s.is_unlocked())
            .unwrap_or(false)
    }

    /// Encrypt data for a project
    pub fn encrypt(&self, project_id: &str, data: &[u8]) -> Result<Vec<u8>> {
        self.sessions
            .get(project_id)
            .ok_or_else(|| anyhow::anyhow!("Project not found in sessions"))
            .and_then(|s| s.encrypt(data))
    }

    /// Decrypt data for a project
    pub fn decrypt(&self, project_id: &str, encrypted: &[u8]) -> Result<Vec<u8>> {
        self.sessions
            .get(project_id)
            .ok_or_else(|| anyhow::anyhow!("Project not found in sessions"))
            .and_then(|s| s.decrypt(encrypted))
    }
}

impl Default for ProjectEncryptionManager {
    fn default() -> Self {
        Self::new()
    }
}
