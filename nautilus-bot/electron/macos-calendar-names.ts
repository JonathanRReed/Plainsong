/// <reference types="node" />
import { execFile } from "child_process";
import { existsSync } from "fs";
import { cleanLocalNames } from "./local-name-hints";
import { CALENDAR_SNAPSHOT_TTL_MS } from "./macos-calendar";

interface NameEvent {
  startsAt: number;
  endsAt: number;
  names: string[];
}
export interface CalendarNames {
  names: string[];
  meetingNames: string[];
}
const EMPTY: CalendarNames = { names: [], meetingNames: [] };
const DAY_MS = 86_400_000;

/** Parse the names-only mode, then rank without retaining an attendee list. */
export function calendarNamesFromOutput(stdout: string, now: number): CalendarNames {
  let payload: unknown;
  try { const lines = stdout.trim().split("\n"); payload = JSON.parse(lines[lines.length - 1] ?? ""); }
  catch { return EMPTY; }
  if (!payload || typeof payload !== "object" || !("type" in payload) ||
    payload.type !== "calendar_names" || !("authorization" in payload) ||
    payload.authorization !== "authorized" || !("events" in payload) ||
    !Array.isArray(payload.events)) return EMPTY;
  const events: NameEvent[] = [];
  for (const raw of payload.events.slice(0, 2_000)) {
    if (!raw || typeof raw !== "object" || !("starts_at" in raw) ||
      !("ends_at" in raw) || !("names" in raw) || !Array.isArray(raw.names) ||
      typeof raw.starts_at !== "string" || typeof raw.ends_at !== "string") continue;
    const startsAt = Date.parse(raw.starts_at);
    const endsAt = Date.parse(raw.ends_at);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt < startsAt ||
      startsAt > now + 2 * DAY_MS || endsAt < now - 7 * DAY_MS) continue;
    const names = cleanLocalNames(raw.names.flatMap((name: unknown) =>
      typeof name === "string" ? [name, ...name.split(/\s+/)] : []));
    events.push({ startsAt, endsAt, names });
  }
  const ranked = new Map<string, { name: string; today: boolean; count: number; recent: number }>();
  const today = new Date(now).toDateString();
  for (const event of events) for (const name of event.names) {
    const key = name.toLowerCase();
    const old = ranked.get(key);
    ranked.set(key, { name: old?.name ?? name,
      today: old?.today === true || new Date(event.startsAt).toDateString() === today,
      count: (old?.count ?? 0) + 1,
      recent: Math.max(old?.recent ?? -Infinity, event.startsAt <= now ? event.startsAt : -Infinity),
    });
  }
  const names = [...ranked.values()].sort((a, b) =>
    Number(b.today) - Number(a.today) || b.count - a.count || b.recent - a.recent ||
    a.name.localeCompare(b.name)).map((entry) => entry.name).slice(0, 2_000);
  const currentOrNext = events.filter((event) => event.endsAt > now)
    .sort((a, b) => a.startsAt - b.startsAt)[0];
  return { names, meetingNames: cleanLocalNames([...(currentOrNext?.names ?? []), ...names]) };
}

export type CalendarNamesSync = ReturnType<typeof createCalendarNamesSync>;

/** One queue prevents a slow read from restoring names after disconnect. */
export function createCalendarNamesSync(input: {
  platform: NodeJS.Platform;
  helperPath: string;
  isEnabled: () => boolean;
  sendNames: (names: CalendarNames) => Promise<void>;
  exec?: (path: string, args: string[]) => Promise<string>;
  helperExists?: (path: string) => boolean;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const exec = input.exec ?? ((path: string, args: string[]) => new Promise<string>((resolve) => {
    execFile(path, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (_error, stdout) => resolve(String(stdout ?? "")));
  }));
  let queue = Promise.resolve();
  let lastRead: number | null = null;
  return {
    sync(force = false): Promise<void> {
      const run = async () => {
        if (!input.isEnabled() || input.platform !== "darwin" ||
          !(input.helperExists ?? existsSync)(input.helperPath)) {
          lastRead = null;
          await input.sendNames(EMPTY);
          return;
        }
        if (!force && lastRead !== null && now() - lastRead < CALENDAR_SNAPSHOT_TTL_MS) return;
        let names: CalendarNames;
        try { names = calendarNamesFromOutput(await exec(input.helperPath, ["--calendar-names"]), now()); }
        catch { names = EMPTY; }
        await input.sendNames(input.isEnabled() ? names : EMPTY);
        lastRead = input.isEnabled() ? now() : null;
      };
      const next = queue.then(run);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
