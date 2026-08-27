import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLAINSONG_RELEASE_TEAM_ID,
  macAppSignatureIsUpdatable,
  parseCodesignTeamIdentifier,
} from "../../electron/macos-code-signature";

const RELEASE_DISPLAY_OUTPUT = [
  "Executable=/Applications/Plainsong.app/Contents/MacOS/Plainsong",
  "Identifier=com.plainsong.app",
  "Authority=Developer ID Application: Jonathan Reed (AJ9VWBRNZN)",
  "Authority=Developer ID Certification Authority",
  "Authority=Apple Root CA",
  `TeamIdentifier=${PLAINSONG_RELEASE_TEAM_ID}`,
  "Runtime Version=14.0.0",
  "Timestamp=Thu Jul 23 00:00:00 UTC 2026",
  "Flags=0x10000(runtime)",
].join("\n");

const ADHOC_DISPLAY_OUTPUT = [
  "Executable=/Applications/Plainsong.app/Contents/MacOS/Plainsong",
  "Identifier=com.plainsong.app",
  "Signature=adhoc",
  "TeamIdentifier=not set",
].join("\n");

// Someone else's perfectly valid Developer ID signature: every field is
// well-formed, the seal verifies, only the team is not ours.
const FOREIGN_DISPLAY_OUTPUT = RELEASE_DISPLAY_OUTPUT.replaceAll(
  PLAINSONG_RELEASE_TEAM_ID,
  "ZZ9ATTACKER",
).replace("Jonathan Reed", "Someone Else");

describe("parseCodesignTeamIdentifier", () => {
  it("reads the team out of codesign display output", () => {
    expect(parseCodesignTeamIdentifier(RELEASE_DISPLAY_OUTPUT)).toBe(
      PLAINSONG_RELEASE_TEAM_ID,
    );
  });

  it("treats an ad-hoc signature's 'not set' as no team", () => {
    expect(parseCodesignTeamIdentifier(ADHOC_DISPLAY_OUTPUT)).toBeNull();
  });

  it("returns null when the field is absent entirely", () => {
    expect(parseCodesignTeamIdentifier("")).toBeNull();
    expect(parseCodesignTeamIdentifier("Executable=/tmp/x\nIdentifier=y")).toBeNull();
  });

  it("does not match the field inside another line", () => {
    // Anchored to the start of a line so a value that merely contains the
    // string cannot supply it.
    expect(
      parseCodesignTeamIdentifier("Authority=Not really TeamIdentifier=ZZ9ATTACKER"),
    ).toBeNull();
  });
});

describe("macAppSignatureIsUpdatable", () => {
  it("accepts a verified signature from the release team", () => {
    expect(
      macAppSignatureIsUpdatable({
        verified: true,
        displayOutput: RELEASE_DISPLAY_OUTPUT,
      }),
    ).toBe(true);
  });

  it("rejects a foreign signature that displays and verifies perfectly", () => {
    // The finding: `codesign -dv` exits 0 for any signature, and only the
    // literal "Signature=adhoc" was rejected — so someone else's valid
    // Developer ID went straight into the ShipIt handoff.
    expect(
      macAppSignatureIsUpdatable({
        verified: true,
        displayOutput: FOREIGN_DISPLAY_OUTPUT,
      }),
    ).toBe(false);
  });

  it("rejects a broken seal even when the team is right", () => {
    // A modified file inside the bundle fails --verify while -dv still prints
    // our own team identifier.
    expect(
      macAppSignatureIsUpdatable({
        verified: false,
        displayOutput: RELEASE_DISPLAY_OUTPUT,
      }),
    ).toBe(false);
  });

  it("still rejects the ad-hoc signature the old check caught", () => {
    expect(
      macAppSignatureIsUpdatable({
        verified: true,
        displayOutput: ADHOC_DISPLAY_OUTPUT,
      }),
    ).toBe(false);
  });

  it("rejects an unsigned bundle with no display output at all", () => {
    expect(macAppSignatureIsUpdatable({ verified: false, displayOutput: "" })).toBe(
      false,
    );
    expect(macAppSignatureIsUpdatable({ verified: true, displayOutput: "" })).toBe(
      false,
    );
  });

  it("honors an explicitly supplied expected team", () => {
    expect(
      macAppSignatureIsUpdatable({
        verified: true,
        displayOutput: FOREIGN_DISPLAY_OUTPUT,
        expectedTeamId: "ZZ9ATTACKER",
      }),
    ).toBe(true);
  });
});

describe("main-process signature gate", () => {
  it("verifies the seal instead of only displaying it", () => {
    const source = readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");

    expect(source).toContain('runCodesign(["--verify", "--strict", "--deep", bundlePath])');
    expect(source).toContain('runCodesign(["-dv", "--verbose=4", bundlePath])');
    expect(source).toContain("macAppSignatureIsUpdatable({");
    // The old check and its single string match are gone.
    expect(source).not.toContain('output.includes("Signature=adhoc")');
    expect(source).not.toContain('"--verbose=2"');
  });

  it("pins the release team the packaged trust gate also checks", () => {
    // docs/APPLE_DEVELOPER_SETUP.md and scripts/verify-macos-release-trust.mjs
    // check the packaged artifact against the same value.
    const docs = readFileSync(
      path.resolve(process.cwd(), "docs/APPLE_DEVELOPER_SETUP.md"),
      "utf8",
    );
    expect(docs).toContain(PLAINSONG_RELEASE_TEAM_ID);
  });
});
