import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { ChatGPTPlanError, type ChatGPTPlanModel } from "./chatgpt-plan-api";

export interface ChatGPTPlanRelayStatus { cloudEnabled: boolean; loaded: boolean; connected: boolean; planEnabled: boolean; }
interface Session {
  complete(input: { model: string; text: string; instructions?: string }, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string>;
}
interface Dependencies {
  session: Session;
  status(): ChatGPTPlanRelayStatus;
  models(): readonly ChatGPTPlanModel[];
}
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_ACTIVE_REQUESTS = 4;
function authorized(value: string | undefined, key: string): boolean {
  const actual = Buffer.from(value ?? ""); const expected = Buffer.from(`Bearer ${key}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function completionUntilAbort(work: Promise<string>, signal: AbortSignal): Promise<string> {
  if (signal.aborted) { void work.catch(() => {}); throw new ChatGPTPlanError("cancelled"); }
  let abort = () => {};
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    abort = () => reject(new ChatGPTPlanError("cancelled"));signal.addEventListener("abort", abort, { once: true });
  })]); } finally { signal.removeEventListener("abort", abort); }
}

/** Private text-only bridge. Its generated key belongs only in sidecar startup
 * memory, never renderer/settings. Creation reads no account or OS credentials. */
export async function startChatGPTPlanRelay(dependencies: Dependencies) {
  const key = randomBytes(32).toString("base64url");
  const active = new Set<AbortController>();
  let closed = false;
  let baseURL = "";
  const server = createServer(async (request, response) => {
    const send = (status: number, value: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close" });
      response.end(JSON.stringify(value));
    };
    const error = (status: number, code: string, message: string) => send(status, { error: { code, message } });
    if (closed || !authorized(request.headers.authorization, key)) { error(401, "sign_in_required", "The private ChatGPT connection could not be verified."); return; }
    // This endpoint is for the sidecar, not browser pages or embedded frames.
    if (request.headers.origin !== undefined || request.headers.host !== new URL(baseURL).host) { error(403, "permission_required", "This caller cannot use the private ChatGPT connection."); return; }
    let url: URL;
    try { url = new URL(request.url ?? "", baseURL); } catch { error(400, "invalid_request", "Invalid ChatGPT request."); return; }
    if (url.origin !== baseURL || url.search || url.hash) { error(400, "invalid_request", "Invalid ChatGPT request."); return; }
    const status = dependencies.status();
    if (request.method === "GET" && url.pathname === "/status") { send(200, status); return; }
    if (!status.cloudEnabled) { error(403, "cloud_disabled", "Cloud processing is disabled."); return; }
    if (request.method === "GET" && url.pathname === "/models") {
      if (!status.loaded || !status.connected || !status.planEnabled) { error(401, "sign_in_required", "Check your ChatGPT account in Models before choosing a model."); return; }
      send(200, dependencies.models()); return;
    }
    if (request.method !== "POST" || url.pathname !== "/complete") { error(404, "invalid_request", "This ChatGPT operation is not supported."); return; }
    if (active.size >= MAX_ACTIVE_REQUESTS) { error(503, "busy", "ChatGPT is processing another request. Try again."); return; }
    if (!request.headers["content-type"]?.startsWith("application/json")) { error(400, "invalid_request", "This ChatGPT request must contain JSON."); return; }
    const contentLength = Number(request.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > MAX_INPUT_BYTES) {
      try { for await (const _chunk of request) { /* Drain without retaining the oversized body. */ } }
      catch { return; }
      error(413, "invalid_request", "This ChatGPT request is too large."); return;
    }
    const controller = new AbortController();active.add(controller);
    const deadline = setTimeout(() => controller.abort(), 10 * 60_000);
    const cancel = () => controller.abort();
    const close = () => { if (!response.writableEnded) cancel(); };
    request.once("aborted", cancel);response.once("close", close);
    try {
      const chunks: Buffer[] = [];let bytes = 0;let tooLarge = false;
      for await (const chunk of request) {
        if (controller.signal.aborted) throw new ChatGPTPlanError("cancelled");
        bytes += chunk.length;
        if (bytes > MAX_INPUT_BYTES) { tooLarge = true;continue; }
        chunks.push(Buffer.from(chunk));
      }
      if (tooLarge) { error(413, "invalid_request", "This ChatGPT request is too large."); return; }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      const body = JSON.parse(text);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(name => !["model", "text", "instructions", "timeoutMs"].includes(name))
        || typeof body.model !== "string" || typeof body.text !== "string"
        || (body.instructions !== undefined && typeof body.instructions !== "string")
        || (body.timeoutMs !== undefined && (!Number.isInteger(body.timeoutMs) || body.timeoutMs <= 0 || body.timeoutMs > 10 * 60_000))) {
        throw new ChatGPTPlanError("invalid_request");
      }
      if (controller.signal.aborted) throw new ChatGPTPlanError("cancelled");
      // The session checks cloud permission and the saved grant again before use.
      const output = await completionUntilAbort(dependencies.session.complete({ model: body.model, text: body.text, ...(body.instructions !== undefined ? { instructions: body.instructions } : {}) }, { signal: controller.signal, timeoutMs: body.timeoutMs }), controller.signal);
      if (controller.signal.aborted) throw new ChatGPTPlanError("cancelled");
      send(200, { text: output, model: body.model });
    } catch (failure) {
      if (failure instanceof ChatGPTPlanError) {
        const status = failure.code === "cloud_disabled" || failure.code === "permission_required" || failure.code === "not_eligible" || failure.code === "access_restricted" ? 403 : failure.code === "sign_in_required" ? 401 : failure.code === "usage_limit" ? 429 : failure.code === "invalid_request" ? 400 : 503;
        error(status, failure.code, failure.message);
      } else error(400, "invalid_request", "The ChatGPT request could not be completed.");
    } finally {
      clearTimeout(deadline);active.delete(controller);request.removeListener("aborted", cancel);response.removeListener("close", close);
    }
  });
  server.maxHeadersCount = 32;server.maxConnections = 16;server.headersTimeout = 5_000;server.requestTimeout = 5_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject);server.listen(0, "127.0.0.1", () => {server.removeListener("error", reject);resolve();}); });
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    sidecarEnvironment: { PLAINSONG_CHATGPT_RELAY_URL: baseURL, PLAINSONG_CHATGPT_RELAY_KEY: key },
    async close() { closed = true;for (const controller of active) controller.abort();server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
