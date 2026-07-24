import { describe, expect, it } from "vitest";
import {
  isOverlayAnchorOnScreen,
  resolveInitialOverlayAnchor,
  resolveOverlayBounds,
  resolveSavedOverlayAnchor,
  withOverlayDisplayMode,
  type OverlayWorkArea,
} from "../../electron/overlay-placement";
import {
  POPUP_MESSAGE_LINE_CLAMP,
  POPUP_PREVIEW_LINE_CLAMP,
  estimatePopupTextLines,
  getPopupSize,
} from "@/lib/dictation-popup-layout";

// A few real-world work areas: a notched laptop, an external 4K, a small
// external panel that is shorter than the tallest HUD estimate, and a display
// with a negative origin (a monitor placed left of / above the primary).
const WORK_AREAS: OverlayWorkArea[] = [
  { x: 0, y: 38, width: 1512, height: 944 },
  { x: 1512, y: 0, width: 3840, height: 2160 },
  { x: 0, y: 25, width: 1280, height: 300 },
  { x: -1920, y: -240, width: 1920, height: 1080 },
];

function sentenceOfLength(length: number): string {
  return "word ".repeat(Math.ceil(length / 5)).slice(0, length);
}

// Content heights measured from the resolved CSS of the rendered card, written
// out here as literals on purpose: the estimate in dictation-popup-layout.ts
// must be checked against an independent reading of the DOM, not against
// itself. Tailwind `text-sm` = 14/20, `text-xs` = 12/16, `leading-6` = 24,
// `leading-relaxed` = 1.625, `space-y-3` = 12, `h-7` = 28, `h-8` = 32,
// `py-3.5` = 14, `py-3` = 12, `py-2.5` = 10, `py-2` = 8, `p-3` = 12; index.css
// gives `p { line-height: 1.6 }`, which the arbitrary `text-[11px]` labels fall
// back to (17.6px).
const CARD_FRAME_PX =
  24 + // outer p-3, top + bottom
  30 + // card 1px border x2 + py-3.5 x2
  40; // header h-7 controls + mb-3

// Full mode, phase=recording, a partial long enough to fill the line-clamp-4
// live-text box. This is the case the window used to cut ~115px off.
const FULL_RECORDING_CONTENT_PX =
  CARD_FRAME_PX +
  52 + // capture bar: h-8 mic/stop + py-2.5 x2
  12 +
  20 + // space-y-3 + one-line text-sm status
  12 +
  16 + // space-y-3 + text-xs stop/cancel hint
  12 +
  (2 + 24 + 17.6 + 8) + // space-y-3 + preview box border/py-3/label/mt-2
  4 * 24; // four clamped leading-6 lines

// Same card with the long hands-free status line, which wraps to two.
const FULL_RECORDING_HANDS_FREE_CONTENT_PX = FULL_RECORDING_CONTENT_PX + 20;

// Full mode, phase=primed: identical chrome minus the live-text box.
const FULL_PRIMED_CONTENT_PX = CARD_FRAME_PX + 52 + 12 + 20 + 12 + 16 + 20;

// Full mode, phase=transcribing, six-line message plus a two-line activation
// detail plus the four-line preview box.
const FULL_TRANSCRIBING_CONTENT_PX =
  CARD_FRAME_PX +
  (16 + 6) + // settled waveform + mb-1.5
  20 + // text-sm title
  6 * 16 + // line-clamp-6 text-xs message
  (4 + 2 * 16) + // mt-1 + line-clamp-2 activation detail
  (8 + 2 + 16 + 17.6 + 4) + // preview box mt-2/border/py-2/label/mt-1
  4 * 19.5; // four clamped text-xs leading-relaxed lines

// Full mode, phase=error, six-line message.
const FULL_ERROR_CONTENT_PX =
  CARD_FRAME_PX +
  20 + // text-sm title
  6 * 22.75 + // line-clamp-6 text-sm leading-relaxed message
  2 * 20 + // two-line text-sm advice
  (8 + 12 + 2 + 16); // button row mt-2 + py-1.5 x2 + border + text-xs

