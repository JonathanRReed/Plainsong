import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { parseStoredActionItem, parseStoredActionItems, serializeActionItem } from "@/lib/action-items";
import { parseRecapQuote, type RecapQuote } from "@/lib/markdown";

/**
 * One fact about an action item, set beside it.
 *
 * Neutral on purpose: an owner or a date is a fact about the item, not a state
 * of it, so nothing here earns gold.
 */
export function ActionItemChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline rounded-md border border-border bg-muted/20 px-2 py-0.5 text-sm text-muted-foreground">
      {label}: {value}
    </span>
  );
}

/**
 * The source sentences a generated item quotes, when its evidence is exactly
 * its task: one `Speaker (0:12): “…”` line per sentence, in order. Null for an
 * edited, hand-written or older item.
 */
function quotedTask(task: string, evidence: string | null): RecapQuote[] | null {
  if (!evidence) return null;
  const quotes = evidence.split("\n").map((line) => parseRecapQuote(line));
  if (quotes.length === 0 || quotes.some((quote) => quote === null)) return null;
  const parsed = quotes as RecapQuote[];
  return parsed.map((quote) => quote.quote).join(" ") === task.trim() ? parsed : null;
}

/**
 * The saved action items, read. Each line shows its task; an owner or a date
 * that Plainsong found in the transcript (and that survived citation checking)
 * is shown beside it instead of being left inside the sentence as
 * `(Owner: … · Due: …)`. A generated item's task is the meeting's own words:
 * while unchanged, it is shown as those quotes with who said them and when,
 * like the recap; one the meeting left unclear says so beside it. An older
 * generated item shows its source sentence under the task. Editing the field still edits the stored lines.
 */
