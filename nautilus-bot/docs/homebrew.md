# Homebrew cask (post-first-release)

Status: **prepared, not submitted.** Submitting a cask requires the GitHub repo
to be public and a published (non-draft) release with a downloadable arm64
artifact. The release must also be notarized and accepted by Gatekeeper.
Those launch gates are tracked in `../../LAUNCH.md`.

The July 23, 2026 v1.0.0 candidate is Developer ID signed but not notarized.
Do not use its DMG or checksum for a cask submission. The final notarized
release rebuild will produce a different artifact and checksum.

## Cask template

electron-builder names the macOS artifacts `Plainsong-<version>-arm64.dmg` and
`Plainsong-<version>-arm64-mac.zip` (see `electron-builder.yml`). The cask uses
the DMG.

```ruby
cask "plainsong" do
  version "1.0.0"
  sha256 "REPLACE_WITH_SHA256_OF_DMG" # shasum -a 256 Plainsong-1.0.0-arm64.dmg

  url "https://github.com/JonathanRReed/Plainsong/releases/download/v#{version}/Plainsong-#{version}-arm64.dmg"
  name "Plainsong"
  desc "Free, open-source, local-first dictation and meeting capture"
  homepage "https://plainsong.jonathanrreed.com"

  depends_on arch: :arm64
  depends_on macos: ">= :ventura"

  app "Plainsong.app"

  zap trash: [
    "~/Library/Application Support/Plainsong",
    "~/Library/Preferences/com.plainsong.app.plist",
    "~/Library/Saved Application State/com.plainsong.app.savedState",
  ]
end
```

Submit only after the official release workflow passes Developer ID signing,
notarization, stapling, and Gatekeeper checks. The workflow fails closed when
credentials or trust evidence are missing.

## Submission steps (homebrew/cask)

1. Confirm `xcrun stapler validate` and `spctl --assess` pass for the exact
   arm64 app distributed in the DMG.
2. Publish the release (not a draft) with the arm64 DMG attached.
3. Download the published DMG again from its public URL.
4. Compute the checksum:
   `shasum -a 256 Plainsong-<version>-arm64.dmg`.
5. Fill in `version` and `sha256` in the template above.
6. Audit locally:
   ```bash
   brew audit --cask --new ./plainsong.rb
   brew install --cask ./plainsong.rb
   ```
7. Open a PR against https://github.com/Homebrew/homebrew-cask adding
   `Casks/p/plainsong.rb`, following the current contribution guide.
8. After acceptance, update the root README Install section with the real
   `brew install --cask plainsong` command.

For subsequent releases, bump `version` and `sha256`, or let Homebrew's
`brew bump-cask-pr` do it.
