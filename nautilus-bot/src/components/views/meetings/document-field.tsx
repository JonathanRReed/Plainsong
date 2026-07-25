import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Check, Edit3 } from "lucide-react";
import { MarkdownText } from "./markdown-text";

interface DocumentFieldProps {
  /** Section label, and the accessible name of both the page and the editor. */
  label: string;
  /** One line under the label — who set this text down, in plain words. */
  caption?: ReactNode;
  value: string;
  onChange: (next: string) => void;
  /** Markdown actually handed to the reader; defaults to `value`. */
  renderValue?: string;
  /** Sentence shown in place of the document when there is nothing yet. */
  emptyMessage: string;
  editorPlaceholder: string;
  isEditing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** Buttons that belong to this field, right of the Edit affordance. */
  actions?: ReactNode;
  /** Ink/rule treatment carrying who wrote the text. */
  bodyClassName?: string;
  disabled?: boolean;
}

/**
 * One field of the meeting record. Read, it is a document: markdown set in the
 * manuscript serif. Edited, it is an editor that grows with the text — never a
 * fixed eight-row box that hides the end of what you wrote.
 *
 * The label is the accessible name of whichever of the two is on screen, so
 * "the summary" is one thing to a screen reader and to a keyboard, not two.
 */
export function DocumentField({
  label,
  caption,
  value,
  onChange,
  renderValue,
  emptyMessage,
  editorPlaceholder,
  isEditing,
  onEditingChange,
  actions,
  bodyClassName,
  disabled = false,
}: DocumentFieldProps) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const hasText = value.trim().length > 0;

  // Grow to the text. Measured after paint so the height tracks wrapping, and
  // reset to `auto` first so deleting a line shrinks the box back down.
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || !isEditing) {
      return;
    }
    editor.style.height = "auto";
    editor.style.height = `${Math.max(editor.scrollHeight, 96)}px`;
  }, [isEditing, value]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="section-heading">{label}</p>
          {caption ? (
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">{caption}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={isEditing ? "active" : "outline"}
            disabled={disabled}
            // Two fields, two Edit buttons: name each one after the text it
            // opens so a keyboard or screen reader can tell them apart.
            aria-label={isEditing ? `Done editing ${label}` : `Edit ${label}`}
            onClick={() => onEditingChange(!isEditing)}
          >
            {isEditing ? (
              <>
                <Check className="mr-2 h-4 w-4" />
                Done editing
              </>
            ) : (
              <>
                <Edit3 className="mr-2 h-4 w-4" />
                Edit
              </>
            )}
          </Button>
          {actions}
        </div>
      </div>

      {isEditing ? (
        <textarea
          ref={editorRef}
          aria-label={label}
          value={value}
          placeholder={editorPlaceholder}
          onChange={(event) => onChange(event.target.value)}
          rows={1}
          className={cn(
            "w-full resize-none overflow-hidden rounded-md border bg-background px-3 py-3 text-sm leading-relaxed placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring",
            bodyClassName
          )}
        />
      ) : (
        <div
          role="region"
          aria-label={label}
          className={cn(hasText && bodyClassName, hasText && "pl-3")}
        >
          {hasText ? (
            <MarkdownText value={renderValue ?? value} />
          ) : (
            <p className="text-sm text-muted-foreground">{emptyMessage}</p>
          )}
        </div>
      )}
    </section>
  );
}