export function ActionItemList({
  items,
  sourceItems = items,
  evidence,
  unclear,
  onInteractionChange,
  completedTasks,
  disabled,
  onCompletionChange,
  focusedTask,
  sourceKey,
  onEdit,
  onAdd,
  onDelete,
}: {
  items: readonly string[];
  sourceItems?: readonly string[];
  /** Quoted source sentences, aligned with `sourceItems`. */
  evidence?: readonly (string | null | undefined)[];
  /** Generated items the meeting left unclear, aligned with `sourceItems`. */
  unclear?: readonly (boolean | undefined)[];
  onInteractionChange?: (active: boolean) => void;
  completedTasks?: ReadonlySet<string>;
  disabled?: boolean;
  onCompletionChange?: (task: string, completed: boolean) => void;
  focusedTask?: string;
  sourceKey?: string;
  onEdit?: (original: string, replacement: string) => Promise<void>;
  onAdd?: (replacement: string) => Promise<void>;
  onDelete?: (original: string, sourceIndex: number) => Promise<void>;
}) {
  const [editor, setEditor] = useState<{ original: string | null; task: string; owner: string; dueDate: string; error: string | null } | null>(null);
  const [deleting, setDeleting] = useState<{ original: string; sourceIndex: number; error: string | null } | null>(null);
  const returnFocusRef = useRef<{ button: HTMLButtonElement; key: string | undefined } | null>(null);
  const editPending = useRef(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const editSource = useRef({ key: sourceKey });
  if (editSource.current.key !== sourceKey) editSource.current = { key: sourceKey };
  useEffect(() => { setEditor(null); setDeleting(null); }, [sourceKey]);
  useEffect(() => { onInteractionChange?.(editor !== null || deleting !== null); }, [editor, deleting, onInteractionChange]);
  useEffect(() => () => onInteractionChange?.(false), [onInteractionChange]);
  const saveEdit = async () => {
    if (!editor || editPending.current || (editor.original === null ? !onAdd : !onEdit)) return;
    const source = editSource.current;
    editPending.current = true;
    setSavingEdit(true);
    try {
      const previous = parseStoredActionItem(editor.original ?? "");
      const unchanged = editor.task === previous.task && editor.owner === (previous.owner ?? "") && editor.dueDate === (previous.dueDate ?? "");
      const replacement = unchanged && editor.original !== null ? editor.original : serializeActionItem(editor.task, editor.owner, editor.dueDate);
      if (editor.original === null) await onAdd!(replacement);
      else await onEdit!(editor.original, replacement);
      if (mountedRef.current && editSource.current === source) setEditor(null);
    } catch (error) {
      if (mountedRef.current && editSource.current === source) setEditor((current) => current ? { ...current, error: error instanceof Error ? error.message : "Could not save this task. Try again." } : current);
    } finally {
      editPending.current = false;
      if (mountedRef.current) setSavingEdit(false);
    }
  };
  const deleteTask = async () => {
    if (!deleting || !onDelete || editPending.current) return;
    const source = editSource.current;
    editPending.current = true;
    setSavingEdit(true);
    try {
      await onDelete(deleting.original, deleting.sourceIndex);
      if (mountedRef.current && editSource.current === source) setDeleting(null);
    } catch (error) {
      if (mountedRef.current && editSource.current === source) setDeleting((current) => current ? { ...current, error: error instanceof Error ? error.message : "Could not delete this task. Try again." } : current);
    } finally {
      editPending.current = false;
      if (mountedRef.current) setSavingEdit(false);
    }
  };
  const listRef = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const target = returnFocusRef.current;
    if (!target) return;
    if (target.key !== sourceKey) {
      returnFocusRef.current = null;
      return;
    }
    if (editor || deleting || savingEdit) return;
    returnFocusRef.current = null;
    // A delayed save must not interrupt someone who has moved elsewhere.
    if (document.activeElement !== document.body && !listRef.current?.contains(document.activeElement)) return;
    const button = target.button.isConnected ? target.button
      : listRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    button?.focus();
  }, [editor, deleting, savingEdit, sourceKey]);
  const parsed = parseStoredActionItems(items);
  const focusTarget = focusedTask?.trim();
  const copyBusyRef = useRef(false);
  const mountedRef = useRef(true);
  const copyScopeRef = useRef({ key: sourceKey, items: JSON.stringify(items), revision: 0 });
  const contentKey = JSON.stringify(items);
  if (copyScopeRef.current.key !== sourceKey || copyScopeRef.current.items !== contentKey) {
    copyScopeRef.current = { key: sourceKey, items: contentKey, revision: copyScopeRef.current.revision + 1 };
  }
  const scope = copyScopeRef.current;
  const [pendingCopy, setPendingCopy] = useState<{ scope: typeof scope; text: string; index: number } | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{ scope: typeof scope; text: string; index: number; error: boolean } | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const copyTask = async (text: string, index: number) => {
    if (copyBusyRef.current || scope !== copyScopeRef.current) return;
    copyBusyRef.current = true;
    setPendingCopy({ scope, text, index });
    setCopyFeedback(null);
    try {
      await navigator.clipboard.writeText(text);
      if (mountedRef.current && copyScopeRef.current === scope) setCopyFeedback({ scope, text, index, error: false });
    } catch {
      if (mountedRef.current && copyScopeRef.current === scope) setCopyFeedback({ scope, text, index, error: true });
    } finally {
      copyBusyRef.current = false;
      if (mountedRef.current) setPendingCopy(null);
    }
  };

  useEffect(() => {
    if (!focusTarget || !listRef.current) {
      return;
    }

    const targetIndex = parseStoredActionItems(items).findIndex(
      (item) => item.text === focusTarget,
    );
    const targetRow = targetIndex >= 0 ? listRef.current.children.item(targetIndex) : null;
    if (!(targetRow instanceof HTMLElement)) {
      return;
    }

    targetRow.scrollIntoView({ block: "center" });
    targetRow.focus({ preventScroll: true });
  }, [focusedTask, items]);

  if (parsed.length === 0 && !editor && !onAdd) {
    return null;
  }

  return (
    <ul ref={listRef} className="space-y-2">
      {parsed.map((item, index) => {
        const isFocused = item.text === focusTarget;
        const occurrence = items.slice(0, index).filter((text) => text === item.text).length;
        const sourceIndex = sourceItems.flatMap((text, sourceIndex) => text === item.text ? [sourceIndex] : [])[occurrence];
        const quoted = sourceIndex === undefined ? null : evidence?.[sourceIndex]?.trim() || null;
        const quotes = quotedTask(item.task, quoted);
        // Only an unchanged quoted item keeps the meeting's own doubt.
        const isUnclear = quotes !== null && sourceIndex !== undefined && unclear?.[sourceIndex] === true;
        const done = completedTasks?.has(item.text) ?? false;
        return (
          <li
            key={`${index}-${item.text}`}
            aria-current={isFocused ? true : undefined}
            tabIndex={isFocused ? -1 : undefined}
            data-focused={isFocused ? true : undefined}
            className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 ${isFocused ? "rounded-md bg-gold/5 ring-1 ring-gold/30" : ""}`}
          >
            {onCompletionChange ? (
              <input
                type="checkbox"
                checked={completedTasks?.has(item.text) ?? false}
                disabled={editor !== null || deleting !== null}
                aria-disabled={disabled || undefined}
                aria-label={`Mark ${item.task} ${completedTasks?.has(item.text) ? "incomplete" : "done"}`}
                onKeyDown={(event) => { if (disabled && event.key === " ") event.preventDefault(); }}
                onChange={(event) => { if (!disabled) onCompletionChange(item.text, event.target.checked); }}
                className="h-4 w-4 shrink-0 accent-gold cursor-pointer disabled:cursor-wait aria-disabled:cursor-wait"
              />
            ) : null}

            {quotes ? (
              <div className={`min-w-0 flex-1 basis-64 space-y-1.5 border-l-2 border-gold-ambient/50 pl-3 ${done ? "text-muted-foreground line-through" : ""}`}>
                <span className="sr-only">Said in the meeting: </span>
                {quotes.map((quote, quoteIndex) => (
                  <div key={quoteIndex}>
                    <blockquote className="manuscript text-sm leading-relaxed">“{quote.quote}”</blockquote>
                    {quote.speaker || quote.time ? (
                      <p className="text-xs text-muted-foreground">
                        {quote.speaker ? <span className="font-medium text-foreground/80">{quote.speaker}</span> : null}
                        {quote.speaker && quote.time ? " · " : null}
                        {quote.time ? <span className="time-spec">{quote.time}</span> : null}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <span className={`font-serif text-sm leading-relaxed ${done ? "text-muted-foreground line-through" : ""}`}>
                {item.task}
              </span>
            )}
            {isUnclear ? (
              <span
                className="inline-flex items-baseline rounded-md border border-border px-2 py-0.5 text-sm text-muted-foreground"
                title="The meeting left who, when or under what condition unclear. Check the quote before acting on it."
              >
                Unclear in the meeting
              </span>
            ) : null}
            {item.owner ? <ActionItemChip label="Owner" value={item.owner} /> : null}
            {item.dueDate ? <ActionItemChip label="Due" value={item.dueDate} /> : null}
            <div className="ml-auto inline-flex shrink-0 items-center gap-2">
            {onEdit && <button type="button" disabled={disabled || savingEdit || editor !== null || deleting !== null}
              aria-label={`Edit task: ${item.task}`} className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={(event) => { returnFocusRef.current = { button: event.currentTarget, key: sourceKey }; setEditor({ original: item.text, task: item.task, owner: item.owner ?? "", dueDate: item.dueDate ?? "", error: null }); }}>Edit task</button>}
            {onDelete && <button type="button" disabled={disabled || savingEdit || editor !== null || deleting !== null}
              aria-label={`Delete task: ${item.task}`} className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={(event) => { returnFocusRef.current = { button: event.currentTarget, key: sourceKey }; setDeleting({ original: item.text, sourceIndex, error: null }); }}>Delete task</button>}
            <button type="button" aria-label={`Copy task: ${item.task}`}
              title="Copy task with its owner and due date"
              disabled={pendingCopy !== null}
              onClick={() => { void copyTask(item.text, index); }}
              className="inline-flex min-h-6 items-center gap-1 rounded px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              {pendingCopy?.scope === scope && pendingCopy.index === index ? "Copying…" : "Copy task"}
            </button>
            </div>
            {quoted && !quotes ? (
              <blockquote className="w-full border-l-2 border-gold-ambient/50 pl-3 text-sm leading-relaxed text-muted-foreground">
                <span className="sr-only">Said in the meeting: </span>
                <span className="manuscript">“{quoted}”</span>
              </blockquote>
            ) : null}
            {copyFeedback?.scope === scope && copyFeedback.index === index && copyFeedback.text === item.text && <p
              role={copyFeedback.error ? "alert" : "status"}
              className={`w-full text-xs ${copyFeedback.error ? "text-rust" : "text-muted-foreground"}`}>
              {copyFeedback.error ? "Could not copy this task. Select its text and copy it manually." : "Task copied."}
            </p>}
          </li>
        );
      })}
      {onAdd && <li><button type="button" disabled={disabled || savingEdit || editor !== null || deleting !== null}
        className="rounded border border-border px-3 py-2 text-sm"
        onClick={(event) => { returnFocusRef.current = { button: event.currentTarget, key: sourceKey }; setEditor({ original: null, task: "", owner: "", dueDate: "", error: null }); }}>Add task</button></li>}
      {deleting && <li className="space-y-2 rounded border border-border p-3">
        <p className="text-sm">Delete task "{parseStoredActionItem(deleting.original).task}"?</p>
        {deleting.error && <p role="alert" className="text-sm text-rust">{deleting.error}</p>}
        <button type="button" disabled={savingEdit || disabled} className="rounded border border-border px-3 py-2 text-sm" onClick={() => void deleteTask()}>{savingEdit ? "Deleting…" : "Confirm delete task"}</button>
        <button type="button" autoFocus disabled={savingEdit} className="ml-2 px-3 py-2 text-sm" onClick={() => setDeleting(null)}>Cancel</button>
      </li>}
            {editor && <li><form className="w-full space-y-2 rounded border border-border p-3" aria-label={editor.original === null ? "Add action item" : "Edit action item"}
              onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}>
              {(["task", "owner", "dueDate"] as const).map((field) => <label key={field} className="block text-sm">
                {field === "dueDate" ? "Due date" : field === "task" ? "Task" : "Owner"}
                <input className="block w-full rounded border border-border bg-background p-2" disabled={savingEdit} autoFocus={field === "task"}
                  value={editor[field]} onChange={(event) => setEditor({ ...editor, [field]: event.target.value, error: null })} />
              </label>)}
              {editor.error && <p role="alert" className="text-sm text-rust">{editor.error}</p>}
              <button type="submit" disabled={savingEdit || disabled} className="rounded border border-border px-3 py-2 text-sm">{savingEdit ? "Saving…" : "Save task"}</button>
              <button type="button" disabled={savingEdit} className="ml-2 px-3 py-2 text-sm" onClick={() => setEditor(null)}>Cancel</button>
            </form></li>}
    </ul>
  );
}
