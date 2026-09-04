import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, "../App.tsx"),
  "utf8",
);

describe("launch interactive boundary", () => {
  it("reports only inside resolved workspace content or the rendered wizard", () => {
    expect(source).toMatch(
      /<Suspense[\s\S]*?<ActiveView \/>[\s\S]*?!wizardMode &&[\s\S]*?<LaunchInteractiveReporter/,
    );
    expect(source).toMatch(/<FirstRunWizard[\s\S]*?<LaunchInteractiveReporter/);
    expect(source).not.toMatch(
      /onboardingGate\.action === "wait" \|\| interactiveMarkedRef/,
    );
  });
});
