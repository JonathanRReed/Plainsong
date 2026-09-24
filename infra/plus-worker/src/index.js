// Plainsong Plus: the paid, optional cloud tier. NOT LAUNCHED: every route
// but /v1/status answers 503 until PLUS_LAUNCH_STATE is "testers" or "on".
//
//   GET  /v1/status                 launch state and published fair-use caps
//   POST /v1/activate               license key -> 24 h entitlement token
//   POST /v1/checkout               a hosted checkout page (Stripe; Polar link)
//   GET  /v1/checkout/done          Stripe only: shows the new license key
//   POST /v1/billing/portal         manage or cancel the subscription
//   POST /v1/audio/transcriptions   OpenAI-shaped speech-to-text relay
//   POST /v1/chat/completions       OpenAI-shaped chat relay (two aliases)
//   GET  /v1/usage                  this month's usage against the caps
//   POST /v1/webhooks/<provider>    subscription status from Polar or Stripe
//
// BILLING_PROVIDER ("polar" | "stripe") picks the billing backend; see
// billing.js.
//
// Privacy: audio and text are streamed to the model provider and back. The
// Worker never logs or stores them; it stores usage counters and
// subscription status only (schema.sql).

import { signToken, verifyToken, TOKEN_LIFETIME_SECONDS } from "./token.js";
import { MONTHLY_CAPS, REQUEST_LIMITS, launchAllows, remainingAllowance, usagePeriod } from "./policy.js";
import { d1Store } from "./store.js";
import { statusGrantsAccess } from "./polar.js";
import { activate, applyWebhook, billingProvider, issueStripeLicense } from "./billing.js";
import { completedCheckoutCustomer, createCheckout, createPortal } from "./stripe.js";
import { chat, transcribe, UpstreamError } from "./providers.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function error(status, code, message) {
  return json({ error: { code, message } }, status);
}

const NOT_LAUNCHED = () =>
  error(503, "not_launched", "Plainsong Plus is not available yet. Local transcription keeps working.");

function storeFor(env) {
  return env.__store ?? d1Store(env.DB);
}

