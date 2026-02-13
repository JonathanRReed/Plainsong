use crate::export::{self, export_recording, ExportFormat};
use crate::models::{AuditLogEntry, Recording, Transcript};
use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use regex::Regex;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::PathBuf;

const EVIDENCE_BUNDLE_FORMAT: &str = "evidence_bundle";
const EVIDENCE_BUNDLE_SCHEMA: &str = "nautilus-evidence-bundle-v1";
const EVIDENCE_CANONICALIZATION: &str = "json-sorted-keys-sha256-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceBundleEnvelope {
    schema_version: String,
    generated_at: String,
    format: String,
    redaction_level: String,
    payload_hash_sha256: String,
    signature: EvidenceSignatureMetadata,
    payload: EvidencePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceSignatureMetadata {
    algorithm: String,
    key_id: String,
    public_key_hex: String,
    signature_hex: String,
    signed_at: String,
    signed_message: String,
    canonicalization: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidencePayload {
    recording: EvidenceRecording,
    #[serde(skip_serializing_if = "Option::is_none")]
    transcript: Option<EvidenceTranscript>,
    audit_trail: EvidenceAuditTrail,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceRecording {
    id: String,
    title: String,
    project_id: String,
    duration_seconds: i64,
    created_at: String,
    updated_at: String,
    source_type: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    audio: Option<EvidenceAudio>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceAudio {
    path: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceTranscript {
    id: String,
    language: String,
    confidence: f64,
    model: String,
    created_at: String,
    full_text: String,
    segments: Vec<EvidenceTranscriptSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceTranscriptSegment {
    id: String,
    start_time: f64,
    end_time: f64,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    speaker_id: Option<String>,
    confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceAuditTrail {
    record_count: usize,
    final_chain_hash_sha256: String,
    records: Vec<EvidenceAuditRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceAuditRecord {
    sequence: usize,
    id: String,
    timestamp: String,
    event: String,
    severity: String,
    details: Value,
    event_hash_sha256: String,
    chain_hash_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceVerificationStatus {
    Pass,
    Fail,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceVerificationCheck {
    pub id: String,
    pub label: String,
    pub status: EvidenceVerificationStatus,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceVerificationResult {
    pub valid: bool,
    pub checked_at: String,
    pub schema_version: Option<String>,
    pub format: Option<String>,
    pub key_id: Option<String>,
    pub checks: Vec<EvidenceVerificationCheck>,
}

pub fn export_with_policy(
    recording: &Recording,
    transcript: Option<&Transcript>,
    audit_log: &[AuditLogEntry],
    format: &str,
    target: Option<&str>,
    redaction_level: &str,
    preview: bool,
) -> Result<crate::models::ExportResponse> {
    if is_evidence_bundle_format(format) {
        return export_signed_evidence_bundle(
            recording,
            transcript,
            audit_log,
            target,
            redaction_level,
            preview,
        );
    }

    let export_format = format
        .parse::<ExportFormat>()
        .unwrap_or(ExportFormat::Markdown);

    let content = export_recording(recording, transcript, export_format, true)?;
    let redacted_content = apply_redaction(&content, redaction_level);

    if preview {
        return Ok(crate::models::ExportResponse {
            format: format.to_string(),
            redaction_level: redaction_level.to_string(),
            preview: true,
            export_path: None,
            content: Some(redacted_content),
        });
    }

    let export_path = match target {
        Some(path) => std::path::PathBuf::from(path),
        None => export::get_default_export_path(recording, export_format),
    };

    if let Some(parent) = export_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&export_path, redacted_content)?;

    Ok(crate::models::ExportResponse {
        format: format.to_string(),
        redaction_level: redaction_level.to_string(),
        preview: false,
        export_path: Some(export_path.to_string_lossy().to_string()),
        content: None,
    })
}

pub fn export(
    recording: &Recording,
    transcript: Option<&crate::models::Transcript>,
    format: &str,
    target: Option<&str>,
) -> Result<String> {
    // Parse format
    let export_format = format
        .parse::<ExportFormat>()
        .unwrap_or(ExportFormat::Markdown);

    // Get export path
    let export_path = match target {
        Some(path) => PathBuf::from(path),
        None => export::get_default_export_path(recording, export_format),
    };

    // Create parent directory
    if let Some(parent) = export_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Generate content
    let content = export_recording(recording, transcript, export_format, true)?;

    // Write file
    std::fs::write(&export_path, content)?;

    tracing::info!("Exported recording {} to {:?}", recording.id, export_path);

    Ok(export_path.to_string_lossy().to_string())
}

pub fn verify_evidence_bundle_file(path: &str) -> Result<EvidenceVerificationResult> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read evidence bundle at {}", path))?;
    verify_evidence_bundle_content(&content)
}

pub fn verify_evidence_bundle_content(content: &str) -> Result<EvidenceVerificationResult> {
    let parsed = serde_json::from_str::<EvidenceBundleEnvelope>(content);
    let envelope = match parsed {
        Ok(envelope) => envelope,
        Err(err) => {
            return Ok(EvidenceVerificationResult {
                valid: false,
                checked_at: Utc::now().to_rfc3339(),
                schema_version: None,
                format: None,
                key_id: None,
                checks: vec![fail_check(
                    "parse",
                    "Bundle JSON parse",
                    format!("Invalid evidence bundle JSON: {}", err),
                )],
            });
        }
    };

    Ok(verify_evidence_bundle(&envelope))
}

fn apply_redaction(content: &str, redaction_level: &str) -> String {
    match redaction_level {
        "none" => content.to_string(),
        "strict" => redact_strict(content),
        _ => redact_basic(content),
    }
}

fn redact_basic(content: &str) -> String {
    let email =
        Regex::new(r"(?i)\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b").expect("valid email regex");
    let phone = Regex::new(r"\+?\d[\d\-\s\(\)]{7,}\d").expect("valid phone regex");

    let without_email = email.replace_all(content, "[REDACTED_EMAIL]");
    phone
        .replace_all(&without_email, "[REDACTED_PHONE]")
        .to_string()
}

fn redact_strict(content: &str) -> String {
    let url = Regex::new(r"(?i)\bhttps?://[^\s]+").expect("valid url regex");
    let key_like = Regex::new(r"\b(sk|pk|api|token)[_-]?[a-z0-9]{8,}\b").expect("valid key regex");
    let long_digits = Regex::new(r"\b\d{4,}\b").expect("valid digits regex");

    let basic = redact_basic(content);
    let without_urls = url.replace_all(&basic, "[REDACTED_URL]");
    let without_keys = key_like.replace_all(&without_urls, "[REDACTED_SECRET]");
    long_digits
        .replace_all(&without_keys, "[REDACTED_NUMBER]")
        .to_string()
}

fn is_evidence_bundle_format(format: &str) -> bool {
    matches!(
        format.trim().to_ascii_lowercase().as_str(),
        EVIDENCE_BUNDLE_FORMAT | "evidence-bundle" | "evidencebundle"
    )
}

fn export_signed_evidence_bundle(
    recording: &Recording,
    transcript: Option<&Transcript>,
    audit_log: &[AuditLogEntry],
    target: Option<&str>,
    redaction_level: &str,
    preview: bool,
) -> Result<crate::models::ExportResponse> {
    let payload = build_evidence_payload(recording, transcript, audit_log, redaction_level)?;
    let payload_bytes = canonical_json_bytes(&payload)?;
    let payload_hash = sha256_bytes(&payload_bytes);
    let payload_hash_hex = hex::encode(payload_hash);

    let signature = sign_payload_hash(&payload_hash)?;
    let bundle = EvidenceBundleEnvelope {
        schema_version: EVIDENCE_BUNDLE_SCHEMA.to_string(),
        generated_at: Utc::now().to_rfc3339(),
        format: EVIDENCE_BUNDLE_FORMAT.to_string(),
        redaction_level: redaction_level.to_string(),
        payload_hash_sha256: payload_hash_hex,
        signature,
        payload,
    };
    let bundle_text = serde_json::to_string_pretty(&bundle)
        .context("Failed to serialize signed evidence bundle")?;

    if preview {
        return Ok(crate::models::ExportResponse {
            format: EVIDENCE_BUNDLE_FORMAT.to_string(),
            redaction_level: redaction_level.to_string(),
            preview: true,
            export_path: None,
            content: Some(bundle_text),
        });
    }

    let export_path = match target {
        Some(path) => PathBuf::from(path),
        None => default_evidence_export_path(recording),
    };
    if let Some(parent) = export_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&export_path, bundle_text).with_context(|| {
        format!(
            "Failed to write evidence bundle to {}",
            export_path.to_string_lossy()
        )
    })?;

    Ok(crate::models::ExportResponse {
        format: EVIDENCE_BUNDLE_FORMAT.to_string(),
        redaction_level: redaction_level.to_string(),
        preview: false,
        export_path: Some(export_path.to_string_lossy().to_string()),
        content: None,
    })
}

fn default_evidence_export_path(recording: &Recording) -> PathBuf {
    let base = export::get_default_export_path(recording, ExportFormat::Json);
    let stem = base
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("evidence");
    base.with_file_name(format!("{stem}_evidence.json"))
}

fn verify_evidence_bundle(bundle: &EvidenceBundleEnvelope) -> EvidenceVerificationResult {
    let mut checks = Vec::new();

    checks.push(if bundle.schema_version == EVIDENCE_BUNDLE_SCHEMA {
        pass_check(
            "schema_version",
            "Schema version",
            format!("Schema version '{}' is supported.", bundle.schema_version),
        )
    } else {
        fail_check(
            "schema_version",
            "Schema version",
            format!(
                "Expected '{}', found '{}'.",
                EVIDENCE_BUNDLE_SCHEMA, bundle.schema_version
            ),
        )
    });

    checks.push(if bundle.format == EVIDENCE_BUNDLE_FORMAT {
        pass_check(
            "bundle_format",
            "Bundle format",
            format!("Bundle format is '{}'.", bundle.format),
        )
    } else {
        fail_check(
            "bundle_format",
            "Bundle format",
            format!(
                "Expected '{}', found '{}'.",
                EVIDENCE_BUNDLE_FORMAT, bundle.format
            ),
        )
    });

    checks.push(
        if bundle.signature.algorithm.eq_ignore_ascii_case("ed25519") {
            pass_check(
                "signature_algorithm",
                "Signature algorithm",
                "Signature algorithm is Ed25519.",
            )
        } else {
            fail_check(
                "signature_algorithm",
                "Signature algorithm",
                format!(
                    "Unsupported signature algorithm '{}'.",
                    bundle.signature.algorithm
                ),
            )
        },
    );

    checks.push(
        if bundle.signature.signed_message == "payload_hash_sha256" {
            pass_check(
                "signed_message",
                "Signed message target",
                "Signature targets payload hash.",
            )
        } else {
            fail_check(
                "signed_message",
                "Signed message target",
                format!(
                    "Expected 'payload_hash_sha256', found '{}'.",
                    bundle.signature.signed_message
                ),
            )
        },
    );

    checks.push(
        if bundle.signature.canonicalization == EVIDENCE_CANONICALIZATION {
            pass_check(
                "canonicalization",
                "Canonicalization mode",
                format!(
                    "Canonicalization mode '{}' is supported.",
                    bundle.signature.canonicalization
                ),
            )
        } else {
            fail_check(
                "canonicalization",
                "Canonicalization mode",
                format!(
                    "Expected '{}', found '{}'.",
                    EVIDENCE_CANONICALIZATION, bundle.signature.canonicalization
                ),
            )
        },
    );

    let computed_payload_hash = match canonical_json_bytes(&bundle.payload) {
        Ok(payload_bytes) => hex::encode(sha256_bytes(&payload_bytes)),
        Err(err) => {
            checks.push(fail_check(
                "payload_hash",
                "Payload hash",
                format!("Could not canonicalize payload: {}", err),
            ));
            String::new()
        }
    };

    if !computed_payload_hash.is_empty() {
        checks.push(
            if computed_payload_hash.eq_ignore_ascii_case(&bundle.payload_hash_sha256) {
                pass_check(
                    "payload_hash",
                    "Payload hash",
                    "Payload hash matches canonical payload content.",
                )
            } else {
                fail_check(
                    "payload_hash",
                    "Payload hash",
                    format!(
                        "Payload hash mismatch. expected={}, computed={}",
                        bundle.payload_hash_sha256, computed_payload_hash
                    ),
                )
            },
        );
    }

    let public_key_bytes = hex::decode(&bundle.signature.public_key_hex);
    let signature_bytes = hex::decode(&bundle.signature.signature_hex);
    let signed_hash_bytes = hex::decode(&bundle.payload_hash_sha256);

    match (&public_key_bytes, &signature_bytes, &signed_hash_bytes) {
        (Ok(public_key), Ok(signature), Ok(signed_hash)) if signed_hash.len() == 32 => {
            let verifier = UnparsedPublicKey::new(&ED25519, public_key);
            checks.push(match verifier.verify(signed_hash, signature) {
                Ok(()) => pass_check(
                    "signature_verify",
                    "Signature verification",
                    "Ed25519 signature is valid for payload hash.",
                ),
                Err(_) => fail_check(
                    "signature_verify",
                    "Signature verification",
                    "Signature does not verify against payload hash/public key.",
                ),
            });

            let expected_key_id =
                format!("ed25519:{}", &hex::encode(sha256_bytes(public_key))[..16]);
            checks.push(if bundle.signature.key_id == expected_key_id {
                pass_check(
                    "key_id_binding",
                    "Signing key identity",
                    "keyId matches signer public key fingerprint.",
                )
            } else {
                fail_check(
                    "key_id_binding",
                    "Signing key identity",
                    format!(
                        "keyId mismatch. expected={}, found={}",
                        expected_key_id, bundle.signature.key_id
                    ),
                )
            });
        }
        _ => {
            checks.push(fail_check(
                "signature_verify",
                "Signature verification",
                "Failed to decode publicKey/signature/payload hash for verification.",
            ));
        }
    }

    let audit_checks = verify_audit_chain(&bundle.payload.audit_trail);
    checks.extend(audit_checks);

    let valid = checks
        .iter()
        .all(|check| matches!(check.status, EvidenceVerificationStatus::Pass));

    EvidenceVerificationResult {
        valid,
        checked_at: Utc::now().to_rfc3339(),
        schema_version: Some(bundle.schema_version.clone()),
        format: Some(bundle.format.clone()),
        key_id: Some(bundle.signature.key_id.clone()),
        checks,
    }
}

fn verify_audit_chain(trail: &EvidenceAuditTrail) -> Vec<EvidenceVerificationCheck> {
    let mut checks = Vec::new();
    checks.push(if trail.record_count == trail.records.len() {
        pass_check(
            "audit_record_count",
            "Audit record count",
            format!("recordCount={} matches records length.", trail.record_count),
        )
    } else {
        fail_check(
            "audit_record_count",
            "Audit record count",
            format!(
                "recordCount={} does not match records length={}.",
                trail.record_count,
                trail.records.len()
            ),
        )
    });

    let mut previous_chain = [0u8; 32];
    let mut chain_ok = true;
    let mut sequence_ok = true;

    for (idx, record) in trail.records.iter().enumerate() {
        let expected_sequence = idx + 1;
        if record.sequence != expected_sequence {
            sequence_ok = false;
        }

        let canonical_details = canonicalize_json(record.details.clone());
        let event_material = serde_json::json!({
            "id": record.id,
            "timestamp": record.timestamp,
            "event": record.event,
            "severity": record.severity,
            "details": canonical_details,
        });
        let event_hash = match canonical_json_bytes(&event_material) {
            Ok(bytes) => sha256_bytes(&bytes),
            Err(_) => {
                chain_ok = false;
                continue;
            }
        };

        if !hex::encode(event_hash).eq_ignore_ascii_case(&record.event_hash_sha256) {
            chain_ok = false;
        }

        let mut chain_material = Vec::with_capacity(previous_chain.len() + event_hash.len());
        chain_material.extend_from_slice(&previous_chain);
        chain_material.extend_from_slice(&event_hash);
        let chain_hash = sha256_bytes(&chain_material);
        if !hex::encode(chain_hash).eq_ignore_ascii_case(&record.chain_hash_sha256) {
            chain_ok = false;
        }
        previous_chain = chain_hash;
    }

    checks.push(if sequence_ok {
        pass_check(
            "audit_sequence",
            "Audit sequence ordering",
            "Audit sequences are contiguous and 1-indexed.",
        )
    } else {
        fail_check(
            "audit_sequence",
            "Audit sequence ordering",
            "Audit sequence values are not contiguous/1-indexed.",
        )
    });

    checks.push(if chain_ok {
        pass_check(
            "audit_chain",
            "Audit hash chain",
            "Audit event hash-chain validates.",
        )
    } else {
        fail_check(
            "audit_chain",
            "Audit hash chain",
            "Audit hash-chain validation failed.",
        )
    });

    checks.push(
        if hex::encode(previous_chain).eq_ignore_ascii_case(&trail.final_chain_hash_sha256) {
            pass_check(
                "audit_final_chain",
                "Audit final chain hash",
                "Final chain hash matches computed hash.",
            )
        } else {
            fail_check(
                "audit_final_chain",
                "Audit final chain hash",
                format!(
                    "Final chain hash mismatch. expected={}, computed={}",
                    trail.final_chain_hash_sha256,
                    hex::encode(previous_chain)
                ),
            )
        },
    );

    checks
}

fn build_evidence_payload(
    recording: &Recording,
    transcript: Option<&Transcript>,
    audit_log: &[AuditLogEntry],
    redaction_level: &str,
) -> Result<EvidencePayload> {
    let audio = compute_audio_evidence(&recording.audio_path)?;
    let transcript = transcript.map(|t| redact_transcript(t, redaction_level));
    let audit_trail = build_audit_trail(audit_log, &recording.id, redaction_level)?;

    Ok(EvidencePayload {
        recording: EvidenceRecording {
            id: recording.id.clone(),
            title: apply_redaction(&recording.title, redaction_level),
            project_id: recording.project_id.clone(),
            duration_seconds: recording.duration,
            created_at: recording.created_at.to_rfc3339(),
            updated_at: recording.updated_at.to_rfc3339(),
            source_type: recording.source_type.clone(),
            status: recording.status.clone(),
            audio,
        },
        transcript,
        audit_trail,
    })
}

fn redact_transcript(transcript: &Transcript, redaction_level: &str) -> EvidenceTranscript {
    EvidenceTranscript {
        id: transcript.id.clone(),
        language: transcript.language.clone(),
        confidence: transcript.confidence,
        model: transcript.model.clone(),
        created_at: transcript.created_at.to_rfc3339(),
        full_text: apply_redaction(&transcript.full_text, redaction_level),
        segments: transcript
            .segments
            .iter()
            .map(|segment| EvidenceTranscriptSegment {
                id: segment.id.clone(),
                start_time: segment.start_time,
                end_time: segment.end_time,
                text: apply_redaction(&segment.text, redaction_level),
                speaker_id: segment.speaker_id.clone(),
                confidence: segment.confidence,
            })
            .collect(),
    }
}

fn compute_audio_evidence(path: &str) -> Result<Option<EvidenceAudio>> {
    if path.trim().is_empty() {
        return Ok(None);
    }
    let audio_path = PathBuf::from(path);
    if !audio_path.exists() {
        return Ok(None);
    }

    let mut file = std::fs::File::open(&audio_path).with_context(|| {
        format!(
            "Failed to open audio file for evidence hashing: {}",
            audio_path.display()
        )
    })?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 16 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let size_bytes = file.metadata()?.len();

    Ok(Some(EvidenceAudio {
        path: audio_path.to_string_lossy().to_string(),
        size_bytes,
        sha256: hex::encode(hasher.finalize()),
    }))
}

fn build_audit_trail(
    audit_log: &[AuditLogEntry],
    recording_id: &str,
    redaction_level: &str,
) -> Result<EvidenceAuditTrail> {
    let mut related: Vec<&AuditLogEntry> = audit_log
        .iter()
        .filter(|entry| audit_entry_matches_recording(entry, recording_id))
        .collect();
    related.sort_by(|a, b| {
        a.timestamp
            .cmp(&b.timestamp)
            .then_with(|| a.id.cmp(&b.id))
            .then_with(|| a.event.cmp(&b.event))
    });

    let mut records = Vec::with_capacity(related.len());
    let mut previous_chain = [0u8; 32];

    for (idx, entry) in related.into_iter().enumerate() {
        let redacted_details = redact_json_value(entry.details.clone(), redaction_level);
        let canonical_details = canonicalize_json(redacted_details);
        let event_material = serde_json::json!({
            "id": entry.id,
            "timestamp": entry.timestamp.to_rfc3339(),
            "event": entry.event,
            "severity": entry.severity,
            "details": canonical_details,
        });
        let event_hash = sha256_bytes(&canonical_json_bytes(&event_material)?);

        let mut chain_material = Vec::with_capacity(previous_chain.len() + event_hash.len());
        chain_material.extend_from_slice(&previous_chain);
        chain_material.extend_from_slice(&event_hash);
        let chain_hash = sha256_bytes(&chain_material);
        previous_chain = chain_hash;

        records.push(EvidenceAuditRecord {
            sequence: idx + 1,
            id: entry.id.clone(),
            timestamp: entry.timestamp.to_rfc3339(),
            event: entry.event.clone(),
            severity: entry.severity.clone(),
            details: canonical_details,
            event_hash_sha256: hex::encode(event_hash),
            chain_hash_sha256: hex::encode(chain_hash),
        });
    }

    Ok(EvidenceAuditTrail {
        record_count: records.len(),
        final_chain_hash_sha256: hex::encode(previous_chain),
        records,
    })
}

fn audit_entry_matches_recording(entry: &AuditLogEntry, recording_id: &str) -> bool {
    let Some(object) = entry.details.as_object() else {
        return false;
    };
    ["recording_id", "recordingId"].iter().any(|key| {
        object
            .get(*key)
            .and_then(|value| value.as_str())
            .map(|value| value == recording_id)
            .unwrap_or(false)
    })
}

fn sign_payload_hash(payload_hash: &[u8; 32]) -> Result<EvidenceSignatureMetadata> {
    let key_bytes = load_or_create_evidence_signing_key()?;
    let key_pair = Ed25519KeyPair::from_pkcs8(&key_bytes)
        .map_err(|_| anyhow!("Failed to parse Ed25519 signing key"))?;
    let signature = key_pair.sign(payload_hash);
    let public_key = key_pair.public_key().as_ref();
    let key_hash = sha256_bytes(public_key);

    Ok(EvidenceSignatureMetadata {
        algorithm: "ed25519".to_string(),
        key_id: format!("ed25519:{}", &hex::encode(key_hash)[..16]),
        public_key_hex: hex::encode(public_key),
        signature_hex: hex::encode(signature.as_ref()),
        signed_at: Utc::now().to_rfc3339(),
        signed_message: "payload_hash_sha256".to_string(),
        canonicalization: EVIDENCE_CANONICALIZATION.to_string(),
    })
}

fn load_or_create_evidence_signing_key() -> Result<Vec<u8>> {
    let key_path = evidence_signing_key_path()?;
    if key_path.exists() {
        return std::fs::read(&key_path)
            .with_context(|| format!("Failed to read signing key: {}", key_path.display()));
    }

    if let Some(parent) = key_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let rng = SystemRandom::new();
    let key_pair_pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng)
        .map_err(|_| anyhow!("Failed to generate Ed25519 signing key"))?;
    let key_bytes = key_pair_pkcs8.as_ref().to_vec();
    std::fs::write(&key_path, &key_bytes)
        .with_context(|| format!("Failed to persist signing key to {}", key_path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600));
    }

    Ok(key_bytes)
}

fn evidence_signing_key_path() -> Result<PathBuf> {
    let config_dir =
        dirs::config_dir().ok_or_else(|| anyhow!("Could not determine config directory"))?;
    Ok(config_dir
        .join("Nautilus")
        .join("security")
        .join("evidence_signing_key.pk8"))
}

fn canonical_json_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let raw = serde_json::to_value(value)?;
    let canonical = canonicalize_json(raw);
    serde_json::to_vec(&canonical).context("Failed to encode canonical JSON")
}

fn canonicalize_json(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map.into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            let mut canonical = serde_json::Map::new();
            for (key, value) in entries {
                canonical.insert(key, canonicalize_json(value));
            }
            Value::Object(canonical)
        }
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize_json).collect()),
        other => other,
    }
}

