/// <reference types="node" />
import { execFile } from "child_process";
import { existsSync } from "fs";
import {
  calendarHelperArgsForSnapshot,
  calendarSnapshotIsFresh,
  emptyCalendarSnapshot,
  parseCalendarHelperOutput,
  CALENDAR_SNAPSHOT_TTL_MS,
  type CalendarSnapshot,
} from "./macos-calendar";

type RuntimePlatform = NodeJS.Platform;

type ExecResult = { stdout: string; stderr: string };

export type CalendarHelperExec = (
  helperPath: string,
  args: string[],
  timeoutMs: number,
) => Promise<ExecResult>;

export interface MacosCalendarRuntime {
  /**
   * The current calendar state. Never prompts: the helper modes this can run
   * read the stored authorization status only.
   */
  readSnapshot(options?: { forceRefresh?: boolean }): Promise<CalendarSnapshot>;
  /**
   * Ask macOS for calendar access. THE ONLY PROMPTING PATH.
   *
   * Reached from one gesture-gated IPC command in main.ts; nothing on the
   * startup path may call it.
   */
  requestAccess(): Promise<CalendarSnapshot>;
  /** Drop the cached snapshot, e.g. after the reader disconnects a calendar. */
  invalidate(): void;
}

/** A probe or an event read; both are local and should be near-instant. */
const READ_TIMEOUT_MS = 10_000;

/**
 * The permission prompt is modal to the user, not to us. A minute is long
 * enough for someone to read it and decide, and short enough that a prompt
 * which never appeared does not wedge the command forever.
 */
const REQUEST_TIMEOUT_MS = 70_000;

const defaultExec: CalendarHelperExec = (helperPath, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      helperPath,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (_error, stdout, stderr) => {
        // The helper exits non-zero for its typed refusals and still prints a
        // parseable payload, so the exit code is deliberately not consulted:
        // stdout is the contract. A genuine crash produces no JSON line and
        // parses to `unknown`, which is the same outcome as a missing helper.
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });

export function createMacosCalendarRuntime(input: {
  platform: RuntimePlatform;
  helperPath: string;
  helperExists?: (helperPath: string) => boolean;
  exec?: CalendarHelperExec;
  now?: () => number;
  ttlMs?: number;
}): MacosCalendarRuntime {
  const helperExists = input.helperExists ?? existsSync;
  const exec = input.exec ?? defaultExec;
  const now = input.now ?? Date.now;
  const ttlMs = input.ttlMs ?? CALENDAR_SNAPSHOT_TTL_MS;

  let cached: CalendarSnapshot | null = null;
  // Concurrent callers (the Meetings header and the Settings row can mount at
  // once) share one subprocess rather than racing two.
  let inFlight: Promise<CalendarSnapshot> | null = null;

  const unavailableSnapshot = (): CalendarSnapshot | null => {
    if (input.platform !== "darwin") {
      return emptyCalendarSnapshot("unsupported_platform", now());
    }
    if (!input.helperPath || !helperExists(input.helperPath)) {
      return emptyCalendarSnapshot("helper_unavailable", now());
    }
    return null;
  };

  const run = async (args: string[], timeoutMs: number): Promise<CalendarSnapshot> => {
    const result = await exec(input.helperPath, args, timeoutMs);
    const snapshot = parseCalendarHelperOutput(result.stdout, now());
    cached = snapshot;
    return snapshot;
  };

  const readSnapshot = async (
    options?: { forceRefresh?: boolean },
  ): Promise<CalendarSnapshot> => {
    const unavailable = unavailableSnapshot();
    if (unavailable) {
      cached = null;
      return unavailable;
    }
    if (!options?.forceRefresh && calendarSnapshotIsFresh(cached, now(), ttlMs)) {
      return cached;
    }
    if (inFlight) {
      return inFlight;
    }

    // Two spawns, not one: the probe answers "may we read at all", and only an
    // authorized answer earns the second call that actually reads events. It
    // costs a few milliseconds and makes the unauthorized path visibly
    // incapable of touching event data.
    inFlight = (async () => {
      const probe = await run(["--probe"], READ_TIMEOUT_MS);
      const args = calendarHelperArgsForSnapshot(probe.authorization);
      if (args[0] === "--probe") {
        return probe;
      }
      return run(args, READ_TIMEOUT_MS);
    })().finally(() => {
      inFlight = null;
    });

    return inFlight;
  };

  return {
    readSnapshot,
    requestAccess: async () => {
      const unavailable = unavailableSnapshot();
      if (unavailable) {
        return unavailable;
      }
      // The prompt's answer changes what a read returns, so the cache goes
      // before the request rather than after it.
      cached = null;
      const granted = await run(["--request-access"], REQUEST_TIMEOUT_MS);
      if (granted.authorization !== "authorized") {
        return granted;
      }
      return readSnapshot({ forceRefresh: true });
    },
    invalidate: () => {
      cached = null;
    },
  };
}