describe("dictation popup sizing", () => {
  it("clamps the height estimate to the lines the DOM actually shows", () => {
    // The live preview paragraph is `line-clamp-4`; before the clamp a long
    // partial computed height for every wrapped line it would never render, so
    // the window grew hundreds of pixels while the user was still speaking.
    const shortPartial = sentenceOfLength(120);
    const longPartial = sentenceOfLength(4000);

    const short = getPopupSize("full", "recording", null, shortPartial);
    const long = getPopupSize("full", "recording", null, longPartial);

    expect(long.height).toBeGreaterThanOrEqual(short.height);
    expect(long.height).toBeLessThan(450);
  });

  // The clamp above traded "window too tall" for "live text invisible" until
  // the base constants were re-derived from the card: the same change added the
  // stop/cancel hint row and moved the status line to `text-sm`, so a four-line
  // partial needs ~366px of card inside a window the estimate capped at 248.
  it("covers the whole recording card, live-text box included", () => {
    const size = getPopupSize("full", "recording", null, sentenceOfLength(4000));
    expect(size.height).toBeGreaterThanOrEqual(FULL_RECORDING_CONTENT_PX);
    expect(size.height).toBeGreaterThanOrEqual(
      FULL_RECORDING_HANDS_FREE_CONTENT_PX,
    );
  });

  it("covers the primed, transcribing and error cards too", () => {
    expect(
      getPopupSize("full", "primed", null, null).height,
    ).toBeGreaterThanOrEqual(FULL_PRIMED_CONTENT_PX);
    expect(
      getPopupSize(
        "full",
        "transcribing",
        sentenceOfLength(4000),
        sentenceOfLength(4000),
      ).height,
    ).toBeGreaterThanOrEqual(FULL_TRANSCRIBING_CONTENT_PX);
    expect(
      getPopupSize("full", "error", sentenceOfLength(4000), null).height,
    ).toBeGreaterThanOrEqual(FULL_ERROR_CONTENT_PX);
  });

  it("covers the compact capture card, which keeps both status rows", () => {
    // Compact drops the live-text box but not the status paragraph, which wraps
    // to three lines at 336px, nor the stop/cancel hint.
    const compactCapture = CARD_FRAME_PX + 52 + 12 + 3 * 20 + 12 + 16;
    expect(
      getPopupSize("compact", "recording", null, sentenceOfLength(4000)).height,
    ).toBeGreaterThanOrEqual(compactCapture);
    expect(
      getPopupSize("compact", "primed", null, null).height,
    ).toBeGreaterThanOrEqual(compactCapture);
  });

  it("caps message-driven growth too", () => {
    const long = getPopupSize("full", "error", sentenceOfLength(4000), null);
    const longer = getPopupSize("full", "error", sentenceOfLength(40000), null);
    expect(longer.height).toBe(long.height);
    expect(long.height).toBeLessThan(400);
    // Growth stops exactly at the clamp, not somewhere past it.
    expect(
      getPopupSize("full", "error", sentenceOfLength(48 * 3), null).height,
    ).toBeLessThan(long.height);
    expect(POPUP_MESSAGE_LINE_CLAMP).toBe(6);
    expect(POPUP_PREVIEW_LINE_CLAMP).toBe(4);
  });

  it("still counts short text honestly", () => {
    expect(estimatePopupTextLines(null, 48, 4)).toBe(0);
    expect(estimatePopupTextLines("one line", 48, 4)).toBe(1);
    expect(estimatePopupTextLines("a\nb\nc", 48, 4)).toBe(3);
    expect(estimatePopupTextLines("a\nb\nc\nd\ne\nf", 48, 4)).toBe(4);
  });
});

describe("resolveOverlayBounds", () => {
  it("keeps the bottom edge pinned across a sweep of previews and displays", () => {
    const previews = [
      null,
      sentenceOfLength(20),
      sentenceOfLength(200),
      sentenceOfLength(1200),
      sentenceOfLength(9000),
      `${sentenceOfLength(60)}\n`.repeat(40),
    ];
    const phases = ["primed", "recording", "transcribing", "done", "error"] as const;
    const displayModes = ["full", "compact", "minimal"] as const;

    for (const workArea of WORK_AREAS) {
      for (const displayMode of displayModes) {
        for (const phase of phases) {
          const anchor = resolveInitialOverlayAnchor({
            workArea,
            size: getPopupSize(displayMode, phase, null, null),
            kind: "dictation",
          });

          for (const preview of previews) {
            const size = getPopupSize(displayMode, phase, preview, preview);
            const bounds = resolveOverlayBounds({ workArea, size, anchor });

            const context = `${displayMode}/${phase}/${size.height}px on ${workArea.width}x${workArea.height}`;
            expect(
              bounds.y + bounds.height,
              `bottom overflow: ${context}`,
            ).toBeLessThanOrEqual(workArea.y + workArea.height);
            expect(bounds.y, `top overflow: ${context}`).toBeGreaterThanOrEqual(
              workArea.y,
            );
            expect(bounds.x, `left overflow: ${context}`).toBeGreaterThanOrEqual(
              workArea.x,
            );
            expect(
              bounds.x + bounds.width,
              `right overflow: ${context}`,
            ).toBeLessThanOrEqual(workArea.x + workArea.width);
          }
        }
      }
    }
  });

  it("grows upward, not downward, when the estimate gets taller", () => {
    const workArea = WORK_AREAS[0];
    const anchor = resolveInitialOverlayAnchor({
      workArea,
      size: { width: 432, height: 232 },
      kind: "dictation",
    });

    const small = resolveOverlayBounds({
      workArea,
      size: { width: 432, height: 232 },
      anchor,
    });
    const large = resolveOverlayBounds({
      workArea,
      size: { width: 432, height: 308 },
      anchor,
    });

    expect(small.y + small.height).toBe(large.y + large.height);
    expect(large.y).toBeLessThan(small.y);
  });

  it("clamps a window taller than the work area instead of hanging off it", () => {
    const workArea = WORK_AREAS[2];
    const bounds = resolveOverlayBounds({
      workArea,
      size: { width: 432, height: 900 },
      anchor: resolveInitialOverlayAnchor({
        workArea,
        size: { width: 432, height: 900 },
        kind: "dictation",
      }),
    });

    expect(bounds.height).toBe(workArea.height);
    expect(bounds.y).toBe(workArea.y);
    expect(bounds.y + bounds.height).toBe(workArea.y + workArea.height);
  });

  it("tucks the recording chip into the bottom-right corner", () => {
    const workArea = WORK_AREAS[0];
    const size = { width: 320, height: 80 };
    const bounds = resolveOverlayBounds({
      workArea,
      size,
      anchor: resolveInitialOverlayAnchor({ workArea, size, kind: "recording" }),
    });

    expect(bounds.x + bounds.width).toBe(workArea.x + workArea.width - 20);
    expect(bounds.y + bounds.height).toBe(workArea.y + workArea.height - 20);
  });
});

