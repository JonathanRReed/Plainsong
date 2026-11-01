import { NotePublishStatusLine } from "@/components/meetings/note-publish-status";
import { MeetingSwitcher } from "@/components/views/meetings/meeting-switcher";
import { MeetingMicrophoneFallback } from "@/components/meetings/microphone-fallback";
import { useMeetingTranscriptionActivity } from "@/hooks/use-meeting-transcription-activity";
import { TranscriptionActivity } from "@/components/meetings/transcription-activity";
import { MeetingFollowupInbox } from "@/components/views/meetings/meeting-followup-inbox";
import { EngineRecoveryBanner } from "@/components/engine-recovery-banner";
import { isCurrentWrittenNoteCitation } from "@/lib/citation-source";
import { SUMMARY_GROUNDING_POLICY_VERSION, type ActionItemProvenance, type UnverifiedStatement } from "@/types/asr";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AiWaitOrb } from "@/components/ui/ai-wait-orb";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useRecordings } from "@/hooks/use-recordings";
import { RecordingDurationText, useRecordingSession } from "@/hooks/use-recording";
import { useRecordingDetail } from "@/hooks/use-recording-detail";
import { AudioPlayer, type AudioPlayerHandle } from "@/components/meetings/audio-player";
import { useScopedRequestGuard } from "@/hooks/use-scoped-request-guard";
import { useToast } from "@/components/toast";
import { ConsentDialog } from "@/components/recording-overlay";
import {
  TranscriptSearch,
  type TranscriptDeleteExpectation,
  type SpeakerVoiceState,
  type TranscriptMatch,
  type TranscriptProvenance,
} from "@/components/transcript-viewer";
import { TranscriptNavigator } from "@/components/meetings/transcript-navigator";
import { PlayheadTranscriptViewer } from "@/components/meetings/playhead-transcript-viewer";
import { MeetingAsides } from "@/components/meetings/meeting-asides";
import { getRecordingAsides, getRecordingAsideRanges, type MeetingAside } from "@/lib/backend/meeting-asides";
import { HeardThroughSpeakers } from "@/components/meetings/heard-through-speakers";
import { usePlayheadStore } from "@/lib/playhead-store";
import {
  isCloudProvider,
  isKnownAsrProvider,
  providerHostingPreference,
} from "@/lib/asr-capabilities";
import {
  describeMeetingDiarizer,
  describeMeetingDiarizerDetail,
} from "@/lib/meeting-diarizer";
import { cn } from "@/lib/utils";
import { userFacingErrorMessage } from "@/lib/user-facing-error";
import { RecordingWaveform, WaveformVisualizer } from "@/components/waveform-visualizer";
import { AiAnalysisPanel } from "@/components/ai-analysis-panel";
import {
  summarizeRecordingGrounded,
  extractActionItemsGrounded,
  askMemory,
  cancelAnalysisRun,
  getRelationshipMemory,
  searchTranscripts,
} from "@/lib/backend/ai";
import {
  deleteRecording,
  deleteTranscriptSegments,
  editTranscriptSpeakerTurn,
  getMeetingChatMessages,
  getMeetingEnhancedNoteDraft,
  saveMeetingEnhancedNoteDraft,
  deleteMeetingEnhancedNoteDraft,
  type EnhancedMeetingNotesDraft,
  getRecording,
  getSummaryRegenerationUndo,
  undoSummaryRegeneration,
  importAudioFile,
  openRecordingAudio,
  renameRecording,
  updateRecordingAttendees,
  acknowledgeIncompleteTranscript,
  retranscribeRecording,
  retryMeetingAnalysis,
  cancelMeetingNotesWait,
  retryMeetingAutoName,
  revalidateRecordingAudio,
  setRecordingSourceType,
  updateMeetingChatMessages,
  updateRecordingAnalysis,
  updateRecordingNotes,
  queueMeetingNoteRecovery,
  listMeetingNoteRecovery,
  updateRecordingTemplate,
} from "@/lib/backend/recordings";
import { getMeetingActionCompletion, setMeetingActionCompleted, editMeetingAction, addMeetingAction, deleteMeetingAction, mergeMeetingActionFields } from "@/lib/backend/meeting-actions";
import { exportRecordingV2, openExportPath } from "@/lib/backend/exports";
import {
  getDiarizationModelPlan,
  isDiarizationModelAvailable,
  rejectSpeakerVoice,
  rememberSpeakerVoice,
  renameSpeaker,
  runDiarization,
  suggestSpeakerVoices,
  type DiarizationModelPlan,
} from "@/lib/backend/asr";
import { SpeakerModelDownloadNote } from "@/components/meetings/speaker-model-download-note";
import { resolveMeetingsSettings } from "@/lib/settings-sections";
import { speakTextAloud, stopSpeakingText } from "@/lib/text-to-speech";
import type {
  CompanyMemoryProfile,
  MeetingChatMessage,
  PersonMemoryProfile,
  RelationshipMemory,
} from "@/lib/backend/ai";
import type {
  MeetingTranscriptDetails,
  Recording,
  RecordingAnalysisFailedEvent,
  RecordingAnalysisProgressEvent,
} from "@/types";
import {
  buildMeetingTemplateOutline,
  getAllMeetingTemplateOptions,
  getMeetingTemplateOption,
  MAX_CUSTOM_MEETING_TEMPLATES,
  MEETING_TEMPLATES,
  type CustomMeetingTemplate,
} from "@/lib/meeting-templates";
import { getSettings, updateSettings } from "@/lib/backend/settings";
import {
  MeetingTemplateEditorDialog,
  type MeetingTemplateDraft,
} from "@/components/views/meetings/template-editor-dialog";
import { MeetingTemplateManagerDialog } from "@/components/views/meetings/template-manager-dialog";
import {
  GENERAL_MEETING_NOTES_TITLE,
  getNextMeetingSectionTitle,
  parseMeetingNoteSections,
  rebaseMeetingNotes,
  serializeMeetingNoteSections,
  type MeetingNoteSection,
} from "@/lib/meeting-notes";
import {
  describeMeetingConsent,
  MEETING_CONSENT_NOTICE_TEXT,
} from "@/lib/meeting-consent";
import {
  appendTranscriptStreamLine,
  describeAudioSourceWarning,
  describeTranscriptDelay,
  describeTranscriptGap,
  MEETING_AUDIO_SOURCE_WARNING_EVENT,
  RECORDING_TRANSCRIPTION_STREAM_EVENT,
  type AudioSourceWarningDescriptor,
  type MeetingAudioSourceWarningEvent,
  type RecordingTranscriptionStreamEvent,
  type TranscriptStreamLine,
} from "@/lib/meeting-transcript-stream";
import { plainMeetingProcessingMessage } from "@/lib/meeting-ui-message";
import {
  consumePendingRecordingWorkspace,
  consumePendingMeetingStartRequest,
  MEETING_START_REQUEST_EVENT,
  registerViewLeaveGuard,
  OPEN_RECORDING_WORKSPACE_EVENT,
  requestMainView,
  requestReadinessDestination,
  requestSettingsTab,
  type OpenRecordingWorkspaceDetail,
} from "@/lib/navigation";
import {
  describeMeetingStartFailure,
  stripTransportPrefix,
  type MeetingStartFailure,
} from "@/lib/meeting-start-error";
import { openPermissionSettings } from "@/lib/backend/settings";
import {
  describeMeetingAnalysis,
  MEETING_ANALYSIS_STATUS_EVENT,
  parseMeetingAnalysisStatus,
  readStoredAnalysisFailure,
  type MeetingAnalysisStatusEvent,
} from "@/lib/meeting-analysis-status";
import { StatusBanner } from "@/components/ui/status-banner";
import { CalendarMeetingCue } from "@/components/meetings/calendar-meeting-cue";
import { MeetingAttendees } from "@/components/meetings/meeting-attendees";
import { attendeeNameSuggestions, type MeetingAttendee } from "@/lib/attendees";
import { DetectedCallCue } from "@/components/meetings/detected-call-cue";
import { matchActionItemOccurrences } from "@/lib/meeting-action-occurrences";
import { calendarJoinServiceLabel, storedVideoServiceLabel } from "@/lib/calendar-events";
import { buildDetectedCallCapturePrefill } from "@/lib/detected-call";
import {
  meetingCapturePrefillFromCalendarEvent,
  meetingCapturePrefillFromDetectedCall,
  type MeetingCapturePrefill,
} from "@/lib/meeting-capture-prefill";
import { subscribeCallCaptureRequests } from "@/lib/call-capture-request";
import {
  canRecheckMeetingAudio,
  describeAnalysisSourceReview,
  describeCaptureDegradation,
  describeIncompleteTranscript,
  readMeetingIntegrity,
} from "@/lib/meeting-recovery";
import { actionItemsToMarkdownList } from "@/lib/markdown";
import { ActionItemList } from "@/components/views/meetings/action-item-list";
import { DocumentField } from "@/components/views/meetings/document-field";
import { AudioIssueBanner } from "@/components/views/meetings/audio-issue-banner";
import { EditableTitle, type EditableTitleHandle } from "@/components/views/meetings/editable-title";
import { MarkdownText } from "@/components/views/meetings/markdown-text";
import { WorkspaceSkeleton } from "@/components/views/meetings/workspace-skeleton";
import { listen } from "@/lib/electron";
import { useProductReadinessStatus } from "@/features/readiness/product-readiness-context";
import {
  meetingCaptureIsReady,
  selectReadinessForSurface,
} from "@/features/readiness/product-readiness";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Edit3,
  ExternalLink,
  FileAudio,
  FileOutput,
  FileText,
  FolderOpen,
  HelpCircle,
  MessageSquare,
  Loader2,
  Mic2,
  MoreHorizontal,
  Pause,
  Plus,
  Play,
  RefreshCw,
  Search,
  Square,
  Trash2,
  Users,
  Volume2,
  Quote,
} from "lucide-react";
import type { AnalysisTemplate } from "@/types";
import type { AsrProviderType, LlmCitation, SearchHit } from "@/types";
import { MEETING_CAPTURE_MODE_IMPORTED } from "@/types";
import { formatDate, formatDateTime } from "@/lib/format-locale";
import { useSettledReveal } from "@/components/views/meetings/use-settled-reveal";

const MEETING_ASK_TEMPLATES: AnalysisTemplate[] = [
  {
    id: "summary",
    name: "Rewrite summary",
    icon: "file-text",
    query: "Using the meeting transcript and saved meeting notes, write a crisp summary with outcomes, open questions, and next steps.",
    description: "Outcomes, open questions, next steps",
  },
  {
    id: "actions",
    name: "Action items",
    icon: "check-square",
    query: "Using the meeting transcript and saved meeting notes, extract clear action items with owners when they are stated.",
    description: "Follow-ups, with owners where they were named",
  },
  {
    id: "decisions",
    name: "Decisions",
    icon: "lightbulb",
    query: "List the decisions, agreements, and commitments made in this meeting, using the saved meeting notes to clarify context.",
    description: "What was agreed and committed to",
  },
  {
    id: "dates",
    name: "Deadlines",
    icon: "calendar",
    query: "Extract all deadlines, dates, and time-sensitive follow-ups from this meeting and the saved notes.",
    description: "Dates and anything time-sensitive",
  },
  {
    id: "follow_up",
    name: "Follow-up draft",
    icon: "file-text",
    query:
      "Using the meeting transcript and saved meeting notes, draft a concise professional follow-up email or message. Keep decisions, owners, next steps, and deadlines clear. Return only the final follow-up draft.",
    description: "A message you can send after the meeting",
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

/** The quoted source of a generated action item; a user's own item has none. */
function generatedEvidence(provenance: ActionItemProvenance | undefined): string | null {
  return provenance && provenance.generated !== false ? provenance.evidence ?? null : null;
}

function generatedUnclear(provenance: ActionItemProvenance | undefined): boolean {
  return provenance?.generated !== false && provenance?.unclear === true;
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

type MeetingNotesSaveStatus = {
  recordingId: string;
  surface: "live" | "review";
  revision: number;
  state: "saving" | "saved" | "error";
};

function MeetingNotesSaveIndicator({
  status,
  onRetry,
}: {
  status: MeetingNotesSaveStatus | null;
  onRetry(): void;
}) {
  if (!status) {
    return null;
  }

  if (status.state === "error") {
    return (
      <div
        className="flex items-center gap-1 text-sm text-rust"
        role="status"
        aria-live="polite"
      >
        <span>Not saved —</span>{" "}
        <button
          type="button"
          className="font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
      {status.state === "saving" ? "Saving…" : "Saved just now"}
    </p>
  );
}

/**
 * Which hand set a recap field down. Current analysis stores verified
 * provenance; legacy text without it keeps an explicit unrecorded state rather
 * than being handed to either the user or the model.
 */
type RecapAuthorship = "plainsong" | "user" | "unrecorded";
type MeetingSearchStatus =
  | "all"
  | "completed"
  | "recording"
  | "processing"
  | "error";

/**
 * Two hands, three treatments: machine-set text sits in the quieter ink behind
 * a bronze rule, the user's own keeps full ink and no rule, and text with no
 * recorded author gets a neutral rule and neither claim.
 */
const RECAP_AUTHORSHIP_TREATMENT: Record<RecapAuthorship, string> = {
  plainsong: "border-l-2 border-l-gold-ambient/60 text-muted-foreground",
  user: "text-foreground",
  unrecorded: "border-l-2 border-l-border text-foreground/70",
};

// The button under these captions is labelled "Regenerate". The only "Refresh"
// on this page belongs to the transcript rail and does something else.
const SUMMARY_AUTHORSHIP_CAPTION: Record<RecapAuthorship, string> = {
  plainsong: "Lines quoted from the transcript and your notes, picked by Plainsong.",
  user: "Your text. Regenerate to replace it with lines quoted from the transcript.",
  unrecorded:
    "Nothing stored says whether you or Plainsong wrote this. Regenerate to replace it with lines quoted from the transcript.",
};

const ACTION_ITEMS_AUTHORSHIP_CAPTION: Record<RecapAuthorship, string> = {
  plainsong: "Quoted from the transcript and your notes, picked by Plainsong.",
  user: "Your text. Regenerate to have Plainsong pull them from the transcript.",
  unrecorded:
    "Nothing stored says whether you or Plainsong wrote these. Regenerate to have Plainsong pull them from the transcript.",
};

function formatCitationTimeRange(citation: LlmCitation): string | null {
  if (
    typeof citation.startTime !== "number" &&
    typeof citation.endTime !== "number"
  ) {
    return null;
  }

  const formatSeconds = (value?: number) => {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return null;
    }
    const totalSeconds = Math.max(0, Math.floor(value));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const start = formatSeconds(citation.startTime);
  const end = formatSeconds(citation.endTime);
  if (start && end) {
    return `${start}-${end}`;
  }
  return start ?? end;
}

function isVerifiedMeetingNoteCitation(citation: LlmCitation, recording: Recording | null | undefined): boolean {
  return isCurrentWrittenNoteCitation(citation, recording?.id, recording?.meetingNotes);
}

function citationSourceLabel(citation: LlmCitation): string {
  if (citation.sourceKind === "meeting_note") {
    return "Written note";
  }
  if (citation.sourceKind == null || citation.sourceKind === "transcript") {
    return formatCitationTimeRange(citation) ?? "No timestamp";
  }
  return "Unverified citation";
}

function UnverifiedSummaryStatements({ statements }: { statements: UnverifiedStatement[] }) {
  const inventedNames = statements.filter((entry) => entry.kind === undefined || entry.kind === "invented_name");
  const unsupported = statements.filter((entry) => entry.kind === "unsupported" || entry.kind === "unknown_fact");
  return (
    <div className="mt-2 space-y-1.5" data-testid="unverified-summary-statements">
      {inventedNames.length > 0 ? (
        <>
          <p className="text-sm text-rust">These names do not appear anywhere in this meeting:</p>
          <ul className="space-y-1.5">
            {inventedNames.map((entry, index) => (
              <li key={`unverified-name-${index}`} className="border-l-2 border-gold-ambient/50 pl-3 text-sm">
                <span className="manuscript">{entry.statement}</span>
                <span className="block text-muted-foreground">
                  {entry.unknownNames.map((name) => `"${name}"`).join(", ")}
                </span>
                {entry.unknownFacts?.length ? <span className="block text-muted-foreground">Not found in the transcript: {entry.unknownFacts.join(", ")}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {unsupported.length > 0 ? (
        <>
          <p className="text-sm text-rust">
            {unsupported.length === 1 ? "Check this against the transcript:" : "Check these against the transcript:"}
          </p>
          <ul className="space-y-1.5">
            {unsupported.map((entry, index) => (
              <li key={`unsupported-${index}`} className="border-l-2 border-gold-ambient/50 pl-3 text-sm">
                <span className="manuscript">{entry.statement}</span>
                {entry.unknownFacts?.length ? <span className="block text-muted-foreground">Not found in the transcript: {entry.unknownFacts.join(", ")}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function hasCurrentGroundingPolicy(provenance: { groundingPolicyVersion?: number | null } | null | undefined): boolean {
  return provenance?.groundingPolicyVersion === SUMMARY_GROUNDING_POLICY_VERSION;
}

function hasTranscriptCitationDestination(citation: LlmCitation, recording: Recording | null | undefined): boolean {
  if (!recording || (citation.sourceKind != null && citation.sourceKind !== "transcript")
    || citation.recordingId !== recording.id || typeof citation.startTime !== "number"
    || !Number.isFinite(citation.startTime) || citation.startTime < 0) return false;
  if (citation.endTime != null && (!Number.isFinite(citation.endTime) || citation.endTime < citation.startTime)) return false;
  return !Number.isFinite(recording.duration) || recording.duration <= 0
    || (citation.startTime <= recording.duration && (citation.endTime == null || citation.endTime <= recording.duration));
}

function hasCurrentCitationSource(citation: LlmCitation, recording: Recording | null): boolean {
  return citation.sourceKind === "meeting_note"
    ? isVerifiedMeetingNoteCitation(citation, recording)
    : hasTranscriptCitationDestination(citation, recording);
}

function RecapCitation({
  citation,
  grounded,
  recording,
  onJumpToTranscript,
  onOpenWrittenNotes,
  currentNotes,
}: {
  citation: LlmCitation;
  grounded: boolean;
  recording: Recording | null | undefined;
  onJumpToTranscript: (citation: LlmCitation) => void;
  onOpenWrittenNotes: (citation: LlmCitation) => void;
  currentNotes: string;
}) {
  const isMeetingNote = citation.sourceKind === "meeting_note";
  const isKnownTranscript = citation.sourceKind == null || citation.sourceKind === "transcript";
  const noteVerified = isMeetingNote && grounded && isVerifiedMeetingNoteCitation(citation, recording)
    && isCurrentWrittenNoteCitation(citation, recording?.id, currentNotes);
  const canOpenTranscript = hasTranscriptCitationDestination(citation, recording);
  const sourceLabel = isMeetingNote
    ? noteVerified
      ? "Written note"
      : "Written note · Unverified"
    : isKnownTranscript && (!grounded || !canOpenTranscript)
      ? `${citationSourceLabel(citation)} · Unverified`
      : citationSourceLabel(citation);
  const contents = (
    <>
      <span className="flex items-baseline gap-2">
        <Quote
          className="h-3.5 w-3.5 shrink-0 translate-y-0.5 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="rubric-muted time-spec shrink-0">{sourceLabel}</span>
      </span>
      <span className="manuscript mt-1 block text-sm">{citation.text}</span>
    </>
  );

  if (!isKnownTranscript && !noteVerified) {
    return (
      <div
        className="rounded-md border border-border/70 bg-background/70 px-3 py-2.5 text-left"
        aria-disabled={!noteVerified}
      >
        {contents}
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={isMeetingNote ? !noteVerified : !canOpenTranscript}
      title={isMeetingNote ? "Open written notes" : undefined}
      className="rounded-md border border-border/70 bg-background/70 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 disabled:cursor-default disabled:hover:bg-background/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => isMeetingNote ? onOpenWrittenNotes(citation) : onJumpToTranscript(citation)}
    >
      {contents}
    </button>
  );
}

function buildEnhancedMeetingNotesDraftText(args: {
  summary: string;
  actionItems: string[];
  rawNotes: string;
}): string {
  // Headings the note parser did not invent get the explicit markdown marker so
  // an applied draft still reads back as three sections.
  const sections = [
    args.summary.trim() ? `## Summary\n${args.summary.trim()}` : null,
    args.actionItems.length > 0
      ? `## Action Items\n${args.actionItems.map((item) => `- ${item}`).join("\n")}`
      : null,
    args.rawNotes.trim() ? `## Raw Notes Context\n${args.rawNotes.trim()}` : null,
  ].filter(Boolean);

  return sections.join("\n\n").trim();
}

// A name Plainsong cannot classify is never called "local". The list itself
// lives in asr-capabilities so it is checked against `AsrProviderType` at
// compile time -- this file used to keep its own copy, which is how it went on
// recognising `mlx_audio` and `voxtral` after both engines were deleted.
const CLOUD_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  elevenlabs_scribe: "ElevenLabs Scribe",
  openai_cloud: "OpenAI",
  groq: "Groq",
  cohere_transcribe: "Cohere",
  deepgram: "Deepgram Nova",
  mistral_voxtral: "Mistral Voxtral",
  gemini_transcribe: "Gemini Transcribe",
  xai_stt: "xAI Grok",
};

/**
 * What the transcript badge is allowed to claim. Derived from the provider the
 * backend says actually ran — never defaulted to "local", because a cloud
 * provider named in the panel above and a gold "Local transcript" badge below
 * it cannot both be true.
 */
function describeTranscriptProvenance(
  provider: string | null | undefined
): TranscriptProvenance {
  if (!isKnownAsrProvider(provider)) {
    return { source: "unknown" };
  }

  const providerType = provider.trim() as AsrProviderType;
  if (providerType === "macos_apple_speech") {
    return { source: "apple_on_device" };
  }
  if (providerHostingPreference(providerType) === "cloud" || isCloudProvider(providerType)) {
    return {
      source: "cloud",
      provider: CLOUD_PROVIDER_DISPLAY_NAMES[providerType] ?? providerType,
    };
  }
  return { source: "local" };
}

function formatSourceMode(details: MeetingTranscriptDetails | null): string {
  switch (details?.sourceMode) {
    case "me_them":
      return "Me + Them";
    case "speaker_labels":
      return "Speaker labels";
    case "single_source":
      return "Single track";
    default:
      return "Unknown";
  }
}

function formatCaptureMode(systemAudio: boolean): string {
  return systemAudio ? "Me + Them" : "Mic only";
}

// The verbatim transcript only travels when the caller asks for it. A recap
// pasted into a chat window must not carry the whole meeting with it.
function buildMeetingShareMarkdown(args: {
  recording: Recording;
  summary: string;
  actionItems: string[];
  notes: string;
  transcript: string;
  captureMode: string;
  consentLabel: string;
  templateLabel: string;
  includeTranscript: boolean;
  reviewWarning?: string;
  completedTasks?: ReadonlySet<string>;
}): string {
  // The service line only appears when the meeting actually began from
  // something that named one — a calendar event or a detected call.
  const serviceLabel = storedVideoServiceLabel(args.recording.videoService);
  const sections = [
    `# ${args.recording.title}`,
    `- Date: ${formatDateTime(args.recording.createdAt)}`,
    ...(serviceLabel ? [`- Service: ${serviceLabel}`] : []),
    `- Capture mode: ${args.captureMode}`,
    `- Template: ${args.templateLabel}`,
    `- Consent: ${args.consentLabel}`,
    ...(args.reviewWarning ? [`> ${args.reviewWarning}`] : []),
  ];

  const body = [
    args.summary.trim() ? `## Summary\n${args.summary.trim()}` : null,
    args.actionItems.length > 0
      ? `## Action Items\n${args.actionItems.map((item) => `- ${args.completedTasks ? `[${args.completedTasks.has(item) ? "x" : " "}] ` : ""}${item}`).join("\n")}`
      : null,
    args.notes.trim() ? `## Notes\n${args.notes.trim()}` : null,
    args.includeTranscript && args.transcript.trim()
      ? `## Transcript\n${args.transcript.trim()}`
      : null,
  ].filter(Boolean);

  return [...sections, ...body].join("\n\n").trim();
}

/** Longer than this, a microphone-only capture is taken to be a real meeting. */
const MISFILED_DICTATION_MAX_SECONDS = 120;

/**
 * A row that reads like a dictation filed as a meeting: a short capture from
 * the microphone alone, recorded here rather than imported, with no one
 * listed as attending. These are the only signals the record carries and none
 * of them is proof, so the list offers the move and never makes it.
 */
function looksLikeMisfiledDictation(recording: Recording): boolean {
  if (recording.status === "recording" || recording.status === "processing") return false;
  if (recording.metadata?.systemAudio) return false;
  if (
    recording.meetingCaptureMode === "me_and_them" ||
    recording.meetingCaptureMode === MEETING_CAPTURE_MODE_IMPORTED ||
    recording.importedSourceName
  ) {
    return false;
  }
  if ((recording.attendees?.length ?? 0) > 0) return false;
  return recording.duration > 0 && recording.duration < MISFILED_DICTATION_MAX_SECONDS;
}

function resolveRecordingCaptureMode(
  recording: Recording | null,
  details: MeetingTranscriptDetails | null,
  fallbackSystemAudio = false
): string {
  // An imported file has no microphone side and no system side, so this is
  // checked before the transcript's source mode: "Single track" would be
  // technically true and completely uninformative.
  if (recording?.meetingCaptureMode === MEETING_CAPTURE_MODE_IMPORTED) {
    return "Imported file";
  }

  const sourceMode = formatSourceMode(details);
  if (sourceMode !== "Unknown") {
    return sourceMode;
  }

  if (recording?.meetingCaptureMode === "me_and_them") {
    return "Me + Them";
  }

  if (recording?.meetingCaptureMode === "mic_only") {
    return "Mic only";
  }

  if (recording?.metadata?.systemAudio != null) {
    return formatCaptureMode(Boolean(recording.metadata.systemAudio));
  }

  return formatCaptureMode(fallbackSystemAudio);
}

// A 1.5px left band that encodes meeting state by gold/rust/neutral — never a
// stoplight hue. Gold = ready/done, rust = needs-attention, bronze ambient =
// processing, muted hairline = draft/unknown. The earned burnished gold is held
// for the live row, so a completed row carries the quieter ambient bronze band.
function recordingStatusBand(
  status: Recording["status"] | undefined,
  isLive: boolean
): { band: string; word: string } {
  if (isLive) {
    return { band: "border-l-gold", word: "Live" };
  }
  switch (status) {
    case "completed":
      return { band: "border-l-gold-ambient", word: "Ready" };
    case "error":
      return { band: "border-l-rust", word: "Failed" };
    case "pending":
      return { band: "border-l-gold-ambient/60", word: "Pending" };
    case "processing":
      return { band: "border-l-gold-ambient/60", word: "Processing" };
    case "recording":
      return { band: "border-l-gold", word: "Recording" };
    default:
      return { band: "border-l-border", word: "Draft" };
  }
}

function describeMeetingAssetRetention(recording: Recording | null): {
  audioLabel: string;
  detail: string;
  deleteWarning: string;
  /**
   * What the reader can actually do after cutting transcript text. Only claimed
   * when the audio really is still attached — with no audio there is no way
   * back, and saying otherwise would be a promise the app cannot keep.
   */
  transcriptRecoveryNote?: string;
} {
  if (recording?.audioPath) {
    return {
      audioLabel: "Audio saved",
      detail:
        "The audio file is still here and can be played. Transcript, notes, summary, and action items stay with this meeting.",
      deleteWarning:
        "The transcript, your notes, the summary, the action items, and the saved audio file all go with it.",
      transcriptRecoveryNote:
        "The audio for this meeting is still saved, so “Re-transcribe from audio” in the meeting menu can produce the whole transcript again.",
    };
  }

  return {
    audioLabel: "No audio",
    detail:
      "The audio was never saved, or has already been deleted. Transcript, notes, summary, and action items stay here until this meeting is deleted.",
    deleteWarning:
      "The transcript, your notes, the summary, and the action items all go with it. There is no audio file to lose.",
  };
}

/**
 * Re-transcribing is the only way back from a transcript edit or deletion that
 * went too far, so it is offered for any meeting whose audio is still on disk —
 * not only for the ones that failed. The sidecar refuses while a pipeline is
 * running, so those states are not offered here either.
 */
function canRetranscribeRecording(recording: Recording | null): boolean {
  if (!recording?.audioPath) {
    return false;
  }
  return recording.status !== "recording" && recording.status !== "processing";
}

function canDeleteRecording(recording: Recording | null): boolean {
  return Boolean(
    recording && recording.status !== "recording" && recording.status !== "processing"
  );
}

function deleteRecordingActionLabel(recording: Recording | null): string {
  if (recording?.status === "recording") {
    return "Delete (stop recording first)";
  }
  if (recording?.status === "processing") {
    return "Delete (wait for processing)";
  }
  return "Delete";
}

function qualityToneClasses(tone: "good" | "warn" | "muted"): string {
  switch (tone) {
    case "good":
      return "border-gold/30 bg-gold/10 text-gold-text";
    case "warn":
      return "border-rust/30 bg-rust/10 text-rust";
    default:
      return "border-border bg-muted/40 text-muted-foreground";
  }
}

/**
 * Meeting exports from this view are not offered a redaction choice, so the
 * level is fixed and stated. Exports is where the other levels live.
 */
const MEETING_EXPORT_REDACTION_LEVEL = "basic" as const;
// Names the level, not just its effect. Exports offers None / Basic / Strict by
// name, so describing the behaviour without saying "Basic" left the reader to
// map a sentence onto a picker label. Say both: what it does, and which option
// that is.
const MEETING_EXPORT_REDACTION_NOTE =
  "Files exported here use Basic redaction: email addresses and phone numbers are replaced, and nothing else. Choose None or Strict in the Exports view.";

function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, seconds);
  const mins = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * One line of the delayed preview.
 *
 * A `gap` line is not transcript — it is the app admitting a span of the
 * meeting was overwritten before it could be read — so it gets the "missing"
 * vocabulary (rust, hollow neume) rather than being set as if it were speech.
 */
function TranscriptStreamLineRow({ line }: { line: TranscriptStreamLine }) {
  if (line.kind === "gap") {
    return (
      <p className="flex items-start gap-2 text-sm leading-relaxed text-rust">
        <span className="time-spec mt-1.5 font-mono text-xs text-rust/70">
          {formatDuration(Math.floor(line.startTime))}
        </span>
        <span
          className="neume neume-hollow mt-2 shrink-0"
          aria-hidden="true"
        />
        <span>{describeTranscriptGap(line)}</span>
      </p>
    );
  }

  return (
    <p className="manuscript text-sm leading-relaxed">
      <span className="time-spec mr-2 font-mono text-xs text-muted-foreground">
        {formatDuration(Math.floor(line.startTime))}
      </span>
      {line.text}
    </p>
  );
}

function normalizePrepSearchTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function relationshipPrepScore(
  profile: PersonMemoryProfile | CompanyMemoryProfile,
  haystack: string,
  tokens: string[]
): number {
  const name = profile.name.toLowerCase();
  let score = haystack.includes(name) ? 5 : 0;
  for (const token of tokens) {
    if (name.includes(token)) {
      score += 1;
    }
  }
  score += Math.min(profile.recordingCount, 3);
  return score;
}

function prepPromptsForTemplate(templateId: string): string[] {
  switch (templateId) {
    case "sales":
      return [
        "What changed since the last conversation?",
        "Where are the buying signals and objections?",
        "What next step do I want before the call ends?",
      ];
    case "1on1":
      return [
        "What feedback or support should I be ready to give?",
        "What commitments do I need to follow up on?",
        "What changed since the last 1:1?",
      ];
    case "interview":
      return [
        "Which signals am I trying to confirm?",
        "What gaps or concerns need evidence?",
        "What should I compare against the scorecard afterward?",
      ];
    case "brainstorm":
      return [
        "What decision should this session unlock?",
        "Which ideas need evidence instead of more debate?",
        "What experiments would make the best next step?",
      ];
    case "doctor":
      return [
        "What symptoms, dates, and changes do I need to mention clearly?",
        "What decisions or prescriptions do I need written down?",
        "What tests, referrals, or follow-up dates should I confirm?",
      ];
    case "legal":
      return [
        "What facts, dates, and documents matter most?",
        "What deadlines or risk tradeoffs do I need clarified?",
        "What follow-up tasks should I leave with?",
      ];
    case "research":
      return [
        "What hypotheses am I trying to validate?",
        "What surprised users before, and what do I still not understand?",
        "What should I synthesize immediately after the call?",
      ];
    case "personal_admin":
      return [
        "What decisions or paperwork need to be completed today?",
        "What dates, references, or case numbers should I capture exactly?",
        "What follow-up reminder should I set right after this?",
      ];
    default:
      return [
        "What outcome do I want from this meeting?",
        "What commitments or blockers should I confirm live?",
        "What follow-up should be ready as soon as the meeting ends?",
      ];
  }
}

function buildDeterministicFollowUpDraft(
  title: string,
  summary: string,
  actionItems: string[]
): string {
  const trimmedSummary = summary.trim();
  const normalizedItems = normalizeActionItems(actionItems);
  return [
    `Subject: Follow-up on ${title}`,
    "",
    "Thanks again for the conversation.",
    "",
    trimmedSummary || "Here is a quick recap of what we covered.",
    "",
    normalizedItems.length > 0
      ? ["Next steps:", ...normalizedItems.map((item) => `- ${item}`)].join("\n")
      : "Next steps:\n- Confirm owners and timing.",
  ].join("\n");
}

function buildDeterministicAgenda(title: string, actionItems: string[]): string {
  const normalizedItems = normalizeActionItems(actionItems);
  return [
    `Next agenda for ${title}`,
    "",
    ...(normalizedItems.length > 0
      ? normalizedItems.map((item) => `- Review: ${item}`)
      : ["- Review outstanding decisions", "- Confirm ownership and dates", "- Close open blockers"]),
  ].join("\n");
}

function buildCrossMeetingRecallQuery(args: {
  title: string;
  summary: string;
  actionItems: string[];
  prompt: string;
}): string {
  const sections = [
    "You are helping a solo user prepare for follow-through across prior meetings.",
    `Current meeting: ${args.title}`,
    args.summary.trim() ? `Current summary: ${args.summary.trim()}` : null,
    args.actionItems.length > 0
      ? `Current action items:\n${args.actionItems.map((item) => `- ${item}`).join("\n")}`
      : null,
    `Question: ${args.prompt.trim()}`,
    "Answer using prior meetings as the source of truth. Focus on recurring priorities, commitments, blockers, and deadlines.",
  ].filter(Boolean);

  return sections.join("\n\n");
}

function buildMeetingReadyState(args: {
  summary: string;
  actionItems: string[];
  notes: string;
  transcriptSegments: number;
  status: Recording["status"] | undefined;
  isLive: boolean;
  summaryGrounded?: boolean;
  actionItemsGrounded?: boolean;
}): { label: string; tone: "good" | "warn" | "muted"; detail: string } {
  // Status comes first: a failed or still-processing meeting cannot be
  // described by what its notes contain, and a week-old failure must never
  // report "Capture in progress".
  if (args.status === "error") {
    return {
      label: "Transcription failed",
      tone: "warn",
      detail:
        "This meeting has no transcript. Retry transcription from the meeting menu before you rely on a summary.",
    };
  }
  if (args.status === "pending") {
    return {
      label: "Transcription pending",
      tone: "muted",
      detail: "The recording is saved. Free some memory, then retry transcription.",
    };
  }
  if (args.status === "processing") {
    return {
      label: "Transcribing",
      tone: "muted",
      detail: "Transcript lines are still arriving. Keep typing notes in the meantime.",
    };
  }
  if (args.isLive || args.status === "recording") {
    return {
      label: "Recording",
      tone: "muted",
      detail: "Keep typing notes while the meeting runs.",
    };
  }
  const summaryNeedsReview = Boolean(args.summary.trim()) && args.summaryGrounded === false;
  const actionsNeedReview = args.actionItems.length > 0 && args.actionItemsGrounded === false;
  if (summaryNeedsReview || actionsNeedReview) {
    const content = summaryNeedsReview && actionsNeedReview
      ? "summary and action items"
      : summaryNeedsReview ? "summary" : "action items";
    return {
      label: "Needs review",
      tone: "warn",
      detail: `Check the ${content} against the quoted sources before sharing.`,
    };
  }
  if (args.summary.trim() && args.actionItems.length > 0) {
    // Source checks can pass while a recap still changes meaning or repeats facts.
    // Report generation here; the quoted sources remain available for review.
    return {
      label: "Recap ready",
      tone: "muted",
      detail: "Key lines and next steps are quoted from the transcript. Check them before sharing.",
    };
  }
  if (args.summary.trim()) {
    return {
      label: "Summary written",
      tone: "good",
      detail: "The summary is written. No action items are listed.",
    };
  }
  if (args.actionItems.length > 0) {
    return {
      label: "Actions written",
      tone: "muted",
      detail: "Action items are listed. No summary is written.",
    };
  }
  if (args.notes.trim() && args.transcriptSegments > 0) {
    return {
      label: "Ready to summarize",
      tone: "warn",
      detail:
        "There are enough notes and transcript here for Plainsong to write the summary and action items.",
    };
  }
  if (args.transcriptSegments > 0) {
    return {
      label: "Transcript only",
      tone: "muted",
      detail: "Add notes, or regenerate the summary and action items below.",
    };
  }
  if (args.notes.trim()) {
    return {
      label: "Notes only",
      tone: "muted",
      detail: "Your notes are available below. This meeting has no transcript yet.",
    };
  }
  return {
    label: "Empty",
    tone: "muted",
    detail: "This meeting has no transcript, notes, or summary yet.",
  };
}

/** Which part of the record a regeneration is about to overwrite. */
type RegenerateScope = "summary" | "actions";

const REGENERATE_SCOPE_LABEL: Record<RegenerateScope, string> = {
  summary: "the summary",
  actions: "the action items",
};

/**
 * Regeneration replaces text in place, so it has to say what it is about to
 * throw away. Text with matching persisted Plainsong provenance is safe to
 * replace silently; anything else is either the reader's own or has no
 * recorded author, and both deserve the question first.
 */
function describeRegenerateClobber(args: {
  scope: RegenerateScope;
  summary: string;
  actionItemsText: string;
  summaryAuthorship: RecapAuthorship;
  actionItemsAuthorship: RecapAuthorship;
  /**
   * Visible action items with no citation recorded this session. The list is
   * the one field where the two hands mix line by line, so the overall
   * authorship cannot decide this: four extracted items plus one the reader
   * typed still reads as "plainsong", and regenerating would take the fifth
   * away without asking. Counting the unattributed lines is the honest test.
   */
  unattributedActionItems: number;
}): string | null {
  const touchesSummary = args.scope === "summary";
  const touchesActions = args.scope === "actions";
  const atRisk: string[] = [];

  if (touchesSummary && args.summary.trim() && args.summaryAuthorship !== "plainsong") {
    atRisk.push(
      args.summaryAuthorship === "user"
        ? "the summary you wrote"
        : "the stored summary, which has no recorded author"
    );
  }
  if (touchesActions && args.actionItemsText.trim() && args.unattributedActionItems > 0) {
    atRisk.push(
      args.actionItemsAuthorship === "user"
        ? "the action items you wrote"
        : args.actionItemsAuthorship === "unrecorded"
          ? "the stored action items, which have no recorded author"
          : `${args.unattributedActionItems} action item${
              args.unattributedActionItems === 1 ? "" : "s"
            } Plainsong did not write`
    );
  }

  if (atRisk.length === 0) {
    return null;
  }

  return `Regenerating ${REGENERATE_SCOPE_LABEL[args.scope]} replaces ${atRisk.join(
    " and "
  )}. ${args.scope === "summary" ? "The previous summary will be saved so you can undo this rewrite." : "Plainsong cannot bring the old text back."}`;
}

/**
 * Cross-meeting recall suggestions. The label is written for the button; it is
 * never derived by cutting the prompt apart, which produced buttons reading
 * "Dana cared about across recent meetings".
 */
function buildRelationshipRecallPrompts(args: {
  title: string;
  people: PersonMemoryProfile[];
  companies: CompanyMemoryProfile[];
}): Array<{ label: string; prompt: string }> {
  const prompts = [
    {
      label: "Open commitments",
      prompt: `What commitments and deadlines from prior meetings matter before the next ${args.title} follow-up?`,
    },
    ...args.people.slice(0, 2).map((person) => ({
      label: `Ask about ${person.name}`,
      prompt: `What has ${person.name} cared about across recent meetings? Include priorities, open questions, and what I owe them.`,
    })),
    ...args.companies.slice(0, 1).map((company) => ({
      label: `Ask about ${company.name}`,
      prompt: `What has ${company.name} pushed on across recent meetings? Include risks, asks, and deadlines.`,
    })),
  ];

  const seen = new Set<string>();
  return prompts.filter((entry) => {
    if (seen.has(entry.prompt)) {
      return false;
    }
    seen.add(entry.prompt);
    return true;
  });
}

/** Field-by-field, not `JSON.stringify` -- key order out of a round trip
 * through Rust's serde and a freshly-built renderer object isn't guaranteed
 * to match byte for byte even when the content is identical, and a
 * stringify comparison would misreport that as a truncation. Used to detect
 * when Rust's save-time sanitization (`sanitize_meeting_custom_templates` in
 * settings.rs) actually changed what was sent -- dropping it, or capping a
 * name/prompt/outline length -- so the optimistic save can be corrected
 * instead of reported as a clean success. */
function meetingTemplatesEqual(
  a: readonly CustomMeetingTemplate[],
  b: readonly CustomMeetingTemplate[]
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((template, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      template.id === other.id &&
      template.name === other.name &&
      template.summaryPrompt === other.summaryPrompt &&
      template.notesOutline.length === other.notesOutline.length &&
      template.notesOutline.every((section, sectionIndex) => section === other.notesOutline[sectionIndex])
    );
  });
}

type SectionUndoEntry = {
  kind: "remove" | "clear";
  recordingId: string;
  templateId: string;
  structureKey: string;
  section: MeetingNoteSection;
  index: number;
};

export function RecordingsView() {
  const { productReadiness, engineNotice, dismissEngineNotice } =
    useProductReadinessStatus();
  // Two readings of the same domain, and they are not interchangeable.
  // `meetingsReadiness` includes the AI-notes lane and is what the reader is
  // told; `meetingCaptureReadiness` is capture alone and is what every action
  // is gated on. Gating on the first disabled meeting capture on every fresh
  // install, because the default notes route points at an absent Ollama.
  const meetingsReadiness = selectReadinessForSurface(
    productReadiness,
    "meetings",
  );
  const meetingCaptureReadiness = productReadiness.meetingsCapture;
  const captureIsReady = meetingCaptureIsReady(productReadiness);
  const fullCaptureReadiness = productReadiness.fullCapture;
  const {
    recordings,
    isLoading: recordingsLoading,
    hasLoaded: recordingsHaveLoaded,
    error: recordingsError,
    refetch,
  } = useRecordings();
  const {
    startMeeting,
    stopMeeting,
    pauseMeeting,
    resumeMeeting,
    isRecording: isCaptureRecording,
    recordingMode = null,
    recordingId,
    meetingPhase = "idle",
    meetingMessage = null,
    meetingPaused = false,
    meetingMicrophoneInput = null,
    meetingMicrophoneWarningDismissed = false,
    // The clock is read only by the labels that show it (RecordingDurationText),
    // so this view does not re-render once a second during a meeting.
  } = useRecordingSession();
  const isDictating = isCaptureRecording && recordingMode === "dictation";
  const isRecording = isCaptureRecording && !isDictating;
  const captureConflictNotice = isCaptureRecording
    ? isDictating
      ? "Dictation is active. Finish it before starting a meeting."
      : "A meeting is already recording. Stop it before starting another."
    : null;
  const { toast } = useToast();
  const recordingStatusEventRevisionRef = useRef(new Map<string, number>());
  const [recordingStatusOverrides, setRecordingStatusOverrides] = useState<
    Record<string, Recording["status"]>
  >({});
  const [showConsent, setShowConsent] = useState(false);
  const meetingStartRevisionRef = useRef(0);
  const pendingMeetingStartRef = useRef<{
    revision: number;
    scopeGeneration: number;
  } | null>(null);
  const [isMeetingStartPending, setIsMeetingStartPending] = useState(false);
  // Set only by the calendar or detected-call affordance, consumed by the
  // start that follows it. A ref rather than state because nothing renders
  // from it: it is read once the reader answers the consent sheet, to give the
  // recording the event's (or the call's) name and service, and to tell the
  // sidecar which detected call this capture is the answer to.
  const pendingCalendarPrefill = useRef<MeetingCapturePrefill | null>(null);
  const [pausingMeeting, setPausingMeeting] = useState<{ recordingId: string; paused: boolean } | null>(null);
  const isTogglingPause = recordingId !== null && pausingMeeting?.recordingId === recordingId;
  const meetingPausePendingLabel = pausingMeeting?.paused ? "Pausing…" : "Resuming…";
  const pendingMeetingPausesRef = useRef(new Set<string>());
  const [meetingPauseError, setMeetingPauseError] = useState<{ recordingId: string; message: string } | null>(null);
  const [showRecordingDetail, setShowRecordingDetail] = useState(false);
  // Opening a meeting and coming back are navigations between two pages that
  // never coexist. Each page's h1 takes focus on arrival; otherwise focus is
  // left on <body> and a keyboard reader restarts from the top of the document.
  const meetingTitleRef = useRef<EditableTitleHandle>(null);
  const workspaceOpenRequestRef = useRef(0);
  const workspaceMountedRef = useRef(true);
  useEffect(() => {
    workspaceMountedRef.current = true;
    return () => { workspaceMountedRef.current = false; workspaceOpenRequestRef.current += 1; };
  }, []);
  const workspaceHeadingRef = useRef<HTMLHeadingElement>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusListAfterDeleteRef = useRef(false);
  const [dismissedLifecycleBanner, setDismissedLifecycleBanner] = useState<string | null>(null);
  const labelSpeakersButtonRef = useRef<HTMLButtonElement>(null);
  const [focusLabelSpeakers, setFocusLabelSpeakers] = useState(false);
  useEffect(() => {
    if (!focusLabelSpeakers || !labelSpeakersButtonRef.current) return;
    setFocusLabelSpeakers(false);
    labelSpeakersButtonRef.current.focus();
  });
  const listHeaderRef = useRef<HTMLDivElement>(null);
  const hasOpenedWorkspaceRef = useRef(false);
  const [meetingTab, setMeetingTab] = useState("record");
  // The record is a document first. Editing is an explicit act on one field at
  // a time, so the other field never turns into a text box behind your back.
  const [isEditingSummary, setIsEditingSummary] = useState(false);
  const [isEditingActionItems, setIsEditingActionItems] = useState(false);
  // A regeneration that would overwrite text Plainsong did not write this
  // session parks here until the reader says it may.
  const [pendingRegenerate, setPendingRegenerate] = useState<{
    scope: RegenerateScope;
    templateId: string | null;
    warning: string;
  } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [transcriptSourceNavigation, setTranscriptSourceNavigation] = useState<{ time: number; requestId: number; recordingId: string; segmentId?: string | null }>();
  const [showTranscriptHelp, setShowTranscriptHelp] = useState(false);
  const [transcriptMatches, setTranscriptMatches] = useState<TranscriptMatch[]>([]);
  const [activeTranscriptMatchIndex, setActiveTranscriptMatchIndex] = useState(0);
  // Where the reader is in the transcript. Set by a segment click, by keyboard
  // stepping, by a search hit, by a citation's "jump to source", and — while
  // the meeting's audio plays — by the playhead, a few times a second. Held
  // outside React state on purpose: as view state, every one of those playback
  // ticks re-rendered this whole view to move one highlight. Only the
  // transcript subscribes.
  const playhead = usePlayheadStore();
  // The in-app player, so a transcript click or a citation can seek the audio.
  const audioPlayerRef = useRef<AudioPlayerHandle | null>(null);
  const [meetingAsides, setMeetingAsides] = useState<MeetingAside[]>([]);
  const [asideRanges, setAsideRanges] = useState<Pick<MeetingAside, "startTime" | "endTime">[]>([]);
  const [asideLoadError, setAsideLoadError] = useState(false);
  // A deep link names both a query and the moment it was found at. The hits
  // only exist once the transcript has loaded, so the requested moment is
  // parked here and spent on the first report that actually has hits in it.
  const pendingMatchFocusTimeRef = useRef<number | null>(null);
  const [audioPlaybackIssue, setAudioPlaybackIssue] = useState<{
    recordingId: string;
    message: string;
  } | null>(null);
  const [isRunningDiarization, setIsRunningDiarization] = useState(false);
  const diarizationOperationRef = useRef<{
    recordingId: string;
    workspaceEpoch: number;
    token: symbol;
  } | null>(null);
  const [diarizationPendingRecordingId, setDiarizationPendingRecordingId] =
    useState<string | null>(null);
  const [diarizationMessage, setDiarizationMessage] = useState<{
    recordingId: string;
    text: string;
  } | null>(null);
  const [diarizationError, setDiarizationError] = useState<{
    recordingId: string;
    text: string;
  } | null>(null);
  // Which speaker model the next labelling run would use, or that none is on
  // this Mac. A meeting never downloads one by itself; when none is there,
  // the meeting offers the download instead of "Label the speakers".
  const [speakerModelPlan, setSpeakerModelPlan] = useState<DiarizationModelPlan | null>(null);
  const refreshSpeakerModelPlan = useCallback(async () => {
    try {
      const plan = await getDiarizationModelPlan();
      if (workspaceMountedRef.current) setSpeakerModelPlan(plan ?? null);
      return plan ?? null;
    } catch {
      // Unknown is not "missing": keep offering the run, which says why it
      // cannot start if it cannot.
      if (workspaceMountedRef.current) setSpeakerModelPlan(null);
      return null;
    }
  }, []);
  const [deletePublishedFile, setDeletePublishedFile] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<Recording | null>(null);
  useEffect(() => { setDeletePublishedFile(false); }, [showDeleteConfirm?.id]);
  const showDeleteConfirmRef = useRef(showDeleteConfirm);
  showDeleteConfirmRef.current = showDeleteConfirm;
  const deleteDialogEpochRef = useRef(0);
  const deletePendingRef = useRef(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const openDeleteConfirmation = (recording: Recording) => {
    if (deletePendingRef.current) return;
    ++deleteDialogEpochRef.current;
    setDeleteError(null);
    setShowDeleteConfirm(recording);
  };
  const closeDeleteConfirmation = () => {
    if (deletePendingRef.current) return;
    ++deleteDialogEpochRef.current;
    setDeleteError(null);
    setShowDeleteConfirm(null);
  };
  // Re-transcribing a meeting that already has a transcript overwrites it, so a
  // meeting that is not simply broken parks here until the reader agrees.
  const [pendingRetranscribe, setPendingRetranscribe] = useState<Recording | null>(null);
  const [showRenameDialog, setShowRenameDialog] = useState<Recording | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renamePendingEpoch, setRenamePendingEpoch] = useState<number | null>(null);
  const renamePendingRef = useRef(false);
  const renameDialogEpochRef = useRef(0);
  const renameMountedRef = useRef(true);
  useEffect(() => {
    renameMountedRef.current = true;
    return () => {
      renameMountedRef.current = false;
      ++renameDialogEpochRef.current;
    };
  }, []);
  const closeRenameDialog = () => {
    ++renameDialogEpochRef.current;
    setShowRenameDialog(null);
    setRenameValue("");
    setRenameError(null);
  };
  const [stoppingMeetingId, setStoppingMeetingId] = useState<string | null>(null);
  const isStopping = recordingId !== null && stoppingMeetingId === recordingId;
  const pendingMeetingStopsRef = useRef(new Set<string>());
  const liveMeetingScopeGenerationRef = useRef(0);
  const previousLiveMeetingIdentityRef = useRef({
    recordingId,
    isCaptureRecording,
    recordingMode,
  });
  const previousLiveMeetingIdentity = previousLiveMeetingIdentityRef.current;
  if (
    previousLiveMeetingIdentity.recordingId !== recordingId ||
    previousLiveMeetingIdentity.isCaptureRecording !== isCaptureRecording ||
    previousLiveMeetingIdentity.recordingMode !== recordingMode
  ) {
    liveMeetingScopeGenerationRef.current += 1;
    previousLiveMeetingIdentityRef.current = {
      recordingId,
      isCaptureRecording,
      recordingMode,
    };
  }
  const liveMeetingScopeRef = useRef({
    recordingId,
    isRecording,
    isCaptureRecording,
    recordingMode,
    meetingPaused,
    generation: liveMeetingScopeGenerationRef.current,
  });
  liveMeetingScopeRef.current = {
    recordingId,
    isRecording,
    isCaptureRecording,
    recordingMode,
    meetingPaused,
    generation: liveMeetingScopeGenerationRef.current,
  };
  const [meetingStopError, setMeetingStopError] = useState<{ recordingId: string; message: string } | null>(null);
  type FinalNoteDraft = { key: number; recoveryId: string; recordingId: string; notes: string; baseNotes: string; savedRef: { current: string }; saving: boolean; journaled: boolean };
  const [finalNoteDrafts, setFinalNoteDrafts] = useState<FinalNoteDraft[]>([]);
  const finalNoteDraftsRef = useRef<FinalNoteDraft[]>([]);
  const finalNoteRevisionRef = useRef(0);
  const finalNoteSavesRef = useRef(new Map<number, Promise<boolean>>());
  const recentFinalNoteSnapshotRef = useRef<{
    recordingId: string;
    key: string;
  } | null>(null);
  const updateFinalNoteDrafts = useCallback((update: (drafts: FinalNoteDraft[]) => FinalNoteDraft[]) => {
    const next = update(finalNoteDraftsRef.current);
    finalNoteDraftsRef.current = next;
    setFinalNoteDrafts(next);
  }, []);

  useEffect(() => {
    let disposed = false;
    let refreshRevision = 0;
    const refresh = () => {
      const revision = ++refreshRevision;
      return listMeetingNoteRecovery().then((drafts) => {
        if (disposed || revision !== refreshRevision) return;
        updateFinalNoteDrafts((current) => {
          const known = new Set(current.map((draft) => draft.recoveryId));
          const storedIds = new Set((drafts ?? []).map((draft) => draft.id));
          const retained = current.filter((draft) => !draft.journaled || draft.saving || storedIds.has(draft.recoveryId));
          return [...retained, ...(drafts ?? []).filter((draft) => !known.has(draft.id)).map((draft) => ({
            key: ++finalNoteRevisionRef.current, recoveryId: draft.id,
            recordingId: draft.recordingId, notes: draft.notes, baseNotes: draft.baseNotes,
            savedRef: { current: draft.baseNotes }, saving: false, journaled: true,
          }))];
        });
      }).catch(() => { if (!disposed && revision === refreshRevision) toast("Couldn't check for recovered notes. Reopen Meetings to try again.", "error"); });
    };
    let unlisten: (() => void) | undefined;
    void listen("meeting-note-recovery-changed", () => { void refresh(); }).then((stop) => {
      if (disposed) stop();
      else { unlisten = stop; void refresh(); }
    });
    return () => { disposed = true; unlisten?.(); };
  }, [updateFinalNoteDrafts]);

  const [liveMeetingNotes, setLiveMeetingNotes] = useState("");
  const latestLiveMeetingNotesRef = useRef(liveMeetingNotes);
  latestLiveMeetingNotesRef.current = liveMeetingNotes;
  const [liveMeetingTemplateId, setLiveMeetingTemplateId] = useState("auto");
  const [liveMeetingSystemAudio, setLiveMeetingSystemAudio] = useState(false);
  const [liveMeetingConsentShown, setLiveMeetingConsentShown] = useState(false);
  const reviewNotesRef = useRef<HTMLElement | null>(null);
  const [meetingNotesState, setMeetingNotesState] = useState<{
    text: string;
    undo: SectionUndoEntry[];
    notice: { message: string; error: boolean } | null;
  }>({ text: "", undo: [], notice: null });
  const meetingNotes = meetingNotesState.text;
  const setMeetingNotes = useCallback((next: string | ((current: string) => string)) => {
    setMeetingNotesState((current) => {
      const text = typeof next === "function" ? next(current.text) : next;
      return text === current.text ? current : { ...current, text, notice: null };
    });
  }, []);
  const [meetingNotesTargetId, setMeetingNotesTargetId] = useState<string | null>(null);
  const [sectionTitleDrafts, setSectionTitleDrafts] = useState<Record<string, { text: string; title: string }>>({});
  const [sectionBodyDrafts, setSectionBodyDrafts] = useState<Record<string, {
    title: string; body: string; text: string;
  }>>({});
  const addSectionButtonRef = useRef<HTMLButtonElement | null>(null);
  const notesCopyPendingRef = useRef(false);
  const [notesCopyPending, setNotesCopyPending] = useState(false);
  const meetingRecordCopyPendingRef = useRef(false);
  const [meetingRecordCopyPending, setMeetingRecordCopyPending] = useState(false);
  const meetingRecordCopySourceRef = useRef({
    recordingId: null as string | null,
    recap: "",
    fullRecord: "",
    revision: 0,
  });
  const notesCopyEpochRef = useRef(0);
  const notesCopyMountedRef = useRef(true);
  const [notesCopyFeedback, setNotesCopyFeedback] = useState<{
    recordingId: string; text: string; error: boolean; message: string;
  } | null>(null);
  useEffect(() => {
    notesCopyMountedRef.current = true;
    return () => { notesCopyMountedRef.current = false; ++notesCopyEpochRef.current; };
  }, []);
  useEffect(() => {
    ++notesCopyEpochRef.current;
    setNotesCopyFeedback(null);
  }, [meetingNotesTargetId]);
  const [meetingNotesSaveStatus, setMeetingNotesSaveStatus] =
    useState<MeetingNotesSaveStatus | null>(null);
  const [meetingTemplateId, setMeetingTemplateId] = useState("auto");
  // The user's saved meeting templates (audit finding ux-12 — user-defined
  // recipes alongside the 11 built-ins). Loaded once on mount and kept in
  // sync with every save this view makes, the same pattern dictation-view.tsx
  // uses for `dictationCustomModes`.
  const [customMeetingTemplates, setCustomMeetingTemplates] = useState<
    CustomMeetingTemplate[]
  >([]);
  // Voiceprints. Empty and off until the setting says otherwise, so the
  // transcript looks exactly as it did before the feature existed.
  const [rememberVoicesEnabled, setRememberVoicesEnabled] = useState(false);
  const [speakerVoices, setSpeakerVoices] = useState<
    Record<string, SpeakerVoiceState>
  >({});
  const [speakerVoicesRecordingId, setSpeakerVoicesRecordingId] = useState<
    string | null
  >(null);
  // Suggestion requests may finish out of order. Keep both the meeting and a
  // generation here so an old response can never populate the next meeting.
  const speakerVoiceRequestRef = useRef(0);
  const selectedRecordingIdRef = useRef<string | null>(null);
  const [speakerNameOptions, setSpeakerNameOptions] = useState<string[]>([]);
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false);
  // null while creating a new template; the template being edited otherwise.
  const [templateEditorTarget, setTemplateEditorTarget] =
    useState<CustomMeetingTemplate | null>(null);
  const [templateEditorSeed, setTemplateEditorSeed] = useState<{
    name: string;
    summaryPrompt: string;
    notesOutline: string[];
  } | null>(null);
  const [templateManagerOpen, setTemplateManagerOpen] = useState(false);
  const [meetingSummary, setMeetingSummary] = useState("");
  const [meetingActionItemsText, setMeetingActionItemsText] = useState("");
  const [enhancedMeetingNotesDraft, setEnhancedMeetingNotesDraft] =
    useState<EnhancedMeetingNotesDraft | null>(null);
  const enhancedDraftRevision = useRef(0);
  const enhancedDraftSelectionEpoch = useRef(0);
  const [savedEnhancedDraft, setSavedEnhancedDraft] = useState<{ recordingId: string; revision: number } | null>(null);
  const enhancedDraftRemovalPending = useRef(new Set<string>());
  const [enhancedDraftRemovalStatus, setEnhancedDraftRemovalStatus] = useState<"idle" | "removing" | "error">("idle");
  const [enhancedDraftRemovalError, setEnhancedDraftRemovalError] = useState<string | null>(null);
  const enhancedDraftSavePending = useRef(new Set<number>());
  const enhancedDraftWriteChains = useRef(new Map<string, Promise<void>>());
  const enhancedDraftStorageRevisions = useRef(new Map<string, number>());
  const [enhancedDraftSaveStatus, setEnhancedDraftSaveStatus] = useState<"unsaved" | "saving" | "saved" | "error">("unsaved");
  const [enhancedDraftSaveError, setEnhancedDraftSaveError] = useState<string | null>(null);

  // Provenance for the recap the user is looking at: which transcript lines the
  // model cited for the summary, and for each action item. Hydrated from storage
  // and retained only while it still matches the visible content.
  const [meetingSummaryProvenance, setMeetingSummaryProvenance] = useState<{
    summary: string;
    citations: LlmCitation[];
    grounded: boolean;
  } | null>(null);
  const [meetingActionItemProvenance, setMeetingActionItemProvenance] = useState<
    Array<{ item: string; citations: LlmCitation[] | null; grounded: boolean; evidence?: string | null }>
  >([]);
  // The recap text the reader typed in this session, held the same way the
  // citations above are: the claim "Your text." only stands while what is on
  // screen is still what they left. Text that arrived from the store was
  // written by nobody this session could name.
  const [userEditedSummary, setUserEditedSummary] = useState<string | null>(null);
  const [userEditedActionItemsText, setUserEditedActionItemsText] = useState<
    string | null
  >(null);
  const [isEnhancingMeetingNotes, setIsEnhancingMeetingNotes] = useState(false);
  const [meetingChatMessages, setMeetingChatMessages] = useState<MeetingChatMessage[]>([]);
  const [meetingRecallQuery, setMeetingRecallQuery] = useState("");
  const meetingRecallQueryRevisionRef = useRef(0);
  const [meetingRecallResponse, setMeetingRecallResponse] = useState<string | null>(null);
  const [meetingRecallCitations, setMeetingRecallCitations] = useState<LlmCitation[]>([]);
  const [meetingRecallGrounded, setMeetingRecallGrounded] = useState<boolean | null>(null);
  const [meetingRecallPromptLabel, setMeetingRecallPromptLabel] = useState<string | null>(null);

  const [meetingRecallLoading, setMeetingRecallLoading] = useState(false);
  const [meetingRecallError, setMeetingRecallError] = useState<string | null>(null);
  const [meetingRecallCancelStatus, setMeetingRecallCancelStatus] = useState<string | null>(null);
  const meetingRecallRunRef = useRef<{ runId: string; recordingId: string; prompt: string; cancelRequested: boolean } | null>(null);
  const cancelActiveMeetingRecall = useCallback(() => {
    const run = meetingRecallRunRef.current;
    meetingRecallRunRef.current = null;
    if (run && !run.cancelRequested) {
      run.cancelRequested = true;
      void Promise.resolve(cancelAnalysisRun(run.runId)).catch(() => undefined);
    }
  }, []);
  const displayedMeetingRecallRun = meetingRecallRunRef.current;
  const [isRefreshingSummary, setIsRefreshingSummary] = useState(false);
  const [isUndoingSummary, setIsUndoingSummary] = useState(false);
  const [summaryUndo, setSummaryUndo] = useState<{ recordingId: string; undoToken: string } | null>(null);
  const [isRefreshingActionItems, setIsRefreshingActionItems] = useState(false);
  const [actionCompletion, setActionCompletion] = useState<{
    recordingId: string; tasks: Set<string>;
  } | null>(null);
  const [actionCompletionError, setActionCompletionError] = useState<string | null>(null);
  const [savingActionCompletion, setSavingActionCompletion] = useState(false);
  const [actionRowInteraction, setActionRowInteraction] = useState(false);
  const actionRowInteractionRef = useRef(false);
  const changeActionRowInteraction = useCallback((active: boolean) => {
    actionRowInteractionRef.current = active;
    setActionRowInteraction(active);
  }, []);
  const [actionTaskFilter, setActionTaskFilter] = useState<"all" | "open" | "done">("all");
  const [requestedActionFocus, setRequestedActionFocus] = useState<{ recordingId: string; task: string } | null>(null);
  const actionCompletionPendingRef = useRef<{ recordingId: string } | null>(null);
  const actionCompletionRequestGuard = useScopedRequestGuard<string | null>();
  const [analysisProgressByTarget, setAnalysisProgressByTarget] = useState<
    Partial<Record<string, RecordingAnalysisProgressEvent>>
  >({});
  const [analysisFailureByTarget, setAnalysisFailureByTarget] = useState<
    Partial<Record<string, RecordingAnalysisFailedEvent>>
  >({});
  // Whole-meeting analysis state, keyed by meeting, so a row in the list can
  // move while a different meeting is open. Separate from the per-target map
  // above, which only describes the one meeting on screen.
  const [analysisStatusByRecording, setAnalysisStatusByRecording] = useState<
    Record<string, { phase: MeetingAnalysisStatusEvent["phase"]; error: string | null }>
  >({});
  const [activeSpeechTarget, setActiveSpeechTarget] = useState<string | null>(null);
  const meetingChatRequestGuard = useScopedRequestGuard<string | null>();
  const meetingSummaryRequestGuard = useScopedRequestGuard<string | null>();
  const meetingActionItemsRequestGuard = useScopedRequestGuard<string | null>();
  const meetingEnhanceRequestGuard = useScopedRequestGuard<string | null>();
  const meetingRegenerationRequestGuard = useScopedRequestGuard<string | null>();
  const meetingExportRequestGuard = useScopedRequestGuard<string | null>();
  const meetingRecallRequestGuard = useScopedRequestGuard<string | null>();
  useEffect(() => () => { meetingRecallRequestGuard.setScope(null); cancelActiveMeetingRecall(); }, [meetingRecallRequestGuard, cancelActiveMeetingRecall]);
  useEffect(() => () => { meetingExportRequestGuard.setScope(null); }, [meetingExportRequestGuard]);
  const [isPreparingRegeneration, setIsPreparingRegeneration] = useState(false);
  const analysisSaveTarget = useRef(meetingNotesTargetId);
  analysisSaveTarget.current = meetingNotesTargetId;
  const visibleAnalysisDraft = useRef({ summary: meetingSummary, actions: meetingActionItemsText });
  visibleAnalysisDraft.current = { summary: meetingSummary, actions: meetingActionItemsText };
  type AnalysisDraftFrame = { targetId: string | null; scope: number; summary: string; actions: string; summaryRevision: number; actionsRevision: number };
  type AnalysisSaveSnapshot = AnalysisDraftFrame & { baseSummary: string; baseActionsKey: string };
  const analysisDraftFrameRef = useRef<AnalysisDraftFrame>({
    targetId: meetingNotesTargetId, scope: 0, summary: meetingSummary, actions: meetingActionItemsText,
    summaryRevision: 0, actionsRevision: 0,
  });
  const previousAnalysisFrame = analysisDraftFrameRef.current;
  const analysisScopeChanged = previousAnalysisFrame.targetId !== meetingNotesTargetId;
  if (analysisScopeChanged || previousAnalysisFrame.summary !== meetingSummary || previousAnalysisFrame.actions !== meetingActionItemsText) {
    analysisDraftFrameRef.current = {
      targetId: meetingNotesTargetId, scope: previousAnalysisFrame.scope + (analysisScopeChanged ? 1 : 0),
      summary: meetingSummary, actions: meetingActionItemsText,
      summaryRevision: previousAnalysisFrame.summaryRevision + (analysisScopeChanged || previousAnalysisFrame.summary !== meetingSummary ? 1 : 0),
      actionsRevision: previousAnalysisFrame.actionsRevision + (analysisScopeChanged || previousAnalysisFrame.actions !== meetingActionItemsText ? 1 : 0),
    };
  }
  const analysisForceSaveRef = useRef({ scope: -1, summary: false, actions: false });
  const [analysisSaveStatus, setAnalysisSaveStatus] = useState<(Pick<AnalysisDraftFrame, "targetId" | "scope" | "summaryRevision" | "actionsRevision"> & { state: "saving" | "failed" }) | null>(null);
  const analysisSaveRunsRef = useRef(new Map<string, { snapshot: AnalysisSaveSnapshot; promise: Promise<void> }>());
  const analysisRetryRef = useRef<{ scope: number; promise: Promise<boolean> } | null>(null);
  const [summaryManualSaveRevision, setSummaryManualSaveRevision] = useState(0);
  const summaryUndoAvailabilityEpochRef = useRef(0);
  const visibleAnalysisSaveStatus = analysisSaveStatus && analysisSaveStatus.targetId === meetingNotesTargetId
    && analysisSaveStatus.scope === analysisDraftFrameRef.current.scope
    && analysisSaveStatus.summaryRevision === analysisDraftFrameRef.current.summaryRevision
    && analysisSaveStatus.actionsRevision === analysisDraftFrameRef.current.actionsRevision ? analysisSaveStatus : null;
  const markAnalysisDraftEdit = (field: "summary" | "actions", text: string) => {
    const current = analysisDraftFrameRef.current;
    if (current.targetId !== analysisSaveTarget.current || current[field] === text) return;
    analysisDraftFrameRef.current = { ...current, [field]: text,
      summaryRevision: current.summaryRevision + (field === "summary" ? 1 : 0),
      actionsRevision: current.actionsRevision + (field === "actions" ? 1 : 0) };
    visibleAnalysisDraft.current[field] = text;
  };
  useEffect(() => () => {
    analysisSaveTarget.current = null;
    analysisDraftFrameRef.current = { ...analysisDraftFrameRef.current, targetId: null,
      scope: analysisDraftFrameRef.current.scope + 1 };
  }, []);
  const analysisAutosaveTimer = useRef<number | null>(null);
  const pendingAnalysisSaves = useRef(new Map<string, Promise<void>>());
  const metadataAutosaveTimers = useRef<{ template: number | null; chat: number | null }>({ template: null, chat: null });
  const meetingChatMessagesKey = useMemo(() => JSON.stringify(meetingChatMessages), [meetingChatMessages]);
  const visibleMeetingMetadata = useRef({ template: meetingTemplateId, messages: meetingChatMessages, messagesKey: meetingChatMessagesKey });
  visibleMeetingMetadata.current = { template: meetingTemplateId === "auto" ? "auto" : meetingTemplateId.trim(), messages: meetingChatMessages, messagesKey: meetingChatMessagesKey };

  const lastSavedLiveMeetingNotesRef = useRef("");
  const previousLiveCaptureRef = useRef<{
    active: boolean;
    recordingId: string | null;
    notes: string;
    baseNotes: string;
  }>({ active: false, recordingId: null, notes: "", baseNotes: "" });
  if (isRecording && recordingId
      && previousLiveCaptureRef.current.active
      && previousLiveCaptureRef.current.recordingId === recordingId) {
    previousLiveCaptureRef.current.notes = liveMeetingNotes;
    previousLiveCaptureRef.current.baseNotes = lastSavedLiveMeetingNotesRef.current;
  }
  const lastSavedMeetingNotesRef = useRef("");
  // Three surfaces edit the same meeting note: the live capture panel, the
  // review canvas, and the recording popup (its own window). Every write goes
  // through persistMeetingNotes, which carries a revision so a response that
  // lands out of order can't walk local state backwards, and rebases against
  // what is actually stored instead of clobbering it.
  const meetingNotesWriteRevisionRef = useRef(0);
  const latestNoteRevisionByRecording = useRef(new Map<string, number>());
  const activeLiveRecordingId = useRef(recordingId);
  activeLiveRecordingId.current = recordingId;
  const playbookEditRevision = useRef(0);
  const pendingMeetingNotesWritesRef = useRef(0);
  // Serialize notes, template, and chat writes per meeting so older requests
  // cannot land after a newer draft is reported saved.
  const meetingWorkspaceWriteChainsRef = useRef(new Map<string, Promise<void>>());
  const meetingNotesRef = useRef("");
  meetingNotesRef.current = meetingNotes;
  const lastSavedMeetingTemplateRef = useRef("auto");
  const lastSavedMeetingSummaryRef = useRef("");
  const lastSavedMeetingActionItemsRef = useRef("[]");
  const lastSavedMeetingChatRef = useRef("[]");
  const lastSelectedMeetingIdRef = useRef<string | null>(null);
  // Autosave failures fire on every debounced keystroke, so throttle the error
  // toast to avoid a toast storm while still making the failure visible.
  const lastAutosaveErrorToastAtRef = useRef(0);
  const notifyAutosaveFailure = useCallback(
    (what: string) => {
      const now = Date.now();
      if (now - lastAutosaveErrorToastAtRef.current < 15000) {
        return;
      }
      lastAutosaveErrorToastAtRef.current = now;
      toast(`${what} aren't saving — keep this meeting open and try editing again.`, "error");
    },
    [toast]
  );

  // Live streaming transcript state. Lines are the words each segment added,
  // not the running transcript the same event also carries: these are stamped
  // with their own start time, and stamping the whole transcript with the
  // newest segment's time would claim the meeting began there.
  const [streamChunks, setStreamChunks] = useState<TranscriptStreamLine[]>([]);
  const [previewDelay, setPreviewDelay] = useState(() => describeTranscriptDelay(null));
  const [audioSourceWarning, setAudioSourceWarning] =
    useState<AudioSourceWarningDescriptor | null>(null);
  const streamScrollRef = useRef<HTMLDivElement>(null);

  const [autoNameIssue, setAutoNameIssue] = useState<{
    recordingId: string;
    message: string;
  } | null>(null);
  const [meetingSearch, setMeetingSearch] = useState("");
  // Transcript hits for the meetings-list search. Titles, notes, summaries, and
  // action items are matched here in the renderer; the transcript body is
  // matched by the backend's bm25 FTS index, which is the only thing that can
  // rank it.
  const [meetingSearchHits, setMeetingSearchHits] = useState<SearchHit[]>([]);
  const [isSearchingMeetingTranscripts, setIsSearchingMeetingTranscripts] = useState(false);
  const [meetingSearchError, setMeetingSearchError] = useState<string | null>(null);
  const [meetingSearchResultQuery, setMeetingSearchResultQuery] = useState<string | null>(null);
  const [meetingSearchResultStatus, setMeetingSearchResultStatus] =
    useState<MeetingSearchStatus | null>(null);
  const [meetingSearchResultScopeKey, setMeetingSearchResultScopeKey] =
    useState<string | null>(null);
  const meetingSearchQueryRef = useRef("");
  const meetingSearchStatusRef = useRef<MeetingSearchStatus>("all");
  const meetingSearchScopeKeyRef = useRef("");
  const meetingSearchRevisionRef = useRef(0);
  const pendingMeetingSearchRef = useRef<{
    query: string;
    revision: number;
    status: MeetingSearchStatus;
    scopeKey: string;
  } | null>(null);
  const [statusFilter, setStatusFilter] = useState<MeetingSearchStatus>("all");
  // What the last audio re-check found, and whether an acknowledgement is
  // waiting on a confirmation. Both are per-meeting and cleared on navigation.
  const [audioRecheckResult, setAudioRecheckResult] = useState<{
    recordingId: string;
    recoverable: boolean;
    message: string;
  } | null>(null);
  const [isRecheckingAudio, setIsRecheckingAudio] = useState(false);
  const [pendingAcknowledgement, setPendingAcknowledgement] =
    useState<Recording | null>(null);
  const [isAcknowledging, setIsAcknowledging] = useState(false);
  // Why the last attempt to start a meeting did not. Held on screen rather than
  // shown as a toast: it carries the one action that resolves it.
  const [meetingStartFailure, setMeetingStartFailure] =
    useState<MeetingStartFailure | null>(null);
  const [isBulkReclassifying, setIsBulkReclassifying] = useState(false);
  // "Import audio…": true from the click until the sidecar has decoded the
  // file and saved it. Transcription runs after that and reports itself
  // through the same processing states a stopped meeting uses.
  const [isImportingAudio, setIsImportingAudio] = useState(false);
  const [isExportingMeeting, setIsExportingMeeting] = useState(false);
  const [isRefreshingTranscriptPanel, setIsRefreshingTranscriptPanel] =
    useState(false);
  const [lastMeetingExportPath, setLastMeetingExportPath] = useState<string | null>(null);
  const [relationshipMemory, setRelationshipMemory] = useState<RelationshipMemory | null>(null);

  const {
    selectedRecording,
    setSelectedRecording,
    selectedTranscript,
    selectedTranscriptDetails,
    speakerNames,
    setSpeakerNames,
    waveformData,
    isLoadingDetail,
    detailError,
    loadRecordingDetail,
    refreshSelectedRecording,
    refreshSpeakerNames,
    refreshTranscript,
    refreshTranscriptDetails,
    clearRecordingDetail,
  } = useRecordingDetail({
    isOpen: showRecordingDetail,
    onRecordingLoaded: (recording) => {
      if (recording.id === meetingNotesTargetId) {
        // Moving the saved marker without moving the buffer is how another
        // window's notes used to disappear: the next keystroke here would
        // overwrite them. Rebase the buffer instead — unless one of our own
        // writes is still in flight, in which case this read is the stale one.
        if (pendingMeetingNotesWritesRef.current === 0) {
          const storedNotes = recording.meetingNotes ?? "";
          const rebased = rebaseMeetingNotes({
            base: lastSavedMeetingNotesRef.current,
            local: meetingNotesRef.current,
            stored: storedNotes,
          });
          lastSavedMeetingNotesRef.current = storedNotes;
          if (rebased !== meetingNotesRef.current) {
            setMeetingNotes(rebased);
          }
        }
        const storedTemplate = recording.meetingTemplateId ?? "auto";
        if (visibleMeetingMetadata.current.template === lastSavedMeetingTemplateRef.current) {
          visibleMeetingMetadata.current.template = storedTemplate;
          setMeetingTemplateId(storedTemplate);
        }
        lastSavedMeetingTemplateRef.current = storedTemplate;
        const storedSummary = recording.summary ?? "";
        const storedActions = actionItemsToText(recording.actionItems);
        if (visibleAnalysisDraft.current.summary.trim() === lastSavedMeetingSummaryRef.current.trim()) {
          visibleAnalysisDraft.current.summary = storedSummary;
          setMeetingSummary(storedSummary);
          setMeetingSummaryProvenance(recording.summaryProvenance && storedSummary ? {
            summary: storedSummary,
            citations: recording.summaryProvenance.citations ?? [],
            grounded: recording.summaryProvenance.grounded !== false,
          } : null);
        }
        if (JSON.stringify(actionItemsFromText(visibleAnalysisDraft.current.actions)) === lastSavedMeetingActionItemsRef.current) {
          visibleAnalysisDraft.current.actions = storedActions;
          setMeetingActionItemsText(storedActions);
          setMeetingActionItemProvenance(recording.actionItemsProvenance
            ? normalizeActionItems(recording.actionItems ?? []).map((item, index) => ({
                item,
                citations: recording.actionItemsProvenance?.items[index]?.generated === false ? null : recording.actionItemsProvenance?.items[index]?.citations ?? [],
                grounded: (recording.actionItemsProvenance?.items[index]?.grounded
                  ?? recording.actionItemsProvenance?.grounded) !== false,
                evidence: generatedEvidence(recording.actionItemsProvenance?.items[index]),
                unclear: generatedUnclear(recording.actionItemsProvenance?.items[index]),
              }))
            : []);
        }
        lastSavedMeetingSummaryRef.current = storedSummary;
        lastSavedMeetingActionItemsRef.current = JSON.stringify(
          normalizeActionItems(recording.actionItems ?? [])
        );
      }
    },
  });
  useEffect(() => {
    let active = true;
    setMeetingAsides([]);
    setAsideRanges([]);
    setAsideLoadError(false);
    if (selectedRecording?.id) {
      void Promise.all([getRecordingAsides(selectedRecording.id), getRecordingAsideRanges(selectedRecording.id)]).then(([asides, ranges]) => {
        if (active) { setMeetingAsides(asides); setAsideRanges(ranges); }
      }).catch(() => { if (active) setAsideLoadError(true); });
    }
    return () => { active = false; };
  }, [selectedRecording?.id, selectedRecording?.updatedAt]);

  const selectedMeetingStatus = selectedRecording
    ? recordingStatusOverrides[selectedRecording.id] ?? selectedRecording.status : null;
  const { activity: transcriptionActivity, reset: resetTranscriptionActivity } =
    useMeetingTranscriptionActivity(selectedRecording?.id ?? null, selectedMeetingStatus === "processing");
  selectedRecordingIdRef.current = selectedRecording?.id ?? null;
  useEffect(() => {
    setTranscriptSourceNavigation(undefined);
  }, [selectedRecording?.id]);
  const recallHasIncompleteReferences = meetingRecallCitations.some((citation) =>
    !citation.recordingId?.trim() || citation.recordingId === selectedRecording?.id
    || (citation.sourceKind != null && citation.sourceKind !== "transcript")
    || typeof citation.startTime !== "number" || !Number.isFinite(citation.startTime) || citation.startTime < 0
    || typeof citation.endTime !== "number" || !Number.isFinite(citation.endTime) || citation.endTime < citation.startTime);
  const meetingRecallReviewWarning = !meetingRecallResponse ? null
    : meetingRecallGrounded === false
      ? "This answer is not fully grounded. Review it against the earlier meetings before sharing."
      : recallHasIncompleteReferences
        ? "Some source references could not be verified. Review this answer against the earlier meetings before sharing."
        : meetingRecallGrounded !== true && meetingRecallCitations.length === 0
          ? "This answer has no verified source references. Review it against the earlier meetings before sharing."
          : null;

  // Loaded on mount, then re-read on every `settings-changed` broadcast --
  // the same pattern models-screen.tsx uses for its own settings-derived
  // state -- so a save from the manage/editor dialogs elsewhere in this same
  // view (which already re-reads directly, see `persistCustomMeetingTemplates`)
  // or from a second window entirely both keep this list current.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const refreshCustomMeetingTemplates = () => {
      void getSettings()
        .then((settings) => {
          if (!disposed) {
            setCustomMeetingTemplates(settings.transcription.meetingCustomTemplates ?? []);
            setRememberVoicesEnabled(resolveMeetingsSettings(settings).rememberVoices);
          }
        })
        .catch((error) => {
          console.warn("Failed to load meeting templates:", error);
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

  /** Read-modify-write settings.transcription.meetingCustomTemplates, the
   * same pattern dictation-view.tsx's `persistDictationPreferences` uses for
   * `dictationCustomModes` -- riding the existing settings surface needs no
   * new IPC command.
   *
   * Rust sanitizes on every save (dropping a malformed entry, capping a
   * name/prompt/outline length or the whole list's count -- see
   * `sanitize_meeting_custom_templates` in settings.rs), so `next` is not
   * necessarily what ends up on disk. Re-reading via `getSettings()` after
   * the write and setting state from *that* -- not the optimistic `next` --
   * is what keeps this view honest about what was actually persisted; the
   * caller is told when the two disagree so it can warn instead of quietly
   * reporting success on data that was just trimmed. */
  const persistCustomMeetingTemplates = async (
    next: CustomMeetingTemplate[]
  ): Promise<{ persisted: CustomMeetingTemplate[]; truncated: boolean } | null> => {
    try {
      const templates = structuredClone(next);
      await updateSettings((settings) => {
        settings.transcription.meetingCustomTemplates = templates;
      });
      const persistedSettings = await getSettings();
      const persisted = persistedSettings.transcription.meetingCustomTemplates ?? [];
      setCustomMeetingTemplates(persisted);
      return { persisted, truncated: !meetingTemplatesEqual(persisted, next) };
    } catch (error) {
      console.warn("Failed to save meeting templates:", error);
      toast("Couldn't save meeting templates — the change may not stick.", "error");
      return null;
    }
  };

  const TEMPLATE_TRUNCATED_WARNING =
    "Saved, but part of it was too long or otherwise invalid and got trimmed. Check the template.";

  const handleSaveNewMeetingTemplate = async (draft: MeetingTemplateDraft) => {
    if (customMeetingTemplates.length >= MAX_CUSTOM_MEETING_TEMPLATES) {
      toast(`You can save up to ${MAX_CUSTOM_MEETING_TEMPLATES} templates.`, "error");
      return;
    }
    const id = `custom-${
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    }`;
    const result = await persistCustomMeetingTemplates([
      ...customMeetingTemplates,
      { id, ...draft },
    ]);
    if (!result) {
      return;
    }
    toast(
      result.truncated ? TEMPLATE_TRUNCATED_WARNING : "Template saved.",
      result.truncated ? "info" : "success"
    );
  };

  const handleUpdateMeetingTemplate = async (
    id: string,
    draft: MeetingTemplateDraft
  ) => {
    const result = await persistCustomMeetingTemplates(
      customMeetingTemplates.map((template) =>
        template.id === id ? { ...template, ...draft } : template
      )
    );
    if (!result) {
      return;
    }
    toast(
      result.truncated ? TEMPLATE_TRUNCATED_WARNING : "Template updated.",
      result.truncated ? "info" : "success"
    );
  };

  const handleDeleteMeetingTemplate = async (template: CustomMeetingTemplate) => {
    // Past meetings keep their stored template id regardless -- the picker
    // and the analysis pass both fall back to the default template for an id
    // that no longer resolves, so a deletion here cannot break their display.
    const result = await persistCustomMeetingTemplates(
      customMeetingTemplates.filter((existing) => existing.id !== template.id)
    );
    if (result) {
      toast(`Deleted "${template.name}".`, "success");
    }
  };

  useEffect(() => {
    if (!selectedRecording?.id) {
      setAnalysisProgressByTarget({});
      setAnalysisFailureByTarget({});
      return;
    }

    let disposed = false;
    let unlistenProgress: (() => void) | undefined;
    let unlistenFailure: (() => void) | undefined;
    const recordingId = selectedRecording.id;
    void Promise.all([
      listen<RecordingAnalysisProgressEvent>(
        "recording-analysis-progress",
        (event) => {
          const payload = event.payload;
          if (!payload || payload.recordingId !== recordingId) return;
          setAnalysisProgressByTarget((current) => {
            const next = { ...current };
            if (payload.stage === "completed") {
              delete next[payload.target];
            } else {
              next[payload.target] = payload;
            }
            return next;
          });
          setAnalysisFailureByTarget((current) => {
            const next = { ...current };
            delete next[payload.target];
            return next;
          });
        }
      ).then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenProgress = unlisten;
        }
      }),
      listen<RecordingAnalysisFailedEvent>(
        "recording-analysis-failed",
        (event) => {
          const payload = event.payload;
          if (!payload || payload.recordingId !== recordingId) return;
          setAnalysisFailureByTarget((current) => ({
            ...current,
            [payload.target]: payload,
          }));
          setAnalysisProgressByTarget((current) => {
            const next = { ...current };
            delete next[payload.target];
            return next;
          });
        }
      ).then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenFailure = unlisten;
        }
      }),
    ]);

    return () => {
      disposed = true;
      unlistenProgress?.();
      unlistenFailure?.();
    };
  }, [selectedRecording?.id]);

  // Whole-meeting analysis status, listened for at the view level rather than
  // per open meeting: the failure this surfaces is normally discovered later,
  // from the list, not while the meeting is on screen.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen(MEETING_ANALYSIS_STATUS_EVENT, (event) => {
      const payload = parseMeetingAnalysisStatus(event.payload);
      if (!payload) {
        return;
      }
      setAnalysisStatusByRecording((current) => ({
        ...current,
        [payload.recordingId]: {
          phase: payload.phase,
          error: payload.error ?? null,
        },
      }));
      if (payload.phase === "completed") {
        // The stored failure is cleared on the sidecar side; re-read the
        // records so the list stops carrying a failure that is over.
        void refetch();
      }
    })
      .then((next) => {
        if (disposed) {
          next();
          return;
        }
        unlisten = next;
      })
      .catch((error) => {
        // A build whose sidecar half has not landed simply never reports; the
        // stored failure field still drives the banner.
        console.warn("Failed to subscribe to meeting analysis status:", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refetch]);

  const enqueueMeetingWorkspaceWrite = useCallback(
    async <T,>(recordingId: string, write: () => Promise<T>): Promise<T> => {
      const previousWrite = meetingWorkspaceWriteChainsRef.current.get(recordingId);
      const result = (previousWrite ?? Promise.resolve())
        .catch(() => undefined)
        .then(write);
      const settled = result.then(
        () => undefined,
        () => undefined
      );
      meetingWorkspaceWriteChainsRef.current.set(recordingId, settled);

      try {
        return await result;
      } finally {
        if (meetingWorkspaceWriteChainsRef.current.get(recordingId) === settled) {
          meetingWorkspaceWriteChainsRef.current.delete(recordingId);
        }
      }
    },
    []
  );
  const persistAnalysisDraft = useCallback(function persist(snapshot: AnalysisSaveSnapshot): Promise<void> {
    const targetId = snapshot.targetId;
    if (!targetId) return Promise.resolve();
    const currentScope = () => analysisSaveTarget.current === targetId
      && selectedRecordingIdRef.current === targetId && analysisDraftFrameRef.current.scope === snapshot.scope;
    const currentRevision = () => currentScope()
      && analysisDraftFrameRef.current.summaryRevision === snapshot.summaryRevision
      && analysisDraftFrameRef.current.actionsRevision === snapshot.actionsRevision;
    const existing = analysisSaveRunsRef.current.get(targetId);
    if (existing && existing.snapshot.scope === snapshot.scope
      && existing.snapshot.summaryRevision === snapshot.summaryRevision
      && existing.snapshot.actionsRevision === snapshot.actionsRevision) return existing.promise;
    const summary = snapshot.summary.trim();
    const actions = actionItemsFromText(snapshot.actions);
    const actionsKey = JSON.stringify(actions);
    let summaryChanged = summary !== snapshot.baseSummary.trim();
    let actionsChanged = actionsKey !== snapshot.baseActionsKey;
    const forced = analysisForceSaveRef.current;
    if (!summaryChanged && !actionsChanged && !pendingAnalysisSaves.current.has(targetId)
      && !(forced.scope === snapshot.scope && (forced.summary || forced.actions))) return Promise.resolve();
    if (currentRevision()) setAnalysisSaveStatus({ ...snapshot, state: "saving" });
    const previous = pendingAnalysisSaves.current.get(targetId) ?? Promise.resolve();
    const followLatest = () => {
      if (!currentScope()) return;
      const latest = analysisDraftFrameRef.current;
      const newerSummary = summaryChanged && latest.summaryRevision !== snapshot.summaryRevision;
      const newerActions = actionsChanged && latest.actionsRevision !== snapshot.actionsRevision;
      if (!newerSummary && !newerActions) return;
      const force = analysisForceSaveRef.current.scope === latest.scope ? analysisForceSaveRef.current
        : { scope: latest.scope, summary: false, actions: false };
      analysisForceSaveRef.current = { ...force, summary: force.summary || newerSummary, actions: force.actions || newerActions };
      void persist({ ...latest, baseSummary: lastSavedMeetingSummaryRef.current,
        baseActionsKey: lastSavedMeetingActionItemsRef.current }).catch(() => {});
    };
    const save = previous.catch(() => {}).then(async () => {
      if (currentScope()) {
        const force = analysisForceSaveRef.current;
        summaryChanged = summary !== lastSavedMeetingSummaryRef.current.trim() || (force.scope === snapshot.scope && force.summary);
        actionsChanged = actionsKey !== lastSavedMeetingActionItemsRef.current || (force.scope === snapshot.scope && force.actions);
      }
      const saved = summaryChanged || actionsChanged ? await updateRecordingAnalysis(targetId, {
        ...(summaryChanged ? { summary: summary || null } : {}),
        ...(actionsChanged ? { actionItems: actions } : {}),
      }) : undefined;
      if (saved && saved.id !== targetId) throw new Error("The recap save wasn't confirmed for this meeting.");
      if (summaryChanged && analysisSaveTarget.current === targetId && selectedRecordingIdRef.current === targetId) {
        summaryUndoAvailabilityEpochRef.current += 1;
        setSummaryUndo((current) => current?.recordingId === targetId ? null : current);
        setSummaryManualSaveRevision((revision) => revision + 1);
      }
      if (!currentScope()) return;
      if (summaryChanged) lastSavedMeetingSummaryRef.current = saved?.summary?.trim() ?? summary;
      if (actionsChanged) lastSavedMeetingActionItemsRef.current = JSON.stringify(saved?.actionItems ?? actions);
      const latest = analysisDraftFrameRef.current;
      const applySummary = summaryChanged && latest.summaryRevision === snapshot.summaryRevision;
      const applyActions = actionsChanged && latest.actionsRevision === snapshot.actionsRevision;
      if (applySummary) setMeetingSummaryProvenance(saved?.summaryProvenance ? {
        summary: saved.summary ?? summary, citations: saved.summaryProvenance.citations ?? [],
        grounded: saved.summaryProvenance.grounded !== false,
      } : null);
      if (applyActions) setMeetingActionItemProvenance(saved?.actionItemsProvenance
        ? normalizeActionItems(saved.actionItems ?? actions).map((item, index) => ({
          item, citations: saved.actionItemsProvenance?.items[index]?.generated === false ? null : saved.actionItemsProvenance?.items[index]?.citations ?? [],
          grounded: (saved.actionItemsProvenance?.items[index]?.grounded ?? saved.actionItemsProvenance?.grounded) !== false,
          evidence: generatedEvidence(saved.actionItemsProvenance?.items[index]),
          unclear: generatedUnclear(saved.actionItemsProvenance?.items[index]),
        })) : []);
      if (analysisForceSaveRef.current.scope === snapshot.scope) {
        if (applySummary) analysisForceSaveRef.current.summary = false;
        if (applyActions) analysisForceSaveRef.current.actions = false;
      }
      setSelectedRecording((current) => current?.id === targetId && currentScope() ? {
        ...current,
        ...(applySummary ? { summary: saved ? saved.summary : summary || undefined, summaryProvenance: saved?.summaryProvenance } : {}),
        ...(applyActions ? { actionItems: saved?.actionItems ?? actions, actionItemsProvenance: saved?.actionItemsProvenance } : {}),
      } : current);
      if (currentRevision()) setAnalysisSaveStatus((status) => status?.scope === snapshot.scope
        && status.summaryRevision === snapshot.summaryRevision && status.actionsRevision === snapshot.actionsRevision ? null : status);
      followLatest();
    }).catch((error) => {
      if (currentRevision()) {
        setAnalysisSaveStatus({ ...snapshot, state: "failed" });
        notifyAutosaveFailure("Summary and action items");
      }
      followLatest();
      throw error;
    }).finally(() => {
      if (pendingAnalysisSaves.current.get(targetId) === save) pendingAnalysisSaves.current.delete(targetId);
      if (analysisSaveRunsRef.current.get(targetId)?.promise === save) analysisSaveRunsRef.current.delete(targetId);
    });
    pendingAnalysisSaves.current.set(targetId, save);
    analysisSaveRunsRef.current.set(targetId, { snapshot, promise: save });
    return save;
  }, [notifyAutosaveFailure, setSelectedRecording]);

  const handleMeetingStatusFilterChange = useCallback(
    (status: MeetingSearchStatus) => {
      meetingSearchRevisionRef.current += 1;
      meetingSearchStatusRef.current = status;
      pendingMeetingSearchRef.current = null;
      setStatusFilter(status);
      setMeetingSearchHits([]);
      setMeetingSearchError(null);
      setMeetingSearchResultQuery(null);
      setMeetingSearchResultStatus(null);
      setMeetingSearchResultScopeKey(null);
      setIsSearchingMeetingTranscripts(
        meetingSearchQueryRef.current.length >= 2,
      );
    },
    [],
  );

  const persistMeetingTemplate = useCallback((targetId: string, templateId: string, autosave = false) =>
    enqueueMeetingWorkspaceWrite(targetId, async () => {
      if (autosave && analysisSaveTarget.current === targetId && visibleMeetingMetadata.current.template !== templateId) return;
      await updateRecordingTemplate(targetId, templateId === "auto" ? null : templateId);
      if (analysisSaveTarget.current === targetId) {
        lastSavedMeetingTemplateRef.current = templateId;
        if (visibleMeetingMetadata.current.template === templateId) {
          setSelectedRecording((current) => current?.id === targetId
            ? { ...current, meetingTemplateId: templateId === "auto" ? null : templateId, summaryProvenance: undefined }
            : current);
          setMeetingSummaryProvenance(null);
        }
      }
    }), [enqueueMeetingWorkspaceWrite, setSelectedRecording]);

  const persistMeetingChat = useCallback((targetId: string, messages: MeetingChatMessage[], autosave = false) => {
    const savedKey = JSON.stringify(messages);
    return enqueueMeetingWorkspaceWrite(targetId, async () => {
      if (autosave && analysisSaveTarget.current === targetId && visibleMeetingMetadata.current.messagesKey !== savedKey) return;
      await updateMeetingChatMessages(targetId, messages);
      if (analysisSaveTarget.current === targetId) lastSavedMeetingChatRef.current = savedKey;
    });
  }, [enqueueMeetingWorkspaceWrite]);

  // The one place meeting notes are written. Callers hand over the buffer they
  // hold plus the marker for the text that buffer was based on; if the record
  // moved underneath us the write is rebased and the buffer is pulled forward,
  // so no surface can silently delete another's text.
  const persistMeetingNotes = useCallback(
    async (target: {
      recordingId: string;
      notes: string;
      savedRef: { current: string };
      onRebase: (notes: string) => void;
      surface: "live" | "review";
      revision?: number;
      invalidateVisibleAnalysis?: boolean;
      recoveryDraftId?: string;
      replace?: boolean;
      expectedVisibleNotes?: string;
    }) => {
      const revision =
        target.revision ?? (meetingNotesWriteRevisionRef.current += 1);
      latestNoteRevisionByRecording.current.set(target.recordingId, Math.max(revision, latestNoteRevisionByRecording.current.get(target.recordingId) ?? 0));
      pendingMeetingNotesWritesRef.current += 1;
      if (revision === meetingNotesWriteRevisionRef.current) {
        setMeetingNotesSaveStatus({
          recordingId: target.recordingId,
          surface: target.surface,
          revision,
          state: "saving",
        });
      }
      try {
        await enqueueMeetingWorkspaceWrite(target.recordingId, async () => {
          // A queued autosave must not run after a newer explicit save.
          if (target.revision !== undefined && revision !== latestNoteRevisionByRecording.current.get(target.recordingId)) return;
          let stored = target.savedRef.current;
          try {
            stored = (await getRecording(target.recordingId))?.meetingNotes ?? "";
          } catch (error) {
            // Keep the last acknowledged base if the read fails. The database
            // comparison still rejects a write when that base is stale.
            console.error("Failed to read stored meeting notes before autosave:", error);
          }

          if (target.replace && (analysisSaveTarget.current !== target.recordingId ||
              meetingNotesRef.current !== target.expectedVisibleNotes || stored !== target.savedRef.current)) {
            throw new Error("Meeting notes changed before the draft could be saved. Review them and build a new draft.");
          }
          const nextNotes = target.replace ? target.notes : rebaseMeetingNotes({
            base: target.savedRef.current,
            local: target.notes,
            stored,
          });
          const notesChanged = nextNotes.trim() !== stored.trim();
          if (target.recoveryDraftId) {
            await updateRecordingNotes(target.recordingId, nextNotes, target.recoveryDraftId, stored);
          } else {
            await updateRecordingNotes(target.recordingId, nextNotes, undefined, stored);
          }

          // Even a superseded write is now the persisted base for the queued
          // write behind it. Only visible state and status are revision-gated.
          const surfaceCurrent = target.surface === "review"
            ? analysisSaveTarget.current === target.recordingId
            : activeLiveRecordingId.current === target.recordingId;
          const sharedSavedRef = target.surface === "review" ? lastSavedMeetingNotesRef : lastSavedLiveMeetingNotesRef;
          if (surfaceCurrent || target.savedRef !== sharedSavedRef) target.savedRef.current = nextNotes;
          if (revision !== latestNoteRevisionByRecording.current.get(target.recordingId) || !surfaceCurrent) return;
          if (nextNotes !== target.notes || target.replace) {
            if (target.surface === "review" && analysisSaveTarget.current === target.recordingId) meetingNotesRef.current = nextNotes;
            target.onRebase(nextNotes);
          }
          setSelectedRecording((current) =>
            current?.id === target.recordingId
              ? {
                  ...current,
                  meetingNotes: nextNotes.trim() ? nextNotes : null,
                  notesUpdatedAt: notesChanged ? new Date().toISOString() : current.notesUpdatedAt,
                  summaryProvenance: notesChanged && current.summaryProvenance
                    ? { ...current.summaryProvenance, grounded: false }
                    : current.summaryProvenance,
                  actionItemsProvenance: notesChanged ? undefined : current.actionItemsProvenance,
                }
              : current
          );
          if (target.invalidateVisibleAnalysis && notesChanged) {
            setMeetingSummaryProvenance((current) => current ? { ...current, grounded: false } : null);
            setMeetingActionItemProvenance([]);
          }
          if (revision === meetingNotesWriteRevisionRef.current) {
            setMeetingNotesSaveStatus({ recordingId: target.recordingId, surface: target.surface, revision, state: "saved" });
          }
        });
        return true;
      } catch (error) {
        console.error("Failed to update meeting notes:", error);
        if (revision === meetingNotesWriteRevisionRef.current) {
          setMeetingNotesSaveStatus({
            recordingId: target.recordingId,
            surface: target.surface,
            revision,
            state: "error",
          });
          if (target.recoveryDraftId) {
            toast(String(error).includes("Meeting notes changed while saving")
              ? "Saved notes changed during recovery. Retry save to merge the latest notes."
              : "Couldn't save the recovered notes. Retry save when storage is available.", "error");
          } else if (String(error).includes("Meeting notes changed while saving")) {
            toast("Saved notes changed during editing. Retry save to merge the latest notes.", "error");
          } else {
            notifyAutosaveFailure("Meeting notes");
          }
        }
        return false;
      } finally {
        pendingMeetingNotesWritesRef.current -= 1;
      }
    },
    [enqueueMeetingWorkspaceWrite, notifyAutosaveFailure, setSelectedRecording]
  );

  const saveFinalNoteDraft = useCallback((draft: FinalNoteDraft) => {
    const existing = finalNoteSavesRef.current.get(draft.key);
    if (existing) return existing;
    updateFinalNoteDrafts((current) => current.map((item) => item.key === draft.key ? { ...item, saving: true } : item));
    const save = (async () => {
      let journaled = draft.journaled;
      if (!journaled) {
        try {
          await queueMeetingNoteRecovery({ id: draft.recoveryId, recordingId: draft.recordingId, baseNotes: draft.baseNotes, notes: draft.notes });
          journaled = true;
          updateFinalNoteDrafts((current) => current.map((item) => item.key === draft.key ? { ...item, journaled: true } : item));
        } catch {
          // Try the normal save too. If both writes fail, keep the only copy
          // visible and keep the leave guard until it can be stored safely.
        }
      }
      const saved = await persistMeetingNotes({
        recordingId: draft.recordingId, notes: draft.notes, savedRef: draft.savedRef,
        onRebase: () => {}, surface: "live",
        recoveryDraftId: journaled ? draft.recoveryId : undefined,
      });
      if (saved) {
        void refreshSelectedRecording(draft.recordingId).catch((error) => {
          console.error("Failed to refresh recovered meeting notes:", error);
        });
      }
      updateFinalNoteDrafts((current) => saved
        ? current.filter((item) => item.key !== draft.key)
        : current.map((item) => item.key === draft.key ? { ...item, saving: false } : item));
      return saved;
    })().finally(() => { finalNoteSavesRef.current.delete(draft.key); });
    finalNoteSavesRef.current.set(draft.key, save);
    return save;
  }, [persistMeetingNotes, refreshSelectedRecording, updateFinalNoteDrafts]);

  const queueFinalNoteSnapshot = useCallback((
    targetRecordingId: string,
    notes: string,
    baseNotes: string,
  ) => {
    if (notes.trim() === baseNotes.trim()) return;
    const snapshotKey = JSON.stringify([targetRecordingId, baseNotes, notes]);
    if (recentFinalNoteSnapshotRef.current?.recordingId === targetRecordingId
        && recentFinalNoteSnapshotRef.current.key === snapshotKey) return;
    recentFinalNoteSnapshotRef.current = {
      recordingId: targetRecordingId,
      key: snapshotKey,
    };
    const draft: FinalNoteDraft = {
      key: ++finalNoteRevisionRef.current,
      recoveryId: crypto.randomUUID(),
      recordingId: targetRecordingId,
      notes,
      baseNotes,
      journaled: false,
      savedRef: { current: baseNotes },
      saving: true,
    };
    updateFinalNoteDrafts((current) => [...current, draft]);
    void saveFinalNoteDraft(draft);
  }, [saveFinalNoteDraft, updateFinalNoteDrafts]);

  useEffect(() => {
    const previous = previousLiveCaptureRef.current;
    const ownershipChanged = previous.active && previous.recordingId !== null
      && (!isRecording || recordingId !== previous.recordingId);
    if (ownershipChanged) {
      queueFinalNoteSnapshot(
        previous.recordingId!,
        previous.notes,
        previous.baseNotes,
      );
      refetch();
      setStreamChunks([]);
      setPreviewDelay(describeTranscriptDelay(null));
      setAudioSourceWarning(null);
      setLiveMeetingNotes("");
      setLiveMeetingTemplateId("auto");
      setLiveMeetingSystemAudio(false);
      setLiveMeetingConsentShown(false);
      lastSavedLiveMeetingNotesRef.current = "";
    }
    previousLiveCaptureRef.current = isRecording && recordingId
      ? {
          active: true,
          recordingId,
          notes: ownershipChanged ? "" : liveMeetingNotes,
          baseNotes: ownershipChanged ? "" : lastSavedLiveMeetingNotesRef.current,
        }
      : { active: false, recordingId: null, notes: "", baseNotes: "" };
  }, [
    isRecording,
    liveMeetingNotes,
    queueFinalNoteSnapshot,
    recordingId,
    refetch,
  ]);

  const retryMeetingNotesSave = useCallback(
    (surface: "live" | "review") => {
      if (surface === "live") {
        if (!recordingId) {
          return;
        }
        const revision = (meetingNotesWriteRevisionRef.current += 1);
        void persistMeetingNotes({
          recordingId,
          notes: liveMeetingNotes,
          savedRef: lastSavedLiveMeetingNotesRef,
          onRebase: setLiveMeetingNotes,
          surface,
          revision,
        });
        return;
      }

      if (!meetingNotesTargetId) {
        return;
      }
      const revision = (meetingNotesWriteRevisionRef.current += 1);
      void persistMeetingNotes({
        recordingId: meetingNotesTargetId,
        notes: meetingNotes,
        savedRef: lastSavedMeetingNotesRef,
        onRebase: setMeetingNotes,
        surface,
        revision,
        invalidateVisibleAnalysis: true,
      });
    },
    [
      liveMeetingNotes,
      meetingNotes,
      meetingNotesTargetId,
      persistMeetingNotes,
      recordingId,
    ]
  );

  useEffect(() => {
    let cancelled = false;

    void getRelationshipMemory()
      .then((result) => {
        if (!cancelled) {
          setRelationshipMemory(result);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("Failed to load relationship memory for meetings:", error);
          setRelationshipMemory(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Ask the sidecar what it recognizes in this meeting's speaker clusters.
   *
   * Returns `enabled: false` (and so an empty map) whenever "Remember voices"
   * is off, which is how the chips disappear entirely rather than sitting
   * there disabled. Never throws into the caller: a failed suggestion is a
   * missing chip, not a broken transcript.
   */
  const refreshSpeakerVoices = useCallback(async (recordingId: string) => {
    const request = ++speakerVoiceRequestRef.current;
    try {
      const result = await suggestSpeakerVoices(recordingId);
      if (
        request !== speakerVoiceRequestRef.current ||
        selectedRecordingIdRef.current !== recordingId
      ) {
        return false;
      }
      const next: Record<string, SpeakerVoiceState> = {};
      if (result.enabled) {
        for (const cluster of result.clusters) {
          next[cluster.speakerId] = {
            matchState: cluster.matchState,
            suggestion: cluster.suggestion
              ? {
                  profileId: cluster.suggestion.profileId,
                  displayName: cluster.suggestion.displayName,
                  percent: cluster.suggestion.percent,
                }
              : null,
          };
        }
      }
      setSpeakerVoices(next);
      setSpeakerVoicesRecordingId(recordingId);
      // Attendees first, then remembered voices — the sidecar has already
      // ranked them, so this side does not re-decide the order.
      setSpeakerNameOptions(result.enabled ? result.nameOptions : []);
      return true;
    } catch (error) {
      if (
        request !== speakerVoiceRequestRef.current ||
        selectedRecordingIdRef.current !== recordingId
      ) {
        return false;
      }
      console.warn("Failed to load remembered-voice suggestions:", error);
      setSpeakerVoices({});
      setSpeakerVoicesRecordingId(null);
      setSpeakerNameOptions([]);
      return false;
    }
  }, []);

  // Re-asked whenever the open meeting changes. Cheap: it compares stored
  // centroids, it does not re-run the embedder over the audio.
  useEffect(() => {
    // Invalidate and hide the previous meeting's map synchronously with the
    // transition; the request below is the only one allowed to refill it.
    speakerVoiceRequestRef.current += 1;
    setSpeakerVoices({});
    setSpeakerVoicesRecordingId(null);
    setSpeakerNameOptions([]);
    if (!selectedRecording) {
      return;
    }
    void refreshSpeakerVoices(selectedRecording.id);
  }, [selectedRecording?.id, refreshSpeakerVoices]);

  // And whenever a remembered voice is forgotten. "Delete all" in Settings
  // used to leave the open transcript offering names for voices that no
  // longer existed until the reader navigated away and back.
  useEffect(() => {
    if (!selectedRecording) {
      return;
    }
    const recordingId = selectedRecording.id;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    let unlistenTranscript: (() => void) | null = null;
    void (async () => {
      const stop = await listen("remembered-voices-changed", () => {
        void refreshSpeakerVoices(recordingId);
      });
      if (cancelled) {
        stop();
        return;
      }
      unlisten = stop;
    })();
    // Speakers labelled after the meeting opened (the automatic pass that
    // finishes after the transcript, or a re-label) have new voices to match:
    // without this the suggestions stayed empty and a rename did not remember
    // the voice until the reader left the meeting and came back.
    void (async () => {
      const stop = await listen<{ recordingId?: string }>("transcript-updated", (event) => {
        if (event.payload?.recordingId === recordingId) {
          void refreshSpeakerVoices(recordingId);
        }
      });
      if (cancelled) {
        stop();
        return;
      }
      unlistenTranscript = stop;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      unlistenTranscript?.();
    };
  }, [selectedRecording?.id, refreshSpeakerVoices]);

  const handleConfirmSpeakerVoice = async (speakerId: string, profileId: string) => {
    if (
      !selectedRecording ||
      speakerVoicesRecordingId !== selectedRecording.id ||
      speakerVoices[speakerId]?.suggestion?.profileId !== profileId
    ) {
      return;
    }
    const recordingId = selectedRecording.id;
    try {
      const { displayName } = await rememberSpeakerVoice({
        recordingId,
        speakerId,
        profileId,
      });
      if (selectedRecordingIdRef.current !== recordingId) {
        return;
      }
      setSpeakerNames((prev) => ({ ...prev, [speakerId]: displayName }));
      await refreshSpeakerVoices(recordingId);
      toast(`Speaker named ${displayName}.`, "success");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Couldn't confirm that voice.";
      toast(message, "error");
      throw error;
    }
  };

  const handleRejectSpeakerVoice = async (speakerId: string, profileId: string) => {
    if (
      !selectedRecording ||
      speakerVoicesRecordingId !== selectedRecording.id ||
      speakerVoices[speakerId]?.suggestion?.profileId !== profileId
    ) {
      return;
    }
    try {
      await rejectSpeakerVoice(selectedRecording.id, speakerId, profileId);
      await refreshSpeakerVoices(selectedRecording.id);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Couldn't dismiss that suggestion.";
      toast(message, "error");
      throw error;
    }
  };

  const handleRefreshTranscriptPanel = async () => {
    if (!selectedRecording) {
      return;
    }

    setIsRefreshingTranscriptPanel(true);
    try {
      await Promise.all([
        refreshSelectedRecording(selectedRecording.id),
        refreshTranscript(selectedRecording.id),
        refreshTranscriptDetails(selectedRecording.id),
        refreshSpeakerNames(selectedRecording.id),
      ]);
      toast("Transcript refreshed.", "success");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Couldn't refresh the transcript. Try again once processing has moved on.";
      toast(message, "error");
    } finally {
      setIsRefreshingTranscriptPanel(false);
    }
  };

  useEffect(() => {
    return () => {
      stopSpeakingText();
    };
  }, []);

  const toggleReadAloudPlayback = (text: string, target: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      toast("Nothing to read aloud.", "error");
      return;
    }

    if (activeSpeechTarget === target) {
      stopSpeakingText();
      setActiveSpeechTarget(null);
      toast("Stopped playback.", "success");
      return;
    }

    setActiveSpeechTarget(target);
    const started = speakTextAloud(trimmed, {
      onEnd: () => setActiveSpeechTarget((current) => (current === target ? null : current)),
      onError: () => toast("Read aloud unavailable.", "error"),
    });

    if (!started) {
      setActiveSpeechTarget(null);
      toast("Read aloud not supported here.", "error");
    }
  };

  type RecordingStatusChangedEvent = {
    recordingId: string;
    status: Recording["status"];
    message?: string | null;
    progress?: number | null;
    updatedAt?: string | null;
    meetingProcessingStartedAt?: string | null;
    transcriptFirstAvailableAt?: string | null;
    consentPromptShown?: boolean | null;
    degraded?: boolean | null;
  };

  useEffect(() => {
    if (!isRecording || !recordingId) {
      return;
    }

    const normalizedNotes = liveMeetingNotes.trim();
    if (normalizedNotes === lastSavedLiveMeetingNotesRef.current.trim()) {
      setMeetingNotesSaveStatus((current) =>
        current?.surface === "live" && current.recordingId === recordingId
          ? null
          : current
      );
      return;
    }

    const revision = (meetingNotesWriteRevisionRef.current += 1);
    setMeetingNotesSaveStatus({
      recordingId,
      surface: "live",
      revision,
      state: "saving",
    });
    const timeoutId = window.setTimeout(() => {
      void persistMeetingNotes({
        recordingId,
        notes: liveMeetingNotes,
        savedRef: lastSavedLiveMeetingNotesRef,
        onRebase: setLiveMeetingNotes,
        surface: "live",
        revision,
      });
    }, 350);

    return () => window.clearTimeout(timeoutId);
  }, [isRecording, liveMeetingNotes, persistMeetingNotes, recordingId]);

  useEffect(() => {
    if (!meetingNotesTargetId) {
      return;
    }

    const normalizedNotes = meetingNotes.trim();
    if (normalizedNotes === lastSavedMeetingNotesRef.current.trim()) {
      setMeetingNotesSaveStatus((current) =>
        current?.surface === "review" && current.recordingId === meetingNotesTargetId
          ? null
          : current
      );
      return;
    }

    const revision = (meetingNotesWriteRevisionRef.current += 1);
    setMeetingNotesSaveStatus({
      recordingId: meetingNotesTargetId,
      surface: "review",
      revision,
      state: "saving",
    });
    const timeoutId = window.setTimeout(() => {
      void persistMeetingNotes({
        recordingId: meetingNotesTargetId,
        notes: meetingNotes,
        savedRef: lastSavedMeetingNotesRef,
        onRebase: setMeetingNotes,
        surface: "review",
        revision,
        invalidateVisibleAnalysis: true,
      });
    }, 350);

    return () => window.clearTimeout(timeoutId);
  }, [meetingNotes, meetingNotesTargetId, persistMeetingNotes]);

  useEffect(() => {
    if (!meetingNotesTargetId) {
      return;
    }

    const normalizedTemplateId = meetingTemplateId === "auto" ? "auto" : meetingTemplateId.trim();
    if (normalizedTemplateId === lastSavedMeetingTemplateRef.current && !meetingWorkspaceWriteChainsRef.current.has(meetingNotesTargetId)) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (metadataAutosaveTimers.current.template === timeoutId) metadataAutosaveTimers.current.template = null;
      void persistMeetingTemplate(meetingNotesTargetId, normalizedTemplateId, true).catch((error) => {
        console.error("Failed to update meeting template:", error);
        notifyAutosaveFailure("Template choices");
      });
    }, 250);
    metadataAutosaveTimers.current.template = timeoutId;
    return () => {
      window.clearTimeout(timeoutId);
      if (metadataAutosaveTimers.current.template === timeoutId) metadataAutosaveTimers.current.template = null;
    };
  }, [meetingNotesTargetId, meetingTemplateId, notifyAutosaveFailure, persistMeetingTemplate]);

  useEffect(() => {
    if (!meetingNotesTargetId) return;
    const snapshot = { ...analysisDraftFrameRef.current, baseSummary: lastSavedMeetingSummaryRef.current,
      baseActionsKey: lastSavedMeetingActionItemsRef.current };
    const force = analysisForceSaveRef.current;
    if (meetingSummary.trim() === lastSavedMeetingSummaryRef.current.trim()
      && JSON.stringify(actionItemsFromText(meetingActionItemsText)) === lastSavedMeetingActionItemsRef.current
      && !(force.scope === snapshot.scope && (force.summary || force.actions))) return;
    const timeoutId = window.setTimeout(() => {
      if (analysisAutosaveTimer.current === timeoutId) analysisAutosaveTimer.current = null;
      void persistAnalysisDraft(snapshot).catch(() => {});
    }, 350);
    analysisAutosaveTimer.current = timeoutId;
    return () => {
      window.clearTimeout(timeoutId);
      if (analysisAutosaveTimer.current === timeoutId) analysisAutosaveTimer.current = null;
    };
  }, [meetingActionItemsText, meetingNotesTargetId, meetingSummary, persistAnalysisDraft]);

  useEffect(() => {
    if (!meetingNotesTargetId) {
      return;
    }

    if (meetingChatMessagesKey === lastSavedMeetingChatRef.current && !meetingWorkspaceWriteChainsRef.current.has(meetingNotesTargetId)) return;
    const timeoutId = window.setTimeout(() => {
      if (metadataAutosaveTimers.current.chat === timeoutId) metadataAutosaveTimers.current.chat = null;
      void persistMeetingChat(meetingNotesTargetId, meetingChatMessages, true).catch((error) => {
        console.error("Failed to update meeting chat:", error);
        notifyAutosaveFailure("Chat history");
      });
    }, 250);
    metadataAutosaveTimers.current.chat = timeoutId;
    return () => {
      window.clearTimeout(timeoutId);
      if (metadataAutosaveTimers.current.chat === timeoutId) metadataAutosaveTimers.current.chat = null;
    };
  }, [meetingChatMessages, meetingChatMessagesKey, meetingNotesTargetId, notifyAutosaveFailure, persistMeetingChat]);

  useEffect(() => {
    if (!isRecording && !showRecordingDetail) {
      meetingChatRequestGuard.setScope(null);
      meetingSummaryRequestGuard.setScope(null);
      meetingRegenerationRequestGuard.setScope(null);
      setIsPreparingRegeneration(false);
      meetingActionItemsRequestGuard.setScope(null);
      meetingEnhanceRequestGuard.setScope(null);
      meetingExportRequestGuard.setScope(null);
      meetingRecallRequestGuard.setScope(null);
      setIsExportingMeeting(false);
      setMeetingNotes("");
      setMeetingNotesTargetId(null);
      setMeetingTemplateId("auto");
      setMeetingSummary("");
      setMeetingActionItemsText("");
      setEnhancedMeetingNotesDraft(null);
      setMeetingSummaryProvenance(null);
      setMeetingActionItemProvenance([]);
      setUserEditedSummary(null);
      setUserEditedActionItemsText(null);
      setIsEnhancingMeetingNotes(false);
      setMeetingChatMessages([]);
      setIsRefreshingSummary(false);
      setIsRefreshingActionItems(false);
      setIsEditingSummary(false);
      setIsEditingActionItems(false);
      setPendingRegenerate(null);
      lastSavedMeetingNotesRef.current = "";
      lastSavedMeetingTemplateRef.current = "auto";
      lastSavedMeetingSummaryRef.current = "";
      lastSavedMeetingActionItemsRef.current = "[]";
      lastSavedMeetingChatRef.current = "[]";
    }
  }, [
    isRecording,
    meetingActionItemsRequestGuard,
    meetingChatRequestGuard,
    meetingEnhanceRequestGuard,
    meetingExportRequestGuard,
    meetingRecallRequestGuard,
    meetingSummaryRequestGuard,
    meetingRegenerationRequestGuard,
    showRecordingDetail,
  ]);

  useEffect(() => {
    if (!selectedRecording) {
      setMeetingTemplateId("auto");
      setMeetingSummary("");
      setMeetingActionItemsText("");
      setEnhancedMeetingNotesDraft(null);
      setMeetingChatMessages([]);
      lastSelectedMeetingIdRef.current = null;
      lastSavedMeetingTemplateRef.current = "auto";
      lastSavedMeetingSummaryRef.current = "";
      lastSavedMeetingActionItemsRef.current = "[]";
      lastSavedMeetingChatRef.current = "[]";
      return;
    }

    const nextTemplateId = selectedRecording.meetingTemplateId ?? "auto";
    const nextSummary = selectedRecording.summary ?? "";
    const nextActionItemsText = actionItemsToText(selectedRecording.actionItems);
    const isNewMeeting = lastSelectedMeetingIdRef.current !== selectedRecording.id;
    if (isNewMeeting || visibleMeetingMetadata.current.template === lastSavedMeetingTemplateRef.current) {
      visibleMeetingMetadata.current.template = nextTemplateId;
      setMeetingTemplateId(nextTemplateId);
    }
    const adoptSummary = isNewMeeting || visibleAnalysisDraft.current.summary.trim() === lastSavedMeetingSummaryRef.current.trim();
    const adoptActions = isNewMeeting || JSON.stringify(actionItemsFromText(visibleAnalysisDraft.current.actions)) === lastSavedMeetingActionItemsRef.current;
    if (adoptSummary) {
      visibleAnalysisDraft.current.summary = nextSummary;
      setMeetingSummary(nextSummary);
    }
    if (adoptActions) {
      visibleAnalysisDraft.current.actions = nextActionItemsText;
      setMeetingActionItemsText(nextActionItemsText);
    }
    if (adoptSummary && selectedRecording.summaryProvenance && nextSummary) {
      setMeetingSummaryProvenance({
        summary: nextSummary,
        citations: selectedRecording.summaryProvenance.citations ?? [],
        grounded: selectedRecording.summaryProvenance.grounded !== false,
      });
    } else if (isNewMeeting) {
      setMeetingSummaryProvenance(null);
    }
    if (adoptActions && selectedRecording.actionItemsProvenance) {
      setMeetingActionItemProvenance(
        normalizeActionItems(selectedRecording.actionItems ?? []).map((item, index) => ({
          item,
          citations:
            selectedRecording.actionItemsProvenance?.items[index]?.generated === false ? null : selectedRecording.actionItemsProvenance?.items[index]?.citations ?? [],
          grounded:
            (selectedRecording.actionItemsProvenance?.items[index]?.grounded
              ?? selectedRecording.actionItemsProvenance?.grounded) !== false,
          evidence: generatedEvidence(selectedRecording.actionItemsProvenance?.items[index]),
          unclear: generatedUnclear(selectedRecording.actionItemsProvenance?.items[index]),
        }))
      );
    } else if (isNewMeeting) {
      setMeetingActionItemProvenance([]);
    }
    if (isNewMeeting) {
      setEnhancedMeetingNotesDraft(null);
      // Evidence and authorship belong to one meeting's text; neither may
      // follow the reader into the next meeting.
      setUserEditedSummary(null);
      setUserEditedActionItemsText(null);
      lastSelectedMeetingIdRef.current = selectedRecording.id;
    }
    lastSavedMeetingTemplateRef.current = nextTemplateId;
    lastSavedMeetingSummaryRef.current = nextSummary;
    lastSavedMeetingActionItemsRef.current = JSON.stringify(
      normalizeActionItems(selectedRecording.actionItems ?? [])
    );
  }, [
    selectedRecording?.actionItems,
    selectedRecording?.actionItemsProvenance,
    selectedRecording?.id,
    selectedRecording?.meetingTemplateId,
    selectedRecording?.summary,
    selectedRecording?.summaryProvenance,
  ]);

  useEffect(() => {
    if (!isRecording || !recordingId || selectedRecording?.id !== recordingId) {
      return;
    }

    // The popup edits the same record, so this can arrive mid-sentence. Rebase
    // onto whatever is stored rather than replacing the buffer outright, which
    // used to drop the keystrokes typed since the last save.
    const nextNotes = selectedRecording.meetingNotes ?? "";
    setLiveMeetingNotes((current) =>
      current === nextNotes
        ? current
        : rebaseMeetingNotes({
            base: lastSavedLiveMeetingNotesRef.current,
            local: current,
            stored: nextNotes,
          })
    );
    setLiveMeetingTemplateId((current) => {
      const nextTemplateId = selectedRecording.meetingTemplateId ?? "auto";
      return current === nextTemplateId ? current : nextTemplateId;
    });
  }, [
    isRecording,
    recordingId,
    selectedRecording?.id,
    selectedRecording?.meetingNotes,
    selectedRecording?.meetingTemplateId,
  ]);

  // Subscribe to live streaming transcript events while recording
  useEffect(() => {
    if (!isRecording || !recordingId) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let scrollTimeout: ReturnType<typeof setTimeout> | undefined;
    listen<RecordingTranscriptionStreamEvent>(
      RECORDING_TRANSCRIPTION_STREAM_EVENT,
      (event) => {
        if (event.payload.recordingId !== recordingId) return;
        setPreviewDelay(describeTranscriptDelay(event.payload));
        setStreamChunks((prev) => appendTranscriptStreamLine(prev, event.payload));
        if (scrollTimeout) {
          clearTimeout(scrollTimeout);
        }
        scrollTimeout = setTimeout(() => {
          const scrollContainer = streamScrollRef.current;
          if (!scrollContainer) return;
          if (typeof scrollContainer.scrollTo === "function") {
            scrollContainer.scrollTo({
              top: scrollContainer.scrollHeight,
              behavior: "smooth",
            });
          } else {
            scrollContainer.scrollTop = scrollContainer.scrollHeight;
          }
        }, 50);
      }
    ).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      disposed = true;
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
      }
      unlisten?.();
    };
  }, [isRecording, recordingId]);

  // A capture source going silent mid-meeting is only useful to know while the
  // meeting is still running, so it is surfaced here rather than in a log.
  useEffect(() => {
    if (!isRecording || !recordingId) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<MeetingAudioSourceWarningEvent>(
      MEETING_AUDIO_SOURCE_WARNING_EVENT,
      (event) => {
        if (event.payload.recordingId !== recordingId) return;
        setAudioSourceWarning(describeAudioSourceWarning(event.payload));
      }
    ).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isRecording, recordingId]);

  useEffect(() => {
    let disposed = false;
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
          message: message ?? "Plainsong could not name this meeting.",
        });
      }
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refetch]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<RecordingStatusChangedEvent>("recording-status-changed", (event) => {
      const payload = event.payload;
      if (!payload?.recordingId) return;
      recordingStatusEventRevisionRef.current.set(payload.recordingId,
        (recordingStatusEventRevisionRef.current.get(payload.recordingId) ?? 0) + 1);

      setRecordingStatusOverrides((current) => ({
        ...current,
        [payload.recordingId]: payload.status,
      }));

      if (payload.status === "completed" || payload.status === "pending" || payload.status === "error") {
        void refetch();
      }

      // A completed meeting can still carry a degraded-transcript note (a
      // chunk or an entire audio source failed but the rest of the meeting
      // was kept) — without this, that note never reaches the user and the
      // meeting looks like every other "completed" row.
      if (payload.status === "completed" && (payload.degraded || payload.message)) {
        toast(
          payload.message ?? "This meeting's transcript may be incomplete.",
          "info"
        );
      }
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refetch]);

  const openMeetingWorkspace = (
    recording: Recording,
    focus?: { segmentTime?: number; highlightQuery?: string; actionItem?: string }
  ) => {
    workspaceOpenRequestRef.current += 1;
    setRequestedActionFocus(focus?.actionItem ? { recordingId: recording.id, task: focus.actionItem } : null);
    if (focus?.actionItem) setActionTaskFilter("all");
    meetingChatRequestGuard.setScope(recording.id);
    meetingSummaryRequestGuard.setScope(recording.id);
    meetingActionItemsRequestGuard.setScope(recording.id);
    meetingEnhanceRequestGuard.setScope(recording.id);
    setIsEnhancingMeetingNotes(false);
    setEnhancedMeetingNotesDraft(null);
    meetingRegenerationRequestGuard.setScope(recording.id);
    meetingExportRequestGuard.setScope(recording.id);
    meetingRecallRequestGuard.setScope(recording.id);
    setIsExportingMeeting(false);
    setIsPreparingRegeneration(false);
    setSummaryUndo(null);
    setIsUndoingSummary(false);
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
    setLastMeetingExportPath(null);
    setShowRecordingDetail(true);
    setSearchQuery(focus?.highlightQuery ?? "");
    setTranscriptMatches([]);
    setActiveTranscriptMatchIndex(0);
    playhead.set(focus?.segmentTime);
    // Which hit the reader asked for: the one at the moment they clicked, not
    // whichever occurrence happens to come first in the meeting.
    pendingMatchFocusTimeRef.current =
      focus?.highlightQuery && focus.segmentTime !== undefined ? focus.segmentTime : null;
    // The transcript is its own pane now, always on screen beside the record,
    // so a deep link cues the moment without hiding the document behind a tab.
    setMeetingTab("record");
    setIsEditingSummary(false);
    setIsEditingActionItems(false);
    setPendingRegenerate(null);
    setAudioPlaybackIssue(null);
    setMeetingSummaryProvenance(
      recording.summaryProvenance && recording.summary
        ? {
            summary: recording.summary,
            citations: recording.summaryProvenance.citations ?? [],
            grounded: recording.summaryProvenance.grounded !== false,
          }
        : null
    );
    setMeetingActionItemProvenance(
      recording.actionItemsProvenance
        ? normalizeActionItems(recording.actionItems ?? []).map((item, index) => ({
            item,
            citations: recording.actionItemsProvenance?.items[index]?.generated === false ? null : recording.actionItemsProvenance?.items[index]?.citations ?? [],
            grounded:
              (recording.actionItemsProvenance?.items[index]?.grounded
                ?? recording.actionItemsProvenance?.grounded) !== false,
            evidence: generatedEvidence(recording.actionItemsProvenance?.items[index]),
            unclear: generatedUnclear(recording.actionItemsProvenance?.items[index]),
          }))
        : []
    );
    setUserEditedSummary(null);
    setUserEditedActionItemsText(null);
    setDiarizationMessage(null);
    setDiarizationError(null);
    setIsRefreshingSummary(false);
    setIsRefreshingActionItems(false);
    void loadRecordingDetail(recording);
    const requestToken = meetingChatRequestGuard.beginRequest(recording.id);
    void getMeetingChatMessages(recording.id)
      .then((messages) => {
        if (!meetingChatRequestGuard.isCurrent(requestToken)) {
          return;
        }
        setMeetingChatMessages(messages);
        lastSavedMeetingChatRef.current = JSON.stringify(messages);
      })
      .catch((error) => {
        if (!meetingChatRequestGuard.isCurrent(requestToken)) {
          return;
        }
        console.error("Failed to load meeting chat:", error);
      });
  };

  const openMeetingCapture = (calendarPrefill?: MeetingCapturePrefill) => {
    if (pendingMeetingStartRef.current) {
      return;
    }
    if (captureConflictNotice) {
      toast(captureConflictNotice, "error");
      return;
    }
    if (!captureIsReady) {
      const cause = meetingCaptureReadiness.cause;
      toast(
        cause?.message ?? "Plainsong could not confirm that meetings are ready.",
        "error",
      );
      // A refresh is temporary and does not require changing setup.
      if (cause?.id === "loading") {
        return;
      }
      if (cause) {
        requestReadinessDestination(cause.action.destination);
      }
      return;
    }
    // Starting from the calendar lands on the same consent step as "New
    // meeting", template picker and all. The event supplies the name; every
    // other decision about the meeting stays where the reader expects it.
    pendingCalendarPrefill.current = calendarPrefill ?? null;
    setMeetingStartFailure(null);
    setShowConsent(true);
  };

  // "Record a Meeting…" in the menu bar and `plainsong://meeting/start`
  // (electron/main.ts) land here: the same readiness gate and the same
  // consent sheet as the New meeting button, and nothing records until the
  // person clicks Start on that sheet. App parks the request because this view
  // is usually not mounted yet when it arrives; it is taken on mount or from
  // the window event, and held while readiness is still loading so the click
  // is not answered with "still checking" and dropped.
  const [meetingStartRequested, setMeetingStartRequested] = useState(false);
  useEffect(() => {
    const handleMeetingStartRequest = () => {
      if (consumePendingMeetingStartRequest()) setMeetingStartRequested(true);
    };
    handleMeetingStartRequest();
    window.addEventListener(MEETING_START_REQUEST_EVENT, handleMeetingStartRequest);
    return () => {
      window.removeEventListener(MEETING_START_REQUEST_EVENT, handleMeetingStartRequest);
    };
  }, []);
  const openMeetingCaptureRef = useRef(openMeetingCapture);
  openMeetingCaptureRef.current = openMeetingCapture;
  const meetingReadinessLoading =
    !captureIsReady && meetingCaptureReadiness.cause?.id === "loading";
  useEffect(() => {
    if (!meetingStartRequested || meetingReadinessLoading) return;
    setMeetingStartRequested(false);
    openMeetingCaptureRef.current();
  }, [meetingStartRequested, meetingReadinessLoading]);

  const handleStartRecording = async (options: { mic: boolean; systemAudio: boolean; template?: string }) => {
    if (pendingMeetingStartRef.current) {
      return;
    }
    if (captureConflictNotice) {
      toast(captureConflictNotice, "error");
      return;
    }
    const requestedReadiness = options.systemAudio
      ? fullCaptureReadiness
      : meetingCaptureReadiness;
    if (requestedReadiness.state !== "ready") {
      const cause = requestedReadiness.cause;
      toast(
        cause?.message ??
          "Plainsong could not confirm that the selected meeting capture is ready.",
        "error",
      );
      // Keep the selected capture mode and template during a readiness refresh.
      if (cause?.id === "loading") {
        return;
      }
      if (cause) {
        requestReadinessDestination(cause.action.destination);
      }
      setShowConsent(false);
      return;
    }

    const request = {
      revision: ++meetingStartRevisionRef.current,
      scopeGeneration: liveMeetingScopeRef.current.generation,
    };
    pendingMeetingStartRef.current = request;
    setIsMeetingStartPending(true);
    setMeetingStartFailure(null);
    const requestedOptions = { ...options };
    const prefill = pendingCalendarPrefill.current
      ? {
          ...pendingCalendarPrefill.current,
          attendees: [...pendingCalendarPrefill.current.attendees],
        }
      : null;
    const selectedTemplateId = requestedOptions.template ?? "auto";
    const notesAtRequest = latestLiveMeetingNotesRef.current;
    const shouldSeedTemplateOutline =
      !notesAtRequest.trim() && typeof requestedOptions.template === "string";
    const seededNotes = shouldSeedTemplateOutline
      ? buildMeetingTemplateOutline(requestedOptions.template!, customMeetingTemplates)
      : notesAtRequest;
    const requestStillOwnsScope = (startedId?: string | null) => {
      if (
        !workspaceMountedRef.current ||
        pendingMeetingStartRef.current !== request
      ) {
        return false;
      }
      const current = liveMeetingScopeRef.current;
      if (
        startedId &&
        current.isCaptureRecording &&
        current.recordingMode !== "dictation" &&
        current.recordingId === startedId
      ) {
        return true;
      }
      return current.generation === request.scopeGeneration;
    };
    let closeConsent = false;
    let acceptedStartedId: string | null = null;
    try {
      const startedId = await startMeeting({
        ...requestedOptions,
        projectId: "default",
        meetingNotes: seededNotes.trim() || undefined,
        detectedCallId: prefill?.detectedCallId ?? undefined,
        videoService: prefill?.videoService ?? undefined,
        joinConferenceUrl: prefill?.joinConferenceUrl,
        onJoinFailure: () => toast("Capture started. The meeting link could not open. Join from your calendar.", "error"),
      });
      if (startedId && requestStillOwnsScope(startedId)) {
        acceptedStartedId = startedId;
        setLiveMeetingNotes((current) =>
          current === notesAtRequest ? seededNotes : current,
        );
        setLiveMeetingTemplateId(selectedTemplateId);
        setLiveMeetingSystemAudio(requestedOptions.systemAudio);
        setLiveMeetingConsentShown(true);
        if (latestLiveMeetingNotesRef.current === notesAtRequest) {
          lastSavedLiveMeetingNotesRef.current = seededNotes;
        }
        closeConsent = true;
        // Name the recording after the calendar event that started it.
        //
        // Renaming after the fact rather than passing a title through
        // `start_recording` keeps this inside the renderer, and it composes
        // with auto-naming exactly as it should: the sidecar's
        // `auto_name_meeting_recording` only overwrites a PLACEHOLDER title,
        // so an event's name survives the analysis pass. A failure here loses
        // the name and nothing else, which is why it does not fail the start.
        if (prefill) {
          try {
            await renameRecording(startedId, prefill.title);
          } catch (error) {
            console.error("Failed to apply the calendar meeting title:", error);
          }
          // Same shape as the rename above: applied after the start, so a
          // failure costs the attendee list and nothing else. The meeting is
          // already recording by this point and must not be undone for it.
          if (prefill.attendees.length > 0) {
            try {
              await updateRecordingAttendees(startedId, prefill.attendees);
            } catch (error) {
              console.error("Failed to store the calendar attendee list:", error);
            }
          }
        }
        void refetch();
      }
    } catch (error) {
      if (!requestStillOwnsScope()) {
        return;
      }
      console.error("Failed to start recording:", error);
      const failure = describeMeetingStartFailure(error);
      // Said once, in the consent dialog that stays open (with its fix), and
      // in the banner behind it; a toast on top made three.
      setMeetingStartFailure(failure);
    } finally {
      if (pendingMeetingStartRef.current === request) {
        const shouldCloseConsent =
          closeConsent && requestStillOwnsScope(acceptedStartedId);
        pendingMeetingStartRef.current = null;
        if (workspaceMountedRef.current) {
          setIsMeetingStartPending(false);
          if (shouldCloseConsent) {
            setShowConsent(false);
          }
        }
      }
    }
  };

  /**
   * The one action a start failure offers. Each code resolves to exactly one
   * button; the old code appended advice to the message instead, which is how a
   * system-audio failure came to carry microphone-permission guidance.
   */
  const runMeetingStartAction = (failure: MeetingStartFailure) => {
    switch (failure.action.id) {
      case "open_microphone_settings":
        void openPermissionSettings("microphone");
        return;
      case "open_system_audio_settings":
        void openPermissionSettings("system_audio");
        return;
      case "open_audio_input_settings":
        requestReadinessDestination("transcription");
        return;
      case "open_storage_settings":
        requestSettingsTab("storage");
        return;
      case "open_security_settings":
        requestSettingsTab("security");
        return;
      case "open_models":
        requestReadinessDestination("models");
        return;
      case "retry":
        setMeetingStartFailure(null);
        setShowConsent(true);
        return;
      case "none":
        setMeetingStartFailure(null);
    }
  };

  const handleStopMeeting = async () => {
    const targetId = recordingId;
    if (!targetId || !isRecording || pendingMeetingStopsRef.current.has(targetId)) return;
    pendingMeetingStopsRef.current.add(targetId);
    setStoppingMeetingId(targetId);
    setMeetingStopError(null);
    if (recordingId && liveMeetingNotes.trim() !== lastSavedLiveMeetingNotesRef.current.trim()) {
      // The snapshot survives the ended-state buffer reset. Saving and stopping
      // run independently so a notes failure never keeps capture running.
      queueFinalNoteSnapshot(
        recordingId,
        liveMeetingNotes,
        lastSavedLiveMeetingNotesRef.current,
      );
    }
    try {
      await stopMeeting();
    } catch (error) {
      if (workspaceMountedRef.current && liveMeetingScopeRef.current.isRecording &&
          liveMeetingScopeRef.current.recordingId === targetId) {
        const message = plainMeetingProcessingMessage(
          error instanceof Error ? error.message : null,
          "Plainsong could not stop this meeting.",
        );
        setMeetingStopError({ recordingId: targetId, message });
        toast(message, "error");
      }
    } finally {
      pendingMeetingStopsRef.current.delete(targetId);
      if (workspaceMountedRef.current) setStoppingMeetingId((current) => current === targetId ? null : current);
    }
  };

  /**
   * Import an existing audio file as a meeting.
   *
   * There is no consent step: nobody is being recorded, the audio already
   * exists, and asking the reader to confirm a notice they cannot send to a
   * meeting that already happened would be theatre. The native picker itself
   * is the user gesture Electron requires.
   */
  const handleImportAudioFile = async () => {
    setIsImportingAudio(true);
    try {
      const imported = await importAudioFile();
      if (!imported) {
        // The picker was dismissed. Nothing happened, so say nothing.
        return;
      }
      await refetch();
      toast(
        `Importing ${imported.sourceFileName}. Transcription is running now.`,
        "success",
      );
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "Plainsong could not import that audio file.",
        "error",
      );
    } finally {
      setIsImportingAudio(false);
    }
  };

  const handleTogglePause = useCallback(async () => {
    const targetId = recordingId;
    if (!isRecording || !targetId || liveMeetingScopeRef.current.recordingId !== targetId ||
        !liveMeetingScopeRef.current.isRecording || pendingMeetingPausesRef.current.has(targetId) ||
        pendingMeetingStopsRef.current.has(targetId)) return;
    pendingMeetingPausesRef.current.add(targetId);
    const requestedPaused = !meetingPaused;
    setPausingMeeting({ recordingId: targetId, paused: requestedPaused });
    setMeetingPauseError(null);
    try {
      if (requestedPaused) {
        await pauseMeeting();
      } else {
        await resumeMeeting();
      }
    } catch (error) {
      if (workspaceMountedRef.current && liveMeetingScopeRef.current.isRecording &&
          liveMeetingScopeRef.current.recordingId === targetId &&
          liveMeetingScopeRef.current.meetingPaused !== requestedPaused) {
        const message = plainMeetingProcessingMessage(
          error instanceof Error ? error.message : null,
          meetingPaused ? "Plainsong could not resume this meeting." : "Plainsong could not pause this meeting.",
        );
        setMeetingPauseError({ recordingId: targetId, message });
        toast(message, "error");
      }
    } finally {
      pendingMeetingPausesRef.current.delete(targetId);
      if (workspaceMountedRef.current) setPausingMeeting((current) => current?.recordingId === targetId ? null : current);
    }
  }, [isRecording, recordingId, meetingPaused, pauseMeeting, resumeMeeting, toast]);

  // ⌘⇧P / Ctrl+Shift+P pauses and resumes the live meeting from anywhere in
  // this view, except while typing: the notes box is where the reader's
  // hands are during a meeting, and a shortcut must not fire out of it.
  useEffect(() => {
    if (!isRecording) return;
    const handleKeydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "p") return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      void handleTogglePause();
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [handleTogglePause, isRecording]);

  // The Record action on a call notification lands here: the consent
  // dialog opens with the call's name filled in, and nothing else happens
  // until the reader answers it.
  useEffect(() => {
    return subscribeCallCaptureRequests((request) => {
      const prefill = buildDetectedCallCapturePrefill(request);
      if (prefill) {
        openMeetingCaptureRef.current(meetingCapturePrefillFromDetectedCall(prefill));
      }
    });
  }, []);

  const handleRecordingClick = (recording: Recording) => {
    openMeetingWorkspace(recording);
  };

  const handleApplyTemplateOutline = () => {
    const outline = buildMeetingTemplateOutline(meetingTemplateId, customMeetingTemplates);
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
      // Explicit marker so the appended block reads back as its own section
      // instead of dissolving into whatever came before it.
      const nextBlock = `## ${heading}\n${trimmedBody}`;
      const trimmedCurrent = current.trim();
      if (!trimmedCurrent) {
        return nextBlock;
      }
      return `${current.trimEnd()}\n\n${nextBlock}`;
    });
  };

  const handleRenameSpeaker = async (
    speakerId: string,
    newName: string,
    remember?: boolean
  ) => {
    if (!selectedRecording) {
      const error = new Error("No recording is open for speaker renaming.");
      toast(error.message, "error");
      throw error;
    }

    const recordingId = selectedRecording.id;
    const workspaceEpoch = workspaceOpenRequestRef.current;
    const isCurrent = () =>
      workspaceMountedRef.current
      && workspaceOpenRequestRef.current === workspaceEpoch
      && selectedRecordingIdRef.current === recordingId;

    // Remembering needs a voice signature for this cluster, and only clusters
    // that have one appear in `speakerVoices`. A meeting diarized before the
    // feature was turned on has none, and the sidecar refuses -- which used to
    // mean the rename failed outright rather than falling back to the plain
    // one the reader actually asked for.
    const canRemember = Boolean(
      remember &&
        speakerVoicesRecordingId === recordingId &&
        speakerVoices[speakerId]
    );
    try {
      if (canRemember) {
        // One call: it renames the speaker through the same path below and
        // stores the voice, so the two can never disagree.
        await rememberSpeakerVoice({
          recordingId,
          speakerId,
          name: newName,
        });
      } else {
        await renameSpeaker(recordingId, speakerId, newName);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Couldn't rename this speaker.";
      if (isCurrent()) toast(message, "error");
      throw error;
    }

    if (!isCurrent()) return;
    setSpeakerNames((prev) => ({ ...prev, [speakerId]: newName }));
    // A rename clears the voice link and the "auto" marker in the sidecar,
    // so the header has to stop saying "auto" without a reload. That metadata
    // refresh is secondary: the name write has already committed.
    const refreshedVoices = await refreshSpeakerVoices(recordingId);
    if (isCurrent() && !refreshedVoices) {
      toast("Speaker name saved, but remembered-voice details could not refresh.", "info");
    }
  };

  const handleDeleteTranscriptSegments = async (
    segmentIds: string[],
    expectedSegments?: TranscriptDeleteExpectation[],
  ) => {
    if (!selectedRecording || segmentIds.length === 0) {
      return;
    }

    const recordingId = selectedRecording.id;
    const requestedSegmentIds = [...segmentIds];
    const workspaceEpoch = workspaceOpenRequestRef.current;
    const isCurrent = () =>
      workspaceMountedRef.current
      && workspaceOpenRequestRef.current === workspaceEpoch
      && selectedRecordingIdRef.current === recordingId;
    let removed: number;
    try {
      removed = expectedSegments
        ? await deleteTranscriptSegments(
            recordingId,
            requestedSegmentIds,
            expectedSegments.map((segment) => ({ ...segment })),
          )
        : await deleteTranscriptSegments(recordingId, requestedSegmentIds);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : typeof error === "string" ? error : "";
      const message = stripTransportPrefix(rawMessage) || "Couldn't remove that transcript text.";
      if (
        isCurrent() &&
        message === "Transcript changed. Review the current turn before deleting it."
      ) {
        try {
          await refreshTranscript(recordingId);
        } catch (refreshError) {
          console.error(
            "Failed to refresh transcript after guarded delete conflict:",
            refreshError,
          );
        }
      }
      if (isCurrent()) toast(message, "error");
      throw error;
    }
    if (removed <= 0) {
      const error = new Error(
        "Plainsong could not confirm that transcript text was removed. The original text is still shown."
      );
      if (isCurrent()) toast(error.message, "error");
      throw error;
    }

    if (isCurrent()) {
      setMeetingSummaryProvenance(null);
      setMeetingActionItemProvenance([]);
    }
    const refreshes = await Promise.allSettled([
      refreshSelectedRecording(recordingId),
      refreshTranscript(recordingId),
      refreshTranscriptDetails(recordingId),
      Promise.resolve().then(() => refetch()),
    ]);
    if (!isCurrent()) return;
    // A stored recording refresh may still carry the now-stale citations.
    // The transcript mutation invalidates them regardless of refresh outcome.
    setMeetingSummaryProvenance(null);
    setMeetingActionItemProvenance([]);
    if (refreshes.some((result) => result.status === "rejected")) {
      toast(
        removed === 1
          ? "Transcript section removed, but the meeting could not refresh. Reopen it to load the saved transcript."
          : `${removed} transcript sections removed, but the meeting could not refresh. Reopen it to load the saved transcript.`,
        "info"
      );
      return;
    }
    toast(
      removed === 1
        ? "Transcript section removed."
        : `${removed} transcript sections removed.`,
      "success"
    );
  };

  useEffect(() => {
    let cancelled = false;
    const availabilityEpoch = ++summaryUndoAvailabilityEpochRef.current;
    setSummaryUndo(null);
    if (!showRecordingDetail || !selectedRecording || isRefreshingSummary || isUndoingSummary) return;
    const recordingId = selectedRecording.id;
    void getSummaryRegenerationUndo(recordingId).then((result) => {
      if (!cancelled && availabilityEpoch === summaryUndoAvailabilityEpochRef.current && result.canUndo && result.undoToken) {
        setSummaryUndo({ recordingId, undoToken: result.undoToken });
      }
    }).catch(() => { /* Availability failure leaves the saved summary usable. */ });
    return () => { cancelled = true; };
  }, [showRecordingDetail, selectedRecording?.id, selectedRecording?.summary, isRefreshingSummary, isUndoingSummary, summaryManualSaveRevision]);

  const handleUndoSummary = async () => {
    if (!selectedRecording || summaryUndo?.recordingId !== selectedRecording.id ||
        isRefreshingSummary || isUndoingSummary || isEditingSummary ||
        meetingSummary.trim() !== lastSavedMeetingSummaryRef.current.trim()) return;
    const recordingId = selectedRecording.id;
    const requestToken = meetingSummaryRequestGuard.beginRequest(recordingId);
    setIsUndoingSummary(true);
    try {
      const restored = await undoSummaryRegeneration(recordingId, summaryUndo.undoToken);
      if (!meetingSummaryRequestGuard.isCurrent(requestToken)) return;
      const summary = restored.summary ?? "";
      lastSavedMeetingSummaryRef.current = summary;
      setUserEditedSummary(null);
      setMeetingSummary(summary);
      setMeetingSummaryProvenance(restored.summaryProvenance ? {
        summary,
        citations: restored.summaryProvenance.citations ?? [],
        grounded: restored.summaryProvenance.grounded !== false,
      } : null);
      setSelectedRecording((current) => current?.id === recordingId ? {
        ...current, summary: restored.summary, summaryProvenance: restored.summaryProvenance,
      } : current);
      setSummaryUndo(null);
      toast("Previous summary restored.", "success");
      void refetch();
    } catch (error) {
      if (meetingSummaryRequestGuard.isCurrent(requestToken)) {
        toast(error instanceof Error ? error.message : "Couldn't restore the previous summary.", "error");
      }
    } finally {
      if (meetingSummaryRequestGuard.isCurrent(requestToken)) setIsUndoingSummary(false);
    }
  };

  const handleRefreshSummary = async () => {
    if (!selectedRecording) {
      return;
    }

    const requestToken = meetingSummaryRequestGuard.beginRequest(selectedRecording.id);
    setIsRefreshingSummary(true);
    try {
      const result = await summarizeRecordingGrounded(selectedRecording.id);
      if (!meetingSummaryRequestGuard.isCurrent(requestToken)) {
        return;
      }
      const nextSummary = result.summary.trim();
      setMeetingSummary(nextSummary);
      // Keep the evidence beside the text it produced, so the recap can say
      // which transcript lines it came from — and admit when it has none.
      setMeetingSummaryProvenance({
        summary: nextSummary,
        citations: result.citations ?? [],
        grounded: result.grounded !== false,
      });
      lastSavedMeetingSummaryRef.current = nextSummary;
      setSelectedRecording((current) =>
        current?.id === selectedRecording.id
          ? { ...current, summary: nextSummary || undefined, summaryProvenance: result.provenance }
          : current
      );
      toast("Summary rewritten from this meeting.", "success");
    } catch (error) {
      if (!meetingSummaryRequestGuard.isCurrent(requestToken)) {
        return;
      }
      const message =
        error instanceof Error ? stripTransportPrefix(error.message) || "Couldn't rewrite the summary." : "Couldn't rewrite the summary.";
      toast(message, "error");
    } finally {
      if (meetingSummaryRequestGuard.isCurrent(requestToken)) {
        setIsRefreshingSummary(false);
      }
    }
  };

  const handleRefreshActionItems = async () => {
    if (!selectedRecording) {
      return;
    }

    const requestToken = meetingActionItemsRequestGuard.beginRequest(selectedRecording.id);
    setIsRefreshingActionItems(true);
    try {
      const result = await extractActionItemsGrounded(selectedRecording.id);
      if (!meetingActionItemsRequestGuard.isCurrent(requestToken)) {
        return;
      }
      const nextActionItems = normalizeActionItems(
        result.items.map((item) => formatGroundedActionItem(item))
      );
      const nextActionItemsText = actionItemsToText(nextActionItems);
      setMeetingActionItemsText(nextActionItemsText);
      setMeetingActionItemProvenance(
        result.items.map((item, index) => ({
          item: nextActionItems[index] ?? item.task,
          citations: item.citations ?? [],
          grounded: (item.grounded ?? result.grounded) !== false,
          evidence: item.evidence ?? null,
          unclear: item.unclear === true,
        }))
      );
      lastSavedMeetingActionItemsRef.current = JSON.stringify(nextActionItems);
      setSelectedRecording((current) =>
        current?.id === selectedRecording.id
          ? { ...current, actionItems: nextActionItems, actionItemsProvenance: result.provenance }
          : current
      );
      toast("Action items pulled from this meeting.", "success");
    } catch (error) {
      if (!meetingActionItemsRequestGuard.isCurrent(requestToken)) {
        return;
      }
      const message =
        error instanceof Error ? error.message : "Couldn't pull the action items.";
      toast(message, "error");
    } finally {
      if (meetingActionItemsRequestGuard.isCurrent(requestToken)) {
        setIsRefreshingActionItems(false);
      }
    }
  };

  // Two regenerations, kept apart on purpose: the plain one repeats what you
  // already asked for, and the other one changes the playbook first. Rolling
  // them into a single button forced a template picker onto every retry.
  //
  // The playbook is read from the stored recording by the summariser, so a
  // playbook change has to land before the request goes out — the 250ms
  // autosave is too late, and the model would answer with the old playbook.
  const runRegeneration = async (scope: RegenerateScope, templateId: string | null) => {
    if (!selectedRecording) {
      return;
    }

    // The undo snapshot must contain the text visible when replacement was
    // requested, including a draft still inside the autosave delay.
    if (isPreparingRegeneration) return;
    const startingPlaybook = visibleMeetingMetadata.current.template;
    const startingPlaybookRevision = playbookEditRevision.current;
    const preparationToken = meetingRegenerationRequestGuard.beginRequest(selectedRecording.id);
    setIsPreparingRegeneration(true);
    const recordingId = selectedRecording.id;
    if (analysisAutosaveTimer.current !== null) {
      window.clearTimeout(analysisAutosaveTimer.current);
      analysisAutosaveTimer.current = null;
    }
    try {
      await pendingAnalysisSaves.current.get(recordingId)?.catch(() => {});
      if (!meetingRegenerationRequestGuard.isCurrent(preparationToken)) return;
      const summary = meetingSummary.trim();
      const actionItems = actionItemsFromText(meetingActionItemsText);
      const actionsKey = JSON.stringify(actionItems);
      const summaryChanged = summary !== lastSavedMeetingSummaryRef.current.trim();
      const actionsChanged = actionsKey !== lastSavedMeetingActionItemsRef.current;
      if (summaryChanged || actionsChanged) {
        const save = updateRecordingAnalysis(recordingId, {
          ...(summaryChanged ? { summary: summary || null } : {}),
          ...(actionsChanged ? { actionItems } : {}),
        }).then(() => {});
        pendingAnalysisSaves.current.set(recordingId, save);
        await save;
        if (!meetingRegenerationRequestGuard.isCurrent(preparationToken)) return;
        if (summaryChanged) lastSavedMeetingSummaryRef.current = summary;
        if (actionsChanged) lastSavedMeetingActionItemsRef.current = actionsKey;
        setSelectedRecording((current) => current?.id === recordingId ? {
          ...current,
          ...(summaryChanged ? { summary: summary || undefined, summaryProvenance: undefined } : {}),
          ...(actionsChanged ? { actionItems, actionItemsProvenance: undefined } : {}),
        } : current);
      }
    } catch (error) {
      if (meetingRegenerationRequestGuard.isCurrent(preparationToken)) {
        toast(error instanceof Error ? error.message : "Couldn't save your draft, so nothing was regenerated.", "error");
      }
      return;
    } finally {
      if (meetingRegenerationRequestGuard.isCurrent(preparationToken)) setIsPreparingRegeneration(false);
    }

    if (playbookEditRevision.current !== startingPlaybookRevision || visibleMeetingMetadata.current.template !== startingPlaybook) return;
    const desiredPlaybook = templateId ?? startingPlaybook;
    if (desiredPlaybook !== lastSavedMeetingTemplateRef.current || meetingWorkspaceWriteChainsRef.current.has(selectedRecording.id)) {
      try {
        if (metadataAutosaveTimers.current.template !== null) {
          window.clearTimeout(metadataAutosaveTimers.current.template);
          metadataAutosaveTimers.current.template = null;
        }
        // Make the explicit choice the visible intent before its queued write,
        // so navigation cannot re-save the previous playbook while it finishes.
        visibleMeetingMetadata.current = { ...visibleMeetingMetadata.current, template: desiredPlaybook };
        setMeetingTemplateId(desiredPlaybook);
        await persistMeetingTemplate(selectedRecording.id, desiredPlaybook);
        if (!meetingRegenerationRequestGuard.isCurrent(preparationToken) || visibleMeetingMetadata.current.template !== desiredPlaybook || playbookEditRevision.current !== startingPlaybookRevision) return;
      } catch (error) {
        console.error("Failed to switch meeting playbook before regenerating:", error);
        toast(
          error instanceof Error
            ? error.message
            : "Couldn't switch the playbook, so nothing was regenerated.",
          "error"
        );
        return;
      }
    }

    if (scope === "summary") {
      await handleRefreshSummary();
      return;
    }
    await handleRefreshActionItems();
  };

  const requestRegeneration = (scope: RegenerateScope, templateId: string | null = null) => {
    const warning = describeRegenerateClobber({
      scope,
      summary: meetingSummary,
      actionItemsText: meetingActionItemsText,
      summaryAuthorship,
      actionItemsAuthorship,
      unattributedActionItems: unattributedActionItemCount,
    });

    if (warning) {
      setPendingRegenerate({ scope, templateId, warning });
      return;
    }

    void runRegeneration(scope, templateId);
  };

  useEffect(() => {
    const recordingId = selectedRecording?.id;
    const revision = ++enhancedDraftRevision.current;
    ++enhancedDraftSelectionEpoch.current;
    setEnhancedMeetingNotesDraft(null);
    setSavedEnhancedDraft(null);
    setEnhancedDraftRemovalStatus("idle");
    setEnhancedDraftRemovalError(null);
    setEnhancedDraftSaveStatus("unsaved");
    setEnhancedDraftSaveError(null);
    if (!recordingId || selectedRecording.sourceType !== "meeting") return;
    let active = true;
    const sourceNotes = selectedRecording.meetingNotes ?? "";
    const storageRevision = enhancedDraftStorageRevisions.current.get(recordingId) ?? 0;
    const storageIsCurrent = () => (enhancedDraftStorageRevisions.current.get(recordingId) ?? 0) === storageRevision;
    void (enhancedDraftWriteChains.current.get(recordingId) ?? Promise.resolve()).then(() => getMeetingEnhancedNoteDraft(recordingId)).then((draft) => {
      if (!active || selectedRecordingIdRef.current !== recordingId || !storageIsCurrent()) return;
      setSavedEnhancedDraft(draft ? { recordingId, revision } : null);
      if (enhancedDraftRevision.current !== revision || meetingNotesRef.current !== sourceNotes) return;
      setEnhancedMeetingNotesDraft(draft);
      setEnhancedDraftSaveStatus(draft ? "saved" : "unsaved");
    }).catch((error) => {
      if (!active || selectedRecordingIdRef.current !== recordingId || enhancedDraftRevision.current !== revision || !storageIsCurrent()) return;
      setEnhancedDraftSaveError(error instanceof Error ? error.message : "Couldn't load the saved draft.");
    });
    return () => { active = false; };
  }, [selectedRecording?.id]);

  const handleEnhanceMeetingNotes = async () => {
    if (!selectedRecording) {
      return;
    }

    ++enhancedDraftRevision.current;
    setEnhancedDraftSaveStatus("unsaved");
    setEnhancedDraftSaveError(null);
    const requestToken = meetingEnhanceRequestGuard.beginRequest(selectedRecording.id);
    setIsEnhancingMeetingNotes(true);
    try {
      if (!(await flushReviewNotesBeforeLeaving()) || !(await flushMeetingMetadataBeforeLeaving())) {
        throw new Error("Save your meeting notes and playbook before building a draft.");
      }
      if (!meetingEnhanceRequestGuard.isCurrent(requestToken)) return;
      const notesSnapshot = meetingNotesRef.current;
      const [summaryOutcome, actionItemsOutcome] = await Promise.allSettled([
        summarizeRecordingGrounded(selectedRecording.id, undefined, { persist: false }),
        extractActionItemsGrounded(selectedRecording.id, undefined, { persist: false }),
      ]);
      if (!meetingEnhanceRequestGuard.isCurrent(requestToken)) {
        return;
      }
      if (summaryOutcome.status === "rejected" && actionItemsOutcome.status === "rejected") {
        throw new Error(
          [...new Set([summaryOutcome.reason, actionItemsOutcome.reason]
            .map((reason) => (reason instanceof Error ? reason.message : String(reason))
              .replace(/^Error invoking remote method 'sidecar:invoke': (?:Error: )?/, "")
              .replace(/^Error: /, "")))].join("; ")
        );
      }

      const summaryResult =
        summaryOutcome.status === "fulfilled" ? summaryOutcome.value : null;
      const actionItemsResult =
        actionItemsOutcome.status === "fulfilled" ? actionItemsOutcome.value : null;
      const nextSummary = summaryResult?.summary.trim() ?? visibleAnalysisDraft.current.summary.trim();
      const nextActionItems = actionItemsResult
        ? normalizeActionItems(
            actionItemsResult.items.map((item) => formatGroundedActionItem(item))
          )
        : actionItemsFromText(visibleAnalysisDraft.current.actions);
      // The generated preview and saved draft are separate from written notes.
      const draftText = buildEnhancedMeetingNotesDraftText({
        summary: nextSummary,
        actionItems: nextActionItems,
        rawNotes: notesSnapshot,
      });
      setEnhancedMeetingNotesDraft({
        text: draftText,
        generatedAt: new Date().toISOString(),
        rawNotesSnapshot: notesSnapshot,
        summaryCitations:
          summaryResult?.citations ?? (visibleAnalysisDraft.current.summary === meetingSummary ? meetingSummaryProvenance?.citations ?? [] : []),
        actionItemCitations: actionItemsResult
          ? actionItemsResult.items.map((item, index) => ({
              label: nextActionItems[index] ?? item.task,
              citations: item.citations ?? [],
            }))
          : (visibleAnalysisDraft.current.actions === meetingActionItemsText ? meetingActionItemProvenance : []).map((entry) => ({
              label: entry.item,
              citations: entry.citations ?? [],
            })),
      });
      if (!summaryResult || !actionItemsResult) {
        const failedPart = summaryResult ? "action items" : "summary";
        toast(
          `Draft ready — but Plainsong could not redo the ${failedPart}, so what was already saved was kept.`,
          "info"
        );
      } else {
        toast("Draft ready.", "success");
      }
    } catch (error) {
      if (!meetingEnhanceRequestGuard.isCurrent(requestToken)) {
        return;
      }
      const message =
        error instanceof Error ? error.message : "Couldn't build the draft.";
      toast(message, "error");
    } finally {
      if (meetingEnhanceRequestGuard.isCurrent(requestToken)) {
        setIsEnhancingMeetingNotes(false);
      }
    }
  };

  const handleCopyEnhancedMeetingNotes = async () => {
    const draft = enhancedMeetingNotesDraft?.text.trim();
    if (!draft) {
      toast("There is no draft to copy yet.", "error");
      return;
    }

    try {
      await navigator.clipboard.writeText(draft);
      toast("Draft copied.", "success");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Couldn't copy the draft.";
      toast(message, "error");
    }
  };

  const handleSaveEnhancedMeetingNotes = async () => {
    if (!selectedRecording || !enhancedMeetingNotesDraft?.text.trim() || enhancedDraftSavePending.current.has(enhancedDraftRevision.current) || (enhancedDraftRemovalPending.current.has(selectedRecording.id) && savedEnhancedDraft?.revision === enhancedDraftRevision.current)) return;
    const recordingId = selectedRecording.id;
    const draft = enhancedMeetingNotesDraft;
    const revision = enhancedDraftRevision.current;
    const sourceNotes = meetingNotesRef.current;
    const selectionEpoch = enhancedDraftSelectionEpoch.current;
    const ownsRequest = () => enhancedDraftRevision.current === revision && selectedRecordingIdRef.current === recordingId;
    const isCurrent = () => ownsRequest() && meetingNotesRef.current === sourceNotes;
    enhancedDraftSavePending.current.add(revision);
    setEnhancedDraftSaveStatus("saving");
    setEnhancedDraftSaveError(null);
    try {
      if (sourceNotes !== draft.rawNotesSnapshot) {
        throw new Error("Your notes changed. Build a new draft before saving it.");
      }
      enhancedDraftStorageRevisions.current.set(recordingId, (enhancedDraftStorageRevisions.current.get(recordingId) ?? 0) + 1);
      // Save intents for one meeting reach storage in the same order they were requested.
      const priorWrite = enhancedDraftWriteChains.current.get(recordingId) ?? Promise.resolve();
      const write = priorWrite.then(() => saveMeetingEnhancedNoteDraft(recordingId, draft));
      const settledWrite = write.then(() => {}, () => {});
      enhancedDraftWriteChains.current.set(recordingId, settledWrite);
      void settledWrite.then(() => {
        if (enhancedDraftWriteChains.current.get(recordingId) === settledWrite) {
          enhancedDraftWriteChains.current.delete(recordingId);
          if (selectedRecordingIdRef.current === recordingId && enhancedDraftSelectionEpoch.current === selectionEpoch) {
            setSavedEnhancedDraft((current) => current ? { ...current } : current);
          }
        }
      });
      const saved = await write;
      if (selectedRecordingIdRef.current === recordingId && enhancedDraftSelectionEpoch.current === selectionEpoch) {
        setSavedEnhancedDraft({ recordingId, revision });
        setEnhancedDraftRemovalStatus("idle");
        setEnhancedDraftRemovalError(null);
      }
      if (!isCurrent()) return;
      setEnhancedMeetingNotesDraft(saved);
      setEnhancedDraftSaveStatus("saved");
      toast("AI draft saved separately.", "success");
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : "Couldn't save the AI draft.";
      setEnhancedDraftSaveStatus("error");
      setEnhancedDraftSaveError(message);
      toast(message, "error");
    } finally {
      enhancedDraftSavePending.current.delete(revision);
      if (ownsRequest() && !isCurrent()) {
        setEnhancedDraftSaveStatus("unsaved");
        setEnhancedDraftSaveError("Your notes changed while saving. Review this draft and build a new one before saving again.");
      }
    }
  };

  const handleRemoveEnhancedMeetingNotes = async () => {
    const saved = savedEnhancedDraft;
    if (!saved || selectedRecordingIdRef.current !== saved.recordingId || enhancedDraftRemovalPending.current.has(saved.recordingId) || enhancedDraftWriteChains.current.has(saved.recordingId)) return;
    const { recordingId, revision } = saved;
    const selectionEpoch = enhancedDraftSelectionEpoch.current;
    enhancedDraftRemovalPending.current.add(recordingId);
    enhancedDraftStorageRevisions.current.set(recordingId, (enhancedDraftStorageRevisions.current.get(recordingId) ?? 0) + 1);
    setEnhancedDraftRemovalStatus("removing");
    setEnhancedDraftRemovalError(null);
    const priorWrite = enhancedDraftWriteChains.current.get(recordingId) ?? Promise.resolve();
    const write = priorWrite.then(() => deleteMeetingEnhancedNoteDraft(recordingId));
    const settledWrite = write.then(() => {}, () => {});
    enhancedDraftWriteChains.current.set(recordingId, settledWrite);
    void settledWrite.then(() => {
      if (enhancedDraftWriteChains.current.get(recordingId) === settledWrite) enhancedDraftWriteChains.current.delete(recordingId);
    });
    try {
      await write;
      if (selectedRecordingIdRef.current !== recordingId || enhancedDraftSelectionEpoch.current !== selectionEpoch) return;
      setSavedEnhancedDraft((current) => current?.recordingId === recordingId && current.revision === revision ? null : current);
      if (enhancedDraftRevision.current === revision) {
        setEnhancedMeetingNotesDraft(null);
        setEnhancedDraftSaveStatus("unsaved");
        setEnhancedDraftSaveError(null);
      }
      setEnhancedDraftRemovalStatus("idle");
      toast("Saved AI draft removed.", "success");
    } catch (error) {
      if (selectedRecordingIdRef.current !== recordingId || enhancedDraftSelectionEpoch.current !== selectionEpoch) return;
      setEnhancedDraftRemovalStatus("error");
      setEnhancedDraftRemovalError(error instanceof Error ? error.message : "Couldn't remove the saved AI draft. Retry removal.");
    } finally {
      enhancedDraftRemovalPending.current.delete(recordingId);
    }
  };

  // Two separate actions on purpose: the recap is the thing you paste into a
  // chat window, the full record is the thing that carries the transcript. The
  // toast names which one left the app.
  const copyMeetingRecord = async (kind: "recap" | "fullRecord") => {
    const recordingId = selectedRecording?.id;
    const markdown = kind === "recap"
      ? selectedMeetingRecapMarkdown
      : selectedMeetingFullRecordMarkdown;
    if (!recordingId || !markdown.trim() || meetingRecordCopyPendingRef.current) {
      return;
    }

    const revision = meetingRecordCopySourceRef.current.revision;
    const isCurrent = () => {
      const current = meetingRecordCopySourceRef.current;
      return workspaceMountedRef.current
        && current.revision === revision
        && current.recordingId === recordingId
        && current[kind] === markdown;
    };
    if (!isCurrent()) return;
    meetingRecordCopyPendingRef.current = true;
    setMeetingRecordCopyPending(true);
    try {
      await navigator.clipboard.writeText(markdown);
      if (isCurrent()) {
        toast(
          kind === "recap"
            ? "Recap copied — summary, action items, and notes. No transcript."
            : "Full record copied — includes the verbatim transcript.",
          "success"
        );
      }
    } catch {
      if (isCurrent()) {
        toast(
          kind === "recap"
            ? "Could not copy the meeting recap. The meeting is still open so you can copy it manually and retry."
            : "Could not copy the full meeting record. The meeting is still open so you can copy it manually and retry.",
          "error"
        );
      }
    } finally {
      meetingRecordCopyPendingRef.current = false;
      if (workspaceMountedRef.current) {
        setMeetingRecordCopyPending(false);
      }
    }
  };

  const handleCopyMeetingRecap = async () => copyMeetingRecord("recap");

  const handleCopyMeetingFullRecord = async () => copyMeetingRecord("fullRecord");

  const handleCopyNotes = async () => {
    const recordingId = meetingNotesTargetId;
    const text = meetingNotes;
    if (!recordingId || recordingId !== selectedRecordingIdRef.current || !text.trim() || notesCopyPendingRef.current) return;
    const epoch = notesCopyEpochRef.current;
    const isCurrent = () => notesCopyMountedRef.current && epoch === notesCopyEpochRef.current &&
      recordingId === selectedRecordingIdRef.current && text === meetingNotesRef.current;
    notesCopyPendingRef.current = true;
    setNotesCopyPending(true);
    setNotesCopyFeedback(null);
    try {
      await navigator.clipboard.writeText(text);
      if (isCurrent()) setNotesCopyFeedback({ recordingId, text, error: false, message: "Notes copied." });
    } catch {
      if (isCurrent()) setNotesCopyFeedback({ recordingId, text, error: true,
        message: "Could not copy the notes. Select them and copy them manually." });
    } finally {
      notesCopyPendingRef.current = false;
      if (notesCopyMountedRef.current) setNotesCopyPending(false);
    }
  };

  const handleCopyMeetingText = async (args: {
    text: string;
    emptyMessage: string;
    successMessage: string;
    failureMessage: string;
  }) => {
    const trimmed = args.text.trim();
    if (!trimmed) {
      toast(args.emptyMessage, "error");
      return;
    }

    try {
      await navigator.clipboard.writeText(trimmed);
      toast(args.successMessage, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : args.failureMessage;
      toast(message, "error");
    }
  };

  const handleCopyMeetingFollowUp = async (text: string) => {
    await handleCopyMeetingText({
      text,
      emptyMessage: "Nothing to copy for the follow-up draft.",
      successMessage: "Follow-up draft copied.",
      failureMessage: "Failed to copy the follow-up draft.",
    });
  };

  const handleCopyMeetingRecall = async (text: string) => {
    await handleCopyMeetingText({
      text: meetingRecallReviewWarning ? `${meetingRecallReviewWarning}\n\n${text}` : text,
      emptyMessage: "There is no answer to copy yet.",
      successMessage: "Answer copied.",
      failureMessage: "Couldn't copy the answer.",
    });
  };

  const runMeetingRecall = async (promptOverride?: string) => {
    if (!selectedRecording || meetingRecallRunRef.current) {
      return;
    }

    const prompt = (promptOverride ?? meetingRecallQuery).trim();
    if (!prompt) {
      return;
    }

    const targetId = selectedRecording.id;
    const run = { runId: crypto.randomUUID(), recordingId: targetId, prompt, cancelRequested: false };
    meetingRecallRunRef.current = run;
    const request = meetingRecallRequestGuard.beginRequest(targetId);
    const queryRevision = meetingRecallQueryRevisionRef.current;
    const ownsRequest = () => meetingRecallRequestGuard.isCurrent(request) &&
      selectedRecordingIdRef.current === targetId && meetingRecallRunRef.current === run;
    const isCurrent = () => ownsRequest() && !run.cancelRequested;
    setMeetingRecallLoading(true);
    setMeetingRecallError(null);
    setMeetingRecallCancelStatus(null);

    try {
      const result = await askMemory(
        buildCrossMeetingRecallQuery({
          title: selectedRecording.title,
          summary: meetingSummary,
          actionItems: selectedMeetingActionItems,
          prompt,
        }),
        {
          excludeRecordingId: targetId,
          sourceType: "meeting",
          runId: run.runId,
          // Search for the question and this meeting's name, not the summary
          // and instructions around them (see ask_memory's searchQuery).
          searchQuery: `${selectedRecording.title.trim()}: ${prompt.trim()}`,
        },
      );
      if (!isCurrent()) return;
      setMeetingRecallPromptLabel(prompt);
      setMeetingRecallResponse(result.response);
      setMeetingRecallCitations(result.citations);
      setMeetingRecallGrounded(typeof result.grounded === "boolean" ? result.grounded : null);
      if (!promptOverride) {
        setMeetingRecallQuery((current) =>
          meetingRecallQueryRevisionRef.current === queryRevision ? "" : current,
        );
      }
    } catch (error) {
      if (!isCurrent()) return;
      setMeetingRecallError(
        error instanceof Error
          ? stripTransportPrefix(error.message)
          : "Couldn't answer from your earlier meetings."
      );
    } finally {
      if (ownsRequest()) {
        meetingRecallRunRef.current = null;
        setMeetingRecallLoading(false);
        setMeetingRecallCancelStatus(null);
      }
    }
  };

  const cancelMeetingRecall = async (runId: string) => {
    const run = meetingRecallRunRef.current;
    if (!run || run.runId !== runId || run.cancelRequested
      || selectedRecordingIdRef.current !== run.recordingId) return;
    run.cancelRequested = true;
    setMeetingRecallError(null);
    setMeetingRecallCancelStatus("Cancelling recall…");
    try {
      await cancelAnalysisRun(runId);
    } catch {
      if (meetingRecallRunRef.current === run && selectedRecordingIdRef.current === run.recordingId) {
        setMeetingRecallCancelStatus("Could not cancel immediately. Waiting for recall to finish.");
      }
    }
  };

  const handleExportMeetingArtifact = async (
    format: "markdown" | "text"
  ) => {
    if (!selectedRecording) {
      return;
    }

    const targetId = selectedRecording.id;
    const requestToken = meetingExportRequestGuard.beginRequest(targetId);
    const isCurrent = () => meetingExportRequestGuard.isCurrent(requestToken) &&
      selectedRecordingIdRef.current === targetId;
    setIsExportingMeeting(true);
    setLastMeetingExportPath(null);
    try {
      if (!(await flushReviewDraftsBeforeLeaving())) {
        if (isCurrent()) toast("Your changes are still saving. Keep this meeting open and try exporting again.", "error");
        return;
      }
      if (!isCurrent()) return;
      const result = await exportRecordingV2(targetId, format, {
        redactionLevel: MEETING_EXPORT_REDACTION_LEVEL,
        preview: false,
      });
      if (!isCurrent()) return;
      if (!result.exportPath) {
        throw new Error("Export did not return a file path.");
      }
      setLastMeetingExportPath(result.exportPath);
      toast(
        format === "text"
          ? "Plain-text export created."
          : "Markdown export created.",
        "success"
      );
    } catch (error) {
      if (!isCurrent()) return;
      const message =
        error instanceof Error ? error.message : "Couldn't export this meeting.";
      toast(message, "error");
    } finally {
      if (isCurrent()) setIsExportingMeeting(false);
    }
  };

  const handleOpenMeetingExport = async () => {
    if (!lastMeetingExportPath) {
      return;
    }

    try {
      await openExportPath(lastMeetingExportPath);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Couldn't open the exported file.";
      toast(message, "error");
    }
  };

  const handleRunDiarization = async () => {
    if (!selectedRecording || diarizationOperationRef.current) {
      return;
    }

    const recording = selectedRecording;
    const operation = {
      recordingId: recording.id,
      workspaceEpoch: workspaceOpenRequestRef.current,
      token: Symbol("diarization"),
    };
    const isCurrent = () =>
      workspaceMountedRef.current
      && diarizationOperationRef.current?.token === operation.token
      && workspaceOpenRequestRef.current === operation.workspaceEpoch
      && selectedRecordingIdRef.current === operation.recordingId;
    diarizationOperationRef.current = operation;
    setIsRunningDiarization(true);
    setDiarizationPendingRecordingId(recording.id);
    setDiarizationMessage(null);
    setDiarizationError(null);

    try {
      const available = await isDiarizationModelAvailable();
      if (!isCurrent()) return;
      if (!available) {
        void refreshSpeakerModelPlan();
        setDiarizationError({
          recordingId: recording.id,
          text: "No speaker model is downloaded, so who said what can't be labelled yet. Ask can still answer questions about what was said.",
        });
        return;
      }

      const result = await runDiarization(recording.id);
      if (!isCurrent()) return;
      await Promise.all([
        refreshSelectedRecording(recording.id),
        refreshTranscript(recording.id),
        refreshTranscriptDetails(recording.id),
        refreshSpeakerNames(recording.id),
        refreshSpeakerVoices(recording.id),
      ]);
      if (!isCurrent()) return;
      setDiarizationMessage({
        recordingId: recording.id,
        text: `Found ${result.speakers.length} speaker${result.speakers.length === 1 ? "" : "s"}.`,
      });
    } catch (error) {
      if (!isCurrent()) return;
      const msg = plainMeetingProcessingMessage(
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : null,
        "Couldn't identify speakers. Ask can still answer questions about this meeting.",
      );
      setDiarizationError({ recordingId: recording.id, text: msg });
    } finally {
      if (diarizationOperationRef.current?.token === operation.token) {
        diarizationOperationRef.current = null;
        if (workspaceMountedRef.current) {
          setIsRunningDiarization(false);
          setDiarizationPendingRecordingId(null);
        }
      }
    }
  };



  // The backend's failure is the actionable one ("Vault is locked. Unlock vault
  // before opening encrypted recordings."). Swallowing it behind a generic
  // toast left the user with no next step, so it is surfaced verbatim and, when
  // it is the locked vault, alongside the control that fixes it.
  const handlePlayAudio = async (recording: Recording) => {
    if (!recording.audioPath) {
      return;
    }
    setAudioPlaybackIssue(null);
    try {
      await openRecordingAudio(recording.id);
    } catch (err) {
      console.error("Failed to open audio file:", err);
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Couldn't open the audio file for this meeting.";
      setAudioPlaybackIssue({ recordingId: recording.id, message });
      toast(message, "error");
    }
  };

  const handleDeleteRecording = async () => {
    const target = showDeleteConfirm;
    if (!target || deletePendingRef.current) return;
    if (!canDeleteRecording(target)) {
      toast(
        target.status === "recording"
          ? "Stop the meeting before deleting it."
          : "Wait for meeting processing to finish before deleting it.",
        "error"
      );
      return;
    }
    const epoch = deleteDialogEpochRef.current;
    const isCurrentConfirmation = () =>
      workspaceMountedRef.current
      && deleteDialogEpochRef.current === epoch
      && showDeleteConfirmRef.current?.id === target.id;
    deletePendingRef.current = true;
    setDeletePending(true);
    setDeleteError(null);
    try {
      if (deletePublishedFile) await deleteRecording(target.id, true);
      else await deleteRecording(target.id);
      updateFinalNoteDrafts((drafts) => drafts.filter((draft) => draft.recordingId !== target.id));
      if (selectedRecordingIdRef.current === target.id) {
        workspaceOpenRequestRef.current += 1;
        if (analysisAutosaveTimer.current !== null) {
          window.clearTimeout(analysisAutosaveTimer.current);
          analysisAutosaveTimer.current = null;
        }
        for (const key of ["template", "chat"] as const) {
          const timer = metadataAutosaveTimers.current[key];
          if (timer !== null) window.clearTimeout(timer);
          metadataAutosaveTimers.current[key] = null;
        }
        meetingExportRequestGuard.setScope(null);
        meetingRecallRequestGuard.setScope(null);
        setIsExportingMeeting(false);
        setShowRecordingDetail(false);
        clearRecordingDetail();
        setMeetingNotesTargetId(null);
        setMeetingNotes("");
        setMeetingChatMessages([]);
        setLastMeetingExportPath(null);
        lastSavedMeetingNotesRef.current = "";
        lastSavedMeetingChatRef.current = "[]";
      }
      if (isCurrentConfirmation()) {
        ++deleteDialogEpochRef.current;
        // The control that opened the dialog (a row menu or the workspace
        // header) is gone with the meeting; focus lands on the list heading
        // instead of the page body.
        focusListAfterDeleteRef.current = true;
        setShowDeleteConfirm(null);
      }
      if (workspaceMountedRef.current) toast(`Deleted “${target.title}”.`, "success");
      try {
        await refetch();
      } catch (refreshError) {
        console.error("Meeting deleted, but the meeting list did not refresh:", refreshError);
        if (workspaceMountedRef.current) {
          toast("Meeting deleted, but the list could not refresh. Reload meetings to update the list.", "error");
        }
      }
    } catch (err) {
      console.error("Failed to delete recording:", err);
      if (isCurrentConfirmation()) {
        const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
        setDeleteError(message.trim() || "Deletion was not confirmed. Try again or close this dialog and refresh the list.");
      }
    } finally {
      deletePendingRef.current = false;
      if (workspaceMountedRef.current) setDeletePending(false);
    }
  };

  // Leaving the workspace is a navigation, not a dismissal: the same teardown
  // the dialog used to run on close, minus the modal.
  const flushAnalysisBeforeLeaving = useCallback(async () => {
    const snapshot = { ...analysisDraftFrameRef.current, baseSummary: lastSavedMeetingSummaryRef.current,
      baseActionsKey: lastSavedMeetingActionItemsRef.current };
    if (!snapshot.targetId) return true;
    if (analysisAutosaveTimer.current !== null) {
      window.clearTimeout(analysisAutosaveTimer.current);
      analysisAutosaveTimer.current = null;
    }
    try {
      await persistAnalysisDraft(snapshot);
      return analysisSaveTarget.current === snapshot.targetId
        && analysisDraftFrameRef.current.scope === snapshot.scope
        && analysisDraftFrameRef.current.summaryRevision === snapshot.summaryRevision
        && analysisDraftFrameRef.current.actionsRevision === snapshot.actionsRevision;
    } catch { return false; }
  }, [persistAnalysisDraft]);

  const retryAnalysisSave = () => {
    const scope = analysisDraftFrameRef.current.scope;
    if (analysisRetryRef.current?.scope === scope) return;
    const promise = flushAnalysisBeforeLeaving();
    const retry = { scope, promise };
    analysisRetryRef.current = retry;
    void promise.finally(() => { if (analysisRetryRef.current === retry) analysisRetryRef.current = null; });
  };

  const flushReviewNotesBeforeLeaving = useCallback(async () => {
    const targetId = meetingNotesTargetId;
    const notes = meetingNotesRef.current;
    if (targetId && notes.trim() !== lastSavedMeetingNotesRef.current.trim()) {
      const saved = await persistMeetingNotes({
        recordingId: targetId,
        notes,
        savedRef: lastSavedMeetingNotesRef,
        onRebase: setMeetingNotes,
        surface: "review",
        invalidateVisibleAnalysis: true,
      });
      // Keep the draft visible if saving fails or typing continues while it
      // saves. A completed request must not dismiss a different meeting.
      if (!saved || selectedRecordingIdRef.current !== targetId ||
          meetingNotesRef.current !== lastSavedMeetingNotesRef.current) {
        return false;
      }
    }
    return true;
  }, [meetingNotesTargetId, meetingNotes, persistMeetingNotes]);

  const flushLiveNotesBeforeLeaving = useCallback(async () => {
    if (!isRecording || !recordingId ||
        liveMeetingNotes.trim() === lastSavedLiveMeetingNotesRef.current.trim()) return true;
    const saved = await persistMeetingNotes({
      recordingId,
      notes: liveMeetingNotes,
      savedRef: lastSavedLiveMeetingNotesRef,
      onRebase: setLiveMeetingNotes,
      surface: "live",
    });
    return saved && latestLiveMeetingNotesRef.current === lastSavedLiveMeetingNotesRef.current;
  }, [isRecording, recordingId, liveMeetingNotes, persistMeetingNotes]);

  const flushMeetingMetadataBeforeLeaving = useCallback(async () => {
    const targetId = analysisSaveTarget.current;
    if (!targetId) return true;
    const draft = visibleMeetingMetadata.current;
    for (const key of ["template", "chat"] as const) {
      const timer = metadataAutosaveTimers.current[key];
      if (timer !== null) window.clearTimeout(timer);
      metadataAutosaveTimers.current[key] = null;
    }
    try {
      const waiting = meetingWorkspaceWriteChainsRef.current.get(targetId);
      await waiting;
      const matchesDraft = () => analysisSaveTarget.current === targetId &&
        visibleMeetingMetadata.current.template === draft.template && visibleMeetingMetadata.current.messagesKey === draft.messagesKey;
      // A newer queued autosave or edit must not be overwritten by this
      // navigation snapshot. Keep the workspace open while it finishes.
      const pending = meetingWorkspaceWriteChainsRef.current.get(targetId);
      if (!matchesDraft() || (pending && pending !== waiting)) return false;
      if (draft.template !== lastSavedMeetingTemplateRef.current) await persistMeetingTemplate(targetId, draft.template);
      if (!matchesDraft() || meetingWorkspaceWriteChainsRef.current.has(targetId) || lastSavedMeetingTemplateRef.current !== draft.template) return false;
      if (draft.messagesKey !== lastSavedMeetingChatRef.current) await persistMeetingChat(targetId, draft.messages);
      return matchesDraft() && !meetingWorkspaceWriteChainsRef.current.has(targetId) &&
        lastSavedMeetingTemplateRef.current === draft.template && lastSavedMeetingChatRef.current === draft.messagesKey;
    } catch (error) {
      console.error("Failed to save meeting metadata before navigation:", error);
      notifyAutosaveFailure("Template choices and chat history");
      return false;
    }
  }, [persistMeetingTemplate, persistMeetingChat, notifyAutosaveFailure]);

  const flushReviewDraftsBeforeLeaving = useCallback(async (allowRowMutation = false) => {
    if (actionRowInteractionRef.current && !allowRowMutation) {
      toast("Finish or cancel the task edit before leaving this meeting.", "error");
      return false;
    }
    const targetId = analysisSaveTarget.current;
    const startingMetadata = visibleMeetingMetadata.current;
    const enhancedDraftWrite = targetId ? enhancedDraftWriteChains.current.get(targetId) : undefined;
    if (isPreparingRegeneration) {
      meetingRegenerationRequestGuard.setScope(meetingNotesTargetId);
      setIsPreparingRegeneration(false);
    }
    const titleRevision = meetingTitleRef.current?.revision();
    if (meetingTitleRef.current && !(await meetingTitleRef.current.commit())) return false;
    await Promise.all([...finalNoteSavesRef.current.values()]);
    await enhancedDraftWrite;
    if (targetId && (selectedRecordingIdRef.current !== targetId || enhancedDraftWriteChains.current.has(targetId))) return false;
    if (targetId) await meetingWorkspaceWriteChainsRef.current.get(targetId);
    if (analysisSaveTarget.current !== targetId ||
        visibleMeetingMetadata.current.template !== startingMetadata.template ||
        visibleMeetingMetadata.current.messagesKey !== startingMetadata.messagesKey) return false;
    if (finalNoteDraftsRef.current.some((draft) => !draft.journaled)) return false;
    if (!(await flushLiveNotesBeforeLeaving())) return false;
    if (!(await flushReviewNotesBeforeLeaving())) return false;
    if (!(await flushMeetingMetadataBeforeLeaving())) return false;
    if (!(await flushAnalysisBeforeLeaving())) return false;
    return (allowRowMutation || !actionRowInteractionRef.current)
      && analysisSaveTarget.current === targetId && meetingTitleRef.current?.revision() === titleRevision
      && (!targetId || !enhancedDraftWriteChains.current.has(targetId));
  }, [isPreparingRegeneration, meetingRegenerationRequestGuard, meetingNotesTargetId,
    flushLiveNotesBeforeLeaving, flushReviewNotesBeforeLeaving, flushMeetingMetadataBeforeLeaving, flushAnalysisBeforeLeaving, toast]);

  useEffect(() => registerViewLeaveGuard("recordings", flushReviewDraftsBeforeLeaving),
    [flushReviewDraftsBeforeLeaving]);

  const switchMeetingWorkspace = async (recording: Recording, dialogIsCurrent: () => boolean) => {
    if (!showRecordingDetail || !selectedRecording || recording.sourceType !== "meeting") return false;
    if (recording.id === selectedRecording.id) return true;
    const currentId = selectedRecording.id;
    const request = ++workspaceOpenRequestRef.current;
    const isCurrent = () => workspaceMountedRef.current
      && workspaceOpenRequestRef.current === request
      && selectedRecordingIdRef.current === currentId
      && dialogIsCurrent();
    if (!(await flushReviewDraftsBeforeLeaving()) || !isCurrent()) return false;
    openMeetingWorkspace(recording);
    return true;
  };

  const closeMeetingWorkspace = async () => {
    workspaceOpenRequestRef.current += 1;
    const hasUnsavedDraft = meetingNotesTargetId && (
      meetingNotes.trim() !== lastSavedMeetingNotesRef.current.trim() ||
      meetingSummary.trim() !== lastSavedMeetingSummaryRef.current.trim() ||
      JSON.stringify(actionItemsFromText(meetingActionItemsText)) !== lastSavedMeetingActionItemsRef.current ||
      visibleMeetingMetadata.current.template !== lastSavedMeetingTemplateRef.current ||
      visibleMeetingMetadata.current.messagesKey !== lastSavedMeetingChatRef.current ||
      meetingWorkspaceWriteChainsRef.current.has(meetingNotesTargetId)
    );
    if ((actionRowInteractionRef.current || hasUnsavedDraft || meetingTitleRef.current) && !(await flushReviewDraftsBeforeLeaving())) return;
    meetingExportRequestGuard.setScope(null);
    meetingRecallRequestGuard.setScope(null);
    setIsExportingMeeting(false);
    setShowRecordingDetail(false);
    clearRecordingDetail();
    setTranscriptSourceNavigation(undefined);
    setSearchQuery("");
    // The failure belonged to the meeting being left. Kept, it would surface
    // again on the list, detached from the click that caused it.
    setAudioPlaybackIssue(null);
    setDiarizationMessage(null);
    setDiarizationError(null);
    setPendingRegenerate(null);
    setIsEditingSummary(false);
    setIsEditingActionItems(false);
    if (!isRecording) {
      setMeetingNotesTargetId(null);
      setMeetingNotes("");
      setMeetingChatMessages([]);
      setLastMeetingExportPath(null);
      lastSavedMeetingNotesRef.current = "";
      lastSavedMeetingChatRef.current = "[]";
    }
  };

  // The title is edited where it is read, in the workspace header. It is the
  // same write the row's Rename dialog performs.
  const handleAttendeesChange = async (next: MeetingAttendee[]) => {
    if (!selectedRecording) {
      return;
    }
    const recordingId = selectedRecording.id;
    try {
      // Render what the sidecar stored, not what was sent: it sanitizes the
      // list (duplicates dropped, fields clipped) and the header must show
      // the version that is actually on disk.
      const stored = await updateRecordingAttendees(recordingId, next);
      setSelectedRecording((current) =>
        current?.id === recordingId ? { ...current, attendees: stored } : current,
      );
    } catch (error) {
      console.error("Failed to update the attendee list:", error);
      toast("Couldn't save that attendee change.", "error");
    }
  };

  const handleRenameMeetingTitle = async (nextTitle: string) => {
    if (!selectedRecording) {
      return;
    }

    const recordingId = selectedRecording.id;
    try {
      await enqueueMeetingWorkspaceWrite(recordingId, async () => {
        await renameRecording(recordingId, nextTitle);
        setSelectedRecording((current) =>
          current?.id === recordingId ? { ...current, title: nextTitle } : current
        );
      });
      void refetch();
    } catch (error) {
      console.error("Failed to rename meeting:", error);
      toast("Couldn't save that title.", "error");
      throw error;
    }
  };

  const handleRenameRecording = async () => {
    if (!showRenameDialog || !renameValue.trim() || renamePendingRef.current) return;
    const targetId = showRenameDialog.id;
    const title = renameValue.trim();
    const epoch = renameDialogEpochRef.current;
    const isCurrent = () => renameMountedRef.current && renameDialogEpochRef.current === epoch;
    renamePendingRef.current = true;
    setRenamePendingEpoch(epoch);
    setRenameError(null);
    try {
      await enqueueMeetingWorkspaceWrite(targetId, async () => {
        await renameRecording(targetId, title);
        if (renameMountedRef.current) {
          setSelectedRecording((current) => current?.id === targetId ? { ...current, title } : current);
        }
      });
      if (!renameMountedRef.current) return;
      void refetch();
      if (isCurrent()) closeRenameDialog();
    } catch (err) {
      console.error("Failed to rename recording:", err);
      if (isCurrent()) {
        setRenameError("Could not save the title. Your edit is still here. Try again.");
      }
    } finally {
      renamePendingRef.current = false;
      if (renameMountedRef.current) setRenamePendingEpoch(null);
    }
  };

  // Every segment is always rendered. Search highlights in place instead of
  // filtering, because a filtered-to-nothing transcript rendered the viewer's
  // "No transcript available" empty state and read as data loss.
  // Memoised so an empty transcript does not hand the viewer a fresh array on
  // every render, which would re-fire its match callback in a loop.
  const transcriptSegments = useMemo(
    () => selectedTranscript?.segments ?? [],
    [selectedTranscript]
  );

  const stepTranscriptMatch = useCallback(
    (direction: 1 | -1) => {
      if (transcriptMatches.length === 0) {
        return;
      }
      const nextIndex =
        (activeTranscriptMatchIndex + direction + transcriptMatches.length) %
        transcriptMatches.length;
      setActiveTranscriptMatchIndex(nextIndex);
      playhead.set(transcriptMatches[nextIndex].startTime);
    },
    [activeTranscriptMatchIndex, transcriptMatches]
  );

  const handleTranscriptMatchesChange = useCallback((matches: TranscriptMatch[]) => {
    // Keep the existing array when the hits are unchanged, so an equal-but-new
    // list can never bounce state back and forth with the viewer.
    setTranscriptMatches((current) =>
      current.length === matches.length &&
      current.every(
        (entry, index) =>
          entry.segmentId === matches[index].segmentId &&
          entry.startTime === matches[index].startTime
      )
        ? current
        : matches
    );
    // A parked deep-link moment claims the nearest hit the moment there are
    // hits to choose from, and is spent once — later searches in this meeting
    // are the reader's own and start at the top.
    const focusTime = pendingMatchFocusTimeRef.current;
    if (focusTime !== null && matches.length > 0) {
      pendingMatchFocusTimeRef.current = null;
      let nearest = 0;
      for (let index = 1; index < matches.length; index += 1) {
        if (
          Math.abs(matches[index].startTime - focusTime) <
          Math.abs(matches[nearest].startTime - focusTime)
        ) {
          nearest = index;
        }
      }
      setActiveTranscriptMatchIndex(nearest);
      return;
    }
    setActiveTranscriptMatchIndex((current) =>
      current < matches.length ? current : 0
    );
  }, []);

  const hasSpeakerLabels = useMemo(
    () => Boolean(selectedTranscript?.segments.some((segment) => Boolean(segment.speakerId))),
    [selectedTranscript]
  );
  // The speakers panel is about to show: learn whether a speaker model is on
  // this Mac, so it offers the download rather than a run that cannot start.
  const speakerPanelRecordingId =
    selectedTranscript
    && (!hasSpeakerLabels || selectedTranscriptDetails?.hasSourceAwareSpeakers === false)
      ? selectedRecording?.id ?? null
      : null;
  useEffect(() => {
    if (speakerPanelRecordingId) void refreshSpeakerModelPlan();
  }, [speakerPanelRecordingId, selectedTranscript, refreshSpeakerModelPlan]);
  const selectedTranscriptProvenance = useMemo(
    () =>
      describeTranscriptProvenance(
        selectedTranscriptDetails?.actualProvider ?? selectedTranscript?.actualProvider
      ),
    [selectedTranscript?.actualProvider, selectedTranscriptDetails?.actualProvider]
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
  const meetingSearchScopeKey = useMemo(
    () =>
      meetings
        .map((meeting) => `${meeting.id}:${meeting.status}:${meeting.updatedAt}`)
        .sort()
        .join("|"),
    [meetings]
  );
  meetingSearchScopeKeyRef.current = meetingSearchScopeKey;
  const activeMeeting = useMemo(
    () => meetings.find((meeting) => meeting.id === recordingId) ?? null,
    [meetings, recordingId]
  );
  // The meeting on screen is the one being captured right now.
  const isLiveSelectedMeeting = selectedRecording?.id === recordingId && isRecording;
  const runMeetingTranscriptSearch = useCallback(
    (
      query: string,
      revision: number,
      status: MeetingSearchStatus,
      scopeKey: string,
    ) => {
      const pending = pendingMeetingSearchRef.current;
      if (
        pending?.query === query &&
        pending.revision === revision &&
        pending.status === status &&
        pending.scopeKey === scopeKey
      ) {
        return;
      }

      const request = { query, revision, status, scopeKey };
      pendingMeetingSearchRef.current = request;
      setMeetingSearchHits([]);
      setMeetingSearchError(null);
      setMeetingSearchResultQuery(null);
      setMeetingSearchResultStatus(null);
      setMeetingSearchResultScopeKey(null);
      setIsSearchingMeetingTranscripts(true);
      void searchTranscripts(
        query,
        25,
        undefined,
        "meeting",
        status === "all" ? undefined : status,
      )
        .then((hits) => {
          if (
            meetingSearchRevisionRef.current !== revision ||
            meetingSearchQueryRef.current !== query ||
            meetingSearchStatusRef.current !== status ||
            meetingSearchScopeKeyRef.current !== scopeKey
          ) {
            return;
          }
          setMeetingSearchHits(hits);
          setMeetingSearchError(null);
          setMeetingSearchResultQuery(query);
          setMeetingSearchResultStatus(status);
          setMeetingSearchResultScopeKey(scopeKey);
        })
        .catch((error) => {
          if (
            meetingSearchRevisionRef.current !== revision ||
            meetingSearchQueryRef.current !== query ||
            meetingSearchStatusRef.current !== status ||
            meetingSearchScopeKeyRef.current !== scopeKey
          ) {
            return;
          }
          console.error("Failed to search meeting transcripts:", error);
          setMeetingSearchHits([]);
          setMeetingSearchError(
            userFacingErrorMessage(error, "Transcript search is unavailable. Titles, notes, summaries, and action items are still searched.")
          );
          setMeetingSearchResultQuery(query);
          setMeetingSearchResultStatus(status);
          setMeetingSearchResultScopeKey(scopeKey);
        })
        .finally(() => {
          if (pendingMeetingSearchRef.current === request) {
            pendingMeetingSearchRef.current = null;
          }
          if (
            meetingSearchRevisionRef.current === revision &&
            meetingSearchQueryRef.current === query &&
            meetingSearchStatusRef.current === status &&
            meetingSearchScopeKeyRef.current === scopeKey
          ) {
            setIsSearchingMeetingTranscripts(false);
          }
        });
    },
    []
  );
  // Transcript bodies are not held in the meetings list, so the FTS index does
  // that half. Debounced so typing does not fire a query per keystroke.
  useEffect(() => {
    const query = meetingSearch.trim();
    const revision = meetingSearchRevisionRef.current;
    const status = statusFilter;
    const scopeKey = meetingSearchScopeKey;
    if (query.length < 2) {
      setMeetingSearchHits([]);
      setMeetingSearchError(null);
      setMeetingSearchResultQuery(null);
      setMeetingSearchResultStatus(null);
      setMeetingSearchResultScopeKey(null);
      setIsSearchingMeetingTranscripts(false);
      return;
    }

    setIsSearchingMeetingTranscripts(true);
    const timeoutId = window.setTimeout(() => {
      runMeetingTranscriptSearch(query, revision, status, scopeKey);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
      if (meetingSearchRevisionRef.current === revision) {
        meetingSearchRevisionRef.current += 1;
      }
    };
  }, [meetingSearch, meetingSearchScopeKey, runMeetingTranscriptSearch, statusFilter]);

  // Only transcript hits that belong to a meeting, and only while the query
  // they were fetched for is still the one on screen.
  const meetingTranscriptHits = useMemo(() => {
    const query = meetingSearch.trim();
    if (
      query.length < 2 ||
      meetingSearchResultQuery !== query ||
      meetingSearchResultStatus !== statusFilter ||
      meetingSearchResultScopeKey !== meetingSearchScopeKey
    ) {
      return [] as Array<SearchHit & { recording: Recording }>;
    }
    return meetingSearchHits.flatMap((hit) => {
      const recording = meetings.find((meeting) => meeting.id === hit.recordingId);
      return recording &&
        (statusFilter === "all" || recording.status === statusFilter)
        ? [{ ...hit, recording }]
        : [];
    });
  }, [
    meetingSearch,
    meetingSearchHits,
    meetingSearchResultQuery,
    meetingSearchResultScopeKey,
    meetingSearchResultStatus,
    meetingSearchScopeKey,
    meetings,
    statusFilter,
  ]);

  const filteredMeetings = useMemo(() => {
    const query = meetingSearch.trim().toLowerCase();
    const transcriptMatchIds = new Set(meetingTranscriptHits.map((hit) => hit.recordingId));
    return meetings
      .filter((meeting) => {
        if (statusFilter !== "all" && meeting.status !== statusFilter) {
          return false;
        }
        if (!query) return true;
        if (transcriptMatchIds.has(meeting.id)) return true;
        // Everything the meeting record itself carries — not just the title and
        // a formatted date, which is all this used to look at.
        const haystack = [
          meeting.title,
          formatDateTime(meeting.createdAt),
          meeting.meetingNotes ?? "",
          meeting.summary ?? "",
          ...(meeting.actionItems ?? []),
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [meetingSearch, meetingTranscriptHits, meetings, statusFilter]);
  const activeMeetingSearchQuery = meetingSearch.trim();
  const meetingTranscriptSearchOwnershipMatches =
    meetingSearchResultQuery === activeMeetingSearchQuery &&
    meetingSearchResultStatus === statusFilter &&
    meetingSearchResultScopeKey === meetingSearchScopeKey;
  const meetingTranscriptSearchPending =
    activeMeetingSearchQuery.length >= 2 &&
    (isSearchingMeetingTranscripts || !meetingTranscriptSearchOwnershipMatches);
  const currentMeetingTranscriptSearchFailed =
    activeMeetingSearchQuery.length >= 2 &&
    meetingTranscriptSearchOwnershipMatches &&
    Boolean(meetingSearchError);

  // Rows that look like dictations, among the ones listed. The move-them
  // banner shows only when there is at least one; the blanket "move all
  // listed" lives in the list's overflow menu.
  const suspectedDictations = useMemo(
    () => filteredMeetings.filter(looksLikeMisfiledDictation),
    [filteredMeetings]
  );

  // The list waits, invisibly and briefly, for the header's banners to land,
  // so it appears once in place instead of jumping down as each one arrives.
  const listSettled = useSettledReveal(
    (recordingsHaveLoaded || Boolean(recordingsError)) &&
      meetingsReadiness.state !== "unknown",
    listHeaderRef,
  );

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
    () => getMeetingTemplateOption(meetingTemplateId, customMeetingTemplates),
    [meetingTemplateId, customMeetingTemplates]
  );
  const sectionStructureKey = JSON.stringify(selectedTemplateOption.notesOutline);
  useEffect(() => {
    setSectionTitleDrafts({});
    setSectionBodyDrafts({});
    setMeetingNotesState((current) => current.undo.length || current.notice
      ? { ...current, undo: [], notice: null } : current);
  }, [meetingNotesTargetId, meetingTemplateId, sectionStructureKey]);
  const lastSectionUndo = meetingNotesState.undo[meetingNotesState.undo.length - 1];
  const visibleSectionUndo = lastSectionUndo?.recordingId === meetingNotesTargetId
    && lastSectionUndo?.recordingId === selectedRecording?.id
    && lastSectionUndo?.templateId === meetingTemplateId
    && lastSectionUndo?.structureKey === sectionStructureKey ? lastSectionUndo : null;
  const liveMeetingTemplateOption = useMemo(
    () => getMeetingTemplateOption(liveMeetingTemplateId, customMeetingTemplates),
    [liveMeetingTemplateId, customMeetingTemplates]
  );
  const meetingNoteSections = useMemo(
    () => parseMeetingNoteSections(meetingNotes, meetingTemplateId, customMeetingTemplates),
    [meetingNotes, meetingTemplateId, customMeetingTemplates]
  );

  /** What "Save current structure as a template" actually captures: the
   * headings the notes are organized under right now -- not the static
   * playbook outline, which would silently discard any section the user
   * added, removed, or renamed by hand. Falls back to the playbook outline
   * only when there is no note text to derive a structure from. */
  const buildTemplateSaveSeed = (): MeetingTemplateDraft => {
    const seenTitles = new Set<string>();
    const outlineFromNotes: string[] = [];
    if (meetingNotes.trim()) {
      for (const section of meetingNoteSections) {
        const title = section.title.trim();
        const key = title.toLowerCase();
        // "General notes" is the catch-all for text with no heading, not a
        // reusable outline section, so it never becomes one.
        if (!title || title === GENERAL_MEETING_NOTES_TITLE || seenTitles.has(key)) {
          continue;
        }
        seenTitles.add(key);
        outlineFromNotes.push(title);
      }
    }
    return {
      name: "",
      summaryPrompt: selectedTemplateOption.summaryPrompt,
      notesOutline:
        outlineFromNotes.length > 0 ? outlineFromNotes : selectedTemplateOption.notesOutline,
    };
  };

  const activeMeetingCaptureMode = useMemo(
    () =>
      resolveRecordingCaptureMode(activeMeeting, null, liveMeetingSystemAudio),
    [activeMeeting, liveMeetingSystemAudio]
  );
  // Which diarizer produced the speaker badges, from what was recorded when
  // they were written -- never inferred from the ASR provider, because a
  // provider-diarization attempt that fell back to the local pipeline would
  // then be credited to the provider.
  const selectedMeetingDiarizer = useMemo(
    () => describeMeetingDiarizer(selectedTranscriptDetails),
    [selectedTranscriptDetails]
  );
  const selectedMeetingDiarizerDetail = useMemo(
    () => describeMeetingDiarizerDetail(selectedTranscriptDetails),
    [selectedTranscriptDetails]
  );

  const selectedMeetingCaptureMode = useMemo(
    () =>
      resolveRecordingCaptureMode(
        selectedRecording,
        selectedTranscriptDetails,
        selectedRecording?.id === recordingId ? liveMeetingSystemAudio : false
      ),
    [liveMeetingSystemAudio, recordingId, selectedRecording, selectedTranscriptDetails]
  );
  const selectedMeetingAssetRetention = useMemo(
    () => describeMeetingAssetRetention(selectedRecording),
    [selectedRecording]
  );
  const deleteConfirmationRetention = useMemo(
    () => describeMeetingAssetRetention(showDeleteConfirm),
    [showDeleteConfirm]
  );
  const selectedMeetingActionItems = useMemo(
    () => actionItemsFromText(meetingActionItemsText),
    [meetingActionItemsText]
  );
  const completedMeetingTasks = actionCompletion?.recordingId === selectedRecording?.id
    ? actionCompletion?.tasks : undefined;
  useEffect(() => {
    const id = selectedRecording?.id ?? null;
    const token = actionCompletionRequestGuard.beginRequest(id);
    setActionCompletion(null);
    setActionTaskFilter("all");
    setActionCompletionError(null);
    setSavingActionCompletion(false);
    if (id) {
      void getMeetingActionCompletion(id).then((result) => {
        if (!actionCompletionRequestGuard.isCurrent(token)) return;
        setActionCompletion({ recordingId: id, tasks: new Set(result.completedTasks) });
      }).catch(() => {
        if (actionCompletionRequestGuard.isCurrent(token)) {
          setActionCompletionError("Couldn't load task checkmarks. Reopen this meeting to try again.");
        }
      });
    }
    return () => actionCompletionRequestGuard.setScope(null);
  }, [selectedRecording?.id, actionCompletionRequestGuard]);
  const changeActionCompletion = useCallback(async (task: string, completed: boolean) => {
    const id = selectedRecordingIdRef.current;
    if (!id || actionCompletionPendingRef.current?.recordingId === id || actionCompletion?.recordingId !== id) return;
    const token = actionCompletionRequestGuard.beginRequest(id);
    const pending = { recordingId: id };
    actionCompletionPendingRef.current = pending;
    setSavingActionCompletion(true);
    setActionCompletionError(null);
    try {
      const saved = await flushReviewDraftsBeforeLeaving();
      if (selectedRecordingIdRef.current !== id || !actionCompletionRequestGuard.isCurrent(token)) return;
      if (!saved) {
        setActionCompletionError("Save your meeting edits before changing a checkmark.");
        return;
      }
      const result = await setMeetingActionCompleted(id, task, completed);
      if (selectedRecordingIdRef.current !== id || !actionCompletionRequestGuard.isCurrent(token)) return;
      setActionCompletion({ recordingId: id, tasks: new Set(result.completedTasks) });
    } catch {
      if (actionCompletionRequestGuard.isCurrent(token)) {
        setActionCompletionError("Couldn't save this checkmark. Your task text is unchanged. Try again.");
      }
    } finally {
      if (actionCompletionPendingRef.current === pending) actionCompletionPendingRef.current = null;
      if (actionCompletionRequestGuard.isCurrent(token)) setSavingActionCompletion(false);
    }
  }, [actionCompletion, actionCompletionRequestGuard, flushReviewDraftsBeforeLeaving]);
  const mutateActionRow = useCallback(async (original: string | null, replacement: string | null, sourceIndex?: number) => {
    const id = selectedRecordingIdRef.current;
    if (!id || actionCompletionPendingRef.current?.recordingId === id) throw new Error("A task change is already saving. Try again.");
    const expectedItems = actionItemsFromText(visibleAnalysisDraft.current.actions);
    const index = original === null ? -1 : sourceIndex ?? expectedItems.indexOf(original);
    if (original !== null && (index < 0 || expectedItems[index] !== original)) throw new Error("Tasks changed. Review the latest tasks. Your draft was kept.");
    const token = actionCompletionRequestGuard.beginRequest(id);
    const pending = { recordingId: id };
    actionCompletionPendingRef.current = pending;
    setSavingActionCompletion(true);
    try {
      if (!await flushReviewDraftsBeforeLeaving(true)) throw new Error("Save your meeting edits before editing this task.");
      if (selectedRecordingIdRef.current !== id || !actionCompletionRequestGuard.isCurrent(token)) throw new Error("The meeting changed. Reopen the task editor.");
      const result = original === null
        ? await addMeetingAction(id, expectedItems, replacement ?? "")
        : replacement === null
          ? await deleteMeetingAction(id, expectedItems, index)
          : await editMeetingAction(id, expectedItems, index, replacement);
      if (selectedRecordingIdRef.current !== id || !actionCompletionRequestGuard.isCurrent(token)) return;
      if (original === null) setActionTaskFilter("all");
      const nextText = actionItemsToText(result.recording.actionItems);
      lastSavedMeetingActionItemsRef.current = JSON.stringify(result.recording.actionItems ?? []);
      visibleAnalysisDraft.current.actions = nextText;
      setMeetingActionItemsText(nextText);
      setUserEditedActionItemsText(nextText);
      setMeetingActionItemProvenance((result.recording.actionItems ?? []).map((item, itemIndex) => {
        const provenance = result.recording.actionItemsProvenance?.items[itemIndex];
        return {
          item,
          citations: provenance && provenance.generated !== false ? provenance.citations : null,
          grounded: provenance?.generated !== false && provenance?.grounded === true,
          evidence: generatedEvidence(provenance),
          unclear: generatedUnclear(provenance),
        };
      }));
      setActionCompletion({ recordingId: id, tasks: new Set(result.completedTasks) });
      setSelectedRecording((current) => mergeMeetingActionFields(current, result.recording));
      void refetch();
    } catch (error) {
      if (error instanceof Error && error.message.includes("Tasks changed")) {
        try {
          const latest = await getRecording(id);
          const completion = await getMeetingActionCompletion(id);
          if (latest && selectedRecordingIdRef.current === id && actionCompletionRequestGuard.isCurrent(token)) {
            setSelectedRecording((current) => mergeMeetingActionFields(current, latest));
            setActionCompletion({ recordingId: id, tasks: new Set(completion.completedTasks) });
          }
        } catch { /* Keep the row draft when refreshing also fails. */ }
      }
      throw error;
    } finally {
      if (actionCompletionPendingRef.current === pending) actionCompletionPendingRef.current = null;
      if (actionCompletionRequestGuard.isCurrent(token)) setSavingActionCompletion(false);
    }
  }, [actionCompletionRequestGuard, flushReviewDraftsBeforeLeaving, refetch, setSelectedRecording]);
  const openMeetingActionItems = useMemo(
    () => selectedMeetingActionItems.filter((task) => !completedMeetingTasks?.has(task)),
    [selectedMeetingActionItems, completedMeetingTasks]
  );
  const doneMeetingActionItems = useMemo(
    () => selectedMeetingActionItems.filter((task) => completedMeetingTasks?.has(task)),
    [selectedMeetingActionItems, completedMeetingTasks]
  );
  const completedMeetingActionCount = doneMeetingActionItems.length;
  const selectedMeetingPrepPrompts = useMemo(
    () => prepPromptsForTemplate(meetingTemplateId),
    [meetingTemplateId]
  );
  // Provenance only holds for the exact text the model produced. The moment the
  // user edits a line it is their text again, and no evidence is claimed for it.
  const summaryProvenance = useMemo(() => {
    if (!meetingSummaryProvenance) {
      return null;
    }
    return meetingSummaryProvenance.summary.trim() === meetingSummary.trim()
      ? meetingSummaryProvenance
      : null;
  }, [meetingSummary, meetingSummaryProvenance]);
  const summaryHasNewerNotes = Boolean(summaryProvenance && (() => {
    const notesUpdatedAt = selectedRecording?.notesUpdatedAt;
    const completedAt = selectedRecording?.summaryProvenance?.completedAt;
    if (!notesUpdatedAt || !completedAt) return false;
    const notesTime = Date.parse(notesUpdatedAt);
    const summaryTime = Date.parse(completedAt);
    return Number.isFinite(notesTime) && Number.isFinite(summaryTime) && notesTime > summaryTime;
  })());
  const actionItemProvenance = useMemo(() => {
    return matchActionItemOccurrences(selectedMeetingActionItems, meetingActionItemProvenance);
  }, [meetingActionItemProvenance, selectedMeetingActionItems]);
  // The quoted source sentence of each unchanged generated item, by position.
  const actionItemEvidence = useMemo(
    () => actionItemProvenance.map((entry) => entry.evidence ?? null),
    [actionItemProvenance]
  );
  // Generated items the meeting left unclear, by position.
  const actionItemUnclear = useMemo(
    () => actionItemProvenance.map((entry) => entry.unclear === true),
    [actionItemProvenance]
  );
  // Only action items still matching persisted model output carry evidence;
  // the rest are the user's own or legacy unattributed text and are left alone.
  const generatedActionItemProvenance = useMemo(
    () =>
      actionItemProvenance.flatMap((entry) =>
        entry.citations
          ? [{ item: entry.item, citations: entry.citations, grounded: entry.grounded }]
          : []
      ),
    [actionItemProvenance]
  );
  const hasRecapProvenance =
    Boolean(summaryProvenance) || generatedActionItemProvenance.length > 0;
  // The failed meeting is named from the list when it is still there, and from
  // the open workspace when the list is unmounted behind it.
  const audioIssueMeetingTitle = audioPlaybackIssue
    ? (meetings.find((meeting) => meeting.id === audioPlaybackIssue.recordingId)?.title ??
      (selectedRecording?.id === audioPlaybackIssue.recordingId
        ? selectedRecording.title
        : "this meeting"))
    : "this meeting";
  // How many visible follow-ups Plainsong has no claim on. Drives both the
  // caption and the regenerate warning, so a hand-typed line is never described
  // as the model's and never replaced without being named.
  const unattributedActionItemCount = actionItemProvenance.filter(
    (entry) => entry.citations === null
  ).length;
  // Three states, and the third is the honest one: text that was already stored
  // when the meeting opened has no recorded author, so it is neither claimed as
  // the model's nor handed back to the reader as their own.
  const summaryAuthorship: RecapAuthorship = summaryProvenance
    ? "plainsong"
    : userEditedSummary !== null && userEditedSummary.trim() === meetingSummary.trim()
      ? "user"
      : "unrecorded";
  const actionItemsAuthorship: RecapAuthorship = actionItemProvenance.some(
    (entry) => entry.citations !== null
  )
    ? "plainsong"
    : userEditedActionItemsText !== null &&
        actionItemsFromText(userEditedActionItemsText).join("\n") ===
          selectedMeetingActionItems.join("\n")
      ? "user"
      : "unrecorded";

  // A citation is only useful if it can take you to the moment it names. The
  // transcript pane sits beside the record, so this cues it in place instead
  // of swapping the document out for a tab.
  const jumpToTranscriptMoment = useCallback((citation: LlmCitation) => {
    if (citation.recordingId !== selectedRecordingIdRef.current) return;
    const startTime = citation.startTime;
    setSearchQuery("");
    setTranscriptMatches([]);
    setActiveTranscriptMatchIndex(0);
    pendingMatchFocusTimeRef.current = null;
    playhead.set(typeof startTime === "number" ? startTime : undefined);
    if (typeof startTime === "number") {
      setTranscriptSourceNavigation((previous) => ({ time: startTime, recordingId: citation.recordingId!, segmentId: citation.segmentId, requestId: (previous?.requestId ?? 0) + 1 }));
      audioPlayerRef.current?.seekTo(startTime);
    }
  }, []);
  const openWrittenNotes = useCallback((citation?: LlmCitation) => {
    const notes = reviewNotesRef.current;
    const editors = Array.from(notes?.querySelectorAll<HTMLTextAreaElement>("textarea") ?? []);
    const matches = citation ? editors.filter((editor) =>
      editor.value.split("\n").some((line) => line.trim() === citation.text)
    ) : [];
    const editor = matches.length === 1 ? matches[0] : editors[0];
    if (matches.length === 1) {
      editor.scrollIntoView({ block: "center" });
      const start = editor.value.indexOf(citation!.text);
      if (start === editor.value.lastIndexOf(citation!.text)) {
        editor.setSelectionRange(start, start + citation!.text.length);
      }
    } else {
      notes?.scrollIntoView({ block: "start" });
    }
    editor?.focus({ preventScroll: true });
  }, []);
  const selectedMeetingRelationshipMatches = useMemo(() => {
    if (!selectedRecording || !relationshipMemory) {
      return { people: [] as PersonMemoryProfile[], companies: [] as CompanyMemoryProfile[] };
    }

    const haystack = [
      selectedRecording.title,
      meetingNotes,
      meetingSummary,
      meetingActionItemsText,
    ]
      .join(" ")
      .toLowerCase();
    const tokens = normalizePrepSearchTokens(haystack);
    const sortProfiles = <T extends PersonMemoryProfile | CompanyMemoryProfile>(profiles: T[]) =>
      profiles
        .map((profile) => ({
          profile,
          score: relationshipPrepScore(profile, haystack, tokens),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, 3)
        .map((entry) => entry.profile);

    return {
      people: sortProfiles(relationshipMemory.people),
      companies: sortProfiles(relationshipMemory.companies),
    };
  }, [
    meetingActionItemsText,
    meetingNotes,
    meetingSummary,
    relationshipMemory,
    selectedRecording,
  ]);
  const deterministicMeetingFollowUp = useMemo(
    () =>
      buildDeterministicFollowUpDraft(
        selectedRecording?.title ?? "this meeting",
        meetingSummary,
        selectedMeetingActionItems
      ),
    [meetingSummary, selectedMeetingActionItems, selectedRecording]
  );
  const deterministicNextAgenda = useMemo(
    () => buildDeterministicAgenda(selectedRecording?.title ?? "this meeting", openMeetingActionItems),
    [openMeetingActionItems, selectedRecording]
  );
  const selectedMeetingRecallPrompts = useMemo(
    () =>
      buildRelationshipRecallPrompts({
        title: selectedRecording?.title ?? "this meeting",
        people: selectedMeetingRelationshipMatches.people,
        companies: selectedMeetingRelationshipMatches.companies,
      }),
    [
      selectedMeetingRelationshipMatches.companies,
      selectedMeetingRelationshipMatches.people,
      selectedRecording?.title,
    ]
  );
  const selectedMeetingConsent = useMemo(
    () =>
      describeMeetingConsent(
        selectedRecording,
        selectedRecording?.id === recordingId ? liveMeetingConsentShown : false
      ),
    [liveMeetingConsentShown, recordingId, selectedRecording]
  );
  const activeMeetingConsent = useMemo(
    () => describeMeetingConsent(activeMeeting, liveMeetingConsentShown),
    [activeMeeting, liveMeetingConsentShown]
  );
  const summaryNeedsShareReview = Boolean(meetingSummary.trim() && summaryProvenance && (
    summaryHasNewerNotes || !hasCurrentGroundingPolicy(selectedRecording?.summaryProvenance)
    || !summaryProvenance.grounded || summaryProvenance.citations.length === 0
    || !summaryProvenance.citations.every((citation) => hasCurrentCitationSource(citation, selectedRecording))
  ));
  const actionsNeedShareReview = actionItemProvenance.some((item) => item.citations !== null && (
    !hasCurrentGroundingPolicy(selectedRecording?.actionItemsProvenance)
    || !item.grounded || item.citations.length === 0
    || !item.citations.every((citation) => hasCurrentCitationSource(citation, selectedRecording))
  ));
  const shareReviewWarning = summaryNeedsShareReview || actionsNeedShareReview
    ? `Needs review: Check the ${summaryNeedsShareReview && actionsNeedShareReview ? "summary and action items" : summaryNeedsShareReview ? "summary" : "action items"} against the meeting transcript and notes before relying on them.`
    : undefined;
  const buildSelectedMeetingMarkdown = useCallback(
    (includeTranscript: boolean) =>
      selectedRecording
        ? buildMeetingShareMarkdown({
            recording: selectedRecording,
            summary: meetingSummary,
            actionItems: selectedMeetingActionItems,
            notes: meetingNotes,
            transcript: selectedTranscript?.fullText ?? "",
            captureMode: selectedMeetingCaptureMode,
            consentLabel: selectedMeetingConsent.shareLabel,
            templateLabel: selectedTemplateOption.label,
            includeTranscript,
            reviewWarning: shareReviewWarning,
            completedTasks: completedMeetingTasks,
          })
        : "",
    [
      meetingNotes,
      meetingSummary,
      selectedMeetingActionItems,
      selectedMeetingCaptureMode,
      selectedMeetingConsent.shareLabel,
      selectedRecording,
      selectedTemplateOption.label,
      selectedTranscript?.fullText,
      shareReviewWarning,
      completedMeetingTasks,
    ]
  );
  const selectedMeetingRecapMarkdown = useMemo(
    () => buildSelectedMeetingMarkdown(false),
    [buildSelectedMeetingMarkdown]
  );
  const selectedMeetingFullRecordMarkdown = useMemo(
    () => buildSelectedMeetingMarkdown(true),
    [buildSelectedMeetingMarkdown]
  );
  const currentMeetingCopySource = meetingRecordCopySourceRef.current;
  const currentMeetingCopyRecordingId = selectedRecording?.id ?? null;
  if (
    currentMeetingCopySource.recordingId !== currentMeetingCopyRecordingId
    || currentMeetingCopySource.recap !== selectedMeetingRecapMarkdown
    || currentMeetingCopySource.fullRecord !== selectedMeetingFullRecordMarkdown
  ) {
    meetingRecordCopySourceRef.current = {
      recordingId: currentMeetingCopyRecordingId,
      recap: selectedMeetingRecapMarkdown,
      fullRecord: selectedMeetingFullRecordMarkdown,
      revision: currentMeetingCopySource.revision + 1,
    };
  }
  const selectedMeetingReadyState = useMemo(
    () =>
      buildMeetingReadyState({
        summary: meetingSummary,
        actionItems: selectedMeetingActionItems,
        notes: meetingNotes,
        transcriptSegments: selectedTranscript?.segments?.length ?? 0,
        status: selectedRecording?.status,
        isLive: selectedRecording?.id === recordingId && isRecording,
        summaryGrounded: summaryProvenance ? !summaryNeedsShareReview : undefined,
        actionItemsGrounded: actionsNeedShareReview ? false : actionItemProvenance.length > 0 && actionItemProvenance.every(
          (item) => item.grounded && item.citations !== null && item.citations.length > 0,
        ) ? true : undefined,
      }),
    [
      isRecording,
      meetingNotes,
      meetingSummary,
      summaryProvenance,
      actionItemProvenance,
      recordingId,
      selectedMeetingActionItems,
      selectedRecording,
      selectedTranscript?.segments?.length,
      summaryNeedsShareReview,
      actionsNeedShareReview,
    ]
  );
  const enhancedMeetingNotesIsStale = useMemo(
    () =>
      Boolean(
        enhancedMeetingNotesDraft &&
          enhancedMeetingNotesDraft.rawNotesSnapshot.trim() !== meetingNotes.trim()
      ),
    [enhancedMeetingNotesDraft, meetingNotes]
  );

  useEffect(() => {
    cancelActiveMeetingRecall();
    meetingRecallRequestGuard.setScope(selectedRecording?.id ?? null);
    setMeetingRecallCancelStatus(null);
    ++meetingRecallQueryRevisionRef.current;
    setMeetingRecallQuery("");
    setMeetingRecallResponse(null);
    setMeetingRecallCitations([]);
    setMeetingRecallGrounded(null);
    setMeetingRecallPromptLabel(null);
    setMeetingRecallError(null);
    setMeetingRecallLoading(false);
  }, [selectedRecording?.id, meetingRecallRequestGuard, cancelActiveMeetingRecall]);

  const updateMeetingSections = (
    updater: (sections: MeetingNoteSection[]) => MeetingNoteSection[]
  ) => {
    setMeetingNotes((current) => {
      const nextSections = updater(
        parseMeetingNoteSections(current, meetingTemplateId, customMeetingTemplates)
      );
      return serializeMeetingNoteSections(nextSections, meetingTemplateId, customMeetingTemplates);
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

  // The stored representation trims edge whitespace and treats a lone dash
  // as an empty placeholder. Keep the raw input only while it still matches
  // that canonical body, so new words from another writer take precedence.
  const sectionBodyKey = (body: string) => body.trim() === "-" ? "" : body.trim();

  const handleClearMeetingSection = (sectionIndex: number) => {
    const targetId = meetingNotesTargetId;
    const expected = meetingNoteSections[sectionIndex];
    if (!targetId || selectedRecordingIdRef.current !== targetId || !expected) return;
    setSectionBodyDrafts({});
    setMeetingNotesState((current) => {
      const sections = parseMeetingNoteSections(current.text, meetingTemplateId, customMeetingTemplates);
      const section = sections[sectionIndex];
      if (!section || section.title !== expected.title || section.body !== expected.body) {
        return { ...current, notice: { error: true,
          message: "The notes changed. Review this section before clearing it." } };
      }
      sections[sectionIndex] = { ...section, body: "", hasExplicitPlaceholder: false,
        isFromNotes: section.isTemplateSection ? false : section.isFromNotes };
      const text = serializeMeetingNoteSections(sections, meetingTemplateId, customMeetingTemplates);
      if (!section.body.trim()) return text === current.text ? current : { ...current, text };
      const entry: SectionUndoEntry = { kind: "clear", recordingId: targetId,
        templateId: meetingTemplateId, structureKey: sectionStructureKey,
        section: { ...section }, index: sectionIndex };
      return { text, undo: [...current.undo, entry].slice(-20),
        notice: { error: false, message: `Cleared notes in "${section.title}".` } };
    });
  };

  const handleAddMeetingSection = () => {
    setSectionTitleDrafts({});
    setSectionBodyDrafts({});
    updateMeetingSections((sections) => [
      ...sections,
      {
        title: getNextMeetingSectionTitle(sections),
        body: "",
        isTemplateSection: false,
        hasExplicitPlaceholder: true,
        isFromNotes: true,
      },
    ]);
  };

  const handleRemoveMeetingSection = (sectionIndex: number) => {
    const targetId = meetingNotesTargetId;
    const expected = meetingNoteSections[sectionIndex];
    if (!targetId || selectedRecordingIdRef.current !== targetId || !expected || expected.isTemplateSection) return;
    setSectionTitleDrafts({});
    setSectionBodyDrafts({});
    setMeetingNotesState((current) => {
      const sections = parseMeetingNoteSections(current.text, meetingTemplateId, customMeetingTemplates);
      const section = sections[sectionIndex];
      if (!section || section.isTemplateSection || section.title !== expected.title || section.body !== expected.body) {
        return { ...current, notice: { error: true,
          message: "The notes changed. Review this section before removing it." } };
      }
      const removal: SectionUndoEntry = { kind: "remove", recordingId: targetId, templateId: meetingTemplateId,
        structureKey: sectionStructureKey, section: { ...section }, index: sectionIndex };
      return {
        text: serializeMeetingNoteSections(sections.filter((_, index) => index !== sectionIndex), meetingTemplateId, customMeetingTemplates),
        undo: [...current.undo, removal].slice(-20),
        notice: { error: false, message: `Removed section "${section.title}".` },
      };
    });
    queueMicrotask(() => {
      if (selectedRecordingIdRef.current === targetId) addSectionButtonRef.current?.focus();
    });
  };

  const handleUndoSectionChange = () => {
    const removal = visibleSectionUndo;
    if (!removal || selectedRecordingIdRef.current !== removal.recordingId) return;
    setSectionTitleDrafts({});
    setSectionBodyDrafts({});
    setMeetingNotesState((current) => {
      // A stale double click must not restore the same section twice or pop
      // another removal before the reader sees its updated button.
      if (current.undo[current.undo.length - 1] !== removal) return current;
      const sections = parseMeetingNoteSections(current.text, meetingTemplateId, customMeetingTemplates);
      const existing = sections.findIndex((section) => section.title.trim().toLowerCase() === removal.section.title.trim().toLowerCase());
      if (existing >= 0) {
        const section = sections[existing];
        const body = !removal.section.body || section.body === removal.section.body ? section.body
          : section.body ? `${section.body}\n\n${removal.section.body}` : removal.section.body;
        sections[existing] = { ...section, body, isFromNotes: true,
          hasExplicitPlaceholder: body.trim() ? false : section.hasExplicitPlaceholder || removal.section.hasExplicitPlaceholder };
      } else {
        sections.splice(Math.min(removal.index, sections.length), 0, { ...removal.section, isFromNotes: true });
      }
      return {
        text: serializeMeetingNoteSections(sections, meetingTemplateId, customMeetingTemplates),
        undo: current.undo.slice(0, -1),
        notice: { error: false, message: removal.kind === "clear"
          ? `Notes in "${removal.section.title}" restored. Current notes were kept.`
          : existing >= 0
          ? `Removed notes restored to the existing section "${removal.section.title}".`
          : `Section "${removal.section.title}" restored.` },
      };
    });
    queueMicrotask(() => {
      if (selectedRecordingIdRef.current !== removal.recordingId) return;
      const label = `${removal.section.title} notes`.toLowerCase();
      const field = Array.from(reviewNotesRef.current?.querySelectorAll<HTMLTextAreaElement>("textarea") ?? [])
        .find((input) => input.getAttribute("aria-label")?.toLowerCase() === label);
      (field ?? addSectionButtonRef.current)?.focus();
    });
  };

  const handleRetranscribeRecording = async (recordingIdToRetry: string) => {
    if (selectedRecordingIdRef.current === recordingIdToRetry) resetTranscriptionActivity();
    const statusRevision = recordingStatusEventRevisionRef.current.get(recordingIdToRetry) ?? 0;
    try {
      await retranscribeRecording(recordingIdToRetry);
      // A native update during the RPC owns the resulting status, including
      // a fast job that already finished before the request returned.
      if ((recordingStatusEventRevisionRef.current.get(recordingIdToRetry) ?? 0) === statusRevision) {
        setRecordingStatusOverrides((current) => ({
          ...current,
          [recordingIdToRetry]: "processing",
        }));
      }
      toast("Re-transcribing from the saved audio.", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't start re-transcription.";
      toast(message, "error");
    }
  };

  /**
   * A failed meeting has no transcript to lose, so retrying is immediate. Any
   * other meeting already has words on the page — possibly corrected by hand —
   * and gets asked first.
   */
  const requestRetranscribeRecording = (recording: Recording) => {
    if (recording.status === "error") {
      void handleRetranscribeRecording(recording.id);
      return;
    }
    setPendingRetranscribe(recording);
  };

  /**
   * Read the one true state of a meeting's notes: what is happening now if
   * anything is, otherwise what the record itself remembers about the last
   * attempt. Returns null when there is nothing to say.
   */
  const meetingAnalysisNotice = useCallback(
    (recording: Recording | null | undefined) => {
      if (!recording) {
        return null;
      }
      const live = analysisStatusByRecording[recording.id];
      return describeMeetingAnalysis({
        storedFailure: readStoredAnalysisFailure(recording),
        livePhase: live?.phase ?? null,
        liveError: live?.error ?? null,
        summary: recording.summary ?? null,
      });
    },
    [analysisStatusByRecording],
  );

  const selectedAnalysisNotice = meetingAnalysisNotice(selectedRecording);
  const selectedMeetingIntegrity = readMeetingIntegrity(selectedRecording);
  const selectedAnalysisSourceReview = describeAnalysisSourceReview(selectedMeetingIntegrity);
  const selectedIncompleteTranscript = describeIncompleteTranscript(
    selectedMeetingIntegrity,
  );
  const selectedCaptureDegradation = describeCaptureDegradation(
    selectedMeetingIntegrity,
  );
  const canRecheckSelectedAudio = canRecheckMeetingAudio(
    selectedRecording,
    selectedMeetingIntegrity,
  );

  /**
   * Re-read the saved audio and repair the lifecycle rows describing it.
   *
   * A stop-time failure can condemn audio that is perfectly intact, and every
   * runtime resolver refuses anything not marked `ready`. Before this the only
   * escape was relaunching the app and hoping the startup reconcile covered it.
   * The meeting's own status is left alone by the sidecar: this is evidence
   * about files, not about whether it was transcribed.
   */
  const handleRecheckMeetingAudio = async (recordingIdToCheck: string) => {
    setIsRecheckingAudio(true);
    setAudioRecheckResult(null);
    try {
      const report = await revalidateRecordingAudio(recordingIdToCheck);
      setAudioRecheckResult({
        recordingId: recordingIdToCheck,
        recoverable: Boolean(report?.recoverable),
        message:
          report?.message ??
          (report?.recoverable
            ? "The saved audio was re-checked and is intact."
            : "The saved audio was re-checked and some of it could not be read."),
      });
      await refetch();
      if (selectedRecording?.id === recordingIdToCheck) {
        await refreshSelectedRecording(recordingIdToCheck);
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Plainsong could not re-check this meeting's audio.";
      setAudioRecheckResult({
        recordingId: recordingIdToCheck,
        recoverable: false,
        message,
      });
      toast(message, "error");
    } finally {
      setIsRecheckingAudio(false);
    }
  };

  /**
   * Record that the reader accepts losing this meeting's audio.
   *
   * Storage policy holds the audio of an incomplete meeting back precisely
   * because it is the only complete record of what was said. This releases it,
   * and never claims the transcript became complete.
   */
  const handleAcknowledgeIncompleteTranscript = async (
    recordingIdToAcknowledge: string,
  ) => {
    setIsAcknowledging(true);
    try {
      await acknowledgeIncompleteTranscript(recordingIdToAcknowledge);
      setPendingAcknowledgement(null);
      await refetch();
      if (selectedRecording?.id === recordingIdToAcknowledge) {
        await refreshSelectedRecording(recordingIdToAcknowledge);
      }
      toast(
        "Noted. This meeting's audio is no longer held back from cleanup.",
        "success",
      );
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "Plainsong could not record that acknowledgement.",
        "error",
      );
    } finally {
      setIsAcknowledging(false);
    }
  };

  const handleStopMeetingNotesWait = async (recordingIdToStop: string) => {
    try {
      const result = await cancelMeetingNotesWait(recordingIdToStop);
      if (!result.cancelled) { void refetch(); return; }
      setSelectedRecording((current) => current?.id === recordingIdToStop
        ? { ...current, analysisFailure: "Automatic notes cancelled. Retry when ready." }
        : current);
      void refetch();
      setAnalysisStatusByRecording((current) => {
        const next = { ...current };
        next[recordingIdToStop] = { phase: "failed", error: "Automatic notes cancelled. Retry when ready." };
        return next;
      });
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "Couldn't stop waiting for memory.",
        "error",
      );
    }
  };

  const handleRetryMeetingAnalysis = async (recordingIdToRetry: string) => {
    setAnalysisStatusByRecording((current) => ({
      ...current,
      [recordingIdToRetry]: { phase: "running", error: null },
    }));
    try {
      await retryMeetingAnalysis(recordingIdToRetry);
      // Whether the command returns on start or on finish is the sidecar's
      // business. Drop the local override and let the events plus the stored
      // field say what actually happened. A wait for memory outlives the
      // command, so its event stays.
      setAnalysisStatusByRecording((current) => {
        if (current[recordingIdToRetry]?.phase === "waiting") {
          return current;
        }
        const next = { ...current };
        delete next[recordingIdToRetry];
        return next;
      });
      await refetch();
      if (selectedRecording?.id === recordingIdToRetry) {
        await refreshSelectedRecording(recordingIdToRetry);
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Couldn't start the meeting notes again.";
      setAnalysisStatusByRecording((current) => ({
        ...current,
        [recordingIdToRetry]: { phase: "failed", error: message },
      }));
      toast(message, "error");
    }
  };

  const handleMarkAsDictation = async (recordingIdToUpdate: string) => {
    try {
      await setRecordingSourceType(recordingIdToUpdate, "dictation");
      await refetch();
      toast("Moved to Dictation.", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't move this to Dictation.";
      toast(message, "error");
    }
  };

  const handleBulkMarkAsDictation = async (toMove: Recording[]) => {
    if (toMove.length === 0 || isBulkReclassifying) {
      return;
    }

    setIsBulkReclassifying(true);
    try {
      await Promise.all(
        toMove.map((recording) => setRecordingSourceType(recording.id, "dictation"))
      );
      await refetch();
      toast(
        `Moved ${toMove.length} meeting${toMove.length === 1 ? "" : "s"} to Dictation.`,
        "success"
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't move every listed meeting.";
      toast(message, "error");
    } finally {
      setIsBulkReclassifying(false);
    }
  };

  const openRequestedWorkspace = useCallback(
    async (detail: OpenRecordingWorkspaceDetail | null | undefined) => {
      const requestedRecordingId = detail?.recordingId?.trim();
      if (!detail || !requestedRecordingId) return;
      const actionItem = typeof detail.focusActionItem === "string" && detail.focusActionItem.trim()
        ? detail.focusActionItem : undefined;
      const fromCitation = typeof detail.focusSegmentTime === "number"
        && Number.isFinite(detail.focusSegmentTime) && detail.focusSegmentTime >= 0;
      const request = ++workspaceOpenRequestRef.current;
      const isCurrent = () => workspaceMountedRef.current && workspaceOpenRequestRef.current === request;
      try {
        const recording = actionItem || fromCitation
          ? await getRecording(requestedRecordingId)
          : effectiveRecordings.find((item) => item.id === requestedRecordingId)
            ?? await getRecording(requestedRecordingId);
        if (!isCurrent()) return;
        if (recording?.sourceType !== "meeting") {
          if (actionItem) toast("This follow-up's meeting is no longer available.", "error");
          else if (fromCitation) toast("The source meeting is no longer available.", "error");
          return;
        }
        if (!(await flushReviewDraftsBeforeLeaving()) || !isCurrent()) return;
        // A citation into the current meeting changes reading position, not its drafts.
        if (showRecordingDetail && selectedRecording?.id === requestedRecordingId) {
          setRequestedActionFocus(actionItem ? { recordingId: requestedRecordingId, task: actionItem } : null);
          if (actionItem) {
            setActionTaskFilter("all");
            setIsEditingActionItems(false);
          }
          setSearchQuery(detail.highlightQuery ?? "");
          setTranscriptMatches([]);
          setActiveTranscriptMatchIndex(0);
          playhead.set(detail.focusSegmentTime);
          pendingMatchFocusTimeRef.current = detail.highlightQuery && detail.focusSegmentTime !== undefined
            ? detail.focusSegmentTime : null;
          setMeetingTab("record");
          return;
        }
        openMeetingWorkspace(recording, {
          segmentTime: detail.focusSegmentTime,
          highlightQuery: detail.highlightQuery,
          actionItem,
        });
      } catch (error) {
        console.error("Failed to open requested meeting view:", error);
        if (isCurrent()) {
          if (actionItem) toast("Couldn't open this follow-up's meeting. Try again.", "error");
          else if (fromCitation) toast("Could not open the source meeting. Try again.", "error");
        }
      }
    },
    [effectiveRecordings, flushReviewDraftsBeforeLeaving, showRecordingDetail, selectedRecording?.id, playhead, toast]
  );

  // A request made from another view is emitted before this lazy view mounts,
  // so the emitted event can land on nobody. Take the parked request instead.
  // Mount only: every later request arrives as an event.
  const hasConsumedPendingWorkspaceRef = useRef(false);
  useEffect(() => {
    if (hasConsumedPendingWorkspaceRef.current) {
      return;
    }
    hasConsumedPendingWorkspaceRef.current = true;
    openRequestedWorkspace(consumePendingRecordingWorkspace());
  }, [openRequestedWorkspace]);

  // Move focus with the navigation. Deliberately not on first mount: nothing
  // was navigated to yet, and stealing focus into a heading on load is worse
  // than leaving it where the app put it.
  useEffect(() => {
    if (showRecordingDetail) {
      hasOpenedWorkspaceRef.current = true;
      // A task link already focuses its exact row. Don't move that focus back
      // to the page heading; ordinary opens and missing targets keep the heading.
      const opensOnAction = !isLoadingDetail && requestedActionFocus
        && requestedActionFocus.recordingId === selectedRecording?.id
        && selectedMeetingActionItems.includes(requestedActionFocus.task.trim());
      if (!opensOnAction) workspaceHeadingRef.current?.focus();
      return;
    }
    if (hasOpenedWorkspaceRef.current) {
      hasOpenedWorkspaceRef.current = false;
      listHeadingRef.current?.focus();
    }
  }, [showRecordingDetail]);

  useEffect(() => {
    const handleOpenRecordingWorkspace = (event: Event) => {
      // Clear the parked copy so the mount path cannot open it a second time.
      consumePendingRecordingWorkspace();
      openRequestedWorkspace((event as CustomEvent<OpenRecordingWorkspaceDetail>).detail);
    };

    window.addEventListener(
      OPEN_RECORDING_WORKSPACE_EVENT,
      handleOpenRecordingWorkspace as EventListener
    );
    return () => {
      window.removeEventListener(
        OPEN_RECORDING_WORKSPACE_EVENT,
        handleOpenRecordingWorkspace as EventListener
      );
    };
  }, [openRequestedWorkspace]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {finalNoteDrafts.length > 0 && <div className="max-h-[40vh] shrink-0 overflow-y-auto">
      {finalNoteDrafts.map((draft) => (
        <section key={draft.key} aria-label="Final meeting notes recovery" className="shrink-0 border-b px-6 py-4">
          <p className="mb-1 text-sm font-semibold">Final notes for {recordings.find((recording) => recording.id === draft.recordingId)?.title ?? "a previous meeting"}</p>
          <p role="status" aria-live="polite" className="text-sm">
            {draft.saving ? "Saving final meeting notes…" : draft.journaled ? "Final notes are stored for recovery. Retry save before regenerating this meeting’s recap." : "Final notes could not be stored. Keep this workspace open and retry."}
          </p>
          <textarea aria-label="Retained final meeting notes" readOnly value={draft.notes}
            className="mt-3 w-full rounded-md border bg-background px-3 py-2 text-sm" rows={3} />
          <Button type="button" variant="outline" size="sm" className="mt-2 data-disabled:opacity-50" disabled={draft.saving} focusableWhenDisabled
            onClick={() => void saveFinalNoteDraft(draft)}>Retry save</Button>
        </section>
      ))}
      </div>}
      {showRecordingDetail ? (
        <div className="flex h-full min-h-0 flex-col">
          {/* The meeting is a page now, not a modal: it has a way back, a
              title you can edit in place, and the row's actions in one
              overflow instead of scattered across the surfaces below. */}
          <div className="shrink-0 border-b border-border/70 px-6 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1">
              <Button variant="ghost" size="sm" onClick={closeMeetingWorkspace}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                All meetings
              </Button>
              {selectedRecording && <MeetingSwitcher meetings={meetings} currentId={selectedRecording.id} onSelect={switchMeetingWorkspace} />}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!selectedRecording?.audioPath}
                  onClick={() => {
                    if (selectedRecording) {
                      void handlePlayAudio(selectedRecording);
                    }
                  }}
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Open audio file
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label="Meeting options"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={meetingRecordCopyPending}
                      onClick={() => void handleCopyMeetingRecap()}
                    >
                      <Copy className="mr-2 h-4 w-4" />
                      Copy recap as Markdown
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => void handleExportMeetingArtifact("markdown")}
                    >
                      <FileText className="mr-2 h-4 w-4" />
                      Export as Markdown (emails and phone numbers replaced)
                    </DropdownMenuItem>
                    {canRetranscribeRecording(selectedRecording) && !isLiveSelectedMeeting && (
                      <DropdownMenuItem
                        onClick={() => {
                          if (selectedRecording) {
                            requestRetranscribeRecording(selectedRecording);
                          }
                        }}
                      >
                        <RefreshCw className="mr-2 h-4 w-4" />
                        {selectedRecording?.status === "error" || selectedRecording?.status === "pending"
                          ? "Retry transcription"
                          : "Re-transcribe from audio"}
                      </DropdownMenuItem>
                    )}
                    {canRecheckSelectedAudio && !isLiveSelectedMeeting && (
                      <DropdownMenuItem
                        disabled={isRecheckingAudio}
                        onClick={() => {
                          if (selectedRecording) {
                            void handleRecheckMeetingAudio(selectedRecording.id);
                          }
                        }}
                      >
                        <FileAudio className="mr-2 h-4 w-4" />
                        Re-check audio
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => {
                        if (selectedRecording) {
                          void handleMarkAsDictation(selectedRecording.id);
                        }
                      }}
                    >
                      <Mic2 className="mr-2 h-4 w-4" />
                      Move to Dictation
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      disabled={!canDeleteRecording(selectedRecording)}
                      onClick={() => {
                        if (selectedRecording && canDeleteRecording(selectedRecording)) {
                          openDeleteConfirmation(selectedRecording);
                        }
                      }}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {deleteRecordingActionLabel(selectedRecording)}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="rubric mb-1.5">MEETING</p>
                {/* The meeting's name is this page's h1. Without it the heading
                    tree started at "The record" and a screen-reader user
                    navigating by heading never heard which meeting they were
                    in. The input carries the type, so the heading only names. */}
                <h1
                  ref={workspaceHeadingRef}
                  tabIndex={-1}
                  className="min-w-0 outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <EditableTitle
                    ref={meetingTitleRef}
                    key={selectedRecording?.id}
                    className="-ml-2"
                    value={selectedRecording?.title ?? "Meeting"}
                    disabled={!selectedRecording}
                    onCommit={handleRenameMeetingTitle}
                  />
                </h1>
              </div>
              {/* Status is said once, here. Every card below used to restate
                  it in its own words. */}
              <Badge
                variant="outline"
                className={qualityToneClasses(selectedMeetingReadyState.tone)}
              >
                {selectedMeetingReadyState.label}
              </Badge>
            </div>
            {selectedRecording && <NotePublishStatusLine key={selectedRecording.id} recordingId={selectedRecording.id} />}
            <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">
              {selectedMeetingReadyState.detail}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
              <span className="time-spec">
                {selectedRecording
                  ? formatDateTime(selectedRecording.createdAt)
                  : "Date unknown"}
              </span>
              <span className="time-spec">
                {formatDuration(selectedRecording?.duration ?? 0)}
              </span>
              {selectedRecording?.importedSourceName ? (
                <span>From {selectedRecording.importedSourceName}</span>
              ) : null}
              {isLiveSelectedMeeting ? (
                <span className="inline-flex items-center gap-1.5 text-gold-text">
                  <span className="neume neume-lit" aria-hidden="true" />
                  Live capture · <RecordingDurationText />
                </span>
              ) : null}
            </div>
            <details
              key={`meeting-details-${selectedRecording?.id}`}
              open={isLiveSelectedMeeting}
              className="mt-2 text-sm text-muted-foreground"
              data-testid="meeting-secondary-details"
            >
              <summary className="cursor-pointer select-none rounded py-1.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Meeting details
              </summary>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <span>{selectedMeetingCaptureMode}</span>
                {selectedMeetingDiarizer ? (
                  <span title={selectedMeetingDiarizerDetail ?? undefined}>
                    {selectedMeetingDiarizer}
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={cn(
                      "neume",
                      selectedMeetingConsent.needsManualNotice ? "neume-hollow" : "neume-lit"
                    )}
                    aria-hidden="true"
                  />
                  {selectedMeetingConsent.label}
                </span>
                <span>Playbook: {selectedTemplateOption.label}</span>
                <span>{selectedMeetingAssetRetention.audioLabel}</span>

              </div>
              {selectedMeetingConsent.message ? (
                <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">
                  {selectedMeetingConsent.message}
                </p>
              ) : null}
              <MeetingAttendees
                attendees={selectedRecording?.attendees ?? []}
                onChange={(next) => void handleAttendeesChange(next)}
                disabled={!selectedRecording}
              />
            </details>
          </div>

          {selectedRecording?.id === recordingId && meetingPhase === "recording"
            && meetingMicrophoneInput?.usedFallback && !meetingMicrophoneWarningDismissed && (
            <div className="shrink-0 px-6 pt-4">
              <MeetingMicrophoneFallback recordingId={recordingId} input={meetingMicrophoneInput}
                dismissed={meetingMicrophoneWarningDismissed} active={isRecording}
                onSettings={() => requestSettingsTab("asr")} />
            </div>
          )}
          {/* What the capture actually got. Rendered before anything derived
              from the transcript, because it is the reason the transcript is
              short. */}
          {selectedCaptureDegradation ? (
            <div className="shrink-0 px-6 pt-4">
              <StatusBanner
                tone="muted"
                title={selectedCaptureDegradation.title}
                message={selectedCaptureDegradation.message}
              />
            </div>
          ) : null}

          {/* A transcript the sidecar knows is incomplete, and the reason its
              audio is still on disk. Both were reachable only programmatically
              before this. */}
          {selectedIncompleteTranscript && selectedRecording ? (
            <div className="shrink-0 px-6 pt-4">
              <StatusBanner
                title={selectedIncompleteTranscript.title}
                message={selectedIncompleteTranscript.message}
                actions={
                  <>
                    {canRetranscribeRecording(selectedRecording) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void handleRetranscribeRecording(selectedRecording.id)
                        }
                      >
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Re-transcribe
                      </Button>
                    ) : null}
                    {selectedIncompleteTranscript.audioHeld ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setPendingAcknowledgement(selectedRecording)
                        }
                      >
                        Accept losing the audio
                      </Button>
                    ) : null}
                  </>
                }
              />
            </div>
          ) : null}

          {/* What the last re-check found. The sidecar leaves the meeting's
              own status alone, so this says what happened to the files. */}
          {audioRecheckResult &&
          audioRecheckResult.recordingId === selectedRecording?.id ? (
            <div className="shrink-0 px-6 pt-4">
              <StatusBanner
                tone={audioRecheckResult.recoverable ? "muted" : "rust"}
                title={
                  audioRecheckResult.recoverable
                    ? "Saved audio re-checked"
                    : "Saved audio could not be fully read"
                }
                message={audioRecheckResult.message}
                actions={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setAudioRecheckResult(null)}
                  >
                    Dismiss
                  </Button>
                }
              />
            </div>
          ) : null}

          {/* Meeting notes that were never written. The list says the same
              thing; a reader who opened the meeting to look for the summary
              needs to be told here, where the summary is missing. */}
          {selectedAnalysisNotice ? (
            <div className="shrink-0 px-6 pt-4">
              <StatusBanner
                tone={selectedAnalysisNotice.busy ? "muted" : "rust"}
                title={selectedAnalysisNotice.title}
                message={selectedAnalysisNotice.message}
                actions={
                  selectedAnalysisNotice.retryable && selectedRecording ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void handleRetryMeetingAnalysis(selectedRecording.id)
                      }
                    >
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Retry notes
                    </Button>
                  ) : null
                }
              />
            </div>
          ) : null}

          {/* The same failure surface the list carries. Without it here, Play
              audio in the header above could fail with nothing on screen but a
              toast, and a locked-vault reader had no route to unlock. */}
          {audioPlaybackIssue && (
            <div className="shrink-0 px-6 pt-4">
              <AudioIssueBanner
                meetingTitle={audioIssueMeetingTitle}
                message={audioPlaybackIssue.message}
                onUnlockVault={() => {
                  setAudioPlaybackIssue(null);
                  requestMainView("settings");
                }}
                onDismiss={() => setAudioPlaybackIssue(null)}
              />
            </div>
          )}

          {/* The transcript is a pane, not a tab a tester never found: it sits
              beside the record at every width and keeps its own scrollbar. */}
          <div className="grid min-h-0 flex-1 grid-rows-[minmax(320px,1.35fr)_minmax(560px,1fr)] overflow-y-auto lg:grid-cols-[minmax(0,1.55fr)_minmax(360px,1fr)] lg:grid-rows-1 lg:overflow-hidden">
            <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
              <Tabs
                value={meetingTab}
                onValueChange={setMeetingTab}
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                <TabsList className="mx-6 mt-4 grid w-auto shrink-0 grid-cols-3">
                  <TabsTrigger value="record" className="flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    Notes
                  </TabsTrigger>
                  <TabsTrigger value="ask" className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" />
                    Ask
                  </TabsTrigger>
                  <TabsTrigger value="assets" className="flex items-center gap-2">
                    <FileAudio className="h-4 w-4" />
                    Audio
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="record" className="mt-0 min-h-0 flex-1 overflow-hidden">
                  <ScrollArea type="always" className="h-full min-h-0">
                    <div className="flex flex-col gap-6 px-6 py-5">
                      {isLoadingDetail ? (
                        <WorkspaceSkeleton
                          label="Loading the summary, action items, and notes for this meeting."
                          lines={6}
                        />
                      ) : (
                        <>
                          <section
                            ref={reviewNotesRef}
                            className="rounded-xl border border-gold/30 bg-background p-5 shadow-sm"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <h2 className="font-serif text-lg font-semibold tracking-tight">
                                    Your notes
                                  </h2>
                                  {isLiveSelectedMeeting ? (
                                    <span
                                      className={cn(
                                        "inline-flex items-center gap-1.5 text-sm font-medium",
                                        meetingPaused ? "text-rust" : "text-gold-text"
                                      )}
                                    >
                                      <span
                                        className={cn(
                                          "neume",
                                          meetingPaused ? "neume-hollow" : "neume-lit"
                                        )}
                                        aria-hidden="true"
                                      />
                                      {meetingPaused ? "Paused" : "Recording"} ·{" "}
                                      <RecordingDurationText />
                                    </span>
                                  ) : null}
                                </div>
                                <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                                  Write what matters in your own words. Plainsong saves as you type
                                  and uses these notes to shape the recap.
                                </p>
                              </div>
                              <MeetingNotesSaveIndicator
                                status={
                                  meetingNotesSaveStatus?.surface === "review" &&
                                  meetingNotesSaveStatus.recordingId === meetingNotesTargetId
                                    ? meetingNotesSaveStatus
                                    : null
                                }
                                onRetry={() => retryMeetingNotesSave("review")}
                              />
                            </div>
                          <div className="mt-4 flex flex-wrap items-center gap-2">
                            <label className="text-sm font-medium" htmlFor="meeting-template">
                              Playbook
                            </label>
                            <select
                              id="meeting-template"
                              value={meetingTemplateId}
                              onChange={(event) => { playbookEditRevision.current += 1; setMeetingTemplateId(event.target.value); }}
                              className="h-9 rounded-md border bg-background px-3 text-sm"
                            >
                              <optgroup label="Built-in">
                                {MEETING_TEMPLATES.map((template) => (
                                  <option key={template.value} value={template.value}>
                                    {template.label}
                                  </option>
                                ))}
                              </optgroup>
                              {customMeetingTemplates.length > 0 ? (
                                <optgroup label="Your templates">
                                  {customMeetingTemplates.map((template) => (
                                    <option key={template.id} value={template.id}>
                                      {template.name}
                                    </option>
                                  ))}
                                </optgroup>
                              ) : null}
                            </select>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={handleApplyTemplateOutline}
                            >
                              Add its headings to my notes
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setTemplateEditorTarget(null);
                                setTemplateEditorSeed(buildTemplateSaveSeed());
                                setTemplateEditorOpen(true);
                              }}
                            >
                              Save as a template
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => setTemplateManagerOpen(true)}
                            >
                              Manage templates
                            </Button>
                            {selectedMeetingConsent.needsManualNotice ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={async () => {
                                  try {
                                    await navigator.clipboard.writeText(MEETING_CONSENT_NOTICE_TEXT);
                                    toast("Consent notice copied.", "success");
                                  } catch {
                                    toast("Couldn't copy the consent notice.", "error");
                                  }
                                }}
                              >
                                <Copy className="mr-2 h-4 w-4" />
                                Copy consent notice
                              </Button>
                            ) : null}
                          </div>
                          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                            {visibleSectionUndo ? <Button type="button" size="sm" variant="ghost"
                              title="Undo a recent section change. History clears when you leave this meeting or change its playbook."
                              onClick={handleUndoSectionChange}>{visibleSectionUndo.kind === "clear" ? "Undo clear section" : "Undo remove section"}</Button> : null}
                            <Button type="button" size="sm" variant="outline"
                              disabled={notesCopyPending || !meetingNotes.trim() || meetingNotesTargetId !== selectedRecording?.id}
                              onClick={() => { void handleCopyNotes(); }}>
                              <Copy className="mr-2 h-4 w-4" />
                              {notesCopyPending ? "Copying notes…" : "Copy notes"}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={handleAddMeetingSection}
                              ref={addSectionButtonRef}
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              Add section
                            </Button>
                          </div>
                          {notesCopyFeedback && notesCopyFeedback.recordingId === selectedRecording?.id && notesCopyFeedback.text === meetingNotes && (
                            <p role={notesCopyFeedback.error ? "alert" : "status"}
                              className={notesCopyFeedback.error ? "mt-2 text-sm text-destructive" : "mt-2 text-sm text-muted-foreground"}>
                              {notesCopyFeedback.message}
                            </p>
                          )}
                          {meetingNotesState.notice ? <p role={meetingNotesState.notice.error ? "alert" : "status"}
                            className={meetingNotesState.notice.error ? "mt-2 text-sm text-rust" : "mt-2 text-sm text-muted-foreground"}>
                            {meetingNotesState.notice.message}
                          </p> : null}
                          <div aria-label="Meeting notes" role="group" className="mt-4 space-y-3">
                            {meetingNoteSections.map((section, index) => (
                              <div
                                key={`${meetingNotesTargetId}-${index}`}
                                className="border-t border-border/60 pt-3"
                              >
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    {section.isTemplateSection ? (
                                      // The badge already says where the heading
                                      // came from; a sentence under it restating
                                      // that was the same fact twice.
                                      <div className="flex items-center gap-2">
                                        <p className="text-sm font-medium">{section.title}</p>
                                        <span className="rubric-muted">From the playbook</span>
                                      </div>
                                    ) : (
                                      <div className="space-y-2">
                                        <label
                                          className="text-sm font-medium"
                                          htmlFor={`meeting-section-title-${index}`}
                                        >
                                          Section title
                                        </label>
                                        <Input
                                          id={`meeting-section-title-${index}`}
                                          value={sectionTitleDrafts[`${meetingNotesTargetId}-${index}`]?.title === section.title
                                            ? sectionTitleDrafts[`${meetingNotesTargetId}-${index}`].text
                                            : section.title}
                                          onChange={(event) => {
                                            const title = event.target.value;
                                            const key = `${meetingNotesTargetId}-${index}`;
                                            setSectionTitleDrafts((drafts) => ({ ...drafts,
                                              [key]: { text: title, title: title.trim() || section.title } }));
                                            // A transient blank is an editing gesture, not a
                                            // request to turn the section into unheaded notes.
                                            if (title.trim()) handleMeetingSectionTitleChange(index, title);
                                          }}
                                          onBlur={() => {
                                            const key = `${meetingNotesTargetId}-${index}`;
                                            setSectionTitleDrafts((drafts) => {
                                              const next = { ...drafts };
                                              delete next[key];
                                              return next;
                                            });
                                          }}
                                        />
                                      </div>
                                    )}
                                  </div>
                                  {section.isTemplateSection ? (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      disabled={!section.body.trim() && !sectionBodyDrafts[`${meetingNotesTargetId}-${index}`]?.text}
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
                                  value={sectionBodyDrafts[`${meetingNotesTargetId}-${index}`]?.title === section.title
                                    && sectionBodyDrafts[`${meetingNotesTargetId}-${index}`].body === sectionBodyKey(section.body)
                                    ? sectionBodyDrafts[`${meetingNotesTargetId}-${index}`].text
                                    : section.body}
                                  onChange={(event) => {
                                    const body = event.target.value;
                                    const key = `${meetingNotesTargetId}-${index}`;
                                    setSectionBodyDrafts((drafts) => ({ ...drafts,
                                      [key]: { title: section.title, body: sectionBodyKey(body), text: body } }));
                                    handleMeetingSectionBodyChange(index, body);
                                  }}
                                  onBlur={() => {
                                    const key = `${meetingNotesTargetId}-${index}`;
                                    setSectionBodyDrafts((drafts) => {
                                      const next = { ...drafts };
                                      delete next[key];
                                      return next;
                                    });
                                  }}
                                  aria-label={`${section.title} notes`}
                                  placeholder={`Capture ${section.title.toLowerCase()} here.`}
                                  rows={5}
                                  className="mt-3 min-h-[120px] resize-y bg-background"
                                />
                              </div>
                            ))}
                          </div>
                        </section>

                          <section className="space-y-5 rounded-xl border border-border/70 bg-muted/15 p-5">
                            <div className="min-w-0">
                              <h2 className="font-serif text-lg font-semibold tracking-tight">
                                Plainsong recap
                              </h2>
                              <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                                Key lines and next steps, quoted from the transcript and your
                                notes. Check them before sharing.
                              </p>
                            </div>

                            {summaryHasNewerNotes ? (
                              <p role="status" className="text-sm text-rust">
                                Your written notes changed after this summary was generated. Review the summary against your updated notes or regenerate it.
                              </p>
                            ) : null}
                            {visibleAnalysisSaveStatus && (
                              <div role={visibleAnalysisSaveStatus.state === "failed" ? "alert" : "status"}
                                className="mb-3 rounded-md border border-border/80 bg-muted/30 px-3 py-2 text-sm">
                                <p>{visibleAnalysisSaveStatus.state === "failed"
                                  ? "Recap not saved. Keep this meeting open." : "Saving recap…"}</p>
                                {visibleAnalysisSaveStatus.state === "failed" && (
                                  <Button type="button" size="sm" variant="outline" className="mt-2" onClick={retryAnalysisSave}>Retry save</Button>
                                )}
                              </div>
                            )}
                            <DocumentField
                              label="Summary"
                              value={meetingSummary}
                              copyable
                              copySourceKey={selectedRecording?.id}
                              copyWarning={summaryNeedsShareReview
                                ? "Needs review: Check the summary against the meeting transcript and notes before relying on it."
                                : undefined}
                              onChange={(next) => {
                                markAnalysisDraftEdit("summary", next);
                                setMeetingSummary(next);
                                setMeetingSummaryProvenance(
                                  selectedRecording?.summaryProvenance &&
                                    next.trim() === (selectedRecording.summary ?? "").trim()
                                    ? {
                                        summary: selectedRecording.summary ?? "",
                                        citations:
                                          selectedRecording.summaryProvenance.citations ?? [],
                                        grounded:
                                          selectedRecording.summaryProvenance.grounded !== false,
                                      }
                                    : null
                                );
                                setUserEditedSummary(next);
                              }}
                              isEditing={isEditingSummary}
                              onEditingChange={setIsEditingSummary}
                              disabled={!selectedRecording || isPreparingRegeneration || isRefreshingSummary || isUndoingSummary}
                              emptyMessage="Nothing written yet. Regenerate to have Plainsong write it from the transcript."
                              editorPlaceholder="Write the summary in your own words, or regenerate it from the transcript."
                              // No caption when the field is empty: the body
                              // already says the same sentence, and printing it
                              // twice is the duplicate-pair bug STYLE.md §2
                              // names outright.
                              caption={
                                meetingSummary.trim()
                                  ? SUMMARY_AUTHORSHIP_CAPTION[summaryAuthorship]
                                  : undefined
                              }
                              bodyClassName={
                                meetingSummary.trim()
                                  ? RECAP_AUTHORSHIP_TREATMENT[summaryAuthorship]
                                  : RECAP_AUTHORSHIP_TREATMENT.user
                              }
                              actions={
                                <>
                                  {/* Two regenerations, never conflated: the plain
                                      one repeats the playbook already chosen, and
                                      the other asks which playbook to use. */}
                                  <Button
                                    type="button"
                                    size="sm"
                                    aria-label="Regenerate summary"
                                    onClick={() => requestRegeneration("summary")}
                                    disabled={!selectedRecording || isRefreshingSummary || isUndoingSummary || isPreparingRegeneration}
                                  >
                                    {isRefreshingSummary ? (
                                      <AiWaitOrb state="composing" theme="light" className="mr-2" />
                                    ) : (
                                      <RefreshCw className="mr-2 h-4 w-4" />
                                    )}
                                    {isRefreshingSummary ? "Picking lines…" : "Regenerate"}
                                  </Button>
                                  {summaryUndo?.recordingId === selectedRecording?.id && (
                                    <Button type="button" size="sm" variant="outline"
                                      aria-label="Restore previous summary" onClick={() => void handleUndoSummary()}
                                      disabled={isRefreshingSummary || isUndoingSummary || isEditingSummary ||
                                        meetingSummary.trim() !== lastSavedMeetingSummaryRef.current.trim()}>
                                      {isUndoingSummary ? "Restoring…" : "Restore previous"}
                                    </Button>
                                  )}
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        aria-label="Regenerate summary with a different playbook"
                                        disabled={!selectedRecording || isRefreshingSummary || isUndoingSummary || isPreparingRegeneration}
                                      >
                                        Different playbook
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                                      {getAllMeetingTemplateOptions(customMeetingTemplates).map(
                                        (template) => (
                                          <DropdownMenuItem
                                            key={template.value}
                                            onClick={() =>
                                              requestRegeneration("summary", template.value)
                                            }
                                          >
                                            {template.label}
                                            {template.isCustom ? " (yours)" : ""}
                                            {template.value === meetingTemplateId
                                              ? " (current)"
                                              : ""}
                                          </DropdownMenuItem>
                                        )
                                      )}
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      toggleReadAloudPlayback(meetingSummary, "meeting-summary")
                                    }
                                    disabled={!selectedRecording || !meetingSummary.trim()}
                                  >
                                    <Volume2 className="mr-2 h-4 w-4" />
                                    {activeSpeechTarget === "meeting-summary"
                                      ? "Stop reading"
                                      : "Read aloud"}
                                  </Button>
                                </>
                              }
                            />
                            {analysisProgressByTarget.summary ? (
                              <p role="status" className="text-sm text-muted-foreground">
                                {analysisProgressByTarget.summary.message}
                              </p>
                            ) : null}
                            {analysisFailureByTarget.summary ? (
                              <p role="alert" className="text-sm text-rust">
                                {selectedRecording?.summary?.trim()
                                  ? "Couldn't generate a new summary. Your saved summary is unchanged."
                                  : "Couldn't generate the summary."}{" "}
                                {analysisFailureByTarget.summary.reason}
                              </p>
                            ) : null}

                            <div className="border-t pt-5">
                              {requestedActionFocus && requestedActionFocus.recordingId === selectedRecording?.id
                                && !selectedMeetingActionItems.includes(requestedActionFocus.task.trim()) ? (
                                  <p role="status" className="mb-3 text-sm text-muted-foreground">
                                    This follow-up isn't in the current action items. Review the meeting below.
                                  </p>
                                ) : null}
                              <DocumentField
                                label="Action items"
                                value={meetingActionItemsText}
                                renderValue={actionItemsToMarkdownList(selectedMeetingActionItems)}
                                renderEmptyBody
                                renderBody={
                                  <div className="space-y-2">
                                    {selectedMeetingActionItems.length === 0 && actionTaskFilter !== "done" ? (
                                      <p className="text-sm text-muted-foreground">Nothing here yet. Regenerate to have Plainsong pull them from the transcript.</p>
                                    ) : null}
                                    {completedMeetingTasks ? (
                                      <div className="flex flex-wrap items-center justify-between gap-2">
                                        <span className="text-xs text-muted-foreground">{openMeetingActionItems.length} open · {completedMeetingActionCount} done</span>
                                        <div className="flex gap-1" role="group" aria-label="Task visibility">
                                          <Button type="button" size="sm" variant={actionTaskFilter === "all" ? "secondary" : "ghost"}
                                            aria-pressed={actionTaskFilter === "all"} onClick={() => setActionTaskFilter("all")}>All tasks</Button>
                                          <Button type="button" size="sm" variant={actionTaskFilter === "open" ? "secondary" : "ghost"}
                                            aria-pressed={actionTaskFilter === "open"} onClick={() => setActionTaskFilter("open")}>Open tasks</Button>
                                          <Button type="button" size="sm" variant={actionTaskFilter === "done" ? "secondary" : "ghost"}
                                            aria-pressed={actionTaskFilter === "done"} onClick={() => setActionTaskFilter("done")}>Done tasks</Button>
                                        </div>
                                      </div>
                                    ) : null}
                                    {actionTaskFilter === "open" && selectedMeetingActionItems.length > 0 && openMeetingActionItems.length === 0 ? (
                                      <p className="text-sm text-muted-foreground">All tasks are done. Choose All tasks to review them.</p>
                                    ) : null}
                                    {actionTaskFilter === "done" && doneMeetingActionItems.length === 0 ? (
                                      <p className="text-sm text-muted-foreground">No tasks are done yet. Mark a task complete to see it here.</p>
                                    ) : null}
                                    <ActionItemList items={actionTaskFilter === "open" ? openMeetingActionItems : actionTaskFilter === "done" ? doneMeetingActionItems : selectedMeetingActionItems}
                                      sourceKey={selectedRecording?.id}
                                      sourceItems={selectedMeetingActionItems}
                                      evidence={actionItemEvidence}
                                      unclear={actionItemUnclear}
                                      onInteractionChange={changeActionRowInteraction}
                                      focusedTask={requestedActionFocus && requestedActionFocus.recordingId === selectedRecording?.id ? requestedActionFocus.task : undefined}
                                      completedTasks={completedMeetingTasks}
                                      disabled={!completedMeetingTasks || savingActionCompletion || isPreparingRegeneration || isRefreshingActionItems}
                                      onCompletionChange={changeActionCompletion}
                                      onEdit={!isEditingActionItems ? (original, replacement) => mutateActionRow(original, replacement) : undefined}
                                      onAdd={!isEditingActionItems ? (replacement) => mutateActionRow(null, replacement) : undefined}
                                      onDelete={!isEditingActionItems ? (original, sourceIndex) => mutateActionRow(original, null, sourceIndex) : undefined} />
                                    {savingActionCompletion ? <p role="status" className="text-xs text-muted-foreground">Saving task change…</p> : null}
                                    {actionCompletionError ? <p role="alert" className="text-sm text-rust">{actionCompletionError}</p> : null}
                                  </div>
                                }
                                onChange={(next) => {
                                  markAnalysisDraftEdit("actions", next);
                                  setMeetingActionItemsText(next);
                                  setUserEditedActionItemsText(next);
                                }}
                                isEditing={isEditingActionItems}
                                onEditingChange={(editing) => {
                                  if (editing) setRequestedActionFocus(null);
                                  setIsEditingActionItems(editing);
                                }}
                                disabled={!selectedRecording || isPreparingRegeneration || isRefreshingActionItems || savingActionCompletion || actionRowInteraction}
                                emptyMessage="Nothing here yet. Regenerate to have Plainsong pull them from the transcript."
                                editorPlaceholder="One follow-up per line. Owners and dates can go on the same line."
                                caption={
                                  !meetingActionItemsText.trim()
                                    ? undefined
                                    : actionItemsAuthorship === "plainsong" &&
                                        unattributedActionItemCount > 0
                                      ? // The two hands mix line by line here, so
                                        // the caption says so rather than handing
                                        // the whole list to either one.
                                        `Found by Plainsong, plus ${unattributedActionItemCount} line${
                                          unattributedActionItemCount === 1 ? "" : "s"
                                        } Plainsong did not write.`
                                      : ACTION_ITEMS_AUTHORSHIP_CAPTION[actionItemsAuthorship]
                                }
                                bodyClassName={
                                  meetingActionItemsText.trim()
                                    ? RECAP_AUTHORSHIP_TREATMENT[actionItemsAuthorship]
                                    : RECAP_AUTHORSHIP_TREATMENT.user
                                }
                                actions={
                                  <>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      aria-label="Regenerate action items"
                                      onClick={() => requestRegeneration("actions")}
                                      disabled={!selectedRecording || isRefreshingActionItems || isPreparingRegeneration}
                                    >
                                      {isRefreshingActionItems ? (
                                        <AiWaitOrb state="composing" className="mr-2" />
                                      ) : (
                                        <RefreshCw className="mr-2 h-4 w-4" />
                                      )}
                                      {isRefreshingActionItems ? "Picking lines…" : "Regenerate"}
                                    </Button>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      onClick={() =>
                                        toggleReadAloudPlayback(
                                          meetingActionItemsText,
                                          "meeting-action-items"
                                        )
                                      }
                                      disabled={
                                        !selectedRecording || !meetingActionItemsText.trim()
                                      }
                                    >
                                      <Volume2 className="mr-2 h-4 w-4" />
                                      {activeSpeechTarget === "meeting-action-items"
                                        ? "Stop reading"
                                        : "Read aloud"}
                                    </Button>
                                  </>
                                }
                              />
                              {analysisProgressByTarget.actionItems ? (
                                <p role="status" className="mt-2 text-sm text-muted-foreground">
                                  {analysisProgressByTarget.actionItems.message}
                                </p>
                              ) : null}
                              {analysisFailureByTarget.actionItems ? (
                                <p role="alert" className="mt-2 text-sm text-rust">
                                  {(selectedRecording?.actionItems?.length ?? 0) > 0
                                    ? "Couldn't generate new action items. Your saved action items are unchanged."
                                    : "Couldn't generate action items."}{" "}
                                  {analysisFailureByTarget.actionItems.reason}
                                </p>
                              ) : null}
                            </div>
                          </section>
                          {/* Provenance. The boxes above carry the authorship mark —
                              machine-set text in the quieter ink behind a bronze
                              rule, the reader's own in full ink, text with no
                              recorded author behind a neutral rule. This is the
                              evidence for the machine-set lines: each one either
                              names the transcript moment it came from, in a row big
                              enough to hit, or says plainly that it has none. */}
                          <div className="mt-4 border-t pt-4">
                            <h3 className="section-heading">Where this came from</h3>
                            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                              The transcript lines and written notes behind the text above.
                              Transcript quotes jump to that moment. Written notes stay here.
                              Unchecked lines from older recaps are shown for comparison only.
                            </p>

                            {!hasRecapProvenance ? (
                              <p className="mt-3 text-sm text-muted-foreground">
                                Nothing quoted yet. Regenerate the summary or the action items and
                                Plainsong will record which transcript lines it used.
                              </p>
                            ) : (
                              <div className="mt-3 space-y-4">
                                {summaryProvenance ? (
                                  <div>
                                    <p className="rubric-muted">Summary</p>
                                    {selectedRecording?.summaryProvenance ? (
                                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                                        {selectedRecording.summaryProvenance.actualProvider} ·{" "}
                                        {selectedRecording.summaryProvenance.actualModel} · finished{" "}
                                        {formatDateTime(selectedRecording.summaryProvenance.completedAt)}
                                      </p>
                                    ) : null}
                                    {!summaryHasNewerNotes && (!hasCurrentGroundingPolicy(selectedRecording?.summaryProvenance) ||
                                    !summaryProvenance.grounded || summaryProvenance.citations.length === 0) ? (
                                      <p className="mt-1.5 inline-flex items-center gap-1.5 text-sm text-rust">
                                        <span className="neume neume-hollow" aria-hidden="true" />
                                        {selectedRecording?.summaryProvenance &&
                                        selectedRecording.summaryProvenance.groundingPolicyVersion !== SUMMARY_GROUNDING_POLICY_VERSION
                                          ? "This summary has not been checked under the current meaning checks. Review it against the transcript or regenerate it."
                                          : summaryProvenance.citations.length === 0
                                          ? "No transcript line was quoted for this summary — read it against the transcript before you send it."
                                          : selectedAnalysisSourceReview ?? "This summary needs review. Check its quoted sources before sharing."}
                                      </p>
                                    ) : null}
                                    {selectedRecording?.summaryProvenance?.unverifiedStatements?.length && !summaryHasNewerNotes ? (
                                      <UnverifiedSummaryStatements
                                        statements={selectedRecording.summaryProvenance.unverifiedStatements}
                                      />
                                    ) : null}
                                    {summaryProvenance.citations.length > 0 ? (
                                      <div className="mt-2 grid gap-1.5">
                                        {summaryProvenance.citations.map((citation, index) => (
                                          <RecapCitation
                                            key={`summary-citation-${index}`}
                                            citation={citation}
                                            grounded={summaryProvenance.grounded && hasCurrentGroundingPolicy(selectedRecording?.summaryProvenance)}
                                            recording={selectedRecording}
                                            onJumpToTranscript={jumpToTranscriptMoment}
                                            onOpenWrittenNotes={openWrittenNotes}
                                            currentNotes={meetingNotes}
                                          />
                                        ))}
                                      </div>
                                    ) : null}
                                  </div>
                                ) : null}

                                {generatedActionItemProvenance.length > 0 ? (
                                  <div>
                                    <p className="rubric-muted">Action items</p>
                                    {selectedRecording?.actionItemsProvenance ? (
                                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                                        {selectedRecording.actionItemsProvenance.actualProvider} ·{" "}
                                        {selectedRecording.actionItemsProvenance.actualModel} · finished{" "}
                                        {formatDateTime(selectedRecording.actionItemsProvenance.completedAt)}
                                      </p>
                                    ) : null}
                                    <div className="mt-1.5 space-y-3">
                                      {generatedActionItemProvenance.map((entry, entryIndex) => (
                                        <div key={`action-provenance-${entryIndex}`}>
                                          <p className="manuscript max-w-prose border-l-2 border-gold-ambient/50 pl-3 text-sm leading-relaxed text-muted-foreground">
                                            {entry.item}
                                          </p>
                                          {!hasCurrentGroundingPolicy(selectedRecording?.actionItemsProvenance) || !entry.grounded || entry.citations.length === 0 ? (
                                            <p className="mt-1 inline-flex items-center gap-1.5 text-sm text-rust">
                                              <span className="neume neume-hollow" aria-hidden="true" />
                                              {!hasCurrentGroundingPolicy(selectedRecording?.actionItemsProvenance)
                                                ? "These action items have not been checked under the current meaning checks. Review them against the transcript or regenerate them."
                                                : entry.citations.length === 0
                                                ? "No transcript line was quoted for this follow-up."
                                                : selectedAnalysisSourceReview ?? "This follow-up needs review. Check its quoted sources before sharing."}
                                            </p>
                                          ) : null}
                                          {entry.citations.length > 0 ? (
                                            <div className="mt-1.5 grid gap-1.5">
                                              {entry.citations.map((citation, citationIndex) => (
                                                <RecapCitation
                                                  key={`action-citation-${entryIndex}-${citationIndex}`}
                                                  citation={citation}
                                                  grounded={entry.grounded && hasCurrentGroundingPolicy(selectedRecording?.actionItemsProvenance)}
                                                  recording={selectedRecording}
                                                  onJumpToTranscript={jumpToTranscriptMoment}
                                                  onOpenWrittenNotes={openWrittenNotes}
                                                  currentNotes={meetingNotes}
                                                />
                                              ))}
                                            </div>
                                          ) : null}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            )}
                          </div>

                        <section className="space-y-3 border-t pt-5">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <h2 className="section-heading">Tidied draft of your notes</h2>
                                  {enhancedMeetingNotesIsStale ? (
                                    <Badge variant="outline" className="bg-rust/10 text-rust">
                                      Your notes changed since this
                                    </Badge>
                                  ) : null}
                                </div>
                                <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                                  A separate AI draft built from your notes and transcript. Saving
                                  keeps your written notes and recap unchanged. Review the quotes below.
                                </p>
                                {enhancedMeetingNotesDraft ? (
                                  <p className="mt-2 text-sm text-muted-foreground">
                                    Generated{" "}
                                    {formatDateTime(enhancedMeetingNotesDraft.generatedAt)}. {enhancedDraftSaveStatus === "saved" ? "Saved separately." : enhancedDraftSaveStatus === "saving" ? "Saving draft…" : "Unsaved draft."}
                                  </p>
                                ) : null}
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void handleEnhanceMeetingNotes()}
                                  disabled={!selectedRecording || isEnhancingMeetingNotes}
                                >
                                  {isEnhancingMeetingNotes ? (
                                    <AiWaitOrb state="composing" className="mr-2" />
                                  ) : (
                                    <RefreshCw className="mr-2 h-4 w-4" />
                                  )}
                                  {isEnhancingMeetingNotes
                                    ? "Writing…"
                                    : enhancedMeetingNotesDraft
                                      ? "Build it again"
                                      : "Build a draft"}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void handleCopyEnhancedMeetingNotes()}
                                  disabled={!enhancedMeetingNotesDraft?.text.trim()}
                                >
                                  <Copy className="mr-2 h-4 w-4" />
                                  Copy
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void handleSaveEnhancedMeetingNotes()}
                                  disabled={!enhancedMeetingNotesDraft?.text.trim() || enhancedDraftSaveStatus === "saving" || enhancedDraftSaveStatus === "saved" || (enhancedDraftRemovalStatus === "removing" && savedEnhancedDraft?.revision === enhancedDraftRevision.current)}
                                >
                                  <CheckCircle2 className="mr-2 h-4 w-4" />
                                  {enhancedDraftSaveStatus === "saving" ? "Saving draft…" : enhancedDraftSaveStatus === "error" ? "Retry save draft" : "Save draft"}
                                </Button>
                                {savedEnhancedDraft?.recordingId === selectedRecording?.id ? (
                                  <Button type="button" size="sm" variant="outline"
                                    onClick={() => void handleRemoveEnhancedMeetingNotes()}
                                    disabled={enhancedDraftRemovalStatus === "removing" || enhancedDraftSaveStatus === "saving" || enhancedDraftWriteChains.current.has(savedEnhancedDraft?.recordingId ?? "")}>
                                    {enhancedDraftRemovalStatus === "removing" ? "Removing saved draft…" : enhancedDraftRemovalStatus === "error" ? "Retry remove saved draft" : "Remove saved draft"}
                                  </Button>
                                ) : null}
                              </div>
                            </div>

                            {enhancedDraftRemovalError ? <p role="alert" className="text-sm text-rust">{enhancedDraftRemovalError}</p> : null}
                            {enhancedDraftSaveError ? <p role="alert" className="text-sm text-rust">{enhancedDraftSaveError}</p> : null}
                            {enhancedMeetingNotesDraft ? (
                              <div className="space-y-4">
                                {/* The draft is read as the document it would
                                    become, not as a scrollable text box. */}
                                <div
                                  role="region"
                                  aria-label="Enhanced meeting notes draft"
                                  className="border-l-2 border-l-gold-ambient/60 pl-3 text-muted-foreground"
                                >
                                  <MarkdownText value={enhancedMeetingNotesDraft.text} />
                                </div>

                                <div className="space-y-3 border-t pt-4">
                                  {/* Saved drafts have no grounding verdict. Keep
                                      quotes unverified while allowing valid transcript jumps. */}
                                  <h3 className="section-heading">
                                    Sources behind this draft
                                  </h3>

                                  <div className="space-y-2">
                                    <p className="text-sm font-medium">Summary</p>
                                    {enhancedMeetingNotesDraft.summaryCitations.length > 0 ? (
                                      enhancedMeetingNotesDraft.summaryCitations.map((citation, index) => (
                                        <RecapCitation
                                          key={`enhanced-summary-citation-${index}`}
                                          citation={citation}
                                          grounded={false}
                                          recording={selectedRecording}
                                          onJumpToTranscript={jumpToTranscriptMoment}
                                          onOpenWrittenNotes={openWrittenNotes}
                                          currentNotes={meetingNotes}
                                        />
                                      ))
                                    ) : (
                                      <p className="text-sm text-muted-foreground">
                                        Plainsong quoted no source for this summary.
                                      </p>
                                    )}
                                  </div>

                                  <div className="space-y-2">
                                    <p className="text-sm font-medium">Action items</p>
                                    {enhancedMeetingNotesDraft.actionItemCitations.some(
                                      (group) => group.citations.length > 0
                                    ) ? (
                                      enhancedMeetingNotesDraft.actionItemCitations.map((group, groupIndex) => (
                                        <div
                                          key={`enhanced-action-group-${groupIndex}`}
                                          className="border-t border-border/60 pt-2"
                                        >
                                          <p className="text-sm font-medium">{group.label}</p>
                                          <div className="mt-2 space-y-2">
                                            {group.citations.length > 0 ? (
                                              group.citations.map((citation, citationIndex) => (
                                                <RecapCitation
                                                  key={`enhanced-action-citation-${groupIndex}-${citationIndex}`}
                                                  citation={citation}
                                                  grounded={false}
                                                  recording={selectedRecording}
                                                  onJumpToTranscript={jumpToTranscriptMoment}
                                                  onOpenWrittenNotes={openWrittenNotes}
                                                  currentNotes={meetingNotes}
                                                />
                                              ))
                                            ) : (
                                              <p className="text-sm text-muted-foreground">
                                                Nothing was quoted for this one.
                                              </p>
                                            )}
                                          </div>
                                        </div>
                                      ))
                                    ) : (
                                      <p className="text-sm text-muted-foreground">
                                        Plainsong quoted no sources for these.
                                      </p>
                                    )}
                                  </div>
                                </div>
                              </div>
                            ) : (
                              <p className="max-w-prose text-sm text-muted-foreground">
                                Nothing built yet. Build a draft to review it here. Saving it keeps
                                your written notes and recap unchanged.
                              </p>
                            )}
                        </section>

                        <section className="border-t pt-5">
                          {/* The playbook name is already on the header strip
                              above and in the picker under "Your notes"; a
                              third bare badge here said nothing new. */}
                          <h2 className="section-heading">Before the next one</h2>
                          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                            Questions worth asking while the conversation is live, and the people
                            and companies this meeting shares with earlier ones.
                          </p>
                          <div className="mt-3 space-y-4">
                            <div>
                              <p className="text-sm font-medium">Questions to ask</p>
                              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                                {selectedMeetingPrepPrompts.map((prompt) => (
                                  <li key={prompt}>{prompt}</li>
                                ))}
                              </ul>
                            </div>
                            <div className="border-t pt-4">
                              <p className="text-sm font-medium">Seen in earlier meetings</p>
                                {selectedMeetingRelationshipMatches.people.length === 0 &&
                                selectedMeetingRelationshipMatches.companies.length === 0 ? (
                                  <p className="mt-2 text-sm text-muted-foreground">
                                    Nothing yet. People and companies show up here once they appear
                                    in more than one meeting.
                                  </p>
                                ) : (
                                  <div className="mt-2 space-y-2">
                                    {selectedMeetingRelationshipMatches.people.map((person) => (
                                      <div key={`person-${person.id}`} className="border-l-2 border-border pl-3">
                                        <p className="text-sm font-medium">{person.name}</p>
                                        <p className="time-spec mt-1 text-sm text-muted-foreground">
                                          {person.recordingCount} meetings · last seen{" "}
                                          {formatDate(person.lastSeenAt)}
                                        </p>
                                        {person.recentMeetings[0] ? (
                                          <p className="mt-2 text-sm text-muted-foreground">
                                            {person.recentMeetings[0].snippet}
                                          </p>
                                        ) : null}
                                      </div>
                                    ))}
                                    {selectedMeetingRelationshipMatches.companies.map((company) => (
                                      <div key={`company-${company.id}`} className="border-l-2 border-border pl-3">
                                        <p className="text-sm font-medium">{company.name}</p>
                                        <p className="time-spec mt-1 text-sm text-muted-foreground">
                                          {company.recordingCount} meetings · last seen{" "}
                                          {formatDate(company.lastSeenAt)}
                                        </p>
                                        {company.recentMeetings[0] ? (
                                          <p className="mt-2 text-sm text-muted-foreground">
                                            {company.recentMeetings[0].snippet}
                                          </p>
                                        ) : null}
                                      </div>
                                    ))}
                                  </div>
                                )}
                            </div>
                          </div>
                        </section>

                        <section className="border-t pt-5">
                          <h2 className="section-heading">Follow-up drafts</h2>
                          <div className="mt-3 grid gap-2 sm:grid-cols-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void handleCopyMeetingFollowUp(deterministicMeetingFollowUp)}
                              >
                                <Copy className="mr-2 h-4 w-4" />
                                Copy follow-up email
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  void handleCopyMeetingFollowUp(
                                    `${meetingSummary.trim() || "Quick recap"}\n\n${selectedMeetingActionItems
                                      .map((item) => `- ${completedMeetingTasks ? `[${completedMeetingTasks.has(item) ? "x" : " "}] ` : ""}${item}`)
                                      .join("\n")}`.trim()
                                  )
                                }
                              >
                                <Copy className="mr-2 h-4 w-4" />
                                Copy short recap for chat
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={!completedMeetingTasks || savingActionCompletion}
                                onClick={() => void handleCopyMeetingFollowUp(deterministicNextAgenda)}
                              >
                                <Copy className="mr-2 h-4 w-4" />
                                Copy next agenda
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  void handleCopyMeetingFollowUp(
                                    selectedMeetingActionItems.length > 0
                                      ? selectedMeetingActionItems.map((item) => `- ${completedMeetingTasks ? `[${completedMeetingTasks.has(item) ? "x" : " "}] ` : ""}${item}`).join("\n")
                                      : "- Review this meeting summary\n- Confirm owners and dates"
                                  )
                                }
                              >
                                <Copy className="mr-2 h-4 w-4" />
                                Copy task list
                              </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                toggleReadAloudPlayback(
                                  deterministicMeetingFollowUp,
                                  "meeting-follow-up"
                                )
                              }
                              disabled={
                                !selectedRecording ||
                                (!meetingSummary.trim() && selectedMeetingActionItems.length === 0)
                              }
                            >
                              <Volume2 className="mr-2 h-4 w-4" />
                              {activeSpeechTarget === "meeting-follow-up"
                                ? "Stop reading"
                                : "Read follow-up aloud"}
                            </Button>
                          </div>
                        </section>

                        <section className="border-t pt-5">
                          <h2 className="section-heading">Ask across your earlier meetings</h2>
                          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                            For when an older promise, deadline, or repeated request should change
                            what you send after this one.
                          </p>
                          <div className="mt-3 space-y-3">
                              <div className="flex flex-wrap gap-2">
                                {selectedMeetingRecallPrompts.map((suggestion) => (
                                  <Button
                                    key={suggestion.prompt}
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    title={suggestion.prompt}
                                    onClick={() => void runMeetingRecall(suggestion.prompt)}
                                    disabled={meetingRecallLoading}
                                  >
                                    {suggestion.label}
                                  </Button>
                                ))}
                              </div>
                              <div className="flex gap-2">
                                <Input
                                  value={meetingRecallQuery}
                                  onChange={(event) => {
                                    ++meetingRecallQueryRevisionRef.current;
                                    setMeetingRecallQuery(event.target.value);
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                                      event.preventDefault();
                                      void runMeetingRecall();
                                    }
                                  }}
                                  placeholder="What did we agree last time?"
                                  aria-label="Ask across your earlier meetings"
                                />
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={() => void runMeetingRecall()}
                                  disabled={meetingRecallLoading || !meetingRecallQuery.trim()}
                                >
                                  {meetingRecallLoading ? (
                                    <>
                                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                      Asking
                                    </>
                                  ) : (
                                    "Ask"
                                  )}
                                </Button>
                              </div>
                              <p role="status" aria-label="Earlier meetings answer status" aria-live="polite" aria-atomic="true" className="sr-only">
                                {meetingRecallError ? "Answer failed. Try again." : meetingRecallLoading ? "Asking about earlier meetings." : meetingRecallResponse ? "Answer ready." : ""}
                              </p>
                              {meetingRecallLoading && displayedMeetingRecallRun && (
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <p className="text-sm text-muted-foreground">{displayedMeetingRecallRun.cancelRequested ? "Cancelling" : "Asking"}: {displayedMeetingRecallRun.prompt}</p>
                                  <Button type="button" size="sm" variant="outline"
                                    disabled={displayedMeetingRecallRun.cancelRequested}
                                    onClick={() => { void cancelMeetingRecall(displayedMeetingRecallRun.runId); }}>
                                    {displayedMeetingRecallRun.cancelRequested ? "Cancelling…" : "Cancel recall"}
                                  </Button>
                                </div>
                              )}
                              {meetingRecallCancelStatus && <p role="status" className="text-sm text-muted-foreground">{meetingRecallCancelStatus}</p>}
                              {meetingRecallError ? (
                                <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                  {meetingRecallError}
                                </div>
                              ) : null}
                              {meetingRecallResponse ? (
                                <div role="region" aria-label="Earlier meetings answer" className="space-y-3 border-l-2 border-gold-ambient/50 pl-3">
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <p className="text-sm font-medium text-muted-foreground">
                                        {meetingRecallPromptLabel ?? "The answer"}
                                      </p>
                                      <MarkdownText
                                        className="mt-2"
                                        value={meetingRecallResponse}
                                      />
                                    </div>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => void handleCopyMeetingRecall(meetingRecallResponse)}
                                    >
                                      <Copy className="mr-2 h-4 w-4" />
                                      Copy
                                    </Button>
                                  </div>
                                  {meetingRecallReviewWarning && (
                                    <p className="rounded-md border border-rust/30 bg-rust/10 px-3 py-2 text-sm text-rust">{meetingRecallReviewWarning}</p>
                                  )}
                                  {meetingRecallCitations.length > 0 ? (
                                    <div className="space-y-2">
                                      <p className="text-sm font-medium text-muted-foreground">
                                        References from earlier meetings
                                      </p>
                                      {meetingRecallCitations.slice(0, 3).map((citation, index) => {
                                        // These quotes come from other meetings, so
                                        // a bare timestamp would read as a moment in
                                        // the meeting on screen. Name the meeting the
                                        // quote was taken from; fall back to its id
                                        // if that meeting is not in the loaded list.
                                        const canOpenSource = Boolean(citation.recordingId?.trim())
                                          && (citation.sourceKind == null || citation.sourceKind === "transcript")
                                          && typeof citation.startTime === "number" && Number.isFinite(citation.startTime) && citation.startTime >= 0
                                          && typeof citation.endTime === "number" && Number.isFinite(citation.endTime) && citation.endTime >= citation.startTime;
                                        const sourceMeeting = citation.recordingId
                                          ? (effectiveRecordings.find(
                                              (recording) => recording.id === citation.recordingId
                                            )?.title ?? citation.recordingId)
                                          : null;
                                        return (
                                          <div
                                            key={`meeting-recall-citation-${index}`}
                                            className="border-t border-border/60 pt-2"
                                          >
                                            <p className="manuscript text-sm">{citation.text}</p>
                                            <p className="mt-1 text-sm text-muted-foreground">
                                              {sourceMeeting ? `${sourceMeeting} · ` : null}
                                              <span className="time-spec font-mono">
                                                {citationSourceLabel(citation)}
                                              </span>
                                            </p>
                                            {canOpenSource && <Button type="button" size="sm" variant="outline" className="mt-2"
                                              aria-label={`Open source meeting: ${sourceMeeting ?? citation.recordingId}`}
                                              onClick={() => { void openRequestedWorkspace({
                                                recordingId: citation.recordingId!,
                                                focusSegmentTime: citation.startTime!,
                                                highlightQuery: citation.text,
                                              }); }}>
                                              Open source meeting
                                            </Button>}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  ) : null}
                                </div>
                              ) : (
                                <p className="text-sm text-muted-foreground">
                                  Pick one of the suggestions above, or type your own question.
                                </p>
                              )}
                          </div>
                        </section>

                        <section className="border-t pt-5">
                          <h2 className="section-heading">Share and export</h2>
                          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                            The recap is the summary, the action items, and your notes as Markdown
                            — safe to paste into a chat window or a notes app. The full record adds
                            every word that was said, so only copy that where the whole meeting is
                            allowed to go.
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void handleCopyMeetingRecap()}
                                disabled={
                                  meetingRecordCopyPending
                                  || !selectedRecording
                                  || !selectedMeetingRecapMarkdown.trim()
                                }
                              >
                                <Copy className="mr-2 h-4 w-4" />
                                Copy recap
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void handleCopyMeetingFullRecord()}
                                disabled={
                                  meetingRecordCopyPending
                                  || !selectedRecording
                                  || !selectedTranscript?.fullText?.trim()
                                }
                              >
                                <Copy className="mr-2 h-4 w-4" />
                                Copy full record, transcript and all
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void handleExportMeetingArtifact("markdown")}
                                disabled={!selectedRecording || isExportingMeeting}
                              >
                                <FileText className="mr-2 h-4 w-4" />
                                Export as Markdown
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void handleExportMeetingArtifact("text")}
                                disabled={!selectedRecording || isExportingMeeting}
                              >
                                {isExportingMeeting ? (
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                  <FileOutput className="mr-2 h-4 w-4" />
                                )}
                                Export as plain text
                              </Button>
                            </div>
                            {/* The level is fixed here; say so rather than let
                                the file imply more or less scrubbing than it
                                got. Exports offers the other levels. */}
                            <p className="mt-2 text-sm text-muted-foreground">
                              {MEETING_EXPORT_REDACTION_NOTE}
                            </p>
                            {lastMeetingExportPath ? (
                              <div className="mt-3 border-t pt-3 text-sm text-muted-foreground">
                                <div className="flex items-center justify-between gap-3">
                                  <span className="min-w-0 break-all font-mono text-sm">
                                    {lastMeetingExportPath}
                                  </span>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => void handleOpenMeetingExport()}
                                  >
                                    <ExternalLink className="mr-2 h-4 w-4" />
                                    Open
                                  </Button>
                                </div>
                              </div>
                            ) : null}
                        </section>
                        </>
                      )}
                    </div>
                  </ScrollArea>
                </TabsContent>

                <TabsContent value="ask" forceMount className="mt-0 min-h-0 flex-1 overflow-hidden">
                  {isLoadingDetail ? (
                    <div className="px-6 py-5">
                      <WorkspaceSkeleton label="Loading this meeting's transcript and notes." />
                    </div>
                  ) : selectedRecording ? (
                    <ScrollArea type="always" className="h-full min-h-0">
                      <div className="space-y-4 px-6 py-5">
                        <div>
                          <h2 className="section-heading">Ask about this meeting</h2>
                          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                            Answers are drawn from this meeting's transcript and your saved notes
                            — decisions, blockers, owners, follow-ups.
                          </p>
                        </div>
                        <AiAnalysisPanel
                          key={selectedRecording.id}
                          recordingId={selectedRecording.id}
                          sourceNotes={meetingNotes}
                          // The section heading above already names this panel;
                          // the result card gets a plain noun instead of a
                          // second copy of the same title.
                          title="Answer"
                          inputPlaceholder="Ask about decisions, blockers, follow-ups, or anything that was said…"
                          templates={MEETING_ASK_TEMPLATES}
                          emptyStateLabel="Reading this meeting…"
                          analysisMode="grounded"
                          chatMessages={meetingChatMessages}
                          onChatMessagesChange={setMeetingChatMessages}
                          responseActions={[
                            {
                              label: "Use as the summary",
                              onAction: ({ response, citations, provenance }) => {
                                if (!selectedRecording) return;
                                void updateRecordingAnalysis(selectedRecording.id, {
                                  summary: response,
                                  summaryProvenance: provenance,
                                })
                                  .then((recording) => {
                                    const savedSummary =
                                      recording?.summary ?? response.trim();
                                    setMeetingSummary(savedSummary);
                                    setMeetingSummaryProvenance({
                                      summary: savedSummary,
                                      citations,
                                      grounded: provenance.grounded !== false,
                                    });
                                    lastSavedMeetingSummaryRef.current = savedSummary;
                                    setSelectedRecording((current) =>
                                      current?.id === selectedRecording.id
                                        ? {
                                            ...current,
                                            ...(recording ?? {}),
                                            summary: savedSummary,
                                            summaryProvenance: provenance,
                                          }
                                        : current
                                    );
                                  })
                                  .catch((error) => {
                                    toast(
                                      error instanceof Error
                                        ? error.message
                                        : "Couldn't save that answer as the summary.",
                                      "error"
                                    );
                                  });
                              },
                              isVisible: ({ templateId }) => templateId !== "follow_up",
                            },
                            {
                              label: "Add to my notes",
                              onAction: ({ response, templateId }) =>
                                appendMeetingNotesBlock(
                                  templateId === "summary"
                                    ? "Summary"
                                    : templateId === "decisions"
                                      ? "Decisions"
                                      : templateId === "dates"
                                        ? "Deadlines"
                                        : templateId === "follow_up"
                                          ? "Follow-up draft"
                                        : "Answer",
                                  response
                                ),
                            },
                            {
                              label: "Copy follow-up",
                              onAction: ({ response }) => {
                                void handleCopyMeetingFollowUp(response);
                              },
                              isVisible: ({ templateId }) => templateId === "follow_up",
                            },
                          ]}
                          actionItemActions={[
                            {
                              label: "Use as the action items",
                              onAction: ({ items }) =>
                                setMeetingActionItemsText(
                                  actionItemsToText(items.map((item) => formatGroundedActionItem(item)))
                                ),
                            },
                            {
                              label: "Add to my notes",
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

                <TabsContent value="assets" className="mt-0 min-h-0 flex-1 overflow-hidden">
                  {isLoadingDetail ? (
                    <div className="px-6 py-5">
                      <WorkspaceSkeleton label="Loading this meeting's audio." lines={3} />
                    </div>
                  ) : (
                    <ScrollArea type="always" className="h-full min-h-0">
                      <div className="space-y-5 px-6 py-5">
                        <div>
                          <h2 className="section-heading">Waveform</h2>
                          <div className="mt-3">
                            <WaveformVisualizer data={waveformData} height={100} />
                          </div>
                        </div>

                        <div className="border-t pt-4">
                          <h2 className="section-heading">What is kept</h2>
                          <p className="mt-2 text-sm">
                            <span className="text-muted-foreground">Length:</span>{" "}
                            <span className="time-spec font-medium">
                              {formatDuration(selectedRecording?.duration ?? 0)}
                            </span>
                          </p>
                          <p className="mt-1 text-sm">
                            <span className="text-muted-foreground">Recorded:</span>{" "}
                            <span className="time-spec font-medium">
                              {selectedRecording?.createdAt
                                ? formatDateTime(selectedRecording.createdAt)
                                : "Unknown"}
                            </span>
                          </p>
                          <p className="mt-1 text-sm">
                            <span className="text-muted-foreground">Audio file:</span>{" "}
                            <span className="font-medium">
                              {selectedMeetingAssetRetention.audioLabel}
                            </span>
                          </p>
                          <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
                            {selectedMeetingAssetRetention.detail}
                          </p>
                        </div>
                      </div>
                    </ScrollArea>
                  )}
                </TabsContent>
              </Tabs>
            </div>

            <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden border-t border-border/70 lg:border-l lg:border-t-0">
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-5 py-4">
                <div className="min-w-0">
                  <h2 className="section-heading">Transcript</h2>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {isLoadingDetail
                      ? "Loading transcript…"
                      : `${selectedTranscript?.segments?.length ?? 0} ${selectedTranscript?.segments?.length === 1 ? "line" : "lines"} · ${selectedMeetingCaptureMode}`}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void handleRefreshTranscriptPanel()}
                  disabled={isRefreshingTranscriptPanel || !selectedRecording}
                >
                  {isRefreshingTranscriptPanel ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  Refresh
                </Button>
              </div>

              {/* Decoded lines land here before they are written to the
                  transcript, so the pane is never blank while capture runs. */}
              {isLiveSelectedMeeting && streamChunks.length > 0 ? (
                <div className="shrink-0 border-y border-gold/25 bg-gold/5 px-5 py-3">
                  <p className="rubric-muted">{previewDelay.label}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {previewDelay.caption}
                  </p>
                  <div className="mt-1.5 space-y-1">
                    {streamChunks.slice(-4).map((line, index) => (
                      <TranscriptStreamLineRow
                        key={`live-line-${index}-${line.startTime}`}
                        line={line}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-1">
              {transcriptionActivity && (
                <div className="mb-3 shrink-0"><TranscriptionActivity activity={transcriptionActivity} /></div>
              )}
              {isLoadingDetail ? (
                <WorkspaceSkeleton label="Loading transcript…" lines={8} className="flex-1" />
              ) : selectedTranscript ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  {detailError && (
                    <div role="alert" className="mb-3 flex items-center gap-2 rounded-md border border-rust/30 bg-rust/10 p-3 text-sm text-rust">
                      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {detailError}
                    </div>
                  )}
                  {(!hasSpeakerLabels || selectedTranscriptDetails?.hasSourceAwareSpeakers === false) && (
                    <div className="mb-3 border-b pb-3">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm text-muted-foreground">{hasSpeakerLabels ? "Recheck who said what" : "Speakers not labeled"}</p>
                        {speakerModelPlan?.runModelId === null && !isRunningDiarization ? null : (
                        <Button
                          ref={labelSpeakersButtonRef}
                          size="sm"
                          variant="outline"
                          onClick={handleRunDiarization}
                          disabled={isRunningDiarization}
                        >
                          {isRunningDiarization ? (
                            <>
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                              {diarizationPendingRecordingId === selectedRecording?.id
                                ? "Working…"
                                : "Speaker labeling busy"}
                            </>
                          ) : (
                            hasSpeakerLabels ? "Relabel speakers" : "Label the speakers"
                          )}
                        </Button>
                        )}
                      </div>
                      {speakerModelPlan?.runModelId === null && !isRunningDiarization && selectedRecording ? (
                        <div className="mt-2">
                          <SpeakerModelDownloadNote
                            key={selectedRecording.id}
                            plan={speakerModelPlan}
                            hasSpeakerLabels={hasSpeakerLabels}
                            onDownloaded={async () => {
                              const recordingId = selectedRecording.id;
                              const plan = await refreshSpeakerModelPlan();
                              if (plan?.runModelId) {
                                setDiarizationError(null);
                                // The note (and the button that had focus)
                                // goes away; the next step takes focus.
                                setFocusLabelSpeakers(true);
                                setDiarizationMessage({
                                  recordingId,
                                  text: `The speaker model is downloaded. ${hasSpeakerLabels ? "Choose Relabel speakers to check who said what." : "Choose Label the speakers to split this transcript by who was talking."}`,
                                });
                              }
                            }}
                          />
                        </div>
                      ) : null}
                      {isRunningDiarization
                        && diarizationPendingRecordingId !== selectedRecording?.id && (
                        <p className="mt-2 text-sm text-muted-foreground">
                          Speaker labeling is still running for another meeting.
                        </p>
                      )}
                      {diarizationMessage?.recordingId === selectedRecording?.id && (
                        <p role="status" className="mt-2 text-sm text-gold-text">{diarizationMessage?.text}</p>
                      )}
                      {diarizationError?.recordingId === selectedRecording?.id && (
                        <p role="alert" className="mt-2 text-sm text-destructive">{diarizationError?.text}</p>
                      )}
                    </div>
                  )}
                  {/* One strip of facts instead of four boxes. The capture mode
                      is already in the pane heading above, so it is not
                      repeated here. */}
                  <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
                    <details key={selectedRecording?.id} className="min-w-0 flex-1">
                      <summary className="cursor-pointer text-xs">Transcription details</summary>
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                    <span>
                      {selectedTranscriptDetails?.actualProvider ??
                        selectedTranscript?.actualProvider ??
                        "Transcriber unknown"}
                      {(selectedTranscriptDetails?.modelId ?? selectedTranscript?.modelId)
                        ? ` · ${selectedTranscriptDetails?.modelId ?? selectedTranscript?.modelId}`
                        : ""}
                    </span>
                    <span className="time-spec">
                      {selectedTranscriptDetails?.transcriptionLatencyMs != null
                        ? `Took ${(
                            selectedTranscriptDetails.transcriptionLatencyMs / 1000
                          ).toFixed(1)}s`
                        : "Transcription time unknown"}
                    </span>
                      </div>
                    </details>
                    {/* How to work the transcript, on request. As a standing
                        paragraph it pushed the transcript itself below the
                        fold of a short window on every visit. */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="ml-auto h-7 w-7 shrink-0"
                      aria-label="How to use the transcript"
                      aria-expanded={showTranscriptHelp}
                      aria-controls="transcript-help"
                      title="How to use the transcript"
                      onClick={() => setShowTranscriptHelp((open) => !open)}
                    >
                      <HelpCircle className="h-4 w-4" />
                    </Button>
                  </div>
                  {showTranscriptHelp ? (
                    <p id="transcript-help" className="mb-3 max-w-prose text-sm text-muted-foreground">
                      Click a line to mark your place; with audio loaded, playback jumps there too.
                      The text stays selectable. Double-click it, or use Edit, to correct it. Arrow
                      keys move line by line; Space plays or pauses; ← and → skip five seconds.
                    </p>
                  ) : null}
                  {selectedRecording?.audioPath ? (
                    <AudioPlayer
                      key={selectedRecording.id}
                      ref={audioPlayerRef}
                      recordingId={selectedRecording.id}
                      waveform={waveformData}
                      asideRanges={asideRanges}
                      durationHint={selectedRecording.duration}
                      onTimeUpdate={playhead.set}
                      onError={(message) =>
                        setAudioPlaybackIssue({ recordingId: selectedRecording.id, message })
                      }
                      className="mb-4 shrink-0"
                    />
                  ) : null}
                  <TranscriptSearch
                    query={searchQuery}
                    onQueryChange={(query) => {
                      setSearchQuery(query);
                      setActiveTranscriptMatchIndex(0);
                      // A search the reader types is their own; it must not
                      // inherit a deep link's moment.
                      pendingMatchFocusTimeRef.current = null;
                    }}
                    matchCount={transcriptMatches.length}
                    activeMatchIndex={activeTranscriptMatchIndex}
                    onStepMatch={stepTranscriptMatch}
                    className="mb-4 shrink-0"
                  />
                  <TranscriptNavigator
                    key={`navigator-${selectedRecording?.id}`}
                    segments={transcriptSegments}
                    speakerNames={speakerNames}
                    onNavigate={(time, segmentId) => {
                      if (!selectedRecording) return;
                      setTranscriptSourceNavigation(previous => ({ time, segmentId, recordingId: selectedRecording.id, requestId: (previous?.requestId ?? 0) + 1 }));
                      playhead.set(time);
                      audioPlayerRef.current?.seekTo(time);
                    }}
                  />
                  <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
                    <PlayheadTranscriptViewer
                      key={selectedRecording?.id}
                      playhead={playhead}
                      compactHeader
                      emptyState={
                        selectedRecording?.status === "completed"
                          ? {
                              title: "No speech was heard",
                              message: selectedRecording.audioPath
                                ? "Plainsong finished this meeting but found no words in the recording. If people did speak, check the microphone and meeting audio, then use Re-transcribe from audio."
                                : "Plainsong finished this meeting but found no words in the recording.",
                            }
                          : undefined
                      }
                      sourceNavigation={transcriptSourceNavigation?.recordingId === selectedRecording?.id ? transcriptSourceNavigation : undefined}
                      segments={transcriptSegments}
                      pauseSpans={selectedRecording?.pauseSpans}
                      speakerNames={speakerNames}
                      speakerNameSuggestions={attendeeNameSuggestions(
                        selectedRecording?.attendees,
                      )}
                      provenance={selectedTranscriptProvenance}
                      onSegmentClick={(segment) => {
                        playhead.set(segment.startTime);
                        audioPlayerRef.current?.seekTo(segment.startTime);
                      }}
                      onTogglePlayback={() => audioPlayerRef.current?.togglePlayback()}
                      onSeekBy={(delta) => audioPlayerRef.current?.seekBy(delta)}
                      highlightQuery={searchQuery}
                      activeMatchIndex={activeTranscriptMatchIndex}
                      onMatchesChange={handleTranscriptMatchesChange}
                      onRenameSpeaker={handleRenameSpeaker}
                      speakerVoices={
                        speakerVoicesRecordingId === selectedRecording?.id
                          ? speakerVoices
                          : {}
                      }
                      rememberVoicesEnabled={rememberVoicesEnabled}
                      onConfirmSpeakerVoice={handleConfirmSpeakerVoice}
                      onRejectSpeakerVoice={handleRejectSpeakerVoice}
                      speakerNameOptions={
                        speakerVoicesRecordingId === selectedRecording?.id
                          ? speakerNameOptions
                          : []
                      }
                      onReloadTranscriptForEdit={async () => {
                        if (!selectedRecording) return null;
                        const recordingId = selectedRecording.id;
                        const workspaceEpoch = workspaceOpenRequestRef.current;
                        const isCurrent = () => workspaceMountedRef.current
                          && workspaceOpenRequestRef.current === workspaceEpoch
                          && selectedRecordingIdRef.current === recordingId;
                        if (!isCurrent()) return null;
                        const fresh = await refreshTranscript(recordingId);
                        return isCurrent() ? fresh?.segments ?? null : null;
                      }}
                      onEditSegment={async (segmentIds, newText, expectedSegments) => {
                        if (!selectedRecording || segmentIds.length === 0) return;
                        const recordingId = selectedRecording.id;
                        const workspaceEpoch = workspaceOpenRequestRef.current;
                        const isCurrent = () =>
                          workspaceMountedRef.current
                          && workspaceOpenRequestRef.current === workspaceEpoch
                          && selectedRecordingIdRef.current === recordingId;
                        try {
                          await editTranscriptSpeakerTurn(
                            recordingId,
                            segmentIds,
                            newText,
                            expectedSegments
                          );
                        } catch (error) {
                          const message =
                            error instanceof Error
                              ? error.message
                              : "Couldn't save that transcript edit.";
                          if (isCurrent()) toast(message, "error");
                          throw error;
                        }
                        if (isCurrent()) {
                          setMeetingSummaryProvenance(null);
                          setMeetingActionItemProvenance([]);
                        }
                        const refreshes = await Promise.allSettled([
                          refreshSelectedRecording(recordingId),
                          refreshTranscript(recordingId),
                          refreshTranscriptDetails(recordingId),
                        ]);
                        if (!isCurrent()) return;
                        setMeetingSummaryProvenance(null);
                        setMeetingActionItemProvenance([]);
                        if (refreshes.some((result) => result.status === "rejected")) {
                          toast("Transcript saved, but the meeting could not refresh. Reopen it to load the saved transcript.", "info");
                        } else {
                          toast("Transcript updated.", "success");
                        }
                      }}
                      onDeleteSegments={handleDeleteTranscriptSegments}
                      // Only promised when the audio is actually still attached.
                      deleteRecoveryNote={
                        selectedMeetingAssetRetention.transcriptRecoveryNote
                      }
                    />
                  </div>
                  {asideLoadError ? <p role="status" className="mt-3 text-sm text-muted-foreground">Asides could not be loaded. Reopen this meeting to retry.</p> : null}
                  {selectedRecording ? <MeetingAsides
                    key={`asides-${selectedRecording.id}`}
                    recordingId={selectedRecording.id}
                    asides={meetingAsides}
                    onDelete={asideId => setMeetingAsides(current => current.filter(aside => aside.asideId !== asideId))}
                    onSeek={time => { playhead.set(time); audioPlayerRef.current?.seekTo(time); }}
                  /> : null}
                  <HeardThroughSpeakers
                    key={`heard-${selectedRecording?.id}`}
                    segments={selectedTranscript?.heardThroughSpeakers}
                    onSelect={(segment) => {
                      playhead.set(segment.startTime);
                      audioPlayerRef.current?.seekTo(segment.startTime);
                    }}
                  />
                </div>
              ) : detailError ? (
                <div className="flex-1 flex items-center justify-center text-destructive">
                  <AlertCircle className="h-5 w-5 mr-2" />
                  {detailError}
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-center px-6">
                  {selectedRecording?.status === "processing" ? (
                    <div className="max-w-md text-sm text-muted-foreground">
                      <div className="flex items-center gap-2 text-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span className="font-medium">Transcribing</span>
                      </div>
                      <p className="mt-2 leading-relaxed">
                        No lines have arrived yet. Plainsong keeps checking on its own; refresh if
                        this pane looks stuck.
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void handleRefreshTranscriptPanel()}
                          disabled={isRefreshingTranscriptPanel}
                        >
                          {isRefreshingTranscriptPanel ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="mr-2 h-4 w-4" />
                          )}
                          Refresh now
                        </Button>
                        {selectedMeetingConsent.needsManualNotice ? (
                          <span className="text-sm text-rust">
                            Share the consent notice before you pass this meeting on.
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ) : selectedRecording?.status === "error" || selectedRecording?.status === "pending" ? (
                    <div className="max-w-md text-sm text-muted-foreground">
                      <p className="font-medium text-foreground">
                        {selectedRecording.status === "pending" ? "Transcription pending" : "Transcription failed"}
                      </p>
                      <p className="mt-2 leading-relaxed">
                        {selectedRecording.status === "pending"
                          ? "The recording is saved. Free some memory, then retry transcription."
                          : "Plainsong could not produce a transcript for this meeting. The audio is still saved, so transcription can be run again from the start."}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            selectedRecording && void handleRetranscribeRecording(selectedRecording.id)
                          }
                        >
                          <RefreshCw className="mr-2 h-4 w-4" />
                          Retry transcription
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="max-w-md text-sm text-muted-foreground">
                      <p className="font-medium text-foreground">
                        No transcript yet
                      </p>
                      <p className="mt-2 leading-relaxed">
                        No transcript lines have been written for this meeting. Refresh if
                        processing has already finished; the record beside this pane is still
                        yours to write either way.
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void handleRefreshTranscriptPanel()}
                          disabled={isRefreshingTranscriptPanel || !selectedRecording}
                        >
                          {isRefreshingTranscriptPanel ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="mr-2 h-4 w-4" />
                          )}
                          Refresh
                        </Button>
                        {/* This is also where a reader lands after deleting the
                            last turn, so the way back is offered right here. */}
                        {canRetranscribeRecording(selectedRecording) && !isLiveSelectedMeeting && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              selectedRecording && requestRetranscribeRecording(selectedRecording)
                            }
                          >
                            <RefreshCw className="mr-2 h-4 w-4" />
                            Re-transcribe from audio
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
              </div>
            </aside>
          </div>
        </div>
      ) : (
        <>
      <div ref={listHeaderRef} className="border-b">
      <div className="p-6 pb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <p className="rubric mb-1.5">MEETINGS</p>
          <h1
            ref={listHeadingRef}
            tabIndex={-1}
            className="font-serif text-2xl font-semibold tracking-tight outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            Meetings
          </h1>
          <p className="mt-1 text-muted-foreground">
            Capture meetings, review transcripts, and keep follow-up moving.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Secondary to the one primary CTA on this surface. Disabled while a
              meeting is live: an import and a capture want the same
              post-processing lease, and the sidecar would refuse the second. */}
          <Button
            variant="outline"
            onClick={() => void handleImportAudioFile()}
            disabled={isCaptureRecording || isImportingAudio}
            title="Transcribe an audio file you already have"
          >
            <FolderOpen className="h-4 w-4 mr-2" />
            {isImportingAudio ? "Importing…" : "Import audio…"}
          </Button>
          {isRecording ? (
            <>
              <Button
                variant="outline"
                disabled={isStopping || isTogglingPause}
                onClick={() => void handleTogglePause()}
                aria-label={meetingPaused ? "Resume meeting" : "Pause meeting"}
                title={`${meetingPaused ? "Resume" : "Pause"} (⌘⇧P)`}
              >
                {meetingPaused ? (
                  <Play className="h-4 w-4 mr-2 fill-current" />
                ) : (
                  <Pause className="h-4 w-4 mr-2 fill-current" />
                )}
                {isTogglingPause ? meetingPausePendingLabel : meetingPaused ? "Resume" : "Pause"}
              </Button>
              <Button
                variant="destructive"
                disabled={isStopping}
                onClick={() => void handleStopMeeting()}
              >
                <Square className="h-4 w-4 mr-2 fill-current" />
                {isStopping ? "Stopping…" : "Stop meeting"}
              </Button>
              {meetingStopError?.recordingId === recordingId && <p role="alert" className="max-w-sm text-sm text-rust">
                Stop was not confirmed. Capture may still be running. {meetingStopError.message} Try Stop meeting again.
              </p>}
              {meetingPauseError?.recordingId === recordingId && <p role="alert" className="max-w-sm text-sm text-rust">
                Pause or resume was not confirmed. {meetingPauseError.message} Try again.
              </p>}
            </>
          ) : (
            <Button
              variant="active"
              onClick={() => openMeetingCapture()}
              disabled={!captureIsReady || Boolean(captureConflictNotice)}
            >
              <Mic2 className="h-4 w-4 mr-2" />
              New meeting
            </Button>
          )}
        </div>
      </div>
        {isDictating && <p role="status" className="mt-3 text-sm text-muted-foreground">{captureConflictNotice}</p>}
        {/* The calendar affordance, and nothing else this file has to know
            about. It renders one line at most and usually nothing: the
            component decides, from a permission state this view never reads,
            whether there is anything honest to say. Readiness is deliberately
            not involved — a Mac with no calendar access records meetings
            exactly as well as one with it. */}
        <CalendarMeetingCue
          captureInProgress={isCaptureRecording}
          onStartCapture={(prefill) =>
            openMeetingCapture(meetingCapturePrefillFromCalendarEvent(prefill))
          }
          onOpenMeeting={(recordingId) => {
            const cited = recordings.find((entry) => entry.id === recordingId);
            if (cited) {
              openMeetingWorkspace(cited);
            }
          }}
        />
        {/* Its sibling for a call that is happening right now, found by the
            sidecar's detector. Same shape, same hand-off, same rule about
            never starting anything itself. */}
        <DetectedCallCue
          captureInProgress={isCaptureRecording}
          onStartCapture={(prefill) =>
            openMeetingCapture(meetingCapturePrefillFromDetectedCall(prefill))
          }
        />
      </div>

      <ScrollArea
        className="meetings-list-settle flex-1"
        data-settled={listSettled ? "true" : "false"}
      >
        <div className="p-6">
          {/* Engine loss, said in plain words on the surface the reader is
              actually on. It used to appear only as the bridge's own log line
              on the buried Setup view. */}
          {engineNotice ? <EngineRecoveryBanner notice={engineNotice} onDismiss={dismissEngineNotice} /> : null}

          <MeetingFollowupInbox onOpenMeeting={(recordingId, task) => {
            void openRequestedWorkspace({ recordingId, focusActionItem: task });
          }} />

          {meetingStartFailure ? (
            <StatusBanner
              className="mb-4"
              title="This meeting did not start"
              message={meetingStartFailure.message}
              actions={
                <>
                  {meetingStartFailure.action.label ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        runMeetingStartAction(meetingStartFailure)
                      }
                    >
                      {meetingStartFailure.action.label}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setMeetingStartFailure(null)}
                  >
                    Dismiss
                  </Button>
                </>
              }
            />
          ) : null}

          {/* Rust and "needs attention" are reserved for something that stops
              a meeting being recorded. A missing notes route does not, and
              saying it does beside a working New meeting button was the
              contradiction this view used to ship. */}
          {meetingsReadiness.state !== "ready" ? (
            <div
              role={
                !captureIsReady && meetingsReadiness.state !== "unknown"
                  ? "alert"
                  : "status"
              }
              aria-label={
                captureIsReady
                  ? "Meeting notes are unavailable"
                  : "Meetings need attention"
              }
              className={`mb-4 flex flex-wrap items-start justify-between gap-3 rounded-md border px-4 py-3 ${
                captureIsReady
                  ? "border-border/80 bg-muted/30"
                  : "border-rust/35 bg-rust/10"
              }`}
            >
              <div
                className={`flex min-w-0 items-start gap-2.5 text-sm ${
                  captureIsReady ? "text-muted-foreground" : "text-rust"
                }`}
              >
                <span
                  className={`neume mt-1 shrink-0 ${
                    captureIsReady ? "neume-hollow" : "neume-rust"
                  }`}
                  aria-hidden="true"
                />
                <div>
                  <p
                    className={`font-medium ${
                      captureIsReady ? "text-foreground" : ""
                    }`}
                  >
                    {captureIsReady
                      ? "Meeting notes are unavailable"
                      : "Meetings need attention"}
                  </p>
                  <p className="mt-1 leading-6">
                    {meetingsReadiness.cause?.message ??
                      "Plainsong could not confirm that meetings are ready."}
                  </p>
                </div>
              </div>
              {meetingsReadiness.cause ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    requestReadinessDestination(
                      meetingsReadiness.cause!.action.destination,
                    )
                  }
                >
                  {meetingsReadiness.cause.action.label}
                </Button>
              ) : null}
            </div>
          ) : null}

          {recordingId &&
          ["preparing", "stopping", "processing", "ready", "error", "cancelled", "recoverable"].includes(
            meetingPhase,
          ) &&
          dismissedLifecycleBanner !== `${recordingId}:${meetingPhase}` ? (
            <div
              role={
                ["error", "recoverable"].includes(meetingPhase)
                  ? "alert"
                  : "status"
              }
              className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 ${
                ["error", "recoverable"].includes(meetingPhase)
                  ? "border-rust/35 bg-rust/10 text-rust"
                  : "border-border/80 bg-muted/40 text-foreground"
              }`}
            >
              <div>
                <p className="font-medium">
                  {meetingPhase === "ready"
                    ? "Meeting ready"
                    : meetingPhase === "cancelled"
                      ? "Meeting not saved"
                    : ["error", "recoverable"].includes(meetingPhase)
                      ? "Meeting needs attention"
                      : meetingPhase === "preparing"
                        ? "Preparing meeting capture"
                        : meetingPhase === "stopping"
                          ? "Saving meeting audio"
                          : "Processing meeting"}
                </p>
                <p className="mt-1 text-sm leading-6">
                  {meetingMessage ??
                    (meetingPhase === "ready"
                      ? "The transcript is ready to review."
                      : "Plainsong is preserving the recording while this step finishes.")}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {recordings.some((recording) => recording.id === recordingId) ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const recording = recordings.find(
                        (candidate) => candidate.id === recordingId,
                      );
                      if (recording) openMeetingWorkspace(recording);
                    }}
                  >
                    Open meeting
                  </Button>
                ) : null}
                {/* A finished outcome stays until the next meeting unless
                    the reader puts it away. */}
                {["ready", "error", "cancelled", "recoverable"].includes(meetingPhase) ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setDismissedLifecycleBanner(`${recordingId}:${meetingPhase}`)}
                  >
                    Dismiss
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {autoNameIssue && (
            <Card className="mb-4 border-rust/40 bg-rust/5">
              <CardContent className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-rust">
                      Plainsong could not name this meeting
                    </p>
                    <p className="text-sm text-muted-foreground">{autoNameIssue.message}</p>
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
                                : "Naming it failed again.",
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

          {recordingsError ? (
            <div
              role="alert"
              className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rust/35 bg-rust/10 px-4 py-3"
            >
              <div className="flex min-w-0 items-start gap-2 text-sm text-rust">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <div>
                  <p className="font-medium">Meetings could not be refreshed.</p>
                  <p className="mt-0.5 text-rust">{recordingsError}</p>
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={recordingsLoading}
                onClick={() => void refetch()}
              >
                {recordingsLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                )}
                Retry
              </Button>
            </div>
          ) : null}

          {/* The panel that used to wrap these counts carried a second title
              and tagline restating the page header two inches above it, and
              boxed every count inside a box inside a panel. The counts are the
              only thing here that was information. */}
          <section
            aria-label="Meeting totals"
            className="mb-5 flex flex-wrap gap-x-10 gap-y-3 border-b border-border/60 pb-5"
          >
            {[
              ["Meetings", recordingsHaveLoaded ? meetingStats.total : "—"],
              ["Ready", recordingsHaveLoaded ? meetingStats.completed : "—"],
              ["Hours", recordingsHaveLoaded ? `${meetingStats.totalHours.toFixed(1)}h` : "—"],
              ["Failed", recordingsHaveLoaded ? meetingStats.errors : "—"],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="rubric-muted">{label}</p>
                <p className="mt-1 font-serif text-xl font-semibold tabular-nums tracking-tight">
                  {value}
                </p>
              </div>
            ))}
          </section>

          {/* Flat toolbar, not a second panel: the search, the status filter,
              and the one bulk action, with the filter buttons grouped so a
              screen reader announces what the row of words does. */}
          <section className="mb-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                {/* Wide enough for the placeholder at any width; the filters
                    wrap below it before it gets any narrower. */}
                <div className="relative min-w-[15rem] flex-1 md:max-w-md">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    placeholder="Search meetings and transcripts"
                    title="Searches titles, notes, summaries, action items, and transcripts"
                    aria-label="Search meetings"
                    value={meetingSearch}
                    onChange={(event) => {
                      const value = event.target.value;
                      const query = value.trim();
                      meetingSearchRevisionRef.current += 1;
                      meetingSearchQueryRef.current = query;
                      pendingMeetingSearchRef.current = null;
                      setMeetingSearch(value);
                      setMeetingSearchHits([]);
                      setMeetingSearchError(null);
                      setMeetingSearchResultQuery(null);
                      setMeetingSearchResultStatus(null);
                      setMeetingSearchResultScopeKey(null);
                      setIsSearchingMeetingTranscripts(query.length >= 2);
                    }}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Show only">
                  <Button
                    variant={statusFilter === "all" ? "active" : "outline"}
                    size="sm"
                    aria-pressed={statusFilter === "all"}
                    onClick={() => handleMeetingStatusFilterChange("all")}
                  >
                    All
                  </Button>
                  <Button
                    variant={statusFilter === "completed" ? "active" : "outline"}
                    size="sm"
                    aria-pressed={statusFilter === "completed"}
                    onClick={() => handleMeetingStatusFilterChange("completed")}
                  >
                    Ready
                  </Button>
                  <Button
                    variant={statusFilter === "recording" ? "active" : "outline"}
                    size="sm"
                    aria-pressed={statusFilter === "recording"}
                    onClick={() => handleMeetingStatusFilterChange("recording")}
                  >
                    Recording
                  </Button>
                  <Button
                    variant={statusFilter === "processing" ? "active" : "outline"}
                    size="sm"
                    aria-pressed={statusFilter === "processing"}
                    onClick={() => handleMeetingStatusFilterChange("processing")}
                  >
                    Processing
                  </Button>
                  <Button
                    variant={statusFilter === "error" ? "active" : "outline"}
                    size="sm"
                    aria-pressed={statusFilter === "error"}
                    onClick={() => handleMeetingStatusFilterChange("error")}
                  >
                    Failed
                  </Button>
                </div>
                {/* The blanket move is rare and hard to undo in bulk, so it
                    sits behind the overflow menu rather than on every visit. */}
                {filteredMeetings.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      aria-label="More list actions"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={isBulkReclassifying}
                      onClick={() => {
                        void handleBulkMarkAsDictation(filteredMeetings);
                      }}
                    >
                      <Mic2 className="h-4 w-4 mr-2" />
                      Move all listed to Dictation
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                ) : null}
                </div>
              </div>
              {suspectedDictations.length > 0 ? (
                <div
                  role="status"
                  className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border/80 bg-muted/30 px-4 py-2.5"
                >
                  <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                    {suspectedDictations.length === 1
                      ? "One listed recording is short and microphone-only, like a dictation."
                      : `${suspectedDictations.length} listed recordings are short and microphone-only, like dictations.`}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isBulkReclassifying}
                    onClick={() => {
                      void handleBulkMarkAsDictation(suspectedDictations);
                    }}
                  >
                    {isBulkReclassifying ? (
                      <>
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        Moving…
                      </>
                    ) : suspectedDictations.length === 1 ? (
                      "Move it to Dictation"
                    ) : (
                      "Move them to Dictation"
                    )}
                  </Button>
                </div>
              ) : null}

              {/* Transcript hits are ranked by the backend's bm25 index and open
                  the meeting at the moment they were found. */}
              {meetingSearch.trim().length >= 2 && (
                <div className="mt-4 border-t border-border/60 pt-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="section-heading">Lines from transcripts</h2>
                    <span className="rubric-muted time-spec">
                      {currentMeetingTranscriptSearchFailed
                        ? "Search unavailable"
                        : meetingTranscriptSearchPending
                        ? "Searching"
                        : `${meetingTranscriptHits.length} found`}
                    </span>
                  </div>
                  {currentMeetingTranscriptSearchFailed ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <p className="text-sm text-rust">{meetingSearchError}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={meetingTranscriptSearchPending}
                        onClick={() =>
                          runMeetingTranscriptSearch(
                            meetingSearch.trim(),
                            meetingSearchRevisionRef.current,
                            statusFilter,
                            meetingSearchScopeKey,
                          )
                        }
                      >
                        Retry transcript search
                      </Button>
                    </div>
                  ) : meetingTranscriptHits.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      {meetingTranscriptSearchPending
                        ? "Looking through every transcript…"
                        : "Nothing spoken matched. Meetings whose title, notes, summary, or action items match are still listed below."}
                    </p>
                  ) : (
                    <div className="mt-2 grid gap-1.5">
                      {meetingTranscriptHits.slice(0, 8).map((hit) => (
                        <button
                          key={`${hit.recordingId}-${hit.segmentId}`}
                          type="button"
                          className="rounded-md border border-border/70 bg-background/60 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() =>
                            openMeetingWorkspace(hit.recording, {
                              segmentTime: hit.startTime,
                              highlightQuery: meetingSearch.trim(),
                            })
                          }
                        >
                          <div className="flex items-baseline gap-2">
                            <span className="truncate text-sm font-medium">
                              {hit.recordingTitle || hit.recording.title}
                            </span>
                            <span className="rubric-muted time-spec shrink-0">
                              {formatDuration(Math.floor(hit.startTime))}
                            </span>
                          </div>
                          <p className="manuscript mt-1 line-clamp-2 text-sm text-muted-foreground">
                            {hit.text}
                          </p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
          </section>

          {audioPlaybackIssue && (
            <div className="mb-4">
              <AudioIssueBanner
                meetingTitle={audioIssueMeetingTitle}
                message={audioPlaybackIssue.message}
                onUnlockVault={() => {
                  setAudioPlaybackIssue(null);
                  requestMainView("settings");
                }}
                onDismiss={() => setAudioPlaybackIssue(null)}
              />
            </div>
          )}

          {isRecording && recordingId && (
            <Card className="mb-4 border-gold/40 bg-gold/5">
              <CardContent className="p-4">
                <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-2">
                    <div>
                      {/* The gold neume is the live mark. A separate "Live
                          meeting" chip beside this line said it a second
                          time. */}
                      {meetingPaused ? (
                        <p className="inline-flex items-center gap-1.5 text-sm font-medium text-rust">
                          <span className="neume neume-hollow" aria-hidden="true" />
                          Paused
                        </p>
                      ) : (
                        <p className="inline-flex items-center gap-1.5 text-sm font-medium text-gold-text">
                          <span className="neume neume-lit" aria-hidden="true" />
                          Recording
                        </p>
                      )}
                      <p className="text-sm text-muted-foreground">
                        {meetingPaused
                          ? "Nothing is being kept until you resume; the clock is stopped."
                          : "Take notes while Plainsong captures the audio."}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="bg-background/70">
                        <Users className="mr-1 h-3 w-3" />
                        {activeMeetingCaptureMode}
                      </Badge>
                      <Badge variant="outline" className="bg-background/70">
                        Playbook: {liveMeetingTemplateOption.label}
                      </Badge>
                      {/* The app knows the prompt was shown; it does not know a
                          notice reached anyone. Use the same words the review
                          surface uses, and reserve "sent" for a sent notice.
                          Driven by the meeting's own consent state so it also
                          survives a reload mid-capture. */}
                      {activeMeetingConsent.tracked ? (
                        <Badge variant="outline" className="border-border bg-muted/30 text-foreground">
                          <span className="neume neume-hollow mr-1.5" aria-hidden="true" />
                          {activeMeetingConsent.label}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const fallbackCreatedAt = new Date().toISOString();
                        openMeetingWorkspace(
                          activeMeeting ?? {
                            id: recordingId,
                            title: "Live meeting",
                            projectId: "default",
                            duration: 0,
                            createdAt: fallbackCreatedAt,
                            updatedAt: fallbackCreatedAt,
                            sourceType: "meeting",
                            audioPath: "",
                            metadata: {
                              sampleRate: 0,
                              channels: 1,
                              systemAudio: liveMeetingSystemAudio,
                            },
                            status: "recording",
                            meetingNotes: liveMeetingNotes.trim() ? liveMeetingNotes : null,
                            meetingTemplateId:
                              liveMeetingTemplateId === "auto" ? null : liveMeetingTemplateId,
                          }
                        );
                      }}
                    >
                      <Edit3 className="mr-2 h-4 w-4" />
                      Open this meeting
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isStopping || isTogglingPause}
                      onClick={() => void handleTogglePause()}
                      aria-label={meetingPaused ? "Resume meeting" : "Pause meeting"}
                      title={`${meetingPaused ? "Resume" : "Pause"} (⌘⇧P)`}
                    >
                      {meetingPaused ? (
                        <Play className="mr-2 h-4 w-4 fill-current" />
                      ) : (
                        <Pause className="mr-2 h-4 w-4 fill-current" />
                      )}
                      {isTogglingPause ? meetingPausePendingLabel : meetingPaused ? "Resume" : "Pause"}
                    </Button>
                    <div
                      className={cn(
                        "font-mono text-lg font-semibold",
                        meetingPaused && "text-muted-foreground",
                      )}
                    >
                      <RecordingDurationText />
                    </div>
                  </div>
                </div>
                <RecordingWaveform
                  recordingId={recordingId}
                  isRecording={isRecording}
                  height={56}
                />
                {/* A source that has stopped producing audio is only fixable
                    while the meeting is still running. */}
                {audioSourceWarning ? (
                  <div
                    role="status"
                    className="mt-4 flex items-start gap-2 rounded-md border border-rust/30 bg-rust/10 p-3 text-sm text-rust"
                  >
                    <span className="neume neume-hollow mt-1.5 shrink-0" aria-hidden="true" />
                    <span>
                      <span className="font-medium">{audioSourceWarning.title}</span>{" "}
                      {audioSourceWarning.message}
                    </span>
                  </div>
                ) : null}
                <MeetingMicrophoneFallback recordingId={recordingId} input={meetingMicrophoneInput}
                  dismissed={meetingMicrophoneWarningDismissed} active={meetingPhase === "recording"}
                  onSettings={() => requestSettingsTab("asr")} />
                {/* Two plain columns. These used to be bordered boxes inside a
                    bordered card inside a bordered row — three surfaces deep for
                    a text area and a scrolling list. */}
                <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,1fr)]">
                  <div>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <p className="section-heading">Meeting notes</p>
                      <MeetingNotesSaveIndicator
                        status={
                          meetingNotesSaveStatus?.surface === "live" &&
                          meetingNotesSaveStatus.recordingId === recordingId
                            ? meetingNotesSaveStatus
                            : null
                        }
                        onRetry={() => retryMeetingNotesSave("live")}
                      />
                    </div>
                    <p className="mb-2 text-sm text-muted-foreground">
                      Saved as you type, and read alongside the transcript when Plainsong writes
                      the summary and the action items.
                    </p>
                    <textarea
                      value={liveMeetingNotes}
                      onChange={(e) => setLiveMeetingNotes(e.target.value)}
                      aria-label="Live meeting notes"
                      placeholder="Decisions, names, risks, and next steps as the conversation moves."
                      rows={8}
                      className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/80 focus:outline-none focus:ring-1 focus:ring-gold"
                    />
                  </div>
                  <div>
                    {/* The label and caption come from the stream itself, so
                        they say how far behind the preview actually is. Nothing
                        here may read as a live caption. */}
                    <p className="section-heading text-gold-text">{previewDelay.label}</p>
                    <p className="mb-2 mt-2 text-sm text-muted-foreground">
                      {previewDelay.caption}
                    </p>
                    {streamChunks.length > 0 ? (
                      <div
                        ref={streamScrollRef}
                        className="max-h-48 space-y-1 overflow-y-auto pr-1 text-sm text-muted-foreground"
                      >
                        {streamChunks.map((line, index) => (
                          <TranscriptStreamLineRow
                            key={`preview-line-${index}-${line.startTime}`}
                            line={line}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="flex h-full min-h-[140px] items-center justify-center rounded-md border border-dashed border-gold/20 bg-muted/20 px-4 text-center text-sm text-muted-foreground">
                        Lines appear here a few seconds after they are spoken.
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {!recordingsHaveLoaded && recordingsLoading ? (
            <div className="surface-panel-subtle rounded-2xl px-6 py-8">
              <WorkspaceSkeleton label="Loading your meetings…" lines={6} />
            </div>
          ) : !recordingsHaveLoaded && recordingsError ? null : filteredMeetings.length === 0 ? (
            <div className="surface-panel-subtle rounded-2xl px-6 py-14 text-center">
              <span
                className="neume neume-hollow mx-auto mb-5 !block size-2.5"
                aria-hidden="true"
              />
              <h3 className="font-serif text-lg font-medium tracking-tight">
                {meetings.length === 0
                  ? "No meetings yet"
                  : meetingTranscriptSearchPending
                    ? "Searching transcripts…"
                    : currentMeetingTranscriptSearchFailed
                      ? "Search incomplete"
                      : "Nothing matches"}
              </h3>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                {meetings.length === 0
                  ? "Start one and Plainsong will keep the audio, the transcript, your notes, and a summary together in one place."
                  : meetingTranscriptSearchPending
                    ? "No titles, notes, summaries, or action items match yet. Plainsong is still searching transcripts."
                    : currentMeetingTranscriptSearchFailed
                      ? "No titles, notes, summaries, or action items match. Transcript search failed, so these results are incomplete. Retry above."
                      : "Try a different search, or a different status."}
              </p>
              {meetings.length === 0 && (
                <Button className="mt-4" variant="active" disabled={Boolean(captureConflictNotice)} onClick={() => openMeetingCapture()}>
                  <Mic2 data-icon="inline-start" />
                  Start a meeting
                </Button>
              )}
            </div>
          ) : (
            <div className="grid gap-2">
              {filteredMeetings.map((recording) => {
                const isLiveRow = recording.id === recordingId && isRecording;
                const statusBand = recordingStatusBand(recording.status, isLiveRow);
                const analysisNotice = meetingAnalysisNotice(recording);
                return (
                <Card
                  key={recording.id}
                  className={`cursor-pointer overflow-hidden transition-smooth hover:bg-muted/25 ${
                    isLiveRow
                      ? "border-gold/40 bg-gold/10"
                      : "border-border/70 bg-card/78"
                  }`}
                  onClick={() => handleRecordingClick(recording)}
                >
                  {/* Left status band: gold = ready/live, rust = needs attention,
                      bronze ambient = processing, muted = draft. Border on the
                      unrounded CardContent so the band reads flush. */}
                  <CardContent className={`rounded-none border-l-2 p-4 ${statusBand.band}`}>
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div className="flex min-w-0 items-center gap-4">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/20">
                          {isLiveRow ? (
                            <span className="neume neume-lit" aria-hidden="true" />
                          ) : (
                            <FileAudio className="h-5 w-5 text-muted-foreground" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <h3 className="font-medium">
                            <button
                              type="button"
                              aria-label={`Open meeting: ${recording.title}`}
                              className="block max-w-full truncate rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleRecordingClick(recording);
                              }}
                            >
                              {recording.title}
                            </button>
                          </h3>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-xs text-muted-foreground">
                            <span className="time-spec">{formatDateTime(recording.createdAt)}</span>
                            <span aria-hidden="true" className="text-muted-foreground/40">·</span>
                            {recording.status === "processing" ? (
                              <span className="inline-flex items-center gap-1">
                                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                                <span className={`rubric-muted ${isLiveRow ? "text-gold-text" : ""}`}>
                                  {statusBand.word}
                                </span>
                              </span>
                            ) : (
                              <span className={`rubric-muted ${isLiveRow ? "text-gold-text" : ""}`}>
                                {statusBand.word}
                              </span>
                            )}
                            {/* Every row in a list called Meetings used to end
                                with the word "Meeting". */}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center justify-end gap-2">
                        <span className="time-spec text-sm text-muted-foreground">{formatDuration(recording.duration)}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label="Play this meeting's audio"
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
                              aria-label="Meeting options"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                ++renameDialogEpochRef.current;
                                setRenameError(null);
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
                              Open
                            </DropdownMenuItem>
                            {canRetranscribeRecording(recording) && !isLiveRow && (
                              <DropdownMenuItem
                                onClick={(e) => {
                                  e.stopPropagation();
                                  requestRetranscribeRecording(recording);
                                }}
                              >
                                <RefreshCw className="h-4 w-4 mr-2" />
                                {recording.status === "error" || recording.status === "pending"
                                  ? "Retry transcription"
                                  : "Re-transcribe from audio"}
                              </DropdownMenuItem>
                            )}
                            {canRecheckMeetingAudio(
                              recording,
                              readMeetingIntegrity(recording),
                            ) && !isLiveRow && (
                              <DropdownMenuItem
                                disabled={isRecheckingAudio}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleRecheckMeetingAudio(recording.id);
                                }}
                              >
                                <FileAudio className="h-4 w-4 mr-2" />
                                Re-check audio
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={async (e) => {
                                e.stopPropagation();
                                await handleMarkAsDictation(recording.id);
                              }}
                            >
                              <Mic2 className="h-4 w-4 mr-2" />
                              Move to Dictation
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              // Both capture and post-processing can still write
                              // transcript rows for this meeting.
                              disabled={!canDeleteRecording(recording)}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (canDeleteRecording(recording)) {
                                  openDeleteConfirmation(recording);
                                }
                              }}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              {deleteRecordingActionLabel(recording)}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>

                    {/* A meeting whose notes failed used to look identical to
                        one that never asked for any. The row says so, and
                        carries the way back. */}
                    {analysisNotice ? (
                      <div
                        className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3"
                        // Announce what changes now, not what the list
                        // remembers: a library with several old failures
                        // otherwise fired an alert per row on every load.
                        role={
                          analysisStatusByRecording[recording.id]
                            ? analysisNotice.busy ? "status" : "alert"
                            : undefined
                        }
                      >
                        <div className="min-w-0">
                          <p
                            className={`text-sm font-medium ${
                              analysisNotice.busy ? "text-foreground" : "text-rust"
                            }`}
                          >
                            {analysisNotice.title}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {analysisNotice.message}
                          </p>
                        </div>
                        {analysisNotice.retryable ? (
                          <div className="flex flex-wrap items-center gap-2">
                            {analysisNotice.waiting ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleStopMeetingNotesWait(recording.id);
                                }}
                              >
                                Stop waiting
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleRetryMeetingAnalysis(recording.id);
                              }}
                            >
                              <RefreshCw className="mr-2 h-4 w-4" />
                              Retry notes
                            </Button>
                          </div>
                        ) : analysisNotice.busy ? (
                          <Loader2
                            className="h-4 w-4 animate-spin text-muted-foreground"
                            aria-hidden="true"
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>
        </>
      )}

      <ConsentDialog
        open={showConsent}
        onOpenChange={(open) => {
          if (!pendingMeetingStartRef.current) {
            if (!open) pendingCalendarPrefill.current = null;
            setShowConsent(open);
          }
        }}
        onStart={handleStartRecording}
        startBlockedReason={
          captureConflictNotice ??
          (isMeetingStartPending ? "This meeting is starting." : null)
        }
        startFailureMessage={meetingStartFailure?.message ?? null}
        startFailureAction={
          meetingStartFailure?.action.label
          && meetingStartFailure.action.id !== "retry"
          && meetingStartFailure.action.id !== "none"
            ? {
                label: meetingStartFailure.action.label,
                onSelect: () => {
                  const failure = meetingStartFailure;
                  setShowConsent(false);
                  runMeetingStartAction(failure);
                },
              }
            : null
        }
        customTemplates={customMeetingTemplates}
        joinServiceLabel={calendarJoinServiceLabel(pendingCalendarPrefill.current?.joinConferenceUrl)}
      />

      {templateEditorSeed ? (
        <MeetingTemplateEditorDialog
          open={templateEditorOpen}
          onOpenChange={setTemplateEditorOpen}
          mode={templateEditorTarget ? "edit" : "create"}
          seed={templateEditorSeed}
          existingNames={customMeetingTemplates
            .filter((template) => template.id !== templateEditorTarget?.id)
            .map((template) => template.name)}
          onSave={async (draft) => {
            if (templateEditorTarget) {
              await handleUpdateMeetingTemplate(templateEditorTarget.id, draft);
            } else {
              await handleSaveNewMeetingTemplate(draft);
            }
          }}
        />
      ) : null}

      <MeetingTemplateManagerDialog
        open={templateManagerOpen}
        onOpenChange={setTemplateManagerOpen}
        templates={customMeetingTemplates}
        onEdit={(template) => {
          setTemplateEditorTarget(template);
          setTemplateEditorSeed({
            name: template.name,
            summaryPrompt: template.summaryPrompt,
            notesOutline: template.notesOutline,
          });
          setTemplateManagerOpen(false);
          setTemplateEditorOpen(true);
        }}
        onDelete={(template) => void handleDeleteMeetingTemplate(template)}
      />

      {/* Regenerating overwrites in place, so text Plainsong did not write in
          this session gets the question asked before it disappears. */}
      <Dialog
        open={pendingRegenerate !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRegenerate(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace what is written there?</DialogTitle>
            <DialogDescription>{pendingRegenerate?.warning}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingRegenerate(null)}>
              Keep what I have
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const request = pendingRegenerate;
                setPendingRegenerate(null);
                if (request) {
                  void runRegeneration(request.scope, request.templateId);
                }
              }}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Replace and regenerate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Acknowledging is the reader agreeing to lose something. The audio of
          an incomplete meeting is the only complete record of it, so the cost
          is stated before the button, never after. */}
      <Dialog
        open={pendingAcknowledgement !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAcknowledgement(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Accept losing this meeting&apos;s audio?</DialogTitle>
            <DialogDescription>
              Part of this transcript is missing, and the saved audio is the
              only complete record of what was said. Accepting this lets
              Plainsong&apos;s storage cleanup delete that audio, after which
              the meeting cannot be transcribed again. The transcript stays
              exactly as it is — still incomplete.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingAcknowledgement(null)}
            >
              Keep the audio
            </Button>
            <Button
              variant="destructive"
              disabled={isAcknowledging}
              onClick={() => {
                if (pendingAcknowledgement) {
                  void handleAcknowledgeIncompleteTranscript(
                    pendingAcknowledgement.id,
                  );
                }
              }}
            >
              {isAcknowledging ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Accept losing the audio
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Re-transcribing is the way back from a transcript edit or deletion,
          but it reads the audio again and overwrites the whole transcript —
          including corrections made by hand. Asked before, never after. */}
      <Dialog
        open={pendingRetranscribe !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRetranscribe(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-transcribe from the saved audio?</DialogTitle>
            <DialogDescription>
              Plainsong reads the audio for &ldquo;{pendingRetranscribe?.title}&rdquo; again and
              replaces the whole transcript. Speaker turns you edited, renamed, or removed are
              replaced by what the transcriber hears this time. Your notes stay as they are; if
              auto-analysis is on, the summary and action items are written again from the new
              transcript.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingRetranscribe(null)}>
              Keep this transcript
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = pendingRetranscribe;
                setPendingRetranscribe(null);
                if (target) {
                  void handleRetranscribeRecording(target.id);
                }
              }}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Replace and re-transcribe
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={showDeleteConfirm !== null}
        onOpenChange={(open) => { if (!open) closeDeleteConfirmation(); }}
      >
        <DialogContent
          onEscapeKeyDown={(event) => { if (deletePending) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (deletePending) event.preventDefault(); }}
          onCloseAutoFocus={(event) => {
            if (!focusListAfterDeleteRef.current) return;
            focusListAfterDeleteRef.current = false;
            event.preventDefault();
            listHeadingRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete this meeting?</DialogTitle>
            <DialogDescription>
              &ldquo;{showDeleteConfirm?.title}&rdquo; is gone for good.{" "}
              {deleteConfirmationRetention.deleteWarning}
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={deletePublishedFile} disabled={deletePending} onChange={event => setDeletePublishedFile(event.target.checked)} />Delete the published file too</label>
          {deleteError ? <p role="alert" className="text-sm text-rust">{deleteError}</p> : null}
          <DialogFooter>
            <Button variant="outline" disabled={deletePending} onClick={closeDeleteConfirmation}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deletePending || !canDeleteRecording(showDeleteConfirm)}
              onClick={handleDeleteRecording}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {deletePending ? "Deleting…" : deleteRecordingActionLabel(showDeleteConfirm)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog
        open={showRenameDialog !== null}
        onOpenChange={(open) => {
          if (!open) closeRenameDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename meeting</DialogTitle>
          </DialogHeader>
          <Input
            aria-label="New meeting title"
            aria-invalid={Boolean(renameError) || undefined}
            value={renameValue}
            readOnly={renamePendingEpoch !== null}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              if (renamePendingRef.current) return;
              setRenameError(null);
              setRenameValue(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleRenameRecording();
              }
            }}
            placeholder="New meeting title"
          />
          {renameError && <p role="alert" className="text-sm text-rust">{renameError}</p>}
          {renamePendingEpoch !== null && renamePendingEpoch !== renameDialogEpochRef.current && (
            <p role="status" className="text-sm text-muted-foreground">The previous title change is still saving. Wait before renaming this meeting.</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeRenameDialog}>
              {renamePendingEpoch !== null ? "Close" : "Cancel"}
            </Button>
            <Button onClick={handleRenameRecording} disabled={!renameValue.trim() || renamePendingEpoch !== null}>
              {renamePendingEpoch === renameDialogEpochRef.current ? "Saving…" : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
