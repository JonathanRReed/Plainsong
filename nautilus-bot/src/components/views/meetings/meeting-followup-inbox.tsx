import { useCallback, useEffect, useRef, useState } from "react";

import { ActionItemChip } from "@/components/views/meetings/action-item-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseStoredActionItem } from "@/lib/action-items";
import {
  listMeetingFollowups,
  type MeetingFollowup,
} from "@/lib/backend/meeting-followups";
import { setMeetingActionCompleted } from "@/lib/backend/meeting-actions";

const PAGE_SIZE = 25;

function followupKey(item: MeetingFollowup): string {
  return `${item.recordingId}\u0000${item.task}`;
}

function appendUnique(
  current: readonly MeetingFollowup[],
  incoming: readonly MeetingFollowup[],
): MeetingFollowup[] {
  const seen = new Set(current.map(followupKey));
  return [
    ...current,
    ...incoming.filter((item) => {
      const key = followupKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}

export function MeetingFollowupInbox({
  onOpenMeeting,
}: {
  onOpenMeeting: (recordingId: string, task: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [items, setItems] = useState<MeetingFollowup[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [writeKey, setWriteKey] = useState<string | null>(null);
  const [writeNotice, setWriteNotice] = useState<{ kind: "status" | "error"; text: string } | null>(null);
  const filtersRef = useRef({ query: "", includeCompleted: false });
  const generationRef = useRef(0);
  const writeGenerationRef = useRef(0);
  const writeBusyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      writeGenerationRef.current += 1;
      writeBusyRef.current = false;
    };
  }, []);

  const loadFirstPage = useCallback(async (generation: number) => {
    setLoading(true);
    setError(null);
    try {
      const filters = filtersRef.current;
      const result = await listMeetingFollowups({
        query: filters.query.trim() || undefined,
        offset: 0,
        limit: PAGE_SIZE,
        includeCompleted: filters.includeCompleted,
      });
      if (!mountedRef.current || generationRef.current !== generation) return;
      if (!Array.isArray(result.items)) throw new Error("Invalid follow-up page");
      setItems(result.items);
      setNextOffset(result.nextOffset);
    } catch {
      if (!mountedRef.current || generationRef.current !== generation) return;
      setError("Follow-ups could not be loaded. Please try again.");
    } finally {
      if (mountedRef.current && generationRef.current === generation) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const generation = generationRef.current;
    void loadFirstPage(generation);
  }, [expanded, query, includeCompleted, loadFirstPage]);

  const resetForFilterChange = () => {
    generationRef.current += 1;
    setItems([]);
    setNextOffset(null);
    setLoading(false);
    setLoadingMore(false);
    setError(null);
    setWriteNotice(null);
  };

  const handleLoadMore = async () => {
    if (nextOffset === null || loadingMore) return;
    const generation = generationRef.current;
    const offset = nextOffset;
    setLoadingMore(true);
    setError(null);
    try {
      const filters = filtersRef.current;
      const result = await listMeetingFollowups({
        query: filters.query.trim() || undefined,
        offset,
        limit: PAGE_SIZE,
        includeCompleted: filters.includeCompleted,
      });
      if (!mountedRef.current || generationRef.current !== generation) return;
      if (!Array.isArray(result.items)) throw new Error("Invalid follow-up page");
      setItems((current) => appendUnique(current, result.items));
      setNextOffset(result.nextOffset);
    } catch {
      if (!mountedRef.current || generationRef.current !== generation) return;
      setError("More follow-ups could not be loaded. Please try again.");
    } finally {
      if (mountedRef.current && generationRef.current === generation) setLoadingMore(false);
    }
  };

  const handleCompletionChange = async (item: MeetingFollowup, completed: boolean) => {
    if (writeBusyRef.current) return;
    writeBusyRef.current = true;
    const key = followupKey(item);
    const contextGeneration = generationRef.current;
    const writeGeneration = writeGenerationRef.current + 1;
    writeGenerationRef.current = writeGeneration;
    setWriteKey(key);
    setWriteNotice(null);
    try {
      await setMeetingActionCompleted(item.recordingId, item.task, completed);
      if (
        !mountedRef.current
        || writeGenerationRef.current !== writeGeneration
      ) return;
      if (generationRef.current === contextGeneration) {
        setWriteNotice({ kind: "status", text: "Follow-up saved." });
      }
      // The write may have finished after filters changed. Refresh the current
      // filters, never the initiating view, and invalidate any older page.
      generationRef.current += 1;
      setItems([]);
      setNextOffset(null);
      setLoadingMore(false);
      await loadFirstPage(generationRef.current);
    } catch {
      if (
        !mountedRef.current
        || writeGenerationRef.current !== writeGeneration
      ) return;
      setWriteNotice({ kind: "error", text: "Couldn't confirm the follow-up was saved. Please try again." });
    } finally {
      if (writeGenerationRef.current === writeGeneration) {
        writeBusyRef.current = false;
        if (mountedRef.current) setWriteKey(null);
      }
    }
  };

  return (
    <section className="border-t border-border pt-5">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between rounded-lg px-1 py-2 text-left text-foreground hover:text-gold-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>
          <span className="block font-serif text-lg font-semibold">Follow-ups</span>
          <span className="block text-sm text-muted-foreground">From saved meeting action items</span>
        </span>
        <span aria-hidden="true" className="text-gold-text">{expanded ? "−" : "+"}</span>
      </button>

      {expanded ? (
        <div className="mt-4 space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Input
              type="search"
              aria-label="Search follow-ups"
              placeholder="Search follow-ups"
              value={query}
              onChange={(event) => {
                resetForFilterChange();
                filtersRef.current = { ...filtersRef.current, query: event.target.value };
                setQuery(event.target.value);
              }}
            />
            <div className="flex shrink-0 gap-1 rounded-lg border border-border bg-muted/20 p-1" aria-label="Follow-up status filter">
              <Button
                size="sm"
                variant={includeCompleted ? "ghost" : "active"}
                aria-pressed={!includeCompleted}
                onClick={() => {
                  if (!includeCompleted) return;
                  resetForFilterChange();
                  filtersRef.current = { ...filtersRef.current, includeCompleted: false };
                  setIncludeCompleted(false);
                }}
              >Open</Button>
              <Button
                size="sm"
                variant={includeCompleted ? "active" : "ghost"}
                aria-pressed={includeCompleted}
                onClick={() => {
                  if (includeCompleted) return;
                  resetForFilterChange();
                  filtersRef.current = { ...filtersRef.current, includeCompleted: true };
                  setIncludeCompleted(true);
                }}
              >All</Button>
            </div>
          </div>

          {error ? (
            <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-rust/30 bg-rust/10 px-3 py-2 text-sm text-rust">
              <span>{error}</span>
              <Button variant="outline" size="sm" onClick={() => {
                generationRef.current += 1;
                void loadFirstPage(generationRef.current);
              }}>Retry</Button>
            </div>
          ) : null}

          {writeNotice ? (
            <p role={writeNotice.kind === "error" ? "alert" : "status"} className={writeNotice.kind === "error" ? "text-sm text-rust" : "text-sm text-muted-foreground"}>
              {writeNotice.text}
            </p>
          ) : null}

          {items.length > 0 ? (
            <ul className="divide-y divide-border rounded-xl border border-border bg-card/50">
              {items.map((item) => {
                const parsed = parseStoredActionItem(item.task);
                const key = followupKey(item);
                return (
                  <li key={key} className="flex gap-3 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={item.completed}
                      disabled={writeKey !== null}
                      aria-label={`Mark ${parsed.task} ${item.completed ? "incomplete" : "done"}`}
                      onChange={(event) => void handleCompletionChange(item, event.target.checked)}
                      className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-gold disabled:cursor-wait"
                    />
                    <div className="min-w-0 flex-1">
                      <p className={`font-serif text-sm leading-relaxed ${item.completed ? "text-muted-foreground line-through" : "text-foreground"}`}>{parsed.task}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        {item.needsReview ? <span className="text-xs text-rust">Needs source review</span> : null}
                        {parsed.owner ? <ActionItemChip label="Owner" value={parsed.owner} /> : null}
                        {parsed.dueDate ? <ActionItemChip label="Due" value={parsed.dueDate} /> : null}
                        <button
                          type="button"
                          disabled={writeKey === key}
                          aria-label={`Open ${parsed.task} in ${item.meetingTitle}`}
                          onClick={() => onOpenMeeting(item.recordingId, item.task)}
                          className="text-sm text-gold-text underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-50"
                        >{item.meetingTitle}</button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : loading ? (
            <p role="status" className="py-4 text-sm text-muted-foreground">Loading follow-ups…</p>
          ) : !error ? (
            <p className="py-4 text-sm text-muted-foreground">No follow-ups match this view.</p>
          ) : null}

          {nextOffset !== null && items.length > 0 ? (
            <Button variant="outline" onClick={() => void handleLoadMore()} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
