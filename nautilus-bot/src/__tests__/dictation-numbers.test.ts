import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CUSTOM_MODE_NUMBERS_CHOICE_LABELS,
  DICTATION_NUMBER_MODE_IDS,
  DICTATION_NUMBERS_SECTION_DESCRIPTION,
  DICTATION_NUMBERS_SECTION_HEADING,
  customModeNumbersChoice,
  customModeNumbersValue,
  defaultNumbersAsDigits,
  numbersAsDigitsModeHint,
  resolveCustomModeNumbersAsDigits,
  resolveNumbersAsDigits,
} from "@/lib/dictation-numbers";

const SIDECAR_SETTINGS = join(
  __dirname,
  "..",
  "..",
  "rust-sidecar",
  "src",
  "settings.rs",
);

describe("numbers-as-digits defaults", () => {
  it("ships on for the drafting presets and off for plain Voice", () => {
    expect(defaultNumbersAsDigits("voice")).toBe(false);
    expect(defaultNumbersAsDigits("messages")).toBe(true);
    expect(defaultNumbersAsDigits("email")).toBe(true);
    expect(defaultNumbersAsDigits("notes")).toBe(true);
    expect(defaultNumbersAsDigits("meeting_follow_up")).toBe(true);
  });

  it("mirrors the sidecar's preset list and its default for Voice", () => {
    // The switch shown in Settings has to be the behavior the sidecar
    // applies; these two tables are the mirror.
    const source = readFileSync(SIDECAR_SETTINGS, "utf8");
    const list = source.match(
      /DICTATION_NUMBERS_AS_DIGITS_MODES: &\[&str\] =\s*&\[([^\]]*)\]/s,
    );
    expect(list).not.toBeNull();
    const rustModes = [...(list?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map(
      (match) => match[1],
    );
    expect(rustModes).toEqual([...DICTATION_NUMBER_MODE_IDS]);

    const defaults = source.match(
      /pub fn default_dictation_numbers_as_digits[\s\S]*?\n\}/,
    )?.[0];
    expect(defaults).toBeTruthy();
    for (const mode of DICTATION_NUMBER_MODE_IDS) {
      const listedAsTrue = new RegExp(`"${mode}"[^\\n]*=> true`).test(
        defaults ?? "",
      );
      expect(listedAsTrue).toBe(defaultNumbersAsDigits(mode));
    }
  });

  it("uses the stored override when the user set one", () => {
    expect(resolveNumbersAsDigits("voice", { voice: true })).toBe(true);
    expect(resolveNumbersAsDigits("email", { email: false })).toBe(false);
    expect(resolveNumbersAsDigits("email", {})).toBe(true);
    expect(resolveNumbersAsDigits("email", undefined)).toBe(true);
    // An override for a different preset must not leak.
    expect(resolveNumbersAsDigits("voice", { email: true })).toBe(false);
  });

  it("lets a custom profile inherit its base style or override it", () => {
    expect(resolveCustomModeNumbersAsDigits(null, "voice", {})).toBe(false);
    expect(resolveCustomModeNumbersAsDigits(undefined, "email", {})).toBe(true);
    expect(resolveCustomModeNumbersAsDigits(true, "voice", {})).toBe(true);
    expect(resolveCustomModeNumbersAsDigits(false, "email", {})).toBe(false);
    // Inheritance follows the user's preset override, not just the default.
    expect(
      resolveCustomModeNumbersAsDigits(null, "voice", { voice: true }),
    ).toBe(true);
  });

  it("round-trips the custom-profile tri-state", () => {
    expect(customModeNumbersChoice(null)).toBe("inherit");
    expect(customModeNumbersChoice(undefined)).toBe("inherit");
    expect(customModeNumbersChoice(true)).toBe("on");
    expect(customModeNumbersChoice(false)).toBe("off");
    expect(customModeNumbersValue("inherit")).toBeNull();
    expect(customModeNumbersValue("on")).toBe(true);
    expect(customModeNumbersValue("off")).toBe(false);
    for (const stored of [null, true, false] as const) {
      expect(customModeNumbersValue(customModeNumbersChoice(stored))).toBe(
        stored,
      );
    }
  });
});

describe("numbers-as-digits settings copy", () => {
  it("says what the stage does, with the examples it actually produces", () => {
    expect(DICTATION_NUMBERS_SECTION_HEADING).toBe("Numbers as digits");
    expect(DICTATION_NUMBERS_SECTION_DESCRIPTION).toContain("$12.50");
    expect(DICTATION_NUMBERS_SECTION_DESCRIPTION).toContain("3:30 pm");
    // The bound is part of the promise: ambiguous phrases stay as spoken.
    expect(DICTATION_NUMBERS_SECTION_DESCRIPTION).toContain("one of them");
    expect(DICTATION_NUMBERS_SECTION_DESCRIPTION).toContain("two thirty");
  });

  it("explains why Voice ships off", () => {
    expect(numbersAsDigitsModeHint("voice")).toBe(
      "Off by default: raw voice mode keeps your words as spoken.",
    );
    for (const mode of DICTATION_NUMBER_MODE_IDS) {
      const hint = numbersAsDigitsModeHint(mode);
      expect(hint.startsWith(defaultNumbersAsDigits(mode) ? "On" : "Off")).toBe(
        true,
      );
    }
  });

  it("labels the custom-profile choices without inventing a third behavior", () => {
    expect(CUSTOM_MODE_NUMBERS_CHOICE_LABELS.inherit).toBe(
      "Follow the base style",
    );
    expect(CUSTOM_MODE_NUMBERS_CHOICE_LABELS.on).toBe("Always digits");
    expect(CUSTOM_MODE_NUMBERS_CHOICE_LABELS.off).toBe("Always as spoken");
  });
});
