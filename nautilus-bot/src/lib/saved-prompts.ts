/**
 * The reader's prompt library: the questions they keep asking, kept.
 *
 * Everything here is pure. The starter prompts are declared in this file and
 * the sidecar knows only their ids (`BUILTIN_SAVED_PROMPT_IDS` in
 * rust-sidecar/src/settings.rs) -- the same arrangement the built-in meeting
 * templates have. Settings stores exactly two things: prompts the reader
 * wrote, and *overrides* of starters they edited or hid. A starter that has
 * never been touched is not in settings at all, so it keeps getting the
 * wording this file ships.
 *
 * A saved prompt is an INSTRUCTION, not transcript text. It is typed by the
 * reader and handed to the grounded chat path in the same slot a hand-typed
 * question goes; the transcript stays fenced as data on the other side of
 * that boundary, in `llm/grounded.rs`. Nothing here reads or embeds meeting
 * content.
 */

import type { SavedPrompt, SavedPromptScope } from "@/types/settings";

export type { SavedPrompt, SavedPromptScope };

/** Mirrors `MAX_SAVED_PROMPTS` in rust-sidecar/src/settings.rs. */
export const MAX_SAVED_PROMPTS = 40;
/** Mirrors `MAX_SAVED_PROMPT_NAME_LEN`. */
export const MAX_SAVED_PROMPT_NAME_LENGTH = 80;
/** Mirrors `MAX_SAVED_PROMPT_TEXT_LEN`. */
export const MAX_SAVED_PROMPT_TEXT_LENGTH = 2000;

/**
 * The six starters.
 *
 * They are questions, not playbooks: each one has to make sense typed into a
 * chat box by someone who has just finished a meeting. "Draft a follow-up
 * message" and "Explain this like I missed the meeting" are scoped to a
 * single meeting because neither means anything asked of a whole library.
 */
export const BUILTIN_SAVED_PROMPTS: readonly SavedPrompt[] = [
  {
    id: "builtin_decisions",
    name: "Decisions made",
    prompt:
      "List the decisions that were actually made, one per line. For each, say who made it and what it commits us to. If something was discussed but not decided, leave it out.",
    scope: "both",
    builtIn: true,
  },
  {
    id: "builtin_open_questions",
    name: "Open questions",
    prompt:
      "List the questions that were raised and not answered. For each, say who raised it and what would settle it.",
    scope: "both",
    builtIn: true,
  },
  {
    id: "builtin_my_commitments",
    name: "What did I commit to",
    prompt:
      "List everything I said I would do, in my own words where possible, with any date or condition attached. Leave out things other people committed to.",
    scope: "both",
    builtIn: true,
  },
  {
    id: "builtin_risks_blockers",
    name: "Risks and blockers",
    prompt:
      "List the risks and blockers that came up. For each, say who raised it, what it blocks, and whether anyone took it on.",
    scope: "both",
    builtIn: true,
  },
  {
    id: "builtin_follow_up_message",
    name: "Draft a follow-up message",
    prompt:
      "Draft a short follow-up message to the other people in this meeting: what we agreed, what each person is doing next, and anything I owe them. Plain sentences, no headings.",
    scope: "meeting",
    builtIn: true,
  },
  {
    id: "builtin_catch_me_up",
    name: "Explain this like I missed the meeting",
    prompt:
      "Explain what happened in this meeting to someone who was not there: what it was about, what was settled, and what happens next.",
    scope: "meeting",
    builtIn: true,
  },
];

const BUILTIN_BY_ID = new Map(
  BUILTIN_SAVED_PROMPTS.map((prompt) => [prompt.id, prompt]),
);

export function isBuiltInSavedPromptId(id: string): boolean {
  return BUILTIN_BY_ID.has(id);
}

function normalizeScope(scope: unknown): SavedPromptScope {
  return scope === "meeting" || scope === "memory" ? scope : "both";
}

/**
 * The library as the picker and the manage dialog see it.
 *
 * Stored entries come first, in their stored order, so reordering is just the
 * array order. Any starter the reader has never touched is appended after
 * them in declaration order -- which is also why the manage dialog writes the
 * whole resolved list back when it reorders: once order is a decision, it has
 * to be stored, not re-derived.
 *
 * A stored entry with an unknown id that merely *looks* built-in is treated
 * as a plain user prompt; `builtIn` is recomputed here from the id, exactly
 * as the sidecar recomputes it, so the two sides cannot disagree.
 */
export function resolveSavedPrompts(
  stored: readonly SavedPrompt[] | null | undefined,
): SavedPrompt[] {
  const seen = new Set<string>();
  const resolved: SavedPrompt[] = [];

  for (const entry of stored ?? []) {
    const id = (entry?.id ?? "").trim();
    const name = (entry?.name ?? "").trim();
    const prompt = (entry?.prompt ?? "").trim();
    if (!id || !name || !prompt || seen.has(id)) continue;
    seen.add(id);
    resolved.push({
      id,
      name,
      prompt,
      scope: normalizeScope(entry.scope),
      builtIn: isBuiltInSavedPromptId(id),
      hidden: entry.hidden === true,
    });
  }

  for (const builtin of BUILTIN_SAVED_PROMPTS) {
    if (!seen.has(builtin.id)) {
      resolved.push({ ...builtin, hidden: false });
    }
  }

  return resolved;
}

/**
 * The prompts the picker offers on one surface.
 *
 * Hidden prompts are skipped, and `both` matches either surface. Filtering by
 * scope is the whole reason scope exists: offering "Draft a follow-up
 * message" against a library of 300 meetings would produce a confident answer
 * to a question nobody asked.
 */
