import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { listen } from "@/lib/electron";
import { useScopedRequestGuard } from "@/hooks/use-scoped-request-guard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AiWaitOrb } from "@/components/ui/ai-wait-orb";
import { useSavedPromptChat } from "@/components/prompts/use-saved-prompt-chat";
import { ActionItemChip } from "@/components/views/meetings/action-item-list";
import {
  analyzeRecording,
  cancelAnalysisRun,
  extractActionItems,
  extractActionItemsGrounded,
  type MeetingChatMessage,
} from "@/lib/backend/ai";
import type {
  LlmAnalysisResult,
  ActionItem,
  AnalysisTemplate,
  AnalysisProvenance,
  LlmCitation,
  RecordingAnalysisFailedEvent,
  RecordingAnalysisProgressEvent,
} from "@/types";
import { 
  Sparkles, 
  FileText, 
  CheckSquare, 
  Lightbulb,
  Calendar,
  Send,
  AlertCircle
} from "lucide-react";
import { formatTime } from "@/lib/format-locale";
import { isCurrentWrittenNoteCitation, type CitationSource } from "@/lib/citation-source";
import { stripTransportPrefix } from "@/lib/meeting-start-error";
import { requestSettingsTab } from "@/lib/navigation";

interface AnalysisCopyScope {
  recordingId: string;
  output: LlmAnalysisResult | ActionItem[] | null;
  kind: "answer" | "tasks";
  text: string;
  sourceNotes: string | null | undefined;
  warning: string | null;
}

interface AiAnalysisPanelProps {
  recordingId: string;
  sourceNotes?: string | null;
  className?: string;
  title?: string;
  inputPlaceholder?: string;
  templates?: AnalysisTemplate[];
  emptyStateLabel?: string;
  analysisMode?: "standard" | "grounded";
  responseActions?: Array<{
    label: string;
    onAction: (payload: {
      response: string;
      query: string;
      templateId: string | null;
      citations: LlmCitation[];
      provenance: AnalysisProvenance;
    }) => void;
    isVisible?: (payload: {
      response: string;
      query: string;
      templateId: string | null;
      citations: LlmCitation[];
      provenance: AnalysisProvenance;
    }) => boolean;
  }>;
  actionItemActions?: Array<{
    label: string;
    onAction: (payload: {
      items: ActionItem[];
      templateId: string | null;
    }) => void;
  }>;
  chatMessages?: MeetingChatMessage[];
  onChatMessagesChange?: (messages: MeetingChatMessage[]) => void;
}

const ANALYSIS_TEMPLATES: AnalysisTemplate[] = [
  {
    id: "summary",
    name: "Meeting Summary",
    icon: "file-text",
    query: "Provide a concise summary of this meeting, highlighting the main topics discussed and key outcomes.",
    description: "Get a high-level overview of the meeting"
  },
  {
    id: "actions",
    name: "Action Items",
    icon: "check-square",
    query: "Extract all action items, tasks, and to-dos mentioned in this transcript.",
    description: "Find all tasks and assignments"
  },
  {
    id: "decisions",
    name: "Decisions Made",
    icon: "lightbulb",
    query: "List all decisions, agreements, and conclusions reached during this meeting.",
    description: "Identify key decisions and outcomes"
  },
  {
    id: "dates",
    name: "Key Dates",
    icon: "calendar",
    query: "Extract all dates, deadlines, and time-related commitments mentioned.",
    description: "Find deadlines and important dates"
  }
];

function hasUsableReference(citation: CitationSource, recordingId: string, notes?: string | null): boolean {
  if (citation.sourceKind === "meeting_note") return isCurrentWrittenNoteCitation(citation, recordingId, notes);
  return (citation.sourceKind == null || citation.sourceKind === "transcript") &&
    citation.recordingId === recordingId &&
    typeof citation.startTime === "number" && Number.isFinite(citation.startTime) && citation.startTime >= 0 &&
    typeof citation.endTime === "number" && Number.isFinite(citation.endTime) && citation.endTime >= citation.startTime;
}

