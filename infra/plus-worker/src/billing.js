// One entitlement flow over two billing providers. BILLING_PROVIDER picks
// "polar" (license keys and activation limits live at Polar) or "stripe"
// (the Worker issues keys and counts Macs itself, see stripe.js). Everything
// after activation, the token, fair use and the relay, is the same for both.

import { activateLicense, subscriptionStatusFromEvent, validateLicense, verifyWebhook } from "./polar.js";
import {
  MAX_ACTIVATIONS,
  licenseKeyFor,
  normalizeLicenseKey,
  sha256Hex,
  stripeChangeFromEvent,
  verifyStripeWebhook,
} from "./stripe.js";

export function billingProvider(env) {
  return String(env.BILLING_PROVIDER ?? "polar").trim() === "stripe" ? "stripe" : "polar";
}

/**
 * Checks a license and registers this Mac against it.
 * Returns { ok, customerId, activationId } or { ok: false, reason }.
 */
export async function activate(env, store, licenseKey, activationId, deviceLabel) {
  if (billingProvider(env) === "stripe") return activateStripe(store, licenseKey, activationId, deviceLabel);
  let activation = activationId;
  if (!activation) {
    const result = await activateLicense(env, licenseKey, deviceLabel);
    if (!result.ok) return result;
    activation = result.activationId;
  }
  const license = await validateLicense(env, licenseKey, activation);
  if (!license.ok) return license;
  return { ok: true, customerId: license.customerId, activationId: activation };
}

async function activateStripe(store, licenseKey, activationId, deviceLabel) {
  const keyHash = await sha256Hex(normalizeLicenseKey(licenseKey));
  const license = await store.getLicense(keyHash);
  if (!license) return { ok: false, reason: "invalid_license" };
  const activations = await store.listActivations(keyHash);
  if (activationId && activations.includes(activationId)) {
    return { ok: true, customerId: license.customerId, activationId };
  }
  if (activations.length >= MAX_ACTIVATIONS) return { ok: false, reason: "activation_limit" };
  const created = crypto.randomUUID();
  await store.addActivation(keyHash, created, String(deviceLabel ?? "Mac").slice(0, 100), new Date().toISOString());
  return { ok: true, customerId: license.customerId, activationId: created };
}

/** Issues (idempotently) the Stripe license for a customer and returns it. */
export async function issueStripeLicense(env, store, customerId) {
  const key = await licenseKeyFor(env.LICENSE_SECRET, customerId);
  await store.putLicense(await sha256Hex(key), customerId, new Date().toISOString());
  return key;
}

/**
 * Verifies and applies a billing webhook for the configured provider.
 * Returns false when the signature does not check out.
 */
export async function applyWebhook(env, store, request) {
  const body = await request.text();
  if (billingProvider(env) === "stripe") {
    const event = await verifyStripeWebhook(env.STRIPE_WEBHOOK_SECRET, request.headers.get("stripe-signature"), body);
    if (!event) return false;
    const change = stripeChangeFromEvent(event);
    if (change) {
      if (change.issueLicense) await issueStripeLicense(env, store, change.customerId);
      await store.setSubscriptionStatus(change.customerId, change.status, change.updatedAt);
    }
    return true;
  }
  const event = await verifyWebhook(env.POLAR_WEBHOOK_SECRET, request.headers, body);
  if (!event) return false;
  const change = subscriptionStatusFromEvent(event);
  if (change) await store.setSubscriptionStatus(change.customerId, change.status, change.updatedAt);
  return true;
}
