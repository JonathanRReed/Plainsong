/** Official ChatGPT-plan HTTP boundary. OAuth and credential storage stay in
 * the trusted main process; this module never opens sign-in or persists tokens. */
export interface ChatGPTPlanGrant {
  accessToken: string;
  scopes: readonly string[];
}

export interface ChatGPTPlanModel {
  slug: string;
  displayName: string;
}

export type ChatGPTPlanErrorCode =
  | "cloud_disabled" | "sign_in_required" | "permission_required"
  | "not_eligible" | "access_restricted"
  | "usage_limit" | "unavailable" | "cancelled" | "invalid_request" | "invalid_response";

const MESSAGES: Record<ChatGPTPlanErrorCode, string> = {
  cloud_disabled: "Enable cloud processing before using your ChatGPT plan.",
  sign_in_required: "Connect your ChatGPT account to continue.",
  permission_required: "Allow ChatGPT plan usage for Plainsong to continue.",
  not_eligible: "ChatGPT plan usage is unavailable for this account or workspace. Choose another account or a local model.",
  access_restricted: "ChatGPT blocked this connection's plan access. Choose another account or a local model.",
  usage_limit: "A ChatGPT app or plan usage limit has been reached. Review ChatGPT usage or choose a local model.",
  unavailable: "ChatGPT plan usage is temporarily unavailable. Try again later.",
  cancelled: "The ChatGPT request was cancelled.",
  invalid_request: "This request is not supported by ChatGPT plan usage.",
  invalid_response: "ChatGPT did not return a completed text response. Try again.",
};

export interface ChatGPTPlanFailureDetails {
  httpStatus?: number;
  providerCode?: string;
  param?: string;
  requestId?: string;
  responseShape?: "structured_error" | "detail" | "other" | "unparseable" | "stream_error";
}

export class ChatGPTPlanError extends Error {
  constructor(readonly code: ChatGPTPlanErrorCode, readonly diagnostics?: Readonly<ChatGPTPlanFailureDetails>) {
    super(MESSAGES[code]);
    this.name = "ChatGPTPlanError";
  }
}

interface Dependencies {
  getGrant(signal?: AbortSignal): Promise<ChatGPTPlanGrant>;
  remoteProcessingEnabled(): boolean;
  fetch?: typeof globalThis.fetch;
}

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const API = "https://api.openai.com/v1";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;

async function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); throw new ChatGPTPlanError("cancelled"); }
  let cancel: () => void = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      cancel = () => reject(new ChatGPTPlanError("cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
    })]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function failureFor(code: unknown, context: {
  httpStatus: number; param?: unknown; requestId?: string | null;
  accessToken: string;
  responseShape: ChatGPTPlanFailureDetails["responseShape"];
}): ChatGPTPlanError {
  // Preserve machine-readable diagnostics, never arbitrary service messages,
  // response bodies, identity details or credentials.
  const withoutCredential = (value: string) => !value.includes(context.accessToken);
  const diagnostics = Object.freeze({
    httpStatus: context.httpStatus,
    ...(typeof code === "string" && /^[a-z][a-z0-9_]{0,95}$/.test(code) && withoutCredential(code)
      ? { providerCode: code } : {}),
    ...(typeof context.param === "string" && context.param.length <= 128
      && /^(?:input|model|instructions|tools|tool_choice|store|stream|service_tier|reasoning|text|max_output_tokens|previous_response_id|prompt|metadata)(?:\.[a-z_][a-z0-9_]*|\[\d+\])*$/.test(context.param)
      && withoutCredential(context.param) ? { param: context.param } : {}),
    ...(typeof context.requestId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(context.requestId)
      && withoutCredential(context.requestId)
      ? { requestId: context.requestId } : {}),
    responseShape: context.responseShape,
  });
  const failure = (appCode: ChatGPTPlanErrorCode) => new ChatGPTPlanError(appCode, diagnostics);
  if (code === "subscription_sharing_usage_limit_exceeded" || context.httpStatus === 429) return failure("usage_limit");
  if (code === "subscription_sharing_user_not_eligible") return failure("not_eligible");
  if (code === "subscription_sharing_route_not_supported") return failure("invalid_request");
  if (code === "subscription_sharing_scope_required") return failure("permission_required");
  if (code === "chatpass_v2_scope_not_authorized" || code === "chatpass_v2_invalid_authorization_context" || context.httpStatus === 403) return failure("access_restricted");
  if (code === "subscription_sharing_invalid_user" || code === "invalid_api_key" || code === "token_expired" || context.httpStatus === 401) return failure("sign_in_required");
  if (code === "subscription_sharing_unsupported_capability" || context.httpStatus === 400) return failure("invalid_request");
  return failure("unavailable");
}

function modelSlug(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value);
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  try { return await untilAbort(reader.read(), signal); }
  catch {
    throw new ChatGPTPlanError(signal.aborted ? "cancelled" : "unavailable");
  }
}

async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new ChatGPTPlanError("invalid_response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await readChunk(reader, signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new ChatGPTPlanError("invalid_response");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
  }
}

function completedText(response: Record<string, unknown>, fallback: string): string {
  if (response.status !== "completed") throw new ChatGPTPlanError("invalid_response");
  const output = response.output;
  if (!Array.isArray(output)) return fallback;
  const texts: string[] = [];
  for (const item of output) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (content?.type === "output_text" && typeof content.text === "string") texts.push(content.text);
    }
  }
  return texts.join("");
}

