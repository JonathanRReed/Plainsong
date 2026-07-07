import type { SelectedTextTransformCommand } from "@/lib/backend/dictation";
import {
  getDictationSpokenEditCommandExamples,
  normalizeDictationCommandPrefix,
} from "@/lib/dictation-voice-edit-actions";
import {
  assertUniqueNormalizedStrings,
  assertUniqueStrings,
  capitalizeString,
  combineNormalizedUniqueStringGroups,
  formatStringList,
  uniqueStrings,
} from "@/lib/string-registry";

type SelectedTextCommandActionKey = Exclude<
  SelectedTextTransformCommand,
  "proofread_text"
>;

type SelectedTextCaseTransformCommand =
  | "uppercase_selection"
  | "lowercase_selection"
  | "title_case_selection"
  | "sentence_case_selection";

type SelectedTextToneRewriteCommand =
  | "rewrite_professional"
  | "rewrite_friendly"
  | "rewrite_casual";

export type SelectedTextQuickActionKey =
  | "proofread"
  | SelectedTextCommandActionKey;

type SelectedTextActionCommandPresetKey = Exclude<
  SelectedTextTransformCommand,
  SelectedTextCaseTransformCommand
>;

export type SelectedTextActionIconKey =
  | "brain"
  | "bug"
  | "check"
  | "file_text"
  | "list"
  | "languages"
  | "search"
  | "sparkles"
  | "terminal"
  | "zap";

type SelectedTextActionTargetPolicy = "prefer_selection" | "selection_required";

export const SELECTED_TEXT_TARGET_POLICY_LABELS: Record<
  SelectedTextActionTargetPolicy,
  string
> = {
  prefer_selection: "Prefer selection",
  selection_required: "Replace selection",
};

export const SELECTED_TEXT_TARGET_POLICY_DETAILS: Record<
  SelectedTextActionTargetPolicy,
  string
> = {
  prefer_selection:
    "Targets selected text first, then the focused field when supported.",
  selection_required:
    "Requires selected text and replaces it in place when supported.",
};

type SelectedTextActionBaseMetadata = {
  action: SelectedTextQuickActionKey;
  paletteLabel: string;
  quickLabel: string;
  busyLabel?: string;
  resultLabel: string;
  detail: string;
  iconKey: SelectedTextActionIconKey;
  targetPolicy: SelectedTextActionTargetPolicy;
  commandAppliedLabel: string;
  searchAliases?: string[];
  spokenCommandExamples?: string[];
  showInLatestResultShape?: boolean;
  captureAction?: {
    order: number;
    variant: "default" | "outline";
  };
  shortcut?: string;
};

type SelectedTextActionCommandPresetMetadata = {
  commandPresetKey: SelectedTextActionCommandPresetKey;
  commandPresetLabel: string;
  commandPresetOrder: number;
  commandDefaultPrompt: string;
};

type SelectedTextActionMetadata = SelectedTextActionBaseMetadata &
  Partial<SelectedTextActionCommandPresetMetadata>;

type SelectedTextCaptureAction = {
  action: SelectedTextQuickActionKey;
  variant: "default" | "outline";
};

type SelectedTextCaptureActionMetadata = SelectedTextCaptureAction & {
  metadata: SelectedTextActionMetadata;
};

type SelectedTextActionWithCaptureAction = SelectedTextActionMetadata & {
  captureAction: NonNullable<SelectedTextActionMetadata["captureAction"]>;
};

export const QUICK_FIX_ACTION_KEY = "proofread" as const;
export const QUICK_FIX_COMMAND_PRESET_KEY = "proofread_text" as const;
export const QUICK_FIX_LABEL = "Quick Fix";
export const QUICK_FIX_COMMAND_LABEL = "Fix Spelling and Grammar";
export const QUICK_FIX_SETTINGS_LABEL = `${QUICK_FIX_LABEL} / ${QUICK_FIX_COMMAND_LABEL}`;
const QUICK_FIX_BUSY_LABEL = "Fixing";
const QUICK_FIX_RESULT_LABEL = "Fixed spelling and grammar";
const QUICK_FIX_CORE_ALIASES = [
  "quick fix spelling and grammar",
  "proofread",
  "proofread text",
  "proofread selection",
  "proofread selected text",
] as const;

const QUICK_FIX_SPELLING_ALIASES = [
  "spell check",
  "spellcheck",
  "spellcheck this",
  "check spelling this",
  "fix spelling",
  "fix spelling this",
  "fix spelling mistakes",
  "fix spelling errors",
  "correct spelling this",
  "correct spelling mistakes",
  "correct spelling errors",
] as const;

const QUICK_FIX_GRAMMAR_ALIASES = [
  "grammar check",
  "grammar check this",
  "check grammar this",
  "fix grammar this",
  "fix grammar mistakes",
  "correct grammar",
  "correct grammar this",
  "correct grammar mistakes",
  "correct spelling and grammar",
] as const;

const QUICK_FIX_TYPO_ALIASES = [
  "fix this",
  "fix that",
  "fix typo",
  "fix typo this",
  "fix misspellings",
  "fix typos this",
  "correct typo",
  "correct typo this",
  "correct typos",
  "correct typos this",
  "correct misspellings",
  "correct this",
  "correct that",
] as const;

const QUICK_FIX_PUNCTUATION_ALIASES = [
  "check punctuation",
  "fix punctuation",
  "correct punctuation",
] as const;

export const QUICK_FIX_SEARCH_ALIASES = [
  ...QUICK_FIX_CORE_ALIASES,
  ...QUICK_FIX_SPELLING_ALIASES,
  ...QUICK_FIX_GRAMMAR_ALIASES,
  ...QUICK_FIX_TYPO_ALIASES,
  ...QUICK_FIX_PUNCTUATION_ALIASES,
] as const;

export const QUICK_FIX_PRIMARY_SPOKEN_EXAMPLE = "fix spelling and grammar";
export const QUICK_FIX_SPOKEN_COMMAND_EXAMPLES = [
  QUICK_FIX_PRIMARY_SPOKEN_EXAMPLE,
  "quick fix",
  "proofread this",
  "proofread it",
  "spell check this",
  "check spelling",
  "fix typos",
  "fix grammar",
  "check grammar",
  "correct spelling",
] as const;

export const QUICK_FIX_COMMAND_ALIASES = [
  ...QUICK_FIX_SEARCH_ALIASES,
  ...QUICK_FIX_SPOKEN_COMMAND_EXAMPLES,
] as const;

