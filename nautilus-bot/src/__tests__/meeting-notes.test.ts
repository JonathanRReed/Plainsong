import { describe, expect, it } from "vitest";
import {
  getNextMeetingSectionTitle,
  parseMeetingNoteSections,
  rebaseMeetingNotes,
  serializeMeetingNoteSections,
} from "@/lib/meeting-notes";

/** What the note canvas does on every keystroke: parse, apply the edit to one
 * section, serialize, autosave. */
function editSectionBody(
  notes: string,
  templateId: string,
  sectionTitle: string,
  body: string
): string {
  const sections = parseMeetingNoteSections(notes, templateId);
  return serializeMeetingNoteSections(
    sections.map((section) =>
      section.title === sectionTitle ? { ...section, body } : section
    ),
    templateId
  );
}

describe("meeting note sections", () => {
  it("keeps a terse unbulleted line when another section is edited", () => {
    // "ship date slipped" is 3 words, no terminal punctuation, and sits in its
    // own paragraph inside the Decisions body — exactly the shape the old
    // heuristic promoted to an empty heading and then deleted.
    const notes =
      "Goals\nAgree the launch order\n\nDecisions\nlegal signed off\n\nship date slipped";

    const afterKeystroke = editSectionBody(
      notes,
      "auto",
      "Goals",
      "Agree the launch orderr"
    );

    expect(afterKeystroke).toBe(
      "Goals\nAgree the launch orderr\n\nDecisions\nlegal signed off\n\nship date slipped"
    );
    expect(afterKeystroke).toContain("ship date slipped");
  });

  it("survives repeated keystrokes without eroding other sections", () => {
    let notes = "Goals\nfoo\n\nDecisions\nlegal signed off\n\nship date slipped";

    for (const draft of ["f", "fo", "foo", "foo ", "foo b", "foo ba", "foo bar"]) {
      notes = editSectionBody(notes, "auto", "Goals", draft);
    }

    expect(notes).toBe(
      "Goals\nfoo bar\n\nDecisions\nlegal signed off\n\nship date slipped"
    );
  });

  it("never drops a section that came from the note text", () => {
    const notes = "Decisions\nship date slipped";

    const cleared = serializeMeetingNoteSections(
      parseMeetingNoteSections(notes, "auto").map((section) =>
        section.title === "Decisions" ? { ...section, body: "" } : section
      )
    );

    expect(cleared).toBe("Decisions");
    expect(parseMeetingNoteSections(cleared, "auto").some(
      (section) => section.title === "Decisions" && section.isFromNotes
    )).toBe(true);
  });

  it("round-trips realistic note bodies byte for byte", () => {
    const templateId = "auto";
    const bodies = [
      "",
      "Goals\n- ",
      "Goals\nAlign launch scope and decide owners",
      "Goals\nship date slipped",
      "Goals\n- one\n- two\n- three",
      "Goals\nfirst paragraph\n\nsecond paragraph after a blank line",
      "General notes\nrandom thought\n\nGoals\nAgree the order",
      "Goals\n- \n\nKey discussion points\n- \n\nDecisions\n- \n\nFollow-ups\n- ",
      "Goals\nA\n\nKey discussion points\nB\n\nDecisions\nC\n\nFollow-ups\nD",
      "Goals\nHold the date\n\n## Pricing thread\nLegal review may slip",
      "Goals\n- ship v2\n\n## Pricing thread\n- decided on tier 2",
      "Goals\nHold the date\n\nRisks\nLegal review may slip",
      "Goals\nnotes with a #hash and 2. numeral\n\nDecisions\nno.",
      "Decisions\nDecisions were made",
    ];

    for (const body of bodies) {
      const sections = parseMeetingNoteSections(body, templateId);
      expect(serializeMeetingNoteSections(sections)).toBe(body);
    }
  });

  it("keeps every character when unrecognised prose is normalised into the general block", () => {
    const notes = "ship date slipped\nno owner yet\n\nlegal is the blocker";

    const first = serializeMeetingNoteSections(parseMeetingNoteSections(notes, "auto"));

    expect(first).toBe(`General notes\n${notes}`);
    // Normalisation happens once; after that the text is stable.
    expect(serializeMeetingNoteSections(parseMeetingNoteSections(first, "auto"))).toBe(
      first
    );
  });

  it("promotes a hand-made section only when it is explicitly marked", () => {
    const explicit = parseMeetingNoteSections("## Risks\nlegal may slip", "auto");
    expect(
      explicit.find((section) => section.title === "Risks")?.body
    ).toBe("legal may slip");

    const bare = parseMeetingNoteSections("Goals\nx\n\nreview the pricing page", "auto");
    expect(bare.some((section) => section.title === "review the pricing page")).toBe(
      false
    );
    expect(bare.find((section) => section.title === "Goals")?.body).toBe(
      "x\n\nreview the pricing page"
    );
  });

  it("migrates bare headings written before sections carried a marker", () => {
    // Exactly what the old code wrote: a bare title with a bullet list under it.
    const legacy =
      "Goals\n- ship v2\n\nPricing thread\n- decided on tier 2\n\nLegal\n- waiting on redlines";
    const sections = parseMeetingNoteSections(legacy, "auto");

    expect(
      sections.filter((section) => section.isFromNotes).map((section) => section.title)
    ).toEqual(["Goals", "Pricing thread", "Legal"]);

    const migrated = serializeMeetingNoteSections(sections);
    expect(migrated).toBe(
      "Goals\n- ship v2\n\n## Pricing thread\n- decided on tier 2\n\n## Legal\n- waiting on redlines"
    );
    // The rewrite adds markers and nothing else.
    expect(migrated.replace(/^## /gm, "")).toBe(legacy);
    // It happens once; after that the note is stable.
    expect(serializeMeetingNoteSections(parseMeetingNoteSections(migrated, "auto"))).toBe(
      migrated
    );
  });

  it("migrates a note the old enhance action wrote", () => {
    const legacy =
      "Summary\n- we shipped\n\nAction Items\n- ping legal\n\nRaw Notes Context\n- old notes";

    expect(
      parseMeetingNoteSections(legacy, "auto")
        .filter((section) => section.isFromNotes)
        .map((section) => section.title)
    ).toEqual(["Summary", "Action Items", "Raw Notes Context"]);
  });

  it("leaves terse prose alone when nothing is bulleted under it", () => {
    const notes = "Goals\n- ship v2\n\nship date slipped\nno owner yet";

    expect(serializeMeetingNoteSections(parseMeetingNoteSections(notes, "auto"))).toBe(
      notes
    );
  });

  it("leaves a numbered list attached to the sentence above it", () => {
    const notes = "Goals\n- ship v2\n\nwe weighed three options\n1. keep\n2. drop";

    expect(serializeMeetingNoteSections(parseMeetingNoteSections(notes, "auto"))).toBe(
      notes
    );
  });

  it("marks a bulleted title once and then leaves the note alone", () => {
    const notes = "## Pricing thread\n- decided on tier 2\n\nLegal\n- waiting on redlines";
    const once = serializeMeetingNoteSections(parseMeetingNoteSections(notes, "auto"));

    expect(once).toBe(
      "## Pricing thread\n- decided on tier 2\n\n## Legal\n- waiting on redlines"
    );
    expect(serializeMeetingNoteSections(parseMeetingNoteSections(once, "auto"))).toBe(once);
  });

  it("keeps filled sections when the template changes underneath them", () => {
    const notes = "Goals\nHold the launch date";
    const asStandup = parseMeetingNoteSections(notes, "standup");

    expect(asStandup.find((section) => section.title === "Goals")?.body).toBe(
      "Hold the launch date"
    );
    expect(serializeMeetingNoteSections(asStandup)).toBe(notes);
  });

  it("names the next custom section without colliding", () => {
    const sections = parseMeetingNoteSections("## Custom section\n- ", "auto");
    expect(getNextMeetingSectionTitle(sections)).toBe("Custom section 2");
  });

  describe("custom (user-saved) templates", () => {
    const customTemplate = {
      id: "custom-board-update",
      name: "Board Update",
      summaryPrompt: "Summarize board sentiment, asks, and follow-ups.",
      notesOutline: ["Sentiment", "Asks"],
    };

    it("recognises a custom template's own outline headings as template sections", () => {
      const notes = "Sentiment\nCautiously optimistic\n\nAsks\nMore runway";
      const sections = parseMeetingNoteSections(notes, customTemplate.id, [customTemplate]);

      expect(
        sections.find((section) => section.title === "Sentiment")?.isTemplateSection
      ).toBe(true);
      expect(
        sections.find((section) => section.title === "Asks")?.isTemplateSection
      ).toBe(true);
    });

    it("round-trips a custom template's outline byte for byte, including after real text replaces the placeholder", () => {
      const seeded = "Sentiment\n- \n\nAsks\n- ";
      const parsed = parseMeetingNoteSections(seeded, customTemplate.id, [customTemplate]);
      expect(serializeMeetingNoteSections(parsed, customTemplate.id, [customTemplate])).toBe(
        seeded
      );

      // Once the placeholder bullet is replaced with prose, the heading must
      // still read back as a heading on the next parse -- the bulleted-title
      // heuristic alone would stop working here, which is exactly why a
      // custom template's headings are added to the known-bare-title set.
      const edited = serializeMeetingNoteSections(
        parsed.map((section) =>
          section.title === "Sentiment"
            ? { ...section, body: "Cautiously optimistic" }
            : section
        ),
        customTemplate.id,
        [customTemplate]
      );
      const reparsed = parseMeetingNoteSections(edited, customTemplate.id, [customTemplate]);
      expect(reparsed.find((section) => section.title === "Sentiment")?.body).toBe(
        "Cautiously optimistic"
      );
      expect(serializeMeetingNoteSections(reparsed, customTemplate.id, [customTemplate])).toBe(
        edited
      );
    });

    it("folds a deleted custom template's notes into general text rather than losing them", () => {
      // The meeting's stored template id still names the deleted template,
      // but it is no longer in the caller's custom-template list -- the
      // shape a meeting record takes right after its template is removed.
      // Parsing must not throw, and the text must not be lost: with no
      // outline to recognise "Sentiment" as a heading, it folds into the
      // general block exactly as any other unrecognised prose does (see
      // "keeps every character when unrecognised prose is normalised into
      // the general block" above) -- deleting a template must not break a
      // past meeting's displayed notes.
      const notes = "Sentiment\nCautiously optimistic";
      const sections = parseMeetingNoteSections(notes, customTemplate.id, []);

      expect(sections.some((section) => section.title === "Sentiment")).toBe(false);
      const serialized = serializeMeetingNoteSections(sections, customTemplate.id, []);
      expect(serialized).toBe(`General notes\n${notes}`);
      // Stable once normalised, and still resolvable without the template.
      expect(
        serializeMeetingNoteSections(
          parseMeetingNoteSections(serialized, customTemplate.id, []),
          customTemplate.id,
          []
        )
      ).toBe(serialized);
    });

    it("does not let one custom template's outline bleed into a note using a different template", () => {
      // The bug this guards: knownBareSectionTitles used to union every
      // custom template's outline regardless of which one a note actually
      // resolved to, so template B's "Vendor risks" heading could get
      // promoted inside a meeting using template A -- and the next edit
      // would write that reordering to disk. Neither title below appears in
      // any built-in template's outline, so a false positive can only come
      // from the bug this test targets.
      const templateA = {
        id: "custom-a",
        name: "Template A",
        summaryPrompt: "",
        notesOutline: ["Sentiment"],
      };
      const templateB = {
        id: "custom-b",
        name: "Template B",
        summaryPrompt: "",
        notesOutline: ["Vendor risks"],
      };
      const notes = "Sentiment\nCautiously optimistic\n\nVendor risks\nnothing pending";

      const sections = parseMeetingNoteSections(notes, templateA.id, [templateA, templateB]);

      expect(sections.some((section) => section.title === "Vendor risks")).toBe(false);
      expect(sections.find((section) => section.title === "Sentiment")?.body).toContain(
        "Vendor risks"
      );
    });
  });
});

describe("rebaseMeetingNotes", () => {
  it("writes local text when nothing moved underneath it", () => {
    expect(
      rebaseMeetingNotes({ base: "Goals\na", local: "Goals\nab", stored: "Goals\na" })
    ).toBe("Goals\nab");
  });

  it("adopts stored text when this surface has nothing unsaved", () => {
    expect(
      rebaseMeetingNotes({
        base: "Goals\na",
        local: "Goals\na",
        stored: "Goals\na\n\n## Popup\nfrom the overlay",
      })
    ).toBe("Goals\na\n\n## Popup\nfrom the overlay");
  });

  it("keeps both sides when two surfaces edited the same note", () => {
    const merged = rebaseMeetingNotes({
      base: "Goals\na",
      local: "Goals\na\nfrom the review tab",
      stored: "Goals\na\nfrom the popup",
    });

    expect(merged).toContain("from the popup");
    expect(merged).toContain("from the review tab");
  });

  it("keeps a one-character edit whose letters appear elsewhere in the stored text", () => {
    // The debounce is 350ms, so the unsaved delta is usually a keystroke or
    // two. Asking whether the stored note "contains" those characters answers
    // yes for any real note and throws the keystroke away.
    expect(
      rebaseMeetingNotes({
        base: "Goals\n- a",
        local: "Goals\n- ab",
        stored: "Goals\n- a\n- blocked on legal",
      })
    ).toBe("Goals\n- ab\n- blocked on legal");
  });

  it("merges an edit made above the end of the note without duplicating it", () => {
    expect(
      rebaseMeetingNotes({
        base: "Goals\n- a\n- b",
        local: "Goals\n- aa\n- b",
        stored: "Goals\n- a\n- b\n- c",
      })
    ).toBe("Goals\n- aa\n- b\n- c");
  });

  it("does not compound duplicated text over repeated conflicting saves", () => {
    let stored = "Goals\n- a\n- b";
    let typed = "a";

    for (const remoteLine of ["- c", "- d", "- e"]) {
      const base = stored;
      typed = `${typed}a`;
      stored = rebaseMeetingNotes({
        base,
        local: base.replace(/^- a+$/m, `- ${typed}`),
        stored: `${base}\n${remoteLine}`,
      });
    }

    expect(stored).toBe("Goals\n- aaaa\n- b\n- c\n- d\n- e");
  });

  it("honours a deletion here while keeping the other surface's addition", () => {
    expect(
      rebaseMeetingNotes({
        base: "Goals\n- a\n- b",
        local: "Goals\n- a",
        stored: "Goals\n- a\n- b\n- c",
      })
    ).toBe("Goals\n- a\n- c");
  });

  it("does not duplicate the same line typed on both surfaces", () => {
    expect(
      rebaseMeetingNotes({
        base: "Goals\n- a",
        local: "Goals\n- a\n- ping legal",
        stored: "Goals\n- a\n- ping legal\n- from the popup",
      })
    ).toBe("Goals\n- a\n- ping legal\n- from the popup");
  });

  it("ignores the whitespace the sidecar trims on write", () => {
    expect(
      rebaseMeetingNotes({ base: "Goals\n- ", local: "Goals\n- x", stored: "Goals\n-" })
    ).toBe("Goals\n- x");
  });

  it("never drops a line either surface typed, whatever the two edits were", () => {
    // Fixed seed so a failure is reproducible. Every line a surface introduced
    // is tagged, so the assertion is exactly "nothing the user typed vanished".
    let seed = 12345;
    const nextInt = (bound: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % bound;
    };
    const vocabulary = [
      "ship date slipped",
      "- legal signed off",
      "",
      "Goals",
      "- a",
      "Decisions",
      "follow up with sam",
      "## Risks",
    ];

    const editedBy = (lines: string[], tag: string) => {
      const draft = [...lines];
      for (let edit = 0, edits = 1 + nextInt(3); edit < edits; edit += 1) {
        const at = draft.length > 0 ? nextInt(draft.length) : 0;
        const operation = nextInt(3);
        if (operation === 0) {
          draft.splice(at, 0, `${tag}${edit}-added`);
        } else if (operation === 1 && draft.length > 0) {
          draft.splice(at, 1);
        } else if (draft.length > 0) {
          draft[at] = `${tag}${edit}-rewritten`;
        }
      }
      return draft.join("\n");
    };

    for (let trial = 0; trial < 500; trial += 1) {
      const baseLines: string[] = [];
      for (let line = 0, count = nextInt(8); line < count; line += 1) {
        baseLines.push(vocabulary[nextInt(vocabulary.length)]);
      }
      const base = baseLines.join("\n");
      const local = editedBy(baseLines, "local");
      const stored = editedBy(baseLines, "stored");
      const merged = rebaseMeetingNotes({ base, local, stored });
      const mergedLines = new Set(merged.split("\n").map((line) => line.trimEnd()));

      for (const line of [...local.split("\n"), ...stored.split("\n")]) {
        if (!/^(?:local|stored)\d/.test(line)) {
          continue;
        }
        const context = JSON.stringify({ base, local, stored, merged });
        expect(mergedLines.has(line), `lost ${line} merging ${context}`).toBe(true);
      }
      // Only the lines that actually collided may be repeated, so the merge can
      // never balloon the way appending a whole note does.
      expect(merged.length).toBeLessThanOrEqual(
        Math.max(local.length, stored.length) + 64
      );
    }
  });

  it("does not merge against an empty record", () => {
    expect(rebaseMeetingNotes({ base: "Goals\na", local: "Goals\nb", stored: "" })).toBe(
      "Goals\nb"
    );
  });
});
