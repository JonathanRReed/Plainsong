import { MeetingMicrophoneFallback } from "@/components/meetings/microphone-fallback";
import { MeetingSourceLevelMeters } from "@/components/meetings/meeting-source-levels";
import type { MeetingMicrophoneInput } from "@/lib/meeting-microphone-input";
import { useMeetingTranscriptionActivity } from "@/hooks/use-meeting-transcription-activity";
import { TranscriptionActivity } from "@/components/meetings/transcription-activity";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LogicalSize, invoke, listen, getCurrentWindow } from "@/lib/electron";
import {
  Mic,
  X,
  GripHorizontal,
  PanelsTopLeft,
  Maximize2,
  Minimize2,
  AppWindow,
  Pause,
  Play,
  Square,
  Monitor,
  CheckCircle2,
  Loader2,
  Copy,
  AlertTriangle,
} from "lucide-react";
import {
  getRecording,
  getWaveformData,
  pauseRecording,
  resumeRecording,
  stopRecording,
  updateRecordingNotes,
  queueMeetingNoteRecovery,
} from "@/lib/backend/recordings";
import {
  describeMeetingConsent,
  MEETING_CONSENT_NOTICE_TEXT,
} from "@/lib/meeting-consent";
import {
  describeAudioSourceWarning,
  describeTranscriptDelay,
  MEETING_AUDIO_SOURCE_WARNING_EVENT,
  RECORDING_TRANSCRIPTION_STREAM_EVENT,
  type AudioSourceWarningDescriptor,
  type MeetingAudioSourceWarningEvent,
  type RecordingTranscriptionStreamEvent,
} from "@/lib/meeting-transcript-stream";
import {
  getMeetingTemplateOption,
  type CustomMeetingTemplate,
} from "@/lib/meeting-templates";
import { getSettings } from "@/lib/backend/settings";
import { rebaseMeetingNotes } from "@/lib/meeting-notes";
import { AudioWaveform } from "@/components/ui/audio-waveform";
import {
  INITIAL_MEETING_LIFECYCLE_STATE,
  meetingCaptureRestarted,
  meetingElapsedSeconds,
  reduceMeetingLifecycleState,
  type MeetingLifecycleEvent,
  type MeetingLifecyclePhase,
  type MeetingLifecycleState,
} from "@/features/meetings/runtime";

import { OVERLAY_MAX_SIZE } from "../../../electron/overlay-placement";

type PauseView = Pick<MeetingLifecycleState, "paused" | "closedPausedMs" | "pauseStartedAtMs">;

const NOT_PAUSED: PauseView = { paused: false, closedPausedMs: 0, pauseStartedAtMs: null };

function pauseViewOf(state: MeetingLifecycleState): PauseView {
  return {
    paused: state.paused,
    closedPausedMs: state.closedPausedMs,
    pauseStartedAtMs: state.pauseStartedAtMs,
  };
}

const RECORDING_CARD_MARGIN = 24;

type DisplayMode = "full" | "compact" | "minimal";

