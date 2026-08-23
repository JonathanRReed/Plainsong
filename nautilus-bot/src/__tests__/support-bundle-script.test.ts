import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "scripts/capture-support-bundle.mjs");

describe("capture-support-bundle.mjs", () => {
  it("keeps useful readiness facts while excluding content, credentials, and full paths", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "plainsong-support-bundle-"));
    try {
      const privatePath = path.join(root, "Jonathan Secret Project");
      mkdirSync(privatePath, { recursive: true });
      writeFileSync(path.join(privatePath, "meeting.wav"), "audio");
      writeFileSync(path.join(privatePath, "transcript.md"), "private meeting transcript");
      const settingsPath = path.join(root, "settings.json");
      const diagnosticsPath = path.join(root, "diagnostics.json");
      const outPath = path.join(root, "support-bundle.json");
      writeFileSync(
        settingsPath,
        JSON.stringify({
          theme: "dark",
          transcription: {
            dictationProvider: "whisper",
            dictationModelId: "base.en",
            meetingProvider: "distil_whisper",
            meetingModelId: "distil-large-v3.5",
            dictationCustomPrompt: "The launch password is swordfish",
          },
          privacy: {
            remoteProcessingEnabled: false,
            apiKey: "sk-private-token",
          },
          updates: { channel: "beta", autoCheck: true },
          export: { exportRoot: privatePath },
        }),
      );
      writeFileSync(
        diagnosticsPath,
        JSON.stringify({
          microphoneReady: true,
          accessibilityReady: false,
          cursorInsertionReady: false,
          notes: [`User file ${privatePath}`, "dictated text: private words"],
        }),
      );

      const result = spawnSync(
        "node",
        [
          scriptPath,
          "--settings",
          settingsPath,
          "--diagnostics",
          diagnosticsPath,
          "--inventory-root",
          privatePath,
          "--out",
          outPath,
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      const output = readFileSync(outPath, "utf8");
      const bundle = JSON.parse(output);
      expect(bundle.safeToShare).toBe(true);
      expect(bundle.settings.transcription.dictationProvider).toBe("whisper");
      expect(bundle.readiness.microphoneReady).toBe(true);
      expect(bundle.inventory.audioFiles).toBe(1);
      expect(bundle.inventory.textLikeFiles).toBe(1);
      for (const forbidden of [
        "swordfish",
        "sk-private-token",
        "private meeting transcript",
        "private words",
        privatePath,
        os.homedir(),
        "meeting.wav",
        "transcript.md",
      ]) {
        expect(output).not.toContain(forbidden);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a requested source is unreadable", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "plainsong-support-bundle-"));
    try {
      const outPath = path.join(root, "support-bundle.json");
      const result = spawnSync(
        "node",
        [scriptPath, "--settings", path.join(root, "missing.json"), "--out", outPath],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      const bundle = JSON.parse(readFileSync(outPath, "utf8"));
      expect(bundle.safeToShare).toBe(false);
      expect(bundle.errors[0]).toMatch(/settings source is missing/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
