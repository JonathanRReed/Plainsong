# Competitive positioning & roadmap

This is the strategic north star, derived from a mid-2026 competitive scan and a
deliberately adversarial critique. It exists to keep the project focused on the
*one* thing that wins and to stop it sprawling into ten things a small team
can't ship. Read it before adding scope.

## The honest landscape (mid-2026)

- **"Free + local + open-source dictation" is now commodity.** Handy (MIT,
  Tauri/Rust, ~23.6k stars, truly cross-platform, biweekly releases) owns that
  identity. Being another free local dictation app is not a reason to exist.
- **Our headline differentiators are partly already taken.** superwhisper
  (closed/paid) already ships on-device streaming *and* meeting capture. Muesli
  makes the same dictation+meetings+local bet on Apple Silicon at ~0.13s — and
  is already Developer-ID signed and notarized, which we are not.
- **The cloud incumbents are foils, not direct threats.** Wispr Flow (~$2B
  raise, cloud-only, $15/mo, dictation-only) is wounded on trust (screenshot
  scandal, SOC-2 audit fraud, 2.7/5 Trustpilot, frequent outages). Granola
  (~$1.5B, meeting-notes leader) is cloud/closed/account-gated and took an
  April-2026 "private by default" backlash. Neither competes on our axis; both
  set category expectations and outspend us on marketing.

## The two existential truths the strategy must respect

1. **The moat cannot be the engine or the latency number.** Apple's
   SpeechAnalyzer (free, in macOS 26, streaming + diarization as a system API,
   ~55% faster than MacWhisper) commoditizes on-device transcription over time.
   Our measured ~593ms p50 (~74× real-time on 44s of real speech,
   `scripts/fixtures/real-speech-44s.wav`) is real but it's *batch* latency on
   `base.en` — the wrong metric to lead with for the "feel" segment. The durable moat is the
   **product** (the workflow, the combo done well) and the **trust posture**,
   not the millisecond count.
2. **There is no revenue model, and that reads as eventual abandonment.** The
   cautionary tale is in our own analysis: anarlog's founders pivoted to a
   closed-source product. "MIT, free, small team, no funding" is exactly the
   profile users distrust. We need a credible answer (see Sustainability) before
   the "durable, didn't-pivot" positioning is honest.

## The one thing that matters in the next 90 days

**Ship streaming partial transcription on Apple Silicon — words appearing as you
speak — signed and notarized, and launch on *that alone*.**

Not the three-in-one. The launch line is:
> "The open-source dictation that finally feels instant — words appear as you
> speak, fully on your Mac. Audit the source."

Why this and nothing else:
- It's our real exposure (batch dictation "reads a generation behind").
- The *open* field hasn't nailed it (superwhisper is the only one shipping it,
  and it's closed/paid).
- It's demoable in a 10-second GIF.
- It directly beats Handy's loudest complaints (2-5s post-stop lag, clipped
  first words, AirPods latency).

Bundle it with the two cheap credibility gates so launch doesn't look amateur:
- **Developer-ID signing + notarization** ($99/yr + ~a day). Mandatory.
- **Hardened privacy defaults + a one-page comparison** (see PRIVACY.md) — the
  one claim our architecture genuinely backs today.

These three (streaming + signing + privacy) are the entire near-term program.

## Deliberately deferred (do NOT do these before the streaming launch)

- **Cross-meeting memory / MCP "company memory."** Today this is a recall button
  with a test, not a product. Ship plain local full-text search over transcripts
  first and prove people use it before building an agent-facing API. Chasing
  Granola's enterprise wedge as a no-name OSS app is a trap.
- **AI cleanup / per-app context modes.** This competes head-on with Wispr's
  single most-praised feature, built over years. We'd ship a worse version and
  invite the comparison we lose. Defer until users say raw transcription quality
  is what's blocking them — and then do it on-device by default.
- **Tauri migration.** Real and worth doing — for cross-platform reach and to
  not look heavier than Handy — but it is not a user-facing emergency (we have no
  users to churn on idle RAM yet). Sequence it *after* streaming. Justify it
  honestly (cross-platform + credibility), not as a vanity RAM benchmark.
- **The three-in-one headline.** Meetings and memory are the *roadmap*, not the
  launch story, until they are demonstrably good. A visibly weak meeting tab makes
  the whole product read as "dictation app with a broken feature," which is worse
  than shipping dictation alone.

## Where we genuinely win (lean on these)

- **Privacy by architecture, verifiable in MIT source, with stricter defaults
  than even local rivals** (no dictation audio persisted; keys in Keychain not
  plaintext JSON like superwhisper; zero telemetry; no network except opt-in
  model download / BYOK cloud). This separates us from Wispr/Granola/superwhisper
  — though note it's a *tie* with Handy, so it is not enough alone.
- **Free forever, MIT, no account, no tier** — against $15/mo cloud tools.
- **The combo as a roadmap thesis** (dictation + bot-free meetings + local
  memory) that Wispr and Granola structurally cannot each match — once it's built
  and good.

## Meetings: the narrow, honest near-term play

Do not try to out-Granola Granola in 90 days. Be the local-first, no-bot,
no-account option for people who refuse cloud meeting notes: bot-free local
capture, unmistakable consent UX, trustworthy transcript review. Explicitly NOT
"company memory." Diarization on 3+ person calls is hard (even Granola is dinged
for it) — don't ship the meeting pillar until it's solid, or it undercuts the
whole pitch.

## Sustainability (the 2-year-survival answer)

To not be the abandonment story we position against, the core stays free, local,
and MIT — and revenue, if any, comes from things that don't compromise that:

- **GitHub Sponsors / OpenCollective** for the project, surfaced honestly.
- **An optional paid hosted-sync tier** (encrypted multi-device sync of
  settings/snippets/history) that is strictly opt-in and keeps the core fully
  functional offline — the VoiceInk/Epicenter pattern (open core + a paid
  convenience layer), never a paywall on local features.
- **Paid support / priority builds** for teams that want them.

The rule: nothing that makes the local-first experience worse to push a paid
tier. The funding model is itself part of the trust pitch.

## Risks to watch

- Arriving late as "another Handy clone" if we launch before streaming is real.
- Handy's solo-maintainer velocity shipping streaming or basic meetings first.
- Muesli out-executing on the same combo (it's already signed; we're not).
- Apple shipping a polished system dictation UX that commoditizes the engine.
- Mis-sequencing: trying to ship streaming + Tauri + memory + signing +
  cross-platform at once burns the one first impression. Sequence ruthlessly.
- Streaming-model licensing: prefer Parakeet v3 (CC-BY-4.0) as the safe default;
  verify any Nemotron/Foundry-Local terms before bundling in an MIT app.
