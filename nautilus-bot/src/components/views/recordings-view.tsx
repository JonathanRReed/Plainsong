import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useRecordings } from "@/hooks/use-recordings";
import { useRecording } from "@/hooks/use-recording";
import { useToast } from "@/components/toast";
import { ConsentDialog } from "@/components/recording-overlay";
import { TranscriptViewer, TranscriptSearch } from "@/components/transcript-viewer";
import { RecordingWaveform, WaveformVisualizer } from "@/components/waveform-visualizer";
import { AiAnalysisPanel } from "@/components/ai-analysis-panel";
import {
  getRecordingWaveform,
  openRecordingAudio,
  getSpeakers,
  getTranscript,
  runDiarization,
  renameSpeaker,
  deleteRecording,
  renameRecording,
  retryMeetingAutoName,
  setRecordingSourceType,
  isDiarizationModelAvailable,
  updateTranscriptSegment,
} from "@/lib/tauri";
import type { Recording, Transcript, TranscriptSegment } from "@/types";
import { listen } from "@tauri-apps/api/event";
import {
  AlertCircle,
  BarChart3,
  Edit3,
  FileAudio,
  FileOutput,
  FileText,
  Loader2,
  Mic2,
  MoreHorizontal,
  Play,
  Search,
  Square,
  Trash2,
} from "lucide-react";

