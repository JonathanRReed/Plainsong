import { describe, expect, it } from "vitest";
import {
  BUILTIN_SAVED_PROMPTS,
  MAX_SAVED_PROMPTS,
  MAX_SAVED_PROMPT_NAME_LENGTH,
  MAX_SAVED_PROMPT_TEXT_LENGTH,
  filterSavedPrompts,
  isBuiltInSavedPromptId,
  moveSavedPrompt,
  removeOrHideSavedPrompt,
  resolveSavedPrompts,
  savedPromptFromMessage,
  savedPromptQueryFor,
  savedPromptsForScope,
  setSavedPromptHidden,
  upsertSavedPrompt,
  type SavedPrompt,
} from "@/lib/saved-prompts";

function prompt(overrides: Partial<SavedPrompt> = {}): SavedPrompt {
  return {
    id: "p1",
    name: "Mine",
    prompt: "What happened?",
    scope: "both",
    ...overrides,
  };
}

describe("resolveSavedPrompts", () => {
  it("appends every untouched starter after the stored prompts", () => {
    const resolved = resolveSavedPrompts([prompt()]);
    expect(resolved[0].id).toBe("p1");
    expect(resolved.slice(1).map((entry) => entry.id)).toEqual(
      BUILTIN_SAVED_PROMPTS.map((entry) => entry.id),
    );
  });

  it("treats a stored entry with a built-in id as an override of that starter", () => {
    const builtinId = BUILTIN_SAVED_PROMPTS[0].id;
    const resolved = resolveSavedPrompts([
      { id: builtinId, name: "My wording", prompt: "Ask it my way", scope: "meeting" },
    ]);
    const overridden = resolved.filter((entry) => entry.id === builtinId);
    expect(overridden).toHaveLength(1);
    expect(overridden[0].name).toBe("My wording");
    expect(overridden[0].scope).toBe("meeting");
    expect(overridden[0].builtIn).toBe(true);
  });

  it("recomputes builtIn from the id rather than trusting the stored flag", () => {
    const resolved = resolveSavedPrompts([
      prompt({ id: "not-a-builtin", builtIn: true }),
    ]);
    expect(resolved[0].builtIn).toBe(false);
    expect(isBuiltInSavedPromptId("not-a-builtin")).toBe(false);
  });

  it("drops entries with no id, name or body, and duplicate ids", () => {
    const resolved = resolveSavedPrompts([
      prompt({ id: "  " }),
      prompt({ id: "a", name: "  " }),
      prompt({ id: "b", prompt: "   " }),
      prompt({ id: "c", name: "Keeper" }),
      prompt({ id: "c", name: "Loser" }),
    ]);
    const stored = resolved.filter((entry) => !entry.builtIn);
    expect(stored.map((entry) => entry.name)).toEqual(["Keeper"]);
  });

  it("normalizes an unknown scope to both", () => {
    const resolved = resolveSavedPrompts([
      prompt({ scope: "elsewhere" as SavedPrompt["scope"] }),
    ]);
    expect(resolved[0].scope).toBe("both");
  });
});

describe("savedPromptsForScope", () => {
  const library: SavedPrompt[] = [
    prompt({ id: "m", scope: "meeting" }),
    prompt({ id: "x", scope: "memory" }),
    prompt({ id: "b", scope: "both" }),
    prompt({ id: "h", scope: "both", hidden: true }),
  ];

  it("offers a meeting-scoped prompt and a both-scoped one in a meeting", () => {
    expect(savedPromptsForScope(library, "meeting").map((p) => p.id)).toEqual([
      "m",
      "b",
    ]);
  });

  it("offers a memory-scoped prompt and a both-scoped one across meetings", () => {
    expect(savedPromptsForScope(library, "memory").map((p) => p.id)).toEqual([
      "x",
      "b",
    ]);
  });

  it("never offers a hidden prompt", () => {
    expect(
      savedPromptsForScope(library, "meeting").some((p) => p.id === "h"),
    ).toBe(false);
  });
});

