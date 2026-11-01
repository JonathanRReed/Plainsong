# b24 QA tools

These tools replace the b23 pressure admission refusal, both-HUD probe and UI guard continuation. They preserve b23 tools and receipts. Their source lives in `scripts/qa/candidate-b24-tools/`. Copy this folder to the qualification artifact directory for a candidate run.

The runner launches one owned instance through Chromium's debugging pipe. It creates a disposable profile below the system temporary directory. It never attaches to an existing app, sends global hotkeys, opens an external URL, or changes TCC. Dictation sounds are disabled. Microphone work still requires permissions already granted to the launched executable. Do not answer permission dialogs during QA.

Every launch checks `memory_pressure`, `df -h /`, a 20 GiB disk floor, normal host pressure, and output volume at most 25 and unmuted. The tools produce no synthetic speech or playback. They stop only their spawned app process group. They retain their temporary profiles and receipts for inspection. Remove those owned profiles after collecting evidence.

## Run

Build the renderer, Electron main and sidecar from the revision under test. For a dev run, the app must find its sidecar in `rust-sidecar/target/debug/` or `rust-sidecar/target/release/`. Rust commands must use the supplied build-slot script, `nice -n 10`, four Cargo jobs, and the assigned target directory. A local symlink from `rust-sidecar/target` to that target directory is sufficient. Native helpers must also exist in `dist-native/`.

From this folder:

```sh
python3 -B run.py smoke --app-root /absolute/path/to/nautilus-bot
python3 -B run.py guards --app-root /absolute/path/to/nautilus-bot --seed /absolute/path/to/disposable-profile --recording-id fixture-meeting
python3 -B run.py huds --app-root /absolute/path/to/nautilus-bot --seed /absolute/path/to/disposable-profile
python3 -B run.py pressure --app-root /absolute/path/to/nautilus-bot --seed /absolute/path/to/disposable-profile --operations operations.json
```

The seed must have `config/` and `data/` folders. Use a persistent QA seed, never the live Plainsong profile. The runner clones the seed and changes only the clone. Models and fixtures must already be present. The tools do not download models or accept provider terms.

For a future packaged qualification, add `--app /absolute/path/to/candidate/Plainsong.app`. The runner makes its own bundle copy below the temporary runtime and checks its bundle hash against the supplied candidate. It refuses `/Applications/Plainsong.app`. `context.json` distinguishes dev and packaged proof. Adding this option is not authorization to exercise a packaged candidate in an implementation task restricted to dev builds.

Each command prints its runtime and receipt paths. `result.json` exists only after the probe returns successfully. Probe-specific reports start with `finished: false` and preserve partial evidence when an assertion fails. An exception exits nonzero. No historical passing receipt is reused.

## Pressure

The launcher sets `PLAINSONG_QA_MODE=1`, `PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB=8`, and a unique absolute `PLAINSONG_QA_PRESSURE_FILE`. The sidecar reads that fixed path every 250 ms. Accepted contents are `warning`, `critical` and `normal`. Missing or invalid contents leave the last accepted state unchanged. Write `normal` before ending a failed probe. The driver does this in its cleanup path.

The hook publishes through the same watch channel and subscribers as native dispatch-source pressure. Native and injected levels combine by severity, so injected recovery cannot override host pressure. Without QA mode and the launch-time path, there is no poller. There is no injection IPC command or deep link.

The sidecar writes metadata-only model events beside the control file as `pressure.models.jsonl`. Each successful load has a unique id, lane and process id. The matching unload follows the model or helper's lifetime. No prompt, transcript or model path appears in these events. A missing event is a failed proof, not an unloaded model.

Supply one real operation per lane. For example:

```json
{
  "notes": {"command": "summarize_recording", "args": {"recordingId": "fixture-meeting"}},
  "cleanup": {"command": "reprocess_dictation_text", "args": {"text": "We will ship on Friday.", "modePreset": "email"}},
  "search": {"command": "search_transcripts", "args": {"query": "Friday", "limit": 5}},
  "speaker": {"command": "run_diarization", "args": {"recordingId": "fixture-meeting"}}
}
```

Use the fixture's real command arguments and settings. Notes must select native text, cleanup must select the bundled helper with AI formatting enabled for the requested mode, and semantic search must use a built-in model with indexed fixture content. An operation that takes a fallback route fails the model-load assertion. Do not replace these with mocked state.

For each lane, the probe records the first use, loaded state and owned process-tree footprint, injects warning, waits for release, records footprint again, returns to normal and repeats the operation. New model ids prove later reload. It checks notes and cleanup as idle residents. Search helpers can be owned by one search or indexing job. Speaker sessions are owned by each diarization pass. If they have already dropped before warning, the report labels them `operation`; that proves operation cleanup and later reload, not pressure eviction of a nonexistent idle cache. Footprint files are observations, not a causal memory-saving claim.

## HUDs and guards

The HUD probe waits for both the saved meeting to reach `completed` and its HUD to become terminal. It then starts and stops a silent dictation. It never fabricates lifecycle events or clears pending product state. A failed or stuck transcription blocks the probe with its last observed state.

Three runs each hide the main window for 135 seconds. Each checks that only the two original HUD targets remain, retains six process-tree footprint samples over 30 seconds with one warm speech helper, reopens through the dictation HUD and verifies renderer PID preservation, navigation and bounds. It does not shorten the product's two-minute timeout. Reopen timings include command-file polling and are not launch-performance measurements.

The guard probe checks a project modal, a meeting edit and setup for 135 hidden seconds each. It discovers editable fields within the meeting-notes group rather than assuming a `Goals notes` section. It can open the Summary editor when notes sections are absent. When the seed has no completed meeting, it inserts a text-only fixture into the owned profile database. It verifies the entered marker after reopening. The current recordings-view policy retains all meeting views, so that receipt does not isolate a dirty-edit-only veto. Setup and modal text must also survive in the same main target.

## Local checks

```sh
python3 -B test_drivers.py
```

From the app root, run `bun run typecheck`, the focused `b24-qa-drivers`, IPC and deep-link tests, then `bun run test`. Never use `bun test`.
