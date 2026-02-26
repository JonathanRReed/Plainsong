import { useState, useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils";
import { useRecording } from "@/hooks/use-recording";
import { useProjects } from "@/hooks/use-projects";
import { useRecordings } from "@/hooks/use-recordings";
import {
  getSettings,
  saveSettings,
  getTranscript,
  listDictationSnippets,
  createDictationSnippet,
  updateDictationSnippet,
  deleteDictationSnippet,
  listDictationCommandPresets,
  upsertDictationCommandPreset,
  deleteDictationCommandPreset,
  type DictationSnippet,
  type DictationCommandPreset,
} from "@/lib/tauri";
import {
  defaultDictationShortcut,
  dictationInstruction,
  formatShortcutForDisplay,
  matchesShortcut,
} from "@/lib/shortcuts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Keyboard, Mic, Square, Zap, Save, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import type { Recording, Transcript } from "@/types";

interface DictationTextReadyEvent {
  text: string;
  pasted?: boolean;
  copied?: boolean;
  pasteError?: string | null;
  requestedProvider?: string;
  actualProvider?: string;
  isFallback?: boolean;
  fallbackReason?: string | null;
  fallbackMessage?: string | null;
  modelId?: string;
  latencyMs?: number;
  endToEndMs?: number;
  insertionModeUsed?: "auto" | "paste" | "clipboard_only" | "command_only" | "none";
  commandApplied?: string | null;
  snippetAppliedCount?: number;
  appTarget?: string | null;
}

const COMMAND_PRESET_FIELDS: Array<{
  key: "rewrite_shorter" | "rewrite_professional" | "bulletize_selection";
  label: string;
  defaultPrompt: string;
}> = [
  {
    key: "rewrite_shorter",
    label: "Rewrite Shorter",
    defaultPrompt:
      "Rewrite the user's text to be shorter while preserving intent. Keep the same language and tone. Return only the rewritten text.",
  },
  {
    key: "rewrite_professional",
    label: "Rewrite Professional",
    defaultPrompt:
      "Rewrite the user's text in a professional tone while preserving meaning. Keep it clear and concise. Return only the rewritten text.",
  },
  {
    key: "bulletize_selection",
    label: "Bulletize Selection",
    defaultPrompt:
      "Convert the user's text into concise bullet points. Use one bullet per idea. Return only the bullet list.",
  },
];

export function DictationView() {
  const { isRecording, formattedDuration, startDictation, stopDictation } = useRecording();
  const { projects } = useProjects();
  const { recordings, isLoading: dictationHistoryLoading, refetch: refetchDictationHistory } = useRecordings();
  const defaultShortcut = defaultDictationShortcut();
  const [hotkeyLabel, setHotkeyLabel] = useState(formatShortcutForDisplay(defaultShortcut));
  const [hotkeyShortcut, setHotkeyShortcut] = useState(defaultShortcut);
  const [transcribedText, setTranscribedText] = useState("");
  const [lastProvider, setLastProvider] = useState<string | null>(null);
  const [lastModelId, setLastModelId] = useState<string | null>(null);
  const [fallbackStatus, setFallbackStatus] = useState<string | null>(null);
  const [pasteStatus, setPasteStatus] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [endToEndMs, setEndToEndMs] = useState<number | null>(null);
  const [insertionModeUsed, setInsertionModeUsed] = useState<string | null>(null);
  const [commandApplied, setCommandApplied] = useState<string | null>(null);
  const [snippetAppliedCount, setSnippetAppliedCount] = useState(0);
  const [appTarget, setAppTarget] = useState<string | null>(null);
  const [dictationError, setDictationError] = useState<string | null>(null);
  const [saveToInbox, setSaveToInbox] = useState(true);
  const [dictationProfile, setDictationProfile] = useState<"normal_speed" | "power_rewrite">(
    "normal_speed"
  );
  const [defaultProjectId, setDefaultProjectId] = useState("inbox");
  const [dictationPushToTalk, setDictationPushToTalk] = useState(true);
  const [dictationCopyToClipboard, setDictationCopyToClipboard] = useState(true);
  const [dictationCommandModeEnabled, setDictationCommandModeEnabled] = useState(true);
  const [dictationCommandPrefix, setDictationCommandPrefix] = useState("command");
  const [dictationInsertionMode, setDictationInsertionMode] = useState<
    "auto" | "paste" | "clipboard_only"
  >("auto");
  const [dictationSnippetsEnabled, setDictationSnippetsEnabled] = useState(true);
  const [dictationSnippets, setDictationSnippets] = useState<DictationSnippet[]>([]);
  const [dictationCommandPresets, setDictationCommandPresets] = useState<
    DictationCommandPreset[]
  >([]);
  const [newSnippetTrigger, setNewSnippetTrigger] = useState("");
  const [newSnippetExpansion, setNewSnippetExpansion] = useState("");
  const [newSnippetAppScope, setNewSnippetAppScope] = useState("");
  const [newSnippetCaseSensitive, setNewSnippetCaseSensitive] = useState(false);
  const [dictationRetentionPreset, setDictationRetentionPreset] = useState<
    "immediate" | "24h" | "72h" | "never" | "custom"
  >("never");
  const [dictationRetentionCustomHours, setDictationRetentionCustomHours] = useState(24);
  const [hotkeyPressed, setHotkeyPressed] = useState(false);
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(null);
  const [selectedTranscript, setSelectedTranscript] = useState<Transcript | null>(null);
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!isDialogOpen || !selectedRecording) {
      setSelectedTranscript(null);
      return;
    }
    setIsLoadingTranscript(true);
    const fetchTranscript = async () => {
      try {
        const transcript = await getTranscript(selectedRecording.id);
        setSelectedTranscript(transcript);
      } catch (error) {
        console.error("Failed to fetch transcript:", error);
        setSelectedTranscript(null);
      } finally {
        setIsLoadingTranscript(false);
      }
    };
    void fetchTranscript();
  }, [isDialogOpen, selectedRecording]);

  const dictationHistory = useMemo(
    () =>
      recordings
        .filter((recording) => recording.sourceType === "dictation")
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [recordings]
  );
  const pasteNeedsAttention = useMemo(() => {
    if (!pasteStatus) return false;
    const normalized = pasteStatus.toLowerCase();
    if (normalized.includes("pasted")) return false;
    return (
      normalized.includes("clipboard") ||
      normalized.includes("accessibility") ||
      normalized.includes("blocked") ||
      normalized.includes("permission")
    );
  }, [pasteStatus]);

  useEffect(() => {
    let mounted = true;
    void getSettings()
      .then((settings) => {
        if (!mounted) return;
        setSaveToInbox(settings.transcription.dictationSaveToInbox);
        setDictationProfile(settings.transcription.dictationProfile);
        setDefaultProjectId(settings.transcription.dictationProjectId || "inbox");
        setDictationPushToTalk(settings.transcription.dictationPushToTalk);
        setDictationCopyToClipboard(settings.transcription.dictationCopyToClipboard ?? true);
        setDictationCommandModeEnabled(
          settings.transcription.dictationCommandModeEnabled ?? true
        );
        setDictationCommandPrefix(settings.transcription.dictationCommandPrefix ?? "command");
        setDictationInsertionMode(settings.transcription.dictationInsertionMode ?? "auto");
        setDictationSnippetsEnabled(settings.transcription.dictationSnippetsEnabled ?? true);
        setDictationRetentionPreset(settings.transcription.dictationRetentionPreset ?? "never");
        setDictationRetentionCustomHours(settings.transcription.dictationRetentionCustomHours ?? 24);
        const shortcut = settings.shortcuts.toggleDictation || defaultShortcut;
        setHotkeyLabel(formatShortcutForDisplay(shortcut));
        setHotkeyShortcut(shortcut);
      })
      .catch((error) => {
        console.warn("Failed to load dictation preferences:", error);
      });
    return () => {
      mounted = false;
    };
  }, [defaultShortcut]);

  useEffect(() => {
    let mounted = true;
    void listDictationSnippets()
      .then((snippets) => {
        if (mounted) {
          setDictationSnippets(snippets);
        }
      })
      .catch((error) => {
        console.warn("Failed to load dictation snippets:", error);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    void listDictationCommandPresets()
      .then((presets) => {
        if (mounted) {
          setDictationCommandPresets(presets);
        }
      })
      .catch((error) => {
        console.warn("Failed to load dictation command presets:", error);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const persistDictationPreferences = async (
    updates: Partial<{
      saveToInbox: boolean;
      profile: "normal_speed" | "power_rewrite";
      projectId: string;
      pushToTalk: boolean;
      copyToClipboard: boolean;
      commandModeEnabled: boolean;
      commandPrefix: string;
      insertionMode: "auto" | "paste" | "clipboard_only";
      snippetsEnabled: boolean;
      retentionPreset: "immediate" | "24h" | "72h" | "never" | "custom";
      retentionCustomHours: number;
    }>
  ) => {
    try {
      const settings = await getSettings();
      settings.transcription.dictationSaveToInbox = updates.saveToInbox ?? saveToInbox;
      settings.transcription.dictationProfile = updates.profile ?? dictationProfile;
      settings.transcription.dictationProjectId = updates.projectId ?? defaultProjectId;
      settings.transcription.dictationPushToTalk = updates.pushToTalk ?? dictationPushToTalk;
      settings.transcription.dictationCopyToClipboard =
        updates.copyToClipboard ?? dictationCopyToClipboard;
      settings.transcription.dictationCommandModeEnabled =
        updates.commandModeEnabled ?? dictationCommandModeEnabled;
      settings.transcription.dictationCommandPrefix =
        updates.commandPrefix ?? dictationCommandPrefix;
      settings.transcription.dictationInsertionMode =
        updates.insertionMode ?? dictationInsertionMode;
      settings.transcription.dictationSnippetsEnabled =
        updates.snippetsEnabled ?? dictationSnippetsEnabled;
      settings.transcription.dictationRetentionPreset =
        updates.retentionPreset ?? dictationRetentionPreset;
      settings.transcription.dictationRetentionCustomHours =
        updates.retentionCustomHours ?? dictationRetentionCustomHours;
      await saveSettings(settings);
    } catch (error) {
      console.warn("Failed to persist dictation preferences:", error);
    }
  };

  useEffect(() => {
    // Listen for hotkey visual feedback
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesShortcut(e, hotkeyShortcut)) {
        setHotkeyPressed(true);
        
        // Clear any existing timeout
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        
        // Set new timeout
        timeoutRef.current = setTimeout(() => setHotkeyPressed(false), 200);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [hotkeyShortcut]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      unlisten = await listen<DictationTextReadyEvent>("dictation-text-ready", (event) => {
        const payload = event.payload;
        const text = payload?.text ?? "";
        if (text) {
          setTranscribedText(text);
          setDictationError(null);
        }
        if (payload?.actualProvider) {
          setLastProvider(payload.actualProvider);
        }
        const hasProviderFallback =
          payload?.isFallback === true ||
          (!!payload?.requestedProvider &&
            !!payload?.actualProvider &&
            payload.requestedProvider !== payload.actualProvider);
        if (payload?.fallbackMessage) {
          setFallbackStatus(payload.fallbackMessage);
        } else if (hasProviderFallback) {
          const reason =
            payload?.fallbackReason?.trim() ||
            "Requested provider could not complete transcription.";
          setFallbackStatus(
            `ASR fallback: requested '${payload.requestedProvider}' but used '${payload.actualProvider}'. ${reason}`
          );
        } else {
          setFallbackStatus(null);
        }
        if (payload?.modelId) {
          setLastModelId(payload.modelId);
        }
        if (payload?.latencyMs !== undefined) {
          setLatencyMs(payload.latencyMs);
        }
        if (payload?.endToEndMs !== undefined) {
          setEndToEndMs(payload.endToEndMs);
        }
        setInsertionModeUsed(payload?.insertionModeUsed ?? null);
        setCommandApplied(payload?.commandApplied ?? null);
        setSnippetAppliedCount(payload?.snippetAppliedCount ?? 0);
        setAppTarget(payload?.appTarget ?? null);
        if (payload?.pasted) {
          setPasteStatus("Paste command sent (also copied to clipboard)");
        } else if (payload?.copied) {
          setPasteStatus(payload?.pasteError ?? "Copied to clipboard");
        } else if (payload?.pasteError) {
          setPasteStatus(payload.pasteError);
        } else {
          setPasteStatus(null);
        }
      });
    };
    void setup();
    return () => {
      unlisten?.();
    };
  }, []);

  const handleStopDictation = async () => {
    try {
      const text = await stopDictation();
        if (text?.trim()) {
          setTranscribedText(text);
          setDictationError(null);
          void refetchDictationHistory();
        } else {
          setDictationError(null);
        }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDictationError(message);
    }
  };

  const formatRecordingDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handleAddSnippet = async () => {
    const trigger = newSnippetTrigger.trim();
    const expansion = newSnippetExpansion.trim();
    if (!trigger || !expansion) {
      return;
    }
    try {
      const created = await createDictationSnippet({
        trigger,
        expansion,
        appScope: newSnippetAppScope.trim() || null,
        caseSensitive: newSnippetCaseSensitive,
        enabled: true,
      });
      setDictationSnippets((prev) => [...prev, created]);
      setNewSnippetTrigger("");
      setNewSnippetExpansion("");
      setNewSnippetAppScope("");
      setNewSnippetCaseSensitive(false);
    } catch (error) {
      console.warn("Failed to create dictation snippet:", error);
    }
  };

  const handleDeleteSnippet = async (snippetId: string) => {
    try {
      await deleteDictationSnippet(snippetId);
      setDictationSnippets((prev) => prev.filter((snippet) => snippet.id !== snippetId));
    } catch (error) {
      console.warn("Failed to delete dictation snippet:", error);
    }
  };

  const upsertCommandPreset = async (
    commandKey: "rewrite_shorter" | "rewrite_professional" | "bulletize_selection",
    systemPrompt: string,
    enabled: boolean
  ) => {
    try {
      const updated = await upsertDictationCommandPreset({
        commandKey,
        systemPrompt,
        enabled,
      });
      setDictationCommandPresets((prev) => {
        const exists = prev.some((preset) => preset.commandKey === commandKey);
        if (exists) {
          return prev.map((preset) => (preset.commandKey === commandKey ? updated : preset));
        }
        return [...prev, updated];
      });
    } catch (error) {
      console.warn("Failed to upsert command preset:", error);
    }
  };

  const resetCommandPreset = async (
    commandKey: "rewrite_shorter" | "rewrite_professional" | "bulletize_selection"
  ) => {
    try {
      await deleteDictationCommandPreset(commandKey);
      setDictationCommandPresets((prev) =>
        prev.filter((preset) => preset.commandKey !== commandKey)
      );
    } catch (error) {
      console.warn("Failed to reset command preset:", error);
    }
  };

  const getCommandPreset = (
    key: "rewrite_shorter" | "rewrite_professional" | "bulletize_selection"
  ) => dictationCommandPresets.find((preset) => preset.commandKey === key);

  const setCommandPresetDraft = (
    commandKey: "rewrite_shorter" | "rewrite_professional" | "bulletize_selection",
    updates: Partial<Pick<DictationCommandPreset, "systemPrompt" | "enabled">>
  ) => {
    setDictationCommandPresets((prev) => {
      const existing = prev.find((preset) => preset.commandKey === commandKey);
      if (existing) {
        return prev.map((preset) =>
          preset.commandKey === commandKey ? { ...preset, ...updates } : preset
        );
      }

      return [
        ...prev,
        {
          id: `draft-${commandKey}`,
          commandKey,
          systemPrompt: updates.systemPrompt ?? "",
          enabled: updates.enabled ?? true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];
    });
  };

  const patchSnippet = async (
    snippetId: string,
    updates: Partial<{
      trigger: string;
      expansion: string;
      appScope: string | null;
      caseSensitive: boolean;
      enabled: boolean;
    }>
  ) => {
    setDictationSnippets((prev) =>
      prev.map((snippet) => (snippet.id === snippetId ? { ...snippet, ...updates } : snippet))
    );
    try {
      const updated = await updateDictationSnippet(snippetId, updates);
      setDictationSnippets((prev) =>
        prev.map((snippet) => (snippet.id === snippetId ? updated : snippet))
      );
    } catch (error) {
      console.warn("Failed to update dictation snippet:", error);
      void listDictationSnippets()
        .then(setDictationSnippets)
        .catch(() => {
          // Keep optimistic state if reload fails.
        });
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="p-6 border-b">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Dictation</h1>
            <p className="text-muted-foreground">Global hotkey capture</p>
          </div>
          <div className="flex items-center gap-4">
            <div 
              className={cn(
                "flex items-center gap-2 text-sm px-4 py-2 rounded-lg border transition-all",
                hotkeyPressed ? "bg-active text-active-foreground border-active scale-105" : "bg-muted"
              )}
            >
              <Keyboard className="h-4 w-4" />
              <span className="font-mono font-medium">{hotkeyLabel}</span>
              <span className="text-muted-foreground ml-2">
                {dictationPushToTalk ? "hold to talk" : "toggle"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="saveToInbox"
                checked={saveToInbox}
                onChange={(e) => {
                  const next = e.target.checked;
                  setSaveToInbox(next);
                  void persistDictationPreferences({ saveToInbox: next });
                }}
                className="h-4 w-4"
              />
              <label htmlFor="saveToInbox" className="text-sm text-muted-foreground">
                Save to Inbox
              </label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="copyToClipboard"
                checked={dictationCopyToClipboard}
                onChange={(e) => {
                  const next = e.target.checked;
                  setDictationCopyToClipboard(next);
                  void persistDictationPreferences({ copyToClipboard: next });
                }}
                className="h-4 w-4"
              />
              <label htmlFor="copyToClipboard" className="text-sm text-muted-foreground">
                Copy result to clipboard
              </label>
            </div>
          </div>
        </div>
      </div>
      
      <ScrollArea className="flex-1">
        <div className="p-6 max-w-4xl mx-auto space-y-6">
          {dictationError && (
            <Card className="border-destructive/30 bg-destructive/10">
              <CardContent className="p-4">
                <p className="text-sm text-destructive">{dictationError}</p>
              </CardContent>
            </Card>
          )}

          {/* Quick Capture Card */}
          <Card className={cn(
            "border-2 transition-all duration-300",
            isRecording ? "border-active" : "border-muted"
          )}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5" />
                Quick Capture
              </CardTitle>
              <CardDescription>
                {dictationInstruction(hotkeyShortcut, dictationPushToTalk ? "hold_to_talk" : "toggle")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col items-center gap-6 py-8">
                {isRecording ? (
                  <div className="flex flex-col items-center gap-4">
                    <div className="h-24 w-24 rounded-full bg-active flex items-center justify-center animate-pulse shadow-lg shadow-active/50">
                      <Mic className="h-12 w-12 text-active-foreground" />
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-medium">Dictating...</p>
                      <p className="text-3xl font-mono mt-2 font-bold text-active">{formattedDuration}</p>
                    </div>
                    <Button variant="destructive" size="lg" onClick={handleStopDictation} className="mt-4">
                      <Square className="h-4 w-4 mr-2 fill-current" />
                      Stop Dictation
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-4">
                    <div className={cn(
                      "h-24 w-24 rounded-full flex items-center justify-center transition-all",
                      hotkeyPressed ? "bg-active scale-110" : "bg-muted"
                    )}>
                      <Mic className={cn(
                        "h-12 w-12 transition-all",
                        hotkeyPressed ? "text-active-foreground" : "text-muted-foreground"
                      )} />
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-medium">Ready to capture</p>
                      <p className="text-muted-foreground mt-1">
                        {dictationPushToTalk
                          ? `Hold ${hotkeyLabel} to record and release to transcribe`
                          : `Press ${hotkeyLabel} to start, press again to transcribe`}
                      </p>
                    </div>
                    <Button 
                      variant="active" 
                      size="lg" 
                      onClick={() =>
                        void startDictation({
                          saveToInbox,
                          projectId: defaultProjectId,
                          profile: dictationProfile,
                        })
                      }
                      className="mt-4"
                    >
                      <Mic className="h-4 w-4 mr-2" />
                      Start Dictation
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
          
          {/* Instructions */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Keyboard className="h-4 w-4" />
                  Global Hotkey
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Works from anywhere on your computer. No need to switch to the Nautilus window.
                </p>
              </CardContent>
            </Card>
            
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Zap className="h-4 w-4" />
                  Instant Transcription
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Text appears at your cursor within seconds after transcription finishes.
                </p>
              </CardContent>
            </Card>
            
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Save className="h-4 w-4" />
                  Automatic Save
                </CardTitle>
              </CardHeader>
              <CardContent>
                  <p className="text-sm text-muted-foreground">
                    All dictations are saved to your Inbox for future reference and search.
                  </p>
              </CardContent>
            </Card>
          </div>
          
          {/* Last Transcription */}
          {transcribedText && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Last Transcription</CardTitle>
                  <CardDescription>
                    {pasteStatus ?? "Latest dictation result"}
                  </CardDescription>
                </div>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => navigator.clipboard.writeText(transcribedText)}
                >
                  <Save className="h-4 w-4 mr-2" />
                  Copy Again
                </Button>
              </CardHeader>
              <CardContent>
                <div className="p-4 bg-muted rounded-lg">
                  <p className="whitespace-pre-wrap">{transcribedText}</p>
                </div>
                {fallbackStatus && (
                  <div className="mt-3 rounded-md border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    {fallbackStatus}
                  </div>
                )}
                {pasteNeedsAttention && (
                  <div className="mt-3 rounded-md border border-orange-400/50 bg-orange-500/10 px-3 py-2 text-xs text-orange-700 dark:text-orange-300">
                    {pasteStatus}
                  </div>
                )}
                {(lastProvider ||
                  lastModelId ||
                  latencyMs !== null ||
                  endToEndMs !== null ||
                  insertionModeUsed ||
                  commandApplied ||
                  snippetAppliedCount > 0 ||
                  appTarget) && (
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    {latencyMs !== null && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-active/10 text-active font-medium">
                        <Zap className="h-3 w-3" />
                        {latencyMs < 1000
                          ? `${latencyMs}ms`
                          : `${(latencyMs / 1000).toFixed(1)}s`}
                      </span>
                    )}
                    {endToEndMs !== null && <span>End-to-end: {endToEndMs}ms</span>}
                    {lastProvider && <span>Provider: {lastProvider}</span>}
                    {lastModelId && <span>Model: {lastModelId}</span>}
                    {insertionModeUsed && <span>Insert mode: {insertionModeUsed}</span>}
                    {commandApplied && <span>Command: {commandApplied}</span>}
                    {snippetAppliedCount > 0 && <span>Snippets: {snippetAppliedCount}</span>}
                    {appTarget && <span>App: {appTarget}</span>}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Dictation History */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Saved Dictations</CardTitle>
                <CardDescription>
                  Dictation recordings retained by your current auto-delete policy.
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => void refetchDictationHistory()}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
            </CardHeader>
            <CardContent>
              {dictationHistoryLoading ? (
                <p className="text-sm text-muted-foreground">Loading dictation history...</p>
              ) : dictationHistory.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No saved dictations yet. If auto-delete is set to Immediate, history is intentionally not retained.
                </p>
              ) : (
                <div className="space-y-2">
                  {dictationHistory.slice(0, 25).map((recording) => (
                    <div
                      key={recording.id}
                      className="flex items-center justify-between rounded-md border p-3 cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => {
                        setSelectedRecording(recording);
                        setIsDialogOpen(true);
                      }}
                    >
                      <div>
                        <p className="font-medium">{recording.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(recording.createdAt).toLocaleString()} · {recording.status}
                        </p>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {formatRecordingDuration(recording.duration)}
                      </p>
                     </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          
          {/* Settings */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Dictation Settings</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Dictation profile</label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationProfile}
                    onChange={(event) => {
                      const profile = event.target.value as "normal_speed" | "power_rewrite";
                      setDictationProfile(profile);
                      void persistDictationPreferences({ profile });
                    }}
                  >
                    <option value="normal_speed">Normal Speed</option>
                    <option value="power_rewrite">Power Rewrite</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    ASR model selection follows your global default local ASR model in Settings.
                  </p>
                </div>
                
                <div className="space-y-2">
                  <label className="text-sm font-medium">Default Project</label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={defaultProjectId}
                    onChange={(event) => {
                      const nextProjectId = event.target.value;
                      setDefaultProjectId(nextProjectId);
                      void persistDictationPreferences({ projectId: nextProjectId });
                    }}
                  >
                    <option value="inbox">Inbox</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Hotkey behavior</label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationPushToTalk ? "hold_to_talk" : "toggle"}
                    onChange={(event) => {
                      const pushToTalk = event.target.value === "hold_to_talk";
                      setDictationPushToTalk(pushToTalk);
                      void persistDictationPreferences({ pushToTalk });
                    }}
                  >
                    <option value="hold_to_talk">Hold-to-talk</option>
                    <option value="toggle">Toggle press</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Hold-to-talk starts on key press and transcribes on release.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Auto-delete dictation recordings</label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationRetentionPreset}
                    onChange={(event) => {
                      const preset = event.target.value as "immediate" | "24h" | "72h" | "never" | "custom";
                      setDictationRetentionPreset(preset);
                      void persistDictationPreferences({ retentionPreset: preset });
                    }}
                  >
                    <option value="immediate">Immediately</option>
                    <option value="24h">After 24 hours</option>
                    <option value="72h">After 72 hours</option>
                    <option value="never">Never</option>
                    <option value="custom">Custom</option>
                  </select>
                  {dictationRetentionPreset === "custom" && (
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">Custom hours</label>
                      <input
                        type="number"
                        min={1}
                        className="w-full p-2 border rounded-md bg-background"
                        value={dictationRetentionCustomHours}
                        onChange={(event) => {
                          const nextHours = Math.max(1, Number(event.target.value) || 1);
                          setDictationRetentionCustomHours(nextHours);
                          void persistDictationPreferences({ retentionCustomHours: nextHours });
                        }}
                      />
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Insertion mode</label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationInsertionMode}
                    onChange={(event) => {
                      const mode = event.target.value as "auto" | "paste" | "clipboard_only";
                      setDictationInsertionMode(mode);
                      void persistDictationPreferences({ insertionMode: mode });
                    }}
                  >
                    <option value="auto">Auto (best effort)</option>
                    <option value="paste">Paste at cursor</option>
                    <option value="clipboard_only">Clipboard only</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Command mode prefix</label>
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationCommandPrefix}
                    onChange={(event) => setDictationCommandPrefix(event.target.value)}
                    onBlur={() => {
                      const nextPrefix = dictationCommandPrefix.trim() || "command";
                      setDictationCommandPrefix(nextPrefix);
                      void persistDictationPreferences({ commandPrefix: nextPrefix });
                    }}
                  />
                  <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={dictationCommandModeEnabled}
                      onChange={(event) => {
                        const next = event.target.checked;
                        setDictationCommandModeEnabled(next);
                        void persistDictationPreferences({ commandModeEnabled: next });
                      }}
                    />
                    Enable command mode
                  </label>
                </div>
              </div>

              <div className="mt-5 border-t pt-4 space-y-3">
                <div>
                  <p className="text-sm font-medium">Command Presets</p>
                  <p className="text-xs text-muted-foreground">
                    Customize prompts used for command rewrite and bulletize actions.
                  </p>
                </div>
                <div className="space-y-3">
                  {COMMAND_PRESET_FIELDS.map((field) => {
                    const preset = getCommandPreset(field.key);
                    const promptValue = preset?.systemPrompt ?? field.defaultPrompt;
                    const enabledValue = preset?.enabled ?? true;
                    return (
                      <div key={field.key} className="rounded-md border p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <label className="text-sm font-medium">{field.label}</label>
                          <div className="flex items-center gap-2">
                            <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                checked={enabledValue}
                                onChange={(event) => {
                                  const next = event.target.checked;
                                  setCommandPresetDraft(field.key, { enabled: next });
                                  void upsertCommandPreset(field.key, promptValue, next);
                                }}
                              />
                              Enabled
                            </label>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void resetCommandPreset(field.key)}
                            >
                              Reset
                            </Button>
                          </div>
                        </div>
                        <textarea
                          className="w-full min-h-[84px] p-2 border rounded-md bg-background text-sm"
                          value={promptValue}
                          onChange={(event) =>
                            setCommandPresetDraft(field.key, {
                              systemPrompt: event.target.value,
                            })
                          }
                          onBlur={(event) => {
                            const nextPrompt = event.target.value.trim() || field.defaultPrompt;
                            setCommandPresetDraft(field.key, {
                              systemPrompt: nextPrompt,
                            });
                            void upsertCommandPreset(field.key, nextPrompt, enabledValue);
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="mt-5 border-t pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Snippets</p>
                    <p className="text-xs text-muted-foreground">
                      Expand trigger phrases after transcription and before insertion.
                    </p>
                  </div>
                  <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={dictationSnippetsEnabled}
                      onChange={(event) => {
                        const next = event.target.checked;
                        setDictationSnippetsEnabled(next);
                        void persistDictationPreferences({ snippetsEnabled: next });
                      }}
                    />
                    Enabled
                  </label>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_1fr_auto] gap-2">
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md bg-background"
                    placeholder="Trigger (e.g. brb)"
                    value={newSnippetTrigger}
                    onChange={(event) => setNewSnippetTrigger(event.target.value)}
                  />
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md bg-background"
                    placeholder="Expansion (e.g. be right back)"
                    value={newSnippetExpansion}
                    onChange={(event) => setNewSnippetExpansion(event.target.value)}
                  />
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md bg-background"
                    placeholder="App scope (optional)"
                    value={newSnippetAppScope}
                    onChange={(event) => setNewSnippetAppScope(event.target.value)}
                  />
                  <Button variant="outline" onClick={() => void handleAddSnippet()}>
                    Add
                  </Button>
                </div>
                <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={newSnippetCaseSensitive}
                    onChange={(event) => setNewSnippetCaseSensitive(event.target.checked)}
                  />
                  Case-sensitive trigger
                </label>

                {dictationSnippets.length > 0 && (
                  <div className="space-y-2">
                    {dictationSnippets.map((snippet) => (
                      <div
                        key={snippet.id}
                        className="rounded-md border p-2 space-y-2"
                      >
                        <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_1fr] gap-2">
                          <input
                            type="text"
                            className="w-full p-2 border rounded-md bg-background text-sm font-mono"
                            value={snippet.trigger}
                            onChange={(event) =>
                              setDictationSnippets((prev) =>
                                prev.map((current) =>
                                  current.id === snippet.id
                                    ? { ...current, trigger: event.target.value }
                                    : current
                                )
                              )
                            }
                            onBlur={(event) =>
                              void patchSnippet(snippet.id, { trigger: event.target.value.trim() })
                            }
                          />
                          <input
                            type="text"
                            className="w-full p-2 border rounded-md bg-background text-sm"
                            value={snippet.expansion}
                            onChange={(event) =>
                              setDictationSnippets((prev) =>
                                prev.map((current) =>
                                  current.id === snippet.id
                                    ? { ...current, expansion: event.target.value }
                                    : current
                                )
                              )
                            }
                            onBlur={(event) =>
                              void patchSnippet(snippet.id, { expansion: event.target.value.trim() })
                            }
                          />
                          <input
                            type="text"
                            className="w-full p-2 border rounded-md bg-background text-sm"
                            placeholder="App scope"
                            value={snippet.appScope ?? ""}
                            onChange={(event) =>
                              setDictationSnippets((prev) =>
                                prev.map((current) =>
                                  current.id === snippet.id
                                    ? { ...current, appScope: event.target.value }
                                    : current
                                )
                              )
                            }
                            onBlur={(event) =>
                              void patchSnippet(snippet.id, {
                                appScope: event.target.value.trim() || null,
                              })
                            }
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={snippet.caseSensitive}
                                onChange={(event) =>
                                  void patchSnippet(snippet.id, {
                                    caseSensitive: event.target.checked,
                                  })
                                }
                              />
                              Case-sensitive
                            </label>
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={snippet.enabled}
                                onChange={(event) =>
                                  void patchSnippet(snippet.id, {
                                    enabled: event.target.checked,
                                  })
                                }
                              />
                              Enabled
                            </label>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleDeleteSnippet(snippet.id)}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </ScrollArea>
      
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{selectedRecording?.title ?? "Dictation"}</DialogTitle>
          </DialogHeader>
          {isLoadingTranscript ? (
            <p className="text-muted-foreground">Loading transcript...</p>
          ) : selectedTranscript ? (
            <div className="space-y-4">
              <div className="p-4 bg-muted rounded-lg">
                <p className="whitespace-pre-wrap text-sm">
                  {selectedTranscript.fullText}
                </p>
              </div>
              <div className="text-xs text-muted-foreground">
                Duration: {selectedRecording ? formatRecordingDuration(selectedRecording.duration) : "N/A"} · 
                Created: {selectedRecording ? new Date(selectedRecording.createdAt).toLocaleString() : "N/A"}
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground">
              No transcript available for this dictation.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
