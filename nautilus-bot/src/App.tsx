import { mainViewCanSuspend, rememberMainView, restoredMainView } from "@/lib/main-window-idle";
import {
  Component,
  Suspense,
  lazy,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ErrorInfo,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { listen } from "@/lib/electron";
import { scheduleAfterPaint } from "@/lib/post-paint";
import {
  readViewScroll,
  restoreViewScroll,
  type ViewScrollPosition,
} from "@/lib/view-scroll-memory";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
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
import { useParakeetUpgradeNotice } from "@/hooks/use-parakeet-upgrade-notice";
import { matchNavShortcut } from "@/lib/nav-shortcuts";
import {
  OPEN_ONBOARDING_EVENT,
  type OnboardingMode,
} from "@/lib/onboarding";
import { useOnboardingGate } from "@/features/onboarding/use-onboarding-gate";
import {
  OPEN_MAIN_VIEW_EVENT,
  canLeaveMainView,
  queueDictationHistoryRequest,
  queueMeetingStartRequest,
  consumePendingDictationHistoryRequest,
  OPEN_RECORDING_WORKSPACE_EVENT as OPEN_RECORDING_WORKSPACE_CUSTOM_EVENT,
  type MainViewId,
} from "@/lib/navigation";

const AppCommandPalette = lazy(async () => ({
  default: (await import("@/components/app-command-palette")).AppCommandPalette,
}));

/**
 * A lazily loaded view that can also be fetched ahead of time. Both paths
 * share one promise, so a view preloaded while the app sat idle renders
 * without suspending. A failed load is forgotten so the next attempt retries.
 */
function lazyView(load: () => Promise<ComponentType>): {
  Component: ComponentType;
  preload: () => Promise<unknown>;
} {
  let pending: Promise<{ default: ComponentType }> | null = null;
  const loadOnce = () =>
    (pending ??= load()
      .then((component) => ({ default: component }))
      .catch((error: unknown) => {
        pending = null;
        throw error;
      }));
  return { Component: lazy(loadOnce), preload: loadOnce };
}

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

const VIEWS: Record<ViewId, ReturnType<typeof lazyView>> = {
  dashboard: lazyView(async () => (await import("@/components/views/dashboard-view")).DashboardView),
  projects: lazyView(async () => (await import("@/components/views/projects-view")).ProjectsView),
  recordings: lazyView(
    async () => (await import("@/components/views/recordings-view")).RecordingsView,
  ),
  dictation: lazyView(async () => (await import("@/components/views/dictation-view")).DictationView),
  exports: lazyView(async () => (await import("@/components/views/exports-view")).ExportsView),
  settings: lazyView(
    async () => (await import("@/components/views/settings-view-simple")).SettingsView,
  ),
  setup: lazyView(async () => (await import("@/components/views/setup-view")).SetupView),
};

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
  useParakeetUpgradeNotice(toast);

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

export function LaunchInteractiveReporter({
  marked,
}: {
  marked: MutableRefObject<boolean>;
}) {
  useEffect(() => {
    if (marked.current) return;
    return scheduleAfterPaint(() => {
      if (marked.current) return;
      marked.current = true;
      window.electronAPI?.reportLaunchMilestone(
        "workspace-or-wizard-interactive",
        performance.now(),
      );
    });
  }, [marked]);
  return null;
}

/**
 * Everything inside the providers, so the first-run gate can read the same
 * live readiness the rest of the app does.
 *
 * The gate used to live in `App` above `ProductReadinessProvider` and consult
 * one localStorage boolean. That boolean is shared with every development
 * build through the Electron user-data directory, so an installed copy read
 * "already onboarded" off months of dev runs and never showed the wizard.
 */
function AppShell() {
  const [activeView, setActiveView] = useState<ViewId>(restoredMainView);
  const [pendingRecordingWorkspaceId, setPendingRecordingWorkspaceId] = useState<string | null>(
    null
  );
  const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useSidebarCollapsed();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const firstViewMarked = useRef(false);
  const mainRef = useRef<HTMLElement>(null);
  const navigationFocusReadyRef = useRef(false);
  const interactiveMarkedRef = useRef(false);
  const activeViewRef = useRef(activeView);
  const viewScrollRef = useRef(new Map<ViewId, ViewScrollPosition>());

  // A transition keeps the current view on screen until the next one is
  // ready, instead of blanking the workspace to a loading line.
  useEffect(() => {
    const target = window as Window & { __plainsongPrepareQuit?: () => Promise<boolean> };
    const prepare = () => canLeaveMainView(activeViewRef.current);
    target.__plainsongPrepareQuit = prepare;
    return () => { if (target.__plainsongPrepareQuit === prepare) delete target.__plainsongPrepareQuit; };
  }, []);

  // Input in a read view may own an uncommitted draft. Navigation resets this
  // only after the existing leave guards have accepted it.
  const idleInputChanged = useRef(false);
  useEffect(() => {
    idleInputChanged.current = false;
    rememberMainView(activeView);
    const changed = () => { idleInputChanged.current = true; };
    document.addEventListener("input", changed, true);
    document.addEventListener("change", changed, true);
    return () => {
      document.removeEventListener("input", changed, true);
      document.removeEventListener("change", changed, true);
    };
  }, [activeView]);

  const navigationRevisionRef = useRef(0);
  const showView = useCallback(async (view: ViewId, recordingId: string | null = null) => {
    const revision = ++navigationRevisionRef.current;
    if (view !== activeViewRef.current && !(await canLeaveMainView(activeViewRef.current))) {
      return;
    }
    if (revision !== navigationRevisionRef.current) return;
    if (view !== "dictation") consumePendingDictationHistoryRequest();
    startTransition(() => {
      setActiveView(view);
      setPendingRecordingWorkspaceId(recordingId);
    });
  }, []);

  // UI overlays
  const { decision: onboardingGate, recordCompleted, recordDeferred } =
    useOnboardingGate();
  // A wizard the reader asked for by hand (Settings, Home, Setup), which
  // outranks the gate's own answer.
  const [requestedWizardMode, setRequestedWizardMode] =
    useState<OnboardingMode | null>(null);
  // Setup opens at most once per launch on its own. Finishing the wizard with
  // something still missing (a skipped model download, a permission left off)
  // would otherwise put the gate straight back into "show" the moment
  // readiness refreshed, which is a modal the reader cannot get out of.
  const [setupClosedThisSession, setSetupClosedThisSession] = useState(false);
  const wizardMode: OnboardingMode | null =
    requestedWizardMode ??
    (onboardingGate.action === "show" && !setupClosedThisSession
      ? onboardingGate.mode
      : null);
  // Avoid loading a hidden route on first run. Once opened, keep it mounted
  // when setup is reopened so editors retain their drafts.
  const workspaceRevealedRef = useRef(false);
  if (onboardingGate.action !== "wait" && !wizardMode) {
    workspaceRevealedRef.current = true;
  }
  useEffect(() => {
    const target = window as Window & { __plainsongCanSuspend?: () => boolean };
    const canSuspend = () => !wizardMode && onboardingGate.action !== "wait" &&
      !commandPaletteOpen && !idleInputChanged.current &&
      mainViewCanSuspend(activeView, document) && rememberMainView(activeView);
    target.__plainsongCanSuspend = canSuspend;
    return () => { if (target.__plainsongCanSuspend === canSuspend) delete target.__plainsongCanSuspend; };
  }, [activeView, wizardMode, onboardingGate.action, commandPaletteOpen]);

  // Once the gate opens setup, it stays open until the reader closes it.
  // Readiness refreshes whenever the window regains focus, and a practice
  // dictation, a finished download or a permission granted mid-setup can
  // flip the gate's live answer; following it unmounted the wizard and
  // brought it back at step 1.
  useEffect(() => {
    if (
      onboardingGate.action === "show" &&
      !setupClosedThisSession &&
      requestedWizardMode === null
    ) {
      setRequestedWizardMode(onboardingGate.mode);
    }
  }, [onboardingGate.action, onboardingGate.mode, requestedWizardMode, setupClosedThisSession]);

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

  // Remember where each view was scrolled, and put the reader back there when
  // they return. Scroll events do not bubble, so this listens in the capture
  // phase. Keyed on the gate so it attaches once the workspace is on screen.
  const workspaceMounted = onboardingGate.action !== "wait";
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const handleScroll = (event: Event) => {
      const position = readViewScroll(main, event.target);
      if (position) {
        viewScrollRef.current.set(activeViewRef.current, position);
      }
    };
    main.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    return () => main.removeEventListener("scroll", handleScroll, { capture: true });
  }, [workspaceMounted]);

  useLayoutEffect(() => {
    activeViewRef.current = activeView;
    const main = mainRef.current;
    const position = viewScrollRef.current.get(activeView);
    if (!main || !position?.top) return;
    return restoreViewScroll(main, position);
  }, [activeView]);

  // The reader closed setup and something is still missing — a model download
  // they skipped, a permission they left off. Record that as a deferral
  // against exactly what remains, so the next launch is quiet about it and
  // still speaks up if something else breaks. Without this, finishing the
  // wizard without finishing setup reopens it on every single launch.
  const deferredResidualRef = useRef<string | null>(null);
  const gateUnmetSignature = onboardingGate.unmet.join(",");
  useEffect(() => {
    if (!setupClosedThisSession || onboardingGate.action !== "show") {
      return;
    }
    if (deferredResidualRef.current === gateUnmetSignature) {
      return;
    }
    deferredResidualRef.current = gateUnmetSignature;
    void recordDeferred().catch((error) => {
      deferredResidualRef.current = null;
      console.warn("[onboarding] could not record the deferred setup state:", error);
    });
  }, [
    gateUnmetSignature,
    onboardingGate.action,
    recordDeferred,
    setupClosedThisSession,
  ]);

  // One line per launch decision, so a support bundle can say why the wizard
  // did or did not appear. State only — never anything the reader wrote.
  useEffect(() => {
    if (onboardingGate.action === "wait") {
      return;
    }
    console.info(
      `[onboarding] ${onboardingGate.action}: ${onboardingGate.reason}`,
    );
  }, [onboardingGate.action, onboardingGate.reason]);

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
        showView(
          requestedView,
          requestedView === "recordings" || requestedView === "dictation" ? requestedRecordingId : null
        );
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [showView]);

  // Main sends this right after "main-view-requested", before a lazily loaded
  // Meetings view can be listening, so App parks it for the view to take.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("meeting-start-requested", () => {
      if (!disposed) queueMeetingStartRequest();
    }).then((dispose) => {
      if (disposed) {
        dispose?.();
        return;
      }
      unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const handleOpenOnboarding = (event: Event) => {
      const detail = (event as CustomEvent<{ mode?: OnboardingMode }>).detail;
      setRequestedWizardMode(detail?.mode ?? "full");
    };

    window.addEventListener(OPEN_ONBOARDING_EVENT, handleOpenOnboarding as EventListener);
    return () => {
      window.removeEventListener(OPEN_ONBOARDING_EVENT, handleOpenOnboarding as EventListener);
    };
  }, []);

  // The Record action on a call notification: the main process focused the
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
      showView("recordings");
      publishCallCaptureRequest(request);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [showView]);


  useEffect(() => {
    const handleOpenMainView = (event: Event) => {
      const detail = (event as CustomEvent<{ view?: MainViewId }>).detail;
      if (!detail?.view) {
        return;
      }
      showView(detail.view as ViewId);
    };

    window.addEventListener(OPEN_MAIN_VIEW_EVENT, handleOpenMainView as EventListener);
    return () => {
      window.removeEventListener(OPEN_MAIN_VIEW_EVENT, handleOpenMainView as EventListener);
    };
  }, [showView]);

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
      showView(view as ViewId);
    };

    window.addEventListener("keydown", handleShortcut);
    return () => {
      window.removeEventListener("keydown", handleShortcut);
    };
  }, [showView]);

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
    if (!pendingRecordingWorkspaceId) return;
    if (activeView === "dictation") {
      queueDictationHistoryRequest(pendingRecordingWorkspaceId);
      setPendingRecordingWorkspaceId(null);
      return;
    }
    if (activeView !== "recordings") return;

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
    deferred?: boolean;
  }) => {
    const completed = result?.markOnboardingComplete ?? wizardMode === "full";
    // Closed with setup unfinished. Recorded so "Skip setup for now" means
    // something durable: the gate stays quiet about exactly what the reader
    // declined, and speaks up again when something new breaks.
    const write = result?.deferred
      ? recordDeferred()
      : completed
        ? recordCompleted(result?.meetingsCompleted === true)
        : null;
    void write?.catch((error) => {
      // Losing the record costs a repeat of this wizard, which is a great deal
      // better than a wizard that will not close.
      console.warn("[onboarding] could not record the setup state:", error);
    });
    setSetupClosedThisSession(true);
    setRequestedWizardMode(null);
  };

  if (onboardingGate.action === "wait") {
    return (
      <div
        className="flex h-screen bg-background text-foreground"
        role="status"
        aria-live="polite"
        aria-label="Checking first-run setup"
        data-workspace-loading=""
      >
        <div aria-hidden="true" className="flex w-72 shrink-0 flex-col gap-5 border-r border-border/70 bg-card/80 px-6 pt-16">
          <span className="neume mb-6" />
          <span className="h-3 w-24 rounded-sm bg-muted" />
          <span className="h-3 w-32 rounded-sm bg-muted" />
          <span className="h-3 w-20 rounded-sm bg-muted" />
        </div>
        <div aria-hidden="true" className="flex flex-1 items-center justify-center">
          <span className="neume" />
        </div>
      </div>
    );
  }

  const ActiveView = (VIEWS[activeView] ?? VIEWS.dashboard).Component;
  const activeViewLabel = VIEW_LABELS[activeView] ?? VIEW_LABELS.dashboard;

  return (
    <>
      {commandPaletteOpen && (
        <Suspense fallback={null}>
          <AppCommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
        </Suspense>
      )}
      <div inert={Boolean(wizardMode)} className="app-shell flex h-screen bg-background text-foreground">
        <a
          href="#main-content"
          className="sr-only z-[100] rounded-md bg-background px-3 py-2 text-sm font-medium text-foreground shadow-lg focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        >
          Skip to workspace
        </a>
        <Sidebar
          activeView={activeView}
          onViewChange={(v) => showView(v as ViewId)}
          isCollapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebar}
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
            {/* Keyed so each arrival settles in; `.view-enter` sits still
                under reduced motion. */}
            {workspaceRevealedRef.current && (
              <div key={activeView} className="view-enter h-full">
                <ActiveView />
              </div>
            )}
            {!wizardMode && (
              <LaunchInteractiveReporter marked={interactiveMarkedRef} />
            )}
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

      {/* Opened by the first-run gate, or by hand from Settings, Home or Setup. */}
      {wizardMode && (
        <>
          <FirstRunWizard mode={wizardMode} onComplete={handleWizardComplete} />
          <LaunchInteractiveReporter marked={interactiveMarkedRef} />
        </>
      )}
    </>
  );
}

function App() {
  useEffect(() => {
    return scheduleAfterPaint(() => {
      window.electronAPI?.reportLaunchMilestone(
        "renderer-post-commit-frame",
        performance.now(),
      );
    });
  }, []);

  return (
    <ThemeProvider>
      <ToastProvider>
        <AppRuntimeListeners />
        <TooltipProvider>
          <ErrorBoundary>
            <RecordingProvider>
              <DataCacheProvider>
                {/* Above the shell now, because the first-run gate reads the
                    same readiness the rest of the app does. */}
                <ProductReadinessProvider>
                  <AppShell />
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
