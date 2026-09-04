# Settings inventory — 2026-09-03

Every user-visible control on the Settings surface (`src/components/views/settings-view-simple.tsx`
and the sections it renders) and on the Models screen (`src/components/models/`), with the settings
key behind it, what the code actually does with that key, and the defect class it was in before this
pass.

Read this before adding a control. The rule the lane worked to: **a label names the thing, a
description says what happens to you if you change it.** Mechanism is optional; consequence is not.

## Headline counts

| | Count |
|---|---|
| User-visible controls inventoried (Settings + Models) | 102 |
| Controls whose explanation was missing or did not name a consequence, now fixed | 31 |
| Retired words, each replaced by one settled term | 7 |
| Duplicate / look-alike control pairs merged, moved or cross-referenced | 4 |
| Controls that could not do anything in a shipped macOS build, removed | 5 |
| Settings keys stored but read by nothing (left in place, listed below) | 4 |
| Setting keys renamed | 0 |

No settings key was renamed, so no tolerant-load path was needed. Every fix in this pass is copy,
`aria-describedby` wiring, or a structural move; the JSON on disk is byte-identical in meaning. The
one file outside Settings that was touched is `src/components/views/dictation-view.tsx`, which
renders the other half of the shared dictation auto-delete control and now says so.

## Defect classes used below

- **NO-EXPLANATION** — the label alone does not tell a new user what happens.
- **AMBIGUOUS** — the word means something else somewhere else in the app.
- **LOOK-ALIKE** — two controls a reader cannot tell apart, or the same control in two places.
- **INERT** — the control cannot change anything in the state the reader is in.
- **SURPRISING-DEFAULT** — on by default and it sends data, records something, or costs money.

---

## 1. Vocabulary map — one word, one concept

Committed as code in `src/lib/settings-vocabulary.ts` and enforced by
`src/__tests__/settings-vocabulary.test.ts`, which fails three ways: if a term is listed against two
concepts, if a concept is listed under two terms, or if a retired phrase reappears in any
settings-surface source file (comments stripped, so a comment may still explain the history) or in
the sidecar's user-facing strings. The code list carries a few more settled terms than the table
below — `binding`, and the three qualified senses of "model" — but the table is the argument.

| Concept | The word we use | Words that used to be used for it | Why this one |
|---|---|---|---|
| A saved bundle of dictation style, context and delivery (`dictationCustomModes`, `dictationModePreset`) | **profile** | "custom mode", "dictation mode", "mode" | The Dictation view already said "profile" and it is the surface where they are made. Settings, Models and three sidecar strings said "mode". |
| The engine that turns speech into text (`dictationProvider` / `meetingProvider`) | **speech engine**, shortened to **engine** inside a speech section | "provider", "route", "recognizer", "transcription method", "ASR provider" | "Provider" also named the company you buy an AI key from. "Route" is an internal word for engine + model. |
| The company or daemon that runs text AI (`privacy.dictationAi.provider`, `privacy.meetingsAi.provider`) | **service** | "provider", "analysis provider", "cloud provider", "LLM provider" | The API-key picker already said "service"; the Models rows now match it. |
| A downloadable weights file | **model**, always with its job attached — "speech model", "AI model", "speaker separation model", "search model" | bare "model" | Four different downloadables were all just "model". The qualifier is now mandatory. |
| Processing that happens on the user's Mac | **on this Mac** | "local", "local-only", "on-device" | "Local" also named the CLI/MCP feature and the "prefer local" routing policy. |
| The `plainsong` command, its MCP server and `plainsong://` links (`automation.localToolsEnabled`) | **command line and MCP access** | "local tools" | Third meaning of "local" on the same tab. |
| A stored numeric signature for a speaker (`meetings.rememberVoices`) | **voice signature** | already consistent; "voiceprint" is internal only | Left alone. Recorded here so nobody reaches for "speaker profile". |

