# Beta 4 final pass

Reviewed September 4, 2026, on the maintainer's Apple Silicon Mac.

Verdict: ready for a private week of testing on the paths listed below.
This is not a public-launch or blanket competitor-parity certification.

## Candidate

- Application source: `5c0ca09886cb3a28fbd72209a1bde30827ed2b09`.
- Internal release: [v0.9.0-beta.4](https://github.com/JonathanRReed/Plainsong/releases/tag/v0.9.0-beta.4).
- DMG: `Plainsong-0.9.0-beta.4-arm64.dmg`, 136,566,773 bytes.
- SHA-256: `28f1b1a42306095afe36b24c126a42ec060f7e5a1a22b37e1d0b2bceee759cb4`.
- The final-pass commit changes QA tooling and documentation only. It does
  not change the application in the signed DMG or move the release tag.

The DMG mounted successfully, its app was copied to a separate directory,
and that copy passed Gatekeeper and stapling validation. All six first-run
checks passed against the copied app. The existing installed app and user
database were not replaced for this check.

## Fresh workflow evidence

| Path | Result | What this establishes |
| --- | --- | --- |
| Toggle dictation | Passed in release qualification | Hotkey start/stop, persisted result and clipboard delivery |
| Hold-to-talk | Passed | One press/release pair covering spoken audio, completed transcript and clipboard readback |
| Apple Notes insertion | Passed | Empty native field before insertion and independent readback in the same note afterward |
| Mic and combined meeting capture | Passed in release qualification | Audio persisted, duplicate stop safe, capture modes correct |
| 45-second spoken combined meeting | Passed | Known system tone, durable transcript, completion events and cleanup |
| Local summary and action items, `gemma4:e4b` | Passed | Source citations and action owners returned through the packaged sidecar |
| Settings backup and restore | Passed | Local backup and the iCloud provider path against an isolated local fixture; not a live iCloud service test |
| Retention | Passed | Packaged retention policy checks in an isolated profile |
| Exports | Passed | Markdown, JSON, text and all eight templates, including Word |
| DMG first run | Passed | Six setup, migration and deferral checks after copying from the mounted DMG |

The Word export check initially failed because it searched compressed DOCX
bytes as UTF-8. The checker now asks `/usr/bin/textutil` to read the document,
rejects conversion failures, and checks the extracted title and transcript.
The unchanged packaged app then passed all export checks. The focused export
UI and QA-isolation tests passed, 14 tests across two files.

The earlier exact-source qualification passed all ten gates, 1,897 frontend
tests and 1,731 Rust tests. Dependency audits found no known vulnerabilities.
The unmaintained transitive `paste` crate remains a dependency warning.
GitHub-hosted CI is unavailable because the account has exhausted its allowance.

Raw local receipts are under `/private/tmp/plainsong-beta4-final-pass` and
`/private/tmp/plainsong-beta4-final-receipts`. This report preserves the useful
results without committing machine logs or user-profile data.

## Competitive conclusions

These are comparisons with current vendor documentation, not measurements
of competitor binaries. Vendor pages were checked during this pass.

| Goal | Evidence and conclusion |
| --- | --- |
| Local transcription without waiting for a cloud service | Plainsong has a working local route. Wispr documents retrying cloud transcription after reconnecting. This is an advantage for the offline workflow, not proof of higher accuracy. [Wispr documentation](https://docs.wisprflow.ai/articles/2503460374-retry-failed-transcriptions) |
| Local meeting data and processing | Plainsong's tested local capture and analysis avoid a hosted account. Granola describes external transcription/AI providers and AWS note storage. This supports our user-control advantage. [Granola security](https://www.granola.ai/security) |
| Free access to local history | Plainsong has no application note-count limit. Granola currently lists limited history on Basic and unlimited history on Business. Retire the older specific 25-note claim. [Granola pricing](https://www.granola.ai/pricing) |
| Free model choice and BYOK | Plainsong does not charge to select supported models or configure keys. Superwhisper offers free dictation and meetings, but lists BYOK and unrestricted local/cloud AI models under Pro. Provider usage can still cost money. [Superwhisper plans](https://superwhisper.com/) |
| Better latency, accuracy and everyday editing | Not established comparatively. Wispr advertises cleanup, vocabulary, snippets and per-app styles; Plainsong has corresponding features, but a feature checklist cannot prove better results. [Wispr product](https://wisprflow.ai/) |
| Better meeting summaries and speaker labels | Not established comparatively. A cited local summary passed, but no blinded same-recording summary or diarization comparison was run. |

Superwhisper also supports offline models. Local execution alone is not an
advantage over it. The private repository is not yet publicly inspectable,
so public source availability is not a current competitive claim either.

## Remaining limits

- Launch presented at 3,015 ms and was interactive at 4,065 ms. The one-minute
  host load average was about 75. The sample missed a 2.5-second working
  target and does not establish normal launch speed. Half-Bounce is no
  longer a release condition, as requested.
- Hands-free did not start from the speaker fixture in either of two runs,
  including a retry with a longer settling time. The checker cannot separate
  microphone routing from activation failure. Leave it off for the baseline
  week test; use toggle or hold-to-talk.
- `gemma4:e2b` reached the output token limit on a summary. The configured
  `gemma4:e4b` model passed. Keep the smaller model unqualified for summaries.
- The hold fixture matched 8 of 12 scored words and the meeting fixture 6 of
  10. These pass the existing capture-smoke bar, but they are not word-error
  rate measurements or evidence of accuracy superiority. Review clipped words
  and proper names during the week test.
- Parakeet V2, all large model downloads, every BYOK provider, the full target
  application matrix, three-hour meetings, crash recovery, and an actual
  installed-version update have not all been requalified on this candidate.
- Enterprise here means product quality for individual users. This beta
  does not claim SSO, fleet administration, or compliance certification.

## Week test

Open the DMG and drag Plainsong into Applications. Quit any running copy
before replacing the older app. Launch from Applications and complete any
macOS permission prompts. Local models download separately from the DMG.

Start with Parakeet V3 and toggle or hold-to-talk. For local meeting analysis,
use the already installed `gemma4:e4b` through Ollama. Test system audio before
the first combined meeting. Keep cloud processing off unless intentionally
testing a BYOK route.

Use it in the apps and meetings you normally work in. Record the target app,
model, activation mode, and whether a problem was missing words, changed
meaning, failed insertion, a recording failure, or a bad summary. Check saved
meetings after relaunch and try an export and backup. Keep the release and
test recordings private. Long-call reliability and subjective editing quality
are the most useful things this week can establish.
