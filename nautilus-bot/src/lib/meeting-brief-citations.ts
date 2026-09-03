/**
 * Turning a brief's raw `Ln` evidence IDs into references a reader can follow.
 *
 * The sidecar builds the brief's evidence out of prior MEETINGS, one line per
 * summary, decision or open item, and the model cites them by the line ID the
 * grounded runner assigned -- `L1`, `L4`. Those IDs are an internal address.
 * Left in the rendered text they are noise the reader cannot resolve: there is
 * no `L4` anywhere on the surface to look at.
 *
 * So the panel numbers them. Each citation gets a position, the text's tokens
 * are rewritten to match, and the numbered list underneath names the meeting
 * each one came from — which is the thing the reader actually wants to open.
 *
 * A token whose ID is not in `citations` is left exactly as the model wrote
 * it. Inventing a number for it would be claiming the brief cites something it
 * does not; the panel already says so out loud when `grounded` is false.
 *
 * Everything here is pure.
 */

import type {
  MeetingBriefCitation,
  RelatedMeeting,
} from "@/lib/backend/calendar";

export interface BriefReference {
  /** 1-based, and the number written into the text. */
  number: number;
  /** The evidence line this reference stands for, when it had an ID. */
  lineId: string | null;
  /** The meeting it came from, when the sidecar attributed one. */
  recordingId: string | null;
  /** That meeting's title, when it is one of the related meetings shown. */
  title: string | null;
  /** The cited evidence itself. */
  text: string;
}

export interface NumberedBrief {
  /** The brief with each resolvable `Ln` rewritten as its `[n]`. */
  text: string;
  references: BriefReference[];
}

/**
 * Number a brief's citations and rewrite the text to match.
 *
 * Numbers follow the order the sidecar returned the citations in, so the list
 * reads in the order the model built its answer, and a citation with no line
 * ID still gets a number and a place on the list rather than disappearing.
 */
export function numberBriefCitations(
  brief: string,
  citations: readonly MeetingBriefCitation[] | null | undefined,
  related: readonly RelatedMeeting[] | null | undefined,
): NumberedBrief {
  const titles = new Map(
    (related ?? []).map((meeting) => [meeting.recordingId, meeting.title]),
  );

  const references: BriefReference[] = [];
  const numberByLineId = new Map<string, number>();
  for (const citation of citations ?? []) {
    const lineId = citation.lineId?.trim() || null;
    // One number per line ID: a model that cites the same evidence twice is
    // pointing at one source, and two identical rows would read as two.
    if (lineId && numberByLineId.has(lineId)) continue;
    const recordingId = citation.recordingId?.trim() || null;
    const number = references.length + 1;
    if (lineId) numberByLineId.set(lineId, number);
    references.push({
      number,
      lineId,
      recordingId,
      title: (recordingId ? titles.get(recordingId) : undefined) ?? null,
      text: citation.text,
    });
  }

  const text = brief
    .replace(/\bL(\d+)\b/g, (token, digits: string) => {
      const number = numberByLineId.get(`L${digits}`);
      return number === undefined ? token : `[${number}]`;
    })
    // A model that already wrote its ID in brackets would otherwise end up
    // with "[[2]]".
    .replace(/\[\[(\d+)\]\]/g, "[$1]");

  return { text, references };
}
