import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Mic, AudioWaveform, FileText, Search, ChevronUp, ChevronDown } from "lucide-react";
import { startDictation } from "@/lib/backend";
import { requestMainView } from "@/lib/navigation";

interface QuickAction {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  shortcut: string;
  onClick: () => void;
}

interface QuickActionsBarProps {
  actions?: QuickAction[];
  className?: string;
}

const DEFAULT_ACTIONS: QuickAction[] = [
  {
    id: "dictation",
    label: "Start Dictation",
    icon: Mic,
    shortcut: "⌘+D",
    onClick: () => {
      void startDictation();
    },
  },
  {
    id: "meeting",
    label: "Start Meeting",
    icon: AudioWaveform,
    shortcut: "⌘+M",
    onClick: () => {
      // Navigate to projects view to select/create project first
      void requestMainView("projects");
    },
  },
  {
    id: "note",
    label: "New Note",
    icon: FileText,
    shortcut: "⌘+N",
    onClick: () => {
      // Navigate to recordings view for new note creation
      void requestMainView("recordings");
    },
  },
  {
    id: "search",
    label: "Search",
    icon: Search,
    shortcut: "⌘+K",
    onClick: () => {
      // Navigate to recordings view where search is available
      void requestMainView("recordings");
    },
  },
];

export function QuickActionsBar({ actions = DEFAULT_ACTIONS, className }: QuickActionsBarProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);

  return (
    <TooltipProvider>
      <div
        className={cn(
          "fixed bottom-6 left-1/2 -translate-x-1/2 z-50 transition-all duration-300",
          isCollapsed && "bottom-4",
          className
        )}
      >
        <div
          className={cn(
            "glass rounded-2xl shadow-lg border transition-all duration-300",
            isExpanded ? "p-2" : "p-3"
          )}
        >
          <div className="flex items-center gap-2">
            {actions.map((action) => {
              const Icon = action.icon;
              return (
                <Tooltip key={action.id} delayDuration={0}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size={isExpanded ? "default" : "icon"}
                      className={cn(
                        "transition-all duration-200 btn-click",
                        isExpanded
                          ? "h-10 px-4 justify-start gap-3"
                          : "h-11 w-11 rounded-xl hover-lift"
                      )}
                      onClick={action.onClick}
                    >
                      <Icon className="h-5 w-5 shrink-0" />
                      {isExpanded && (
                        <>
                          <span className="font-medium">{action.label}</span>
                          <span className="ml-auto text-xs text-muted-foreground/70">
                            {action.shortcut}
                          </span>
                        </>
                      )}
                    </Button>
                  </TooltipTrigger>
                  {!isExpanded && (
                    <TooltipContent side="top">
                      <div className="flex items-center gap-2">
                        <span>{action.label}</span>
                        <span className="text-muted-foreground text-xs">{action.shortcut}</span>
                      </div>
                    </TooltipContent>
                  )}
                </Tooltip>
              );
            })}

            <Separator orientation="vertical" className="h-8 mx-1" />

            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11 rounded-xl transition-all duration-200 btn-click"
                  onClick={() => setIsExpanded(!isExpanded)}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-5 w-5" />
                  ) : (
                    <ChevronUp className="h-5 w-5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {isExpanded ? "Collapse" : "Expand"}
              </TooltipContent>
            </Tooltip>

            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11 rounded-xl transition-all duration-200 btn-click"
                  onClick={() => setIsCollapsed(!isCollapsed)}
                >
                  <div className="flex flex-col items-center gap-0.5">
                    <div className="w-1 h-1 rounded-full bg-foreground/60" />
                    <div className="w-1 h-1 rounded-full bg-foreground/60" />
                    <div className="w-1 h-1 rounded-full bg-foreground/60" />
                  </div>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {isCollapsed ? "Show" : "Hide"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
