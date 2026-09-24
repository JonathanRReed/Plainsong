import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { memoryStore } from "../src/store.js";
import { licenseKeyFor, stripeStatus, verifyStripeWebhook } from "../src/stripe.js";

const TOKEN_SECRET = "test-secret-that-is-at-least-32-chars!!";
const LICENSE_SECRET = "license-secret-that-is-at-least-32-chars";
let calls;
let upstream;

function env(overrides = {}) {
  return {
    PLUS_LAUNCH_STATE: "on",
    BILLING_PROVIDER: "stripe",
    TOKEN_SECRET,
    LICENSE_SECRET,
    STRIPE_SECRET_KEY: "sk_test_1",
    STRIPE_WEBHOOK_SECRET: "whsec_stripe",
    STRIPE_PRICE_MONTHLY: "price_month",
    STRIPE_PRICE_YEARLY: "price_year",
    __store: memoryStore(),
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  upstream = {
    "POST api.stripe.com/v1/checkout/sessions": () => ({ status: 200, body: { url: "https://checkout.stripe.com/c/1" } }),
    "GET api.stripe.com/v1/checkout/sessions/cs_test_1": () => ({
      status: 200,
      body: { status: "complete", payment_status: "paid", customer: "cus_s1" },
    }),
    "POST api.stripe.com/v1/billing_portal/sessions": () => ({ status: 200, body: { url: "https://billing.stripe.com/p/1" } }),
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const key = `${init.method ?? "GET"} ${url.host}${url.pathname}`;
    calls.push({ key, init });
    const handler = upstream[key];
    if (!handler) throw new Error(`unexpected fetch ${key}`);
    const { status, body } = handler(init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
});

async function stripeSigned(secret, event, timestamp = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(event);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request("https://plus.example/v1/webhooks/stripe", {
    method: "POST",
    body,
    headers: { "stripe-signature": `t=${timestamp},v1=${hex}` },
  });
}

const completed = { type: "checkout.session.completed", created: 1790000000, data: { object: { mode: "subscription", customer: "cus_s1" } } };

function activate(e, licenseKey, activationId) {
  return worker.fetch(
    new Request("https://plus.example/v1/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ licenseKey, activationId, deviceLabel: "Mac" }),
    }),
    e,
  );
}

test("license keys are stable per customer, readable, and need a long secret", async () => {
  const key = await licenseKeyFor(LICENSE_SECRET, "cus_s1");
  assert.match(key, /^PLUS-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal(key, await licenseKeyFor(LICENSE_SECRET, "cus_s1"));
  assert.notEqual(key, await licenseKeyFor(LICENSE_SECRET, "cus_s2"));
  await assert.rejects(licenseKeyFor("short", "cus_s1"));
});

test("only a correctly signed, fresh Stripe webhook is accepted", async () => {
  const good = await stripeSigned("whsec_stripe", completed);
  assert.ok(await verifyStripeWebhook("whsec_stripe", good.headers.get("stripe-signature"), await good.text()));
  const forged = await stripeSigned("wrong", completed);
  assert.equal(await verifyStripeWebhook("whsec_stripe", forged.headers.get("stripe-signature"), await forged.text()), null);
  const stale = await stripeSigned("whsec_stripe", completed, Math.floor(Date.now() / 1000) - 3600);
  assert.equal(await verifyStripeWebhook("whsec_stripe", stale.headers.get("stripe-signature"), await stale.text()), null);
});

test("checkout completes, the key activates up to three Macs, and a deleted subscription cuts access", async () => {
  const e = env();
  assert.equal((await worker.fetch(await stripeSigned("whsec_stripe", completed), e)).status, 202);
  const key = await licenseKeyFor(LICENSE_SECRET, "cus_s1");
  // No plaintext key is stored.
  assert.ok(![...e.__store.licenses.keys()].includes(key));

  const first = await activate(e, key.toLowerCase());
  assert.equal(first.status, 200);
  const { activationId } = await first.json();
  assert.equal((await activate(e, key, activationId)).status, 200, "re-activating the same Mac is free");
  assert.equal((await activate(e, key)).status, 200);
  assert.equal((await activate(e, key)).status, 200);
  const fourth = await activate(e, key);
  assert.equal(fourth.status, 403);
  assert.equal((await fourth.json()).error.code, "activation_limit");
  assert.equal((await activate(e, "PLUS-AAAAA-AAAAA-AAAAA-AAAAA")).status, 403);

  const deleted = { type: "customer.subscription.deleted", created: 1790000100, data: { object: { customer: "cus_s1", status: "canceled" } } };
  await worker.fetch(await stripeSigned("whsec_stripe", deleted), e);
  assert.equal((await activate(e, key, activationId)).status, 402);
});

test("a cancel at period end keeps access until Stripe ends the subscription", () => {
  assert.equal(stripeStatus("active"), "active");
  assert.equal(stripeStatus("trialing"), "active");
  assert.equal(stripeStatus("past_due"), "past_due");
  assert.equal(stripeStatus("canceled"), "revoked");
  assert.equal(stripeStatus("incomplete"), null);
});

test("checkout, the success page and the billing portal go through Stripe", async () => {
  const e = env();
  const checkout = await worker.fetch(
    new Request("https://plus.example/v1/checkout", { method: "POST", body: JSON.stringify({ plan: "yearly" }) }),
    e,
  );
  assert.equal((await checkout.json()).url, "https://checkout.stripe.com/c/1");
  const sent = new URLSearchParams(calls[0].init.body);
  assert.equal(sent.get("line_items[0][price]"), "price_year");
  assert.equal(sent.get("mode"), "subscription");
  assert.match(sent.get("success_url"), /\/v1\/checkout\/done\?session_id=\{CHECKOUT_SESSION_ID\}$/);

  const done = await worker.fetch(new Request("https://plus.example/v1/checkout/done?session_id=cs_test_1"), e);
  const html = await done.text();
  assert.ok(html.includes(await licenseKeyFor(LICENSE_SECRET, "cus_s1")));

  const bad = await worker.fetch(new Request("https://plus.example/v1/checkout/done?session_id=../../x"), e);
  assert.match(await bad.text(), /not finished/);

  // Access starts with the subscription webhook, not with the success page.
  assert.equal((await activate(e, await licenseKeyFor(LICENSE_SECRET, "cus_s1"))).status, 402);
  await worker.fetch(await stripeSigned("whsec_stripe", completed), e);
  const activation = await (await activate(e, await licenseKeyFor(LICENSE_SECRET, "cus_s1"))).json();
  const portal = await worker.fetch(
    new Request("https://plus.example/v1/billing/portal", { method: "POST", headers: { authorization: `Bearer ${activation.token}` } }),
    e,
  );
  assert.equal((await portal.json()).url, "https://billing.stripe.com/p/1");
  assert.equal(new URLSearchParams(calls.at(-1).init.body).get("customer"), "cus_s1");
});

test("under Polar billing a Stripe webhook is not a route and changes nothing", async () => {
  const polar = env({ BILLING_PROVIDER: "polar" });
  const response = await worker.fetch(await stripeSigned("whsec_stripe", completed), polar);
  assert.notEqual(response.status, 202);
  assert.equal(polar.__store.licenses.size, 0);
  assert.equal(await polar.__store.getSubscriptionStatus("cus_s1"), null);
});
