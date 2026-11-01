import type { CallCaptureRequest, NotificationFocus, PlainsongNotification } from "./notification-policy";

interface NotificationActionSource {
  on(event: "click" | "close" | "failed", listener: () => void): unknown;
  on(event: "action", listener: (event: { actionIndex: number }) => void): unknown;
}

export function bindNotificationActions(
  note: NotificationActionSource,
  notification: PlainsongNotification,
  handlers: {
    openView: (focus: NotificationFocus) => void;
    recordMeeting: (call: CallCaptureRequest) => void;
    release: () => void;
  },
): void {
  note.on("click", () => {
    handlers.openView(notification.focus);
    handlers.release();
  });
  note.on("action", ({ actionIndex: index }) => {
    if (index !== 0 || !notification.actions?.[index]) return;
    const focus = notification.focus;
    if (notification.kind !== "call_detected" || focus.view !== "recordings" || !focus.callCapture) return;
    handlers.recordMeeting(focus.callCapture);
    handlers.release();
  });
  note.on("close", handlers.release);
  note.on("failed", handlers.release);
}
