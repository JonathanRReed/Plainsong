import { describe, expect, it } from "vitest";
import { RECOMMENDED_APP_STYLES, VOICE_EDIT_STYLE_ID } from "@/lib/dictation-profiles";
import { formatAppliedDictationCommandLabel } from "@/lib/dictation-command-labels";

describe("Voice Edit style", () => {
  it("captures the selection and is marked as an instruction profile", () => {
    const style = RECOMMENDED_APP_STYLES.find((candidate) => candidate.id === VOICE_EDIT_STYLE_ID);
    expect(style?.voiceEdit).toBe(true);
    expect(style?.contextSource).toBe("selected_text");
    // The command grammar would compete with the instruction.
    expect(style?.commandModeEnabled).toBe(false);
  });

  it("labels both outcomes in history", () => {
    expect(formatAppliedDictationCommandLabel("voice_edit")).toBe("Voice edit");
    expect(formatAppliedDictationCommandLabel("help_me_write")).toBe("Help me write");
  });
});