export const POLISH_LEGACY_IMPROVE_SEARCH_ALIASES = [
  "improve writing",
  "improve this",
  "improve it",
  "improve the writing",
  "improve my writing",
  "clean up writing",
  "clean up the writing",
  "clean up this writing",
  "clean this up",
  "clean it up",
  "make this read better",
  "make it read better",
  "polish it",
] as const;

export const POLISH_PRIMARY_SPOKEN_COMMAND_EXAMPLES = [
  "polish",
  "polish this",
  "make this clearer",
  "make it clearer",
] as const;

export const BULLETIZE_SELECTION_SEARCH_ALIASES = [
  "bulletize selection",
  "bulletize this",
  "bullets",
  "bullet points",
  "bullet list",
  "make a bullet list",
  "make it a bullet list",
  "make bullet points",
  "make this a bullet list",
  "turn this into bullets",
  "turn this into bullet points",
  "turn it into bullets",
  "turn it into bullet points",
] as const;

export const NUMBERED_LIST_SELECTION_SEARCH_ALIASES = [
  "numbered list selection",
  "make this a numbered list",
  "make it a numbered list",
  "turn this into a numbered list",
  "turn it into a numbered list",
  "turn this into steps",
  "turn it into steps",
  "numbered steps",
  "ordered list",
  "make a numbered list",
  "make this an ordered list",
  "make it an ordered list",
  "step by step",
] as const;

export const SUMMARIZE_TEXT_SEARCH_ALIASES = [
  "summarize selection",
  "summarize selected text",
  "summarize this",
  "summarize it",
  "summarise selection",
  "summarise selected text",
  "summarise this",
  "summarise it",
  "summarise",
  "make this a summary",
  "make it a summary",
  "give me a summary",
  "summarize this text",
  "turn this into a summary",
  "turn it into a summary",
  "main takeaways",
  "key takeaways",
  "give me the takeaways",
  "what are the takeaways",
  "summary",
  "tl dr",
  "tldr",
  "give me a tl dr",
  "give me a tldr",
  "too long didnt read",
  "too long did not read",
] as const;

export const TRANSLATE_ENGLISH_SEARCH_ALIASES = [
  "translate",
  "translate english",
  "translate this to english",
  "translate it to english",
  "translate this into english",
  "translate it into english",
  "translate selection",
  "translate selection to english",
  "translate the selection to english",
  "translate selected text",
  "translate selected text to english",
  "translate this text to english",
] as const;

export const REWRITE_SHORTER_SEARCH_ALIASES = [
  "rewrite shorter",
  "make shorter",
  "make this shorter",
  "make it shorter",
  "make this concise",
  "make it concise",
  "make more concise",
  "make this more concise",
  "make it more concise",
  "more concise",
  "condense",
] as const;

export const EXPAND_TEXT_SEARCH_ALIASES = [
  "expand",
  "expand text",
  "make this longer",
  "make it longer",
  "elaborate",
  "expand this outline",
  "turn this outline into an essay",
  "turn this outline into prose",
  "turn this outline into a draft",
  "expand it into prose",
] as const;

export const CONTINUE_WRITING_SEARCH_ALIASES = [
  "continue",
  "keep writing",
  "finish writing",
  "finish this",
] as const;

export const SIMPLIFY_LANGUAGE_SEARCH_ALIASES = [
  "simplify",
  "make simpler",
  "make this simpler",
  "make it simpler",
  "plain language",
] as const;

export const EXPLAIN_TEXT_SEARCH_ALIASES = [
  "explain",
  "explain this",
  "explain it",
  "explain that",
  "explain the text",
  "explain this text",
  "explain code",
  "explain this code",
  "explain selected code",
  "code overview",
  "give code overview",
  "give me a code overview",
  "explain code step by step",
  "explain this code step by step",
  "walk through this code",
  "explain in simple terms",
  "explain this in simple terms",
  "explain code in simple terms",
  "explain it in simple terms",
  "explain selected text",
  "what does this mean",
] as const;

export const FIND_BUGS_SEARCH_ALIASES = [
  "find bugs in this",
  "find bugs in selected text",
  "find bugs in code",
  "review for bugs",
  "review this for bugs",
  "check this for bugs",
  "check it for bugs",
  "review this code",
  "code review",
  "debug selection",
  "review code",
] as const;

export const PROMPT_ENGINEER_SEARCH_ALIASES = [
  "prompt",
  "make this a prompt",
  "make it a prompt",
  "turn this into a prompt",
  "turn it into a prompt",
  "ai prompt",
] as const;

export const REWRITE_PROFESSIONAL_SEARCH_ALIASES = [
  ...toneLabelAliases(["professional", "formal", "assertive"]),
  ...changeToneAliases(["professional", "formal"]),
  ...makeAdjectiveAliases(["professional"]),
  ...soundAdjectiveAliases(["professional"]),
  ...soundMoreAdjectiveAliases(["professional"]),
  "make more assertive",
  "make this more assertive",
  "make it more assertive",
  "make this more assertive and concise",
  "more assertive",
  ...rewriteInToneAliases(["professional", "formal"]),
] as const;

export const REWRITE_PROFESSIONAL_SPOKEN_COMMAND_EXAMPLES = [
  "rewrite professional",
] as const;

export const REWRITE_FRIENDLY_SEARCH_ALIASES = [
  "rewrite friendly",
  "rewrite polite",
  ...rewriteInToneAliases(["friendly", "friendlier", "polite"]),
  ...toneLabelAliases(["warm", "polite"]),
  ...changeToneAliases(["friendly", "polite"]),
  ...makeAdjectiveAliases(["friendly"]),
  ...soundAdjectiveAliases(["friendly", "friendlier"]),
  "make this friendlier",
  "make it friendlier",
  ...makeAdjectiveAliases(["polite"]),
  "make this warmer",
  "make it warmer",
] as const;

export const REWRITE_FRIENDLY_SPOKEN_COMMAND_EXAMPLES = [
  "friendly tone",
] as const;

export const REWRITE_CASUAL_SEARCH_ALIASES = [
  "casual",
  "rewrite casual",
  ...changeToneAliases(["casual"]),
  ...makeAdjectiveAliases(["casual"]),
  ...soundAdjectiveAliases(["casual"]),
  ...soundMoreAdjectiveAliases(["casual"]),
  "sound casual",
] as const;

export const REWRITE_CASUAL_SPOKEN_COMMAND_EXAMPLES = [
  "casual tone",
] as const;