export function RecordingsView() {
  const { recordings, refetch } = useRecordings();
  const { startMeeting, stopMeeting, isRecording, recordingId, formattedDuration } = useRecording();
  const { toast } = useToast();
  const [showConsent, setShowConsent] = useState(false);
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(null);
  const [showRecordingDetail, setShowRecordingDetail] = useState(false);
  const [selectedTranscript, setSelectedTranscript] = useState<Transcript | null>(null);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [waveformData, setWaveformData] = useState<number[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isRunningDiarization, setIsRunningDiarization] = useState(false);
  const [diarizationMessage, setDiarizationMessage] = useState<string | null>(null);
  const [diarizationError, setDiarizationError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<Recording | null>(null);
  const [showRenameDialog, setShowRenameDialog] = useState<Recording | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isStopping, setIsStopping] = useState(false);
  const [meetingNotes, setMeetingNotes] = useState("");
  const lastRecordingState = useRef(false);

  // Live streaming transcript state
  type StreamChunk = { text: string; startTime: number; isPartial: boolean };
  const [streamChunks, setStreamChunks] = useState<StreamChunk[]>([]);
  const streamScrollRef = useRef<HTMLDivElement>(null);

  // Nautilus auto-analysis results keyed by recording ID
  type AutoAnalysis = { summary: string | null; actionItems: string[] };
  const [analysisCache, setAnalysisCache] = useState<Record<string, AutoAnalysis>>({});
  const [autoNameIssue, setAutoNameIssue] = useState<{
    recordingId: string;
    message: string;
  } | null>(null);
  const [meetingSearch, setMeetingSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "completed" | "recording" | "error">(
    "all"
  );
  const [isBulkReclassifying, setIsBulkReclassifying] = useState(false);

  useEffect(() => {
    if (lastRecordingState.current && !isRecording) {
      refetch();
      setStreamChunks([]);
    }
    lastRecordingState.current = isRecording;
  }, [isRecording, refetch]);

  // Listen for recording-analysis-ready events (auto Nautilus-style summary)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ recordingId: string; summary?: string | null; actionItems?: string[] }>(
      "recording-analysis-ready",
      (event) => {
        const { recordingId, summary = null, actionItems = [] } = event.payload;
        setAnalysisCache((prev) => ({ ...prev, [recordingId]: { summary, actionItems } }));
      }
    ).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Subscribe to live streaming transcript events while recording
  useEffect(() => {
    if (!isRecording || !recordingId) {
      return;
    }
    let unlisten: (() => void) | undefined;
    listen<{ recordingId: string; text: string; startTime: number; isPartial: boolean }>(
      "recording-transcription-stream",
      (event) => {
        if (event.payload.recordingId !== recordingId) return;
        setStreamChunks((prev) => {
          const chunk: StreamChunk = {
            text: event.payload.text,
            startTime: event.payload.startTime,
            isPartial: event.payload.isPartial,
          };
          return [...prev.filter((c) => !c.isPartial), chunk];
        });
        setTimeout(() => {
          streamScrollRef.current?.scrollTo({
            top: streamScrollRef.current.scrollHeight,
            behavior: "smooth",
          });
        }, 50);
      }
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [isRecording, recordingId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{
      recordingId: string;
      status: "ok" | "error";
      newTitle?: string;
      message?: string;
      canRetry?: boolean;
    }>("recording-title-updated", (event) => {
      const { recordingId: updatedId, status, newTitle, message } = event.payload;
      if (status === "ok" && newTitle) {
        setAutoNameIssue((current) =>
          current?.recordingId === updatedId ? null : current
        );
        setSelectedRecording((current) =>
          current && current.id === updatedId ? { ...current, title: newTitle } : current
        );
        refetch();
        return;
      }
      if (status === "error") {
        setAutoNameIssue({
          recordingId: updatedId,
          message: message ?? "Meeting auto-name failed.",
        });
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [refetch]);

  const handleStartRecording = async (options: { mic: boolean; systemAudio: boolean; template?: string }) => {
    try {
      const startedId = await startMeeting({ ...options, projectId: "default" });
      console.log("startMeeting returned:", startedId);
      if (startedId) {
        refetch();
      }
    } catch (error) {
      console.error("Failed to start recording:", error);
      toast(
        error instanceof Error ? error.message : "Failed to start recording",
        "error"
      );
    } finally {
      setShowConsent(false);
    }
  };

  const loadRecordingDetail = async (recording: Recording) => {
    setIsLoadingDetail(true);
    setDetailError(null);
    setSelectedTranscript(null);
    setSpeakerNames({});
    setWaveformData([]);
    setSearchQuery("");
    setDiarizationMessage(null);
    setDiarizationError(null);

    try {
      const [transcriptResult, waveformResult, speakersResult] = await Promise.allSettled([
        getTranscript(recording.id),
        getRecordingWaveform(recording.id, 500),
        getSpeakers(recording.id),
      ]);

      let hadAnyFailure = false;

      if (transcriptResult.status === "fulfilled") {
        const transcript = transcriptResult.value;
        const normalizedSegments: TranscriptSegment[] = Array.isArray(transcript?.segments)
          ? transcript.segments
              .filter((segment): segment is TranscriptSegment => {
                return Boolean(
                  segment &&
                    typeof segment.text === "string" &&
                    Number.isFinite(segment.startTime) &&
                    Number.isFinite(segment.endTime)
                );
              })
              .map((segment, index) => ({
                id: segment.id || `${transcript?.id ?? recording.id}-segment-${index}`,
                startTime: Number.isFinite(segment.startTime) ? segment.startTime : 0,
                endTime: Number.isFinite(segment.endTime) ? segment.endTime : 0,
                text: segment.text ?? "",
                speakerId: segment.speakerId,
                confidence: Number.isFinite(segment.confidence) ? segment.confidence : 0,
              }))
          : [];
        setSelectedTranscript(
          transcript
            ? {
                ...transcript,
                segments: normalizedSegments,
              }
            : null
        );
      } else {
        hadAnyFailure = true;
        setSelectedTranscript(null);
      }

      if (waveformResult.status === "fulfilled") {
        const waveform = waveformResult.value;
        setWaveformData(Array.isArray(waveform) ? waveform : []);
      } else {
        hadAnyFailure = true;
        setWaveformData([]);
      }

      if (speakersResult.status === "fulfilled") {
        const speakers = Array.isArray(speakersResult.value) ? speakersResult.value : [];
        setSpeakerNames(
          speakers.reduce<Record<string, string>>((acc, speaker) => {
            if (speaker.name) {
              acc[speaker.id] = speaker.name;
            }
            return acc;
          }, {})
        );
      } else {
        hadAnyFailure = true;
        setSpeakerNames({});
      }

      if (hadAnyFailure) {
        setDetailError(
          "Some recording details could not be loaded. Transcript content is still shown when available."
        );
      }
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "Failed to load recording details.");
    } finally {
      setIsLoadingDetail(false);
    }
  };

  const handleRecordingClick = (recording: Recording) => {
    setSelectedRecording(recording);
    setShowRecordingDetail(true);
    void loadRecordingDetail(recording);
  };

  const handleRenameSpeaker = async (speakerId: string, newName: string) => {
    if (!selectedRecording) {
      return;
    }
    setSpeakerNames((prev) => ({ ...prev, [speakerId]: newName }));
    await renameSpeaker(selectedRecording.id, speakerId, newName);
  };

  const handleRunDiarization = async () => {
    if (!selectedRecording) {
      return;
    }

    setIsRunningDiarization(true);
    setDiarizationMessage(null);
    setDiarizationError(null);

    try {
      const available = await isDiarizationModelAvailable();
      if (!available) {
        setDiarizationError(
          "Speaker diarization is not yet available as a local model. Use the Analysis tab for AI-powered meeting summaries, action items, and speaker attribution."
        );
        setIsRunningDiarization(false);
        return;
      }

      const result = await runDiarization(selectedRecording.id);
      await loadRecordingDetail(selectedRecording);
      setDiarizationMessage(
        `Speaker identification complete (${result.speakers.length} speakers found).`
      );
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Speaker identification failed. Use the Analysis tab for AI-powered features.";
      setDiarizationError(msg);
    } finally {
      setIsRunningDiarization(false);
    }
  };



  const handlePlayAudio = async (recording: Recording) => {
    if (recording.audioPath) {
      try {
        await openRecordingAudio(recording.id);
      } catch (err) {
        console.error("Failed to open audio file:", err);
      }
    }
  };

  const handleDeleteRecording = async () => {
    if (!showDeleteConfirm) return;
    try {
      await deleteRecording(showDeleteConfirm.id);
      refetch();
    } catch (err) {
      console.error("Failed to delete recording:", err);
    } finally {
      setShowDeleteConfirm(null);
    }
  };

  const handleRenameRecording = async () => {
    if (!showRenameDialog || !renameValue.trim()) return;
    try {
      await renameRecording(showRenameDialog.id, renameValue.trim());
      refetch();
    } catch (err) {
      console.error("Failed to rename recording:", err);
    } finally {
      setShowRenameDialog(null);
      setRenameValue("");
    }
  };

  const filteredSegments = useMemo(() => {
    if (!selectedTranscript) {
      return [];
    }
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return selectedTranscript.segments;
    }
    return selectedTranscript.segments.filter((segment) => {
      const speaker = segment.speakerId?.toLowerCase() ?? "";
      return (
        segment.text.toLowerCase().includes(query) ||
        speaker.includes(query)
      );
    });
  }, [selectedTranscript, searchQuery]);

  const hasSpeakerLabels = useMemo(
    () => Boolean(selectedTranscript?.segments.some((segment) => Boolean(segment.speakerId))),
    [selectedTranscript]
  );
  const meetings = useMemo(
    () => recordings.filter((recording) => recording.sourceType === "meeting"),
    [recordings]
  );
  const filteredMeetings = useMemo(() => {
    const query = meetingSearch.trim().toLowerCase();
    return meetings
      .filter((meeting) => {
        if (statusFilter !== "all" && meeting.status !== statusFilter) {
          return false;
        }
        if (!query) return true;
        const haystack = `${meeting.title} ${new Date(meeting.createdAt).toLocaleString()}`.toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [meetingSearch, meetings, statusFilter]);

  const meetingStats = useMemo(() => {
    const total = meetings.length;
    const completed = meetings.filter((meeting) => meeting.status === "completed").length;
    const errors = meetings.filter((meeting) => meeting.status === "error").length;
    const totalSeconds = meetings.reduce((sum, meeting) => sum + Math.max(0, meeting.duration), 0);
    return {
      total,
      completed,
      errors,
      totalHours: totalSeconds / 3600,
    };
  }, [meetings]);

  const handleMarkAsDictation = async (recordingIdToUpdate: string) => {
    try {
      await setRecordingSourceType(recordingIdToUpdate, "dictation");
      await refetch();
      toast("Moved recording to Dictation.", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to move recording to Dictation.";
      toast(message, "error");
    }
  };

  const handleBulkMarkFilteredAsDictation = async () => {
    if (filteredMeetings.length === 0 || isBulkReclassifying) {
      return;
    }

    setIsBulkReclassifying(true);
    try {
      await Promise.all(
        filteredMeetings.map((recording) => setRecordingSourceType(recording.id, "dictation"))
      );
      await refetch();
      toast(`Moved ${filteredMeetings.length} item(s) to Dictation.`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to move all filtered recordings.";
      toast(message, "error");
    } finally {
      setIsBulkReclassifying(false);
    }
  };

  const formatDuration = (seconds: number) => {
    const safeSeconds = Math.max(0, seconds);
    const mins = Math.floor(safeSeconds / 60);
    const secs = safeSeconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="h-full flex flex-col">
      <div className="p-6 border-b flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Meetings</h1>
          <p className="text-muted-foreground">
            Long-form sessions, meeting history, and transcript review.
          </p>
        </div>
        <div className="flex gap-2">
          {isRecording ? (
            <Button variant="destructive" disabled={isStopping} onClick={async () => { setIsStopping(true); try { await stopMeeting(); } finally { setIsStopping(false); } }}>
              <Square className="h-4 w-4 mr-2 fill-current" />
              {isStopping ? "Stopping..." : "Stop Meeting"}
            </Button>
          ) : (
            <Button variant="active" onClick={() => setShowConsent(true)}>
              <Mic2 className="h-4 w-4 mr-2" />
              New Meeting
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-6">
          {autoNameIssue && (
            <Card className="mb-4 border-amber-500/40 bg-amber-500/5">
              <CardContent className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                      Meeting title generation failed
                    </p>
                    <p className="text-xs text-muted-foreground">{autoNameIssue.message}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void retryMeetingAutoName(autoNameIssue.recordingId).catch((error) => {
                          console.error("Retry meeting auto-name failed:", error);
                          setAutoNameIssue({
                            recordingId: autoNameIssue.recordingId,
                            message:
                              error instanceof Error
                                ? error.message
                                : "Meeting title retry failed.",
                          });
                        });
                      }}
                    >
                      Retry
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setAutoNameIssue(null)}>
                      Dismiss
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="mb-4 grid gap-3 md:grid-cols-4">
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Total Meetings</p>
                <p className="text-2xl font-semibold">{meetingStats.total}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Completed</p>
                <p className="text-2xl font-semibold">{meetingStats.completed}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Total Time</p>
                <p className="text-2xl font-semibold">{meetingStats.totalHours.toFixed(1)}h</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Errors</p>
                <p className="text-2xl font-semibold">{meetingStats.errors}</p>
              </CardContent>
            </Card>
          </div>

          <Card className="mb-4">
            <CardContent className="p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="relative w-full md:max-w-md">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    placeholder="Search meetings by title or date…"
                    value={meetingSearch}
                    onChange={(event) => setMeetingSearch(event.target.value)}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={filteredMeetings.length === 0 || isBulkReclassifying}
                    onClick={() => {
                      void handleBulkMarkFilteredAsDictation();
                    }}
                  >
                    {isBulkReclassifying ? (
                      <>
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        Moving...
                      </>
                    ) : (
                      "Mark Filtered as Dictation"
                    )}
                  </Button>
                  <Button
                    variant={statusFilter === "all" ? "active" : "outline"}
                    size="sm"
                    onClick={() => setStatusFilter("all")}
                  >
                    All
                  </Button>
                  <Button
                    variant={statusFilter === "completed" ? "active" : "outline"}
                    size="sm"
                    onClick={() => setStatusFilter("completed")}
                  >
                    Completed
                  </Button>
                  <Button
                    variant={statusFilter === "recording" ? "active" : "outline"}
                    size="sm"
                    onClick={() => setStatusFilter("recording")}
                  >
                    Recording
                  </Button>
                  <Button
                    variant={statusFilter === "error" ? "active" : "outline"}
                    size="sm"
                    onClick={() => setStatusFilter("error")}
                  >
                    Error
                  </Button>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Seeing a dictation in this list? Use <span className="font-medium">••• → Mark as Dictation</span> to move it out of Meetings.
              </p>
            </CardContent>
          </Card>

          {isRecording && recordingId && (
            <Card className="mb-4 border-active/40 bg-active/5">
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-4 mb-3">
                  <div>
                    <p className="text-sm font-medium text-active">Recording in progress</p>
                    <p className="text-xs text-muted-foreground">Meeting capture is live</p>
                  </div>
                  <div className="font-mono text-lg font-semibold">{formattedDuration}</div>
                </div>
                <RecordingWaveform
                  recordingId={recordingId}
                  isRecording={isRecording}
                  height={56}
                />
                <div className="mt-3 border-t border-active/20 pt-3">
                  <p className="text-xs font-medium text-muted-foreground mb-1">Meeting Notes <span className="opacity-50">(optional — AI will use these)</span></p>
                  <textarea
                    value={meetingNotes}
                    onChange={(e) => setMeetingNotes(e.target.value)}
                    placeholder="Jot key points, names, or topics as you go..."
                    rows={3}
                    className="w-full text-sm bg-background border border-border rounded-md px-3 py-2 resize-none placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-active"
                  />
                </div>
                {streamChunks.length > 0 && (
                  <div className="mt-3 border-t border-active/20 pt-3">
                    <p className="text-xs font-medium text-active mb-1.5">Live Transcript</p>
                    <div
                      ref={streamScrollRef}
                      className="max-h-32 overflow-y-auto text-sm text-muted-foreground space-y-1 pr-1"
                    >
                      {streamChunks.map((chunk, i) => {
                        const minutes = Math.floor(chunk.startTime / 60);
                        const seconds = Math.floor(chunk.startTime % 60);
                        const ts = `${minutes}:${seconds.toString().padStart(2, "0")}`;
                        return (
                          <p
                            key={i}
                            className={chunk.isPartial ? "opacity-50 italic" : "opacity-100"}
                          >
                            <span className="text-xs text-active/60 mr-1.5 font-mono">{ts}</span>
                            {chunk.text}
                          </p>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {filteredMeetings.length === 0 ? (
            <div className="text-center py-12">
              <FileAudio className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">
                {meetings.length === 0 ? "No meetings yet" : "No meetings match your filters"}
              </h3>
              <p className="text-muted-foreground mt-1">
                {meetings.length === 0
                  ? "Start a meeting to capture long-form conversation and notes"
                  : "Try a different search or status filter."}
              </p>
              {meetings.length === 0 && (
                <Button className="mt-4" variant="active" onClick={() => setShowConsent(true)}>
                  <Mic2 className="h-4 w-4 mr-2" />
                  Start Meeting
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredMeetings.map((recording) => (
                <Card
                  key={recording.id}
                  className="hover:bg-accent/50 cursor-pointer transition-colors"
                  onClick={() => handleRecordingClick(recording)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="h-10 w-10 rounded-lg bg-trusted/10 flex items-center justify-center">
                          <FileAudio className="h-5 w-5 text-trusted" />
                        </div>
                        <div>
                          <h3 className="font-medium">{recording.title}</h3>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <span>{new Date(recording.createdAt).toLocaleString()}</span>
                            <span>•</span>
                            <span className="capitalize">{recording.status}</span>
                            <span>•</span>
                            <span>Meeting</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">{formatDuration(recording.duration)}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePlayAudio(recording);
                          }}
                        >
                          <Play className="h-4 w-4" />
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                setRenameValue(recording.title);
                                setShowRenameDialog(recording);
                              }}
                            >
                              <Edit3 className="h-4 w-4 mr-2" />
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRecordingClick(recording);
                              }}
                            >
                              <FileOutput className="h-4 w-4 mr-2" />
                              View Details
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={async (e) => {
                                e.stopPropagation();
                                await handleMarkAsDictation(recording.id);
                              }}
                            >
                              <Mic2 className="h-4 w-4 mr-2" />
                              Mark as Dictation
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowDeleteConfirm(recording);
                              }}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

      <ConsentDialog
        open={showConsent}
        onOpenChange={setShowConsent}
        onStart={handleStartRecording}
      />

      <Dialog
        open={showRecordingDetail}
        onOpenChange={(open) => {
          setShowRecordingDetail(open);
          if (!open) {
            setSelectedRecording(null);
            setSelectedTranscript(null);
            setSpeakerNames({});
            setWaveformData([]);
            setSearchQuery("");
            setDiarizationMessage(null);
            setDiarizationError(null);
            setDetailError(null);
          }
        }}
      >
        <DialogContent className="max-w-5xl h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{selectedRecording?.title ?? "Recording"}</DialogTitle>
          </DialogHeader>

          <Tabs defaultValue="transcript" className="flex-1 flex flex-col">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="transcript" className="flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Transcript
              </TabsTrigger>
              <TabsTrigger value="audio" className="flex items-center gap-2">
                <FileAudio className="h-4 w-4" />
                Audio
              </TabsTrigger>
              <TabsTrigger value="analysis" className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4" />
                Analysis
              </TabsTrigger>
            </TabsList>

            <TabsContent value="transcript" className="flex-1 flex flex-col">
              {isLoadingDetail ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  Loading transcript...
                </div>
              ) : detailError ? (
                <div className="flex-1 flex items-center justify-center text-destructive">
                  <AlertCircle className="h-5 w-5 mr-2" />
                  {detailError}
                </div>
              ) : selectedTranscript ? (
                <>
                  {!hasSpeakerLabels && (
                    <div className="mb-3 rounded-lg border p-3 bg-muted/40">
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-sm">
                          <p className="font-medium">No speaker labels detected</p>
                          <p className="text-muted-foreground">
                            Run speaker identification to label multiple speakers in this transcript.
                          </p>
                        </div>
                        <Button
                          size="sm"
                          onClick={handleRunDiarization}
                          disabled={isRunningDiarization}
                        >
                          {isRunningDiarization ? (
                            <>
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                              Identifying...
                            </>
                          ) : (
                            "Identify Speakers"
                          )}
                        </Button>
                      </div>
                      {diarizationMessage && (
                        <p className="text-xs text-green-700 mt-2">{diarizationMessage}</p>
                      )}
                      {diarizationError && (
                        <p className="text-xs text-destructive mt-2">{diarizationError}</p>
                      )}
                    </div>
                  )}
                  <TranscriptSearch
                    onSearch={setSearchQuery}
                    className="mb-4"
                  />
                  <div className="flex-1 border rounded-lg overflow-hidden">
                    <TranscriptViewer
                      segments={filteredSegments}
                      speakerNames={speakerNames}
                      onRenameSpeaker={handleRenameSpeaker}
                      onEditSegment={async (segmentId, newText) => {
                        if (!selectedRecording) return;
                        await updateTranscriptSegment(selectedRecording.id, segmentId, newText);
                        const updated = await getTranscript(selectedRecording.id);
                        if (updated) setSelectedTranscript(updated);
                      }}
                    />
                  </div>
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  Transcript is not available yet. It will appear after processing completes.
                </div>
              )}
            </TabsContent>

            <TabsContent value="audio" className="flex-1 flex flex-col">
              {isLoadingDetail ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  Loading audio waveform...
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="p-4 border rounded-lg">
                    <h3 className="font-medium mb-2">Waveform</h3>
                    <WaveformVisualizer data={waveformData} height={100} />
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="p-3 bg-muted rounded-lg">
                      <span className="text-muted-foreground">Duration:</span>{" "}
                      <span className="font-medium">
                        {Math.floor((selectedRecording?.duration || 0) / 60)}:
                        {((selectedRecording?.duration || 0) % 60).toString().padStart(2, "0")}
                      </span>
                    </div>
                    <div className="p-3 bg-muted rounded-lg">
                      <span className="text-muted-foreground">Status:</span>{" "}
                      <span className="font-medium">{selectedRecording?.status ?? "unknown"}</span>
                    </div>
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="analysis" className="flex-1 overflow-hidden">
              {selectedRecording ? (
                <ScrollArea className="h-full pr-2">
                  {analysisCache[selectedRecording.id] && (
                    <div className="space-y-4 mb-6">
                      {analysisCache[selectedRecording.id].summary && (
                        <div className="rounded-lg border border-active/30 bg-active/5 p-4 space-y-2">
                          <p className="text-xs font-semibold text-active uppercase tracking-wide">
                            Nautilus Summary
                          </p>
                          <p className="text-sm leading-relaxed whitespace-pre-wrap">
                            {analysisCache[selectedRecording.id].summary}
                          </p>
                        </div>
                      )}
                      {analysisCache[selectedRecording.id].actionItems.length > 0 && (
                        <div className="rounded-lg border p-4 space-y-2">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Action Items
                          </p>
                          <ul className="space-y-1.5">
                            {analysisCache[selectedRecording.id].actionItems.map((item, i) => (
                              <li key={i} className="flex items-start gap-2 text-sm">
                                <span className="mt-1 h-2 w-2 rounded-full bg-active shrink-0" />
                                {item}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                  <AiAnalysisPanel recordingId={selectedRecording.id} />
                </ScrollArea>
              ) : (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  Select a recording to analyze.
                </div>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={showDeleteConfirm !== null}
        onOpenChange={(open) => { if (!open) setShowDeleteConfirm(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Recording</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{showDeleteConfirm?.title}&rdquo;? This will
              permanently remove the meeting, its transcript, and audio file.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteRecording}>
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog
        open={showRenameDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setShowRenameDialog(null);
            setRenameValue("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Recording</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleRenameRecording()}
            placeholder="New meeting title"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowRenameDialog(null); setRenameValue(""); }}>
              Cancel
            </Button>
            <Button onClick={handleRenameRecording} disabled={!renameValue.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
