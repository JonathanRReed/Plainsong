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
import { TranscriptViewer, TranscriptSearch } from "@/components/transcript-viewer";
import { RecordingWaveform, WaveformVisualizer } from "@/components/waveform-visualizer";
import { AiAnalysisPanel } from "@/components/ai-analysis-panel";
import {
  summarizeRecordingGrounded,
  extractActionItemsGrounded,
  askMemory,
  getRelationshipMemory,
} from "@/lib/backend/ai";
import {
  deleteRecording,
  deleteTranscriptSegments,
  getMeetingChatMessages,
  getRecording,
  openRecordingAudio,
  renameRecording,
  retranscribeRecording,
  retryMeetingAutoName,
  setRecordingSourceType,
  updateMeetingChatMessages,
  updateRecordingAnalysis,
  updateRecordingNotes,
  updateRecordingTemplate,
  updateTranscriptSegment,
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
import type { MeetingTranscriptDetails, Recording } from "@/types";
import {
  buildMeetingTemplateOutline,
  getMeetingTemplateOption,
  MEETING_TEMPLATES,
} from "@/lib/meeting-templates";
import {
  describeMeetingConsent,
  MEETING_CONSENT_NOTICE_TEXT,
} from "@/lib/meeting-consent";
import {
  OPEN_RECORDING_WORKSPACE_EVENT,
  type OpenRecordingWorkspaceDetail,
} from "@/lib/navigation";
import { listen } from "@/lib/electron";
import {
  AlertCircle,
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
  Rocket,
  ClipboardList,
  CalendarClock,
  Volume2,
} from "lucide-react";
import type { AnalysisTemplate } from "@/types";
import type { LlmCitation } from "@/types";

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
  {
    id: "follow_up",
    name: "Follow-up Draft",
    icon: "file-text",
    query:
      "Using the meeting transcript and saved meeting notes, draft a concise professional follow-up email or message. Keep decisions, owners, next steps, and deadlines clear. Return only the final follow-up draft.",
    description: "Write the post-meeting follow-up",
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
  const sections = [
    args.summary.trim() ? `Summary\n${args.summary.trim()}` : null,
    args.actionItems.length > 0
      ? `Action Items\n${args.actionItems.map((item) => `- ${item}`).join("\n")}`
      : null,
    args.rawNotes.trim() ? `Raw Notes Context\n${args.rawNotes.trim()}` : null,
  ].filter(Boolean);

  return sections.join("\n\n").trim();
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

function buildMeetingShareMarkdown(args: {
  recording: Recording;
  summary: string;
  actionItems: string[];
  notes: string;
  transcript: string;
  captureMode: string;
  consentLabel: string;
  templateLabel: string;
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
    args.transcript.trim() ? `## Transcript\n${args.transcript.trim()}` : null,
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

function formatMeetingReviewState(status: Recording["status"] | undefined): string {
  switch (status) {
    case "recording":
      return "Capture live";
    case "processing":
      return "Transcribing";
    case "completed":
      return "Review ready";
    case "error":
      return "Needs attention";
    default:
      return "Unknown";
  }
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
      return { band: "border-l-rust", word: "Attention" };
    case "processing":
      return { band: "border-l-gold-ambient/60", word: "Processing" };
    case "recording":
      return { band: "border-l-gold", word: "Capturing" };
    default:
      return { band: "border-l-border", word: "Draft" };
  }
}

function describeMeetingAssetRetention(recording: Recording | null): {
  audioLabel: string;
  detail: string;
  deleteWarning: string;
} {
  if (recording?.audioPath) {
    return {
      audioLabel: "Audio saved",
      detail:
        "Audio is available for playback. Transcript, notes, summary, and action items remain attached to this meeting.",
      deleteWarning:
        "This permanently removes the meeting, transcript, notes, summary, action items, and saved audio file.",
    };
  }

  return {
    audioLabel: "Transcript-only",
    detail:
      "Audio is not saved or has already been removed by retention. Transcript, notes, summary, and action items remain available until this meeting is deleted.",
    deleteWarning:
      "This permanently removes the meeting, transcript, notes, summary, and action items. No saved audio file is attached.",
  };
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
}): { label: string; tone: "good" | "warn" | "muted"; detail: string } {
  if (args.summary.trim() && args.actionItems.length > 0) {
    return {
      label: "Ready to send follow-up",
      tone: "good",
      detail: "Summary and next steps are already in place.",
    };
  }
  if (args.notes.trim() && args.transcriptSegments > 0) {
    return {
      label: "Ready for AI cleanup",
      tone: "warn",
      detail: "You have enough notes and transcript context to generate a solid recap.",
    };
  }
  if (args.transcriptSegments > 0) {
    return {
      label: "Transcript captured",
      tone: "muted",
      detail: "Start filling notes or run summary/action item refresh next.",
    };
  }
  return {
    label: "Capture in progress",
    tone: "muted",
    detail: "Keep notes current while the meeting is still live.",
  };
}

function buildRelationshipRecallPrompts(args: {
  title: string;
  people: PersonMemoryProfile[];
  companies: CompanyMemoryProfile[];
}): string[] {
  const prompts = [
    `What commitments and deadlines from prior meetings matter before the next ${args.title} follow-up?`,
    ...args.people.slice(0, 2).map(
      (person) =>
        `What has ${person.name} cared about across recent meetings? Include priorities, open questions, and what I owe them.`
    ),
    ...args.companies.slice(0, 1).map(
      (company) =>
        `What has ${company.name} pushed on across recent meetings? Include risks, asks, and deadlines.`
    ),
  ];

  return [...new Set(prompts)];
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
  const [liveMeetingNotes, setLiveMeetingNotes] = useState("");
  const [liveMeetingTemplateId, setLiveMeetingTemplateId] = useState("auto");
  const [liveMeetingSystemAudio, setLiveMeetingSystemAudio] = useState(false);
  const [liveMeetingConsentShown, setLiveMeetingConsentShown] = useState(false);
  const [meetingNotes, setMeetingNotes] = useState("");
  const [meetingNotesTargetId, setMeetingNotesTargetId] = useState<string | null>(null);
  const [meetingTemplateId, setMeetingTemplateId] = useState("auto");
  const [meetingSummary, setMeetingSummary] = useState("");
  const [meetingActionItemsText, setMeetingActionItemsText] = useState("");
  const [enhancedMeetingNotesDraft, setEnhancedMeetingNotesDraft] =
    useState<EnhancedMeetingNotesDraft | null>(null);
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
  const [activeSpeechTarget, setActiveSpeechTarget] = useState<string | null>(null);
  const meetingChatRequestGuard = useScopedRequestGuard<string | null>();
  const meetingSummaryRequestGuard = useScopedRequestGuard<string | null>();
  const meetingActionItemsRequestGuard = useScopedRequestGuard<string | null>();
  const meetingEnhanceRequestGuard = useScopedRequestGuard<string | null>();
  const lastRecordingState = useRef(false);
  const lastSavedLiveMeetingNotesRef = useRef("");
  const lastSavedMeetingNotesRef = useRef("");
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
    refreshTranscript,
    refreshTranscriptDetails,
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
      ]);
      toast("Transcript panel refreshed.", "success");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Transcript refresh failed. Try again after processing advances.";
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
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void updateRecordingNotes(recordingId, liveMeetingNotes)
        .then(() => {
          lastSavedLiveMeetingNotesRef.current = liveMeetingNotes;
          setSelectedRecording((current) =>
            current?.id === recordingId
              ? {
                  ...current,
                  meetingNotes: normalizedNotes ? liveMeetingNotes : null,
                  notesUpdatedAt: new Date().toISOString(),
                }
              : current
          );
        })
        .catch((error) => {
          console.error("Failed to update live meeting notes:", error);
          notifyAutosaveFailure("Meeting notes");
        });
    }, 350);

    return () => window.clearTimeout(timeoutId);
  }, [isRecording, liveMeetingNotes, notifyAutosaveFailure, recordingId, setSelectedRecording]);

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
          notifyAutosaveFailure("Meeting notes");
        });
    }, 350);

    return () => window.clearTimeout(timeoutId);
  }, [meetingNotes, meetingNotesTargetId, notifyAutosaveFailure]);

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
      setIsEnhancingMeetingNotes(false);
      setMeetingChatMessages([]);
      setIsRefreshingSummary(false);
      setIsRefreshingActionItems(false);
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
    setMeetingTemplateId(nextTemplateId);
    setMeetingSummary(nextSummary);
    setMeetingActionItemsText(nextActionItemsText);
    if (lastSelectedMeetingIdRef.current !== selectedRecording.id) {
      setEnhancedMeetingNotesDraft(null);
      lastSelectedMeetingIdRef.current = selectedRecording.id;
    }
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

  useEffect(() => {
    if (!isRecording || !recordingId || selectedRecording?.id !== recordingId) {
      return;
    }

    const nextNotes = selectedRecording.meetingNotes ?? "";
    setLiveMeetingNotes((current) => (current === nextNotes ? current : nextNotes));
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
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [refetch]);

  const openMeetingWorkspace = (recording: Recording) => {
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
    setSearchQuery("");
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

  const handleStartRecording = async (options: { mic: boolean; systemAudio: boolean; template?: string }) => {
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
        consentPromptShown: true,
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
      toast(
        error instanceof Error ? error.message : "Failed to start recording",
        "error"
      );
    } finally {
      setShowConsent(false);
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
      await refreshTranscriptDetails(selectedRecording.id);
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

    const requestToken = meetingSummaryRequestGuard.beginRequest(selectedRecording.id);
    setIsRefreshingSummary(true);
    try {
      const result = await summarizeRecordingGrounded(selectedRecording.id);
      if (!meetingSummaryRequestGuard.isCurrent(requestToken)) {
        return;
      }
      const nextSummary = result.summary.trim();
      const currentActionItems = actionItemsFromText(meetingActionItemsText);

      await updateRecordingAnalysis(
        selectedRecording.id,
        nextSummary || null,
        currentActionItems
      );
      if (!meetingSummaryRequestGuard.isCurrent(requestToken)) {
        return;
      }
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
      toast("Summary refreshed from this meeting.", "success");
    } catch (error) {
      if (!meetingSummaryRequestGuard.isCurrent(requestToken)) {
        return;
      }
      const message =
        error instanceof Error ? error.message : "Failed to refresh the summary.";
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
      const normalizedSummary = meetingSummary.trim();

      await updateRecordingAnalysis(
        selectedRecording.id,
        normalizedSummary || null,
        nextActionItems
      );
      if (!meetingActionItemsRequestGuard.isCurrent(requestToken)) {
        return;
      }
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
      toast("Action items refreshed from this meeting.", "success");
    } catch (error) {
      if (!meetingActionItemsRequestGuard.isCurrent(requestToken)) {
        return;
      }
      const message =
        error instanceof Error ? error.message : "Failed to refresh action items.";
      toast(message, "error");
    } finally {
      if (meetingActionItemsRequestGuard.isCurrent(requestToken)) {
        setIsRefreshingActionItems(false);
      }
    }
  };

  const handleEnhanceMeetingNotes = async () => {
    if (!selectedRecording) {
      return;
    }

    const requestToken = meetingEnhanceRequestGuard.beginRequest(selectedRecording.id);
    setIsEnhancingMeetingNotes(true);
    try {
      const [summaryResult, actionItemsResult] = await Promise.all([
        summarizeRecordingGrounded(selectedRecording.id),
        extractActionItemsGrounded(selectedRecording.id),
      ]);
      if (!meetingEnhanceRequestGuard.isCurrent(requestToken)) {
        return;
      }

      const nextSummary = summaryResult.summary.trim();
      const nextActionItems = normalizeActionItems(
        actionItemsResult.items.map((item) => formatGroundedActionItem(item))
      );
      const nextActionItemsText = actionItemsToText(nextActionItems);

      await updateRecordingAnalysis(
        selectedRecording.id,
        nextSummary || null,
        nextActionItems
      );
      if (!meetingEnhanceRequestGuard.isCurrent(requestToken)) {
        return;
      }
      setMeetingSummary(nextSummary);
      setMeetingActionItemsText(nextActionItemsText);
      lastSavedMeetingSummaryRef.current = nextSummary;
      lastSavedMeetingActionItemsRef.current = JSON.stringify(nextActionItems);
      setSelectedRecording((current) =>
        current?.id === selectedRecording.id
          ? {
              ...current,
              summary: nextSummary || undefined,
              actionItems: nextActionItems,
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
        summaryCitations: summaryResult.citations ?? [],
        actionItemCitations: actionItemsResult.items.map((item, index) => ({
          label: nextActionItems[index] ?? item.task,
          citations: item.citations ?? [],
        })),
      });
      toast("Enhanced notes draft ready.", "success");
    } catch (error) {
      if (!meetingEnhanceRequestGuard.isCurrent(requestToken)) {
        return;
      }
      const message =
        error instanceof Error ? error.message : "Failed to build enhanced notes.";
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
      toast("Nothing to copy for enhanced notes.", "error");
      return;
    }

    try {
      await navigator.clipboard.writeText(draft);
      toast("Enhanced notes copied.", "success");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to copy enhanced notes.";
      toast(message, "error");
    }
  };

  const handleApplyEnhancedMeetingNotes = async () => {
    if (!selectedRecording || !enhancedMeetingNotesDraft?.text.trim()) {
      return;
    }

    try {
      const nextNotes = enhancedMeetingNotesDraft.text.trim();
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
      toast("Enhanced notes applied to this meeting.", "success");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to apply enhanced notes.";
      toast(message, "error");
    }
  };

  const handleCopyMeetingShareMarkdown = async () => {
    if (!selectedRecording || !selectedMeetingShareMarkdown.trim()) {
      return;
    }

    try {
      await navigator.clipboard.writeText(selectedMeetingShareMarkdown);
      toast("Meeting recap copied as markdown.", "success");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to copy the meeting recap.";
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
      emptyMessage: "Nothing to copy from cross-meeting recall.",
      successMessage: "Cross-meeting recall copied.",
      failureMessage: "Failed to copy cross-meeting recall.",
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
        error instanceof Error ? error.message : "Cross-meeting recall could not be generated."
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
        redactionLevel: "basic",
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
        error instanceof Error ? error.message : "Failed to export the meeting artifact.";
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
        error instanceof Error ? error.message : "Failed to open the exported file.";
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
        toast("Couldn't open the audio file for this meeting.", "error");
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
      toast("Couldn't delete that meeting — it's still in your list.", "error");
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
      toast("Couldn't rename that meeting — the old name is unchanged.", "error");
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
  const transcriptQuality = useMemo(
    () => formatTranscriptQuality(selectedTranscriptDetails),
    [selectedTranscriptDetails]
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
  const selectedMeetingShareMarkdown = useMemo(
    () =>
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
          })
        : "",
    [
      meetingNotes,
      meetingSummary,
      recordingId,
      selectedMeetingActionItems,
      selectedMeetingCaptureMode,
      selectedMeetingConsent.shareLabel,
      selectedRecording,
      selectedTemplateOption.label,
      selectedTranscript?.fullText,
    ]
  );
  const selectedMeetingReadyState = useMemo(
    () =>
      buildMeetingReadyState({
        summary: meetingSummary,
        actionItems: selectedMeetingActionItems,
        notes: meetingNotes,
        transcriptSegments: selectedTranscript?.segments?.length ?? 0,
      }),
    [meetingNotes, meetingSummary, selectedMeetingActionItems, selectedTranscript?.segments?.length]
  );
  const selectedMeetingReviewPath = useMemo(
    () => [
      {
        title: "Ground transcript",
        status: (selectedTranscript?.segments?.length ?? 0) > 0 ? "Grounded" : "Processing",
        detail:
          (selectedTranscript?.segments?.length ?? 0) > 0
            ? `${selectedTranscript?.segments?.length ?? 0} transcript segments ready from ${selectedMeetingCaptureMode.toLowerCase()} capture. Consent: ${selectedMeetingConsent.label}.`
            : "Transcript is still processing. Keep the note canvas current until grounded lines arrive.",
      },
      {
        title: "Lock recap",
        status: meetingSummary.trim() ? "Summary ready" : "Refresh summary",
        detail: meetingSummary.trim()
          ? "Your recap is editable. Refresh it only after notes or transcript context changes."
          : "Refresh the summary from transcript and notes before you send anything out.",
      },
      {
        title: "Send next move",
        status:
          meetingSummary.trim() && selectedMeetingActionItems.length > 0
            ? "Send-ready"
            : selectedMeetingActionItems.length > 0
              ? "Need recap"
              : "Need follow-ups",
        detail:
          meetingSummary.trim() && selectedMeetingActionItems.length > 0
            ? "Copy a send-ready follow-up or a review bundle while context is still fresh."
            : selectedMeetingActionItems.length > 0
              ? "Action items are captured. Tighten the summary next so the follow-up is easy to send."
              : "Extract owners and dates so the follow-up carries real commitments, not just recap text.",
      },
    ],
    [
      meetingSummary,
      selectedMeetingActionItems,
      selectedMeetingCaptureMode,
      selectedMeetingConsent.label,
      selectedTranscript?.segments?.length,
    ]
  );
  const selectedMeetingEvidenceState = useMemo(
    () => [
      {
        label: "Capture",
        value:
          selectedRecording?.id === recordingId && isRecording
            ? "Recording"
            : formatMeetingReviewState(selectedRecording?.status),
      },
      {
        label: "Consent action",
        value: selectedMeetingConsent.needsManualNotice
          ? "Copy notice"
          : selectedMeetingConsent.label,
      },
      {
        label: "Transcript",
        value:
          (selectedTranscript?.segments?.length ?? 0) > 0
            ? `${selectedTranscript?.segments?.length ?? 0} segments`
            : selectedRecording?.status === "processing"
              ? "Processing"
              : "Not grounded",
      },
      {
        label: "Export",
        value: isExportingMeeting
          ? "Exporting"
          : lastMeetingExportPath
            ? "Last export ready"
            : "Not exported",
      },
    ],
    [
      isExportingMeeting,
      isRecording,
      lastMeetingExportPath,
      recordingId,
      selectedMeetingConsent.label,
      selectedMeetingConsent.needsManualNotice,
      selectedRecording?.id,
      selectedRecording?.status,
      selectedTranscript?.segments?.length,
    ]
  );
  const transcriptPreviewItems = useMemo(() => {
    if (selectedRecording?.id === recordingId && streamChunks.length > 0) {
      return streamChunks.slice(-5).map((chunk, index) => ({
        id: `live-${index}-${chunk.startTime}`,
        text: chunk.text,
        startTime: chunk.startTime,
        isPartial: chunk.isPartial,
      }));
    }

    return (selectedTranscript?.segments ?? []).slice(-4).map((segment) => ({
      id: segment.id,
      text: segment.text,
      startTime: segment.startTime,
      isPartial: false,
    }));
  }, [recordingId, selectedRecording?.id, selectedTranscript?.segments, streamChunks]);
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

  const handleRetranscribeRecording = async (recordingIdToRetry: string) => {
    try {
      await retranscribeRecording(recordingIdToRetry);
      setRecordingStatusOverrides((current) => ({
        ...current,
        [recordingIdToRetry]: "processing",
      }));
      toast("Re-transcribing meeting.", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to re-transcribe meeting.";
      toast(message, "error");
    }
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

  useEffect(() => {
    const handleOpenRecordingWorkspace = (event: Event) => {
      const detail = (event as CustomEvent<OpenRecordingWorkspaceDetail>).detail;
      const requestedRecordingId = detail?.recordingId?.trim();
      if (!requestedRecordingId) {
        return;
      }

      const existingRecording =
        effectiveRecordings.find((recording) => recording.id === requestedRecordingId) ?? null;
      if (existingRecording) {
        openMeetingWorkspace(existingRecording);
        return;
      }

      void getRecording(requestedRecordingId)
        .then((recording) => {
          if (recording?.sourceType === "meeting") {
            openMeetingWorkspace(recording);
          }
        })
        .catch((error) => {
          console.error("Failed to open requested meeting view:", error);
        });
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
  }, [effectiveRecordings]);

  return (
    <div className="h-full flex flex-col">
      <div className="p-6 border-b flex items-center justify-between">
        <div>
          <p className="rubric mb-1.5">MEETINGS</p>
          <h1 className="font-serif text-2xl font-semibold tracking-tight">Meetings</h1>
          <p className="mt-1 text-muted-foreground">
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
            <Card className="mb-4 border-rust/40 bg-rust/5">
              <CardContent className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-rust">
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

          <section className="surface-panel-subtle mb-4 rounded-2xl p-4">
            <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
              <div>
                <p className="rubric-muted">Meeting workspace</p>
                <p className="mt-1.5 font-serif text-base font-medium text-card-foreground">
                  Bot-free capture, transcript-first review, and practical follow-through.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["Total", meetingStats.total],
                  ["Completed", meetingStats.completed],
                  ["Hours", `${meetingStats.totalHours.toFixed(1)}h`],
                  ["Errors", meetingStats.errors],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="min-w-24 rounded-xl border border-border/70 bg-background/55 px-3 py-2"
                  >
                    <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
                    <p className="mt-1 font-serif text-xl font-semibold tabular-nums tracking-tight">{value}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="surface-panel-subtle mb-4 rounded-2xl p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="relative w-full md:max-w-md">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    placeholder="Search meetings by title or date"
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
                Seeing a dictation in this list? Use the row menu and choose Mark as Dictation to move it out of Meetings.
              </p>
          </section>

          {isRecording && recordingId && (
            <Card className="mb-4 border-gold/40 bg-gold/5">
              <CardContent className="p-4">
                <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-2">
                    <div>
                      <p className="text-sm font-medium text-gold-text">Recording in progress</p>
                      <p className="text-xs text-muted-foreground">
                        Keep notes current while Plainsong captures the meeting.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="border-border bg-muted/30 text-foreground">
                        <span className="neume neume-lit mr-1" />
                        Live meeting
                      </Badge>
                      <Badge variant="outline" className="bg-background/70">
                        <Users className="mr-1 h-3 w-3" />
                        {activeMeetingCaptureMode}
                      </Badge>
                      <Badge variant="outline" className="bg-background/70">
                        Playbook: {liveMeetingTemplateOption.label}
                      </Badge>
                      {liveMeetingConsentShown ? (
                        <Badge variant="outline" className="border-gold/30 bg-gold/10 text-gold-text">
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          Consent confirmed
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
                      Open Workspace
                    </Button>
                    <div className="font-mono text-lg font-semibold">{formattedDuration}</div>
                  </div>
                </div>
                <RecordingWaveform
                  recordingId={recordingId}
                  isRecording={isRecording}
                  height={56}
                />
                <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,1fr)]">
                  <div className="rounded-lg border border-gold/20 bg-background/80 p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <p className="text-xs font-medium text-muted-foreground">
                        Meeting Notes <span className="opacity-50">(grounds summary, actions, and Ask)</span>
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        Autosaves to this meeting
                      </p>
                    </div>
                    <textarea
                      value={liveMeetingNotes}
                      onChange={(e) => setLiveMeetingNotes(e.target.value)}
                      placeholder="Capture decisions, names, risks, and next steps as the conversation moves."
                      rows={8}
                      className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-gold"
                    />
                  </div>
                  <div className="rounded-lg border border-gold/20 bg-background/70 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-xs font-medium text-gold-text">Live Transcript</p>
                      <p className="text-[11px] text-muted-foreground">
                        Transcript stays secondary to notes here
                      </p>
                    </div>
                    {streamChunks.length > 0 ? (
                      <div
                        ref={streamScrollRef}
                        className="max-h-48 space-y-1 overflow-y-auto pr-1 text-sm text-muted-foreground"
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
                              <span className="mr-1.5 font-mono text-xs text-gold-text/60">{ts}</span>
                              {chunk.text}
                            </p>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="flex h-full min-h-[140px] items-center justify-center rounded-md border border-dashed border-gold/20 bg-muted/20 px-4 text-center text-sm text-muted-foreground">
                        Live transcript lines will appear here while the meeting is being captured.
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <div className="rounded-lg border bg-background/70 p-3">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Solo operator tip
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Capture decisions and owners in notes now. Plainsong can clean them up after the call, but only if the raw facts are here.
                    </p>
                  </div>
                  <div className="rounded-lg border bg-background/70 p-3">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Best note pattern
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Decision, owner, deadline, blocker. That four-part rhythm makes summaries and follow-ups much stronger.
                    </p>
                  </div>
                  <div className="rounded-lg border bg-background/70 p-3">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      End-of-call move
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Stop capture, open workspace, refresh summary and action items, then copy a follow-up draft before context cools off.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {filteredMeetings.length === 0 ? (
            <div className="surface-panel-subtle rounded-2xl px-6 py-14 text-center">
              <span
                className="neume neume-hollow mx-auto mb-5 !block size-2.5"
                aria-hidden="true"
              />
              <h3 className="font-serif text-lg font-medium tracking-tight">
                {meetings.length === 0 ? "No meetings yet" : "No meetings match your filters"}
              </h3>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                {meetings.length === 0
                  ? "Start a meeting to capture conversation, notes, transcript review, and follow-up drafts."
                  : "Try a different search or status filter."}
              </p>
              {meetings.length === 0 && (
                <Button className="mt-4" variant="active" onClick={() => setShowConsent(true)}>
                  <Mic2 data-icon="inline-start" />
                  Start Meeting
                </Button>
              )}
            </div>
          ) : (
            <div className="grid gap-2">
              {filteredMeetings.map((recording) => {
                const isLiveRow = recording.id === recordingId && isRecording;
                const statusBand = recordingStatusBand(recording.status, isLiveRow);
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
                            <span aria-hidden="true" className="text-muted-foreground/40">·</span>
                            <span>Meeting</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center justify-end gap-2">
                        <span className="time-spec text-sm text-muted-foreground">{formatDuration(recording.duration)}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label="Play audio recording"
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
                              aria-label="Recording options"
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
                            {recording.status === "error" && (
                              <DropdownMenuItem
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  await handleRetranscribeRecording(recording.id);
                                }}
                              >
                                <RefreshCw className="h-4 w-4 mr-2" />
                                Retry Transcription
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
                              Mark as Dictation
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              // Deleting the meeting that is still recording would
                              // pull the file out from under the capture pipeline.
                              disabled={isLiveRow}
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowDeleteConfirm(recording);
                              }}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              {isLiveRow ? "Delete (stop recording first)" : "Delete"}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                );
              })}
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
              setLastMeetingExportPath(null);
              lastSavedMeetingNotesRef.current = "";
              lastSavedMeetingChatRef.current = "[]";
            }
          }
        }}
      >
          <DialogContent className="flex h-[85vh] max-h-[85vh] min-h-0 max-w-5xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>{selectedRecording?.title ?? "Recording"}</DialogTitle>
            <DialogDescription>
              Continue from live notes into grounded review, transcript editing, and follow-up for this meeting.
            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="notes" className="flex min-h-0 flex-1 flex-col overflow-hidden">
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

            <TabsContent value="notes" className="mt-2 min-h-0 flex-1 overflow-hidden">
              <ScrollArea className="h-full min-h-0 pr-2">
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
                        <div>Playbook: {selectedTemplateOption.label}</div>
                        <div>{selectedTemplateOption.description}</div>
                        {selectedRecording?.notesUpdatedAt ? (
                          <div>
                            Updated {new Date(selectedRecording.notesUpdatedAt).toLocaleString()}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                      <div className="rounded-lg border bg-muted/30 p-3">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Workspace
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className="bg-background/80">
                            {formatMeetingReviewState(selectedRecording?.status)}
                          </Badge>
                          {selectedRecording?.id === recordingId && isRecording ? (
                            <Badge variant="outline" className="border-border bg-muted/30 text-foreground">
                              <span className="neume neume-lit mr-1" />
                              Live meeting
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                      <div className="rounded-lg border bg-muted/30 p-3">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Capture mode
                        </p>
                        <p className="mt-2 text-sm font-medium">{selectedMeetingCaptureMode}</p>
                      </div>
                      <div className="rounded-lg border bg-muted/30 p-3">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Transcript grounding
                        </p>
                        <p className="mt-2 text-sm font-medium">
                          {selectedTranscript?.segments?.length ?? 0} segments
                        </p>
                      </div>
                      <div className="rounded-lg border bg-muted/30 p-3">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Consent
                        </p>
                        <p className="mt-2 text-sm font-medium">{selectedMeetingConsent.label}</p>
                        {selectedMeetingConsent.message ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {selectedMeetingConsent.message}
                          </p>
                        ) : null}
                      </div>
                      <div className="rounded-lg border bg-muted/30 p-3">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Retention
                        </p>
                        <p className="mt-2 text-sm font-medium">
                          {selectedMeetingAssetRetention.audioLabel}
                        </p>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          {selectedMeetingAssetRetention.detail}
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 rounded-lg border border-rust/20 bg-rust/5 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="rubric">
                            Solo Meeting Cockpit
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            One-glance status for what to do next before you leave this workspace.
                          </p>
                        </div>
                        <Badge variant="outline" className={qualityToneClasses(selectedMeetingReadyState.tone)}>
                          {selectedMeetingReadyState.label}
                        </Badge>
                      </div>
                      <p className="mt-3 text-sm text-muted-foreground">{selectedMeetingReadyState.detail}</p>
                      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                        {selectedMeetingEvidenceState.map((item) => (
                          <div
                            key={item.label}
                            className="rounded-md border bg-background/80 px-3 py-2"
                          >
                            <p className="text-xs font-medium text-muted-foreground">
                              {item.label}
                            </p>
                            <p className="mt-1 text-sm font-semibold">
                              {item.value}
                            </p>
                          </div>
                        ))}
                      </div>
                      <div className="mt-4 grid gap-3 md:grid-cols-3">
                        <div className="rounded-md border bg-background/80 p-3">
                          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                            <FileText className="h-3.5 w-3.5" />
                            Summary
                          </div>
                          <p className="mt-2 text-sm font-medium">
                            {meetingSummary.trim() ? "Ready" : "Needs refresh"}
                          </p>
                        </div>
                        <div className="rounded-md border bg-background/80 p-3">
                          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                            <ClipboardList className="h-3.5 w-3.5" />
                            Action items
                          </div>
                          <p className="mt-2 text-sm font-medium">
                            {selectedMeetingActionItems.length > 0
                              ? `${selectedMeetingActionItems.length} captured`
                              : "Need follow-ups"}
                          </p>
                        </div>
                        <div className="rounded-md border bg-background/80 p-3">
                          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                            <Rocket className="h-3.5 w-3.5" />
                            Follow-up
                          </div>
                          <p className="mt-2 text-sm font-medium">
                            {meetingSummary.trim() && selectedMeetingActionItems.length > 0
                              ? "Follow-up ready"
                              : "Summary needed"}
                          </p>
                        </div>
                      </div>
                      <div className="mt-4 rounded-md border bg-background/80 p-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              Review workflow
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Review the summary, confirm the next steps, then copy the draft you need without leaving Notes.
                            </p>
                          </div>
                          <Badge variant="outline" className="bg-muted/30">
                            Reliable capture + review
                          </Badge>
                        </div>
                        <div className="mt-3 grid gap-3 md:grid-cols-3">
                          {selectedMeetingReviewPath.map((step) => (
                            <div
                              key={step.title}
                              className="rounded-md border bg-muted/20 px-3 py-3"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-xs font-medium text-muted-foreground">
                                  {step.title}
                                </p>
                                <span className="rounded-full border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                                  {step.status}
                                </span>
                              </div>
                              <p className="mt-2 text-sm text-muted-foreground">{step.detail}</p>
                            </div>
                          ))}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
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
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void handleCopyMeetingFollowUp(deterministicMeetingFollowUp)}
                            disabled={
                              !selectedRecording ||
                              (!meetingSummary.trim() && selectedMeetingActionItems.length === 0)
                            }
                          >
                            <Copy className="mr-2 h-4 w-4" />
                            Copy Follow-up Draft
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
                              : "Read Follow-up"}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void handleCopyMeetingShareMarkdown()}
                            disabled={!selectedRecording || !selectedMeetingShareMarkdown.trim()}
                          >
                            <Copy className="mr-2 h-4 w-4" />
                            Copy Summary + Actions
                          </Button>
                        </div>
                      </div>
                    </div>
                    <div className="mt-4 grid gap-3 xl:grid-cols-2">
                      <div className="rounded-lg border-l-2 border-rust/40 border-y border-r border-y-rust/20 border-r-rust/20 bg-rust/5 p-4 space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="rubric flex items-center gap-1.5">
                              <span className="neume neume-rust" aria-hidden="true" />
                              Summary
                            </p>
                            <p className="rubric-muted mt-1 normal-case tracking-normal text-[10px]">
                              AI-generated from transcript + notes
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
                        </div>
                        <textarea
                          value={meetingSummary}
                          onChange={(event) => setMeetingSummary(event.target.value)}
                          aria-label="Meeting summary"
                          placeholder="Summary will appear here after transcription and analysis finish."
                          rows={8}
                          className="w-full resize-none rounded-lg border bg-background px-3 py-3 text-sm leading-relaxed placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-rust"
                        />
                      </div>

                      <div className="rounded-lg border-l-2 border-rust/40 border-y border-r border-y-border border-r-border p-4 space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="rubric flex items-center gap-1.5">
                              <span className="neume neume-rust" aria-hidden="true" />
                              Action Items
                            </p>
                            <p className="rubric-muted mt-1 normal-case tracking-normal text-[10px]">
                              AI-extracted from transcript + notes
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
                            disabled={!selectedRecording || !meetingActionItemsText.trim()}
                          >
                            <Volume2 className="mr-2 h-4 w-4" />
                            {activeSpeechTarget === "meeting-action-items"
                              ? "Stop reading"
                              : "Read aloud"}
                          </Button>
                        </div>
                        <textarea
                          value={meetingActionItemsText}
                          onChange={(event) => setMeetingActionItemsText(event.target.value)}
                          aria-label="Meeting action items"
                          placeholder="Action items will appear here after transcription and analysis finish."
                          rows={8}
                          className="w-full resize-none rounded-lg border bg-background px-3 py-3 text-sm leading-relaxed placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-rust"
                        />
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <label className="text-xs font-medium text-muted-foreground" htmlFor="meeting-template">
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
                        Apply Outline
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
                          Copy Notice
                        </Button>
                      ) : null}
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

                    <div className="rounded-lg border border-rust/30 bg-rust/5 p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="rubric">
                              Enhanced Notes
                            </p>
                            <Badge variant="outline" className="bg-background/80">
                              Transcript + raw notes
                            </Badge>
                            {enhancedMeetingNotesIsStale ? (
                              <Badge variant="outline" className="bg-rust/10 text-rust">
                                Raw notes changed
                              </Badge>
                            ) : null}
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Build a separate enhanced draft from the transcript and your current raw
                            notes, then review citations before replacing anything.
                          </p>
                          {enhancedMeetingNotesDraft ? (
                            <p className="mt-2 text-[11px] text-muted-foreground">
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
                            {enhancedMeetingNotesDraft ? "Regenerate" : "Enhance Notes"}
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
                            onClick={() => void handleApplyEnhancedMeetingNotes()}
                            disabled={!enhancedMeetingNotesDraft?.text.trim()}
                          >
                            <CheckCircle2 className="mr-2 h-4 w-4" />
                            Apply to Notes
                          </Button>
                        </div>
                      </div>

                      {enhancedMeetingNotesDraft ? (
                        <div className="space-y-3">
                          <Textarea
                            value={enhancedMeetingNotesDraft.text}
                            readOnly
                            aria-label="Enhanced meeting notes draft"
                            rows={12}
                            className="min-h-[220px] resize-y bg-background/90"
                          />

                          <div className="rounded-md border bg-background/80 p-3 space-y-3">
                            <div>
                              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                Source Evidence
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                Review which transcript lines grounded this enhanced draft.
                              </p>
                            </div>

                            <div className="space-y-2">
                              <p className="text-xs font-medium">Summary</p>
                              {enhancedMeetingNotesDraft.summaryCitations.length > 0 ? (
                                enhancedMeetingNotesDraft.summaryCitations.map((citation, index) => (
                                  <div
                                    key={`enhanced-summary-citation-${index}`}
                                    className="rounded-md border px-3 py-2 text-sm"
                                  >
                                    <p>{citation.text}</p>
                                    <p className="mt-1 text-[11px] text-muted-foreground">
                                      {formatCitationTimeRange(citation) ?? "No timestamp"}
                                      {citation.recordingId ? ` · ${citation.recordingId}` : ""}
                                    </p>
                                  </div>
                                ))
                              ) : (
                                <p className="text-xs text-muted-foreground">
                                  No summary citations were returned for this draft.
                                </p>
                              )}
                            </div>

                            <div className="space-y-2">
                              <p className="text-xs font-medium">Action Items</p>
                              {enhancedMeetingNotesDraft.actionItemCitations.some(
                                (group) => group.citations.length > 0
                              ) ? (
                                enhancedMeetingNotesDraft.actionItemCitations.map((group, groupIndex) => (
                                  <div
                                    key={`enhanced-action-group-${groupIndex}`}
                                    className="rounded-md border px-3 py-2"
                                  >
                                    <p className="text-sm font-medium">{group.label}</p>
                                    <div className="mt-2 space-y-2">
                                      {group.citations.length > 0 ? (
                                        group.citations.map((citation, citationIndex) => (
                                          <div
                                            key={`enhanced-action-citation-${groupIndex}-${citationIndex}`}
                                            className="rounded-md border bg-muted/20 px-3 py-2 text-sm"
                                          >
                                            <p>{citation.text}</p>
                                            <p className="mt-1 text-[11px] text-muted-foreground">
                                              {formatCitationTimeRange(citation) ?? "No timestamp"}
                                              {citation.recordingId
                                                ? ` · ${citation.recordingId}`
                                                : ""}
                                            </p>
                                          </div>
                                        ))
                                      ) : (
                                        <p className="text-xs text-muted-foreground">
                                          No citations were returned for this action item.
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                ))
                              ) : (
                                <p className="text-xs text-muted-foreground">
                                  No action-item citations were returned for this draft.
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-md border border-dashed bg-background/60 px-4 py-6 text-center text-sm text-muted-foreground">
                          Generate an enhanced draft when you want a cleaner meeting note built
                          from the transcript and your saved raw notes.
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="rounded-lg border bg-muted/20 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                            Prep notes
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Solo prep before or after the call: playbook, relationship memory, and the questions worth answering live.
                          </p>
                        </div>
                        <Badge variant="outline" className="bg-background/80">
                          {selectedTemplateOption.label}
                        </Badge>
                      </div>
                      <div className="mt-3 space-y-3">
                        <div className="rounded-md border bg-background/80 px-3 py-3">
                          <p className="text-xs font-medium text-muted-foreground">Prep prompts</p>
                          <ul className="mt-2 space-y-1 text-sm">
                            {selectedMeetingPrepPrompts.map((prompt) => (
                              <li key={prompt}>- {prompt}</li>
                            ))}
                          </ul>
                        </div>
                        <div className="rounded-md border bg-background/80 px-3 py-3">
                          <p className="text-xs font-medium text-muted-foreground">Relationship memory</p>
                          {selectedMeetingRelationshipMatches.people.length === 0 &&
                          selectedMeetingRelationshipMatches.companies.length === 0 ? (
                            <p className="mt-2 text-sm text-muted-foreground">
                              No strong matches yet. Plainsong will start surfacing people and companies as meetings accumulate.
                            </p>
                          ) : (
                            <div className="mt-2 space-y-2">
                              {selectedMeetingRelationshipMatches.people.map((person) => (
                                <div key={`person-${person.id}`} className="rounded-md border bg-muted/20 px-3 py-2">
                                  <p className="text-sm font-medium">{person.name}</p>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {person.recordingCount} meetings · last seen {new Date(person.lastSeenAt).toLocaleDateString()}
                                  </p>
                                  {person.recentMeetings[0] ? (
                                    <p className="mt-2 text-sm text-muted-foreground">
                                      {person.recentMeetings[0].snippet}
                                    </p>
                                  ) : null}
                                </div>
                              ))}
                              {selectedMeetingRelationshipMatches.companies.map((company) => (
                                <div key={`company-${company.id}`} className="rounded-md border bg-muted/20 px-3 py-2">
                                  <p className="text-sm font-medium">{company.name}</p>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {company.recordingCount} meetings · last seen {new Date(company.lastSeenAt).toLocaleDateString()}
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
                    </div>

                    <div className="rounded-lg border bg-muted/20 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                            Follow-up tools
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Deterministic solo outputs you can copy immediately, even before generating an AI draft.
                          </p>
                        </div>
                        <Badge variant="outline" className="bg-background/80">
                          Solo
                        </Badge>
                      </div>
                      <div className="mt-3 grid gap-3 md:grid-cols-3">
                        <div className="rounded-md border bg-background/80 px-3 py-3">
                          <p className="text-xs font-medium text-muted-foreground">Quick option</p>
                          <p className="mt-2 text-sm text-muted-foreground">
                            Copy a DM recap when you need speed, then send the longer follow-up after a quick edit.
                          </p>
                        </div>
                        <div className="rounded-md border bg-background/80 px-3 py-3">
                          <p className="text-xs font-medium text-muted-foreground">Planning option</p>
                          <p className="mt-2 text-sm text-muted-foreground">
                            Use Next Agenda after every important call so the next conversation starts with memory already loaded.
                          </p>
                        </div>
                        <div className="rounded-md border bg-background/80 px-3 py-3">
                          <p className="text-xs font-medium text-muted-foreground">Default</p>
                          <p className="mt-2 text-sm text-muted-foreground">
                            Summary, action items, and one copied draft cover the default review flow.
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void handleCopyMeetingFollowUp(deterministicMeetingFollowUp)}
                        >
                          <Copy className="mr-2 h-4 w-4" />
                          Copy Follow-up Email
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
                          Copy DM Recap
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void handleCopyMeetingFollowUp(deterministicNextAgenda)}
                        >
                          <Copy className="mr-2 h-4 w-4" />
                          Copy Next Agenda
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
                          Copy Task List
                        </Button>
                      </div>
                    </div>

                    <div className="rounded-lg border bg-muted/20 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                            Cross-meeting Recall
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Ask across prior meetings before you draft the next note, reply, or agenda.
                          </p>
                        </div>
                        <Badge variant="outline" className="bg-background/80">
                          Memory
                        </Badge>
                      </div>
                      <div className="mt-3 rounded-md border bg-background/80 px-3 py-3">
                        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                          <CalendarClock className="h-3.5 w-3.5" />
                          Best use
                        </div>
                        <p className="mt-2 text-sm text-muted-foreground">
                          Run this before sending the follow-up when prior promises, deadlines, or repeated asks may change what you say next.
                        </p>
                      </div>
                      <div className="mt-3 space-y-3">
                        <div className="flex flex-wrap gap-2">
                          {selectedMeetingRecallPrompts.map((prompt) => (
                            <Button
                              key={prompt}
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => void runMeetingRecall(prompt)}
                              disabled={meetingRecallLoading}
                            >
                              {prompt.includes("What has")
                                ? prompt.replace(/^What has /, "").split("?")[0]
                                : "Recall next follow-up"}
                            </Button>
                          ))}
                        </div>
                        <div className="flex gap-2">
                          <Input
                            value={meetingRecallQuery}
                            onChange={(event) => setMeetingRecallQuery(event.target.value)}
                            placeholder="Ask across prior meetings"
                            aria-label="Ask across meetings"
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
                              "Ask across meetings"
                            )}
                          </Button>
                        </div>
                        {meetingRecallError ? (
                          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                            {meetingRecallError}
                          </div>
                        ) : null}
                        {meetingRecallResponse ? (
                          <div className="space-y-3 rounded-md border bg-background/80 px-3 py-3">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="text-xs font-medium text-muted-foreground">
                                  {meetingRecallPromptLabel ?? "Cross-meeting answer"}
                                </p>
                                <p className="mt-2 text-sm whitespace-pre-wrap">
                                  {meetingRecallResponse}
                                </p>
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
                                <p className="text-xs font-medium text-muted-foreground">
                                  Supporting meetings
                                </p>
                                {meetingRecallCitations.slice(0, 3).map((citation, index) => (
                                  <div
                                    key={`meeting-recall-citation-${index}`}
                                    className="rounded-md border bg-muted/20 px-3 py-2 text-sm"
                                  >
                                    <p>{citation.text}</p>
                                    <p className="mt-1 text-[11px] text-muted-foreground">
                                      {formatCitationTimeRange(citation) ?? "No timestamp"}
                                      {citation.recordingId ? ` · ${citation.recordingId}` : ""}
                                    </p>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            Start with a suggested prompt or ask your own question to pull forward
                            context from prior meetings.
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="rounded-lg border bg-muted/20 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                            Share & export
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Copy a clean markdown recap or export this meeting as markdown, text, or an evidence bundle without leaving review.
                          </p>
                        </div>
                        <Badge variant="outline" className="bg-background/80">
                          Single-user
                        </Badge>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void handleCopyMeetingShareMarkdown()}
                          disabled={!selectedRecording || !selectedMeetingShareMarkdown.trim()}
                        >
                          <Copy className="mr-2 h-4 w-4" />
                          Copy Markdown
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void handleExportMeetingArtifact("markdown")}
                          disabled={!selectedRecording || isExportingMeeting}
                        >
                          <FileText className="mr-2 h-4 w-4" />
                          Export Markdown
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
                          Export Text
                        </Button>
                      </div>
                      {lastMeetingExportPath ? (
                        <div className="mt-3 rounded-md border bg-background/80 px-3 py-2 text-xs text-muted-foreground">
                          <div className="flex items-center justify-between gap-3">
                            <span className="min-w-0 break-all">{lastMeetingExportPath}</span>
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
                    </div>

                    <div className="rounded-lg border bg-muted/20 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                            Transcript preview
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Keep the note canvas open while checking the latest grounded lines.
                          </p>
                        </div>
                        <Badge variant="outline" className="bg-background/80">
                          {selectedRecording?.id === recordingId && isRecording ? "Live" : "Recent"}
                        </Badge>
                      </div>
                      {transcriptPreviewItems.length > 0 ? (
                        <div className="mt-3 space-y-2">
                          {transcriptPreviewItems.map((item) => {
                            const minutes = Math.floor(item.startTime / 60);
                            const seconds = Math.floor(item.startTime % 60);
                            const ts = `${minutes}:${seconds.toString().padStart(2, "0")}`;
                            return (
                              <div
                                key={item.id}
                                className="rounded-md border bg-background/80 px-3 py-2 text-sm"
                              >
                                <p className="mb-1 font-mono text-[11px] text-muted-foreground">
                                  {ts}
                                  {item.isPartial ? " · partial" : ""}
                                </p>
                                <p className={item.isPartial ? "text-muted-foreground italic" : ""}>
                                  {item.text}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="mt-3 rounded-md border border-dashed bg-background/60 px-4 py-6 text-center text-sm text-muted-foreground">
                          {selectedRecording?.status === "processing"
                            ? "Transcript preview will populate when processing catches up."
                            : "Transcript preview appears here once the meeting has transcript content."}
                        </div>
                      )}
                    </div>

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

                  </div>
                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent value="ask" forceMount className="mt-2 min-h-0 flex-1 overflow-hidden">
              {selectedRecording ? (
                <ScrollArea className="h-full min-h-0 pr-2">
                  <div className="space-y-4">
                    <div className="rounded-lg border bg-muted/20 p-4">
                      <p className="text-sm font-medium">Ask this meeting</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Chat against the transcript and saved meeting notes. Use this for follow-ups, decisions, blockers, or owner questions.
                      </p>
                    </div>
                    <AiAnalysisPanel
                      key={selectedRecording.id}
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
                          isVisible: ({ templateId }) => templateId !== "follow_up",
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
                                    : templateId === "follow_up"
                                      ? "Follow-up draft"
                                    : "Meeting answer",
                              response
                            ),
                        },
                        {
                          label: "Copy Follow-up",
                          onAction: ({ response }) => {
                            void handleCopyMeetingFollowUp(response);
                          },
                          isVisible: ({ templateId }) => templateId === "follow_up",
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

            <TabsContent value="transcript" className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden">
              {isLoadingDetail ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  Loading transcript...
                </div>
              ) : selectedTranscript ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  {detailError && (
                    <div className="mb-3 flex items-center gap-2 rounded-lg border border-rust/30 bg-rust/10 p-3 text-xs text-rust">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      {detailError}
                    </div>
                  )}
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
                        <p className="text-xs text-gold-text mt-2">{diarizationMessage}</p>
                      )}
                      {diarizationError && (
                        <p className="text-xs text-destructive mt-2">{diarizationError}</p>
                      )}
                    </div>
                  )}
                  <div className="mb-3 rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
                    Edit transcript paragraphs in place, or remove a paragraph if it should not be part of the meeting record.
                  </div>
                  <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-lg border bg-muted/20 p-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Transcript quality
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <span
                          className={`inline-flex rounded-full border px-2 py-1 text-[11px] font-medium ${qualityToneClasses(
                            transcriptQuality.tone
                          )}`}
                        >
                          {transcriptQuality.label}
                        </span>
                        {typeof selectedTranscriptDetails?.qualityScore === "number" && (
                          <span className="text-xs text-muted-foreground">
                            {Math.round(selectedTranscriptDetails.qualityScore * 100)}%
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="rounded-lg border bg-muted/20 p-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Source attribution
                      </p>
                      <p className="mt-2 text-sm font-medium">
                        {formatSourceMode(selectedTranscriptDetails)}
                      </p>
                    </div>
                    <div className="rounded-lg border bg-muted/20 p-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Provider
                      </p>
                      <p className="mt-2 text-sm font-medium">
                        {selectedTranscriptDetails?.actualProvider ??
                          selectedTranscript?.actualProvider ??
                          "Unknown"}
                      </p>
                      {(selectedTranscriptDetails?.modelId ?? selectedTranscript?.modelId) && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {selectedTranscriptDetails?.modelId ?? selectedTranscript?.modelId}
                        </p>
                      )}
                    </div>
                    <div className="rounded-lg border bg-muted/20 p-3">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Transcription latency
                      </p>
                      <p className="mt-2 text-sm font-medium">
                        {selectedTranscriptDetails?.transcriptionLatencyMs != null
                          ? `${(selectedTranscriptDetails.transcriptionLatencyMs / 1000).toFixed(1)}s`
                          : "Unavailable"}
                      </p>
                    </div>
                  </div>
                  <TranscriptSearch
                    onSearch={setSearchQuery}
                    className="mb-4 shrink-0"
                  />
                  <div className="min-h-0 flex-1 rounded-lg border overflow-hidden">
                    <TranscriptViewer
                      segments={filteredSegments}
                      speakerNames={speakerNames}
                      onRenameSpeaker={handleRenameSpeaker}
                      onEditSegment={async (segmentIds, newText) => {
                        if (!selectedRecording || segmentIds.length === 0) return;
                        try {
                          // The edited text covers the whole speaker turn: it
                          // replaces the first segment, and the remaining
                          // segments are removed so their old text can't
                          // duplicate alongside the correction.
                          const [firstSegmentId, ...restSegmentIds] = segmentIds;
                          await updateTranscriptSegment(selectedRecording.id, firstSegmentId, newText);
                          if (restSegmentIds.length > 0) {
                            await deleteTranscriptSegments(selectedRecording.id, restSegmentIds);
                          }
                          await refreshTranscript(selectedRecording.id);
                          await refreshTranscriptDetails(selectedRecording.id);
                          toast("Transcript updated.", "success");
                        } catch (error) {
                          const message =
                            error instanceof Error
                              ? error.message
                              : "Failed to update the transcript.";
                          toast(message, "error");
                          // Rethrow so the editor stays open with the correction.
                          throw error;
                        }
                      }}
                      onDeleteSegments={handleDeleteTranscriptSegments}
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
                    <div className="max-w-md rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
                      <div className="flex items-center gap-2 text-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span className="font-medium">Processing transcript</span>
                      </div>
                      <p className="mt-2 leading-relaxed">
                        Transcript lines have not landed yet. Auto-refresh is still running in the
                        background, and you can force a manual refresh if the detail panel looks
                        stale.
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
                        <span className="text-xs text-muted-foreground">
                          Consent: {selectedMeetingConsent.label}
                        </span>
                        {selectedMeetingConsent.needsManualNotice ? (
                          <span className="text-xs text-rust">
                            Share the notice before distributing this capture.
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ) : selectedRecording?.status === "error" ? (
                    <div className="max-w-md rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
                      <p className="font-medium text-foreground">
                        Transcription failed
                      </p>
                      <p className="mt-2 leading-relaxed">
                        This meeting's transcript could not be produced. The audio is still on
                        disk, so you can retry transcription from scratch.
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
                    <div className="max-w-md rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
                      <p className="font-medium text-foreground">
                        Transcript is not available yet
                      </p>
                      <p className="mt-2 leading-relaxed">
                        This meeting does not have grounded transcript lines yet. Refresh the
                        detail panel if processing already finished, or return to the note canvas
                        while capture is still active.
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
                          Refresh transcript
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          Capture mode: {selectedMeetingCaptureMode}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </TabsContent>

            <TabsContent value="assets" className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden">
              {isLoadingDetail ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  Loading meeting assets...
                </div>
              ) : (
                <ScrollArea className="h-full min-h-0 pr-2">
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
                          {selectedMeetingAssetRetention.audioLabel}
                        </span>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          {selectedMeetingAssetRetention.detail}
                        </p>
                      </div>
                    </div>
                  </div>
                </ScrollArea>
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
              Are you sure you want to delete &ldquo;{showDeleteConfirm?.title}&rdquo;?{" "}
              {deleteConfirmationRetention.deleteWarning}
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
