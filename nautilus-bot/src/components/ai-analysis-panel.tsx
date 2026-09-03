import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { listen } from "@/lib/electron";
import { useScopedRequestGuard } from "@/hooks/use-scoped-request-guard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
  Loader2,
  AlertCircle
} from "lucide-react";
import { formatTime } from "@/lib/format-locale";

interface AiAnalysisPanelProps {
  recordingId: string;
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

export function AiAnalysisPanel({
  recordingId,
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
  const [customQuery, setCustomQuery] = useState("");
  const [lastResult, setLastResult] = useState<LlmAnalysisResult | null>(null);
  const [actionItems, setActionItems] = useState<ActionItem[] | null>(null);
  const [actionItemCitations, setActionItemCitations] = useState<Array<LlmCitation[]>>([]);
  const [actionItemsGrounded, setActionItemsGrounded] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analysisProgress, setAnalysisProgress] =
    useState<RecordingAnalysisProgressEvent | null>(null);
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [lastQuery, setLastQuery] = useState("");
  const [lastTemplateId, setLastTemplateId] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<MeetingChatMessage[]>(
    chatMessages ?? []
  );
  const requestGuard = useScopedRequestGuard<string | null>();
  const activeAnalysisRunRef = useRef<{
    runId: string;
    target: "ask" | "actionItems";
  } | null>(null);

  useEffect(() => {
    setThreadMessages(chatMessages ?? []);
  }, [chatMessages]);

  useEffect(() => {
    const activeRun = activeAnalysisRunRef.current;
    if (activeRun) {
      void cancelAnalysisRun(activeRun.runId);
      activeAnalysisRunRef.current = null;
    }
    requestGuard.setScope(recordingId);
    setIsAnalyzing(false);
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
        activeRun &&
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
      if (activeRun) {
        void cancelAnalysisRun(activeRun.runId);
      }
    };
  }, []);

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

