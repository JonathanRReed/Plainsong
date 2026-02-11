import { Component, useMemo, useState, type ErrorInfo, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "@/components/sidebar";
import { RecordingOverlay } from "@/components/recording-overlay";
import { RecordingProvider } from "@/hooks/use-recording";
import { DictationPopup } from "@/components/popups/dictation-popup";
import { RecordingPopup } from "@/components/popups/recording-popup";
import { DashboardView } from "@/components/views/dashboard-view";
import { ProjectsView } from "@/components/views/projects-view";
import { RecordingsView } from "@/components/views/recordings-view";
import { DictationView } from "@/components/views/dictation-view";
import { ExportsView } from "@/components/views/exports-view";
import { SettingsView } from "@/components/views/settings-view-simple";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";

export type ViewId =
  | "dashboard"
  | "projects"
  | "recordings"
  | "dictation"
  | "exports"
  | "settings";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

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
            <h2 className="text-xl font-semibold text-destructive">
              Something went wrong
            </h2>
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

const VIEW_COMPONENTS: Record<ViewId, () => ReactNode> = {
  dashboard: () => <DashboardView />,
  projects: () => <ProjectsView />,
  recordings: () => <RecordingsView />,
  dictation: () => <DictationView />,
  exports: () => <ExportsView />,
  settings: () => <SettingsView />,
};

type OverlayMode = "dictation" | "recording" | null;

function getOverlayMode(): OverlayMode {
  if (typeof window === "undefined") return null;
  const overlay = new URLSearchParams(window.location.search).get("overlay");
  if (overlay === "dictation" || overlay === "recording") {
    return overlay;
  }

  try {
    const label = getCurrentWindow().label;
    if (label === "dictation-overlay") return "dictation";
    if (label === "recording-overlay") return "recording";
  } catch {
    // Not in a Tauri runtime window.
  }

  return null;
}

function App() {
  const overlayMode = useMemo(getOverlayMode, []);
  const [activeView, setActiveView] = useState<ViewId>("dashboard");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  if (overlayMode) {
    return (
      <ThemeProvider>
        <TooltipProvider>
          {overlayMode === "dictation" ? <DictationPopup /> : <RecordingPopup />}
        </TooltipProvider>
      </ThemeProvider>
    );
  }

  const renderView = VIEW_COMPONENTS[activeView] ?? VIEW_COMPONENTS.dashboard;

  return (
    <ThemeProvider>
      <TooltipProvider>
        <ErrorBoundary>
          <RecordingProvider>
            <div className="flex h-screen bg-background text-foreground">
              <Sidebar
                activeView={activeView}
                onViewChange={(v) => setActiveView(v as ViewId)}
                isCollapsed={sidebarCollapsed}
                onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
              />

              <main className="flex-1 overflow-hidden">{renderView()}</main>
              <RecordingOverlay isDictation={activeView === "dictation"} />
            </div>
          </RecordingProvider>
        </ErrorBoundary>

      </TooltipProvider>
    </ThemeProvider>
  );
}

export default App;
