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

/** The view's main column: the tallest scroll container inside `root`. */
function findPrimaryScroller(root: HTMLElement): HTMLElement | null {
  let primary: HTMLElement | null = null;
  for (const element of root.querySelectorAll<HTMLElement>(SCROLLER_SELECTOR)) {
    if (!primary || element.clientHeight > primary.clientHeight) {
      primary = element;
    }
  }
  return primary;
}

/**
 * Whether a scroll event came from a view's main column rather than a nested
 * list, judged by size so it costs nothing per event.
 */
export function isPrimaryScroll(root: HTMLElement, target: EventTarget | null): target is HTMLElement {
  return (
    target instanceof HTMLElement &&
    target !== root &&
    target.clientHeight >= root.clientHeight * 0.5
  );
}

/**
 * Scroll the view inside `root` back to `top`. A view often paints before its
 * data arrives, so this retries for a few frames until the content is tall
 * enough. Returns a cancel function for a switch that happens meanwhile.
 */
export function restoreViewScroll(root: HTMLElement, top: number): () => void {
  let frame = 0;
  let handle = 0;
  const attempt = () => {
    const scroller = findPrimaryScroller(root);
    const reachable = scroller ? scroller.scrollHeight - scroller.clientHeight >= top : false;
    if (scroller && (reachable || frame >= RESTORE_FRAMES)) {
      scroller.scrollTop = top;
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
