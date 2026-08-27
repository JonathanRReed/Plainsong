import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

export interface SearchableSelectOption {
  value: string;
  label: string;
  /** A short qualifier shown after the label — never the whole story. */
  hint?: string;
}

interface SearchableSelectProps {
  id?: string;
  value: string;
  options: SearchableSelectOption[];
  onChange(value: string): void;
  /** Accessible name, when no visible <label> points at `id`. */
  ariaLabel?: string;
  /** What to type into. */
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * A one-of-many picker you can type into.
 *
 * Built on the same `cmdk` primitive as the command palette rather than a new
 * dependency: the app has no popover package, so the list opens inline under
 * the trigger. A plain `<select>` is still the right control for a handful of
 * options; this exists for the lists that run to a hundred.
 */
export function SearchableSelect({
  id,
  value,
  options,
  onChange,
  ariaLabel,
  searchPlaceholder = "Search…",
  emptyText = "Nothing matches that.",
  disabled = false,
  className,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const generatedId = useId();
  const listId = `${id ?? generatedId}-list`;
  const selected = options.find((option) => option.value === value) ?? null;

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) {
      triggerRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    // Tabbing out of the list has to close it too. Watching only for an outside
    // mousedown left a keyboard user with an open listbox floating over the
    // controls below while their focus had already moved on.
    let focusCheck: ReturnType<typeof setTimeout> | undefined;
    const handleFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (next && containerRef.current?.contains(next)) {
        return;
      }
      // During an internal pointer interaction focus can be nowhere for an
      // instant, and `relatedTarget` is null for exactly that case as well as
      // for a real departure. Re-check once the browser has settled focus.
      focusCheck = setTimeout(() => {
        if (!containerRef.current?.contains(document.activeElement)) {
          setOpen(false);
        }
      }, 0);
    };

    const container = containerRef.current;
    document.addEventListener("mousedown", handlePointerDown);
    container?.addEventListener("focusout", handleFocusOut);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      container?.removeEventListener("focusout", handleFocusOut);
      if (focusCheck !== undefined) {
        clearTimeout(focusCheck);
      }
    };
  }, [open]);

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-2 rounded-md border bg-background p-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="truncate">
          {selected?.label ?? value}
          {selected?.hint ? (
            <span className="ml-2 text-muted-foreground">{selected.hint}</span>
          ) : null}
        </span>
        <ChevronsUpDown
          className="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div className="absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-md border bg-popover shadow-md">
          <Command
            loop
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close(true);
              }
            }}
          >
            <CommandInput placeholder={searchPlaceholder} autoFocus />
            <CommandList id={listId}>
              <CommandEmpty>{emptyText}</CommandEmpty>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={`${option.label} ${option.value}`}
                  onSelect={() => {
                    onChange(option.value);
                    close(true);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      option.value === value ? "opacity-100" : "opacity-0",
                    )}
                    aria-hidden="true"
                  />
                  <span className="truncate">{option.label}</span>
                  {option.hint ? (
                    <span className="ml-2 text-muted-foreground">
                      {option.hint}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </div>
      ) : null}
    </div>
  );
}