describe("isOverlayAnchorOnScreen", () => {
  it("accepts an anchor the user dragged to a connected display", () => {
    expect(isOverlayAnchorOnScreen({ left: 600, bottom: 800 }, WORK_AREAS)).toBe(
      true,
    );
    expect(
      isOverlayAnchorOnScreen({ left: -1200, bottom: 400 }, WORK_AREAS),
    ).toBe(true);
  });

  it("rejects an anchor on a display that is gone, and missing/garbage values", () => {
    expect(
      isOverlayAnchorOnScreen({ left: 9000, bottom: 9000 }, WORK_AREAS),
    ).toBe(false);
    expect(isOverlayAnchorOnScreen(null, WORK_AREAS)).toBe(false);
    expect(
      isOverlayAnchorOnScreen({ left: Number.NaN, bottom: 400 }, WORK_AREAS),
    ).toBe(false);
  });
});

describe("saved overlay placements", () => {
  it("only treats a dragged position as a pin", () => {
    expect(
      resolveSavedOverlayAnchor({ bottom: 800, left: 600 }, WORK_AREAS),
    ).toEqual({ bottom: 800, left: 600 });
    // A placement that only remembers a display mode is not a drag: the HUD has
    // to keep following the cursor onto whichever display the user is on.
    expect(
      resolveSavedOverlayAnchor({ displayMode: "compact" }, WORK_AREAS),
    ).toBeNull();
    expect(resolveSavedOverlayAnchor({ bottom: 800 }, WORK_AREAS)).toBeNull();
    expect(resolveSavedOverlayAnchor({ left: 600 }, WORK_AREAS)).toBeNull();
    expect(resolveSavedOverlayAnchor(undefined, WORK_AREAS)).toBeNull();
    // A drag onto a display that is no longer connected still loses.
    expect(
      resolveSavedOverlayAnchor({ bottom: 9000, left: 9000 }, WORK_AREAS),
    ).toBeNull();
  });

  it("never invents an anchor when the display mode changes", () => {
    // The Compact/Expand button and the minimal pill's double-click both land
    // here. Synthesising bounds would pin the HUD to one display forever, and
    // the synthesised `left` would be the *previous*, wider card's left edge,
    // so every narrower mode would then render off-centre.
    const fresh = withOverlayDisplayMode(undefined, "compact");
    expect(fresh).toEqual({ displayMode: "compact" });
    expect(resolveSavedOverlayAnchor(fresh, WORK_AREAS)).toBeNull();

    const afterSecondToggle = withOverlayDisplayMode(fresh, "minimal");
    expect(afterSecondToggle).toEqual({ displayMode: "minimal" });
    expect(resolveSavedOverlayAnchor(afterSecondToggle, WORK_AREAS)).toBeNull();
  });

  it("keeps a real dragged anchor across a display-mode change", () => {
    const dragged = { bottom: 800, left: 600 };
    const toggled = withOverlayDisplayMode(dragged, "minimal");

    expect(toggled).toEqual({ bottom: 800, left: 600, displayMode: "minimal" });
    expect(resolveSavedOverlayAnchor(toggled, WORK_AREAS)).toEqual(dragged);
  });
});
