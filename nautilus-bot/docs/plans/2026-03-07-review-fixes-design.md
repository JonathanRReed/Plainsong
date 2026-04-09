# Review Fixes Design

## Goal

Fix the product issues found in the audit without widening the behavioral surface unnecessarily.

- Backup and restore must include the real settings file.
- Recording-scoped async UI work must ignore stale responses after the user switches recordings.
- Meeting AI chat and refresh actions must never persist onto the wrong recording.
- Vault migration must stop committing visible migration state before file work succeeds.
- The backend test suite must return to green.

## Approach

### Rust persistence helpers

- Add a shared settings-path helper in `rust-sidecar/src/settings.rs`.
- Reuse that helper from both the settings manager and backup/restore code.
- Keep the backup artifact name as `settings.json`, but source and restore it from the canonical Nautilus config path.

### Frontend stale-request guard

- Add a reusable request guard hook that issues request tokens tied to a logical scope.
- Use the guard in recording detail loading, AI analysis, and meeting chat loading.
- Drop late responses silently when they no longer belong to the active recording.

### Small UX adjustments

- Reset transient analysis/loading state when the active recording changes.
- Prefer fresh selection state over preserving stale in-flight results.
- Do not introduce new workflow changes.

### Vault migration safety

- Split recording encryption into staged work that writes encrypted temp files first.
- Defer final visible migration state updates until staged work has succeeded.
- Clean up staged temp artifacts on failure.

## Testing

- Extend frontend tests to cover stale AI responses and stale meeting chat loads.
- Keep the Rust test expectation aligned with the intended contextual-command copy.
- Re-run `bun run test`, `bun run build`, and `cargo test`.
