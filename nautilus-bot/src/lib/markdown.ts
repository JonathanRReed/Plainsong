/**
 * A small, offline markdown reader for the text Plainsong sets down: meeting
 * summaries, action items, and enhanced-note drafts. It exists because the
 * recap is a document the user reads, not a value in a text box — and because
 * the app ships no CDN, so a full markdown library is not on the table.
 *
 * It understands only what the app itself writes and what a person types into
 * a note: ATX headings, bullet and numbered lists, blockquotes, paragraphs,
 * and inline bold/italic/code. Raw HTML and links are deliberately not parsed —
 * nothing here can inject markup, and an unmatched `*` stays the character the
 * user typed instead of quietly disappearing.
 *
 * Emphasis follows CommonMark's flanking rule, which matters more here than it
 * looks: without it a PAIR of markers that were never meant as emphasis gets
 * eaten too. `report_v2_final` rendered as "reportv2final" and `3 * 12 * 4`
 * lost both asterisks — snake_case filenames, ticket ids and arithmetic are
 * routine in action items, and this text is read as a document.
 */

export interface MarkdownSpan {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
}

export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; spans: MarkdownSpan[] }
  | { kind: "paragraph"; spans: MarkdownSpan[] }
  | { kind: "list"; ordered: boolean; items: MarkdownSpan[][] }
  | { kind: "quote"; spans: MarkdownSpan[] };

const HEADING_PATTERN = /^(#{1,3})\s+(.*)$/;
const BULLET_PATTERN = /^\s*[-*+]\s+(.*)$/;
const ORDERED_PATTERN = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE_PATTERN = /^\s*>\s?(.*)$/;
// Code first so a backtick run wins over emphasis inside it; the longer
// emphasis markers are tried before the single-character ones.
const INLINE_PATTERN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;

const WHITESPACE = /\s/;
const PUNCTUATION = /[!-/:-@[-`{-~]/;

/** Line start, line end, whitespace, or punctuation — the edge of a word. */
function isWordBoundary(char: string | undefined): boolean {
  return char === undefined || WHITESPACE.test(char) || PUNCTUATION.test(char);
}

/**
 * Whether an emphasis run really opens and closes emphasis, rather than being
 * two characters that happen to sit inside words. The opening marker has to
 * follow a boundary and be followed by a non-space; the closing marker is the
 * mirror. That is what keeps `report_v2_final` and `3 * 12 * 4` intact.
 */
function isEmphasis(line: string, index: number, token: string, markerLength: number): boolean {
  const before = line[index - 1];
  const after = line[index + token.length];
  const firstInside = token[markerLength];
  const lastInside = token[token.length - markerLength - 1];

  const opens = !WHITESPACE.test(firstInside) && isWordBoundary(before);
  const closes = !WHITESPACE.test(lastInside) && isWordBoundary(after);
  return opens && closes;
}

function span(text: string, marks: Partial<Omit<MarkdownSpan, "text">> = {}): MarkdownSpan {
  return {
    text,
    bold: marks.bold ?? false,
    italic: marks.italic ?? false,
    code: marks.code ?? false,
  };
}

/**
 * Split one line of text into styled runs. Markers that never close, and pairs
 * that sit inside a word instead of around one, are left as literal text — the
 * user's asterisk is theirs, not ours to swallow.
 */
export function parseMarkdownSpans(line: string): MarkdownSpan[] {
  if (!line) {
    return [];
  }

  const spans: MarkdownSpan[] = [];
  let cursor = 0;

  INLINE_PATTERN.lastIndex = 0;
  for (;;) {
    const match = INLINE_PATTERN.exec(line);
    if (!match) {
      break;
    }
    const token = match[0];
    if (token.startsWith("`")) {
      if (match.index > cursor) {
        spans.push(span(line.slice(cursor, match.index)));
      }
      spans.push(span(token.slice(1, -1), { code: true }));
      cursor = match.index + token.length;
      continue;
    }

    const markerLength = token.startsWith("**") || token.startsWith("__") ? 2 : 1;
    if (!isEmphasis(line, match.index, token, markerLength)) {
      // Not emphasis after all. Leave the characters where they are and look
      // again from just inside this run — a later pair on the same line may
      // still be real.
      INLINE_PATTERN.lastIndex = match.index + 1;
      continue;
    }

    if (match.index > cursor) {
      spans.push(span(line.slice(cursor, match.index)));
    }
    spans.push(
      span(token.slice(markerLength, -markerLength), {
        bold: markerLength === 2,
        italic: markerLength === 1,
      })
    );
    cursor = match.index + token.length;
  }

  if (cursor < line.length) {
    spans.push(span(line.slice(cursor)));
  }

  return spans.filter((entry) => entry.text.length > 0);
}

/**
 * Parse a markdown document into the blocks the renderer draws. Soft line
 * breaks inside a paragraph are preserved as newlines in the span text, so a
 * hand-typed note keeps the shape its author gave it.
 */
export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    const text = paragraph.join("\n").trim();
    paragraph = [];
    if (text) {
      blocks.push({ kind: "paragraph", spans: parseMarkdownSpans(text) });
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: Math.min(3, heading[1].length) as 1 | 2 | 3,
        spans: parseMarkdownSpans(heading[2].trim()),
      });
      continue;
    }

    const quote = QUOTE_PATTERN.exec(line);
    if (quote) {
      flushParagraph();
      const previous = blocks[blocks.length - 1];
      if (previous?.kind === "quote") {
        previous.spans.push(span("\n"), ...parseMarkdownSpans(quote[1]));
      } else {
        blocks.push({ kind: "quote", spans: parseMarkdownSpans(quote[1]) });
      }
      continue;
    }

    const bullet = BULLET_PATTERN.exec(line);
    const ordered = bullet ? null : ORDERED_PATTERN.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const itemText = (bullet ?? ordered)?.[1] ?? "";
      const previous = blocks[blocks.length - 1];
      if (previous?.kind === "list" && previous.ordered === isOrdered) {
        previous.items.push(parseMarkdownSpans(itemText));
      } else {
        blocks.push({
          kind: "list",
          ordered: isOrdered,
          items: [parseMarkdownSpans(itemText)],
        });
      }
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return blocks;
}

/**
 * One action item per line becomes one bullet. A line the user already wrote
 * as a bullet is not double-marked.
 */
export function actionItemsToMarkdownList(items: string[]): string {
  return items
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => (BULLET_PATTERN.test(item) ? item : `- ${item}`))
    .join("\n");
}
