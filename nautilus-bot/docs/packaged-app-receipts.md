# Capture evidence for one packaged app

Capture the full app identity before a workflow and check it again afterward.
A timestamp or a hash of selected helpers cannot identify the tested bundle.
Changed or identity-free receipts do not qualify a release. Recapture the
workflow instead of adding a new hash to old observations.

Run these commands from the app checkout. Use the exact isolated candidate,
with its current native build and static package checks already passed.
Obtain resource admission before capture or model work. Physical permission
and destination-app checks need an available operator.

The app-matrix preflight defaults to `release/mac-arm64/Plainsong.app`.
Override it for an isolated candidate:

```sh
bun run qa:packaged:macos:app-matrix:preflight -- --candidate-app "$PLAINSONG_QA_APP"
bun run qa:support-bundle -- --app "$PLAINSONG_QA_APP"
```

Support capture without `--app` can still produce a content-free support
bundle. It cannot serve as exact-app release evidence.

## Measure the memory footprint

`qa:packaged:macos:footprint` measures what the candidate costs a smaller Mac.
It needs no operator, but it needs a virtual input for its spoken fixtures
(BlackHole 2ch by default, `--fixture-device` to change it) and the same
microphone and system audio permissions as the meeting receipts.

```sh
bun run qa:packaged:macos:footprint -- --app "$PLAINSONG_QA_APP" --simulate-gb 8
bun run qa:packaged:macos:footprint -- --app "$PLAINSONG_QA_APP" --simulate-gb 16
```

A development Mac has far more free memory than an 8 GB Mac beside a call
app, a browser and chat. `--simulate-available-gb <GB>` (with
`--simulate-gb`) makes the sidecar's admission plan as if the other apps left
that much free when it started, less whatever Plainsong loads since
(`PLAINSONG_SIMULATE_AVAILABLE_GB`, honoured only in QA mode and only beside
the physical simulation). Memory pressure is still this Mac's own. The
receipt (`footprint-<GB>gb-available-<GB>gb.json`) records the figure; such a
stress run shows what Plainsong defers or refuses, and never qualifies a
release in place of the standard run.

The receipt (`artifacts/qa/macos/footprint-<GB>gb.json` and `.md`) gives each
state's peak and mean against its budget, the per-process breakdown at the
peak, the reopen time from the menu bar, and a once-a-second timeline. Short-lived
search helpers also capture the whole app process tree before exit, so a helper
cannot disappear between sampler ticks. States:

| State | Budget | What runs |
|---|---|---|
| `idle` | idle | Window open, 60 s after launch settled |
| `idle-hidden` | idle | Window closed to the menu bar |
| `dictation` | dictation | Two dictations from the menu bar, kept in Plainsong |
| `meeting` | meeting | Two minutes of Me + Them capture with live transcript |
| `post-call` | notes, or meeting when no selected local notes model is installed | Final transcript, speakers, notes, until the sidecar is quiet |

The profile is cloned from the operator's settings and models, so it measures
the routes that operator chose; the receipt names them. Remote processing is
turned off in the clone. The gate checks the selected built-in or local
Ollama notes model and enables automatic notes in the clone when that model is
installed. If it is missing or Ollama is unavailable, the receipt records a skip.
A failed notes job fails the exercised-state check. Notes served by an external
Ollama process cannot qualify the notes budget because that process is outside
the candidate process tree. `--app-arg` adds an app switch for experiments and
marks the receipt as an experiment. Shortened workloads, route overrides,
notes overrides and mic-only capture also cannot qualify a release. A missing
measurement for a still-running process fails the gate. The sidecar must receive
the simulated memory setting, and the meeting must emit live speech before stop.

Use `--attribution <json>` to include measured component attribution. Each row
contains `component`, `measurement`, `evidence` and `owner`. Keep earlier-build
attribution separate from this candidate's process peaks. Use `--capture-frames`
in a separate inspection run to save workspace and overlay PNGs. Frame capture marks the run as an experiment, keeping screenshot
allocations out of qualifying memory measurements. The release audit requires
both the 8 GB and 16 GB receipts to pass for the exact candidate.

