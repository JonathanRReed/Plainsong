type RequestFrame = (callback: FrameRequestCallback) => number;
type ScheduleTask = (callback: () => void) => number;

export function scheduleAfterPaint(
  callback: () => void,
  requestFrame: RequestFrame = window.requestAnimationFrame.bind(window),
  scheduleTask: ScheduleTask = (task) => window.setTimeout(task, 0),
): () => void {
  let cancelled = false;
  requestFrame(() => {
    if (cancelled) return;
    requestFrame(() => {
      if (cancelled) return;
      scheduleTask(() => {
        if (!cancelled) callback();
      });
    });
  });
  return () => { cancelled = true; };
}
