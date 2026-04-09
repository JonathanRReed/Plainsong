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

/// Known plaintext used to verify that a derived key is correct.
const VERIFY_PLAINTEXT: &[u8] = b"nautilus-key-check";

/// Project encryption state
#[derive(Debug, Clone)]
pub struct ProjectEncryption {
    pub project_id: String,
    pub key: Option<[u8; KEY_LEN]>,
    pub salt: [u8; SALT_LEN],
    /// Ciphertext of `VERIFY_PLAINTEXT` produced at initialization, used to
    /// confirm that subsequent `unlock` calls supply the correct password.
    pub verify_blob: Option<Vec<u8>>,
}

impl ProjectEncryption {
    /// Create new encryption state with password
    pub fn new_with_password(project_id: String, password: &str) -> Self {
        let salt = ProjectKeyManager::generate_salt();
        let key = ProjectKeyManager::derive_key(password, &salt);
        let verify_blob = ProjectKeyManager::encrypt(VERIFY_PLAINTEXT, &key).ok();

        Self {
            project_id,
            key: Some(key),
            salt,
            verify_blob,
        }
    }

    /// Create from stored salt (key not yet derived)
    pub fn from_salt(project_id: String, salt: [u8; SALT_LEN]) -> Self {
        Self {
            project_id,
            key: None,
            salt,
            verify_blob: None,
        }
    }

    /// Create from stored salt and verification blob
    pub fn from_salt_and_verify(
        project_id: String,
        salt: [u8; SALT_LEN],
        verify_blob: Vec<u8>,
    ) -> Self {
        Self {
            project_id,
            key: None,
            salt,
            verify_blob: Some(verify_blob),
        }
    }

    /// Unlock with password. Returns `true` only if the derived key can
    /// decrypt the verification blob (or if no blob is stored, falls back
    /// to unconditional unlock for backwards compatibility).
    pub fn unlock(&mut self, password: &str) -> bool {
        let derived = ProjectKeyManager::derive_key(password, &self.salt);

        if let Some(ref blob) = self.verify_blob {
            match ProjectKeyManager::decrypt(blob, &derived) {
                Ok(plaintext) if plaintext == VERIFY_PLAINTEXT => {
                    self.key = Some(derived);
                    true
                }
                _ => {
                    // Wrong password — do not store the key
                    false
                }
            }
        } else {
            // No verification blob (legacy project) — accept unconditionally
            self.key = Some(derived);
            true
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let salt = ProjectKeyManager::generate_salt();
        let key = ProjectKeyManager::derive_key("test-password", &salt);
        let plaintext = b"Hello, Nautilus!";

        let encrypted = ProjectKeyManager::encrypt(plaintext, &key).unwrap();
        let decrypted = ProjectKeyManager::decrypt(&encrypted, &key).unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_wrong_key_fails_decrypt() {
        let salt = ProjectKeyManager::generate_salt();
        let key_correct = ProjectKeyManager::derive_key("correct", &salt);
        let key_wrong = ProjectKeyManager::derive_key("wrong", &salt);

        let encrypted = ProjectKeyManager::encrypt(b"secret", &key_correct).unwrap();
        let result = ProjectKeyManager::decrypt(&encrypted, &key_wrong);

        assert!(result.is_err());
    }

    #[test]
    fn test_different_salts_produce_different_keys() {
        let salt_a = ProjectKeyManager::generate_salt();
        let salt_b = ProjectKeyManager::generate_salt();
        let key_a = ProjectKeyManager::derive_key("password", &salt_a);
        let key_b = ProjectKeyManager::derive_key("password", &salt_b);

        assert_ne!(key_a, key_b);
    }

    #[test]
    fn test_salt_roundtrip_serialization() {
        let salt = ProjectKeyManager::generate_salt();
        let hex_str = ProjectKeyManager::salt_to_string(&salt);
        let restored = ProjectKeyManager::salt_from_string(&hex_str).unwrap();

        assert_eq!(salt, restored);
    }

    #[test]
    fn test_invalid_salt_string() {
        assert!(ProjectKeyManager::salt_from_string("not-hex").is_err());
        assert!(ProjectKeyManager::salt_from_string("aabb").is_err()); // too short
    }

    #[test]
    fn test_decrypt_empty_payload_fails() {
        let key = [0u8; KEY_LEN];
        assert!(ProjectKeyManager::decrypt(&[], &key).is_err());
        assert!(ProjectKeyManager::decrypt(&[0u8; 5], &key).is_err());
    }

    #[test]
    fn test_project_encryption_unlock_correct_password() {
        let enc = ProjectEncryption::new_with_password("p1".to_string(), "mypass");
        assert!(enc.is_unlocked());
        assert!(enc.verify_blob.is_some());

        // Re-create from salt + verify_blob and unlock
        let mut enc2 = ProjectEncryption::from_salt_and_verify(
            "p1".to_string(),
            enc.salt,
            enc.verify_blob.clone().unwrap(),
        );
        assert!(!enc2.is_unlocked());
        assert!(enc2.unlock("mypass"));
        assert!(enc2.is_unlocked());
    }

    #[test]
    fn test_project_encryption_unlock_wrong_password() {
        let enc = ProjectEncryption::new_with_password("p1".to_string(), "correct");

        let mut enc2 = ProjectEncryption::from_salt_and_verify(
            "p1".to_string(),
            enc.salt,
            enc.verify_blob.clone().unwrap(),
        );
        assert!(!enc2.unlock("wrong"));
        assert!(!enc2.is_unlocked());
    }

    #[test]
    fn test_project_encryption_lock_zeroizes() {
        let mut enc = ProjectEncryption::new_with_password("p1".to_string(), "pass");
        assert!(enc.is_unlocked());
        enc.lock();
        assert!(!enc.is_unlocked());
        assert!(enc.key.is_none());
    }

    #[test]
    fn test_encryption_manager_lifecycle() {
        let mut mgr = ProjectEncryptionManager::new();

        let salt = mgr.initialize_project("p1".to_string(), "secret");
        assert!(mgr.is_unlocked("p1"));

        // Encrypt and decrypt through manager
        let ct = mgr.encrypt("p1", b"data").unwrap();
        let pt = mgr.decrypt("p1", &ct).unwrap();
        assert_eq!(pt, b"data");

        // Lock and verify
        mgr.lock_project("p1");
        assert!(!mgr.is_unlocked("p1"));

        // Re-unlock with correct password
        assert!(mgr.unlock_project("p1", "secret", salt));
        assert!(mgr.is_unlocked("p1"));
    }
}
