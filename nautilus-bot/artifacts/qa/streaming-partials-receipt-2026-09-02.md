# Streaming dictation partials receipt (2026-09-02)

Parity program lane C1. Question: Plainsong's dictation "live preview" is a
batch re-decode — every 220–420 ms it re-transcribes a growing copy of the
audio with the dictation engine (`lib.rs`, `dictation_partial_buffer`), so the
words land a whole decode behind the speaker. C2 proved transcribe.cpp can load
Nemotron 3.5 ASR Streaming (cache-aware FastConformer + RNN-T) in about half a
second. Does a real streaming session make the preview *live* — and can it be
added without putting a single partial anywhere near the text that gets
inserted?

**Answers, in order: not quite, and yes.**

## Verdict

**Adopt the trait and the session; do not yet call the preview "live" at the
default chunk size.** The engine works, the text is right, and the safety
property holds by construction and by test. But on this machine, under the load
it was measured on, partial latency at the 560 ms operating point was **p95
720–1133 ms**, not the ~600 ms the lane set as the bar for calling it live. The
320 ms operating point was better and still missed: **p95 631–703 ms**. A
quiet-machine re-run is owed before the default moves, and is the one thing
that would change the recommendation below.

What *did* land unambiguously: the preview now updates 4–14 times across a 5.3 s
utterance with a stable/volatile split the popup renders, instead of a whole-
utterance re-decode, and it costs a fraction of a core.

## The guarantee this lane was not allowed to break

The inserted text is the batch decode of the selected dictation engine, made
after capture stops. Streaming partials are UI-only.

This is not asserted, it is enforced by three source-scan tests in `lib.rs`
that fail the build rather than the user:

| Test | What it forbids |
| --- | --- |
| `dictation_insertion_never_reads_a_streaming_partial` | Any of `StreamingPartialTracker`, `StreamingAsrSession`, `StreamingAsrProvider`, `spawn_streaming_live_preview`, `open_streaming_live_preview_session`, `partial_text`, `partialText`, `partialStableText`, `partialVolatileText`, `dictation_partial_buffer` appearing anywhere in `stop_dictation_for_sidecar` past the session-ownership anchor |
| `the_live_preview_is_closed_before_the_final_transcription_starts` | The close call appearing *after* `transcribe_bytes_for_dictation` |
| `the_streaming_preview_task_only_ever_emits_a_preview_event` | `insert_text`, `paste_text_systemwide`, `copy_to_clipboard`, `save_dictation` or `dictation-text-ready` appearing inside the preview task |

The one thing the stop path may say about the preview is `stop`, and the same
test asserts that it does.

Corroborating, though not the guarantee: on the 5.32 s fixture the streaming
session's own final text was **byte-identical** to a batch decode of the same
weights — `This is a Nautilus local quality gate sample with enough spoken words
for verification.` in both, in all nine runs below.

Read that for exactly what it is: a `benchmark-latency --stream` measurement.
The harness feeds the whole fixture, feeds the chunker's remainder and calls
`finalize()`, so the text it compares is a *finished* stream. The shipped
preview path did neither when this receipt was first written, so its last
partial was an uncommitted tail over audio one chunk short of the capture; it
now closes the same way the harness does (`finish_streaming_utterance`), which
is what makes this comparison say anything about the shipped path at all. Even
then it is a comparison of two previews of the same weights, not evidence about
the text Plainsong inserts: that is always the batch decode from the user's own
dictation engine, which is usually not these weights.

## Environment

- Hardware: Apple M4 Pro, 14 logical CPUs, 24 GB.
- OS: macOS 27.0. rustc/cargo 1.93.0.
- Source: this lane branch, cut from `main`, merged with `parity-waves` and with
  lane C2's branch (`worktree-agent-a9d0aba36879242b9` @ `aa94a89b`).
- Binary: one `--release --locked` build of `benchmark-latency` with
  `--features asr-transcribe-cpp`, used for every configuration.
- Model: `nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf`, 751 094 240 bytes, SHA-256
  `b94545b3…8089c`, fetched from the HuggingFace commit C2 pinned and installed
  through the app's own `download_verified_model_asset` path, which hashed it
  and wrote its `.plainsong-integrity` receipt before first use.
- Fixture: `scripts/fixtures/local-quality-gate.wav`, 5.323 s, 15 reference
  words.
