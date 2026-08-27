import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Calendar access must never be asked for without a user gesture.
 *
 * The behavioural tests cover what the runtime does when it is called. This
 * file covers the thing a behavioural test cannot: that nothing ANYWHERE calls
 * the prompting path off a mount, an interval, or a bootstrap step. It reads
 * the source, because "no code path from launch to a TCC dialog" is a property
 * of the whole tree rather than of any one function.
 *
 * If a legitimate new caller appears, add it to the allowlist below and say why
 * it is gesture-bound. Do not widen the scan.
 */

const repoRoot = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function sourceFiles(relativeDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      // Tests are allowed to name the prompting path; that is their job.
      if (full.includes(`${path.sep}__tests__${path.sep}`)) continue;
      found.push(path.relative(repoRoot, full));
    }
  };
  walk(path.join(repoRoot, relativeDir));
  return found;
}

/** The only renderer modules permitted to name the prompting call. */
const ALLOWED_RENDERER_CALLERS = new Set([
  // Declares it.
  path.join("src", "lib", "backend", "calendar.ts"),
  // Wraps it in `connect`, which only the cue's onClick reaches.
  path.join("src", "hooks", "use-calendar-events.ts"),
]);

describe("calendar access is never requested without a user gesture", () => {
  it("is named by only two renderer modules", () => {
    const offenders = [...sourceFiles("src"), ...sourceFiles("electron")].filter(
      (file) =>
        read(file).includes("requestCalendarAccess") &&
        !ALLOWED_RENDERER_CALLERS.has(file),
    );

    expect(offenders).toEqual([]);
  });

  it("names the IPC command in exactly one place", () => {
    // A second call site is a second thing to audit; the bridge allowlist and
    // the main-process case are the other two mentions and live elsewhere.
    const offenders = sourceFiles("src").filter(
      (file) =>
        read(file).includes('"request_calendar_access"') &&
        file !== path.join("src", "lib", "backend", "calendar.ts"),
    );

    expect(offenders).toEqual([]);
  });

  it("calls it from `connect`, never from an effect", () => {
    const hook = read("src/hooks/use-calendar-events.ts");
    const calls = hook.match(/requestCalendarAccess\(/g) ?? [];
    expect(calls).toHaveLength(1);

    const callIndex = hook.indexOf("requestCalendarAccess(");
    const connectIndex = hook.lastIndexOf("connect: async", callIndex);
    const effectIndex = hook.lastIndexOf("useEffect(", callIndex);

    expect(connectIndex).toBeGreaterThanOrEqual(0);
    // The nearest enclosing construct is `connect`, not an effect: an effect
    // that opened above this call would put a permission dialog on mount.
    expect(connectIndex).toBeGreaterThan(effectIndex);
  });

  it("polls with the read that cannot prompt", () => {
    const hook = read("src/hooks/use-calendar-events.ts");
    const effectStart = hook.indexOf("useEffect(() => {\n    if (!enabled) return;");
    expect(effectStart).toBeGreaterThan(-1);
    const effectBody = hook.slice(effectStart, hook.indexOf("}, [enabled]);", effectStart));

    expect(effectBody).toContain("getCalendarSnapshot");
    expect(effectBody).not.toContain("requestCalendarAccess");
    expect(effectBody).not.toContain("connect(");
  });

  it("reaches `connect` only from a click handler", () => {
    const cue = read("src/components/meetings/calendar-meeting-cue.tsx");
    const invocations = [...cue.matchAll(/calendar\.connect\(\)/g)];
    expect(invocations).toHaveLength(1);

    const index = invocations[0].index ?? 0;
    const preceding = cue.slice(Math.max(0, index - 200), index);
    expect(preceding).toContain("onClick");
  });

  it("gates the main-process command on a consumed gesture", () => {
    const main = read("electron/main.ts");
    const caseStart = main.indexOf('case "request_calendar_access": {');
    expect(caseStart).toBeGreaterThan(-1);
    const caseBody = main.slice(caseStart, main.indexOf("\n    }", caseStart));

    // The same guard the storage-location pickers use: main window only, and
    // a single-use gesture consumed BEFORE the dialog can open.
    const guardIndex = caseBody.indexOf("requireMainWindowGesture(");
    const requestIndex = caseBody.indexOf("requestAccess(");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(requestIndex).toBeGreaterThan(guardIndex);
  });

  it("leaves the snapshot command ungated, because it cannot prompt", () => {
    // Stated as an expectation rather than left implicit: if reading ever
    // becomes able to prompt, this test is the thing that has to change too.
    const main = read("electron/main.ts");
    const caseStart = main.indexOf('case "get_calendar_snapshot": {');
    const caseBody = main.slice(caseStart, main.indexOf("\n    }", caseStart));

    expect(caseBody).toContain("readSnapshot(");
    expect(caseBody).not.toContain("requestAccess(");
  });

  it("keeps the prompting helper mode out of the reading path", () => {
    const runtime = read("electron/macos-calendar-runtime.ts");
    const occurrences = runtime.match(/"--request-access"/g) ?? [];
    expect(occurrences).toHaveLength(1);

    const index = runtime.indexOf('"--request-access"');
    const readIndex = runtime.indexOf("const readSnapshot = async");
    const requestIndex = runtime.indexOf("requestAccess: async");
    expect(requestIndex).toBeGreaterThan(-1);
    // The single mention sits inside requestAccess, which is declared after
    // readSnapshot; anything else would put it on the reading path.
    expect(index).toBeGreaterThan(requestIndex);
    expect(readIndex).toBeLessThan(requestIndex);
  });

  it("keeps the Swift helper's only prompting call in its request mode", () => {
    const swift = read("scripts/native-macos-calendar-helper.swift");

    // Two request APIs, one per macOS generation, both inside requestAccess().
    const requestStart = swift.indexOf("private func requestAccess()");
    const requestEnd = swift.indexOf("// MARK: - Events", requestStart);
    expect(requestStart).toBeGreaterThan(-1);
    const requestBody = swift.slice(requestStart, requestEnd);

    for (const api of ["requestFullAccessToEvents", "requestAccess(to: .event)"]) {
      expect(swift.split(api).length - 1).toBe(1);
      expect(requestBody).toContain(api);
    }

    // And the reading modes consult the stored status, which does not prompt.
    const eventsStart = swift.indexOf("private func loadEvents(");
    const eventsBody = swift.slice(eventsStart, swift.indexOf("// MARK: - Entry point"));
    expect(eventsBody).toContain("currentAuthorization()");
    expect(eventsBody).not.toContain("requestFullAccessToEvents");
    expect(eventsBody).not.toContain("requestAccess(to:");
  });

  it("keeps the helper read-only", () => {
    // A read-only entitlement is a claim about intent; this is the claim
    // about the code. EventKit's write surface must not appear at all.
    const swift = read("scripts/native-macos-calendar-helper.swift");
    for (const writeApi of [
      "EKEvent(",
      ".save(",
      ".remove(",
      "saveEvent",
      "removeEvent",
      "commit(",
    ]) {
      expect(swift).not.toContain(writeApi);
    }
  });

  it("emits no calendar prose beyond titles", () => {
    // Locations and notes are read only through the link detector, and only
    // http/https matches are emitted, so a note contributes a conferencing
    // URL and nothing else.
    const swift = read("scripts/native-macos-calendar-helper.swift");
    const payloadStart = swift.indexOf("private struct EventPayload: Encodable {");
    const payloadBody = swift.slice(payloadStart, swift.indexOf("}", payloadStart));

    expect(payloadBody).toContain("let title: String");
    expect(payloadBody).not.toContain("notes");
    expect(payloadBody).not.toContain("location");

    // And the URLs that do escape are web-scheme only.
    expect(swift).toContain('guard scheme == "http" || scheme == "https" else { return }');
  });
});
