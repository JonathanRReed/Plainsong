# Local notes verification, 2026-10-23

All 18 native fixture, size and RAM cases completed during October 23 and 24,
2026. Selection, process exit, footprint and admission-profile checks passed.
These results qualify the local sidecar and helper cases described below.
Whole-app memory and a delivered package remain separate gates.

## Runtime

Built-in notes and S1-mini cleanup use `plainsong-text-helper`, a separate
llama.cpp process. The binding is pinned in
`rust-sidecar/text-helper/Cargo.lock`. The helper receives the verified model
file descriptor and uses quantized weights, a quantized cache, and a context
sized for each request. Notes use batches of 256 tokens.

Light uses Qwen3 1.7B with a 6,144-token window. Balanced uses Qwen3 4B Instruct
2507 with 8,192 tokens. Best uses the same 4B weights with 16,384 tokens. The
hardware tier selects the recommendation. A saved model choice takes priority.

Structured native notes use top-k 20, top-p 0.8 and temperature 0.7, with
seed 42 for replay. Cleanup keeps greedy decoding. These are the non-thinking
parameters recommended by the pinned [1.7B model card](https://huggingface.co/Qwen/Qwen3-1.7B/blob/70d244cc86ccca08cf5af4e1e306ecf908b1ad5e/README.md)
and [4B model card](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/blob/cdbee75f17c01a7cc42f958dc650907174af0554/README.md).

Memory reservations include the model's resident pages, fixed overhead, and a
context allowance. Reservations are distinct from `phys_footprint` and the
whole-app budget. The profiles were fitted to earlier direct-helper RSS
measurements. All 18 admitted fixture runs stayed within their selected RSS
claim. The table below
keeps those claims distinct from footprint measurements.

Long meetings use the grounded map and reduce path. Chunks preserve complete
speaker turns when a turn fits the window. Longer turns split without dropping
source rows. Later chunks receive bounded context from earlier evidence.
Deterministic source quotes retain decisions, actions, names, numbers, dates,
and timestamps. The final check marks unsupported details for review and keeps
the transcript available.

When a local model reaches its output allowance, unfinished text is discarded.
Mapping resumes from smaller source groups while keeping completed rows. Final
action groups split without separating a fact from its sources. Complete action
responses retain their owners, dates and citations. Identical task text with
different source identities stays separate. The configured output allowance
stays fixed.

A direct default recap or action request that reaches its output limit moves
to evidence processing. This keeps the output allowance fixed. A final recap
can split into complete parts around intact facts. Each part keeps its source
scope and model identity. Invalid JSON, empty parts, unfinished article
phrases and mixed-model results are refused. Failed citation checks retain a
review flag when the complete parts are joined. Custom recap prompts and
external providers retain their existing behavior.

Apple Intelligence is an optional notes provider when its availability probe
succeeds. The helper uses structured responses and the runtime context size
when the SDK exposes that API. Older SDKs use a conservative 4,096-token
fallback. The SDK check preserves builds without Foundation Models.
[Apple's context-size API](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/contextsize)
describes the reported window.

The Apple helper checks `GeneratedContent.isComplete` before using either
structured or plain responses. A native SDK fixture reproduced incomplete
content serializing into valid JSON. The helper now reports `output_limit`
instead of forwarding that content. This allows bounded input recovery.
[Apple's response-token limit documentation](https://developer.apple.com/documentation/foundationmodels/generationoptions/maximumresponsetokens)
explains that the limit can terminate generation without an error. The SDK
fixture test parses content and does not run model generation.

## Measurement method

`scripts/evaluate-local-notes.py` seeds one fictional meeting in an isolated
QA database and starts the real release sidecar. Its temporary data, config,
and scratch directories contain no live profile. The sidecar's QA credential
store stays in memory. The evaluator uses the existing model-download command
to verify locally cloned weights and license files.

Each case calls `retry_meeting_analysis` and times its complete notes pass,
including summary and action items. Fixture setup, model verification, and
process startup are outside that timer. Verification warms the filesystem
cache. A memory wait that later succeeds is included in the elapsed time and
marked in the receipt. The idle memory observation window pauses during
generation, so a later deferred stage gets its own wait window. The overall
observation deadline stays fixed. The receipt records failures separately
from completed jobs. Cases run serially through the build-slot guard and the
app's memory admission.

The evaluator samples the sidecar and its children every 50 ms using Darwin's
`rusage_info_v4`. The helper also reports its lifetime peak through the existing
native-model status command. The sum of helper and sidecar lifetime peaks is a
conservative bound for those two processes. Receipts include source manifests,
binary digests, model selection, simulated RAM, admission, output, and process
exit checks.

Each attempt saves a preparation record and a progress log before generation.
Interrupted attempts remain distinguishable from completed jobs. A new attempt
archives the previous receipt rather than replacing its bytes.

Electron and retained capture models are absent. These measurements cannot
establish the packaged app's total footprint. The coordinator's candidate gate
must include all app processes and their retained allocations.

The queue restart check uses a 3 GB simulation to force admission refusal in a
temporary profile. It then restarts that profile at 8 GB. A canceled wait stays
canceled; manual retry remains available; a saved wait resumes automatically.
This control is separate from the 8 GB and 16 GB model measurements.

Built-in recaps retain missing material source details as attributed verbatim
quotes. Existing warnings about generated text remain. The quality report
separates coverage of generated text from coverage after source details are
added. Custom prompts and scoped questions retain their own content selection.

Scores follow `docs/evals/meeting-notes-fixtures.json`: a retained item matches
at least one `anyOf` term and every `allOf` term. These counts measure coverage,
not whether a claim binds the correct owner, amount, or condition. Unsupported
statements and manual source review remain separate checks. Times are single
observations on a shared M4 Pro host, not comparative speed claims or measured
MacBook Neo performance.

Simulated RAM changes the hardware recommendation and admission capacity.
Available memory is capped at that capacity when it is smaller than the host.
The simulation does not reproduce a smaller Mac's CPU, memory bandwidth, or
competing applications.

The 4B reference uses the existing pinned weights on the new helper. Historical
Candle measurements cover different prompts and are not a matched latency or
quality comparison. The earlier Candle peaks were 6.477 GiB at 1,256 request
tokens and 7.280 GiB at 3,512 tokens. The approximately 8.76 GiB full-chunk
figure was extrapolated, not an admitted run.

Receipts belong in the coordinator's
`artifacts/continuation-2026-10-20/opus-loop/realistic-hardware/notes/` directory.
A refused run has no quality score or completed-notes latency.

## Measured native cases

Each timing is one completed summary and action pass. Memory is the maximum
observed bound across the listed fixtures for that size and RAM simulation.
The source manifests, process checks and outputs are in the dated receipts.

| RAM | Choice | Native bound, GiB | Helper peak RSS, GiB | Admission claim, GiB | 3-minute, s | 30-minute, s |
|---|---|---:|---:|---:|---:|---:|
| 8 GB | Light | 0.547 | 1.662 | 1.866 | 16.5 | 229.0 |
| 8 GB | Balanced | 0.827 | 3.023 | 3.326 | 61.3 | 775.8 |
| 8 GB | Best | 1.352 | 3.526 | 4.076 | 38.9 | 935.3 |
| 16 GB | Light | 0.586 | 1.706 | 1.866 | 17.1 | 209.3 |
| 16 GB | Balanced | 0.821 | 3.010 | 3.326 | 39.3 | 813.3 |
| 16 GB | Best | 1.349 | 3.527 | 4.076 | 37.9 | 795.1 |

The largest Light native bound was 629,328,848 bytes, or 0.586 GiB. The
hardware-tier module's whole-app Light notes budget is 2,684,354,560 bytes,
or 2.5 GiB. Electron and retained capture allocations were absent, so the
whole-app result is unqualified. A whole-app excess cannot be calculated from
these component measurements. The footprint lane must measure the combined
candidate after integration.

## Fixture coverage

This table counts targets in generated recap and action text at simulated
16 GB. Balanced is the existing pinned 4B weight reference. Best uses those
same weights with a larger window. The CSV also includes the 8 GB pairs.

| Fixture | Choice | Names | Numbers | Dates | Decisions | Actions |
|---|---|---:|---:|---:|---:|---:|
| standup-3min | Light | 2/3 | 2/4 | 1/2 | 2/2 | 1/3 |
| standup-3min | Balanced | 3/3 | 2/4 | 2/2 | 2/2 | 3/3 |
| standup-3min | Best | 3/3 | 2/4 | 2/2 | 2/2 | 3/3 |
| planning-30min | Light | 7/8 | 4/13 | 3/6 | 4/7 | 6/8 |
| planning-30min | Balanced | 8/8 | 12/13 | 5/6 | 6/7 | 8/8 |
| planning-30min | Best | 8/8 | 13/13 | 5/6 | 7/7 | 8/8 |
| customer-call-10min | Light | 5/5 | 4/5 | 3/3 | 3/3 | 4/4 |
| customer-call-10min | Balanced | 4/5 | 5/5 | 2/3 | 3/3 | 4/4 |
| customer-call-10min | Best | 5/5 | 5/5 | 2/3 | 3/3 | 4/4 |
| hiring-sync-8min | Light | 2/5 | 6/6 | 3/3 | 2/3 | 0/5 |
| hiring-sync-8min | Balanced | 5/5 | 5/6 | 3/3 | 3/3 | 5/5 |
| hiring-sync-8min | Best | 5/5 | 5/6 | 3/3 | 3/3 | 5/5 |

With the deterministic source quotes included, all fixture targets were present
in all 18 native cases. Existing review flags remained. This is coverage, not
semantic accuracy. A manual sample found stale June 2 launch wording despite
the final June 16 decision in the source quotes. Balanced also contradicted its
own Gantt-view decision. The checker flagged unsupported quantities and owner
claims, and produced a false name warning for a generic heading. Generated
notes still require review.

## Cleanup, queue and Apple checks

S1 completed 15 real generations and eight additional fidelity probes. Four
probe candidates passed the fidelity check; four were refused. These probes
exercise the backend and validation, not destination-app insertion.

The real queue restart test completed all four phases. A canceled wait remained
canceled after restart, manual retry remained available, and a saved wait
resumed and completed automatically at 8 GB. All sidecars exited. A separate
active-pass cancellation repro acknowledged cancellation but continued writing
analysis progress afterward. That code is in the footprint lane's protected
`analysis.rs`. It needs an active-task abort handle, followed by release and
save-boundary checks. Capture priority also needs a recheck after retry backoff;
that finding is source-only.

Apple's availability probe succeeded on macOS 27.2. Generation was refused by
the existing 10 GiB admission guard. The final pre-attempt snapshot showed
7,572,717,568 available bytes, or about 7.05 GiB. The wait was canceled and its
notice persisted. Apple notes generation and long-fixture quality remain
unqualified. The allowance was not reduced to force admission. Five native SDK
parsing fixtures passed without model generation.

## Verification and receipts

The final source gates passed: formatting, clippy with warnings denied,
3,450 Rust library tests and 30 binary tests, with 78 ignored; 13 text-helper
tests; typecheck; 4,466 Vitest tests across 283 files; and notice generation.
Local helper signatures were verified with ad-hoc identities. This does not
qualify Developer ID signing, notarization, installation or a delivered app.

`bun run language-model-helper:test` runs the SDK parsing check without model
generation. `bun run notes:evaluate:test` runs four virtual-clock tests. They
cover the observed premature cancellation of a later memory wait while keeping
the overall observation deadline fixed.

The Light file was checked against its real SHA-256:
`72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb`,
1,282,439,584 bytes. Its pinned revision is
`dcb19155b962dbb6389f4691a982043a8e651022`. The license SHA-256 is
`832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e`.
The 4B weight SHA-256 is
`2fde00ce69dd4899c70d020845e2638353015bba0fdf161b3eb965f2bca4464e`.
Each fixture run also verified its cloned files through the app's download and
integrity-receipt path.

Curated receipts are under
`artifacts/continuation-2026-10-20/opus-loop/realistic-hardware/notes/codex-2026-10-23/`
at the Git root. They include the full measurements CSV, generated and
source-quote coverage, raw results and events, source manifests, red/green
regression logs, signature checks, queue restart/cancellation evidence, and
qualification limits. Model weights are excluded.
