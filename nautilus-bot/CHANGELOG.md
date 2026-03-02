# Changelog

All notable changes to NautilusBot are documented in this file.

## [Unreleased] - 2026-03-02

### Added
- Added benchmark launch gate verifier (`scripts/verify-benchmark-gates.mjs`) for CP-13/CP-14/CP-15 thresholds.
- Added benchmark gate artifact schema (`docs/ci/schemas/benchmark-gate-result.schema.json`).
- Added owner/evidence placeholders across all packaged QA matrix rows.

### Changed
- Updated release cold-start gate process matcher to target packaged binary `nautilus-bot`.
- Updated competitor parity command docs to use npm commands.
- Updated release/prelaunch readiness docs with current gate status and blockers.
- Improved artifact validator support for `date-time` formats and regex `pattern`.

### Security
- Updated lockfile dependencies to remediate Rollup path traversal advisory.
