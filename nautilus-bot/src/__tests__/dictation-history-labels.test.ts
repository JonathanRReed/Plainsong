import { describe, expect, it } from "vitest";
import {
  formatInsertionModeLabel,
  historyModeLabel,
  historyPipelineStageLabel,
  historyPromptSourceLabel,
  INSERTION_MODE_LABELS,
  SESSION_INSERTION_MODE_LABELS,
} from "@/lib/dictation-history-labels";

describe("dictation history labels", () => {
  it("formats insertion modes for live state and saved sessions", () => {
    expect(INSERTION_MODE_LABELS.clipboard_only).toBe("Clipboard only");
    expect(SESSION_INSERTION_MODE_LABELS.command_only).toBe("Command only");
    expect(SESSION_INSERTION_MODE_LABELS.none).toBe("Save only");
    expect(formatInsertionModeLabel(null)).toBeNull();
    expect(formatInsertionModeLabel("clipboard_only")).toBe("Clipboard only");
    expect(formatInsertionModeLabel("none")).toBe("Save only");
    expect(formatInsertionModeLabel("custom_mode")).toBe("custom mode");
  });

  it("prefers saved mode labels before falling back to presets", () => {
    expect(historyModeLabel(null)).toBe("Unavailable");
    expect(
      historyModeLabel({ modeLabel: "My Slack style", modePreset: "messages" }),
    ).toBe("My Slack style");
    expect(historyModeLabel({ modeLabel: null, modePreset: "messages" })).toBe(
      "Slack & Chat",
    );
    expect(
      historyModeLabel({ modeLabel: null, modePreset: "experimental" }),
    ).toBe("experimental");
    expect(historyModeLabel({ modeLabel: null, modePreset: null })).toBe(
      "Unavailable",
    );
  });

  it("names prompt sources in user-facing history metadata", () => {
    expect(historyPromptSourceLabel(null)).toBe("Direct transcript");
    expect(historyPromptSourceLabel("command:quick_fix")).toBe(
      "Command: Quick Fix",
    );
    expect(historyPromptSourceLabel("dictation_command:quick_fix")).toBe(
      "Command: Quick Fix",
    );
    expect(historyPromptSourceLabel("mode:messages")).toBe(
      "Mode transform: Slack & Chat",
    );
    expect(historyPromptSourceLabel("mode_transform:meeting_follow_up")).toBe(
      "Mode transform: Meeting Follow-up",
    );
    expect(historyPromptSourceLabel("custom_mode_format:abc")).toBe(
      "Style-specific instructions",
    );
    expect(historyPromptSourceLabel("custom_dictation_format")).toBe(
      "Custom instructions",
    );
    expect(historyPromptSourceLabel("default_dictation_format")).toBe(
      "Standard instructions",
    );
    expect(historyPromptSourceLabel("raw_source")).toBe("raw_source");
  });

  it("keeps pipeline stage labels readable", () => {
    expect(historyPipelineStageLabel("dictionary")).toBe("Dictionary");
    expect(historyPipelineStageLabel("mode_transform")).toBe("Mode transform");
    expect(historyPipelineStageLabel("mode_transform_fallback")).toBe(
      "Mode transform fallback",
    );
    expect(historyPipelineStageLabel("backtrack")).toBe("Voice edits");
    expect(historyPipelineStageLabel("inline_correction")).toBe("Voice edits");
    expect(historyPipelineStageLabel("press_enter")).toBe("Press Enter");
    expect(historyPipelineStageLabel("snippets")).toBe("Snippets");
    expect(historyPipelineStageLabel("smart_formatting")).toBe("Voice edits");
    expect(historyPipelineStageLabel("custom_stage")).toBe("Custom Stage");
  });
});
