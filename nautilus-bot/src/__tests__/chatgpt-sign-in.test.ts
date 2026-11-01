import { beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import { createChatGPTSignIn, ChatGPTSignInError } from "../../electron/chatgpt-sign-in";

const host = `urn:uuid:${randomUUID()}`;
const clientId = "oaiapp_plainsong_test";
const issuer = "https://auth.openai.com";
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
let otherSigning: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => {
  signing = await generateKeyPair("RS256");
  otherSigning = await generateKeyPair("RS256");
  jwk = { ...await exportJWK(signing.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
});
interface FixtureOptions {
  claims?: JWTPayload;
  wrongSignature?: boolean;
  scopes?: string;
  tokens?: Record<string, unknown>;
  callback?: (url: URL) => URL;
  remote?: () => boolean;
  afterCallback?: () => void;
  tokenResponse?: () => Response;
  onJWKS?: () => void;
}
function fixture(options: FixtureOptions = {}) {
  let authorization!: URL;
  const rememberRegistration = vi.fn().mockResolvedValue(undefined);
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/.well-known/jwks.json")) { options.onJWKS?.(); return Response.json({ keys: [jwk] }); }
    expect(url).toBe(`${issuer}/api/accounts/oauth/token`);
    if (options.tokenResponse) return options.tokenResponse();
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({ iss: issuer, aud: clientId, sub: "test-account", nonce: authorization.searchParams.get("nonce"), iat: now, exp: now + 3600, ...options.claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(options.wrongSignature ? otherSigning.privateKey : signing.privateKey);
    return Response.json({ id_token: idToken, access_token: "dummy-access-token", refresh_token: "dummy-refresh-token", token_type: "Bearer", expires_in: 3600,
      scope: options.scopes ?? "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct", ...options.tokens });
  });
  const openAuthorizationURL = vi.fn(async (value: string) => {
    authorization = new URL(value);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ state: authorization.searchParams.get("state")!, code: "dummy-code", client_id: clientId }).toString();
    const response = await fetch(options.callback ? options.callback(callback) : callback);
    await response.text();
    options.afterCallback?.();
  });
  const auth = createChatGPTSignIn({ remoteProcessingEnabled: options.remote ?? (() => true), openAuthorizationURL, rememberRegistration, fetch: fetchMock as typeof fetch });
  return { auth, fetchMock, openAuthorizationURL, rememberRegistration, authorization: () => authorization };
}

