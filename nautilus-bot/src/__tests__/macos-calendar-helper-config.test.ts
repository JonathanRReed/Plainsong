import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const HELPER_NAME = "plainsong-native-calendar-helper";
const CALENDAR_USAGE_DESCRIPTION =
  "Plainsong reads your calendar on this Mac so it can offer to start capturing the meeting you are about to join. Nothing is written to your calendar and nothing leaves your Mac.";

describe("calendar helper entitlements", () => {
  it("grants calendars and nothing else", () => {
    // The point of compiling a separate binary is that the app's own
    // signature — microphone, Apple Events, and the Accessibility grant it
    // holds at runtime — never has to carry calendar reading too.
    const entitlements = read("build-resources/entitlements.mac.calendar-helper.plist");
    const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map(
      ([, key]) => key,
    );

    expect(keys).toEqual(["com.apple.security.personal-information.calendars"]);
  });

  it("keeps calendar access off the app and the inherited child policy", () => {
    for (const file of [
      "build-resources/entitlements.mac.plist",
      "build-resources/entitlements.mac.inherit.plist",
      "build-resources/entitlements.mac.helper.plist",
      "build-resources/entitlements.mac.sidecar.plist",
      "build-resources/entitlements.mac.shortcut-helper.plist",
    ]) {
      expect(read(file)).not.toContain(
        "com.apple.security.personal-information.calendars",
      );
    }
  });
});

describe("calendar helper Info.plist", () => {
  const infoPlist = read("build-resources/info.mac.calendar-helper.plist");

  it("carries both usage keys, because macOS 13 and 14 read different ones", () => {
    // macOS 13 is the support floor and reads NSCalendarsUsageDescription;
    // macOS 14 replaced it and terminates a process that asks for full access
    // without the new key. Shipping one shows half the range an empty prompt.
    expect(infoPlist).toContain("<key>NSCalendarsUsageDescription</key>");
    expect(infoPlist).toContain("<key>NSCalendarsFullAccessUsageDescription</key>");
    expect(infoPlist.split(CALENDAR_USAGE_DESCRIPTION).length - 1).toBe(2);
  });

  it("declares the macOS 13 floor and claims no other permission", () => {
    expect(infoPlist).toMatch(
      /<key>LSMinimumSystemVersion<\/key>\s*<string>13\.0<\/string>/,
    );
    expect(infoPlist).not.toContain("NSMicrophoneUsageDescription");
    expect(infoPlist).not.toContain("NSAppleEventsUsageDescription");
    expect(infoPlist).not.toContain("NSSpeechRecognitionUsageDescription");
  });

  it("is a valid property list", () => {
    if (process.platform !== "darwin") return;
    const result = spawnSync("/usr/bin/plutil", [
      "-lint",
      path.join(repoRoot, "build-resources/info.mac.calendar-helper.plist"),
    ]);
    expect(result.status).toBe(0);
  });
});

describe("scripts/build-native-calendar-helper.mjs", () => {
  const buildScript = read("scripts/build-native-calendar-helper.mjs");

  it("pins the macOS 13 deployment target rather than the host SDK's", () => {
    expect(buildScript).toContain('"arm64-apple-macosx13.0"');
    expect(buildScript).toContain('MACOSX_DEPLOYMENT_TARGET: "13.0"');
  });

  it("embeds the Info.plist into the binary's own __info_plist section", () => {
    // A command-line helper has no bundle to put an Info.plist beside, and
    // TCC reads the usage string out of the Mach-O section.
    expect(buildScript).toContain("-sectcreate");
    expect(buildScript).toContain("__info_plist");
    expect(buildScript).toContain("info.mac.calendar-helper.plist");
  });

  it("signs with the helper's own entitlements", () => {
    expect(buildScript).toContain("entitlements.mac.calendar-helper.plist");
    expect(buildScript).toContain("/usr/bin/codesign");
  });

  it("removes a stale binary before compiling", () => {
    // A binary that survives a failed compile would be signed and packaged
    // with the previous protocol, and nothing downstream would notice.
    expect(buildScript.indexOf("rmSync(outputPath")).toBeLessThan(
      buildScript.indexOf("spawnSync(\n  \"swiftc\""),
    );
  });

  it("runs in every packaging chain that builds the shortcut helper", () => {
    const scripts = (
      JSON.parse(read("package.json")) as { scripts: Record<string, string> }
    ).scripts;

    expect(scripts["calendar-helper:build"]).toBe(
      "node scripts/build-native-calendar-helper.mjs",
    );
    for (const [name, command] of Object.entries(scripts)) {
      if (!command.includes("shortcut-helper:build")) continue;
      if (name === "shortcut-helper:build") continue;
      expect(command, `${name} must also build the calendar helper`).toContain(
        "calendar-helper:build",
      );
    }
  });
});

