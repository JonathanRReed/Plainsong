import { setTimeout as delay } from "node:timers/promises";

/** Small CDP client for the packaged app's explicitly enabled loopback port. */
export class UpdaterQaCdp {
  private nextId = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message: unknown = JSON.parse(String(event.data));
      if (!message || typeof message !== "object" || !("id" in message) || typeof message.id !== "number") return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if ("error" in message) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve("result" in message ? message.result : undefined);
    });
    socket.addEventListener("close", () => {
      for (const entry of this.pending.values()) entry.reject(new Error("App CDP connection closed"));
      this.pending.clear();
    });
  }

  static async connect(port: number, timeoutMs = 30_000): Promise<UpdaterQaCdp> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000), redirect: "error" });
        const targets: unknown = await response.json();
        if (Array.isArray(targets)) {
          const target = targets.find((item: unknown) => item && typeof item === "object" &&
            "type" in item && item.type === "page" && "url" in item && typeof item.url === "string" &&
            !item.url.includes("overlay") && !item.url.startsWith("devtools:"));
          if (target && typeof target === "object" && "webSocketDebuggerUrl" in target && typeof target.webSocketDebuggerUrl === "string") {
            const url = new URL(target.webSocketDebuggerUrl);
            if (url.hostname !== "127.0.0.1" || url.port !== String(port) || url.protocol !== "ws:") throw new Error("Nonlocal CDP endpoint");
            const socket = new WebSocket(url);
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => { socket.close(); reject(new Error("CDP connect timeout")); }, 1000);
              socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
              socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connect failed")); }, { once: true });
            });
            const cdp = new UpdaterQaCdp(socket);
            try {
              if (await cdp.evaluate('typeof window.electronAPI?.invoke === "function" && window.electronAPI.invoke("get_settings").then(() => true, () => false)')) return cdp;
            } catch { /* The renderer or sidecar may not be ready yet. */ }
            cdp.close();
          }
        }
      } catch { /* The app may still be starting or relaunching. */ }
      await delay(100);
    }
    throw new Error("Packaged app never exposed its main renderer on the QA CDP port");
  }

  private send(method: string, params: object): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 10_000);
      this.pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const value = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (!value || typeof value !== "object" || "exceptionDetails" in value || !("result" in value) ||
        !value.result || typeof value.result !== "object") throw new Error(`CDP evaluation failed: ${JSON.stringify(value)}`);
    return "value" in value.result ? value.result.value : undefined;
  }

  invoke(command: string, args: object = {}) {
    return this.evaluate(`window.electronAPI.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
  }
  close() { this.socket.close(); }
}
