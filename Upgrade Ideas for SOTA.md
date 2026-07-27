# Upgrade Ideas for SOTA

Research pass, 2026-07-25, against commit `bd18193`.

Six web-research lanes, each grounded in a verified limitation of our own code
rather than an abstract survey. Every high-impact recommendation was then
adversarially checked for license, Apple Silicon support, and integration
realism: **25 recommendations evaluated, 12 survived.** Refuted ones are listed
at the bottom so they don't quietly reappear.

Claims marked **[verified here]** I checked directly against the repo or the
crate source during this pass. Everything else is research-sourced and carries
its own confidence.

---

## Completion update, 2026-07-27

All five items originally listed under **Now** are closed in the current working
tree:

1. Meeting completion is persisted and emitted before optional diarization.
   CPU-heavy diarization work uses blocking workers, and uncovered spans remain
   unattributed instead of being assigned to speaker one.
2. Native Core Audio process-tap capture is implemented through a patched,
   vendored CPAL route with dynamic symbol loading, output-device change
   handling, and virtual-loopback fallback.
3. The packaged Apple Speech helper is restored, strict about on-device
   recognition, signed with a Speech-only entitlement, and verified during the
   build.
4. Grounded analysis uses compact canonical line IDs, recursive reduction, and
   explicit Ollama context planning based on `/api/show` metadata.
5. `docs/competitive-positioning.md` was rewritten against current first-party
   sources and no longer carries the stale uniqueness or anarlog claims.
6. v1 consent delivery is manual and fail-safe. Plainsong does not toggle Zoom
   or Google Meet chat and claim success without proving the intended message
   field has focus.

The original analysis remains below as a record of why those changes were
made. Statements phrased in the present tense under **Now** describe the
July 25 baseline, not the completed July 27 tree. **Next** and **Later** remain
future product ideas, not unfinished v1 launch work.

---

## The headline

**The original two highest-leverage correctness items are now implemented.**

Native system-audio capture no longer requires a third-party driver on the
supported process-tap path, and diarization can no longer withhold the initial
completed transcript. Streaming ASR remains deliberately demoted. See
"Do not do."

---

## Strategic read

**The "only free/OSS local-first app doing BOTH dictation and meetings" claim no
longer holds, and should be retired before the repo goes public.**

Doing both is now the shape of the category:

- **Muesli** (`github.com/Muesli-HQ/muesli`) — native Swift/CoreML macOS app,
  explicitly Wispr-style dictation *plus* Granola-style meeting transcription,
  simultaneous mic + system capture, on-device diarization.
- **Superwhisper** ships a dedicated Meeting mode with on-device speaker
  separation.
- Wispr and Raycast both added meeting surfaces.
- Streaming stopped being a moat on **2026-07-01**, when Handy shipped local
  streaming free and MIT.

### What still holds, and is verifiable rather than rhetorical

1. **Granola's own security page states it uses Deepgram and AssemblyAI.** The
   category leader's "real-time" transcript *leaves the device*. A genuinely
   local transcript is a claim they cannot make.
2. **The trust and durability axis opened up.** Granola capped free history and
   retired its individual tier in 2026 while pivoting to enterprise. Otter is in
   federal wiretap class-action litigation.
3. **Anarlog kept MIT and monetized cloud sync at $15/mo** — a working template,
   not a cautionary tale.

The durable position is: *free, MIT, no account, nothing leaves the machine,
both surfaces, honest about what it cannot do.* Every one of those is a promise
about behavior rather than a feature race we would lose.

The remaining release gates are **notarization and user-present acceptance**,
not a missing model.

---

## Now

### 1. Stop diarization withholding and mis-attributing transcripts — `M`: closed

This is not an upgrade idea. **It is a live bug that costs a user their meeting.**

**(a) The transcript is saved *after* diarization.** [verified here] At
`lib.rs:17624-17631`, `run_diarization(&path).await` completes before
`db.save_transcript()` and `update_recording_status("completed")`. The clustering
in `diarization/embedder.rs` is O(n³) over roughly one embedding per second of
audio, so a 60-minute meeting can take minutes and a 2-hour meeting may never
finish. Because the whole pipeline is a detached `tokio::spawn`, a hang surfaces
as **no transcript, no event, no error**.

Fix: save unlabelled first, mark completed, then diarize.

> `tokio::spawn` alone does **not** fix this — `cluster()` has no await points,
> so it must go behind `spawn_blocking` or a dedicated thread. A
> `tokio::time::timeout` wrapped around the current code cannot fire at all.

**(b) Unattributed speech is confidently assigned to speaker one.** [verified
here] Both `unwrap_or_else(|| "S1".to_string())` calls at
`diarization/mod.rs:249` and `:258` assign any span diarization didn't cover to
S1. Then `infer_speaker_aliases_from_segments` (`lib.rs:5579`), called right
after merge, **auto-maps S1 to a real human name** regexed out of an intro
phrase. We put words in a named person's mouth with no user action.

