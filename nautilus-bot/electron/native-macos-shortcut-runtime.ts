/// <reference types="node" />
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { existsSync } from "fs";
import { createInterface, type Interface } from "readline";
import type { NativeHelperBindingEntry } from "./dictation-bindings";
import {
  buildNativeShortcutHelperArgs,
  isNativeShortcutRawEvent,
  resolveNativeShortcutStatus,
  type NativeShortcutController,
  type NativeShortcutRawEvent,
} from "./native-macos-shortcut";

type RuntimePlatform =
  | "aix"
  | "android"
  | "darwin"
  | "freebsd"
  | "haiku"
  | "linux"
  | "openbsd"
  | "sunos"
  | "win32"
  | "cygwin"
  | "netbsd";

type NativeShortcutChild = Pick<
  ChildProcessWithoutNullStreams,
  "stdin" | "stdout" | "stderr" | "on" | "kill"
>;

export function startNativeMacosShortcutController(input: {
  platform: RuntimePlatform;
  helperPath?: string | null;
  /** The binding table the helper should watch for; empty means disabled. */
  helperBindings: NativeHelperBindingEntry[];
  helperExists?: (helperPath: string) => boolean;
  spawnHelper?: (helperPath: string, args: string[]) => NativeShortcutChild;
  onEvent: (event: NativeShortcutRawEvent) => void;
  onUnavailable?: (status: NativeShortcutController["status"]) => void;
}): NativeShortcutController {
  const helperExists = input.helperExists ?? existsSync;
  if (input.platform !== "darwin") {
    return {
      status: resolveNativeShortcutStatus({
        platform: input.platform,
        helperReady: false,
      }),
      setSessionActive: () => {},
      dispose: () => {},
    };
  }

  const helperPath = input.helperPath?.trim();
  if (!helperPath || !helperExists(helperPath)) {
    return {
      status: resolveNativeShortcutStatus({
        platform: input.platform,
        helperReady: false,
      }),
      setSessionActive: () => {},
      dispose: () => {},
    };
  }

  // An empty table means every dictation binding was removed (the user
  // switched the hotkey off) or none can be watched; do not spawn a helper
  // with nothing to do, and do not silently fall back to a default binding.
  if (input.helperBindings.length === 0) {
    return {
      status: { available: false, reason: "shortcut_disabled" },
      setSessionActive: () => {},
      dispose: () => {},
    };
  }

  const args = buildNativeShortcutHelperArgs(input.helperBindings);
  const child =
    input.spawnHelper?.(helperPath, args) ??
    spawn(helperPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
  const status = resolveNativeShortcutStatus({
    platform: input.platform,
    helperReady: true,
  });
  let disposed = false;
  let lines: Interface | null = null;
  const writeSessionActive = (active: boolean): void => {
    if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ sessionActive: active })}\n`);
  };
  const markHelperUnavailable = (): void => {
    // A crash-exit event from an already-disposed helper must not clobber the
    // availability of a freshly spawned replacement controller.
    if (disposed || !status.available) {
      return;
    }
    status.available = false;
    status.reason = "helper_unavailable";
    writeSessionActive(false);
    lines?.close();
    lines = null;
    child.kill("SIGTERM");
    input.onUnavailable?.(status);
  };
  child.stdin.on("error", () => markHelperUnavailable());
  lines = createInterface({ input: child.stdout });
  lines.on("close", markHelperUnavailable);
  lines.on("error", markHelperUnavailable);
  child.stdout.on("error", markHelperUnavailable);
  lines.on("line", (line: string) => {
    if (disposed || !status.available) return;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isNativeShortcutRawEvent(parsed)) {
        input.onEvent(parsed);
      }
    } catch {
      // Ignore malformed helper output. The fallback shortcut remains registered
      // if the helper fails before becoming available.
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const message = String(chunk).trim();
    if (message) {
      console.warn("[shortcuts] native helper:", message);
    }
  });

  child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    if (disposed) {
      return;
    }
    console.warn("[shortcuts] native helper exited", { code, signal });
    markHelperUnavailable();
  });

  child.on("error", (error: Error) => {
    console.warn("[shortcuts] native helper error", error);
    markHelperUnavailable();
  });

  writeSessionActive(false);

  return {
    status,
    setSessionActive: (active) => {
      if (!disposed && status.available) writeSessionActive(active);
    },
    dispose: () => {
      writeSessionActive(false);
      disposed = true;
      lines?.close();
      lines = null;
      child.kill("SIGTERM");
    },
  };
}
