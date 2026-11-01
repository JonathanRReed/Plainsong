import { afterEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";
import { startChatGPTPlanRelay } from "../../electron/chatgpt-plan-relay";
import { ChatGPTPlanError } from "../../electron/chatgpt-plan-api";
const running: Array<Awaited<ReturnType<typeof startChatGPTPlanRelay>>> = [];
afterEach(async () => { for(const relay of running.splice(0)) await relay.close(); });
async function fixture(cloud = true, onStatus?: () => void) {
  const complete = vi.fn(async (_input: {model:string;text:string;instructions?:string}, _options?: {signal?:AbortSignal;timeoutMs?:number}) => "Meaning preserved.");
  const relay = await startChatGPTPlanRelay({ session: { complete },status: () => { onStatus?.();return { cloudEnabled: cloud, loaded: true, connected: true, planEnabled: true }; },models: () => [{ slug: "account-model", displayName: "Account model" }] });running.push(relay);
  return { relay, complete, url: relay.sidecarEnvironment.PLAINSONG_CHATGPT_RELAY_URL, headers: { Authorization: `Bearer ${relay.sidecarEnvironment.PLAINSONG_CHATGPT_RELAY_KEY}`, "Content-Type": "application/json" } };
}
async function postChunked(url: string, headers: Record<string, string>, chunks: string[]) {
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(url, { method: "POST", headers }, response => {
      const body: Buffer[] = [];
      response.on("data", chunk => body.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(body).toString("utf8") }));
    });
    request.on("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}
describe("private ChatGPT text relay", () => {
  it("rejects unauthenticated or browser-origin callers without reading a session", async () => {
    const f = await fixture();
    expect((await fetch(f.url+"/complete",{method:"POST",body:'{}'})).status).toBe(401);
    expect((await fetch(f.url+"/complete",{method:"POST",headers:{...f.headers,Origin:"https://example.invalid"},body:'{}'})).status).toBe(403);
    expect(f.complete).not.toHaveBeenCalled();
  });
  it("sends exact text and trusted instructions through the session and returns the selected model", async () => {
    const f = await fixture();const response = await fetch(f.url+"/complete",{method:"POST",headers:f.headers,body:JSON.stringify({model:"account-model",text:"  keep indent\n",instructions:"Preserve meaning.",timeoutMs:2000})});
    expect(await response.json()).toEqual({text:"Meaning preserved.",model:"account-model"});
    expect(f.complete.mock.calls[0][0]).toEqual({model:"account-model",text:"  keep indent\n",instructions:"Preserve meaning."});
    expect(f.complete.mock.calls[0][1]).toMatchObject({timeoutMs:2000});
  });
  it("returns public cached status/models and never an OAuth credential", async () => {
    const f = await fixture();const status = await (await fetch(f.url+"/status",{headers:f.headers})).json();
    expect(status).toEqual({cloudEnabled:true,loaded:true,connected:true,planEnabled:true});
    expect(await (await fetch(f.url+"/models",{headers:f.headers})).json()).toEqual([{slug:"account-model",displayName:"Account model"}]);expect(f.complete).not.toHaveBeenCalled();
  });
  it("blocks text and models while cloud is disabled", async () => {
    const f = await fixture(false);
    const response = await fetch(f.url+"/complete",{method:"POST",headers:f.headers,body:JSON.stringify({model:"account-model",text:"private-fixture"})});
    expect((await response.json()).error.code).toBe("cloud_disabled");expect(f.complete).not.toHaveBeenCalled();
  });
  it("rejects extra request fields and oversized bodies with a content length", async () => {
    const f = await fixture();
    expect((await fetch(f.url+"/complete",{method:"POST",headers:f.headers,body:JSON.stringify({model:"account-model",text:"fixture",accessToken:"must-not-forward"})})).status).toBe(400);
    const response = await fetch(f.url+"/complete",{method:"POST",headers:f.headers,body:"x".repeat(1024*1024+1)});
    expect(response.status).toBe(413);expect((await response.json()).error.code).toBe("invalid_request");expect(f.complete).not.toHaveBeenCalled();
  });
  it("drains and rejects oversized chunked bodies without calling the session", async () => {
    const f = await fixture();
    const response = await postChunked(f.url+"/complete",f.headers,["x".repeat(512*1024),"x".repeat(512*1024),"x"]);
    expect(response.status).toBe(413);expect(JSON.parse(response.body).error.code).toBe("invalid_request");expect(f.complete).not.toHaveBeenCalled();
  });
  it("survives a client abort while draining a known oversized body", async () => {
    let headersReceived!: () => void;const received = new Promise<void>(resolve => { headersReceived = resolve; });
    const f = await fixture(true, headersReceived);
    const aborted = new Promise<void>(resolve => {
      const request = httpRequest(f.url+"/complete",{method:"POST",headers:{...f.headers,"Content-Length":String(1024*1024+1)}});
      request.on("error", () => resolve());request.flushHeaders();void received.then(() => request.destroy());
    });
    await received;await aborted;
    const response = await fetch(f.url+"/complete",{method:"POST",headers:f.headers,body:JSON.stringify({model:"account-model",text:"still alive"})});
    expect(response.status).toBe(200);expect(f.complete).toHaveBeenCalledOnce();
  });
  it.each(["not_eligible", "access_restricted"] as const)("preserves the nonretryable %s code across the private relay", async code => {
    const f = await fixture();
    f.complete.mockRejectedValue(new ChatGPTPlanError(code));
    const response = await fetch(f.url+"/complete", { method:"POST", headers:f.headers, body:JSON.stringify({model:"account-model",text:"fixture"}) });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe(code);
    expect(f.complete).toHaveBeenCalledOnce();
  });

  it("does not echo unexpected session error content", async () => {
    const f = await fixture();f.complete.mockRejectedValue(new Error("dummy-sensitive-provider-content"));
    const response = await fetch(f.url+"/complete",{method:"POST",headers:f.headers,body:JSON.stringify({model:"account-model",text:"fixture"})});
    expect(await response.text()).not.toContain("dummy-sensitive-provider-content");
  });
  it("maps a usage limit without changing billing paths", async () => {
    const f = await fixture();f.complete.mockRejectedValue(new ChatGPTPlanError("usage_limit"));
    const response = await fetch(f.url+"/complete",{method:"POST",headers:f.headers,body:JSON.stringify({model:"account-model",text:"fixture"})});
    expect(response.status).toBe(429);expect((await response.json()).error.code).toBe("usage_limit");
  });
  it("cancels the upstream request when its sidecar connection is aborted", async () => {
    const f = await fixture();let entered!:()=>void;const started = new Promise<void>(resolve=>{entered=resolve;});let signal!:AbortSignal;
    f.complete.mockImplementation(async (_input,_options) => {signal=_options!.signal!;entered();return new Promise<string>(()=>{});});
    const abort = new AbortController();const response = fetch(f.url+"/complete",{method:"POST",headers:f.headers,body:JSON.stringify({model:"account-model",text:"fixture"}),signal:abort.signal});
    const failed=expect(response).rejects.toThrow();await started;abort.abort();await failed;await new Promise(resolve=>setTimeout(resolve,20));expect(signal.aborted).toBe(true);
  });
});