Words deliberately **not** unified, with the reason:

- `dictationProfile` (`normal_speed` / `power_rewrite`) is labelled **"Dictation style"** in the
  Dictation view. It is a third meaning of neither "profile" nor "mode" in Settings, because Settings
  renders no control for it. Flagged for the Dictation lane, not changed here — see §6.
- "Mode" survives inside settings *keys* (`meetingAudioStorageMode`, `memorySearchMode`,
  `dictationInsertionMode`, `meetingRetentionDeleteMode`). None of them puts the word on screen.

---

## 2. Settings → Models (`src/components/models/`)

| Control | Key | Default | Rendered in | What it does | Was |
|---|---|---|---|---|---|
| Preset tiles: Light / Balanced / Widest languages / Largest models | writes `dictationProvider`+`dictationModelId`, `meetingProvider`+`meetingModelId`, `defaultProvider`, `selectedModelId`, `useSharedAsrSelection` | Balanced-equivalent (`parakeet`/`parakeet-tdt-0.6b-v3` on both lanes) | `preset-picker.tsx` | Sets both speech lanes at once. Never touches the AI lanes. | ok (each tile already carries a `buys` and a `costs` sentence) |
| Speech for dictation | `dictationProvider`, `dictationModelId` | `parakeet` / `parakeet-tdt-0.6b-v3` | `speech-lane-row.tsx` | The engine that runs while you talk. | ok |
| Speech for meetings | `meetingProvider`, `meetingModelId` | `parakeet` / `parakeet-tdt-0.6b-v3` | `speech-lane-row.tsx` | The engine that runs over a finished recording. | ok |
| **Meeting engine Plainsong offers first** (Prefer local / Best available) | `meetingRoutePolicy` | `prefer_local` | moved here from Transcription → Engine status | Only reorders what the meetings list offers; it never switches an engine by itself. | LOOK-ALIKE — it sat two tabs away from the engine list it reorders, under the name "Meeting quality policy", where it read like a second engine picker. |
| Live preview engine (Download / Delete) | none — file on disk | not downloaded | `live-preview-engine-row.tsx` | Draws the popup text while you speak. Never changes the inserted text. Marked experimental. | ok |
| Who writes summaries, answers, and actions | `privacy.meetingsAi.provider` | `ollama` | `ai-lane-row.tsx` | The service that writes meeting notes. | AMBIGUOUS ("cloud provider" → "cloud service") |
| — its Model | `privacy.meetingsAi.modelId` | `null` (the service's own default) | `ai-lane-row.tsx` | Which AI model that service uses. | ok |
| Who cleans up dictation | `privacy.dictationAi.provider` | `ollama` | `ai-lane-row.tsx` | The service that tidies a dictation before it is inserted. | AMBIGUOUS ("custom modes" → "saved profiles") |
| — its Model | `privacy.dictationAi.modelId` | `null` | `ai-lane-row.tsx` | ditto | ok |
| Built-in cleanup model (Download / Delete) | none — file on disk | not downloaded | `zero-setup-model-row.tsx` | S1-mini by Superwhisper, on this Mac. Dictation cleanup only. | AMBIGUOUS ("custom modes") |
| Apple on-device model (Re-check) | none — OS capability | n/a | `zero-setup-model-row.tsx` | Apple's on-device model. Dictation cleanup only. | ok |
| More models drawer (Use for dictation / Use for meetings, per route) | same two speech-lane pairs | closed | `more-models-drawer.tsx` | The rest of the catalogue. | NO-EXPLANATION — the "Cloud engines" group said you bring a key but not that the service bills you. |
| Disk footprint (read-only) | none | n/a | `model-footprint.tsx` | Measured from the files. | ok |

## 3. Settings → Transcription

| Control | Key | Default | What it does | Was |
|---|---|---|---|---|
| Engine status readouts (read-only) | `useSharedAsrSelection`, `dictationProvider`, `meetingProvider` | shared | Names the engine each lane will hit. | AMBIGUOUS — labelled "Shared route" / "Dictation route" / "Meeting route". |
| Whole-app microphone | `audio.preferredInputDevice` | System default | The mic used unless an override below is on. | ok |
| Use a different microphone for dictation | `audio.dictationInputOverrideEnabled` | off | Turns on the dictation-only mic picker. | ok |
| Dictation microphone override | `audio.dictationInputDevice` | none | The mic used for dictation. | ok |
| Use a different microphone for meetings | `audio.meetingInputOverrideEnabled` | off | Turns on the meetings-only mic picker. | ok |
| Meeting microphone override | `audio.meetingInputDevice` | none | The mic used for meetings. | ok |
| Run the test (system audio) | none | n/a | Asks macOS for permission, then verifies real sound arrived. | ok |
| Separate speakers | `enableDiarization` | **on** | After a recording is transcribed, splits the text by who spoke. Needs a ~25 MB download. | ok |
| Speaker separation model | `diarizationModelId` | `ecapa_tdnn_speaker` | Which embedding model does the splitting. | NO-EXPLANATION — did not say that changing it invalidates every remembered voice. |
| Transcription language | `language` | Auto-detect | The language both dictation and meetings assume. | NO-EXPLANATION, AMBIGUOUS — did not say it covers meetings too, nor how it interacts with the chip list directly beneath it. |
| Languages you dictate in (chips) | `dictationActiveLanguages` | none picked | Narrows what auto-detect chooses from, for dictation only. | ok |
| How the dictation shortcut works | `dictationPushToTalk`, `dictationHandsFreeEnabled` | Press to start, press again to stop | What the hotkey does physically. | ok |
| Smart Format | `dictationAiFormatting` | **off** | Sends each dictation to the AI service before it is inserted. | ok |
| Translate to English | `dictationTranslateToEnglish` | off | Translates the built-in profiles' output. | ok |
| Spoken commands | `dictationCommandModeEnabled` | on | Acts on "command …" instead of typing it. | ok |
| The word that starts a spoken command | `dictationCommandPrefix` | `command` | The trigger word. | NO-EXPLANATION |
| Snippets | `dictationSnippetsEnabled` | on | Expands saved abbreviations. | ok |
| Learn from corrections you make in Plainsong | `dictationAutoLearnCorrections` | on | Remembers fixes you make in Plainsong's own history. | ok |
| Learn from corrections you make in other apps | `dictationLearnFromExternalCorrections` | off | Re-reads the field it just typed into for 8 seconds. | ok (already the longest and most careful description in the app) |
| Your own Smart Format instructions | `dictationCustomPrompt` | empty | Replaces the built-in cleanup prompt. | ok |
| Your own meeting summary instructions | `meetingCustomPrompt` | empty | Replaces the built-in summary prompt. | ok |
| Name meetings for me | `meetingAutoNameEnabled` | **on** | Sends the finished transcript to an AI service for a title. | NO-EXPLANATION — did not say the transcript goes to the summary service. |
| Model used for those titles | `meetingAutoNameModel` | empty (uses the summary model) | Overrides the AI model for titles only. | NO-EXPLANATION (placeholder only) |
| Also copy dictated text to the clipboard | `dictationCopyToClipboard` | off | Leaves the result on the clipboard. | ok |
| Skip silence | `silenceSkipEnabled` | off | Drops quiet stretches before transcription. | ok |
| How Plainsong decides you are speaking (Loudness / Silero) | `dictationVadBackend` | `energy_threshold` | Which detector drives auto-stop and hands-free. | ok |
| Microphone test | none | n/a | Level meter and a 3-second playback. | ok |
| ~~Mode (auto / manual)~~ | `platformOptimization.mode` | `auto` | **INERT** — `select_requested_engine` (rust-sidecar/src/asr/manager.rs) only returns a Windows engine, behind `cfg(target_os = "windows")`. On a Mac, manual and auto resolve identically. Removed from the UI; key still loads. |
| ~~Fallback policy~~ | `platformOptimization.fallbackPolicy` | `local_only` | **INERT** — normalized on load in `settings_values.rs` and read by nothing else in the sidecar. Removed from the UI; key still loads. |
| ~~Allow MLX acceleration routes~~ | `platformOptimization.macos.mlxEnabled` | `true` | **INERT** — `effective_provider_selection` explicitly discards `optimization` and `mlx_enabled`; the MLX Audio route was deleted. Removed from the UI; key still loads. |
| ~~Windows Foundry Local~~ | `platformOptimization.windows.foundryEnabled` | `false` | **INERT** — Windows is outside the beta (`docs/beta/KNOWN-LIMITATIONS.md`). Removed from the UI; key still loads. |
| ~~Manual engine priority~~ | `platformOptimization.manualEnginePriority` | `[]` | **INERT** — the picker offered exactly two options, one of which was Windows Foundry Local. Removed from the UI; key still loads. |
| Repair local cache | none | n/a | Deletes invalid local ASR artifacts and re-probes. | ok |
| Benchmark (upload a WAV) | none | n/a | Compares engines on one file. | ok |

## 4. Settings → General

| Control | Key | Default | What it does | Was |
|---|---|---|---|---|
| Theme (Light / Dark / System) | `theme` | System | Which palette the window uses. | NO-EXPLANATION |
| Keep running after close | `ui.minimizeToTray` | on | Closing the window leaves Plainsong in the menu bar. | ok |
| Always on top | `ui.alwaysOnTop` | off | Window floats above other apps. | ok |
| Suggest meetings from your calendar | local preference, not `Settings` | on once granted | Shows the next meeting at the top of Meetings. | section had a heading with no description |
| Calendars to read (per calendar) | local preference | all on | Which calendars are consulted. | ok |
| While dictating (mini window) | `ui.showDictationPopup` | on | Floating window during a dictation. | NO-EXPLANATION |
| While recording a meeting (mini window) | `ui.showRecordingPopup` | on | Floating window during a meeting. | NO-EXPLANATION |
| Meeting events (notification) | `notifications.meetingEvents` | on | macOS notifications for meeting lifecycle. | ok |
| Dictation problems while the mini window is hidden | `notifications.dictationFailures` | on | macOS notification for a refused or failed insert. | ok |
| Offer to record a call it notices | `meetings.callDetectionEnabled` | **on** | Polls running apps every few seconds. | ok (already discloses the polling and that it is local) |
| Keep the speakers a cloud service sends back | `meetings.preferProviderDiarization` | **on** | Uses the transcription service's own speaker labels. | AMBIGUOUS ("cloud provider") |
| Stop the meeting when the call app quits | `meetings.autoStopWhenCallAppQuits` | on | Ends a detected-call meeting with the app. | ok |
| Stop the meeting after minutes of silence | `meetings.autoStopAfterSilenceMinutes` | 15 | Ends and saves a silent meeting. | ok |
| Remember voices | `meetings.rememberVoices` | off | Stores a numeric voice signature per named speaker. | ok |
| Apply a confident match without asking | `meetings.autoApplyConfidentVoices` | off | Puts a remembered name on straight away. | ok |
| Forget / Delete all (remembered voices) | n/a | n/a | Deletes stored signatures. | ok |
| Allow the plainsong command and MCP server | `automation.localToolsEnabled` | off | Lets apps on this Mac read your meetings and dictations read-only. | AMBIGUOUS ("local tools") |
| Install command-line tool | none | n/a | Writes `/usr/local/bin/plainsong`. | ok |
| Dictation bindings (trigger / action / behaviour, per row) | `shortcuts.dictationBindings` | one primary binding | What starts, cycles or cancels dictation. | AMBIGUOUS — options said "profile", the section text said "mode". |
| Paste last result / Copy last result / Open window | `shortcuts.*` | see defaults | Recovery and window shortcuts. | ok |

## 5. Settings → Privacy & Security

| Control | Key | Default | What it does | Was |
|---|---|---|---|---|
| Recordings on disk (read-only chip) | derived from `securityStatus` | n/a | How many stored recordings are encrypted. | ok |
| Use cloud AI for summaries and answers | `privacy.remoteProcessingEnabled` | off | Gate for every non-Ollama AI service. | LOOK-ALIKE — an identical switch with a *different* description also stood on AI & Keys. |
| Ask macOS for permission when needed | `dictationAutoRequestPermissions` | on | Prompts for mic (and Speech Recognition on the Apple route). | ok |
| macOS permission rows + Open System Settings | none | n/a | Live permission state. | owned by lane U1 — untouched |
| Diagnostics / support bundle | none | n/a | Redacted log bundle. | ok |
| Vault password + Unlock / Lock / Encrypt what is on disk now | `privacy.vaultInitialized`, `privacy.vaultSalt` | not set up | Encrypts recordings already on disk. | NO-EXPLANATION on the buttons; "Migrate to Encrypted Storage" was title case jargon. |

## 6. Settings → Storage

| Control | Key | Default | What it does | Was |
|---|---|---|---|---|
| Approved export folder | `privacy.exportLocationId/Label/Approved` | standard folders | Where exports may be written. | ok |
| Auto-delete dictation recordings | `dictationRetentionPreset` | Never | **Deletes the whole dictation** — its text in History and any audio kept for it — once it is older than the preset. `enforce_dictation_retention_policy` calls `delete_recording`, not an audio-only delete. | NO-EXPLANATION + LOOK-ALIKE — the identical control also stands in Dictation, and neither said the text goes too. Both copies now say what is deleted and that they are the same setting. |
| Custom retention hours | `dictationRetentionCustomHours` | 24 | The custom cutoff. | NO-EXPLANATION |
| Meeting audio | `meetingAudioStorageMode` | Keep it | Whether the meeting's audio file survives transcription. | NO-EXPLANATION |
| Auto-delete meeting data | `meetingRetentionPreset` | Never | Age at which a meeting is cleaned up. | NO-EXPLANATION |
| Custom retention months | `meetingRetentionCustomMonths` | 1 | The custom cutoff. | NO-EXPLANATION |
| When a meeting is auto-deleted, remove | `meetingRetentionDeleteMode` | The audio only | Whether the transcript goes with the audio. | NO-EXPLANATION |
| Open Setup / Rerun onboarding / Fix dictation setup / Set up meetings | none | n/a | Re-runs the guided flows. | mis-grouped under Storage; left in place — lane U1 owns onboarding entry points (see §8) |
| Reset everything on this device | none | n/a | Deletes recordings, transcripts, projects, keys. | ok |
| Backups to keep on this Mac | `backupConfig.maxBackups` | 7 | Rolling count. | ok |
| Backup folder | `backupConfig.backupLocation*` | none | Where a backup is written. | NO-EXPLANATION |
| Allow uploading to cloud storage | `backupConfig.cloudSync` | off | Enables the Sync buttons. Uploads are still manual. | ok |
| Cloud storage service | `backupConfig.cloudProvider` | none | OneDrive / Google Drive / Proton Drive / iCloud. | NO-EXPLANATION |
| Cloud folder | `backupConfig.cloudFolder` | `PlainsongBackups` | Folder name at the destination. | NO-EXPLANATION |
| rclone remote name | `backupConfig.cloudRemoteName` | none | The rclone remote to use. | NO-EXPLANATION |
| Snapshot settings / Back up everything / Upload… / Restore… | none | n/a | Manual backup actions. | ok |

## 7. Settings → AI & Keys

| Control | Key | Default | What it does | Was |
|---|---|---|---|---|
| Summarize every meeting automatically | `enableAutoAnalysis` | **on** | Every finished transcript goes to the summary service without asking. | ok (this description was already the model for the rest of this pass) |
| Manage prompts | `ai.savedPrompts` | 0 overrides | The "/" prompt library. | ok |
| ~~Use cloud AI for summaries and answers~~ | `privacy.remoteProcessingEnabled` | off | Replaced by a read-only status row and a button to Privacy & Security. | LOOK-ALIKE (merged) |
| Ollama status (read-only) | none | n/a | Whether the daemon answers. | ok |
| API key service | none (UI state) | OpenAI | Which service's key you are editing. Does **not** change which service is used. | ok |
| Key / Save key / Remove key | keychain via `secrets.rs` | none | Stores a key in the macOS keychain. | ok |
| Check your cloud setup | none | n/a | Reports what is missing before a summary can run. | heading was a bare question with no description |
| How search finds a meeting | `memorySearchMode` | `fts` | Word matching (built in) or meaning matching (needs Ollama). | NO-EXPLANATION + AMBIGUOUS — the label was the single word "Method". |
| Ollama model used for meaning matching | `embeddingModel` | `nomic-embed-text` | The embedding model. | ok |
| Rebuild the index | none | n/a | Re-reads every transcript. | ok |

## 8. Settings → Updates

| Control | Key | Default | What it does | Was |
|---|---|---|---|---|
| Check for updates | none | n/a | One network call to the release feed, on your click. | NO-EXPLANATION — the card said "Check for the latest updates to get new features and bug fixes", which is a slogan, and did not say Plainsong never checks on its own. |
| Beta updates | `updates.channel` | `stable` | Which release feed the check reads. | NO-EXPLANATION — "Get early access to new features and improvements" is a promise, not a consequence; the warning line was `text-xs`. |

## 9. Keys stored but read by nothing

Left in the settings file so old files load. No control renders them; none of them is a lie on
screen, because nothing on screen mentions them.

| Key | Where it dies |
|---|---|
| `updates.autoCheck` | Nothing calls `checkForUpdatesInElectron` except the IPC handler behind the button. |
| `transcription.platformOptimization.fallbackPolicy` | Normalized in `settings_values.rs`, read by no decision. |
| `transcription.platformOptimization.macos.mlxEnabled` | `effective_provider_selection` discards it. |
| `transcription.platformOptimization.windows.*` | Behind `cfg(target_os = "windows")`. |

## 10. Left for the user to decide

These are defaults or behaviours the copy now describes honestly, but which this lane was not
allowed to change. Each one is a decision, not a bug report.

1. **`enableDiarization` defaults to on, and the model is a 25 MB download.** A fresh install shows
   "Separate speakers" already switched on with a Download button beside it. The switch is honest
   now, but a default that is on and cannot run until you download something is a strange first
   impression.
2. **`meetingAutoNameEnabled` defaults to on.** Every finished meeting transcript is sent to the
   summary service for a title, including when that service is a cloud one. It is now disclosed at
   the control; whether it should default on is yours.
3. **`meetings.preferProviderDiarization` defaults to on.** Fine today (no local engine returns
   speaker labels) but it means the answer changes silently the day one does.
4. **`platformOptimization.macos.mlxEnabled` defaults to `true`** for a route that does not exist.
   Harmless, but the default reads as a promise in the settings file.
5. **`dictationProfile` is called "Dictation style" in the Dictation view** while `dictationCustomModes`
   are called "profiles" there. Settings renders neither, so this pass could not fix it without
   editing a view outside the lane. Renaming `dictationProfile`'s label to something that is not a
   near-synonym of "profile" is the one vocabulary collision left standing.
6. **The Setup / onboarding buttons live under Storage.** They belong with permissions and models,
   not with retention and backups. Lane U1 owns the onboarding entry points this pass, so they were
   left where they are rather than moved into a file two lanes are editing.
