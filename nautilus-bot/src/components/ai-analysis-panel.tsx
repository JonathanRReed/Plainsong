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

  const handleTemplateClick = async (template: AnalysisTemplate) => {
    setIsAnalyzing(true);
    setError(null);
    
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
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleCustomQuery = async () => {
    if (!customQuery.trim()) return;
    
    setIsAnalyzing(true);
    setError(null);
    
    try {
      const result = await analyzeRecording(recordingId, customQuery);
      setLastResult(result);
      setActionItems(null);
      setCustomQuery("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
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
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error}
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
            
            {lastResult.citations.length === 0 && (
              <div className="mt-4 p-2 rounded-md bg-amber-500/10 text-amber-700 text-xs">
                Uncertainty: model response has no grounded citations for this transcript.
              </div>
            )}

            {lastResult.citations.length > 0 && (
              <div className="mt-4 pt-4 border-t">
                <p className="text-xs text-muted-foreground mb-2">Citations:</p>
                <div className="space-y-1">
                  {lastResult.citations.map((citation: { text: string; startTime?: number; endTime?: number }, idx: number) => (
                    <p key={idx} className="text-xs text-muted-foreground italic">
                      &ldquo;{citation.text}&rdquo;
                      {typeof citation.startTime === "number" && typeof citation.endTime === "number" ? (
                        <span className="not-italic ml-1">
                          ({citation.startTime.toFixed(1)}s - {citation.endTime.toFixed(1)}s)
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