- **Machine state: heavily contended throughout.** 1-minute load average at each
  run's start is recorded with every number; every run below was taken between
  **71 and 115** on 14 cores. Anything above ~14 is oversubscribed. **Treat
  every latency here as provisional and as an upper bound.**

## What "partial latency" means here

For each word the reference decode aligned, latency is:

> (wall clock when a partial first showed that word in that position)
> − (the moment the speaker finished saying it)

The reference is a word-timestamped batch decode of *the same weights*
(`streaming_reference_words`), so the zero point is not another recognizer's
segmentation. The fixture is fed in real time, in 100 ms slices, with the
harness sleeping so each slice is handed over no earlier than the moment it
would have been captured — a preview that only looks fast because it was fed
faster than a person speaks is not a measurement.

Some of this latency is structural and cannot be optimized away: a word that
ends just after a chunk boundary waits most of a chunk before its audio is fed
at all. The floor is roughly `chunk_ms/2 + feed_time` at p50 and
`chunk_ms + feed_time` at p95.

## Measurements

`benchmark-latency --stream --stream-chunk-ms <MS>`, three rounds each.

### Partial latency (ms after the word ended)

| Chunk | p50 per round | p95 per round | best p95 | partials over 5.3 s | words aligned |
| --- | --- | --- | ---: | ---: | --- |
| 320 ms | 437 / 463 / 410 | 631 / 703 / 682 | **631** | 14 | 13/15 |
| 560 ms (default) | 574 / 593 / 893 | 720 / 819 / 1133 | **720** | 9 | 13/15 |
| 1120 ms | 951 / 755 / 784 | 1300 / 1075 / 1104 | **1075** | 4 | 12/15 |

1-minute load at each round's start: 320 ms — 115 / 94 / 77; 560 ms —
107 / 90 / 71; 1120 ms — 100 / 83 / 71.

"Words aligned" is how many of the 15 reference words the preview ever showed
in their reference position. The two it never matched at 320/560 ms are the
same two in every run — the preview's own wording differs there before the
final chunk settles it — and they are excluded from the percentiles rather than
counted as zero, which would flatter the result.

### Cost

| Chunk | `feed()` p50 per round (ms) | `feed()` p95 (ms) | sidecar CPU, % of one core |
| --- | --- | --- | --- |
| 320 ms | 96 / 145 / 82 | 130 / 245 / 109 | 28 / 116 / 37 |
| 560 ms | 65 / 91 / 419 | 132 / 154 / 511 | 14 / 32 / 202 |
| 1120 ms | 259 / 90 / 89 | 416 / 118 / 119 | 50 / 15 / 23 |

Read the *lowest* of each row: those are the runs least disturbed by the other
lanes on this box. On that basis a 320 ms chunk costs about 82 ms of decode per
320 ms of audio (~0.26 of real time) and a 560 ms chunk about 65 ms per 560 ms
(~0.12), which is the expected shape — a smaller chunk buys latency with
compute — and the sidecar sits well under a third of one core. The 202% and
116% CPU rows are contention, not the engine: the same binary and the same
audio measured 14% one round earlier.

