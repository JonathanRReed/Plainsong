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

const DEFAULT_VOICE_NUMBERS_AS_DIGITS = true;

/**
 * Digits by default for every preset. Voice retains small prose numbers.
 *
 * Mirrors `default_dictation_numbers_as_digits` in
 * `rust-sidecar/src/settings.rs`; the two have to agree or the switch shown
 * here would not be the behavior the sidecar applies.
 */
export function defaultNumbersAsDigits(mode: DictationBaseModePreset): boolean {
  return mode === "voice" ? DEFAULT_VOICE_NUMBERS_AS_DIGITS : true;
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
  'Write "twelve dollars fifty" as $12.50 and "march third at three thirty pm" ' +
  'as March 3 at 3:30 pm. Voice keeps "one of them" and small prose numbers as words. ' +
  'Ambiguous phrases such as "two thirty" stay words. Turn off to write numbers as words.';

/**
 * Per-mode description of the default number style.
 */
export function numbersAsDigitsModeHint(mode: DictationBaseModePreset): string {
  switch (mode) {
    case "voice":
      return "On by default: digits for data, words for small prose numbers.";
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
  on: "Digits",
  off: "Words",
};
