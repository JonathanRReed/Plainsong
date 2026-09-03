# Bundled dictation-cleanup model — measurement receipt

**Date:** 2026-09-02
**Machine:** Apple M4 Pro, macOS 27.0 (build 26A5406e)
**Model:** S1-mini by Superwhisper, `s1-mini-q4_k_m.gguf` (462 MiB), downloaded
through the app's own verified path into
`~/Library/Application Support/Plainsong/models/bundled_cleanup`
**Harness:** the opt-in `bundled_cleanup_real_text_eval` test
(`rust-sidecar/src/llm/bundled_local.rs`), release profile, run as

```
PLAINSONG_BUNDLED_CLEANUP_EVAL=1 cargo test --release --features candle-metal \
  --lib bundled_cleanup_real_text_eval -- --ignored --nocapture
```

## Load caveat — read this before quoting a number

**Every timing below is provisional.** The machine was shared with other
lanes' cargo builds throughout; `uptime` reported a 1-minute load average of
**34.4** (5-min 44.5, 15-min 51.2) immediately after the Metal run and
**44.2 / 47.4 / 52.6** immediately after the earlier one. These are not
quiet-machine numbers. They are quoted here because they are *worse* than a
quiet machine would produce and the conclusion — the pass fits inside the 6 s
pre-insert budget with a wide margin — only gets stronger when the load drops.
A quiet-machine re-run is still owed before any of these appear in product
copy.

## Download and integrity

| | |
|---|---|
| Files | 4 (`s1-mini-q4_k_m.gguf`, `tokenizer.json`, `LICENSE`, `NOTICE`) |
| Pinned total | 495,654,965 bytes (473 MiB) |
| On disk after download | 495,654,965 bytes |
| Integrity | all four passed `artifacts_trusted` after the download; each carries a MAC'd receipt |
| Revisions | GGUF `34add00a…`, weights repo `88f6b158…` (immutable commit shas, not `main`) |

The download ran through `DownloadManager::download_verified_model_asset`, so
each file's SHA-256 was checked against the digest pinned in
`llm/bundled_local.rs` before it was accepted. No digest had to be corrected:
the values taken from Hugging Face's LFS `oid` matched the bytes that arrived.

## Latency — Metal (the shipped configuration)

Backend reported by the runtime: `metal`. Five runs per fixture, after
`prewarm()` (which loads the GGUF **and** runs one throwaway generation).

| Fixture | Words | Control line | p50 | p95 |
|---|---|---|---|---|
| short | 59 | `[Styling: semi-formal] [Structure: prose] [Context: general]` | **414 ms** | **430 ms** |
| long | 199 | `[Styling: semi-formal] [Structure: prose] [Context: general]` | **1.82 s** | **1.92 s** |
| short, email register | 59 | `[Styling: formal] [Structure: prose] [Context: email]` | **408 ms** | **417 ms** |

Budget: `DICTATION_FORMAT_TIMEOUT_LOCAL` is 6,000 ms. The worst measured p95
is 1.92 s — **32% of the budget**, on a machine under load average 34.

### The warmup generation is load-bearing

The first run of this receipt loaded the model but did not generate with it,
and measured **p50 442 ms / p95 7.54 s** on the short fixture. The 7.5 s was
the first inference in the process paying Candle's deferred Metal shader
compile — which would have blown the 6 s budget exactly once per launch, on
the user's first dictation. `prewarm()` now runs a two-token throwaway
generation for that reason, and the same fixture measures p95 430 ms.

## Latency — CPU (the fallback path), and why it matters

Same harness, same machine, built *without* `--features candle-metal`
(load average 43.1 / 37.6 / 44.8 immediately after the run):

| Fixture | Words | p50 | p95 | Inside the 6 s budget? |
|---|---|---|---|---|
| short | 59 | 4.85 s | 5.08 s | yes, with ~1 s to spare |
| long | 199 | **11.26 s** | **13.42 s** | **no** |
| short, email register | 59 | 3.49 s | 4.89 s | yes, barely |

**Metal is not an optimization here, it is the thing that makes this route
usable.** It is 11.7x faster on the short fixture and 6.2x on the long one,
and without it a 200-word dictation blows the pre-insert budget every time —
the user would get their unmodified local-pipeline text and an "AI formatting
took too long" warning on every long capture.

This is acceptable as shipped because the macOS release binary always compiles
`candle-metal` (`scripts/sidecar-cargo-features.mjs`), and the runtime only
falls back to CPU when `Device::new_metal(0)` fails — which it logs as a
warning. It is *not* acceptable to quote the Metal numbers as though they were
the model's, and the product copy does not.

Contrast with the larger Candle ASR models, where Metal's advantage is a
~30x speedup (`acceleration-receipt-2026-09-01.md`): at 0.6B the gap is
smaller but still decisive against a 6 s budget.

## Output

Verbatim, from the Metal run. Input fixtures are in the eval test.

**short** — input: `so um i need to like send the the quarterly report by uh friday no wait make that thursday and i should probably loop in sarah because she owns the numbers section anyway once that goes out we can start on the deck for the review which is uh the week after i think the third or the fourth`

> So I need to send the quarterly report by Thursday, and I should probably
> loop in Sarah because she owns the numbers section. Anyway, once that goes
> out, we can start on the deck for the review, which is the week after, I
> think the 3rd or the 4th.

Filler removed, the `friday no wait make that thursday` self-correction
resolved to Thursday, `the the` de-duplicated, `third or the fourth`
rendered as `3rd or the 4th`, sentence boundaries and capitalization added.

**long** (199 words) — cleaned into five paragraphs with `two and a half
seconds`→ kept as words, `four hundred milliseconds` → `400 milliseconds`,
`sha two fifty six` → `SHA-256`, `beta two` → `beta 2`, `two gigabytes` → `2
gigabytes`. One flaw worth recording: `Second, thing is the model download
path.` keeps a stray comma, and `the meeting summary chunking I started it`
loses a clause boundary. Neither is a correctness problem — no content was
invented — but the model is 0.6B and it is not perfect prose.

**email register** produced the same body text without a greeting/sign-off
block, which is correct: the fixture has no addressee or signature for the
`Context: email` layout to work from.

## What this receipt does not cover

- **Apple's on-device model.** `scripts/native-macos-language-model-helper.swift`
  was compiled against SDK 26.2 (`xcrun --sdk macosx --show-sdk-version`) with
  an `arm64-apple-macosx13.0` deployment target, and its probe, malformed-request
  and error paths were exercised against the real binary on macOS 27.0. Every
  run returned `model_not_ready` — Apple Intelligence has not finished
  downloading its model on this machine — so **no generation has been run
  through that provider**. That needs a Mac with Apple Intelligence enabled and
  its model downloaded.
- **A quiet machine.** See the load caveat.
- **Non-English input.** The model card says English only, and nothing else was
  tried.
