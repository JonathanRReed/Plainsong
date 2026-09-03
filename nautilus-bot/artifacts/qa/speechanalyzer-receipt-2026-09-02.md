# SpeechAnalyzer receipt: the macOS 26+ zero-download Apple Speech tier (2026-09-02)

Parity program item C5. Question: the Apple Speech helper only *detected*
`SpeechAnalyzer` and kept transcribing through `SFSpeechRecognizer`. Build the
real path, measure it against the repo's own references, and decide what it is
allowed to serve.

## Decision

| Question | Answer | Why (measured, this machine) |
| --- | --- | --- |
| Use SpeechAnalyzer for batch dictation? | **Yes, when its assets are on disk** | 4.44% WER on the 44 s fixture and 0.00% on the 5.3 s fixture against the repo's references, at 1.26 s p50 for 44 s of audio on a machine at load 86. |
| Use it for meetings? | **Yes, but only when the meeting slot names it** | It returns per-segment timestamps (7 segments spanning 0.00-43.50 s on the 44 s fixture), which is what `transcribe_recording_in_chunks` offsets and merges. SFSpeechRecognizer returns none, so that path stays dictation-only. Eligibility is not inheritance: the meeting lane picks it up only when the meeting slot names it outright, the same rule whisper.cpp has, so nobody's existing meetings move engine on a macOS update. |
| Use it for live dictation partials? | **Helper side only, not wired** | The `--live --engine speech_analyzer` stream works (volatile spans track audio in real time; finalization lands 73-187 ms after the last byte), and the Rust adapter that folds it into `stable_prefix` + `volatile_suffix` is tested. Nothing drives it: streaming dictation is a separate lane, and this one deliberately left the default `--live` protocol untouched. |
| Relax the Speech Recognition permission gate? | **No, not on this evidence** | SpeechAnalyzer transcribed both fixtures with `authorization: not_determined` — it does not go through `SFSpeechRecognizer`'s TCC gate. But "undecided" is not "denied", and the packaged Developer-ID-signed helper was not tested. The permission flow is unchanged; the relaxation is available later on stronger evidence. |

## Environment

- Hardware: Apple M4 Pro, 14 logical CPUs, 24 GB (25 769 803 776 bytes).
- OS: macOS 27.0 (build 26A5406e). SDK: macosx 26.2. Swift 6.2.3
  (swiftlang-6.2.3.3.21).
- Helper: `rust-sidecar/native/macos_speech_helper.swift` compiled exactly as
  `build.rs` does — `xcrun swiftc -O -target arm64-apple-macosx13.0`,
  `MACOSX_DEPLOYMENT_TARGET=13.0`, ad-hoc signed with
  `macos_speech_helper.entitlements.plist` (Speech recognition only, nothing
  else). Binary sha256 `28cc21d0…5649`.
- Source: this lane's branch at `12139d03`, cut from `parity-waves` at
  `c865ba8f`.
- **Machine state: shared with other parity lanes.** The 1-minute load average
  is recorded with every timing below; 14 cores, so anything above ~14 is
  oversubscribed, and every number here was taken between load 28 and load 87.
  Treat the latencies as an upper bound, not a benchmark.
- Fixtures (repo, sha256): `scripts/fixtures/local-quality-gate.wav` 5.32 s
  `3a3caf18…31dc`; `scripts/fixtures/real-speech-44s.wav` 43.97 s
  `bcece745…5af4`. Both 16 kHz mono 16-bit.
- References: the Parakeet TDT 0.6B v3 output cross-checked against whisper.cpp
  `base.en`, as kept in `rust-sidecar/src/asr/qwen3_asr.rs`
  (`REAL_SPEECH_44S_REFERENCE`, `LOCAL_QUALITY_GATE_REFERENCE`). Neither fixture
  ships a human transcript. WER is the same normalized word-level edit distance
  those tests use.

## Batch transcription (`--transcribe-file --engine speech_analyzer`)