export function RecordingPopup() {
  const window = useMemo(() => getCurrentWindow(), []);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [systemAudioActive, setSystemAudioActive] = useState(false);
  const [phase, setPhase] = useState<MeetingLifecyclePhase>("recording");
  const [transcriptionPreview, setTranscriptionPreview] = useState("");
  const [previewDelay, setPreviewDelay] = useState(() =>
    describeTranscriptDelay(null),
  );
  const [lostAudioSeconds, setLostAudioSeconds] = useState(0);
  const [audioSourceWarning, setAudioSourceWarning] =
    useState<AudioSourceWarningDescriptor | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [pauseView, setPauseView] = useState<PauseView>(NOT_PAUSED);
  const [togglingPause, setTogglingPause] = useState(false);
  const pauseRequestRef = useRef<object | null>(null);
  const stopRequestRef = useRef<object | null>(null);
  const recordingCardRef = useRef<HTMLDivElement | null>(null);
  const recordingContentRef = useRef<HTMLDivElement | null>(null);
  const lastWindowSizeRef = useRef<LogicalSize | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("full");
  const [levels, setLevels] = useState<number[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [captureControlError, setCaptureControlError] = useState<string | null>(null);
  const [microphoneInput, setMicrophoneInput] = useState<MeetingMicrophoneInput | null>(null);
  const [microphoneWarningDismissed, setMicrophoneWarningDismissed] = useState(false);
  const [consentNoticeMessage, setConsentNoticeMessage] = useState<
    string | null
  >(null);
  const [recordingTitle, setRecordingTitle] = useState("Live meeting");
  const [meetingNotes, setMeetingNotes] = useState("");
  type FinalPopupDraft = { id: string; recordingId: string; baseNotes: string; notes: string; journaled: boolean };
  const [failedFinalDrafts, setFailedFinalDrafts] = useState<FinalPopupDraft[]>([]);
  const finalDraftWritesRef = useRef(new Map<string, Promise<void>>());
  const outstandingFinalDraftsRef = useRef(new Map<string, FinalPopupDraft>());
  const [noteSaveError, setNoteSaveError] = useState<string | null>(null);
  const noteSaveErrorRef = useRef<HTMLDivElement | null>(null);
  const [noteRetryRevision, setNoteRetryRevision] = useState(0);
  const latestMeetingNotesRef = useRef(meetingNotes);
  latestMeetingNotesRef.current = meetingNotes;
  const liveNotesRef = useRef<HTMLTextAreaElement | null>(null);
  // The overlay cannot take keys until it is made focusable on purpose
  // (`electron/overlay-notes-focus.ts`). True while the notes box holds focus.
  const liveNotesFocusedRef = useRef(false);
  const focusLiveNotes = useCallback(async () => {
    if (!liveNotesFocusedRef.current) {
      const granted = await invoke<boolean>("__overlay_notes_focus__", { focus: true }).catch(() => false);
      if (!granted) return;
    }
    liveNotesFocusedRef.current = true;
    liveNotesRef.current?.focus();
  }, []);
  const releaseLiveNotes = useCallback(() => {
    if (!liveNotesFocusedRef.current) return;
    liveNotesFocusedRef.current = false;
    void invoke("__overlay_notes_focus__", { focus: false }).catch(() => undefined);
  }, []);
  const [liveNotesRequested, setLiveNotesRequested] = useState(0);
  useEffect(() => {
    // The menu bar's "Type Live Notes" already made the overlay focusable.
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("overlay-focus-live-notes", () => {
      if (disposed) return;
      liveNotesFocusedRef.current = true;
      setDisplayMode("full");
      setLiveNotesRequested((count) => count + 1);
    })
      .then((dispose) => {
        if (disposed) {
          dispose?.();
          return;
        }
        unlisten = dispose;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    if (liveNotesRequested > 0) liveNotesRef.current?.focus();
  }, [liveNotesRequested]);
  const noteWritesRef = useRef(new Map<string, Promise<void>>());
  const noteScopeRef = useRef<string | null>(null);
  const [meetingTemplateLabel, setMeetingTemplateLabel] = useState("Auto");
  const [meetingTemplateDescription, setMeetingTemplateDescription] = useState(
    "Plainsong chooses the note format based on what you captured.",
  );
  const [consentPromptShown, setConsentPromptShown] = useState(false);
  const [consentNoticeMode, setConsentNoticeMode] = useState<string | null>(
    null,
  );
  const [copiedNotice, setCopiedNotice] = useState(false);
  const [copyingNotice, setCopyingNotice] = useState(false);
  const [noticeCopyError, setNoticeCopyError] = useState<string | null>(null);
  const noticeCopyRequestRef = useRef<object | null>(null);
  // Loaded once so a meeting tagged with a user-saved template still shows
  // its real name here instead of falling back to "Auto" (see
  // `getMeetingTemplateOption`'s custom-template lookup).
  const [customMeetingTemplates, setCustomMeetingTemplates] = useState<
    CustomMeetingTemplate[]
  >([]);
  const [transcriptCommitted, setTranscriptCommitted] = useState(false);
  const recordingIdRef = useRef<string | null>(null);
  const lifecycleRef = useRef<MeetingLifecycleState>(
    INITIAL_MEETING_LIFECYCLE_STATE,
  );
  const lastSavedMeetingNotesRef = useRef("");

  const { activity: transcriptionActivity } = useMeetingTranscriptionActivity(
    recordingId, phase === "stopping" || phase === "processing",
  );

  recordingIdRef.current = recordingId;

  // Loaded on mount, then re-read on every `settings-changed` broadcast, so
  // a template saved or edited from the main window's meetings workspace
  // updates this overlay's label without waiting for it to be reopened.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const refreshCustomMeetingTemplates = () => {
      void getSettings()
        .then((settings) => {
          if (!disposed) {
            setCustomMeetingTemplates(
              settings.transcription.meetingCustomTemplates ?? [],
            );
          }
        })
        .catch((error) => {
          console.warn("Failed to load custom meeting templates:", error);
        });
    };

    refreshCustomMeetingTemplates();
    void listen("settings-changed", () => {
      if (!disposed) {
        refreshCustomMeetingTemplates();
      }
    })
      .then((dispose) => {
        if (disposed) {
          dispose?.();
          return;
        }
        unlisten = dispose;
      })
      .catch((error) => {
        console.warn("Failed to subscribe to settings-changed:", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let receivedLiveLifecycle = false;
    const queuedLifecycle: MeetingLifecycleEvent[] = [];
    let unlisten: (() => void) | undefined;
    let unlistenStream: (() => void) | undefined;
    let unlistenSourceWarning: (() => void) | undefined;

    const applyLifecycle = (payload: MeetingLifecycleEvent, live: boolean) => {
      if (disposed) return;
      const previous = lifecycleRef.current;
      const incomingId = payload.recordingId?.trim() || null;
      if (live && !previous.recordingId && (!incomingId || !["preparing", "recording"].includes(payload.phase))) {
        if (incomingId) {
          queuedLifecycle.push(payload);
          if (queuedLifecycle.length > 32) queuedLifecycle.shift();
        }
        return;
      }
      if (payload.recordingId && previous.recordingId && payload.recordingId !== previous.recordingId
        && !["preparing", "recording"].includes(payload.phase)) return;
      const next = reduceMeetingLifecycleState(previous, payload);
      if (next === previous) return;
      if (live) receivedLiveLifecycle = true;
      lifecycleRef.current = next;
      recordingIdRef.current = next.recordingId;
      if (next.phase !== "idle" && next.recordingId) {
        setRecordingId(next.recordingId);
        setStartedAtMs(
          typeof next.startedAtMs === "number" ? next.startedAtMs : Date.now(),
        );
        setSystemAudioActive(next.systemAudioActive);
        setConsentPromptShown(next.consentPromptShown);
        setConsentNoticeMode(null);
        setConsentNoticeMessage(null);
        setPhase(next.phase);
        setMessage(next.message);
        setMicrophoneInput(next.microphoneInput ?? null);
        setMicrophoneWarningDismissed(next.microphoneWarningDismissed ?? false);
        setPauseView(pauseViewOf(next));
        // Only on an actual transition into capture. The sidecar re-emits
        // `recording` mid-meeting to carry a warning (dead writer, filling
        // disk); resetting on those would erase the visible source warning
        // and the transcript preview at the exact moment the user needs
        // them.
        if (next.phase !== "recording" || meetingCaptureRestarted(previous, next)) {
          setCaptureControlError(null);
          pauseRequestRef.current = null;
          stopRequestRef.current = null;
          setTogglingPause(false);
        }
        if (meetingCaptureRestarted(previous, next)) {
          noticeCopyRequestRef.current = null;
          setCopyingNotice(false);
          setCopiedNotice(false);
          setNoticeCopyError(null);
          setTranscriptionPreview("");
          setTranscriptCommitted(false);
          setPreviewDelay(describeTranscriptDelay(null));
          setLostAudioSeconds(0);
          setAudioSourceWarning(null);
        }
        setStopping(false);
        return;
      }

      setRecordingId(null);
      setStartedAtMs(null);
      setSystemAudioActive(false);
      setConsentPromptShown(false);
      setConsentNoticeMode(null);
      setConsentNoticeMessage(null);
      setPhase("recording");
      setMessage(null);
      noticeCopyRequestRef.current = null;
      setCopyingNotice(false);
      setCopiedNotice(false);
      setNoticeCopyError(null);
      setCaptureControlError(null);
      pauseRequestRef.current = null;
      stopRequestRef.current = null;
      setTogglingPause(false);
      setMicrophoneInput(null);
      setMicrophoneWarningDismissed(false);
      setPauseView(NOT_PAUSED);
      setTranscriptionPreview("");
      setTranscriptCommitted(false);
      setPreviewDelay(describeTranscriptDelay(null));
      setLostAudioSeconds(0);
      setAudioSourceWarning(null);
      setStopping(false);
    };

    const replayQueuedLifecycle = () => {
      const owner = lifecycleRef.current.recordingId;
      if (disposed || !owner) return;
      const pending = queuedLifecycle.splice(0);
      for (const event of pending) {
        if (event.recordingId?.trim() === owner) applyLifecycle(event, true);
      }
    };

    const setup = async () => {
      unlisten = await listen<MeetingLifecycleEvent>(
        "meeting-recording-state-changed",
        (event) => {
          applyLifecycle(event.payload, true);
          replayQueuedLifecycle();
        },
      );

      if (disposed) { unlisten(); return; }
      unlistenStream = await listen<RecordingTranscriptionStreamEvent>(
        RECORDING_TRANSCRIPTION_STREAM_EVENT,
        (event) => {
          if (disposed) return;
          const currentRecordingId = lifecycleRef.current.recordingId;
          if (
            !currentRecordingId ||
            event.payload.recordingId !== currentRecordingId
          ) {
            return;
          }
          setPreviewDelay(describeTranscriptDelay(event.payload));
          // `text` is the whole preview transcript so far, not just this
          // segment, so this pane replaces rather than appends. The segment's
          // own words ride along as `segmentText` for the line-by-line surface
          // in Meetings.
          if (event.payload.text.trim()) {
            setTranscriptionPreview(event.payload.text);
          }
          if (event.payload.kind === "gap") {
            const dropped = Math.max(
              0,
              (event.payload.endTime ?? 0) - (event.payload.startTime ?? 0),
            );
            setLostAudioSeconds((current) => current + dropped);
          }
          if (event.payload.isFinal) {
            setMessage("Transcript preview is ready in Meetings.");
            setTranscriptCommitted(true);
          }
        },
      );

      if (disposed) { unlistenStream(); return; }
      // A source going silent is a failure the user can still fix while the
      // meeting runs, and this overlay is often the only Plainsong surface on
      // screen at the time.
      unlistenSourceWarning = await listen<MeetingAudioSourceWarningEvent>(
        MEETING_AUDIO_SOURCE_WARNING_EVENT,
        (event) => {
          if (disposed) return;
          const currentRecordingId = lifecycleRef.current.recordingId;
          if (
            !currentRecordingId ||
            event.payload.recordingId !== currentRecordingId
          ) {
            return;
          }
          setAudioSourceWarning(describeAudioSourceWarning(event.payload));
        },
      );
      if (disposed) { unlistenSourceWarning(); return; }
      try {
        const initialState = await invoke<MeetingLifecycleEvent>("get_recording_overlay_state");
        if (!disposed && !receivedLiveLifecycle) applyLifecycle(initialState, false);
        replayQueuedLifecycle();
      } catch (error) {
        if (!disposed) console.error("Failed to load initial recording popup state:", error);
      }
    };

    void setup();
    return () => {
      disposed = true;
      noticeCopyRequestRef.current = null;
      queuedLifecycle.length = 0;
      unlisten?.();
      unlistenStream?.();
      unlistenSourceWarning?.();
    };
  }, []);

  useEffect(() => {
    if (!recordingId || phase !== "recording") {
      setElapsed(0);
      return;
    }

    // Excludes every pause, and stands still while paused: the reader is
    // looking at how much meeting has been kept, not how long the window
    // has been open.
    const tick = () => {
      setElapsed(
        meetingElapsedSeconds(
          { startedAtMs: startedAtMs ?? Date.now(), ...pauseView },
          Date.now(),
        ),
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [pauseView, phase, recordingId, startedAtMs]);

  useEffect(() => {
    if (!recordingId || phase !== "recording") {
      setLevels([]);
      return;
    }

    let cancelled = false;
    let isFetching = false;
    const interval = setInterval(async () => {
      if (isFetching) return;

      try {
        isFetching = true;
        const samples = await getWaveformData(recordingId);
        if (cancelled || !samples?.length) {
          isFetching = false;
          return;
        }

        const targetBars = 18;
        const stride = Math.max(1, Math.floor(samples.length / targetBars));
        const bars: number[] = [];
        for (
          let i = 0;
          i < samples.length && bars.length < targetBars;
          i += stride
        ) {
          const slice = samples.slice(i, i + stride);
          const avg =
            slice.reduce((acc, value) => acc + Math.abs(value), 0) /
            Math.max(1, slice.length);
          bars.push(Math.min(1, avg * 12));
        }
        if (!cancelled) {
          setLevels(bars);
        }
      } catch {
        // Ignore transient polling errors while recording starts/stops.
      } finally {
        isFetching = false;
      }
    }, 250);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [phase, recordingId]);

  useEffect(() => {
    if (!recordingId) {
      setRecordingTitle("Live meeting");
      setMeetingNotes("");
      setMeetingTemplateLabel("Auto");
      setMeetingTemplateDescription(
        "Plainsong chooses the note format based on what you captured.",
      );
      setConsentNoticeMode(null);
      setConsentNoticeMessage(null);
      lastSavedMeetingNotesRef.current = "";
      latestMeetingNotesRef.current = "";
      noteScopeRef.current = null;
      setNoteSaveError(null);
      return;
    }

    if (noteScopeRef.current !== recordingId) {
      noteScopeRef.current = recordingId;
      latestMeetingNotesRef.current = "";
      lastSavedMeetingNotesRef.current = "";
      setMeetingNotes("");
      setNoteSaveError(null);
    }
    let cancelled = false;
    void getRecording(recordingId)
      .then((recording) => {
        if (cancelled || !recording) {
          return;
        }

        setRecordingTitle(recording.title || "Live meeting");
        const nextNotes = recording.meetingNotes ?? "";
        const rebased = rebaseMeetingNotes({ base: lastSavedMeetingNotesRef.current, local: latestMeetingNotesRef.current, stored: nextNotes });
        latestMeetingNotesRef.current = rebased;
        setMeetingNotes(rebased);
        lastSavedMeetingNotesRef.current = nextNotes;

        const template = getMeetingTemplateOption(
          recording.meetingTemplateId ?? "auto",
          customMeetingTemplates,
        );
        setMeetingTemplateLabel(template.label);
        setMeetingTemplateDescription(template.description);
        setConsentPromptShown(Boolean(recording.consentPromptShown));
        setConsentNoticeMode(recording.consentNoticeMode ?? null);
        setConsentNoticeMessage(recording.consentNoticeMessage ?? null);
        if (recording.consentNoticeMessage?.trim()) {
          setMessage(recording.consentNoticeMessage);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to hydrate meeting popup recording:", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [recordingId, customMeetingTemplates]);

  useEffect(() => {
    if (!recordingId) {
      return;
    }

    const normalizedNotes = meetingNotes.trim();
    if (normalizedNotes === lastSavedMeetingNotesRef.current.trim()) {
      return;
    }

    const base = lastSavedMeetingNotesRef.current;
    const typed = meetingNotes;
    const timeoutId = globalThis.setTimeout(() => {
      const previous = noteWritesRef.current.get(recordingId) ?? Promise.resolve();
      const write = previous.catch(() => {}).then(async () => {
        let stored = base;
        try {
          stored = (await getRecording(recordingId))?.meetingNotes ?? "";
        } catch (error) {
          console.error("Failed to read stored meeting notes before autosave:", error);
        }
        const nextNotes = rebaseMeetingNotes({ base, local: typed, stored });
        try {
          await updateRecordingNotes(recordingId, nextNotes, undefined, stored);
          if (recordingIdRef.current !== recordingId) return;
          lastSavedMeetingNotesRef.current = nextNotes;
          const latest = rebaseMeetingNotes({ base: typed, local: latestMeetingNotesRef.current, stored: nextNotes });
          latestMeetingNotesRef.current = latest;
          setMeetingNotes(latest);
          setNoteSaveError(null);
        } catch (error) {
          console.error("Failed to update popup meeting notes:", error);
          if (recordingIdRef.current === recordingId) {
            setNoteSaveError(String(error).includes("Meeting notes changed while saving")
              ? "Saved notes changed. Retry note save to merge the latest notes."
              : "Notes could not be saved. Keep this popup open and retry.");
          }
        }
      });
      noteWritesRef.current.set(recordingId, write);
      void write.finally(() => {
        if (noteWritesRef.current.get(recordingId) === write) noteWritesRef.current.delete(recordingId);
      });
    }, 350);
    return () => globalThis.clearTimeout(timeoutId);
  }, [meetingNotes, recordingId, noteRetryRevision]);

  useEffect(() => {
    if (!copiedNotice) {
      return;
    }
    const id = globalThis.setTimeout(() => setCopiedNotice(false), 1500);
    return () => globalThis.clearTimeout(id);
  }, [copiedNotice]);

  // The commit shine is a single gold set-down sweep — retire it after one pass
  // so the transcript block doesn't keep glinting once it's been laid down.
  useEffect(() => {
    if (!transcriptCommitted) {
      return;
    }
    const id = globalThis.setTimeout(() => setTranscriptCommitted(false), 800);
    return () => globalThis.clearTimeout(id);
  }, [transcriptCommitted]);

  const elapsedText = useMemo(() => {
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }, [elapsed]);

  const isTranscribing = phase === "stopping" || phase === "processing";
  const isPreparing = phase === "preparing";
  const isFailure =
    phase === "error" || phase === "recoverable" || phase === "cancelled";
  const isReady = phase === "ready";
  const captureIsLive = phase === "recording";
  const captureWarning = captureIsLive ? lifecycleRef.current.message?.trim() || null : null;
  const compactProcessingActivity = displayMode === "compact" && Boolean(transcriptionActivity);
  const activeMicrophoneFallback = phase === "recording" && Boolean(microphoneInput?.usedFallback) && !microphoneWarningDismissed;

  useLayoutEffect(() => {
    const resize = () => {
      let size = new LogicalSize(470, 650);
      if (failedFinalDrafts.length === 0 && displayMode === "minimal") {
        size = new LogicalSize(340, 46);
      } else if (failedFinalDrafts.length === 0 && displayMode === "compact") {
        const card = recordingCardRef.current;
        if (!card) return;
        const style = getComputedStyle(card);
        const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
        size = new LogicalSize(
          Math.min(330, OVERLAY_MAX_SIZE.recording.width),
          Math.min(OVERLAY_MAX_SIZE.recording.height, Math.ceil(
            Math.max(card.scrollHeight + border, card.offsetHeight) + RECORDING_CARD_MARGIN,
          )),
        );
      }
      const previous = lastWindowSizeRef.current;
      if (previous?.width === size.width && previous.height === size.height) return;
      lastWindowSizeRef.current = size;
      void window.setSize(size).catch((error) => {
        if (lastWindowSizeRef.current === size) lastWindowSizeRef.current = null;
        console.error("Failed to resize recording popup:", error);
      });
    };
    resize();
    if (displayMode !== "compact" || failedFinalDrafts.length > 0 || !recordingCardRef.current) return;
    const observer = new ResizeObserver(resize);
    observer.observe(recordingCardRef.current);
    // The content can change while the card is held at the security cap.
    if (recordingContentRef.current) observer.observe(recordingContentRef.current);
    return () => observer.disconnect();
  }, [displayMode, window, recordingId, failedFinalDrafts.length]);

  useEffect(() => {
    if (captureWarning) setDisplayMode("full");
  }, [captureWarning]);

  useEffect(() => {
    if (noteSaveError) noteSaveErrorRef.current?.scrollIntoView({ block: "nearest" });
  }, [noteSaveError]);

  const cycleDisplayMode = async () => {
    const next: DisplayMode =
      displayMode === "full"
        ? "compact"
        : displayMode === "compact"
          ? "minimal"
          : "full";
    setDisplayMode(next);
  };

  const hidePopup = useCallback(async () => {
    try {
      await invoke("dismiss_recording_overlay");
      await getCurrentWindow().hide();
    } catch (error) {
      console.error("Failed to hide recording popup:", error);
    }
  }, []);

  // Note: no in-window Escape handler — the overlay window is created with
  // focusable: false and shown via showInactive() (electron/windows.ts), so
  // it never receives keyboard focus and a document-level keydown listener
  // could never fire. Dismissal is via the close button.

  const openMainApp = async (
    view?: "recordings" | "settings",
    targetRecordingId?: string,
  ) => {
    try {
      if (view) {
        await invoke("open_main_window_to", {
          view,
          recordingId: targetRecordingId ?? null,
        });
      } else {
        await invoke("open_main_window");
      }
    } catch (error) {
      console.error("Failed to open main window:", error);
    }
  };

  const handleTogglePause = async () => {
    if (!recordingId || stopping || togglingPause) return;
    const request = {};
    pauseRequestRef.current = request;
    setTogglingPause(true);
    setCaptureControlError(null);
    try {
      // The sidecar's lifecycle event follows and is what every window
      // renders from; applying the answer here only closes the gap.
      const snapshot = pauseView.paused
        ? await resumeRecording(recordingId)
        : await pauseRecording(recordingId);
      if (pauseRequestRef.current !== request || recordingIdRef.current !== recordingId || lifecycleRef.current.phase !== "recording") return;
      setPauseView({
        paused: snapshot.paused,
        closedPausedMs: snapshot.closedPausedMs,
        pauseStartedAtMs: snapshot.pauseStartedAtMs,
      });
    } catch (error) {
      console.error("Failed to pause or resume recording from popup:", error);
      if (pauseRequestRef.current !== request || recordingIdRef.current !== recordingId || lifecycleRef.current.phase !== "recording") return;
      setDisplayMode("full");
      setCaptureControlError(
        error instanceof Error
          ? error.message
          : pauseView.paused
            ? "Plainsong could not resume this meeting."
            : "Plainsong could not pause this meeting.",
      );
    } finally {
      if (pauseRequestRef.current === request) {
        pauseRequestRef.current = null;
        setTogglingPause(false);
      }
    }
  };

  const saveFinalPopupDraft = (draft: FinalPopupDraft) => {
    if (finalDraftWritesRef.current.has(draft.id)) return;
    outstandingFinalDraftsRef.current.set(draft.id, draft);
    const queue = draft.journaled ? Promise.resolve(true) : queueMeetingNoteRecovery(draft).then(() => true, () => false);
    const previous = noteWritesRef.current.get(draft.recordingId) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      const journaled = await queue;
      let stored = draft.baseNotes;
      try { stored = (await getRecording(draft.recordingId))?.meetingNotes ?? ""; } catch {}
      const nextNotes = rebaseMeetingNotes({ base: draft.baseNotes, local: draft.notes, stored });
      try {
        await updateRecordingNotes(draft.recordingId, nextNotes, journaled ? draft.id : undefined, stored);
        outstandingFinalDraftsRef.current.delete(draft.id);
        setFailedFinalDrafts((current) => current.filter((item) => item.id !== draft.id));
      } catch {
        outstandingFinalDraftsRef.current.set(draft.id, { ...draft, journaled });
        setFailedFinalDrafts((current) => [...current.filter((item) => item.id !== draft.id), { ...draft, journaled }]);
      }
    }).finally(() => {
      finalDraftWritesRef.current.delete(draft.id);
      if (noteWritesRef.current.get(draft.recordingId) === write) noteWritesRef.current.delete(draft.recordingId);
    });
    finalDraftWritesRef.current.set(draft.id, write);
    noteWritesRef.current.set(draft.recordingId, write);
  };

  useEffect(() => {
    const target = globalThis.window as Window & { __plainsongPrepareQuit?: () => Promise<boolean> };
    const prepare = async () => {
      await Promise.all([...finalDraftWritesRef.current.values()]);
      const id = recordingIdRef.current;
      const notes = latestMeetingNotesRef.current;
      const drafts = [...outstandingFinalDraftsRef.current.values()];
      if (id && notes.trim() !== lastSavedMeetingNotesRef.current.trim()) {
        const existing = drafts.find((draft) => draft.recordingId === id && draft.notes === notes);
        if (!existing) drafts.push({ id: crypto.randomUUID(), recordingId: id,
          baseNotes: lastSavedMeetingNotesRef.current, notes, journaled: false });
      }
      for (const draft of drafts) {
        if (draft.journaled) continue;
        try {
          await queueMeetingNoteRecovery(draft);
          outstandingFinalDraftsRef.current.set(draft.id, { ...draft, journaled: true });
        } catch {
          outstandingFinalDraftsRef.current.set(draft.id, draft);
          setFailedFinalDrafts((current) => [...current.filter((item) => item.id !== draft.id), draft]);
          return false;
        }
      }
      // Typing during the journal write requires another quit check.
      return recordingIdRef.current === id && latestMeetingNotesRef.current === notes;
    };
    target.__plainsongPrepareQuit = prepare;
    return () => { if (target.__plainsongPrepareQuit === prepare) delete target.__plainsongPrepareQuit; };
  }, []);

  const handleCopyNotice = async () => {
    if (!recordingId || noticeCopyRequestRef.current) return;
    const request = {};
    noticeCopyRequestRef.current = request;
    setCopyingNotice(true);
    setCopiedNotice(false);
    setNoticeCopyError(null);
    try {
      await invoke("__overlay_copy_text__", { text: MEETING_CONSENT_NOTICE_TEXT });
      if (noticeCopyRequestRef.current === request && recordingIdRef.current === recordingId) {
        setCopiedNotice(true);
      }
    } catch {
      if (noticeCopyRequestRef.current === request && recordingIdRef.current === recordingId) {
        setNoticeCopyError("Could not copy the notice. Try again.");
      }
    } finally {
      if (noticeCopyRequestRef.current === request) {
        noticeCopyRequestRef.current = null;
        setCopyingNotice(false);
      }
    }
  };

  const handleStop = async () => {
    if (!recordingId || stopping) return;
    if (latestMeetingNotesRef.current.trim() !== lastSavedMeetingNotesRef.current.trim()) {
      saveFinalPopupDraft({ id: crypto.randomUUID(), recordingId, baseNotes: lastSavedMeetingNotesRef.current, notes: latestMeetingNotesRef.current, journaled: false });
    }
    const request = {};
    stopRequestRef.current = request;
    setStopping(true);
    setCaptureControlError(null);
    try {
      await stopRecording(recordingId);
    } catch (error) {
      console.error("Failed to stop recording from popup:", error);
      // An RPC rejection does not establish whether capture stopped. Keep
      // the authoritative lifecycle state and let the user retry the command.
      if (stopRequestRef.current === request && recordingIdRef.current === recordingId && lifecycleRef.current.phase === "recording") {
        setDisplayMode("full");
        setCaptureControlError("Plainsong could not confirm this meeting stopped. Try Stop again.");
      }
      if (stopRequestRef.current === request) {
        stopRequestRef.current = null;
        setStopping(false);
      }
    }
  };

  const previewText =
    transcriptionPreview.trim() ||
    (isFailure
      ? message || "Saved meeting audio needs your attention."
      : isReady
        ? "The transcript is ready in Meetings."
        : isTranscribing
          ? "Generating the first transcript preview for this meeting."
          : isPreparing
            ? systemAudioActive
              ? "Preparing your microphone and the meeting audio."
              : "Preparing your microphone."
            : "Capture is live. Stop when you want Plainsong to save and process the meeting.");

  const statusLabel = isFailure
    ? "Needs attention"
    : isReady
      ? "Ready"
      : isPreparing
        ? "Preparing"
        : isTranscribing
          ? "Processing"
          : "Live meeting";
  const captureModeLabel = systemAudioActive ? "Me + Them" : "Mic only";
  // The chip changes phase without focus moving, so a screen reader hears it
  // only through a live region. One short phrase per phase; the clock stays
  // out of it, or it would be read every second.
  const spokenStatus = isFailure
    ? "Meeting needs attention"
    : isReady
      ? "Meeting ready"
      : isPreparing
        ? "Preparing the meeting"
        : isTranscribing
          ? "Finishing the meeting"
          : captureIsLive
            ? pauseView.paused
              ? "Meeting paused"
              : "Recording the meeting"
            : "";
  const statusAnnouncer = (
    <span className="sr-only" role="status" aria-live="polite">
      {spokenStatus}
    </span>
  );
  const consentStatus = describeMeetingConsent({
    consentPromptShown,
    consentNoticeMode,
    consentNoticeMessage,
  });

  const captureControls = captureIsLive ? (
    <>
      <button
        type="button"
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border/80 bg-card text-foreground hover:bg-muted disabled:opacity-50"
        onClick={() => void handleTogglePause()}
        disabled={stopping || togglingPause}
        aria-label={pauseView.paused ? "Resume recording" : "Pause recording"}
      >
        {pauseView.paused ? (
          <Play className="h-4.5 w-4.5 fill-current" />
        ) : (
          <Pause className="h-4.5 w-4.5 fill-current" />
        )}
      </button>
      <button
        type="button"
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border/80 bg-card text-foreground hover:bg-muted disabled:opacity-50"
        onClick={handleStop}
        disabled={stopping}
        aria-label="Stop recording"
      >
        <Square className="h-4.5 w-4.5 fill-current" />
      </button>
    </>
  ) : null;
  const statusBadge = (
    <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
      isFailure || isTranscribing || isPreparing || (captureIsLive && pauseView.paused)
        ? "border-rust/30 bg-rust/10 text-rust"
        : `border-gold/40 bg-gold/10 text-gold-text${displayMode === "full" ? " gilt-halo" : ""}`
    }`}>
      {isTranscribing || isPreparing
        ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        : <span className={`neume ${captureIsLive && !pauseView.paused ? "neume-lit" : "neume-hollow"}`} aria-hidden="true" />}
      {captureIsLive && pauseView.paused ? "Paused" : statusLabel}
    </span>
  );

  if (failedFinalDrafts.length > 0) {
    return <div className="h-screen overflow-y-auto bg-background p-4 text-foreground">
      {failedFinalDrafts.map((draft) => <section key={draft.id} className="mb-4" aria-label="Final popup notes recovery">
        <p role="status">{draft.journaled ? "Final notes are stored for recovery. Retry here or in Meetings." : "Final notes could not be stored. Keep Plainsong open and retry."}</p>
        <textarea aria-label="Retained final popup notes" readOnly value={draft.notes} rows={5} className="mt-3 w-full rounded-md border bg-background p-3" />
        <button type="button" className="mt-2 rounded-md border px-3 py-2" onClick={() => saveFinalPopupDraft(draft)}>Retry final note save</button>
      </section>)}
      <button type="button" className="rounded-md border px-3 py-2" onClick={() => void openMainApp("recordings")}>Open meeting view</button>
    </div>;
  }

  if (!recordingId) {
    return <div className="h-screen w-screen bg-transparent" />;
  }

  if (displayMode === "minimal") {
    return (
      <div
        data-drag-region
        className="flex h-screen w-screen items-center justify-center bg-transparent"
      >
        {statusAnnouncer}
        <div className={`flex max-w-[calc(100vw-8px)] items-center gap-2 rounded-full border border-border/80 bg-background ${activeMicrophoneFallback ? "px-2" : "px-3"} py-1 text-foreground shadow-[0_20px_60px_hsl(34_26%_4%/0.45)]`}>
          {captureWarning ? (
            <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-rust/15 text-rust"
              aria-label="Show meeting warning" title={captureWarning}
              onMouseDown={(event) => event.stopPropagation()} onClick={() => setDisplayMode("full")}>
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : activeMicrophoneFallback ? (
            <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-rust/15 text-rust"
              aria-label="Show microphone warning" title={`Using ${microphoneInput?.resolvedName}.`}
              onMouseDown={(event) => event.stopPropagation()} onClick={() => setDisplayMode("full")}>
              <Mic className="h-3.5 w-3.5" />
            </button>
          ) : (
          <div className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted/80 text-foreground">
            {isTranscribing || isPreparing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : isReady ? (
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Mic className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </div>
          )}
          {!activeMicrophoneFallback && <span
            className={`min-w-0 truncate font-mono text-xs font-medium${
              captureIsLive && pauseView.paused ? " text-rust" : ""
            }`}
          >
            {captureWarning ? "Warning" : captureIsLive ? (pauseView.paused ? "Paused" : captureModeLabel) : statusLabel}
          </span>}
          <span className="time-spec font-mono text-sm text-muted-foreground">
            {captureIsLive ? elapsedText : "…"}
          </span>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-muted/80 text-muted-foreground hover:bg-muted hover:text-foreground"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => setDisplayMode("full")}
            aria-label="Expand popup"
            title="Expand popup"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          {!activeMicrophoneFallback && <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-muted/80 text-muted-foreground hover:bg-muted hover:text-foreground"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void openMainApp("recordings", recordingId)}
            aria-label="Open meeting view"
          >
            <AppWindow className="h-3.5 w-3.5" />
          </button>}
          {captureIsLive && (
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border/80 bg-card text-foreground hover:bg-muted disabled:opacity-50"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void handleTogglePause()}
              disabled={stopping || togglingPause}
              aria-label={pauseView.paused ? "Resume recording" : "Pause recording"}
            >
              {pauseView.paused ? (
                <Play className="h-3.5 w-3.5 fill-current" />
              ) : (
                <Pause className="h-3.5 w-3.5 fill-current" />
              )}
            </button>
          )}
          {captureIsLive && (
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border/80 bg-card text-foreground hover:bg-muted disabled:opacity-50"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={handleStop}
              disabled={stopping}
              aria-label="Stop recording"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          )}
        </div>
      </div>
    );
  }

  const waveformBars = levels.length
    ? levels
    : isTranscribing
      ? [0.2, 0.28, 0.34, 0.26, 0.22, 0.28]
      : [0.18, 0.34, 0.24, 0.4, 0.3, 0.22];

  return (
    <div className={`h-screen bg-transparent p-3 ${displayMode === "compact" ? "w-[330px]" : "w-screen"}`}>
      {statusAnnouncer}
      <div
        ref={recordingCardRef}
        data-recording-card
        className={`${displayMode === "full" ? "max-h-[calc(100vh-24px)]" : ""} overflow-y-auto rounded-[24px] border border-border/80 bg-background px-4 py-3 text-foreground shadow-[0_24px_80px_hsl(34_26%_4%/0.5)]`}
        style={displayMode === "compact" ? { maxHeight: OVERLAY_MAX_SIZE.recording.height - RECORDING_CARD_MARGIN } : undefined}
      >
        <div ref={recordingContentRef}>
        <div
          data-drag-region
          className="mb-3 flex cursor-grab select-none items-center justify-between text-muted-foreground active:cursor-grabbing"
        >
          <div className="inline-flex h-6 items-center gap-1 rounded-full border border-border/80 bg-muted/50 px-2 text-muted-foreground">
            <GripHorizontal className="h-3 w-3" />
          </div>
          {displayMode === "compact" && <span className="manuscript min-w-0 flex-1 truncate px-2 text-base font-medium text-foreground" title={recordingTitle}>{recordingTitle}</span>}
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void cycleDisplayMode()}
              aria-label={
                displayMode === "compact" ? "Minimal popup" : "Compact popup"
              }
            >
              {displayMode === "compact" ? (
                <PanelsTopLeft className="h-3.5 w-3.5" />
              ) : (
                <Minimize2 className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void openMainApp()}
              aria-label="Open app"
            >
              <AppWindow className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void hidePopup()}
              aria-label="Hide popup"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {displayMode === "compact" && (
          <div className="mb-3 flex items-center justify-between gap-2">
            {statusBadge}
            <div className="flex shrink-0 items-center gap-2">
              {captureIsLive && <span aria-label="Elapsed time" className="time-spec font-mono text-sm text-foreground">{elapsedText}</span>}
              {captureControls}
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {displayMode === "full" && statusBadge}
          {displayMode === "full" && captureIsLive && (
            <span className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-muted/60 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              <span className="neume neume-hollow" />
              Instant notes
            </span>
          )}
          <span className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-muted/60 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            {systemAudioActive ? (
              <Monitor className="h-3.5 w-3.5" />
            ) : (
              <Mic className="h-3.5 w-3.5" />
            )}
            {captureModeLabel}
          </span>
          {displayMode === "full" && <span className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-muted/60 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            Template: {meetingTemplateLabel}
          </span>}
          {consentStatus.tracked ? (
            <span className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-muted/60 px-2.5 py-1 text-[11px] font-medium text-foreground">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {consentStatus.label}
            </span>
          ) : null}
          {transcriptionPreview.trim() ? (
            <span className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-muted/60 px-2.5 py-1 text-[11px] font-medium text-foreground">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {previewDelay.label}
            </span>
          ) : null}
          {lostAudioSeconds > 0 ? (
            <span className="inline-flex items-center gap-2 rounded-full border border-rust/30 bg-rust/10 px-2.5 py-1 text-[11px] font-medium text-rust">
              <span className="neume neume-hollow" aria-hidden="true" />
              {Math.round(lostAudioSeconds)}s not transcribed
            </span>
          ) : null}
        </div>

        {displayMode === "full" ? (
          <MeetingSourceLevelMeters recordingId={recordingId} active={captureIsLive} />
        ) : null}

        <div className={activeMicrophoneFallback ? "mt-3" : undefined}><MeetingMicrophoneFallback recordingId={recordingId} input={microphoneInput}
          dismissed={microphoneWarningDismissed} active={phase === "recording"}
          onSettings={() => openMainApp("settings")} /></div>
        {captureWarning ? (
          <div role="alert" className="mt-3 rounded-xl border border-rust/30 bg-rust/10 p-2.5 text-sm leading-5 text-rust">
            <p>{captureWarning}</p>
            <button type="button" className="mt-2 rounded-md border border-rust/30 px-2.5 py-1 text-xs font-medium hover:bg-rust/10"
              onClick={() => void openMainApp("settings")}>
              Open settings
            </button>
          </div>
        ) : null}
        {transcriptionActivity && (
          <div className="mt-3"><TranscriptionActivity activity={transcriptionActivity} /></div>
        )}

        {captureControlError ? (
          <div role="alert" className="mt-3 rounded-xl border border-rust/30 bg-rust/10 p-2.5 text-sm leading-5 text-rust">
            {captureControlError}
          </div>
        ) : null}

        {isFailure && message ? (
          <div
            role="alert"
            className="mt-3 rounded-xl border border-rust/30 bg-rust/10 p-2.5 text-sm leading-5 text-rust"
          >
            {message}
          </div>
        ) : null}

        {audioSourceWarning ? (
          <div
            role="status"
            className="mt-3 flex items-start gap-2 rounded-xl border border-rust/30 bg-rust/10 p-2.5 text-sm leading-5 text-rust"
          >
            <span className="neume neume-hollow mt-1.5 shrink-0" aria-hidden="true" />
            <span>
              <span className="font-medium">{audioSourceWarning.title}</span>{" "}
              {audioSourceWarning.message}
            </span>
          </div>
        ) : null}

        {displayMode === "full" && <div className="mt-3 flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-14 items-center rounded-2xl border border-border/80 bg-muted/40 px-3 shadow-lg shadow-foreground/20">
              <AudioWaveform
                levels={waveformBars}
                active={captureIsLive}
                size="lg"
                glow
                glowColor="rgba(200,149,67,0.45)"
              />
            </div>
            <div>
              <p className="manuscript text-lg font-medium leading-snug tracking-tight">
                {isFailure
                  ? "Meeting needs attention"
                  : isReady
                    ? "Meeting ready"
                    : isPreparing
                      ? "Preparing your meeting"
                      : isTranscribing
                        ? "Finishing your meeting"
                        : recordingTitle}
              </p>
              <p className="text-sm text-muted-foreground">
                {stopping
                  ? "Stopping capture and handing off to transcription."
                  : (!captureWarning && message) ||
                    (isTranscribing || isPreparing || isFailure || isReady
                      ? previewText
                      : meetingTemplateDescription)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-border/80 bg-muted/40 px-3 py-2 text-right shadow-lg shadow-foreground/10">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                {captureIsLive ? (pauseView.paused ? "Paused" : "Elapsed") : "Status"}
              </p>
              <p
                aria-label="Elapsed time"
                className={`time-spec font-mono text-base font-medium ${
                  captureIsLive && pauseView.paused ? "text-muted-foreground" : "text-foreground"
                }`}
              >
                {captureIsLive ? elapsedText : statusLabel}
              </p>
            </div>
            {captureControls}
          </div>
        </div>}

        {displayMode === "full" && (
          <div className="mt-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <button
                type="button"
                className="rounded-lg border border-border/80 bg-muted/50 px-2.5 py-1.5 hover:bg-muted"
                onClick={() => void openMainApp("recordings", recordingId)}
              >
                Open Workspace
              </button>
              <button
                type="button"
                className="rounded-lg border border-border/80 bg-muted/50 px-2.5 py-1.5 hover:bg-muted"
                onClick={() => void openMainApp("settings")}
              >
                Settings
              </button>
              {consentStatus.needsManualNotice ? (
                <button
                  type="button"
                  className="inline-flex items-center rounded-lg border border-border/80 bg-muted/50 px-2.5 py-1.5 hover:bg-muted"
                  disabled={copyingNotice}
                  onClick={() => void handleCopyNotice()}
                >
                  <Copy className="mr-2 h-3.5 w-3.5" />
                  {copyingNotice ? "Copying…" : "Copy notice"}
                </button>
              ) : null}
              {copiedNotice ? <span>Copied.</span> : null}
              {noticeCopyError ? <span role="alert">{noticeCopyError}</span> : null}
            </div>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1.05fr)_minmax(220px,0.95fr)]">
              <div className="rounded-2xl border border-border/80 bg-muted/30 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="font-mono text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                    Live notes
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Autosaves to this meeting
                  </p>
                </div>
                <textarea
                  ref={liveNotesRef}
                  aria-label="Live notes"
                  value={meetingNotes}
                  onPointerDown={() => { void focusLiveNotes(); }}
                  onBlur={releaseLiveNotes}
                  onChange={(event) => { latestMeetingNotesRef.current = event.target.value; setMeetingNotes(event.target.value); }}
                  placeholder="Capture decisions, blockers, names, and next steps without leaving the overlay."
                  rows={8}
                  className="min-h-[176px] w-full resize-none rounded-xl border border-border/80 bg-background/80 px-3 py-3 text-sm leading-6 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring/40"
                />
                {noteSaveError && (
                  <div ref={noteSaveErrorRef} role="alert" className="mt-2 text-sm text-rust">
                    <p>{noteSaveError}</p>
                    <button type="button" className="mt-2 rounded-md border px-3 py-1.5 text-foreground" onClick={() => setNoteRetryRevision((revision) => revision + 1)}>Retry note save</button>
                  </div>
                )}
              </div>
              <div
                className={`rounded-2xl border border-border/80 bg-muted/30 p-3${
                  transcriptCommitted ? " commit-shine" : ""
                }`}
              >
                <div className="mb-1 flex items-center justify-between">
                  <p className="font-mono text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                    {previewDelay.label}
                  </p>
                </div>
                <p className="mb-2 text-sm leading-5 text-muted-foreground">
                  {isTranscribing
                    ? "Updates while processing."
                    : previewDelay.caption}
                </p>
                <p className="manuscript max-h-[176px] overflow-y-auto text-sm leading-6 text-foreground">
                  {previewText}
                </p>
              </div>
            </div>
          </div>
        )}

        {compactProcessingActivity && transcriptionPreview.trim() && (
          <p aria-label="Transcript preview" className="manuscript mt-2 line-clamp-2 text-sm leading-5 text-foreground">{transcriptionPreview}</p>
        )}
        {displayMode === "compact" && consentStatus.needsManualNotice && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <button type="button" className="rounded-lg border border-border/80 bg-muted/50 px-2.5 py-1.5 hover:bg-muted"
              disabled={copyingNotice} onClick={() => void handleCopyNotice()}>
              {copyingNotice ? "Copying…" : "Copy notice"}
            </button>
            {copiedNotice ? <span>Copied.</span> : null}
            {noticeCopyError ? <span role="alert">{noticeCopyError}</span> : null}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
