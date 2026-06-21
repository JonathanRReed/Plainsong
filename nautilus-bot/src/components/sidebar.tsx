import { useEffect, useState } from "react";
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
  Sparkles,
  MoreHorizontal,
  ChevronRight,
  Keyboard,
} from "lucide-react";
import type { ViewId } from "@/App";
import { getSettings } from "@/lib/backend/settings";
import {
  defaultDictationShortcut,
  dictationInstruction,
  formatShortcutForDisplay,
} from "@/lib/shortcuts";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/theme-toggle";
import { useRecording } from "@/hooks/use-recording";

interface SidebarProps {
  activeView: string;
  onViewChange: (view: ViewId) => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
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

type DictationShortcutMode = "hold_to_talk" | "toggle" | "hands_free";

interface DictationHotkey {
  label: string;
  instruction: string;
}

const DEFAULT_DICTATION_HOTKEY: DictationHotkey = (() => {
  const shortcut = defaultDictationShortcut();
  return {
    label: formatShortcutForDisplay(shortcut),
    instruction: dictationInstruction(shortcut, "toggle"),
  };
})();

interface ShortcutHelpItem {
  label: string;
  keys: string[];
}

/** Split a "⌘+H" style label into individual keycaps. */
function shortcutKeys(shortcut: string): string[] {
  return shortcut.split("+").map((part) => part.trim()).filter(Boolean);
}

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

export function Sidebar({
  activeView,
  onViewChange,
  isCollapsed = false,
  onToggleCollapse,
}: SidebarProps) {
  const { isRecording, formattedDuration, recordingMode } = useRecording();
  const [localModeStatus, setLocalModeStatus] = useState<LocalModeStatus>(DEFAULT_LOCAL_MODE_STATUS);
  const [dictationHotkey, setDictationHotkey] = useState<DictationHotkey>(DEFAULT_DICTATION_HOTKEY);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const isMoreView = moreNavItems.some((item) => item.id === activeView);
  const [showMoreItems, setShowMoreItems] = useState(isMoreView);

  const navShortcuts: ShortcutHelpItem[] = [...primaryNavItems, ...secondaryNavItems].map(
    (item) => ({ label: item.label, keys: shortcutKeys(item.shortcut) })
  );
  const shortcutGroups: ShortcutHelpItem[] = [
    { label: "Start dictation", keys: shortcutKeys(dictationHotkey.label.replace(/ \+ /g, "+")) },
    ...navShortcuts,
  ];

  useEffect(() => {
    let mounted = true;
    let intervalId: ReturnType<typeof setInterval> | undefined;

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
        const shortcut =
          settings.shortcuts?.toggleDictation || defaultDictationShortcut();
        const transcription = settings.transcription;
        const mode: DictationShortcutMode = transcription?.dictationHandsFreeEnabled
          ? "hands_free"
          : transcription?.dictationPushToTalk
            ? "hold_to_talk"
            : "toggle";
        setDictationHotkey({
          label: formatShortcutForDisplay(shortcut),
          instruction: dictationInstruction(shortcut, mode),
        });
      } catch {
        if (mounted) {
          setLocalModeStatus(DEFAULT_LOCAL_MODE_STATUS);
          setDictationHotkey(DEFAULT_DICTATION_HOTKEY);
        }
      }
    };

    void refreshLocalMode().then(() => {
      if (mounted) {
        intervalId = setInterval(() => {
          void refreshLocalMode();
        }, 5000);
      }
    });

    return () => {
      mounted = false;
      if (intervalId) {
        clearInterval(intervalId);
      }
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
          "flex h-full shrink-0 flex-col overflow-hidden border-r border-border/70 bg-card/80 shadow-[1px_0_0_hsl(var(--foreground)/0.03)_inset] backdrop-blur-xl transition-[width] duration-200",
          isCollapsed ? "w-[72px]" : "w-72"
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
            <p className="font-serif text-lg font-semibold tracking-tight">
              <span className="gilt-text">P</span>lainsong
            </p>
            <p className="mt-1 text-[11px] font-medium text-muted-foreground">
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

        <ScrollArea className={cn("staff-bg flex-1 py-5", isCollapsed ? "px-2" : "px-3")}>
          <nav className="flex flex-col gap-6">
            {/* Primary Navigation */}
              <div className="flex flex-col gap-1.5">
              {!isCollapsed && (
                <p className="rubric mb-2 px-3">
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
                          "h-10 w-full justify-start rounded-xl border border-l-2 border-transparent px-3.5 text-muted-foreground transition-all duration-200 hover:border-border/70 hover:bg-muted/55 hover:text-foreground",
                          isActive &&
                            "border-l-gold bg-muted/50 text-foreground shadow-[0_1px_0_hsl(var(--foreground)/0.04)_inset]",
                          isCollapsed && "justify-center border-l-0 px-2"
                        )}
                        onClick={() => onViewChange(item.id as ViewId)}
                        aria-label={isCollapsed ? item.label : undefined}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {!isCollapsed && (
                          <>
                            <span className="ml-3 min-w-0 flex-1 text-left">{item.label}</span>
                            {isActive ? (
                              <span className="neume neume-lit" aria-hidden="true" />
                            ) : (
                              <span className="text-[10px] text-muted-foreground/70">{item.shortcut}</span>
                            )}
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
              <div className="flex flex-col gap-1.5">
              {!isCollapsed && (
                <p className="rubric mb-2 px-3">
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
                          "h-10 w-full justify-start rounded-xl border border-l-2 border-transparent px-3.5 text-muted-foreground transition-all duration-200 hover:border-border/70 hover:bg-muted/55 hover:text-foreground",
                          isActive &&
                            "border-l-gold bg-muted/50 text-foreground shadow-[0_1px_0_hsl(var(--foreground)/0.04)_inset]",
                          isCollapsed && "justify-center border-l-0 px-2"
                        )}
                        onClick={() => onViewChange(item.id as ViewId)}
                        aria-label={isCollapsed ? item.label : undefined}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {!isCollapsed && (
                          <>
                            <span className="ml-3 min-w-0 flex-1 text-left">{item.label}</span>
                            {isActive ? (
                              <span className="neume neume-lit" aria-hidden="true" />
                            ) : (
                              <span className="text-[10px] text-muted-foreground/70">{item.shortcut}</span>
                            )}
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
                  className="h-10 w-full justify-start rounded-xl border border-transparent px-3.5 text-muted-foreground transition-all duration-200 hover:border-border/70 hover:bg-muted/55 hover:text-foreground"
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
                          "h-10 w-full justify-start rounded-xl border border-l-2 border-transparent px-3.5 text-muted-foreground transition-all duration-200 hover:border-border/70 hover:bg-muted/55 hover:text-foreground",
                          isActive &&
                            "border-l-gold bg-muted/50 text-foreground shadow-[0_1px_0_hsl(var(--foreground)/0.04)_inset]"
                        )}
                        onClick={() => onViewChange(item.id as ViewId)}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="ml-3 min-w-0 flex-1 text-left">{item.label}</span>
                        {isActive && <span className="neume neume-lit" aria-hidden="true" />}
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}
            {isCollapsed && (
              <div className="flex flex-col gap-1.5">
                {moreNavItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeView === item.id;
                  return (
                    <Tooltip key={item.id} delayDuration={0}>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          className={cn(
                            "h-10 w-full justify-center rounded-xl border border-transparent px-2 text-muted-foreground transition-all duration-200 hover:border-border/70 hover:bg-muted/55 hover:text-foreground",
                            isActive &&
                              "border-gold/30 bg-gold/10 text-foreground shadow-[0_1px_0_hsl(var(--foreground)/0.04)_inset]",
                          )}
                          onClick={() => onViewChange(item.id as ViewId)}
                          aria-label={item.label}
                        >
                          <Icon className="h-4 w-4 shrink-0" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="right">{item.label}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            )}
          </nav>
        </ScrollArea>

        <Separator />

        <div className={cn("flex flex-col gap-3", isCollapsed ? "items-center p-2" : "p-4")}>
          {isRecording && (
            <div
              className={cn(
                "flex items-center gap-2 rounded-xl border border-destructive/20 bg-destructive/10 px-2.5 py-2 text-xs transition-all duration-200",
                isCollapsed && "justify-center"
              )}
            >
              <span className="neume neume-rust neume-live" aria-hidden="true" />
              {!isCollapsed && (
                <span className="font-medium text-foreground">
                  {recordingMode === "meeting" ? "Meeting" : "Dictation"}{" "}
                  <span className="time-spec">{formattedDuration}</span>
                </span>
              )}
            </div>
          )}

          <div className={cn("flex h-9 items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-2", isCollapsed && "h-10 w-10 justify-center px-0")}>
            <ThemeToggle />
            {!isCollapsed && <span className="text-xs text-muted-foreground">Theme</span>}
          </div>

          <div className={cn("flex flex-col gap-2", isCollapsed && "items-center gap-2")}>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    "flex h-9 cursor-help items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-2.5 text-xs text-muted-foreground",
                    isCollapsed && "h-10 w-10 justify-center p-0"
                  )}
                >
                  <span className={localModeStatus.active ? "neume neume-lit" : "neume neume-hollow"} aria-hidden="true" />
                  {!isCollapsed && <span>{localModeStatus.label}</span>}
                </div>
              </TooltipTrigger>
              <TooltipContent side="right">{localModeStatus.detail}</TooltipContent>
            </Tooltip>

            <div
              className={cn(
                "flex items-center gap-1.5",
                isCollapsed && "flex-col"
              )}
            >
              {!isCollapsed && (
                <Tooltip delayDuration={0}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => onViewChange("settings")}
                      className="min-w-0 flex-1 truncate rounded-lg px-1.5 py-0.5 text-left font-mono text-[10px] leading-none text-muted-foreground/80 transition-colors hover:text-foreground"
                    >
                      Dictation · {dictationHotkey.label}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">{dictationHotkey.instruction}</TooltipContent>
                </Tooltip>
              )}

              <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
                <Tooltip delayDuration={0}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn("h-7 w-7 shrink-0 text-muted-foreground", isCollapsed && "h-9 w-9")}
                      onClick={() => setShortcutsOpen(true)}
                      aria-label="Keyboard shortcuts"
                    >
                      <Keyboard className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Keyboard shortcuts</TooltipContent>
                </Tooltip>
                <DialogContent className="surface-elevation-2 sm:max-w-sm">
                  <DialogHeader>
                    <DialogTitle className="rubric">Keyboard shortcuts</DialogTitle>
                    <DialogDescription>{dictationHotkey.instruction}</DialogDescription>
                  </DialogHeader>
                  <ul className="settle-stagger flex flex-col gap-2">
                    {shortcutGroups.map((entry) => (
                      <li
                        key={entry.label}
                        className="flex items-center justify-between gap-3 rounded-lg px-1 py-1 text-sm"
                      >
                        <span className="text-muted-foreground">{entry.label}</span>
                        <span className="flex items-center gap-1">
                          {entry.keys.map((key, index) => (
                            <kbd
                              key={`${entry.label}-${index}`}
                              className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] leading-none text-foreground"
                            >
                              {key}
                            </kbd>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
