import { useCallback, useEffect, useState } from "react";
import { listen } from "@/lib/electron";
import {
  dismissDetectedCall,
  getMeetingCallStatus,
  type DetectedCall,
  type MeetingCallStatus,
} from "@/lib/backend/recordings";

const EMPTY_STATUS: MeetingCallStatus = {
  supported: false,
  enabled: false,
  accessibilityGranted: false,
  activeCall: null,
};

/**
 * How often the status is re-read as a backstop. The sidecar pushes
 * `meeting-call-detected` / `meeting-call-ended` the moment they happen; the
 * poll only covers a window that missed an event while it was not mounted.
 */
const REFRESH_MS = 30_000;

export interface DetectedCallState {
  status: MeetingCallStatus;
  /** The call to offer, or null: none, dismissed, or detection off. */
  call: DetectedCall | null;
  dismiss: (callId: number) => Promise<void>;
  refresh: () => Promise<void>;
}

function normalizeEvent(payload: unknown): DetectedCall | null {
  if (!payload || typeof payload !== "object") return null;
  const call = payload as Partial<DetectedCall>;
  return typeof call.callId === "number" && typeof call.appLabel === "string"
    ? (call as DetectedCall)
    : null;
}

/**
 * The live-call detector, as the Meetings header sees it.
 *
 * Reads only. Nothing here can start a recording: `dismiss` tells the sidecar
 * to stop offering this one call, and the offer itself is answered by the
 * view through the same consent dialog "New meeting" opens.
 */
export function useDetectedCall(options?: { enabled?: boolean }): DetectedCallState {
  const enabled = options?.enabled !== false;
  const [status, setStatus] = useState<MeetingCallStatus>(EMPTY_STATUS);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getMeetingCallStatus());
    } catch {
      // A detector that cannot answer offers nothing. It never puts an error
      // over the reader's meetings.
      setStatus(EMPTY_STATUS);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);

    void listen("meeting-call-detected", (event) => {
      const call = normalizeEvent(event.payload);
      if (disposed || !call) return;
      setStatus((current) => ({ ...current, supported: true, enabled: true, activeCall: call }));
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisteners.push(dispose);
    });
    void listen("meeting-call-ended", (event) => {
      const call = normalizeEvent(event.payload);
      if (disposed) return;
      setStatus((current) =>
        !call || current.activeCall?.callId === call.callId
          ? { ...current, activeCall: null }
          : current,
      );
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisteners.push(dispose);
    });

    return () => {
      disposed = true;
      window.clearInterval(timer);
      unlisteners.forEach((dispose) => dispose());
    };
  }, [enabled, refresh]);

  const dismiss = useCallback(async (callId: number) => {
    // Hide it at once; the sidecar's answer is the same status, re-read.
    setStatus((current) =>
      current.activeCall?.callId === callId
        ? { ...current, activeCall: { ...current.activeCall, dismissed: true } }
        : current,
    );
    try {
      setStatus(await dismissDetectedCall(callId));
    } catch (error) {
      console.warn("Could not dismiss the detected call:", error);
    }
  }, []);

  const call = status.activeCall && !status.activeCall.dismissed ? status.activeCall : null;
  return { status, call, dismiss, refresh };
}