Fix: emit `None`. Ship the renderer half in the same change —
`transcript-viewer.tsx:562` substitutes `speaker-${groupIndex}` for a null id,
and `handleRenameSpeaker` would persist an alias keyed to a synthetic id
matching nothing.

**Files:** `rust-sidecar/src/lib.rs`, `rust-sidecar/src/diarization/mod.rs`,
`rust-sidecar/src/diarization/embedder.rs`, `src/components/transcript-viewer.tsx`

---

### 2. Delete the BlackHole requirement with a Core Audio process tap — `M`: closed

**Start with the 30-minute experiment before writing any Swift.**

[verified here] `cpal 0.18.1` — already in our lockfile — ships
`src/host/coreaudio/macos/loopback.rs`, which uses
`AudioHardwareCreateProcessTap` + `CATapDescription` + a private aggregate
device, triggered by building an *input* stream on an *output* device.

`find_loopback_device()` (`system_capture.rs:584`) never tries this, because
`LOOPBACK_KEYWORDS` (`system_capture.rs:512`) rejects any device not named
"blackhole"/"stereo mix"/etc.

**Try the default output device as a loopback source first.** If it works, our
worst adoption barrier is a device-selection change, not a project.

If it doesn't, the fallback is a small signed Swift helper spawned by the
sidecar, emitting PCM on stdout. Use a **separate process, not in-process FFI** —
`AudioHardwareCreateProcessTap` links as a strong import and dyld kills the
process on macOS 13 before any Rust version gate runs. A binary that is simply
never launched below 14.4 sidesteps that.

Either way: replace Electron's boilerplate `NSAudioCaptureUsageDescription`,
gate at 14.4, keep BlackHole as the macOS 13.x tier, emit at the output device's
**native** rate (`resolve_target_sample_rate` is `mic_rate.max(system_rate)`, so
a 16kHz tap against a 48kHz mic gets upsampled for nothing), and add a
`kAudioHardwarePropertyDefaultOutputDevice` listener — taps follow the default
output only, so AirPods connecting mid-meeting silences them for 180s before our
watchdog warns.

Notarization is **not** a blocker for building or testing this: TCC keys off the
signing identity, and `Developer ID Application: Jonathan Reed (AJ9VWBRNZN)`
already signs everything.

**Files:** `rust-sidecar/src/audio/system_capture.rs`, `electron-builder.yml`,
`src/components/first-run-wizard.tsx`, `rust-sidecar/src/lib.rs`

---

### 3. Wire or delete `macos_apple_speech` — it has never worked — `S`: closed

[verified here] `build.rs:63` only emits `cargo:rustc-cfg=nautilus_macos_speech_helper`
if a Swift helper compiles from `rust-sidecar/native/`. **That directory does not
exist**, and the shipped build output never sets the cfg. So `probe()` always
returns `ready:false` and `is_available()` is permanently false — while the
provider is surfaced in `AsrProviderType::all()`, the provider manager, the
first-run wizard, settings, and the recordings view, behind a gate that can
never open.

Two small steps: invert `build.rs` so a missing helper on macOS is a hard error
rather than a silent skip (this class of bug recurs otherwise), then either drop
the provider from the advertised list or restore the helper — it still exists at
`git show 59f1818^:nautilus-bot/src-tauri/native/macos_speech_helper.swift`
(414 lines, `--live` already implemented).

> If restoring: the recovered file sets
> `requiresOnDeviceRecognition = supportsOnDeviceRecognition`, which silently
> falls back to **Apple's servers** when on-device is unavailable for the locale
> — while our Info.plist promises "Audio stays on your device." Force it true and
> hard-fail otherwise.

We advertise a provider that cannot be selected. That's the same class of
unbacked claim the last few commits were spent deleting.

---

### 4. Fix the two ways summarization silently drops most of the meeting — `M`: closed

**(a) Two-thirds of the analysis payload is UUIDs.** `serialize_analysis_context`
(`lib.rs:1244`) emits
`[recordingId:{uuid}|title:{title}|segmentId:{uuid}|startTime|endTime] {text}`
per segment — roughly 158 characters of metadata against ~88 of speech.

Replace the citation key with a short integer line index, map it back
server-side in `validate_structured_citations`, drop the repeated title. Per-line
cost falls ~83 → ~32 tokens; a 1400-segment meeting goes ~116K → ~45K tokens,
which fits one call on every provider we support. That lets us raise or drop
`ANALYSIS_CONTEXT_MAX_SEGMENTS = 140` and retire the coverage caveat — **no new
architecture, and it buys back most of a map-reduce pipeline's benefit.**

