import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { parseMarkdownBlocks, type MarkdownSpan } from "@/lib/markdown";

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
          case "list":
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
          case "quote":
            return (
              <blockquote
                key={index}
                className="manuscript max-w-prose whitespace-pre-wrap border-l-2 border-gold-ambient/50 pl-3 text-[0.95rem] leading-[1.85] text-muted-foreground"
              >
                <Spans spans={block.spans} />
              </blockquote>
            );
          default:
            return (
              <p
                key={index}
                className="manuscript max-w-prose whitespace-pre-wrap text-[0.95rem] leading-[1.85]"
              >
                <Spans spans={block.spans} />
              </p>
            );
        }
      })}
    </div>
  );
}
