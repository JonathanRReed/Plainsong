/// <reference types="node" />
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { existsSync } from "fs";
import { createInterface, type Interface } from "readline";
import {
  buildNativeShortcutHelperArgs,
  isNativeShortcutRawEvent,
  resolveNativeShortcutStatus,
  resolveNativeShortcutHelperShortcut,
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
  "stdout" | "stderr" | "on" | "kill"
>;

export function startNativeMacosShortcutController(input: {
  platform: RuntimePlatform;
  helperPath?: string | null;
  shortcut?: string | null;
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
      dispose: () => {},
    };
  }

  const shortcut = resolveNativeShortcutHelperShortcut(input.shortcut);
  const args = buildNativeShortcutHelperArgs(shortcut);
  const child =
    input.spawnHelper?.(helperPath, args) ??
    spawn(helperPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  const status = resolveNativeShortcutStatus({
    platform: input.platform,
    helperReady: true,
  });
  const markHelperUnavailable = (): void => {
    if (!status.available) {
      return;
    }
    status.available = false;
    status.reason = "helper_unavailable";
    lines?.close();
    lines = null;
    child.kill("SIGTERM");
    input.onUnavailable?.(status);
  };
  let lines: Interface | null = createInterface({ input: child.stdout });
  lines.on("line", (line: string) => {
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
    if (code !== 0 && signal !== "SIGTERM") {
      console.warn("[shortcuts] native helper exited", { code, signal });
      markHelperUnavailable();
    }
  });

  child.on("error", (error: Error) => {
    console.warn("[shortcuts] native helper error", error);
    markHelperUnavailable();
  });

  return {
    status,
    dispose: () => {
      lines?.close();
      lines = null;
      child.kill("SIGTERM");
    },
  };
}