| Fixture | WER vs reference | Wall time (p50 of 3) | Samples | Load | Segments | Mean confidence |
| --- | --- | --- | --- | --- | --- | --- |
| `real-speech-44s.wav` (43.97 s) | **4.44%** (6 edits / 135 words) | **1.26 s** (0.029× real time) | 0.958 / 1.260 / 1.371 s | 86.7 | 7 | 0.934 |
| `local-quality-gate.wav` (5.32 s) | **0.00%** | **0.34 s** (0.064× real time) | 0.303 / 0.341 / 0.356 s | 84.8-86.7 | 1 | 0.963 |

An earlier single run of the 44 s fixture at load 31 took **0.94 s**, so the
numbers above are dominated by contention, not by the engine.

All six of the 44 s edits come from three disagreements, four of them from the
same word appearing twice:

| Reference | SpeechAnalyzer | Edits |
| --- | --- | --- |
| "Plainsong" (twice) | "Plain song" | 4 (one substitution + one insertion, twice) |
| "mail client" | "male client" | 1 |
| "a commit message in your journal" | "…in your terminal" | 1 |

Neither fixture has a human transcript in this repo, so "journal" vs "terminal"
cannot be adjudicated here — the reference is itself model output. All three
disagreements are counted as errors above rather than argued away.

Segment timestamps on the 44 s fixture (the reason meetings are allowed at all):

```
  0.00   3.36  0.941  Plain song is a free and open source dictation app for the Mac.
  3.36  10.14  0.953  It listens when you press a hot, turns your words into text …
 10.38  12.36  0.964  Nothing you say ever leaves your computer.
 12.48  23.16  0.941  You can dictate an email in your male client, a message in Slack, …
 23.16  31.74  0.950  It also captures meetings without a bot joining the call, …
 31.74  36.72  0.845  Voice input everywhere, with no account, no subscription, …
 36.96  43.50  0.945  This recording exists to benchmark transcription latency …
```

Spans are contiguous and monotonic, and the last one ends 0.47 s before the end
of the file (trailing silence). `transcribe_with_engine` subtracts the 750 ms of
silence `stage_macos_speech_input` prepends before reporting these, so they land
on the caller's audio and not on the staged copy; that offset has its own test.

### Memory

The helper's own RSS is not the cost. Peak RSS sampled at 20 Hz during one 44 s
run (load 77):

| Process | Peak RSS |
| --- | --- |
| `localspeechrecognition` (the XPC service doing the work) | 99.9 MB |
| `(localspeechrecog)` | 22.6 MB |
| `nautilus-macos-speech-helper-aarch64-apple-darwin` | 20.1 MB |
| `corespeechd` | 7.8 MB |
| `speechmaintenanced` | 3.5 MB |

So ~130 MB total while transcribing, of which the helper holds 20 MB. Reporting
only the helper's RSS would understate it about five-fold. All of it is
transient: the daemons are the OS's and are not held between runs.

## Live streaming (`--live --engine speech_analyzer`)

Driver: a Python harness in the session scratchpad (not committed) that feeds
the fixture as Float32 PCM in 100 ms slices in real time and timestamps every
JSON line the helper prints.

`local-quality-gate.wav`, 4 runs, load 28-39:

| Run | First volatile | Last volatile | Finalized | After last audio byte | Volatile → finalized |
| --- | --- | --- | --- | --- | --- |
| 1 | 3.918 s | 5.337 s | 5.477 s | 151 ms | 140 ms |
| 2 | 3.922 s | 5.336 s | 5.511 s | 187 ms | 175 ms |
| 3 | 3.916 s | 5.336 s | 5.398 s | 73 ms | 62 ms |
| 4 | 3.918 s | 5.339 s | 5.405 s | 77 ms | 66 ms |

p50 finalization: **114 ms** after the last audio byte. Volatile results are not
smooth: they arrive in bursts of 10-20 events a few milliseconds apart as the
analyzer extends its volatile range (0.00-4.00 s at wall 3.92 s, then
0.00-5.32 s at wall 5.34 s), so the preview tracks the audio closely but jumps
rather than crawls.

`real-speech-44s.wav`, one run, load 28: 198 volatile events and 7 finalized
spans, each arriving 0.7-3.9 s after the end of the audio it covers; the closing
`final` line landed 95 ms after the last audio byte. The assembled live text is
byte-identical to the batch text, so live and batch score the same 4.44%.

## Language assets

