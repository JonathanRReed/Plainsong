import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { ChatGPTSignInError, type ChatGPTCredentials } from "./chatgpt-sign-in";
import { ChatGPTPlanError } from "./chatgpt-plan-api";

const MAX_BYTES = 8 * 1024 * 1024;
export interface ChatGPTStorageCipher {
  encrypt(text: string): Promise<Buffer>;
  decrypt(bytes: Buffer): Promise<string>;
}
export interface ChatGPTStoredAccount {
  clientId: string;
  subject?: string;
  email?: string;
  credentials?: ChatGPTCredentials;
}
export interface ChatGPTAccountState {
  version: 1;
  hostId: string;
  activeClientId: string | null;
  accounts: ChatGPTStoredAccount[];
}
class ChatGPTStoreError extends Error {
  constructor(readonly code: "storage_unavailable" | "invalid_account_data" | "busy" | "cancelled") {
    const messages = {
      storage_unavailable: "Protected ChatGPT account storage is unavailable. Try again when your system credential store is unlocked.",
      invalid_account_data: "Saved ChatGPT account data could not be verified. It has been preserved.",
      busy: "ChatGPT account storage is busy. Try again.",
      cancelled: "The ChatGPT account operation was cancelled.",
    };
    super(messages[code]); this.name = "ChatGPTStoreError";
  }
}
function fail(code: ChatGPTStoreError["code"]): never { throw new ChatGPTStoreError(code); }
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function opaque(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x20\x7f]/.test(value);
}
function clientId(value: unknown): value is string { return opaque(value, 256) && /^[A-Za-z0-9_-]+$/.test(value) && value !== "dynamic_agent_client"; }
function hostId(value: unknown): value is string {
  return typeof value === "string" && /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function subject(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512; }
export function validChatGPTCredentials(value: unknown): value is ChatGPTCredentials {
  if (!object(value) || value.issuer !== "https://auth.openai.com" || !hostId(value.hostId) || !clientId(value.clientId)
    || !subject(value.subject) || !opaque(value.idToken, 16 * 1024) || (value.email !== undefined && !opaque(value.email, 320))
    || (value.accessToken !== undefined && !opaque(value.accessToken, 64 * 1024))
    || (value.refreshToken !== undefined && !opaque(value.refreshToken, 64 * 1024))
    || !Array.isArray(value.scopes) || value.scopes.length > 64 || !value.scopes.every(scope => opaque(scope, 128))
    || value.scopes.join(" ").length > 4096 || typeof value.receivedAt !== "number" || !Number.isFinite(value.receivedAt) || value.receivedAt < 0) return false;
  if (value.accessToken !== undefined && (typeof value.accessExpiresAt !== "number" || !Number.isFinite(value.accessExpiresAt) || value.accessExpiresAt <= value.receivedAt)) return false;
  if (value.accessToken === undefined && value.accessExpiresAt !== undefined) return false;
  return value.planEnabled === (Boolean(value.accessToken) && value.scopes.includes("resource.invoke") && value.scopes.includes("chatgpt.tokens.use.direct"));
}
function validState(value: unknown): value is ChatGPTAccountState {
  if (!object(value) || value.version !== 1 || !hostId(value.hostId) || !Array.isArray(value.accounts) || value.accounts.length > 64
    || (value.activeClientId !== null && !clientId(value.activeClientId))) return false;
  const ids = new Set<string>();
  for (const account of value.accounts) {
    if (!object(account) || !clientId(account.clientId) || ids.has(account.clientId)
      || (account.subject !== undefined && !subject(account.subject)) || (account.email !== undefined && !opaque(account.email, 320))
      || (account.email !== undefined && account.subject === undefined)) return false;
    ids.add(account.clientId);
    if (account.credentials !== undefined && (!validChatGPTCredentials(account.credentials)
      || account.credentials.clientId !== account.clientId || account.credentials.hostId !== value.hostId || account.credentials.subject !== account.subject)) return false;
  }
  return value.activeClientId === null || value.accounts.some(account => account.clientId === value.activeClientId && account.credentials !== undefined);
}
function check(signal: AbortSignal) { if (signal.aborted) fail("cancelled"); }
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); fail("cancelled"); }
  let cancel = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      cancel = () => reject(new ChatGPTStoreError("cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", cancel); }
}
function privateOwner(stat: { mode: number; uid: number }) {
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))) fail("storage_unavailable");
}

/** One encrypted record, read under a cross-process lock for each transaction.
 * Construction performs no I/O. The directory is dedicated to this store. */
