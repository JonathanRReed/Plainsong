# Settings inventory, 2026-10-22

Every control on the Settings surface, where it lives after the October 2026 reorganization, the
settings key behind it, its default, and whether it shows straight away or sits behind a "More
options" disclosure. It replaces the 2026-09-03 inventory, which described the old seven tabs.

The source of truth is code, not this page:

- `src/components/settings/settings-sections.ts`: section order, section summaries, and
  `SETTINGS_INDEX`, the list settings search reads.
- `src/components/views/settings-view-simple.tsx`: the sections themselves.
- `src/components/models/`: the Models section.
- `src/components/ui/settings-control.tsx`: the row primitives (`SettingsRow`, `SettingsSwitch`,
  `SettingsInput`, `SettingsGroup`, `SettingsMore`).

No settings key or IPC command was renamed or removed. Every control still writes the key it wrote
before.

## Rules the surface keeps

1. **One row shape.** A label, one plain sentence saying what changes for the reader, and the
   control on the right. A switch or select without a described-by sentence fails
   `settings-view-simple.test.tsx` ("gives every switch and select in every section a sentence of
   its own").
2. **Most common first.** Sections run from everyday to rare, and so do the groups and rows inside
   each one. Rows most people never change sit behind a `SettingsMore` disclosure whose hint names
   what is inside, so nobody has to open it to find out.
3. **One control per setting.** A setting has one home. Other places that mention it report its
   state and link there (Search & AI reports cloud AI and sends you to Privacy & data; Advanced
   reports text insertion and sends you to Privacy & data > macOS permissions).
4. **Plain words.** The settled terms are speech model, speaker model, search model, AI cleanup,
   built-in text model, service, profile, binding, voice signature, on this Mac, and command line
   and MCP access (`src/lib/settings-vocabulary.ts`). Engineering words (GPU, CPU, GGUF, ONNX,
   runtime, provider, embedding, headroom, and so on) never reach the screen; the "Settings
   structure" tests open every section and every disclosure and fail on any of them.
5. **Dangerous actions are grouped and confirmed.** Reset asks for the word RESET in a dialog.
   Restoring a settings snapshot asks before it replaces every preference. Allowing cloud AI from
   the cloud check asks first. Encryption and backups sit behind disclosures in Privacy & data.
6. **Every path is true.** Any "Settings > Section > Row" written in the renderer, Electron, the
   sidecar or the user guides names a section and row that exist (`settings-paths.test.ts`).

## Structure

`More` means the row is inside a `SettingsMore` disclosure. Search opens the disclosure and focuses
the row.

### General

Appearance, your microphone and language, and updates.

| Group | Row | Key | Default | Where |
|---|---|---|---|---|
| Appearance and window | Appearance (Light / Dark / System) | `theme` | System | shown |
| | Keep running in the menu bar | `ui.minimizeToTray` | on | shown |
| | Keep the window on top | `ui.alwaysOnTop` | off | shown |
| Microphone and language | Microphone | `audio.preferredInputDevice` | system default | shown |
| | Test your microphone | none | n/a | shown |
| | Use a different microphone for dictation or meetings: Dictation microphone, Meeting microphone | `audio.dictationInputOverrideEnabled`, `audio.dictationInputDevice`, `audio.meetingInputOverrideEnabled`, `audio.meetingInputDevice` | off | More |
| | Language you speak | `transcription.language` | Auto-detect | shown |
| | Languages you dictate in (only while auto-detect is on) | `transcription.dictationActiveLanguages` | none picked | More |
| Updates and setup | Updates (Check for updates) | none | never checks on its own | shown |
| | Beta updates | update channel (`get_update_channel`) | stable | shown |
| | Setup guide (Open Setup, Run setup again) | none | n/a | shown |

### Dictation

What you see and hear while you dictate, and how your words are cleaned up.

| Group | Row | Key | Default | Where |
|---|---|---|---|---|
| While you dictate | Show the dictation pill | `ui.showDictationPopup` | on | shown |
| | Pill size | `ui.dictationPillSize` | Default | shown |
| | Pill position | `ui.dictationPillDock` | Bottom center | shown |
| | Dictation sounds | `ui.dictationSounds` | on | shown |
| | Mute other audio while dictating | `ui.muteMediaWhileDictating` | off | shown |
| | Notify me when a dictation fails | `notifications.dictationFailures` | on | shown |
| Your words | Remove filler words | `transcription.dictationRemoveDisfluencies` | on | shown |
| | AI cleanup | `transcription.dictationAiFormatting` | off | shown |
| | Match surrounding text | `transcription.dictationMatchSurroundingText` | on | shown |
| | Translate to English | `transcription.dictationTranslateToEnglish` | off | shown |
| | Also copy to the clipboard | `transcription.dictationCopyToClipboard` | off | shown |
| | Spoken commands | `transcription.dictationCommandModeEnabled` | off when absent | More |
| | Command word | `transcription.dictationCommandPrefix` | `command` | More |
| | Snippets | `transcription.dictationSnippetsEnabled` | on | More |
| | Suggest corrections from edits in Plainsong | `transcription.dictationAutoLearnCorrections` | on | More |
| | Learn from corrections you make in other apps | `transcription.dictationLearnFromExternalCorrections` | off | More |
| | Your own AI cleanup instructions | `transcription.dictationCustomPrompt` | empty | More |
| Profiles and setup | Word list, snippets and profiles (Open Dictation) | none | n/a | shown |
| | Fix dictation setup | none | n/a | shown |

### Meetings

What gets recorded, how speakers are told apart, and what happens afterwards.

| Group | Row | Key | Default | Where |
|---|---|---|---|---|
| Recording | Mac audio (Allow meeting audio before macOS has asked; Check meeting audio; Open System Settings and Check again when macOS refused) | none | needs your OK | shown |
| | Offer to record a call it notices | `meetings.callDetectionEnabled` | on | shown |
| | Show the meeting window | `ui.showRecordingPopup` | on | shown |
| | Meeting notifications | `notifications.meetingEvents` | on | shown |
| | Set up meetings | none | n/a | shown |
| Calendar | Connect calendar before macOS has asked (Open System Settings when refused); once granted: Suggest meetings from your calendar, Calendars to read | local preference | on once granted | shown |
| Speakers | Tell speakers apart (or Download speaker model) | `transcription.enableDiarization` | on | shown |
| | Speaker model | `transcription.diarizationModelId` | ECAPA-TDNN | shown |
| Remembered voices | Remember voices | `meetings.rememberVoices` | off | shown |
| | Apply a confident match without asking | `meetings.autoApplyConfidentVoices` | off | shown |
| | Stored on this Mac (Forget, Delete all) | none | n/a | shown |
| After a meeting | Summarize every meeting automatically | `transcription.enableAutoAnalysis` | on | shown |
| | Name meetings for me | `transcription.meetingAutoNameEnabled` | on | shown |
| | Stop when the call app quits | `meetings.autoStopWhenCallAppQuits` | on | More |
| | Stop after minutes of silence | `meetings.autoStopAfterSilenceMinutes` | 15 | More |
| | Longest meeting, in minutes | `meetings.maxRecordingMinutes` | 0 (no limit) | More |
| | Keep speaker labels from cloud services | `meetings.preferProviderDiarization` | on | More |
| | AI model for meeting titles | `transcription.meetingAutoNameModel` | empty (the summary model) | More |
| | Your own summary instructions | `transcription.meetingCustomPrompt` | empty | More |

### Models

The speech model that hears you and the AI that writes for you. Rendered by `ModelsScreen`.

| Group | Row | Key | Default | Where |
|---|---|---|---|---|
| (banner) | Your speech model / AI model needs attention | none | only when something is wrong | shown |
| What each task uses | Speech for dictation (list of models, Download) | `transcription.dictationProvider`, `dictationModelId` | Parakeet v3 | shown |
| | Live preview model (experimental, Download / Delete) | file on disk | not downloaded | shown |
| | Which meeting models to list first | `transcription.meetingRoutePolicy` | prefer this Mac | shown |
| | Speech for meetings | `transcription.meetingProvider`, `meetingModelId` | Parakeet v3 | shown |
| | ChatGPT account | none (account store) | not loaded | shown |
| | Who cleans up dictation, and its model | `privacy.dictationAi` | built-in cleanup model (`bundled_local`) | shown |
| | Who writes summaries, answers, and actions, and its model | `privacy.meetingsAi` | built-in text model (`native_text`) where it ships accelerated, otherwise Ollama | shown |
| | Built-in text model, Apple on-device model, Ollama models | files on disk | not downloaded | shown with the lane that uses them |
| Start from a preset | Recommended / Light / Widest languages / Whisper Turbo + Distil-Whisper | both speech lanes at once | Recommended | More |
| Experimental models and cloud services | the rest of the catalogue | both speech lanes | closed | drawer |
| Disk | what is downloaded | none | n/a | shown |

### Shortcuts

Keys and mouse buttons that work in any app. Click a shortcut and press the new keys; it saves
right away.

| Group | Row | Key | Default | Where |
|---|---|---|---|---|
| Starting and stopping | How the dictation shortcut works | `transcription.dictationPushToTalk`, `dictationHandsFreeEnabled` | Press to start, press again to stop | shown |
| | Double-tap to lock, Tap to lock (only in hold mode) | `transcription.dictationDoubleTapToLock`, `dictationTapToLock` | off, on | shown when hold is in use |
| Dictation shortcuts | one row per binding: trigger, action, behaviour, Press Return after inserting | `shortcuts.dictationBindings` (and `toggleDictation`) | one binding, Cmd-Shift-Space | shown |
| Other shortcuts | Paste last result, Copy last result, Open window | `shortcuts.repasteLastDictation`, `recopyLastDictation`, `openWindow` | see defaults | shown |

### Search & AI

API keys, saved prompts, and how search finds a recording.

| Group | Row | Key | Default | Where |
|---|---|---|---|---|
| AI services | Who writes for you (Open Models) | reports `privacy.*Ai` | n/a | shown |
| | Cloud AI is off / allowed (Open Privacy & data) | reports `privacy.remoteProcessingEnabled` | off | shown |
| | Ollama status (only when a lane uses Ollama) | none | n/a | shown |
| | Saved prompts (Manage prompts) | `ai.savedPrompts` | built-in set | shown |
| API keys | Service, Key, Save key, Remove key | macOS keychain | none | shown |
| | Check cloud setup (Check, Allow it, with confirmation) | none | n/a | More |
| Search | How search finds a recording | `transcription.memorySearchMode` | Match the words you type | shown |
| | Search model / Ollama model used for meaning matching | `transcription.builtinEmbeddingModel`, `embeddingModel` | built-in default | shown when meaning matching is chosen |

### Privacy & data

What may leave this Mac, what macOS allows, and what Plainsong keeps.

| Group | Row | Key | Default | Where |
|---|---|---|---|---|
| Cloud | Allow cloud AI processing | `privacy.remoteProcessingEnabled` | off | shown |
| macOS permissions | Ask macOS for permission when needed | `transcription.dictationAutoRequestPermissions` | on | shown |
| | Microphone, Speech recognition (optional: only Apple Speech), Accessibility, Typing when paste is blocked | none | n/a | shown |
| | Check again, Ask for the missing ones, Repair text insertion | none | n/a | shown |
| Keep and delete | Auto-delete dictations (and custom hours) | `transcription.dictationRetentionPreset`, `dictationRetentionCustomHours` | Never | shown |
| | Meeting audio | `transcription.meetingAudioStorageMode` | Keep it | shown |
| | Auto-delete meetings (and custom months) | `transcription.meetingRetentionPreset`, `meetingRetentionCustomMonths` | Never | shown |
| | What auto-delete removes | `transcription.meetingRetentionDeleteMode` | The audio only | shown |
| Files | Export folder | `privacy.exportLocationId/Label/Approved` | standard folders | shown |
| | Backups: full backup, settings snapshot (restore asks first), backups to keep, backup folder, cloud upload, service, folder, rclone remote, checks | backup config (`save_backup_config`) | uploads off, 7 kept | More |
| | Encryption: recordings on disk, vault password, unlock, lock, encrypt what is on disk now | `privacy.vaultInitialized`, `privacy.vaultSalt` | not set up | More |
| Start over | Reset Plainsong (dialog asks for RESET) | none | n/a | shown |

### Advanced

Diagnostics and tools for when something needs a closer look.

| Group | Row | Key | Default | Where |
|---|---|---|---|---|
| Speech model status | each task's speech model and whether it is ready | reports | n/a | shown |
| | Apple Speech setup (only when Apple Speech is chosen) | none | n/a | shown |
| | Typing into other apps (Check again, Fix in Privacy & data) | reports | n/a | shown |
| Repair and compare | Repair speech models: Repair, then every speech model's status | none | n/a | More |
| | Compare speech models: choose a WAV clip, Compare, earlier comparisons | none | n/a | More |
| Speech detection | Skip silence | `transcription.silenceSkipEnabled` | off | shown |
| | How Plainsong hears you start talking (Loudness / Voice detection model) | `transcription.dictationVadBackend` | Loudness | shown when hands-free or auto-stop is in use |
| Command line and MCP access | Allow the plainsong command and MCP server | `automation.localToolsEnabled` | off | shown |
| | Command-line tool (Install) | none | not installed | shown |
| | AI assistants (`plainsong mcp`) | none | n/a | shown |
| Diagnostics bundle | Show what is included, Create support bundle | none | n/a | shown |

## What moved where

| Before (tab) | Control | Now |
|---|---|---|
| General | Theme, Keep running after close, Always on top | General > Appearance and window |
| General | Calendar | Meetings > Calendar |
| General | Mini windows (While dictating, While recording a meeting) | Dictation > Show the dictation pill; Meetings > Show the meeting window |
| General | Dictation pill size and position, sounds | Dictation > While you dictate |
| General | Notifications (meeting events, dictation problems) | Meetings > Meeting notifications; Dictation > Notify me when a dictation fails |
| General | Call detection, auto-stop, longest meeting, cloud speaker labels | Meetings > Recording and Meetings > After a meeting (More) |
| General | Remembered voices | Meetings > Remembered voices |
| General | Command line and MCP access | Advanced |
| General | Keyboard shortcuts and dictation bindings | Shortcuts |
| General / Storage | Setup, Fix dictation setup, Set up meetings | General > Setup guide; Dictation > Fix dictation setup; Meetings > Set up meetings |
| Transcription | Microphones, microphone test, language | General > Microphone and language |
| Transcription | Mute other audio, cleanup switches, spoken commands, snippets, corrections, instructions | Dictation |
| Transcription | Recording what your Mac plays | Meetings > Mac audio |
| Transcription | Speakers, speaker model | Meetings > Speakers |
| Transcription | Meeting titles, summary instructions | Meetings > After a meeting (More) |
| Transcription | Skip silence, Loudness / Silero | Advanced > Speech detection |
| Transcription | Speech model status, repair tools, benchmark | Advanced > Speech model status, Repair and compare |
| AI & Keys | Automatic summaries | Meetings > After a meeting |
| AI & Keys | API keys, cloud check, saved prompts, search | Search & AI |
| Privacy & Security | Cloud AI switch, permissions | Privacy & data |
| Privacy & Security | Vault | Privacy & data > Files > Encryption (More) |
| Privacy & Security | Diagnostics bundle | Advanced |
| Storage | Export folder, auto-delete, backups, reset | Privacy & data |
| Updates | Update check, beta channel | General > Updates and setup |
| Models | Presets above the task lanes | Models > Start from a preset, below the lanes (More) |

Old section ids (`asr`, `security`, `storage`, `updates`) still resolve in `requestSettingsTab`, and
each lands on the row it used to open (`src/lib/navigation.ts`).

## Removed or merged

- "Open Memory" and "Open Meetings" buttons on the old AI & Keys tab: both opened views the sidebar
  already lists.
- The duplicate "Repair insert permissions" and "Open Accessibility" buttons in the speech model
  diagnostics: Privacy & data > macOS permissions has them; the diagnostics row links there.
- The static "Provider Status" card under Benchmark: hard-coded engine descriptions that no longer
  matched the shipped engines.
- Status / Benchmark tabs inside the diagnostics card: now two disclosures in one group.

## Keys with no control

These still load and normalize; nothing on screen writes them, because on a macOS build they cannot
change anything (see `asr-provider-manager.tsx` and `rust-sidecar/src/asr/manager.rs`):
`platformOptimization.mode`, `platformOptimization.fallbackPolicy`,
`platformOptimization.macos.mlxEnabled`, `platformOptimization.windows.foundryEnabled`,
`platformOptimization.manualEnginePriority`.

## Tests that hold this in place

- `src/__tests__/settings-view-simple.test.tsx`, "Settings structure": eight sections in order,
  each under its own heading with level-3 group headings; every non-conditional
  `SETTINGS_INDEX` row has its anchor; search lands on a row inside a closed disclosure and opens
  it; no engineering words anywhere, disclosures open.
- The same file, "Settings copy clarity": every switch and select in every section has a
  described-by sentence; the cloud-AI switch exists once.
- `src/__tests__/settings-paths.test.ts`: every "Settings > Section > Row" in `src`, `electron`,
  `rust-sidecar/src` and the user guides names a real section and row; every `requestSettingsTab`
  call names a real section and row.
- `src/__tests__/settings-vocabulary.test.ts`: one word per concept, no retired words.
