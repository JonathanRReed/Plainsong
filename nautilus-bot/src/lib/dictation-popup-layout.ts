import type { DictationPhase } from "@/features/dictation/runtime";

export type DictationPopupDisplayMode = "full" | "compact" | "minimal";

// The height estimate below is what the overlay window is actually resized to,
// so it must agree with what the DOM renders. Every preview/message paragraph
// is line-clamped; without the same cap here a long partial (they arrive every
// 700ms while the user speaks) grows the window hundreds of pixels past the
// text it can ever show. Keep these in lockstep with the `line-clamp-*` classes
// in dictation-popup.tsx.
export const POPUP_PREVIEW_LINE_CLAMP = 4;
export const POPUP_MESSAGE_LINE_CLAMP = 6;

export function estimatePopupTextLines(
  value: string | null,
  charsPerLine: number,
  maxLines: number,
) {
  if (!value) {
    return 0;
  }

  const lines = value
    .split("\n")
    .reduce(
      (total, line) =>
        total + Math.max(1, Math.ceil(line.length / charsPerLine)),
      0,
    );

  return Math.min(lines, maxLines);
}

// ── Rendered chrome, in CSS pixels ───────────────────────────────────────────
// The card is bottom-anchored inside a window sized to exactly the estimate
// below, so the two failure modes are not symmetric: an estimate that is SHORT
// clips the bottom of the card (the "Live text" box goes first, which is the
// one thing the user is reading while speaking), while an estimate that is long
// only leaves transparent padding above the card. Bias long, never short.
//
// Every number is measured from the resolved styles — Tailwind `text-sm` =
// 14/20, `text-xs` = 12/16, `leading-6` = 24, `leading-relaxed` = 1.625,
// `space-y-3` = 12, `h-7` = 28, `h-8` = 32, `py-3.5` = 14, `py-3` = 12,
// `py-2.5` = 10, `py-2` = 8, `p-3` = 12 — plus index.css's `p { line-height:
// 1.6 }`, which is what the arbitrary `text-[11px]` labels fall back to (17.6px,
// rounded up here).
const WINDOW_PADDING = 24; // outer p-3, top + bottom
const CARD_CHROME = 30; // 1px border x2 + py-3.5 x2
const CARD_HEADER = 40; // h-7 controls + mb-3
const CARD_FRAME = WINDOW_PADDING + CARD_CHROME + CARD_HEADER;

const STACK_GAP = 12; // space-y-3 between capture rows
const CAPTURE_BAR = 52; // h-8 mic/stop buttons + py-2.5 x2
const CAPTURE_STATUS_LINE = 20; // text-sm runtime status paragraph
const CAPTURE_HINT_LINE = 16; // text-xs "… to stop · Esc to cancel"
const CAPTURE_PREVIEW_CHROME = 52; // border x2 + py-3 x2 + 11px label + mt-2
const CAPTURE_PREVIEW_LINE = 24; // text-sm leading-6, line-clamp-4

// The runtime status paragraph is assembled from settings this module never
// sees (the hands-free variant is several times longer than the plain "Sending
// to Mail" line), so it gets a wrap budget instead of a measurement — three
// lines at the narrower compact width.
const CAPTURE_STATUS_LINES = { full: 2, compact: 3 } as const;

const PROCESSING_HEAD = 42; // settled waveform + mb-1.5 + text-sm title
const PROCESSING_DETAIL_LINE = 16; // text-xs detail paragraph, line-clamp-6
const PROCESSING_ACTIVATION = 36; // mt-1 + the line-clamp-2 activation detail
const PROCESSING_PREVIEW_CHROME = 48; // mt-2 + border x2 + py-2 x2 + label + mt-1
const PROCESSING_PREVIEW_LINE = 20; // text-xs leading-relaxed, line-clamp-4

const ERROR_CHROME = 98; // text-sm title + the two-line advice + button row
const ERROR_MESSAGE_LINE = 23; // text-sm leading-relaxed, line-clamp-6

const CHARS_PER_LINE = { full: 48, compact: 32 } as const;