fn redact_json_value(value: Value, redaction_level: &str) -> Value {
    match value {
        Value::String(value) => Value::String(apply_redaction(&value, redaction_level)),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|item| redact_json_value(item, redaction_level))
                .collect(),
        ),
        Value::Object(map) => {
            let mut updated = serde_json::Map::new();
            for (key, value) in map {
                updated.insert(key, redact_json_value(value, redaction_level));
            }
            Value::Object(updated)
        }
        other => other,
    }
}

fn pass_check(id: &str, label: &str, message: impl Into<String>) -> EvidenceVerificationCheck {
    EvidenceVerificationCheck {
        id: id.to_string(),
        label: label.to_string(),
        status: EvidenceVerificationStatus::Pass,
        message: message.into(),
    }
}

fn fail_check(id: &str, label: &str, message: impl Into<String>) -> EvidenceVerificationCheck {
    EvidenceVerificationCheck {
        id: id.to_string(),
        label: label.to_string(),
        status: EvidenceVerificationStatus::Fail,
        message: message.into(),
    }
}

fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(data);
    let mut result = [0u8; 32];
    result.copy_from_slice(&digest);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_test_bundle() -> EvidenceBundleEnvelope {
        let mut payload = EvidencePayload {
            recording: EvidenceRecording {
                id: "rec_1".to_string(),
                title: "Security Review Meeting".to_string(),
                project_id: "project_1".to_string(),
                duration_seconds: 120,
                created_at: "2026-02-06T10:00:00Z".to_string(),
                updated_at: "2026-02-06T10:02:00Z".to_string(),
                source_type: "meeting".to_string(),
                status: "completed".to_string(),
                audio: Some(EvidenceAudio {
                    path: "/tmp/audio.wav".to_string(),
                    size_bytes: 1024,
                    sha256: "00".repeat(32),
                }),
            },
            transcript: Some(EvidenceTranscript {
                id: "tr_1".to_string(),
                language: "en".to_string(),
                confidence: 0.93,
                model: "whisper-large-v3".to_string(),
                created_at: "2026-02-06T10:02:10Z".to_string(),
                full_text: "Launch approved for Monday.".to_string(),
                segments: vec![EvidenceTranscriptSegment {
                    id: "seg_1".to_string(),
                    start_time: 0.0,
                    end_time: 2.0,
                    text: "Launch approved for Monday.".to_string(),
                    speaker_id: Some("S1".to_string()),
                    confidence: 0.95,
                }],
            }),
            audit_trail: EvidenceAuditTrail {
                record_count: 0,
                final_chain_hash_sha256: String::new(),
                records: Vec::new(),
            },
        };

        let details = serde_json::json!({
            "recording_id": "rec_1",
            "format": "evidence_bundle",
        });
        let canonical_details = canonicalize_json(details);
        let event_material = serde_json::json!({
            "id": "audit_1",
            "timestamp": "2026-02-06T10:03:00Z",
            "event": "recording_exported_v2",
            "severity": "info",
            "details": canonical_details,
        });
        let event_hash = sha256_bytes(&canonical_json_bytes(&event_material).unwrap());
        let mut chain_material = Vec::new();
        chain_material.extend_from_slice(&[0u8; 32]);
        chain_material.extend_from_slice(&event_hash);
        let chain_hash = sha256_bytes(&chain_material);

        payload.audit_trail = EvidenceAuditTrail {
            record_count: 1,
            final_chain_hash_sha256: hex::encode(chain_hash),
            records: vec![EvidenceAuditRecord {
                sequence: 1,
                id: "audit_1".to_string(),
                timestamp: "2026-02-06T10:03:00Z".to_string(),
                event: "recording_exported_v2".to_string(),
                severity: "info".to_string(),
                details: serde_json::json!({
                    "recording_id": "rec_1",
                    "format": "evidence_bundle",
                }),
                event_hash_sha256: hex::encode(event_hash),
                chain_hash_sha256: hex::encode(chain_hash),
            }],
        };

        let payload_hash = sha256_bytes(&canonical_json_bytes(&payload).unwrap());
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let key_pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let signature = key_pair.sign(&payload_hash);
        let public_key = key_pair.public_key().as_ref().to_vec();
        let key_id = format!("ed25519:{}", &hex::encode(sha256_bytes(&public_key))[..16]);

        EvidenceBundleEnvelope {
            schema_version: EVIDENCE_BUNDLE_SCHEMA.to_string(),
            generated_at: "2026-02-06T10:03:00Z".to_string(),
            format: EVIDENCE_BUNDLE_FORMAT.to_string(),
            redaction_level: "basic".to_string(),
            payload_hash_sha256: hex::encode(payload_hash),
            signature: EvidenceSignatureMetadata {
                algorithm: "ed25519".to_string(),
                key_id,
                public_key_hex: hex::encode(public_key),
                signature_hex: hex::encode(signature.as_ref()),
                signed_at: "2026-02-06T10:03:00Z".to_string(),
                signed_message: "payload_hash_sha256".to_string(),
                canonicalization: EVIDENCE_CANONICALIZATION.to_string(),
            },
            payload,
        }
    }

    #[test]
    fn verify_evidence_bundle_valid() {
        let bundle = build_test_bundle();
        let content = serde_json::to_string(&bundle).unwrap();
        let result = verify_evidence_bundle_content(&content).unwrap();
        assert!(result.valid);
        assert!(result
            .checks
            .iter()
            .all(|check| matches!(check.status, EvidenceVerificationStatus::Pass)));
    }

    #[test]
    fn verify_evidence_bundle_detects_tampering() {
        let bundle = build_test_bundle();
        let mut value = serde_json::to_value(bundle).unwrap();
        value["payload"]["recording"]["title"] = Value::String("Tampered".to_string());
        let content = serde_json::to_string(&value).unwrap();

        let result = verify_evidence_bundle_content(&content).unwrap();
        assert!(!result.valid);
        assert!(result.checks.iter().any(|check| check.id == "payload_hash"
            && matches!(check.status, EvidenceVerificationStatus::Fail)));
    }
}
