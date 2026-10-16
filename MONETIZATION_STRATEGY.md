# Plainsong — Monetization Strategy (opt-in cloud credits)
_Draft, Oct 15, 2026 (CT). Sources: read-only review of `JonathanRReed/Plainsong` (README) and https://plainsong.jonathanrreed.com, plus cited provider and competitor pricing. Re-verify before launch._

## 1. Recommendation (TL;DR)
- **The app stays free and MIT-licensed.** Local transcription (Parakeet / Whisper) stays the default. Bring-your-own-key stays available and free.
- **Add "Plainsong Cloud": opt-in prepaid credits**, not a monthly plan.
- **Proposed packs:** $10 and $25. Credits are deducted at the **published provider cost plus a disclosed markup** that covers payment fees and infrastructure. Proposal: provider cost × 1.25, shown on the pricing page per model.
- **No $5 pack:** a fixed $0.50 fee would eat ~15% of it on Polar or Lemon Squeezy.
- **Payment stack:** Polar or Lemon Squeezy for prepaid packs. Use Stripe Managed Payments only if eligibility for metered usage is confirmed (see §5).

## 2. Provider costs (cited; batch/pre-recorded unless noted)

| Provider / model | Published price | Per audio hour | Source |
|---|---|---|---|
| Groq whisper-large-v3-turbo | $0.04/hr (10-second minimum per request) | **$0.04** | https://console.groq.com/docs/model/whisper-large-v3-turbo |
| OpenAI gpt-4o-mini-transcribe | $0.003/min | $0.18 | https://developers.openai.com/api/docs/pricing |
| OpenAI gpt-transcribe | $0.0045/min | $0.27 | same |
| OpenAI gpt-4o-transcribe / Whisper | $0.006/min | $0.36 | same |
| OpenAI gpt-live-transcribe (streaming) | $0.017/min | $1.02 | same |
| Deepgram Nova-3 | $0.0043/min batch; $0.0048/min streaming (promo), $0.0077 regular | $0.258 / $0.288 | https://deepgram.com/pricing |
| AssemblyAI Universal-3.5 Pro | $0.21/hr batch; $0.45/hr realtime | $0.21 / $0.45 | https://www.assemblyai.com/pricing |
| ElevenLabs Scribe v2 | $0.22/hr; realtime $0.39/hr | $0.22 / $0.39 | https://elevenlabs.io/pricing/api |

AI cleanup and summaries (LLM tokens) are a separate cost. Price them per model from the provider's own pricing page at implementation time; I didn't include LLM rates here.

## 3. Competitors (cited)

| Product | Price | Source |
|---|---|---|
| Wispr Flow | Free: 2,000 words/week (desktop). Pro: $15/mo or $144/yr | https://wisprflow.ai/pricing |
| Superwhisper | Free (local). Pro: $8.49/mo, $84.99/yr, $249.99 lifetime | https://superwhisper.com/docs/billing/plans |
| MacWhisper | Free. Pro: €64 once (bring your own API keys) | https://www.macwhisper.com/, https://saynota.com/blog/macwhisper-vs-superwhisper |

**Positioning:** a heavy user dictating 20 hours a month on Groq costs **$0.80** in raw provider spend (20 × $0.04), or $1.00 at the proposed 1.25× markup. Wispr Flow Pro is $15/mo. The pitch is "free app, pay pennies for cloud, and see the receipt."

## 4. Credits vs monthly: pick credits

1. **Fees.** Fixed per-charge fees punish small recurring charges. Polar Starter and Lemon Squeezy charge 5% + $0.50; SMP is about 6.4% + $0.30. A $2/mo "at cost" plan would lose $0.60 on Polar (30%). A $10 pack loses $1.00 on Polar (10%) or $0.94 on SMP (9.4%).
   - Sources: https://polar.sh/docs/merchant-of-record/fees, https://www.lemonsqueezy.com/pricing, https://stripe.com/managed-payments
2. **Usage is spiky.** Meetings vary a lot. A flat monthly price would either overcharge light users or lose money on heavy ones, which contradicts "near-at-cost."
3. **It matches the brand.** "Nothing leaves your machine unless you send it, by name" fits a pay-as-you-go wallet better than an always-on subscription.
4. **Less to build.** No dunning, proration or renewal handling at first.

_Revisit later:_ an optional auto-top-up (charge $10 when the balance drops below $1) gets most of the convenience of a subscription.

