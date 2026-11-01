import { ChatGPTPlanError, createChatGPTPlanAPI, type ChatGPTPlanModel } from "./chatgpt-plan-api";
import { createChatGPTSignIn, ChatGPTSignInError, type ChatGPTCredentials, type ChatGPTRegistration } from "./chatgpt-sign-in";
import { validChatGPTCredentials, type ChatGPTAccountStore, type ChatGPTStoredAccount } from "./chatgpt-account-store";

const ISSUER = "https://auth.openai.com";
const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_ENDPOINT = `${ISSUER}/.well-known/openid-configuration`;
const RESOURCE = "https://api.openai.com/v1";
const MAX_RESPONSE_BYTES = 256 * 1024;
const TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
  "refresh_token_invalidated", "refresh_token_reused",
]);

type Store = Pick<ChatGPTAccountStore, "transaction">;
interface Dependencies {
  store: Store;
  remoteProcessingEnabled(): boolean;
  openAuthorizationURL(url: string): Promise<void>;
  fetch?: typeof globalThis.fetch;
  onAccountsChanged?(accounts: ChatGPTAccountSummary[]): void;
}
interface RequestOptions { signal?: AbortSignal; timeoutMs?: number; }
export interface ChatGPTAccountSummary {
  clientId: string;
  email?: string;
  label: string;
  active: boolean;
  connected: boolean;
  planEnabled: boolean;
}
export interface ChatGPTSignOutResult { remoteRevocation: "confirmed" | "unconfirmed" | "not_needed"; }

function accountSummary(account: ChatGPTStoredAccount, activeClientId: string | null, index: number): ChatGPTAccountSummary {
  return { clientId: account.clientId, ...(account.email ? { email: account.email } : {}),
    label: `ChatGPT account ${index + 1}`,
    active: account.clientId === activeClientId, connected: Boolean(account.credentials),
    planEnabled: account.credentials?.planEnabled === true };
}

function tokenString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 64 * 1024 && !/[\x00-\x20\x7f]/.test(value);
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("invalid_response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await untilAbort(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("invalid_response");
      text += decoder.decode(chunk.value, { stream: true });
    }
    const value: unknown = JSON.parse(text + decoder.decode());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_response");
    return value as Record<string, unknown>;
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
  }
}

async function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); throw new ChatGPTPlanError("cancelled"); }
  let abort = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(new ChatGPTPlanError("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

function requestSignal(parent: AbortSignal | undefined, timeoutMs = 30_000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent?.removeEventListener("abort", abort); } };
}

