import type { DictationBaseModePreset } from "@/lib/dictation-profiles";

/**
 * Numbers as digits: the inverse-text-normalization stage in the sidecar
 * (`rust-sidecar/src/text/itn.rs`), exposed per dictation profile.
 *
 * This module is the TypeScript half of the mirror. `DICTATION_NUMBER_MODE_IDS`
 * matches `DICTATION_NUMBERS_AS_DIGITS_MODES` and
 * `defaultNumbersAsDigits` matches `default_dictation_numbers_as_digits`, both
 * in `rust-sidecar/src/settings.rs`. The sidecar is the one that decides at
 * dictation time (`resolve_dictation_numbers_as_digits` in `lib.rs`); this
 * copy exists so the settings surface can show the same answer without asking.
 */
export const DICTATION_NUMBER_MODE_IDS: readonly DictationBaseModePreset[] = [
  "voice",
  "messages",
  "email",
  "notes",
  "meeting_follow_up",
];

/** Sparse per-preset overrides. An absent key means the preset default. */
export type DictationNumbersAsDigitsMap = Partial<
  Record<DictationBaseModePreset, boolean>
>;

/**
 * On for the drafting presets, off for plain Voice.
 *
 * Mirrors `default_dictation_numbers_as_digits` in
 * `rust-sidecar/src/settings.rs`; the two have to agree or the switch shown
 * here would not be the behavior the sidecar applies.
 */
export function defaultNumbersAsDigits(mode: DictationBaseModePreset): boolean {
  return mode !== "voice";
}

/**
 * The effective value for a built-in preset: the user's override if they set
 * one, otherwise the preset default.
 */
export function resolveNumbersAsDigits(
  mode: DictationBaseModePreset,
  overrides: DictationNumbersAsDigitsMap | undefined,
): boolean {
  const override = overrides?.[mode];
  return typeof override === "boolean" ? override : defaultNumbersAsDigits(mode);
}

/**
 * The effective value for a saved custom profile: its own setting when it has
 * one, otherwise whatever its base style resolves to. A profile saved before
 * this setting existed has no value and inherits.
 *
 * Mirrors the resolution order in `resolve_dictation_numbers_as_digits`
 * (`rust-sidecar/src/lib.rs`).
 */
export function resolveCustomModeNumbersAsDigits(
  own: boolean | null | undefined,
  baseMode: DictationBaseModePreset,
  overrides: DictationNumbersAsDigitsMap | undefined,
): boolean {
  if (typeof own === "boolean") {
    return own;
  }
  return resolveNumbersAsDigits(baseMode, overrides);
}

export const DICTATION_NUMBERS_SECTION_HEADING = "Numbers as digits";

export const DICTATION_NUMBERS_SECTION_DESCRIPTION =
  "Write spoken numbers the way they read: “twelve dollars fifty” becomes $12.50, " +
  "“march third at three thirty pm” becomes March 3 at 3:30 pm. Anything ambiguous " +
  "is left as you said it — “one of them” and “two thirty” stay words.";

/**
 * Per-mode helper line. Voice states the reason it ships off; the others say
 * what the setting is for. Copy has to describe what the app actually does
 * (STYLE §6), so nothing here promises a rule the stage does not implement.
 */
export function numbersAsDigitsModeHint(mode: DictationBaseModePreset): string {
  switch (mode) {
    case "voice":
      return "Off by default: raw voice mode keeps your words as spoken.";
    case "messages":
      return "On by default: times, prices and counts read better in chat.";
    case "email":
      return "On by default: written prose spells numbers as digits.";
    case "notes":
      return "On by default: notes you scan later are easier to read as digits.";
    case "meeting_follow_up":
      return "On by default: follow-ups quote dates, times and amounts.";
  }
}

/** The tri-state a custom profile can be in. */
export type CustomModeNumbersChoice = "inherit" | "on" | "off";

export function customModeNumbersChoice(
  own: boolean | null | undefined,
): CustomModeNumbersChoice {
  if (own === true) {
    return "on";
  }
  if (own === false) {
    return "off";
  }
  return "inherit";
}

export function customModeNumbersValue(
  choice: CustomModeNumbersChoice,
): boolean | null {
  if (choice === "on") {
    return true;
  }
  if (choice === "off") {
    return false;
  }
  return null;
}

export const CUSTOM_MODE_NUMBERS_CHOICE_LABELS: Record<
  CustomModeNumbersChoice,
  string
> = {
  inherit: "Follow the base style",
  on: "Always digits",
  off: "Always as spoken",
};
