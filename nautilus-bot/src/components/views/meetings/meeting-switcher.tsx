import { useEffect, useRef, useState } from "react";
import { Trigger } from "@radix-ui/react-dialog";
import { ArrowLeftRight, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDateTime } from "@/lib/format-locale";
import type { Recording } from "@/types";

interface MeetingSwitcherProps {
  meetings: Recording[];
  currentId: string;
  onSelect: (meeting: Recording, isCurrent: () => boolean) => Promise<boolean>;
}

const statusLabels: Record<string, string> = {
  completed: "Ready", error: "Failed", recording: "Recording",
  processing: "Processing", pending: "Pending", queued: "Queued",
};
const PAGE_SIZE = 50;

export function MeetingSwitcher({ meetings, currentId, onSelect }: MeetingSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  useEffect(() => {
    generation.current += 1;
    pending.current = false;
    setBusy(false);
    setIssue(false);
    setQuery("");
    setVisibleCount(PAGE_SIZE);
    setOpen(false);
  }, [currentId]);
  useEffect(() => () => { generation.current += 1; }, []);

  const changeOpen = (next: boolean) => {
    generation.current += 1;
    pending.current = false;
    setBusy(false);
    setIssue(false);
    setQuery("");
    setVisibleCount(PAGE_SIZE);
    setOpen(next);
  };
  const select = async (meeting: Recording) => {
    if (pending.current) return;
    if (meeting.id === currentId) { changeOpen(false); return; }
    pending.current = true;
    setBusy(true);
    setIssue(false);
    const request = generation.current;
    const sourceId = currentId;
    const isCurrent = () => generation.current === request && currentIdRef.current === sourceId;
    try {
      const switched = await onSelect(meeting, isCurrent);
      if (!isCurrent()) return;
      if (switched) changeOpen(false);
      else setIssue(true);
    } catch {
      if (isCurrent()) setIssue(true);
    } finally {
      if (isCurrent()) { pending.current = false; setBusy(false); }
    }
  };
  const filtered = meetings.filter(meeting => meeting.sourceType === "meeting"
    && meeting.title.toLocaleLowerCase("en-US").includes(query.trim().toLocaleLowerCase("en-US")));

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <Trigger asChild>
        <Button variant="ghost" size="sm">
          <ArrowLeftRight className="mr-2 h-4 w-4" />
          Switch meeting
        </Button>
      </Trigger>
      <DialogContent className="w-[calc(100%-2rem)] max-w-lg rounded-lg">
        <DialogHeader>
          <DialogTitle>Switch meeting</DialogTitle>
          <DialogDescription>
            Choose another meeting. Your edits are saved before you leave.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Find a meeting"
          placeholder="Search meeting titles"
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            setVisibleCount(PAGE_SIZE);
          }}
        />
        <div className="max-h-[50vh] overflow-y-auto p-1" aria-label="Meetings to open" aria-busy={busy}>
          {filtered.length ? (
            <ul className="space-y-2">
              {filtered.slice(0, visibleCount).map(meeting => (
                <li key={meeting.id}>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Open meeting: ${meeting.title}`}
                    aria-current={meeting.id === currentId ? "true" : undefined}
                    onClick={() => void select(meeting)}
                    className="flex w-full items-center justify-between gap-3 rounded-md border border-border/70 bg-card/78 px-3 py-3 text-left hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{meeting.title}</span>
                      <span className="mt-1 block font-mono text-xs text-muted-foreground">
                        {formatDateTime(meeting.createdAt)} · {statusLabels[meeting.status] ?? "Draft"}
                      </span>
                    </span>
                    {meeting.id === currentId && (
                      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-gold-text">
                        <Check className="h-3 w-3" />Current
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {query.trim() ? "No meeting titles match." : "No meetings available."}
            </p>
          )}
          {filtered.length > visibleCount && (
            <Button variant="outline" className="mt-3" disabled={busy} onClick={() => setVisibleCount(count => count + PAGE_SIZE)}>
              Show more
            </Button>
          )}
        </div>
        {busy && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />Saving your edits…
          </p>
        )}
        {issue && (
          <p role="alert" className="text-sm text-destructive">
            Finish your edits or retry saving before switching meetings.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