export function createChatGPTPlanSession(dependencies: Dependencies) {
  const fetch = dependencies.fetch ?? globalThis.fetch;
  let epoch = 0;
  let requestController = new AbortController();
  let pendingConnectEpoch: number | null = null;
  const invalidate = () => { epoch += 1; requestController.abort(); requestController = new AbortController(); };

  const signIn = createChatGPTSignIn({
    remoteProcessingEnabled: dependencies.remoteProcessingEnabled,
    openAuthorizationURL: dependencies.openAuthorizationURL,
    fetch,
    rememberRegistration: async registration => {
      const connectEpoch = pendingConnectEpoch;
      if (connectEpoch === null || connectEpoch !== epoch) throw new ChatGPTPlanError("cancelled");
      await dependencies.store.transaction(async state => {
        if (connectEpoch !== epoch) throw new ChatGPTPlanError("cancelled");
        if (state.hostId !== registration.hostId) throw new Error("host_mismatch");
        const existing = state.accounts.find(account => account.clientId === registration.clientId);
        if (!existing) state.accounts.push({ clientId: registration.clientId });
      }, { signal: requestController.signal });
    },
  });

  async function refresh(credentials: ChatGPTCredentials, signal: AbortSignal) {
    if (!dependencies.remoteProcessingEnabled()) return { kind: "error" as const, error: new ChatGPTPlanError("cloud_disabled") };
    if (!credentials.refreshToken) return { kind: "error" as const, error: new ChatGPTPlanError("sign_in_required") };
    let response: Response;
    try {
      response = await untilAbort(fetch(TOKEN_ENDPOINT, { method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: credentials.clientId,
          refresh_token: credentials.refreshToken, resource: RESOURCE }).toString() }), signal);
    } catch {
      if (signal.aborted) return { kind: "error" as const, error: new ChatGPTPlanError("cancelled") };
      return { kind: "error" as const, error: new ChatGPTPlanError("unavailable") };
    }
    const receivedAt = Date.now();
    let body: Record<string, unknown>;
    try { body = await boundedJson(response, signal); }
    catch { return { kind: "error" as const, error: new ChatGPTPlanError("unavailable") }; }
    if (!response.ok) {
      if (TERMINAL_REFRESH_ERRORS.has(body.error as string)) return { kind: "terminal" as const };
      return { kind: "error" as const, error: new ChatGPTPlanError("unavailable") };
    }
    if (!tokenString(body.access_token) || body.token_type !== "Bearer" || typeof body.expires_in !== "number"
      || !Number.isInteger(body.expires_in) || body.expires_in <= 0 || body.expires_in > 365 * 86400
      || (body.refresh_token !== undefined && !tokenString(body.refresh_token))
      || (body.scope !== undefined && (typeof body.scope !== "string" || body.scope.length > 4096))) {
      return { kind: "error" as const, error: new ChatGPTPlanError("unavailable") };
    }
    const scope = body.scope as string | undefined;
    const scopes = scope === undefined ? credentials.scopes : [...new Set(scope.split(/\s+/).filter(Boolean))];
    const next = { ...credentials, accessToken: body.access_token,
      refreshToken: (body.refresh_token as string | undefined) ?? credentials.refreshToken, scopes, receivedAt,
      accessExpiresAt: receivedAt + body.expires_in * 1000,
      planEnabled: scopes.includes("resource.invoke") && scopes.includes("chatgpt.tokens.use.direct") };
    if (!validChatGPTCredentials(next)) return { kind: "error" as const, error: new ChatGPTPlanError("unavailable") };
    return { kind: "success" as const, credentials: next };
  }

  async function getGrant(signal?: AbortSignal) {
    if (!dependencies.remoteProcessingEnabled()) throw new ChatGPTPlanError("cloud_disabled");
    const bounded = requestSignal(signal);
    const combined = AbortSignal.any([bounded.signal, requestController.signal]);
    try {
      const outcome = await dependencies.store.transaction(async (state, storeSignal) => {
        const result = (value: { error?: ChatGPTPlanError; grant?: { accessToken: string; scopes: string[] } }) => ({ ...value,
          accounts: state.accounts.map((account, index) => accountSummary(account, state.activeClientId, index)) });
        const operationSignal = AbortSignal.any([combined, storeSignal]);
        if (operationSignal.aborted) return result({ error: new ChatGPTPlanError("cancelled") });
        if (!dependencies.remoteProcessingEnabled()) return result({ error: new ChatGPTPlanError("cloud_disabled") });
        const account = state.accounts.find(candidate => candidate.clientId === state.activeClientId);
        const current = account?.credentials;
        if (!account || !current?.accessToken) return result({ error: new ChatGPTPlanError("sign_in_required") });
        if (!current.scopes.includes("resource.invoke") || !current.scopes.includes("chatgpt.tokens.use.direct")) {
          return result({ error: new ChatGPTPlanError("permission_required") });
        }
        if (!current.accessExpiresAt || current.accessExpiresAt - Date.now() > 60_000) {
          return result({ grant: { accessToken: current.accessToken, scopes: current.scopes } });
        }
        const refreshed = await refresh(current, operationSignal);
        if (refreshed.kind === "terminal") {
          delete account.credentials;
          if (state.activeClientId === account.clientId) state.activeClientId = null;
          return result({ error: new ChatGPTPlanError("sign_in_required") });
        }
        if (refreshed.kind === "error") return result({ error: refreshed.error });
        account.credentials = refreshed.credentials;
        return result({ grant: { accessToken: refreshed.credentials.accessToken!, scopes: refreshed.credentials.scopes } });
      }, { signal: combined });
      dependencies.onAccountsChanged?.(outcome.accounts);
      if (outcome.error) throw outcome.error;
      return outcome.grant!;
    } finally { bounded.dispose(); }
  }

  const api = createChatGPTPlanAPI({ getGrant, remoteProcessingEnabled: dependencies.remoteProcessingEnabled, fetch });

  return {
    async connect(clientId?: string): Promise<ChatGPTAccountSummary> {
      if (!dependencies.remoteProcessingEnabled()) throw new ChatGPTPlanError("cloud_disabled");
      if (pendingConnectEpoch !== null) throw new ChatGPTSignInError("in_progress");
      const startedAt = epoch;
      pendingConnectEpoch = startedAt;
      const connectController = requestController;
      try {
        const registration = await dependencies.store.transaction(async state => {
          if (!clientId) return { hostId: state.hostId };
          const account = state.accounts.find(candidate => candidate.clientId === clientId);
          if (!account) throw new ChatGPTPlanError("sign_in_required");
          const returning: ChatGPTRegistration = { clientId, hostId: state.hostId,
            ...(account.subject ? { subject: account.subject } : {}),
            ...(account.credentials?.idToken ? { idToken: account.credentials.idToken } : {}),
            ...(account.email && account.subject ? { email: account.email } : {}) };
          return { hostId: state.hostId, returning, requestPlanConsent: account.credentials?.planEnabled === false };
        }, { signal: connectController.signal });
        const credentials = await signIn.signIn(registration.hostId, registration.returning, { signal: connectController.signal, requestPlanConsent: registration.requestPlanConsent });
        const summary = await dependencies.store.transaction(async state => {
          if (epoch !== startedAt || state.hostId !== credentials.hostId) throw new ChatGPTPlanError("cancelled");
          const account = state.accounts.find(candidate => candidate.clientId === credentials.clientId);
          if (!account || (account.subject && account.subject !== credentials.subject)) throw new ChatGPTPlanError("sign_in_required");
          account.subject = credentials.subject;
          if (credentials.email) account.email = credentials.email;
          account.credentials = credentials;
          state.activeClientId = credentials.clientId;
          return accountSummary(account, state.activeClientId, state.accounts.indexOf(account));
        }, { signal: connectController.signal });
        invalidate();
        return summary;
      } finally { pendingConnectEpoch = null; }
    },

    async selectAccount(clientId: string): Promise<ChatGPTAccountSummary> {
      if (!dependencies.remoteProcessingEnabled()) throw new ChatGPTPlanError("cloud_disabled");
      invalidate();
      const signal = requestController.signal;
      return dependencies.store.transaction(async state => {
        if (!dependencies.remoteProcessingEnabled()) throw new ChatGPTPlanError("cloud_disabled");
        const account = state.accounts.find(candidate => candidate.clientId === clientId);
        if (!account?.credentials) throw new ChatGPTPlanError("sign_in_required");
        state.activeClientId = clientId;
        return accountSummary(account, clientId, state.accounts.indexOf(account));
      }, { signal });
    },

    async listAccounts(): Promise<ChatGPTAccountSummary[]> {
      if (!dependencies.remoteProcessingEnabled()) throw new ChatGPTPlanError("cloud_disabled");
      return dependencies.store.transaction(async state => {
        if (!dependencies.remoteProcessingEnabled()) throw new ChatGPTPlanError("cloud_disabled");
        return state.accounts.map((account, index) => accountSummary(account, state.activeClientId, index));
      }, { signal: requestController.signal });
    },

    async signOut(clientId?: string): Promise<ChatGPTSignOutResult> {
      invalidate();
      const revocationSignal = requestController.signal;
      return dependencies.store.transaction(async (state, storeSignal) => {
        const selected = clientId ?? state.activeClientId;
        const account = state.accounts.find(candidate => candidate.clientId === selected);
        if (!account) return { remoteRevocation: "not_needed" };
        const refreshToken = account.credentials?.refreshToken;
        let remoteRevocation: ChatGPTSignOutResult["remoteRevocation"] = refreshToken ? "unconfirmed" : "not_needed";
        if (refreshToken && dependencies.remoteProcessingEnabled()) {
          const bounded = requestSignal(AbortSignal.any([storeSignal, revocationSignal]));
          try {
            const discovery = await untilAbort(fetch(DISCOVERY_ENDPOINT, { headers: { Accept: "application/json" }, redirect: "error", signal: bounded.signal }), bounded.signal);
            if (!discovery.ok) void discovery.body?.cancel().catch(() => {});
            const metadata = discovery.ok ? await boundedJson(discovery, bounded.signal) : {};
            const endpoint = typeof metadata.revocation_endpoint === "string" ? new URL(metadata.revocation_endpoint) : undefined;
            if (metadata.issuer === ISSUER && endpoint?.protocol === "https:" && endpoint.origin === ISSUER
              && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash) {
              for (let attempt = 0; attempt < 2; attempt += 1) {
                if (!dependencies.remoteProcessingEnabled() || bounded.signal.aborted) break;
                try {
                  const response = await untilAbort(fetch(endpoint.toString(), { method: "POST", redirect: "error", signal: bounded.signal,
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token", client_id: account.clientId }).toString() }), bounded.signal);
                  if (response.status === 200) { void response.body?.cancel().catch(() => {}); remoteRevocation = "confirmed"; break; }
                  void response.body?.cancel().catch(() => {});
                  if (response.status < 500) break;
                  if (attempt === 0) await untilAbort(new Promise(resolve => setTimeout(resolve, 100)), bounded.signal);
                } catch {
                  if (bounded.signal.aborted) break;
                  if (attempt === 0) await untilAbort(new Promise(resolve => setTimeout(resolve, 100)), bounded.signal);
                }
              }
            }
          } catch { /* Local clearance still completes. */ }
          finally { bounded.dispose(); }
        }
        delete account.credentials;
        if (state.activeClientId === account.clientId) state.activeClientId = null;
        return { remoteRevocation };
      });
    },

    notifyCloudPermissionChanged() { invalidate(); },
    listModels(options: RequestOptions = {}): Promise<ChatGPTPlanModel[]> {
      return api.listModels({ ...options, signal: AbortSignal.any([options.signal ?? new AbortController().signal, requestController.signal]) });
    },
    complete(input: { model: string; text: string; instructions?: string }, options: RequestOptions = {}) {
      return api.complete(input, { ...options, signal: AbortSignal.any([options.signal ?? new AbortController().signal, requestController.signal]) });
    },
  };
}
