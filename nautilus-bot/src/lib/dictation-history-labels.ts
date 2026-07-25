import type { DictationInsertionMode, DictationModePreset } from "@/features/dictation/runtime";
import type { DictationHistoryDetails } from "@/lib/backend/dictation";
import { formatAppliedDictationCommandLabel } from "@/lib/dictation-command-labels";

type DictationSessionInsertionMode =
  | DictationInsertionMode
  // Retired settings values that stored sessions may still carry.
  | "paste"
  | "inline"
  | "command_only"
  | "none";

const MODE_LABELS: Record<DictationModePreset, string> = {
  voice: "General",
  messages: "Slack & Chat",
  email: "Writing",
  notes: "Notes",
  meeting_follow_up: "Meeting Follow-up",
  custom: "Custom",
};

const VOICE_EDIT_PIPELINE_STAGE_KEYS = new Set([
  "backtrack",
  "inline_correction",
  "smart_formatting",
]);

export const INSERTION_MODE_LABELS: Record<DictationInsertionMode, string> = {
  auto: "Insert at cursor",
  clipboard_only: "Clipboard only",
};

/**
 * Coerce a stored insertion mode onto the two behaviors that still exist.
 *
 * Mirrors `normalize_dictation_insertion_mode` in rust-sidecar/src/settings.rs.
 * The sidecar migrates saved values on load, so this only covers settings that
 * reach the renderer before that rewrite lands on disk — without it, a profile
 * still carrying `paste` indexes `INSERTION_MODE_LABELS` to `undefined` and
 * puts a value the picker has no option for into its `<select>`.
 */
export function normalizeInsertionMode(
  value: string | null | undefined,
): DictationInsertionMode {
  return value?.trim() === "clipboard_only" ? "clipboard_only" : "auto";
}

export const SESSION_INSERTION_MODE_LABELS: Record<
  DictationSessionInsertionMode,
  string
> = {
  ...INSERTION_MODE_LABELS,
  // History rows recorded before "paste"/"inline" were retired named the same
  // insert path the app still takes, so they read under its current name
  // rather than as modes that no longer exist.
  paste: INSERTION_MODE_LABELS.auto,
  inline: INSERTION_MODE_LABELS.auto,
  command_only: "Command only",
  none: "Save only",
};

function formatSnakeCaseLabel(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatInsertionModeLabel(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return (
    SESSION_INSERTION_MODE_LABELS[value as DictationSessionInsertionMode] ??
    value.replace(/_/g, " ")
  );
}

export function historyModeLabel(
  details: Pick<DictationHistoryDetails, "modeLabel" | "modePreset"> | null,
): string {
  if (!details) {
    return "Unavailable";
  }
  if (details.modeLabel) {
    return details.modeLabel;
  }
  if (details.modePreset) {
    return MODE_LABELS[details.modePreset as DictationModePreset] ?? details.modePreset;
  }
  return "Unavailable";
}

export function historyPromptSourceLabel(
  promptSource: string | null | undefined,
): string {
  if (!promptSource) {
    return "Direct transcript";
  }
  if (
    promptSource.startsWith("command:") ||
    promptSource.startsWith("dictation_command:")
  ) {
    const command = promptSource.slice(promptSource.indexOf(":") + 1);
    return `Command: ${formatAppliedDictationCommandLabel(command) ?? command}`;
  }
  if (
    promptSource.startsWith("mode:") ||
    promptSource.startsWith("mode_transform:")
  ) {
    const modePreset = promptSource.slice(promptSource.indexOf(":") + 1);
    return `Mode transform: ${historyModeLabel({
      modeLabel: null,
      modePreset,
    })}`;
  }
  if (promptSource.startsWith("custom_mode_format:")) {
    return "Style-specific instructions";
  }
  if (promptSource === "custom_dictation_format") {
    return "Custom instructions";
  }
  if (promptSource === "default_dictation_format") {
    return "Standard instructions";
  }
  return promptSource;
}

export function historyPipelineStageLabel(stageKey: string): string {
  if (VOICE_EDIT_PIPELINE_STAGE_KEYS.has(stageKey)) {
    return "Voice edits";
  }

  switch (stageKey) {
    case "dictionary":
      return "Dictionary";
    case "mode_transform":
      return "Mode transform";
    case "mode_transform_fallback":
      return "Mode transform fallback";
    case "press_enter":
      return formatAppliedDictationCommandLabel(stageKey) ?? "Press Enter";
    case "snippets":
      return "Snippets";
    default:
      return formatSnakeCaseLabel(stageKey);
  }
}
