# Plainsong Plus Worker (not launched)

The optional paid tier: $10/month for hosted speech-to-text and cleanup
models. Plainsong stays free and local-first; Plus is a model provider the
user can pick, like a BYOK provider without the key.

Nothing here is live. The Worker answers 503 on every route but `/v1/status`
while `PLUS_LAUNCH_STATE` is `off`, and the app side only exists in sidecar
builds with the `plainsong-plus` Cargo feature, which no release enables.
Plan, model picks and economics: `nautilus-bot/docs/plainsong-plus.md`.

## Routes

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /v1/status` | none | Launch state and the fair-use caps |
| `POST /v1/activate` | license key | Polar license key (and activation id) to a 24 h token |
| `POST /v1/audio/transcriptions` | token | Multipart `file`, `purpose` (`dictation`/`meeting`), `language`, repeated `keyterm` |
| `POST /v1/chat/completions` | token | OpenAI-shaped chat; `model` is `plainsong-fast` or `plainsong-quality` |
| `GET /v1/usage` | token | This month's usage and what is left |
| `POST /v1/webhooks/polar` | Standard Webhooks signature | Subscription status changes |

Models sit behind the aliases in `src/providers.js`, so they can change
without an app update.

## Launch states

- `off` (default): nobody gets in. Webhooks are still recorded.
- `testers`: only the Polar customer ids in `TESTER_CUSTOMER_IDS`.
- `on`: anyone with a granted license and an active, canceled-but-paid, or
  past-due subscription.

## Setup

```bash
cd infra/plus-worker
npm test                                   # node --test, no install needed
npx wrangler@4 d1 create plainsong-plus    # paste the id into wrangler.toml
npx wrangler@4 d1 execute plainsong-plus --remote --file schema.sql
npx wrangler@4 secret put TOKEN_SECRET     # 32+ random characters
npx wrangler@4 secret put POLAR_WEBHOOK_SECRET
npx wrangler@4 secret put XAI_API_KEY
npx wrangler@4 secret put GROQ_API_KEY
npx wrangler@4 secret put ANTHROPIC_API_KEY
npx wrangler@4 secret put ELEVENLABS_API_KEY   # optional fallback
npx wrangler@4 deploy
```

In Polar: create a $10/month product (and a $96/year one) with the license
key benefit, activation limit 3, then add a webhook to
`https://<worker>/v1/webhooks/polar` for the `subscription.*` events. Set
`POLAR_ORGANIZATION_ID` and, once tested in sandbox, `POLAR_ENVIRONMENT =
"production"`.

## Privacy

Audio and text pass through to the model provider and back. The Worker does
not log or store them. D1 holds usage counters per customer per month and
subscription status, nothing else (`schema.sql`). Before launch, confirm
zero-retention terms with each provider and list them in `PRIVACY.md`.
