# Homebrew cask (post-first-release)

Status: **prepared, not submitted.** Submitting a cask requires the GitHub repo
to be public and a published (non-draft) release with a downloadable arm64
artifact — both are launch-day human actions tracked in `../../LAUNCH.md`.

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

Note: while releases are unsigned (no Apple Developer ID yet), homebrew/cask
will generally not accept the submission — unsigned apps trip Gatekeeper and
casks are expected to install cleanly. Two options:

1. **Wait for signing + notarization** (the release pipeline already signs when
   the Developer ID secrets are present), then submit to homebrew/cask.
2. **Self-host a tap** in the meantime (`JonathanRReed/homebrew-plainsong`),
   which has no signing requirement:
   `brew install --cask JonathanRReed/plainsong/plainsong`.

## Submission steps (homebrew/cask)

1. Publish the release (not a draft) with the arm64 DMG attached.
2. Compute the checksum: `shasum -a 256 Plainsong-<version>-arm64.dmg`.
3. Fill in `version` and `sha256` in the template above.
4. Audit locally:
   ```bash
   brew audit --cask --new ./plainsong.rb
   brew install --cask ./plainsong.rb   # smoke-test the install
   ```
5. Open a PR against https://github.com/Homebrew/homebrew-cask adding
   `Casks/p/plainsong.rb` (one cask per PR; follow their CONTRIBUTING guide).
6. After acceptance, update the root README's Install section from
   "Homebrew: planned" to the real `brew install --cask plainsong` command.

For subsequent releases, bump `version`/`sha256` — or let Homebrew's
`brew bump-cask-pr` do it.
