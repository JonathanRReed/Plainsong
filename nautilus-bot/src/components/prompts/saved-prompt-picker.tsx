import { Button } from "@/components/ui/button";
import type { SavedPrompt } from "@/lib/saved-prompts";

interface SavedPromptPickerProps {
  /**
   * Already filtered to this surface's scope and to the typed query, and
   * never empty: the caller closes the picker instead of showing an empty
   * one, so a question that just happens to start with a path is still
   * sendable.
   */
  listId: string;
  matches: readonly SavedPrompt[];
  /** The highlighted row's id, owned by the caller's keyboard handler. */
  activeId: string;
  onActiveIdChange: (id: string) => void;
  onSelect: (prompt: SavedPrompt) => void;
  onManage: () => void;
  label: string;
}

/**
 * The list that opens under a chat input when the reader types "/".
 *
 * It is a plain panel, not a modal: the input keeps focus, so typing keeps
 * filtering and the arrow keys still belong to the reader's text field. That
 * is why the caller owns selection and the list leaves focus in the input.
 *
 * Prompt text is the reader's own words, rendered as text. Nothing on this
 * surface comes from a meeting transcript.
 */
export function SavedPromptPicker({
  listId,
  matches,
  activeId,
  onActiveIdChange,
  onSelect,
  onManage,
  label,
}: SavedPromptPickerProps) {
  return (
    <div
      className="rounded-md border border-border bg-popover shadow-sm"
      role="group"
      aria-label={label}
    >
      <div id={listId} role="listbox" aria-label={label} className="max-h-56 overflow-y-auto p-1">
        {matches.map((prompt) => (
          <div
            key={prompt.id}
            id={`${listId}-${prompt.id}`}
            role="option"
            aria-selected={prompt.id === activeId}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => onActiveIdChange(prompt.id)}
            onClick={() => onSelect(prompt)}
            className="flex cursor-default flex-col items-start gap-0.5 rounded-sm px-2 py-2 aria-selected:bg-accent aria-selected:text-accent-foreground"
          >
            <span className="text-sm font-medium">{prompt.name}</span>
            <span className="line-clamp-1 text-sm text-muted-foreground">{prompt.prompt}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
        <p className="text-sm text-muted-foreground">
          Saved on this Mac. Picking one only fills the box.{" "}
          <span className="whitespace-nowrap">Esc closes this.</span>
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onManage}
        >
          Manage
        </Button>
      </div>
    </div>
  );
}