async function collectCompletedText(response: Response, signal: AbortSignal, accessToken: string): Promise<string> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new ChatGPTPlanError("invalid_response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let pending = "";
  let output = "";
  try {
    while (true) {
      const chunk = await readChunk(reader, signal);
      if (chunk.done) throw new ChatGPTPlanError("invalid_response");
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new ChatGPTPlanError("invalid_response");
      pending += decoder.decode(chunk.value, { stream: true });
      // SSE separates events with blank lines; CRLF may span network chunks.
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data || data === "[DONE]") continue;
        const event = JSON.parse(data);
        if (event.type === "response.output_text.delta") {
          if (typeof event.delta !== "string") throw new ChatGPTPlanError("invalid_response");
          output += event.delta;
        } else if (event.type === "response.failed" || event.type === "error") {
          throw failureFor(event.response?.error?.code ?? event.code ?? event.error?.code, {
            httpStatus: response.status,
            accessToken,
            param: event.response?.error?.param ?? event.param ?? event.error?.param,
            requestId: response.headers.get("x-request-id"), responseShape: "stream_error",
          });
        } else if (event.type === "response.incomplete") {
          throw new ChatGPTPlanError("invalid_response");
        } else if (event.type === "response.completed") {
          const text = completedText(event.response ?? {}, output);
          if (!text.trim()) throw new ChatGPTPlanError("invalid_response");
          return text;
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
  }
}

export function createChatGPTPlanAPI(dependencies: Dependencies) {
  async function request<T>(path: string, body: unknown | undefined, options: RequestOptions, consume: (response: Response, signal: AbortSignal, accessToken: string) => Promise<T>): Promise<T> {
    if (!dependencies.remoteProcessingEnabled()) throw new ChatGPTPlanError("cloud_disabled");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10 * 60_000) throw new ChatGPTPlanError("invalid_request");
    const timer = setTimeout(cancel, timeoutMs);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    try {
      if (controller.signal.aborted) throw new ChatGPTPlanError("cancelled");
      let grant: ChatGPTPlanGrant;
      try { grant = await untilAbort(dependencies.getGrant(controller.signal), controller.signal); } catch (error) {
        if (error instanceof ChatGPTPlanError) throw error;
        throw new ChatGPTPlanError("sign_in_required");
      }
      if (controller.signal.aborted) throw new ChatGPTPlanError("cancelled");
      if (!grant.scopes.includes("resource.invoke") || !grant.scopes.includes("chatgpt.tokens.use.direct")) throw new ChatGPTPlanError("permission_required");
      if (!grant.accessToken || /[\r\n]/.test(grant.accessToken)) throw new ChatGPTPlanError("sign_in_required");
      if (!dependencies.remoteProcessingEnabled()) throw new ChatGPTPlanError("cloud_disabled");
      let response: Response;
      try { response = await untilAbort((dependencies.fetch ?? globalThis.fetch)(`${API}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${grant.accessToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      }), controller.signal); } catch (error) {
        if (controller.signal.aborted) throw new ChatGPTPlanError("cancelled");
        if (error instanceof ChatGPTPlanError) throw error;
        throw new ChatGPTPlanError("unavailable");
      }
      if (!response.ok) {
        let payload;
        let responseShape: ChatGPTPlanFailureDetails["responseShape"] = "other";
        try {
          payload = JSON.parse(await untilAbort(boundedText(response, controller.signal), controller.signal));
          if (payload?.error && typeof payload.error === "object" && !Array.isArray(payload.error)) responseShape = "structured_error";
          else if (typeof payload?.detail === "string") responseShape = "detail";
        } catch (error) {
          if (error instanceof ChatGPTPlanError && (error.code === "unavailable" || error.code === "cancelled")) throw error;
          responseShape = "unparseable";
        }
        throw failureFor(payload?.error?.code, {
          httpStatus: response.status, param: payload?.error?.param, accessToken: grant.accessToken,
          requestId: response.headers.get("x-request-id"), responseShape,
        });
      }
      const result = await untilAbort(consume(response, controller.signal, grant.accessToken), controller.signal);
      if (controller.signal.aborted) throw new ChatGPTPlanError("cancelled");
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw new ChatGPTPlanError("cancelled");
      if (error instanceof ChatGPTPlanError) throw error;
      throw new ChatGPTPlanError("invalid_response");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    }
  }

  return {
    async listModels(options: RequestOptions = {}): Promise<ChatGPTPlanModel[]> {
      return request("/models", undefined, options, async (response, signal) => {
        const data = JSON.parse(await boundedText(response, signal));
        if (!Array.isArray(data.models)) throw new ChatGPTPlanError("invalid_response");
        const seen = new Set<string>();
        return data.models.filter((model: Record<string, unknown>) => model.visibility === "list" && modelSlug(model.slug)
          && typeof model.display_name === "string" && model.display_name.length > 0 && model.display_name.length <= 256
          && !seen.has(model.slug) && Boolean(seen.add(model.slug)))
          .map((model: Record<string, string>) => ({ slug: model.slug, displayName: model.display_name }));
      });
    },
    async complete(input: { model: string; text: string; instructions?: string }, options: RequestOptions = {}): Promise<string> {
      if (!modelSlug(input.model) || typeof input.text !== "string" || !input.text.trim()
        || Buffer.byteLength(input.text, "utf8") > MAX_INPUT_BYTES
        || (input.instructions !== undefined && (typeof input.instructions !== "string" || Buffer.byteLength(input.instructions, "utf8") > 64 * 1024))) throw new ChatGPTPlanError("invalid_request");
      return request("/responses", {
        model: input.model,
        input: [{ role: "user", content: input.text }],
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        store: false,
        stream: true,
      }, options, collectCompletedText);
    },
  };
}
