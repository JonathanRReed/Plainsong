import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { hasDeliberateSignature } from "../../scripts/verify-packaged-native-helpers.mjs";

const repoRoot = process.cwd();
const gate = readFileSync(
  path.join(repoRoot, "scripts", "verify-packaged-native-helpers.mjs"),
  "utf8",
);

/**
 * Verbatim `codesign -dv` output, captured on this Mac 2026-09-03.
 *
 * The three states are not interchangeable and the difference is the whole
 * point of the check, so these are real outputs rather than hand-written
 * approximations of them.
 */
const LINKER_SIGNED_RUST_BINARY = `Executable=/…/rust-sidecar/target/release/plainsong-cli
Identifier=plainsong_cli-43fc433f559eb402
Format=Mach-O thin (arm64)
CodeDirectory v=20400 size=20408 flags=0x20002(adhoc,linker-signed) hashes=634+0 location=embedded
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
Sealed Resources=none
Internal requirements=none
`;

const DELIBERATE_ADHOC_HELPER = `Executable=/…/rust-sidecar/binaries/nautilus-macos-speech-helper-aarch64-apple-darwin
Identifier=com.plainsong.app.speech-helper
Format=Mach-O thin (arm64)
CodeDirectory v=20400 size=1112 flags=0x2(adhoc) hashes=24+7 location=embedded
Signature=adhoc
Info.plist entries=8
TeamIdentifier=not set
Sealed Resources=none
Internal requirements count=0 size=12
`;

const DEVELOPER_ID_SIGNED_APP = `Executable=/…/release/mac-arm64/Plainsong.app/Contents/MacOS/Plainsong
Identifier=com.plainsong.app
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=445 flags=0x10000(runtime) hashes=3+7 location=embedded
Signature size=9046
Timestamp=Aug 27, 2026 at 7:38:50 PM
Info.plist entries=35
TeamIdentifier=AJ9VWBRNZN
Runtime Version=26.4.0
Sealed Resources version=2 rules=13 files=18
Internal requirements count=1 size=180
`;

const NOT_SIGNED_AT_ALL = `/…/Contents/Resources/sidecar/plainsong-cli: code object is not signed at all
`;

describe("hasDeliberateSignature", () => {
  it("does not treat a cargo linker-signed binary as signed", () => {
    // `flags=0x20002(adhoc,linker-signed)` means the LINKER stamped it while
    // cargo built it. No codesign ran, so there is no entitlement blob, and an
    // "empty entitlement set" assertion against it fails on "no readable
    // entitlement property list" — which is what made `bun run electron:pack`
    // impossible to finish on a machine with no signing identity.
    expect(
      hasDeliberateSignature({ status: 0, output: LINKER_SIGNED_RUST_BINARY }),
    ).toBe(false);
  });

  it("treats a build script's own ad-hoc signature as signed", () => {
    // The Speech, calendar, shortcut and Foundation Models helpers are each
    // codesigned by their build script with a chosen entitlement plist. Those
    // entitlements are a real claim about the binary and stay under assertion
    // even in the unsigned-bundle mode.
    expect(
      hasDeliberateSignature({ status: 0, output: DELIBERATE_ADHOC_HELPER }),
    ).toBe(true);
  });

  it("treats a Developer ID signature as signed", () => {
    expect(
      hasDeliberateSignature({ status: 0, output: DEVELOPER_ID_SIGNED_APP }),
    ).toBe(true);
  });

  it("treats an unsigned binary as unsigned", () => {
    expect(hasDeliberateSignature({ status: 1, output: NOT_SIGNED_AT_ALL })).toBe(
      false,
    );
  });
});

describe("scripts/verify-packaged-native-helpers.mjs signature modes", () => {
  it("relaxes signature assertions in the afterPack hook only", () => {
    // electron-builder emits `afterPack` BEFORE it signs, on every path
    // including `release:mac`, so the hook is never looking at a signed
    // bundle. Asserting entitlements there would be asserting on a signature
    // that does not exist yet.
    expect(gate).toContain("allowUnsigned: true");
    expect(gate).toContain("verifyPackagedNativeHelpers(context)");
  });

  it("keeps the standalone gate strict by default", () => {
    // `bun run gate:packaged:macos:native` points at the signed release
    // bundle. An unsigned helper there is a release defect, so the flag has to
    // be asked for rather than inferred.
    expect(gate).toContain('const allowUnsigned = args.includes("--allow-unsigned");');
    expect(gate).toContain("{ allowUnsigned = false } = {}");
    expect(gate).toContain("a signed build must sign every ");
  });

  it("still checks every signature-independent property in both modes", () => {
    // File presence, executability and arm64-only-ness are read out of the
    // Mach-O, not out of a signature, so relaxing the signature mode must not
    // relax those. They run above the `unsignedSkips` line.
    const skipPoint = gate.indexOf("const unsignedSkips = []");
    expect(skipPoint).toBeGreaterThan(0);
    const beforeSkips = gate.slice(gate.indexOf("function verifyAppBundle("), skipPoint);
    expect(beforeSkips).toContain("requireExecutable(filePath, label)");
    expect(beforeSkips).toContain("requireArchitecture(");
    // The calendar helper's usage strings are compiled into its
    // `__TEXT,__info_plist` section, and the app's are in its Info.plist:
    // neither is attached by codesign, so both stay asserted unconditionally.
    const afterSkips = gate.slice(skipPoint);
    expect(afterSkips).toContain(
      "requireCalendarHelperEmbeddedUsageDescriptions(paths.calendarHelper);",
    );
    expect(afterSkips).toContain(
      "requirePackagedCalendarUsageDescriptions(appPath);",
    );
  });
});
