import { useState } from "react";
import { Sidebar } from "@/components/sidebar";
import { RecordingOverlay } from "@/components/recording-overlay";
import { DashboardView } from "@/components/views/dashboard-view";
import { ProjectsView } from "@/components/views/projects-view";
import { RecordingsView } from "@/components/views/recordings-view";
import { DictationView } from "@/components/views/dictation-view";
import { ExportsView } from "@/components/views/exports-view";
import { SettingsView } from "@/components/views/settings-view-simple";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";

function App() {
  const [activeView, setActiveView] = useState("dashboard");
  const [sidebarCollapsed] = useState(false);

  const renderView = () => {
    switch (activeView) {
      case "dashboard":
        return <DashboardView />;
      case "projects":
        return <ProjectsView />;
      case "recordings":
        return <RecordingsView />;
      case "dictation":
        return <DictationView />;
      case "exports":
        return <ExportsView />;
      case "settings":
        return <SettingsView />;
      default:
        return <DashboardView />;
    }
  };

  return (
    <ThemeProvider>
      <TooltipProvider>
        <div className="flex h-screen bg-background text-foreground">
          <Sidebar 
            activeView={activeView} 
            onViewChange={setActiveView}
            isCollapsed={sidebarCollapsed}
          />
          
          <main className="flex-1 overflow-hidden">
            {renderView()}
          </main>
          
          <RecordingOverlay isDictation={activeView === "dictation"} />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );
}

export default App;