Session open (model load, on the preview's own thread, off the async runtime):
**220–393 ms** across all nine runs. It does not delay the start of dictation —
the session is opened inside the spawned preview task — but it does mean the
first partial of a session cannot arrive before it.

### What holds in every round

1. 320 ms beat 560 ms on both p50 and p95 in all three rounds, and beat
   1120 ms in all three. That ordering is the one this receipt would act on.
2. The *benchmark harness's* final text — a stream that was fed its remainder
   and finalized — was byte-identical to the batch decode of the same weights,
   in all nine runs. Nothing here measured the shipped preview's own final
   text; it is only since `finish_streaming_utterance` that the shipped path
   closes a stream the same way.
3. The sidecar never approached saturating a core in an uncontended round.

What does *not* hold is the rest of the ordering: in round 3 the 1120 ms
configuration beat 560 ms (p50 784 vs 893, p95 1104 vs 1133), which is the wrong
way round and is the clearest single sign of how much the load average is in
these numbers. Round 3's 560 ms run also recorded a `feed()` p50 of 419 ms and
202% CPU against 65 ms and 14% for the same code one round earlier.

### What does not hold

**The ~600 ms p95 bar.** Not at 560 ms (720 ms in the best round), and not at
320 ms (631 ms in the best round) — though 320 ms is within noise of it on a
machine that was never below a load average of 71. Saying this plainly is the
point of the receipt: on the evidence actually collected, this is a *faster*
preview, not yet a demonstrably live one.

## Recommendation

1. Ship the trait, the session and the wiring. They are correct, tested, and
   compiled out of every binary a user gets (`asr-transcribe-cpp` is off in
   `default` and absent from `scripts/sidecar-cargo-features.mjs`).
2. Keep `DEFAULT_STREAMING_CHUNK_MS` at 560 for now, because that is the size
   the lane specified and the measurements are too contended to justify moving
   a default on.
3. **Re-run on a quiet machine before claiming "live" anywhere in the UI.** If
   the ordering above survives, move the default to 320 ms: it was better on
   p50 and p95 in every round, and its compute cost is still a quarter of a
   core. The feature keeps the name it already had ("Live preview", "Live
   text"); no copy added by this lane claims "instant" or "real time". What it
   says is that the words appear while you are still speaking, which is what
   was measured — 4 to 14 updates across a 5.3 s utterance, the first of them
   inside the first second.

## Deviations from the lane brief, and why

- **Chunk table is 320/560/1120 ms, not 160/560/1120.** A cache-aware
  FastConformer does not take an arbitrary chunk. The GGUF port exposes
  `--stream-att-right {0,3,6,13}`, which at 80 ms per encoder frame is
  80/320/560/1120 ms. NVIDIA's own card mentions 160 ms, but the port offers no
  `att_context_right = 1` with which to select it. 80 ms is omitted because
  per-chunk overhead dominates there.
- **The language gate uses 28 codes, not 40.** Three counts are in circulation:
  NVIDIA advertises 40 language-locales; the GGUF port's card says 32 are
  supported ("the tokenizer recognizes 40, but 8 are adaptation-ready and need
  fine-tuning"); and the file's own `language:` metadata at the pinned revision
  lists 28. The gate uses the 28, because it is the only list pinned with the
  bytes this app downloads. Only English was exercised here.
- **No reset-on-silence in the dictation loop.** The trait and its tracker
  support it and are tested for it, but a dictation session is one utterance of
  a few seconds, and dropping encoder context mid-sentence would make the
  preview lose the sentence the user is still in. It is the meeting-caption
  path that needs it, and that path needs `reset` to become
  commit-and-continue first — see `docs/streaming-dictation-plan.md`.

## Gates

Run from `nautilus-bot/`, `CARGO_TARGET_DIR` pointed at the shared target dir.

```
# Default / release feature set (what ships)
bun run lint:rust        -> cargo fmt --check + clippy --locked --all-targets -D warnings: clean
bun run test:rust        -> 1411 passed; 0 failed; 8 ignored (lib)
                            19 passed (benchmark-latency), 0 (plainsong-cli), 4 (sidecar)

# With the streaming engine compiled in
cargo fmt --manifest-path rust-sidecar/Cargo.toml --check                       -> clean
node scripts/cargo-sidecar.mjs clippy --locked --features asr-transcribe-cpp \
  --all-targets -- -D warnings                                                  -> clean
node scripts/cargo-sidecar.mjs test --locked --features asr-transcribe-cpp \
  --lib --bins                                                                  -> 1444 passed; 0 failed; 8 ignored (lib)
                                                                                   20 passed (benchmark-latency), 0 (plainsong-cli), 4 (sidecar)

# Shared
bun run typecheck        -> clean
bun run test             -> 146 files, 1663 tests passed
bun run gate:ipc-contract-> 197 renderer commands, 249 sidecar commands, all reachable
bun run gate:dead-code   -> clean
```

## Reproducing

```
node scripts/cargo-sidecar.mjs build --release --locked \
  --features asr-transcribe-cpp --bin benchmark-latency

BIN=$CARGO_TARGET_DIR/release/benchmark-latency

# Install and verify the weights through the app's own pinned-hash path.
"$BIN" --provider transcribe_cpp --model nemotron-3.5-asr-streaming-0.6b-q8_0 \
  --ensure-model --runs 1

# Measure the live preview at each operating point.
"$BIN" --stream --stream-chunk-ms 320
"$BIN" --stream --stream-chunk-ms 560
"$BIN" --stream --stream-chunk-ms 1120
```

The GGUF lands in
`~/Library/Application Support/Plainsong/models/transcribe_cpp/` (716 MiB) and
is removable from the Models screen's "Live preview engine" row.