export const SELECTED_TEXT_TRANSFORM_SHORTCUTS = {
  [QUICK_FIX_ACTION_KEY]: "Ctrl Alt P",
  polish_text: "Ctrl Alt 1",
  prompt_engineer: "Ctrl Alt 2",
} as const satisfies Partial<Record<SelectedTextQuickActionKey, string>>;

export const SPOKEN_COMMANDS_LABEL = "Spoken commands";
export const SPOKEN_COMMAND_ACTIONS_LABEL = "Spoken command actions";
export const SPOKEN_COMMAND_PREFIX_LABEL = "Spoken command prefix";
export const RETURN_ONLY_CORRECTED_TEXT = "Return only the corrected text.";
export const RETURN_ONLY_REWRITTEN_TEXT = "Return only the rewritten text.";
export const RETURN_ONLY_EXPANDED_TEXT = "Return only the expanded text.";
export const RETURN_ONLY_SIMPLIFIED_TEXT = "Return only the simplified text.";
export const RETURN_ONLY_SUMMARY = "Return only the summary.";
export const RETURN_ONLY_EXPLANATION = "Return only the explanation.";
export const RETURN_ONLY_BULLET_LIST = "Return only the bullet list.";
export const RETURN_ONLY_NUMBERED_LIST = "Return only the numbered list.";
export const RETURN_ONLY_PROMPT = "Return only the prompt.";

type QuickFixToastResult = {
  targetScope?: string | null;
  pasted?: boolean;
  copied?: boolean;
  error?: string | null;
  inputText?: string | null;
  outputText?: string | null;
};

type SelectedTextActionStatusResult = QuickFixToastResult;

const QUICK_FIX_EXACT_EDIT_COUNT_TOKEN_LIMIT = 400;
const QUICK_FIX_CHANGE_PREVIEW_LIMIT = 3;
const QUICK_FIX_CHANGE_PREVIEW_TOKEN_LIMIT = 24;

