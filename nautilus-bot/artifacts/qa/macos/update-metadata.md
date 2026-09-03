# Updates: Packaged macOS Update Metadata

Status: PASS
Owner: qa-macos
Mode: full
Generated: 2026-09-03T06:25:14.064Z

## Command

`bun run qa:packaged:macos:update-metadata`

## Result

- App update metadata: /Users/jonathanreed/Downloads/Plainsong/.claude/worktrees/agent-a7989c7610bb925cf/nautilus-bot/release/mac-arm64/Plainsong.app/Contents/Resources/app-update.yml
- Beta manifest: /Users/jonathanreed/Downloads/Plainsong/.claude/worktrees/agent-a7989c7610bb925cf/nautilus-bot/release/beta-mac.yml
- Error: none
- Update provider: generic
- Update feed: https://updates.plainsong.jonathanrreed.com/beta/
- Multiple range requests: false
- Release channel: beta
- Installed app requests: beta-mac.yml
- Packaged channel file: beta-mac.yml
- Manifest version: 0.9.0-beta.3
- Packaged app version: 0.9.0-beta.3
- Package version: 0.9.0-beta.3
- ZIP artifact: /Users/jonathanreed/Downloads/Plainsong/.claude/worktrees/agent-a7989c7610bb925cf/nautilus-bot/release/Plainsong-0.9.0-beta.3-arm64-mac.zip
- ZIP SHA-512 matches manifest: yes
- ZIP size matches manifest: yes
- Blockmap exists: yes

## Checks

- appUpdateMetadataExists: PASS
- appInfoPlistExists: PASS
- appVersionPresent: PASS
- packageVersionMatchesPackagedApp: PASS
- providerIsGeneric: PASS
- betaFeedUrlMatchesExpected: PASS
- multipleRangeRequestsDisabled: PASS
- releaseChannelIsBeta: PASS
- packagedChannelMatchesRelease: PASS
- channelResolverLoaded: PASS
- installedChannelRequestsPackagedManifest: PASS
- releaseManifestExists: PASS
- betaChannelManifestEmitted: PASS
- versionMatchesPackagedApp: PASS
- zipPathPresent: PASS
- zipArtifactExists: PASS
- zipSha512Present: PASS
- zipSha512MatchesManifest: PASS
- zipSizePresent: PASS
- zipSizeMatchesManifest: PASS
- blockmapExists: PASS

