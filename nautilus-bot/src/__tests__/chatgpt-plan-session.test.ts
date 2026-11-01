import { describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { ChatGPTAccountState } from "../../electron/chatgpt-account-store";
import { createChatGPTPlanSession } from "../../electron/chatgpt-plan-session";

const hostId = "urn:uuid:123e4567-e89b-42d3-a456-426614174000";
const credentials = {
  issuer: "https://auth.openai.com" as const,
  hostId,
  clientId: "issued-client",
  subject: "subject-1",
  email: "person@example.com",
  idToken: "verified-id-token",
  accessToken: "old-access-token",
  refreshToken: "old-refresh-token",
  scopes: ["openid", "resource.invoke", "chatgpt.tokens.use.direct"],
  receivedAt: 1_000,
  accessExpiresAt: Date.now() + 30_000,
  planEnabled: true,
};

class MemoryStore {
  reads = 0;
  state: ChatGPTAccountState;
  private tail = Promise.resolve();
  constructor(state: ChatGPTAccountState) { this.state = structuredClone(state); }
  async transaction<T>(operation: (state: ChatGPTAccountState, signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal } = {}) {
    let release!: () => void;
    const prior = this.tail;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try {
      this.reads += 1;
      const draft = structuredClone(this.state);
      const result = await operation(draft, options.signal ?? new AbortController().signal);
      this.state = draft;
      return result;
    } finally { release(); }
  }
}

function state(withCredentials = true): ChatGPTAccountState {
  return { version: 1, hostId, activeClientId: "issued-client", accounts: [{
    clientId: "issued-client", subject: "subject-1", email: "person@example.com",
    ...(withCredentials ? { credentials } : {}),
  }] };
}

function session(store: MemoryStore, fetch = vi.fn(), remote = () => true) {
  return createChatGPTPlanSession({
    store,
    remoteProcessingEnabled: remote,
    openAuthorizationURL: vi.fn(),
    fetch: fetch as typeof globalThis.fetch,
  });
}

describe("ChatGPT plan session lifecycle", () => {
  it("does not read protected state when cloud processing is disabled", async () => {
    const store = new MemoryStore(state());
    const value = session(store, vi.fn(), () => false);
    await expect(value.listAccounts()).rejects.toMatchObject({ code: "cloud_disabled" });
    await expect(value.listModels()).rejects.toMatchObject({ code: "cloud_disabled" });
    expect(store.reads).toBe(0);
  });

  it("returns account metadata without exposing credentials", async () => {
    const accounts = await session(new MemoryStore(state())).listAccounts();
    expect(accounts).toEqual([{ clientId: "issued-client", email: "person@example.com", label: "ChatGPT account 1", active: true, connected: true, planEnabled: true }]);
    expect(JSON.stringify(accounts)).not.toContain("token");
  });

  it("keeps same-email accounts distinct with stable labels after selection changes", async () => {
    const initial = state();
    initial.accounts.push({ ...initial.accounts[0], clientId: "other-client", credentials: { ...credentials, clientId: "other-client" } });
    const value = session(new MemoryStore(initial));
    const first = await value.listAccounts();
    expect(new Set(first.map(account => account.label)).size).toBe(2);
    await value.selectAccount("other-client");
    expect((await value.listAccounts()).map(account => account.label)).toEqual(first.map(account => account.label));
  });

  it("does not let a rejected concurrent connection poison the valid sign-in", async () => {
    const pair = await generateKeyPair("RS256");
    const key = { ...await exportJWK(pair.publicKey), kid: "session-test", alg: "RS256", use: "sig" };
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    let continueSignIn!: () => void; const continuation = new Promise<void>(resolve => { continueSignIn = resolve; });
    let authorization!: URL;
    const openAuthorizationURL = vi.fn(async (value: string) => {
      authorization = new URL(value);started();await continuation;
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ state: authorization.searchParams.get("state")!, code: "dummy-code", client_id: credentials.clientId }).toString();
      expect((await globalThis.fetch(callback)).status).toBe(200);
    });
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/.well-known/jwks.json")) return Response.json({ keys: [key] });
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({ iss: credentials.issuer, aud: credentials.clientId, sub: credentials.subject, nonce: authorization.searchParams.get("nonce"), iat: now, exp: now + 3600 })
        .setProtectedHeader({ alg: "RS256", kid: "session-test" }).sign(pair.privateKey);
      return Response.json({ id_token: token, access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer", expires_in: 3600, scope: "openid resource.invoke chatgpt.tokens.use.direct" });
    });
    const value = createChatGPTPlanSession({ store: new MemoryStore(state()), remoteProcessingEnabled: () => true, openAuthorizationURL, fetch: fetch as typeof globalThis.fetch });
    const first = value.connect(credentials.clientId);await ready;
    await expect(value.connect()).rejects.toMatchObject({ code: "in_progress" });
    continueSignIn();await expect(first).resolves.toMatchObject({ connected: true, planEnabled: true });
    expect(openAuthorizationURL).toHaveBeenCalledTimes(1);
  });

  it("stops remote revocation after cloud permission changes while still clearing local tokens", async () => {
    const store = new MemoryStore(state());let enabled = true;
    let value!: ReturnType<typeof createChatGPTPlanSession>;
    const fetch = vi.fn(async () => {
      enabled = false;value.notifyCloudPermissionChanged();
      return Response.json({ issuer: "https://auth.openai.com", revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke" });
    });
    value = session(store, fetch, () => enabled);
    await expect(value.signOut()).resolves.toEqual({ remoteRevocation: "unconfirmed" });
    expect(fetch).toHaveBeenCalledTimes(1);expect(store.state.accounts[0].credentials).toBeUndefined();expect(store.state.activeClientId).toBeNull();
  });

  it("refreshes a near-expiry grant atomically and retains omitted refresh token and verified identity hint", async () => {
    const store = new MemoryStore(state());
    const fetch = vi.fn().mockResolvedValue(Response.json({
      access_token: "rotated-access-token", token_type: "Bearer", expires_in: 3600,
      scope: "resource.invoke chatgpt.tokens.use.direct",
    }));
    const value = session(store, fetch);
    await expect(value.listModels()).rejects.toMatchObject({ code: "invalid_response" });
    const request = fetch.mock.calls[0][1] as RequestInit;
    expect(fetch.mock.calls[0][0]).toBe("https://auth.openai.com/api/accounts/oauth/token");
    expect(String(request.body)).toBe("grant_type=refresh_token&client_id=issued-client&refresh_token=old-refresh-token&resource=https%3A%2F%2Fapi.openai.com%2Fv1");
    expect(store.state.accounts[0].credentials).toMatchObject({
      accessToken: "rotated-access-token", refreshToken: "old-refresh-token", idToken: "verified-id-token",
      scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
    });
  });

  it("commits terminal refresh-token clearance while retaining account identity", async () => {
    const store = new MemoryStore(state());
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expect(session(store, fetch).listModels()).rejects.toMatchObject({ code: "sign_in_required" });
    expect(store.state.accounts[0]).toEqual({ clientId: "issued-client", subject: "subject-1", email: "person@example.com" });
    expect(store.state.activeClientId).toBeNull();
  });

  it.each([
    [new Response(null, { status: 503 })],
    [Response.json({ access_token: "bad token", token_type: "Bearer", expires_in: 3600 })],
  ])("preserves the prior credential set after a transient or malformed refresh", async refreshResponse => {
    const store = new MemoryStore(state());
    await expect(session(store, vi.fn().mockResolvedValue(refreshResponse)).listModels()).rejects.toMatchObject({ code: "unavailable" });
    expect(store.state.accounts[0].credentials).toEqual(credentials);
  });

  it("serializes refresh across session instances sharing the store", async () => {
    const store = new MemoryStore(state());
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === "https://auth.openai.com/api/accounts/oauth/token") return Response.json({
        access_token: "rotated-access-token", refresh_token: "rotated-refresh-token", token_type: "Bearer", expires_in: 3600,
        scope: "resource.invoke chatgpt.tokens.use.direct",
      });
      return Response.json({ models: [] });
    });
    const first = session(store, fetch);
    const second = session(store, fetch);
    await Promise.all([first.listModels(), second.listModels()]);
    expect(fetch.mock.calls.filter(([url]) => String(url) === "https://auth.openai.com/api/accounts/oauth/token")).toHaveLength(1);
    expect(store.state.accounts[0].credentials?.refreshToken).toBe("rotated-refresh-token");
  });

  it("aborts an in-flight provider request when account selection changes", async () => {
    const initial = state();
    initial.accounts[0].credentials!.accessExpiresAt = Date.now() + 3_600_000;
    initial.accounts.push({ clientId: "other-client", subject: "subject-2", credentials: {
      ...credentials, clientId: "other-client", subject: "subject-2", accessExpiresAt: Date.now() + 3_600_000,
    } });
    const store = new MemoryStore(initial);
    const value = session(store, vi.fn(() => new Promise<Response>(() => {})));
    const request = value.listModels();
    await new Promise(resolve => setTimeout(resolve, 0));
    await value.selectAccount("other-client");
    await expect(request).rejects.toMatchObject({ code: "cancelled" });
  });

  it("rejects selecting a pending or signed-out registration", async () => {
    const initial = state();
    initial.accounts.push({ clientId: "pending-client" });
    await expect(session(new MemoryStore(initial)).selectAccount("pending-client")).rejects.toMatchObject({ code: "sign_in_required" });
  });

  it("does not refresh an identity-only grant", async () => {
    const initial = state();
    initial.accounts[0].credentials = { ...credentials, scopes: ["openid", "email"], planEnabled: false };
    const fetch = vi.fn();
    await expect(session(new MemoryStore(initial), fetch).listModels()).rejects.toMatchObject({ code: "permission_required" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears only the selected account after bounded remote revocation succeeds", async () => {
    const initial = state();
    initial.accounts.push({ clientId: "other-client", subject: "subject-2", credentials: { ...credentials, clientId: "other-client", subject: "subject-2" } });
    const store = new MemoryStore(initial);
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ issuer: "https://auth.openai.com", revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke" }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(session(store, fetch).signOut()).resolves.toEqual({ remoteRevocation: "confirmed" });
    expect(fetch.mock.calls[1][0]).toBe("https://auth.openai.com/api/accounts/oauth/revoke");
    expect(String((fetch.mock.calls[1][1] as RequestInit).body)).toBe("token=old-refresh-token&token_type_hint=refresh_token&client_id=issued-client");
    expect(store.state.accounts[0]).toEqual({ clientId: "issued-client", subject: "subject-1", email: "person@example.com" });
    expect(store.state.accounts[1].credentials?.accessToken).toBe("old-access-token");
  });

  it("retries a server-side revocation failure and confirms the second response", async () => {
    const store = new MemoryStore(state());
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ issuer: "https://auth.openai.com", revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke" }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(session(store, fetch).signOut()).resolves.toEqual({ remoteRevocation: "confirmed" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("clears local tokens without network access when cloud processing is disabled", async () => {
    const store = new MemoryStore(state());
    const fetch = vi.fn();
    await expect(session(store, fetch, () => false).signOut()).resolves.toEqual({ remoteRevocation: "unconfirmed" });
    expect(fetch).not.toHaveBeenCalled();
    expect(store.state.accounts[0].credentials).toBeUndefined();
  });
});
