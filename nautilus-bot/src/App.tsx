import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { listen } from "@/lib/electron";
import {
  normalizeCallCaptureRequest,
  publishCallCaptureRequest,
} from "@/lib/call-capture-request";
import { Sidebar } from "@/components/sidebar";
import { RecordingProvider } from "@/hooks/use-recording";
import { DataCacheProvider } from "@/hooks/data-cache-context";
import { ProductReadinessProvider } from "@/features/readiness/product-readiness-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { FirstRunWizard } from "@/components/first-run-wizard";
import { ToastProvider, useToast } from "@/components/toast";
import { AppCommandPalette } from "@/components/app-command-palette";
import { matchNavShortcut } from "@/lib/nav-shortcuts";
import {
  MEETING_ONBOARDING_STORAGE_KEY,
  ONBOARDING_STORAGE_KEY,
  OPEN_ONBOARDING_EVENT,
  type OnboardingMode,
} from "@/lib/onboarding";
import {
  OPEN_MAIN_VIEW_EVENT,
  OPEN_RECORDING_WORKSPACE_EVENT as OPEN_RECORDING_WORKSPACE_CUSTOM_EVENT,
  type MainViewId,
} from "@/lib/navigation";

const DashboardView = lazy(() =>
  import("@/components/views/dashboard-view").then((m) => ({ default: m.DashboardView }))
);

export type ViewId =
  | "dashboard"
  | "projects"
  | "recordings"
  | "dictation"
  | "exports"
  | "settings"
  | "setup";

interface ErrorBoundaryProps {
  children: ReactNode;
}
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

const ProjectsView = lazy(async () => ({
  default: (await import("@/components/views/projects-view")).ProjectsView,
}));
const RecordingsView = lazy(async () => ({
  default: (await import("@/components/views/recordings-view")).RecordingsView,
}));
const DictationView = lazy(async () => ({
  default: (await import("@/components/views/dictation-view")).DictationView,
}));
const ExportsView = lazy(async () => ({
  default: (await import("@/components/views/exports-view")).ExportsView,
}));
const SettingsView = lazy(async () => ({
  default: (await import("@/components/views/settings-view-simple")).SettingsView,
}));
const SetupView = lazy(async () => ({
  default: (await import("@/components/views/setup-view")).SetupView,
}));

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Uncaught error:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="surface-panel max-w-md rounded-xl border border-border/60 px-8 py-10 text-center">
            <span className="neume neume-rust mx-auto mb-5 block" aria-hidden="true" />
            <div role="alert" aria-live="assertive">
              <h2 className="font-serif text-xl font-semibold text-destructive">
              Something went wrong
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {this.state.error?.message ?? "An unexpected error occurred."}
              </p>
            </div>
            <button
              type="button"
              className="transition-smooth mt-6 rounded-md border border-border/70 px-4 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const VIEW_COMPONENTS: Record<ViewId, ComponentType> = {
  dashboard: DashboardView,
  projects: ProjectsView,
  recordings: RecordingsView,
  dictation: DictationView,
  exports: ExportsView,
  settings: SettingsView,
  setup: SetupView,
};

const VIEW_LABELS: Record<ViewId, string> = {
  dashboard: "Home",
  projects: "Projects",
  recordings: "Meetings",
  dictation: "Dictation",
  exports: "Exports",
  settings: "Settings",
  setup: "Setup",
};

interface MainViewRequestEvent {
  view?: ViewId | string | null;
  recordingId?: string | null;
}

