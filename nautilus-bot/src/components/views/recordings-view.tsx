import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useRecordings } from "@/hooks/use-recordings";
import { useRecording } from "@/hooks/use-recording";
import { useRecordingDetail } from "@/hooks/use-recording-detail";
import { useToast } from "@/components/toast";
import { ConsentDialog } from "@/components/recording-overlay";
import { TranscriptViewer, TranscriptSearch } from "@/components/transcript-viewer";
import { RecordingWaveform, WaveformVisualizer } from "@/components/waveform-visualizer";
import { AiAnalysisPanel } from "@/components/ai-analysis-panel";
import {
  openRecordingAudio,
  runDiarization,
  renameSpeaker,
  deleteRecording,
  renameRecording,
  retryMeetingAutoName,
  setRecordingSourceType,
  isDiarizationModelAvailable,
  updateTranscriptSegment,
  deleteTranscriptSegments,
  updateRecordingNotes,
  updateRecordingAnalysis,
  updateRecordingTemplate,
  getMeetingChatMessages,
  updateMeetingChatMessages,
  summarizeRecordingGrounded,
  extractActionItemsGrounded,
} from "@/lib/tauri";
import type { MeetingChatMessage } from "@/lib/tauri";
import type { Recording } from "@/types";
import {
  buildMeetingTemplateOutline,
  getMeetingTemplateOption,
  MEETING_TEMPLATES,
} from "@/lib/meeting-templates";
import { listen } from "@tauri-apps/api/event";
import {
  AlertCircle,
  Edit3,
  FileAudio,
  FileOutput,
  FileText,
  MessageSquare,
  Loader2,
  Mic2,
  MoreHorizontal,
  Plus,
  Play,
  RefreshCw,
  Search,
  Square,
  Trash2,
} from "lucide-react";
import type { AnalysisTemplate } from "@/types";

const MEETING_ASK_TEMPLATES: AnalysisTemplate[] = [
  {
    id: "summary",
    name: "Refresh Summary",
    icon: "file-text",
    query: "Using the meeting transcript and saved meeting notes, write a crisp summary with outcomes, open questions, and next steps.",
    description: "Rebuild the summary from notes and transcript",
  },
  {
    id: "actions",
    name: "Action Items",
    icon: "check-square",
    query: "Using the meeting transcript and saved meeting notes, extract clear action items with owners when they are stated.",
    description: "Find follow-ups and owners",
  },
  {
    id: "decisions",
    name: "Decisions",
    icon: "lightbulb",
    query: "List the decisions, agreements, and commitments made in this meeting, using the saved meeting notes to clarify context.",
    description: "Surface what was decided",
  },
  {
    id: "dates",
    name: "Deadlines",
    icon: "calendar",
    query: "Extract all deadlines, dates, and time-sensitive follow-ups from this meeting and the saved notes.",
    description: "Highlight timing commitments",
  },
];

function normalizeActionItems(items: string[]): string[] {
  return items
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function actionItemsToText(items: string[] | null | undefined): string {
  return normalizeActionItems(items ?? []).join("\n");
}

function actionItemsFromText(value: string): string[] {
  return normalizeActionItems(value.split("\n"));
}

function formatGroundedActionItem(item: {
  task: string;
  assignee?: string | null;
  deadline?: string | null;
}): string {
  const details = [
    item.assignee?.trim() ? `Owner: ${item.assignee.trim()}` : null,
    item.deadline?.trim() ? `Due: ${item.deadline.trim()}` : null,
  ].filter(Boolean);

  if (details.length === 0) {
    return item.task.trim();
  }

  return `${item.task.trim()} (${details.join(" · ")})`;
}

type MeetingNoteSection = {
  title: string;
  body: string;
  isTemplateSection: boolean;
  hasExplicitPlaceholder: boolean;
};

function normalizeMeetingSectionTitle(value: string): string {
  return value.trim().toLowerCase();
}

function looksLikeMeetingSectionHeading(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/^[-*•]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed)) {
    return false;
  }
  if (trimmed.length > 72) {
    return false;
  }
  if (/[.!?]$/.test(trimmed)) {
    return false;
  }
  return trimmed.split(/\s+/).length <= 10;
}

function serializeMeetingNoteSections(sections: MeetingNoteSection[]): string {
  return sections
    .flatMap((section) => {
      const title = section.title.trim();
      if (!title) {
        return [];
      }

      const body = section.body.trimEnd();
      if (!body && !section.hasExplicitPlaceholder) {
        return [];
      }

      return [body ? `${title}\n${body}` : `${title}\n- `];
    })
    .join("\n\n");
}

