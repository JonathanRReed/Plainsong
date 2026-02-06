import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useRecording } from "@/hooks/use-recording";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { RecordingWaveform } from "@/components/waveform-visualizer";
import { Mic, Square, Monitor, Mic2, AlertCircle, CheckCircle } from "lucide-react";
import { checkSystemAudioAvailability, getLoopbackDeviceName } from "@/lib/tauri";

interface RecordingOverlayProps {
  isDictation?: boolean;
}

export function RecordingOverlay({ isDictation = false }: RecordingOverlayProps) {
  const { isRecording, recordingId, formattedDuration, isSystemAudioActive, stopMeeting } = useRecording();

  if (!isRecording) return null;

  if (isDictation) {
    return (
      <div className="fixed top-4 right-4 z-50">
        <div className="bg-active text-active-foreground px-4 py-2 rounded-full shadow-lg flex items-center gap-3 animate-pulse">
          <Mic className="h-4 w-4" />
          <span className="text-sm font-medium">Dictating...</span>
          <span className="text-sm font-mono">{formattedDuration}</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="fixed inset-0 z-40 pointer-events-none">
        <div className={cn(
          "absolute inset-0 border-4 transition-colors",
          isRecording ? "border-active" : "border-transparent"
        )} />
      </div>
      
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[500px]">
        <div className="bg-active text-active-foreground rounded-xl shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-active-foreground/20">
            <div className="flex items-center gap-3">
              <Mic2 className="h-5 w-5" />
              <span className="font-medium">Recording</span>
            </div>
            
            <div className="flex items-center gap-3">
              {isSystemAudioActive && (
                <div className="flex items-center gap-1 px-2 py-1 bg-active-foreground/20 rounded text-xs">
                  <Monitor className="h-3 w-3" />
                  <span>System Audio</span>
                </div>
              )}
              
              <span className="font-mono text-lg">{formattedDuration}</span>
              
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-active-foreground hover:bg-active-foreground/20"
                onClick={stopMeeting}
              >
                <Square className="h-4 w-4 fill-current" />
              </Button>
            </div>
          </div>
          
          {/* Waveform */}
          <div className="px-4 py-3 bg-active/50">
            <RecordingWaveform 
              recordingId={recordingId || "temp"}
              isRecording={isRecording}
              height={50}
            />
          </div>
        </div>
      </div>
    </>
  );
}

interface ConsentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (options: { mic: boolean; systemAudio: boolean }) => void;
}

export function ConsentDialog({ open, onOpenChange, onStart }: ConsentDialogProps) {
  const [options, setOptions] = useState({
    mic: true,
    systemAudio: false,
  });
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start Recording</DialogTitle>
          <DialogDescription>
            Choose what audio sources to capture. You'll see clear indicators while recording.
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4 py-4">
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="active"
            onClick={() => onStart(options)}
            disabled={!options.mic && !options.systemAudio}
          >
            Start Recording
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
