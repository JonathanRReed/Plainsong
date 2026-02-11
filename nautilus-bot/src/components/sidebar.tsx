import { cn } from "@/lib/utils";
import { Mic, AudioWaveform, FileOutput, FileText, Settings, Folder, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/theme-toggle";
import { useRecording } from "@/hooks/use-recording";

interface SidebarProps {
  activeView: string;
  onViewChange: (view: string) => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

const navItems = [
  { id: "dashboard", label: "Dashboard", icon: FileText },
  { id: "projects", label: "Projects", icon: Folder },
  { id: "recordings", label: "Recordings", icon: AudioWaveform },
  { id: "dictation", label: "Dictation", icon: Mic },
  { id: "exports", label: "Exports", icon: FileOutput },
  { id: "settings", label: "Settings", icon: Settings },
];

export function Sidebar({ activeView, onViewChange, isCollapsed = false, onToggleCollapse }: SidebarProps) {
  const { isRecording, formattedDuration, recordingMode } = useRecording();

  return (
    <TooltipProvider>
      <div className={cn(
        "flex flex-col h-full border-r bg-background transition-all duration-300",
        isCollapsed ? "w-16" : "w-64"
      )}>
        <div className="p-4 flex items-center justify-between">
          <div className={cn(isCollapsed && "hidden")}>
            <h1 className="font-semibold text-lg">Nautilus</h1>
            <p className="text-xs text-muted-foreground mt-1">Verifiable Memory Layer</p>
          </div>
          {onToggleCollapse && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={onToggleCollapse}
              aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {isCollapsed ? (
                <PanelLeftOpen className="h-4 w-4" />
              ) : (
                <PanelLeftClose className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>
        
        <Separator />
        
        <ScrollArea className="flex-1 px-2 py-4">
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeView === item.id;
              
              return (
                <Tooltip key={item.id} delayDuration={0}>
                  <TooltipTrigger asChild>
                    <Button
                      variant={isActive ? "secondary" : "ghost"}
                      className={cn(
                        "w-full justify-start",
                        isCollapsed && "justify-center px-2"
                      )}
                      onClick={() => onViewChange(item.id)}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {!isCollapsed && (
                        <span className="ml-3">{item.label}</span>
                      )}
                    </Button>
                  </TooltipTrigger>
                  {isCollapsed && (
                    <TooltipContent side="right">
                      {item.label}
                    </TooltipContent>
                  )}
                </Tooltip>
              );
            })}
          </nav>
        </ScrollArea>
        
        <Separator />
        
        <div className="p-4 space-y-3">
          {isRecording && (
            <div
              className={cn(
                "flex items-center gap-2 rounded-md border border-active/40 bg-active/10 px-2 py-1 text-xs",
                isCollapsed && "justify-center"
              )}
            >
              <div className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
              {!isCollapsed && (
                <span className="font-medium text-active">
                  {recordingMode === "meeting" ? "Meeting" : "Dictation"} {formattedDuration}
                </span>
              )}
            </div>
          )}

          <div className={cn(
            "flex items-center gap-2",
            isCollapsed && "justify-center"
          )}>
            <ThemeToggle />
            {!isCollapsed && <span className="text-xs text-muted-foreground">Theme</span>}
          </div>
          
          <div className={cn(
            "flex items-center gap-2 text-xs text-muted-foreground",
            isCollapsed && "justify-center"
          )}>
            <div className="h-2 w-2 rounded-full bg-green-500" />
            {!isCollapsed && <span>Local Mode</span>}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
