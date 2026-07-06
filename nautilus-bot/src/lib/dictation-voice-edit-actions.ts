import { assertUniqueNormalizedStrings } from "@/lib/string-registry";

const DICTATION_BACKTRACK_WORD_TARGET = "word" as const;

const DICTATION_BACKTRACK_NON_WORD_TEXT_UNIT_TARGETS = [
  "clause",
  "phrase",
  "sentence",
  "line",
  "paragraph",
] as const;

const DICTATION_BACKTRACK_COUNTED_WORD_DELETE_TARGETS = [
  {
    count: "two",
    phrases: [
      "scratch last",
      "scratch the last",
      "scratch previous",
      "scratch the previous",
      "delete last",
      "delete previous",
      "remove last",
      "remove previous",
      "undo last",
      "undo previous",
    ],
  },
  {
    count: "couple",
    phrases: ["scratch last", "delete last", "undo previous"],
  },
  {
    count: "few",
    phrases: ["scratch last", "delete last", "undo previous"],
  },
] as const;

const DICTATION_BACKTRACK_GRANULAR_DELETE_TARGETS = [
  DICTATION_BACKTRACK_WORD_TARGET,
  ...DICTATION_BACKTRACK_NON_WORD_TEXT_UNIT_TARGETS,
] as const;

type DictationBacktrackGranularDeleteTarget =
  (typeof DICTATION_BACKTRACK_GRANULAR_DELETE_TARGETS)[number];

const DICTATION_BACKTRACK_RECENT_TEXT_REFERENCE_PREFIXES = [
  "scratch last",
  "scratch the last",
  "scratch previous",
  "scratch the previous",
] as const;

const DICTATION_BACKTRACK_UNDO_RECENT_TEXT_REFERENCE_PREFIXES = [
  "undo last",
  "undo previous",
] as const;

const DICTATION_DELETE_LAST_SEARCH_PREFIXES = [
  "delete last",
  "delete previous",
  "remove last",
  "remove previous",
  ...DICTATION_BACKTRACK_RECENT_TEXT_REFERENCE_PREFIXES,
  ...DICTATION_BACKTRACK_UNDO_RECENT_TEXT_REFERENCE_PREFIXES,
] as const;

const DICTATION_BACKTRACK_UNDO_PHRASES = [
  "undo last insert",
  "undo that",
  "undo it",
  "scratch that",
  "scratch it",
  "scratch all that",
  "strike that",
  "strike it",
  "cancel that",
  "cancel it",
  "cancel all that",
  "take that back",
  "take it back",
  "take all that back",
  "never mind",
  "nevermind",
  "forget that",
  "forget it",
  "disregard that",
  "disregard it",
] as const;

const DICTATION_BACKTRACK_COUNTED_WORD_DELETE_PHRASES =
  DICTATION_BACKTRACK_COUNTED_WORD_DELETE_TARGETS.flatMap(({ count, phrases }) =>
    phrases.map((phrase) => `${phrase} ${count} words`),
  );

const DICTATION_TRAILING_PRESS_ENTER_PHRASES = [
  "press enter",
  "press return",
  "hit enter",
  "hit return",
] as const;

export const DICTATION_PRIMARY_PRESS_ENTER_COMMAND =
  DICTATION_TRAILING_PRESS_ENTER_PHRASES[0];

const DICTATION_COMMAND_MODE_PRESS_ENTER_PHRASES = [
  ...DICTATION_TRAILING_PRESS_ENTER_PHRASES,
  "send",
  "submit",
] as const;

const DICTATION_INSERT_BREAK_SEARCH_ALIASES = [
  "newline",
  "new line",
  "next line",
  "line break",
  "insert newline",
  "insert line break",
  "paragraph",
  "new paragraph",
  "paragraph break",
  "skip a line",
  "insert paragraph",
  "start a new paragraph",
] as const;

const DICTATION_REPLACE_SELECTION_SEARCH_ALIASES = [
  "replace this",
  "replace this with",
  "replace selection",
  "replace selection with",
  "replace it with",
  "replace that with",
  "change selection",
  "change selection to",
  "change this to",
  "change it to",
  "change that to",
  "set selection to",
  "set this to",
  "make selection say",
  "make this say",
] as const;

const DICTATION_APPEND_PREPEND_SEARCH_ALIASES = [
  "append to selection",
  "append",
  "add to selection",
  "add after selection",
  "insert after selection",
  "prepend to selection",
  "prepend",
  "add before selection",
  "insert before selection",
] as const;

const DICTATION_DELETE_PHRASE_SEARCH_ALIASES = [
  "delete phrase",
  "remove phrase",
  "cut phrase",
  "delete word",
  "remove word",
] as const;

type DictationDeleteLastSearchPrefix =
  (typeof DICTATION_DELETE_LAST_SEARCH_PREFIXES)[number];

type GranularDeleteLastSearchAlias<Target extends string> =
  `${DictationDeleteLastSearchPrefix} ${Target}`;

function granularDeleteLastSearchAliases<
  const Target extends DictationBacktrackGranularDeleteTarget,