function CitationQuote({ citation, recordingId, notes }: {citation: CitationSource; recordingId: string; notes?: string | null}) {
  const usable = hasUsableReference(citation, recordingId, notes);
  const isNote = citation.sourceKind === "meeting_note";
  const knownTranscript = citation.sourceKind === "transcript" || (citation.sourceKind == null &&
    typeof citation.startTime === "number" && typeof citation.endTime === "number");
  const label = isNote ? "Written note" : knownTranscript ? "Transcript" : citation.sourceKind == null ? "Source not recorded" : "Unknown source";
  return (
    <p className="text-xs text-muted-foreground italic">
      <span className="not-italic font-medium">{label}{usable ? "" : " · Unverified reference"}</span>{" "}
      &ldquo;{citation.text}&rdquo;
      {knownTranscript && usable ? <span className="not-italic ml-1">({citation.startTime!.toFixed(1)}s - {citation.endTime!.toFixed(1)}s)</span> : null}
    </p>
  );
}

function analysisErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message
    : typeof error === "string" ? error
    : error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message
    : "Analysis failed";
  return stripTransportPrefix(message) || "Analysis failed";
}

function needsProviderSetup(message: string): boolean {
  return /connection refused|API key|missing provider secret|key not configured/i.test(message);
}

export function AiAnalysisPanel({
  recordingId,
  sourceNotes,
  className,
  title = "AI Analysis",
  inputPlaceholder = "Ask a custom question about this transcript...",
  templates = ANALYSIS_TEMPLATES,
  emptyStateLabel = "Analyzing transcript...",
  analysisMode = "standard",
  responseActions = [],
  actionItemActions = [],
  chatMessages,
  onChatMessagesChange,
}: AiAnalysisPanelProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [cancelStatus, setCancelStatus] = useState<string | null>(null);
  const [copyPending, setCopyPending] = useState(false);
  const copyPendingRef = useRef(false);
  const [copyFeedback, setCopyFeedback] = useState<{ scope: AnalysisCopyScope; message: string; error: boolean } | null>(null);
  const currentRecordingIdRef = useRef(recordingId);
  currentRecordingIdRef.current = recordingId;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const [customQuery, setCustomQuery] = useState("");
  const customQueryRevisionRef = useRef(0);
  const changeCustomQuery = useCallback((value: string) => {
    ++customQueryRevisionRef.current;
    setCustomQuery(value);
  }, []);
  const [lastResult, setLastResult] = useState<LlmAnalysisResult | null>(null);
  const [actionItems, setActionItems] = useState<ActionItem[] | null>(null);
  const [actionItemCitations, setActionItemCitations] = useState<Array<LlmCitation[]>>([]);
  const [actionItemsGrounded, setActionItemsGrounded] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analysisProgress, setAnalysisProgress] =
    useState<RecordingAnalysisProgressEvent | null>(null);
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [lastQuery, setLastQuery] = useState("");
  const [lastPromptLabel, setLastPromptLabel] = useState("");
  const [lastTemplateId, setLastTemplateId] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<MeetingChatMessage[]>(
    chatMessages ?? []
  );
  const requestGuard = useScopedRequestGuard<string | null>();
  const activeAnalysisRunRef = useRef<{
    runId: string;
    target: "ask" | "actionItems";
    promptLabel: string;
    recordingId: string;
    cancelRequested: boolean;
  } | null>(null);

  useEffect(() => {
    setThreadMessages(chatMessages ?? []);
  }, [chatMessages]);

  useEffect(() => {
    const activeRun = activeAnalysisRunRef.current;
    if (activeRun && !activeRun.cancelRequested) {
      activeRun.cancelRequested = true;
      void Promise.resolve(cancelAnalysisRun(activeRun.runId)).catch(() => undefined);
    }
    activeAnalysisRunRef.current = null;
    requestGuard.setScope(recordingId);
    setIsAnalyzing(false);
    setCancelStatus(null);
    ++customQueryRevisionRef.current;
    setCustomQuery("");
    setLastResult(null);
    setActionItems(null);
    setActionItemCitations([]);
    setActionItemsGrounded(null);
    activeAnalysisRunRef.current = null;
    setError(null);
    setAnalysisProgress(null);
    setShowSetupGuide(false);
    setLastQuery("");
    setLastPromptLabel("");
    setLastTemplateId(null);
  }, [recordingId, requestGuard]);

  useEffect(() => {
    let disposed = false;
    let unlistenProgress: (() => void) | undefined;
    let unlistenFailure: (() => void) | undefined;

    const matchesActiveRun = (
      payload: RecordingAnalysisProgressEvent | RecordingAnalysisFailedEvent
    ) => {
      const activeRun = activeAnalysisRunRef.current;
      return Boolean(
        activeRun && !activeRun.cancelRequested &&
          payload.recordingId === recordingId &&
          payload.target === activeRun.target &&
          payload.runId === activeRun.runId
      );
    };

    void listen<RecordingAnalysisProgressEvent>(
      "recording-analysis-progress",
      (event) => {
        if (event.payload && matchesActiveRun(event.payload)) {
          setAnalysisProgress(
            event.payload.stage === "completed" ? null : event.payload
          );
        }
      }
    ).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlistenProgress = unlisten;
      }
    });
    void listen<RecordingAnalysisFailedEvent>(
      "recording-analysis-failed",
      (event) => {
        if (event.payload && matchesActiveRun(event.payload)) {
          setAnalysisProgress(null);
          setError(
            `${event.payload.reason} Previous successful analysis remains available.`
          );
        }
      }
    ).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlistenFailure = unlisten;
      }
    });
    return () => {
      disposed = true;
      unlistenProgress?.();
      unlistenFailure?.();
    };
  }, [recordingId]);

  useEffect(() => {
    return () => {
      const activeRun = activeAnalysisRunRef.current;
      activeAnalysisRunRef.current = null;
      requestGuard.setScope(null);
      if (activeRun && !activeRun.cancelRequested) {
        activeRun.cancelRequested = true;
        void Promise.resolve(cancelAnalysisRun(activeRun.runId)).catch(() => undefined);
      }
    };
  }, [requestGuard]);

  const appendThreadMessages = useCallback((messages: MeetingChatMessage[]) => {
    setThreadMessages((current) => {
      const next = [...current, ...messages];
      onChatMessagesChange?.(next);
      return next;
    });
  }, [onChatMessagesChange]);

  const buildThreadedCustomQuery = (query: string) => {
    if (threadMessages.length === 0) {
      return query;
    }

    const threadContext = threadMessages
      .filter((message) => message.role === "user")
      .slice(-6)
      .map((message) => `Earlier user question: ${message.content}`)
      .join("\n\n");
    if (!threadContext) {
      return query;
    }

    return [
      "Earlier user questions for conversational context:",
      threadContext,
      "",
      `New user question: ${query}`,
      "Answer the newest question directly. Use the transcript and saved meeting notes as the source of truth.",
    ].join("\n");
  };

  const buildActionItemsThreadMessage = (items: ActionItem[]) => {
    if (items.length === 0) {
      return "No action items found in this meeting.";
    }

    return items
      .map((item) => {
        const details = [
          item.assignee ? `Owner: ${item.assignee}` : null,
          item.deadline ? `Due: ${item.deadline}` : null,
        ].filter(Boolean);
        return details.length > 0
          ? `- ${item.task} (${details.join(" · ")})`
          : `- ${item.task}`;
      })
      .join("\n");
  };

  const canAcceptResult = (runId: string) => {
    const active = activeAnalysisRunRef.current;
    return mountedRef.current && active?.runId === runId && !active.cancelRequested
      && active.recordingId === currentRecordingIdRef.current;
  };
  const handleCancelRequest = async (runId: string) => {
    const active = activeAnalysisRunRef.current;
    if (!active || active.runId !== runId || active.cancelRequested
      || active.recordingId !== currentRecordingIdRef.current) return;
    active.cancelRequested = true;
    setCancelStatus("Cancelling request…");
    setAnalysisProgress(null);
    setError(null);
    try {
      await cancelAnalysisRun(runId);
    } catch {
      if (mountedRef.current && activeAnalysisRunRef.current === active
        && active.recordingId === currentRecordingIdRef.current) {
        setCancelStatus("Could not cancel immediately. Waiting for the request to finish.");
      }
    }
  };

  // Completed output keeps the prompt that produced it while another request
  // runs or fails. Result actions must never use a pending prompt's metadata.
  const setCompletedPrompt = (query: string, templateId: string | null, label: string) => {
    setLastQuery(query);
    setLastTemplateId(templateId);
    setLastPromptLabel(label);
  };

  const handleTemplateClick = async (template: AnalysisTemplate) => {
    if (activeAnalysisRunRef.current || isAnalyzing) return;
    const requestToken = requestGuard.beginRequest(recordingId);
    const runId = crypto.randomUUID();
    const target = template.id === "actions" ? "actionItems" : "ask";
    activeAnalysisRunRef.current = { runId, target, promptLabel: template.name, recordingId, cancelRequested: false };
    setIsAnalyzing(true);
    setCancelStatus(null);
    setError(null);
    setShowSetupGuide(false);
    const userMessage: MeetingChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: template.name,
      templateId: template.id,
      citations: [],
      createdAt: new Date().toISOString(),
    };
    
    try {
      if (template.id === "actions") {
        if (analysisMode === "grounded") {
          const result = await extractActionItemsGrounded(recordingId, undefined, {
            persist: false,
            runId,
          });
          if (!requestGuard.isCurrent(requestToken) || !canAcceptResult(runId)) {
            return;
          }
          setLastResult(null);
          setCompletedPrompt(template.query, template.id, template.name);
          setActionItems(result.items);
          setActionItemCitations(result.items.map((item) => item.citations ?? []));
          setActionItemsGrounded(result.grounded !== false);
          appendThreadMessages([
            userMessage,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: buildActionItemsThreadMessage(result.items),
              templateId: template.id,
              citations: result.items.flatMap((item) => item.citations ?? []),
              createdAt: new Date().toISOString(),
            },
          ]);
        } else {
          const items = await extractActionItems(recordingId, undefined, {
            persist: false,
            runId,
          });
          if (!requestGuard.isCurrent(requestToken) || !canAcceptResult(runId)) {
            return;
          }
          setLastResult(null);
          setCompletedPrompt(template.query, template.id, template.name);
          setActionItems(items);
          setActionItemCitations([]);
          setActionItemsGrounded(null);
          appendThreadMessages([
            userMessage,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: buildActionItemsThreadMessage(items),
              templateId: template.id,
              citations: [],
              createdAt: new Date().toISOString(),
            },
          ]);
        }
      } else {
        const result = await analyzeRecording(
          recordingId,
          template.query,
          undefined,
          runId
        );
        if (!requestGuard.isCurrent(requestToken) || !canAcceptResult(runId)) {
          return;
        }
        setCompletedPrompt(template.query, template.id, template.name);
        setLastResult(result);
        setActionItems(null);
        setActionItemCitations([]);
        setActionItemsGrounded(null);
        appendThreadMessages([
          userMessage,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: result.response,
            templateId: template.id,
            citations: result.citations,
            createdAt: new Date().toISOString(),
          },
        ]);
      }
    } catch (err) {
      if (!requestGuard.isCurrent(requestToken) || !canAcceptResult(runId)) {
        return;
      }
      const message = analysisErrorMessage(err);
      setShowSetupGuide(needsProviderSetup(message));
      setError(message);
    } finally {
      if (requestGuard.isCurrent(requestToken)) {
        setIsAnalyzing(false);
        setCancelStatus(null);
        setAnalysisProgress(null);
        if (activeAnalysisRunRef.current?.runId === runId) {
          activeAnalysisRunRef.current = null;
        }
      }
    }
  };

  const savedPromptChat = useSavedPromptChat({
    scope: "meeting",
    inputValue: customQuery,
    onPickPrompt: changeCustomQuery,
    label: "Saved prompts for this meeting",
  });

  const handleCustomQuery = async () => {
    if (activeAnalysisRunRef.current || isAnalyzing) return;
    // A "/" query is the picker's, not a question. Sending it would ask the
    // meeting about the literal text "/dec".
    if (savedPromptChat.pickerOpen) return;
    if (!customQuery.trim()) return;
    const requestToken = requestGuard.beginRequest(recordingId);
    const runId = crypto.randomUUID();
    const rawQuery = customQuery.trim();
    activeAnalysisRunRef.current = { runId, target: "ask", promptLabel: rawQuery, recordingId, cancelRequested: false };

    setIsAnalyzing(true);
    setCancelStatus(null);
    setError(null);
    setShowSetupGuide(false);

    const queryRevision = customQueryRevisionRef.current;
    const userMessage: MeetingChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: rawQuery,
      templateId: null,
      citations: [],
      createdAt: new Date().toISOString(),
    };
    
    try {
      const result = await analyzeRecording(
        recordingId,
        buildThreadedCustomQuery(rawQuery),
        undefined,
        runId
      );
      if (!requestGuard.isCurrent(requestToken) || !canAcceptResult(runId)) {
        return;
      }
      setCompletedPrompt(rawQuery, null, rawQuery);
      setLastResult(result);
      setActionItems(null);
      setActionItemCitations([]);
      setActionItemsGrounded(null);
      appendThreadMessages([
        userMessage,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: result.response,
          templateId: null,
          citations: result.citations,
          createdAt: new Date().toISOString(),
        },
      ]);
      setCustomQuery((current) => customQueryRevisionRef.current === queryRevision ? "" : current);
    } catch (err) {
      if (!requestGuard.isCurrent(requestToken) || !canAcceptResult(runId)) {
        return;
      }
      const message = analysisErrorMessage(err);
      setShowSetupGuide(needsProviderSetup(message));
      setError(message);
    } finally {
      if (requestGuard.isCurrent(requestToken)) {
        setIsAnalyzing(false);
        setCancelStatus(null);
        setAnalysisProgress(null);
        if (activeAnalysisRunRef.current?.runId === runId) {
          activeAnalysisRunRef.current = null;
        }
      }
    }
  };

  const getTemplateIcon = (iconName: string) => {
    switch (iconName) {
      case "file-text":
        return <FileText className="h-4 w-4" />;
      case "check-square":
        return <CheckSquare className="h-4 w-4" />;
      case "lightbulb":
        return <Lightbulb className="h-4 w-4" />;
      case "calendar":
        return <Calendar className="h-4 w-4" />;
      default:
        return <Sparkles className="h-4 w-4" />;
    }
  };

  const hasIncompleteReferences = Boolean(lastResult && (lastResult.citations.length === 0 || lastResult.citations.some(citation => !hasUsableReference(citation, recordingId, sourceNotes))));
  const answerReviewWarning = lastResult?.grounded === false
    ? "Not fully grounded: one or more citations were invalid or did not support the answer."
    : hasIncompleteReferences
      ? "Some citations lack a current source reference. Review the answer against its sources."
      : null;
  const showUncertaintyBanner = answerReviewWarning !== null;
  const tasksHaveIncompleteReferences = Boolean(actionItems?.some((_item, index) => {
    const citations = actionItemCitations[index] ?? [];
    return citations.length === 0 || citations.some(citation => !hasUsableReference(citation, recordingId, sourceNotes));
  }));
  const taskReviewWarning = actionItemsGrounded === false
    ? "Not fully grounded: one or more follow-ups had invalid or unsupported transcript citations."
    : tasksHaveIncompleteReferences
      ? "Some task citations lack a current source reference. Review the tasks against the meeting before sharing."
      : null;
  const kind = lastResult ? "answer" : "tasks";
  const output = lastResult ?? actionItems;
  const text = lastResult ? lastResult.response : actionItems ? buildActionItemsThreadMessage(actionItems) : "";
  const warning = lastResult ? answerReviewWarning : taskReviewWarning;
  const copyScopeRef = useRef<AnalysisCopyScope>({ recordingId, output, kind, text, sourceNotes, warning });
  const previousCopyScope = copyScopeRef.current;
  if (previousCopyScope.recordingId !== recordingId || previousCopyScope.output !== output
    || previousCopyScope.kind !== kind || previousCopyScope.text !== text
    || previousCopyScope.sourceNotes !== sourceNotes || previousCopyScope.warning !== warning) {
    copyScopeRef.current = { recordingId, output, kind, text, sourceNotes, warning };
  }
  const visibleCopyFeedback = copyFeedback?.scope === copyScopeRef.current ? copyFeedback : null;
  const handleCopyOutput = async (requestedKind: AnalysisCopyScope["kind"]) => {
    const scope = copyScopeRef.current;
    if (copyPendingRef.current || scope.kind !== requestedKind || !scope.output || !scope.text.trim()) return;
    const copiedText = scope.warning ? `${scope.warning}\n\n${scope.text}` : scope.text;
    copyPendingRef.current = true;
    setCopyPending(true);
    setCopyFeedback({ scope, message: "Copying…", error: false });
    try {
      await navigator.clipboard.writeText(copiedText);
      if (mountedRef.current && copyScopeRef.current === scope) {
        setCopyFeedback({ scope, message: scope.kind === "tasks" ? "Tasks copied." : "Answer copied.", error: false });
      }
    } catch {
      if (mountedRef.current && copyScopeRef.current === scope) {
        setCopyFeedback({ scope, message: scope.kind === "tasks"
          ? "Could not copy the tasks. Select them and copy them manually."
          : "Could not copy the answer. Select it and copy it manually.", error: true });
      }
    } finally {
      copyPendingRef.current = false;
      if (mountedRef.current) setCopyPending(false);
    }
  };
  const displayedRun = activeAnalysisRunRef.current;

  return (
    <div className={cn("space-y-4", className)}>
      <p role="status" aria-label="Answer status" aria-live="polite" aria-atomic="true" className="sr-only">
        {error ? "Answer failed. Try again." : isAnalyzing ? "Answering your question." : lastResult || actionItems ? "Answer ready." : ""}
      </p>
      {savedPromptChat.manager}
      {/* Template Buttons */}
      <div className="grid grid-cols-2 gap-2">
        {templates.map((template) => (
          <Button
            key={template.id}
            variant="outline"
            className="h-auto py-3 px-3 justify-start text-left flex-col items-start gap-1"
            onClick={() => handleTemplateClick(template)}
            disabled={isAnalyzing}
          >
            <div className="flex items-center gap-2 font-medium">
              {getTemplateIcon(template.icon)}
              {template.name}
            </div>
            <p className="text-xs text-muted-foreground font-normal">
              {template.description}
            </p>
          </Button>
        ))}
      </div>

      {/* Custom Query */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <Input
            placeholder={inputPlaceholder}
            value={customQuery}
            {...savedPromptChat.inputProps}
            aria-label="Question about this meeting"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => changeCustomQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
              // The picker takes the arrows, Enter and Escape while it is
              // open; anything it does not claim falls through to Send.
              savedPromptChat.onInputKeyDown(e);
              if (e.defaultPrevented) return;
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCustomQuery();
              }
            }}
          />
          <Button
            size="icon"
            aria-label="Send"
            onClick={handleCustomQuery}
            disabled={isAnalyzing || !customQuery.trim() || savedPromptChat.pickerOpen}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        {savedPromptChat.picker}
        <p className="text-sm text-muted-foreground">
          Type &ldquo;/&rdquo; for a saved prompt.
        </p>
      </div>

      {threadMessages.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="font-serif text-base font-semibold">Conversation</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-72 pr-3">
              <div className="space-y-3">
                {threadMessages.map((message) => (
                  <div
                    key={message.id}
                    className={cn(
                      "rounded-lg border p-3",
                      message.role === "assistant" ? "bg-muted/40" : "bg-background"
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="rubric-muted">
                        {message.role === "assistant" ? "Assistant" : "You"}
                      </p>
                      <div className="flex items-center gap-2">
                        {message.role === "user" && message.content.trim() ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-auto px-2 py-1 text-sm text-muted-foreground"
                            onClick={() => savedPromptChat.saveTextAsPrompt(message.content)}
                          >
                            Save as prompt
                          </Button>
                        ) : null}
                        <p className="font-mono text-[11px] text-muted-foreground tabular-nums">
                          {formatTime(message.createdAt)}
                        </p>
                      </div>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm">{message.content}</p>
                    {message.citations.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {message.citations.map((citation, idx) => (
                          <CitationQuote key={`${message.id}-${idx}`} citation={citation} recordingId={recordingId} notes={sourceNotes} />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {analysisProgress && (
        <div
          role="status"
          className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground"
        >
          <div className="flex items-center gap-2">
            <AiWaitOrb state="composing" />
            <span>{analysisProgress.message}</span>
          </div>
          {analysisProgress.strategy === "chunked" && analysisProgress.total > 0 ? (
            <p className="mt-1 text-xs">
              Full transcript coverage · {analysisProgress.completed} of{" "}
              {analysisProgress.total}
            </p>
          ) : null}
        </div>
      )}

      {isAnalyzing && displayedRun && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {displayedRun.cancelRequested ? "Cancelling" : "Answering"}: {displayedRun.promptLabel}
          </p>
          <Button type="button" variant="outline" size="sm" disabled={displayedRun.cancelRequested}
            onClick={() => void handleCancelRequest(displayedRun.runId)}>
            {displayedRun.cancelRequested ? "Cancelling…" : "Cancel request"}
          </Button>
        </div>
      )}
      {cancelStatus && <p role="status" className="text-sm text-muted-foreground">{cancelStatus}</p>}

      {/* Error Display */}
      {error && (
        <div
          role="alert"
          className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-start gap-2 text-sm text-destructive"
        >
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <div className="flex-1">
            <p>{error}</p>
            {showSetupGuide && (
              // One way forward, in the app: the built-in model needs no
              // terminal and no account, and Ollama or a cloud key are
              // choices made in Search & AI.
              <div className="mt-3 space-y-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                <p>
                  Choose who answers in Search &amp; AI. The built-in model runs on this Mac
                  without an account; Ollama and cloud providers are optional.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => requestSettingsTab("ai")}
                >
                  Open Search &amp; AI
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Results */}
      {isAnalyzing && !lastResult && !actionItems && (
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
          {/* One orb at a time: the progress card above carries it once a
              long transcript is analysed in parts. */}
          {analysisProgress ? null : <AiWaitOrb state="composing" />}
          <p className="font-serif text-sm text-muted-foreground">{displayedRun?.cancelRequested ? "Waiting for the request to finish." : emptyStateLabel}</p>
        </div>
      )}

      {lastResult && (
        <Card role="region" aria-label="Meeting answer">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 font-serif text-base font-semibold">
                <Sparkles className="h-4 w-4 text-gold-text" />
                {title}
              </CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="outline" disabled={copyPending || !lastResult.response.trim()}
                  onClick={() => void handleCopyOutput("answer")}>
                  {copyPending ? "Copying…" : "Copy answer"}
                </Button>
                <Badge variant="secondary" className="font-mono text-xs">
                  {lastResult.actualProvider
                    ? `${lastResult.actualProvider} · ${lastResult.model}`
                    : lastResult.model}
                </Badge>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {(lastResult.processingTimeMs / 1000).toFixed(1)}s
                </span>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">Answered question: {lastPromptLabel}</p>
            {visibleCopyFeedback && <p aria-label="Copy status" role={visibleCopyFeedback.error ? "alert" : "status"} className="mb-3 text-sm text-muted-foreground">
              {visibleCopyFeedback.message}
            </p>}
            <ScrollArea className="h-[200px]">
              <div className="text-sm leading-relaxed whitespace-pre-wrap">
                {lastResult.response}
              </div>
            </ScrollArea>
            
            {showUncertaintyBanner && (
              <div className="mt-4 p-2 rounded-md bg-rust/10 text-rust text-xs">
                {answerReviewWarning}
              </div>
            )}

            {lastResult.citations.length > 0 && (
              <div className="mt-4 pt-4 border-t">
                <p className="rubric mb-2">CITATIONS</p>
                <div className="space-y-1">
                  {lastResult.citations.map((citation, idx) => (
                    <CitationQuote key={idx} citation={citation} recordingId={recordingId} notes={sourceNotes} />
                  ))}
                </div>
              </div>
            )}

            {responseActions.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2 border-t pt-4">
                {responseActions
                  .filter((action) =>
                    action.isVisible?.({
                      response: lastResult.response,
                      query: lastQuery,
                      templateId: lastTemplateId,
                      citations: lastResult.citations,
                      provenance: lastResult.provenance,
                    }) ?? true
                  )
                  .map((action) => (
                    <Button
                      key={action.label}
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        action.onAction({
                          response: lastResult.response,
                          query: lastQuery,
                          templateId: lastTemplateId,
                          citations: lastResult.citations,
                          provenance: lastResult.provenance,
                        })
                      }
                    >
                      {action.label}
                    </Button>
                  ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {actionItems && actionItems.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 font-serif text-base font-semibold">
                <CheckSquare className="h-4 w-4 text-gold-text" />
                Action Items
              </CardTitle>
              <Button type="button" size="sm" variant="outline" disabled={copyPending}
                onClick={() => void handleCopyOutput("tasks")}>
                {copyPending ? "Copying…" : "Copy tasks"}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {visibleCopyFeedback && <p aria-label="Copy status" role={visibleCopyFeedback.error ? "alert" : "status"} className="mb-3 text-sm text-muted-foreground">
              {visibleCopyFeedback.message}
            </p>}
            <div className="space-y-2">
              {actionItems.map((item, idx) => (
                <div key={idx} className="flex items-start gap-2 p-2 bg-muted/50 rounded-lg">
                  <div className="h-5 w-5 rounded border border-muted-foreground/30 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm">{item.task}</p>
                    {(item.assignee || item.deadline) && (
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        {item.assignee && (
                          <ActionItemChip label="Owner" value={item.assignee} />
                        )}
                        {item.deadline && (
                          <ActionItemChip label="Due" value={item.deadline} />
                        )}
                      </div>
                    )}
                    {actionItemCitations[idx]?.length ? (
                      <div className="mt-2 space-y-1">
                        {actionItemCitations[idx].map((citation, citationIndex) => (
                          <CitationQuote key={citationIndex} citation={citation} recordingId={recordingId} notes={sourceNotes} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>

            {taskReviewWarning && (
              <div className="mt-4 rounded-md bg-rust/10 p-2 text-xs text-rust">
                {taskReviewWarning}
              </div>
            )}

            {actionItemActions.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2 border-t pt-4">
                {actionItemActions.map((action) => (
                  <Button
                    key={action.label}
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      action.onAction({
                        items: actionItems,
                        templateId: lastTemplateId,
                      })
                    }
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {actionItems && actionItems.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <span className="neume neume-hollow" aria-hidden="true" />
          <p className="font-serif text-sm text-muted-foreground">No action items found in this transcript</p>
        </div>
      )}
    </div>
  );
}