function textChangeTokens(value: string): string[] {
  return value.trim().match(/[A-Za-z0-9']+|[^\sA-Za-z0-9]/g) ?? [];
}

export function estimateTextEditCount(
  inputText: string | null | undefined,
  outputText: string | null | undefined,
): number {
  const input = inputText?.trim() ?? "";
  const output = outputText?.trim() ?? "";
  if (!input || !output || input === output) {
    return 0;
  }

  const inputTokens = textChangeTokens(input);
  const outputTokens = textChangeTokens(output);
  if (inputTokens.length === 0 || outputTokens.length === 0) {
    return input === output ? 0 : 1;
  }

  const previousRow = Array.from(
    { length: outputTokens.length + 1 },
    (_, index) => index,
  );
  let lastRow = previousRow;

  for (let inputIndex = 1; inputIndex <= inputTokens.length; inputIndex += 1) {
    const currentRow = [inputIndex];
    for (
      let outputIndex = 1;
      outputIndex <= outputTokens.length;
      outputIndex += 1
    ) {
      const substitutionCost =
        inputTokens[inputIndex - 1] === outputTokens[outputIndex - 1] ? 0 : 1;
      currentRow[outputIndex] = Math.min(
        lastRow[outputIndex] + 1,
        currentRow[outputIndex - 1] + 1,
        lastRow[outputIndex - 1] + substitutionCost,
      );
    }
    lastRow = currentRow;
  }

  return lastRow[outputTokens.length];
}

function formatChangePreviewToken(token: string): string {
  if (token.length <= QUICK_FIX_CHANGE_PREVIEW_TOKEN_LIMIT) {
    return token;
  }
  return `${token.slice(0, QUICK_FIX_CHANGE_PREVIEW_TOKEN_LIMIT - 1)}...`;
}

function formatQuickFixChangedTokenPreview(
  inputTokens: string[],
  outputTokens: string[],
  editCount: number,
): string | null {
  if (
    editCount > QUICK_FIX_CHANGE_PREVIEW_LIMIT ||
    inputTokens.length !== outputTokens.length
  ) {
    return null;
  }

  const changedPairs = inputTokens.flatMap((inputToken, index) => {
    const outputToken = outputTokens[index];
    return inputToken === outputToken
      ? []
      : [
          `${formatChangePreviewToken(inputToken)} -> ${formatChangePreviewToken(
            outputToken,
          )}`,
        ];
  });

  return changedPairs.length === editCount && changedPairs.length > 0
    ? changedPairs.join(", ")
    : null;
}

function formatQuickFixChangeSummary(
  result: QuickFixToastResult,
): string | null {
  const input = result.inputText?.trim() ?? "";
  const output = result.outputText?.trim() ?? "";
  if (!input || !output || input === output) {
    return null;
  }

  const inputTokens = textChangeTokens(input);
  const outputTokens = textChangeTokens(output);
  if (
    inputTokens.length > QUICK_FIX_EXACT_EDIT_COUNT_TOKEN_LIMIT ||
    outputTokens.length > QUICK_FIX_EXACT_EDIT_COUNT_TOKEN_LIMIT
  ) {
    return "Text changed";
  }

  const editCount = estimateTextEditCount(input, output);
  if (editCount === 0) {
    return null;
  }
  const editLabel = `${editCount} text ${editCount === 1 ? "edit" : "edits"}`;
  const changedTokenPreview = formatQuickFixChangedTokenPreview(
    inputTokens,
    outputTokens,
    editCount,
  );
  return changedTokenPreview ? `${editLabel}: ${changedTokenPreview}` : editLabel;
}

function quickFixCheckedUnchanged(result: QuickFixToastResult): boolean {
  const input = result.inputText?.trim();
  const output = result.outputText?.trim();
  return Boolean(input && output && input === output);
}

function selectedTextTargetLabel(
  result: Pick<QuickFixToastResult, "targetScope">,
): string {
  return result.targetScope === "focused_field"
    ? "focused field"
    : "selected text";
}

function selectedTextFallbackDetail(result: QuickFixToastResult): string {
  const error = result.error?.trim();
  if (!error || result.pasted) {
    return "";
  }

  const targetLabel = selectedTextTargetLabel(result);
  if (result.copied) {
    return ` Could not replace ${targetLabel}; copied result instead.`;
  }

  return ` Could not replace ${targetLabel}.`;
}

export function formatQuickFixToastMessage(
  result: QuickFixToastResult,
): string {
  const changeSummary = formatQuickFixChangeSummary(result);
  const suffix = changeSummary ? ` ${changeSummary}.` : "";
  const fallbackDetail = selectedTextFallbackDetail(result);

  if (result.pasted) {
    const targetLabel = selectedTextTargetLabel(result);
    if (quickFixCheckedUnchanged(result)) {
      return `${QUICK_FIX_LABEL} checked ${targetLabel}. No text edits.`;
    }
    return `${QUICK_FIX_LABEL} applied to ${targetLabel}.${suffix}`;
  }

  if (result.copied) {
    if (quickFixCheckedUnchanged(result)) {
      return `${QUICK_FIX_LABEL} checked text. No text edits.`;
    }
    return `${QUICK_FIX_LABEL} text copied.${suffix}${fallbackDetail}`;
  }

  if (quickFixCheckedUnchanged(result)) {
    return `${QUICK_FIX_LABEL} checked text. No text edits.`;
  }

  return `${QUICK_FIX_LABEL} result is ready.${suffix}${fallbackDetail}`;
}

export function formatSelectedTextActionStatusMessage(
  action: SelectedTextQuickActionKey,
  result: SelectedTextActionStatusResult,
): string {
  if (action === QUICK_FIX_ACTION_KEY) {
    return formatQuickFixToastMessage(result);
  }

  const metadata = selectedTextActionMetadata(action);
  const fallbackDetail = selectedTextFallbackDetail(result);
  if (result.pasted) {
    const targetLabel = selectedTextTargetLabel(result);
    return `${metadata.resultLabel} ${targetLabel}`;
  }

  if (result.copied) {
    return fallbackDetail
      ? `${metadata.resultLabel} text copied.${fallbackDetail}`
      : `${metadata.resultLabel} text copied`;
  }

  return fallbackDetail
    ? `${metadata.resultLabel} result is ready.${fallbackDetail}`
    : `${metadata.resultLabel} result is ready`;
}

export function selectedTextActionSearchAliases(
  action: Pick<
    SelectedTextActionMetadata,
    "searchAliases" | "spokenCommandExamples"
  >,
): string[] {
  return uniqueStrings([
    ...(action.searchAliases ?? []),
    ...(action.spokenCommandExamples ?? []),
  ]);
}

function caseTransformAction({
  action,
  label,
  resultLabel,
  spokenCommandExample,
  showInLatestResultShape,
}: {
  action: SelectedTextCaseTransformCommand;
  label: string;
  resultLabel: string;
  spokenCommandExample: string;
  showInLatestResultShape?: boolean;
}): SelectedTextActionMetadata {
  const normalizedLabel = label.toLowerCase();

  return {
    action,
    paletteLabel: `${label} Selected Text`,
    quickLabel: label,
    resultLabel,
    detail: `Convert the current selection to ${normalizedLabel}`,
    iconKey: "terminal",
    targetPolicy: "selection_required",
    commandAppliedLabel: `${capitalizeString(normalizedLabel)} selection`,
    showInLatestResultShape,
    searchAliases: [
      normalizedLabel,
      `${normalizedLabel} selection`,
      `make ${normalizedLabel}`,
      `make selection ${normalizedLabel}`,
      `make this ${normalizedLabel}`,
      `make that ${normalizedLabel}`,
    ].filter((alias) => alias !== spokenCommandExample),
    spokenCommandExamples: [spokenCommandExample],
  };
}

function toneRewriteAction({
  action,
  paletteLabel,
  quickLabel,
  resultLabel,
  detail,
  commandPresetLabel,
  commandAppliedLabel,
  commandPresetOrder,
  commandDefaultPrompt,
  searchAliases,
  spokenCommandExamples,
}: {
  action: SelectedTextToneRewriteCommand;
  paletteLabel: string;
  quickLabel: string;
  resultLabel: string;
  detail: string;
  commandPresetLabel: string;
  commandAppliedLabel: string;
  commandPresetOrder: number;
  commandDefaultPrompt: string;
  searchAliases: string[];
  spokenCommandExamples: string[];
}): SelectedTextActionMetadata {
  return {
    action,
    paletteLabel,
    quickLabel,
    resultLabel,
    detail,
    iconKey: "sparkles",
    targetPolicy: "selection_required",
    commandPresetKey: action,
    commandPresetLabel,
    commandAppliedLabel,
    commandPresetOrder,
    commandDefaultPrompt,
    searchAliases,
    spokenCommandExamples,
  };
}

function toneLabelAliases(tones: readonly string[]): string[] {
  return tones.map((tone) => `${tone} tone`);
}

function changeToneAliases(tones: readonly string[]): string[] {
  return tones.flatMap((tone) => [
    `change tone to ${tone}`,
    `change this tone to ${tone}`,
  ]);
}

function makeAdjectiveAliases(adjectives: readonly string[]): string[] {
  return adjectives.flatMap((adjective) => [
    `make ${adjective}`,
    `make this ${adjective}`,
    `make it ${adjective}`,
  ]);
}

function soundAdjectiveAliases(adjectives: readonly string[]): string[] {
  return adjectives.flatMap((adjective) => [
    `make this sound ${adjective}`,
    `make it sound ${adjective}`,
  ]);
}

function soundMoreAdjectiveAliases(adjectives: readonly string[]): string[] {
  return adjectives.flatMap((adjective) => [
    `make this sound more ${adjective}`,
    `make it sound more ${adjective}`,
  ]);
}

function rewriteInToneAliases(tones: readonly string[]): string[] {
  return tones.map((tone) => `rewrite in a ${tone} tone`);
}

function hasCommandPreset(
  action: SelectedTextActionMetadata,
): action is SelectedTextActionMetadata &
  SelectedTextActionCommandPresetMetadata {
  return Boolean(action.commandPresetKey);
}

function hasCaptureAction(
  action: SelectedTextActionMetadata,
): action is SelectedTextActionWithCaptureAction {
  return Boolean(action.captureAction);
}

function assertNonBlankSelectedTextField(
  action: SelectedTextQuickActionKey,
  field: string,
  value: string | undefined,
): void {
  if (!value?.trim()) {
    throw new Error(`Missing selected-text ${field}: ${action}`);
  }
}

function assertPositiveIntegerSelectedTextField(
  action: SelectedTextQuickActionKey,
  field: string,
  value: number,
): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid selected-text ${field}: ${action}`);
  }
}

function assertContiguousSelectedTextOrder(
  scope: string,
  values: readonly number[],
): void {
  const sorted = [...values].sort((left, right) => left - right);
  sorted.forEach((value, index) => {
    const expected = index + 1;
    if (value !== expected) {
      throw new Error(`Invalid ${scope}: expected ${expected}, found ${value}`);
    }
  });
}

function assertUniqueContiguousSelectedTextOrder(
  scope: string,
  values: readonly number[],
): void {
  assertUniqueStrings(scope, values.map(String));
  assertContiguousSelectedTextOrder(scope, values);
}

function orderedSelectedTextActions<Action extends SelectedTextActionMetadata>(
  actions: readonly SelectedTextActionMetadata[],
  predicate: (action: SelectedTextActionMetadata) => action is Action,
  order: (action: Action) => number,
): Action[] {
  return actions
    .filter(predicate)
    .sort((left, right) => order(left) - order(right));
}

function validateSelectedTextActionMetadata(
  action: SelectedTextActionMetadata,
): void {
  for (const [field, value] of Object.entries({
    paletteLabel: action.paletteLabel,
    quickLabel: action.quickLabel,
    resultLabel: action.resultLabel,
    detail: action.detail,
    commandAppliedLabel: action.commandAppliedLabel,
    busyLabel: action.busyLabel,
    shortcut: action.shortcut,
  })) {
    if (value !== undefined) {
      assertNonBlankSelectedTextField(action.action, field, value);
    }
  }

  if (hasCommandPreset(action)) {
    assertNonBlankSelectedTextField(
      action.action,
      "commandPresetLabel",
      action.commandPresetLabel,
    );
    assertNonBlankSelectedTextField(
      action.action,
      "commandDefaultPrompt",
      action.commandDefaultPrompt,
    );
    assertPositiveIntegerSelectedTextField(
      action.action,
      "commandPresetOrder",
      action.commandPresetOrder,
    );
  }

  if (action.captureAction) {
    assertPositiveIntegerSelectedTextField(
      action.action,
      "captureAction.order",
      action.captureAction.order,
    );
  }
}

export const SELECTED_TEXT_ACTIONS: SelectedTextActionMetadata[] = [
  {
    action: QUICK_FIX_ACTION_KEY,
    paletteLabel: QUICK_FIX_COMMAND_LABEL,
    quickLabel: QUICK_FIX_LABEL,
    busyLabel: QUICK_FIX_BUSY_LABEL,
    resultLabel: QUICK_FIX_RESULT_LABEL,
    detail: "Fix spelling, grammar, punctuation, and capitalization in place",
    iconKey: "check",
    targetPolicy: "prefer_selection",
    commandPresetKey: QUICK_FIX_COMMAND_PRESET_KEY,
    commandPresetLabel: QUICK_FIX_COMMAND_LABEL,
    commandAppliedLabel: QUICK_FIX_LABEL,
    commandPresetOrder: 12,
    commandDefaultPrompt: `Proofread the user's text. Correct spelling, grammar, punctuation, and capitalization while preserving meaning, tone, structure, and wording as much as possible. ${RETURN_ONLY_CORRECTED_TEXT}`,
    searchAliases: [...QUICK_FIX_SEARCH_ALIASES],
    spokenCommandExamples: [...QUICK_FIX_SPOKEN_COMMAND_EXAMPLES],
    showInLatestResultShape: true,
    captureAction: {
      order: 1,
      variant: "default",
    },
    shortcut: SELECTED_TEXT_TRANSFORM_SHORTCUTS[QUICK_FIX_ACTION_KEY],
  },
  {
    action: "rewrite_shorter",
    paletteLabel: "Shorten Selected Text",
    quickLabel: "Shorten",
    resultLabel: "Shortened",
    detail: "Condense the current selection without changing its point",
    iconKey: "zap",
    targetPolicy: "selection_required",
    commandPresetKey: "rewrite_shorter",
    commandPresetLabel: "Rewrite Shorter",
    commandAppliedLabel: "Rewrite shorter",
    commandPresetOrder: 1,
    commandDefaultPrompt: `Rewrite the user's text to be shorter while preserving intent. Keep the same language and tone. ${RETURN_ONLY_REWRITTEN_TEXT}`,
    searchAliases: [...REWRITE_SHORTER_SEARCH_ALIASES],
    spokenCommandExamples: ["make concise"],
    captureAction: {
      order: 3,
      variant: "outline",
    },
  },
  {
    action: "expand_text",
    paletteLabel: "Expand Selected Text",
    quickLabel: "Expand",
    resultLabel: "Expanded",
    detail: "Add useful context and detail without changing intent",
    iconKey: "file_text",
    targetPolicy: "selection_required",
    commandPresetKey: "expand_text",
    commandPresetLabel: "Expand Text",
    commandAppliedLabel: "Expand",
    commandPresetOrder: 2,
    commandDefaultPrompt: `Expand the user's text with useful context, clearer connective tissue, and concrete detail while preserving intent and avoiding unsupported assumptions. ${RETURN_ONLY_EXPANDED_TEXT}`,
    searchAliases: [...EXPAND_TEXT_SEARCH_ALIASES],
    spokenCommandExamples: ["make longer"],
  },
  {
    action: "continue_writing",
    paletteLabel: "Continue Writing Selected Text",
    quickLabel: "Continue Writing",
    resultLabel: "Continued",
    detail:
      "Continue from the current selection while preserving style and direction",
    iconKey: "file_text",
    targetPolicy: "selection_required",
    commandPresetKey: "continue_writing",
    commandPresetLabel: "Continue Writing",
    commandAppliedLabel: "Continue Writing",
    commandPresetOrder: 3,
    commandDefaultPrompt:
      "Continue the user's text with the next useful sentence or paragraph while preserving style, facts, and direction. Do not repeat the original text unless needed for continuity. Return only the continued text.",
    searchAliases: [...CONTINUE_WRITING_SEARCH_ALIASES],
    spokenCommandExamples: ["continue writing"],
  },
  {
    action: "simplify_language",
    paletteLabel: "Simplify Language Selected Text",
    quickLabel: "Simplify",
    resultLabel: "Simplified",
    detail: "Rewrite the selection in clearer, simpler language",
    iconKey: "search",
    targetPolicy: "selection_required",
    commandPresetKey: "simplify_language",
    commandPresetLabel: "Simplify Language",
    commandAppliedLabel: "Simplify",
    commandPresetOrder: 4,
    commandDefaultPrompt: `Rewrite the user's text in clear, plain language while preserving meaning, facts, and important nuance. Prefer shorter sentences and familiar words. ${RETURN_ONLY_SIMPLIFIED_TEXT}`,
    searchAliases: [...SIMPLIFY_LANGUAGE_SEARCH_ALIASES],
    spokenCommandExamples: ["simplify language"],
  },
  toneRewriteAction({
    action: "rewrite_professional",
    paletteLabel: "Professionalize Selected Text",
    quickLabel: "Professionalize",
    resultLabel: "Professionalized",
    detail: "Rewrite the current selection in a polished work tone",
    commandPresetLabel: "Rewrite Professional",
    commandAppliedLabel: "Rewrite professional",
    commandPresetOrder: 5,
    commandDefaultPrompt: `Rewrite the user's text in a professional tone while preserving meaning. Keep it clear and concise. ${RETURN_ONLY_REWRITTEN_TEXT}`,
    searchAliases: [...REWRITE_PROFESSIONAL_SEARCH_ALIASES],
    spokenCommandExamples: [...REWRITE_PROFESSIONAL_SPOKEN_COMMAND_EXAMPLES],
  }),
  toneRewriteAction({
    action: "rewrite_friendly",
    paletteLabel: "Friendly Tone Selected Text",
    quickLabel: "Friendly Tone",
    resultLabel: "Rewritten friendly",
    detail: "Warm up the current selection while preserving meaning",
    commandPresetLabel: "Friendly Tone",
    commandAppliedLabel: "Friendly Tone",
    commandPresetOrder: 6,
    commandDefaultPrompt: `Rewrite the user's text in a friendly, warm tone while preserving meaning and avoiding extra enthusiasm. Keep it clear and concise. ${RETURN_ONLY_REWRITTEN_TEXT}`,
    searchAliases: [...REWRITE_FRIENDLY_SEARCH_ALIASES],
    spokenCommandExamples: [...REWRITE_FRIENDLY_SPOKEN_COMMAND_EXAMPLES],
  }),
  toneRewriteAction({
    action: "rewrite_casual",
    paletteLabel: "Casual Tone Selected Text",
    quickLabel: "Casual Tone",
    resultLabel: "Rewritten casual",
    detail: "Relax the current selection into a more conversational tone",
    commandPresetLabel: "Casual Tone",
    commandAppliedLabel: "Casual Tone",
    commandPresetOrder: 7,
    commandDefaultPrompt: `Rewrite the user's text in a casual, conversational tone while preserving meaning and avoiding slang, filler, or extra enthusiasm. ${RETURN_ONLY_REWRITTEN_TEXT}`,
    searchAliases: [...REWRITE_CASUAL_SEARCH_ALIASES],
    spokenCommandExamples: [...REWRITE_CASUAL_SPOKEN_COMMAND_EXAMPLES],
  }),
  {
    action: "summarize_text",
    paletteLabel: "Summarize Selected Text",
    quickLabel: "Summarize",
    resultLabel: "Summarized",
    detail: "Turn the current selection into a concise summary",
    iconKey: "file_text",
    targetPolicy: "selection_required",
    commandPresetKey: "summarize_text",
    commandPresetLabel: "Summarize Text",
    commandAppliedLabel: "Summarize",
    commandPresetOrder: 8,
    commandDefaultPrompt: `Summarize the user's text into the shortest useful summary while preserving key decisions, facts, and action items. ${RETURN_ONLY_SUMMARY}`,
    searchAliases: [...SUMMARIZE_TEXT_SEARCH_ALIASES],
    spokenCommandExamples: ["summarize"],
  },
  {
    action: "translate_english",
    paletteLabel: "Translate Selected Text to English",
    quickLabel: "Translate",
    resultLabel: "Translated to English",
    detail: "Translate the current selection to clear English",
    iconKey: "languages",
    targetPolicy: "selection_required",
    commandPresetKey: "translate_english",
    commandPresetLabel: "Translate to English",
    commandAppliedLabel: "Translate to English",
    commandPresetOrder: 9,
    commandDefaultPrompt:
      "Translate the user's text into clear, natural English while preserving names, product terms, code, URLs, and formatting. Return only the translated English text.",
    searchAliases: [...TRANSLATE_ENGLISH_SEARCH_ALIASES],
    spokenCommandExamples: ["translate to English"],
  },
  {
    action: "explain_text",
    paletteLabel: "Explain Selected Text",
    quickLabel: "Explain",
    resultLabel: "Explained",
    detail: "Explain the current selection in plain language",
    iconKey: "search",
    targetPolicy: "selection_required",
    commandPresetKey: "explain_text",
    commandPresetLabel: "Explain Text",
    commandAppliedLabel: "Explain",
    commandPresetOrder: 10,
    commandDefaultPrompt: `Explain the user's text in plain language for a competent reader who lacks the original context. Preserve important details. ${RETURN_ONLY_EXPLANATION}`,
    searchAliases: [...EXPLAIN_TEXT_SEARCH_ALIASES],
    spokenCommandExamples: ["explain selection"],
  },
  {
    action: "find_bugs",
    paletteLabel: "Find Bugs in Selected Text",
    quickLabel: "Find Bugs",
    resultLabel: "Reviewed for bugs",
    detail: "Review selected code or instructions for concrete bugs and risks",
    iconKey: "bug",
    targetPolicy: "selection_required",
    commandPresetKey: "find_bugs",
    commandPresetLabel: "Find Bugs",
    commandAppliedLabel: "Find Bugs",
    commandPresetOrder: 11,
    commandDefaultPrompt:
      "Review the user's selected code, instructions, or plan for concrete bugs, contradictions, edge cases, and missing checks. Return only concise findings. If no bugs are found, say No concrete bugs found.",
    searchAliases: [...FIND_BUGS_SEARCH_ALIASES],
    spokenCommandExamples: ["find bugs"],
  },
  {
    action: "bulletize_selection",
    paletteLabel: "Bulletize Selected Text",
    quickLabel: "Bulletize",
    resultLabel: "Bulletized",
    detail: "Turn the current selection into concise bullets",
    iconKey: "list",
    targetPolicy: "selection_required",
    commandPresetKey: "bulletize_selection",
    commandPresetLabel: "Bulletize Selection",
    commandAppliedLabel: "Bulletize selection",
    commandPresetOrder: 13,
    commandDefaultPrompt: `Convert the user's text into concise bullet points. Use one bullet per idea. ${RETURN_ONLY_BULLET_LIST}`,
    searchAliases: [...BULLETIZE_SELECTION_SEARCH_ALIASES],
    spokenCommandExamples: ["bulletize"],
    captureAction: {
      order: 4,
      variant: "outline",
    },
  },
  {
    action: "numbered_list_selection",
    paletteLabel: "Numbered List Selected Text",
    quickLabel: "Numbered List",
    resultLabel: "Numbered",
    detail: "Turn the current selection into ordered steps",
    iconKey: "list",
    targetPolicy: "selection_required",
    commandPresetKey: "numbered_list_selection",
    commandPresetLabel: "Numbered List",
    commandAppliedLabel: "Numbered List",
    commandPresetOrder: 14,
    commandDefaultPrompt: `Convert the user's text into a concise numbered list. Use one numbered item per step, idea, or decision. ${RETURN_ONLY_NUMBERED_LIST}`,
    searchAliases: [...NUMBERED_LIST_SELECTION_SEARCH_ALIASES],
    spokenCommandExamples: ["numbered list"],
  },
  {
    action: "polish_text",
    paletteLabel: "Polish Selected Text",
    quickLabel: "Polish",
    resultLabel: "Improved",
    detail: "Clean up clarity, flow, and concision without changing intent",
    iconKey: "sparkles",
    targetPolicy: "selection_required",
    commandPresetKey: "polish_text",
    commandPresetLabel: "Polish",
    commandAppliedLabel: "Polish",
    commandPresetOrder: 15,
    commandDefaultPrompt:
      "Improve the user's writing for clarity, flow, and concision while preserving meaning, voice, and important details. Return only the improved text.",
    searchAliases: [...POLISH_LEGACY_IMPROVE_SEARCH_ALIASES],
    spokenCommandExamples: [...POLISH_PRIMARY_SPOKEN_COMMAND_EXAMPLES],
    showInLatestResultShape: true,
    captureAction: {
      order: 2,
      variant: "outline",
    },
    shortcut: SELECTED_TEXT_TRANSFORM_SHORTCUTS.polish_text,
  },
  {
    action: "prompt_engineer",
    paletteLabel: "Prompt Engineer Selected Text",
    quickLabel: "Prompt Engineer",
    resultLabel: "Rewritten as prompt",
    detail: "Turn the selection into a structured AI prompt",
    iconKey: "brain",
    targetPolicy: "selection_required",
    commandPresetKey: "prompt_engineer",
    commandPresetLabel: "Prompt Engineer",
    commandAppliedLabel: "Prompt Engineer",
    commandPresetOrder: 16,
    commandDefaultPrompt: `Rewrite the user's text as a clear, well-structured AI prompt. Include objective, context, constraints, output format, and success criteria when they are implied. ${RETURN_ONLY_PROMPT}`,
    searchAliases: [...PROMPT_ENGINEER_SEARCH_ALIASES],
    spokenCommandExamples: ["prompt engineer"],
    showInLatestResultShape: true,
    shortcut: SELECTED_TEXT_TRANSFORM_SHORTCUTS.prompt_engineer,
  },
  caseTransformAction({
    action: "uppercase_selection",
    label: "Uppercase",
    resultLabel: "Uppercased",
    spokenCommandExample: "make this uppercase",
  }),
  caseTransformAction({
    action: "lowercase_selection",
    label: "Lowercase",
    resultLabel: "Lowercased",
    spokenCommandExample: "make this lowercase",
  }),
  caseTransformAction({
    action: "title_case_selection",
    label: "Title Case",
    resultLabel: "Title cased",
    spokenCommandExample: "make selection title case",
  }),
  caseTransformAction({
    action: "sentence_case_selection",
    label: "Sentence Case",
    resultLabel: "Sentence cased",
    spokenCommandExample: "make selection sentence case",
  }),
];

