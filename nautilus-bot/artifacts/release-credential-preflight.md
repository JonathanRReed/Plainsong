# Release Credential Preflight

Status: BLOCKED
Generated: 2026-05-05T15:23:44.446Z

This preflight is intentionally secret-safe. It records only environment variable names, boolean presence, and keychain identity counts.

## macOS

- Ready: no
- Missing required inputs: CSC_LINK or CSC_NAME, CSC_KEY_PASSWORD or Keychain identity, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
- Developer ID identities found: 0
- Configured identity matched: no

Required validation:

- `bun run electron:build:dmg`
- `codesign --verify --deep --strict --verbose=2 release/mac-arm64/Nautilus.app`
- `spctl --assess --verbose=4 release/mac-arm64/Nautilus.app`
- `xcrun stapler validate release/mac-arm64/Nautilus.app`

## Windows

- Ready: no
- Missing required inputs: WIN_CSC_LINK or WINDOWS_CERTIFICATE, WIN_CSC_KEY_PASSWORD or WINDOWS_CERTIFICATE_PASSWORD
- Publisher name present: no

Required validation:

- `bun run electron:build:win`
- `Get-AuthenticodeSignature .\\release\\Nautilus Setup 1.0.0.exe | Format-List`
- `pwsh scripts/windows-packaged-qa-runner.ps1`

SmartScreen note: A signed first release may still show reputation warnings until the publisher and file reputation are established.

## Publishing

- Ready: no
- Missing required inputs: GH_TOKEN or GITHUB_TOKEN
- Required flow: draft GitHub release first, update metadata validation second, public promotion last.
