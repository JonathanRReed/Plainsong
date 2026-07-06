import { describe, expect, it } from "vitest";
import {
  DICTATION_PRIMARY_PRESS_ENTER_COMMAND,
  DICTATION_SPOKEN_EDIT_COMMAND_EXAMPLES,
  getDictationSpokenEditCommandExamples,
} from "@/lib/dictation-voice-edit-actions";
import { SELECTED_TEXT_ACTION_ICONS } from "@/lib/selected-text-action-icons";
import {
  DICTATION_TEXT_ACTIONS,
  BULLETIZE_SELECTION_SEARCH_ALIASES,
  CONTINUE_WRITING_SEARCH_ALIASES,
  estimateTextEditCount,
  EXPLAIN_TEXT_SEARCH_ALIASES,
  EXPAND_TEXT_SEARCH_ALIASES,
  FIND_BUGS_SEARCH_ALIASES,
  formatQuickFixToastMessage,
  formatSelectedTextActionStatusMessage,
  NUMBERED_LIST_SELECTION_SEARCH_ALIASES,
  QUICK_FIX_ACTION_KEY,
  QUICK_FIX_COMMAND_ALIASES,
  QUICK_FIX_COMMAND_LABEL,
  QUICK_FIX_COMMAND_PRESET_KEY,
  QUICK_FIX_LABEL,
  QUICK_FIX_PRIMARY_SPOKEN_EXAMPLE,
  QUICK_FIX_SETTINGS_LABEL,
  QUICK_FIX_SEARCH_ALIASES,
  QUICK_FIX_SPOKEN_COMMAND_EXAMPLES,
  PROMPT_ENGINEER_SEARCH_ALIASES,
  POLISH_LEGACY_IMPROVE_SEARCH_ALIASES,
  POLISH_PRIMARY_SPOKEN_COMMAND_EXAMPLES,
  REWRITE_CASUAL_SEARCH_ALIASES,
  REWRITE_CASUAL_SPOKEN_COMMAND_EXAMPLES,
  REWRITE_FRIENDLY_SEARCH_ALIASES,
  REWRITE_FRIENDLY_SPOKEN_COMMAND_EXAMPLES,
  REWRITE_PROFESSIONAL_SEARCH_ALIASES,
  REWRITE_PROFESSIONAL_SPOKEN_COMMAND_EXAMPLES,
  REWRITE_SHORTER_SEARCH_ALIASES,
  RETURN_ONLY_BULLET_LIST,
  RETURN_ONLY_CORRECTED_TEXT,
  RETURN_ONLY_EXPLANATION,
  RETURN_ONLY_EXPANDED_TEXT,
  RETURN_ONLY_NUMBERED_LIST,
  RETURN_ONLY_PROMPT,
  RETURN_ONLY_REWRITTEN_TEXT,
  RETURN_ONLY_SIMPLIFIED_TEXT,
  RETURN_ONLY_SUMMARY,
  SPOKEN_COMMAND_ACTIONS_LABEL,
  SPOKEN_COMMAND_PREFIX_LABEL,
  SPOKEN_COMMANDS_LABEL,
  SELECTED_TEXT_ACTIONS,
  SELECTED_TEXT_COMMAND_PRESET_ACTIONS,
  SELECTED_TEXT_COMMAND_PRESET_KEYS,
  SELECTED_TEXT_CAPTURE_ACTIONS,
  SELECTED_TEXT_CAPTURE_ACTION_METADATA,
  SELECTED_TEXT_LATEST_RESULT_SHAPE_ACTIONS,
  SELECTED_TEXT_ACTION_SEARCH_ALIASES,
  SELECTED_TEXT_TRANSFORM_SHORTCUTS,
  SELECTED_TEXT_TARGET_POLICY_DETAILS,
  SELECTED_TEXT_TARGET_POLICY_LABELS,
  SIMPLIFY_LANGUAGE_SEARCH_ALIASES,
  SPOKEN_COMMAND_ACTION_EXAMPLES,
  SPOKEN_COMMAND_ACTION_EXAMPLE_LIST,
  SPOKEN_TEXT_CONTEXT_COMMAND_EXAMPLES,
  SUMMARIZE_TEXT_SEARCH_ALIASES,
  TRANSLATE_ENGLISH_SEARCH_ALIASES,
  getDictationTextContextDescription,
  getSpokenTextContextCommandExamples,
  selectedTextActionMetadataForCommandPreset,
  selectedTextActionMetadata,
  selectedTextActionSearchAliases,
  selectedTextActionTransformCommand,
} from "@/lib/selected-text-actions";

function expectSelectedTextAliases(
  action: Parameters<typeof selectedTextActionSearchAliases>[0],
  aliases: string[],
): void {
  expect(selectedTextActionSearchAliases(action)).toEqual(
    expect.arrayContaining(aliases),
  );
}

