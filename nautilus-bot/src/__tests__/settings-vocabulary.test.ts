import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RETIRED_SETTINGS_TERMS,
  SETTINGS_VOCABULARY,
  conceptsWithTwoTerms,
  stripComments,
  termsWithTwoConcepts,
} from "@/lib/settings-vocabulary";
import { sidecarSource } from "./sidecar-source";

/**
 * The settings surface, as files rather than as a screen.
 *
 * Every file here renders something a reader sees inside Settings or the
 * Models screen. A retired word reaching any of them is the failure this test
 * exists to catch: it fails at the commit that reintroduces the word, not the
 * next time someone reads the tab.
 */
const SETTINGS_SURFACE = [
  "src/components/views/settings-view-simple.tsx",
  // Not a Settings tab, but it renders the other half of the shared
  // auto-delete control and it is where dictation profiles are made, so the
  // same vocabulary has to hold there.
  "src/components/views/dictation-view.tsx",
  "src/components/asr-provider-manager.tsx",
  "src/components/local-tools-section.tsx",
  "src/components/remembered-voices-section.tsx",
  "src/components/meetings/calendar-settings-section.tsx",
  "src/components/settings/support-bundle-panel.tsx",
  "src/components/ui/settings-control.tsx",
  "src/components/update/BetaChannelToggle.tsx",
  "src/components/update/UpdateStatusWidget.tsx",
  "src/components/models/models-screen.tsx",
  "src/components/models/ai-lane-row.tsx",
  "src/components/models/ai-lanes.ts",
  "src/components/models/speech-lane-row.tsx",
  "src/components/models/preset-picker.tsx",
  "src/components/models/model-presets.ts",
  "src/components/models/model-facts.tsx",
  "src/components/models/model-footprint.tsx",
  "src/components/models/more-models-drawer.tsx",
  "src/components/models/live-preview-engine-row.tsx",
  "src/components/models/zero-setup-model-row.tsx",
] as const;

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function surfaceSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("settings vocabulary", () => {
  it("never uses one word for two concepts", () => {
    expect(
      termsWithTwoConcepts(),
      "a word listed against two concepts is exactly the confusion this list exists to prevent",
    ).toEqual([]);
  });

  it("never uses two words for one concept", () => {
    expect(
      conceptsWithTwoTerms(),
      "two names for one thing is how Settings ended up with 'mode', 'profile' and 'style' for the same feature",
    ).toEqual([]);
  });

  it("gives every settled term a sentence saying what it means", () => {
    for (const entry of SETTINGS_VOCABULARY) {
      expect(entry.term.trim().length, entry.concept).toBeGreaterThan(0);
      expect(entry.term).toBe(entry.term.toLowerCase());
      expect(entry.means.trim().length, entry.term).toBeGreaterThan(20);
    }
  });

  it("gives every retired phrase a replacement and a reason", () => {
    for (const retired of RETIRED_SETTINGS_TERMS) {
      expect(retired.useInstead.trim().length).toBeGreaterThan(0);
      expect(retired.because.trim().length).toBeGreaterThan(20);
    }
  });

  it.each(SETTINGS_SURFACE)("keeps retired words out of %s", (relativePath) => {
    const source = stripComments(surfaceSource(relativePath));
    const offenders = RETIRED_SETTINGS_TERMS.filter((retired) =>
      retired.pattern.test(source),
    ).map((retired) => `"${retired.pattern.source}" -> use ${retired.useInstead}`);
    expect(offenders).toEqual([]);
  });

  /**
   * The sidecar's error strings surface verbatim in the dictation popup and in
   * the settings error banner, so they are part of the same vocabulary. Only
   * the phrases that actually reached a user are checked here -- "custom mode"
   * is still the internal name in `dictation_text.rs`, and renaming a Rust
   * identifier is not what this pass is for.
   */
  it("keeps retired words out of the sidecar's user-facing strings", () => {
    const source = stripComments(sidecarSource());
    const userFacing = [
      /\bdictation modes? prefers\b/i,
      /custom modes and dictation commands/i,
      /Ollama or a cloud provider/i,
    ];
    const offenders = userFacing
      .filter((pattern) => pattern.test(source))
      .map((pattern) => pattern.source);
    expect(offenders).toEqual([]);
  });
});

describe("stripComments", () => {
  it("drops line and block comments but keeps rendered text", () => {
    const stripped = stripComments(
      [
        "// a custom mode used to be called this",
        "/* and a custom mode here too */",
        '{/* and a custom mode in JSX */}',
        'const label = "saved profile";',
      ].join("\n"),
    );
    expect(stripped).not.toMatch(/custom mode/);
    expect(stripped).toMatch(/saved profile/);
  });

  it("leaves a URL's double slash alone", () => {
    expect(stripComments('const url = "plainsong://start";')).toMatch(
      /plainsong:\/\/start/,
    );
  });
});
