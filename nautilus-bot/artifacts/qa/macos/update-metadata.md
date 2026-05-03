# Updates: Packaged macOS Update Metadata

Status: PASS
Owner: qa-macos
Generated: 2026-05-02T23:22:48.982Z

## Command

`bun run qa:packaged:macos:update-metadata`

## Result

- App update metadata: /Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/release/mac-arm64/Nautilus.app/Contents/Resources/app-update.yml
- Latest manifest: /Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/release/latest-mac.yml
- Update provider: github
- GitHub owner: nautilusbot
- GitHub repo: nautilus
- Manifest version: 1.0.0
- Package version: 1.0.0
- ZIP artifact: /Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/release/Nautilus-1.0.0-arm64-mac.zip
- ZIP SHA-512 matches manifest: yes
- ZIP size matches manifest: yes
- Blockmap exists: yes

## Checks

- appUpdateMetadataExists: PASS
- latestManifestExists: PASS
- providerIsGithub: PASS
- ownerConfigured: PASS
- repoConfigured: PASS
- versionMatchesPackage: PASS
- zipPathPresent: PASS
- zipArtifactExists: PASS
- zipSha512Present: PASS
- zipSha512MatchesManifest: PASS
- zipSizePresent: PASS
- zipSizeMatchesManifest: PASS
- blockmapExists: PASS

