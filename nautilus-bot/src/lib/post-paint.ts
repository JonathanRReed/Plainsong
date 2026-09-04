type RequestFrame = (callback: FrameRequestCallback) => number;
type ScheduleTask = (callback: () => void) => number;

export function scheduleAfterPaint(
  callback: () => void,
  requestFrame: RequestFrame = window.requestAnimationFrame.bind(window),
  scheduleTask: ScheduleTask = (task) => window.setTimeout(task, 0),
): void {
  requestFrame(() => {
    requestFrame(() => {
      scheduleTask(callback);
    });
  });
}
