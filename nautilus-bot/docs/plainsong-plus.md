# Plainsong Plus: plan, models and launch checklist (2026-09-24)

Plainsong stays free, MIT and local-first. Plus is an optional $10/month
subscription that adds hosted models: the most accurate speech-to-text we
can route to, and hosted cleanup, Voice Edit and summaries. It is a model
provider the user picks in Models, like a bring-your-own-key provider
without the key.

**Status: built, not launched.** Nothing a user can download contains it.

| Piece | Where | Off switch |
| --- | --- | --- |
| Relay Worker | `infra/plus-worker` | `PLUS_LAUNCH_STATE = "off"`: every route but `/v1/status` answers 503 |
| App side | `rust-sidecar/src/plus.rs`, `asr/plainsong_plus.rs`, `src/lib/plus.ts`, `src/components/plus-settings-section.tsx` | Cargo feature `plainsong-plus`, not in `default` and not in `scripts/sidecar-cargo-features.mjs` |

A default build answers `plus_get_status` with `available: false`, has no
`plainsong_plus` route or `plainsong-plus` provider to deserialize, and
resets a settings file that names one. Tests pin this for both builds
(`plus::feature_gate_tests`, `sidecar-cargo-features.test.ts`).

To try it locally:

```bash
cd infra/plus-worker && npx wrangler@4 dev    # PLUS_LAUNCH_STATE=testers in .dev.vars
cd nautilus-bot
cargo build --manifest-path rust-sidecar/Cargo.toml --features candle-metal,plainsong-plus
PLAINSONG_PLUS_URL=http://localhost:8787 bun run dev   # dev loads target/debug
```

Settings then shows a Plainsong Plus section (license key, usage), Models
lists "Plainsong Plus" as a dictation route and as a cleanup provider.

## 1. Model picks

Chosen for accuracy first, then latency, then cost. The app only sees two
chat aliases and one speech route, so any of these can change in the Worker
(`src/providers.js`) without an app update.

| Job | Pick | Why | Fallback |
| --- | --- | --- | --- |
| Dictation speech-to-text | xAI Grok speech-to-text | 2.3% AA-WER, $0.10/h batch, key terms, 25 languages | ElevenLabs Scribe v2 (2.2%, $0.22/h, 90+ languages) on a 5xx |
| Cleanup and Voice Edit (`plainsong-fast`) | Groq `openai/gpt-oss-120b` | About 500 tokens/s, $0.15/$0.60 per M tokens; cleanup must feel instant | Gemini 3.1 Flash-Lite ($0.25/$1.50) |
| Summaries and long rewrites (`plainsong-quality`) | Claude Haiku 4.5 | Best at "change nothing but the form" edits; $1/$5 per M tokens | Claude Sonnet 5 for very long meetings |

Considered and not picked yet:

- **MAI-Transcribe-2** (2.0%, $0.10/h): no streaming, speaker labels fail
  on recordings over about 15 minutes in preview, and the price is a promo
  to the end of 2026. Worth an A/B for dictation once Azure exposes it
  cleanly.
- **StepAudio 3 / Fun-ASR** (1.7%): China-hosted, wrong fit for a privacy
  app.
- **Deepgram Nova-3**: cheaper but less accurate, and list prices opt you
  into training unless `mip_opt_out=true`.

Re-run `scripts/eval-asr-wer.mjs` against each candidate before launch; the
leaderboard reshuffles every few months.

## 2. How it runs

```
Mac app ──license key──▶ Worker /v1/activate ──▶ Polar (validate, count Macs)
        ◀──24 h token───
Mac app ──audio + token──▶ Worker ──▶ xAI (or ElevenLabs) ──▶ text back
Mac app ──text + token───▶ Worker ──▶ Groq or Anthropic   ──▶ text back
Polar ──webhooks──▶ Worker ──▶ D1 (subscription status, monthly counters)
```

- **Relay, not client tokens.** Short-lived provider tokens mostly exist
  for streaming only, are rarely usage-scoped, and would tie the app to one
  vendor. The relay meters exactly, keeps every provider key server-side
  and lets us switch models without a release.
- **Billing: Polar** as merchant of record. It handles worldwide VAT and
  sales tax, issues license keys, limits activations (set 3 Macs) and gives
  customers a portal. Lemon Squeezy is the alternative with the same shape.
- **Entitlement:** the Worker signs its own 24 h token after checking the
  license with Polar and the subscription status from webhooks. The app
  keeps the license key and activation id in the Keychain and the token in
  memory, and re-activates quietly 10 minutes before expiry.
- **Cost of running it:** Cloudflare Workers paid plan, $5/month, covers
  10M requests. Audio waits on `fetch`, which is not CPU time.

