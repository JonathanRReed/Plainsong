import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { SavedPromptManagerDialog } from "@/components/prompts/saved-prompt-manager-dialog";
import { SavedPromptPicker } from "@/components/prompts/saved-prompt-picker";
import { useSavedPrompts } from "@/hooks/use-saved-prompts";
import {
  filterSavedPrompts,
  savedPromptFromMessage,
  savedPromptQueryFor,
  savedPromptsForScope,
  type SavedPrompt,
  type SavedPromptScope,
} from "@/lib/saved-prompts";

interface UseSavedPromptChatOptions {
  /** Which chat this is; filters the library by scope. */
  scope: Exclude<SavedPromptScope, "both">;
  /** The chat input's current text. A leading "/" opens the picker. */
  inputValue: string;
  /** Replaces the input's text with the chosen prompt. */
  onPickPrompt: (promptText: string) => void;
  /** Names the picker for screen readers. */
  label: string;
}

interface SavedPromptChat {
  /** The picker panel, or null when it should not be showing. */
  picker: ReactNode;
  /** The manage dialog. Always rendered; it hides itself when closed. */
  manager: ReactNode;
  /**
   * Whether the picker is currently taking the arrow keys and Enter. The
   * chat input's own Enter handler must check this: while the picker is
   * open, Enter chooses a prompt rather than sending "/dec" as a question.
   *
   * False whenever nothing matches, so a question that merely begins with a
   * path stays sendable.
   */
  pickerOpen: boolean;
  /** Wire onto the chat input's `onKeyDown`, before its own handling. */
  onInputKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  /** Opens the manage dialog with a new prompt seeded from this text. */
  saveTextAsPrompt: (text: string) => void;
}

/**
 * The saved-prompt library, wired to one chat input.
 *
 * A hook rather than a wrapper component because the picker has to share the
 * input's keyboard: the reader is typing in a text field, so the arrow keys
 * and Enter arrive there and have to be forwarded, and a component that owns
 * neither the input nor its handlers cannot do that.
 *
 * Everything it does is local. Choosing a prompt fills the input; it does not
 * send anything. The question then travels the same grounded chat path a
 * hand-typed one does.
 */
export function useSavedPromptChat({
  scope,
  inputValue,
  onPickPrompt,
  label,
}: UseSavedPromptChatOptions): SavedPromptChat {
  const { prompts, persist, saveError } = useSavedPrompts();
  const [managerOpen, setManagerOpen] = useState(false);
  const [seed, setSeed] = useState<SavedPrompt | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [activeId, setActiveId] = useState("");

  const query = savedPromptQueryFor(inputValue);
  const matches = useMemo(() => {
    if (query === null) return [];
    return filterSavedPrompts(savedPromptsForScope(prompts, scope), query);
  }, [prompts, scope, query]);

  // Escape dismisses the picker for this "/"; typing anything that stops
  // being a "/" query re-arms it, so the reader is never stuck with a picker
  // they closed or without one they want.
  useEffect(() => {
    if (query === null) setDismissed(false);
  }, [query]);

  // No match, no picker -- and so no Send block either.
  //
  // The trigger is any leading "/", which is also how a path is written. A
  // question that opens "/Users/me/notes.txt is failing to import" filtered
  // the library down to nothing, and both chat surfaces refuse to send while
  // the picker is open, so that question could not be asked at all: Enter
  // chose a prompt that did not exist and the Send button did nothing, with a
  // panel saying "No saved prompt matches that" as the only explanation.
  // A picker offering nothing has nothing to take the keyboard for.
  const pickerOpen =
    query !== null && matches.length > 0 && !dismissed && !managerOpen;

  // Keep the highlight on a row that still exists as the filter narrows.
  useEffect(() => {
    if (!pickerOpen) return;
    setActiveId((current) =>
      matches.some((prompt) => prompt.id === current) ? current : matches[0].id,
    );
  }, [pickerOpen, matches]);

  const choose = useCallback(
    (prompt: SavedPrompt) => {
      onPickPrompt(prompt.prompt);
      setDismissed(true);
    },
    [onPickPrompt],
  );

  const onInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!pickerOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
      const index = matches.findIndex((prompt) => prompt.id === activeId);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveId(matches[(index + 1 + matches.length) % matches.length].id);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveId(matches[(index - 1 + matches.length) % matches.length].id);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        choose(matches[index === -1 ? 0 : index]);
      }
    },
    [pickerOpen, matches, activeId, choose],
  );

  const saveTextAsPrompt = useCallback(
    (text: string) => {
      const seeded = savedPromptFromMessage(text, scope);
      if (!seeded) return;
      setSeed(seeded);
      setManagerOpen(true);
    },
    [scope],
  );

  const onSeedConsumed = useCallback(() => setSeed(null), []);

  return {
    pickerOpen,
    onInputKeyDown,
    saveTextAsPrompt,
    picker: pickerOpen ? (
      <SavedPromptPicker
        matches={matches}
        activeId={activeId}
        onActiveIdChange={setActiveId}
        label={label}
        onSelect={choose}
        onManage={() => setManagerOpen(true)}
      />
    ) : null,
    manager: (
      <SavedPromptManagerDialog
        open={managerOpen}
        onOpenChange={setManagerOpen}
        prompts={prompts}
        onPersist={persist}
        seedPrompt={seed}
        onSeedConsumed={onSeedConsumed}
        saveError={saveError}
      />
    ),
  };
}
