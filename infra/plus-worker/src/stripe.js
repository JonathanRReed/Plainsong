// Stripe billing. Stripe has no license keys, so the Worker issues them:
// a key is an HMAC of the Stripe customer id under LICENSE_SECRET, shown once
// on the checkout success page and re-derivable there, and D1 keeps only its
// SHA-256 so a database leak reveals no working key.
//
// API shapes follow the Stripe REST API (form-encoded requests); the webhook
// signature is `Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`.

const STRIPE_API = "https://api.stripe.com/v1";
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
const encoder = new TextEncoder();

export const MAX_ACTIVATIONS = 3;

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return crypto.subtle.sign("HMAC", key, encoder.encode(message));
}

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I

/** PLUS-XXXXX-XXXXX-XXXXX-XXXXX, stable for a customer under one secret. */
export async function licenseKeyFor(secret, customerId) {
  if (!secret || secret.length < 32) throw new Error("LICENSE_SECRET must be at least 32 characters");
  const bytes = new Uint8Array(await hmac(secret, `plainsong-plus-license:${customerId}`));
  const chars = [...bytes.subarray(0, 20)].map((byte) => KEY_ALPHABET[byte % KEY_ALPHABET.length]).join("");
  return `PLUS-${chars.match(/.{5}/g).join("-")}`;
}

export function normalizeLicenseKey(key) {
  return String(key ?? "").trim().toUpperCase();
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verifies a Stripe webhook. Returns the parsed event or null. */
export async function verifyStripeWebhook(secret, header, body, now = Date.now()) {
  if (!secret || !header) return null;
  const parts = header.split(",").map((part) => part.trim().split("="));
  const timestamp = parts.find(([name]) => name === "t")?.[1];
  const signatures = parts.filter(([name]) => name === "v1").map(([, value]) => value ?? "");
  if (!timestamp || signatures.length === 0) return null;
  if (Math.abs(now / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return null;
  const expected = toHex(await hmac(secret, `${timestamp}.${body}`));
  if (!signatures.some((candidate) => timingSafeEqual(candidate, expected))) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Stripe subscription status to the Worker's stored status. Stripe's own
 * "canceled" means the subscription has ended (a cancel at period end stays
 * "active" until then), so it maps to "revoked".
 */
export function stripeStatus(status) {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
    case "unpaid":
    case "incomplete_expired":
    case "paused":
      return "revoked";
    default:
      return null; // "incomplete": wait for the next event
  }
}

/** Entitlement changes from a Stripe event, or null for anything else. */
export function stripeChangeFromEvent(event) {
  const object = event?.data?.object ?? {};
  const updatedAt = new Date((event?.created ?? Date.now() / 1000) * 1000).toISOString();
  if (event?.type === "checkout.session.completed" && object.mode === "subscription" && object.customer) {
    return { customerId: object.customer, status: "active", updatedAt, issueLicense: true };
  }
  if (
    ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(
      event?.type,
    )
  ) {
    const status = event.type === "customer.subscription.deleted" ? "revoked" : stripeStatus(object.status);
    if (!status || !object.customer) return null;
    return { customerId: object.customer, status, updatedAt, issueLicense: false };
  }
  return null;
}

function form(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) body.append(key, String(value));
  }
  return body;
}

async function stripeRequest(env, method, path, fields) {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(fields ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: fields ? form(fields) : undefined,
  });
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data };
}

/** A hosted Checkout page for the monthly or yearly price. */
export async function createCheckout(env, origin, plan) {
  const price = plan === "yearly" ? env.STRIPE_PRICE_YEARLY : env.STRIPE_PRICE_MONTHLY;
  if (!price) return { ok: false };
  const result = await stripeRequest(env, "POST", "/checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": price,
    "line_items[0][quantity]": 1,
    allow_promotion_codes: "true",
    automatic_tax: env.STRIPE_AUTOMATIC_TAX === "true" ? "true" : undefined,
    success_url: `${origin}/v1/checkout/done?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: env.PLUS_RETURN_URL || origin,
  });
  return result.ok ? { ok: true, url: result.data.url } : { ok: false };
}

/** The customer behind a finished Checkout, or null if it is not paid. */
export async function completedCheckoutCustomer(env, sessionId) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId ?? "")) return null;
  const result = await stripeRequest(env, "GET", `/checkout/sessions/${sessionId}`);
  const session = result.data;
  if (!result.ok || session?.status !== "complete" || !session.customer) return null;
  if (!["paid", "no_payment_required"].includes(session.payment_status)) return null;
  return session.customer;
}

/** Stripe's customer portal: cancel, change plan, update the card, invoices. */
export async function createPortal(env, customerId) {
  const result = await stripeRequest(env, "POST", "/billing_portal/sessions", {
    customer: customerId,
    return_url: env.PLUS_RETURN_URL || undefined,
  });
  return result.ok ? result.data.url : null;
}
