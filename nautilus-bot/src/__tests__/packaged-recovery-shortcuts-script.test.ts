import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const harnessPath = resolve(
  process.cwd(),
  "scripts/capture-packaged-macos-recovery-shortcuts.mjs",
);

describe("packaged recovery shortcut harness", () => {
  it("makes the spoken seed audible and restores the prior speaker state", () => {
    const source = readFileSync(harnessPath, "utf8");

    expect(source).toMatch(/fixtureOutputVolume/);
    expect(source).toMatch(/snapshotOutputVolume\(/);
    expect(source).toMatch(/setFixtureOutputVolume\(/);
    expect(source).toMatch(/finally\s*{[\s\S]{0,500}restoreOutputVolume\(/);
    expect(source).toMatch(/assertSpeechFixturePlayed\(record\.sayExit\)/);
  });
});
