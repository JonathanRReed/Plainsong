import { describe, expect, it } from "vitest";
import {
  LAUNCH_MILESTONE_NAMES,
  formatLaunchMilestone,
  parseRendererLaunchMilestone,
} from "../../electron/launch-milestones";
import fs from "node:fs";
import path from "node:path";

describe("launch milestone contract", () => {
  it("scopes first sidecar responses to a process generation and ignores notifications", () => {
    const bridge = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../electron/ipc-bridge.ts"),
      "utf8",
    );
    expect(bridge).toContain("private sidecarGeneration = 0");
    expect(bridge).toContain("const generation = ++this.sidecarGeneration");
    expect(bridge).toContain("this.handleSidecarMessage(msg, generation)");
    expect(bridge).toContain("generation !== this.sidecarGeneration");
    expect(bridge).toContain("msg.id !== null && msg.id !== undefined");
  });
  it("keeps the required startup milestones in one typed vocabulary", () => {
    expect(LAUNCH_MILESTONE_NAMES).toEqual([
      "electron-module-entry",
      "app-ready",
      "sidecar-spawned",
      "sidecar-first-response",
      "window-created",
      "did-finish-load",
      "renderer-first-contentful-paint",
      "renderer-post-commit-frame",
      "workspace-or-wizard-interactive",
    ]);
  });

  it("accepts only renderer-owned milestones with finite nonnegative timing", () => {
    expect(
      parseRendererLaunchMilestone({
        name: "renderer-post-commit-frame",
        rendererElapsedMs: 18.25,
      }),
    ).toEqual({ name: "renderer-post-commit-frame", rendererElapsedMs: 18.25 });
    expect(
      parseRendererLaunchMilestone({ name: "app-ready", rendererElapsedMs: 2 }),
    ).toBeNull();
    expect(
      parseRendererLaunchMilestone({
        name: "renderer-first-contentful-paint",
        rendererElapsedMs: Number.NaN,
      }),
    ).toBeNull();
  });

  it("writes one parseable privacy-safe structured line", () => {
    const line = formatLaunchMilestone({
      name: "window-created",
      elapsedMs: 42.125,
      wallTimeMs: 1_800_000_000_000,
      source: "main",
    });
    expect(line.startsWith("[launch-milestone] ")).toBe(true);
    expect(JSON.parse(line.slice("[launch-milestone] ".length))).toEqual({
      name: "window-created",
      elapsedMs: 42.125,
      wallTimeMs: 1_800_000_000_000,
      source: "main",
    });
    expect(line).not.toMatch(/path|url|user|profile/i);
  });
});
