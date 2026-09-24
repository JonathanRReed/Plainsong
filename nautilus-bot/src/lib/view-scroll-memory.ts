/**
 * Where each workspace view was scrolled to, so switching away and back lands
 * the reader where they left off. Views unmount on a switch, and each owns its
 * scroll container (a Radix ScrollArea viewport or a plain overflow column),
 * so the shell remembers the position rather than the element.
 */

const SCROLLER_SELECTOR =
  "[data-radix-scroll-area-viewport], .overflow-y-auto, .overflow-auto";

/** How long a restore keeps trying while the view's content fills in. */
const RESTORE_FRAMES = 30;

/**
 * A remembered position, and which of the view's main columns it belongs to.
 * A view can have several (Meetings has its list and a transcript side by
 * side), and one's offset put on another lands the reader somewhere random.
 */
export type ViewScrollPosition = {
  /** Order among the view's main columns, which is stable across mounts. */
  index: number;
  top: number;
};

/** A main column fills at least half the workspace; nested lists do not. */
function isMainColumn(root: HTMLElement, element: HTMLElement): boolean {
  return element !== root && element.clientHeight >= root.clientHeight * 0.5;
}

/** The view's main columns, in document order. */
function mainColumns(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(SCROLLER_SELECTOR)).filter((element) =>
    isMainColumn(root, element),
  );
}

/**
 * The position to remember for a scroll event, or null when it came from a
 * nested list rather than one of the view's main columns.
 */
export function readViewScroll(
  root: HTMLElement,
  target: EventTarget | null,
): ViewScrollPosition | null {
  // The size check first, so a nested list's scroll costs no query.
  if (!(target instanceof HTMLElement) || !isMainColumn(root, target)) {
    return null;
  }
  const index = mainColumns(root).indexOf(target);
  return index === -1 ? null : { index, top: target.scrollTop };
}

/**
 * Scroll the same main column back to where it was. A view often paints
 * before its data arrives, so this retries for a few frames until the column
 * is there and tall enough, and gives up rather than scroll a different one.
 * Returns a cancel function for a switch that happens meanwhile.
 */
export function restoreViewScroll(root: HTMLElement, position: ViewScrollPosition): () => void {
  let frame = 0;
  let handle = 0;
  const attempt = () => {
    const scroller = mainColumns(root)[position.index];
    const reachable = scroller
      ? scroller.scrollHeight - scroller.clientHeight >= position.top
      : false;
    if (scroller && (reachable || frame >= RESTORE_FRAMES)) {
      scroller.scrollTop = position.top;
      return;
    }
    frame += 1;
    if (frame <= RESTORE_FRAMES) {
      handle = window.requestAnimationFrame(attempt);
    }
  };
  attempt();
  return () => window.cancelAnimationFrame(handle);
}
