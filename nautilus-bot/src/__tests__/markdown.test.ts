import { describe, expect, it } from "vitest";
import {
  actionItemsToMarkdownList,
  parseMarkdownBlocks,
  parseMarkdownSpans,
} from "@/lib/markdown";

describe("parseMarkdownSpans", () => {
  it("marks bold, italic, and code runs and leaves the rest alone", () => {
    expect(parseMarkdownSpans("Ship **now**, _quietly_, via `cargo run`.")).toEqual([
      { text: "Ship ", bold: false, italic: false, code: false },
      { text: "now", bold: true, italic: false, code: false },
      { text: ", ", bold: false, italic: false, code: false },
      { text: "quietly", bold: false, italic: true, code: false },
      { text: ", via ", bold: false, italic: false, code: false },
      { text: "cargo run", bold: false, italic: false, code: true },
      { text: ".", bold: false, italic: false, code: false },
    ]);
  });

  it("keeps an unclosed marker as the character the user typed", () => {
    // Swallowing a stray asterisk would silently edit the user's words.
    expect(parseMarkdownSpans("2 * 3 is 6")).toEqual([
      { text: "2 * 3 is 6", bold: false, italic: false, code: false },
    ]);
  });

  it("leaves an intraword underscore alone — a filename is not emphasis", () => {
    // Snake_case filenames and ticket ids are routine in action items, and the
    // recap is read as a document now: "reportv2final" is not what was typed.
    expect(parseMarkdownSpans("Files: report_v2_final and notes_v3_final")).toEqual([
      {
        text: "Files: report_v2_final and notes_v3_final",
        bold: false,
        italic: false,
        code: false,
      },
    ]);
  });

  it("leaves a paired asterisk that reads as arithmetic alone", () => {
    expect(parseMarkdownSpans("Budget: 3 * 12 * 4 seats")).toEqual([
      { text: "Budget: 3 * 12 * 4 seats", bold: false, italic: false, code: false },
    ]);
  });

  it("still emphasises a marker that opens and closes on a word boundary", () => {
    expect(parseMarkdownSpans("(_quietly_) and **loudly**.")).toEqual([
      { text: "(", bold: false, italic: false, code: false },
      { text: "quietly", bold: false, italic: true, code: false },
      { text: ") and ", bold: false, italic: false, code: false },
      { text: "loudly", bold: true, italic: false, code: false },
      { text: ".", bold: false, italic: false, code: false },
    ]);
  });
});

describe("parseMarkdownBlocks", () => {
  it("reads the shape the app writes: headings, bullets, and paragraphs", () => {
    const blocks = parseMarkdownBlocks(
      "## Summary\nLaunch is on track.\n\n## Action Items\n- Send the packet\n- Confirm the date"
    );

    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "list",
    ]);
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 2 });
    expect(blocks[3]).toMatchObject({ kind: "list", ordered: false });
    if (blocks[3].kind === "list") {
      expect(blocks[3].items).toHaveLength(2);
      expect(blocks[3].items[1][0].text).toBe("Confirm the date");
    }
  });

  it("keeps a numbered list numbered and a quote quoted", () => {
    const blocks = parseMarkdownBlocks("1. First\n2. Second\n\n> Legal signed off");
    expect(blocks[0]).toMatchObject({ kind: "list", ordered: true });
    expect(blocks[1]).toMatchObject({ kind: "quote" });
  });

  it("preserves a soft line break inside one paragraph", () => {
    const blocks = parseMarkdownBlocks("Owners:\nJon, Dana");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("paragraph");
    if (blocks[0].kind === "paragraph") {
      expect(blocks[0].spans[0].text).toBe("Owners:\nJon, Dana");
    }
  });

  it("returns nothing for blank text so callers can show their own empty state", () => {
    expect(parseMarkdownBlocks("   \n\n  ")).toEqual([]);
  });
});

describe("actionItemsToMarkdownList", () => {
  it("bullets one item per line and drops blanks", () => {
    expect(actionItemsToMarkdownList(["Send packet", "  ", "Confirm date"])).toBe(
      "- Send packet\n- Confirm date"
    );
  });

  it("does not double-bullet a line the user already bulleted", () => {
    expect(actionItemsToMarkdownList(["- Send packet"])).toBe("- Send packet");
  });
});
