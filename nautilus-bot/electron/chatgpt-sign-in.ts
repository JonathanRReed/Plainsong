import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const JWKS = `${ISSUER}/.well-known/jwks.json`;
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const MAX_JSON_BYTES = 256 * 1024;

export type ChatGPTSignInErrorCode = "cloud_disabled" | "in_progress" | "cancelled" | "expired"
  | "invalid_registration" | "invalid_callback" | "denied" | "invalid_identity"
  | "invalid_token_response" | "unavailable";
const MESSAGES: Record<ChatGPTSignInErrorCode, string> = {
  cloud_disabled: "Enable cloud processing before connecting your ChatGPT account.",
  in_progress: "A ChatGPT sign-in is already in progress.",
  cancelled: "ChatGPT sign-in was cancelled.",
  expired: "ChatGPT sign-in expired. Start again.",
  invalid_registration: "The ChatGPT account registration could not be verified.",
  invalid_callback: "The ChatGPT sign-in response could not be verified. Start again.",
  denied: "ChatGPT sign-in was not approved.",
  invalid_identity: "The ChatGPT account identity could not be verified. Start again.",
  invalid_token_response: "ChatGPT did not return usable sign-in credentials. Start again.",
  unavailable: "ChatGPT sign-in is temporarily unavailable. Try again later.",
};
export class ChatGPTSignInError extends Error {
  constructor(readonly code: ChatGPTSignInErrorCode) { super(MESSAGES[code]); this.name = "ChatGPTSignInError"; }
}

export interface ChatGPTRegistration {
  clientId: string;
  hostId: string;
  // Absent for a pending registration whose first token exchange failed.
  subject?: string;
  idToken?: string;
  email?: string;
}
export interface ChatGPTCredentials {
  issuer: typeof ISSUER;
  hostId: string;
  clientId: string;
  subject: string;
  email?: string;
  idToken: string;
  accessToken?: string;
  refreshToken?: string;
  scopes: string[];
  receivedAt: number;
  accessExpiresAt?: number;
  planEnabled: boolean;
}
interface Dependencies {
  remoteProcessingEnabled(): boolean;
  openAuthorizationURL(url: string): Promise<void>;
  // Save a pending issued registration before exchange, without making it active.
  rememberRegistration(registration: { clientId: string; hostId: string }): Promise<void>;
  fetch?: typeof globalThis.fetch;
}
interface SignInOptions { signal?: AbortSignal; timeoutMs?: number; requestPlanConsent?: boolean; }
function fail(code: ChatGPTSignInErrorCode): never { throw new ChatGPTSignInError(code); }
function issuedClient(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value) && value !== "dynamic_agent_client";
}
function tokenString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 64 * 1024 && !/[\x00-\x20\x7f]/.test(value);
}
function identityToken(value: unknown): value is string {
  return tokenString(value) && Buffer.byteLength(value) <= 16 * 1024;
}
function emailHint(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 320 && !/[\x00-\x20\x7f]/.test(value);
}
function equalState(actual: string, expected: string): boolean {
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); fail("cancelled"); }
  let cancel = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      cancel = () => reject(new ChatGPTSignInError("cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", cancel); }
}
async function readJSON(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.body) fail("invalid_token_response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = ""; let bytes = 0;
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_JSON_BYTES) fail("invalid_token_response");
      text += decoder.decode(chunk.value, { stream: true });
    }
    const parsed: unknown = JSON.parse(text + decoder.decode());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("invalid_token_response");
    return parsed as Record<string, unknown>;
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
  }
}

/** Trusted main-process OAuth flow. No browser, IPC or credential store is used
 * until signIn is explicitly called. The caller persists the host ID and stores
 * the returned credentials in protected storage only after this verifies them. */
