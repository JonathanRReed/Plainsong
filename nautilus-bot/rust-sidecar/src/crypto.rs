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
use rand::Rng;
use std::io::{Read, Write};

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
const TAG_LEN: usize = 16;

/// Identifies the framed streaming vault format.
///
/// Recording audio used to be encrypted by reading a whole track into memory,
/// encrypting it into a second full-size buffer, and writing that out -- roughly
/// three times the track size resident at once, for up to three tracks, on the
/// async runtime while holding the database lock. A long meeting could stall the
/// app or exhaust memory outright.
///
/// The streaming format encrypts fixed-size frames with a per-frame nonce
/// derived from a random 8-byte prefix and a 4-byte counter, so memory is one
/// frame regardless of recording length. Each frame's AAD binds its index and
/// whether it is the final frame, which is what makes truncation and reordering
/// detectable rather than silently producing a short recording.
///
/// The magic exists so existing vault files -- written in the legacy
/// whole-file format, which opens with a bare random nonce -- keep decrypting
/// through the old path forever. Format changes get a new version byte.
const STREAM_MAGIC: &[u8; 8] = b"PSVAULT1";
const STREAM_MAGIC_LEN: usize = 8;
const STREAM_VERSION: u8 = 1;
const STREAM_NONCE_PREFIX_LEN: usize = 8;
/// magic + version + frame length + nonce prefix.
const STREAM_HEADER_LEN: usize = STREAM_MAGIC_LEN + 1 + 4 + STREAM_NONCE_PREFIX_LEN;
/// 1 MiB: large enough that per-frame overhead is negligible (~0.002%), small
/// enough that peak memory stays flat for any recording length.
const STREAM_FRAME_LEN: usize = 1024 * 1024;
/// Bound on a frame size read from a file, so a corrupt header cannot make us
/// allocate arbitrarily.
const STREAM_MAX_FRAME_LEN: usize = 64 * 1024 * 1024;

/// Nonce for one frame: random per-file prefix plus the frame counter.
///
/// The prefix is what keeps nonces unique *across* files under the same key;
/// the counter keeps them unique within one.
fn stream_frame_nonce(
    prefix: &[u8; STREAM_NONCE_PREFIX_LEN],
    frame_index: u32,
) -> Nonce<aes_gcm::aes::cipher::consts::U12> {
    let mut nonce = [0u8; NONCE_LEN];
    nonce[..STREAM_NONCE_PREFIX_LEN].copy_from_slice(prefix);
    nonce[STREAM_NONCE_PREFIX_LEN..].copy_from_slice(&frame_index.to_le_bytes());
    Nonce::from(nonce)
}

/// Associated data binding a frame to its position and finality.
fn stream_frame_aad(frame_index: u32, is_last: bool) -> [u8; STREAM_MAGIC_LEN + 1 + 4 + 1] {
    let mut aad = [0u8; STREAM_MAGIC_LEN + 1 + 4 + 1];
    aad[..STREAM_MAGIC_LEN].copy_from_slice(STREAM_MAGIC);
    aad[STREAM_MAGIC_LEN] = STREAM_VERSION;
    aad[STREAM_MAGIC_LEN + 1..STREAM_MAGIC_LEN + 5].copy_from_slice(&frame_index.to_le_bytes());
    aad[STREAM_MAGIC_LEN + 5] = u8::from(is_last);
    aad
}

/// Project key manager
pub struct ProjectKeyManager;