## 3. Economics

Per heavy user (20k dictated words a week, about 9.6 h of audio a month,
plus 20 h of meetings):

| Line | Monthly cost |
| --- | ---: |
| Dictation speech-to-text (Grok batch) | $0.96 |
| Cleanup (about 0.8M in, 0.12M out, gpt-oss-120b) | $0.19 |
| Meeting speech-to-text (Grok batch), once meetings ship | $2.00 |
| Meeting summaries (about 0.5M tokens, Haiku 4.5) | $0.60 |
| **Heavy user** | **about $4** (up to $8 with streaming or Haiku cleanup) |
| **Median user** | **under $1.50** |

Revenue per $10 month through Polar (5% + $0.50): **$9.00**. An annual plan
at **$96/year** keeps $90.70 and halves the fixed-fee drag. Worst case at
the fair-use caps is about $7 to $9, so a user at the cap still breaks even.

Competitors: Wispr Flow Pro $15/month ($12 annual), Typeless Pro $30/month
($12 annual). Both say "unlimited" without numbers. Plainsong at $10 with
free local models underneath is the cheapest serious option.

## 4. Fair use ("unlimited for normal personal use")

Published in the terms and enforced in `infra/plus-worker/src/policy.js`:

| Cap | Value | For scale |
| --- | --- | --- |
| Dictation | 15 h of audio a month | About 135k words, 3 to 4 times a heavy Wispr user |
| Meetings | 30 h a month | Six hours of calls every week |
| Hosted AI | 20M tokens a month | Far above any cleanup or summary pattern |
| One dictation | 10 minutes | Per request |
| One meeting upload | 60 minutes | Per request; the app sends meetings in chunks |

Past a cap the app falls back to local models. Nobody is cut off.

## 5. Privacy copy (draft for PRIVACY.md)

> Plainsong Plus sends the audio of a dictation, and the text you ask it to
> clean up, edit or summarize, through our relay to the model provider
> (xAI, ElevenLabs, Groq or Anthropic) and back. We do not store or log
> audio or text. We store your monthly usage totals and whether your
> subscription is active. Local models never send anything anywhere, with
> or without Plus.

Confirm each provider's retention and zero-data-retention terms before
launch and list them next to this paragraph.

## 6. Launch checklist

1. Verify against the vendors' own docs (blocked from this build machine):
   xAI `/v1/stt` fields, limits and retention; Groq model id and ZDR;
   Anthropic ZDR; ElevenLabs retention (ZDR is enterprise-only).
2. Run the WER harness on Grok, Scribe v2 and MAI-Transcribe-2 with real
   dictation audio.
3. Create the Polar products ($10/month, $96/year) with the license key
   benefit, then the webhook (see `infra/plus-worker/README.md`).
4. Deploy the Worker with `PLUS_LAUNCH_STATE = "testers"` and a handful of
   tester customer ids.
5. Build a tester app with `--features plainsong-plus` and dogfood for two
   weeks.
6. Add meetings to the Plus route (chunked uploads with `purpose=meeting`).
7. Publish the terms, the fair-use caps and the privacy copy.
8. Add `plainsong-plus` to `MACOS_SIDECAR_CARGO_FEATURES`, flip
   `PLUS_LAUNCH_STATE` to `on`, and release.

## 7. What else would make Plainsong the most premium

Shipped in this round (round 3):

- **Voice Edit and Help me write**: select text, hold the key, say "make
  this friendlier"; or say what to write into an empty field.
- **Quiet speech**: the dictation noise gate is off (it clipped consonants)
  and quiet recordings are loudness-normalized before transcription.

Remaining gaps against Typeless, by expected user impact:

1. **100+ languages with auto-detect on a local model.** Parakeet covers
   25. Qwen3-ASR 1.7B and Granite 5 are the candidates; both need
   huggingface.co to pin, which this build machine cannot reach. Plus with
   Scribe v2 covers 90+ languages in the meantime.
2. **AI formatting on by default** once the cleanup model is downloaded,
   behind a readiness check so a first dictation never waits on a download.
3. **Windows.** Typeless and Wispr ship both platforms; the Rust side
   already compiles on Linux and has Windows speech stubs.
4. **Personal dictionary learning from corrections** without the user
   opening a screen (capture exists in `dictation_correction_capture`).
5. **Streaming captions for meetings on Plus** using Grok's streaming mode.

Premium ideas beyond parity:

- A weekly "words dictated, time saved" note (Typeless and Wispr both
  lean on this).
- Per-app voice presets that follow the user across Macs via the existing
  sync.
- A quality badge after each dictation showing which model ran, so Plus
  users see what they pay for.
