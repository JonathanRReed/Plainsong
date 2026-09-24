// Polar (merchant of record) integration: license keys and webhooks.
// Endpoint and field names follow @polar-sh/sdk 0.49
// (/v1/customer-portal/license-keys/{activate,validate}); webhooks use the
// Standard Webhooks signature scheme with the secret's UTF-8 bytes as key.

const POLAR_API = { production: "https://api.polar.sh", sandbox: "https://sandbox-api.polar.sh" };

function apiBase(env) {
  return env.POLAR_ENVIRONMENT === "sandbox" ? POLAR_API.sandbox : POLAR_API.production;
}

async function polarPost(env, path, body) {
  const response = await fetch(`${apiBase(env)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data };
}

/** Registers this device against the license (Polar caps activations). */
export async function activateLicense(env, key, deviceLabel) {
  const result = await polarPost(env, "/v1/customer-portal/license-keys/activate", {
    key,
    organization_id: env.POLAR_ORGANIZATION_ID,
    label: String(deviceLabel ?? "Mac").slice(0, 100),
  });
  if (!result.ok) return { ok: false, reason: result.status === 403 ? "activation_limit" : "invalid_license" };
  return { ok: true, activationId: result.data?.id };
}

/** Validates a license (and its activation). Granted and unexpired only. */
export async function validateLicense(env, key, activationId, now = Date.now()) {
  const result = await polarPost(env, "/v1/customer-portal/license-keys/validate", {
    key,
    organization_id: env.POLAR_ORGANIZATION_ID,
    activation_id: activationId ?? null,
  });
  const license = result.data;
  if (!result.ok || !license || license.status !== "granted") return { ok: false, reason: "invalid_license" };
  if (license.expires_at && Date.parse(license.expires_at) <= now) return { ok: false, reason: "expired" };
  return { ok: true, customerId: license.customer_id, licenseId: license.id };
}

const encoder = new TextEncoder();
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Standard Webhooks verification. Returns the parsed event or null. */
export async function verifyWebhook(secret, headers, body, now = Date.now()) {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!secret || !id || !timestamp || !signatures) return null;
  if (Math.abs(now / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return null;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${id}.${timestamp}.${body}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  const matched = signatures
    .split(" ")
    .map((entry) => entry.split(",")[1] ?? "")
    .some((candidate) => timingSafeEqual(candidate, expected));
  if (!matched) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Subscription events that change entitlement, mapped to a stored status. */
export function subscriptionStatusFromEvent(event) {
  const statusByType = {
    "subscription.active": "active",
    "subscription.uncanceled": "active",
    "subscription.created": null,
    "subscription.updated": null,
    "subscription.canceled": "canceled", // still paid through the period
    "subscription.past_due": "past_due",
    "subscription.revoked": "revoked",
  };
  if (!(event?.type in statusByType)) return null;
  const data = event.data ?? {};
  const status = statusByType[event.type] ?? data.status ?? null;
  const customerId = data.customer_id ?? data.customer?.id ?? null;
  if (!status || !customerId) return null;
  return { customerId, status, updatedAt: data.modified_at ?? data.created_at ?? new Date().toISOString() };
}

/** Statuses that still grant access. Canceled keeps access until revoked. */
export function statusGrantsAccess(status) {
  return status === null || status === "active" || status === "canceled" || status === "past_due";
}
