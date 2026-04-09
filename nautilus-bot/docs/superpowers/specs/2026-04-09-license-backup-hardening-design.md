# License And Backup Hardening Design

Date: 2026-04-09
Status: approved for implementation

## Goal

Harden two launch-blocking areas without changing user-facing product scope:

- licensing and trial enforcement
- backup, restore, and iCloud sync safety

The desired outcome is launch-safe architecture, not a cosmetic patch.

## Licensing Design

### Current problems

- license key and instance ID are stored in plaintext JSON
- the renderer receives raw license material
- trial anchor and device identity are locally editable
- license cache and secret material are tightly coupled

### New boundary

Split licensing into two layers:

- `LicenseSecretStore`
  - stores `license_key`
  - stores `license_instance_id`
  - stores `license_device_id`
  - stores `license_first_run_at`
  - production path uses OS secure storage through `keyring`
  - test path uses in-memory overrides
- `LicenseCache`
  - stores tier
  - stores LS status
  - stores activation counts
  - stores last validation timestamp
  - stored on disk in the existing license JSON path

### Migration

- detect legacy plaintext license JSON on load
- write secret fields into secure storage first
- rewrite the disk cache second with only non-sensitive fields
- preserve activation and entitlement state
- never force reactivation when an in-place migration can preserve the current device instance
- if secure-store migration fails, keep the legacy file untouched and fail safely

### API changes

- frontend `LicenseInfo` no longer includes `key`
- frontend `LicenseInfo` no longer includes `instanceId`
- entitlement reads remain cache-only and fast
- activation and validation still use the same Lemon Squeezy API flow, but read secret material from secure storage

### Failure handling

- if secure storage is unavailable, fail closed for license validation
- preserve trial metadata in secure storage so deleting the cache file alone cannot reset trial state
- deactivation clears secure secret entries and resets only the non-sensitive cache fields that must be cleared

## Backup And Restore Design

### Current problems

- restore writes directly into live paths
- restore has no rollback boundary
- iCloud sync deletes the destination before copying
- interruption can destroy customer data

### New boundary

Introduce a staged restore transaction:

- validate backup contents
- create per-target staging copies
- create rollback snapshots of live targets
- commit by rename or swap only after staging is ready
- if any step fails, restore the previous live state

### Restore units

- database restore unit
- recordings restore unit
- settings restore unit
- restore transaction coordinator

Each unit stages its own content and reports whether a live target exists, whether it was replaced, and how to roll it back.

### Backup manifest

- write a manifest into each new backup
- record backup ID, type, timestamp, and included components
- use manifest for pre-restore validation when present
- remain backward-compatible with older backups that do not yet contain a manifest

### iCloud sync

- copy source backup into a temporary cloud destination first
- if the final destination exists, rename it aside as previous
- rename temp into the final destination
- only delete the previous destination after the swap succeeds
- if swap fails, restore the previous destination

## Testing

Add targeted tests for:

- legacy license migration to secure storage
- cache-only entitlement reads
- no secret fields remaining in persisted license cache
- trial metadata persistence outside the disk cache
- staged restore success path
- staged restore rollback when commit fails
- iCloud sync preserving the previous destination on failure
- manifest creation and restore validation

## Rollout

1. Land licensing hardening.
2. Land backup and restore hardening.
3. Run lint and targeted Rust tests after each slice.
4. Update launch tracking docs only after code and tests are green.
