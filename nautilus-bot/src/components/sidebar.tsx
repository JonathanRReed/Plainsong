import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Mic,
  AudioWaveform,
  FileOutput,
  FileText,
  Settings,
  Folder,
  PanelLeftClose,
  PanelLeftOpen,
  Shield,
  Star,
  Clock,
  KeyRound,
  Sparkles,
} from "lucide-react";
import type { ViewId } from "@/App";
import { getSettings, type LicenseInfo } from "@/lib/tauri";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/theme-toggle";
import { useRecording } from "@/hooks/use-recording";

interface SidebarProps {
  activeView: string;
  onViewChange: (view: ViewId) => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  license?: LicenseInfo | null;
  onActivateClick?(): void;
}

const primaryNavItems = [
  { id: "dashboard", label: "Home", icon: FileText },
  { id: "dictation", label: "Dictation", icon: Mic },
  { id: "recordings", label: "Meetings", icon: AudioWaveform },
  { id: "projects", label: "Projects", icon: Folder },
];

const utilityNavItems = [
  { id: "setup", label: "Setup", icon: Sparkles },
  { id: "exports", label: "Exports", icon: FileOutput },
  { id: "settings", label: "Settings", icon: Settings },
];

interface LocalModeStatus {
  active: boolean;
  label: string;
  detail: string;
}

const DEFAULT_LOCAL_MODE_STATUS: LocalModeStatus = {
  active: true,
  label: "Local only",
  detail: "Using local analysis with privacy-first defaults.",
};

function deriveLocalModeStatus(
  llmProvider: string,
  remoteProcessingEnabled: boolean
): LocalModeStatus {
  if (!remoteProcessingEnabled) {
    return {
      active: true,
      label: "Local only",
      detail: "Remote processing is disabled by policy.",
    };
  }

  if (llmProvider === "ollama") {
    return {
      active: true,
      label: "Local only",
      detail: "Default analysis provider is local (Ollama).",
    };
  }

  return {
    active: false,
    label: "Cloud Enabled",
    detail: `Remote processing enabled with '${llmProvider}' as default analysis provider.`,
  };
}

function LicenseBadge({
  license,
  isCollapsed,
  onActivateClick,
}: {
  license: LicenseInfo | null | undefined;
  isCollapsed: boolean;
  onActivateClick?(): void;
}) {
  if (!license) return null;

  if (license.valid) {
    const isFriends = license.tier === "friends_club";
    const label = isFriends ? "Friends Club" : "Pro";
    const icon = isFriends ? (
      <Star className="h-3.5 w-3.5 shrink-0 text-amber-500" />
    ) : (
      <Shield className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
    );

    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "flex items-center gap-1.5 text-xs cursor-default select-none",
              isFriends ? "text-amber-600 dark:text-amber-400" : "text-emerald-600",
              isCollapsed && "justify-center"
            )}
          >
            {icon}
            {!isCollapsed && <span>{label}</span>}
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" align="center">
          {label} · {license.activationsUsage}/{license.activationsLimit} devices
        </TooltipContent>
      </Tooltip>
    );
  }

  // Trial / unlicensed
  if (license.trialDaysRemaining > 0) {
    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "flex items-center gap-1.5 text-xs text-muted-foreground cursor-default select-none",
              isCollapsed && "justify-center"
            )}
          >
            <Clock className="h-3.5 w-3.5 shrink-0" />
            {!isCollapsed && <span>Trial · {license.trialDaysRemaining}d left</span>}
          </div>
        </TooltipTrigger>
        <TooltipContent side="right">
          {license.trialDaysRemaining} trial days remaining
        </TooltipContent>
      </Tooltip>
    );
  }

  // Trial expired — show activate shortcut
  if (onActivateClick) {
    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onActivateClick}
            className={cn(
              "flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 hover:underline cursor-pointer",
              isCollapsed && "justify-center"
            )}
          >
            <KeyRound className="h-3.5 w-3.5 shrink-0" />
            {!isCollapsed && <span>Activate</span>}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Enter your license key</TooltipContent>
      </Tooltip>
    );
  }

  return null;
}

