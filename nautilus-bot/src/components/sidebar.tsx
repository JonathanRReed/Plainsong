import React, { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Mic,
  AudioWaveform,
  FileText,
  FileOutput,
  Settings,
  Folder,
  PanelLeftClose,
  PanelLeftOpen,
  Shield,
  Star,
  Clock,
  KeyRound,
  Sparkles,
  MoreHorizontal,
  ChevronRight,
} from "lucide-react";
import type { ViewId } from "@/App";
import { getSettings, type LicenseInfo } from "@/lib/backend";
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
  { id: "dashboard", label: "Home", icon: FileText, shortcut: "⌘+H" },
  { id: "dictation", label: "Dictation", icon: Mic, shortcut: "⌘+D" },
  { id: "recordings", label: "Meetings", icon: AudioWaveform, shortcut: "⌘+M" },
];

const secondaryNavItems = [
  { id: "projects", label: "Projects", icon: Folder, shortcut: "⌘+P" },
  { id: "settings", label: "Settings", icon: Settings, shortcut: "⌘+," },
];

const moreNavItems = [
  { id: "setup", label: "Setup", icon: Sparkles },
  { id: "exports", label: "Exports", icon: FileOutput },
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
  onActivateClick?: () => void;
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
            aria-label="Activate license"
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

const MemoizedLicenseBadge = React.memo(LicenseBadge);

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
  const isMoreView = moreNavItems.some((item) => item.id === activeView);
  const [showMoreItems, setShowMoreItems] = useState(isMoreView);

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

  useEffect(() => {
    if (isMoreView) {
      setShowMoreItems(true);
    }
  }, [isMoreView]);

  return (
    <TooltipProvider>
      <div
        className={cn(
          "flex flex-col h-full border-r bg-background transition-all duration-300",
          isCollapsed ? "w-16" : "w-72"
        )}
      >
        <div
          className={cn(
            "flex items-start justify-between gap-3 px-5 pb-5 pt-14",
            !isCollapsed && "pl-12",
            isCollapsed && "items-center px-3 pb-3 pt-10"
          )}
        >
          <div className={cn("min-w-0", isCollapsed && "hidden")}>
            <h1 className="font-semibold text-lg tracking-tight">Nautilus</h1>
            <p className="mt-1 text-[11px] font-medium tracking-[0.14em] text-muted-foreground">
              Voice workspace
            </p>
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

        <ScrollArea className="flex-1 px-3 py-5">
          <nav className="flex flex-col gap-6">
            {/* Primary Navigation */}
            <div className="flex flex-col gap-1">
              {!isCollapsed && (
                <p className="mb-2 px-3 text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
                  Primary
                </p>
              )}
              {primaryNavItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeView === item.id;
                return (
                  <Tooltip key={item.id} delayDuration={0}>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        className={cn(
                          "h-10 w-full justify-start rounded-xl border-l-2 border-transparent px-3.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-all duration-200",
                          isActive && "border-l-primary bg-primary/8 text-foreground font-medium shadow-sm",
                          isCollapsed && "justify-center px-2 border-l-0"
                        )}
                        onClick={() => onViewChange(item.id as ViewId)}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {!isCollapsed && (
                          <>
                            <span className="ml-3 min-w-0 flex-1 text-left">{item.label}</span>
                            <span className="text-[10px] text-muted-foreground/70">{item.shortcut}</span>
                          </>
                        )}
                      </Button>
                    </TooltipTrigger>
                    {isCollapsed && (
                      <TooltipContent side="right">
                        <div className="flex items-center gap-2">
                          <span>{item.label}</span>
                          <span className="text-muted-foreground">{item.shortcut}</span>
                        </div>
                      </TooltipContent>
                    )}
                  </Tooltip>
                );
              })}
            </div>

            {/* Secondary Navigation */}
            <div className="flex flex-col gap-1">
              {!isCollapsed && (
                <p className="mb-2 px-3 text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
                  Secondary
                </p>
              )}
              {secondaryNavItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeView === item.id;
                return (
                  <Tooltip key={item.id} delayDuration={0}>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        className={cn(
                          "h-10 w-full justify-start rounded-xl border-l-2 border-transparent px-3.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-all duration-200",
                          isActive && "border-l-primary bg-primary/8 text-foreground font-medium shadow-sm",
                          isCollapsed && "justify-center px-2 border-l-0"
                        )}
                        onClick={() => onViewChange(item.id as ViewId)}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {!isCollapsed && (
                          <>
                            <span className="ml-3 min-w-0 flex-1 text-left">{item.label}</span>
                            <span className="text-[10px] text-muted-foreground/70">{item.shortcut}</span>
                          </>
                        )}
                      </Button>
                    </TooltipTrigger>
                    {isCollapsed && (
                      <TooltipContent side="right">
                        <div className="flex items-center gap-2">
                          <span>{item.label}</span>
                          <span className="text-muted-foreground">{item.shortcut}</span>
                        </div>
                      </TooltipContent>
                    )}
                  </Tooltip>
                );
              })}
            </div>

            {/* More Menu */}
            {!isCollapsed && (
              <div className="flex flex-col gap-1 pt-2">
                <Button
                  variant="ghost"
                  className="h-10 w-full justify-start rounded-xl px-3.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-all duration-200"
                  onClick={() => setShowMoreItems((value) => !value)}
                  aria-expanded={showMoreItems}
                  aria-controls="sidebar-more-items"
                >
                  <MoreHorizontal className="h-4 w-4 shrink-0" />
                  <span className="ml-3">More</span>
                  <ChevronRight
                    className={cn(
                      "ml-auto h-3 w-3 opacity-50 transition-transform duration-200",
                      showMoreItems && "rotate-90"
                    )}
                  />
                </Button>
                <div
                  id="sidebar-more-items"
                  className={cn("ml-2 flex flex-col gap-1", !showMoreItems && "hidden")}
                >
                  {moreNavItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = activeView === item.id;
                    return (
                      <Button
                        key={item.id}
                        variant="ghost"
                        className={cn(
                          "h-10 w-full justify-start rounded-xl border-l-2 border-transparent px-3.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-all duration-200",
                          isActive && "border-l-primary bg-primary/8 text-foreground font-medium shadow-sm"
                        )}
                        onClick={() => onViewChange(item.id as ViewId)}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="ml-3 min-w-0 flex-1 text-left">{item.label}</span>
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}
          </nav>
        </ScrollArea>

        <Separator />

        <div className="flex flex-col gap-3 p-4">
          {isRecording && (
            <div
              className={cn(
                "flex items-center gap-2 rounded-md border border-border bg-muted/60 px-2 py-1 text-xs transition-all duration-200",
                isCollapsed && "justify-center"
              )}
            >
              <div className="relative h-2 w-2">
                <div className="absolute inset-0 rounded-full bg-red-500 animate-ping opacity-40" />
                <div className="relative h-2 w-2 rounded-full bg-red-500" />
              </div>
              {!isCollapsed && (
                <span className="font-medium text-foreground">
                  {recordingMode === "meeting" ? "Meeting" : "Dictation"} {formattedDuration}
                </span>
              )}
            </div>
          )}

          <MemoizedLicenseBadge
            license={license ?? undefined}
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
                  "flex items-center gap-2 text-xs text-muted-foreground cursor-help",
                  isCollapsed && "justify-center"
                )}
              >
                <div
                  className={cn(
                    "h-2 w-2 rounded-full transition-colors duration-200",
                    localModeStatus.active ? "bg-success" : "bg-warning"
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
