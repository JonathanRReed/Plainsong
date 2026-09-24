import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { wavDurationSeconds } from "../src/index.js";
import { memoryStore } from "../src/store.js";
import { signToken, verifyToken } from "../src/token.js";
import { MONTHLY_CAPS, usagePeriod } from "../src/policy.js";

const SECRET = "test-secret-that-is-at-least-32-chars!!";
let calls;
let upstream;

function wav(seconds, rate = 16000) {
  const dataBytes = Math.round(seconds * rate * 2);
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const write = (at, text) => [...text].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buffer);
}

function env(overrides = {}) {
  return {
    PLUS_LAUNCH_STATE: "on",
    TOKEN_SECRET: SECRET,
    POLAR_ORGANIZATION_ID: "org_1",
    POLAR_WEBHOOK_SECRET: "whsec_test",
    XAI_API_KEY: "xai",
    GROQ_API_KEY: "groq",
    ANTHROPIC_API_KEY: "anthropic",
    __store: memoryStore(),
    ...overrides,
  };
}

function call(e, method, path, { body, token, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  return worker.fetch(new Request(`https://plus.example${path}`, init), e);
}

function audioForm(seconds, extra = {}) {
  const form = new FormData();
  form.append("file", new Blob([wav(seconds)], { type: "audio/wav" }), "a.wav");
  for (const [key, value] of Object.entries(extra)) {
    for (const item of [].concat(value)) form.append(key, item);
  }
  return form;
}

beforeEach(() => {
  calls = [];
  upstream = {
    "api.polar.sh/v1/customer-portal/license-keys/activate": () => ({ status: 200, body: { id: "act_1" } }),
    "api.polar.sh/v1/customer-portal/license-keys/validate": () => ({
      status: 200,
      body: { id: "lic_1", status: "granted", customer_id: "cus_1", expires_at: null },
    }),
    "api.x.ai/v1/stt": () => ({ status: 200, body: { text: "hello there", language: "en", duration: 4.5, words: [] } }),
    "api.groq.com/openai/v1/chat/completions": () => ({
      status: 200,
      body: { choices: [{ message: { content: "Cleaned." } }], usage: { prompt_tokens: 10, completion_tokens: 3 } },
    }),
    "api.anthropic.com/v1/messages": () => ({
      status: 200,
      body: { content: [{ type: "text", text: "Summary." }], usage: { input_tokens: 20, output_tokens: 5 } },
    }),
    "api.elevenlabs.io/v1/speech-to-text": () => ({ status: 200, body: { text: "from fallback", words: [] } }),
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const key = `${url.host}${url.pathname}`;
    calls.push({ key, init });
    const handler = upstream[key];
    if (!handler) throw new Error(`unexpected fetch ${key}`);
    const { status, body } = handler(init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
});

test("nothing works while the launch state is off, and nothing reaches a provider", async () => {
  const e = env({ PLUS_LAUNCH_STATE: "off" });
  const status = await (await call(e, "GET", "/v1/status")).json();
  assert.equal(status.launched, false);
  assert.equal((await call(e, "POST", "/v1/activate", { body: { licenseKey: "K" } })).status, 503);
  const token = await signToken({ sub: "cus_1" }, SECRET);
  assert.equal((await call(e, "POST", "/v1/audio/transcriptions", { body: audioForm(2), token })).status, 503);
  assert.equal(calls.length, 0);
});

test("tester mode admits only listed customers", async () => {
  const outsider = env({ PLUS_LAUNCH_STATE: "testers", TESTER_CUSTOMER_IDS: "cus_other" });
  assert.equal((await call(outsider, "POST", "/v1/activate", { body: { licenseKey: "K" } })).status, 503);
  const tester = env({ PLUS_LAUNCH_STATE: "testers", TESTER_CUSTOMER_IDS: "cus_other, cus_1" });
  assert.equal((await call(tester, "POST", "/v1/activate", { body: { licenseKey: "K" } })).status, 200);
});

test("a license activates this Mac and returns a working entitlement token", async () => {
  const e = env();
  const response = await call(e, "POST", "/v1/activate", { body: { licenseKey: "K", deviceLabel: "Studio" } });
  assert.equal(response.status, 200);
  const { token, activationId } = await response.json();
  assert.equal(activationId, "act_1");
  assert.equal((await verifyToken(token, SECRET)).sub, "cus_1");
  const activate = calls.find((c) => c.key.endsWith("/activate"));
  assert.deepEqual(JSON.parse(activate.init.body), { key: "K", organization_id: "org_1", label: "Studio" });
});

test("a revoked license is refused", async () => {
  upstream["api.polar.sh/v1/customer-portal/license-keys/validate"] = () => ({
    status: 200,
    body: { status: "revoked", customer_id: "cus_1" },
  });
  assert.equal((await call(env(), "POST", "/v1/activate", { body: { licenseKey: "K" } })).status, 403);
});

test("transcription relays audio and dictionary terms, then meters the seconds", async () => {
  const e = env();
  const token = await signToken({ sub: "cus_1" }, SECRET);
  const response = await call(e, "POST", "/v1/audio/transcriptions", {
    token,
    body: audioForm(5, { keyterm: ["Plainsong", "Priya"], language: "en" }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.text, "hello there");
  const sent = calls.find((c) => c.key === "api.x.ai/v1/stt").init.body;
  assert.deepEqual(sent.getAll("keyterm"), ["Plainsong", "Priya"]);
  assert.equal(sent.get("language"), "en");
  const usage = await e.__store.getUsage("cus_1", usagePeriod());
  assert.equal(usage.dictationSeconds, 4.5);
});

test("fair use: an exhausted allowance answers 429 without calling the provider", async () => {
  const e = env();
  await e.__store.addUsage("cus_1", usagePeriod(), { dictationSeconds: MONTHLY_CAPS.dictationSeconds });
  const token = await signToken({ sub: "cus_1" }, SECRET);
  const response = await call(e, "POST", "/v1/audio/transcriptions", { token, body: audioForm(3) });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "fair_use_reached");
  assert.equal(calls.length, 0);
});

test("a clip longer than one dictation request allows is refused", async () => {
  const token = await signToken({ sub: "cus_1" }, SECRET);
  const response = await call(env(), "POST", "/v1/audio/transcriptions", { token, body: audioForm(11 * 60) });
  assert.equal(response.status, 413);
});

test("a server error from xAI falls back to ElevenLabs only when a key is set", async () => {
  upstream["api.x.ai/v1/stt"] = () => ({ status: 503, body: {} });
  const token = await signToken({ sub: "cus_1" }, SECRET);
  const withFallback = await call(env({ ELEVENLABS_API_KEY: "el" }), "POST", "/v1/audio/transcriptions", {
    token,
    body: audioForm(2),
  });
  assert.equal((await withFallback.json()).text, "from fallback");
  const without = await call(env(), "POST", "/v1/audio/transcriptions", { token, body: audioForm(2) });
  assert.equal(without.status, 502);
  assert.match((await without.json()).error.message, /xai/);
});

test("chat aliases route to Groq and Anthropic and meter tokens", async () => {
  const e = env();
  const token = await signToken({ sub: "cus_1" }, SECRET);
  const fast = await call(e, "POST", "/v1/chat/completions", {
    token,
    body: { model: "plainsong-fast", messages: [{ role: "system", content: "Clean." }, { role: "user", content: "um hi" }] },
  });
  assert.equal((await fast.json()).choices[0].message.content, "Cleaned.");
  const quality = await call(e, "POST", "/v1/chat/completions", {
    token,
    body: { model: "plainsong-quality", messages: [{ role: "system", content: "Summarize." }, { role: "user", content: "notes" }] },
  });
  assert.equal((await quality.json()).choices[0].message.content, "Summary.");
  const anthropicBody = JSON.parse(calls.find((c) => c.key === "api.anthropic.com/v1/messages").init.body);
  assert.equal(anthropicBody.system, "Summarize.");
  assert.deepEqual(anthropicBody.messages, [{ role: "user", content: "notes" }]);
  assert.equal((await e.__store.getUsage("cus_1", usagePeriod())).llmTokens, 13 + 25);
});

async function signedWebhook(secret, payload, timestamp = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`msg_1.${timestamp}.${body}`));
  const signature = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return {
    body,
    headers: { "webhook-id": "msg_1", "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${signature}` },
  };
}

test("a signed revocation webhook cuts off access; a forged one is ignored", async () => {
  const e = env();
  const token = await signToken({ sub: "cus_1" }, SECRET);
  const revoke = { type: "subscription.revoked", data: { customer_id: "cus_1", modified_at: "2026-10-01T00:00:00Z" } };

  const forged = await signedWebhook("wrong-secret", revoke);
  const forgedResponse = await worker.fetch(
    new Request("https://plus.example/v1/webhooks/polar", { method: "POST", body: forged.body, headers: forged.headers }),
    e,
  );
  assert.equal(forgedResponse.status, 401);

  const real = await signedWebhook("whsec_test", revoke);
  const realResponse = await worker.fetch(
    new Request("https://plus.example/v1/webhooks/polar", { method: "POST", body: real.body, headers: real.headers }),
    e,
  );
  assert.equal(realResponse.status, 202);
  const after = await call(e, "POST", "/v1/audio/transcriptions", { token, body: audioForm(2) });
  assert.equal(after.status, 402);
});

test("tampered and expired tokens are rejected", async () => {
  const token = await signToken({ sub: "cus_1" }, SECRET);
  const [header, , signature] = token.split(".");
  const forgedPayload = btoa(JSON.stringify({ sub: "cus_2", exp: 9999999999 })).replace(/=+$/, "");
  const forged = `${header}.${forgedPayload}.${signature}`;
  assert.equal((await call(env(), "GET", "/v1/usage", { token: forged })).status, 401);
  const old = await signToken({ sub: "cus_1" }, SECRET, Date.now() - 2 * 24 * 60 * 60 * 1000);
  assert.equal((await call(env(), "GET", "/v1/usage", { token: old })).status, 401);
  assert.equal((await call(env(), "GET", "/v1/usage", { token })).status, 200);
});

test("WAV duration comes from the header", () => {
  assert.equal(wavDurationSeconds(wav(3)), 3);
  assert.equal(wavDurationSeconds(new Uint8Array([1, 2, 3])), null);
});