describe("savedPromptQueryFor", () => {
  it("opens on a leading slash and returns what follows it", () => {
    expect(savedPromptQueryFor("/")).toBe("");
    expect(savedPromptQueryFor("/dec")).toBe("dec");
  });

  it("stays closed for a slash that is part of a question", () => {
    expect(savedPromptQueryFor("what was the 50/50 split")).toBeNull();
    expect(savedPromptQueryFor("")).toBeNull();
  });

  it("closes once the reader has moved past the trigger line", () => {
    expect(savedPromptQueryFor("/dec\nand then")).toBeNull();
  });
});

describe("filterSavedPrompts", () => {
  const library = [
    prompt({ id: "a", name: "Decisions made", prompt: "What was decided?" }),
    prompt({ id: "b", name: "Open questions", prompt: "What is unresolved?" }),
  ];

  it("returns everything for an empty query", () => {
    expect(filterSavedPrompts(library, "")).toHaveLength(2);
  });

  it("matches the name case-insensitively", () => {
    expect(filterSavedPrompts(library, "DECIS").map((p) => p.id)).toEqual(["a"]);
  });

  it("also matches the prompt body", () => {
    expect(filterSavedPrompts(library, "unresolved").map((p) => p.id)).toEqual([
      "b",
    ]);
  });
});

describe("savedPromptFromMessage", () => {
  it("names a new prompt from the message and keeps the whole body", () => {
    const created = savedPromptFromMessage(
      "  Who owns the migration, and by when?  ",
      "meeting",
    );
    expect(created?.name).toBe("Who owns the migration, and by when?");
    expect(created?.prompt).toBe("Who owns the migration, and by when?");
    expect(created?.scope).toBe("meeting");
    expect(created?.builtIn).toBe(false);
  });

  it("clips a long name and a long body to the stored ceilings", () => {
    const created = savedPromptFromMessage("q".repeat(4000), "memory");
    expect(created?.name.length).toBeLessThanOrEqual(
      MAX_SAVED_PROMPT_NAME_LENGTH,
    );
    expect(created?.prompt.length).toBe(MAX_SAVED_PROMPT_TEXT_LENGTH);
  });

  it("refuses an empty message", () => {
    expect(savedPromptFromMessage("   ", "meeting")).toBeNull();
  });
});

describe("editing the library", () => {
  it("adds a new prompt and replaces an existing one in place", () => {
    const start = [prompt({ id: "a" }), prompt({ id: "b", name: "B" })];
    const added = upsertSavedPrompt(start, prompt({ id: "c", name: "C" }));
    expect(added.map((p) => p.id)).toEqual(["a", "b", "c"]);

    const edited = upsertSavedPrompt(added, prompt({ id: "b", name: "B2" }));
    expect(edited.map((p) => p.name)).toEqual(["Mine", "B2", "C"]);
  });

  it("refuses to grow past the stored cap", () => {
    const full = Array.from({ length: MAX_SAVED_PROMPTS }, (_unused, index) =>
      prompt({ id: `p${index}` }),
    );
    expect(upsertSavedPrompt(full, prompt({ id: "one-more" }))).toHaveLength(
      MAX_SAVED_PROMPTS,
    );
  });

  it("deletes a user prompt but only hides a built-in one", () => {
    const builtinId = BUILTIN_SAVED_PROMPTS[0].id;
    const library = [prompt({ id: "mine" }), prompt({ id: builtinId, builtIn: true })];

    expect(removeOrHideSavedPrompt(library, "mine").map((p) => p.id)).toEqual([
      builtinId,
    ]);

    const hidden = removeOrHideSavedPrompt(library, builtinId);
    expect(hidden).toHaveLength(2);
    expect(hidden.find((p) => p.id === builtinId)?.hidden).toBe(true);
  });

  it("un-hides a prompt the reader brings back", () => {
    const library = [prompt({ id: "a", hidden: true })];
    expect(setSavedPromptHidden(library, "a", false)[0].hidden).toBe(false);
  });

  it("moves a prompt one place and refuses to move past either end", () => {
    const library = [prompt({ id: "a" }), prompt({ id: "b" }), prompt({ id: "c" })];
    expect(moveSavedPrompt(library, "b", -1).map((p) => p.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(moveSavedPrompt(library, "a", -1).map((p) => p.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(moveSavedPrompt(library, "c", 1).map((p) => p.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