export class ChatGPTAccountStore {
  readonly directory: string;
  readonly file: string;
  constructor(directory: string, private readonly cipher: ChatGPTStorageCipher) {
    this.directory = resolve(directory);
    this.file = join(this.directory, "accounts.enc");
  }
  private async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("storage_unavailable");
    privateOwner(stat);
  }
  private async read(signal: AbortSignal): Promise<ChatGPTAccountState> {
    let handle;
    try { handle = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, hostId: `urn:uuid:${randomUUID()}`, activeClientId: null, accounts: [] };
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) fail("invalid_account_data");
      privateOwner(stat);
      const chunks: Buffer[] = []; let bytes = 0;
      while (true) {
        check(signal);
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > MAX_BYTES) fail("invalid_account_data");
        chunks.push(buffer.subarray(0, bytesRead));
      }
      const text = await abortable(this.cipher.decrypt(Buffer.concat(chunks)), signal);
      if (Buffer.byteLength(text) > MAX_BYTES) fail("invalid_account_data");
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { fail("invalid_account_data"); }
      if (!validState(parsed)) fail("invalid_account_data");
      return parsed;
    } finally { await handle.close(); }
  }
  private async write(state: ChatGPTAccountState, signal: AbortSignal) {
    if (!validState(state)) fail("invalid_account_data");
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > MAX_BYTES) fail("invalid_account_data");
    const encrypted = await abortable(this.cipher.encrypt(text), signal);
    if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_BYTES) fail("invalid_account_data");
    check(signal);
    const temporary = join(this.directory, `accounts-${randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      created = true;
      try { await handle.writeFile(encrypted); await handle.sync(); } finally { await handle.close(); }
      check(signal);
      await rename(temporary, this.file);
      // Every committed record replaces access/refresh/scopes/expiry together.
      if (process.platform !== "win32") {
        const directory = await open(this.directory, constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { if (created) await rm(temporary, { force: true }).catch(() => {}); }
  }
  async transaction<T>(operation: (state: ChatGPTAccountState, signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    if (options.signal?.aborted) fail("cancelled");
    const compromised = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, compromised.signal]) : compromised.signal;
    let release: (() => Promise<void>) | undefined;
    try {
      await this.prepare(); check(signal);
      try {
        const acquisition = lockfile.lock(this.file, { realpath: false, stale: 60_000, update: 1000,
          retries: { retries: 30, minTimeout: 25, maxTimeout: 250, factor: 1.3 }, onCompromised: () => compromised.abort() });
        try { release = await abortable(acquisition, signal); }
        catch (error) {
          // Cancellation must not leave a detached acquisition holding a lease.
          if (signal.aborted) void acquisition.then(unlock => unlock()).catch(() => {});
          throw error;
        }
      } catch { if (signal.aborted) fail("cancelled"); fail("busy"); }
      check(signal);
      const state = await this.read(signal); check(signal);
      const result = await abortable(operation(state, signal), signal); check(signal);
      // Re-encrypt even a read transaction to honor OS key rotation.
      await this.write(state, signal);
      return result;
    } catch (error) {
      if (signal.aborted) fail("cancelled");
      if (error instanceof ChatGPTStoreError || error instanceof ChatGPTPlanError || error instanceof ChatGPTSignInError) throw error;
      return fail("storage_unavailable");
    } finally { if (release) await release().catch(() => {}); }
  }
}

interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(bytes: Buffer): string;
  getSelectedStorageBackend?(): string;
  isAsyncEncryptionAvailable?(): Promise<boolean>;
  encryptStringAsync?(text: string): Promise<Buffer>;
  decryptStringAsync?(bytes: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}
/** Pass Electron safeStorage after app readiness, only for explicit account
 * operations. No call is made here, and no plaintext fallback is enabled. */
export function createChatGPTStorageCipher(storage: SafeStorage, platform: NodeJS.Platform = process.platform): ChatGPTStorageCipher {
  const asynchronous = platform !== "linux" && storage.isAsyncEncryptionAvailable && storage.encryptStringAsync && storage.decryptStringAsync;
  async function available() {
    if (asynchronous) { if (!await storage.isAsyncEncryptionAvailable!()) fail("storage_unavailable"); }
    else {
      if (!storage.isEncryptionAvailable()) fail("storage_unavailable");
      if (platform === "linux" && !["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(storage.getSelectedStorageBackend?.() ?? "unknown")) fail("storage_unavailable");
    }
  }
  return {
    async encrypt(text) { await available(); return asynchronous ? storage.encryptStringAsync!(text) : storage.encryptString(text); },
    async decrypt(bytes) { await available(); return asynchronous ? (await storage.decryptStringAsync!(bytes)).result : storage.decryptString(bytes); },
  };
}