describe("scripts/sign-macos.mjs", () => {
  /**
   * Run the real signing adapter in a child Node process.
   *
   * The module imports @electron/osx-sign at its top level, which does not
   * resolve under the renderer's test transform — the same reason
   * macos-apple-speech-helper.test.ts drives it this way.
   */
  function selectEntitlements(paths: Record<string, string>) {
    const signScriptUrl = pathToFileURL(
      path.join(repoRoot, "scripts/sign-macos.mjs"),
    ).href;
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          const { optionsForSignedFile } = await import(${JSON.stringify(signScriptUrl)});
          const inherited = () => ({ entitlements: "inherit.plist" });
          const targets = ${JSON.stringify(paths)};
          console.log(JSON.stringify(
            Object.fromEntries(
              Object.entries(targets).map(([key, filePath]) => [
                key,
                optionsForSignedFile(filePath, inherited),
              ]),
            ),
          ));
        `,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    return JSON.parse(output) as Record<string, { entitlements: string }>;
  }

  it("routes the calendar helper to its own entitlements, and nothing else", () => {
    const selected = selectEntitlements({
      calendarHelper: `/tmp/Plainsong.app/Contents/Resources/calendar-helper/${HELPER_NAME}`,
      app: "/tmp/Plainsong.app/Contents/MacOS/Plainsong",
      sidecar: "/tmp/Plainsong.app/Contents/Resources/sidecar/plainsong-sidecar",
      shortcutHelper:
        "/tmp/Plainsong.app/Contents/Resources/shortcut-helper/plainsong-native-shortcut-helper",
      genericHelper: "/tmp/Plainsong.app/Contents/Frameworks/Plainsong Helper.app",
    });

    expect(selected.calendarHelper.entitlements).toBe(
      path.join(repoRoot, "build-resources/entitlements.mac.calendar-helper.plist"),
    );
    for (const key of ["app", "sidecar", "shortcutHelper", "genericHelper"]) {
      expect(selected[key].entitlements).not.toContain("calendar-helper");
    }
  }, 30_000);
});

describe("electron-builder macOS packaging", () => {
  const config = read("electron-builder.yml");

  it("packages the helper into its own resource directory", () => {
    expect(config).toMatch(
      /- from: dist-native\/\s*\n\s+to: calendar-helper\s*\n\s+filter:\s*\n\s+- plainsong-native-calendar-helper/,
    );
  });

  it("signs it explicitly, at the path the gates look for", () => {
    expect(config).toContain(
      `Contents/Resources/calendar-helper/${HELPER_NAME}`,
    );
    expect(config).toContain("sign: scripts/sign-macos.mjs");
  });

  it("carries both calendar usage strings on the app bundle", () => {
    // TCC attributes a spawned helper's prompt to the responsible process —
    // the app — and reads the string from ITS Info.plist, so the pair has to
    // be here as well as in the helper.
    expect(config).toContain(
      `NSCalendarsUsageDescription: "${CALENDAR_USAGE_DESCRIPTION}"`,
    );
    expect(config).toContain(
      `NSCalendarsFullAccessUsageDescription: "${CALENDAR_USAGE_DESCRIPTION}"`,
    );
  });
});

describe("scripts/verify-packaged-native-helpers.mjs", () => {
  const gate = read("scripts/verify-packaged-native-helpers.mjs");

  it("refuses to package a build whose calendar helper is missing or fat", () => {
    expect(gate).toContain('"calendar-helper"');
    expect(gate).toContain('["calendar helper", paths.calendarHelper]');
  });

  it("requires an empty entitlement set for the packaged plainsong CLI", () => {
    // The `plainsong` CLI is a separate signature for the same reason the
    // shortcut helper is: it must not inherit the app's microphone, Apple
    // Events or library-validation entitlements. It is invokable by anything
    // on the machine and only ever reads the database read-only, so an
    // entitlement leaking into its signature would be handing out the app's
    // own privileges.
    expect(gate).toContain('requireEmptyEntitlements(paths.cli, "plainsong CLI")');
    expect(gate).toContain('requireEmptyEntitlements(paths.shortcutHelper, "shortcut helper")');
    expect(gate).toContain("must have an empty entitlement set");
    expect(gate).toContain('["plainsong CLI", paths.cli]');
  });

  it("checks the helper's entitlement set in both directions", () => {
    expect(gate).toContain("requireCalendarHelperEntitlements(paths.calendarHelper)");
    expect(gate).toContain("CALENDAR_HELPER_REQUIRED_ENTITLEMENT");
    for (const forbidden of [
      "com.apple.security.device.microphone",
      "com.apple.security.automation.apple-events",
      "com.apple.security.cs.disable-library-validation",
    ]) {
      expect(gate).toContain(forbidden);
    }
  });

  it("checks the embedded and app-level usage strings", () => {
    // A helper compiled without its __info_plist section still runs, signs and
    // packages — and is then killed the moment it asks for access. That is
    // only findable before notarization if the gate looks.
    expect(gate).toContain(
      "requireCalendarHelperEmbeddedUsageDescriptions(paths.calendarHelper)",
    );
    expect(gate).toContain("requirePackagedCalendarUsageDescriptions(appPath)");
    expect(gate).toContain("CALENDAR_USAGE_DESCRIPTION_KEYS");
  });
});

describe("scripts/verify-macos-release-trust.mjs", () => {
  const gate = read("scripts/verify-macos-release-trust.mjs");

  it("holds the calendar helper to the app's signing identity", () => {
    for (const check of [
      "calendarHelperExecutablePresent",
      "calendarHelperSignatureValid",
      "calendarHelperUsesDeveloperId",
      "calendarHelperUsesHardenedRuntime",
      "calendarHelperHasSecureTimestamp",
      "calendarHelperTeamMatchesApp",
      "calendarHelperIsArm64",
    ]) {
      expect(gate).toContain(check);
    }
  });

  it("requires the entitlement to be on the helper and off the app", () => {
    expect(gate).toContain("calendarHelperHasCalendarEntitlement");
    expect(gate).toContain("calendarHelperHasNoUnrelatedEntitlements");
    // The split is the whole point; a release that took the entitlement back
    // into the app's signature would otherwise pass everything else.
    expect(gate).toContain("appHasNoCalendarEntitlement");
  });
});

describe("the calendar helper's privacy contract", () => {
  const helper = read("scripts/native-macos-calendar-helper.swift");

  /**
   * The shape of `EventPayload` IS the privacy promise.
   *
   * `docs/beta/PRIVACY-AND-CLOUD.md` tells the reader that a location and a
   * note never leave the helper — only http/https links inside them do — and
   * that an attendee list is the only prose it emits besides the title. That
   * promise is kept by the struct: a field that does not exist cannot be
   * encoded, however the emitting code is later rearranged. Nothing else in
   * the suite can run this file, so this reads it.
   */
  it("emits no location, notes or raw URL field on an event", () => {
    const payload = helper.match(
      /private struct EventPayload: Encodable \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(payload, "EventPayload must be findable").toBeTruthy();

    const fields = [...(payload ?? "").matchAll(/^\s*let (\w+):/gm)].map(
      ([, name]) => name,
    );
    expect(fields).toEqual([
      "id",
      "title",
      "startsAt",
      "endsAt",
      "isAllDay",
      "calendarId",
      "calendarName",
      "conferenceUrls",
      "attendees",
    ]);
    for (const forbidden of ["location", "notes", "url", "structuredLocation"]) {
      expect(
        fields.some((field) => field.toLowerCase() === forbidden.toLowerCase()),
        `EventPayload must not carry ${forbidden}`,
      ).toBe(false);
    }
  });

  it("says which protocol it speaks in one place, and speaks it everywhere", () => {
    // The encode-failure line used to hard-code protocol_version 1 while the
    // constant said 2. It is emitted exactly when nothing else can be, so the
    // one message a caller gets from a broken helper announced a protocol the
    // helper does not speak.
    expect(helper).toMatch(/private let protocolVersion = 2\b/);
    const hardCoded = [...helper.matchAll(/"protocol_version":\s*(\d+)/g)];
    expect(
      hardCoded,
      `protocol_version must come from the constant, found: ${hardCoded
        .map(([match]) => match)
        .join(", ")}`,
    ).toEqual([]);
    expect(helper).toContain('"protocol_version":\\#(protocolVersion)');
  });

  it("caps the attendee list at the same 40 the app does", () => {
    expect(helper).toMatch(/private let maximumAttendeesPerEvent = 40\b/);
    expect(helper).toMatch(/private let maximumAttendeeFieldLength = 256\b/);
  });
});

describe("the Swift helper compiles", () => {
  it("type-checks against the macOS 13 deployment target", () => {
    // Cheap insurance for a file nothing else in the test suite can execute:
    // a syntax error or a use of an API that is not available at the floor
    // would otherwise surface during a release build.
    if (process.platform !== "darwin") return;

    const result = spawnSync(
      "swiftc",
      [
        "-typecheck",
        "-target",
        "arm64-apple-macosx13.0",
        path.join(repoRoot, "scripts/native-macos-calendar-helper.swift"),
      ],
      { encoding: "utf8", env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: "13.0" } },
    );

    expect(
      `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
      "swiftc -typecheck reported diagnostics",
    ).toBe("");
    expect(result.status).toBe(0);
  }, 120_000);
});
