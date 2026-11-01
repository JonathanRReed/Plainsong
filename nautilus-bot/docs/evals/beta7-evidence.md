# Beta.7 claim evidence

Reconciled October 22, 2026 against base source `0cf8c4ca` and the local receipts
listed below. No models were run and no network requests were made for this
reconciliation. The model-release publication status comes from the
maintainer's October 22 verification.

Receipt paths are relative to the main checkout,
`/Users/jonathanreed/Documents/Plainsong/nautilus-bot/`. They are untracked
measurement artifacts. This tracked index carries their methods, results and
limits so readers do not need those files to understand the claims. It does
not turn a historical run into evidence for a later package.

## Speech recognition

Word error rate includes substitutions, deletions and insertions. Lower is
better. Results compare the Parakeet v3 Q8_0 build through transcribe.cpp with
the older ONNX int8 build. These are recorded-audio harness runs. They do not
measure live capture, shortcut reliability or insertion into another app.

| Run | Dataset and count | Date and hardware | Result | Source receipt |
| --- | --- | --- | --- | --- |
| Hard audio | Synthetic speech from macOS voices with generated noise; 30 prompts, six voices, 60 clips per condition; 352 long clips and 150 background-only negatives in the broader evaluation. Engine comparison covered 522 of 750 clips at report time. | October 20, 2026; M4 Pro, 24 GB; release build. | Pooled hard-audio WER 8.2% versus 13.5%; babble at 5 dB 4.4% versus 19.4%; far-field 14.4% versus 28.3%. The background-talker case was worse, 16.8% versus 13.8%. The comparison was incomplete in this report. | `artifacts/continuation-2026-10-20/opus-accuracy/report.md` |
| Real human speech | 630 clips from LibriSpeech test-clean and test-other, 30 joined long clips, 100 AMI segments in both headset and room recordings, and 40 FLEURS clips each in German, Spanish, French, Italian and Portuguese. A quiet-gain control was also run. | October 21, 2026; busy shared host. Hardware is not recorded in this report. Base `b44d8b47`; app preprocessing and admission. | Pooled WER 6.32% versus 7.59%; English 7.05% versus 7.97%; FLEURS 4.70% versus 6.74%. Peak resident memory about 1.7 GB versus 2.4 GB. On AMI clips shorter than 1.5 seconds the newer build was worse. | `artifacts/continuation-2026-10-20/opus-real-speech/report.md` |
| Meeting speech | AMI ES2004a, IS1009a, TS3003a, EN2002a and ES2004b, about 131 minutes, each as headset mix and Array1-01 room audio. Also a joined 74.8-minute fixture. Product meeting path in an isolated profile, pause-aligned 90-second chunks. | October 21, 2026, from receipt file date; hardware is not recorded in the report. Source rebased on `9bf2d306`. | Pooled headset WER 23.0% versus 30.4%; room WER 28.0% versus 37.6%. Lower WER on all ten meeting/source pairs. Peak resident memory 1.0-1.1 GiB versus 2.0-2.2 GiB. | `artifacts/continuation-2026-10-20/opus-meeting/report.md` |
| Word timing | The AMI meeting runs above, aligned to manual reference words, including the joined 75-minute fixture. | Same meeting run; hardware not recorded. | Older Parakeet build after word-timing fix: median absolute timing error 70 ms, 90th percentile 180-200 ms; no observed drift over the joined fixture. This measures timing, not speaker identity. | `artifacts/continuation-2026-10-20/opus-meeting/report.md` |

The real-speech report also records admission refusals on the busy host.
Accuracy results cover admitted decodes, not a claim that every requested
recording completed. Memory figures are process peaks from those runs, not a
universal memory requirement. No quiet-host hardware comparison is claimed
where hardware was not recorded.

## Speaker labels

The first five AMI meetings are the set listed above. Eleven held-out meetings
are EN2002b/c/d, ES2004c/d, IS1009b/c/d and TS3003b/c/d. Scores below pool
aligned words, weighted by their count, rather than averaging meeting
percentages. They use saved Parakeet transcripts. Unrecognised reference words
are outside this speaker-word metric.

Date: October 21, 2026, from run logs and receipt dates. Hardware is not
recorded in the final score files. The earlier comparison report describes a
heavily loaded shared host. This is speaker-label accuracy evidence, not a
hardware performance benchmark.