function buildSelectedTextActionIndexes(
  actions: readonly SelectedTextActionMetadata[],
): {
  byAction: ReadonlyMap<SelectedTextQuickActionKey, SelectedTextActionMetadata>;
  byCommandPreset: ReadonlyMap<
    SelectedTextActionCommandPresetKey,
    SelectedTextActionMetadata & SelectedTextActionCommandPresetMetadata
  >;
} {
  const commandPresetOrders = actions.flatMap((action) =>
    hasCommandPreset(action) ? [action.commandPresetOrder] : [],
  );
  const captureActionOrders = actions.flatMap((action) =>
    hasCaptureAction(action) ? [action.captureAction.order] : [],
  );

  assertUniqueStrings(
    "selected-text action keys",
    actions.map((action) => action.action),
  );
  assertUniqueStrings(
    "selected-text command preset keys",
    actions.flatMap((action) =>
      hasCommandPreset(action) ? [action.commandPresetKey] : [],
    ),
  );
  assertUniqueNormalizedStrings(
    "selected-text palette labels",
    actions.map((action) => action.paletteLabel),
  );
  assertUniqueNormalizedStrings(
    "selected-text command applied labels",
    actions.map((action) => action.commandAppliedLabel),
  );
  assertUniqueContiguousSelectedTextOrder(
    "selected-text command preset orders",
    commandPresetOrders,
  );
  assertUniqueContiguousSelectedTextOrder(
    "selected-text capture action orders",
    captureActionOrders,
  );

  const byAction = new Map<
    SelectedTextQuickActionKey,
    SelectedTextActionMetadata
  >();
  const byCommandPreset = new Map<
    SelectedTextActionCommandPresetKey,
    SelectedTextActionMetadata & SelectedTextActionCommandPresetMetadata
  >();

  for (const action of actions) {
    validateSelectedTextActionMetadata(action);
    assertUniqueStrings(
      `selected-text search aliases for ${action.action}`,
      action.searchAliases ?? [],
    );
    assertUniqueNormalizedStrings(
      `selected-text search aliases for ${action.action}`,
      action.searchAliases ?? [],
    );
    assertUniqueStrings(
      `selected-text spoken examples for ${action.action}`,
      action.spokenCommandExamples ?? [],
    );
    assertUniqueNormalizedStrings(
      `selected-text spoken examples for ${action.action}`,
      action.spokenCommandExamples ?? [],
    );
    combineNormalizedUniqueStringGroups(
      `selected-text aliases for ${action.action}`,
      [
        { label: "search aliases", values: action.searchAliases ?? [] },
        {
          label: "spoken command examples",
          values: action.spokenCommandExamples ?? [],
        },
      ],
    );

    byAction.set(action.action, action);
    if (hasCommandPreset(action)) {
      byCommandPreset.set(action.commandPresetKey, action);
    }
  }

  return { byAction, byCommandPreset };
}