export function Sidebar({
  activeView,
  onViewChange,
  isCollapsed = false,
  onToggleCollapse,
  license,
  onActivateClick,
}: SidebarProps) {
  const { isRecording, formattedDuration, recordingMode } = useRecording();
  const [localModeStatus, setLocalModeStatus] = useState<LocalModeStatus>(DEFAULT_LOCAL_MODE_STATUS);

  useEffect(() => {
    let mounted = true;

    const refreshLocalMode = async () => {
      try {
        const settings = await getSettings();
        if (!mounted) {
          return;
        }
        setLocalModeStatus(
          deriveLocalModeStatus(
            settings.privacy.llmProvider,
            settings.privacy.remoteProcessingEnabled
          )
        );
      } catch {
        if (mounted) {
          setLocalModeStatus(DEFAULT_LOCAL_MODE_STATUS);
        }
      }
    };

    void refreshLocalMode();
    const intervalId = setInterval(() => {
      void refreshLocalMode();
    }, 5000);

    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, []);

  return (
    <TooltipProvider>
      <div
        className={cn(
          "flex flex-col h-full border-r bg-background transition-all duration-300",
          isCollapsed ? "w-16" : "w-64"
        )}
      >
        <div className="p-4 flex items-center justify-between">
          <div className={cn(isCollapsed && "hidden")}>
            <h1 className="font-semibold text-lg">Nautilus</h1>
            <p className="mt-1 text-xs text-muted-foreground">Dictation first. Meetings included.</p>
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
          <nav className="space-y-4">
            <div className="space-y-1">
              {primaryNavItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeView === item.id;
                return (
                  <Tooltip key={item.id} delayDuration={0}>
                    <TooltipTrigger asChild>
                      <Button
                        variant={isActive ? "secondary" : "ghost"}
                        className={cn(
                          "w-full justify-start border border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                          isActive && "border-border bg-muted text-foreground shadow-none",
                          isCollapsed && "justify-center px-2"
                        )}
                        onClick={() => onViewChange(item.id as ViewId)}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {!isCollapsed && <span className="ml-3">{item.label}</span>}
                      </Button>
                    </TooltipTrigger>
                    {isCollapsed && (
                      <TooltipContent side="right">{item.label}</TooltipContent>
                    )}
                  </Tooltip>
                );
              })}
            </div>
            <div className="space-y-1">
              {!isCollapsed && (
                <p className="px-3 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                  Utilities
                </p>
              )}
              {utilityNavItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeView === item.id;
                return (
                  <Tooltip key={item.id} delayDuration={0}>
                    <TooltipTrigger asChild>
                      <Button
                        variant={isActive ? "secondary" : "ghost"}
                        className={cn(
                          "w-full justify-start border border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                          isActive && "border-border bg-muted text-foreground shadow-none",
                          isCollapsed && "justify-center px-2"
                        )}
                        onClick={() => onViewChange(item.id as ViewId)}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {!isCollapsed && <span className="ml-3">{item.label}</span>}
                      </Button>
                    </TooltipTrigger>
                    {isCollapsed && (
                      <TooltipContent side="right">{item.label}</TooltipContent>
                    )}
                  </Tooltip>
                );
              })}
            </div>
          </nav>
        </ScrollArea>

        <Separator />

        <div className="p-4 space-y-3">
          {isRecording && (
            <div
              className={cn(
                "flex items-center gap-2 rounded-md border border-border bg-muted/60 px-2 py-1 text-xs",
                isCollapsed && "justify-center"
              )}
            >
              <div className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
              {!isCollapsed && (
                <span className="font-medium text-foreground">
                  {recordingMode === "meeting" ? "Meeting" : "Dictation"} {formattedDuration}
                </span>
              )}
            </div>
          )}

          <LicenseBadge
            license={license}
            isCollapsed={isCollapsed}
            onActivateClick={onActivateClick}
          />

          <div className={cn("flex items-center gap-2", isCollapsed && "justify-center")}>
            <ThemeToggle />
            {!isCollapsed && <span className="text-xs text-muted-foreground">Theme</span>}
          </div>

          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "flex items-center gap-2 text-xs text-muted-foreground",
                  isCollapsed && "justify-center"
                )}
              >
                <div
                  className={cn(
                    "h-2 w-2 rounded-full",
                    localModeStatus.active ? "bg-green-500" : "bg-amber-500"
                  )}
                />
                {!isCollapsed && <span>{localModeStatus.label}</span>}
              </div>
            </TooltipTrigger>
            <TooltipContent side="right">{localModeStatus.detail}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}
