import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LogicalSize, invoke, listen, getCurrentWindow } from "@/lib/electron";
import {
  Mic,
  X,
  GripHorizontal,
  PanelsTopLeft,
  Minimize2,
  AppWindow,
  Square,
  Monitor,
  CheckCircle2,
  Loader2,
  Copy,
} from "lucide-react";
import {
  getRecording,
  getWaveformData,
  stopRecording,
  updateRecordingNotes,
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
import { getMeetingTemplateOption } from "@/lib/meeting-templates";
import { rebaseMeetingNotes } from "@/lib/meeting-notes";
import { AudioWaveform } from "@/components/ui/audio-waveform";
import {
  INITIAL_MEETING_LIFECYCLE_STATE,
  reduceMeetingLifecycleState,
  type MeetingLifecycleEvent,
  type MeetingLifecyclePhase,
  type MeetingLifecycleState,
} from "@/features/meetings/runtime";

type DisplayMode = "full" | "compact" | "minimal";

export function RecordingPopup() {
  const window = getCurrentWindow();
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
  const [displayMode, setDisplayMode] = useState<DisplayMode>("full");
  const [levels, setLevels] = useState<number[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [consentNoticeMessage, setConsentNoticeMessage] = useState<
    string | null
  >(null);
  const [recordingTitle, setRecordingTitle] = useState("Live meeting");
  const [meetingNotes, setMeetingNotes] = useState("");
  const [meetingTemplateLabel, setMeetingTemplateLabel] = useState("Auto");
  const [meetingTemplateDescription, setMeetingTemplateDescription] = useState(
    "Plainsong chooses the note format based on what you captured.",
  );
  const [consentPromptShown, setConsentPromptShown] = useState(false);
  const [consentNoticeMode, setConsentNoticeMode] = useState<string | null>(
    null,
  );
  const [copiedNotice, setCopiedNotice] = useState(false);
  const [transcriptCommitted, setTranscriptCommitted] = useState(false);
  const recordingIdRef = useRef<string | null>(null);
  const lifecycleRef = useRef<MeetingLifecycleState>(
    INITIAL_MEETING_LIFECYCLE_STATE,
  );
  const lastSavedMeetingNotesRef = useRef("");

  useEffect(() => {
    recordingIdRef.current = recordingId;
  }, [recordingId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenStream: (() => void) | undefined;
    let unlistenSourceWarning: (() => void) | undefined;

    const setup = async () => {
      try {
        const initialState = await invoke<MeetingLifecycleEvent>(
          "get_recording_overlay_state",
        );
        const next = reduceMeetingLifecycleState(
          INITIAL_MEETING_LIFECYCLE_STATE,
          initialState,
        );
        lifecycleRef.current = next;
        if (next.phase !== "idle" && next.recordingId) {
          setRecordingId(next.recordingId);
          setStartedAtMs(
            typeof next.startedAtMs === "number"
              ? next.startedAtMs
              : Date.now(),
          );
          setSystemAudioActive(next.systemAudioActive);
          setConsentPromptShown(next.consentPromptShown);
          setConsentNoticeMode(null);
          setConsentNoticeMessage(null);
          setPhase(next.phase);
          setMessage(next.message);
        }
      } catch (error) {
        console.error("Failed to load initial recording popup state:", error);
      }

      unlisten = await listen<MeetingLifecycleEvent>(
        "meeting-recording-state-changed",
        (event) => {
          const payload = event.payload;
          const next = reduceMeetingLifecycleState(
            lifecycleRef.current,
            payload,
          );
          lifecycleRef.current = next;
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
            if (next.phase === "recording") {
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
          setTranscriptionPreview("");
          setTranscriptCommitted(false);
          setPreviewDelay(describeTranscriptDelay(null));
          setLostAudioSeconds(0);
          setAudioSourceWarning(null);
          setStopping(false);
        },
      );

      unlistenStream = await listen<RecordingTranscriptionStreamEvent>(
        RECORDING_TRANSCRIPTION_STREAM_EVENT,
        (event) => {
          const currentRecordingId = recordingIdRef.current;
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

      // A source going silent is a failure the user can still fix while the
      // meeting runs, and this overlay is often the only Plainsong surface on
      // screen at the time.
      unlistenSourceWarning = await listen<MeetingAudioSourceWarningEvent>(
        MEETING_AUDIO_SOURCE_WARNING_EVENT,
        (event) => {
          const currentRecordingId = recordingIdRef.current;
          if (
            !currentRecordingId ||
            event.payload.recordingId !== currentRecordingId
          ) {
            return;
          }
          setAudioSourceWarning(describeAudioSourceWarning(event.payload));
        },
      );
    };

    void setup();
    return () => {
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

    const tick = () => {
      const start = startedAtMs ?? Date.now();
      setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [phase, recordingId, startedAtMs]);

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
      return;
    }

    let cancelled = false;
    void getRecording(recordingId)
      .then((recording) => {
        if (cancelled || !recording) {
          return;
        }

        setRecordingTitle(recording.title || "Live meeting");
        const nextNotes = recording.meetingNotes ?? "";
        setMeetingNotes(nextNotes);
        lastSavedMeetingNotesRef.current = nextNotes;

        const template = getMeetingTemplateOption(
          recording.meetingTemplateId ?? "auto",
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
  }, [recordingId]);

  useEffect(() => {
    if (!recordingId) {
      return;
    }

    const normalizedNotes = meetingNotes.trim();
    if (normalizedNotes === lastSavedMeetingNotesRef.current.trim()) {
      return;
    }

    // The main window edits the same record. Read what is stored first and
    // rebase onto it, so a save from this window can never delete notes the
    // meeting view wrote while the popup was open.
    const timeoutId = globalThis.setTimeout(() => {
      void (async () => {
        let stored = lastSavedMeetingNotesRef.current;
        try {
          stored = (await getRecording(recordingId))?.meetingNotes ?? "";
        } catch (error) {
          console.error("Failed to read stored meeting notes before autosave:", error);
        }

        const nextNotes = rebaseMeetingNotes({
          base: lastSavedMeetingNotesRef.current,
          local: meetingNotes,
          stored,
        });

        try {
          await updateRecordingNotes(recordingId, nextNotes);
          lastSavedMeetingNotesRef.current = nextNotes;
          if (nextNotes !== meetingNotes) {
            setMeetingNotes(nextNotes);
          }
        } catch (error) {
          console.error("Failed to update popup meeting notes:", error);
        }
      })();
    }, 350);

    return () => globalThis.clearTimeout(timeoutId);
  }, [meetingNotes, recordingId]);

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

  const cycleDisplayMode = async () => {
    const next: DisplayMode =
      displayMode === "full"
        ? "compact"
        : displayMode === "compact"
          ? "minimal"
          : "full";
    setDisplayMode(next);
    try {
      if (next === "minimal") {
        await window.setSize(new LogicalSize(170, 46));
      } else if (next === "compact") {
        await window.setSize(new LogicalSize(330, 126));
      } else {
        await window.setSize(new LogicalSize(470, 228));
      }
    } catch (error) {
      console.error("Failed to resize recording popup:", error);
    }
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

  const handleStop = async () => {
    if (!recordingId || stopping) return;
    setStopping(true);
    try {
      await stopRecording(recordingId);
    } catch (error) {
      console.error("Failed to stop recording from popup:", error);
      setStopping(false);
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
            ? "Preparing microphone and system audio capture."
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
  const notesSummary =
    meetingNotes.trim() || "Open the meeting view to keep notes current.";
  const consentStatus = describeMeetingConsent({
    consentPromptShown,
    consentNoticeMode,
    consentNoticeMessage,
  });

  if (!recordingId) {
    return <div className="h-screen w-screen bg-transparent" />;
  }

  if (displayMode === "minimal") {
    return (
      <div
        data-drag-region
        className="flex h-screen w-screen items-center justify-center bg-transparent"
      >
        <div className="flex items-center gap-2 rounded-full border border-border/80 bg-background/95 px-3 py-2 text-foreground shadow-[0_20px_60px_hsl(34_26%_4%/0.45)] backdrop-blur-md">
          <div className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted/80 text-foreground">
            {isTranscribing || isPreparing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : isReady ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <Mic className="h-3.5 w-3.5" />
            )}
          </div>
          <AudioWaveform
            levels={levels.length ? levels : undefined}
            active={captureIsLive}
            size="sm"
            barCount={9}
          />
          <span className="font-mono text-xs font-medium uppercase tracking-[0.18em]">
            {captureIsLive ? captureModeLabel : statusLabel}
          </span>
          <span className="time-spec font-mono text-sm text-muted-foreground">
            {captureIsLive ? elapsedText : "…"}
          </span>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-muted/80 text-muted-foreground hover:bg-muted hover:text-foreground"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void openMainApp("recordings", recordingId)}
            aria-label="Open meeting view"
          >
            <AppWindow className="h-3.5 w-3.5" />
          </button>
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
    <div className="h-screen w-screen bg-transparent p-3">
      <div className="max-h-[calc(100vh-24px)] overflow-y-auto rounded-[24px] border border-border/80 bg-background/95 px-4 py-3 text-foreground shadow-[0_24px_80px_hsl(34_26%_4%/0.5)] backdrop-blur-xl">
        <div
          data-drag-region
          className="mb-3 flex cursor-grab select-none items-center justify-between text-muted-foreground active:cursor-grabbing"
        >
          <div className="inline-flex h-6 items-center gap-1 rounded-full border border-border/80 bg-muted/50 px-2 text-muted-foreground">
            <GripHorizontal className="h-3 w-3" />
          </div>
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

        <div className="flex flex-wrap items-center gap-2">
          {isFailure ? (
            <span className="inline-flex items-center gap-2 rounded-full border border-rust/30 bg-rust/10 px-2.5 py-1 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-rust">
              <span className="neume neume-hollow" aria-hidden="true" />
              {statusLabel}
            </span>
          ) : isTranscribing || isPreparing ? (
            <span className="inline-flex items-center gap-2 rounded-full border border-rust/30 bg-rust/10 px-2.5 py-1 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-rust">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {statusLabel}
            </span>
          ) : (
            <span className="gilt-halo inline-flex items-center gap-2 rounded-full border border-gold/40 bg-gold/10 px-2.5 py-1 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-gold-text">
              <span
                className="neume neume-lit neume-live"
                aria-hidden="true"
              />
              {statusLabel}
            </span>
          )}
          {captureIsLive && (
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
          <span className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-muted/60 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            Template: {meetingTemplateLabel}
          </span>
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

        <div
          className={displayMode === "compact"
            ? "mt-3 flex items-center justify-between gap-3"
            : "mt-3 flex flex-col gap-4"}
        >
          <div className="flex items-center gap-3">
            {displayMode === "full" && (
              <div className="flex h-14 items-center rounded-2xl border border-border/80 bg-muted/40 px-3 shadow-lg shadow-foreground/20">
                <AudioWaveform
                  levels={waveformBars}
                  active={captureIsLive}
                  size="lg"
                  glow
                  glowColor="rgba(200,149,67,0.45)"
                />
              </div>
            )}
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
                  : message ||
                    (isTranscribing || isPreparing || isFailure || isReady
                      ? previewText
                      : meetingTemplateDescription)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-border/80 bg-muted/40 px-3 py-2 text-right shadow-lg shadow-foreground/10">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                {captureIsLive ? "Elapsed" : "Status"}
              </p>
              <p className="time-spec font-mono text-base font-medium text-foreground">
                {captureIsLive ? elapsedText : statusLabel}
              </p>
            </div>
            {captureIsLive && (
              <button
                type="button"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border/80 bg-card text-foreground hover:bg-muted hover:scale-105 transition-all disabled:opacity-50 disabled:hover:scale-100"
                onClick={handleStop}
                disabled={stopping}
                aria-label="Stop recording"
              >
                <Square className="h-4.5 w-4.5 fill-current" />
              </button>
            )}
          </div>
        </div>

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
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        MEETING_CONSENT_NOTICE_TEXT,
                      );
                      setCopiedNotice(true);
                    } catch {
                      setCopiedNotice(false);
                    }
                  }}
                >
                  <Copy className="mr-2 h-3.5 w-3.5" />
                  Copy notice
                </button>
              ) : null}
              {copiedNotice ? <span>Copied.</span> : null}
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
                  value={meetingNotes}
                  onChange={(event) => setMeetingNotes(event.target.value)}
                  placeholder="Capture decisions, blockers, names, and next steps without leaving the overlay."
                  rows={8}
                  className="min-h-[176px] w-full resize-none rounded-xl border border-border/80 bg-background/80 px-3 py-3 text-sm leading-6 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring/40"
                />
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

        {displayMode === "compact" && (
          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <div className="min-w-0">
                <p className="manuscript truncate font-medium text-foreground">
                  {recordingTitle}
                </p>
                <p className="truncate text-muted-foreground">
                  {meetingTemplateLabel} · {consentStatus.label}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {consentStatus.needsManualNotice ? (
                  <button
                    type="button"
                    className="rounded-lg border border-foreground/10 bg-foreground/5 px-2.5 py-1.5 hover:bg-foreground/10"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(
                          MEETING_CONSENT_NOTICE_TEXT,
                        );
                        setCopiedNotice(true);
                      } catch {
                        setCopiedNotice(false);
                      }
                    }}
                  >
                    Copy notice
                  </button>
                ) : null}
                <button
                  type="button"
                  className="rounded-lg border border-foreground/10 bg-foreground/5 px-2.5 py-1.5 hover:bg-foreground/10"
                  onClick={() => void openMainApp("recordings", recordingId)}
                >
                  Open Workspace
                </button>
              </div>
            </div>
            <div className="rounded-2xl border border-foreground/10 bg-foreground/4 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Notes snapshot
                </p>
                <p className="text-[11px] text-muted-foreground">{captureModeLabel}</p>
              </div>
              <p className="line-clamp-3 text-sm leading-6 text-foreground">
                {notesSummary}
              </p>
            </div>
            <div className="rounded-2xl border border-foreground/10 bg-foreground/4 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  {previewDelay.label}
                </p>
                <p className="text-[11px] text-muted-foreground">{statusLabel}</p>
              </div>
              <p className="line-clamp-3 text-sm leading-6 text-foreground">
                {previewText}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