const SELECTED_TEXT_ACTION_INDEXES = buildSelectedTextActionIndexes(
  SELECTED_TEXT_ACTIONS,
);

export const SELECTED_TEXT_ACTION_SEARCH_ALIASES =
  combineNormalizedUniqueStringGroups(
    "selected-text action aliases",
    SELECTED_TEXT_ACTIONS.map((action) => ({
      label: action.action,
      values: selectedTextActionSearchAliases(action),
    })),
  );

export function selectedTextActionMetadata(
  action: SelectedTextQuickActionKey,
): SelectedTextActionMetadata {
  const metadata = SELECTED_TEXT_ACTION_INDEXES.byAction.get(action);
  if (!metadata) {
    throw new Error(`Unknown selected-text action: ${action}`);
  }
  return metadata;
}

export function selectedTextActionTransformCommand(
  action: SelectedTextQuickActionKey,
): SelectedTextTransformCommand {
  const metadata = selectedTextActionMetadata(action);
  return (metadata.commandPresetKey ?? action) as SelectedTextTransformCommand;
}

export const SELECTED_TEXT_CAPTURE_ACTION_METADATA: SelectedTextCaptureActionMetadata[] =
  orderedSelectedTextActions(
    SELECTED_TEXT_ACTIONS,
    hasCaptureAction,
    (action) => action.captureAction.order,
  ).map((metadata) => ({
    action: metadata.action,
    variant: metadata.captureAction.variant,
    metadata,
  }));