>(target: Target): GranularDeleteLastSearchAlias<Target>[] {
  return DICTATION_DELETE_LAST_SEARCH_PREFIXES.map(
    (prefix) => `${prefix} ${target}` as const,
  );
}

const DICTATION_DELETE_LAST_SEARCH_ALIASES =
  [
    ...DICTATION_BACKTRACK_GRANULAR_DELETE_TARGETS.flatMap(
      granularDeleteLastSearchAliases,
    ),
    ...DICTATION_BACKTRACK_COUNTED_WORD_DELETE_PHRASES,
  ] as const;

const DICTATION_DELETE_SELECTION_SEARCH_ALIASES = [
  "delete selection",
  "clear selection",
  "remove selection",
  "delete this",
  "delete that",
  "clear this",
  "clear that",
  "remove this",
  "remove that",
] as const;

const DICTATION_CASE_SELECTION_SEARCH_ALIASES = [
  "uppercase selection",
  "uppercase this",
  "make selection uppercase",
  "make this uppercase",
  "make that uppercase",
  "all caps selection",
  "all caps this",
  "lowercase selection",
  "lowercase this",
  "make selection lowercase",
  "make this lowercase",
  "make that lowercase",
  "title case selection",
  "title case this",
  "capitalize selection",
  "make selection title case",
  "make this title case",
  "make that title case",
  "capitalize this",
  "sentence case selection",
  "sentence case this",
  "make selection sentence case",
  "make this sentence case",
  "make that sentence case",
] as const;

const DICTATION_SPOKEN_EDIT_SEARCH_ALIASES = [
  ...DICTATION_INSERT_BREAK_SEARCH_ALIASES,
  ...DICTATION_COMMAND_MODE_PRESS_ENTER_PHRASES,
  ...DICTATION_BACKTRACK_UNDO_PHRASES,
  ...DICTATION_REPLACE_SELECTION_SEARCH_ALIASES,
  ...DICTATION_APPEND_PREPEND_SEARCH_ALIASES,
  ...DICTATION_DELETE_PHRASE_SEARCH_ALIASES,
  ...DICTATION_DELETE_LAST_SEARCH_ALIASES,
  ...DICTATION_DELETE_SELECTION_SEARCH_ALIASES,
  ...DICTATION_CASE_SELECTION_SEARCH_ALIASES,
] as const;

function validateDictationVoiceEditPhraseRegistry(): void {
  assertUniqueNormalizedStrings(
    "dictation spoken edit search aliases",
    DICTATION_SPOKEN_EDIT_SEARCH_ALIASES,
  );
}

validateDictationVoiceEditPhraseRegistry();

type DictationSpokenEditSearchAlias =
  (typeof DICTATION_SPOKEN_EDIT_SEARCH_ALIASES)[number];

function spokenEditCommandExample<const Phrase extends DictationSpokenEditSearchAlias>(
  phrase: Phrase,
): Phrase;
function spokenEditCommandExample<
  const Phrase extends DictationSpokenEditSearchAlias,
  const Payload extends string,
>(phrase: Phrase, payload: Payload): `${Phrase} ${Payload}`;
function spokenEditCommandExample(
  phrase: DictationSpokenEditSearchAlias,
  payload?: string,
): string {
  return payload ? `${phrase} ${payload}` : phrase;
}

export const DICTATION_SPOKEN_EDIT_COMMAND_EXAMPLES = [
  spokenEditCommandExample("new line"),
  spokenEditCommandExample("new paragraph"),
  spokenEditCommandExample(DICTATION_PRIMARY_PRESS_ENTER_COMMAND),
  spokenEditCommandExample("replace this with", "approved plan"),
  spokenEditCommandExample("make this say", "approved plan"),
  spokenEditCommandExample("append", "today"),
  spokenEditCommandExample("insert before selection", "please"),
  spokenEditCommandExample("delete phrase", "roadmap"),
  spokenEditCommandExample("delete word", "roadmap"),
  spokenEditCommandExample("scratch last word"),
  spokenEditCommandExample("scratch last two words"),
  spokenEditCommandExample("scratch last clause"),
  spokenEditCommandExample("scratch last phrase"),
  spokenEditCommandExample("scratch last sentence"),
  spokenEditCommandExample("scratch last line"),
  spokenEditCommandExample("scratch last paragraph"),
  spokenEditCommandExample("clear this"),
  spokenEditCommandExample("capitalize this"),
  spokenEditCommandExample("undo that"),
] as const;

export function normalizeDictationCommandPrefix(prefix: string): string {
  return prefix.trim() || "command";
}

function formatDictationSpokenCommandExample(
  prefix: string,
  phrase: string,
): string {
  return `${normalizeDictationCommandPrefix(prefix)} ${phrase}`;
}

export function getDictationSpokenEditCommandExamples(prefix: string): string[] {
  return DICTATION_SPOKEN_EDIT_COMMAND_EXAMPLES.map((phrase) =>
    formatDictationSpokenCommandExample(prefix, phrase),
  );
}