function parseMeetingNoteSections(
  notes: string,
  templateId: string | null | undefined
): MeetingNoteSection[] {
  const template = getMeetingTemplateOption(templateId);
  const templateTitles = new Set(
    template.notesOutline.map((title) => normalizeMeetingSectionTitle(title))
  );
  const parsedSections: MeetingNoteSection[] = [];
  const generalBlocks: string[] = [];

  for (const block of notes.split(/\n{2,}/)) {
    const trimmedBlock = block.trim();
    if (!trimmedBlock) {
      continue;
    }

    const lines = trimmedBlock.split("\n");
    const title = lines[0]?.trim() ?? "";
    const bodyText = lines.slice(1).join("\n").trimEnd();
    const normalizedTitle = normalizeMeetingSectionTitle(title);

    if (
      title &&
      (templateTitles.has(normalizedTitle) || looksLikeMeetingSectionHeading(title))
    ) {
      const hasExplicitPlaceholder = bodyText.trim() === "-";
      parsedSections.push({
        title,
        body: hasExplicitPlaceholder ? "" : bodyText,
        isTemplateSection: templateTitles.has(normalizedTitle),
        hasExplicitPlaceholder,
      });
      continue;
    }

    generalBlocks.push(trimmedBlock);
  }

  const sections: MeetingNoteSection[] = [];

  if (generalBlocks.length > 0) {
    sections.push({
      title: "General notes",
      body: generalBlocks.join("\n\n"),
      isTemplateSection: false,
      hasExplicitPlaceholder: false,
    });
  }

  for (const title of template.notesOutline) {
    const normalizedTitle = normalizeMeetingSectionTitle(title);
    const matchedSection = parsedSections.find(
      (section) => normalizeMeetingSectionTitle(section.title) === normalizedTitle
    );
    sections.push(
      matchedSection ?? {
        title,
        body: "",
        isTemplateSection: true,
        hasExplicitPlaceholder: false,
      }
    );
  }

  for (const section of parsedSections) {
    if (templateTitles.has(normalizeMeetingSectionTitle(section.title))) {
      continue;
    }
    sections.push({
      ...section,
      isTemplateSection: false,
    });
  }

  if (sections.length > 0) {
    return sections;
  }

  return template.notesOutline.map((title) => ({
    title,
    body: "",
    isTemplateSection: true,
    hasExplicitPlaceholder: false,
  }));
}

function getNextMeetingSectionTitle(sections: MeetingNoteSection[]): string {
  const baseTitle = "Custom section";
  const usedTitles = new Set(
    sections.map((section) => normalizeMeetingSectionTitle(section.title))
  );

  if (!usedTitles.has(normalizeMeetingSectionTitle(baseTitle))) {
    return baseTitle;
  }

  let index = 2;
  while (usedTitles.has(normalizeMeetingSectionTitle(`${baseTitle} ${index}`))) {
    index += 1;
  }

  return `${baseTitle} ${index}`;
}