describe("official ChatGPT desktop sign-in", () => {
  it("binds a live loopback callback before opening authorization and exchanges the matching PKCE verifier", async () => {
    const f = fixture();
    const record = await f.auth.signIn(host);
    const auth = f.authorization();
    expect(auth.origin + auth.pathname).toBe(`${issuer}/api/accounts/authorize`);
    expect(auth.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(auth.searchParams.get("agent_name_hint")).toBe("Plainsong");
    expect(auth.searchParams.get("ext_agent_host_id")).toBe(host);
    expect(auth.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    const callback = new URL(auth.searchParams.get("redirect_uri")!);
    expect(callback.hostname).toBe("127.0.0.1"); expect(callback.pathname).toBe("/auth/callback");
    const request = f.fetchMock.mock.calls[0][1]!;
    const form = new URLSearchParams(request.body as string);
    expect(form.get("client_id")).toBe(clientId);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("redirect_uri")).toBe(callback.href);
    expect(form.has("client_secret")).toBe(false);
    expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(auth.searchParams.get("code_challenge"));
    expect(form.get("resource")).toBe("https://api.openai.com/v1");
    expect(request.redirect).toBe("error");
    expect(f.rememberRegistration).toHaveBeenCalledWith({ clientId, hostId: host });
    expect(f.rememberRegistration.mock.invocationCallOrder[0]).toBeLessThan(f.fetchMock.mock.invocationCallOrder[0]);
    expect(record).toMatchObject({ issuer, hostId: host, clientId, subject: "test-account", planEnabled: true });
    await expect(fetch(callback)).rejects.toThrow(); // Listener has closed.
  });

  it("creates fresh state, nonce and verifier for every attempt", async () => {
    const f = fixture(); await f.auth.signIn(host); const first = f.authorization();
    await f.auth.signIn(host); const second = f.authorization();
    for (const name of ["state", "nonce", "code_challenge"]) expect(first.searchParams.get(name)).not.toBe(second.searchParams.get(name));
  });

  it("requests renewed plan consent only for the explicit permission-upgrade path", async () => {
    const f = fixture();
    await f.auth.signIn(host, { clientId, hostId: host, subject: "test-account" }, { requestPlanConsent: true });
    expect(f.authorization().searchParams.get("prompt")).toBe("consent");
    await f.auth.signIn(host, { clientId, hostId: host, subject: "test-account" });
    expect(f.authorization().searchParams.has("prompt")).toBe(false);
  });

  it("reuses an issued registration and verifies the selected account subject", async () => {
    const f = fixture({ callback: url => { url.searchParams.delete("client_id"); return url; } });
    await f.auth.signIn(host, { clientId, hostId: host, subject: "test-account", email: "test@example.invalid", idToken: "retained-test-token" });
    expect(f.authorization().searchParams.get("client_id")).toBe(clientId);
    expect(f.authorization().searchParams.has("agent_name_hint")).toBe(false);
    expect(f.authorization().searchParams.get("id_token_hint")).toBe("retained-test-token");
    expect(f.authorization().searchParams.get("login_hint")).toBe("test@example.invalid");
    await expect(fixture().auth.signIn(host, { clientId, hostId: host, subject: "another-account" })).rejects.toMatchObject({ code: "invalid_identity" });
  });

  it("rejects a different returning client without saving or exchanging it", async () => {
    const f = fixture({ callback: url => { url.searchParams.set("client_id", "oaiapp_other"); return url; } });
    await expect(f.auth.signIn(host, { clientId, hostId: host, subject: "test-account" })).rejects.toMatchObject({ code: "invalid_callback" });
    expect(f.fetchMock).not.toHaveBeenCalled(); expect(f.rememberRegistration).not.toHaveBeenCalled();
  });

  it.each(["missing", "dynamic", "duplicate"])("rejects %s registration callback IDs", async kind => {
    const f = fixture({ callback: url => {
      if (kind === "missing") url.searchParams.delete("client_id");
      if (kind === "dynamic") url.searchParams.set("client_id", "dynamic_agent_client");
      if (kind === "duplicate") url.searchParams.append("client_id", "oaiapp_other");
      return url;
    } });
    await expect(f.auth.signIn(host, undefined, { timeoutMs: 70 })).rejects.toMatchObject({ code: kind === "duplicate" ? "expired" : "invalid_callback" });
    expect(f.fetchMock).not.toHaveBeenCalled(); expect(f.rememberRegistration).not.toHaveBeenCalled();
  });

  it.each([
    { iss: "https://untrusted.example" }, { aud: "oaiapp_other" }, { nonce: "wrong-nonce" },
    { exp: 1 }, { iat: Math.floor(Date.now() / 1000) + 10000 }, { sub: "" },
    { aud: [clientId, "oaiapp_other"], azp: "oaiapp_other" },
  ])("rejects a signed ID token with invalid claims %j", async claims => {
    await expect(fixture({ claims }).auth.signIn(host)).rejects.toMatchObject({ code: "invalid_identity" });
  });
  it("verifies the signature against the fixed official JWKS endpoint", async () => {
    const f = fixture({ wrongSignature: true });
    await expect(f.auth.signIn(host)).rejects.toMatchObject({ code: "invalid_identity" });
    expect(String(f.fetchMock.mock.calls[1][0])).toBe(`${issuer}/.well-known/jwks.json`);
    expect(f.fetchMock.mock.calls[1][1]!.redirect).toBe("error");
  });

  it("retains a newly issued registration when a code expires and accepts its retry before any verified identity exists", async () => {
    const first = fixture({ tokenResponse: () => Response.json({ error: "invalid_grant", error_description: "private-provider-content" }, { status: 400 }) });
    await expect(first.auth.signIn(host)).rejects.toMatchObject({ code: "expired" });
    expect(first.rememberRegistration).toHaveBeenCalledWith({ clientId, hostId: host });
    const retry = fixture();
    expect((await retry.auth.signIn(host, { clientId, hostId: host })).subject).toBe("test-account");
    expect(retry.authorization().searchParams.get("client_id")).toBe(clientId);
    expect(retry.authorization().searchParams.has("agent_name_hint")).toBe(false);
  });

  it.each([
    { hostId: `urn:uuid:${randomUUID()}` }, { email: "x".repeat(321) }, { email: "private\ncontent" }, { idToken: "x".repeat(16385) },
  ])("rejects mismatched hosts and malformed stored hints %j without opening the browser", async changes => {
    const f = fixture();
    await expect(f.auth.signIn(host, { clientId, hostId: host, subject: "test-account", ...changes })).rejects.toMatchObject({ code: "invalid_registration" });
    expect(f.openAuthorizationURL).not.toHaveBeenCalled(); expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a signed oversized ID token before creating an unusable returning registration", async () => {
    await expect(fixture({ claims: { large_claim: "x".repeat(20000) } }).auth.signIn(host)).rejects.toMatchObject({ code: "invalid_token_response" });
  });
  it.each(["é".repeat(200) + "@example.invalid", "private\ncontent@example.invalid"])("omits invalid signed email hints and keeps the verified registration reusable", async email => {
    const f = fixture({ claims: { email } });
    const first = await f.auth.signIn(host);
    expect(first.email).toBeUndefined();
    const second = await f.auth.signIn(host, first);
    expect(second.subject).toBe(first.subject);
    expect(f.authorization().searchParams.has("login_hint")).toBe(false);
  });

  it("anchors access expiry to token receipt instead of extending it by identity verification time", async () => {
    const started = Date.now();
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    const f = fixture({ onJWKS: () => { clock = vi.spyOn(Date, "now").mockReturnValue(started + 60_000); } });
    try {
      const record = await f.auth.signIn(host);
      expect(record.accessExpiresAt).toBeLessThan(started + 3600_000 + 10_000);
    } finally { clock?.mockRestore(); }
  });

  it("does not enable plan inference from identity-only scopes", async () => {
    const record = await fixture({ scopes: "openid profile email" }).auth.signIn(host);
    expect(record.planEnabled).toBe(false);
  });
  it.each([{ expires_in: -1 }, { token_type: "Other" }, { access_token: "dummy\ntoken" }, { scope: undefined }, { id_token: "" }])("rejects malformed token fields %j", async tokens => {
    await expect(fixture({ tokens }).auth.signIn(host)).rejects.toMatchObject({ code: "invalid_token_response" });
  });

  it("rejects denial after validating state and never echoes service content", async () => {
    const f = fixture({ callback: url => { url.searchParams.set("error", "access_denied"); url.searchParams.set("error_description", "private-provider-content"); return url; } });
    await expect(f.auth.signIn(host)).rejects.toMatchObject({ code: "denied" });
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("ignores invalid state and duplicate fields while allowing the matching callback", async () => {
    let callback!: URL;
    const f = fixture();
    const auth = createChatGPTSignIn({ remoteProcessingEnabled: () => true, rememberRegistration: f.rememberRegistration, fetch: f.fetchMock as typeof fetch,
      openAuthorizationURL: async value => {
        const url = new URL(value); callback = new URL(url.searchParams.get("redirect_uri")!);
        const wrong = new URL(callback); wrong.search = "state=wrong&error=access_denied";
        expect((await fetch(wrong)).status).toBe(400);
        // Use fixture's opener to produce a signed token with this attempt's nonce.
        await f.openAuthorizationURL(value);
      } });
    expect((await auth.signIn(host)).planEnabled).toBe(true);
  });

  it("consumes a valid callback only once while exchange is still pending", async () => {
    const f = fixture();
    const auth = createChatGPTSignIn({ remoteProcessingEnabled: () => true, rememberRegistration: f.rememberRegistration, fetch: f.fetchMock as typeof fetch,
      openAuthorizationURL: async value => {
        const url = new URL(value);
        await f.openAuthorizationURL(value);
        const replay = new URL(url.searchParams.get("redirect_uri")!);
        replay.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "another-code", client_id: clientId }).toString();
        expect((await fetch(replay)).status).toBe(400);
      } });
    await auth.signIn(host);
    expect(f.rememberRegistration).toHaveBeenCalledTimes(1);
    expect(f.fetchMock.mock.calls.filter(call => String(call[0]).endsWith("/oauth/token"))).toHaveLength(1);
  });

  it("rejects simultaneous sign-in attempts and releases the listener after timeout", async () => {
    let callback: string | undefined;
    const auth = createChatGPTSignIn({ remoteProcessingEnabled: () => true, rememberRegistration: async () => {},
      openAuthorizationURL: async value => { callback = new URL(value).searchParams.get("redirect_uri")!; return new Promise<void>(() => {}); } });
    const first = auth.signIn(host, undefined, { timeoutMs: 50 });
    const failed = expect(first).rejects.toMatchObject({ code: "expired" });
    await expect(auth.signIn(host)).rejects.toMatchObject({ code: "in_progress" });
    await failed;
    expect(callback).toBeDefined(); await expect(fetch(callback!)).rejects.toThrow();
  });

  it("does not open a browser or request credentials when cloud is disabled or already cancelled", async () => {
    const off = fixture({ remote: () => false });
    await expect(off.auth.signIn(host)).rejects.toMatchObject({ code: "cloud_disabled" });
    expect(off.openAuthorizationURL).not.toHaveBeenCalled(); expect(off.fetchMock).not.toHaveBeenCalled();
    const f = fixture(); const controller = new AbortController();controller.abort();
    await expect(f.auth.signIn(host, undefined, { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(f.openAuthorizationURL).not.toHaveBeenCalled();
  });

  it("stops before token exchange if cloud processing is disabled during sign-in", async () => {
    let enabled = true;
    const f = fixture({ remote: () => enabled, afterCallback: () => { enabled = false; } });
    await expect(f.auth.signIn(host)).rejects.toMatchObject({ code: "cloud_disabled" });
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("cancels a stalled token request and closes its listener", async () => {
    let callback!: string;
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) => new Promise<Response>(() => {}));
    const controller = new AbortController();
    const auth = createChatGPTSignIn({ remoteProcessingEnabled: () => true, rememberRegistration: async () => {}, fetch: fetchMock as typeof fetch,
      openAuthorizationURL: async value => { const url = new URL(value);callback = url.searchParams.get("redirect_uri")!;
        await fetch(`${callback}?state=${url.searchParams.get("state")}&code=dummy&client_id=${clientId}`);setTimeout(() => controller.abort(), 15); } });
    await expect(auth.signIn(host, undefined, { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await expect(fetch(callback)).rejects.toThrow();
  });

  it("bounds token response bodies and keeps raw errors out of returned messages", async () => {
    const f = fixture({ tokenResponse: () => new Response('private-provider-content'.repeat(20000)) });
    await expect(f.auth.signIn(host)).rejects.toMatchObject({ code: "invalid_token_response" });
    expect(new ChatGPTSignInError("unavailable").message).not.toContain("private-provider-content");
  });
});
