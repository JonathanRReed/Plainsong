import type { DictationInsertionMode, DictationModePreset } from "@/features/dictation/runtime";
import type { DictationHistoryDetails } from "@/lib/backend/dictation";
import { formatAppliedDictationCommandLabel } from "@/lib/dictation-command-labels";

type DictationSessionInsertionMode =
  | DictationInsertionMode
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
  auto: "Recommended",
  paste: "Paste at cursor",
  inline: "Insert on release",
  clipboard_only: "Clipboard only",
};

export const SESSION_INSERTION_MODE_LABELS: Record<
  DictationSessionInsertionMode,
  string
> = {
  ...INSERTION_MODE_LABELS,
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
