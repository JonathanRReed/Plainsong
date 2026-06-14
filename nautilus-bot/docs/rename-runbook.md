# Rename runbook

Mechanical steps to rename the app from "Nautilus / NautilusBot" to the chosen
name. There are ~393 case-insensitive `nautilus` occurrences; they fall into
three buckets with very different risk. **Because the project is pre-launch (no
real users), the identity strings can be replaced cleanly — no data/keychain
migration is needed.** (If we ever rename *after* shipping, bucket 2 would
require a migration shim; see the note at the end.)

In what follows, substitute:
- `NewName` — display/brand name (e.g. `Tidewater`)
- `newname` — lowercase slug (binary, crate, npm, dirs) (e.g. `tidewater`)
- `com.you.newname` — the new bundle identifier / keychain service

## Bucket 1 — Identity strings (pick new values, replace exactly once)

These define app + data identity. Changing them on a shipped app orphans
permissions/keys/data; pre-launch it's free. Decide the new values, then change:

| What | File:symbol | Current | Change to |
|---|---|---|---|
| Bundle ID (Electron) | `electron-builder.yml:appId` | `com.nautilus.bot` | `com.you.newname` |
| Bundle ID (Rust) | `rust-sidecar/src/lib.rs` `APP_BUNDLE_IDENTIFIER` | `com.nautilus.bot` | `com.you.newname` |
| Keychain service | `rust-sidecar/src/secrets.rs` `SERVICE_NAME` | `com.nautilus.bot` | `com.you.newname` |
| Legacy secrets file | `rust-sidecar/src/secrets.rs` `legacy_secrets_file_path` | `~/.nautilus-bot-secrets.json` | keep or rename (legacy migration only) |
| Data dir | many: `.join("Nautilus")` (db.rs, settings.rs, audio.rs, backup.rs, lib.rs, download/mod.rs, export/mod.rs) | `…/Application Support/Nautilus` | `…/NewName` |
| DB filename | `db.rs`, `backup.rs` | `nautilus.db` | `newname.db` (optional; can keep) |
| Product name | `package.json:productName`, `electron-builder.yml:productName` | `Nautilus` | `NewName` |

Tip: the data-dir string `"Nautilus"` is repeated in ~8 files — centralize it
into one `const APP_DIR_NAME` (or reuse `secrets.rs`'s existing pattern) during
the rename so it can never drift again.

## Bucket 2 — Internal identifiers (mechanical, must stay in sync)

The Rust binary name is referenced from three places that MUST change together,
or the packaged app won't find its sidecar:

- `rust-sidecar/Cargo.toml`: `name = "nautilus-bot"`, `[lib] name = "nautilus_bot_lib"`, `default-run = "nautilus-sidecar"`, `[[bin]] name = "nautilus-sidecar"`
- `rust-sidecar/src/bin/sidecar.rs` and `benchmark-latency.rs`: `use nautilus_bot_lib::…` → `use newname_lib::…`
- `package.json`: `sidecar:build:release` → `--bin newname-sidecar`; the Electron sidecar spawn path in `electron/main.ts` (`getSidecarPath`) resolves `nautilus-sidecar` → `newname-sidecar`
- `electron-builder.yml:extraResources` filter: `nautilus-sidecar` / `nautilus-sidecar.exe`
- `package.json:name` (`nautilus-bot`), `repository`/`homepage` URLs

Decision: keep the binary name as `nautilus-sidecar` OR rename to `newname-sidecar`.
Renaming is cleaner but touches all the above; keeping it works and is lower-risk.

## Bucket 3 — Cosmetic / brand text (free-form replace)

README/docs, UI copy in `src/`, window titles, comments, the `productName`
display, log strings. Safe to bulk find-replace `Nautilus`→`NewName` and
`nautilus`→`newname` in `src/**`, `docs/**`, `*.md` — but review diffs (don't
rewrite words like "nautical" if any, and leave third-party/library names alone).

Also: app icons in `build-resources/` (`icon.icns`, `icon.ico`, `icon.png`) and
`app-icon.png` are brand assets to regenerate, not text.

## External (do before/at the rename, outside the repo)

- Register `newname.app` (and `.ai`/`.com` if obtainable) at a registrar.
- Grab the GitHub org/handle (`newname` or `getnewname`/`newname-app`).
- Reserve npm `newname` if relevant.
- Update `electron-builder.yml:publish` owner/repo and `package.json`
  `repository`/`homepage` to the real org.
- Run the USPTO Class 9 + 42 knockout / attorney opinion per the name's vet.

## Suggested execution order

1. Lock the new values (NewName, newname, com.you.newname, data-dir name).
2. Bucket 1 + 2 in code (identity + internal identifiers), centralizing the
   data-dir constant.
3. Bucket 3 cosmetic sweep with diff review.
4. Regenerate icons; update repo URLs.
5. Verify: `bun run lint && bun run test && bun run test:rust && bun run electron:build`,
   then launch the packaged app and confirm the sidecar spawns (binary path) and
   a dictation round-trips (data dir + keychain service resolve under the new id).

## If we ever rename POST-launch (not now)

Bucket 1 would need a one-time migration: read the old keychain service +
`Application Support/Nautilus` dir, copy secrets/DB/settings to the new identity,
and leave the old in place until verified. The existing
`migrate_legacy_file_if_needed()` in `secrets.rs` is the pattern to extend.
Pre-launch, skip all of this.