| Comparison | n | Correct / wrong / unlabelled aligned words | Source receipt |
| --- | --- | --- | --- |
| ECAPA merge before versus after | 16 headset meetings, 71,787 aligned words | Before 88.569% / 4.899% / 6.532%; after 92.606% / 6.799% / 0.595%. About two thirds of newly assigned words gained the right label; wrong labels also increased. | `artifacts/continuation-2026-10-20/opus-diarization/scores-var/ecapa-rustbase.hs.*.json` and `ecapa-rustnew.hs.*.json` |
| Community-1 versus updated ECAPA | First five headset meetings | Community-1 93.181% / 6.276% / 0.543%; ECAPA 92.666% / 6.657% / 0.676%. | `artifacts/continuation-2026-10-20/opus-pyannote-c1/deeprec/scores/c1-pad1.hs.*.json`; `opus-diarization/scores-var/ecapa-rustnew.hs.*.json` under the same artifact base |
| Community-1 versus updated ECAPA | Eleven held-out headset meetings | Community-1 92.548% / 6.942% / 0.510%; ECAPA 92.587% / 6.844% / 0.569%. No material headset accuracy lead is claimed. | Same score families, restricted to the held-out meeting IDs |
| Community-1 versus updated ECAPA | First five room recordings | Community-1 91.513% / 7.989% / 0.498%; ECAPA 89.996% / 9.009% / 0.996%. No held-out room result is claimed. | `artifacts/continuation-2026-10-20/opus-pyannote-c1/deeprec/scores/c1-pad1.sdm.*.json`; `opus-diarization/scores-var/ecapa-rustnew.sdm.*.json` under the same artifact base |
| Small-cluster folding | First five AMI meetings, four reference speakers each | ECAPA headset speaker counts 3-5 versus 60-183 before folding; room counts 3-6 versus 110-283. | `artifacts/continuation-2026-10-20/opus-meeting/report.md` |
| Brief guest | Synthetic 10- and 15-second guest inserted into a joined 75-minute, eight-speaker meeting | ECAPA and community-1 retained the guest in the comparison. Similar voices still merged in some meetings. This is a constructed case, not a guarantee for every brief speaker. | `artifacts/continuation-2026-10-20/opus-diarization/report.md`; `opus-pyannote-c1/parity/cml_vs_mps.md` under the same artifact base |

The `c1-pad1` score family is the community-1 variant behind the beta.7
headline. Earlier `pscores/prod.gguf.*` and the reference-port tables evaluate
different merge settings and must not be substituted for it. The scoring and
pooling method is in `opus-diarization/scripts-heldout/summarize.py` under the
same artifact base. For each group, sum `aligned * correct` and
`aligned * unlabelled`, then divide by total aligned words. Wrong words are
the remainder.

## Meaning search

The dataset contains manual English AMI reference transcripts for 171 meetings,
97.973 hours in total, plus synthetic dictation notes. The headline uses 124
hand-written questions, with relevance taken from linked AMI manual summary
annotations. A hit means at least one relevant passage occurs in the first
five results. It does not measure whether Ask writes a correct answer.

The `team` setting filters candidates to the question's project series plus
EN/IB/IN meetings and dictation notes. These are not unrestricted searches
across all 171 meetings. Passage windows contain about 100 words. Headline
model scores are meaning search alone. Ask's combined ranking has different
scores and must not be described by the meaning-search figures.

Date: October 21, 2026, from receipt file dates. Hardware is not recorded in
the score files. The timing run used CPU inference in ONNX Runtime 1.28,
without the app's background scheduling. It is not a measured completion-time
promise on a named Mac.

| Method | n | Top-five hits | Source receipt |
| --- | --- | --- | --- |
| Word matching over stored word rows | 124 | 26.6% | `artifacts/continuation-2026-10-20/opus-embeddings/results/scores.jsonl`, `model=none`, `scheme=word`, `setting=team`, `set=hand`, `method=fts` |
| Word matching over passage windows | 124 | 53.2% | Same file, `model=none`, `scheme=window100`, `setting=team`, `set=hand`, `method=fts` |
| EmbeddingGemma 2 | 124 | 75.0%, 93/124 | Same file, `model=gemma2-q8@ort128`, `scheme=window100`, `setting=team`, `set=hand`, `method=semantic` |
| EmbeddingGemma 300M | 124 | 77.4%, 96/124 | Same filters, `model=gemma-int8@ort128` |
| Qwen3 Embedding 0.6B | 124 | 71.0%, 88/124 | Same filters, `model=qwen3-int8@ort128` |
| EmbeddingGemma 2 combined ranking | 124 | 69.4% | Same filters, `method=hybrid` |
| Standalone EmbeddingGemma 2 indexing | 11,123 unique passages | 601.1 seconds, 18.5 passages/second, 6.1 processing seconds per hour of reference transcript | `artifacts/continuation-2026-10-20/opus-embeddings/results/embed_stats.jsonl`, `model=gemma2-q8@ort128` |

