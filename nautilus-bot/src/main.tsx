import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./index.css";

function detectOverlayMode(): "dictation" | "recording" | null {
  const fromQuery = new URLSearchParams(window.location.search).get("overlay");
  if (fromQuery === "dictation" || fromQuery === "recording") {
    return fromQuery;
  }

  try {
    const label = getCurrentWindow().label;
    if (label === "dictation-overlay") return "dictation";
    if (label === "recording-overlay") return "recording";
  } catch {
    // Not running inside a Tauri window context.
  }

  return null;
}

const overlayMode = detectOverlayMode();
if (overlayMode) {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
}

if (import.meta.env.DEV && typeof performance !== "undefined") {
  performance.mark("app-bootstrap-start");
  console.debug("[perf] app-bootstrap-start");
}

async function bootstrap() {
  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

  if (overlayMode) {
    const { OverlayRoot } = await import("./overlay-root");
    root.render(
      <React.StrictMode>
        <OverlayRoot overlayMode={overlayMode} />
      </React.StrictMode>
    );
    return;
  }

  const { default: App } = await import("./App");
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void bootstrap();
