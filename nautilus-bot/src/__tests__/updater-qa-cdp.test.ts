import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdaterQaCdp } from "../../scripts/lib/updater-qa-cdp";

const expressions: string[] = [];
class FakeSocket extends EventTarget {
  constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
  send(data: string) {
    const request: { id: number; params: { expression: string } } = JSON.parse(data);
    const expression = request.params.expression;
    expressions.push(expression);
    if (expression === "pending") { queueMicrotask(() => this.close()); return; }
    const result = expression === "bad-evaluation"
      ? { exceptionDetails: { text: "fixture exception" }, result: {} }
      : { result: { value: expression.includes("typeof window.electronAPI") ? true : "fixture-value" } };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: request.id, result }) })));
  }
  close() { this.dispatchEvent(new Event("close")); }
}
function setup(socketUrl = "ws://127.0.0.1:12345/devtools/page/test") {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => [
    { type: "page", url: "file:///overlay.html", webSocketDebuggerUrl: "ws://unused" },
    { type: "page", url: "file:///index.html", webSocketDebuggerUrl: socketUrl },
  ] }));
  vi.stubGlobal("WebSocket", FakeSocket);
}
afterEach(() => { vi.unstubAllGlobals(); expressions.splice(0); });

describe("packaged updater CDP driver", () => {
  it("attaches to the main renderer and invokes existing commands with literal JSON arguments", async () => {
    setup();
    const cdp = await UpdaterQaCdp.connect(12345, 500);
    try {
      expect(await cdp.invoke("get_settings", { value: "'); throw new Error('injected" })).toBe("fixture-value");
      expect(expressions[0]).toContain('invoke("get_settings")');
      expect(expressions[1]).toBe('window.electronAPI.invoke("get_settings", {"value":"\'); throw new Error(\'injected"})');
    } finally { cdp.close(); }
  });

  it("rejects renderer exceptions and pending evaluations when the app quits", async () => {
    setup();
    const cdp = await UpdaterQaCdp.connect(12345, 500);
    await expect(cdp.evaluate("bad-evaluation")).rejects.toThrow("fixture exception");
    await expect(cdp.evaluate("pending")).rejects.toThrow("CDP connection closed");
  });

  it("refuses a debugger URL outside the runner's loopback port", async () => {
    setup("ws://example.invalid:12345/devtools/page/test");
    await expect(UpdaterQaCdp.connect(12345, 100)).rejects.toThrow("never exposed");
    expect(expressions).toEqual([]);
  });
});
