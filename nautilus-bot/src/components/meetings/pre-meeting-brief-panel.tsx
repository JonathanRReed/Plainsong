import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import {
  prepareMeetingBrief,
  type MeetingBriefResult,
  type RelatedMeeting,
} from "@/lib/backend/calendar";
import { meetingAttendeesFromCalendar } from "@/lib/attendees";
import type { CalendarEventSummary } from "@/lib/calendar-events";

interface PreMeetingBriefPanelProps {
  event: CalendarEventSummary;
  /** Opens a prior meeting the brief cited. */
  onOpenMeeting?: (recordingId: string) => void;
}

function describeReason(meeting: RelatedMeeting): string {
  const parts: string[] = [];
  if (meeting.reason.sharedAttendees > 0) {
    const names = meeting.sharedAttendeeNames.join(", ");
    parts.push(
      meeting.reason.sharedAttendees === 1
        ? `same person: ${names}`
        : `${meeting.reason.sharedAttendees} of the same people: ${names}`,
    );
  }
  if (meeting.reason.titleMatch) {
    parts.push("same meeting name");
  }
  return parts.join(" · ");
}

/**
 * What Plainsong already knows about the meeting you are about to join.
 *
 * Built from meetings already on this Mac — ones that share an attendee or a
 * name with the upcoming event — and run through whichever AI lane the reader
 * chose for meetings. Nothing is fetched and no calendar beyond this event is
 * read.
 *
 * Three honest states, and no fourth:
 *
 *   - nothing on this Mac relates to it   → say so, offer nothing
 *   - related meetings but no AI route    → the raw list, and the reason
 *   - a brief                             → the brief, with its sources
 *
 * The middle one is the important one. A Mac with no analysis provider still
 * gets the list of prior meetings and their open items, which is most of what
 * a brief is; showing an error there would be hiding data the app has.
 */
export function PreMeetingBriefPanel({
  event,
  onOpenMeeting,
}: PreMeetingBriefPanelProps) {
  const [result, setResult] = useState<MeetingBriefResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      setResult(
        await prepareMeetingBrief({
          eventId: event.id,
          title: event.title,
          attendees: meetingAttendeesFromCalendar(event.attendees),
          refresh,
        }),
      );
    } catch (caught) {
      console.error("Failed to prepare the meeting brief:", caught);
      setError(
        caught instanceof Error
          ? caught.message
          : "Plainsong could not prepare a brief for this meeting.",
      );
    } finally {
      setLoading(false);
    }
  };

  if (!result && !loading && !error) {
    return (
      <div className="mt-2">
        <Button size="sm" variant="outline" onClick={() => void run(false)}>
          Prepare
        </Button>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Reads meetings already on this Mac that share a person or a name with
          this one.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-border/80 bg-background/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="section-heading">Before this meeting</p>
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => void run(true)}
        >
          {loading ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              Reading your meetings…
            </>
          ) : (
            "Refresh"
          )}
        </Button>
      </div>

      {error ? (
        <p className="mt-2 text-sm text-rust">{error}</p>
      ) : null}

      {result?.state === "no_sources" ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No meeting on this Mac shares a person or a name with this one, so
          there is nothing to brief from yet.
        </p>
      ) : null}

      {result?.state === "sources_only" ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {result.unavailableReason
            ? `No written brief: ${result.unavailableReason} The meetings it would have been written from are below.`
            : "No written brief. The meetings it would have been written from are below."}
        </p>
      ) : null}

      {result?.brief ? (
        <>
          <p className="mt-2 whitespace-pre-wrap text-sm">{result.brief}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {`Written by ${result.actualProvider ?? "the analysis provider"}${
              result.model ? ` (${result.model})` : ""
            } from ${result.related.length} earlier ${
              result.related.length === 1 ? "meeting" : "meetings"
            } on this Mac${result.cached ? ", from cache" : ""}.`}
          </p>
          {result.grounded === false ? (
            <p className="mt-1 text-sm text-rust">
              Some of this brief could not be traced back to a cited meeting.
              Check it against the sources below.
            </p>
          ) : null}
        </>
      ) : null}

      {result && result.related.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {result.related.map((meeting) => (
            <li key={meeting.recordingId} className="border-t pt-2 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{meeting.title}</p>
                <span className="time-spec text-sm text-muted-foreground">
                  {new Date(meeting.createdAt).toLocaleDateString()}
                </span>
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {describeReason(meeting)}
              </p>
              {meeting.openItems.length > 0 ? (
                <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
                  {meeting.openItems.map((item, index) => (
                    <li key={`${meeting.recordingId}-item-${index}`}>{item}</li>
                  ))}
                </ul>
              ) : null}
              {onOpenMeeting ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1 h-auto px-2 py-1 text-sm"
                  onClick={() => onOpenMeeting(meeting.recordingId)}
                >
                  Open this meeting
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