  const handleTemplateClick = async (template: AnalysisTemplate) => {
    const requestToken = requestGuard.beginRequest(recordingId);
    const runId = crypto.randomUUID();
    const target = template.id === "actions" ? "actionItems" : "ask";
    activeAnalysisRunRef.current = { runId, target };
    setIsAnalyzing(true);
    setError(null);
    setShowSetupGuide(false);
    setLastQuery(template.query);
    setLastTemplateId(template.id);
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
          if (!requestGuard.isCurrent(requestToken)) {
            return;
          }
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
          if (!requestGuard.isCurrent(requestToken)) {
            return;
          }
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
        setLastResult(null);
      } else {
        const result = await analyzeRecording(
          recordingId,
          template.query,
          undefined,
          runId
        );
        if (!requestGuard.isCurrent(requestToken)) {
          return;
        }
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
      if (!requestGuard.isCurrent(requestToken)) {
        return;
      }
      const message = err instanceof Error ? err.message : "Analysis failed";
      let helpfulError = message;
      
      if (message.includes("ollama") || message.includes("Ollama") || message.includes("connection refused") || message.includes("connect")) {
        helpfulError = "Ollama is not running. Start Ollama locally, or configure a cloud provider in Settings.";
        setShowSetupGuide(true);
      } else if (message.includes("API key") || message.includes("secret") || message.includes("key not configured")) {
        helpfulError = "API key not configured. Add your API key in Settings.";
        setShowSetupGuide(true);
      } else if (message.includes("not found") || message.includes("Transcript")) {
        helpfulError = "Transcript not available. Wait for transcription to complete.";
      }
      
      setError(helpfulError);
    } finally {
      if (requestGuard.isCurrent(requestToken)) {
        setIsAnalyzing(false);
        if (activeAnalysisRunRef.current?.runId === runId) {
          activeAnalysisRunRef.current = null;
        }
      }
    }
  };

  const savedPromptChat = useSavedPromptChat({
    scope: "meeting",
    inputValue: customQuery,
    onPickPrompt: setCustomQuery,
    label: "Saved prompts for this meeting",
  });

  const handleCustomQuery = async () => {
    // A "/" query is the picker's, not a question. Sending it would ask the
    // meeting about the literal text "/dec".
    if (savedPromptChat.pickerOpen) return;
    if (!customQuery.trim()) return;
    const requestToken = requestGuard.beginRequest(recordingId);
    const runId = crypto.randomUUID();
    activeAnalysisRunRef.current = { runId, target: "ask" };

    setIsAnalyzing(true);
    setError(null);
    setShowSetupGuide(false);
    setLastQuery(customQuery);
    setLastTemplateId(null);
    const rawQuery = customQuery.trim();
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
      if (!requestGuard.isCurrent(requestToken)) {
        return;
      }
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
      setCustomQuery("");
    } catch (err) {
      if (!requestGuard.isCurrent(requestToken)) {
        return;
      }
      const message = err instanceof Error ? err.message : "Analysis failed";
      let helpfulError = message;
      
      if (message.includes("ollama") || message.includes("Ollama") || message.includes("connection refused") || message.includes("connect")) {
        helpfulError = "Ollama is not running. Start Ollama locally, or configure a cloud provider in Settings.";
        setShowSetupGuide(true);
      } else if (message.includes("API key") || message.includes("secret") || message.includes("key not configured")) {
        helpfulError = "API key not configured. Add your API key in Settings.";
        setShowSetupGuide(true);
      } else if (message.includes("not found") || message.includes("Transcript")) {
        helpfulError = "Transcript not available. Wait for transcription to complete.";
      }
      
      setError(helpfulError);
    } finally {
      if (requestGuard.isCurrent(requestToken)) {
        setIsAnalyzing(false);
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

  const citationCoverage = (() => {
    if (!lastResult) return null;
    const citations = lastResult.citations ?? [];
    if (citations.length === 0) {
      return { ratio: 0, avgCertainty: 0 };
    }
    const mappedCount = citations.filter(
      (citation) =>
        typeof citation.startTime === "number" &&
        typeof citation.endTime === "number" &&
        typeof citation.recordingId === "string" &&
        citation.recordingId.trim().length > 0
    ).length;
    const certaintyValues = citations
      .map((citation) => citation.certainty)
      .filter((value): value is number => typeof value === "number");
    const avgCertainty =
      certaintyValues.length > 0
        ? certaintyValues.reduce((sum, value) => sum + value, 0) / certaintyValues.length
        : 0;
    return {
      ratio: mappedCount / citations.length,
      avgCertainty,
    };
  })();
  const showUncertaintyBanner =
    citationCoverage !== null &&
    (lastResult?.grounded === false ||
      citationCoverage.ratio < 0.8 ||
      citationCoverage.avgCertainty < 0.75);

  return (
    <div className={cn("space-y-4", className)}>
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
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCustomQuery(e.target.value)}
            onKeyDown={(e) => {
              // The picker takes the arrows, Enter and Escape while it is
              // open; anything it does not claim falls through to Send.
              savedPromptChat.onInputKeyDown(e);
              if (e.defaultPrevented) return;
              if (e.key === "Enter") void handleCustomQuery();
            }}
            disabled={isAnalyzing}
          />
          <Button
            size="icon"
            aria-label="Send"
            onClick={handleCustomQuery}
            disabled={isAnalyzing || !customQuery.trim() || savedPromptChat.pickerOpen}
          >
            {isAnalyzing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
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
                          <p key={`${message.id}-${idx}`} className="text-[11px] text-muted-foreground italic">
                            &ldquo;{citation.text}&rdquo;
                            {typeof citation.startTime === "number" &&
                            typeof citation.endTime === "number" ? (
                              <span className="not-italic ml-1">
                                ({citation.startTime.toFixed(1)}s - {citation.endTime.toFixed(1)}s)
                              </span>
                            ) : null}
                          </p>
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
            <Loader2 className="h-4 w-4 animate-spin" />
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

      {/* Error Display */}
      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-start gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p>{error}</p>
            {showSetupGuide && (
              <div className="mt-3 p-3 bg-muted rounded-lg text-muted-foreground text-xs space-y-2">
                <p className="font-medium text-foreground">Setup Options:</p>
                <ul className="list-disc list-inside space-y-1">
                  <li><strong>Ollama (Free, Local):</strong> Install from ollama.com, then run <code className="bg-muted-foreground/10 px-1 rounded">ollama serve</code></li>
                  <li><strong>OpenAI:</strong> Get an API key from platform.openai.com</li>
                  <li><strong>Anthropic:</strong> Get an API key from console.anthropic.com</li>
                </ul>
                <p className="pt-1">Go to <strong>Settings → AI & Keys</strong> to configure your preferred provider.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Results */}
      {isAnalyzing && !lastResult && !actionItems && (
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <p className="font-serif text-sm text-muted-foreground">{emptyStateLabel}</p>
        </div>
      )}

      {lastResult && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 font-serif text-base font-semibold">
                <Sparkles className="h-4 w-4 text-gold-text" />
                {title}
              </CardTitle>
              <div className="flex items-center gap-2">
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
            <ScrollArea className="h-[200px]">
              <div className="text-sm leading-relaxed whitespace-pre-wrap">
                {lastResult.response}
              </div>
            </ScrollArea>
            
            {showUncertaintyBanner && (
              <div className="mt-4 p-2 rounded-md bg-rust/10 text-rust text-xs">
                {lastResult.grounded === false
                  ? "Not fully grounded: one or more citations were invalid or did not support the answer."
                  : `Uncertainty: citation coverage is below threshold (coverage ${((citationCoverage?.ratio ?? 0) * 100).toFixed(0)}%, confidence ${((citationCoverage?.avgCertainty ?? 0) * 100).toFixed(0)}%).`}
              </div>
            )}

            {lastResult.citations.length > 0 && (
              <div className="mt-4 pt-4 border-t">
                <p className="rubric mb-2">CITATIONS</p>
                <div className="space-y-1">
                  {lastResult.citations.map((citation: { text: string; startTime?: number; endTime?: number; recordingId?: string; certainty?: number }, idx: number) => (
                    <p key={idx} className="text-xs text-muted-foreground italic">
                      &ldquo;{citation.text}&rdquo;
                      {citation.recordingId ? (
                        <span className="not-italic ml-1">[{citation.recordingId}]</span>
                      ) : null}
                      {typeof citation.startTime === "number" && typeof citation.endTime === "number" ? (
                        <span className="not-italic ml-1">
                          ({citation.startTime.toFixed(1)}s - {citation.endTime.toFixed(1)}s)
                        </span>
                      ) : null}
                      {typeof citation.certainty === "number" ? (
                        <span className="not-italic ml-1">
                          certainty {(citation.certainty * 100).toFixed(0)}%
                        </span>
                      ) : null}
                    </p>
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
            <CardTitle className="flex items-center gap-2 font-serif text-base font-semibold">
              <CheckSquare className="h-4 w-4 text-gold-text" />
              Action Items
            </CardTitle>
          </CardHeader>
          <CardContent>
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
                          <p key={citationIndex} className="text-[11px] text-muted-foreground italic">
                            &ldquo;{citation.text}&rdquo;
                            {typeof citation.startTime === "number" &&
                            typeof citation.endTime === "number" ? (
                              <span className="not-italic ml-1">
                                ({citation.startTime.toFixed(1)}s - {citation.endTime.toFixed(1)}s)
                              </span>
                            ) : null}
                          </p>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>

            {actionItemsGrounded === false && (
              <div className="mt-4 rounded-md bg-rust/10 p-2 text-xs text-rust">
                Not fully grounded: one or more follow-ups had invalid or unsupported transcript citations.
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
