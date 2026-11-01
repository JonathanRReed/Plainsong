export type QuitMeetingFinalization =
  | { status: "confirmed" }
  | { status: "timed_out" }
  | { status: "failed"; error: unknown };

type MeetingQuitDraftCallbacks = {
  flushRendererDrafts: () => Promise<boolean>;
  finalizeMeeting: () => Promise<QuitMeetingFinalization>;
  reissueQuit: () => void;
  setQuitPending: (pending: boolean) => void;
  onQuitCancelled?: (error?: unknown) => void;
  onFinalizationFailure: (result: Extract<QuitMeetingFinalization, { status: "failed" }>) => void;
};

type BeforeQuitOptions = {
  activeMeetingId: string | null;
  needsRendererFlush: boolean;
};

/** Coordinates renderer saves and meeting finalization without starting shutdown early. */
export function createMeetingQuitDraftCoordinator(callbacks: MeetingQuitDraftCallbacks) {
  let rendererDraftsPrepared = false;
  let rendererFlushPending = false;
  let meetingFinalizationPending = false;
  let attemptedMeetingId: string | null = null;
  let finalShutdownStarted = false;

  const cancelPendingQuit = (error?: unknown) => {
    rendererDraftsPrepared = false;
    rendererFlushPending = false;
    meetingFinalizationPending = false;
    callbacks.setQuitPending(false);
    callbacks.onQuitCancelled?.(error);
  };

  return {
    beforeQuit(options: BeforeQuitOptions): boolean {
      if (finalShutdownStarted) return true;
      if (rendererFlushPending || meetingFinalizationPending) return false;

      if (!rendererDraftsPrepared && options.needsRendererFlush) {
        rendererFlushPending = true;
        callbacks.setQuitPending(true);
        let flush: Promise<boolean>;
        try {
          flush = callbacks.flushRendererDrafts();
        } catch (error) {
          cancelPendingQuit(error);
          return false;
        }
        void flush.then((allowed) => {
          rendererFlushPending = false;
          if (!allowed) {
            cancelPendingQuit();
            return;
          }
          rendererDraftsPrepared = true;
          callbacks.reissueQuit();
        }, (error: unknown) => {
          cancelPendingQuit(error);
        });
        return false;
      }

      if (options.activeMeetingId && attemptedMeetingId !== options.activeMeetingId) {
        meetingFinalizationPending = true;
        callbacks.setQuitPending(true);
        const meetingId = options.activeMeetingId;
        let finalization: Promise<QuitMeetingFinalization>;
        try {
          finalization = callbacks.finalizeMeeting();
        } catch (error) {
          cancelPendingQuit(error);
          callbacks.onFinalizationFailure({ status: "failed", error });
          return false;
        }
        void finalization.then((result) => {
          meetingFinalizationPending = false;
          if (result.status !== "confirmed") {
            const error = result.status === "failed" ? result.error
              : new Error("The meeting is still saving. Try quitting again after it finishes.");
            cancelPendingQuit(error);
            callbacks.onFinalizationFailure({ status: "failed", error });
            return;
          }

          attemptedMeetingId = meetingId;
          rendererDraftsPrepared = false;
          callbacks.reissueQuit();
        }, (error: unknown) => {
          cancelPendingQuit(error);
          callbacks.onFinalizationFailure({ status: "failed", error });
        });
        return false;
      }

      finalShutdownStarted = true;
      return true;
    },

    isFinalShutdownStarted(): boolean {
      return finalShutdownStarted;
    },
  };
}