type CardMode = "full" | "compact";

/**
 * Height of the primed/recording card: the capture bar, the runtime status
 * line, the stop/cancel hint, and (full mode only) the live-text box.
 */
function captureCardHeight(mode: CardMode, previewLines: number): number {
  const previewBox =
    mode === "full" && previewLines > 0
      ? STACK_GAP +
        CAPTURE_PREVIEW_CHROME +
        previewLines * CAPTURE_PREVIEW_LINE
      : 0;

  return (
    CARD_FRAME +
    CAPTURE_BAR +
    STACK_GAP +
    CAPTURE_STATUS_LINES[mode] * CAPTURE_STATUS_LINE +
    STACK_GAP +
    CAPTURE_HINT_LINE +
    previewBox
  );
}

/**
 * Height of the stopping/transcribing/delivering card. All three share one
 * shape; the tallest (transcribing, which adds the settled waveform) sets the
 * constants, so the shorter two carry a little slack rather than needing their
 * own branch.
 */
function processingCardHeight(
  mode: CardMode,
  messageLines: number,
  previewLines: number,
): number {
  const previewBox =
    mode === "full" && previewLines > 0
      ? PROCESSING_PREVIEW_CHROME + previewLines * PROCESSING_PREVIEW_LINE
      : 0;

  return (
    CARD_FRAME +
    PROCESSING_HEAD +
    Math.max(1, messageLines) * PROCESSING_DETAIL_LINE +
    PROCESSING_ACTIVATION +
    previewBox
  );
}

export function getPopupSize(
  displayMode: DictationPopupDisplayMode,
  phase: DictationPhase,
  message: string | null,
  preview: string | null,
) {
  if (displayMode === "minimal") {
    // Wide enough for the longest state label ("Getting ready") beside the mic,
    // the state neume, the waveform and the stop button — the pill clipped its
    // own status text at the old 196px.
    return { width: 260, height: 56 };
  }

  const mode: CardMode = displayMode === "compact" ? "compact" : "full";
  const charsPerLine = CHARS_PER_LINE[mode];
  const messageLines = estimatePopupTextLines(
    message,
    charsPerLine,
    POPUP_MESSAGE_LINE_CLAMP,
  );
  const previewLines = estimatePopupTextLines(
    preview,
    charsPerLine,
    POPUP_PREVIEW_LINE_CLAMP,
  );

  if (displayMode === "compact") {
    // Only the capture and processing branches are derived from the rendered
    // card here. Compact `done`/`error` hide everything but their title, so
    // their long-standing allowances already over-cover the card and are left
    // alone rather than shrunk as a side effect of this fix.
    return {
      width: 336,
      height:
        phase === "idle"
          ? 204
          : phase === "error"
            ? Math.max(188, 144 + messageLines * 18)
            : phase === "done"
              ? Math.max(188, 146 + Math.max(messageLines, previewLines) * 16)
              : phase === "primed" || phase === "recording"
                ? captureCardHeight("compact", previewLines)
                : processingCardHeight("compact", messageLines, previewLines),
    };
  }

  if (phase === "idle") {
    // Nothing is rendered at idle (the card returns an empty transparent div)
    // and the window is hidden, so this is only a resting size.
    return { width: 432, height: 308 };
  }

  if (phase === "error") {
    return {
      width: 432,
      height: CARD_FRAME + ERROR_CHROME + messageLines * ERROR_MESSAGE_LINE,
    };
  }

  if (phase === "primed" || phase === "recording") {
    return { width: 432, height: captureCardHeight("full", previewLines) };
  }

  if (phase === "done") {
    // The done panel is a stack of chips, a result box, hint pills and an
    // action grid inside an `overflow-hidden` card; it needs its own pass and
    // keeps its existing allowance for now.
    const contentLines = Math.max(messageLines, previewLines);
    return { width: 432, height: Math.max(248, 198 + contentLines * 18) };
  }

  return {
    width: 432,
    height: processingCardHeight("full", messageLines, previewLines),
  };
}