On macOS, built-in search runs each token-window or embedding batch in a private
sidecar helper. Text travels over local pipes. The parent holds its operation
lease until the helper exits, and the helper stops if its parent exits. Exiting
reclaims native allocator pages that remained resident after dropping a session
in the capture process. Other platforms retain the in-process runtime.

## Record real-device meeting observations

Choose a new session directory. Keep its start record unchanged. The commands
below inspect files and write QA records; they do not launch the app or grant
permissions.

```sh
export PLAINSONG_QA_APP="$PWD/release/mac-arm64/Plainsong.app"
export PLAINSONG_QA_SESSION="$PWD/artifacts/qa/macos/meeting-session-01"
bun run - <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { captureAppReceiptBinding } from './scripts/lib/app-receipt-binding.ts';
import { collectReleaseCandidateIdentity } from './scripts/lib/release-candidate-identity.ts';
import { REQUIRED_REAL_DEVICE_MEETING_SCENARIOS } from './scripts/capture-packaged-macos-meeting-lifecycle.ts';

const app = process.env.PLAINSONG_QA_APP;
const session = process.env.PLAINSONG_QA_SESSION;
assert(app && session);
const binding = captureAppReceiptBinding(app);
const identity = collectReleaseCandidateIdentity({ candidatePath: path.dirname(path.dirname(app)), appPath: app });
assert(binding.appBundleSha256 && identity.appBundle?.sha256 === binding.appBundleSha256);
const components = Object.fromEntries(identity.appComponents.map(entry => [entry.name, entry.sha256]));
const candidateComponents = {
  appAsar: components['Contents/Resources/app.asar'],
  sidecar: components['Contents/Resources/sidecar/plainsong-sidecar'],
  shortcutHelper: components['Contents/Resources/shortcut-helper/plainsong-native-shortcut-helper'],
  speechHelper: components['Contents/Resources/sidecar/nautilus-macos-speech-helper-aarch64-apple-darwin'],
};
assert(Object.values(candidateComponents).every(value => /^[a-f0-9]{64}$/.test(value ?? '')));
fs.mkdirSync(path.dirname(session), { recursive: true });
fs.mkdirSync(session);
fs.writeFileSync(path.join(session, 'start.json'), JSON.stringify({
  startedAt: new Date().toISOString(), binding, candidateComponents,
  candidateIdentityTarget: 'packaged-app-components',
  candidateAppSha256: candidateComponents.appAsar,
}, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
fs.writeFileSync(path.join(session, 'observations.json'), JSON.stringify({
  observations: Object.fromEntries(REQUIRED_REAL_DEVICE_MEETING_SCENARIOS.map(name => [name, {
    pass: false, observedAt: null, notes: '',
  }])),
  evidence: { processingQuitRecovery: {
    statusBeforeQuit: '', recoveredStatus: '', audioBytes: null,
    reconciliationPreviousStatus: '', retranscribeStatus: '', finalStatus: '', transcriptChars: null,
  } },
}, null, 2) + '\n', { flag: 'wx' });
console.log(session);
JS
```

Exercise the nine named real-device scenarios on that app. Edit only
`observations.json`. For each scenario, record its actual ISO timestamp,
pass or failure, and specific readback evidence. Fill processing recovery
fields from the saved recording and recovery result. Use public fixture
content. Do not copy observations from another run or edit `start.json`.

After the observations, finalize the receipt. A changed app or incomplete
observation produces a failed receipt. The command refuses to overwrite an
existing final receipt.