**(b) `num_ctx` is never sent to Ollama.** `GenerationOptions`
(`llm/ollama.rs:275`) carries only temperature and `num_predict`. Ollama defaults
by VRAM tier, so a 16–32GB Mac gets 4096, and with context shift on the prompt is
truncated to ~2051 tokens keeping `tokens[..5]` plus the **tail** — destroying
the template instruction, the action-item block, and the user's custom prompt
while preserving the end of the transcript.

Send `num_ctx` as `Option<i32>` with `skip_serializing_if` (a bare `0` disables
Ollama's OOM step-down and clamps to a 4-token context), derive it from
`/api/show`, never lower it below the tier default, and raise the 120s timeout in
the same change or you trade a truncated summary for none at all.

---

### 5. Correct `docs/competitive-positioning.md` before the repo goes public — `S`: closed

Two claims are false and are steering the roadmap; a third proposed "correction"
should be **rejected**.

1. **Line 51** — "the open field hasn't nailed it (superwhisper is the only one
   shipping it, and it's closed/paid)". Handy shipped streaming free and MIT in
   v0.9.0 on **2026-07-01** and has iterated four times since. The doc's own
   Risks section named this as the thing to fear; it happened.
2. **Line 36** — "anarlog's founders pivoted to a closed-source product".
   `fastrepl/anarlog` is MIT, ~8,875 stars, pushed today, and the predecessor
   repo was explicitly relicensed **GPL → MIT**. They went *more* permissive, and
   run the exact open-core model our own Sustainability section proposes.
3. **Do NOT add the proposed Wispr Flow notetaker correction** —
   `wisprflow.ai/notetaker` 404s and every current surface shows dictation only.
   The existing line is accurate.

Also drop the stale star count, and re-argue the "launch on streaming alone" bet
— that's the part that actually expired.

This is already flagged in `LAUNCH.md` as must-resolve-before-public, alongside
the separate unsourced-allegation problem on line 19.

---

## Next

| # | Item | Effort |
| --- | --- | --- |
| 1 | **Spike streaming ASR for dictation only** — timebox 1–2 days. Answer two things nothing on the web answers: does `transcribe-cpp` link alongside `whisper-rs` without a ggml duplicate-symbol failure on macOS arm64, and what is real streaming latency and peak RSS on the oldest M-series we support? There are **zero** published Apple Silicon benchmarks for transcribe.cpp streaming; the quoted Moonshine numbers (34/73/107ms) are end-of-utterance finalization on unspecified hardware from a different implementation. Scope to dictation partials — Moonshine streaming is English-only with `supports_timestamps:false`, so it cannot back multilingual meetings and gives diarization nothing to align to. Expect a **second trait**: `AsrProvider` is `Send+Sync` with `async fn transcribe(&self, …)` and cannot express a `&mut` streaming session. | S spike / L integration |
| 2 | **Evaluate consent auto-post only with positive target-field verification.** v1 deliberately keeps the notice manual because Zoom's chat shortcut is a toggle and browser meeting layouts change. A future implementation must prove the intended chat field has focus before inserting or sending anything, fall back to the copyable manual notice otherwise, and include a "not legal advice" disclaimer. | S |
| 3 | **Evaluate `speakrs` as the diarization engine, gated on a build spike.** v0.5.0 (Apache-2.0, 2026-07-07), pure Rust, pins `ort 2.0.0-rc.12` and `ndarray 0.17.2` — the exact versions we already have — reporting 17.2% DER on AMI IHM at 666× realtime on M4 Pro. **Exit criterion is a single green build**: it pulls `ndarray-linalg` + `openblas-src`, which does not compile on this machine today, and `ndarray-linalg 0.18` has no Accelerate backend. Also budget ~59.5MB across ~10 files against a DownloadManager that handles one flat file per model id. | S spike / L |
| 4 | **Local stdio MCP server, read-only, off by default.** The sidecar is already a newline-delimited JSON-RPC stdio server; `rmcp 2.2.0` is the official Apache-2.0 Rust SDK. Granola's MCP is remote OAuth with the transcript tool paywalled — a local server with no account and unlimited history is genuinely differentiated. Two things a naive version gets wrong: the allowlist must be enforced by whatever owns the socket (0600 authenticates the *user*, not the *process*, and the unfiltered dispatch table includes `set_provider_secret` and `delete_recording`), and **fence every transcript byte as untrusted** — anyone who speaks in a meeting can plant instructions an agent later reads. | L |
| 5 | **Apple Foundation Models as the zero-install summarizer on macOS 26+.** Real, GA, no entitlement for the on-device path. Gated behind two prerequisites: chunking (the 4096-token window is input **and** output, ~15 minutes of speech, and we have no chunking anywhere), and an actual LLM trait (`llm/mod.rs` declares zero traits; provider selection is a copy-pasted match at ~8 sites). Make it the default **only when Ollama is absent** — a 3B model doing map-reduce is worse than an 8B with 32k context. | L |
| 6 | **Publish a narrow sustainability commitment.** A no-rug-pull guarantee that local capture, transcription and storage stay free and MIT forever, plus GitHub Sponsors. Must land with housekeeping: clear the stale paywall strings that would falsify the pledge on day one — `docs/cloud-sync-byoc.md:7` calls cloud sync "a Friends Club entitlement", `settings.rs:128` marks silence-skip "(Pro/Friends Club feature)", `settings.rs:823` restricts beta to Friends Club. Nothing enforces any of it, but the strings ship in a public MIT repo. | S |

---

## Later

- **Streaming diarization.** NVIDIA Sortformer is real (13.24% DER on DIHARD III
  at 1.04s latency, CC-BY-4.0) and `parakeet-rs` exposes it over the `ort` backend
  we use. But it caps at 4 speakers, published RTFs are datacenter-GPU, and
  there's nothing to attach live labels to until streaming ASR exists.
- **Windows as second platform.** Defensible on market size, not on the usual
  argument. The claim that Windows loopback is driver-free and therefore better
  is **wrong** — `cpal` does driver-free loopback on both. Real cost: 228
  `target_os="macos"` cfgs across 10 files (152 in `lib.rs`), no CI workflows,
  `electron:build:win` has never run successfully, no Windows signing config.
  One upside: `whisper-rs 0.16` already has a `vulkan` feature, so Windows GPU is
  a flag, not a resignation.
- **Persistent speaker identity (voiceprints).** Genuine parity, right storage
  design — but downstream of everything. Embeddings are computed and thrown away
  today, the diarization model picker is inert (`with_model` is called from
  nowhere, so selecting CAM++ still gets ECAPA embeddings), and the widely-cited
  0.70/0.55 cosine thresholds come from CAM++, not the WeSpeaker ECAPA space we
  use. Opt-in, off by default, local-only, visible delete-all.
- **SpeechAnalyzer on macOS 26+** as an opportunistic fast path. GA, on-device,
  purpose-built for long-form streaming, volatile/finalized semantics that map
  cleanly onto a stable-prefix contract, zero bytes shipped. No custom-vocabulary
  API, so it cannot serve the dictation dictionary. Worth doing once a streaming
  seam exists; **not** worth raising the OS floor for.

---

## Do not do

These are the traps. Several look attractive.

1. **Live word-by-word captioning during meetings.** The strongest dead-end
   signal in the whole scan. Anarlog shipped it and **removed it in v1.3.9 on
   2026-07-24**, with the explicit note: *"Run batch transcription models after
   recording instead of attempting live transcription."* Our delayed preview is
   where two better-resourced competitors independently landed.
2. **Collapsing the ASR providers onto one runtime.** Doesn't survive contact
   with our code. `ort` cannot be removed — `silero_vad.rs`,
   `diarization/embedder.rs` and `transcription.rs` all use it, and the
   `diarization` feature enables it independently of any ASR provider.
3. **ScreenCaptureKit for audio.** SCK structurally cannot capture audio only —
   without a video output it logs "stream output NOT found. Dropping frame." So
   you run a dummy video stream, hold the full Screen Recording grant, light the
   purple indicator, and inherit macOS 15's monthly re-consent prompts. Process
   taps are strictly better here.
4. **Training or fine-tuning our own ASR or LLM.** This is the 2026 paid-
   differentiator race (Superwhisper S1-Mini, Aqua Avalon, FluidVoice Fluid-1)
   and it is capital-intensive. Telling detail: FluidVoice is GPLv3 but its
   Fluid Intelligence runtime is separately and privately maintained.
5. **Multi-device sync, CRDTs, or cr-sqlite.** Automerge 3.0, Loro and iroh are
   production-ready, so "the tech isn't ready" is no longer the objection —
   *scope* is. CRDTs merge documents; our payload is hundreds of MB of audio plus
   a SQLCipher-encrypted archive.
6. **Homebrew-cask and Setapp as launch channels.** Self-submission requires
   90 forks / 90 watchers / 225 stars. The repo has 0 of each. The star count, not
   repo age, is the blocker.
7. **Enterprise memory, CRM sync, calendar automation as a product.** Granola's
   Series C wedge, enterprise-sales-shaped, unwinnable for a no-name OSS app. Our
   own positioning doc already flags it as a trap and that judgment holds.
8. **Raising the macOS floor to 26, or making our existing Parakeet stream.**
   Same shape: a shortcut that costs more than it saves. SpeechTranscriber covers
   10 languages with no custom-vocabulary API, which would silently break the
   dictation dictionary.

---

## Sequencing note

The five **Now** items are closed in the July 27 working tree. **Next** and
**Later** should remain separately scoped product work after the notarization
and user-present acceptance gates in `LAUNCH.md`.
