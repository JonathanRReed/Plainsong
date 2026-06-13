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
import { Sidebar } from "@/components/sidebar";
import { RecordingProvider } from "@/hooks/use-recording";
import { DataCacheProvider } from "@/hooks/data-cache-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { FirstRunWizard } from "@/components/first-run-wizard";
import { ToastProvider, useToast } from "@/components/toast";
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

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
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
          <div className="max-w-md text-center space-y-4">
            <h2 className="text-xl font-semibold text-destructive">Something went wrong</h2>
            <p className="text-sm text-muted-foreground">
              {this.state.error?.message ?? "An unexpected error occurred."}
            </p>
            <button
              type="button"
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm"
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
  const firstViewMarked = useRef(false);

  // UI overlays
  const [wizardMode, setWizardMode] = useState<OnboardingMode | null>(null);

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
    const alreadyOnboarded = localStorage.getItem(ONBOARDING_STORAGE_KEY) === "true";
    setWizardMode(alreadyOnboarded ? null : "full");
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
    const SHORTCUT_VIEWS: Record<string, ViewId> = {
      h: "dashboard",
      d: "dictation",
      m: "recordings",
      p: "projects",
      ",": "settings",
    };

    const handleShortcut = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }

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

      const view = SHORTCUT_VIEWS[event.key.toLowerCase()];
      if (!view) {
        return;
      }

      event.preventDefault();
      setActiveView(view);
    };

    window.addEventListener("keydown", handleShortcut);
    return () => {
      window.removeEventListener("keydown", handleShortcut);
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
    if (result?.markOnboardingComplete ?? wizardMode === "full") {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
    }
    if (result?.meetingsCompleted) {
      localStorage.setItem(MEETING_ONBOARDING_STORAGE_KEY, "true");
    }
    setWizardMode(null);
  };

  const ActiveView = VIEW_COMPONENTS[activeView] ?? VIEW_COMPONENTS.dashboard;

  return (
    <ThemeProvider>
      <ToastProvider>
        <AppRuntimeListeners />
        <TooltipProvider>
          <ErrorBoundary>
            <RecordingProvider>
              <DataCacheProvider>
                <div className="app-shell flex h-screen bg-background text-foreground">
                  <Sidebar
                    activeView={activeView}
                    onViewChange={(v) => setActiveView(v as ViewId)}
                    isCollapsed={sidebarCollapsed}
                    onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
                  />

                  <main className="app-main-surface min-w-0 flex-1 overflow-hidden">
                    <Suspense
                      fallback={
                        <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                          Loading workspace...
                        </div>
                      }
                    >
                      <ActiveView />
                    </Suspense>
                  </main>
                </div>

                {/* First-run wizard (shown once on first launch) */}
                {wizardMode && <FirstRunWizard mode={wizardMode} onComplete={handleWizardComplete} />}
              </DataCacheProvider>
            </RecordingProvider>
          </ErrorBoundary>
        </TooltipProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
