import { cleanLocalNames } from "../../electron/local-name-hints";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { calendarNamesFromOutput, createCalendarNamesSync } from "../../electron/macos-calendar-names";

const now = Date.parse("2026-10-27T12:00:00Z");
const day = 86_400_000;
const event = (start: number, names: string[]) => ({ starts_at: new Date(start).toISOString(), ends_at: new Date(start + 3_600_000).toISOString(), names });
const output = (events: ReturnType<typeof event>[], authorization = "authorized") => JSON.stringify({ type: "calendar_names", authorization, events });

describe("local name spelling hints", () => {
  it("deduplicates names and refuses addresses, long fields and multi-line text", () => {
    expect(cleanLocalNames([" Siobhan ", "siobhan", "Name@example.com", "two\nlines", "a".repeat(65), null])).toEqual(["Siobhan"]);
  });
  it("ranks today's names then frequent/recent attendees for dictation, and the current event first for meetings", () => {
    const result = calendarNamesFromOutput(output([
      event(now - day * 3, ["Frequent"]), event(now - day * 2, ["Frequent"]),
      event(now - day, ["Recent"]), event(now + 3_600_000, ["Next"]),
      event(now - 1_800_000, ["Current Person"]),
      event(now - day * 9, ["Expired"]), event(now + day * 3, ["Distant"]),
    ]), now);
    expect(result.names.indexOf("Current Person")).toBeLessThan(result.names.indexOf("Frequent"));
    expect(result.names.indexOf("Frequent")).toBeLessThan(result.names.indexOf("Recent"));
    expect(result.meetingNames.slice(0, 3)).toEqual(["Current Person", "Current", "Person"]);
    expect(result.names).not.toContain("Expired");
    expect(result.names).not.toContain("Distant");
  });
  it("uses the next event when no event is current", () => {
    expect(calendarNamesFromOutput(output([event(now + day, ["Tomorrow"]), event(now + 100, ["Next"])]), now).meetingNames[0]).toBe("Next");
  });
  it.each(["denied", "restricted", "write_only", "not_determined"])("returns no names for %s", (authorization) => {
    expect(calendarNamesFromOutput(output([event(now, ["Siobhan"])], authorization), now)).toEqual({ names: [], meetingNames: [] });
  });
  it("never reads when off and sends only the empty spelling list", async () => {
    const exec = vi.fn(); const sendNames = vi.fn();
    const sync = createCalendarNamesSync({ platform: "darwin", helperPath: "/fake", helperExists: () => true, isEnabled: () => false, exec, sendNames });
    await sync.sync(); expect(exec).not.toHaveBeenCalled();
    expect(sendNames).toHaveBeenCalledWith({ names: [], meetingNames: [] });
  });
  it("cannot restore a read after the user switches off or disconnects", async () => {
    let enabled = true;
    let finish!: (stdout: string) => void;
    const exec = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const sendNames = vi.fn();
    const sync = createCalendarNamesSync({ platform: "darwin", helperPath: "/fake", helperExists: () => true, isEnabled: () => enabled, exec, sendNames, now: () => now });
    const pending = sync.sync(); await Promise.resolve();
    enabled = false; finish(output([event(now, ["Siobhan"])])); await pending;
    expect(sendNames).toHaveBeenLastCalledWith({ names: [], meetingNames: [] });
    expect(exec).toHaveBeenCalledWith("/fake", ["--calendar-names"]);
  });
  it("refreshes with the existing calendar TTL and clears on revocation or malformed output", async () => {
    let time = now;
    const exec = vi.fn().mockResolvedValueOnce(output([event(now, ["Siobhan"])])).mockResolvedValueOnce(output([], "denied")).mockResolvedValueOnce("bad json");
    const sendNames = vi.fn();
    const sync = createCalendarNamesSync({ platform: "darwin", helperPath: "/fake", helperExists: () => true, isEnabled: () => true, exec, sendNames, now: () => time });
    await sync.sync(); await sync.sync(); expect(exec).toHaveBeenCalledTimes(1);
    time += 60_001; await sync.sync(); expect(sendNames).toHaveBeenLastCalledWith({ names: [], meetingNames: [] });
    time += 60_001; await sync.sync(); expect(sendNames).toHaveBeenLastCalledWith({ names: [], meetingNames: [] });
  });
  it("keeps the trusted names command off the renderer allowlist", () => {
    expect(readFileSync("electron/ipc-bridge.ts", "utf8")).not.toContain('"set_dictation_calendar_names"');
    const helper = readFileSync("scripts/native-macos-calendar-helper.swift", "utf8");
    const mode = helper.slice(helper.indexOf('if arguments.contains("--calendar-names")'), helper.indexOf('if arguments.contains("--events")'));
    expect(mode).not.toContain("requestAccess");
    expect(mode).not.toContain("email:");
  });
});
