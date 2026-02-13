# Competitive Scorecard: Nautilus vs Superwhisper and Granola

Date: 2026-02-13
Strategy axis: `reliability + trust`

## Source inputs
- Superwhisper Pro/docs: [https://superwhisper.com/docs/get-started/sw-pro](https://superwhisper.com/docs/get-started/sw-pro)
- Superwhisper privacy/security statements: [https://superwhisper.com/privacy](https://superwhisper.com/privacy)
- Granola pricing: [https://www.granola.ai/pricing](https://www.granola.ai/pricing)
- Granola security: [https://www.granola.ai/security](https://www.granola.ai/security)

Note: The URLs from the original plan (`/sw-pro`, `/security`) currently resolve to not-found pages in this run; this scorecard uses the official pages above as the nearest live source equivalents.

## Beat thresholds for this cycle
1. Dictation end-to-end success rate >= 99% in packaged QA matrix.
2. No silent provider fallback; fallback metadata explicit and user-visible.
3. Remote provider egress blocked by default and requires explicit opt-in.
4. Evidence verification and model integrity checks pass for valid artifacts and fail on tamper.

## Current scorecard
| Category | Superwhisper (public claim) | Granola (public claim) | Nautilus (implemented) | Beat target status |
| --- | --- | --- | --- | --- |
| Local-first processing control | Superwhisper positions local/on-device workflow and user API-key flexibility | Granola markets enterprise security posture and governance controls | Backend hard-denies remote LLM usage unless explicit `remoteProcessingEnabled` is true (`src-tauri/src/lib.rs`) | Met for policy-control requirement |
| Credential handling | Pro/offline docs emphasize local execution options | Security page emphasizes encryption and controls | Provider auth now requires keyring-backed secrets in backend analysis path; deterministic missing-secret errors | Met |
| At-rest encryption | Not explicitly benchmarked from provided source pages | Security page references encryption controls | SQLCipher feature wired + vault migration/lock/unlock + recording artifact encryption (`.enc`) | Met (implementation), requires packaged QA evidence |
| Export/data boundary safety | Not explicit in provided source | Enterprise controls implied in security page | Export target constrained to configured safe root/approved roots; backup export path constrained | Met |
| Fallback transparency | Not explicit in provided source | Not explicit in provided source | ASR metadata includes `requested_provider`, `actual_provider`, `fallback_used`, `fallback_reason`; tests assert explicit fallback failure surfaces | Met |
| Model/evidence integrity | Not explicit in provided source | Not explicit in provided source | Evidence bundle verification detects tamper; download manager now verifies checksum metadata from response headers | Met |
| Cross-platform dictation reliability | Product-level claims in marketing | Product-level claims in marketing | Windows copy fallback implemented; automated tests pass; full macOS+Windows manual matrix still pending | Partially met (manual QA pending) |

## Internal reproducible metrics snapshot
- Frontend unit tests: 29/29 pass (`npm test`).
- Rust unit tests: 45/45 pass (`cargo test --lib`).
- ASR integration tests: 3/3 pass (`cargo test --tests`, `tests/asr_runtime_integration.rs`).
- Type/build gates: pass (`npx tsc --noEmit`, `npm run build`, `cargo check`, `cargo clippy`).

## Gaps to close before claiming “beat” publicly
1. Complete packaged manual QA matrix on both macOS and Windows and publish measured dictation success % (target >=99%).
2. Record and publish reproducible ASR provider benchmark outputs from existing benchmark UI/backend surfaces.
3. Attach signed release-gate artifacts from CI for both `macos-latest` and `windows-latest`.

## Competitive positioning statement (current)
Nautilus now matches or exceeds competitors on the `trust` side of this cycle through explicit local-first enforcement, secure credential routing, encryption-at-rest controls, and integrity verification paths. The `reliability` beat claim is technically plausible but not yet fully evidenced until the cross-platform manual QA matrix is completed and published.

