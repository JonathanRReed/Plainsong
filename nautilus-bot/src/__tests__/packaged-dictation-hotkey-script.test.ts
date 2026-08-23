import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const harnessPath = resolve(
  process.cwd(),
  "scripts/capture-packaged-macos-dictation-hotkey.mjs",
);
const driverPath = resolve(process.cwd(), "scripts/native-macos-key-hold-driver.swift");

describe("packaged dictation hotkey hold driver", () => {
  it("keeps one CGEvent source alive from key-down through key-up", () => {
    expect(existsSync(driverPath)).toBe(true);
    const source = readFileSync(driverPath, "utf8");

    expect(source).toMatch(/let source = CGEventSource\(stateID: \.hidSystemState\)/);
    expect(source).toMatch(/down\.post\(tap: \.cghidEventTap\)/);
    expect(source).toMatch(/readLine\(\)/);
    expect(source).toMatch(/up\.post\(tap: \.cghidEventTap\)/);
  });

  it("drives hold mode with the persistent helper instead of separate JXA sources", () => {
    const source = readFileSync(harnessPath, "utf8");

    expect(source).toMatch(/launchSyntheticHoldDriver\(/);
    expect(source).toMatch(/holdDriver\.release\(\)/);
    expect(source).not.toMatch(/postSyntheticKeyEvent\("down"\)[\s\S]{0,3000}postSyntheticKeyEvent\("up"\)/);
  });

  it("restores speaker state and rejects unrelated nonempty transcripts", () => {
    const source = readFileSync(harnessPath, "utf8");

    expect(source).toMatch(/snapshotOutputVolume\(/);
    expect(source).toMatch(/restoreOutputVolume\(/);
    expect(source).toMatch(/matchSpokenFixture\(transcriptText, speakFixtureText\)/);
    expect(source).toMatch(/spokenFixtureMatched: fixtureMatch\.matched/);
  });
});
