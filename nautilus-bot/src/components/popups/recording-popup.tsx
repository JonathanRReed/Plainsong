import { useEffect, useMemo, useRef, useState } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AppWindow,
  CheckCircle2,
  Copy,
  GripHorizontal,
  Loader2,
  Mic,
  Minimize2,
  Monitor,
  PanelsTopLeft,
  Square,
  X,
} from "lucide-react";
import { getRecording, getWaveformData, stopRecording, updateRecordingNotes } from "@/lib/tauri";
import {
  describeMeetingConsent,
  MEETING_CONSENT_NOTICE_TEXT,
} from "@/lib/meeting-consent";
import { getMeetingTemplateOption } from "@/lib/meeting-templates";

interface MeetingRecordingStateChangedEvent {
  phase: "idle" | "recording" | "transcribing" | "error";
  recordingId?: string | null;
  startedAtMs?: number | null;
  systemAudioActive?: boolean | null;
  consentPromptShown?: boolean | null;
  message?: string | null;
}

interface RecordingTranscriptionStreamEvent {
  recordingId: string;
  isPartial: boolean;
  isFinal: boolean;
  text: string;
  startTime?: number;
  endTime?: number;
  confidence?: number;
}

type DisplayMode = "full" | "compact" | "minimal";

export function RecordingPopup() {
  const window = getCurrentWindow();
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [systemAudioActive, setSystemAudioActive] = useState(false);
  const [phase, setPhase] = useState<"recording" | "transcribing" | "error">("recording");
  const [transcriptionPreview, setTranscriptionPreview] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("full");
  const [levels, setLevels] = useState<number[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [consentNoticeMessage, setConsentNoticeMessage] = useState<string | null>(null);
  const [recordingTitle, setRecordingTitle] = useState("Live meeting");
  const [meetingNotes, setMeetingNotes] = useState("");
  const [meetingTemplateLabel, setMeetingTemplateLabel] = useState("Auto");
  const [meetingTemplateDescription, setMeetingTemplateDescription] = useState(
    "Nautilus chooses the note format based on what you captured."
  );
  const [consentPromptShown, setConsentPromptShown] = useState(false);
  const [consentNoticeMode, setConsentNoticeMode] = useState<string | null>(null);
  const [copiedNotice, setCopiedNotice] = useState(false);
  const recordingIdRef = useRef<string | null>(null);
  const lastSavedMeetingNotesRef = useRef("");

  useEffect(() => {
    recordingIdRef.current = recordingId;
  }, [recordingId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenStream: (() => void) | undefined;

    const setup = async () => {
      try {
        const initialState = await invoke<MeetingRecordingStateChangedEvent>(
          "get_recording_overlay_state"
        );
        if (
          (initialState.phase === "recording" || initialState.phase === "transcribing") &&
          initialState.recordingId
        ) {
          setRecordingId(initialState.recordingId);
          setStartedAtMs(
            typeof initialState.startedAtMs === "number" ? initialState.startedAtMs : Date.now()
          );
          setSystemAudioActive(Boolean(initialState.systemAudioActive));
          setConsentPromptShown(Boolean(initialState.consentPromptShown));
          setConsentNoticeMode(null);
          setConsentNoticeMessage(null);
          setPhase(initialState.phase);
          setMessage(initialState.message ?? null);
        }
      } catch (error) {
        console.error("Failed to load initial recording popup state:", error);
      }

      unlisten = await listen<MeetingRecordingStateChangedEvent>(
        "meeting-recording-state-changed",
        (event) => {
          const payload = event.payload;
          if ((payload.phase === "recording" || payload.phase === "transcribing") && payload.recordingId) {
            setRecordingId(payload.recordingId);
            setStartedAtMs(
              typeof payload.startedAtMs === "number" ? payload.startedAtMs : Date.now()
            );
            setSystemAudioActive(Boolean(payload.systemAudioActive));
            setConsentPromptShown(Boolean(payload.consentPromptShown));
            setConsentNoticeMode(null);
            setConsentNoticeMessage(null);
            setPhase(payload.phase);
            setMessage(payload.message ?? null);
            if (payload.phase === "recording") {
              setTranscriptionPreview("");
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
          setStopping(false);
        }
      );

      unlistenStream = await listen<RecordingTranscriptionStreamEvent>(
        "recording-transcription-stream",
        (event) => {
          const currentRecordingId = recordingIdRef.current;
          if (!currentRecordingId || event.payload.recordingId !== currentRecordingId) {
            return;
          }
          if (event.payload.text.trim()) {
            setTranscriptionPreview(event.payload.text);
          }
          if (event.payload.isFinal) {
            setMessage("Transcript preview is ready in Meetings.");
          }
        }
      );
    };

    void setup();
    return () => {
      unlisten?.();
      unlistenStream?.();
    };
  }, []);

  useEffect(() => {
    if (!recordingId || phase === "transcribing") {
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
    if (!recordingId || phase === "transcribing") {
      setLevels([]);
      return;
    }

    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const samples = await getWaveformData(recordingId);
        if (cancelled || !samples?.length) return;

        const targetBars = 18;
        const stride = Math.max(1, Math.floor(samples.length / targetBars));
        const bars: number[] = [];
        for (let i = 0; i < samples.length && bars.length < targetBars; i += stride) {
          const slice = samples.slice(i, i + stride);
          const avg =
            slice.reduce((acc, value) => acc + Math.abs(value), 0) / Math.max(1, slice.length);
          bars.push(Math.min(1, avg * 12));
        }
        setLevels(bars);
      } catch {
        // Ignore transient polling errors while recording starts/stops.
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
        "Nautilus chooses the note format based on what you captured."
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

        const template = getMeetingTemplateOption(recording.meetingTemplateId ?? "auto");
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

    const timeoutId = globalThis.setTimeout(() => {
      void updateRecordingNotes(recordingId, meetingNotes)
        .then(() => {
          lastSavedMeetingNotesRef.current = meetingNotes;
        })
        .catch((error) => {
          console.error("Failed to update popup meeting notes:", error);
        });
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

  const elapsedText = useMemo(() => {
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }, [elapsed]);

  const isTranscribing = phase === "transcribing";

  const cycleDisplayMode = async () => {
    const next: DisplayMode =
      displayMode === "full" ? "compact" : displayMode === "compact" ? "minimal" : "full";
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

  const hidePopup = async () => {
    try {
      await invoke("dismiss_recording_overlay");
      await window.hide();
    } catch (error) {
      console.error("Failed to hide recording popup:", error);
    }
  };

  const openMainApp = async (view?: "recordings" | "settings", targetRecordingId?: string) => {
    try {
      if (view) {
        await invoke("open_main_window_to", { view, recordingId: targetRecordingId ?? null });
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
    (isTranscribing
      ? "Generating the first transcript preview for this meeting."
      : "Capture is live. Stop when you want Nautilus to save and process the meeting.");

  const statusLabel = isTranscribing ? "Processing" : "Live meeting";
  const captureModeLabel = systemAudioActive ? "Me + Them" : "Mic only";
  const notesSummary = meetingNotes.trim() || "Open the meeting view to keep notes current.";
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
        className="flex h-screen w-screen items-center justify-center bg-transparent"
        onMouseDownCapture={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          void window.startDragging();
        }}
      >
        <div className="flex items-center gap-2 rounded-full border border-cyan-400/25 bg-slate-950/92 px-3 py-2 text-white shadow-[0_20px_60px_rgba(2,6,23,0.45)] backdrop-blur-md">
          <span className={`h-2.5 w-2.5 rounded-full ${isTranscribing ? "bg-cyan-400" : "bg-rose-400"}`} />
          <span className="text-xs font-medium uppercase tracking-[0.18em]">
            {isTranscribing ? "Processing" : captureModeLabel}
          </span>
          <span className="font-mono text-sm text-cyan-100">
            {isTranscribing ? "..." : elapsedText}
          </span>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/8 text-white hover:bg-white/15"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void openMainApp("recordings", recordingId)}
            aria-label="Open meeting view"
          >
            <AppWindow className="h-3.5 w-3.5" />
          </button>
          {!isTranscribing && (
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-rose-500/90 text-white hover:bg-rose-500 disabled:opacity-50"
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
      <div className="max-h-[calc(100vh-24px)] overflow-y-auto rounded-[28px] border border-cyan-400/20 bg-[linear-gradient(180deg,rgba(2,6,23,0.96),rgba(15,23,42,0.92))] px-4 py-3 text-white shadow-[0_24px_80px_rgba(2,6,23,0.5)] backdrop-blur-xl">
        <div
          data-tauri-drag-region
          className="mb-3 flex cursor-grab select-none items-center justify-between text-slate-300 active:cursor-grabbing"
          onMouseDownCapture={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            void window.startDragging();
          }}
        >
          <div className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.2em]">
            <GripHorizontal className="h-3 w-3" />
            Move
          </div>
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-white/10"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void cycleDisplayMode()}
              aria-label={displayMode === "compact" ? "Minimal popup" : "Compact popup"}
            >
              {displayMode === "compact" ? (
                <PanelsTopLeft className="h-3.5 w-3.5" />
              ) : (
                <Minimize2 className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-white/10"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void openMainApp()}
              aria-label="Open app"
            >
              <AppWindow className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-white/10"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void hidePopup()}
              aria-label="Hide popup"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-cyan-100">
            {isTranscribing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mic className="h-3.5 w-3.5" />}
            {statusLabel}
          </span>
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-slate-200">
            {systemAudioActive ? <Monitor className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
            {captureModeLabel}
          </span>
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-slate-200">
            Template: {meetingTemplateLabel}
          </span>
          {consentStatus.tracked ? (
            <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-medium text-emerald-100">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {consentStatus.label}
            </span>
          ) : null}
          {transcriptionPreview.trim() ? (
            <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-medium text-emerald-100">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Live transcript preview
            </span>
          ) : null}
        </div>

        <div className={`mt-3 ${displayMode === "compact" ? "flex items-center justify-between gap-3" : "space-y-4"}`}>
          <div className="flex items-center gap-3">
            {displayMode === "full" && (
              <div className="flex h-14 items-end gap-1.5 rounded-2xl border border-white/8 bg-white/[0.04] px-3 py-2">
                {waveformBars.map((level, idx) => (
                  <span
                    key={`${idx}-${Math.round(level * 100)}`}
                    className="w-1.5 rounded-full bg-cyan-300/90 transition-all"
                    style={{ height: `${Math.max(18, Math.round(level * 100))}%` }}
                  />
                ))}
              </div>
            )}
            <div>
              <p className="text-base font-semibold tracking-tight">
                {isTranscribing ? "Finishing your meeting" : recordingTitle}
              </p>
              <p className="text-sm text-slate-300">
                {stopping
                  ? "Stopping capture and handing off to transcription."
                  : message ||
                    (isTranscribing
                      ? "Nautilus is preparing the transcript and summary."
                      : meetingTemplateDescription)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-right">
              <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-100/80">
                {isTranscribing ? "Status" : "Elapsed"}
              </p>
              <p className="font-mono text-base text-cyan-100">
                {isTranscribing ? "Saving" : elapsedText}
              </p>
            </div>
            {!isTranscribing && (
              <button
                type="button"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-rose-500/90 text-white hover:bg-rose-500 disabled:opacity-50"
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
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <button
                type="button"
                className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 hover:bg-white/10"
                onClick={() => void openMainApp("recordings", recordingId)}
              >
                Open Workspace
              </button>
              <button
                type="button"
                className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 hover:bg-white/10"
                onClick={() => void openMainApp("settings")}
              >
                Settings
              </button>
              {consentStatus.needsManualNotice ? (
                <button
                  type="button"
                  className="inline-flex items-center rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 hover:bg-white/10"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(MEETING_CONSENT_NOTICE_TEXT);
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
              <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-300">
                    Live notes
                  </p>
                  <p className="text-[11px] text-slate-400">Autosaves to this meeting</p>
                </div>
                <textarea
                  value={meetingNotes}
                  onChange={(event) => setMeetingNotes(event.target.value)}
                  placeholder="Capture decisions, blockers, names, and next steps without leaving the overlay."
                  rows={8}
                  className="min-h-[176px] w-full resize-none rounded-xl border border-white/10 bg-slate-950/60 px-3 py-3 text-sm leading-6 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-400/50"
                />
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-300">
                    Transcript preview
                  </p>
                  <p className="text-[11px] text-slate-400">
                    {isTranscribing ? "Updates while processing" : "Live support for your notes"}
                  </p>
                </div>
                <p className="max-h-[176px] overflow-y-auto text-sm leading-6 text-slate-100">
                  {previewText}
                </p>
              </div>
            </div>
          </div>
        )}

        {displayMode === "compact" && (
          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between gap-3 text-xs text-slate-300">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-100">{recordingTitle}</p>
                <p className="truncate text-slate-400">
                  {meetingTemplateLabel} · {consentStatus.label}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {consentStatus.needsManualNotice ? (
                  <button
                    type="button"
                    className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 hover:bg-white/10"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(MEETING_CONSENT_NOTICE_TEXT);
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
                  className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 hover:bg-white/10"
                  onClick={() => void openMainApp("recordings", recordingId)}
                >
                  Open Workspace
                </button>
              </div>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-300">
                  Notes snapshot
                </p>
                <p className="text-[11px] text-slate-400">{captureModeLabel}</p>
              </div>
              <p className="line-clamp-3 text-sm leading-6 text-slate-100">{notesSummary}</p>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-300">
                  Transcript preview
                </p>
                <p className="text-[11px] text-slate-400">{statusLabel}</p>
              </div>
              <p className="line-clamp-3 text-sm leading-6 text-slate-100">{previewText}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