## 5. Payment stack
- **Polar:** 5% + $0.50 on Starter; switch to Pro ($20/mo) above roughly $1,379/mo in sales. Disputes cost $15 each, and Polar may issue refunds itself within 60 days (https://polar.sh/docs/merchant-of-record/fees).
- **Lemon Squeezy:** 5% + $0.50, advertises usage-based billing (https://www.lemonsqueezy.com/pricing).
- **Stripe Managed Payments:** requires a "fully automated digital product" with an eligible tax code (https://docs.stripe.com/payments/managed-payments/eligibility). Confirm that prepaid transcription credits qualify before choosing it.
  - If Inkling is approved on SMP, using one Stripe account for both apps is simpler.
- **Credit expiry:** don't expire credits. Avoiding expiry is simpler and friendlier, though the state-law treatment of prepaid balances should be checked; that is not legal advice.
- **Refunds:** refund unused balance on request within 30 days (proposal).

## 6. The privacy promise has to change

Today's statements:
- README: "Optional cloud transcription and AI cleanup use your own provider keys… Those requests go to the selected provider, **not through a Plainsong server**."
- README: "no trial, paid tiers, or required account."
- Website commitment ii: "Nothing leaves your machine unless you send it, by name."

Cloud credits require a Plainsong relay holding Jonathan's provider keys, plus an account. Required changes:
1. Keep local and BYO-key as defaults, unchanged. State that **"Plainsong Cloud" is the only path through a Plainsong server**, and that it's off unless you buy credits and turn it on.
2. Publish relay data handling:
   - audio is streamed or proxied, not stored
   - transcripts are not stored
   - only metering metadata is logged (account, seconds, model, cost)
   - name the subprocessors (the chosen STT and LLM providers, payment provider, host)
   - give retention periods
3. Accounts collect an email only (magic link), so a wallet exists without passwords or personal profiles.
4. Update `PRIVACY.md`, the README "paid tiers" sentence, and the website's eight commitments. Commitment ii can stay true if the cloud provider is named in the UI at the moment of use.
5. Consider making the relay source public, consistent with the MIT and inspectability ethos. It doesn't have to be.

## 7. Implementation checklist

**Accounts**
- [ ] Email magic-link auth (e.g. on Cloudflare Workers + D1, as Jonathan's other projects use). The device stores a revocable token in the macOS Keychain, the same place BYO keys go today.
- [ ] Account page: balance, top-up, usage history, delete account (which also deletes usage records).

**Metering proxy (`infra/` new service, alongside `infra/updates-worker`)**
- [ ] Endpoint per provider (start with Groq; add OpenAI mini or Deepgram for quality or streaming). Server-held provider keys only.
- [ ] Pre-authorize: estimate audio seconds and reserve balance. Post-settle: bill on the provider-reported duration or tokens. Use the actual response (e.g. OpenAI's `usage.seconds`), and respect Groq's 10-second minimum.
- [ ] Price table with `provider_cost × markup`, versioned and published, with a change log.
- [ ] Per-account rate limits and a hard stop at zero balance (no negative balances).
- [ ] Never log audio, transcripts or prompts. Log only account id, model, seconds/tokens, cost and a timestamp.
- [ ] Abuse controls: max file length, concurrency cap, provider spend alarms.

**Billing**
- [ ] Polar or Lemon Squeezy checkout for $10 and $25 packs. A webhook credits the wallet idempotently, with a ledger table (`ledger(id, account, delta_cents, reason, ref, ts)`).
- [ ] Handle refund and dispute webhooks by debiting the remaining balance and flagging the account.
- [ ] Receipts and invoices from the merchant of record.

**App (`nautilus-bot/`)**
- [ ] New provider option "Plainsong Cloud" next to the BYO-key providers, off by default.
- [ ] Per-request disclosure of the provider and model, plus estimated cost before long meeting uploads.
- [ ] Balance indicator. Low-balance warning. Automatic fallback to local transcription when the balance is empty, never silently to another cloud.
- [ ] Settings copy and onboarding updated to the new privacy text.

**Before charging money**
- [ ] Fix known limits: hands-free mode not activating, no soak test on meetings longer than 45 seconds, unfinished updater journey (README). Ship 1.0.
- [ ] Publish the pricing page with the per-model cost table and its markup.
- [ ] Optional: a waitlist or "notify me" to measure demand before building billing.

## 8. Metrics to watch
- Cloud opt-in rate among active installs (opt-in telemetry only, or count accounts created).
- First top-up conversion and repeat top-up rate.
- Gross margin per pack after provider cost and payment fees. It should stay small and positive.
- Model mix (Groq vs premium) and average hours per account.
- Refunds and disputes; Polar charges $15 per dispute.
- Relay error rate and latency vs direct BYO-key.
