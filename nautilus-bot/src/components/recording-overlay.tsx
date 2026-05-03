import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Mic, Monitor, CheckCircle } from "lucide-react";
import {
  checkSystemAudioAvailability,
  getLoopbackDeviceName,
  getMeetingConsentAutomationStatus,
  type MeetingConsentAutomationStatus,
} from "@/lib/backend/recordings";
import { MEETING_CONSENT_NOTICE_TEXT } from "@/lib/meeting-consent";
import { getMeetingTemplateOption, MEETING_TEMPLATES } from "@/lib/meeting-templates";

interface ConsentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (options: { mic: boolean; systemAudio: boolean; template?: string }) => Promise<void> | void;
}

export function ConsentDialog({ open, onOpenChange, onStart }: ConsentDialogProps) {
  const [captureMode, setCaptureMode] = useState<"mic_only" | "me_them">("me_them");
  const [template, setTemplate] = useState("auto");
  const [systemAudioAvailable, setSystemAudioAvailable] = useState<boolean | null>(null);
  const [loopbackDevice, setLoopbackDevice] = useState<string | null>(null);
  const [consentAutomation, setConsentAutomation] =
    useState<MeetingConsentAutomationStatus | null>(null);
  const [copiedNotice, setCopiedNotice] = useState(false);
  const selectedTemplate = getMeetingTemplateOption(template);

  useEffect(() => {
    if (open) {
      checkSystemAudioAvailability().then(setSystemAudioAvailable).catch(() => setSystemAudioAvailable(false));
      getLoopbackDeviceName().then(setLoopbackDevice).catch(() => setLoopbackDevice(null));
      getMeetingConsentAutomationStatus()
        .then(setConsentAutomation)
        .catch(() => setConsentAutomation(null));
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    if (systemAudioAvailable === false && captureMode === "me_them") {
      setCaptureMode("mic_only");
    }
  }, [captureMode, open, systemAudioAvailable]);

  useEffect(() => {
    if (!open || !copiedNotice) {
      return;
    }

    const id = window.setTimeout(() => setCopiedNotice(false), 1500);
    return () => window.clearTimeout(id);
  }, [copiedNotice, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onPointerDownOutside={(e) => e.preventDefault()} onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Start Meeting</DialogTitle>
          <DialogDescription>
            Choose the capture mode and note format. Nautilus will carry these choices into the live recorder and review view.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => {
          e.preventDefault();
          onStart({
            mic: true,
            systemAudio: captureMode === "me_them",
            template: template === "auto" ? undefined : template,
          });
        }}>
          <div className="space-y-4 py-4">
          <div>
            <p className="mb-2 text-sm font-medium">Capture Mode</p>
            <div className="grid gap-2 md:grid-cols-2">
              <button
                type="button"
                onClick={() => setCaptureMode("mic_only")}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  captureMode === "mic_only"
                    ? "border-active bg-active/10"
                    : "border-border bg-background hover:bg-muted"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Mic className="h-4 w-4 text-muted-foreground" />
                  <p className="font-medium">Mic only</p>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  Capture your side of the conversation and keep note-taking lightweight.
                </p>
              </button>
              <button
                type="button"
                onClick={() => {
                  if (systemAudioAvailable) {
                    setCaptureMode("me_them");
                  }
                }}
                disabled={!systemAudioAvailable}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  captureMode === "me_them"
                    ? "border-active bg-active/10"
                    : "border-border bg-background hover:bg-muted"
                } disabled:cursor-not-allowed disabled:opacity-60`}
              >
                <div className="flex items-center gap-2">
                  <Monitor className="h-4 w-4 text-muted-foreground" />
                  <p className="font-medium">Me + Them</p>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  Capture your microphone and remote participants for meeting-grade notes and follow-up.
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {systemAudioAvailable === null
                    ? "Checking system audio availability..."
                    : systemAudioAvailable
                      ? `Ready via ${loopbackDevice || "system audio capture"}.`
                      : "System audio is not ready, so Nautilus will fall back to Mic only."}
                </p>
              </button>
            </div>
          </div>

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
          </div>

          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{selectedTemplate.label}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selectedTemplate.description}
                </p>
              </div>
              <span className="rounded-full border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground">
                {captureMode === "me_them" ? "Me + Them" : "Mic only"}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {selectedTemplate.notesOutline.slice(0, 4).map((section) => (
                <span
                  key={section}
                  className="rounded-full border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground"
                >
                  {section}
                </span>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm text-muted-foreground">
            <div className="flex items-center gap-2 font-medium text-foreground">
              <CheckCircle className="h-4 w-4 text-emerald-600" />
              Participant consent reminder
            </div>
            <p className="mt-1">
              By starting, you confirm participants know the meeting is being recorded and transcribed.
            </p>
          </div>

          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium text-foreground">Consent notice delivery</p>
                <p className="mt-1 text-muted-foreground">
                  {consentAutomation?.message ??
                    "Nautilus checks whether it can post the consent notice automatically before the meeting starts."}
                </p>
              </div>
              <span className="rounded-full border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground">
                {consentAutomation?.canAutomate ? "Auto" : "Manual"}
              </span>
            </div>
            <div className="mt-3 rounded-md border bg-background/80 px-3 py-2 text-xs text-muted-foreground">
              {consentAutomation?.noticeText ?? MEETING_CONSENT_NOTICE_TEXT}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      consentAutomation?.noticeText ?? MEETING_CONSENT_NOTICE_TEXT
                    );
                    setCopiedNotice(true);
                  } catch {
                    setCopiedNotice(false);
                  }
                }}
              >
                Copy notice
              </Button>
              {copiedNotice ? (
                <span className="text-xs text-muted-foreground">Copied.</span>
              ) : null}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <button
            type="submit"
            className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-active text-active-foreground hover:bg-active/90 h-10 px-4 py-2"
          >
            Start Meeting
          </button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