export const SELECTED_TEXT_CAPTURE_ACTIONS: SelectedTextCaptureAction[] =
  SELECTED_TEXT_CAPTURE_ACTION_METADATA.map(({ action, variant }) => ({
    action,
    variant,
  }));

export const SELECTED_TEXT_COMMAND_PRESET_ACTIONS = orderedSelectedTextActions(
  SELECTED_TEXT_ACTIONS,
  hasCommandPreset,
  (action) => action.commandPresetOrder,
);

export const SELECTED_TEXT_COMMAND_PRESET_KEYS =
  SELECTED_TEXT_COMMAND_PRESET_ACTIONS.map((action) => action.commandPresetKey);

function formatSpokenCommandExample(
  example: string,
  prefix = "command",
): string {
  return `"${normalizeDictationCommandPrefix(prefix)} ${example}"`;
}

export const SPOKEN_COMMAND_ACTION_EXAMPLES =
  SELECTED_TEXT_COMMAND_PRESET_ACTIONS.map(
    (action) => action.spokenCommandExamples?.[0] ?? action.quickLabel,
  );

export const SPOKEN_COMMAND_ACTION_EXAMPLE_LIST = formatStringList(
  SPOKEN_COMMAND_ACTION_EXAMPLES,
);

const SPOKEN_TEXT_CONTEXT_COMMAND_EXAMPLE_PHRASES =
  SELECTED_TEXT_ACTIONS.flatMap((action) => action.spokenCommandExamples ?? []);

