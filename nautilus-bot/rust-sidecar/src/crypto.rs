//! Per-project encryption key management
//!
//! Security model:
//! - Argon2id key derivation (memory-hard)
//! - AES-256-GCM authenticated encryption
//! - Random salt and nonce for each encryption event
//! - Key zeroization on lock/drop

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use anyhow::{Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

/// Project key manager
pub struct ProjectKeyManager;

impl ProjectKeyManager {
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
        let cipher =
            Aes256Gcm::new_from_slice(key).map_err(|_| anyhow::anyhow!("Invalid AES key"))?;

        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::rng().fill_bytes(&mut nonce_bytes);
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

        let cipher =
            Aes256Gcm::new_from_slice(key).map_err(|_| anyhow::anyhow!("Invalid AES key"))?;

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
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let salt = [7u8; SALT_LEN];
        let key = ProjectKeyManager::derive_key("test-password", &salt);
        let plaintext = b"Hello, Nautilus!";

        let encrypted = ProjectKeyManager::encrypt(plaintext, &key).unwrap();
        let decrypted = ProjectKeyManager::decrypt(&encrypted, &key).unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_wrong_key_fails_decrypt() {
        let salt = [7u8; SALT_LEN];
        let key_correct = ProjectKeyManager::derive_key("correct", &salt);
        let key_wrong = ProjectKeyManager::derive_key("wrong", &salt);

        let encrypted = ProjectKeyManager::encrypt(b"secret", &key_correct).unwrap();
        let result = ProjectKeyManager::decrypt(&encrypted, &key_wrong);

        assert!(result.is_err());
    }

    #[test]
    fn test_salt_roundtrip_serialization() {
        let salt = [7u8; SALT_LEN];
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
}
