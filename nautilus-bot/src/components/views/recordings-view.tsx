import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
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
import { useScopedRequestGuard } from "@/hooks/use-scoped-request-guard";
import { useToast } from "@/components/toast";
import { ConsentDialog } from "@/components/recording-overlay";
import {
  TranscriptViewer,
  TranscriptSearch,
  type TranscriptMatch,
  type TranscriptProvenance,
} from "@/components/transcript-viewer";
import {
  isCloudProvider,
  isKnownAsrProvider,
  providerHostingPreference,
} from "@/lib/asr-capabilities";
import { cn } from "@/lib/utils";
import { RecordingWaveform, WaveformVisualizer } from "@/components/waveform-visualizer";
import { AiAnalysisPanel } from "@/components/ai-analysis-panel";
import {
  summarizeRecordingGrounded,
  extractActionItemsGrounded,
  askMemory,
  getRelationshipMemory,
  searchTranscripts,
} from "@/lib/backend/ai";
import {
  deleteRecording,
  deleteTranscriptSegments,
  editTranscriptSpeakerTurn,
  getMeetingChatMessages,
  getRecording,
  openRecordingAudio,
  renameRecording,
  retranscribeRecording,
  retryMeetingAnalysis,
  retryMeetingAutoName,
  setRecordingSourceType,
  updateMeetingChatMessages,
  updateRecordingAnalysis,
  updateRecordingNotes,
  updateRecordingTemplate,
} from "@/lib/backend/recordings";
import { exportRecordingV2, openExportPath } from "@/lib/backend/exports";
import { isDiarizationModelAvailable, renameSpeaker, runDiarization } from "@/lib/backend/asr";
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
  getMeetingTemplateOption,
  MEETING_TEMPLATES,
} from "@/lib/meeting-templates";
import {
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
import {
  consumePendingRecordingWorkspace,
  OPEN_RECORDING_WORKSPACE_EVENT,
  requestMainView,
  requestReadinessDestination,
  requestSettingsTab,
  type OpenRecordingWorkspaceDetail,
} from "@/lib/navigation";
import {
  describeMeetingStartFailure,
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
import { actionItemsToMarkdownList } from "@/lib/markdown";
import { DocumentField } from "@/components/views/meetings/document-field";
import { AudioIssueBanner } from "@/components/views/meetings/audio-issue-banner";
import { EditableTitle } from "@/components/views/meetings/editable-title";
import { MarkdownText } from "@/components/views/meetings/markdown-text";
import { WorkspaceSkeleton } from "@/components/views/meetings/workspace-skeleton";
import { listen } from "@/lib/electron";
import { useProductReadinessStatus } from "@/features/readiness/product-readiness-context";
import { selectReadinessForSurface } from "@/features/readiness/product-readiness";
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
  Users,
  Volume2,
  Quote,
} from "lucide-react";
import type { AnalysisTemplate } from "@/types";
import type { AsrProviderType, LlmCitation, SearchHit } from "@/types";

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

type EnhancedMeetingNotesDraft = {
  text: string;
  generatedAt: string;
  rawNotesSnapshot: string;
  summaryCitations: LlmCitation[];
  actionItemCitations: Array<{
    label: string;
    citations: LlmCitation[];
  }>;
};

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
  plainsong: "Written by Plainsong from the transcript and your notes.",
  user: "Your text. Regenerate to have Plainsong rewrite it from the transcript.",
  unrecorded:
    "Nothing stored says whether you or Plainsong wrote this. Regenerate to have Plainsong rewrite it from the transcript.",
};

const ACTION_ITEMS_AUTHORSHIP_CAPTION: Record<RecapAuthorship, string> = {
  plainsong: "Found by Plainsong in the transcript and your notes.",
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

function formatTranscriptQuality(details: MeetingTranscriptDetails | null): {
  label: string;
  tone: "good" | "warn" | "muted";
} {
  const score = details?.qualityScore;
  if (typeof score !== "number") {
    return { label: "Not scored yet", tone: "muted" };
  }
  if (score >= 0.85) {
    return { label: "Strong", tone: "good" };
  }
  if (score >= 0.6) {
    return { label: "Needs review", tone: "warn" };
  }
  return { label: "Low confidence", tone: "warn" };
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
}): string {
  const sections = [
    `# ${args.recording.title}`,
    `- Date: ${new Date(args.recording.createdAt).toLocaleString()}`,
    `- Capture mode: ${args.captureMode}`,
    `- Template: ${args.templateLabel}`,
    `- Consent: ${args.consentLabel}`,
  ];

  const body = [
    args.summary.trim() ? `## Summary\n${args.summary.trim()}` : null,
    args.actionItems.length > 0
      ? `## Action Items\n${args.actionItems.map((item) => `- ${item}`).join("\n")}`
      : null,
    args.notes.trim() ? `## Notes\n${args.notes.trim()}` : null,
    args.includeTranscript && args.transcript.trim()
      ? `## Transcript\n${args.transcript.trim()}`
      : null,
  ].filter(Boolean);

  return [...sections, ...body].join("\n\n").trim();
}

