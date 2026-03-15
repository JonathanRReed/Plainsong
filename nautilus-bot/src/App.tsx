import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "@/components/sidebar";
import { RecordingProvider } from "@/hooks/use-recording";
import { DataCacheProvider } from "@/hooks/data-cache-context";
import { DictationPopup } from "@/components/popups/dictation-popup";
import { RecordingPopup } from "@/components/popups/recording-popup";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { ActivationModal } from "@/components/activation-modal";
import { NagModal, shouldShowNag } from "@/components/nag-modal";
import { FirstRunWizard } from "@/components/first-run-wizard";
import { ToastProvider, useToast } from "@/components/toast";
import { validateLicense } from "@/lib/tauri";
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
import type { LicenseInfo } from "@/lib/tauri";
import { usePeriodicLicenseCheck } from "@/hooks/use-periodic-license-check";

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

type OverlayMode = "dictation" | "recording" | null;

interface MainViewRequestEvent {
  view?: ViewId | string | null;
  recordingId?: string | null;
}

function getOverlayMode(): OverlayMode {
  if (typeof window === "undefined") return null;
  const overlay = new URLSearchParams(window.location.search).get("overlay");
  if (overlay === "dictation" || overlay === "recording") return overlay;
  try {
    const label = getCurrentWindow().label;
    if (label === "dictation-overlay") return "dictation";
    if (label === "recording-overlay") return "recording";
  } catch {
    // Not in a Tauri window.
  }
  return null;
}

function OverlayBackgroundFix() {
  useEffect(() => {
    const overlay = getOverlayMode();
    if (overlay) {
      document.body.style.backgroundColor = "transparent";
      document.documentElement.style.backgroundColor = "transparent";
    }
  }, []);
  return null;
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
  const overlayMode = useMemo(getOverlayMode, []);
  const [activeView, setActiveView] = useState<ViewId>("dashboard");
  const [pendingRecordingWorkspaceId, setPendingRecordingWorkspaceId] = useState<string | null>(
    null
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const firstViewMarked = useRef(false);

  // License state
  const [licenseChecked, setLicenseChecked] = useState(false);
  const [license, setLicense] = useState<LicenseInfo | null>(null);

  // UI overlays
  const [showActivationModal, setShowActivationModal] = useState(false);
  const [wizardMode, setWizardMode] = useState<OnboardingMode | null>(null);
  const [showNag, setShowNag] = useState(false);

  // Check license on startup (skip for overlay windows)
  useEffect(() => {
    if (overlayMode) {
      setLicenseChecked(true);
      return;
    }
    void validateLicense()
      .then((info) => {
        setLicense(info);
        setLicenseChecked(true);
        if (info.nagRequired && shouldShowNag()) {
          setShowNag(true);
        }
      })
      .catch(() => {
        // Tauri not available (web/dev mode) – proceed in trial mode
        setLicense(null);
        setLicenseChecked(true);
      });
  }, [overlayMode]);

  // Periodic license validation (every 4 hours)
  usePeriodicLicenseCheck({
    license,
    onLicenseChange: (info) => {
      setLicense(info);
      if (!info.valid && info.nagRequired && shouldShowNag()) {
        setShowNag(true);
      }
    },
    onLicenseRevoked: () => {
      setShowNag(true);
    },
  });

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
    if (overlayMode || !licenseChecked) {
      return;
    }
    const alreadyOnboarded = localStorage.getItem(ONBOARDING_STORAGE_KEY) === "true";
    setWizardMode(alreadyOnboarded ? null : "full");
  }, [overlayMode, licenseChecked]);

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

  const handleActivated = (info: LicenseInfo) => {
    setLicense(info);
    setShowActivationModal(false);
    setShowNag(false);
  };

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

  // ── Overlay windows (dictation popup, recording popup) ───────────────────
  if (overlayMode) {
    return (
      <ThemeProvider>
        <OverlayBackgroundFix />
        <TooltipProvider>
          {overlayMode === "dictation" ? <DictationPopup /> : <RecordingPopup />}
        </TooltipProvider>
      </ThemeProvider>
    );
  }

  // ── Startup splash while license is being checked ────────────────────────
  if (!licenseChecked) {
    return (
      <ThemeProvider>
        <div className="flex h-screen items-center justify-center bg-background">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </ThemeProvider>
    );
  }

  const ActiveView = VIEW_COMPONENTS[activeView] ?? VIEW_COMPONENTS.dashboard;

  return (
    <ThemeProvider>
      <ToastProvider>
        <AppRuntimeListeners />
        <TooltipProvider>
          <ErrorBoundary>
            <RecordingProvider>
              <DataCacheProvider>
                <div className="flex h-screen bg-background text-foreground">
                  <Sidebar
                    activeView={activeView}
                    onViewChange={(v) => setActiveView(v as ViewId)}
                    isCollapsed={sidebarCollapsed}
                    onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
                    license={license}
                    onActivateClick={() => setShowActivationModal(true)}
                  />

                  <main className="flex-1 overflow-hidden">
                    <Suspense
                      fallback={
                        <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                          Loading workspace...
                        </div>
                      }
                    >
                      {activeView === "settings" ? (
                        <SettingsView onLicenseChange={setLicense} />
                      ) : (
                        <ActiveView />
                      )}
                    </Suspense>
                  </main>
                </div>

                {/* Dismissible nag (no license + trial expired) */}
                {showNag && !license?.valid && (
                  <NagModal onActivate={() => { setShowNag(false); setShowActivationModal(true); }} />
                )}

                {/* Activation modal (user-triggered or from nag) */}
                {showActivationModal && (
                  <ActivationModal
                    onActivated={handleActivated}
                    onCancel={() => setShowActivationModal(false)}
                  />
                )}

                {/* First-run wizard (shown once after first activation) */}
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