/** Seconds of audio in a PCM WAV, from its header; null when not a WAV. */
export function wavDurationSeconds(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let offset = 12;
  let byteRate = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt " && offset + 16 <= bytes.byteLength) byteRate = view.getUint32(offset + 16, true);
    if (id === "data" && byteRate) {
      const dataBytes = Math.min(size, bytes.byteLength - offset - 8);
      return dataBytes / byteRate;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

async function authenticate(request, env) {
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const claims = await verifyToken(token, env.TOKEN_SECRET);
  if (!claims) return { response: error(401, "invalid_token", "Sign in to Plainsong Plus again.") };
  if (!launchAllows(env, claims.sub)) return { response: NOT_LAUNCHED() };
  const status = await storeFor(env).getSubscriptionStatus(claims.sub);
  if (!statusGrantsAccess(status)) {
    return { response: error(402, "subscription_inactive", "Your Plainsong Plus subscription is not active.") };
  }
  return { customerId: claims.sub };
}

async function handleActivate(request, env) {
  const body = await request.json().catch(() => null);
  const licenseKey = typeof body?.licenseKey === "string" ? body.licenseKey.trim() : "";
  if (!licenseKey) return error(400, "missing_license", "A license key is required.");
  const activationId = typeof body?.activationId === "string" ? body.activationId : null;
  const store = storeFor(env);
  const license = await activate(env, store, licenseKey, activationId, body?.deviceLabel);
  if (!license.ok) {
    return license.reason === "activation_limit"
      ? error(403, "activation_limit", "This license is active on too many Macs. Remove one from your account.")
      : error(403, license.reason ?? "invalid_license", "That license key is not valid or has expired.");
  }
  if (!launchAllows(env, license.customerId)) return NOT_LAUNCHED();
  const status = await store.getSubscriptionStatus(license.customerId);
  if (!statusGrantsAccess(status)) {
    return error(402, "subscription_inactive", "Your Plainsong Plus subscription is not active.");
  }
  const token = await signToken({ sub: license.customerId, act: license.activationId }, env.TOKEN_SECRET);
  return json({
    token,
    activationId: license.activationId,
    expiresAt: new Date(Date.now() + TOKEN_LIFETIME_SECONDS * 1000).toISOString(),
  });
}

async function handleCheckout(request, env) {
  const body = await request.json().catch(() => ({}));
  const plan = body?.plan === "yearly" ? "yearly" : "monthly";
  if (billingProvider(env) === "polar") {
    const url = plan === "yearly" ? env.POLAR_CHECKOUT_URL_YEARLY : env.POLAR_CHECKOUT_URL_MONTHLY;
    return url ? json({ url }) : error(501, "checkout_unavailable", "Checkout is not set up yet.");
  }
  const checkout = await createCheckout(env, new URL(request.url).origin, plan);
  return checkout.ok ? json({ url: checkout.url }) : error(502, "checkout_unavailable", "Checkout is unavailable right now.");
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function page(title, message, detail = "") {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{font:16px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1f1d1a;background:#faf8f4}
@media (prefers-color-scheme:dark){body{color:#ece8e1;background:#161513}code{background:#26241f}}
code{display:block;font-size:1.25rem;letter-spacing:.04em;padding:1rem;border-radius:.5rem;background:#efe9df;user-select:all;margin:1rem 0}
</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${detail}</body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

async function handleCheckoutDone(request, env) {
  if (billingProvider(env) !== "stripe") return error(404, "not_found", "Unknown route.");
  const sessionId = new URL(request.url).searchParams.get("session_id");
  const customerId = await completedCheckoutCustomer(env, sessionId);
  if (!customerId) {
    return page("Payment not finished", "This checkout is not complete. If you were charged, contact support.");
  }
  const key = await issueStripeLicense(env, storeFor(env), customerId);
  return page(
    "Welcome to Plainsong Plus",
    "Copy this license key into Plainsong, Settings, Plainsong Plus. It works on up to three Macs. Opening this page again shows the same key.",
    `<code>${escapeHtml(key)}</code>`,
  );
}

async function handlePortal(request, env) {
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const claims = await verifyToken(token, env.TOKEN_SECRET);
  if (!claims) return error(401, "invalid_token", "Sign in to Plainsong Plus again.");
  if (billingProvider(env) === "polar") {
    return env.POLAR_PORTAL_URL ? json({ url: env.POLAR_PORTAL_URL }) : error(501, "portal_unavailable", "Not set up yet.");
  }
  const url = await createPortal(env, claims.sub);
  return url ? json({ url }) : error(502, "portal_unavailable", "The billing page is unavailable right now.");
}

async function handleTranscription(request, env, customerId) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > REQUEST_LIMITS.maxAudioBytes) return error(413, "audio_too_large", "That recording is too large.");
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") return error(400, "missing_audio", "No audio was sent.");
  if (file.size > REQUEST_LIMITS.maxAudioBytes) return error(413, "audio_too_large", "That recording is too large.");
  const purpose = form.get("purpose") === "meeting" ? "meeting" : "dictation";
  const bytes = new Uint8Array(await file.arrayBuffer());
  const estimate = wavDurationSeconds(bytes);
  const perRequest = purpose === "meeting" ? REQUEST_LIMITS.meetingSeconds : REQUEST_LIMITS.dictationSeconds;
  if (estimate !== null && estimate > perRequest) {
    return error(413, "audio_too_long", "That recording is longer than one request allows.");
  }

  const store = storeFor(env);
  const period = usagePeriod();
  const remaining = remainingAllowance(await store.getUsage(customerId, period));
  const allowance = purpose === "meeting" ? remaining.meetingSeconds : remaining.dictationSeconds;
  if (allowance <= 0 || (estimate !== null && estimate > allowance)) {
    return error(429, "fair_use_reached", "This month's Plainsong Plus allowance is used up. Local models take over.");
  }

  const result = await transcribe(env, new Blob([bytes], { type: file.type || "audio/wav" }), {
    language: typeof form.get("language") === "string" ? form.get("language") : null,
    keyterms: form.getAll("keyterm"),
  });
  const seconds = result.duration ?? estimate ?? 0;
  await store.addUsage(customerId, period, purpose === "meeting" ? { meetingSeconds: seconds } : { dictationSeconds: seconds });
  return json({ text: result.text, language: result.language, duration: seconds, words: result.words });
}

async function handleChat(request, env, customerId) {
  const body = await request.json().catch(() => null);
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || messages.length === 0 || messages.some((m) => typeof m?.content !== "string")) {
    return error(400, "invalid_messages", "Messages must be a non-empty list of text messages.");
  }
  const inputChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (inputChars > REQUEST_LIMITS.maxLlmInputChars) return error(413, "input_too_large", "That text is too long.");

  const store = storeFor(env);
  const period = usagePeriod();
  const remaining = remainingAllowance(await store.getUsage(customerId, period));
  if (remaining.llmTokens <= 0) {
    return error(429, "fair_use_reached", "This month's Plainsong Plus allowance is used up. Local models take over.");
  }
  const response = await chat(env, {
    model: body.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: Math.min(Number(body.max_tokens) || 2048, 8192),
    temperature: typeof body.temperature === "number" ? body.temperature : 0.2,
  });
  await store.addUsage(customerId, period, { llmTokens: response.usage.total_tokens });
  return json(response);
}

async function handleWebhook(request, env) {
  const applied = await applyWebhook(env, storeFor(env), request);
  return applied ? json({ received: true }, 202) : error(401, "invalid_signature", "Bad webhook signature.");
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const route = `${request.method} ${pathname}`;
    try {
      if (route === "GET /v1/status") {
        const state = String(env.PLUS_LAUNCH_STATE ?? "off");
        return json({ launched: state === "on", state, caps: MONTHLY_CAPS });
      }
      if (route === `POST /v1/webhooks/${billingProvider(env)}`) return await handleWebhook(request, env);
      if (String(env.PLUS_LAUNCH_STATE ?? "off") === "off") return NOT_LAUNCHED();
      if (route === "POST /v1/activate") return await handleActivate(request, env);
      if (route === "POST /v1/checkout") return await handleCheckout(request, env);
      if (route === "GET /v1/checkout/done") return await handleCheckoutDone(request, env);
      if (route === "POST /v1/billing/portal") return await handlePortal(request, env);

      const auth = await authenticate(request, env);
      if (auth.response) return auth.response;
      if (route === "POST /v1/audio/transcriptions") return await handleTranscription(request, env, auth.customerId);
      if (route === "POST /v1/chat/completions") return await handleChat(request, env, auth.customerId);
      if (route === "GET /v1/usage") {
        const usage = await storeFor(env).getUsage(auth.customerId, usagePeriod());
        return json({ period: usagePeriod(), usage, caps: MONTHLY_CAPS, remaining: remainingAllowance(usage) });
      }
      return error(404, "not_found", "Unknown route.");
    } catch (caught) {
      // Never echo request content; upstream failures say which provider.
      if (caught instanceof UpstreamError) {
        return error(502, "upstream_error", `The ${caught.provider} model is unavailable right now.`);
      }
      return error(500, "internal_error", "Something went wrong.");
    }
  },
};
