import { parseStoredActionItems } from "@/lib/action-items";

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
 * The saved action items, read. Each line shows its task; an owner or a date
 * that Plainsong found in the transcript (and that survived citation checking)
 * is shown beside it instead of being left inside the sentence as
 * `(Owner: … · Due: …)`. Editing the field still edits the stored lines.
 */
export function ActionItemList({ items }: { items: readonly string[] }) {
  const parsed = parseStoredActionItems(items);
  if (parsed.length === 0) {
    return null;
  }

  return (
    <ul className="space-y-2">
      {parsed.map((item, index) => (
        <li
          key={`${index}-${item.text}`}
          className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
        >
          <span className="font-serif text-sm leading-relaxed">{item.task}</span>
          {item.owner ? <ActionItemChip label="Owner" value={item.owner} /> : null}
          {item.dueDate ? <ActionItemChip label="Due" value={item.dueDate} /> : null}
        </li>
      ))}
    </ul>
  );
}
