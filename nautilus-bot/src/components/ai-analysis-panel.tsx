import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { analyzeRecording, extractActionItems } from "@/lib/tauri";
import type { LlmAnalysisResult, ActionItem, AnalysisTemplate } from "@/types";
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

export function AiAnalysisPanel({ recordingId, className }: AiAnalysisPanelProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [customQuery, setCustomQuery] = useState("");
  const [lastResult, setLastResult] = useState<LlmAnalysisResult | null>(null);
  const [actionItems, setActionItems] = useState<ActionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSetupGuide, setShowSetupGuide] = useState(false);

  const handleTemplateClick = async (template: AnalysisTemplate) => {
    setIsAnalyzing(true);
    setError(null);
    setShowSetupGuide(false);
    
    try {
      if (template.id === "actions") {
        const items = await extractActionItems(recordingId);
        setActionItems(items);
        setLastResult(null);
      } else {
        const result = await analyzeRecording(recordingId, template.query);
        setLastResult(result);
        setActionItems(null);
      }
    } catch (err) {
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
      setIsAnalyzing(false);
    }
  };

  const handleCustomQuery = async () => {
    if (!customQuery.trim()) return;
    
    setIsAnalyzing(true);
    setError(null);
    setShowSetupGuide(false);
    
    try {
      const result = await analyzeRecording(recordingId, customQuery);
      setLastResult(result);
      setActionItems(null);
      setCustomQuery("");
    } catch (err) {
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
      setIsAnalyzing(false);
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
        {ANALYSIS_TEMPLATES.map((template) => (
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
          placeholder="Ask a custom question about this transcript..."
          value={customQuery}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCustomQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCustomQuery()}
          disabled={isAnalyzing}
        />
        <Button 
          size="icon" 
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
          Analyzing transcript...
        </div>
      )}

      {lastResult && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-trusted" />
                AI Analysis
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
                  </div>
                </div>
              ))}
            </div>
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
