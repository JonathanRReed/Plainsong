import { useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  parseMarkdownBlocks,
  parseRecapQuote,
  RECAP_TOPICS_PREFIX,
  type MarkdownSpan,
  type RecapQuote,
} from "@/lib/markdown";

interface MarkdownTextProps {
  value: string;
  className?: string;
}

function Spans({ spans }: { spans: MarkdownSpan[] }) {
  return (
    <>
      {spans.map((entry, index) => {
        if (entry.code) {
          return (
            <code
              key={index}
              className="rounded-sm bg-muted/50 px-1 py-0.5 font-mono text-[0.9em]"
            >
              {entry.text}
            </code>
          );
        }
        return (
          <span
            key={index}
            className={cn(entry.bold && "font-semibold", entry.italic && "italic")}
          >
            {entry.text}
          </span>
        );
      })}
    </>
  );
}

function spanText(spans: MarkdownSpan[]): string {
  return spans.map((entry) => entry.text).join("");
}

/**
 * A recap's quoted source sentences: the words as said, in the transcript's
 * serif behind the quote rule, then who said them and when, as metadata.
 */
function QuoteList({ quotes }: { quotes: RecapQuote[] }) {
  return (
    <ul className="max-w-prose space-y-3">
      {quotes.map((quote, index) => (
        <li key={index} className="border-l-2 border-gold-ambient/50 pl-3">
          <blockquote className="manuscript text-[0.95rem] leading-[1.7]">“{quote.quote}”</blockquote>
          {quote.speaker || quote.time ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {quote.speaker ? <span className="font-medium text-foreground/80">{quote.speaker}</span> : null}
              {quote.speaker && quote.time ? " · " : null}
              {quote.time ? <span className="time-spec">{quote.time}</span> : null}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The set-down text, read as a document. Newsreader via `.manuscript`, because
 * this is the meeting record — the thing STYLE.md reserves the display serif
 * for — and never a text box pretending to be a page.
 */
export function MarkdownText({ value, className }: MarkdownTextProps) {
  const blocks = useMemo(() => parseMarkdownBlocks(value), [value]);

  if (blocks.length === 0) {
    return null;
  }

  return (
    <div className={cn("space-y-3", className)}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading": {
            const Tag = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
            return (
              <Tag
                key={index}
                className={cn(
                  "font-serif font-semibold tracking-tight text-foreground",
                  block.level === 1 ? "text-lg" : block.level === 2 ? "text-base" : "text-sm"
                )}
              >
                <Spans spans={block.spans} />
              </Tag>
            );
          }
          case "list": {
            const quotes = block.ordered
              ? []
              : block.items.map((item) => parseRecapQuote(spanText(item)));
            if (quotes.length > 0 && quotes.every((quote) => quote !== null)) {
              return <QuoteList key={index} quotes={quotes as RecapQuote[]} />;
            }
            return block.ordered ? (
              <ol
                key={index}
                className="manuscript max-w-prose list-decimal space-y-1.5 pl-5 text-[0.95rem] leading-[1.7]"
              >
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <Spans spans={item} />
                  </li>
                ))}
              </ol>
            ) : (
              <ul
                key={index}
                className="manuscript max-w-prose list-disc space-y-1.5 pl-5 text-[0.95rem] leading-[1.7]"
              >
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <Spans spans={item} />
                  </li>
                ))}
              </ul>
            );
          }
          case "quote":
            return (
              <blockquote
                key={index}
                className="manuscript max-w-prose whitespace-pre-wrap border-l-2 border-gold-ambient/50 pl-3 text-[0.95rem] leading-[1.85] text-muted-foreground"
              >
                <Spans spans={block.spans} />
              </blockquote>
            );
          default: {
            const text = spanText(block.spans);
            if (text.startsWith(RECAP_TOPICS_PREFIX) && !text.includes("\n")) {
              return (
                <p key={index} className="max-w-prose text-sm text-muted-foreground">
                  <span className="font-medium text-foreground/80">Topics</span>{" "}
                  {text.slice(RECAP_TOPICS_PREFIX.length)}
                </p>
              );
            }
            return (
              <p
                key={index}
                className="manuscript max-w-prose whitespace-pre-wrap text-[0.95rem] leading-[1.85]"
              >
                <Spans spans={block.spans} />
              </p>
            );
          }
        }
      })}
    </div>
  );
}