function expectSelectedTextAliasesNotToInclude(
  action: Parameters<typeof selectedTextActionSearchAliases>[0],
  aliases: string[],
): void {
  expect(selectedTextActionSearchAliases(action)).not.toEqual(
    expect.arrayContaining(aliases),
  );
}

describe("selected text actions", () => {
  it("keeps Quick Fix discoverable through proofreading aliases", () => {
    const quickFix = selectedTextActionMetadata(QUICK_FIX_ACTION_KEY);

    expect(quickFix.paletteLabel).toBe(QUICK_FIX_COMMAND_LABEL);
    expect(quickFix.quickLabel).toBe(QUICK_FIX_LABEL);
    expect(quickFix.commandPresetLabel).toBe(QUICK_FIX_COMMAND_LABEL);
    expect(QUICK_FIX_SETTINGS_LABEL).toBe(
      `${QUICK_FIX_LABEL} / ${QUICK_FIX_COMMAND_LABEL}`,
    );
    expect(quickFix.iconKey).toBe("check");
    expect(quickFix.targetPolicy).toBe("prefer_selection");
    expect(SELECTED_TEXT_TARGET_POLICY_LABELS[quickFix.targetPolicy]).toBe(
      "Prefer selection",
    );
    expect(
      SELECTED_TEXT_TARGET_POLICY_DETAILS[quickFix.targetPolicy],
    ).toContain("focused field");
    expect(quickFix.searchAliases).toEqual(
      expect.arrayContaining([...QUICK_FIX_SEARCH_ALIASES]),
    );
    expectSelectedTextAliases(quickFix, [
      "quick fix",
      "proofread text",
      "proofread selected text",
      "proofread selection",
      "quick fix spelling and grammar",
      "proofread this",
      "proofread it",
      "spell check this",
      "check spelling",
      "fix this",
      "fix typos",
      "fix typos this",
      "fix misspellings",
      "correct this",
      "correct typos",
      "correct typos this",
      "correct misspellings",
      "correct spelling",
      "correct spelling this",
      "correct spelling mistakes",
      "correct spelling errors",
      "fix spelling and grammar",
      "check grammar",
      "grammar check",
      "grammar check this",
      "fix grammar",
      "fix grammar this",
      "fix grammar mistakes",
      "correct grammar",
      "correct grammar this",
      "correct punctuation",
    ]);
    expect(selectedTextActionSearchAliases(quickFix)).not.toContain("grammar");
    expect(QUICK_FIX_PRIMARY_SPOKEN_EXAMPLE).toBe("fix spelling and grammar");
    expect(QUICK_FIX_SPOKEN_COMMAND_EXAMPLES[0]).toBe(
      QUICK_FIX_PRIMARY_SPOKEN_EXAMPLE,
    );
    expect(quickFix.spokenCommandExamples).toEqual([
      ...QUICK_FIX_SPOKEN_COMMAND_EXAMPLES,
    ]);
    expect(quickFix.searchAliases).not.toEqual(
      expect.arrayContaining([...QUICK_FIX_SPOKEN_COMMAND_EXAMPLES]),
    );
    expect(QUICK_FIX_COMMAND_ALIASES).toEqual([
      ...QUICK_FIX_SEARCH_ALIASES,
      ...QUICK_FIX_SPOKEN_COMMAND_EXAMPLES,
    ]);
    expect(selectedTextActionSearchAliases(quickFix)).toEqual([
      ...QUICK_FIX_COMMAND_ALIASES,
    ]);
    for (const example of QUICK_FIX_SPOKEN_COMMAND_EXAMPLES) {
      expect(selectedTextActionSearchAliases(quickFix)).toContain(example);
    }
  });

  it("keeps focused-field fallback limited to Quick Fix", () => {
    const preferSelectionActions = SELECTED_TEXT_ACTIONS.filter(
      (action) => action.targetPolicy === "prefer_selection",
    );
    const selectionRequiredActions = SELECTED_TEXT_ACTIONS.filter(
      (action) => action.targetPolicy === "selection_required",
    );

    expect(preferSelectionActions.map((action) => action.action)).toEqual([
      QUICK_FIX_ACTION_KEY,
    ]);
    expect(preferSelectionActions[0]?.commandPresetKey).toBe(
      QUICK_FIX_COMMAND_PRESET_KEY,
    );
    expect(SELECTED_TEXT_TARGET_POLICY_LABELS.selection_required).toBe(
      "Replace selection",
    );
    expect(SELECTED_TEXT_TARGET_POLICY_DETAILS.selection_required).toContain(
      "replaces it in place",
    );
    expect(selectionRequiredActions.length).toBeGreaterThan(0);
    expect(selectionRequiredActions).not.toContain(preferSelectionActions[0]);
  });

  it("distinguishes spoken dictation commands from the command palette", () => {
    expect(DICTATION_TEXT_ACTIONS.familyLabel).toBe(
      SPOKEN_COMMAND_ACTIONS_LABEL,
    );
    expect(DICTATION_TEXT_ACTIONS.availableLabel).toBe(
      `${SPOKEN_COMMAND_ACTIONS_LABEL} available`,
    );
    expect(DICTATION_TEXT_ACTIONS.commandModeLabel).toBe(SPOKEN_COMMANDS_LABEL);
    expect(DICTATION_TEXT_ACTIONS.commandModeEnabledLabel).toBe(
      `Enable ${SPOKEN_COMMANDS_LABEL.toLowerCase()}`,
    );
    expect(DICTATION_TEXT_ACTIONS.commandPrefixLabel).toBe(
      SPOKEN_COMMAND_PREFIX_LABEL,
    );
    expect(DICTATION_TEXT_ACTIONS.coachBody).toContain(SPOKEN_COMMANDS_LABEL);
    expect(DICTATION_TEXT_ACTIONS.coachBody).not.toContain("Command mode");
    expect(DICTATION_TEXT_ACTIONS.coachBody).toContain(
      SPOKEN_COMMAND_ACTION_EXAMPLE_LIST,
    );
    expect(DICTATION_TEXT_ACTIONS.settingsDescription).toContain(
      SPOKEN_COMMAND_ACTION_EXAMPLE_LIST,
    );
    expect(DICTATION_TEXT_ACTIONS.presetEditorDescription).toContain(
      SPOKEN_COMMAND_ACTION_EXAMPLE_LIST,
    );
    expect(DICTATION_TEXT_ACTIONS.prefixExamples).toContain(
      SPOKEN_COMMAND_ACTION_EXAMPLE_LIST,
    );
    expect(DICTATION_TEXT_ACTIONS.developerCommandSuffix).toContain(
      SPOKEN_COMMAND_ACTION_EXAMPLE_LIST,
    );
    expect(SPOKEN_COMMAND_ACTION_EXAMPLE_LIST).toContain(
      QUICK_FIX_PRIMARY_SPOKEN_EXAMPLE,
    );
    for (const example of SPOKEN_COMMAND_ACTION_EXAMPLES) {
      expect(SPOKEN_COMMAND_ACTION_EXAMPLE_LIST).toContain(example);
    }
    expect(DICTATION_TEXT_ACTIONS.textContextDescription).toContain(
      `command ${QUICK_FIX_PRIMARY_SPOKEN_EXAMPLE}`,
    );
    expect(DICTATION_TEXT_ACTIONS.textContextDescription).toContain(
      "command quick fix",
    );
    expect(DICTATION_TEXT_ACTIONS.textContextDescription).toContain(
      "command proofread this",
    );
    expect(DICTATION_TEXT_ACTIONS.textContextDescription).toContain(
      "command spell check this",
    );
    expect(DICTATION_TEXT_ACTIONS.textContextDescription).toContain(
      "command check spelling",
    );
    expect(DICTATION_TEXT_ACTIONS.textContextDescription).toContain(
      "command fix typos",
    );
    expect(DICTATION_TEXT_ACTIONS.textContextDescription).toContain(
      "command fix grammar",
    );
    expect(DICTATION_TEXT_ACTIONS.textContextDescription).toContain(
      "command check grammar",
    );
    expect(DICTATION_TEXT_ACTIONS.textContextDescription).toContain(
      "command correct spelling",
    );
    expect(DICTATION_TEXT_ACTIONS.textContextDescription).toContain(
      "command make longer",
    );
    expect(DICTATION_TEXT_ACTIONS.textContextDescription).toContain(
      "command make this clearer",
    );
    for (const example of SPOKEN_TEXT_CONTEXT_COMMAND_EXAMPLES) {
      expect(DICTATION_TEXT_ACTIONS.textContextDescription).toContain(example);
    }
    for (const example of DICTATION_SPOKEN_EDIT_COMMAND_EXAMPLES) {
      expect(DICTATION_TEXT_ACTIONS.textContextDescription).toContain(
        `command ${example}`,
      );
    }
    expect(getDictationTextContextDescription("plainsong")).toContain(
      "plainsong new line",
    );
    expect(getDictationTextContextDescription("plainsong")).toContain(
      `plainsong ${QUICK_FIX_PRIMARY_SPOKEN_EXAMPLE}`,
    );
    expect(getDictationTextContextDescription("plainsong")).not.toContain(
      "command new line",
    );
    expect(getSpokenTextContextCommandExamples("plainsong")).toEqual(
      expect.arrayContaining([
        `"plainsong ${QUICK_FIX_PRIMARY_SPOKEN_EXAMPLE}"`,
      ]),
    );
    expect(getDictationSpokenEditCommandExamples("plainsong")).toEqual(
      expect.arrayContaining([
        "plainsong new line",
        `plainsong ${DICTATION_PRIMARY_PRESS_ENTER_COMMAND}`,
      ]),
    );
  });

  it("keeps the selected-text action registry free of duplicate keys", () => {
    const actionKeys = SELECTED_TEXT_ACTIONS.map((action) => action.action);
    expect(new Set(actionKeys).size).toBe(actionKeys.length);
    expect(new Set(SELECTED_TEXT_COMMAND_PRESET_KEYS).size).toBe(
      SELECTED_TEXT_COMMAND_PRESET_KEYS.length,
    );

    for (const action of SELECTED_TEXT_ACTIONS) {
      expect(new Set(action.searchAliases ?? []).size).toBe(
        action.searchAliases?.length ?? 0,
      );
      expect(new Set(action.spokenCommandExamples ?? []).size).toBe(
        action.spokenCommandExamples?.length ?? 0,
      );
      const rawAliases = new Set(action.searchAliases ?? []);
      for (const example of action.spokenCommandExamples ?? []) {
        expect(rawAliases.has(example)).toBe(false);
      }
    }
  });

  it("formats Quick Fix result toasts from shared copy", () => {
    expect(formatQuickFixToastMessage({ pasted: true })).toBe(
      "Quick Fix applied to selected text.",
    );
    expect(
      formatQuickFixToastMessage({
        pasted: true,
        targetScope: "focused_field",
      }),
    ).toBe("Quick Fix applied to focused field.");
    expect(formatQuickFixToastMessage({ copied: true })).toBe(
      "Quick Fix text copied.",
    );
    expect(formatQuickFixToastMessage({})).toBe("Quick Fix result is ready.");
    expect(
      formatQuickFixToastMessage({
        pasted: true,
        inputText: "teh selected text",
        outputText: "the selected text",
      }),
    ).toBe("Quick Fix applied to selected text. 1 text edit: teh -> the.");
    expect(
      formatQuickFixToastMessage({
        copied: true,
        inputText: "teh seperate adress",
        outputText: "the separate address",
      }),
    ).toBe(
      "Quick Fix text copied. 3 text edits: teh -> the, seperate -> separate, adress -> address.",
    );
    expect(
      formatQuickFixToastMessage({
        copied: true,
        error: "Accessibility replacement failed",
        inputText: "teh selected text",
        outputText: "the selected text",
      }),
    ).toBe(
      "Quick Fix text copied. 1 text edit: teh -> the. Could not replace selected text; copied result instead.",
    );
    expect(
      formatQuickFixToastMessage({
        pasted: true,
        targetScope: "focused_field",
        inputText: "Already clean.",
        outputText: "Already clean.",
      }),
    ).toBe("Quick Fix checked focused field. No text edits.");
    expect(
      formatQuickFixToastMessage({
        copied: true,
        inputText: "Already clean.",
        outputText: "Already clean.",
      }),
    ).toBe("Quick Fix checked text. No text edits.");
    expect(estimateTextEditCount("hello world", "hello brave world")).toBe(1);
    expect(estimateTextEditCount("hello world", "Hello world")).toBe(1);
    expect(
      formatQuickFixToastMessage({
        pasted: true,
        inputText: "hello world",
        outputText: "hello brave world",
      }),
    ).toBe("Quick Fix applied to selected text. 1 text edit.");
  });

  it("keeps Quick Fix summaries cheap for long selected text", () => {
    const longInput = Array.from(
      { length: 450 },
      (_, index) => `word${index}`,
    ).join(" ");
    const longOutput = `${longInput} fixed`;

    expect(
      formatQuickFixToastMessage({
        pasted: true,
        inputText: longInput,
        outputText: longOutput,
      }),
    ).toBe("Quick Fix applied to selected text. Text changed.");
    expect(
      formatQuickFixToastMessage({
        pasted: true,
        inputText: longInput,
        outputText: longInput,
      }),
    ).toBe("Quick Fix checked selected text. No text edits.");
  });

  it("formats selected-text transform status from action metadata", () => {
    expect(
      formatSelectedTextActionStatusMessage("rewrite_shorter", {
        pasted: true,
      }),
    ).toBe("Shortened selected text");
    expect(
      formatSelectedTextActionStatusMessage("rewrite_shorter", {
        pasted: true,
        targetScope: "focused_field",
      }),
    ).toBe("Shortened focused field");
    expect(
      formatSelectedTextActionStatusMessage("polish_text", {
        copied: true,
      }),
    ).toBe("Improved text copied");
    expect(
      formatSelectedTextActionStatusMessage("polish_text", {
        copied: true,
        error: "Accessibility replacement failed",
      }),
    ).toBe(
      "Improved text copied. Could not replace selected text; copied result instead.",
    );
    expect(
      formatSelectedTextActionStatusMessage("polish_text", {
        targetScope: "focused_field",
        error: "Accessibility replacement failed",
      }),
    ).toBe("Improved result is ready. Could not replace focused field.");
    expect(formatSelectedTextActionStatusMessage("expand_text", {})).toBe(
      "Expanded result is ready",
    );
    expect(
      formatSelectedTextActionStatusMessage(QUICK_FIX_ACTION_KEY, {
        pasted: true,
        inputText: "teh text",
        outputText: "the text",
      }),
    ).toBe("Quick Fix applied to selected text. 1 text edit: teh -> the.");
  });

  it("keeps capture actions backed by full action metadata", () => {
    const actionIds = new Set(
      SELECTED_TEXT_ACTIONS.map((action) => action.action),
    );

    for (const action of SELECTED_TEXT_CAPTURE_ACTIONS) {
      expect(actionIds.has(action.action)).toBe(true);
      expect(
        selectedTextActionMetadata(action.action).quickLabel.trim(),
      ).not.toBe("");
    }
    expect(
      SELECTED_TEXT_CAPTURE_ACTION_METADATA.map((action) => action.action),
    ).toEqual(SELECTED_TEXT_CAPTURE_ACTIONS.map((action) => action.action));
    expect(
      SELECTED_TEXT_CAPTURE_ACTION_METADATA.map((action) => ({
        action: action.action,
        variant: action.variant,
      })),
    ).toEqual([
      { action: QUICK_FIX_ACTION_KEY, variant: "default" },
      { action: "polish_text", variant: "outline" },
      { action: "rewrite_shorter", variant: "outline" },
      { action: "bulletize_selection", variant: "outline" },
    ]);
    for (const action of SELECTED_TEXT_CAPTURE_ACTION_METADATA) {
      expect(action.metadata).toBe(selectedTextActionMetadata(action.action));
      expect(action.metadata.captureAction?.variant).toBe(action.variant);
      expect(action.metadata.quickLabel.trim()).not.toBe("");
    }
  });

  it("uses one shared icon map for every selected-text action", () => {
    for (const action of SELECTED_TEXT_ACTIONS) {
      expect(SELECTED_TEXT_ACTION_ICONS[action.iconKey]).toBeTruthy();
    }
  });

  it("derives searchable aliases from typed aliases and spoken examples", () => {
    const allAliases = Array.from(
      new Set(SELECTED_TEXT_ACTIONS.flatMap(selectedTextActionSearchAliases)),
    );
    const aliasOwners = new Map<string, string[]>();

    expect(SELECTED_TEXT_ACTION_SEARCH_ALIASES).toEqual(allAliases);
    expect(new Set(SELECTED_TEXT_ACTION_SEARCH_ALIASES).size).toBe(
      SELECTED_TEXT_ACTION_SEARCH_ALIASES.length,
    );
    expect(
      new Set(
        SELECTED_TEXT_ACTION_SEARCH_ALIASES.map((alias) =>
          alias.toLocaleLowerCase(),
        ),
      ).size,
    ).toBe(SELECTED_TEXT_ACTION_SEARCH_ALIASES.length);

    for (const action of SELECTED_TEXT_ACTIONS) {
      const aliases = selectedTextActionSearchAliases(action);

      expect(aliases).toEqual(
        expect.arrayContaining(action.searchAliases ?? []),
      );
      expect(aliases).toEqual(
        expect.arrayContaining(action.spokenCommandExamples ?? []),
      );
      expect(new Set(aliases).size).toBe(aliases.length);
      expect(
        new Set(aliases.map((alias) => alias.toLocaleLowerCase())).size,
      ).toBe(aliases.length);
      for (const alias of aliases) {
        aliasOwners.set(alias, [
          ...(aliasOwners.get(alias) ?? []),
          action.action,
        ]);
      }
    }

    const duplicateAliases = Array.from(aliasOwners.entries()).filter(
      ([, actionKeys]) => new Set(actionKeys).size > 1,
    );
    expect(duplicateAliases).toEqual([]);
  });

  it("derives latest-result shaping actions from full action metadata", () => {
    expect(
      SELECTED_TEXT_LATEST_RESULT_SHAPE_ACTIONS.map((action) => action.action),
    ).toEqual([
      QUICK_FIX_ACTION_KEY,
      "polish_text",
      "prompt_engineer",
    ]);

    expect(
      SELECTED_TEXT_LATEST_RESULT_SHAPE_ACTIONS.every(
        (action) => action.showInLatestResultShape,
      ),
    ).toBe(true);
  });

  it("maps every configurable command preset to a selected-text action", () => {
    const expectedPresetOrder = [
      "rewrite_shorter",
      "expand_text",
      "continue_writing",
      "simplify_language",
      "rewrite_professional",
      "rewrite_friendly",
      "rewrite_casual",
      "summarize_text",
      "translate_english",
      "explain_text",
      "find_bugs",
      QUICK_FIX_COMMAND_PRESET_KEY,
      "bulletize_selection",
      "numbered_list_selection",
      "polish_text",
      "prompt_engineer",
    ];

    expect(SELECTED_TEXT_COMMAND_PRESET_KEYS).toEqual(expectedPresetOrder);
    expect(new Set(SELECTED_TEXT_COMMAND_PRESET_KEYS).size).toBe(
      SELECTED_TEXT_COMMAND_PRESET_KEYS.length,
    );
    expect(
      SELECTED_TEXT_COMMAND_PRESET_ACTIONS.map(
        (action) => action.commandPresetKey,
      ).sort(),
    ).toEqual([...expectedPresetOrder].sort());
    expect(
      selectedTextActionMetadataForCommandPreset("rewrite_shorter").action,
    ).toBe("rewrite_shorter");
    expect(
      selectedTextActionMetadataForCommandPreset("expand_text").action,
    ).toBe("expand_text");
    expect(
      selectedTextActionMetadataForCommandPreset("continue_writing").action,
    ).toBe("continue_writing");
    expect(
      selectedTextActionMetadataForCommandPreset("simplify_language").action,
    ).toBe("simplify_language");
    expect(
      selectedTextActionMetadataForCommandPreset(QUICK_FIX_COMMAND_PRESET_KEY)
        .action,
    ).toBe(QUICK_FIX_ACTION_KEY);
    expect(selectedTextActionTransformCommand(QUICK_FIX_ACTION_KEY)).toBe(
      QUICK_FIX_COMMAND_PRESET_KEY,
    );
    expect(selectedTextActionTransformCommand("rewrite_shorter")).toBe(
      "rewrite_shorter",
    );
    expect(selectedTextActionTransformCommand("uppercase_selection")).toBe(
      "uppercase_selection",
    );
    for (const actionKey of [
      "uppercase_selection",
      "lowercase_selection",
      "title_case_selection",
      "sentence_case_selection",
    ] as const) {
      expect(SELECTED_TEXT_COMMAND_PRESET_KEYS).not.toContain(actionKey);
    }
    expect(
      selectedTextActionMetadataForCommandPreset("summarize_text").action,
    ).toBe("summarize_text");
    expect(
      selectedTextActionMetadataForCommandPreset("rewrite_friendly").action,
    ).toBe("rewrite_friendly");
    expect(
      selectedTextActionMetadataForCommandPreset("rewrite_casual").action,
    ).toBe("rewrite_casual");
    expect(
      selectedTextActionMetadataForCommandPreset("translate_english").action,
    ).toBe("translate_english");
    expect(
      selectedTextActionMetadataForCommandPreset("explain_text").action,
    ).toBe("explain_text");
    expect(selectedTextActionMetadataForCommandPreset("find_bugs").action).toBe(
      "find_bugs",
    );
  });

  it("keeps selected-text transform shortcut metadata centralized", () => {
    expect(selectedTextActionMetadata(QUICK_FIX_ACTION_KEY).shortcut).toBe(
      SELECTED_TEXT_TRANSFORM_SHORTCUTS[QUICK_FIX_ACTION_KEY],
    );
    expect(selectedTextActionMetadata("polish_text").shortcut).toBe(
      SELECTED_TEXT_TRANSFORM_SHORTCUTS.polish_text,
    );
    expect(selectedTextActionMetadata("prompt_engineer").shortcut).toBe(
      SELECTED_TEXT_TRANSFORM_SHORTCUTS.prompt_engineer,
    );
  });

  it("uses shared return-only prompt endings for command presets", () => {
    expect(
      selectedTextActionMetadata(QUICK_FIX_ACTION_KEY).commandDefaultPrompt,
    ).toContain(RETURN_ONLY_CORRECTED_TEXT);
    expect(
      selectedTextActionMetadata("rewrite_shorter").commandDefaultPrompt,
    ).toContain(RETURN_ONLY_REWRITTEN_TEXT);
    expect(
      selectedTextActionMetadata("rewrite_professional").commandDefaultPrompt,
    ).toContain(RETURN_ONLY_REWRITTEN_TEXT);
    expect(
      selectedTextActionMetadata("rewrite_friendly").commandDefaultPrompt,
    ).toContain(RETURN_ONLY_REWRITTEN_TEXT);
    expect(
      selectedTextActionMetadata("rewrite_casual").commandDefaultPrompt,
    ).toContain(RETURN_ONLY_REWRITTEN_TEXT);
    expect(
      selectedTextActionMetadata("expand_text").commandDefaultPrompt,
    ).toContain(RETURN_ONLY_EXPANDED_TEXT);
    expect(
      selectedTextActionMetadata("simplify_language").commandDefaultPrompt,
    ).toContain(RETURN_ONLY_SIMPLIFIED_TEXT);
    expect(
      selectedTextActionMetadata("summarize_text").commandDefaultPrompt,
    ).toContain(RETURN_ONLY_SUMMARY);
    expect(
      selectedTextActionMetadata("explain_text").commandDefaultPrompt,
    ).toContain(RETURN_ONLY_EXPLANATION);
    expect(
      selectedTextActionMetadata("bulletize_selection").commandDefaultPrompt,
    ).toContain(RETURN_ONLY_BULLET_LIST);
    expect(
      selectedTextActionMetadata("numbered_list_selection")
        .commandDefaultPrompt,
    ).toContain(RETURN_ONLY_NUMBERED_LIST);
    expect(
      selectedTextActionMetadata("prompt_engineer").commandDefaultPrompt,
    ).toContain(RETURN_ONLY_PROMPT);
  });

  it("includes an expand action for longer selected-text rewrites", () => {
    const expand = selectedTextActionMetadata("expand_text");

    expect(expand.paletteLabel).toBe("Expand Selected Text");
    expect(expand.commandPresetLabel).toBe("Expand Text");
    expectSelectedTextAliases(expand, [
      "make longer",
      ...EXPAND_TEXT_SEARCH_ALIASES,
    ]);
  });

  it("includes concise aliases for shorter selected-text rewrites", () => {
    const shorten = selectedTextActionMetadata("rewrite_shorter");

    expect(shorten.paletteLabel).toBe("Shorten Selected Text");
    expectSelectedTextAliases(shorten, [
      "make concise",
      ...REWRITE_SHORTER_SEARCH_ALIASES,
    ]);
    expect(shorten.searchAliases).not.toContain("summarize");
  });

  it("includes a continue writing action for drafting from selected text", () => {
    const continuation = selectedTextActionMetadata("continue_writing");

    expect(continuation.paletteLabel).toBe("Continue Writing Selected Text");
    expect(continuation.commandPresetLabel).toBe("Continue Writing");
    expectSelectedTextAliases(continuation, [
      "continue writing",
      ...CONTINUE_WRITING_SEARCH_ALIASES,
    ]);
  });

  it("includes a simplify action for plain-language selected-text rewrites", () => {
    const simplify = selectedTextActionMetadata("simplify_language");

    expect(simplify.paletteLabel).toBe("Simplify Language Selected Text");
    expect(simplify.commandPresetLabel).toBe("Simplify Language");
    expectSelectedTextAliases(simplify, [
      "simplify language",
      ...SIMPLIFY_LANGUAGE_SEARCH_ALIASES,
    ]);
  });

  it("includes a casual tone action for conversational rewrites", () => {
    const casual = selectedTextActionMetadata("rewrite_casual");
    const professional = selectedTextActionMetadata("rewrite_professional");
    const friendly = selectedTextActionMetadata("rewrite_friendly");

    expectSelectedTextAliases(professional, [
      ...REWRITE_PROFESSIONAL_SEARCH_ALIASES,
      ...REWRITE_PROFESSIONAL_SPOKEN_COMMAND_EXAMPLES,
    ]);
    expectSelectedTextAliases(friendly, [
      ...REWRITE_FRIENDLY_SEARCH_ALIASES,
      ...REWRITE_FRIENDLY_SPOKEN_COMMAND_EXAMPLES,
    ]);
    expect(casual.paletteLabel).toBe("Casual Tone Selected Text");
    expect(casual.commandPresetLabel).toBe("Casual Tone");
    expectSelectedTextAliases(casual, [
      ...REWRITE_CASUAL_SEARCH_ALIASES,
      ...REWRITE_CASUAL_SPOKEN_COMMAND_EXAMPLES,
    ]);
  });

  it("keeps parser-backed utility action aliases searchable", () => {
    const summarize = selectedTextActionMetadata("summarize_text");
    const translate = selectedTextActionMetadata("translate_english");
    const explain = selectedTextActionMetadata("explain_text");
    const findBugs = selectedTextActionMetadata("find_bugs");
    const bulletize = selectedTextActionMetadata("bulletize_selection");
    const numberedList = selectedTextActionMetadata("numbered_list_selection");
    const promptEngineer = selectedTextActionMetadata("prompt_engineer");

    expectSelectedTextAliases(summarize, [
      "summarize",
      ...SUMMARIZE_TEXT_SEARCH_ALIASES,
    ]);
    expectSelectedTextAliases(translate, [...TRANSLATE_ENGLISH_SEARCH_ALIASES]);
    expectSelectedTextAliases(findBugs, [...FIND_BUGS_SEARCH_ALIASES]);
    expectSelectedTextAliases(explain, [...EXPLAIN_TEXT_SEARCH_ALIASES]);
    expectSelectedTextAliases(bulletize, [
      "bulletize",
      ...BULLETIZE_SELECTION_SEARCH_ALIASES,
    ]);
    expectSelectedTextAliases(numberedList, [
      "numbered list",
      ...NUMBERED_LIST_SELECTION_SEARCH_ALIASES,
    ]);
    expectSelectedTextAliases(promptEngineer, [
      "prompt engineer",
      ...PROMPT_ENGINEER_SEARCH_ALIASES,
    ]);
  });

  it("keeps Polish discoverable through improve-writing aliases", () => {
    const improve = selectedTextActionMetadata("polish_text");

    expect(improve.paletteLabel).toBe("Polish Selected Text");
    expect(improve.quickLabel).toBe("Polish");
    expect(improve.commandPresetLabel).toBe("Polish");
    expect(improve.commandAppliedLabel).toBe("Polish");
    expect(improve.searchAliases).toEqual([
      ...POLISH_LEGACY_IMPROVE_SEARCH_ALIASES,
    ]);
    expect(improve.spokenCommandExamples).toEqual([
      ...POLISH_PRIMARY_SPOKEN_COMMAND_EXAMPLES,
    ]);
    expectSelectedTextAliases(improve, [
      ...POLISH_LEGACY_IMPROVE_SEARCH_ALIASES,
      ...POLISH_PRIMARY_SPOKEN_COMMAND_EXAMPLES,
    ]);
    expectSelectedTextAliasesNotToInclude(improve, ["rewrite", "rewrite this"]);
    expect(SPOKEN_COMMAND_ACTION_EXAMPLES).toContain("polish");
  });

  it("includes deterministic case transforms without adding AI presets", () => {
    const uppercase = selectedTextActionMetadata("uppercase_selection");
    const lowercase = selectedTextActionMetadata("lowercase_selection");
    const titleCase = selectedTextActionMetadata("title_case_selection");
    const sentenceCase = selectedTextActionMetadata("sentence_case_selection");

    expect(uppercase.paletteLabel).toBe("Uppercase Selected Text");
    expect(lowercase.paletteLabel).toBe("Lowercase Selected Text");
    expect(titleCase.paletteLabel).toBe("Title Case Selected Text");
    expect(sentenceCase.paletteLabel).toBe("Sentence Case Selected Text");
    expect(uppercase.commandPresetKey).toBeUndefined();
    expect(lowercase.commandPresetKey).toBeUndefined();
    expect(titleCase.commandPresetKey).toBeUndefined();
    expect(sentenceCase.commandPresetKey).toBeUndefined();
    expectSelectedTextAliases(uppercase, [
      "uppercase",
      "make uppercase",
      "make selection uppercase",
      "make this uppercase",
      "make that uppercase",
    ]);
    expectSelectedTextAliases(lowercase, [
      "lowercase",
      "make lowercase",
      "make selection lowercase",
      "make this lowercase",
      "make that lowercase",
    ]);
    expectSelectedTextAliases(titleCase, [
      "title case",
      "make title case",
      "make selection title case",
      "make this title case",
      "make that title case",
    ]);
    expectSelectedTextAliases(sentenceCase, [
      "sentence case",
      "make sentence case",
      "make selection sentence case",
      "make this sentence case",
      "make that sentence case",
    ]);
  });

  it("only exposes command keys the Rust sidecar recognizes", () => {
    // Mirrors `dictation_command_selected_text_label` in
    // rust-sidecar/src/dictation_parity.rs. Every key SELECTED_TEXT_ACTIONS
    // exposes to the command palette must appear in this list, or
    // `transform_selected_text_impl` hard-errors with "Unsupported
    // selected-text transform: <key>" the moment a user runs it. There is no
    // automated cross-language check between the TS and Rust source files,
    // so this list must be updated by hand whenever
    // `dictation_command_selected_text_label` gains or loses a command —
    // the Rust-side test `every_renderer_selected_text_command_has_a_selected_text_label`
    // is this test's counterpart on the other side of the IPC boundary.
    const rustSupportedCommandKeys = new Set([
      "proofread_text",
      "rewrite_shorter",
      "expand_text",
      "continue_writing",
      "simplify_language",
      "rewrite_professional",
      "rewrite_friendly",
      "rewrite_casual",
      "summarize_text",
      "translate_english",
      "explain_text",
      "find_bugs",
      "bulletize_selection",
      "numbered_list_selection",
      "polish_text",
      "prompt_engineer",
      "uppercase_selection",
      "lowercase_selection",
      "title_case_selection",
      "sentence_case_selection",
    ]);

    const exposedCommandKeys = SELECTED_TEXT_ACTIONS.map((action) =>
      selectedTextActionTransformCommand(action.action),
    );

    for (const commandKey of exposedCommandKeys) {
      expect(
        rustSupportedCommandKeys.has(commandKey),
        `expected Rust sidecar to support command key '${commandKey}' exposed by SELECTED_TEXT_ACTIONS`,
      ).toBe(true);
    }
  });
});
