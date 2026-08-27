import {
  getMeetingTemplateOption,
  MEETING_TEMPLATES,
  type CustomMeetingTemplate,
} from "@/lib/meeting-templates";

/** Holds whatever the user wrote above the first recognised heading. Exported
 * so callers building a template outline from a note's current sections (see
 * "Save current structure as a template" in recordings-view.tsx) can exclude
 * this catch-all bucket -- it is not a reusable outline heading. */
export const GENERAL_MEETING_NOTES_TITLE = "General notes";

export type MeetingNoteSection = {
  title: string;
  body: string;
  isTemplateSection: boolean;
  hasExplicitPlaceholder: boolean;
  /** True when the section was actually present in the saved note text. A
   * scaffold synthesised from the template outline is false, so an untouched
   * outline is never written to disk — but anything that came from the user's
   * text is kept even when its body is empty. */
  isFromNotes: boolean;
};

function normalizeMeetingSectionTitle(value: string): string {
  return value.trim().toLowerCase();
}

/** Every heading a built-in template can lay down, plus the general block.
 * These read back as headings on sight and write back bare, so a note the
 * outline created round-trips byte for byte. A bare line that is not one of
 * these is only a heading in the one narrow case below; terse notes ("ship
 * date slipped") are the primary input here, so guessing at short lines is
 * not allowed. Fixed at module load because the built-in set never changes;
 * a user's custom templates do, so those titles are unioned in per call by
 * `knownBareSectionTitles` below rather than baked in here. */
const BUILTIN_KNOWN_BARE_SECTION_TITLES = new Set<string>([
  normalizeMeetingSectionTitle(GENERAL_MEETING_NOTES_TITLE),
  ...MEETING_TEMPLATES.flatMap((template) =>
    template.notesOutline.map((title) => normalizeMeetingSectionTitle(title))
  ),
]);

/** The built-in known-bare-title set, plus the outline headings of the one
 * template actually resolved for this note. A custom template's own
 * headings need the exact same bare-round-trip treatment a built-in's do --
 * otherwise they would only be recognised as headings via the
 * bulleted-title heuristic, which stops working the moment the user
 * replaces the placeholder bullet with real text.
 *
 * Deliberately narrow: this takes one template's outline, not the caller's
 * whole custom-template list. Unioning every saved template's headings in
 * regardless of which one a given note actually uses let one template's
 * "Sentiment" section promote a bare "Sentiment" line to a heading in a
 * completely unrelated meeting using a different template -- and the next
 * edit would write that reordering to disk. */
function knownBareSectionTitles(templateOutline: readonly string[]): Set<string> {
  if (templateOutline.length === 0) {
    return BUILTIN_KNOWN_BARE_SECTION_TITLES;
  }
  return new Set([
    ...BUILTIN_KNOWN_BARE_SECTION_TITLES,
    ...templateOutline.map((title) => normalizeMeetingSectionTitle(title)),
  ]);
}

/** Sections the user created by hand carry an explicit markdown marker so they
 * survive a reload without the parser having to guess. */
const EXPLICIT_SECTION_HEADING = /^#{1,6}[ \t]+(\S.*)$/;

/** Anything that reads as a list item, so it is never mistaken for a title. */
const MEETING_NOTE_LIST_ITEM = /^(?:[-*•]|\d+[.)])(?:\s|$)/;
/** The narrower shape every bare heading this app ever wrote was followed by:
 * the template outline laid down `Title\n- `, and so did the old enhance
 * action. A numbered line is left out on purpose — it is more often an
 * enumeration under a sentence than a list under a title. */
const MEETING_NOTE_DASH_ITEM = /^[-*•](?:\s|$)/;

/** Notes written before sections carried the `##` marker used a bare title with
 * a bullet list under it. Reading that shape back as a heading is what keeps a
 * pre-upgrade note's hand-made sections from collapsing into the one above
 * them. The bullet underneath is the whole tell: terse prose on its own line
 * ("ship date slipped") has nothing under it and stays body text, which is the
 * case this parser must never get wrong. A title recognised this way is written
 * back with the explicit marker, so the note only shifts shape once. */