export const SPOKEN_TEXT_CONTEXT_COMMAND_EXAMPLES =
  SPOKEN_TEXT_CONTEXT_COMMAND_EXAMPLE_PHRASES.map((example) =>
    formatSpokenCommandExample(example),
  );

export function getSpokenTextContextCommandExamples(prefix: string): string[] {
  return SPOKEN_TEXT_CONTEXT_COMMAND_EXAMPLE_PHRASES.map((example) =>
    formatSpokenCommandExample(example, prefix),
  );
}

export function getDictationTextContextDescription(prefix: string): string {
  const normalizedPrefix = normalizeDictationCommandPrefix(prefix);
  const contextExamples = formatStringList(
    getSpokenTextContextCommandExamples(normalizedPrefix),
  );
  const editExamples = formatStringList(
    getDictationSpokenEditCommandExamples(normalizedPrefix),
  );

  return `Voice commands transform existing text. Try ${contextExamples}. Editing commands also support phrases like ${editExamples}. Application context captures the frontmost app, window title, and selected text when available.`;
}

export const DICTATION_TEXT_ACTIONS = {
  familyLabel: SPOKEN_COMMAND_ACTIONS_LABEL,
  commandModeLabel: SPOKEN_COMMANDS_LABEL,
  commandModeOnLabel: `${SPOKEN_COMMANDS_LABEL} on`,
  commandModeOffLabel: `${SPOKEN_COMMANDS_LABEL} off`,
  commandModeEnabledLabel: `Enable ${SPOKEN_COMMANDS_LABEL.toLowerCase()}`,
  commandPrefixLabel: SPOKEN_COMMAND_PREFIX_LABEL,
  coachTitle: "Use spoken command actions, not just voice typing",
  coachBody: `${SPOKEN_COMMANDS_LABEL} turn dictated phrases into actions like ${SPOKEN_COMMAND_ACTION_EXAMPLE_LIST} on selected text.`,
  settingsDescription: `Enable voice-editing phrases like "command undo that" and selected-text actions like ${SPOKEN_COMMAND_ACTION_EXAMPLE_LIST}.`,
  prefixDescription:
    "Say this before voice-editing commands when spoken commands are enabled.",
  availableLabel: `${SPOKEN_COMMAND_ACTIONS_LABEL} available`,
  presetEditorDescription: `Customize ${SPOKEN_COMMAND_ACTION_EXAMPLE_LIST} actions that run after dictation.`,
  prefixExamples: `Great for ${SPOKEN_COMMAND_ACTION_EXAMPLE_LIST} flows.`,
  developerCommandSuffix: ` for ${SPOKEN_COMMAND_ACTION_EXAMPLE_LIST} on selected text.`,
  textContextDescription: getDictationTextContextDescription("command"),
} as const;

export const SELECTED_TEXT_LATEST_RESULT_SHAPE_ACTIONS =
  SELECTED_TEXT_ACTIONS.filter((action) => action.showInLatestResultShape);

export function selectedTextActionMetadataForCommandPreset(
  commandPresetKey: SelectedTextActionCommandPresetKey,
): SelectedTextActionMetadata & SelectedTextActionCommandPresetMetadata {
  const metadata =
    SELECTED_TEXT_ACTION_INDEXES.byCommandPreset.get(commandPresetKey);
  if (!metadata) {
    throw new Error(
      `Unknown selected-text command preset: ${commandPresetKey}`,
    );
  }
  return metadata;
}
