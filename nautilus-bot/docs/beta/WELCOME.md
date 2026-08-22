# Welcome to the Plainsong limited beta

Thank you for testing Plainsong `0.9.0-beta.2`. This beta has two supported
pillars: fast system-wide Dictation and local-first Meeting capture.

## Supported Macs

- Apple Silicon Mac, M1 or newer
- macOS 13 or later
- at least 8 GB memory, with 16 GB recommended for larger local models
- several gigabytes of free space if you test meeting-grade models

Native system-audio capture is enabled on macOS 14.7 or later. On macOS 13 and
macOS 14.0 through 14.6, mic-only Meetings work without extra software, while
Me + Them capture needs a configured virtual loopback device such as BlackHole.

## Install

1. Download the DMG and `SHA256SUMS.txt` from the private invitation.
2. Verify the DMG checksum with `shasum -a 256 /path/to/Plainsong*.dmg`.
3. Open the DMG and drag Plainsong into `/Applications`.
4. Open the installed copy from `/Applications`, not from the DMG.
5. Follow setup for the Dictation model, microphone, text insertion, Meeting
   route, audio storage, and retention.

Plainsong should open normally through Gatekeeper. Do not use a quarantine
bypass or disable macOS security. If macOS refuses the build, stop and report
the exact message.

## What to test first

Run one mission from each pillar in [TEST-MISSIONS.md](TEST-MISSIONS.md). The
best first report includes what Mac and macOS version you used, the Plainsong
version, whether Dictation inserted into the target app, and whether a Meeting
captured only you or everyone.

Read [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md) before testing interruption,
Me + Them capture, automatic updates, or insertion into security-sensitive
fields.

## Getting help

Reply through the same private channel that delivered your invitation. Before
sending diagnostics, follow [SUPPORT-BUNDLE.md](SUPPORT-BUNDLE.md). A support
bundle is optional in this limited beta, and installed-app testers are not
expected to install developer tools to create one. Never send meeting audio,
transcripts, dictated text, API keys, or Keychain exports.

The beta is limited, not confidential. Treat the installer link as unlisted,
but assume it may be copied. Plainsong must remain safe without relying on link
secrecy.
