import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useScopedRequestGuard } from "@/hooks/use-scoped-request-guard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  analyzeRecording,
  extractActionItems,
  extractActionItemsGrounded,
  type MeetingChatMessage,
} from "@/lib/tauri";
import type { LlmAnalysisResult, ActionItem, AnalysisTemplate, LlmCitation } from "@/types";
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
    }) => void;
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
  const [error, setError] = useState<string | null>(null);
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [lastQuery, setLastQuery] = useState("");
  const [lastTemplateId, setLastTemplateId] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<MeetingChatMessage[]>(
    chatMessages ?? []
  );
  const requestGuard = useScopedRequestGuard<string | null>();

  useEffect(() => {
    setThreadMessages(chatMessages ?? []);
  }, [chatMessages]);

  useEffect(() => {
    requestGuard.setScope(recordingId);
    setIsAnalyzing(false);
    setCustomQuery("");
    setLastResult(null);
    setActionItems(null);
    setActionItemCitations([]);
    setError(null);
    setShowSetupGuide(false);
    setLastQuery("");
    setLastTemplateId(null);
  }, [recordingId, requestGuard]);

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
      .slice(-6)
      .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`)
      .join("\n\n");

    return [
      "Conversation so far:",
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
          const result = await extractActionItemsGrounded(recordingId);
          if (!requestGuard.isCurrent(requestToken)) {
            return;
          }
          setActionItems(result.items);
          setActionItemCitations(result.items.map((item) => item.citations ?? []));
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
          const items = await extractActionItems(recordingId);
          if (!requestGuard.isCurrent(requestToken)) {
            return;
          }
          setActionItems(items);
          setActionItemCitations([]);
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
        const result = await analyzeRecording(recordingId, template.query);
        if (!requestGuard.isCurrent(requestToken)) {
          return;
        }
        setLastResult(result);
        setActionItems(null);
        setActionItemCitations([]);
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
      }
    }
  };

  const handleCustomQuery = async () => {
    if (!customQuery.trim()) return;
    const requestToken = requestGuard.beginRequest(recordingId);

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
      const result = await analyzeRecording(recordingId, buildThreadedCustomQuery(rawQuery));
      if (!requestGuard.isCurrent(requestToken)) {
        return;
      }
      setLastResult(result);
      setActionItems(null);
      setActionItemCitations([]);
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
    (citationCoverage.ratio < 0.8 || citationCoverage.avgCertainty < 0.75);

  return (
    <div className={cn("space-y-4", className)}>
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
      <div className="flex gap-2">
        <Input
          placeholder={inputPlaceholder}
          value={customQuery}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCustomQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCustomQuery()}
          disabled={isAnalyzing}
        />
        <Button 
          size="icon" 
          aria-label="Send"
          onClick={handleCustomQuery}
          disabled={isAnalyzing || !customQuery.trim()}
        >
          {isAnalyzing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>

      {threadMessages.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Conversation</CardTitle>
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
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {message.role === "assistant" ? "Assistant" : "You"}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {new Date(message.createdAt).toLocaleTimeString()}
                      </p>
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
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="h-5 w-5 mr-2 animate-spin" />
          {emptyStateLabel}
        </div>
      )}

      {lastResult && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-trusted" />
                {title}
              </CardTitle>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs">
                  {lastResult.model}
                </Badge>
                <span className="text-xs text-muted-foreground">
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
              <div className="mt-4 p-2 rounded-md bg-amber-500/10 text-amber-700 text-xs">
                Uncertainty: citation coverage is below threshold (coverage {(((citationCoverage?.ratio ?? 0) * 100)).toFixed(0)}%, confidence {((citationCoverage?.avgCertainty ?? 0) * 100).toFixed(0)}%).
              </div>
            )}

            {lastResult.citations.length > 0 && (
              <div className="mt-4 pt-4 border-t">
                <p className="text-xs text-muted-foreground mb-2">Citations:</p>
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
                {responseActions.map((action) => (
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
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <CheckSquare className="h-4 w-4 text-trusted" />
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
                      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                        {item.assignee && (
                          <span>Assigned: {item.assignee}</span>
                        )}
                        {item.deadline && (
                          <span>Due: {item.deadline}</span>
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
        <div className="text-center py-8 text-muted-foreground">
          <CheckSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No action items found in this transcript</p>
        </div>
      )}
    </div>
  );
}