function looksLikeBulletedSectionTitle(
  title: string,
  nextLine: string | undefined
): boolean {
  if (!title || title.length > 72 || MEETING_NOTE_LIST_ITEM.test(title)) {
    return false;
  }
  if (/[.!?]$/.test(title) || title.split(/\s+/).length > 10) {
    return false;
  }
  return nextLine !== undefined && MEETING_NOTE_DASH_ITEM.test(nextLine.trim());
}

function readMeetingSectionHeading(
  line: string,
  nextLine: string | undefined,
  knownTitles: Set<string>
): string | null {
  const trimmed = line.trim();
  const explicit = EXPLICIT_SECTION_HEADING.exec(trimmed);
  if (explicit) {
    return explicit[1].trim();
  }
  if (!trimmed) {
    return null;
  }
  if (knownTitles.has(normalizeMeetingSectionTitle(trimmed))) {
    return trimmed;
  }
  return looksLikeBulletedSectionTitle(trimmed, nextLine) ? trimmed : null;
}

/** A known heading writes back bare so existing notes round-trip byte for byte;
 * a hand-made title gets the explicit marker so it is still a heading next
 * time the note is parsed. */
function formatMeetingSectionTitle(title: string, knownTitles: Set<string>): string {
  return knownTitles.has(normalizeMeetingSectionTitle(title)) ? title : `## ${title}`;
}

/** Sections back to text. This is lossless by contract: nothing the user typed
 * is dropped, so re-serializing on every keystroke can never delete a section.
 * `templateId`/`customTemplates` should match the `parseMeetingNoteSections`
 * call that produced `sections`, so the same one resolved template's own
 * headings keep round-tripping bare -- not every template the caller happens
 * to have on hand. */
export function serializeMeetingNoteSections(
  sections: MeetingNoteSection[],
  templateId?: string | null,
  customTemplates: readonly CustomMeetingTemplate[] = []
): string {
  const template = getMeetingTemplateOption(templateId, customTemplates);
  const knownTitles = knownBareSectionTitles(template.notesOutline);
  return sections
    .flatMap((section) => {
      const title = section.title.trim();
      const body = section.body.trimEnd();

      if (!title) {
        // A title-less block can still hold text — keep the text, not the shape.
        return body ? [body] : [];
      }

      const titleLine = formatMeetingSectionTitle(title, knownTitles);
      if (body) {
        return [`${titleLine}\n${body}`];
      }
      if (section.hasExplicitPlaceholder) {
        return [`${titleLine}\n- `];
      }
      // Only a scaffold the template synthesised is dropped when empty.
      return section.isFromNotes ? [titleLine] : [];
    })
    .join("\n\n");
}

