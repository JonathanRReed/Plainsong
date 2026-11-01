import { describe, expect, it, vi } from "vitest";
import { createChatGPTPlanAPI, ChatGPTPlanError } from "../../electron/chatgpt-plan-api";

const token = "private-test-token";
const grant = { accessToken: token, scopes: ["resource.invoke", "chatgpt.tokens.use.direct"] };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const delta = (text: string) => ({ type: "response.output_text.delta", delta: text });
const done = (text?: string) => ({ type: "response.completed", response: { status: "completed", ...(text === undefined ? {} : { output: [{ type: "message", content: [{ type: "output_text", text }] }] }) } });
function stream(frames: unknown[], bytewise = false) {
  const bytes = new TextEncoder().encode(frames.map(event).join(""));
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    if (bytewise) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}
function setup(response: Response, remote = true) {
  const fetch = vi.fn().mockResolvedValue(response);
  const getGrant = vi.fn().mockResolvedValue(grant);
  return { fetch, getGrant, api: createChatGPTPlanAPI({ fetch, getGrant, remoteProcessingEnabled: () => remote }) };
}

describe("official ChatGPT-plan request boundary", () => {
  it.each(["completion", "catalog", "error body"])("reports interrupted %s reads as unavailable without returning partial content", async kind => {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode(kind === "completion"
        ? event(delta("partial private output")) : '{"models":['));
      else controller.error(new TypeError(`connection reset ${token}`));
    } });
    const response = new Response(body, { status: kind === "error body" ? 503 : 200,
      headers: { "Content-Type": kind === "completion" ? "text/event-stream" : "application/json" } });
    const { api, fetch } = setup(response);
    const error = await (kind === "completion" ? api.complete({ model: "gpt-example", text: "hello" }) : api.listModels()).catch(e => e);
    expect(error).toMatchObject({ code: "unavailable" });
    expect(JSON.stringify(error)).not.toContain(token);
    expect(JSON.stringify(error)).not.toContain("partial private output");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("reports transport failure as unavailable and permits a later request with the same grant", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError(`fetch failed ${token}`))
      .mockResolvedValueOnce(stream([done("recovered")]));
    const getGrant = vi.fn().mockResolvedValue(grant);
    const api = createChatGPTPlanAPI({ fetch, getGrant, remoteProcessingEnabled: () => true });
    const error = await api.complete({ model: "gpt-example", text: "hello" }).catch(e => e);
    expect(error).toMatchObject({ code: "unavailable" });
    expect(error.message).not.toContain(token);
    expect(fetch).toHaveBeenCalledOnce();
    expect(await api.complete({ model: "gpt-example", text: "hello" })).toBe("recovered");
    expect(getGrant).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${token}`);
  });
  it("retains bounded failure diagnostics without retaining raw service text", async () => {
    const { api } = setup(Response.json({ error: {
      code: "subscription_sharing_unsupported_capability", param: "input[0].content[0].type", message: token,
    } }, { status: 400, headers: { "x-request-id": "req_test_123" } }));
    const error = await api.listModels().catch(e => e);
    expect(error).toMatchObject({ code: "invalid_request", diagnostics: {
      httpStatus: 400, providerCode: "subscription_sharing_unsupported_capability",
      param: "input[0].content[0].type", requestId: "req_test_123", responseShape: "structured_error",
    } });
    expect(JSON.stringify(error)).not.toContain(token);
  });
  it("preserves direct-admission shape and rejects unsafe diagnostic fields", async () => {
    const detail = await setup(Response.json({ detail: token }, { status: 403 })).api.listModels().catch(e => e);
    expect(detail).toMatchObject({ diagnostics: { httpStatus: 403, responseShape: "detail" } });
    const unsafe = await setup(Response.json({ error: { code: token, param: token, message: token } }, {
      status: 503, headers: { "x-request-id": `https://example.test/${token}` },
    })).api.listModels().catch(e => e);
    expect(unsafe.diagnostics).toEqual({ httpStatus: 503, responseShape: "structured_error" });
    expect(JSON.stringify(detail)).not.toContain(token);
    expect(JSON.stringify(unsafe)).not.toContain(token);
  });
  it("retains streaming failure metadata without returning partial output", async () => {
    const response = stream([delta("partial"), { type: "response.failed", response: { error: {
      code: "subscription_sharing_usage_limit_exceeded", message: token,
    } } }]);
    response.headers.set("x-request-id", "req_stream_123");
    const error = await setup(response).api.complete({ model: "gpt-example", text: "hello" }).catch(e => e);
    expect(error).toMatchObject({ code: "usage_limit", diagnostics: {
      httpStatus: 200, providerCode: "subscription_sharing_usage_limit_exceeded",
      requestId: "req_stream_123", responseShape: "stream_error",
    } });
    expect(JSON.stringify(error)).not.toContain(token);
    expect(JSON.stringify(error)).not.toContain("partial");
  });
  it("keeps opaque request identifiers and removes credentials embedded in identifiers", async () => {
    const opaque = await setup(Response.json({ error: { code: "server_error" } }, {
      status: 503, headers: { "x-request-id": "04f4a30c-c049-4687-a9ef-bd2f60b471a5" },
    })).api.listModels().catch(e => e);
    expect(opaque.diagnostics.requestId).toBe("04f4a30c-c049-4687-a9ef-bd2f60b471a5");
    expect(opaque.diagnostics.providerCode).toBe("server_error");
    const embedded = await setup(Response.json({ error: { code: "server_error" } }, {
      status: 503, headers: { "x-request-id": `req_${token}` },
    })).api.listModels().catch(e => e);
    expect(embedded.diagnostics.requestId).toBeUndefined();
    expect(JSON.stringify(embedded)).not.toContain(token);
  });
  it("redacts credential values even when they resemble valid diagnostic identifiers", async () => {
    const secret = "private_test_token";
    const api = createChatGPTPlanAPI({ remoteProcessingEnabled: () => true,
      getGrant: async () => ({ ...grant, accessToken: secret }),
      fetch: async () => Response.json({ error: {
        code: `subscription_sharing_${secret}`, param: `input.${secret}`, message: secret,
      } }, { status: 403, headers: { "x-request-id": `req_${secret}` } }),
    });
    const error = await api.listModels().catch(e => e);
    expect(error.diagnostics).toEqual({ httpStatus: 403, responseShape: "structured_error" });
    expect(JSON.stringify(error)).not.toContain(secret);
  });
  it("keeps tokens unread and makes no request when cloud processing is off", async () => {
    const { api, getGrant, fetch } = setup(stream([done("ok")]), false);
    await expect(api.complete({ model: "gpt-example", text: "hello" })).rejects.toMatchObject({ code: "cloud_disabled" });
    expect(getGrant).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("requires the inference scopes rather than identity-only sign-in", async () => {
    const fetch = vi.fn();
    const api = createChatGPTPlanAPI({ fetch, remoteProcessingEnabled: () => true,
      getGrant: async () => ({ accessToken: token, scopes: ["openid", "email"] }) });
    await expect(api.listModels()).rejects.toMatchObject({ code: "permission_required" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lists visible account models in server order and rejects the API-key catalog shape", async () => {
    const { api } = setup(Response.json({ models: [
      { slug: "second", display_name: "Second", visibility: "list" },
      { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
      { slug: "first", display_name: "First", visibility: "list" },
      { slug: "second", display_name: "Duplicate", visibility: "list" },
    ] }));
    expect(await api.listModels()).toEqual([{ slug: "second", displayName: "Second" }, { slug: "first", displayName: "First" }]);
    await expect(setup(Response.json({ data: [] })).api.listModels()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("sends only supported text Responses fields with the OAuth bearer", async () => {
    const { api, fetch } = setup(stream([delta("clear"), done("clear")]));
    expect(await api.complete({ model: "gpt-example", text: "  keep indent\n", instructions: "Preserve meaning." })).toBe("clear");
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(request.redirect).toBe("error");
    expect(request.headers.Authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(request.body)).toEqual({ model: "gpt-example", input: [{ role: "user", content: "  keep indent\n" }], instructions: "Preserve meaning.", store: false, stream: true });
  });

  it("handles split UTF-8 and CRLF and uses the completed canonical text", async () => {
    const { api } = setup(stream([delta("Café"), done("Café, Priya.")], true));
    expect(await api.complete({ model: "gpt-example", text: "hello" })).toBe("Café, Priya.");
  });

  it.each([
    [delta("unfinished")],
    [delta("unfinished"), { type: "response.incomplete", response: { status: "incomplete" } }],
    [{ type: "response.completed", response: { status: "failed" } }],
    [done("")],
  ])("never returns unfinished or empty text as success", async (...frames) => {
    const { api } = setup(stream(frames));
    await expect(api.complete({ model: "gpt-example", text: "hello" })).rejects.toBeInstanceOf(ChatGPTPlanError);
  });

  it("rejects a usage failure after deltas without leaking service content or tokens", async () => {
    const { api } = setup(stream([delta("partial"), { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: token } } }]));
    await expect(api.complete({ model: "gpt-example", text: "hello" })).rejects.toMatchObject({ code: "usage_limit" });
    const error = await setup(new Response(JSON.stringify({ error: { message: token } }), { status: 401 })).api.listModels().catch(e => e);
    expect(error.code).toBe("sign_in_required"); expect(error.message).not.toContain(token);
  });

  it.each([
    ["subscription_sharing_user_not_eligible", "not_eligible"],
    ["subscription_sharing_route_not_supported", "invalid_request"],
    ["chatpass_v2_scope_not_authorized", "access_restricted"],
    ["chatpass_v2_invalid_authorization_context", "access_restricted"],
  ])("does not turn %s into a renewed-consent request", async (upstream, expected) => {
    for (const response of [
      Response.json({ error: { code: upstream, message: token } }, { status: 403 }),
      stream([delta("partial"), { type: "response.failed", response: { error: { code: upstream, message: token } } }]),
    ]) {
      const { api, fetch, getGrant } = setup(response);
      const error = await api.complete({ model: "gpt-example", text: "fixture" }).catch(e => e);
      expect(error).toMatchObject({ code: expected });
      expect(error.message).not.toContain(token);
      expect(fetch).toHaveBeenCalledOnce();
      expect(getGrant).toHaveBeenCalledOnce();
    }
  });

  it("keeps policy restrictions separate from temporary availability failures", async () => {
    const restricted = await setup(Response.json({ detail: token }, { status: 403 })).api.listModels().catch(e => e);
    expect(restricted).toMatchObject({ code: "access_restricted" });
    expect(restricted.message).not.toContain(token);
    const unavailable = await setup(Response.json({ error: { code: "subscription_sharing_usage_unavailable" } }, { status: 503 })).api.listModels().catch(e => e);
    expect(unavailable).toMatchObject({ code: "unavailable" });
  });

  it("honors cancellation before reading credentials and during a slow grant read", async () => {
    const controller = new AbortController(); controller.abort();
    const { api, getGrant } = setup(stream([done("ok")]));
    await expect(api.listModels({ signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(getGrant).not.toHaveBeenCalled();
    const fetch = vi.fn(); let resolve!: (value: typeof grant) => void;
    const slow = createChatGPTPlanAPI({ fetch, remoteProcessingEnabled: () => true, getGrant: () => new Promise(r => { resolve = r; }) });
    await expect(slow.listModels({ timeoutMs: 5 })).rejects.toMatchObject({ code: "cancelled" });
    resolve(grant); await Promise.resolve(); expect(fetch).not.toHaveBeenCalled();
  });

  it("fails malformed SSE without echoing content", async () => {
    const { api } = setup(new Response(`data: ${token}\n\n`, { headers: { "Content-Type": "text/event-stream" } }));
    const error = await api.complete({ model: "gpt-example", text: "hello" }).catch(e => e);
    expect(error.code).toBe("invalid_response"); expect(error.message).not.toContain(token);
  });

  it("cancels a stalled response reader instead of leaving it live after the deadline", async () => {
    const cancel = vi.fn();
    const { api } = setup(new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": "text/event-stream" } }));
    await expect(api.complete({ model: "gpt-example", text: "hello" }, { timeoutMs: 5 })).rejects.toMatchObject({ code: "cancelled" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not substitute earlier deltas for an empty canonical completed output", async () => {
    const { api } = setup(stream([delta("partial"), { type: "response.completed", response: { status: "completed", output: [] } }]));
    await expect(api.complete({ model: "gpt-example", text: "hello" })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("bounds service response bytes before accepting a completion", async () => {
    const { api } = setup(new Response(new Uint8Array(8 * 1024 * 1024 + 1), { headers: { "Content-Type": "text/event-stream" } }));
    await expect(api.complete({ model: "gpt-example", text: "hello" })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("checks cloud permission again after a slow credential lookup", async () => {
    let allowed = true;
    const fetch = vi.fn();
    const api = createChatGPTPlanAPI({ fetch, remoteProcessingEnabled: () => allowed,
      getGrant: async () => { allowed = false; return grant; } });
    await expect(api.listModels()).rejects.toMatchObject({ code: "cloud_disabled" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

 it("returns at its deadline even when an injected fetch never settles", async () => {
   const fetch = vi.fn(() => new Promise<Response>(() => {}));
   const api = createChatGPTPlanAPI({ fetch, remoteProcessingEnabled: () => true, getGrant: async () => grant });
   await expect(api.complete({ model: "gpt-example", text: "hello" }, { timeoutMs: 20 })).rejects.toMatchObject({ code: "cancelled" });
 });