export function savedPromptsForScope(
  prompts: readonly SavedPrompt[],
  scope: Exclude<SavedPromptScope, "both">,
): SavedPrompt[] {
  return prompts.filter(
    (prompt) =>
      prompt.hidden !== true &&
      (prompt.scope === "both" || prompt.scope === scope),
  );
}

/**
 * What the "/" in a chat input is asking for, if anything.
 *
 * The trigger is a leading "/" on an otherwise-unsent input, not a "/"
 * anywhere in the text: a slash mid-sentence ("the 50/50 split") is part of a
 * question, and popping a picker over it would be a surprise. Returns the
 * filter text after the slash, or `null` when the picker should stay closed.
 */
export function savedPromptQueryFor(value: string): string | null {
  if (!value.startsWith("/")) return null;
  const query = value.slice(1);
  // A newline means the reader has moved past the trigger line.
  if (query.includes("\n")) return null;
  return query;
}

/**
 * Filter the offered prompts by what has been typed after the "/".
 *
 * Case-insensitive substring over the name, then the prompt text. `cmdk` does
 * its own fuzzy scoring when the picker renders inside a `Command`; this
 * function exists so the *decision to show the picker at all* (and the tests
 * for it) does not depend on a third-party matcher.
 */
export function filterSavedPrompts(
  prompts: readonly SavedPrompt[],
  query: string,
): SavedPrompt[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...prompts];
  return prompts.filter(
    (prompt) =>
      prompt.name.toLowerCase().includes(needle) ||
      prompt.prompt.toLowerCase().includes(needle),
  );
}

/** A stable-enough id for a prompt the reader just created. */
export function newSavedPromptId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `prompt_${Date.now().toString(36)}_${random}`;
}

/**
 * A name for a prompt made from a message the reader already sent.
 *
 * The first line, collapsed and clipped. Not the whole question: the name is
 * a picker row, and a picker row that is a paragraph is not a row.
 */
const SAVED_PROMPT_NAME_FROM_TEXT_MAX = 48;

function savedPromptNameFromText(text: string): string {
  const firstLine = text.replace(/\s+/g, " ").trim();
  if (!firstLine) return "Saved prompt";
  return firstLine.length > SAVED_PROMPT_NAME_FROM_TEXT_MAX
    ? `${firstLine.slice(0, SAVED_PROMPT_NAME_FROM_TEXT_MAX).trimEnd()}…`
    : firstLine;
}

/**
 * A new prompt seeded from a sent message, ready for the editor dialog.
 *
 * Returns `null` for a message with nothing in it, and clips the body to the
 * same ceiling the sidecar enforces so the editor never opens holding text it
 * would silently lose on save.
 */
export function savedPromptFromMessage(
  text: string,
  scope: SavedPromptScope,
): SavedPrompt | null {
  const body = text.trim();
  if (!body) return null;
  return {
    id: newSavedPromptId(),
    name: savedPromptNameFromText(body).slice(0, MAX_SAVED_PROMPT_NAME_LENGTH),
    prompt: body.slice(0, MAX_SAVED_PROMPT_TEXT_LENGTH),
    scope: normalizeScope(scope),
    builtIn: false,
    hidden: false,
  };
}

/**
 * Apply one edit to the resolved library and return what to store.
 *
 * Storing the whole resolved list (starters included) rather than only the
 * changed entry is deliberate: it is what makes order a stored fact, and it
 * costs at most 40 short rows in settings.json. The sidecar re-sanitizes
 * whatever this produces, so this function is a convenience, not a boundary.
 */
export function upsertSavedPrompt(
  resolved: readonly SavedPrompt[],
  next: SavedPrompt,
): SavedPrompt[] {
  const index = resolved.findIndex((prompt) => prompt.id === next.id);
  const normalized: SavedPrompt = {
    ...next,
    name: next.name.trim().slice(0, MAX_SAVED_PROMPT_NAME_LENGTH),
    prompt: next.prompt.trim().slice(0, MAX_SAVED_PROMPT_TEXT_LENGTH),
    scope: normalizeScope(next.scope),
    builtIn: isBuiltInSavedPromptId(next.id),
  };
  if (index === -1) {
    return [...resolved, normalized].slice(0, MAX_SAVED_PROMPTS);
  }
  const copy = [...resolved];
  copy[index] = normalized;
  return copy;
}

/**
 * Remove a prompt, or hide it when it is a starter.
 *
 * Deleting a starter would mean nothing: this file would put it straight
 * back on the next render. Hiding is the honest version of the same wish, and
 * it is reversible from the manage dialog.
 */
export function removeOrHideSavedPrompt(
  resolved: readonly SavedPrompt[],
  id: string,
): SavedPrompt[] {
  if (isBuiltInSavedPromptId(id)) {
    return resolved.map((prompt) =>
      prompt.id === id ? { ...prompt, hidden: true } : prompt,
    );
  }
  return resolved.filter((prompt) => prompt.id !== id);
}

export function setSavedPromptHidden(
  resolved: readonly SavedPrompt[],
  id: string,
  hidden: boolean,
): SavedPrompt[] {
  return resolved.map((prompt) =>
    prompt.id === id ? { ...prompt, hidden } : prompt,
  );
}

/**
 * Move a prompt one place up or down.
 *
 * Index-based rather than drag-and-drop: a two-button reorder is reachable
 * from the keyboard, which a drag handle is not.
 */
export function moveSavedPrompt(
  resolved: readonly SavedPrompt[],
  id: string,
  direction: -1 | 1,
): SavedPrompt[] {
  const index = resolved.findIndex((prompt) => prompt.id === id);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= resolved.length) {
    return [...resolved];
  }
  const copy = [...resolved];
  [copy[index], copy[target]] = [copy[target], copy[index]];
  return copy;
}