export function parseMeetingNoteSections(
  notes: string,
  templateId: string | null | undefined,
  customTemplates: readonly CustomMeetingTemplate[] = []
): MeetingNoteSection[] {
  const template = getMeetingTemplateOption(templateId, customTemplates);
  const knownTitles = knownBareSectionTitles(template.notesOutline);
  const templateTitles = new Set(
    template.notesOutline.map((title) => normalizeMeetingSectionTitle(title))
  );
  const generalTitle = normalizeMeetingSectionTitle(GENERAL_MEETING_NOTES_TITLE);

  const parsedSections: MeetingNoteSection[] = [];
  const leadingLines: string[] = [];
  let openTitle: string | null = null;
  let openBodyLines: string[] = [];

  const closeOpenSection = () => {
    if (openTitle === null) {
      return;
    }
    const body = openBodyLines.join("\n").trimEnd();
    const hasExplicitPlaceholder = body.trim() === "-";
    parsedSections.push({
      title: openTitle,
      body: hasExplicitPlaceholder ? "" : body,
      isTemplateSection: templateTitles.has(normalizeMeetingSectionTitle(openTitle)),
      hasExplicitPlaceholder,
      isFromNotes: true,
    });
    openTitle = null;
    openBodyLines = [];
  };

  // A heading only opens a section at the start of a block, so a blank line
  // inside a body keeps the paragraph after it attached to the same section
  // instead of shunting it somewhere else.
  const lines = notes.split("\n");
  lines.forEach((line, index) => {
    const startsBlock = index === 0 || lines[index - 1].trim() === "";
    const heading = startsBlock
      ? readMeetingSectionHeading(line, lines[index + 1], knownTitles)
      : null;
    if (heading !== null) {
      closeOpenSection();
      openTitle = heading;
      return;
    }
    if (openTitle === null) {
      leadingLines.push(line);
    } else {
      openBodyLines.push(line);
    }
  });
  closeOpenSection();

  const consumed = new Set<MeetingNoteSection>();
  const sections: MeetingNoteSection[] = [];

  const generalSections = parsedSections.filter(
    (section) => normalizeMeetingSectionTitle(section.title) === generalTitle
  );
  generalSections.forEach((section) => consumed.add(section));
  const generalBody = [
    leadingLines.join("\n").trim(),
    ...generalSections.map((section) => section.body),
  ]
    .filter(Boolean)
    .join("\n\n");

  if (generalBody || generalSections.length > 0) {
    sections.push({
      title: GENERAL_MEETING_NOTES_TITLE,
      body: generalBody,
      isTemplateSection: false,
      hasExplicitPlaceholder: false,
      isFromNotes: true,
    });
  }

  for (const title of template.notesOutline) {
    const normalizedTitle = normalizeMeetingSectionTitle(title);
    const matchedSection = parsedSections.find(
      (section) =>
        !consumed.has(section) &&
        normalizeMeetingSectionTitle(section.title) === normalizedTitle
    );
    if (matchedSection) {
      consumed.add(matchedSection);
    }
    sections.push(
      matchedSection ?? {
        title,
        body: "",
        isTemplateSection: true,
        hasExplicitPlaceholder: false,
        isFromNotes: false,
      }
    );
  }

  for (const section of parsedSections) {
    if (consumed.has(section)) {
      continue;
    }
    sections.push({ ...section, isTemplateSection: false });
  }

  return sections;
}

export function getNextMeetingSectionTitle(sections: MeetingNoteSection[]): string {
  const baseTitle = "Custom section";
  const usedTitles = new Set(
    sections.map((section) => normalizeMeetingSectionTitle(section.title))
  );

  if (!usedTitles.has(normalizeMeetingSectionTitle(baseTitle))) {
    return baseTitle;
  }

  let index = 2;
  while (usedTitles.has(normalizeMeetingSectionTitle(`${baseTitle} ${index}`))) {
    index += 1;
  }

  return `${baseTitle} ${index}`;
}

/** One contiguous edit, expressed as the half-open range of base lines a
 * surface replaced and the lines it put there. */
type MeetingNoteLineEdit = {
  start: number;
  end: number;
  lines: string[];
};

/** Trailing spaces are not meaningful in a note and the sidecar trims what it
 * stores, so lines match on their right-trimmed form. The original line is what
 * gets written back. */
function meetingNoteLineKey(line: string): string {
  return line.trimEnd();
}

function splitMeetingNoteLines(notes: string): string[] {
  return notes ? notes.split("\n") : [];
}

/** Longest common subsequence over lines. Notes are short enough that the plain
 * table beats being clever, and it keeps the merge deterministic. */