```sh
bun run - <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bindAppReceipt } from './scripts/lib/app-receipt-binding.ts';
import { evaluateMeetingLifecycleEvidence, REQUIRED_REAL_DEVICE_MEETING_SCENARIOS } from './scripts/capture-packaged-macos-meeting-lifecycle.ts';

const session = process.env.PLAINSONG_QA_SESSION;
assert(session);
const start = JSON.parse(fs.readFileSync(path.join(session, 'start.json'), 'utf8'));
const draft = JSON.parse(fs.readFileSync(path.join(session, 'observations.json'), 'utf8'));
const now = Date.now();
const started = Date.parse(start.startedAt);
assert(Number.isFinite(started));
const observed = REQUIRED_REAL_DEVICE_MEETING_SCENARIOS.every(name => {
  const observation = draft.observations?.[name];
  const timestamp = Date.parse(observation?.observedAt);
  return observation?.pass === true && Number.isFinite(timestamp) && timestamp >= started && timestamp <= now &&
    typeof observation.notes === 'string' && observation.notes.trim().length >= 12;
});
const receipt = bindAppReceipt({
  ...draft, candidateIdentityTarget: start.candidateIdentityTarget,
  candidateAppSha256: start.candidateAppSha256, candidateComponents: start.candidateComponents,
  generatedAt: new Date(now).toISOString(), pass: observed,
}, start.binding);
const evaluated = evaluateMeetingLifecycleEvidence({
  candidateAppBundleSha256: start.binding.appBundleSha256, candidateReleaseSha256: null,
  candidateAppSha256: start.candidateAppSha256, candidateComponents: start.candidateComponents,
  realDevice: receipt,
});
receipt.pass &&= evaluated.checks.filter(check => check.mode === 'real_device').every(check => check.pass);
const output = path.join(session, 'meeting-lifecycle-real-device.json');
fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, pass: receipt.pass, candidateAppUnchanged: receipt.candidateAppUnchanged }));
process.exitCode = receipt.pass ? 0 : 1;
JS
```

Generate the microphone, combined-capture and soak receipts for this same
candidate and session directory using their existing capture commands.
The soak must also match the final release identity. Then run:

```sh
bun run qa:packaged:macos:meeting:lifecycle -- --app "$PLAINSONG_QA_APP" --qa-dir "$PLAINSONG_QA_SESSION"
```

The aggregate still requires all automated and real-device checks. A completed
form or matching hash alone is not evidence that the workflows passed.

## Install staged model artifacts into a QA profile

The `models-2026-10` GitHub prerelease now carries the pyannote community-1,
Fluid Speech Mini and Underdog Bark 3.0 Pro assets. The app can download them
from Plainsong's release. They remain prerelease assets until launch.
Publication status was supplied by the maintainer on October 22, 2026;
this offline source review did not recheck GitHub.

For offline QA, copy the staged artifacts into an isolated profile:

```sh
export PLAINSONG_QA_DATA="$(mktemp -d)/plainsong-qa"
bun scripts/install-staged-models.ts --data-dir "$PLAINSONG_QA_DATA" --dry-run
bun scripts/install-staged-models.ts --data-dir "$PLAINSONG_QA_DATA"
```

`--data-dir` is required and is the value to pass as `PLAINSONG_DATA_DIR`. The
app adds `Plainsong/models` to it, so the files land in
`Plainsong/models/diarization/pyannote-community-1/` and
`Plainsong/models/transcribe_cpp/`, as the download code would place them. The
script refuses any path inside `~/Library/Application Support`.
`--staging-dir` overrides the default staging folder,
`artifacts/continuation-2026-10-20/models-release-staging/` in the main
checkout.

The script reads each file name and SHA-256 from
`rust-sidecar/src/download/mod.rs` and `rust-sidecar/src/asr/transcribe_cpp.rs`.
It checks every staged file before writing anything, then copies with APFS
clones (`cp -c`). If a clone fails, it prints a warning and makes an ordinary
copy. It hashes each file again at its destination. A missing pin or a
mismatched file stops the run. Running it again verifies files already present
and skips them.

The script records nothing about verification, and neither does the app.
The models report as installed as soon as their files are present. Each
sidecar run hashes a file against its pin the first time it loads it, and a
low-priority background pass checks the active dictation and meeting speech
models shortly after launch. A file that fails its check then reports as not
installed.

Point the sidecar or the app at the profile with `PLAINSONG_DATA_DIR` set to
the same absolute path. Also set `PLAINSONG_CONFIG_DIR` to a sibling temporary
directory so settings stay isolated. A relative path is ignored and the sidecar
reports that it could not find a data directory. The packaged app forwards
both variables to its sidecar only when `PLAINSONG_QA_MODE=1`. Ephemeral QA
credentials (`PLAINSONG_QA_EPHEMERAL_SECRETS=1`) also require both directories
to exist beneath `$TMPDIR`, which `mktemp -d` satisfies and `/tmp` does not.
