import { describe, expect, it } from "vitest";
import { numberBriefCitations } from "@/lib/meeting-brief-citations";
import type {
  MeetingBriefCitation,
  RelatedMeeting,
} from "@/lib/backend/calendar";

function citation(overrides: Partial<MeetingBriefCitation> = {}): MeetingBriefCitation {
  return {
    text: "Weekly sync (2026-08-26) — summary: Shipped the importer.",
    lineId: "L1",
    segmentId: "summary",
    recordingId: "r1",
    certainty: 0.9,
    ...overrides,
  };
}

function related(overrides: Partial<RelatedMeeting> = {}): RelatedMeeting {
  return {
    recordingId: "r1",
    title: "Weekly sync",
    createdAt: "2026-08-26T15:30:00Z",
    reason: { sharedAttendees: 1, titleMatch: true },
    sharedAttendeeNames: ["Alice"],
    summary: "Shipped the importer.",
    openItems: [],
    decisions: [],
    ...overrides,
  };
}

describe("numberBriefCitations", () => {
  it("numbers in the order the sidecar returned them and rewrites the text", () => {
    const numbered = numberBriefCitations(
      "Shipped it L1. Alice owes numbers L2.",
      [citation(), citation({ lineId: "L2", segmentId: "action:0" })],
      [related()],
    );

    expect(numbered.text).toBe("Shipped it [1]. Alice owes numbers [2].");
    expect(numbered.references.map((r) => [r.number, r.lineId, r.title])).toEqual([
      [1, "L1", "Weekly sync"],
      [2, "L2", "Weekly sync"],
    ]);
  });

  it("leaves an ID the sidecar did not return exactly as the model wrote it", () => {
    // Numbering it would claim a citation the brief does not have.
    const numbered = numberBriefCitations("Something happened L9.", [], []);
    expect(numbered.text).toBe("Something happened L9.");
    expect(numbered.references).toEqual([]);
  });

  it("does not double the brackets a model already wrote", () => {
    const numbered = numberBriefCitations("Shipped it [L1].", [citation()], [related()]);
    expect(numbered.text).toBe("Shipped it [1].");
  });

  it("gives one number to evidence cited twice", () => {
    const numbered = numberBriefCitations(
      "Shipped it L1, and again L1.",
      [citation(), citation()],
      [related()],
    );
    expect(numbered.text).toBe("Shipped it [1], and again [1].");
    expect(numbered.references).toHaveLength(1);
  });

  it("keeps a citation the sidecar could not attribute to a meeting", () => {
    const numbered = numberBriefCitations(
      "Shipped it L1.",
      [citation({ recordingId: null })],
      [related()],
    );
    expect(numbered.references[0].recordingId).toBeNull();
    expect(numbered.references[0].title).toBeNull();
  });

  it("does not rewrite a capital L inside a word or a bare number", () => {
    const numbered = numberBriefCitations(
      "The L1 lane, LP1 and PL1 and 1 stay put.",
      [citation()],
      [related()],
    );
    expect(numbered.text).toBe("The [1] lane, LP1 and PL1 and 1 stay put.");
  });

  it("numbers a citation whose meeting is not on the related list", () => {
    // The list is capped; a cited meeting can fall off the end of it. It still
    // gets a number, and the entry says what it can rather than vanishing.
    const numbered = numberBriefCitations(
      "Shipped it L1.",
      [citation({ recordingId: "r-uncapped" })],
      [related()],
    );
    expect(numbered.references[0]).toMatchObject({
      number: 1,
      recordingId: "r-uncapped",
      title: null,
    });
  });
});
