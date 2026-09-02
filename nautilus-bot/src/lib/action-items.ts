/**
 * Reading the stored form of a meeting action item.
 *
 * An action item is stored as one editable line, so a person can rewrite the
 * list as text. When Plainsong finds an owner or a date it writes them into
 * that line as `task (Owner: X · Due: Y)`; this module reads that suffix back
 * so the workspace can show the parts without a second storage column.
 *
 * This mirrors `rust-sidecar/src/export/action_items.rs`, which writes the
 * form and reads it for the exports. Change one and change the other: the two
 * test suites pin the same cases.
 */

const OWNER_LABEL = "Owner: ";
const DUE_LABEL = "Due: ";
const DETAIL_SEPARATOR = " · ";

export interface StructuredActionItem {
  /** The stored line, trimmed and otherwise unchanged. */
  text: string;
  task: string;
  owner: string | null;
  dueDate: string | null;
}

function clean(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read one stored line. A line that does not end in a recognised
 * `(Owner: … · Due: …)` suffix is one task with no owner and no date, so a
 * person's own parenthetical is never mistaken for structure.
 */
export function parseStoredActionItem(text: string): StructuredActionItem {
  const trimmed = text.trim();
  const whole: StructuredActionItem = {
    text: trimmed,
    task: trimmed,
    owner: null,
    dueDate: null,
  };
  if (!trimmed.endsWith(")")) {
    return whole;
  }
  const withoutClose = trimmed.slice(0, -1);
  const open = withoutClose.lastIndexOf(" (");
  if (open < 0) {
    return whole;
  }
  const task = withoutClose.slice(0, open).trim();
  const suffix = withoutClose.slice(open + 2);
  if (task.length === 0 || suffix.length === 0) {
    return whole;
  }

  let owner: string | null = null;
  let dueDate: string | null = null;
  for (const part of suffix.split(DETAIL_SEPARATOR)) {
    if (part.startsWith(OWNER_LABEL)) {
      if (owner !== null) {
        return whole;
      }
      owner = clean(part.slice(OWNER_LABEL.length));
    } else if (part.startsWith(DUE_LABEL)) {
      if (dueDate !== null) {
        return whole;
      }
      dueDate = clean(part.slice(DUE_LABEL.length));
    } else {
      return whole;
    }
  }
  if (owner === null && dueDate === null) {
    return whole;
  }
  return { text: trimmed, task, owner, dueDate };
}

/** Every non-empty stored line, read back. */
export function parseStoredActionItems(
  items: readonly string[]
): StructuredActionItem[] {
  return items
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map(parseStoredActionItem);
}