function AppRuntimeListeners() {
  const { toast } = useToast();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<string>("asr-provider-warning", (event) => {
      const message = typeof event.payload === "string" ? event.payload.trim() : "";
      if (message) {
        toast(message, "error");
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [toast]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<string>("audio-input-advisory", (event) => {
      const message = typeof event.payload === "string" ? event.payload.trim() : "";
      if (message) {
        toast(message, "info");
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [toast]);

  // The database is opened before the sidecar has anywhere to send events, so
  // a vault repair that ran at startup reports itself here. It is a toast and
  // not a log line because it changes what is true about the user's data:
  // either the database is encrypted now when it was not before, or it is
  // still readable and they should know that too.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ message?: unknown; encrypted?: unknown }>(
      "vault-database-encryption-notice",
      (event) => {
        const message =
          typeof event.payload?.message === "string" ? event.payload.message.trim() : "";
        if (message) {
          toast(message, event.payload?.encrypted === true ? "success" : "error");
        }
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [toast]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<void>("accessibility-permission-warning", () => {
      toast(
        "Accessibility permission required for dictation. Enable it in System Settings > Privacy & Security > Accessibility.",
        "error"
      );
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [toast]);

  return null;
}

function App() {
  const [activeView, setActiveView] = useState<ViewId>("dictation");
  const [pendingRecordingWorkspaceId, setPendingRecordingWorkspaceId] = useState<string | null>(
    null
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const firstViewMarked = useRef(false);
  const mainRef = useRef<HTMLElement>(null);
  const navigationFocusReadyRef = useRef(false);

  // UI overlays
  const [wizardMode, setWizardMode] = useState<
    OnboardingMode | "unresolved" | null
  >("unresolved");

  useEffect(() => {
    if (!import.meta.env.DEV || typeof performance === "undefined") return;
    performance.mark("app-mounted");
    console.debug("[perf] app-mounted");
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV || typeof performance === "undefined") return;
    if (!firstViewMarked.current) {
      firstViewMarked.current = true;
      performance.mark("first-view-render");
      console.debug("[perf] first-view-render");
    }
    performance.mark(`view-change:${activeView}`);
    console.debug(`[perf] view-change:${activeView}`);
  }, [activeView]);

  useEffect(() => {
    if (!navigationFocusReadyRef.current) {
      navigationFocusReadyRef.current = true;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [activeView]);

  useEffect(() => {
    try {
      const alreadyOnboarded =
        localStorage.getItem(ONBOARDING_STORAGE_KEY) === "true";
      setWizardMode(alreadyOnboarded ? null : "full");
    } catch {
      // If storage is unavailable, fail into onboarding instead of flashing a
      // workspace whose setup state has not been established.
      setWizardMode("full");
    }
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<MainViewRequestEvent>("main-view-requested", (event) => {
      const requestedView = event.payload?.view;
      const requestedRecordingId =
        typeof event.payload?.recordingId === "string" ? event.payload.recordingId : null;
      if (
        requestedView === "dashboard" ||
        requestedView === "projects" ||
        requestedView === "recordings" ||
        requestedView === "dictation" ||
        requestedView === "exports" ||
        requestedView === "settings" ||
        requestedView === "setup"
      ) {
        setActiveView(requestedView);
        setPendingRecordingWorkspaceId(
          requestedView === "recordings" ? requestedRecordingId : null
        );
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const handleOpenOnboarding = (event: Event) => {
      const detail = (event as CustomEvent<{ mode?: OnboardingMode }>).detail;
      setWizardMode(detail?.mode ?? "full");
    };

    window.addEventListener(OPEN_ONBOARDING_EVENT, handleOpenOnboarding as EventListener);
    return () => {
      window.removeEventListener(OPEN_ONBOARDING_EVENT, handleOpenOnboarding as EventListener);
    };
  }, []);

  // A clicked "Zoom call started" notification: the main process focused the
  // window and sent the call. Go to Meetings and park the request for the
  // view, which opens the consent dialog with the call's name on it. Nothing
  // records until the reader says so there.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<unknown>("meeting-call-capture-requested", (event) => {
      const request = normalizeCallCaptureRequest(event.payload);
      if (!request) {
        return;
      }
      setActiveView("recordings");
      publishCallCaptureRequest(request);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const handleOpenMainView = (event: Event) => {
      const detail = (event as CustomEvent<{ view?: MainViewId }>).detail;
      if (!detail?.view) {
        return;
      }
      setActiveView(detail.view as ViewId);
    };

    window.addEventListener(OPEN_MAIN_VIEW_EVENT, handleOpenMainView as EventListener);
    return () => {
      window.removeEventListener(OPEN_MAIN_VIEW_EVENT, handleOpenMainView as EventListener);
    };
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }

      const view = matchNavShortcut(event);
      if (!view) {
        return;
      }

      event.preventDefault();
      setActiveView(view as ViewId);
    };

    window.addEventListener("keydown", handleShortcut);
    return () => {
      window.removeEventListener("keydown", handleShortcut);
    };
  }, []);

  useEffect(() => {
    const handleCommandPaletteShortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) {
        return;
      }
      if (event.altKey || event.shiftKey) {
        return;
      }

      event.preventDefault();
      setCommandPaletteOpen((open) => !open);
    };

    window.addEventListener("keydown", handleCommandPaletteShortcut);
    return () => {
      window.removeEventListener("keydown", handleCommandPaletteShortcut);
    };
  }, []);

  useEffect(() => {
    if (activeView !== "recordings" || !pendingRecordingWorkspaceId) {
      return;
    }

    window.dispatchEvent(
      new CustomEvent<{ recordingId: string }>(OPEN_RECORDING_WORKSPACE_CUSTOM_EVENT, {
        detail: { recordingId: pendingRecordingWorkspaceId },
      })
    );
    setPendingRecordingWorkspaceId(null);
  }, [activeView, pendingRecordingWorkspaceId]);

  const handleWizardComplete = (result?: {
    markOnboardingComplete?: boolean;
    meetingsCompleted?: boolean;
  }) => {
    try {
      if (result?.markOnboardingComplete ?? wizardMode === "full") {
        localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
      }
      if (result?.meetingsCompleted) {
        localStorage.setItem(MEETING_ONBOARDING_STORAGE_KEY, "true");
      }
    } catch {
      // Completion markers are best-effort state, not a reason to keep the wizard open.
    }
    setWizardMode(null);
  };

  if (wizardMode === "unresolved") {
    return (
      <ThemeProvider>
        <div
          className="flex h-screen items-center justify-center bg-background text-foreground"
          role="status"
          aria-live="polite"
          aria-label="Checking first-run setup"
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="neume" aria-hidden="true" />
            <p className="font-serif text-sm text-muted-foreground">
              Checking your setup...
            </p>
          </div>
        </div>
      </ThemeProvider>
    );
  }

  const ActiveView = VIEW_COMPONENTS[activeView] ?? VIEW_COMPONENTS.dashboard;
  const activeViewLabel = VIEW_LABELS[activeView] ?? VIEW_LABELS.dashboard;

  return (
    <ThemeProvider>
      <ToastProvider>
        <AppRuntimeListeners />
        <AppCommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
        <TooltipProvider>
          <ErrorBoundary>
            <RecordingProvider>
              <DataCacheProvider>
                <ProductReadinessProvider>
                  <div className="app-shell flex h-screen bg-background text-foreground">
                    <a
                      href="#main-content"
                      className="sr-only z-[100] rounded-md bg-background px-3 py-2 text-sm font-medium text-foreground shadow-lg focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                    >
                      Skip to workspace
                    </a>
                    <Sidebar
                      activeView={activeView}
                      onViewChange={(v) => setActiveView(v as ViewId)}
                      isCollapsed={sidebarCollapsed}
                      onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
                    />

                    <main
                      id="main-content"
                      ref={mainRef}
                      tabIndex={-1}
                      aria-label={`${activeViewLabel} workspace`}
                      className="app-main-surface min-w-0 flex-1 overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                    >
                      <Suspense
                        fallback={
                          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                            <span className="neume" aria-hidden="true" />
                            <p className="font-serif text-sm text-muted-foreground">
                              Loading workspace...
                            </p>
                          </div>
                        }
                      >
                        <ActiveView />
                      </Suspense>
                    </main>
                    <span
                      className="sr-only"
                      role="status"
                      aria-live="polite"
                      aria-label="Current workspace"
                    >
                      {activeViewLabel} workspace
                    </span>
                  </div>

                  {/* First-run wizard (shown once on first launch) */}
                  {wizardMode && (
                    <FirstRunWizard
                      mode={wizardMode}
                      onComplete={handleWizardComplete}
                    />
                  )}
                </ProductReadinessProvider>
              </DataCacheProvider>
            </RecordingProvider>
          </ErrorBoundary>
        </TooltipProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
