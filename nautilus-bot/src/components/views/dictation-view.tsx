import { useState, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils";
import { useRecording } from "@/hooks/use-recording";
import { useProjects } from "@/hooks/use-projects";
import { getSettings, saveSettings } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Keyboard, Mic, Square, Zap, Save } from "lucide-react";

interface DictationTextReadyEvent {
  text: string;
  pasted?: boolean;
  copied?: boolean;
  pasteError?: string | null;
  requestedProvider?: string;
  actualProvider?: string;
  fallbackUsed?: boolean;
  fallbackReason?: string | null;
  modelId?: string;
}

export function DictationView() {
  const { isRecording, formattedDuration, startDictation, stopDictation } = useRecording();
  const { projects } = useProjects();
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const hotkeyLabel = isMac
    ? "Cmd + Shift + Space or Ctrl + Shift + Space"
    : "Ctrl + Shift + Space";
  const [transcribedText, setTranscribedText] = useState("");
  const [lastProvider, setLastProvider] = useState<string | null>(null);
  const [lastModelId, setLastModelId] = useState<string | null>(null);
  const [pasteStatus, setPasteStatus] = useState<string | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [saveToInbox, setSaveToInbox] = useState(true);
  const [dictationProfile, setDictationProfile] = useState<"speed" | "accuracy">("speed");
  const [defaultProjectId, setDefaultProjectId] = useState("inbox");
  const [hotkeyPressed, setHotkeyPressed] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    let mounted = true;
    void getSettings()
      .then((settings) => {
        if (!mounted) return;
        setSaveToInbox(settings.transcription.dictationSaveToInbox);
        setDictationProfile(settings.transcription.dictationProfile);
        setDefaultProjectId(settings.transcription.dictationProjectId || "inbox");
      })
      .catch((error) => {
        console.warn("Failed to load dictation preferences:", error);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const persistDictationPreferences = async (
    updates: Partial<{ saveToInbox: boolean; profile: "speed" | "accuracy"; projectId: string }>
  ) => {
    try {
      const settings = await getSettings();
      settings.transcription.dictationSaveToInbox = updates.saveToInbox ?? saveToInbox;
      settings.transcription.dictationProfile = updates.profile ?? dictationProfile;
      settings.transcription.dictationProjectId = updates.projectId ?? defaultProjectId;
      await saveSettings(settings);
    } catch (error) {
      console.warn("Failed to persist dictation preferences:", error);
    }
  };

  useEffect(() => {
    // Listen for hotkey visual feedback
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "Space") {
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
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      unlisten = await listen<DictationTextReadyEvent>("dictation-text-ready", (event) => {
        const payload = event.payload;
        const text = payload?.text ?? "";
        if (text) {
          setTranscribedText(text);
        }
        if (payload?.actualProvider) {
          setLastProvider(payload.actualProvider);
        }
        if (payload?.modelId) {
          setLastModelId(payload.modelId);
        }
        if (payload?.fallbackUsed) {
          setFallbackNotice(
            payload.fallbackReason
              ? `Fallback used: ${payload.fallbackReason}`
              : "Fallback to Whisper was used."
          );
        } else {
          setFallbackNotice(null);
        }
        if (payload?.pasted) {
          setPasteStatus("Pasted into focused app");
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
    const text = await stopDictation();
    if (text) {
      setTranscribedText(text);
      
      // Copy to clipboard
      try {
        await navigator.clipboard.writeText(text);
        // Could show toast notification here
      } catch (err) {
        console.error("Failed to copy to clipboard:", err);
      }
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
              <span className="text-muted-foreground ml-2">to hold</span>
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
          </div>
        </div>
      </div>
      
      <ScrollArea className="flex-1">
        <div className="p-6 max-w-4xl mx-auto space-y-6">
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
                Press and hold the global hotkey to start dictating. 
                Release to stop and transcribe.
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
                        Hold and keep pressed: {hotkeyLabel}, release to transcribe
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
                  Text appears at your cursor position within seconds of releasing the hotkey.
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
                {(lastProvider || lastModelId || fallbackNotice) && (
                  <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                    {lastProvider && <p>Provider: {lastProvider}</p>}
                    {lastModelId && <p>Model: {lastModelId}</p>}
                    {fallbackNotice && <p className="text-amber-500">{fallbackNotice}</p>}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
          
          {/* Settings */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Dictation Settings</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Transcription Model</label>
                  <select
                    className="w-full p-2 border rounded-md bg-background"
                    value={dictationProfile}
                    onChange={(event) => {
                      const profile = event.target.value as "speed" | "accuracy";
                      setDictationProfile(profile);
                      void persistDictationPreferences({ profile });
                    }}
                  >
                    <option value="speed">Speed (Whisper Turbo)</option>
                    <option value="accuracy">Accuracy (Whisper Large)</option>
                  </select>
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
              </div>
            </CardContent>
          </Card>
        </div>
      </ScrollArea>
    </div>
  );
}
