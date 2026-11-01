import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Check, Copy, Edit3 } from "lucide-react";
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
  /**
   * Read mode only: show this instead of the markdown. For a field whose
   * saved text has structure worth showing (action items carry an owner and a
   * date), so reading it does not mean reading the raw stored line. The
   * editor still edits `value`, which stays the one saved thing.
   */
  renderBody?: ReactNode;
  renderEmptyBody?: boolean;
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
  copyable?: boolean;
  copySourceKey?: string;
  copyWarning?: string;
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
  renderBody,
  renderEmptyBody = false,
  emptyMessage,
  editorPlaceholder,
  isEditing,
  onEditingChange,
  actions,
  bodyClassName,
  disabled = false,
  copyable = false,
  copySourceKey,
  copyWarning,
}: DocumentFieldProps) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const requestedFocusRef = useRef<"editor" | "button" | null>(null);
  const copyBusyRef = useRef(false);
  const copyMountedRef = useRef(true);
  const copyScopeRef = useRef({ source: copySourceKey, label, value, warning: copyWarning, enabled: copyable });
  if (copyScopeRef.current.source !== copySourceKey || copyScopeRef.current.label !== label ||
      copyScopeRef.current.value !== value || copyScopeRef.current.warning !== copyWarning ||
      copyScopeRef.current.enabled !== copyable) {
    copyScopeRef.current = { source: copySourceKey, label, value, warning: copyWarning, enabled: copyable };
  }
  const copyScope = copyScopeRef.current;
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<{ scope: typeof copyScope; error: boolean } | null>(null);
  useEffect(() => {
    copyMountedRef.current = true;
    return () => { copyMountedRef.current = false; };
  }, []);
  const copyCurrentText = async () => {
    if (!copyable || !value.trim() || copyBusyRef.current || copyScope !== copyScopeRef.current) return;
    copyBusyRef.current = true;
    setCopyBusy(true);
    setCopyFeedback(null);
    try {
      await navigator.clipboard.writeText(copyWarning ? `${copyWarning}\n\n${value}` : value);
      if (copyMountedRef.current && copyScope === copyScopeRef.current) setCopyFeedback({ scope: copyScope, error: false });
    } catch {
      if (copyMountedRef.current && copyScope === copyScopeRef.current) setCopyFeedback({ scope: copyScope, error: true });
    } finally {
      copyBusyRef.current = false;
      if (copyMountedRef.current) setCopyBusy(false);
    }
  };
  const changeEditing = (editing: boolean) => {
    if (disabled) return;
    requestedFocusRef.current = editing ? "editor" : "button";
    onEditingChange(editing);
  };
  useLayoutEffect(() => {
    if (disabled) {
      requestedFocusRef.current = null;
      return;
    }
    if (isEditing && requestedFocusRef.current === "editor" && editorRef.current) {
      editorRef.current.focus();
      const end = editorRef.current.value.length;
      editorRef.current.setSelectionRange(end, end);
      requestedFocusRef.current = null;
    } else if (!isEditing && requestedFocusRef.current === "button") {
      editButtonRef.current?.focus();
      requestedFocusRef.current = null;
    }
  }, [isEditing, disabled]);
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
          {/* A real heading, so "Summary" and "Action items" show up when a
              screen reader walks the meeting page by heading. */}
          <h3 className="section-heading">{label}</h3>
          {caption ? (
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">{caption}</p>
          ) : null}
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          <Button
            ref={editButtonRef}
            type="button"
            size="sm"
            variant={isEditing ? "active" : "outline"}
            disabled={disabled}
            // Two fields, two Edit buttons: name each one after the text it
            // opens so a keyboard or screen reader can tell them apart.
            aria-label={isEditing ? `Done editing ${label}` : `Edit ${label}`}
            title={isEditing ? "Finish editing with Command+Enter or Ctrl+Enter" : undefined}
            onClick={() => changeEditing(!isEditing)}
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
          {copyable && <Button type="button" variant="outline" size="sm" aria-label={`Copy ${label}`}
            disabled={copyBusy || !hasText} onClick={() => { void copyCurrentText(); }}>
            <Copy className="mr-2 h-4 w-4" aria-hidden="true" />{copyBusy ? "Copying…" : "Copy"}
          </Button>}
        </div>
      </div>
      {copyable && copyFeedback?.scope === copyScope && <p role={copyFeedback.error ? "alert" : "status"}
        className={`text-sm ${copyFeedback.error ? "text-rust" : "text-muted-foreground"}`}>
        {copyFeedback.error ? "Could not copy. Select the text and copy it manually." : "Copied."}
      </p>}

      {isEditing ? (
        <textarea
          ref={editorRef}
          aria-label={label}
          aria-keyshortcuts={disabled ? undefined : "Meta+Enter Control+Enter"}
          value={value}
          readOnly={disabled}
          placeholder={editorPlaceholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)
              && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !disabled) {
              event.preventDefault();
              changeEditing(false);
            }
          }}
          rows={1}
          className={cn(
            "w-full resize-none overflow-hidden rounded-md border bg-background px-3 py-3 text-sm leading-relaxed placeholder:text-muted-foreground/80 focus:outline-none focus:ring-1 focus:ring-ring",
            bodyClassName
          )}
        />
      ) : (
        <div
          role="region"
          aria-label={label}
          className={cn(hasText && bodyClassName, hasText && "pl-3")}
        >
          {hasText || renderEmptyBody ? (
            (renderBody ?? <MarkdownText value={renderValue ?? value} />)
          ) : (
            <p className="text-sm text-muted-foreground">{emptyMessage}</p>
          )}
        </div>
      )}
    </section>
  );
}
