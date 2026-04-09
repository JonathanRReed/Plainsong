import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import { randomUUID } from "crypto";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: { event: string; payload: unknown };
}

type PendingRequest = {
  command: string;
  args?: unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type EventCallback = (eventName: string, payload: unknown) => void;
type WindowCommandCallback = (command: string, payload: unknown) => void;
type CommandResolvedCallback = (command: string, args: unknown, result: unknown) => void;
type LocalCommandResult = { handled: boolean; result?: unknown };
type LocalCommandCallback = (
  event: IpcMainInvokeEvent,
  command: string,
  args: unknown
) => Promise<LocalCommandResult> | LocalCommandResult;

export class IpcBridge {
  private sidecarPath: string;
  private process: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private eventCallback: EventCallback | null = null;
  private windowCommandCallback: WindowCommandCallback | null = null;
  private commandResolvedCallback: CommandResolvedCallback | null = null;
  private localCommandCallback: LocalCommandCallback | null = null;
  private shuttingDown = false;
  private restartAttempts = 0;
  private readonly maxRestarts = 5;

  constructor(sidecarPath: string) {
    this.sidecarPath = sidecarPath;
  }

  onEvent(cb: EventCallback): void {
    this.eventCallback = cb;
  }

  onWindowCommand(cb: WindowCommandCallback): void {
    this.windowCommandCallback = cb;
  }

  onCommandResolved(cb: CommandResolvedCallback): void {
    this.commandResolvedCallback = cb;
  }

  onLocalCommand(cb: LocalCommandCallback): void {
    this.localCommandCallback = cb;
  }

  start(): void {
    this.spawnSidecar();
    this.registerIpcHandler();
  }

  private spawnSidecar(): void {
    console.log(`[sidecar] spawning: ${this.sidecarPath}`);

    this.process = spawn(this.sidecarPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const rl = createInterface({ input: this.process.stdout! });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        this.handleSidecarMessage(msg);
      } catch (e) {
        console.warn("[sidecar] unparseable stdout:", line, e);
      }
    });

    this.process.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(`[sidecar] ${chunk.toString()}`);
    });

    this.process.on("exit", (code, signal) => {
      console.warn(`[sidecar] exited: code=${code} signal=${signal}`);
      if (!this.shuttingDown && this.restartAttempts < this.maxRestarts) {
        const delay = Math.min(1000 * 2 ** this.restartAttempts, 30000);
        this.restartAttempts++;
        console.log(`[sidecar] restarting in ${delay}ms (attempt ${this.restartAttempts})`);
        setTimeout(() => this.spawnSidecar(), delay);
      } else if (this.restartAttempts >= this.maxRestarts) {
        console.error("[sidecar] max restarts reached, giving up");
      }
      for (const [, pending] of this.pending) {
        pending.reject(new Error("Sidecar process exited"));
      }
      this.pending.clear();
    });

    this.process.on("spawn", () => {
      console.log("[sidecar] connected");
      this.restartAttempts = 0;
    });
  }

  private handleSidecarMessage(msg: JsonRpcResponse): void {
    if (msg.method === "event" && msg.params) {
      const { event, payload } = msg.params;
      if (event.startsWith("window:")) {
        this.windowCommandCallback?.(event.replace("window:", ""), payload);
      } else {
        this.eventCallback?.(event, payload);
      }
      return;
    }

    if (msg.id !== null && msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message));
      } else {
        pending.resolve(msg.result);
        this.commandResolvedCallback?.(pending.command, pending.args, msg.result);
      }
    }
  }

  private sendToSidecar(request: JsonRpcRequest): void {
    if (!this.process?.stdin?.writable) {
      throw new Error("Sidecar process stdin is not writable");
    }
    this.process.stdin.write(JSON.stringify(request) + "\n");
  }

  invokeSidecar(command: string, args?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      this.pending.set(id, { command, args, resolve, reject });
      try {
        this.sendToSidecar({ jsonrpc: "2.0", id, method: command, params: args ?? {} });
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Command timed out: ${command}`));
        }
      }, 60_000);
    });
  }

  invoke(command: string, args?: unknown): Promise<unknown> {
    return this.invokeSidecar(command, args);
  }

  private registerIpcHandler(): void {
    ipcMain.handle("sidecar:invoke", async (event, command: string, args?: unknown) => {
      if (this.localCommandCallback) {
        const local = await this.localCommandCallback(event, command, args);
        if (local.handled) {
          return local.result ?? null;
        }
      }

      return this.invokeSidecar(command, args);
    });
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.process && !this.process.killed) {
      try {
        this.sendToSidecar({ jsonrpc: "2.0", id: randomUUID(), method: "shutdown", params: {} });
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGTERM");
        }
      }, 3000);
    }
  }
}
