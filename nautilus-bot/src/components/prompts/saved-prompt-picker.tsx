import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import type { SavedPrompt } from "@/lib/saved-prompts";

interface SavedPromptPickerProps {
  /** Already filtered to this surface's scope and to the typed query. */
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
 * is why `cmdk` runs fully controlled here -- `shouldFilter` off because the
 * filtering lives in `saved-prompts.ts` where it is testable without a DOM,
 * and `value` driven from outside because the element with focus is the chat
 * input, not this list.
 *
 * Prompt text is the reader's own words, rendered as text. Nothing on this
 * surface comes from a meeting transcript.
 */
export function SavedPromptPicker({
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
      <Command shouldFilter={false} value={activeId} onValueChange={onActiveIdChange}>
        <CommandList className="max-h-56">
          {matches.length === 0 ? (
            <CommandEmpty className="text-sm text-muted-foreground">
              No saved prompt matches that.
            </CommandEmpty>
          ) : (
            <CommandGroup>
              {matches.map((prompt) => (
                <CommandItem
                  key={prompt.id}
                  value={prompt.id}
                  onSelect={() => onSelect(prompt)}
                  className="flex-col items-start gap-0.5 py-2"
                >
                  <span className="text-sm font-medium">{prompt.name}</span>
                  <span className="line-clamp-1 text-sm text-muted-foreground">
                    {prompt.prompt}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
      <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
        <p className="text-sm text-muted-foreground">
          Saved on this Mac. Picking one only fills the box.
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          // `onMouseDown` rather than `onClick`: a click on this button also
          // blurs the chat input, and the picker is gone by the time a click
          // handler would run.
          onMouseDown={(event) => {
            event.preventDefault();
            onManage();
          }}
        >
          Manage
        </Button>
      </div>
    </div>
  );
}