export function RecordingsView() {
  const { recordings, refetch } = useRecordings();
  const { startMeeting, stopMeeting, isRecording, recordingId, formattedDuration } = useRecording();
  const { toast } = useToast();
  const [recordingStatusOverrides, setRecordingStatusOverrides] = useState<
    Record<string, Recording["status"]>
  >({});
  const [showConsent, setShowConsent] = useState(false);
  const [showRecordingDetail, setShowRecordingDetail] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isRunningDiarization, setIsRunningDiarization] = useState(false);
  const [diarizationMessage, setDiarizationMessage] = useState<string | null>(null);
  const [diarizationError, setDiarizationError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<Recording | null>(null);
  const [showRenameDialog, setShowRenameDialog] = useState<Recording | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isStopping, setIsStopping] = useState(false);
  const [meetingNotes, setMeetingNotes] = useState("");
  const [meetingNotesTargetId, setMeetingNotesTargetId] = useState<string | null>(null);
  const [meetingTemplateId, setMeetingTemplateId] = useState("auto");
  const [meetingSummary, setMeetingSummary] = useState("");
  const [meetingActionItemsText, setMeetingActionItemsText] = useState("");
  const [meetingChatMessages, setMeetingChatMessages] = useState<MeetingChatMessage[]>([]);
  const [isRefreshingSummary, setIsRefreshingSummary] = useState(false);
  const [isRefreshingActionItems, setIsRefreshingActionItems] = useState(false);
  const lastRecordingState = useRef(false);
  const lastSavedMeetingNotesRef = useRef("");
  const lastSavedMeetingTemplateRef = useRef("auto");
  const lastSavedMeetingSummaryRef = useRef("");
  const lastSavedMeetingActionItemsRef = useRef("[]");
  const lastSavedMeetingChatRef = useRef("[]");

  // Live streaming transcript state
  type StreamChunk = { text: string; startTime: number; isPartial: boolean };
  const [streamChunks, setStreamChunks] = useState<StreamChunk[]>([]);
  const streamScrollRef = useRef<HTMLDivElement>(null);

  const [autoNameIssue, setAutoNameIssue] = useState<{
    recordingId: string;
    message: string;
  } | null>(null);
  const [meetingSearch, setMeetingSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "completed" | "recording" | "processing" | "error"
  >(
    "all"
  );
  const [isBulkReclassifying, setIsBulkReclassifying] = useState(false);

  const {
    selectedRecording,
    setSelectedRecording,
    selectedTranscript,
    speakerNames,
    setSpeakerNames,
    waveformData,
    isLoadingDetail,
    detailError,
    loadRecordingDetail,
    refreshTranscript,
    clearRecordingDetail,
  } = useRecordingDetail({
    isOpen: showRecordingDetail,
    onRecordingLoaded: (recording) => {
      if (recording.id === meetingNotesTargetId) {
        lastSavedMeetingNotesRef.current = recording.meetingNotes ?? "";
        lastSavedMeetingTemplateRef.current = recording.meetingTemplateId ?? "auto";
        lastSavedMeetingSummaryRef.current = recording.summary ?? "";
        lastSavedMeetingActionItemsRef.current = JSON.stringify(
          normalizeActionItems(recording.actionItems ?? [])
        );
      }
    },
  });

  type RecordingStatusChangedEvent = {
    recordingId: string;
    status: Recording["status"];
    message?: string | null;
    progress?: number | null;
    updatedAt?: string | null;
    meetingProcessingStartedAt?: string | null;
    transcriptFirstAvailableAt?: string | null;
    consentPromptShown?: boolean | null;
  };

  useEffect(() => {
    if (lastRecordingState.current && !isRecording) {
      refetch();
      setStreamChunks([]);
    }
    lastRecordingState.current = isRecording;
  }, [isRecording, refetch]);

  useEffect(() => {
    if (!meetingNotesTargetId) {
      return;
    }

    const normalizedNotes = meetingNotes.trim();
    if (normalizedNotes === lastSavedMeetingNotesRef.current.trim()) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void updateRecordingNotes(meetingNotesTargetId, meetingNotes)
        .then(() => {
          lastSavedMeetingNotesRef.current = meetingNotes;
          setSelectedRecording((current) =>
            current?.id === meetingNotesTargetId
              ? {
                  ...current,
                  meetingNotes: normalizedNotes ? meetingNotes : null,
                  notesUpdatedAt: new Date().toISOString(),
                }
              : current
          );
        })
        .catch((error) => {
          console.error("Failed to update meeting notes:", error);
        });
    }, 350);

    return () => window.clearTimeout(timeoutId);
  }, [meetingNotes, meetingNotesTargetId]);

  useEffect(() => {
    if (!meetingNotesTargetId) {
      return;
    }

    const normalizedTemplateId = meetingTemplateId === "auto" ? "auto" : meetingTemplateId.trim();
    if (normalizedTemplateId === lastSavedMeetingTemplateRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void updateRecordingTemplate(
        meetingNotesTargetId,
        normalizedTemplateId === "auto" ? null : normalizedTemplateId
      )
        .then(() => {
          lastSavedMeetingTemplateRef.current = normalizedTemplateId;
          setSelectedRecording((current) =>
            current?.id === meetingNotesTargetId
              ? {
                  ...current,
                  meetingTemplateId:
                    normalizedTemplateId === "auto" ? null : normalizedTemplateId,
                }
              : current
          );
        })
        .catch((error) => {
          console.error("Failed to update meeting template:", error);
        });
    }, 250);

    return () => window.clearTimeout(timeoutId);
  }, [meetingNotesTargetId, meetingTemplateId, setSelectedRecording]);

  useEffect(() => {
    if (!meetingNotesTargetId) {
      return;
    }

    const normalizedSummary = meetingSummary.trim();
    const normalizedActionItems = actionItemsFromText(meetingActionItemsText);
    const nextActionItemsKey = JSON.stringify(normalizedActionItems);

    if (
      normalizedSummary === lastSavedMeetingSummaryRef.current.trim() &&
      nextActionItemsKey === lastSavedMeetingActionItemsRef.current
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void updateRecordingAnalysis(
        meetingNotesTargetId,
        normalizedSummary || null,
        normalizedActionItems
      )
        .then(() => {
          lastSavedMeetingSummaryRef.current = normalizedSummary;
          lastSavedMeetingActionItemsRef.current = nextActionItemsKey;
          setSelectedRecording((current) =>
            current?.id === meetingNotesTargetId
              ? {
                  ...current,
                  summary: normalizedSummary || undefined,
                  actionItems: normalizedActionItems,
                }
              : current
          );
        })
        .catch((error) => {
          console.error("Failed to update meeting analysis:", error);
        });
    }, 350);

    return () => window.clearTimeout(timeoutId);
  }, [meetingActionItemsText, meetingNotesTargetId, meetingSummary, setSelectedRecording]);

  useEffect(() => {
    if (!meetingNotesTargetId) {
      return;
    }

    const nextMessagesKey = JSON.stringify(meetingChatMessages);
    if (nextMessagesKey === lastSavedMeetingChatRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void updateMeetingChatMessages(meetingNotesTargetId, meetingChatMessages)
        .then(() => {
          lastSavedMeetingChatRef.current = nextMessagesKey;
        })
        .catch((error) => {
          console.error("Failed to update meeting chat:", error);
        });
    }, 250);

    return () => window.clearTimeout(timeoutId);
  }, [meetingChatMessages, meetingNotesTargetId]);

  useEffect(() => {
    if (!isRecording && !showRecordingDetail) {
      setMeetingNotes("");
      setMeetingNotesTargetId(null);
      setMeetingTemplateId("auto");
      setMeetingSummary("");
      setMeetingActionItemsText("");
      setMeetingChatMessages([]);
      lastSavedMeetingNotesRef.current = "";
      lastSavedMeetingTemplateRef.current = "auto";
      lastSavedMeetingSummaryRef.current = "";
      lastSavedMeetingActionItemsRef.current = "[]";
      lastSavedMeetingChatRef.current = "[]";
    }
  }, [isRecording, showRecordingDetail]);

  useEffect(() => {
    if (!selectedRecording) {
      setMeetingTemplateId("auto");
      setMeetingSummary("");
      setMeetingActionItemsText("");
      setMeetingChatMessages([]);
      lastSavedMeetingTemplateRef.current = "auto";
      lastSavedMeetingSummaryRef.current = "";
      lastSavedMeetingActionItemsRef.current = "[]";
      lastSavedMeetingChatRef.current = "[]";
      return;
    }

    const nextTemplateId = selectedRecording.meetingTemplateId ?? "auto";
    const nextSummary = selectedRecording.summary ?? "";
    const nextActionItemsText = actionItemsToText(selectedRecording.actionItems);
    setMeetingTemplateId(nextTemplateId);
    setMeetingSummary(nextSummary);
    setMeetingActionItemsText(nextActionItemsText);
    lastSavedMeetingTemplateRef.current = nextTemplateId;
    lastSavedMeetingSummaryRef.current = nextSummary;
    lastSavedMeetingActionItemsRef.current = JSON.stringify(
      normalizeActionItems(selectedRecording.actionItems ?? [])
    );
  }, [
    selectedRecording?.actionItems,
    selectedRecording?.id,
    selectedRecording?.meetingTemplateId,
    selectedRecording?.summary,
  ]);

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
        void refetch();
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

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<RecordingStatusChangedEvent>("recording-status-changed", (event) => {
      const payload = event.payload;
      if (!payload?.recordingId) return;

      setRecordingStatusOverrides((current) => ({
        ...current,
        [payload.recordingId]: payload.status,
      }));

      if (payload.status === "completed" || payload.status === "error") {
        void refetch();
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
      const startedId = await startMeeting({
        ...options,
        projectId: "default",
        meetingNotes: meetingNotes.trim() || undefined,
        consentPromptShown: true,
      });
      if (startedId) {
        setMeetingNotesTargetId(startedId);
        lastSavedMeetingNotesRef.current = meetingNotes;
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

  const handleRecordingClick = (recording: Recording) => {
    setMeetingNotes(recording.meetingNotes ?? "");
    setMeetingNotesTargetId(recording.id);
    lastSavedMeetingNotesRef.current = recording.meetingNotes ?? "";
    setMeetingTemplateId(recording.meetingTemplateId ?? "auto");
    lastSavedMeetingTemplateRef.current = recording.meetingTemplateId ?? "auto";
    setMeetingSummary(recording.summary ?? "");
    setMeetingActionItemsText(actionItemsToText(recording.actionItems));
    lastSavedMeetingSummaryRef.current = recording.summary ?? "";
    lastSavedMeetingActionItemsRef.current = JSON.stringify(
      normalizeActionItems(recording.actionItems ?? [])
    );
    setMeetingChatMessages([]);
    lastSavedMeetingChatRef.current = "[]";
    setShowRecordingDetail(true);
    setSearchQuery("");
    setDiarizationMessage(null);
    setDiarizationError(null);
    void loadRecordingDetail(recording);
    void getMeetingChatMessages(recording.id)
      .then((messages) => {
        setMeetingChatMessages(messages);
        lastSavedMeetingChatRef.current = JSON.stringify(messages);
      })
      .catch((error) => {
        console.error("Failed to load meeting chat:", error);
      });
  };

  const handleApplyTemplateOutline = () => {
    const outline = buildMeetingTemplateOutline(meetingTemplateId);
    setMeetingNotes((current) => {
      const trimmedCurrent = current.trim();
      if (!trimmedCurrent) {
        return outline;
      }
      if (trimmedCurrent.includes(outline.trim())) {
        return current;
      }
      return `${current.trimEnd()}\n\n${outline}`;
    });
  };

  const appendMeetingNotesBlock = (heading: string, body: string) => {
    const trimmedBody = body.trim();
    if (!trimmedBody) {
      return;
    }

    setMeetingNotes((current) => {
      const nextBlock = `${heading}\n${trimmedBody}`;
      const trimmedCurrent = current.trim();
      if (!trimmedCurrent) {
        return nextBlock;
      }
      return `${current.trimEnd()}\n\n${nextBlock}`;
    });
  };

  const handleRenameSpeaker = async (speakerId: string, newName: string) => {
    if (!selectedRecording) {
      return;
    }
    setSpeakerNames((prev) => ({ ...prev, [speakerId]: newName }));
    await renameSpeaker(selectedRecording.id, speakerId, newName);
  };

  const handleDeleteTranscriptSegments = async (segmentIds: string[]) => {
    if (!selectedRecording || segmentIds.length === 0) {
      return;
    }

    try {
      const removed = await deleteTranscriptSegments(selectedRecording.id, segmentIds);
      if (removed === 0) {
        toast("Nothing was removed from the transcript.", "error");
        return;
      }

      await refreshTranscript(selectedRecording.id);
      await refetch();
      toast(
        removed === 1
          ? "Transcript section removed."
          : `${removed} transcript sections removed.`,
        "success"
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to remove transcript text from this meeting.";
      toast(message, "error");
    }
  };

  const handleRefreshSummary = async () => {
    if (!selectedRecording) {
      return;
    }

    setIsRefreshingSummary(true);
    try {
      const result = await summarizeRecordingGrounded(selectedRecording.id);
      const nextSummary = result.summary.trim();
      const currentActionItems = actionItemsFromText(meetingActionItemsText);

      setMeetingSummary(nextSummary);
      lastSavedMeetingSummaryRef.current = nextSummary;
      lastSavedMeetingActionItemsRef.current = JSON.stringify(currentActionItems);
      setSelectedRecording((current) =>
        current?.id === selectedRecording.id
          ? {
              ...current,
              summary: nextSummary || undefined,
              actionItems: currentActionItems,
            }
          : current
      );
      await updateRecordingAnalysis(
        selectedRecording.id,
        nextSummary || null,
        currentActionItems
      );
      toast("Summary refreshed from this meeting.", "success");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to refresh the summary.";
      toast(message, "error");
    } finally {
      setIsRefreshingSummary(false);
    }
  };

  const handleRefreshActionItems = async () => {
    if (!selectedRecording) {
      return;
    }

    setIsRefreshingActionItems(true);
    try {
      const result = await extractActionItemsGrounded(selectedRecording.id);
      const nextActionItems = normalizeActionItems(
        result.items.map((item) => formatGroundedActionItem(item))
      );
      const nextActionItemsText = actionItemsToText(nextActionItems);
      const normalizedSummary = meetingSummary.trim();

      setMeetingActionItemsText(nextActionItemsText);
      lastSavedMeetingSummaryRef.current = normalizedSummary;
      lastSavedMeetingActionItemsRef.current = JSON.stringify(nextActionItems);
      setSelectedRecording((current) =>
        current?.id === selectedRecording.id
          ? {
              ...current,
              summary: normalizedSummary || undefined,
              actionItems: nextActionItems,
            }
          : current
      );
      await updateRecordingAnalysis(
        selectedRecording.id,
        normalizedSummary || null,
        nextActionItems
      );
      toast("Action items refreshed from this meeting.", "success");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to refresh action items.";
      toast(message, "error");
    } finally {
      setIsRefreshingActionItems(false);
    }
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
  const effectiveRecordings = useMemo(
    () =>
      recordings.map((recording) => ({
        ...recording,
        status: recordingStatusOverrides[recording.id] ?? recording.status,
      })),
    [recordingStatusOverrides, recordings]
  );
  const meetings = useMemo(
    () => effectiveRecordings.filter((recording) => recording.sourceType === "meeting"),
    [effectiveRecordings]
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
  const selectedTemplateOption = useMemo(
    () => getMeetingTemplateOption(meetingTemplateId),
    [meetingTemplateId]
  );
  const meetingNoteSections = useMemo(
    () => parseMeetingNoteSections(meetingNotes, meetingTemplateId),
    [meetingNotes, meetingTemplateId]
  );

  const updateMeetingSections = (
    updater: (sections: MeetingNoteSection[]) => MeetingNoteSection[]
  ) => {
    setMeetingNotes((current) => {
      const nextSections = updater(
        parseMeetingNoteSections(current, meetingTemplateId)
      );
      return serializeMeetingNoteSections(nextSections);
    });
  };

  const handleMeetingSectionBodyChange = (sectionIndex: number, body: string) => {
    updateMeetingSections((sections) =>
      sections.map((section, index) =>
        index === sectionIndex
          ? {
              ...section,
              body,
            }
          : section
      )
    );
  };

  const handleMeetingSectionTitleChange = (sectionIndex: number, title: string) => {
    updateMeetingSections((sections) =>
      sections.map((section, index) =>
        index === sectionIndex
          ? {
              ...section,
              title,
            }
          : section
      )
    );
  };

  const handleClearMeetingSection = (sectionIndex: number) => {
    updateMeetingSections((sections) =>
      sections.map((section, index) =>
        index === sectionIndex
          ? {
              ...section,
              body: "",
              hasExplicitPlaceholder: false,
            }
          : section
      )
    );
  };

  const handleAddMeetingSection = () => {
    updateMeetingSections((sections) => [
      ...sections,
      {
        title: getNextMeetingSectionTitle(sections),
        body: "",
        isTemplateSection: false,
        hasExplicitPlaceholder: true,
      },
    ]);
  };

  const handleRemoveMeetingSection = (sectionIndex: number) => {
    updateMeetingSections((sections) =>
      sections.filter((_, index) => index !== sectionIndex)
    );
  };

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
            Capture meetings, review transcripts, and keep follow-up moving.
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
                    variant={statusFilter === "processing" ? "active" : "outline"}
                    size="sm"
                    onClick={() => setStatusFilter("processing")}
                  >
                    Processing
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
                            {recording.status === "processing" ? (
                              <span className="inline-flex items-center gap-1">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                Processing
                              </span>
                            ) : (
                              <span className="capitalize">{recording.status}</span>
                            )}
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
                          disabled={!recording.audioPath}
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
            clearRecordingDetail();
            setSearchQuery("");
            setDiarizationMessage(null);
            setDiarizationError(null);
            if (!isRecording) {
              setMeetingNotesTargetId(null);
              setMeetingNotes("");
              setMeetingChatMessages([]);
              lastSavedMeetingNotesRef.current = "";
              lastSavedMeetingChatRef.current = "[]";
            }
          }
        }}
      >
        <DialogContent className="max-w-5xl h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{selectedRecording?.title ?? "Recording"}</DialogTitle>
            <DialogDescription>
              Review meeting notes, grounded AI outputs, transcript edits, and audio assets for this recording.
            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="notes" className="flex-1 flex flex-col">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="notes" className="flex items-center gap-2">
                <Edit3 className="h-4 w-4" />
                Notes
              </TabsTrigger>
              <TabsTrigger value="ask" className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4" />
                Ask
              </TabsTrigger>
              <TabsTrigger value="transcript" className="flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Transcript
              </TabsTrigger>
              <TabsTrigger value="assets" className="flex items-center gap-2">
                <FileAudio className="h-4 w-4" />
                Assets
              </TabsTrigger>
            </TabsList>

            <TabsContent value="notes" className="flex-1 overflow-hidden">
              <ScrollArea className="h-full pr-2">
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
                  <div className="rounded-lg border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">Meeting notes</p>
                        <p className="text-xs text-muted-foreground">
                          Keep the note canvas current. Summaries, action items, and meeting chat use this alongside the transcript.
                        </p>
                      </div>
                      <div className="text-xs text-muted-foreground text-right">
                        <div>Template: {selectedTemplateOption.label}</div>
                        <div>{selectedTemplateOption.description}</div>
                        {selectedRecording?.notesUpdatedAt ? (
                          <div>
                            Updated {new Date(selectedRecording.notesUpdatedAt).toLocaleString()}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <label className="text-xs font-medium text-muted-foreground" htmlFor="meeting-template">
                        Format
                      </label>
                      <select
                        id="meeting-template"
                        value={meetingTemplateId}
                        onChange={(event) => setMeetingTemplateId(event.target.value)}
                        className="h-9 rounded-md border bg-background px-3 text-sm"
                      >
                        {MEETING_TEMPLATES.map((template) => (
                          <option key={template.value} value={template.value}>
                            {template.label}
                          </option>
                        ))}
                      </select>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={handleApplyTemplateOutline}
                      >
                        Apply Outline
                      </Button>
                    </div>
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">
                        Edit notes by section. Everything still autosaves to the same meeting note record.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={handleAddMeetingSection}
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Add Section
                      </Button>
                    </div>
                    <div aria-label="Meeting notes" role="group" className="mt-4 space-y-3">
                      {meetingNoteSections.map((section, index) => (
                        <div
                          key={`${section.title}-${index}`}
                          className="rounded-lg border bg-muted/20 p-3"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              {section.isTemplateSection ? (
                                <div>
                                  <div className="flex items-center gap-2">
                                    <p className="text-sm font-medium">{section.title}</p>
                                    <span className="rounded-full bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                                      Template
                                    </span>
                                  </div>
                                  <p className="text-xs text-muted-foreground">
                                    Keeps this meeting aligned to the selected format.
                                  </p>
                                </div>
                              ) : (
                                <div className="space-y-2">
                                  <label
                                    className="text-xs font-medium text-muted-foreground"
                                    htmlFor={`meeting-section-title-${index}`}
                                  >
                                    Section title
                                  </label>
                                  <Input
                                    id={`meeting-section-title-${index}`}
                                    value={section.title}
                                    onChange={(event) =>
                                      handleMeetingSectionTitleChange(
                                        index,
                                        event.target.value
                                      )
                                    }
                                  />
                                </div>
                              )}
                            </div>
                            {section.isTemplateSection ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => handleClearMeetingSection(index)}
                              >
                                Clear
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                aria-label={`Remove section ${section.title}`}
                                onClick={() => handleRemoveMeetingSection(index)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                          <Textarea
                            value={section.body}
                            onChange={(event) =>
                              handleMeetingSectionBodyChange(index, event.target.value)
                            }
                            aria-label={`${section.title} notes`}
                            placeholder={`Capture ${section.title.toLowerCase()} here.`}
                            rows={5}
                            className="mt-3 min-h-[120px] resize-y bg-background/90"
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                      <div className="rounded-lg border bg-muted/30 p-4">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Meeting status
                        </p>
                        <p className="mt-1 text-sm font-medium capitalize">
                          {selectedRecording?.status ?? "unknown"}
                        </p>
                      </div>
                      <div className="rounded-lg border bg-muted/30 p-4">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Transcript length
                        </p>
                        <p className="mt-1 text-sm font-medium">
                          {selectedTranscript?.segments?.length ?? 0} segments
                        </p>
                      </div>
                    </div>

                    <div className="rounded-lg border border-active/30 bg-active/5 p-4 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-active">
                            Summary
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Keep the meeting recap editable. Regenerate when your notes change.
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={handleRefreshSummary}
                          disabled={!selectedRecording || isRefreshingSummary}
                        >
                          {isRefreshingSummary ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="mr-2 h-4 w-4" />
                          )}
                          Refresh Summary
                        </Button>
                      </div>
                      <textarea
                        value={meetingSummary}
                        onChange={(event) => setMeetingSummary(event.target.value)}
                        aria-label="Meeting summary"
                        placeholder="Summary will appear here after transcription and analysis finish."
                        rows={8}
                        className="w-full resize-none rounded-lg border bg-background px-3 py-3 text-sm leading-relaxed placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-active"
                      />
                    </div>

                    <div className="rounded-lg border p-4 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Action Items
                          </p>
                          <p className="text-xs text-muted-foreground">
                            One line per follow-up. Owners and dates can stay inline.
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={handleRefreshActionItems}
                          disabled={!selectedRecording || isRefreshingActionItems}
                        >
                          {isRefreshingActionItems ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="mr-2 h-4 w-4" />
                          )}
                          Refresh Action Items
                        </Button>
                      </div>
                      <textarea
                        value={meetingActionItemsText}
                        onChange={(event) => setMeetingActionItemsText(event.target.value)}
                        aria-label="Meeting action items"
                        placeholder="Action items will appear here after transcription and analysis finish."
                        rows={8}
                        className="w-full resize-none rounded-lg border bg-background px-3 py-3 text-sm leading-relaxed placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-active"
                      />
                    </div>
                  </div>
                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent value="ask" forceMount className="flex-1 overflow-hidden">
              {selectedRecording ? (
                <ScrollArea className="h-full pr-2">
                  <div className="space-y-4">
                    <div className="rounded-lg border bg-muted/20 p-4">
                      <p className="text-sm font-medium">Ask this meeting</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Chat against the transcript and saved meeting notes. Use this for follow-ups, decisions, blockers, or owner questions.
                      </p>
                    </div>
                    <AiAnalysisPanel
                      recordingId={selectedRecording.id}
                      title="Meeting Chat"
                      inputPlaceholder="Ask about decisions, blockers, follow-ups, or anything in this meeting..."
                      templates={MEETING_ASK_TEMPLATES}
                      emptyStateLabel="Reviewing meeting context..."
                      analysisMode="grounded"
                      chatMessages={meetingChatMessages}
                      onChatMessagesChange={setMeetingChatMessages}
                      responseActions={[
                        {
                          label: "Replace Summary",
                          onAction: ({ response }) => setMeetingSummary(response),
                        },
                        {
                          label: "Append to Notes",
                          onAction: ({ response, templateId }) =>
                            appendMeetingNotesBlock(
                              templateId === "summary"
                                ? "Summary refresh"
                                : templateId === "decisions"
                                  ? "Decisions"
                                  : templateId === "dates"
                                    ? "Deadlines"
                                    : "Meeting answer",
                              response
                            ),
                        },
                      ]}
                      actionItemActions={[
                        {
                          label: "Replace Action Items",
                          onAction: ({ items }) =>
                            setMeetingActionItemsText(
                              actionItemsToText(items.map((item) => formatGroundedActionItem(item)))
                            ),
                        },
                        {
                          label: "Append to Notes",
                          onAction: ({ items }) =>
                            appendMeetingNotesBlock(
                              "Action items",
                              items.map((item) => `- ${formatGroundedActionItem(item)}`).join("\n")
                            ),
                        },
                      ]}
                    />
                  </div>
                </ScrollArea>
              ) : (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  Select a meeting to ask questions.
                </div>
              )}
            </TabsContent>

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
                  <div className="mb-3 rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
                    Edit transcript paragraphs in place, or remove a paragraph if it should not be part of the meeting record.
                  </div>
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
                        await refreshTranscript(selectedRecording.id);
                      }}
                      onDeleteSegments={handleDeleteTranscriptSegments}
                    />
                  </div>
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  {selectedRecording?.status === "processing" ? (
                    <span className="inline-flex items-center">
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Processing transcript...
                    </span>
                  ) : (
                    "Transcript is not available yet. It will appear after processing completes."
                  )}
                </div>
              )}
            </TabsContent>

            <TabsContent value="assets" className="flex-1 flex flex-col">
              {isLoadingDetail ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  Loading meeting assets...
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="rounded-lg border p-4">
                    <h3 className="font-medium mb-2">Waveform</h3>
                    <WaveformVisualizer data={waveformData} height={100} />
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="p-3 bg-muted rounded-lg text-sm">
                      <span className="text-muted-foreground">Duration:</span>{" "}
                      <span className="font-medium">
                        {Math.floor((selectedRecording?.duration || 0) / 60)}:
                        {((selectedRecording?.duration || 0) % 60).toString().padStart(2, "0")}
                      </span>
                    </div>
                    <div className="p-3 bg-muted rounded-lg text-sm">
                      <span className="text-muted-foreground">Status:</span>{" "}
                      <span className="font-medium capitalize">
                        {selectedRecording?.status ?? "unknown"}
                      </span>
                    </div>
                    <div className="p-3 bg-muted rounded-lg text-sm">
                      <span className="text-muted-foreground">Created:</span>{" "}
                      <span className="font-medium">
                        {selectedRecording?.createdAt
                          ? new Date(selectedRecording.createdAt).toLocaleString()
                          : "Unknown"}
                      </span>
                    </div>
                    <div className="p-3 bg-muted rounded-lg text-sm">
                      <span className="text-muted-foreground">Audio:</span>{" "}
                      <span className="font-medium">
                        {selectedRecording?.audioPath ? "Available" : "Not saved"}
                      </span>
                    </div>
                  </div>
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