impl ProjectKeyManager {
    /// Derive encryption key from password and salt using Argon2id
    pub fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; KEY_LEN]> {
        let params = Params::new(19_456, 2, 1, Some(KEY_LEN))
            .map_err(|_| anyhow::anyhow!("Invalid argon2 parameters"))?;
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

        let mut key = [0u8; KEY_LEN];
        argon2
            .hash_password_into(password.as_bytes(), salt, &mut key)
            .map_err(|_| anyhow::anyhow!("Argon2 key derivation failed"))?;
        Ok(key)
    }

    /// Encrypt data with AES-256-GCM.
    /// Format: [nonce (12 bytes)] [ciphertext+tag]
    pub fn encrypt(data: &[u8], key: &[u8; KEY_LEN]) -> Result<Vec<u8>> {
        let cipher =
            Aes256Gcm::new_from_slice(key).map_err(|_| anyhow::anyhow!("Invalid AES key"))?;

        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::try_from(&nonce_bytes[..])
            .map_err(|_| anyhow::anyhow!("Invalid AES-GCM nonce length"))?;

        let ciphertext = cipher
            .encrypt(&nonce, data)
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
        let nonce = Nonce::try_from(nonce_bytes)
            .map_err(|_| anyhow::anyhow!("Invalid encrypted payload"))?;

        cipher
            .decrypt(&nonce, ciphertext)
            .map_err(|_| anyhow::anyhow!("Decryption failed or integrity check mismatch"))
    }

    /// Salt to hex string
    pub fn salt_to_string(salt: &[u8]) -> String {
        hex::encode(salt)
    }

    /// Encrypt `reader` into `writer` as framed AEAD, returning plaintext bytes.
    ///
    /// See [`STREAM_MAGIC`] for the format and why it exists.
    pub fn encrypt_stream<R: Read, W: Write>(
        reader: &mut R,
        writer: &mut W,
        key: &[u8; KEY_LEN],
        mut on_progress: impl FnMut(u64),
    ) -> Result<u64> {
        let cipher =
            Aes256Gcm::new_from_slice(key).map_err(|_| anyhow::anyhow!("Invalid AES key"))?;

        let mut nonce_prefix = [0u8; STREAM_NONCE_PREFIX_LEN];
        rand::rng().fill_bytes(&mut nonce_prefix);

        writer.write_all(STREAM_MAGIC)?;
        writer.write_all(&[STREAM_VERSION])?;
        writer.write_all(&(STREAM_FRAME_LEN as u32).to_le_bytes())?;
        writer.write_all(&nonce_prefix)?;

        let mut plaintext_bytes = 0_u64;
        let mut frame_index = 0_u32;
        let mut buffer = vec![0_u8; STREAM_FRAME_LEN];

        loop {
            // Fill a whole frame unless the source ends first, so frame
            // boundaries depend on the data alone and never on how the reader
            // happened to chunk it.
            let mut filled = 0_usize;
            while filled < STREAM_FRAME_LEN {
                match reader.read(&mut buffer[filled..])? {
                    0 => break,
                    read => filled += read,
                }
            }
            let is_last = filled < STREAM_FRAME_LEN;

            let ciphertext = cipher
                .encrypt(
                    &stream_frame_nonce(&nonce_prefix, frame_index),
                    aes_gcm::aead::Payload {
                        msg: &buffer[..filled],
                        aad: &stream_frame_aad(frame_index, is_last),
                    },
                )
                .map_err(|_| anyhow::anyhow!("Encryption failed"))?;

            writer.write_all(&(ciphertext.len() as u32).to_le_bytes())?;
            writer.write_all(&ciphertext)?;

            plaintext_bytes += filled as u64;
            on_progress(plaintext_bytes);

            if is_last {
                break;
            }
            frame_index = frame_index
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("Recording is too large to encrypt"))?;
        }

        Ok(plaintext_bytes)
    }

    /// Decrypt a framed-AEAD stream from `reader` into `writer`.
    pub fn decrypt_stream<R: Read, W: Write>(
        reader: &mut R,
        writer: &mut W,
        key: &[u8; KEY_LEN],
    ) -> Result<u64> {
        let cipher =
            Aes256Gcm::new_from_slice(key).map_err(|_| anyhow::anyhow!("Invalid AES key"))?;

        let mut magic = [0u8; STREAM_MAGIC_LEN];
        reader.read_exact(&mut magic)?;
        if &magic != STREAM_MAGIC {
            anyhow::bail!("Not a streaming vault payload");
        }
        let mut version = [0u8; 1];
        reader.read_exact(&mut version)?;
        if version[0] != STREAM_VERSION {
            anyhow::bail!("Unsupported vault format version {}", version[0]);
        }
        let mut frame_len_bytes = [0u8; 4];
        reader.read_exact(&mut frame_len_bytes)?;
        let frame_len = u32::from_le_bytes(frame_len_bytes) as usize;
        if frame_len == 0 || frame_len > STREAM_MAX_FRAME_LEN {
            anyhow::bail!("Vault payload declares an unusable frame size");
        }
        let mut nonce_prefix = [0u8; STREAM_NONCE_PREFIX_LEN];
        reader.read_exact(&mut nonce_prefix)?;

        let mut plaintext_bytes = 0_u64;
        let mut frame_index = 0_u32;

        loop {
            let mut len_bytes = [0u8; 4];
            reader.read_exact(&mut len_bytes)?;
            let ciphertext_len = u32::from_le_bytes(len_bytes) as usize;
            if ciphertext_len < TAG_LEN || ciphertext_len > frame_len + TAG_LEN {
                anyhow::bail!("Vault payload frame has an invalid length");
            }
            let mut ciphertext = vec![0_u8; ciphertext_len];
            reader.read_exact(&mut ciphertext)?;

            // A frame is final only if it decrypts under the "last" AAD, so a
            // truncated file cannot pass as a complete one: the attacker would
            // have to forge a tag to relabel a middle frame as the end.
            let is_last = ciphertext_len < frame_len + TAG_LEN;
            let plaintext = cipher
                .decrypt(
                    &stream_frame_nonce(&nonce_prefix, frame_index),
                    aes_gcm::aead::Payload {
                        msg: &ciphertext,
                        aad: &stream_frame_aad(frame_index, is_last),
                    },
                )
                .map_err(|_| anyhow::anyhow!("Decryption failed or integrity check mismatch"))?;

            writer.write_all(&plaintext)?;
            plaintext_bytes += plaintext.len() as u64;

            if is_last {
                break;
            }
            frame_index = frame_index
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("Vault payload has too many frames"))?;
        }

        Ok(plaintext_bytes)
    }

    /// Ciphertext size a streaming payload of `plaintext_len` will occupy.
    ///
    /// Exact, not an estimate: the space preflight refuses to start an
    /// encryption it cannot finish, and an optimistic guess there would put us
    /// back to filling the disk halfway through.
    pub fn streaming_ciphertext_len(plaintext_len: u64) -> u64 {
        let full_frames = plaintext_len / STREAM_FRAME_LEN as u64;
        // Always one trailing frame, even for empty input: it is what carries
        // the end-of-stream marker.
        let frames = full_frames.saturating_add(1);
        (STREAM_HEADER_LEN as u64)
            .saturating_add(frames.saturating_mul(4 + TAG_LEN as u64))
            .saturating_add(plaintext_len)
    }

    /// Whether a payload's leading bytes identify the streaming format.
    ///
    /// The legacy format opens with a random 12-byte nonce, so a false positive
    /// needs a 2^-64 collision with the magic; treating that as "not legacy" is
    /// safe because such a payload would fail its tag check either way.
    pub fn is_streaming_payload(prefix: &[u8]) -> bool {
        prefix.len() >= STREAM_MAGIC_LEN && &prefix[..STREAM_MAGIC_LEN] == STREAM_MAGIC
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
        let key = ProjectKeyManager::derive_key("test-password", &salt).unwrap();
        let plaintext = b"Hello, Plainsong!";

        let encrypted = ProjectKeyManager::encrypt(plaintext, &key).unwrap();
        let decrypted = ProjectKeyManager::decrypt(&encrypted, &key).unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_wrong_key_fails_decrypt() {
        let salt = [7u8; SALT_LEN];
        let key_correct = ProjectKeyManager::derive_key("correct", &salt).unwrap();
        let key_wrong = ProjectKeyManager::derive_key("wrong", &salt).unwrap();

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

    fn stream_roundtrip(plaintext: &[u8], key: &[u8; KEY_LEN]) -> Vec<u8> {
        let mut ciphertext = Vec::new();
        let written =
            ProjectKeyManager::encrypt_stream(&mut &plaintext[..], &mut ciphertext, key, |_| {})
                .expect("encrypt");
        assert_eq!(written, plaintext.len() as u64);
        ciphertext
    }

    #[test]
    fn streaming_roundtrips_across_frame_boundaries() {
        let key = ProjectKeyManager::derive_key("pw", &[3u8; SALT_LEN]).unwrap();
        // Empty, sub-frame, exactly one frame, and multi-frame all have to come
        // back byte-identical -- the boundary cases are where a framed format
        // silently truncates.
        for length in [
            0,
            1,
            STREAM_FRAME_LEN - 1,
            STREAM_FRAME_LEN,
            STREAM_FRAME_LEN + 1,
            STREAM_FRAME_LEN * 2 + 7,
        ] {
            let plaintext: Vec<u8> = (0..length).map(|index| (index % 251) as u8).collect();
            let ciphertext = stream_roundtrip(&plaintext, &key);

            let mut recovered = Vec::new();
            let read =
                ProjectKeyManager::decrypt_stream(&mut &ciphertext[..], &mut recovered, &key)
                    .expect("decrypt");

            assert_eq!(read, length as u64, "length {length} round-trip");
            assert_eq!(recovered, plaintext, "length {length} round-trip");
        }
    }

    #[test]
    fn streaming_ciphertext_length_is_exact() {
        // The space preflight refuses work it cannot finish, so this has to be
        // the real size rather than an estimate.
        let key = ProjectKeyManager::derive_key("pw", &[4u8; SALT_LEN]).unwrap();
        for length in [0, 100, STREAM_FRAME_LEN, STREAM_FRAME_LEN * 2 + 512] {
            let plaintext = vec![7u8; length];
            let ciphertext = stream_roundtrip(&plaintext, &key);
            assert_eq!(
                ciphertext.len() as u64,
                ProjectKeyManager::streaming_ciphertext_len(length as u64),
                "projected size must match the bytes actually written for {length}"
            );
        }
        assert_eq!(
            ProjectKeyManager::streaming_ciphertext_len(u64::MAX),
            u64::MAX,
            "unrepresentable projections must fail closed at the largest size"
        );
    }

    #[test]
    fn a_truncated_stream_is_rejected_rather_than_silently_short() {
        // Dropping trailing frames must not yield a shorter, valid-looking
        // recording. The final frame's AAD is what makes this detectable.
        let key = ProjectKeyManager::derive_key("pw", &[5u8; SALT_LEN]).unwrap();
        let plaintext = vec![9u8; STREAM_FRAME_LEN * 2 + 64];
        let ciphertext = stream_roundtrip(&plaintext, &key);

        let truncated = &ciphertext[..STREAM_HEADER_LEN + 4 + STREAM_FRAME_LEN + TAG_LEN];
        let mut recovered = Vec::new();
        assert!(
            ProjectKeyManager::decrypt_stream(&mut &truncated[..], &mut recovered, &key).is_err(),
            "a truncated stream must not decrypt as a complete one"
        );
    }

    #[test]
    fn a_tampered_frame_fails_its_integrity_check() {
        let key = ProjectKeyManager::derive_key("pw", &[6u8; SALT_LEN]).unwrap();
        let plaintext = vec![1u8; 4096];
        let mut ciphertext = stream_roundtrip(&plaintext, &key);

        let last = ciphertext.len() - 1;
        ciphertext[last] ^= 0xFF;

        let mut recovered = Vec::new();
        assert!(
            ProjectKeyManager::decrypt_stream(&mut &ciphertext[..], &mut recovered, &key).is_err()
        );
    }

    #[test]
    fn a_stream_written_under_another_key_does_not_decrypt() {
        let good = ProjectKeyManager::derive_key("right", &[7u8; SALT_LEN]).unwrap();
        let bad = ProjectKeyManager::derive_key("wrong", &[7u8; SALT_LEN]).unwrap();
        let ciphertext = stream_roundtrip(b"vault contents", &good);

        let mut recovered = Vec::new();
        assert!(
            ProjectKeyManager::decrypt_stream(&mut &ciphertext[..], &mut recovered, &bad).is_err()
        );
    }

    #[test]
    fn every_frame_gets_a_distinct_nonce() {
        // Nonce reuse under one key is catastrophic for GCM, so pin the
        // derivation rather than trusting it by inspection.
        let prefix = [0xAB_u8; STREAM_NONCE_PREFIX_LEN];
        let first = stream_frame_nonce(&prefix, 0);
        let second = stream_frame_nonce(&prefix, 1);
        assert_ne!(first, second);
        // ...and the random prefix separates files written under the same key.
        let other_file = stream_frame_nonce(&[0xCD_u8; STREAM_NONCE_PREFIX_LEN], 0);
        assert_ne!(first, other_file);
    }

    #[test]
    fn frame_aad_binds_position_and_finality() {
        assert_ne!(stream_frame_aad(0, false), stream_frame_aad(1, false));
        assert_ne!(stream_frame_aad(0, false), stream_frame_aad(0, true));
    }

    #[test]
    fn legacy_payloads_are_recognised_and_still_decrypt() {
        // Existing vault files must keep opening forever; the magic is what
        // tells the two formats apart.
        let key = ProjectKeyManager::derive_key("pw", &[8u8; SALT_LEN]).unwrap();
        let legacy = ProjectKeyManager::encrypt(b"an older recording", &key).unwrap();

        assert!(!ProjectKeyManager::is_streaming_payload(&legacy));
        assert_eq!(
            ProjectKeyManager::decrypt(&legacy, &key).unwrap(),
            b"an older recording"
        );

        let streamed = stream_roundtrip(b"a newer recording", &key);
        assert!(ProjectKeyManager::is_streaming_payload(&streamed));
    }

    #[test]
    fn a_corrupt_header_cannot_force_a_huge_allocation() {
        let key = ProjectKeyManager::derive_key("pw", &[9u8; SALT_LEN]).unwrap();
        let mut ciphertext = stream_roundtrip(b"small", &key);
        // Claim an absurd frame size.
        ciphertext[STREAM_MAGIC_LEN + 1..STREAM_MAGIC_LEN + 5]
            .copy_from_slice(&u32::MAX.to_le_bytes());

        let mut recovered = Vec::new();
        assert!(
            ProjectKeyManager::decrypt_stream(&mut &ciphertext[..], &mut recovered, &key).is_err()
        );
    }

    #[test]
    fn streaming_progress_is_reported_monotonically() {
        let key = ProjectKeyManager::derive_key("pw", &[10u8; SALT_LEN]).unwrap();
        let plaintext = vec![2u8; STREAM_FRAME_LEN * 3 + 11];
        let mut seen = Vec::new();
        let mut ciphertext = Vec::new();
        ProjectKeyManager::encrypt_stream(&mut &plaintext[..], &mut ciphertext, &key, |bytes| {
            seen.push(bytes)
        })
        .unwrap();

        assert!(seen.len() >= 4, "each frame should report progress");
        assert!(
            seen.windows(2).all(|pair| pair[0] < pair[1]),
            "progress must advance monotonically: {seen:?}"
        );
        assert_eq!(seen.last().copied(), Some(plaintext.len() as u64));
    }
}