`--install-assets --locale en_US` ran in 0.16 s and reported
`{"asset_status":"installed","engine":"speech_analyzer","installed":true,…}`,
having found nothing to download.

Two measured macOS behaviours shaped the protocol, and both are worth knowing:

1. **`AssetInventory.status(forModules:)` reports `.installed` only for a
   locale allocated to the calling process.** With `en_US` in
   `SpeechTranscriber.installedLocales` and the model plainly on disk, the
   status read back as `.supported` until `AssetInventory.reserve(locale:)`
   ran, after which the same call returned `.installed` and
   `assetInstallationRequest(supporting:)` returned nil. So "supported" does
   not mean "needs a download".
2. **That reservation does not survive the process.** The helper's next
   `--probe` reported the locale unallocated again.

The probe therefore treats *either* signal as "the assets are on disk"
(`speech_analyzer_assets_installed`), reports the raw state separately as
`installed_not_allocated` so the distinction is not lost, and every analysis
path reserves the locale for itself before starting. `maximumReservedLocales`
is 5 on this Mac.

`SpeechTranscriber.supportedLocales` reports **45 locales** here, of which **9
are installed** (every English variant: `en_AU en_CA en_GB en_IE en_IN en_NZ
en_SG en_US en_ZA`). The other 36 — including `de_DE`, `es_ES`, `fr_FR`,
`ja_JP`, `ko_KR`, `zh_CN`, and eleven Indic locales — are supported but not
installed. That list is per-machine, which is why the provider's language list
is now read from the probe rather than hard-coded.

**Not exercised: a real language download.** Installing, say, `fr_FR` would pull
an Apple asset of unknown size onto the reader's disk, so this lane did not run
one unprompted. The progress emitter is the same code path in both cases and was
observed emitting its `checking` and `verifying` stages; only the `downloading`
stage, its `fraction`, and the wall time of a real download are unmeasured. That
needs a user-present run.

## Permission

Every measurement above was taken with the helper's probe reporting
`"authorization":"not_determined"`. SpeechAnalyzer transcribed anyway;
`--engine sf_speech_recognizer` on the same fixture refused with
`authorization_not_determined`, as it always has. That is a real capability
difference, and it is *not* being spent: `readiness_from_probe` still refuses to
call the route ready until Speech Recognition permission is decided, and the
Models screen still shows the permission flow. Two things would have to be true
before relaxing it — that a *denied* decision also does not block SpeechAnalyzer,
and that the same holds for the Developer-ID-signed helper inside the packaged
app — and neither was tested here.

## Gates

Run from `nautilus-bot/` with the shared `CARGO_TARGET_DIR`, on the same loaded
machine.

| Gate | Result |
| --- | --- |
| `bun run typecheck` | pass (no output) |
| `bun run test` | 139 files, 1567 tests passed |
| `cargo fmt --check` | clean |
| `bun run lint:rust` (clippy `--all-targets -D warnings`) | clean |
| `bun run test:rust` (`--lib --bins`) | 1307 + 18 + 4 passed, 8 ignored, 0 failed |
| `bun run gate:ipc-contract` | pass — 193 renderer commands, 179 dispatched commands reachable |
| `bun run gate:dead-code` | pass |
| `node scripts/verify-macos-speech-helper.mjs` | `{"pass":true,…,"engine":"speech_analyzer"}` |

`verify-macos-speech-helper.mjs` was extended for this lane: it now checks the
`#available(macOS 26, *)` guard, the timestamp attribute, the refusal when
assets are missing, the `--live` default staying on the old protocol, the two
new typed error codes, every new probe field's type, that a resolved
`speech_analyzer` engine implies `speech_analyzer_available`, and that both an
unknown `--engine` and `--live --engine auto` return a typed
`malformed_request` — live mode refuses to auto-select rather than resolving
to one engine silently.

## What a reader still has to do on-device

- Grant Speech Recognition once, as before. Nothing here changed that flow.
- Install a non-English language before SpeechAnalyzer will serve it. The
  action exists and is wired end to end; the download itself is unmeasured.
- Confirm the packaged, Developer-ID-signed helper behaves the same as the
  ad-hoc-signed one measured here. The signing identity is the one input this
  lane could not reproduce.
