import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("packaged macOS smoke harness", () => {
  it("uses a disposable profile and cloned model assets instead of the live profile", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/capture-packaged-macos-smoke.ts"),
      "utf8",
    );

    expect(source).toContain("mkdtempSync");
    expect(source).toContain("COPYFILE_FICLONE");
    expect(source).toContain("PLAINSONG_CONFIG_DIR");
    expect(source).toContain("PLAINSONG_DATA_DIR");
    expect(source).toContain("profileIsolated: true");
    expect(source).toContain("profileCleaned");
  });

  it("allows cold native model teardown to finish before force termination", () => {
    const scripts = [
      "capture-packaged-macos-app-matrix-insertion.ts",
      "capture-packaged-macos-backup-restore.ts",
      "capture-packaged-macos-dictation-hotkey.ts",
      "capture-packaged-macos-meeting-mic.ts",
      "capture-packaged-macos-meeting-soak.ts",
      "capture-packaged-macos-ollama-analysis.ts",
      "capture-packaged-macos-onboarding-settings.ts",
      "capture-packaged-macos-recovery-shortcuts.ts",
      "capture-packaged-macos-retention.ts",
      "capture-packaged-macos-whisper-transcription.ts",
    ];

    for (const script of scripts) {
      const source = fs.readFileSync(path.resolve(process.cwd(), "scripts", script), "utf8");
      expect(source, script).not.toContain("setTimeout(() => resolve(null), 3000)");
      expect(source, script).toContain("setTimeout(() => resolve(null), 15000)");
    }
  });

  it("never searches unrelated TextEdit documents during recovery-shortcut cleanup", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/capture-packaged-macos-recovery-shortcuts.ts"),
      "utf8",
    );
    const cleanup = source.slice(
      source.indexOf("function closeDisposableDocument"),
      source.indexOf("function focusedElementRole"),
    );

    expect(cleanup).toContain(`if (text of document 1) is \${asString(expectedText)} then`);
    expect(cleanup).toContain("close document 1 saving no");
    expect(cleanup).not.toContain("repeat with i from (count of documents)");
    expect(cleanup).not.toContain("contains ${asString(expectedText)}");
  });
});
