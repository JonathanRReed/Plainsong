import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Mic, Monitor, CheckCircle, Loader2 } from "lucide-react";
import {
  getMeetingConsentNoticeStatus,
  getSystemAudioCapability,
  type MeetingConsentNoticeStatus,
  type SystemAudioCapability,
} from "@/lib/backend/recordings";
import { MEETING_CONSENT_NOTICE_TEXT } from "@/lib/meeting-consent";
import {
  getAllMeetingTemplateOptions,
  getMeetingTemplateOption,
  type CustomMeetingTemplate,
} from "@/lib/meeting-templates";

interface ConsentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (options: { mic: boolean; systemAudio: boolean; template?: string }) => Promise<void> | void;
  /** The user's saved templates, listed alongside the built-ins below and
   * labeled as theirs. Optional so every other caller (and the mocked
   * version in recordings-view.test.tsx) keeps working unchanged. */
  customTemplates?: CustomMeetingTemplate[];
}

export function ConsentDialog({
  open,
  onOpenChange,
  onStart,
  customTemplates = [],
}: ConsentDialogProps) {
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
  const [consentNotice, setConsentNotice] =
    useState<MeetingConsentNoticeStatus | null>(null);
  const [copiedNotice, setCopiedNotice] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const isStartingRef = useRef(false);
  const captureModeTouchedRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const templateOptions = getAllMeetingTemplateOptions(customTemplates);
  const selectedTemplate = getMeetingTemplateOption(template, customTemplates);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    captureModeTouchedRef.current = false;
    isStartingRef.current = false;
    setCaptureMode("mic_only");
    setSystemAudioCapability(null);
    setConsentNotice(null);
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
    void getMeetingConsentNoticeStatus()
      .then((status) => {
        if (!cancelled) {
          setConsentNotice(status);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConsentNotice(null);
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
      <DialogContent
        className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-hidden"
        onPointerDownOutside={(e) => e.preventDefault()}
        onOpenAutoFocus={() => {
          const activeElement = document.activeElement;
          returnFocusRef.current =
            activeElement instanceof HTMLElement && activeElement !== document.body
              ? activeElement
              : null;
        }}
        onCloseAutoFocus={(event) => {
          const returnTarget = returnFocusRef.current;
          returnFocusRef.current = null;
          if (returnTarget?.isConnected) {
            event.preventDefault();
            returnTarget.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Start Meeting</DialogTitle>
          <DialogDescription>
            Choose the capture mode and note format. Plainsong will carry these choices into the live recorder and review view.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submitMeeting();
          }}
        >
          <div
            data-testid="meeting-start-dialog-body"
            className="-mr-2 min-h-0 flex-1 space-y-5 overflow-y-auto py-4 pr-2"
          >
          <div>
            <p className="rubric mb-2">Capture Mode</p>
            <div className="grid gap-2 md:grid-cols-2">
              <button
                type="button"
                aria-pressed={captureMode === "mic_only"}
                onClick={() => {
                  captureModeTouchedRef.current = true;
                  setCaptureMode("mic_only");
                }}
                disabled={isStarting}
                className={`rounded-lg border p-3 text-left transition-smooth focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
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
                aria-pressed={captureMode === "me_them"}
                onClick={() => {
                  if (systemAudioReady) {
                    captureModeTouchedRef.current = true;
                    setCaptureMode("me_them");
                  }
                }}
                disabled={isStarting || !systemAudioReady}
                className={`rounded-lg border p-3 text-left transition-smooth focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
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
                <p
                  className="mt-2 text-sm text-muted-foreground"
                  role="status"
                  aria-live="polite"
                  aria-label="System audio capability"
                >
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
              {templateOptions.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  aria-pressed={template === t.value}
                  onClick={() => setTemplate(t.value)}
                  disabled={isStarting}
                  className={`min-h-8 rounded border px-2 py-1.5 text-left text-sm transition-smooth focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                    template === t.value
                      ? "border-rust/40 bg-rust/8 text-rust"
                      : "bg-background border-border hover:bg-muted"
                  }`}
                >
                  <div className="font-medium">
                    {t.label}
                    {t.isCustom ? (
                      <span className="ml-1.5 rounded-full border border-border bg-muted px-1.5 py-0.5 align-middle font-mono text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                        Yours
                      </span>
                    ) : null}
                  </div>
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
            <div>
              <p className="font-serif text-base font-medium leading-snug text-foreground">Consent notice</p>
              {/* Plainsong never posts this into the meeting chat. The
                  backend message only names the meeting app it detected
                  (Zoom, Google Meet) so the instruction can say where to
                  send it; the action is always the user's. */}
              <p className="mt-1 text-muted-foreground">
                {consentNotice?.message ??
                  "Plainsong does not post this notice into the meeting chat for you. Copy it and send it in the meeting yourself before you start."}
              </p>
            </div>
            <div className="mt-3 rounded-md border bg-background/80 px-3 py-2 text-sm text-muted-foreground">
              {consentNotice?.noticeText ?? MEETING_CONSENT_NOTICE_TEXT}
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
                      consentNotice?.noticeText ?? MEETING_CONSENT_NOTICE_TEXT
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
                <span
                  className="text-sm text-muted-foreground"
                  role="status"
                  aria-live="polite"
                >
                  Copied.
                </span>
              ) : null}
            </div>
          </div>
          {startError ? (
            <p role="alert" className="text-sm text-destructive">
              {startError}
            </p>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 pt-4">
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
