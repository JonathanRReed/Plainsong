import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Mic, Monitor, AlertCircle, CheckCircle } from "lucide-react";
import { checkSystemAudioAvailability, getLoopbackDeviceName } from "@/lib/tauri";
import { MEETING_TEMPLATES } from "@/lib/meeting-templates";

interface ConsentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (options: { mic: boolean; systemAudio: boolean; template?: string }) => Promise<void> | void;
}

export function ConsentDialog({ open, onOpenChange, onStart }: ConsentDialogProps) {
  const [options, setOptions] = useState({
    mic: true,
    systemAudio: false,
  });
  const [template, setTemplate] = useState("auto");
  const [systemAudioAvailable, setSystemAudioAvailable] = useState<boolean | null>(null);
  const [loopbackDevice, setLoopbackDevice] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      checkSystemAudioAvailability().then(setSystemAudioAvailable).catch(() => setSystemAudioAvailable(false));
      getLoopbackDeviceName().then(setLoopbackDevice).catch(() => setLoopbackDevice(null));
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onPointerDownOutside={(e) => e.preventDefault()} onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Start Recording</DialogTitle>
          <DialogDescription>
            Choose what audio sources to capture. You'll see clear indicators while recording.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => {
          e.preventDefault();
          onStart({ ...options, template: template === "auto" ? undefined : template });
        }}>
          <div className="space-y-4 py-4">
          {/* Meeting template picker */}
          <div>
            <p className="text-sm font-medium mb-2">Meeting Type</p>
            <div className="grid grid-cols-3 gap-1.5">
              {MEETING_TEMPLATES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setTemplate(t.value)}
                  className={`px-2 py-1.5 rounded text-xs text-left transition-colors border ${
                    template === t.value
                      ? "bg-active text-active-foreground border-active"
                      : "bg-background border-border hover:bg-muted"
                  }`}
                >
                  <div className="font-medium">{t.label}</div>
                </button>
              ))}
            </div>
            {template !== "auto" && (
              <p className="text-xs text-muted-foreground mt-1">
                {MEETING_TEMPLATES.find(t => t.value === template)?.description}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Mic className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Microphone</p>
                <p className="text-sm text-muted-foreground">Record your voice</p>
              </div>
            </div>
            <input
              type="checkbox"
              checked={options.mic}
              onChange={(e) => setOptions(prev => ({ ...prev, mic: e.target.checked }))}
              className="h-4 w-4"
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Monitor className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="font-medium">System Audio</p>
                {systemAudioAvailable === null ? (
                  <p className="text-sm text-muted-foreground">Checking availability...</p>
                ) : systemAudioAvailable ? (
                  <p className="text-sm text-green-600 flex items-center gap-1">
                    <CheckCircle className="h-3 w-3" />
                    {loopbackDevice || "Available"}
                  </p>
                ) : (
                  <p className="text-sm text-amber-600 flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" />
                    Install BlackHole: brew install blackhole-2ch
                  </p>
                )}
              </div>
            </div>
            <input
              type="checkbox"
              checked={options.systemAudio}
              onChange={(e) => setOptions(prev => ({ ...prev, systemAudio: e.target.checked }))}
              disabled={!systemAudioAvailable}
              className="h-4 w-4"
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <button
            type="submit"
            className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-active text-active-foreground hover:bg-active/90 h-10 px-4 py-2"
            disabled={!options.mic && !options.systemAudio}
          >
            Start Recording
          </button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
