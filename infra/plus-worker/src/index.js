// Plainsong Plus: the paid, optional cloud tier. NOT LAUNCHED: every route
// but /v1/status answers 503 until PLUS_LAUNCH_STATE is "testers" or "on".
//
//   GET  /v1/status                 launch state and published fair-use caps
//   POST /v1/activate               license key -> 24 h entitlement token
//   POST /v1/audio/transcriptions   OpenAI-shaped speech-to-text relay
//   POST /v1/chat/completions       OpenAI-shaped chat relay (two aliases)
//   GET  /v1/usage                  this month's usage against the caps
//   POST /v1/webhooks/polar         subscription status from Polar
//
// Privacy: audio and text are streamed to the model provider and back. The
// Worker never logs or stores them; it stores usage counters and
// subscription status only (schema.sql).

import { signToken, verifyToken, TOKEN_LIFETIME_SECONDS } from "./token.js";
import { MONTHLY_CAPS, REQUEST_LIMITS, launchAllows, remainingAllowance, usagePeriod } from "./policy.js";
import { d1Store } from "./store.js";
import {
  activateLicense,
  statusGrantsAccess,
  subscriptionStatusFromEvent,
  validateLicense,
  verifyWebhook,
} from "./polar.js";
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
  let activationId = typeof body?.activationId === "string" ? body.activationId : null;
  if (!activationId) {
    const activation = await activateLicense(env, licenseKey, body?.deviceLabel);
    if (!activation.ok) {
      return activation.reason === "activation_limit"
        ? error(403, "activation_limit", "This license is active on too many Macs. Remove one from your account.")
        : error(403, "invalid_license", "That license key is not valid.");
    }
    activationId = activation.activationId;
  }
  const license = await validateLicense(env, licenseKey, activationId);
  if (!license.ok) return error(403, license.reason, "That license key is not valid or has expired.");
  if (!launchAllows(env, license.customerId)) return NOT_LAUNCHED();
  const status = await storeFor(env).getSubscriptionStatus(license.customerId);
  if (!statusGrantsAccess(status)) {
    return error(402, "subscription_inactive", "Your Plainsong Plus subscription is not active.");
  }
  const token = await signToken({ sub: license.customerId, act: activationId }, env.TOKEN_SECRET);
  return json({
    token,
    activationId,
    expiresAt: new Date(Date.now() + TOKEN_LIFETIME_SECONDS * 1000).toISOString(),
  });
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
  const body = await request.text();
  const event = await verifyWebhook(env.POLAR_WEBHOOK_SECRET, request.headers, body);
  if (!event) return error(401, "invalid_signature", "Bad webhook signature.");
  const change = subscriptionStatusFromEvent(event);
  if (change) await storeFor(env).setSubscriptionStatus(change.customerId, change.status, change.updatedAt);
  return json({ received: true }, 202);
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
      if (route === "POST /v1/webhooks/polar") return await handleWebhook(request, env);
      if (String(env.PLUS_LAUNCH_STATE ?? "off") === "off") return NOT_LAUNCHED();
      if (route === "POST /v1/activate") return await handleActivate(request, env);

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
