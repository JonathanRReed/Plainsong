import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, X } from "lucide-react";
import {
  MAX_MEETING_ATTENDEES,
  addManualAttendee,
  attendeeIdentityKey,
  removeAttendee,
  type MeetingAttendee,
} from "@/lib/attendees";

interface MeetingAttendeesProps {
  attendees: readonly MeetingAttendee[];
  /** Persists a whole list. The header re-renders from what comes back. */
  onChange: (next: MeetingAttendee[]) => void;
  /** A finished meeting is still editable; a missing recording is not. */
  disabled?: boolean;
}

/**
 * Who was in this meeting, as a row of neutral chips.
 *
 * Neutral on purpose. An attendee is not a state — nobody here is ready or
 * not-yet or in error — so there is no gold and no rust on this row, and no
 * neume. It is a fact about the meeting, sitting in the same muted register
 * as the date and the duration beside it.
 *
 * The address, when there is one, lives on the chip's `title` and nowhere
 * else visible: it is what makes the same person recognizable across two
 * meetings, and it is not something anyone needs to read in a header.
 */
export function MeetingAttendees({
  attendees,
  onChange,
  disabled = false,
}: MeetingAttendeesProps) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const atCapacity = attendees.length >= MAX_MEETING_ATTENDEES;

  const commitDraft = () => {
    const next = addManualAttendee(attendees, draft);
    setDraft("");
    setAdding(false);
    if (next.length !== attendees.length) {
      onChange(next);
    }
  };

  if (attendees.length === 0 && !adding) {
    return (
      <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
        <span>
          No attendees recorded. Meetings started from a calendar event keep
          their invitee list.
        </span>
        {disabled ? null : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-auto px-2 py-1 text-sm"
            onClick={() => setAdding(true)}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add attendee
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Attendees">
      {attendees.map((attendee) => {
        const key = attendeeIdentityKey(attendee);
        return (
          <span
            key={key}
            // `title`, not a visible line: the address is for recognition,
            // not for reading.
            title={attendee.email ?? undefined}
            className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/30 px-2 py-0.5 text-sm text-muted-foreground"
          >
            {attendee.name}
            {attendee.isOrganizer ? (
              <span className="text-sm text-muted-foreground">· organizer</span>
            ) : null}
            {disabled ? null : (
              <button
                type="button"
                aria-label={`Remove ${attendee.name}`}
                className="ml-0.5 rounded-sm opacity-60 hover:opacity-100"
                onClick={() => onChange(removeAttendee(attendees, key))}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </span>
        );
      })}

      {adding ? (
        <span className="inline-flex items-center gap-1">
          <Input
            aria-label="Attendee name"
            autoFocus
            value={draft}
            className="h-7 w-44 text-sm"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitDraft();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft("");
                setAdding(false);
              }
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-sm"
            disabled={!draft.trim()}
            onClick={commitDraft}
          >
            Add
          </Button>
        </span>
      ) : disabled || atCapacity ? null : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-auto px-2 py-0.5 text-sm text-muted-foreground"
          onClick={() => setAdding(true)}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add attendee
        </Button>
      )}
    </div>
  );
}