function matchMeetingNoteLines(base: string[], other: string[]): Array<[number, number]> {
  const baseKeys = base.map(meetingNoteLineKey);
  const otherKeys = other.map(meetingNoteLineKey);
  const width = other.length + 1;
  const lengths = new Uint32Array((base.length + 1) * width);

  for (let i = base.length - 1; i >= 0; i -= 1) {
    for (let j = other.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        baseKeys[i] === otherKeys[j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }

  const matches: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < base.length && j < other.length) {
    if (baseKeys[i] === otherKeys[j]) {
      matches.push([i, j]);
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return matches;
}

function diffMeetingNoteLines(base: string[], other: string[]): MeetingNoteLineEdit[] {
  const edits: MeetingNoteLineEdit[] = [];
  let baseCursor = 0;
  let otherCursor = 0;

  const record = (baseEnd: number, otherEnd: number) => {
    if (baseCursor < baseEnd || otherCursor < otherEnd) {
      edits.push({
        start: baseCursor,
        end: baseEnd,
        lines: other.slice(otherCursor, otherEnd),
      });
    }
  };

  for (const [baseIndex, otherIndex] of matchMeetingNoteLines(base, other)) {
    record(baseIndex, otherIndex);
    baseCursor = baseIndex + 1;
    otherCursor = otherIndex + 1;
  }
  record(base.length, other.length);

  return edits;
}

/** Three-way merge on lines. Edits that touch different parts of the note both
 * apply as written; edits that land on the same lines keep the stored text and
 * then re-apply whatever the local edit added on top of it. Duplicated text is
 * recoverable by hand, deleted text is not, so an overlap errs toward keeping
 * both — but only for the lines that actually collided, never the whole note. */
function mergeMeetingNoteLines(
  base: string[],
  storedEdits: MeetingNoteLineEdit[],
  localEdits: MeetingNoteLineEdit[]
): string[] {
  // One queue in base order, stored ahead of local on a tie, so a collision
  // reads "the stored lines, then what local added" without juggling cursors.
  const queue = [
    ...storedEdits.map((edit) => ({ ...edit, fromStored: true })),
    ...localEdits.map((edit) => ({ ...edit, fromStored: false })),
  ].sort(
    (left, right) =>
      left.start - right.start || Number(right.fromStored) - Number(left.fromStored)
  );

  const merged: string[] = [];
  let cursor = 0;
  let index = 0;

  while (index < queue.length) {
    const start = queue[index].start;
    let end = queue[index].end;
    const storedLines: string[] = [];
    const localLines: string[] = [];

    // This edit, plus everything that lands inside the range it claims or that
    // inserts at the very same spot — that is the collision.
    while (
      index < queue.length &&
      (queue[index].start < end || queue[index].start === start)
    ) {
      const edit = queue[index];
      end = Math.max(end, edit.end);
      (edit.fromStored ? storedLines : localLines).push(...edit.lines);
      index += 1;
    }

    for (let line = cursor; line < start; line += 1) {
      merged.push(base[line]);
    }
    merged.push(...storedLines);
    const storedKeys = new Set(storedLines.map(meetingNoteLineKey));
    merged.push(
      ...localLines.filter((line) => !storedKeys.has(meetingNoteLineKey(line)))
    );
    cursor = end;
  }

  for (let line = cursor; line < base.length; line += 1) {
    merged.push(base[line]);
  }

  return merged;
}

/** Well past any hand-written note. Past this the merge table is the problem,
 * not the merge. */
const MAX_MERGED_NOTE_LINES = 2000;

/** Resolve a concurrent meeting-note write. The review tab, the live capture
 * panel, and the recording popup all edit the same record, so a save that no
 * longer matches the text it was based on is merged against what is actually
 * stored instead of replacing it. Both surfaces edited the same ancestor, so
 * this is a line-level three-way merge: each side's edits apply where they
 * don't collide, and where they do the stored lines are kept and the local
 * lines added after them. */
export function rebaseMeetingNotes(args: {
  base: string;
  local: string;
  stored: string;
}): string {
  // The sidecar trims notes on write, so compare on trimmed text.
  const base = args.base.trim();
  const local = args.local.trim();
  const stored = args.stored.trim();

  if (!stored || stored === base || stored === local) {
    return args.local;
  }
  if (local === base) {
    return args.stored;
  }

  const baseLines = splitMeetingNoteLines(base);
  const localLines = splitMeetingNoteLines(local);
  const storedLines = splitMeetingNoteLines(stored);

  if (
    baseLines.length > MAX_MERGED_NOTE_LINES ||
    localLines.length > MAX_MERGED_NOTE_LINES ||
    storedLines.length > MAX_MERGED_NOTE_LINES
  ) {
    // Clumsy, but keeping both sides is still the safe direction.
    return `${stored}\n\n${local}`;
  }

  return mergeMeetingNoteLines(
    baseLines,
    diffMeetingNoteLines(baseLines, storedLines),
    diffMeetingNoteLines(baseLines, localLines)
  ).join("\n");
}
