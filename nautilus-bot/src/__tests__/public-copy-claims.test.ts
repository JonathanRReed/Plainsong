import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("public performance and accuracy claims", () => {
  it("does not rank cloud routes without comparative measurements", () => {
    const changelog = readFileSync("CHANGELOG.md", "utf8");
    expect(changelog).not.toMatch(/the fastest route Plainsong offers|the lowest published word error rate here/);
  });

  it("describes the optional speech detector without an unmeasured accuracy claim", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).not.toMatch(/VAD model download for better accuracy/);
  });

  it("describes meeting resume without promising zero delay", () => {
    const changelog = readFileSync("CHANGELOG.md", "utf8");
    expect(changelog).not.toMatch(/resume is instant/);
  });

  it("does not promise instant follow-up drafts in the meeting screen", () => {
    const view = readFileSync("src/components/views/recordings-view.tsx", "utf8");
    expect(view).not.toMatch(/these are instant/);
  });
});
