import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ChatGPTAccountStore, createChatGPTStorageCipher, validChatGPTCredentials, type ChatGPTStorageCipher } from "../../electron/chatgpt-account-store";
import lockfile from "proper-lockfile";
import type { ChatGPTCredentials } from "../../electron/chatgpt-sign-in";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function softwareCipher(): ChatGPTStorageCipher {
  const key = randomBytes(32);
  return {
    async encrypt(text) { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    async decrypt(bytes) { const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));decipher.setAuthTag(bytes.subarray(12, 28));return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"); },
  };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "plainsong-chatgpt-store-"));roots.push(root);
  const cipher = softwareCipher(); const directory = join(root, "vault");
  return { root, directory, cipher, store: new ChatGPTAccountStore(directory, cipher) };
}
function credentials(hostId: string): ChatGPTCredentials {
  return { issuer: "https://auth.openai.com", hostId, clientId: "oaiapp_store_test", subject: "test-subject", email: "test@example.invalid",
    idToken: "dummy-sensitive-id-token", accessToken: "dummy-sensitive-access-token", refreshToken: "dummy-sensitive-refresh-token",
    scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], receivedAt: Date.now(), accessExpiresAt: Date.now() + 3600_000, planEnabled: true };
}
async function seed(store: ChatGPTAccountStore) {
  return store.transaction(async state => {
    const record = credentials(state.hostId);
    state.accounts.push({ clientId: record.clientId, subject: record.subject, email: record.email, credentials: record });
    state.activeClientId = record.clientId;
    return record;
  });
}

describe("protected ChatGPT account store", () => {
  it("performs no storage or crypto calls on construction", async () => {
    const f = await fixture();const encrypt = vi.fn();const decrypt = vi.fn();new ChatGPTAccountStore(f.directory, { encrypt, decrypt });
    expect(encrypt).not.toHaveBeenCalled();expect(decrypt).not.toHaveBeenCalled();expect(await readdir(f.root)).toEqual([]);
  });
  it("keeps a stable host ID across instances and stores only encrypted bytes with private permissions", async () => {
    const f = await fixture(); const record = await seed(f.store);
    const bytes = await readFile(f.store.file);
    for (const secret of [record.idToken, record.accessToken!, record.refreshToken!, record.email!]) expect(bytes.includes(Buffer.from(secret))).toBe(false);
    const copy = new ChatGPTAccountStore(f.directory, f.cipher);
    const loaded = await copy.transaction(async state => state);
    expect(loaded.hostId).toBe(record.hostId);expect(loaded.accounts[0].credentials).toEqual(record);
    if (process.platform !== "win32") {expect((await stat(f.directory)).mode & 0o077).toBe(0);expect((await stat(f.store.file)).mode & 0o077).toBe(0);}
    expect(await readdir(f.directory)).toEqual(["accounts.enc"]);
  });
  it("serializes independent instances and preserves every concurrent update", async () => {
    const f = await fixture(); const second = new ChatGPTAccountStore(f.directory, f.cipher);
    await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? second : f.store).transaction(async state => {
      state.accounts.push({ clientId: `oaiapp_parallel_${i}` });await new Promise(resolve => setTimeout(resolve, 3));
    })));
    const loaded = await f.store.transaction(async state => state);
    expect(loaded.accounts).toHaveLength(8);expect(new Set(loaded.accounts.map(a => a.clientId)).size).toBe(8);
  });
  it("does not commit a thrown operation or a failed encryption", async () => {
    const f = await fixture();await seed(f.store); const before = await readFile(f.store.file);
    await expect(f.store.transaction(async state => {state.accounts = [];throw new Error("private-provider-content");})).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(await readFile(f.store.file)).toEqual(before);
    const broken = new ChatGPTAccountStore(f.directory, { decrypt: f.cipher.decrypt, encrypt: async () => {throw new Error("private-provider-content");} });
    await expect(broken.transaction(async state => {state.accounts[0].email = "updated@example.invalid";})).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(await readFile(f.store.file)).toEqual(before);expect(await readdir(f.directory)).toEqual(["accounts.enc"]);
  });
  it("preserves corrupted ciphertext instead of resetting accounts or the host", async () => {
    const f = await fixture(); await seed(f.store); const bytes = await readFile(f.store.file); bytes[bytes.length - 1] ^= 1; await writeFile(f.store.file, bytes);
    await expect(f.store.transaction(async state => state.hostId)).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(await readFile(f.store.file)).toEqual(bytes);
  });
  it("rejects host, client and subject credential mixing before committing", async () => {
    const f = await fixture(); await seed(f.store);const before = await readFile(f.store.file);
    for (const field of ["hostId", "clientId", "subject"] as const) {
      await expect(f.store.transaction(async state => {state.accounts[0].credentials![field] = "wrong-account";})).rejects.toMatchObject({ code: "invalid_account_data" });
      expect(await readFile(f.store.file)).toEqual(before);
    }
  });
  it("rejects oversized encrypted files without decrypting them", async () => {
    const f = await fixture();await seed(f.store); await writeFile(f.store.file, Buffer.alloc(8 * 1024 * 1024 + 1));
    const decrypt = vi.fn(f.cipher.decrypt);const guarded = new ChatGPTAccountStore(f.directory, { encrypt: f.cipher.encrypt, decrypt });
    await expect(guarded.transaction(async state => state)).rejects.toMatchObject({ code: "invalid_account_data" });expect(decrypt).not.toHaveBeenCalled();
  });
  it("does not follow a replaced credential-file symlink", async () => {
    const f = await fixture();await seed(f.store); const outside = join(f.root, "outside");await writeFile(outside, "private-outside-content");await rm(f.store.file);await symlink(outside, f.store.file);
    await expect(f.store.transaction(async state => state)).rejects.toMatchObject({ code: "storage_unavailable" });expect(await readFile(outside, "utf8")).toBe("private-outside-content");
  });
  it("rejects unsafe existing permissions without changing them", async () => {
    if (process.platform === "win32") return;
    const f = await fixture();await seed(f.store);await chmod(f.store.file, 0o644);
    await expect(f.store.transaction(async state => state)).rejects.toMatchObject({ code: "storage_unavailable" });expect((await stat(f.store.file)).mode & 0o777).toBe(0o644);
  });
  it("cancels a stalled operation without committing late state", async () => {
    const f = await fixture();await seed(f.store);const before = await readFile(f.store.file);const controller = new AbortController();
    let started!: () => void;const ready = new Promise<void>(resolve => {started = resolve;});let finish!: () => void;
    const work = f.store.transaction(async state => {started();await new Promise<void>(resolve => {finish = resolve;});state.accounts[0].email = "late@example.invalid";}, { signal: controller.signal });
    const rejected = expect(work).rejects.toMatchObject({ code: "cancelled" });await ready;controller.abort();await rejected;finish();await new Promise(resolve => setTimeout(resolve, 10));
    expect(await readFile(f.store.file)).toEqual(before);expect(await readdir(f.directory)).toEqual(["accounts.enc"]);
  });
  it("cancels lock acquisition immediately and releases any lease acquired later", async () => {
    const f = await fixture();await seed(f.store);
    let ownerReady!: () => void;const ownerStarted = new Promise<void>(resolve => { ownerReady = resolve; });
    let releaseOwner!: () => void;const hold = new Promise<void>(resolve => { releaseOwner = resolve; });
    const owner = f.store.transaction(async () => {ownerReady();await hold;});await ownerStarted;
    let acquisitionReady!: () => void;const acquisitionStarted = new Promise<void>(resolve => {acquisitionReady = resolve;});
    const original = lockfile.lock; const spy = vi.spyOn(lockfile, "lock").mockImplementation((file, options) => {const acquisition = original(file, options);acquisitionReady();return acquisition;});
    const controller = new AbortController();let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const waiter = f.store.transaction(async () => {throw new Error("Cancelled acquisition must not run this operation");}, { signal: controller.signal });
      const cancelled = expect(waiter).rejects.toMatchObject({ code: "cancelled" });await acquisitionStarted;controller.abort();
      await Promise.race([cancelled, new Promise<never>((_, reject) => {timeout = setTimeout(() => reject(new Error("Lock cancellation stalled")), 250);})]);
    } finally {if(timeout)clearTimeout(timeout);spy.mockRestore();releaseOwner();await owner;}
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((await f.store.transaction(async state => state.accounts)).length).toBe(1);
    expect(await readdir(f.directory)).toEqual(["accounts.enc"]);
  });

  it("rejects inconsistent inference grants and invalid saved hint fields", () => {
    const valid = credentials("urn:uuid:0d5f5840-f9ac-4cfa-a48b-f5c0e4064bf1");expect(validChatGPTCredentials(valid)).toBe(true);
    for (const changed of [{ planEnabled: false }, { scopes: ["openid"] }, { email: "x".repeat(321) }, { idToken: "x".repeat(16385) }, { receivedAt: Infinity }]) expect(validChatGPTCredentials({ ...valid, ...changed })).toBe(false);
  });
});