function resolveRecordingCaptureMode(
  recording: Recording | null,
  details: MeetingTranscriptDetails | null,
  fallbackSystemAudio = false
): string {
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
  if (args.status === "processing") {
    return {
      label: "Transcribing",
      tone: "muted",
      detail: "Transcript lines are still arriving. Keep typing notes in the meantime.",
    };
  }
  if (args.summary.trim() && args.actionItems.length > 0) {
    return {
      label: "Ready to send",
      tone: "good",
      detail: "The summary and the next steps are both written.",
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
  if (args.isLive || args.status === "recording") {
    return {
      label: "Recording",
      tone: "muted",
      detail: "Keep typing notes while the meeting runs.",
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
  )}. Plainsong cannot bring the old text back.`;
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

export function RecordingsView() {
  const { productReadiness, engineNotice, dismissEngineNotice } =
    useProductReadinessStatus();
  const meetingsReadiness = selectReadinessForSurface(
    productReadiness,
    "meetings",
  );
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
    isRecording,
    recordingId,
    formattedDuration,
    meetingPhase = "idle",
    meetingMessage = null,
  } = useRecording();
  const { toast } = useToast();
  const [recordingStatusOverrides, setRecordingStatusOverrides] = useState<
    Record<string, Recording["status"]>
  >({});
  const [showConsent, setShowConsent] = useState(false);
  const [showRecordingDetail, setShowRecordingDetail] = useState(false);
  // Opening a meeting and coming back are navigations between two pages that
  // never coexist. Each page's h1 takes focus on arrival; otherwise focus is
  // left on <body> and a keyboard reader restarts from the top of the document.
  const workspaceHeadingRef = useRef<HTMLHeadingElement>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
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
  const [transcriptMatches, setTranscriptMatches] = useState<TranscriptMatch[]>([]);
  const [activeTranscriptMatchIndex, setActiveTranscriptMatchIndex] = useState(0);
  // Where the reader is in the transcript. Set by a segment click, by keyboard
  // stepping, by a search hit, and by a citation's "jump to source" — it is a
  // reading position, not audio playback, which this build cannot drive.
  const [transcriptCueTime, setTranscriptCueTime] = useState<number | undefined>(undefined);
  // A deep link names both a query and the moment it was found at. The hits
  // only exist once the transcript has loaded, so the requested moment is
  // parked here and spent on the first report that actually has hits in it.
  const pendingMatchFocusTimeRef = useRef<number | null>(null);
  const [audioPlaybackIssue, setAudioPlaybackIssue] = useState<{
    recordingId: string;
    message: string;
  } | null>(null);
  const [isRunningDiarization, setIsRunningDiarization] = useState(false);
  const [diarizationMessage, setDiarizationMessage] = useState<string | null>(null);
  const [diarizationError, setDiarizationError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<Recording | null>(null);
  // Re-transcribing a meeting that already has a transcript overwrites it, so a
  // meeting that is not simply broken parks here until the reader agrees.
  const [pendingRetranscribe, setPendingRetranscribe] = useState<Recording | null>(null);
  const [showRenameDialog, setShowRenameDialog] = useState<Recording | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isStopping, setIsStopping] = useState(false);
  const [liveMeetingNotes, setLiveMeetingNotes] = useState("");
  const [liveMeetingTemplateId, setLiveMeetingTemplateId] = useState("auto");
  const [liveMeetingSystemAudio, setLiveMeetingSystemAudio] = useState(false);
  const [liveMeetingConsentShown, setLiveMeetingConsentShown] = useState(false);
  const [meetingNotes, setMeetingNotes] = useState("");
  const [meetingNotesTargetId, setMeetingNotesTargetId] = useState<string | null>(null);
  const [meetingNotesSaveStatus, setMeetingNotesSaveStatus] =
    useState<MeetingNotesSaveStatus | null>(null);
  const [meetingTemplateId, setMeetingTemplateId] = useState("auto");
  const [meetingSummary, setMeetingSummary] = useState("");
  const [meetingActionItemsText, setMeetingActionItemsText] = useState("");
  const [enhancedMeetingNotesDraft, setEnhancedMeetingNotesDraft] =
    useState<EnhancedMeetingNotesDraft | null>(null);
  // Provenance for the recap the user is looking at: which transcript lines the
  // model cited for the summary, and for each action item. Hydrated from storage
  // and retained only while it still matches the visible content.
  const [meetingSummaryProvenance, setMeetingSummaryProvenance] = useState<{
    summary: string;
    citations: LlmCitation[];
    grounded: boolean;
  } | null>(null);
  const [meetingActionItemProvenance, setMeetingActionItemProvenance] = useState<
    Array<{ item: string; citations: LlmCitation[]; grounded: boolean }>
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
  const [meetingRecallResponse, setMeetingRecallResponse] = useState<string | null>(null);
  const [meetingRecallCitations, setMeetingRecallCitations] = useState<LlmCitation[]>([]);
  const [meetingRecallPromptLabel, setMeetingRecallPromptLabel] = useState<string | null>(null);
  const [meetingRecallLoading, setMeetingRecallLoading] = useState(false);
  const [meetingRecallError, setMeetingRecallError] = useState<string | null>(null);
  const [isRefreshingSummary, setIsRefreshingSummary] = useState(false);
  const [isRefreshingActionItems, setIsRefreshingActionItems] = useState(false);
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
  const lastRecordingState = useRef(false);
  const lastSavedLiveMeetingNotesRef = useRef("");
  const lastSavedMeetingNotesRef = useRef("");
  // Three surfaces edit the same meeting note: the live capture panel, the
  // review canvas, and the recording popup (its own window). Every write goes
  // through persistMeetingNotes, which carries a revision so a response that
  // lands out of order can't walk local state backwards, and rebases against
  // what is actually stored instead of clobbering it.
  const meetingNotesWriteRevisionRef = useRef(0);
  const pendingMeetingNotesWritesRef = useRef(0);
  // Serialize writes per meeting. Revision checks keep stale responses from
  // changing the indicator, but ordering the actual writes is what keeps an
  // older request from landing last on disk after a newer edit was reported saved.
  const meetingNotesWriteChainsRef = useRef(new Map<string, Promise<void>>());
  const meetingNotesRef = useRef("");
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
  const [statusFilter, setStatusFilter] = useState<
    "all" | "completed" | "recording" | "processing" | "error"
  >(
    "all"
  );
  // Why the last attempt to start a meeting did not. Held on screen rather than
  // shown as a toast: it carries the one action that resolves it.
  const [meetingStartFailure, setMeetingStartFailure] =
    useState<MeetingStartFailure | null>(null);
  const [isBulkReclassifying, setIsBulkReclassifying] = useState(false);
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
        lastSavedMeetingTemplateRef.current = recording.meetingTemplateId ?? "auto";
        lastSavedMeetingSummaryRef.current = recording.summary ?? "";
        lastSavedMeetingActionItemsRef.current = JSON.stringify(
          normalizeActionItems(recording.actionItems ?? [])
        );
      }
    },
  });

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

  useEffect(() => {
    meetingNotesRef.current = meetingNotes;
  }, [meetingNotes]);

  const enqueueMeetingNotesWrite = useCallback(
    async <T,>(recordingId: string, write: () => Promise<T>): Promise<T> => {
      const previousWrite = meetingNotesWriteChainsRef.current.get(recordingId);
      const result = (previousWrite ?? Promise.resolve())
        .catch(() => undefined)
        .then(write);
      const settled = result.then(
        () => undefined,
        () => undefined
      );
      meetingNotesWriteChainsRef.current.set(recordingId, settled);

      try {
        return await result;
      } finally {
        if (meetingNotesWriteChainsRef.current.get(recordingId) === settled) {
          meetingNotesWriteChainsRef.current.delete(recordingId);
        }
      }
    },
    []
  );

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
    }) => {
      const revision =
        target.revision ?? (meetingNotesWriteRevisionRef.current += 1);
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
        await enqueueMeetingNotesWrite(target.recordingId, async () => {
          let stored = target.savedRef.current;
          try {
            stored = (await getRecording(target.recordingId))?.meetingNotes ?? "";
          } catch (error) {
            // A read failure must not block the save; fall back to a plain write.
            console.error("Failed to read stored meeting notes before autosave:", error);
          }

          const nextNotes = rebaseMeetingNotes({
            base: target.savedRef.current,
            local: target.notes,
            stored,
          });
          await updateRecordingNotes(target.recordingId, nextNotes);

          // Even a superseded write is now the persisted base for the queued
          // write behind it. Only visible state and status are revision-gated.
          target.savedRef.current = nextNotes;
          if (revision !== meetingNotesWriteRevisionRef.current) {
            return;
          }
          if (nextNotes !== target.notes) {
            target.onRebase(nextNotes);
          }
          setSelectedRecording((current) =>
            current?.id === target.recordingId
              ? {
                  ...current,
                  meetingNotes: nextNotes.trim() ? nextNotes : null,
                  notesUpdatedAt: new Date().toISOString(),
                  summaryProvenance: undefined,
                  actionItemsProvenance: undefined,
                }
              : current
          );
          if (target.invalidateVisibleAnalysis) {
            setMeetingSummaryProvenance(null);
            setMeetingActionItemProvenance([]);
          }
          setMeetingNotesSaveStatus({
            recordingId: target.recordingId,
            surface: target.surface,
            revision,
            state: "saved",
          });
        });
      } catch (error) {
        console.error("Failed to update meeting notes:", error);
        if (revision === meetingNotesWriteRevisionRef.current) {
          setMeetingNotesSaveStatus({
            recordingId: target.recordingId,
            surface: target.surface,
            revision,
            state: "error",
          });
          notifyAutosaveFailure("Meeting notes");
        }
      } finally {
        pendingMeetingNotesWritesRef.current -= 1;
      }
    },
    [enqueueMeetingNotesWrite, notifyAutosaveFailure, setSelectedRecording]
  );

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
    if (lastRecordingState.current && !isRecording) {
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
    lastRecordingState.current = isRecording;
  }, [isRecording, refetch]);

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
                  summaryProvenance: undefined,
                }
              : current
          );
          setMeetingSummaryProvenance(null);
        })
        .catch((error) => {
          console.error("Failed to update meeting template:", error);
          notifyAutosaveFailure("Template choices");
        });
    }, 250);

    return () => window.clearTimeout(timeoutId);
  }, [meetingNotesTargetId, meetingTemplateId, notifyAutosaveFailure, setSelectedRecording]);

  useEffect(() => {
    if (!meetingNotesTargetId) {
      return;
    }

    const normalizedSummary = meetingSummary.trim();
    const normalizedActionItems = actionItemsFromText(meetingActionItemsText);
    const nextActionItemsKey = JSON.stringify(normalizedActionItems);

    const summaryChanged =
      normalizedSummary !== lastSavedMeetingSummaryRef.current.trim();
    const actionItemsChanged =
      nextActionItemsKey !== lastSavedMeetingActionItemsRef.current;
    if (!summaryChanged && !actionItemsChanged) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void updateRecordingAnalysis(meetingNotesTargetId, {
        ...(summaryChanged ? { summary: normalizedSummary || null } : {}),
        ...(actionItemsChanged ? { actionItems: normalizedActionItems } : {}),
      })
        .then(() => {
          if (summaryChanged) {
            lastSavedMeetingSummaryRef.current = normalizedSummary;
          }
          if (actionItemsChanged) {
            lastSavedMeetingActionItemsRef.current = nextActionItemsKey;
          }
          setSelectedRecording((current) =>
            current?.id === meetingNotesTargetId
              ? {
                  ...current,
                  ...(summaryChanged
                    ? {
                        summary: normalizedSummary || undefined,
                        summaryProvenance: undefined,
                      }
                    : {}),
                  ...(actionItemsChanged
                    ? {
                        actionItems: normalizedActionItems,
                        actionItemsProvenance: undefined,
                      }
                    : {}),
                }
              : current
          );
        })
        .catch((error) => {
          console.error("Failed to update meeting analysis:", error);
          notifyAutosaveFailure("Summary and action items");
        });
    }, 350);

    return () => window.clearTimeout(timeoutId);
  }, [
    meetingActionItemsText,
    meetingNotesTargetId,
    meetingSummary,
    notifyAutosaveFailure,
    setSelectedRecording,
  ]);

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
          notifyAutosaveFailure("Chat messages");
        });
    }, 250);

    return () => window.clearTimeout(timeoutId);
  }, [meetingChatMessages, meetingNotesTargetId, notifyAutosaveFailure]);

  useEffect(() => {
    if (!isRecording && !showRecordingDetail) {
      meetingChatRequestGuard.setScope(null);
      meetingSummaryRequestGuard.setScope(null);
      meetingActionItemsRequestGuard.setScope(null);
      meetingEnhanceRequestGuard.setScope(null);
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
    meetingSummaryRequestGuard,
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
    setMeetingTemplateId(nextTemplateId);
    setMeetingSummary(nextSummary);
    setMeetingActionItemsText(nextActionItemsText);
    if (selectedRecording.summaryProvenance && nextSummary) {
      setMeetingSummaryProvenance({
        summary: nextSummary,
        citations: selectedRecording.summaryProvenance.citations ?? [],
        grounded: selectedRecording.summaryProvenance.grounded !== false,
      });
    } else if (isNewMeeting) {
      setMeetingSummaryProvenance(null);
    }
    if (selectedRecording.actionItemsProvenance) {
      setMeetingActionItemProvenance(
        normalizeActionItems(selectedRecording.actionItems ?? []).map((item, index) => ({
          item,
          citations:
            selectedRecording.actionItemsProvenance?.items[index]?.citations ?? [],
          grounded:
            selectedRecording.actionItemsProvenance?.items[index]?.grounded !== false &&
            selectedRecording.actionItemsProvenance?.grounded !== false,
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

      setRecordingStatusOverrides((current) => ({
        ...current,
        [payload.recordingId]: payload.status,
      }));

      if (payload.status === "completed" || payload.status === "error") {
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
    focus?: { segmentTime?: number; highlightQuery?: string }
  ) => {
    meetingChatRequestGuard.setScope(recording.id);
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
    setTranscriptCueTime(focus?.segmentTime);
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
            citations: recording.actionItemsProvenance?.items[index]?.citations ?? [],
            grounded:
              recording.actionItemsProvenance?.items[index]?.grounded !== false &&
              recording.actionItemsProvenance?.grounded !== false,
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

  const openMeetingCapture = () => {
    if (meetingsReadiness.state !== "ready") {
      const cause = meetingsReadiness.cause;
      toast(
        cause?.message ?? "Plainsong could not confirm that meetings are ready.",
        "error",
      );
      if (cause) {
        requestReadinessDestination(cause.action.destination);
      }
      return;
    }
    setShowConsent(true);
  };

  const handleStartRecording = async (options: { mic: boolean; systemAudio: boolean; template?: string }) => {
    const requestedReadiness = options.systemAudio
      ? fullCaptureReadiness
      : meetingsReadiness;
    if (requestedReadiness.state !== "ready") {
      const cause = requestedReadiness.cause;
      toast(
        cause?.message ??
          "Plainsong could not confirm that the selected meeting capture is ready.",
        "error",
      );
      if (cause) {
        requestReadinessDestination(cause.action.destination);
      }
      setShowConsent(false);
      return;
    }

    setMeetingStartFailure(null);
    try {
      const selectedTemplateId = options.template ?? "auto";
      const shouldSeedTemplateOutline =
        !liveMeetingNotes.trim() && typeof options.template === "string";
      const seededNotes = shouldSeedTemplateOutline
        ? buildMeetingTemplateOutline(options.template)
        : liveMeetingNotes;
      const startedId = await startMeeting({
        ...options,
        projectId: "default",
        meetingNotes: seededNotes.trim() || undefined,
      });
      if (startedId) {
        setLiveMeetingNotes(seededNotes);
        setLiveMeetingTemplateId(selectedTemplateId);
        setLiveMeetingSystemAudio(options.systemAudio);
        setLiveMeetingConsentShown(true);
        lastSavedLiveMeetingNotesRef.current = seededNotes;
        void refetch();
      }
    } catch (error) {
      console.error("Failed to start recording:", error);
      const failure = describeMeetingStartFailure(error);
      setMeetingStartFailure(failure);
      toast(failure.message, "error");
    } finally {
      setShowConsent(false);
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
      case "retry":
        setMeetingStartFailure(null);
        setShowConsent(true);
        return;
      case "none":
        setMeetingStartFailure(null);
    }
  };

  const handleStopMeeting = async () => {
    setIsStopping(true);
    try {
      await stopMeeting();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Plainsong could not stop this meeting.",
        "error",
      );
    } finally {
      setIsStopping(false);
    }
  };

  const handleRecordingClick = (recording: Recording) => {
    openMeetingWorkspace(recording);
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

  const handleRenameSpeaker = async (speakerId: string, newName: string) => {
    if (!selectedRecording) {
      const error = new Error("No recording is open for speaker renaming.");
      toast(error.message, "error");
      throw error;
    }

    try {
      await renameSpeaker(selectedRecording.id, speakerId, newName);
      setSpeakerNames((prev) => ({ ...prev, [speakerId]: newName }));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Couldn't rename this speaker.";
      toast(message, "error");
      throw error;
    }
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

      await refreshSelectedRecording(selectedRecording.id);
      await refreshTranscript(selectedRecording.id);
      await refreshTranscriptDetails(selectedRecording.id);
      await refetch();
      setMeetingSummaryProvenance(null);
      setMeetingActionItemProvenance([]);
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
          : "Couldn't remove that transcript text.";
      toast(message, "error");
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
          ? {
              ...current,
              summary: nextSummary || undefined,
              summaryProvenance: result.provenance,
            }
          : current
      );
      toast("Summary rewritten from this meeting.", "success");
    } catch (error) {
      if (!meetingSummaryRequestGuard.isCurrent(requestToken)) {
        return;
      }
      const message =
        error instanceof Error ? error.message : "Couldn't rewrite the summary.";
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
          grounded: item.grounded !== false && result.grounded !== false,
        }))
      );
      lastSavedMeetingActionItemsRef.current = JSON.stringify(nextActionItems);
      setSelectedRecording((current) =>
        current?.id === selectedRecording.id
          ? {
              ...current,
              actionItems: nextActionItems,
              actionItemsProvenance: result.provenance,
            }
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

    if (templateId && templateId !== meetingTemplateId) {
      try {
        await updateRecordingTemplate(
          selectedRecording.id,
          templateId === "auto" ? null : templateId
        );
        lastSavedMeetingTemplateRef.current = templateId;
        setMeetingTemplateId(templateId);
        setSelectedRecording((current) =>
          current?.id === selectedRecording.id
            ? {
                ...current,
                meetingTemplateId: templateId === "auto" ? null : templateId,
                summaryProvenance: undefined,
              }
            : current
        );
        setMeetingSummaryProvenance(null);
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

  const handleEnhanceMeetingNotes = async () => {
    if (!selectedRecording) {
      return;
    }

    const requestToken = meetingEnhanceRequestGuard.beginRequest(selectedRecording.id);
    setIsEnhancingMeetingNotes(true);
    try {
      const [summaryOutcome, actionItemsOutcome] = await Promise.allSettled([
        summarizeRecordingGrounded(selectedRecording.id),
        extractActionItemsGrounded(selectedRecording.id),
      ]);
      if (!meetingEnhanceRequestGuard.isCurrent(requestToken)) {
        return;
      }
      if (summaryOutcome.status === "rejected" && actionItemsOutcome.status === "rejected") {
        throw new Error(
          [summaryOutcome.reason, actionItemsOutcome.reason]
            .map((reason) => (reason instanceof Error ? reason.message : String(reason)))
            .join("; ")
        );
      }

      const summaryResult =
        summaryOutcome.status === "fulfilled" ? summaryOutcome.value : null;
      const actionItemsResult =
        actionItemsOutcome.status === "fulfilled" ? actionItemsOutcome.value : null;
      const nextSummary = summaryResult?.summary.trim() ?? meetingSummary.trim();
      const nextActionItems = actionItemsResult
        ? normalizeActionItems(
            actionItemsResult.items.map((item) => formatGroundedActionItem(item))
          )
        : actionItemsFromText(meetingActionItemsText);
      const nextActionItemsText = actionItemsToText(nextActionItems);

      if (summaryResult) {
        setMeetingSummary(nextSummary);
        setMeetingSummaryProvenance({
          summary: nextSummary,
          citations: summaryResult.citations ?? [],
          grounded: summaryResult.grounded !== false,
        });
        lastSavedMeetingSummaryRef.current = nextSummary;
      }
      if (actionItemsResult) {
        setMeetingActionItemsText(nextActionItemsText);
        setMeetingActionItemProvenance(
          actionItemsResult.items.map((item, index) => ({
            item: nextActionItems[index] ?? item.task,
            citations: item.citations ?? [],
            grounded:
              item.grounded !== false && actionItemsResult.grounded !== false,
          }))
        );
        lastSavedMeetingActionItemsRef.current = JSON.stringify(nextActionItems);
      }
      setSelectedRecording((current) =>
        current?.id === selectedRecording.id
          ? {
              ...current,
              ...(summaryResult
                ? {
                    summary: nextSummary || undefined,
                    summaryProvenance: summaryResult.provenance,
                  }
                : {}),
              ...(actionItemsResult
                ? {
                    actionItems: nextActionItems,
                    actionItemsProvenance: actionItemsResult.provenance,
                  }
                : {}),
            }
          : current
      );

      const draftText = buildEnhancedMeetingNotesDraftText({
        summary: nextSummary,
        actionItems: nextActionItems,
        rawNotes: meetingNotes,
      });
      setEnhancedMeetingNotesDraft({
        text: draftText,
        generatedAt: new Date().toISOString(),
        rawNotesSnapshot: meetingNotes,
        summaryCitations:
          summaryResult?.citations ?? meetingSummaryProvenance?.citations ?? [],
        actionItemCitations: actionItemsResult
          ? actionItemsResult.items.map((item, index) => ({
              label: nextActionItems[index] ?? item.task,
              citations: item.citations ?? [],
            }))
          : meetingActionItemProvenance.map((entry) => ({
              label: entry.item,
              citations: entry.citations,
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

  const handleApplyEnhancedMeetingNotes = async () => {
    if (!selectedRecording || !enhancedMeetingNotesDraft?.text.trim()) {
      return;
    }

    try {
      const nextNotes = enhancedMeetingNotesDraft.text.trim();
      // An explicit apply replaces the note, so it is not rebased — but it still
      // claims the newest revision so an autosave already in flight cannot land
      // on top of it.
      meetingNotesWriteRevisionRef.current += 1;
      await updateRecordingNotes(selectedRecording.id, nextNotes);
      const updatedAt = new Date().toISOString();
      setMeetingNotes(nextNotes);
      lastSavedMeetingNotesRef.current = nextNotes;
      setSelectedRecording((current) =>
        current?.id === selectedRecording.id
          ? {
              ...current,
              meetingNotes: nextNotes,
              notesUpdatedAt: updatedAt,
            }
          : current
      );
      setEnhancedMeetingNotesDraft(null);
      toast("Draft saved into your notes.", "success");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Couldn't save the draft into your notes.";
      toast(message, "error");
    }
  };

  // Two separate actions on purpose: the recap is the thing you paste into a
  // chat window, the full record is the thing that carries the transcript. The
  // toast names which one left the app.
  const handleCopyMeetingRecap = async () => {
    if (!selectedRecording || !selectedMeetingRecapMarkdown.trim()) {
      return;
    }

    try {
      await navigator.clipboard.writeText(selectedMeetingRecapMarkdown);
      toast("Recap copied — summary, action items, and notes. No transcript.", "success");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to copy the meeting recap.";
      toast(message, "error");
    }
  };

  const handleCopyMeetingFullRecord = async () => {
    if (!selectedRecording || !selectedMeetingFullRecordMarkdown.trim()) {
      return;
    }

    try {
      await navigator.clipboard.writeText(selectedMeetingFullRecordMarkdown);
      toast("Full record copied — includes the verbatim transcript.", "success");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to copy the full meeting record.";
      toast(message, "error");
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
      text,
      emptyMessage: "There is no answer to copy yet.",
      successMessage: "Answer copied.",
      failureMessage: "Couldn't copy the answer.",
    });
  };

  const runMeetingRecall = async (promptOverride?: string) => {
    if (!selectedRecording) {
      return;
    }

    const prompt = (promptOverride ?? meetingRecallQuery).trim();
    if (!prompt) {
      return;
    }

    setMeetingRecallLoading(true);
    setMeetingRecallError(null);

    try {
      const result = await askMemory(
        buildCrossMeetingRecallQuery({
          title: selectedRecording.title,
          summary: meetingSummary,
          actionItems: selectedMeetingActionItems,
          prompt,
        })
      );
      setMeetingRecallPromptLabel(prompt);
      setMeetingRecallResponse(result.response);
      setMeetingRecallCitations(result.citations);
      if (!promptOverride) {
        setMeetingRecallQuery("");
      }
    } catch (error) {
      setMeetingRecallError(
        error instanceof Error
          ? error.message
          : "Couldn't answer from your earlier meetings."
      );
      setMeetingRecallResponse(null);
      setMeetingRecallCitations([]);
    } finally {
      setMeetingRecallLoading(false);
    }
  };

  const handleExportMeetingArtifact = async (
    format: "markdown" | "text"
  ) => {
    if (!selectedRecording) {
      return;
    }

    setIsExportingMeeting(true);
    setLastMeetingExportPath(null);
    try {
      const result = await exportRecordingV2(selectedRecording.id, format, {
        redactionLevel: MEETING_EXPORT_REDACTION_LEVEL,
        preview: false,
      });
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
      const message =
        error instanceof Error ? error.message : "Couldn't export this meeting.";
      toast(message, "error");
    } finally {
      setIsExportingMeeting(false);
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
          "Plainsong has no on-device model for separating speakers yet, so who said what can't be labelled here. Ask can still answer questions about what was said."
        );
        setIsRunningDiarization(false);
        return;
      }

      const result = await runDiarization(selectedRecording.id);
      await loadRecordingDetail(selectedRecording);
      setDiarizationMessage(
        `Found ${result.speakers.length} speaker${result.speakers.length === 1 ? "" : "s"}.`
      );
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Couldn't identify speakers. Ask can still answer questions about this meeting.";
      setDiarizationError(msg);
    } finally {
      setIsRunningDiarization(false);
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
    if (!showDeleteConfirm) return;
    if (!canDeleteRecording(showDeleteConfirm)) {
      toast(
        showDeleteConfirm.status === "recording"
          ? "Stop the meeting before deleting it."
          : "Wait for meeting processing to finish before deleting it.",
        "error"
      );
      return;
    }
    try {
      await deleteRecording(showDeleteConfirm.id);
      refetch();
    } catch (err) {
      console.error("Failed to delete recording:", err);
      toast(
        err instanceof Error
          ? err.message
          : "Couldn't delete that meeting — it's still in your list.",
        "error"
      );
    } finally {
      setShowDeleteConfirm(null);
    }
  };

  // Leaving the workspace is a navigation, not a dismissal: the same teardown
  // the dialog used to run on close, minus the modal.
  const closeMeetingWorkspace = () => {
    setShowRecordingDetail(false);
    clearRecordingDetail();
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
  const handleRenameMeetingTitle = async (nextTitle: string) => {
    if (!selectedRecording) {
      return;
    }

    try {
      await renameRecording(selectedRecording.id, nextTitle);
      setSelectedRecording((current) =>
        current?.id === selectedRecording.id ? { ...current, title: nextTitle } : current
      );
      refetch();
    } catch (error) {
      console.error("Failed to rename meeting:", error);
      toast("Couldn't rename that meeting — the old name is unchanged.", "error");
    }
  };

  const handleRenameRecording = async () => {
    if (!showRenameDialog || !renameValue.trim()) return;
    try {
      await renameRecording(showRenameDialog.id, renameValue.trim());
      refetch();
    } catch (err) {
      console.error("Failed to rename recording:", err);
      toast("Couldn't rename that meeting — the old name is unchanged.", "error");
    } finally {
      setShowRenameDialog(null);
      setRenameValue("");
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
      setTranscriptCueTime(transcriptMatches[nextIndex].startTime);
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
  const transcriptQuality = useMemo(
    () => formatTranscriptQuality(selectedTranscriptDetails),
    [selectedTranscriptDetails]
  );
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
  const activeMeeting = useMemo(
    () => meetings.find((meeting) => meeting.id === recordingId) ?? null,
    [meetings, recordingId]
  );
  // The meeting on screen is the one being captured right now.
  const isLiveSelectedMeeting = selectedRecording?.id === recordingId && isRecording;
  // Transcript bodies are not held in the meetings list, so the FTS index does
  // that half. Debounced so typing does not fire a query per keystroke.
  useEffect(() => {
    const query = meetingSearch.trim();
    if (query.length < 2) {
      setMeetingSearchHits([]);
      setMeetingSearchError(null);
      setIsSearchingMeetingTranscripts(false);
      return;
    }

    let cancelled = false;
    setIsSearchingMeetingTranscripts(true);
    const timeoutId = window.setTimeout(() => {
      void searchTranscripts(query, 25)
        .then((hits) => {
          if (cancelled) return;
          setMeetingSearchHits(hits);
          setMeetingSearchError(null);
        })
        .catch((error) => {
          if (cancelled) return;
          console.error("Failed to search meeting transcripts:", error);
          setMeetingSearchHits([]);
          setMeetingSearchError(
            error instanceof Error
              ? error.message
              : "Transcript search is unavailable. Titles, notes, summaries, and action items are still searched."
          );
        })
        .finally(() => {
          if (!cancelled) {
            setIsSearchingMeetingTranscripts(false);
          }
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [meetingSearch]);

  // Only transcript hits that belong to a meeting, and only while the query
  // they were fetched for is still the one on screen.
  const meetingTranscriptHits = useMemo(() => {
    if (meetingSearch.trim().length < 2) {
      return [] as Array<SearchHit & { recording: Recording }>;
    }
    return meetingSearchHits.flatMap((hit) => {
      const recording = meetings.find((meeting) => meeting.id === hit.recordingId);
      return recording ? [{ ...hit, recording }] : [];
    });
  }, [meetingSearch, meetingSearchHits, meetings]);

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
          new Date(meeting.createdAt).toLocaleString(),
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
  const liveMeetingTemplateOption = useMemo(
    () => getMeetingTemplateOption(liveMeetingTemplateId),
    [liveMeetingTemplateId]
  );
  const meetingNoteSections = useMemo(
    () => parseMeetingNoteSections(meetingNotes, meetingTemplateId),
    [meetingNotes, meetingTemplateId]
  );
  const activeMeetingCaptureMode = useMemo(
    () =>
      resolveRecordingCaptureMode(activeMeeting, null, liveMeetingSystemAudio),
    [activeMeeting, liveMeetingSystemAudio]
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
  const actionItemProvenance = useMemo(() => {
    const byItem = new Map(
      meetingActionItemProvenance.map((entry) => [
        entry.item.trim(),
        { citations: entry.citations, grounded: entry.grounded },
      ])
    );
    return selectedMeetingActionItems.map((item) => {
      const provenance = byItem.get(item.trim());
      return {
        item,
        citations: provenance?.citations ?? null,
        grounded: provenance?.grounded ?? false,
      };
    });
  }, [meetingActionItemProvenance, selectedMeetingActionItems]);
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
  const jumpToTranscriptMoment = useCallback((startTime?: number) => {
    setSearchQuery("");
    setTranscriptMatches([]);
    setActiveTranscriptMatchIndex(0);
    pendingMatchFocusTimeRef.current = null;
    setTranscriptCueTime(typeof startTime === "number" ? startTime : undefined);
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
    () => buildDeterministicAgenda(selectedRecording?.title ?? "this meeting", selectedMeetingActionItems),
    [selectedMeetingActionItems, selectedRecording]
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
  const selectedMeetingReadyState = useMemo(
    () =>
      buildMeetingReadyState({
        summary: meetingSummary,
        actionItems: selectedMeetingActionItems,
        notes: meetingNotes,
        transcriptSegments: selectedTranscript?.segments?.length ?? 0,
        status: selectedRecording?.status,
        isLive: selectedRecording?.id === recordingId && isRecording,
      }),
    [
      isRecording,
      meetingNotes,
      meetingSummary,
      recordingId,
      selectedMeetingActionItems,
      selectedRecording?.id,
      selectedRecording?.status,
      selectedTranscript?.segments?.length,
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
    setMeetingRecallQuery("");
    setMeetingRecallResponse(null);
    setMeetingRecallCitations([]);
    setMeetingRecallPromptLabel(null);
    setMeetingRecallError(null);
    setMeetingRecallLoading(false);
  }, [selectedRecording?.id]);

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
              // Clearing a template heading puts the scaffold back so the note
              // text holds nothing; a hand-made section keeps its heading so
              // the section itself doesn't disappear from under the user.
              isFromNotes: section.isTemplateSection ? false : section.isFromNotes,
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
        isFromNotes: true,
      },
    ]);
  };

  const handleRemoveMeetingSection = (sectionIndex: number) => {
    updateMeetingSections((sections) =>
      sections.filter((_, index) => index !== sectionIndex)
    );
  };

  const handleRetranscribeRecording = async (recordingIdToRetry: string) => {
    try {
      await retranscribeRecording(recordingIdToRetry);
      setRecordingStatusOverrides((current) => ({
        ...current,
        [recordingIdToRetry]: "processing",
      }));
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
      });
    },
    [analysisStatusByRecording],
  );

  const selectedAnalysisNotice = meetingAnalysisNotice(selectedRecording);

  const handleRetryMeetingAnalysis = async (recordingIdToRetry: string) => {
    setAnalysisStatusByRecording((current) => ({
      ...current,
      [recordingIdToRetry]: { phase: "running", error: null },
    }));
    try {
      await retryMeetingAnalysis(recordingIdToRetry);
      // Whether the command returns on start or on finish is the sidecar's
      // business. Drop the local override and let the events plus the stored
      // field say what actually happened.
      setAnalysisStatusByRecording((current) => {
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
      toast(
        `Moved ${filteredMeetings.length} meeting${
          filteredMeetings.length === 1 ? "" : "s"
        } to Dictation.`,
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
    (detail: OpenRecordingWorkspaceDetail | null | undefined) => {
      const requestedRecordingId = detail?.recordingId?.trim();
      if (!detail || !requestedRecordingId) {
        return;
      }

      const focus = {
        segmentTime: detail.focusSegmentTime,
        highlightQuery: detail.highlightQuery,
      };
      const existingRecording =
        effectiveRecordings.find((recording) => recording.id === requestedRecordingId) ?? null;
      if (existingRecording) {
        openMeetingWorkspace(existingRecording, focus);
        return;
      }

      void getRecording(requestedRecordingId)
        .then((recording) => {
          if (recording?.sourceType === "meeting") {
            openMeetingWorkspace(recording, focus);
          }
        })
        .catch((error) => {
          console.error("Failed to open requested meeting view:", error);
        });
    },
    // openMeetingWorkspace only reads its own arguments plus stable setters and
    // hook callbacks, so it is deliberately left out; the meeting list is the
    // part that actually has to be current.
    [effectiveRecordings]
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
      workspaceHeadingRef.current?.focus();
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
      {showRecordingDetail ? (
        <div className="flex h-full min-h-0 flex-col">
          {/* The meeting is a page now, not a modal: it has a way back, a
              title you can edit in place, and the row's actions in one
              overflow instead of scattered across the surfaces below. */}
          <div className="shrink-0 border-b border-border/70 px-6 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={closeMeetingWorkspace}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                All meetings
              </Button>
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
                  <Play className="mr-2 h-4 w-4" />
                  Play audio
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
                    <DropdownMenuItem onClick={() => void handleCopyMeetingRecap()}>
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
                        {selectedRecording?.status === "error"
                          ? "Retry transcription"
                          : "Re-transcribe from audio"}
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
                          setShowDeleteConfirm(selectedRecording);
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
            <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">
              {selectedMeetingReadyState.detail}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
              <span className="time-spec">
                {selectedRecording
                  ? new Date(selectedRecording.createdAt).toLocaleString()
                  : "Date unknown"}
              </span>
              <span className="time-spec">
                {formatDuration(selectedRecording?.duration ?? 0)}
              </span>
              <span>{selectedMeetingCaptureMode}</span>
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
              {isLiveSelectedMeeting ? (
                <span className="inline-flex items-center gap-1.5 text-gold-text">
                  <span className="neume neume-lit" aria-hidden="true" />
                  Live capture · {formattedDuration}
                </span>
              ) : null}
            </div>
            {selectedMeetingConsent.message ? (
              <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">
                {selectedMeetingConsent.message}
              </p>
            ) : null}
          </div>

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
          <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1.35fr)_minmax(0,1fr)] overflow-hidden xl:grid-cols-[minmax(0,1.55fr)_minmax(360px,1fr)] xl:grid-rows-1">
            <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
              <Tabs
                value={meetingTab}
                onValueChange={setMeetingTab}
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                <TabsList className="mx-6 mt-4 grid w-auto shrink-0 grid-cols-3">
                  <TabsTrigger value="record" className="flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    Record
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
                    <div className="space-y-6 px-6 py-5">
                      {isLoadingDetail ? (
                        <WorkspaceSkeleton
                          label="Loading the summary, action items, and notes for this meeting."
                          lines={6}
                        />
                      ) : (
                        <>
                          <section className="space-y-5">
                            <div className="min-w-0">
                              <h2 className="font-serif text-lg font-semibold tracking-tight">
                                The record
                              </h2>
                              <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                                What was decided, and what happens next. Type over either part, or
                                have Plainsong write it again from the transcript and your notes.
                                The playbook changes how the summary is written; action items are
                                pulled out the same way under every playbook.
                              </p>
                            </div>

                            <DocumentField
                              label="Summary"
                              value={meetingSummary}
                              onChange={(next) => {
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
                              disabled={!selectedRecording}
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
                                    disabled={!selectedRecording || isRefreshingSummary}
                                  >
                                    {isRefreshingSummary ? (
                                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    ) : (
                                      <RefreshCw className="mr-2 h-4 w-4" />
                                    )}
                                    Regenerate
                                  </Button>
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        aria-label="Regenerate summary with a different playbook"
                                        disabled={!selectedRecording || isRefreshingSummary}
                                      >
                                        Different playbook
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                                      {MEETING_TEMPLATES.map((template) => (
                                        <DropdownMenuItem
                                          key={template.value}
                                          onClick={() =>
                                            requestRegeneration("summary", template.value)
                                          }
                                        >
                                          {template.value === meetingTemplateId
                                            ? `${template.label} (current)`
                                            : template.label}
                                        </DropdownMenuItem>
                                      ))}
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
                                Couldn't rewrite the summary, so the saved one was kept.{" "}
                                {analysisFailureByTarget.summary.reason}
                              </p>
                            ) : null}

                            <div className="border-t pt-5">
                              <DocumentField
                                label="Action items"
                                value={meetingActionItemsText}
                                renderValue={actionItemsToMarkdownList(selectedMeetingActionItems)}
                                onChange={(next) => {
                                  setMeetingActionItemsText(next);
                                  setUserEditedActionItemsText(next);
                                }}
                                isEditing={isEditingActionItems}
                                onEditingChange={setIsEditingActionItems}
                                disabled={!selectedRecording}
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
                                      disabled={!selectedRecording || isRefreshingActionItems}
                                    >
                                      {isRefreshingActionItems ? (
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                      ) : (
                                        <RefreshCw className="mr-2 h-4 w-4" />
                                      )}
                                      Regenerate
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
                                  Couldn't pull new action items, so the saved ones were kept.{" "}
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
                              The transcript lines Plainsong quoted when it wrote the text above.
                              Pick one to jump to that moment. Editing a field by hand drops the
                              quotes for that field only.
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
                                        {new Date(
                                          selectedRecording.summaryProvenance.completedAt
                                        ).toLocaleString()}
                                      </p>
                                    ) : null}
                                    {!summaryProvenance.grounded ||
                                    summaryProvenance.citations.length === 0 ? (
                                      <p className="mt-1.5 inline-flex items-center gap-1.5 text-sm text-rust">
                                        <span className="neume neume-hollow" aria-hidden="true" />
                                        {summaryProvenance.citations.length === 0
                                          ? "No transcript line was quoted for this summary — read it against the transcript before you send it."
                                          : "Some quoted lines could not be found in the transcript, or do not support this summary."}
                                      </p>
                                    ) : (
                                      <div className="mt-2 grid gap-1.5">
                                        {summaryProvenance.citations.map((citation, index) => (
                                          <button
                                            key={`summary-citation-${index}`}
                                            type="button"
                                            // No aria-label here: the accessible
                                            // name must come from the contents so
                                            // the quote itself is read out. A
                                            // button is a leaf to a screen reader,
                                            // so a label would silence the
                                            // evidence this section exists to show.
                                            className="rounded-md border border-border/70 bg-background/70 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                            onClick={() => jumpToTranscriptMoment(citation.startTime)}
                                          >
                                            <span className="flex items-baseline gap-2">
                                              <Quote
                                                className="h-3.5 w-3.5 shrink-0 translate-y-0.5 text-muted-foreground"
                                                aria-hidden="true"
                                              />
                                              <span className="rubric-muted time-spec shrink-0">
                                                {formatCitationTimeRange(citation) ?? "No timestamp"}
                                              </span>
                                            </span>
                                            <span className="manuscript mt-1 block text-sm">
                                              {citation.text}
                                            </span>
                                          </button>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                ) : null}

                                {generatedActionItemProvenance.length > 0 ? (
                                  <div>
                                    <p className="rubric-muted">Action items</p>
                                    {selectedRecording?.actionItemsProvenance ? (
                                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                                        {selectedRecording.actionItemsProvenance.actualProvider} ·{" "}
                                        {selectedRecording.actionItemsProvenance.actualModel} · finished{" "}
                                        {new Date(
                                          selectedRecording.actionItemsProvenance.completedAt
                                        ).toLocaleString()}
                                      </p>
                                    ) : null}
                                    <div className="mt-1.5 space-y-3">
                                      {generatedActionItemProvenance.map((entry, entryIndex) => (
                                        <div key={`action-provenance-${entryIndex}`}>
                                          <p className="manuscript max-w-prose border-l-2 border-gold-ambient/50 pl-3 text-sm leading-relaxed text-muted-foreground">
                                            {entry.item}
                                          </p>
                                          {!entry.grounded || entry.citations.length === 0 ? (
                                            <p className="mt-1 inline-flex items-center gap-1.5 text-sm text-rust">
                                              <span className="neume neume-hollow" aria-hidden="true" />
                                              {entry.citations.length === 0
                                                ? "No transcript line was quoted for this follow-up."
                                                : "Some quoted lines could not be found in the transcript, or do not support this follow-up."}
                                            </p>
                                          ) : (
                                            <div className="mt-1.5 grid gap-1.5">
                                              {entry.citations.map((citation, citationIndex) => (
                                                <button
                                                  key={`action-citation-${entryIndex}-${citationIndex}`}
                                                  type="button"
                                                  // Contents-derived name only —
                                                  // see the summary citations above.
                                                  className="rounded-md border border-border/70 bg-background/70 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                  onClick={() =>
                                                    jumpToTranscriptMoment(citation.startTime)
                                                  }
                                                >
                                                  <span className="flex items-baseline gap-2">
                                                    <Quote
                                                      className="h-3.5 w-3.5 shrink-0 translate-y-0.5 text-muted-foreground"
                                                      aria-hidden="true"
                                                    />
                                                    <span className="rubric-muted time-spec shrink-0">
                                                      {formatCitationTimeRange(citation) ?? "No timestamp"}
                                                    </span>
                                                  </span>
                                                  <span className="manuscript mt-1 block text-sm">
                                                    {citation.text}
                                                  </span>
                                                </button>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            )}
                          </div>

                          <section className="border-t pt-5">
                            <h2 className="section-heading">Your notes</h2>
                            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                              Plainsong reads these notes alongside the transcript when it writes
                              the summary, the action items, and its answers in Ask. Fix them here,
                              then regenerate above — neither one overwrites the other.
                            </p>
                          <div className="mt-4 flex flex-wrap items-center gap-2">
                            <label className="text-sm font-medium" htmlFor="meeting-template">
                              Playbook
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
                              Add its headings to my notes
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
                          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                            {/* The live indicator already says "Saving…" and
                                "Saved just now"; a static "autosaves" sentence
                                beside it was the same fact twice. */}
                            <MeetingNotesSaveIndicator
                              status={
                                meetingNotesSaveStatus?.surface === "review" &&
                                meetingNotesSaveStatus.recordingId === meetingNotesTargetId
                                  ? meetingNotesSaveStatus
                                  : null
                              }
                              onRetry={() => retryMeetingNotesSave("review")}
                            />
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="ml-auto"
                              onClick={handleAddMeetingSection}
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              Add section
                            </Button>
                          </div>
                          <div aria-label="Meeting notes" role="group" className="mt-4 space-y-3">
                            {meetingNoteSections.map((section, index) => (
                              <div
                                key={`${section.title}-${index}`}
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
                                  className="mt-3 min-h-[120px] resize-y bg-background"
                                />
                              </div>
                            ))}
                          </div>
                        </section>

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
                                  One rewrite of your notes, built from the transcript. It sits
                                  here until you save it — read the quotes underneath first.
                                </p>
                                {enhancedMeetingNotesDraft ? (
                                  <p className="mt-2 text-sm text-muted-foreground">
                                    Generated{" "}
                                    {new Date(enhancedMeetingNotesDraft.generatedAt).toLocaleString()}.
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
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  ) : (
                                    <RefreshCw className="mr-2 h-4 w-4" />
                                  )}
                                  {enhancedMeetingNotesDraft ? "Build it again" : "Build a draft"}
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
                                  onClick={() => void handleApplyEnhancedMeetingNotes()}
                                  disabled={!enhancedMeetingNotesDraft?.text.trim()}
                                >
                                  <CheckCircle2 className="mr-2 h-4 w-4" />
                                  Save over my notes
                                </Button>
                              </div>
                            </div>

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
                                  {/* The heading names the content; a line under
                                      it saying the same thing was cut. */}
                                  <h3 className="section-heading">
                                    Transcript lines behind this draft
                                  </h3>

                                  <div className="space-y-2">
                                    <p className="text-sm font-medium">Summary</p>
                                    {enhancedMeetingNotesDraft.summaryCitations.length > 0 ? (
                                      enhancedMeetingNotesDraft.summaryCitations.map((citation, index) => (
                                        <div
                                          key={`enhanced-summary-citation-${index}`}
                                          className="border-t border-border/60 pt-2"
                                        >
                                          <p className="manuscript text-sm">{citation.text}</p>
                                          <p className="time-spec mt-1 font-mono text-xs text-muted-foreground">
                                            {formatCitationTimeRange(citation) ?? "No timestamp"}
                                          </p>
                                        </div>
                                      ))
                                    ) : (
                                      <p className="text-sm text-muted-foreground">
                                        Plainsong quoted no transcript line for this summary.
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
                                                <div
                                                  key={`enhanced-action-citation-${groupIndex}-${citationIndex}`}
                                                  className="border-l-2 border-border pl-3"
                                                >
                                                  <p className="manuscript text-sm">{citation.text}</p>
                                                  <p className="time-spec mt-1 font-mono text-xs text-muted-foreground">
                                                    {formatCitationTimeRange(citation) ?? "No timestamp"}
                                                  </p>
                                                </div>
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
                                        Plainsong quoted no transcript lines for these.
                                      </p>
                                    )}
                                  </div>
                                </div>
                              </div>
                            ) : (
                              <p className="max-w-prose text-sm text-muted-foreground">
                                Nothing built yet. Your notes are not touched until you choose to
                                save the draft over them.
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
                                          {new Date(person.lastSeenAt).toLocaleDateString()}
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
                                          {new Date(company.lastSeenAt).toLocaleDateString()}
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
                          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                            Assembled from the summary and action items above — no model runs, so
                            these are instant. Copy one and send it while the meeting is fresh.
                          </p>
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
                                      .map((item) => `- ${item}`)
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
                                      ? selectedMeetingActionItems.map((item) => `- ${item}`).join("\n")
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
                                  onChange={(event) => setMeetingRecallQuery(event.target.value)}
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
                              {meetingRecallError ? (
                                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                  {meetingRecallError}
                                </div>
                              ) : null}
                              {meetingRecallResponse ? (
                                <div className="space-y-3 border-l-2 border-gold-ambient/50 pl-3">
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
                                  {meetingRecallCitations.length > 0 ? (
                                    <div className="space-y-2">
                                      <p className="text-sm font-medium text-muted-foreground">
                                        Quoted from earlier meetings
                                      </p>
                                      {meetingRecallCitations.slice(0, 3).map((citation, index) => {
                                        // These quotes come from other meetings, so
                                        // a bare timestamp would read as a moment in
                                        // the meeting on screen. Name the meeting the
                                        // quote was taken from; fall back to its id
                                        // if that meeting is not in the loaded list.
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
                                                {formatCitationTimeRange(citation) ?? "No timestamp"}
                                              </span>
                                            </p>
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
                                disabled={!selectedRecording || !selectedMeetingRecapMarkdown.trim()}
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
                                  !selectedRecording || !selectedTranscript?.fullText?.trim()
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
                                ? new Date(selectedRecording.createdAt).toLocaleString()
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

            <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden border-t border-border/70 xl:border-l xl:border-t-0">
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-5 py-4">
                <div className="min-w-0">
                  <h2 className="section-heading">Transcript</h2>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {isLoadingDetail
                      ? "Loading the transcript."
                      : `${selectedTranscript?.segments?.length ?? 0} lines · ${selectedMeetingCaptureMode}`}
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

              <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-4">
              {isLoadingDetail ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  Loading transcript…
                </div>
              ) : selectedTranscript ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  {detailError && (
                    <div className="mb-3 flex items-center gap-2 rounded-md border border-rust/30 bg-rust/10 p-3 text-sm text-rust">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      {detailError}
                    </div>
                  )}
                  {!hasSpeakerLabels && (
                    <div className="mb-3 border-b pb-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-sm">
                          <p className="font-medium">Nobody is named in this transcript</p>
                          <p className="text-muted-foreground">
                            Every line is unattributed. Plainsong can try to tell the voices apart
                            and label them.
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleRunDiarization}
                          disabled={isRunningDiarization}
                        >
                          {isRunningDiarization ? (
                            <>
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                              Working…
                            </>
                          ) : (
                            "Label the speakers"
                          )}
                        </Button>
                      </div>
                      {diarizationMessage && (
                        <p className="mt-2 text-sm text-gold-text">{diarizationMessage}</p>
                      )}
                      {diarizationError && (
                        <p className="mt-2 text-sm text-destructive">{diarizationError}</p>
                      )}
                    </div>
                  )}
                  {/* One strip of facts instead of four boxes. The capture mode
                      is already in the pane heading above, so it is not
                      repeated here. */}
                  <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
                    <span
                      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-sm ${qualityToneClasses(
                        transcriptQuality.tone
                      )}`}
                    >
                      {transcriptQuality.label}
                      {typeof selectedTranscriptDetails?.qualityScore === "number"
                        ? ` · ${Math.round(selectedTranscriptDetails.qualityScore * 100)}%`
                        : ""}
                    </span>
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
                  <p className="mb-3 max-w-prose text-sm text-muted-foreground">
                    Click a line to mark your place; the text stays selectable. Double-click it, or
                    use Edit, to correct it. Arrow keys move line by line.
                  </p>
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
                  <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
                    <TranscriptViewer
                      segments={transcriptSegments}
                      speakerNames={speakerNames}
                      provenance={selectedTranscriptProvenance}
                      currentTime={transcriptCueTime}
                      onSegmentClick={(segment) => setTranscriptCueTime(segment.startTime)}
                      highlightQuery={searchQuery}
                      activeMatchIndex={activeTranscriptMatchIndex}
                      onMatchesChange={handleTranscriptMatchesChange}
                      onRenameSpeaker={handleRenameSpeaker}
                      onEditSegment={async (segmentIds, newText) => {
                        if (!selectedRecording || segmentIds.length === 0) return;
                        try {
                          // The sidecar validates and rewrites the whole turn in
                          // one transaction, so a failed remove can never leave
                          // duplicated old text beside the correction.
                          await editTranscriptSpeakerTurn(
                            selectedRecording.id,
                            segmentIds,
                            newText
                          );
                          await refreshSelectedRecording(selectedRecording.id);
                          await refreshTranscript(selectedRecording.id);
                          await refreshTranscriptDetails(selectedRecording.id);
                          setMeetingSummaryProvenance(null);
                          setMeetingActionItemProvenance([]);
                          toast("Transcript updated.", "success");
                        } catch (error) {
                          const message =
                            error instanceof Error
                              ? error.message
                              : "Couldn't save that transcript edit.";
                          toast(message, "error");
                          // Rethrow so the editor stays open with the correction.
                          throw error;
                        }
                      }}
                      onDeleteSegments={handleDeleteTranscriptSegments}
                      // Only promised when the audio is actually still attached.
                      deleteRecoveryNote={
                        selectedMeetingAssetRetention.transcriptRecoveryNote
                      }
                    />
                  </div>
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
                  ) : selectedRecording?.status === "error" ? (
                    <div className="max-w-md text-sm text-muted-foreground">
                      <p className="font-medium text-foreground">
                        Transcription failed
                      </p>
                      <p className="mt-2 leading-relaxed">
                        Plainsong could not produce a transcript for this meeting. The audio is
                        still saved, so transcription can be run again from the start.
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
      <div className="p-6 border-b flex items-center justify-between">
        <div>
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
        <div className="flex gap-2">
          {isRecording ? (
            <Button
              variant="destructive"
              disabled={isStopping}
              onClick={() => void handleStopMeeting()}
            >
              <Square className="h-4 w-4 mr-2 fill-current" />
              {isStopping ? "Stopping…" : "Stop meeting"}
            </Button>
          ) : (
            <Button
              variant="active"
              onClick={openMeetingCapture}
              disabled={meetingsReadiness.state !== "ready"}
            >
              <Mic2 className="h-4 w-4 mr-2" />
              New meeting
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-6">
          {/* Engine loss, said in plain words on the surface the reader is
              actually on. It used to appear only as the bridge's own log line
              on the buried Setup view. */}
          {engineNotice ? (
            <StatusBanner
              tone={engineNotice.recovering ? "muted" : "rust"}
              role={engineNotice.recovering ? "status" : "alert"}
              title={engineNotice.title}
              message={engineNotice.message}
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => dismissEngineNotice?.()}
                >
                  Dismiss
                </Button>
              }
            />
          ) : null}

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

          {meetingsReadiness.state !== "ready" ? (
            <div
              role={
                meetingsReadiness.state === "unknown" ? "status" : "alert"
              }
              aria-label="Meetings need attention"
              className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-md border border-rust/35 bg-rust/10 px-4 py-3"
            >
              <div className="flex min-w-0 items-start gap-2.5 text-sm text-rust">
                <span
                  className="neume neume-rust mt-1 shrink-0"
                  aria-hidden="true"
                />
                <div>
                  <p className="font-medium">Meetings need attention</p>
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
          ) ? (
            <div
              role={
                ["error", "cancelled", "recoverable"].includes(meetingPhase)
                  ? "alert"
                  : "status"
              }
              className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 ${
                ["error", "cancelled", "recoverable"].includes(meetingPhase)
                  ? "border-rust/35 bg-rust/10 text-rust"
                  : "border-border/80 bg-muted/40 text-foreground"
              }`}
            >
              <div>
                <p className="font-medium">
                  {meetingPhase === "ready"
                    ? "Meeting ready"
                    : ["error", "cancelled", "recoverable"].includes(meetingPhase)
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
                  <p className="mt-0.5 text-rust/90">{recordingsError}</p>
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
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="relative w-full md:max-w-md">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    placeholder="Search titles, notes, summaries, action items, and transcripts"
                    aria-label="Search meetings"
                    value={meetingSearch}
                    onChange={(event) => setMeetingSearch(event.target.value)}
                  />
                </div>
                <div className="flex items-center gap-2" role="group" aria-label="Show only">
                  <Button
                    variant={statusFilter === "all" ? "active" : "outline"}
                    size="sm"
                    aria-pressed={statusFilter === "all"}
                    onClick={() => setStatusFilter("all")}
                  >
                    All
                  </Button>
                  <Button
                    variant={statusFilter === "completed" ? "active" : "outline"}
                    size="sm"
                    aria-pressed={statusFilter === "completed"}
                    onClick={() => setStatusFilter("completed")}
                  >
                    Ready
                  </Button>
                  <Button
                    variant={statusFilter === "recording" ? "active" : "outline"}
                    size="sm"
                    aria-pressed={statusFilter === "recording"}
                    onClick={() => setStatusFilter("recording")}
                  >
                    Recording
                  </Button>
                  <Button
                    variant={statusFilter === "processing" ? "active" : "outline"}
                    size="sm"
                    aria-pressed={statusFilter === "processing"}
                    onClick={() => setStatusFilter("processing")}
                  >
                    Processing
                  </Button>
                  <Button
                    variant={statusFilter === "error" ? "active" : "outline"}
                    size="sm"
                    aria-pressed={statusFilter === "error"}
                    onClick={() => setStatusFilter("error")}
                  >
                    Failed
                  </Button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <p className="text-sm text-muted-foreground">
                  A dictation landed in this list? Move it out from its row menu, or move
                  everything listed at once.
                </p>
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
                      Moving…
                    </>
                  ) : (
                    "Move all listed to Dictation"
                  )}
                </Button>
              </div>

              {/* Transcript hits are ranked by the backend's bm25 index and open
                  the meeting at the moment they were found. */}
              {meetingSearch.trim().length >= 2 && (
                <div className="mt-4 border-t border-border/60 pt-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="section-heading">Lines from transcripts</h2>
                    <span className="rubric-muted time-spec">
                      {isSearchingMeetingTranscripts
                        ? "Searching"
                        : `${meetingTranscriptHits.length} found`}
                    </span>
                  </div>
                  {meetingSearchError ? (
                    <p className="mt-2 text-sm text-rust">{meetingSearchError}</p>
                  ) : meetingTranscriptHits.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      {isSearchingMeetingTranscripts
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
                      <p className="inline-flex items-center gap-1.5 text-sm font-medium text-gold-text">
                        <span className="neume neume-lit" aria-hidden="true" />
                        Recording
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Take notes while Plainsong captures the audio.
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
                    <div className="font-mono text-lg font-semibold">{formattedDuration}</div>
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
                      className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-gold"
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
                {meetings.length === 0 ? "No meetings yet" : "Nothing matches"}
              </h3>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                {meetings.length === 0
                  ? "Start one and Plainsong will keep the audio, the transcript, your notes, and a summary together in one place."
                  : "Try a different search, or a different status."}
              </p>
              {meetings.length === 0 && (
                <Button className="mt-4" variant="active" onClick={openMeetingCapture}>
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
                          <h3 className="truncate font-medium">{recording.title}</h3>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-xs text-muted-foreground">
                            <span className="time-spec">{new Date(recording.createdAt).toLocaleString()}</span>
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
                                {recording.status === "error"
                                  ? "Retry transcription"
                                  : "Re-transcribe from audio"}
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
                                  setShowDeleteConfirm(recording);
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
                        role={analysisNotice.busy ? "status" : "alert"}
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
                        ) : (
                          <Loader2
                            className="h-4 w-4 animate-spin text-muted-foreground"
                            aria-hidden="true"
                          />
                        )}
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
        onOpenChange={setShowConsent}
        onStart={handleStartRecording}
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
        onOpenChange={(open) => { if (!open) setShowDeleteConfirm(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this meeting?</DialogTitle>
            <DialogDescription>
              &ldquo;{showDeleteConfirm?.title}&rdquo; is gone for good.{" "}
              {deleteConfirmationRetention.deleteWarning}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!canDeleteRecording(showDeleteConfirm)}
              onClick={handleDeleteRecording}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {deleteRecordingActionLabel(showDeleteConfirm)}
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
            <DialogTitle>Rename meeting</DialogTitle>
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
