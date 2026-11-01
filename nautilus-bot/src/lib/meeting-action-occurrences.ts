import type { LlmCitation } from "@/types";

export interface ActionItemOccurrence {
  item: string;
  citations: LlmCitation[] | null;
  grounded: boolean;
  /** The quoted source sentences, only while the item is unchanged. */
  evidence?: string | null;
  /** The meeting left the quoted commitment unclear, only while unchanged. */
  unclear?: boolean;
}

/** Keep occurrence slots aligned. Structural edits cannot identify duplicate survivors. */
export function matchActionItemOccurrences(
  items: readonly string[],
  provenance: readonly ActionItemOccurrence[],
): ActionItemOccurrence[] {
  if (items.length === provenance.length) {
    return items.map((item, index) => {
      const entry = provenance[index];
      const matches = entry.item.trim() === item.trim();
      return {
        item,
        citations: matches ? entry.citations : null,
        grounded: matches && entry.citations != null && entry.grounded,
        evidence: matches ? entry.evidence : undefined,
        unclear: matches ? entry.unclear : undefined,
      };
    });
  }
  const queues = new Map<string, ActionItemOccurrence[]>();
  for (const entry of provenance) {
    const key = entry.item.trim();
    const queue = queues.get(key) ?? [];
    queue.push(entry);
    queues.set(key, queue);
  }
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.trim(), (counts.get(item.trim()) ?? 0) + 1);
  return items.map((item) => {
    const queue = queues.get(item.trim());
    // Raw text edits have no row identity. A canonical row deletion supplies a
    // new, aligned provenance array and takes the positional branch above.
    const entry = queue?.length === 1 && counts.get(item.trim()) === 1 ? queue[0] : undefined;
    return {
      item,
      citations: entry?.citations ?? null,
      grounded: entry?.citations != null && entry.grounded,
      evidence: entry?.evidence,
      unclear: entry?.unclear,
    };
  });
}