describe("Electron protected-storage adapter", () => {
  function storage() { return { isEncryptionAvailable: vi.fn(() => true), encryptString: vi.fn((text: string) => Buffer.from(text)), decryptString: vi.fn((bytes: Buffer) => bytes.toString()), getSelectedStorageBackend: vi.fn(() => "basic_text") }; }
  it("does not initialize the OS credential provider until explicitly used", () => {
    const provider = storage();createChatGPTStorageCipher(provider, "linux");expect(provider.isEncryptionAvailable).not.toHaveBeenCalled();
  });
  it("rejects Linux plaintext and unknown fallback providers", async () => {
    const provider = storage();const cipher = createChatGPTStorageCipher(provider, "linux");
    await expect(cipher.encrypt("dummy-private-token")).rejects.toMatchObject({ code: "storage_unavailable" });expect(provider.encryptString).not.toHaveBeenCalled();
    provider.getSelectedStorageBackend.mockReturnValue("unknown");await expect(cipher.decrypt(Buffer.from("dummy"))).rejects.toMatchObject({ code: "storage_unavailable" });expect(provider.decryptString).not.toHaveBeenCalled();
  });
  it("uses asynchronous protected storage on macOS and rejects unavailability", async () => {
    const provider = { ...storage(), isAsyncEncryptionAvailable: vi.fn(async () => true), encryptStringAsync: vi.fn(async () => Buffer.from("encrypted-fixture")), decryptStringAsync: vi.fn(async () => ({ result: "decrypted-fixture", shouldReEncrypt: true })) };
    const cipher = createChatGPTStorageCipher(provider, "darwin");expect((await cipher.encrypt("dummy" )).toString()).toBe("encrypted-fixture");expect(await cipher.decrypt(Buffer.from("fixture"))).toBe("decrypted-fixture");expect(provider.encryptString).not.toHaveBeenCalled();
    provider.isAsyncEncryptionAvailable.mockResolvedValue(false);await expect(cipher.encrypt("dummy")).rejects.toMatchObject({ code: "storage_unavailable" });
  });
});
