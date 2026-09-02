/**
 * Who was in a meeting, as recorded from the calendar event that started it.
 *
 * Everything here is pure. It mirrors `MeetingAttendee` in
 * rust-sidecar/src/models.rs -- same shape, same caps, same sanitization
 * discipline -- because the sidecar stores the list on the recording and the
 * renderer is not the only thing that reads it back.
 *
 * The one rule that is not about shape: **names may reach a prompt, addresses
 * never do.** An attendee list is the reader's contact book by another name,
 * and a summary lane pointed at a cloud provider would otherwise carry it
 * there for no benefit at all -- a model does not answer better for knowing
 * someone's employer domain. `attendeeNamesForContext` is the only function
 * that produces prompt-bound text, and it drops `email` on the floor.
 */

export interface MeetingAttendee {
  name: string;
  /** From the calendar's `mailto:`, when it had one. Never enters a prompt. */
  email: string | null;
  isOrganizer: boolean;
}

/** Mirrors `MAX_MEETING_ATTENDEES` in rust-sidecar/src/models.rs. */
export const MAX_MEETING_ATTENDEES = 40;
const MAX_ATTENDEE_FIELD_LENGTH = 256;

/**
 * Characters that steer rendering rather than saying anything: C0/C1
 * controls, the bidi marks and isolates (U+200E/U+200F, U+202A-U+202E,
 * U+2066-U+2069), the zero-width joiners and the BOM.
 *
 * Whitespace collapsing does not touch them -- `\s` does not match U+202E --
 * so a name of "Dana\u202Ekafo" used to survive the whole sanitizer. It
 * matters because an attendee name is rendered beside other text in the
 * meeting header, written verbatim into an export, and placed inside a fenced
 * block in a prompt. A right-to-left override reverses everything drawn after
 * it, which is how one line is made to read as another. The name is calendar
 * text somebody else wrote: exactly the text that must not be able to.
 *
 * Mirrors `is_formatting_control` in rust-sidecar/src/models.rs.
 */
const FORMATTING_CONTROLS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Strip the steering characters, then collapse runs of whitespace.
 *
 * In that order: a control character is not whitespace, so collapsing first
 * would leave the override in, and stripping afterwards would leave a double
 * space behind. Mirrors `collapse_whitespace` in rust-sidecar/src/models.rs.
 */
export function normalizeAttendeeText(value: string): string {
  return value.replace(FORMATTING_CONTROLS, "").replace(/\s+/g, " ").trim();
}

interface CalendarAttendeeLike {
  name: string;
  email: string | null;
  isOrganizer: boolean;
  isCurrentUser: boolean;
}

/**
 * How two attendee entries are recognized as the same person.
 *
 * Address first, because display names differ between accounts ("J. Reed" in
 * one invite, "Jonathan Reed" in another) and an address does not. Name only
 * when there is no address, lowercased and whitespace-collapsed so casing and
 * a double space do not split one person into two chips.
 */
export function attendeeIdentityKey(attendee: {
  name: string;
  email?: string | null;
}): string {
  const email = normalizeAttendeeText(attendee.email ?? "").toLowerCase();
  if (email) return `email:${email}`;
  return `name:${normalizeAttendeeText(attendee.name).toLowerCase()}`;
}

function clip(value: string): string {
  const collapsed = normalizeAttendeeText(value);
  return collapsed.length > MAX_ATTENDEE_FIELD_LENGTH
    ? collapsed.slice(0, MAX_ATTENDEE_FIELD_LENGTH).trimEnd()
    : collapsed;
}

/**
 * Trim, de-duplicate and cap a list, whatever produced it.
 *
 * Run on every path that builds one -- calendar prefill, manual entry, a list
 * loaded back from the database -- so a duplicated invite or a hand-edited
 * database row cannot put the same person on the header twice.
 */
export function sanitizeMeetingAttendees(
  attendees: readonly MeetingAttendee[] | null | undefined,
): MeetingAttendee[] {
  const seen = new Set<string>();
  const result: MeetingAttendee[] = [];
  for (const attendee of attendees ?? []) {
    const name = clip(attendee?.name ?? "");
    if (!name) continue;
    const email = attendee?.email ? clip(attendee.email) : null;
    const key = attendeeIdentityKey({ name, email });
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ name, email: email || null, isOrganizer: attendee.isOrganizer === true });
    if (result.length >= MAX_MEETING_ATTENDEES) break;
  }
  return result;
}

/**
 * The attendee list a meeting started from a calendar cue keeps.
 *
 * The current user is dropped. The header chips answer "who else was in
 * this", and the reader already knows they were there; keeping the row would
 * also make every attendee-overlap match trivially true, because every
 * meeting the reader attended shares the reader.
 */
export function meetingAttendeesFromCalendar(
  attendees: readonly CalendarAttendeeLike[] | null | undefined,
): MeetingAttendee[] {
  return sanitizeMeetingAttendees(
    (attendees ?? [])
      .filter((attendee) => !attendee.isCurrentUser)
      .map((attendee) => ({
        name: attendee.name,
        email: attendee.email,
        isOrganizer: attendee.isOrganizer,
      })),
  );
}

/**
 * Add one attendee the reader typed, for a meeting that started without a
 * calendar event behind it.
 *
 * Returns the list unchanged when the name is empty or the person is already
 * on it, so the caller can treat "nothing happened" and "added" the same way
 * without a second identity check.
 */
export function addManualAttendee(
  attendees: readonly MeetingAttendee[],
  name: string,
  email?: string | null,
): MeetingAttendee[] {
  const trimmed = normalizeAttendeeText(name);
  if (!trimmed) return [...attendees];
  return sanitizeMeetingAttendees([
    ...attendees,
    { name: trimmed, email: normalizeAttendeeText(email ?? "") || null, isOrganizer: false },
  ]);
}

export function removeAttendee(
  attendees: readonly MeetingAttendee[],
  key: string,
): MeetingAttendee[] {
  return attendees.filter((attendee) => attendeeIdentityKey(attendee) !== key);
}

/**
 * The names, and only the names, for a grounded prompt's "Attendees:" line.
 *
 * Addresses are dropped here rather than at the call site so there is exactly
 * one place to check. Order is preserved; duplicates cannot occur because the
 * list was sanitized on the way in.
 */
export function attendeeNamesForContext(
  attendees: readonly MeetingAttendee[] | null | undefined,
): string[] {
  return (attendees ?? [])
    .map((attendee) => normalizeAttendeeText(attendee.name))
    .filter(Boolean);
}

/**
 * Suggested speaker names for the rename flow, most-likely first.
 *
 * The organizer leads: on a two-or-three-person call they are the likeliest
 * person who is not the reader. Everything else keeps calendar order.
 */
export function attendeeNameSuggestions(
  attendees: readonly MeetingAttendee[] | null | undefined,
): string[] {
  const names = attendeeNamesForContext(attendees);
  const organizers = (attendees ?? [])
    .filter((attendee) => attendee.isOrganizer)
    .map((attendee) => normalizeAttendeeText(attendee.name))
    .filter(Boolean);
  const seen = new Set<string>();
  return [...organizers, ...names].filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
