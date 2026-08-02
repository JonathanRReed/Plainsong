# Sidecar Entitlement Hardening Context

## Source identity

- Repository: Plainsong
- Baseline revision: `18cd7389f29ea9221174ad88b799a65292864bc3`
- Baseline evidence collection SHA-256:
  `feb26e7f5fd383dd9027d917c5ffc23b35095b3b2d8ef89926f130afeb76c782`
- Source drift: present, because the hardening implementation is an uncommitted
  working-tree change and unrelated concurrent Rust edits also exist

## Evidence inventory

| Evidence | Title | Path | What it establishes |
| --- | --- | --- | --- |
| `E001` | Broad inherited child entitlements | `build-resources/entitlements.mac.inherit.plist` | The inherited policy grants JIT, unsigned executable memory, disabled library validation, microphone, and Apple Events. |
| `E002` | Incomplete sidecar trust enforcement | `scripts/verify-macos-release-trust.mjs` at the baseline revision | The gate checked that the sidecar lacked Speech Recognition but did not reject the other inherited privileges. |
| `E003` | Packaged sidecar privilege evidence | `bun run gate:release:macos:trust` against the 2026-07-29 package | The signed sidecar contains `com.apple.security.inherit`, audio, microphone, Apple Events, JIT, unsigned executable memory, and disabled library validation. |
| `E004` | Existing per-helper signing pattern | `scripts/sign-macos.mjs` at the baseline revision | The Speech and shortcut helpers already receive specialized entitlement files. |

## Constraints

- Preserve the current Electron packaging toolchain.
- Add no production dependency.
- Do not add a process hop to the dictation hot path without measured need.
- Preserve microphone, system-audio, shortcut, and Speech behavior.
- Require exact-package verification before describing the finding as closed.