export function createChatGPTSignIn(dependencies: Dependencies) {
  let pending = false;
  return {
    async signIn(hostId: string, returning?: ChatGPTRegistration, options: SignInOptions = {}): Promise<ChatGPTCredentials> {
      if (!dependencies.remoteProcessingEnabled()) fail("cloud_disabled");
      if (pending) fail("in_progress");
      if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(hostId)) fail("invalid_registration");
      if (returning && (!issuedClient(returning.clientId) || returning.hostId !== hostId
        || (returning.subject !== undefined && (typeof returning.subject !== "string" || !returning.subject || returning.subject.length > 512))
        || (returning.idToken !== undefined && !identityToken(returning.idToken))
        || (returning.email !== undefined && !emailHint(returning.email))
        || ((returning.idToken !== undefined || returning.email !== undefined) && !returning.subject))) fail("invalid_registration");
      const timeoutMs = options.timeoutMs ?? 5 * 60_000;
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10 * 60_000) fail("invalid_registration");
      const controller = new AbortController();
      const cancel = () => controller.abort();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
      pending = true;
      const state = randomBytes(32).toString("base64url");
      const nonce = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      let redirectUri = "";
      let consumed = false;
      let accept!: (value: { code: string; clientId: string }) => void;
      let reject!: (error: Error) => void;
      const callback = new Promise<{ code: string; clientId: string }>((resolve, rejectCallback) => { accept = resolve; reject = rejectCallback; });
      // A rejection may precede the browser-opening promise settling.
      void callback.catch(() => {});
      const server = createServer((request, response) => {
        const reply = (status: number, text: string) => {
          response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'", Connection: "close" });
          response.end(text);
        };
        let url: URL;
        try { url = new URL(request.url ?? "", redirectUri); } catch { reply(400, "Invalid sign-in response."); return; }
        if (request.method !== "GET" || url.origin !== new URL(redirectUri).origin || url.pathname !== "/auth/callback"
          || request.headers.host !== new URL(redirectUri).host || url.hash || consumed || controller.signal.aborted
          || (request.url?.length ?? 0) > 16 * 1024) { reply(400, "Invalid sign-in response."); return; }
        const params = url.searchParams;
        if (["state", "code", "client_id", "error"].some(key => params.getAll(key).length > 1)
          || !equalState(params.get("state") ?? "", state)) { reply(400, "Sign-in could not be verified."); return; }
        consumed = true;
        const clientId = params.get("client_id") ?? returning?.clientId;
        const code = params.get("code");
        if (params.has("error")) { reply(200, "Sign-in was not approved. You can return to Plainsong."); reject(new ChatGPTSignInError("denied")); return; }
        if (!code || !tokenString(code) || !issuedClient(clientId) || (returning && clientId !== returning.clientId)) {
          reply(400, "Sign-in could not be verified."); reject(new ChatGPTSignInError("invalid_callback")); return;
        }
        reply(200, "Sign-in received. Return to Plainsong to see the result.");
        accept({ code, clientId });
      });
      server.on("error", () => reject(new ChatGPTSignInError("unavailable")));
      server.maxHeadersCount = 32;
      server.maxConnections = 16;
      server.headersTimeout = 5_000;
      server.requestTimeout = 5_000;
      function checkAccess() {
        if (controller.signal.aborted) fail("cancelled");
        if (!dependencies.remoteProcessingEnabled()) fail("cloud_disabled");
      }
      const authFetch = async (url: string, init?: RequestInit): Promise<Response> => {
        checkAccess();
        if (url !== TOKEN && url !== JWKS) fail("invalid_registration");
        const signal = init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
        const response = await abortable((dependencies.fetch ?? globalThis.fetch)(url, { ...init, signal, redirect: "error" }), signal);
        checkAccess();
        return response;
      };
      try {
        checkAccess();
        await abortable(new Promise<void>((resolve, rejectListen) => {
          server.once("error", rejectListen);
          server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", rejectListen);
            if (controller.signal.aborted) { server.close(); server.closeAllConnections(); }
            resolve();
          });
        }), controller.signal);
        redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/callback`;
        const authorize = new URL(AUTHORIZE);
        authorize.search = new URLSearchParams({ client_id: returning?.clientId ?? "dynamic_agent_client",
          ext_agent_host_id: hostId, response_type: "code", redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE,
          state, nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          ...(!returning ? { agent_name_hint: "Plainsong" } : {}),
          ...(options.requestPlanConsent === true ? { prompt: "consent" } : {}),
          ...(returning?.idToken ? { id_token_hint: returning.idToken } : {}),
          ...(returning?.email ? { login_hint: returning.email } : {}),
        }).toString();
        checkAccess();
        await abortable(dependencies.openAuthorizationURL(authorize.toString()), controller.signal);
        const returned = await abortable(callback, controller.signal);
        checkAccess();
        await abortable(dependencies.rememberRegistration({ clientId: returned.clientId, hostId }), controller.signal);
        const response = await authFetch(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({ grant_type: "authorization_code", client_id: returned.clientId, code: returned.code,
            code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }).toString() });
        const receivedAt = Date.now();
        if (!response.ok) {
          let code: unknown;
          try { code = (await readJSON(response, controller.signal)).error; } catch { /* Keep provider content private. */ }
          fail(code === "invalid_grant" ? "expired" : "unavailable");
        }
        const tokens = await readJSON(response, controller.signal);
        if (!identityToken(tokens.id_token) || typeof tokens.scope !== "string" || tokens.scope.length > 4096) fail("invalid_token_response");
        const { createRemoteJWKSet, customFetch, jwtVerify } = await import("jose");
        const keys = createRemoteJWKSet(new URL(JWKS), { [customFetch]: async (url: string, init: RequestInit) => {
          const response = await authFetch(url, init);
          if (!response.ok) { void response.body?.cancel().catch(() => {}); fail("unavailable"); }
          const json = await readJSON(response, init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal);
          if (!Array.isArray(json.keys) || json.keys.length > 128) fail("invalid_identity");
          return Response.json(json);
        } });
        let identity;
        try {
          identity = (await abortable(jwtVerify(tokens.id_token, keys, { issuer: ISSUER, audience: returned.clientId,
            algorithms: ["RS256"], requiredClaims: ["sub", "exp", "iat", "nonce"], clockTolerance: 5 }), controller.signal)).payload;
        } catch (error) {
          if (error instanceof ChatGPTSignInError && (error.code === "cancelled" || error.code === "cloud_disabled" || error.code === "unavailable")) throw error;
          fail("invalid_identity");
        }
        if (identity.nonce !== nonce || typeof identity.sub !== "string" || !identity.sub || identity.sub.length > 512
          || (returning?.subject !== undefined && identity.sub !== returning.subject)
          || typeof identity.iat !== "number" || !Number.isFinite(identity.iat) || !Number.isFinite(identity.exp)
          || identity.iat > Date.now() / 1000 + 5
          || (Array.isArray(identity.aud) && identity.aud.length > 1 && identity.azp !== returned.clientId)
          || (identity.azp !== undefined && identity.azp !== returned.clientId)) fail("invalid_identity");
        const scopes = [...new Set(tokens.scope.split(/\s+/).filter(Boolean))];
        const accessToken = tokens.access_token;
        const refreshToken = tokens.refresh_token;
        if ((accessToken !== undefined && !tokenString(accessToken)) || (refreshToken !== undefined && !tokenString(refreshToken))) fail("invalid_token_response");
        if (accessToken && (tokens.token_type !== "Bearer" || typeof tokens.expires_in !== "number"
          || !Number.isInteger(tokens.expires_in) || tokens.expires_in <= 0 || tokens.expires_in > 365 * 86400)) fail("invalid_token_response");
        checkAccess();
        return { issuer: ISSUER, hostId, clientId: returned.clientId, subject: identity.sub,
          ...(emailHint(identity.email) ? { email: identity.email } : {}),
          idToken: tokens.id_token, accessToken: accessToken as string | undefined, refreshToken: refreshToken as string | undefined,
          receivedAt, ...(accessToken ? { accessExpiresAt: receivedAt + (tokens.expires_in as number) * 1000 } : {}), scopes,
          planEnabled: Boolean(accessToken) && scopes.includes("resource.invoke") && scopes.includes("chatgpt.tokens.use.direct") };
      } catch (error) {
        if (controller.signal.aborted) fail(timedOut ? "expired" : "cancelled");
        if (error instanceof ChatGPTSignInError) throw error;
        fail("unavailable");
      } finally {
        cancel();
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
        server.close();
        server.closeAllConnections();
        pending = false;
      }
    },
  };
}
