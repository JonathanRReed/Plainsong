import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Mic, Monitor, CheckCircle, Loader2 } from "lucide-react";
import {
  getMeetingConsentAutomationStatus,
  getSystemAudioCapability,
  type MeetingConsentAutomationStatus,
  type SystemAudioCapability,
} from "@/lib/backend/recordings";
import { MEETING_CONSENT_NOTICE_TEXT } from "@/lib/meeting-consent";
import { getMeetingTemplateOption, MEETING_TEMPLATES } from "@/lib/meeting-templates";

interface ConsentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (options: { mic: boolean; systemAudio: boolean; template?: string }) => Promise<void> | void;
}

export function ConsentDialog({ open, onOpenChange, onStart }: ConsentDialogProps) {
  const [captureMode, setCaptureMode] = useState<"mic_only" | "me_them">("mic_only");
  const [template, setTemplate] = useState("auto");
  const [systemAudioCapability, setSystemAudioCapability] =
    useState<SystemAudioCapability | null>(null);
  const systemAudioRouteDetected =
    systemAudioCapability !== null && systemAudioCapability.backend !== "none";
  const systemAudioReady =
    systemAudioCapability?.ready === true &&
    systemAudioCapability.readiness === "ready" &&
    systemAudioCapability.backend !== "none";
  const [consentAutomation, setConsentAutomation] =
    useState<MeetingConsentAutomationStatus | null>(null);
  const [copiedNotice, setCopiedNotice] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const isStartingRef = useRef(false);
  const captureModeTouchedRef = useRef(false);
  const selectedTemplate = getMeetingTemplateOption(template);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    captureModeTouchedRef.current = false;
    isStartingRef.current = false;
    setCaptureMode("mic_only");
    setSystemAudioCapability(null);
    setConsentAutomation(null);
    setCopiedNotice(false);
    setIsStarting(false);
    setStartError(null);

    void getSystemAudioCapability()
      .then((capability) => {
        if (cancelled) {
          return;
        }
        setSystemAudioCapability(capability);
        if (
          capability.ready &&
          capability.readiness === "ready" &&
          capability.backend !== "none" &&
          !captureModeTouchedRef.current
        ) {
          setCaptureMode("me_them");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSystemAudioCapability({
            backend: "none",
            nativeOsSupported: false,
            nativeOsEnabled: false,
            routeDevice: null,
            routeId: null,
            nativeSampleRate: null,
            nativeChannels: null,
            readiness: "unavailable",
            ready: false,
            reason: "stream_construction",
            actionableReason: "Could not inspect system-audio routes.",
          });
        }
      });
    void getMeetingConsentAutomationStatus()
      .then((status) => {
        if (!cancelled) {
          setConsentAutomation(status);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConsentAutomation(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !copiedNotice) {
      return;
    }

    const id = window.setTimeout(() => setCopiedNotice(false), 1500);
    return () => window.clearTimeout(id);
  }, [copiedNotice, open]);

  const submitMeeting = async () => {
    if (isStartingRef.current) {
      return;
    }

    isStartingRef.current = true;
    setIsStarting(true);
    setStartError(null);
    try {
      await onStart({
        mic: true,
        systemAudio: captureMode === "me_them" && systemAudioReady,
        template: template === "auto" ? undefined : template,
      });
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      isStartingRef.current = false;
      setIsStarting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isStartingRef.current) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent onPointerDownOutside={(e) => e.preventDefault()} onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Start Meeting</DialogTitle>
          <DialogDescription>
            Choose the capture mode and note format. Plainsong will carry these choices into the live recorder and review view.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitMeeting();
          }}
        >
          <div className="space-y-5 py-4">
          <div>
            <p className="rubric mb-2">Capture Mode</p>
            <div className="grid gap-2 md:grid-cols-2">
              <button
                type="button"
                onClick={() => {
                  captureModeTouchedRef.current = true;
                  setCaptureMode("mic_only");
                }}
                disabled={isStarting}
                className={`rounded-lg border p-3 text-left transition-smooth ${
                  captureMode === "mic_only"
                    ? "border-rust/40 bg-rust/8 text-rust"
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
                  if (systemAudioReady) {
                    captureModeTouchedRef.current = true;
                    setCaptureMode("me_them");
                  }
                }}
                disabled={isStarting || !systemAudioReady}
                className={`rounded-lg border p-3 text-left transition-smooth ${
                  captureMode === "me_them"
                    ? "border-rust/40 bg-rust/8 text-rust"
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
                  <span
                    aria-hidden="true"
                    className={`neume mr-1.5 align-middle ${
                      systemAudioCapability === null
                        ? "neume-hollow"
                        : systemAudioReady
                          ? "neume-lit"
                          : "neume-rust"
                    }`}
                  />
                  {systemAudioCapability === null
                    ? "Checking the current system-audio capability..."
                    : systemAudioReady
                      ? `Verified via ${systemAudioCapability.routeDevice || "system audio capture"}.`
                      : systemAudioRouteDetected
                        ? `Route detected via ${systemAudioCapability.routeDevice || "system audio capture"}, but callbacks are unverified. Run Test system audio before using Me + Them.`
                        : "Me + Them is unavailable right now. Mic only remains ready to use."}
                </p>
              </button>
            </div>
          </div>

          <div>
            <p className="rubric mb-2">Meeting Type</p>
            <div className="grid grid-cols-3 gap-1.5">
              {MEETING_TEMPLATES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setTemplate(t.value)}
                  disabled={isStarting}
                  className={`px-2 py-1.5 rounded text-xs text-left transition-smooth border ${
                    template === t.value
                      ? "border-rust/40 bg-rust/8 text-rust"
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
                <p className="font-serif text-base font-medium leading-snug">{selectedTemplate.label}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selectedTemplate.description}
                </p>
              </div>
              <span className="shrink-0 rounded-full border bg-background px-2 py-1 font-mono text-[11px] font-medium tracking-wide text-muted-foreground">
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

          <div className="rounded-lg border border-border bg-muted/10 p-3 text-sm text-muted-foreground">
            <div className="flex items-center gap-2 font-medium text-foreground">
              <CheckCircle className="h-4 w-4 text-foreground" />
              Participant consent reminder
            </div>
            <p className="mt-1">
              By starting, you confirm participants know the meeting is being recorded and transcribed.
            </p>
          </div>

          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-serif text-base font-medium leading-snug text-foreground">Consent notice delivery</p>
                <p className="mt-1 text-muted-foreground">
                  {consentAutomation?.message ??
                    "Plainsong checks whether it can post the consent notice automatically before the meeting starts."}
                </p>
              </div>
              <span className="shrink-0 rounded-full border bg-background px-2 py-1 font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
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
                disabled={isStarting}
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
          {startError ? (
            <p role="alert" className="text-sm text-destructive">
              {startError}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isStarting}
          >
            Cancel
          </Button>
          <button
            type="submit"
            disabled={isStarting}
            className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2"
          >
            {isStarting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Starting…
              </>
            ) : (
              "Start Meeting"
            )}
          </button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