Dataset and scorer: `opus-embeddings/results/ami.json`,
`results/hand_queries.json` and `scripts/score.py` under the artifact base.
These English tests do not support a ranking in other languages. The Qwen
summary's "strongest in other languages" claim was removed.

## Dictation formatting and fidelity

- `artifacts/continuation-2026-10-20/opus-format/report.md` records formatter
  outputs, 20 added fixtures and focused checks for lists, paragraphs and
  email layout. It explicitly leaves live insertion into Mail, Notes,
  Notion and Linear unverified. Source base `fb3e7cad`, change `b6b68ee5`.
- `artifacts/continuation-2026-10-20/opus-e2e/report.md` records a headless
  production-text-path test, not insertion into running destination apps.
  The corpus has 98 synthetic speech clips and 136 scored destination rows.
  In its October 21 round-5 result, 61/136 rows were word-exact, WER was
  9.8%, and 24 critical errors remained in 18 rows. Corrections resolved /
  left visible / wrong were 9 / 7 / 0. Hardware is not recorded in this report.
  Those results support bounded correction examples. They do not establish
  exact output or correct spelling on every recording.
- Each of two earlier busy-host runs in that report refused all 136 built-in
  AI cleanup requests for memory headroom. The app retained
  local text. Later memory-admission changes do not retroactively establish
  a successful cleanup run or measured resident-memory requirement.

## Idle CPU

`artifacts/continuation-2026-10-20/opus-loop/candidate-b6/qa/idle-cpu-baseline.md`
and its JSON receipt record 20 samples at one-second intervals after a
30-second warm-up. Generated October 22, 2026 at 06:01:36 UTC for the beta.7
app in worktree `t3-0757c92e`, as archived under `candidate-b6`. Mean total
process-tree CPU was 0.33%, 95th percentile 0.7%, peak 5.5%. The average
threshold was 1%. Hardware is not recorded in this receipt. This is one
packaged candidate's idle result, not a zero-CPU claim or evidence for this
branch's delivered bytes.

## Download sizes and notices

On October 22, 2026, the six files in
`artifacts/continuation-2026-10-20/models-release-staging/` were measured
locally. No model was loaded. Hardware is irrelevant to this byte count.

| Community-1 file | Bytes |
| --- | ---: |
| `pyannote-community-1-segmentation.onnx` | 5,917,280 |
| `pyannote-community-1-embedding.onnx` | 26,546,699 |
| `pyannote-community-1-plda.npz` | 133,852 |
| `pyannote-community-1-xvec_transform.npz` | 134,376 |
| `pyannote-community-1-LICENSE.txt` | 18,657 |
| `pyannote-community-1-NOTICE.txt` | 2,648 |
| Total | 32,753,512 |

The existing rounded decimal label, 33 MB, is correct and was retained.
Sources: staged `README.md`, `SHA256SUMS`, the measured files, and the six
pins in `rust-sidecar/src/download/mod.rs`.

Qwen3 4B Instruct has two manifest entries tied to
`rust-sidecar/src/llm/native_text.rs`: bartowski's Q4_K_M conversion at
`ae44f08e1392f39c0e474af10c3ff8355c8b6688`, and Qwen's tokenizer and Apache-2.0
license at `cdbee75f17c01a7cc42f958dc650907174af0554`. The generated notices
name Qwen, bartowski, both repositories, revisions and all three files.
This records attribution, not an inference-quality result.

The October 23 and 24 helper migration uses the model weights and license
files; tokenization is contained in the weights. Current model choices and
native measurements are recorded in [notes helper evidence](notes-helper-2026-10-23.md).

The maintainer verified that `models-2026-10` is a published GitHub prerelease
carrying community-1, Fluid and Bark assets. They remain prerelease assets
until launch. This review made no network check and no statement about
publication of the beta.7 app.

## Claims without a supporting measurement

Microphone-opening timing, trigger-buffer reuse, memory admission and fidelity
checks are described as mechanisms. They do not guarantee no lost words,
cleanup availability or exact preservation. Secure-field recovery copy does
not promise a history entry. Cloud-model summaries and model presets no
longer claim comparative quality, price or size leadership. The README latency
JSON is labelled example output because no matching candidate receipt was
found. September install-size and release records are labelled historical.
